// @ts-check
/**
 * Host boundary: every page-level dependency of the extension lives here.
 *
 * Keeping these lookups in one module means the rest of the code can be written
 * against explicit inputs instead of reaching for globals, and the failure mode
 * for "this is not a supported host" is a single, readable error.
 */

import { getContext as getPageContext } from '/scripts/extensions.js';

/**
 * True on the Android/iOS builds of TauriTavern.
 *
 * The paint-degradation layer is mobile-only on purpose: a desktop GPU rasterises
 * the backdrop blur and the shadow halos cheaply, so degrading them there would
 * spend looks for no measurable gain. TauriTavern publishes the host identity as
 * `{ platform, kind }` before extensions activate; a missing or malformed
 * identity is treated as "not mobile" and reported by the caller instead of
 * being guessed.
 *
 * @returns {boolean}
 */
export function isMobileHost() {
    const identity = globalThis.__TAURITAVERN_HOST__;
    if (!identity || typeof identity !== 'object') {
        return false;
    }
    return identity.kind === 'mobile';
}

/** @returns {Record<string, any>} The SillyTavern/TauriTavern page context. */
export function getContext() {
    const context = getPageContext();
    if (!context || typeof context !== 'object') {
        throw new Error('[Tavern Optimize] SillyTavern context is unavailable');
    }
    return context;
}

/**
 * Resolves once the application is interactive.
 *
 * Third-party extensions are activated after `APP_READY`, and the event source
 * replays that event for late listeners, so a single `once` subscription covers
 * both the "already ready" and the "not ready yet" cases.
 *
 * @returns {Promise<void>}
 */
export async function waitForAppReady() {
    const tauriTavern = globalThis.__TAURITAVERN__;
    if (tauriTavern?.ready && typeof tauriTavern.ready.then === 'function') {
        await tauriTavern.ready;
        return;
    }

    const legacyReady = globalThis.__TAURITAVERN_MAIN_READY__;
    if (legacyReady && typeof legacyReady.then === 'function') {
        await legacyReady;
        return;
    }

    const context = getContext();
    const { eventSource, eventTypes } = context;
    if (!eventSource?.once || !eventTypes?.APP_READY) {
        return;
    }

    /** @type {Promise<void>} */
    const appReady = new Promise(resolve => {
        const finish = () => resolve();
        eventSource.once(eventTypes.APP_READY, finish);
    });
    await appReady;
}

/**
 * Derives the extension identity from the module URL so renaming the installed
 * folder cannot break resource lookups.
 *
 * @param {string} moduleUrl `import.meta.url` of the extension entry point.
 * @returns {{ name: string, folder: string, resourceRoot: string }}
 */
export function resolveExtensionIdentity(moduleUrl) {
    const resourceRoot = new URL('./', moduleUrl);
    const match = /^\/scripts\/extensions\/(.+)\/$/.exec(resourceRoot.pathname);
    if (!match) {
        throw new Error(`[Tavern Optimize] Unexpected extension location: ${resourceRoot.pathname}`);
    }

    const name = match[1];
    const segments = name.split('/');
    const folder = segments[segments.length - 1];

    return { name, folder, resourceRoot: resourceRoot.pathname };
}

export { createStorage } from './storage.js';
