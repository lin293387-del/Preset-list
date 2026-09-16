// @ts-check
/**
 * Runtime takeover of the chat-completion prompt manager.
 *
 * Nothing in the application source is modified: the upstream class and the
 * upstream instance are re-pointed at this extension while it is enabled, and
 * every wrapper delegates to the captured original when it is not. That keeps a
 * single switch able to restore byte-for-byte upstream behaviour without a
 * reload.
 *
 * The upstream class and instance are injected so this layer can be unit tested
 * without the application module graph.
 */

const PATCH_MARKER = '__presetLitePatch';
const TARGET_CONTAINER_ID = 'completion_prompt_manager';

/** Methods captured before being replaced; all of them must exist. */
const TAKEOVER_METHODS = Object.freeze([
    'init',
    'render',
    'renderNowAndRefresh',
    'renderPromptManager',
    'renderPromptManagerListItems',
    'setChatCompletion',
    'makeDraggable',
    'getPromptsForCharacter',
    'getPromptOrderEntry',
]);

/**
 * @param {any} instance
 * @returns {boolean} True when the instance drives the visible panel.
 */
export function isTargetInstance(instance) {
    if (instance?.configuration?.containerIdentifier !== TARGET_CONTAINER_ID) {
        return false;
    }
    // An isolated prompt-assembly manager (Agent Mode and other headless
    // assemblies) copies the panel configuration but never touches the DOM; its
    // hook for macro substitution is what tells the two apart. Letting it through
    // marked the visible panel "fresh" after an assembly it never saw, which
    // cancelled the pending recount and left its token numbers stale.
    return typeof instance.substituteParams !== 'function';
}

/**
 * @param {object} options
 * @param {any} options.PromptManager Upstream class.
 * @param {() => any} options.getPromptManagerInstance Live upstream instance getter.
 * @param {() => boolean} options.isEnabled
 * @param {{ info: Function, warn: Function, degrade: Function }} options.diagnostics
 * @param {object} options.hooks Runtime callbacks (sync, recount, cache, ...).
 */
export function createPromptManagerPatch({ PromptManager, getPromptManagerInstance, isEnabled, diagnostics, hooks }) {
    /** @type {Record<string, Function>} */
    const originals = {};
    let installed = false;

    /**
     * @param {any} instance
     */
    function patchInstance(instance) {
        if (!isTargetInstance(instance) || instance[PATCH_MARKER]) {
            return;
        }

        const instanceOriginals = {
            renderDebounced: instance.renderDebounced,
            renderDryRunLatest: instance.renderDryRunLatest,
            handleToggle: instance.handleToggle,
            handleInspect: instance.handleInspect,
        };

        instance.renderDebounced = function patchedRenderDebounced() {
            if (!isEnabled()) {
                return instanceOriginals.renderDebounced.call(instance);
            }
            hooks.markDirty('renderDebounced');
            hooks.requestPanelSync('renderDebounced');
            hooks.scheduleRecount('renderDebounced');
            return undefined;
        };

        instance.renderDryRunLatest = function patchedRenderDryRunLatest() {
            if (!isEnabled()) {
                return instanceOriginals.renderDryRunLatest.call(instance);
            }
            hooks.scheduleRecount('renderDryRunLatest');
            return undefined;
        };

        instance.handleToggle = function patchedHandleToggle(/** @type {Event} */ event) {
            if (!isEnabled()) {
                return instanceOriginals.handleToggle.call(instance, event);
            }
            return hooks.handleToggle(instance, event, instanceOriginals.handleToggle);
        };

        instance.handleInspect = function patchedHandleInspect(/** @type {Event} */ event) {
            if (!isEnabled()) {
                return instanceOriginals.handleInspect.call(instance, event);
            }
            return hooks.handleInspect(instance, event, instanceOriginals.handleInspect);
        };

        hooks.attachTokenCache?.(instance);
        instance[PATCH_MARKER] = { instanceOriginals };
        diagnostics.info('Prompt manager instance patched');
    }

    /**
     * @param {any} instance
     */
    function restoreInstance(instance) {
        const marker = instance?.[PATCH_MARKER];
        if (!marker) {
            return;
        }
        Object.assign(instance, marker.instanceOriginals);
        delete instance[PATCH_MARKER];
    }

    return {
        /** Verifies the upstream surface this extension depends on. */
        assertSupported() {
            const prototype = PromptManager?.prototype;
            const missing = TAKEOVER_METHODS.filter(name => typeof prototype?.[name] !== 'function');
            if (missing.length > 0) {
                throw new Error(`PromptManager is missing methods: ${missing.join(', ')}`);
            }
        },
        install() {
            if (installed) {
                return;
            }
            this.assertSupported();

            for (const name of TAKEOVER_METHODS) {
                originals[name] = PromptManager.prototype[name];
            }

            PromptManager.prototype.render = function patchedRender(afterTryGenerate = true) {
                if (!isEnabled() || !isTargetInstance(this)) {
                    return originals.render.call(this, afterTryGenerate);
                }
                if (hooks.getMainApi() !== 'openai') {
                    return undefined;
                }
                if (this.configuration?.promptOrder?.strategy === 'character' && this.activeCharacter === null) {
                    return undefined;
                }

                this.error = null;
                hooks.requestPanelSync('render');
                if (afterTryGenerate === true) {
                    hooks.scheduleRecount('render');
                }
                return undefined;
            };

            PromptManager.prototype.renderNowAndRefresh = function patchedRenderNowAndRefresh() {
                if (!isEnabled() || !isTargetInstance(this)) {
                    return originals.renderNowAndRefresh.call(this);
                }
                if (hooks.getMainApi() !== 'openai') {
                    return undefined;
                }

                hooks.markDirty('renderNowAndRefresh');
                hooks.requestPanelSync('renderNowAndRefresh');
                hooks.scheduleRecount('renderNowAndRefresh');
                return undefined;
            };

            // These two are only reachable through the upstream private render
            // pipeline; routing them into the incremental renderer keeps callers
            // that reach them by other means working.
            PromptManager.prototype.renderPromptManager = function patchedRenderPromptManager(generation) {
                if (!isEnabled() || !isTargetInstance(this)) {
                    return originals.renderPromptManager.call(this, generation);
                }
                return hooks.requestPanelSync('renderPromptManager');
            };

            PromptManager.prototype.renderPromptManagerListItems = function patchedRenderListItems(generation) {
                if (!isEnabled() || !isTargetInstance(this)) {
                    return originals.renderPromptManagerListItems.call(this, generation);
                }
                return hooks.requestPanelSync('renderPromptManagerListItems');
            };

            PromptManager.prototype.setChatCompletion = function patchedSetChatCompletion(chatCompletion) {
                const result = originals.setChatCompletion.call(this, chatCompletion);
                if (isEnabled() && isTargetInstance(this)) {
                    hooks.onAssemblyFresh('setChatCompletion');
                }
                return result;
            };

            PromptManager.prototype.init = function patchedInit(...args) {
                const result = originals.init.apply(this, args);
                if (isTargetInstance(this)) {
                    patchInstance(this);
                }
                return result;
            };

            installed = true;
            diagnostics.info('Prompt manager prototype patched');
        },
        uninstall() {
            if (!installed) {
                return;
            }
            for (const [name, original] of Object.entries(originals)) {
                PromptManager.prototype[name] = original;
            }
            const instance = getPromptManagerInstance();
            if (instance) {
                restoreInstance(instance);
            }
            installed = false;
        },
        /** Attaches to an instance that was created before this extension loaded. */
        patchExistingInstance() {
            const instance = getPromptManagerInstance();
            if (instance) {
                patchInstance(instance);
                return true;
            }
            return false;
        },
        getInstance() {
            return getPromptManagerInstance();
        },
        originals,
    };
}
