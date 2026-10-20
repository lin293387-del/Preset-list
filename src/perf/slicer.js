// @ts-check
/**
 * Cooperative scheduling for loops that are too long to run in one go.
 *
 * A sync that walks a few hundred rows is fast enough to stay in one task, but a
 * panel with a thousand prompts is not: assembling and parsing that many rows in
 * a single task blocks scrolling, typing and every other interaction for as long
 * as it runs. The work is not urgent — it is bookkeeping the user did not ask for
 * — so it can be spread over several tasks and let the browser breathe between
 * them.
 *
 * Slicing is not free either: every yield is a task boundary, so a loop that would
 * have finished in 4 ms must not pay for one. Nothing is yielded until the current
 * slice has been running for the budget, which is why the fast case costs one
 * clock read per item and nothing else.
 *
 * The yield itself is picked from what the host has, best first:
 *
 * 1. `scheduler.yield()` — designed for exactly this: the continuation keeps its
 *    task priority, so sliced work does not fall behind rendering.
 * 2. `scheduler.postTask()` with `user-visible` priority — same family, one task
 *    of its own.
 * 3. `setTimeout(0)` — the classic fallback, which does drop to the back of the
 *    timer queue.
 */

/** How long one slice may run before the next item waits for a new task. */
export const SLICE_BUDGET_MS = 8;

/**
 * @returns {number} A monotonic timestamp in milliseconds.
 */
function defaultNow() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

/**
 * Hands control back to the browser, keeping the continuation on the same task
 * priority where the host supports it.
 *
 * @returns {Promise<unknown>}
 */
export function yieldToMain() {
    const schedulerApi = /** @type {any} */ (globalThis).scheduler;
    if (schedulerApi && typeof schedulerApi.yield === 'function') {
        return schedulerApi.yield();
    }
    if (schedulerApi && typeof schedulerApi.postTask === 'function') {
        return schedulerApi.postTask(() => {}, { priority: 'user-visible' });
    }
    return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Visits every item, yielding whenever the current slice has used its budget.
 *
 * The budget is checked *after* an item is visited, so an item that is itself
 * longer than the budget cannot be split — the loop only promises not to make the
 * task longer than one item past the budget.
 *
 * @template T
 * @param {ArrayLike<T>} items
 * @param {(item: T, index: number) => void} visit
 * @param {{
 *   budgetMs?: number,
 *   now?: () => number,
 *   yieldFn?: () => Promise<unknown>,
 * }} [options]
 * @returns {Promise<number>} How many times the loop yielded.
 */
export async function runSliced(items, visit, options = {}) {
    const { budgetMs = SLICE_BUDGET_MS, now = defaultNow, yieldFn = yieldToMain } = options;
    let sliceStart = now();
    let slices = 0;

    for (let index = 0; index < items.length; index += 1) {
        visit(items[index], index);
        if (now() - sliceStart >= budgetMs) {
            slices += 1;
            await yieldFn();
            sliceStart = now();
        }
    }

    return slices;
}
