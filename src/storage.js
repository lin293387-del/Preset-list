// @ts-check
/**
 * Key/value persistence with graceful degradation.
 *
 * Order: TauriTavern extension store -> `localStorage` -> memory. The active
 * tier is reported so diagnostics can explain why a cache is not surviving a
 * restart instead of pretending it does.
 */

/**
 * @param {{ namespace: string, key: string }} options
 */
export function createStorage({ namespace, key }) {
    const localKey = `${namespace}:${key}`;

    /** @returns {Record<string, any> | null} */
    function getTauriStore() {
        const store = globalThis.__TAURITAVERN__?.api?.extension?.store;
        return store && typeof store.tryGetJson === 'function' && typeof store.setJson === 'function' ? store : null;
    }

    function getLocalStorage() {
        try {
            const storage = globalThis.localStorage;
            if (!storage) {
                return null;
            }
            // Probe: some private modes throw on write.
            const probe = `${localKey}:probe`;
            storage.setItem(probe, '1');
            storage.removeItem(probe);
            return storage;
        } catch {
            return null;
        }
    }

    let backend = getTauriStore() ? 'tauri-store' : getLocalStorage() ? 'localStorage' : 'memory';
    /** @type {any} */
    let memoryValue = null;

    return {
        get backend() {
            return backend;
        },
        /** @returns {Promise<any>} */
        async read() {
            if (backend === 'tauri-store') {
                const store = getTauriStore();
                if (store) {
                    try {
                        const result = await store.tryGetJson({ namespace, key });
                        return result?.found ? result.value : null;
                    } catch (error) {
                        backend = getLocalStorage() ? 'localStorage' : 'memory';
                        console.warn('[Preset Lite] Extension store read failed, falling back:', error);
                    }
                }
            }

            if (backend === 'localStorage') {
                const storage = getLocalStorage();
                if (storage) {
                    const raw = storage.getItem(localKey);
                    if (!raw) {
                        return null;
                    }
                    try {
                        return JSON.parse(raw);
                    } catch (error) {
                        console.warn('[Preset Lite] Dropping unreadable local cache entry:', error);
                        storage.removeItem(localKey);
                        return null;
                    }
                }
            }

            return memoryValue;
        },
        /**
         * @param {any} value
         * @returns {Promise<void>}
         */
        async write(value) {
            if (backend === 'tauri-store') {
                const store = getTauriStore();
                if (store) {
                    try {
                        await store.setJson({ namespace, key, value });
                        return;
                    } catch (error) {
                        backend = getLocalStorage() ? 'localStorage' : 'memory';
                        console.warn('[Preset Lite] Extension store write failed, falling back:', error);
                    }
                }
            }

            if (backend === 'localStorage') {
                const storage = getLocalStorage();
                if (storage) {
                    try {
                        storage.setItem(localKey, JSON.stringify(value));
                        return;
                    } catch (error) {
                        backend = 'memory';
                        console.warn('[Preset Lite] localStorage write failed, keeping cache in memory:', error);
                    }
                }
            }

            memoryValue = value;
        },
        /** @returns {Promise<void>} */
        async clear() {
            memoryValue = null;
            const store = getTauriStore();
            if (backend === 'tauri-store' && store && typeof store.deleteJson === 'function') {
                try {
                    await store.deleteJson({ namespace, key });
                    return;
                } catch (error) {
                    console.warn('[Preset Lite] Extension store delete failed:', error);
                }
            }
            getLocalStorage()?.removeItem(localKey);
        },
    };
}
