// @ts-check
/**
 * Extension settings: validated defaults, live reads and persistence through the
 * regular SillyTavern settings file (`extension_settings`).
 */

export const SETTINGS_NAMESPACE = 'preset-lite';

/**
 * @typedef {object} PresetLiteSettings
 * @property {boolean} enabled Master switch; off means every patched path delegates to upstream.
 * @property {boolean} keepStaleNumbers Keep the last known token numbers (dimmed) while a recount is pending.
 * @property {number} idleDelayMs Minimum quiet time after the last interaction before a recount may start.
 * @property {number} idleTimeoutMs Idle callback fallback budget.
 * @property {boolean} deferDuringScroll Never start a recount while scrolling or dragging rows.
 * @property {boolean} coalescePresetEvents Coalesce upstream `input` events fired by the preset-apply loop.
 * @property {boolean} reportPresetConflicts Report preset fields a replayed handler changed afterwards.
 * @property {boolean} persistentTokenCache Persist token counts across sessions.
 * @property {number} tokenCacheLimit LRU bound for the persistent token cache.
 */

/** @type {PresetLiteSettings} */
export const DEFAULT_SETTINGS = Object.freeze({
    /** Master switch. When off, every patched path delegates to upstream. */
    enabled: true,
    /** Keep the last known token numbers (dimmed) while a recount is pending. */
    keepStaleNumbers: true,
    /** Minimum quiet time after the last interaction before a recount may start. */
    idleDelayMs: 100,
    /** Idle callback fallback budget: a recount is never postponed indefinitely. */
    idleTimeoutMs: 3000,
    /** Never start a recount while the user is scrolling or dragging rows. */
    deferDuringScroll: true,
    /** Coalesce upstream `input` events fired by the preset-apply loop. */
    coalescePresetEvents: true,
    /** Report preset fields whose value a coalesced handler changed afterwards. */
    reportPresetConflicts: true,
    /** Persist token counts across sessions. */
    persistentTokenCache: true,
    /** LRU bound for the persistent token cache. */
    tokenCacheLimit: 4000,
});

const NUMBER_LIMITS = Object.freeze({
    idleDelayMs: [0, 5000],
    idleTimeoutMs: [250, 60000],
    tokenCacheLimit: [100, 200000],
});

const BOOLEAN_KEYS = Object.freeze([
    'enabled',
    'keepStaleNumbers',
    'deferDuringScroll',
    'coalescePresetEvents',
    'reportPresetConflicts',
    'persistentTokenCache',
]);

/**
 * @param {string} key
 * @param {any} value
 * @returns {any} A value that is safe to store and read back.
 */
function coerce(key, value) {
    if (BOOLEAN_KEYS.includes(key)) {
        return typeof value === 'boolean' ? value : DEFAULT_SETTINGS[key];
    }

    const limits = NUMBER_LIMITS[key];
    if (limits) {
        const numeric = Math.round(Number(value));
        if (!Number.isFinite(numeric)) {
            return DEFAULT_SETTINGS[key];
        }
        return Math.min(limits[1], Math.max(limits[0], numeric));
    }

    return value;
}

/**
 * @param {Record<string, any>} context Page context.
 * @returns {{ get: () => PresetLiteSettings, update: (patch: Record<string, any>) => void, subscribe: (listener: () => void) => () => void }}
 */
export function createSettings(context) {
    const container = context.extensionSettings;
    if (!container || typeof container !== 'object') {
        throw new Error('[Preset Lite] extensionSettings is unavailable');
    }

    const existing = container[SETTINGS_NAMESPACE];
    /** @type {PresetLiteSettings} */
    const state = { ...DEFAULT_SETTINGS };

    if (existing && typeof existing === 'object') {
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (key in existing) {
                state[key] = coerce(key, existing[key]);
            }
        }
    }

    container[SETTINGS_NAMESPACE] = state;

    /** @type {Set<() => void>} */
    const listeners = new Set();

    function persist() {
        container[SETTINGS_NAMESPACE] = state;
        context.saveSettingsDebounced?.();
    }

    return {
        get() {
            return state;
        },
        update(patch) {
            let changed = false;
            for (const [key, value] of Object.entries(patch)) {
                if (!(key in DEFAULT_SETTINGS)) {
                    continue;
                }
                const next = coerce(key, value);
                if (state[key] !== next) {
                    state[key] = next;
                    changed = true;
                }
            }
            if (!changed) {
                return;
            }
            persist();
            for (const listener of [...listeners]) {
                try {
                    listener();
                } catch (error) {
                    console.error('[Preset Lite] Settings listener failed:', error);
                }
            }
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
