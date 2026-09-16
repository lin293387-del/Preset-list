// @ts-check
/**
 * Runtime composition: patches, scheduling, caching and measurement wiring.
 *
 * The runtime is the only place that knows about every other module; everything
 * it owns is created here so `stop()` can restore the application to its
 * unmodified behaviour.
 */

import { PromptManager } from '/scripts/PromptManager.js';
import { promptManager as livePromptManager } from '/scripts/openai.js';
import { getTokenizerModel } from '/scripts/tokenizers.js';

import { getContext } from './host.js';
import { createPresetWindowCoalescer } from './patches/preset-window.js';
import { createPromptManagerPatch } from './patches/prompt-manager.js';
import { createPanelState, fullRebuild, syncPanel } from './render/panel.js';
import { createBench } from './perf/bench.js';
import { createMetrics } from './perf/metrics.js';
import { createTokenCountCache } from './tokens/cache.js';
import { createBrowserScheduler, createRecountScheduler } from './tokens/scheduler.js';

const VERSION = '0.1.0';
const SCROLL_HOLD_MS = 160;
const INTERACTION_EVENTS = ['pointerdown', 'touchstart', 'keydown', 'wheel', 'scroll'];

/**
 * @param {HTMLElement} element
 * @returns {boolean}
 */
function isDrawerOpen(element) {
    return element.classList.contains('openDrawer') && !element.classList.contains('closedDrawer');
}

/**
 * @param {object} options
 * @param {any} options.context Page context.
 * @param {{ get: () => any, update: (patch: object) => void, subscribe: (listener: () => void) => () => void }} options.settings
 * @param {object} options.diagnostics
 * @param {{ name: string, folder: string }} options.identity
 * @param {Record<string, Function>} options.hooks Late-bound hooks (settings UI actions).
 */
export function createRuntime({ context, settings, diagnostics, identity, hooks = {} }) {
    const metrics = createMetrics();
    const panelState = createPanelState();
    const cache = createTokenCountCache({
        settings,
        diagnostics,
        namespace: 'preset-lite',
        resolveModel: getTokenizerModel,
    });

    const eventSource = context.eventSource;
    const eventTypes = context.eventTypes;
    const jQuery = context.jQuery ?? globalThis.jQuery;

    let syncRequested = false;
    let settingsSyncTimer = null;
    let scrollingUntil = 0;
    let scrollHoldTimer = null;
    let sorting = false;
    let busy = false;
    let observedVisible = true;
    /** @type {IntersectionObserver | null} */
    let visibilityObserver = null;
    /** @type {Array<() => void>} */
    const disposers = [];

    // ---------------------------------------------------------------- scheduling

    const scheduler = createRecountScheduler({
        settings,
        diagnostics,
        metrics,
        scheduler: createBrowserScheduler(),
        getInstance: () => patch.getInstance(),
        isVisible: () => isPanelVisible(),
        isBusy: () => busy,
        isInteractionHeld: () => isInteractionHeld(),
        onNumbersFresh: () => {
            requestPanelSync('recount');
            void cache.flush();
        },
        onRecountError: error => reportRecountError(error),
    });

    // -------------------------------------------------------------- panel syncing

    function panelContext() {
        return {
            instance: patch.getInstance(),
            originals: {
                renderPromptManager: patch.originals.renderPromptManager,
                renderPromptManagerListItems: patch.originals.renderPromptManagerListItems,
            },
            state: panelState,
            settings,
            diagnostics,
            isPending: () => scheduler.isPending(),
        };
    }

    function requestPanelSync(reason) {
        if (!settings.get().enabled || syncRequested) {
            return;
        }
        syncRequested = true;
        queueMicrotask(() => {
            syncRequested = false;
            const panel = panelContext();
            if (!panel.instance) {
                return;
            }
            if (!panel.originals.renderPromptManager || !panel.originals.renderPromptManagerListItems) {
                // Never pretend to render: without the upstream references the
                // panel would silently stop updating.
                diagnostics.degrade('panel-sync', 'upstream renderer references are unavailable');
                return;
            }
            const endSpan = metrics.startSpan('panelSync');
            if (panelState.structureInvalid) {
                void fullRebuild(panel)
                    .catch(error => diagnostics.warn('Upstream fallback render failed:', error))
                    .finally(endSpan);
                return;
            }
            void syncPanel(panel).finally(endSpan);
        });
        diagnostics.info(`Panel sync requested (${reason})`);
    }

    /**
     * Settings saves fire on every interaction; collapsing them keeps a burst of
     * saves from turning into a burst of panel syncs.
     */
    function requestSettingsSync() {
        if (settingsSyncTimer !== null) {
            return;
        }
        settingsSyncTimer = setTimeout(() => {
            settingsSyncTimer = null;
            requestPanelSync('settings-updated');
        }, 250);
    }

    function syncPanelDirect(reason) {
        const panel = panelContext();
        if (!panel.instance || !panel.originals.renderPromptManager) {
            return Promise.resolve();
        }
        diagnostics.info(`Direct panel sync (${reason})`);
        return syncPanel(panel);
    }

    function reportRecountError(error) {
        const instance = patch.getInstance();
        const message = error instanceof Error ? error.message : String(error || 'Unknown error');
        if (instance) {
            instance.error = message;
        }
        requestPanelSync('recount-error');
    }

    // ---------------------------------------------------------------- interaction

    function isPanelVisible() {
        const container = patch.getInstance()?.containerElement;
        if (!(container instanceof HTMLElement) || !container.isConnected) {
            return false;
        }
        const drawer = container.closest('.drawer-content');
        if (drawer instanceof HTMLElement && !isDrawerOpen(drawer)) {
            return false;
        }
        if (typeof document !== 'undefined' && document.hidden) {
            return false;
        }
        return observedVisible;
    }

    function isInteractionHeld() {
        if (!settings.get().deferDuringScroll) {
            return false;
        }
        if (sorting || document.querySelector('.ui-sortable-helper')) {
            return true;
        }
        return Date.now() < scrollingUntil;
    }

    /**
     * Only interactions with the preset panel matter: typing in the chat must not
     * postpone the recount indefinitely.
     *
     * @param {any} node
     * @returns {boolean}
     */
    function isNodeInsidePanel(node) {
        return node instanceof Element && Boolean(node.closest('#left-nav-panel'));
    }

    function onUserInteraction(event) {
        if (!settings.get().enabled) {
            return;
        }
        const type = String(event?.type ?? 'interaction');
        const target = event?.target;
        const insidePanel = type === 'scroll'
            ? isNodeInsidePanel(target) || isNodeInsidePanel(event?.currentTarget)
            : isNodeInsidePanel(target);
        if (!insidePanel) {
            return;
        }

        if (type === 'scroll') {
            scrollingUntil = Date.now() + SCROLL_HOLD_MS;
            if (scrollHoldTimer !== null) {
                clearTimeout(scrollHoldTimer);
            }
            scrollHoldTimer = setTimeout(() => {
                scrollHoldTimer = null;
                scrollingUntil = 0;
                scheduler.wake('scroll-end');
            }, SCROLL_HOLD_MS);
        }
        scheduler.noteInteraction(type);
    }

    function setSorting(next) {
        if (sorting === next) {
            return;
        }
        sorting = next;
        document.body?.classList.toggle('tt-pl-dragging', next);
        if (next) {
            scheduler.noteInteraction('drag');
        } else {
            scheduler.wake('drag-end');
        }
    }

    // -------------------------------------------------------------------- patches

    const hooksInternal = {
        getMainApi() {
            try {
                return String(getContext().mainApi ?? '');
            } catch {
                diagnostics.noteOnce('main-api', 'Unable to read the main API, treating it as openai');
                return 'openai';
            }
        },
        requestPanelSync,
        markDirty(reason) {
            scheduler.markDirty(reason);
        },
        scheduleRecount(reason) {
            scheduler.schedule(reason);
        },
        onAssemblyFresh(reason) {
            scheduler.markFresh(reason);
            requestPanelSync(reason);
        },
        attachTokenCache(instance) {
            attachTokenCache(instance);
        },
        handleToggle(instance, event, original) {
            return handleToggle(instance, event, original);
        },
        handleInspect(instance, event, original) {
            return handleInspect(instance, event, original);
        },
    };

    const patch = createPromptManagerPatch({
        PromptManager,
        // The imported binding is live: it becomes non-null once the
        // chat-completion module creates the prompt manager.
        getPromptManagerInstance: () => livePromptManager,
        isEnabled: () => settings.get().enabled,
        diagnostics,
        hooks: hooksInternal,
    });

    function attachTokenCache(instance) {
        const handler = instance?.tokenHandler;
        if (!handler || typeof handler.countTokenAsyncFn !== 'function') {
            return;
        }
        if (handler.countTokenAsyncFn.__presetLiteMemoized) {
            return;
        }
        const original = handler.countTokenAsyncFn;
        const memoized = cache.memoize(original);
        Object.defineProperty(memoized, '__presetLiteMemoized', { value: true, enumerable: false });
        handler.countTokenAsyncFn = memoized;
        diagnostics.info('Token counting cache attached');
    }

    function handleToggle(instance, event, original) {
        const row = event?.target?.closest?.('.completion_prompt_manager_prompt') ?? null;
        const key = row?.dataset?.pmIdentifier ?? null;
        const counts = instance.tokenHandler?.getCounts?.() ?? null;
        const previous = key && counts ? counts[key] : undefined;

        const result = original.call(instance, event);

        if (key && counts && previous !== undefined && settings.get().keepStaleNumbers) {
            // Upstream clears the row's number; keep the last known value visible
            // while the recount is pending instead of blanking the whole panel.
            counts[key] = previous;
            // The row's number was just overwritten in the DOM, so the next sync
            // has to write it again. `previousByKey` stays intact: it doubles as
            // the DOM index used to tell new rows from changed ones.
            panelState.forceTokenKeys.add(key);
        }

        scheduler.markDirty('toggle');
        scheduler.schedule('toggle');
        return result;
    }

    async function handleInspect(instance, event, original) {
        const key = event?.target?.closest?.('.completion_prompt_manager_prompt')?.dataset?.pmIdentifier ?? null;
        const hasItem = Boolean(key) && Boolean(instance.messages?.hasItemWithIdentifier?.(key));

        if (key && !hasItem && scheduler.isPending()) {
            await scheduler.recountNow('inspect-missing');
        }

        const result = original.call(instance, event);

        if (key && scheduler.isPending()) {
            void refreshInspectAfterRecount(instance, key);
        }
        return result;
    }

    async function refreshInspectAfterRecount(instance, key) {
        const fresh = await scheduler.recountNow('inspect-refresh');
        if (!fresh) {
            return;
        }
        const prefix = instance.configuration?.prefix ?? 'completion_';
        const area = document.getElementById(`${prefix}prompt_manager_popup_inspect`);
        if (!area || area.style.display === 'none') {
            return;
        }
        const messages = instance.messages?.getItemByIdentifier?.(key);
        if (!messages) {
            return;
        }
        instance.loadMessagesIntoInspectForm(messages);
        diagnostics.info('Inspect popup refreshed with a fresh assembly');
    }

    // -------------------------------------------------- preset apply window bracket

    const presetWindow = createPresetWindowCoalescer({
        settings,
        diagnostics,
        onWindowStart: () => {
            scheduler.markDirty('preset-window');
        },
        onWindowEnd: ({ conflicts }) => {
            requestPanelSync('preset-window');
            scheduler.schedule('preset-window');
            if (conflicts.length > 0) {
                diagnostics.info(`Preset window replay reported ${conflicts.length} conflict(s)`);
            }
        },
    });

    // ----------------------------------------------------------------- benchmark

    const bench = createBench({
        settings,
        metrics,
        diagnostics,
        getJQuery: () => jQuery,
        runtime: {
            getInstance: () => patch.getInstance(),
            getChatLength() {
                const chat = getContext().chat;
                return Array.isArray(chat) ? chat.length : null;
            },
            cacheStats: () => ({ ...cache.stats, size: cache.size(), backend: cache.backend() }),
            schedulerSnapshot: () => scheduler.snapshot(),
            requestPanelSync,
            scheduleRecount: reason => scheduler.schedule(reason),
            assertIdleForBench() {
                if (busy) {
                    throw new Error('Wait for the current generation to finish before running the benchmark');
                }
            },
        },
    });

    // ------------------------------------------------------------------- lifecycle

    function installListeners() {
        for (const type of INTERACTION_EVENTS) {
            document.addEventListener(type, onUserInteraction, { passive: true, capture: true });
            disposers.push(() => document.removeEventListener(type, onUserInteraction, { capture: true }));
        }

        if (jQuery?.fn?.on) {
            const onSortStart = () => setSorting(true);
            const onSortEnd = () => setSorting(false);
            jQuery(document).on('sortstart.ttPresetLite sortbegin.ttPresetLite', onSortStart);
            jQuery(document).on('sortstop.ttPresetLite sortend.ttPresetLite', onSortEnd);
            disposers.push(() => {
                jQuery(document).off('sortstart.ttPresetLite sortbegin.ttPresetLite', onSortStart);
                jQuery(document).off('sortstop.ttPresetLite sortend.ttPresetLite', onSortEnd);
            });
        }

        const generationEvents = [
            [eventTypes.GENERATION_STARTED, () => { busy = true; }],
            [eventTypes.GENERATION_STOPPED, () => { busy = false; scheduler.wake('generation stopped'); }],
            [eventTypes.GENERATION_ENDED, () => { busy = false; scheduler.wake('generation ended'); }],
            [eventTypes.OAI_PRESET_CHANGED_BEFORE, () => presetWindow.open()],
            [eventTypes.OAI_PRESET_CHANGED_AFTER, () => presetWindow.close('preset-changed-after')],
            [eventTypes.PRESET_CHANGED, () => presetWindow.close('preset-changed')],
            [eventTypes.CHATCOMPLETION_SOURCE_CHANGED, () => {
                patch.patchExistingInstance();
                panelState.structureInvalid = false;
                requestPanelSync('source-changed');
            }],
            [eventTypes.SETTINGS_UPDATED, requestSettingsSync],
        ];

        for (const [event, handler] of generationEvents) {
            if (!event) {
                continue;
            }
            eventSource.on(event, handler);
            disposers.push(() => eventSource.removeListener(event, handler));
        }
    }

    function observeVisibility() {
        if (visibilityObserver || typeof IntersectionObserver !== 'function') {
            return;
        }
        const container = patch.getInstance()?.containerElement ?? document.getElementById('completion_prompt_manager');
        if (!container) {
            return;
        }
        const target = container.closest('.drawer-content') ?? container;
        visibilityObserver = new IntersectionObserver(entries => {
            const entry = entries[entries.length - 1];
            observedVisible = entry ? entry.isIntersecting : true;
            scheduler.wake('visibility');
            if (observedVisible) {
                requestPanelSync('visibility');
            }
        });
        visibilityObserver.observe(target);
    }

    function disposeListeners() {
        for (const dispose of disposers.splice(0)) {
            try {
                dispose();
            } catch (error) {
                diagnostics.warn('Listener cleanup failed:', error);
            }
        }
        if (scrollHoldTimer !== null) {
            clearTimeout(scrollHoldTimer);
            scrollHoldTimer = null;
        }
        if (settingsSyncTimer !== null) {
            clearTimeout(settingsSyncTimer);
            settingsSyncTimer = null;
        }
    }

    const unsubscribeSettings = settings.subscribe(() => {
        document.body?.classList.toggle('tt-pl-on', settings.get().enabled);
        if (!settings.get().enabled) {
            presetWindow.flushNow('disabled');
            // Write the real numbers back before upstream takes over again.
            void syncPanelDirect('disabled');
            return;
        }
        scheduler.wake('settings');
        requestPanelSync('settings');
    });

    return {
        version: VERSION,
        settings,
        diagnostics,
        metrics,
        cache,
        bench,
        identity,
        panelState,
        scheduler,
        patch,
        presetWindow,
        hooks,

        start() {
            patch.install();
            if (!patch.originals.renderPromptManager || !patch.originals.renderPromptManagerListItems) {
                throw new Error('PromptManager renderer references were not captured');
            }
            patch.patchExistingInstance();
            document.body?.classList.toggle('tt-pl-on', settings.get().enabled);

            if (jQuery?.fn?.trigger) {
                presetWindow.install(jQuery);
            } else {
                diagnostics.degrade('preset-window', 'jQuery trigger is unavailable');
            }
            installListeners();
            observeVisibility();

            // Warm the cache and produce the first assembly in the background.
            void cache.ensureLoaded();
            requestPanelSync('start');
            scheduler.schedule('start');
            diagnostics.info(`Preset Lite ${VERSION} started (${identity.folder})`);
        },

        stop() {
            unsubscribeSettings();
            disposeListeners();
            visibilityObserver?.disconnect();
            visibilityObserver = null;
            scheduler.stop();
            presetWindow.uninstall();
            patch.uninstall();
            document.body?.classList.remove('tt-pl-dragging');
            document.body?.classList.remove('tt-pl-on');
            hooks.onStop?.();
            diagnostics.info('Preset Lite stopped');
        },

        requestPanelSync,
        scheduleRecount: reason => scheduler.schedule(reason),
        async recountNow(reason) {
            return scheduler.recountNow(reason);
        },
        async clearCache() {
            await cache.clear();
            requestPanelSync('cache-cleared');
        },
        setEnabled(enabled) {
            settings.update({ enabled: Boolean(enabled) });
        },
        snapshot() {
            return {
                version: VERSION,
                enabled: settings.get().enabled,
                folder: identity.folder,
                structureInvalid: panelState.structureInvalid,
                panel: panelState.lastStats,
                scheduler: scheduler.snapshot(),
                cache: { ...cache.stats, size: cache.size(), backend: cache.backend() },
                presetWindow: presetWindow.stats(),
                metrics: metrics.snapshot(),
                diagnostics: diagnostics.snapshot(),
            };
        },
    };
}
