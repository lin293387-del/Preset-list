// @ts-check
/** Test double for `/scripts/tokenizers.js`. */

/**
 * @param {any} settings
 * @returns {string}
 */
export function getTokenizerModel(settings = null) {
    return settings?.model ?? 'gpt-4o-test';
}
