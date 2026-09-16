// @ts-check
/**
 * Timing of the extension's own work.
 *
 * Only spans are recorded: how long a panel sync takes and how long a recount
 * takes. They are exposed through `__PRESET_LITE__.snapshot()` so a slow device
 * can be diagnosed from the console without a profiler.
 */

/**
 * @param {object} [options]
 * @param {number} [options.labelLimit] Unused labels are dropped once this many exist.
 */
export function createMetrics({ labelLimit = 32 } = {}) {
    const now = () => globalThis.performance?.now?.() ?? Date.now();

    /** @type {Map<string, { count: number, totalMs: number, maxMs: number, lastMs: number }>} */
    const spans = new Map();

    /**
     * @param {string} label
     * @param {number} durationMs
     */
    function recordSpan(label, durationMs) {
        if (!Number.isFinite(durationMs)) {
            return;
        }
        const entry = spans.get(label) ?? { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
        entry.count += 1;
        entry.totalMs += durationMs;
        entry.maxMs = Math.max(entry.maxMs, durationMs);
        entry.lastMs = durationMs;
        spans.set(label, entry);
        if (spans.size > labelLimit) {
            const oldest = spans.keys().next();
            if (!oldest.done) {
                spans.delete(oldest.value);
            }
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
                return duration;
            };
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
            return { spans: spanSnapshot };
        },
    };
}
