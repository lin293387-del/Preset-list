// @ts-check
/**
 * Holds panel writes back while a scroll or drag gesture is in progress.
 *
 * A gesture is the one moment where the panel must not do anything: every DOM
 * write during a fling costs a style recalculation and a repaint of the region,
 * and a repaint that lands between two frames is exactly what a user perceives as
 * a blank flash. There is no amount of "make it fast enough" that beats not doing
 * it at all, so the rule here is absolute — while a gesture is held, the work is
 * remembered instead of run.
 *
 * Consequences that are part of the design, not accidents:
 *
 * - token numbers can be one gesture behind. They are shown dimmed while a
 *   recount is pending, so the panel never claims to be current when it is not.
 * - a structural change requested mid-gesture (a helper script deleting a row)
 *   is applied when the gesture ends, so the list never empties under the finger.
 * - the work is coalesced: many requests during one gesture become one run with
 *   the latest reason, because they all mean "the panel needs a sync".
 *
 * The gate is a plain object so it can be unit tested without a DOM, and so the
 * browser harness can drive the very same logic the runtime uses.
 */

/**
 * @param {object} options
 * @param {() => boolean} options.isHeld True while a gesture must not be interrupted.
 * @param {{ info?: (message: string) => void }} [options.diagnostics]
 */
export function createGestureGate({ isHeld, diagnostics }) {
    /** @type {{ reason: string, work: (reason: string) => void } | null} */
    let deferred = null;

    return {
        /** True while a request is waiting for the gesture to end. */
        isDeferred() {
            return deferred !== null;
        },
        /** The reason of the waiting request, for diagnostics and tests. */
        deferredReason() {
            return deferred?.reason ?? null;
        },
        /**
         * Runs the work now, or remembers it until the gesture ends.
         *
         * @param {string} reason
         * @param {(reason: string) => void} work
         * @returns {'ran' | 'deferred'}
         */
        run(reason, work) {
            if (isHeld()) {
                const replaced = deferred !== null;
                deferred = { reason, work };
                if (!replaced) {
                    diagnostics?.info?.(`Panel write deferred until the gesture ends (${reason})`);
                }
                return 'deferred';
            }
            work(reason);
            return 'ran';
        },
        /**
         * Runs the waiting work, if any.
         *
         * @param {string} [reason] What ended the gesture; reported to the work.
         * @returns {boolean} True when something was flushed.
         */
        flush(reason = 'gesture-end') {
            if (!deferred) {
                return false;
            }
            const { work } = deferred;
            deferred = null;
            work(reason);
            return true;
        },
        /** Drops waiting work without running it (extension stopping). */
        clear() {
            deferred = null;
        },
    };
}
