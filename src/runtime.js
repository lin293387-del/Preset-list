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

import { createGestureGate } from './gesture.js';
import { createInputGate } from './input.js';
import { getContext, isMobileHost } from './host.js';
import { createPresetWindowCoalescer } from './patches/preset-window.js';
import { createPromptManagerPatch } from './patches/prompt-manager.js';
import { createPanelState, fullRebuild, syncPanel } from './render/panel.js';
import { createMetrics } from './perf/metrics.js';
import { createTokenCountCache } from './tokens/cache.js';
import { createBrowserScheduler, createRecountScheduler } from './tokens/scheduler.js';
import { VERSION } from './version.js';

/**
 * How long after the last scroll event the list counts as still moving.
 *
 * Only used to hold the recount and to keep the scroll presentation class on; the
 * scroll-end wake-up itself is event driven, so a gesture never waits for a
 * polling tick to be recognised as finished.
 */
const SCROLL_HOLD_MS = 160;
/**
 * A preset switch is something the user waits for, so its recount may not sit
 * behind a repaint: the browser gets this long to find a quiet moment, then the
 * recount runs anyway.
 */
const PRESET_RECOUNT_MAX_IDLE_WAIT_MS = 150;
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
        namespace: 'tavern-optimize',
        resolveModel: getTokenizerModel,
        metrics,
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
    /** When the last preset apply loop finished, epoch milliseconds. */
    let lastPresetAppliedAt = null;
    /** True while the numbers of that switch are still waiting for a fresh assembly. */
    let freshAfterSwitchPending = false;
    /** @type {IntersectionObserver | null} */
    let visibilityObserver = null;
    /** @type {Array<() => void>} */
    const disposers = [];

    /**
     * Records how long a preset switch needed to show exact numbers again.
     *
     * Only the first fresh assembly after the switch counts: the ones that follow
     * belong to the user's next edit. This number is what tells a slow backend
     * apart from a slow assembly, so it must not be diluted by later recounts.
     */
    function noteNumbersFreshForSwitch() {
        if (!freshAfterSwitchPending || lastPresetAppliedAt === null) {
            return;
        }
        freshAfterSwitchPending = false;
        metrics.record('numbersAfterSwitch', Date.now() - lastPresetAppliedAt);
    }

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
            noteNumbersFreshForSwitch();
        },
        onRecountStart: () => {
            if (freshAfterSwitchPending && lastPresetAppliedAt !== null) {
                metrics.record('presetRecountWait', Date.now() - lastPresetAppliedAt);
            }
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

    /**
     * Panel writes are held back for the whole duration of a scroll or a drag.
     *
     * This is the one place that decides *when* the panel may be touched; the
     * renderer decides *what* to touch. Keeping the two apart is what makes the
     * promise "no repaint during a fling" checkable: nothing else in this module
     * calls the renderer directly.
     */
    /**
     * The chat field has its own hold, for a different reason than a gesture.
     *
     * While an IME is composing, the field changes value with every candidate and
     * a DOM write elsewhere can move the caret or drop the composition. The panel
     * therefore waits for the composition to end, and for a moment after ordinary
     * typing, instead of writing into the middle of a sentence. What the hold
     * delays is bookkeeping; nothing the user is typing depends on it.
     */
    const inputGate = createInputGate({
        diagnostics,
        onIdle: reason => {
            panelGate.flush(reason);
            scheduler.wake(reason);
        },
    });

    const panelGate = createGestureGate({
        isHeld: () => isGestureHeld() || inputGate.isHeld(),
        diagnostics,
    });

    function requestPanelSync(reason) {
        if (!settings.get().enabled) {
            return;
        }
        panelGate.run(reason, runPanelSync);
    }

    /**
     * @param {string} reason
     */
    function runPanelSync(reason) {
        if (syncRequested) {
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

    /**
     * True while the user is actively moving the panel: a scroll, a fling or a
     * row drag. During that time nothing may write to the panel DOM.
     *
     * `deferDuringScroll` still exists as a switch, but it now controls the
     * recount hold only — a gesture always gates panel writes, because a repaint
     * under the finger is visible even when the numbers are already correct.
     *
     * @returns {boolean}
     */
    function isGestureHeld() {
        if (sorting || document.querySelector('.ui-sortable-helper')) {
            return true;
        }
        return Date.now() < scrollingUntil;
    }

    /**
     * The recount may additionally be held back while scrolling, which is what
     * `deferDuringScroll` is for: a recount that starts mid-gesture costs CPU the
     * gesture needs.
     *
     * @returns {boolean}
     */
    function isInteractionHeld() {
        if (!settings.get().deferDuringScroll) {
            return false;
        }
        return isGestureHeld();
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
                // The gesture is over: this is the first moment the panel may be
                // touched again, and the waiting work is what the user waits for.
                panelGate.flush('scroll-end');
                scheduler.wake('scroll-end');
            }, SCROLL_HOLD_MS);
            // A scroll is a gesture, not an edit: it must not postpone a recount
            // that is already due, otherwise a long fling keeps the numbers stale
            // for as long as the finger moves.
            return;
        }
        scheduler.noteInteraction(type);
    }

    /**
     * @param {EventTarget | null | undefined} target
     * @returns {boolean} True when the event came from something the user types into.
     */
    function isEditableTarget(target) {
        if (!(target instanceof Element)) {
            return false;
        }
        const tag = target.tagName;
        if (tag === 'TEXTAREA' || tag === 'INPUT') {
            return true;
        }
        return /** @type {any} */ (target).isContentEditable === true
            || target.closest('[contenteditable="true"]') !== null;
    }

    /**
     * @param {any} event
     */
    function onCompositionStart(event) {
        if (!settings.get().enabled || !isEditableTarget(event?.target)) {
            return;
        }
        inputGate.beginComposition();
    }

    /**
     * @param {any} event
     */
    function onCompositionEnd(event) {
        if (!isEditableTarget(event?.target)) {
            return;
        }
        inputGate.endComposition();
    }

    /**
     * @param {any} event
     */
    function onInput(event) {
        if (!settings.get().enabled || !isEditableTarget(event?.target)) {
            return;
        }
        inputGate.noteInput();
    }

    function setSorting(next) {
        if (sorting === next) {
            return;
        }
        sorting = next;
        document.body?.classList.toggle('tt-to-dragging', next);
        if (next) {
            scheduler.noteInteraction('drag');
        } else {
            panelGate.flush('drag-end');
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
            noteNumbersFreshForSwitch();
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
        onWindowEnd: ({ reason, conflicts, durationMs, fieldLoopMs, chainMs, replayMs, closedAt }) => {
            metrics.record('presetReplay', replayMs);
            const isSwitch = reason === 'preset-changed-after' || reason === 'preset-changed';
            if (isSwitch) {
                metrics.record('presetApply', durationMs);
                if (fieldLoopMs > 0) {
                    metrics.record('presetApplyFields', fieldLoopMs);
                }
                metrics.record('presetApplyChain', chainMs);
                lastPresetAppliedAt = closedAt || Date.now();
                freshAfterSwitchPending = true;
            }
            requestPanelSync('preset-window');
            scheduler.schedule('preset-window', { maxIdleWaitMs: PRESET_RECOUNT_MAX_IDLE_WAIT_MS });
            if (isSwitch) {
                // A preset switch is a completed gesture, not an ongoing edit: the
                // recount may start once it has settled instead of waiting out the
                // full quiet time that typing and scrubbing need.
                scheduler.noteDiscreteAction('preset-switch');
            }
            if (conflicts.length > 0) {
                diagnostics.info(`Preset window replay reported ${conflicts.length} conflict(s)`);
            }
        },
    });

    // ------------------------------------------------------------------- lifecycle

    function installListeners() {
        for (const type of INTERACTION_EVENTS) {
            document.addEventListener(type, onUserInteraction, { passive: true, capture: true });
            disposers.push(() => document.removeEventListener(type, onUserInteraction, { capture: true }));
        }

        // The chat field. `input` fires per keystroke; the gate folds a burst into
        // one frame and holds the panel until the user stops typing.
        /** @type {Array<[string, (event: any) => void]>} */
        const fieldEvents = [
            ['compositionstart', onCompositionStart],
            ['compositionend', onCompositionEnd],
            ['input', onInput],
        ];
        for (const [type, handler] of fieldEvents) {
            document.addEventListener(type, handler, { passive: true, capture: true });
            disposers.push(() => document.removeEventListener(type, handler, { capture: true }));
        }

        if (jQuery?.fn?.on) {
            const onSortStart = () => setSorting(true);
            const onSortEnd = () => setSorting(false);
            jQuery(document).on('sortstart.ttTavernOptimize sortbegin.ttTavernOptimize', onSortStart);
            jQuery(document).on('sortstop.ttTavernOptimize sortend.ttTavernOptimize', onSortEnd);
            disposers.push(() => {
                jQuery(document).off('sortstart.ttTavernOptimize sortbegin.ttTavernOptimize', onSortStart);
                jQuery(document).off('sortstop.ttTavernOptimize sortend.ttTavernOptimize', onSortEnd);
            });
        }

        const generationEvents = [
            // A prompt-assembly preview (the "dry run" that produces the token
            // numbers) emits GENERATION_STARTED with `dryRun === true` and returns
            // before the event that normally closes a generation is emitted.
            // Treating it as a running generation used to latch this flag, which
            // parked every later recount and left the panel on stale or "-" numbers.
            [eventTypes.GENERATION_STARTED, (_type, _options, isDryRun) => {
                if (isDryRun) {
                    return;
                }
                busy = true;
            }],
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
        panelGate.clear();
        inputGate.clear();
        if (settingsSyncTimer !== null) {
            clearTimeout(settingsSyncTimer);
            settingsSyncTimer = null;
        }
    }

    /**
     * Publishes the host platform to CSS.
     *
     * The paint-degradation layer in `style.css` is scoped to
     * `body.tt-to-on.tt-to-mobile`, so this class is the only thing that decides
     * whether an Android/iOS device gets the cheap paint path. A missing host
     * identity is reported rather than silently treated as desktop.
     */
    function applyHostClasses() {
        const onMobileHost = isMobileHost();
        // The paint layer is a look-for-speed trade, so it is the user's call as well
        // as the platform's: mobile by default, and off the moment the switch is off.
        const mobile = onMobileHost && settings.get().mobilePaintLayer;
        document.body?.classList.toggle('tt-to-mobile', mobile);
        if (!onMobileHost && !globalThis.__TAURITAVERN_HOST__) {
            diagnostics.degrade('paint-downgrade', 'host identity is missing, so the paint layer stays off');
        }
    }

    const unsubscribeSettings = settings.subscribe(() => {
        document.body?.classList.toggle('tt-to-on', settings.get().enabled);
        // Flipping the paint switch takes effect immediately: it is one body class,
        // so nothing has to be re-rendered or reloaded.
        applyHostClasses();
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
            document.body?.classList.toggle('tt-to-on', settings.get().enabled);
            applyHostClasses();

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
            diagnostics.info(`Tavern Optimize ${VERSION} started (${identity.folder})`);
        },

        stop() {
            unsubscribeSettings();
            disposeListeners();
            visibilityObserver?.disconnect();
            visibilityObserver = null;
            scheduler.stop();
            presetWindow.uninstall();
            patch.uninstall();
            document.body?.classList.remove('tt-to-dragging');
            document.body?.classList.remove('tt-to-mobile');
            document.body?.classList.remove('tt-to-on');
            hooks.onStop?.();
            diagnostics.info('Tavern Optimize stopped');
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
        panelGate,
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
