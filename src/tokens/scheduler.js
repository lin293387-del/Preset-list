// @ts-check
/**
 * Recount scheduler.
 *
 * The expensive part of the preset panel is the upstream dry run: it assembles
 * the whole chat-completion prompt to obtain exact per-prompt token counts. This
 * scheduler makes that work invisible to the user:
 *
 * - interactions only mark the assembly stale; they never await a recount,
 * - recounts are coalesced, single-flight and started while the browser is idle,
 * - a recount never starts while the panel is hidden, a generation is running,
 *   or the user is scrolling/dragging,
 * - stale results are discarded by epoch instead of racing the UI.
 */

/**
 * @returns {{
 *   now: () => number,
 *   setTimer: (fn: () => void, ms: number) => any,
 *   clearTimer: (handle: any) => void,
 *   requestIdle: (fn: () => void, timeoutMs: number) => any,
 *   cancelIdle: (handle: any) => void,
 * }}
 */
export function createBrowserScheduler() {
    const hasIdleCallback = typeof globalThis.requestIdleCallback === 'function';
    return {
        now: () => Date.now(),
        setTimer: (fn, ms) => globalThis.setTimeout(fn, ms),
        clearTimer: handle => globalThis.clearTimeout(handle),
        requestIdle: (fn, timeoutMs) => (hasIdleCallback
            ? globalThis.requestIdleCallback(fn, { timeout: timeoutMs })
            : globalThis.setTimeout(fn, 0)),
        cancelIdle: handle => (hasIdleCallback
            ? globalThis.cancelIdleCallback(handle)
            : globalThis.clearTimeout(handle)),
    };
}

const RETRY_INTERVAL_MS = 250;

/**
 * @typedef {object} SchedulerSettings
 * @property {boolean} enabled
 * @property {number} idleDelayMs
 * @property {number} idleTimeoutMs
 * @property {boolean} deferDuringScroll
 */

/**
 * @param {object} options
 * @param {{ get: () => SchedulerSettings }} options.settings
 * @param {{
 *   info: (message: string, ...args: any[]) => void,
 *   warn: (message: string, ...args: any[]) => void,
 *   noteOnce?: (key: string, message: string, ...args: any[]) => void,
 * }} options.diagnostics
 * @param {() => any} options.getInstance
 * @param {() => boolean} options.isVisible
 * @param {() => boolean} options.isBusy
 * @param {() => boolean} options.isInteractionHeld
 * @param {() => void} options.onNumbersFresh
 * @param {(error: unknown) => void} options.onRecountError
 * @param {ReturnType<typeof createBrowserScheduler>} [options.scheduler]
 * @param {{ startSpan: (label: string) => () => void } | null} [options.metrics]
 */
export function createRecountScheduler({
    settings,
    diagnostics,
    getInstance,
    isVisible,
    isBusy,
    isInteractionHeld,
    onNumbersFresh,
    onRecountError,
    scheduler = createBrowserScheduler(),
    metrics = null,
}) {
    const state = {
        dirty: false,
        running: false,
        epoch: 0,
        /** @type {number | null} */
        lastInteractionAt: null,
        /** @type {number | null} */
        lastRun: null,
    };

    /** @type {{ kind: 'idle' | 'timer', handle: any } | null} */
    let pending = null;
    /** @type {Promise<void> | null} */
    let currentRun = null;
    let stopped = false;

    function canStart() {
        const config = settings.get();
        if (!config.enabled || stopped) {
            return false;
        }
        if (!isVisible() || isBusy()) {
            return false;
        }
        if (typeof document !== 'undefined' && document.hidden) {
            return false;
        }
        if (state.lastInteractionAt !== null && scheduler.now() - state.lastInteractionAt < config.idleDelayMs) {
            return false;
        }
        if (config.deferDuringScroll && isInteractionHeld()) {
            return false;
        }
        return true;
    }

    function cancelPending() {
        if (!pending) {
            return;
        }
        if (pending.kind === 'idle') {
            scheduler.cancelIdle(pending.handle);
        } else {
            scheduler.clearTimer(pending.handle);
        }
        pending = null;
    }

    function armRetry() {
        if (pending || !state.dirty || state.running) {
            return;
        }
        pending = {
            kind: 'timer',
            handle: scheduler.setTimer(() => {
                pending = null;
                arm();
            }, RETRY_INTERVAL_MS),
        };
    }

    function arm() {
        if (stopped || !state.dirty || state.running || pending) {
            return;
        }
        if (!canStart()) {
            // A hidden panel must not spin: it is re-armed on visibility changes.
            if (isVisible() && !isBusy()) {
                armRetry();
            }
            return;
        }

        pending = {
            kind: 'idle',
            handle: scheduler.requestIdle(() => {
                pending = null;
                void run('idle');
            }, settings.get().idleTimeoutMs),
        };
    }

    /**
     * @param {string} reason
     * @returns {Promise<void> | null}
     */
    function run(reason) {
        if (currentRun) {
            return currentRun;
        }
        if (!canStart()) {
            arm();
            return null;
        }

        const instance = getInstance();
        if (!instance) {
            state.dirty = false;
            diagnostics.noteOnce?.('no-instance', 'Recount skipped: prompt manager is not available yet');
            return null;
        }

        state.dirty = false;
        const epoch = ++state.epoch;
        const endSpan = metrics?.startSpan('recount') ?? null;

        state.running = true;
        const promise = (async () => {
            try {
                await instance.tryGenerate();
                if (epoch === state.epoch) {
                    state.lastRun = scheduler.now();
                    onNumbersFresh?.();
                    diagnostics.info(`Recount finished (${reason})`);
                }
            } catch (error) {
                if (epoch === state.epoch) {
                    diagnostics.warn('Recount failed:', error);
                    onRecountError?.(error);
                }
            }
        })();

        currentRun = promise;
        void promise.finally(() => {
            endSpan?.();
            if (currentRun === promise) {
                currentRun = null;
            }
            state.running = false;
            if (state.dirty) {
                arm();
            }
        });

        return promise;
    }

    return {
        /** Marks the assembled prompt as out of date without doing any work. */
        markDirty(reason) {
            if (!settings.get().enabled || stopped) {
                return;
            }
            if (!state.dirty) {
                diagnostics.info(`Assembly marked stale (${reason})`);
            }
            state.dirty = true;
        },
        /** Upstream assembled the prompt on its own; numbers are exact again. */
        markFresh(reason) {
            if (!state.dirty) {
                return;
            }
            state.dirty = false;
            diagnostics.info(`Assembly marked fresh (${reason})`);
            cancelPending();
        },
        isPending() {
            return state.dirty || state.running;
        },
        isRunning() {
            return state.running;
        },
        /** Schedules a recount for the next suitable idle moment. */
        schedule(reason) {
            if (!settings.get().enabled || stopped) {
                return;
            }
            state.dirty = true;
            if (state.running) {
                return;
            }
            cancelPending();
            arm();
        },
        /** Records user activity so a recount does not start under the finger. */
        noteInteraction(kind) {
            state.lastInteractionAt = scheduler.now();
            if (!state.dirty || state.running) {
                return;
            }
            const hadPending = pending !== null;
            cancelPending();
            if (hadPending) {
                diagnostics.info(`Recount deferred after ${kind}`);
            }
            arm();
        },
        /** Called when visibility/busy flags change so a parked recount can resume. */
        wake(reason) {
            if (!state.dirty || state.running) {
                return;
            }
            diagnostics.info(`Recount wake (${reason})`);
            cancelPending();
            arm();
        },
        /**
         * Forces a recount now, awaiting completion when possible.
         *
         * @param {string} reason
         * @returns {Promise<boolean>} True when the assembly is guaranteed fresh
         * once this call resolves. False means the recount stayed parked (hidden
         * panel, running generation, ...) and callers must treat numbers as stale.
         */
        async recountNow(reason) {
            cancelPending();
            if (currentRun) {
                await currentRun;
            }
            if (!state.dirty) {
                return true;
            }
            for (let attempt = 0; attempt < 2; attempt += 1) {
                if (!canStart()) {
                    arm();
                    return false;
                }
                const promise = run(`forced:${reason}`);
                if (!promise) {
                    return false;
                }
                await promise;
                if (!state.dirty) {
                    return true;
                }
            }
            return !state.dirty;
        },
        snapshot() {
            return {
                dirty: state.dirty,
                running: state.running,
                epoch: state.epoch,
                lastRun: state.lastRun,
                lastInteractionAt: state.lastInteractionAt,
                pending: pending ? pending.kind : null,
                canStart: canStart(),
            };
        },
        stop() {
            stopped = true;
            cancelPending();
        },
    };
}
