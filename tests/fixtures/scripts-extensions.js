// @ts-check
/** Test double for `/scripts/extensions.js`: exposes the page context of the test. */

/**
 * @returns {any}
 */
export function getContext() {
    const context = /** @type {any} */ (globalThis).__TEST_CONTEXT__;
    if (!context) {
        throw new Error('Test context is not installed');
    }
    return context;
}
