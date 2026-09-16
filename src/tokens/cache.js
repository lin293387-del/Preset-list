// @ts-check
/**
 * Bounded, persistent memoization of upstream token counts.
 *
 * Upstream already caches counts per chat, but every interaction still walks the
 * whole prompt set through serialization + HTTP. Two messages with identical
 * (model, role, name, content) always produce the same count, so the result of
 * the counting function can be reused across interactions, presets, chats and
 * sessions.
 *
 * Only single-message calls are cached: array inputs are passed through
 * untouched, so the upstream summing/offset semantics can never be altered.
 */

import { createStorage } from '../storage.js';

const CACHE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 3000;
const STORAGE_KEY = 'token-counts-v1';

/**
 * FNV-1a, run twice with different seeds to get a 64-bit-ish digest.
 *
 * @param {string} text
 * @param {number} seed
 * @returns {number}
 */
function fnv1a(text, seed) {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

/**
 * @param {string} text
 * @returns {string} 16 hex characters.
 */
export function hashContent(text) {
    const first = fnv1a(text, 0x811c9dc5);
    const second = fnv1a(text, 0x9e3779b9);
    return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}
/**
 * @param {{ model: string, full: boolean, role: string, name: string, content: string }} input
 * @returns {string}
 */
export function buildCountKey({ model, full, role, name, content }) {
    return `${model}|${full ? 1 : 0}|${role}|${name}|${content.length}|${hashContent(content)}`;
}

/**
 * @param {any} message
 * @returns {{ role: string, name: string, content: string } | null}
 */
export function describeCountableMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return null;
    }
    if (typeof message.content !== 'string') {
        return null;
    }
    return {
        role: String(message.role ?? ''),
        name: String(message.name ?? ''),
        content: message.content,
    };
}

/**
 * @param {object} options
 * @param {string} options.namespace
 * @param {{ snapshot: () => any }} options.diagnostics
 * @param {(message: string, error?: unknown) => void} options.onStorageError
 * @returns {Map<string, number>}
 */
function parsePersistedCache(raw, onStorageError) {
    const entries = new Map();
    if (!raw || typeof raw !== 'object') {
        return entries;
    }
    if (raw.version !== CACHE_VERSION || !Array.isArray(raw.entries)) {
        onStorageError('Ignoring token cache with unknown shape');
        return entries;
    }

    for (const pair of raw.entries) {
        if (!Array.isArray(pair) || pair.length !== 2) {
            continue;
        }
        const [key, value] = pair;
        if (typeof key === 'string' && key.length > 0 && typeof value === 'number' && Number.isFinite(value)) {
            entries.set(key, value);
        }
    }

    return entries;
}

/**
 * @param {object} options
 * @param {{ get: () => { persistentTokenCache: boolean, tokenCacheLimit: number } }} options.settings
 * @param {{ info: Function, warn: Function, noteOnce: Function }} options.diagnostics
 * @param {string} options.namespace
 * @param {(settings: any) => string} options.resolveModel Resolves the tokenizer model for a settings object.
 * @param {ReturnType<typeof createStorage>} [options.storage] Override for tests.
 */
export function createTokenCountCache({ settings, diagnostics, namespace, resolveModel, storage }) {
    const backingStore = storage ?? createStorage({ namespace, key: STORAGE_KEY });
    /** @type {Map<string, number>} */
    const entries = new Map();
    /** @type {{ hits: number, misses: number, evictions: number, loadedFrom: string | null }} */
    const stats = { hits: 0, misses: 0, evictions: 0, loadedFrom: null };

    let loadPromise = null;
    let saveTimer = null;
    let dirty = false;

    function limit() {
        return settings.get().tokenCacheLimit;
    }

    function persistEnabled() {
        return settings.get().persistentTokenCache;
    }

    async function load() {
        if (!persistEnabled()) {
            stats.loadedFrom = 'disabled';
            return;
        }
        try {
            const raw = await backingStore.read();
            const restored = parsePersistedCache(raw, message => diagnostics.info(message));
            for (const [key, value] of restored) {
                entries.set(key, value);
            }
            stats.loadedFrom = `${backingStore.backend} (${restored.size})`;
            diagnostics.info(`Token cache loaded: ${restored.size} entries from ${backingStore.backend}`);
        } catch (error) {
            stats.loadedFrom = 'failed';
            diagnostics.warn('Token cache could not be loaded:', error);
        }
    }

    function ensureLoaded() {
        loadPromise ??= load();
        return loadPromise;
    }

    function evictIfNeeded() {
        const max = limit();
        while (entries.size > max) {
            const oldest = entries.keys().next();
            if (oldest.done) {
                break;
            }
            entries.delete(oldest.value);
            stats.evictions += 1;
        }
    }

    function scheduleSave() {
        if (!persistEnabled()) {
            return;
        }
        dirty = true;
        if (saveTimer !== null) {
            return;
        }
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void flush();
        }, SAVE_DEBOUNCE_MS);
    }

    async function flush() {
        if (!persistEnabled() || !dirty) {
            return;
        }
        dirty = false;
        const payload = {
            version: CACHE_VERSION,
            entries: [...entries.entries()],
        };
        try {
            await backingStore.write(payload);
        } catch (error) {
            diagnostics.warn('Token cache could not be saved:', error);
        }
    }

    return {
        stats,
        size: () => entries.size,
        backend: () => backingStore.backend,
        /** Loads the persisted cache once; safe to call concurrently. */
        ensureLoaded,
        flush,
        async clear() {
            entries.clear();
            stats.evictions = 0;
            dirty = false;
            if (saveTimer !== null) {
                clearTimeout(saveTimer);
                saveTimer = null;
            }
            await backingStore.clear();
            diagnostics.info('Token cache cleared');
        },
        /**
         * Wraps an upstream counting function with memoization.
         *
         * @template {(messages: any, full?: boolean, settings?: any) => Promise<number>} T
         * @param {T} original
         * @returns {T}
         */
        memoize(original) {
            /**
             * @this {any}
             * @param {any} messages
             * @param {boolean} [full]
             * @param {any} [countSettings]
             * @returns {Promise<number>}
             */
            const countingWithCache = async function (messages, full, countSettings) {
                const callOriginal = () => original.call(this, messages, full, countSettings);
                const described = describeCountableMessage(messages);
                if (!described) {
                    return callOriginal();
                }

                let model;
                try {
                    model = String(resolveModel(countSettings) ?? '');
                } catch {
                    // Unknown settings must never turn a cache miss into a failure.
                    return callOriginal();
                }

                await ensureLoaded().catch(() => undefined);

                const key = buildCountKey({ model, full: Boolean(full), ...described });
                const cached = entries.get(key);
                if (typeof cached === 'number') {
                    stats.hits += 1;
                    // Refresh recency.
                    entries.delete(key);
                    entries.set(key, cached);
                    return cached;
                }

                stats.misses += 1;
                const value = await callOriginal();
                if (typeof value === 'number' && Number.isFinite(value)) {
                    entries.set(key, value);
                    evictIfNeeded();
                    scheduleSave();
                }
                return value;
            };

            return /** @type {T} */ (countingWithCache);
        },
    };
}
