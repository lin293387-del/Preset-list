// @ts-check
/** Test double for `/scripts/openai.js`: only the live `promptManager` binding. */

/** @type {any} */
export let promptManager = null;

/**
 * @param {any} instance
 */
export function __setPromptManager(instance) {
    promptManager = instance;
}
