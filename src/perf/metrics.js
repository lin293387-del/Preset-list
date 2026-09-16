// @ts-check
/**
 * Lightweight performance sampling for spans, frames and long tasks.
 *
 * The performance HUD shipped by TauriTavern is opt-in and host-internal, so the
 * extension brings its own measurement and only *reads* the host HUD when it
 * happens to be enabled.
 */

const LAG_INTERVAL_MS = 100;
const LONG_TASK_THRESHOLD_MS = 50;

/**
 * @param {number[]} values
 * @returns {{ count: number, avgMs: number, p50Ms: number, p95Ms: number, maxMs: number }}
 */
export function summarize(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
    }
    const sorted = [...values].sort((left, right) => left - right);
    const sum = sorted.reduce((total, value) => total + value, 0);
    const quantile = ratio => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];

    return {
        count: sorted.length,
        avgMs: sum / sorted.length,
        p50Ms: quantile(0.5),
        p95Ms: quantile(0.95),
        maxMs: sorted[sorted.length - 1],
    };
}

/**
 * @param {Array<{ duration: number }>} entries
 * @returns {object}
 */
function summarizeLongTasks(entries) {
    const durations = entries.map(entry => entry.duration);
    const blockingMs = durations.reduce((total, duration) => total + Math.max(0, duration - LONG_TASK_THRESHOLD_MS), 0);
    return {
        ...summarize(durations),
        count: durations.length,
        blockingMs,
        thresholdMs: LONG_TASK_THRESHOLD_MS,
    };
}

export function createMetrics({ sampleLimit = 1500 } = {}) {
    const now = () => globalThis.performance?.now?.() ?? Date.now();

    /** @type {Map<string, { count: number, totalMs: number, maxMs: number, lastMs: number }>} */
    const spans = new Map();

    function recordSpan(label, durationMs) {
        const entry = spans.get(label) ?? { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
        entry.count += 1;
        entry.totalMs += durationMs;
        entry.maxMs = Math.max(entry.maxMs, durationMs);
        entry.lastMs = durationMs;
        spans.set(label, entry);
    }

    let sampling = false;
    let frames = [];
    let longTasks = [];
    let lags = [];
    let rafHandle = null;
    let lagTimer = null;
    let lastFrameTime = 0;
    let lastLagTime = 0;
    /** @type {PerformanceObserver | null} */
    let observer = null;
    let startedAt = 0;

    function frameTick(timestamp) {
        if (!sampling) {
            return;
        }
        if (lastFrameTime) {
            frames.push(timestamp - lastFrameTime);
            if (frames.length > sampleLimit) {
                frames.shift();
            }
        }
        lastFrameTime = timestamp;
        rafHandle = globalThis.requestAnimationFrame(frameTick);
    }

    function lagTick() {
        if (!sampling) {
            return;
        }
        const timestamp = Date.now();
        if (lastLagTime) {
            lags.push(Math.max(0, timestamp - lastLagTime - LAG_INTERVAL_MS));
            if (lags.length > sampleLimit) {
                lags.shift();
            }
        }
        lastLagTime = timestamp;
        lagTimer = globalThis.setTimeout(lagTick, LAG_INTERVAL_MS);
    }

    function startLongTaskObserver() {
        try {
            const supported = globalThis.PerformanceObserver?.supportedEntryTypes ?? [];
            if (!supported.includes('longtask')) {
                return;
            }
            observer = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) {
                    longTasks.push({ name: entry.name, duration: entry.duration });
                }
            });
            observer.observe({ type: 'longtask', buffered: false });
        } catch (error) {
            observer = null;
            console.warn('[Preset Lite] Long task observer unavailable:', error);
        }
    }

    return {
        /**
         * @param {string} label
         * @returns {() => number} Ends the span and returns its duration.
         */
        startSpan(label) {
            const started = now();
            return () => {
                const duration = now() - started;
                recordSpan(label, duration);
                try {
                    globalThis.performance?.measure?.(`preset-lite:${label}`, { start: started, end: started + duration });
                } catch {
                    // Measurement is best effort only.
                }
                return duration;
            };
        },
        record(label, durationMs) {
            recordSpan(label, durationMs);
        },
        sampling: {
            begin() {
                if (sampling) {
                    return;
                }
                sampling = true;
                startedAt = now();
                frames = [];
                longTasks = [];
                lags = [];
                lastFrameTime = 0;
                lastLagTime = 0;

                if (typeof globalThis.requestAnimationFrame === 'function') {
                    rafHandle = globalThis.requestAnimationFrame(frameTick);
                }
                lagTimer = globalThis.setTimeout(lagTick, LAG_INTERVAL_MS);
                startLongTaskObserver();
            },
            /**
             * @returns {{ durationMs: number, frames: object, longTasks: object, eventLoopLag: object }}
             */
            end() {
                if (!sampling) {
                    return {
                        durationMs: 0,
                        frames: summarize([]),
                        longTasks: summarizeLongTasks([]),
                        eventLoopLag: summarize([]),
                    };
                }
                sampling = false;
                if (rafHandle !== null && typeof globalThis.cancelAnimationFrame === 'function') {
                    globalThis.cancelAnimationFrame(rafHandle);
                    rafHandle = null;
                }
                if (lagTimer !== null) {
                    globalThis.clearTimeout(lagTimer);
                    lagTimer = null;
                }
                observer?.disconnect();
                observer = null;

                const result = {
                    durationMs: now() - startedAt,
                    frames: summarize(frames),
                    longTasks: summarizeLongTasks(longTasks),
                    eventLoopLag: summarize(lags),
                };
                frames = [];
                longTasks = [];
                lags = [];
                return result;
            },
        },
        snapshot() {
            const spanSnapshot = {};
            for (const [label, entry] of spans) {
                spanSnapshot[label] = {
                    count: entry.count,
                    avgMs: entry.totalMs / Math.max(1, entry.count),
                    maxMs: entry.maxMs,
                    lastMs: entry.lastMs,
                };
            }
            return {
                spans: spanSnapshot,
                hostPerf: this.readHostSnapshot(),
            };
        },
        /** Reads the TauriTavern HUD when the user enabled it, otherwise null. */
        readHostSnapshot() {
            try {
                const hud = globalThis.__TAURITAVERN_PERF__;
                return typeof hud?.snapshot === 'function' ? hud.snapshot() : null;
            } catch {
                return null;
            }
        },
    };
}
