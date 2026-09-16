// @ts-check
/** Node resolve hook that maps the upstream module specifiers onto test doubles. */

const MAPPINGS = {
    '/scripts/PromptManager.js': './scripts-prompt-manager.js',
    '/scripts/openai.js': './scripts-openai.js',
    '/scripts/tokenizers.js': './scripts-tokenizers.js',
    '/scripts/extensions.js': './scripts-extensions.js',
};

/**
 * @param {string} specifier
 * @param {any} context
 * @param {(specifier: string, context: any) => any} nextResolve
 * @returns {any}
 */
export function resolve(specifier, context, nextResolve) {
    const mapped = MAPPINGS[specifier];
    if (mapped) {
        return { url: new URL(mapped, import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
