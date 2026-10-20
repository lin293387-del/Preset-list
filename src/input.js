// @ts-check
/**
 * Keeps the panel quiet while the user is typing, and folds a burst of input
 * events into one frame's worth of work.
 *
 * Two separate problems, one gate:
 *
 * **Composition.** While an IME is composing, the value of the field changes with
 * every candidate the user cycles through, and anything that writes to the DOM in
 * that window can move the caret or drop the composition. A Chinese, Japanese or
 * Korean user typing a sentence produces dozens of those updates; touching the
 * panel in the middle of one is felt as the input "swallowing" characters. So the
 * panel holds off for the whole composition, not for a fixed timeout.
 *
 * **Keystrokes.** Ordinary typing fires `input` on every key. Work per event is
 * work the browser can never get ahead of: a fast typist outruns it and the queue
 * grows. The gate therefore lets any number of events arrive and does the
 * bookkeeping once per frame.
 *
 * The gate is a plain object with an injected clock and frame scheduler, so the
 * behaviour is unit tested without a DOM — the same reason the gesture gate is.
 */

/** How long the panel stays quiet after the last keystroke. */
export const TYPE_HOLD_MS = 120;

/**
 * @param {() => void} callback
 * @returns {number | ReturnType<typeof setTimeout>} Handle for `cancelFrame`.
 */
function defaultScheduleFrame(callback) {
    if (typeof requestAnimationFrame === 'function') {
        return requestAnimationFrame(() => callback());
    }
    return setTimeout(callback, 16);
}

/**
 * @param {any} handle
 */
function defaultCancelFrame(handle) {
    if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(handle);
        return;
    }
    clearTimeout(handle);
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] Clock in milliseconds.
 * @param {(callback: () => void) => any} [options.scheduleFrame] Runs `callback` on the next frame.
 * @param {(handle: any) => void} [options.cancelFrame]
 * @param {(callback: () => void, ms: number) => any} [options.setTimer]
 * @param {(handle: any) => void} [options.clearTimer]
 * @param {number} [options.holdMs] How long typing holds the panel, default `TYPE_HOLD_MS`.
 * @param {(reason: string) => void} [options.onIdle] Called when the hold ends.
 * @param {{ info?: (message: string) => void }} [options.diagnostics]
 */
export function createInputGate(options = {}) {
    const {
        now = () => Date.now(),
        scheduleFrame = defaultScheduleFrame,
        cancelFrame = defaultCancelFrame,
        setTimer = (callback, ms) => setTimeout(callback, ms),
        clearTimer = handle => clearTimeout(handle),
        holdMs = TYPE_HOLD_MS,
        onIdle,
        diagnostics,
    } = options;

    /** Depth, because composition events can nest across elements. */
    let composing = 0;
    let typingUntil = 0;
    /** The frame this burst of keystrokes is already folded into. */
    let frame = null;
    /** Re-arms the hold after the last keystroke. */
    let idleTimer = null;

    function dropTimer() {
        if (idleTimer !== null) {
            clearTimer(idleTimer);
            idleTimer = null;
        }
    }

    function endHold(reason) {
        dropTimer();
        typingUntil = 0;
        onIdle?.(reason);
    }

    return {
        isComposing() {
            return composing > 0;
        },

        /** True while the panel must not write: composing, or just typed into. */
        isHeld() {
            return composing > 0 || now() < typingUntil;
        },

        beginComposition() {
            composing += 1;
            if (composing === 1) {
                diagnostics?.info?.('Panel writes held: IME composition in progress');
            }
        },

        endComposition() {
            if (composing === 0) {
                return;
            }
            composing -= 1;
            if (composing === 0) {
                endHold('composition-end');
            }
        },

        /**
         * Records a keystroke. Any number of calls within one frame cost one frame's
         * worth of bookkeeping, and the hold is extended from the latest one.
         */
        noteInput() {
            typingUntil = now() + holdMs;
            if (frame !== null) {
                return;
            }
            frame = scheduleFrame(() => {
                frame = null;
                // Composing already holds the panel for as long as it lasts, so the
                // timer only has to exist for plain typing.
                if (composing > 0) {
                    return;
                }
                dropTimer();
                idleTimer = setTimer(() => endHold('typing-end'), holdMs);
            });
        },

        /** Releases the hold now; the waiting work can run. */
        flush(reason = 'input-flush') {
            if (frame !== null) {
                cancelFrame(frame);
                frame = null;
            }
            composing = 0;
            if (typingUntil !== 0 || idleTimer !== null) {
                endHold(reason);
            }
        },

        /** Drops every pending timer (extension stopping). */
        clear() {
            if (frame !== null) {
                cancelFrame(frame);
                frame = null;
            }
            dropTimer();
            composing = 0;
            typingUntil = 0;
        },
    };
}
