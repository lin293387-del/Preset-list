// @ts-check
/**
 * Preset-apply window coalescing.
 *
 * Switching a chat-completion preset runs one synchronous loop that writes
 * ~100 form fields and fires an `input` event for each of them. Every event runs
 * the same UI-sync handlers (counters, cost previews, debounced saves) again and
 * again, even though only the final values matter.
 *
 * Upstream emits `OAI_PRESET_CHANGED_BEFORE` immediately before that loop and
 * `OAI_PRESET_CHANGED_AFTER` after it, which gives us an exact window:
 *
 * - inside the window, `input` events carrying `{ source: 'preset' }` that target
 *   a field of the left navigation panel are recorded instead of dispatched,
 * - at the end of the window they are replayed in order, once per element,
 *   through the untouched jQuery trigger, so handlers observe the final values.
 *   Fields that still hold the value they had when the window opened are skipped:
 *   the handler would repeat work the preset did not change,
 * - fields whose value a replayed handler changed afterwards are reported, since
 *   that means a handler disagreed with the preset,
 * - a `change` event a preset re-fires for a select it did not move is dropped for
 *   the same reason: rebuilding model dropdowns, re-checking the connection and
 *   re-tokenizing the character editor are not needed for an unchanged value.
 *
 * Every other event keeps its original timing, and a `change` event whose value
 * did move is dispatched exactly like upstream dispatches it.
 */

const WINDOW_SAFETY_TIMEOUT_MS = 1500;
const LEFT_NAV_SELECTOR = '#left-nav-panel';

/**
 * Values of every panel field at the moment the window opened.
 *
 * Upstream writes a field and fires its event even when the new value equals the
 * old one. With this snapshot the replay can tell a real change from a redundant
 * write, which is what makes "the preset did not move this field" cheap.
 *
 * @returns {Map<any, string> | null} Null when there is no panel to read.
 */
function capturePanelValues() {
    if (typeof document === 'undefined') {
        return null;
    }
    const panel = document.querySelector(LEFT_NAV_SELECTOR);
    if (!panel || typeof panel.querySelectorAll !== 'function') {
        return null;
    }
    const values = new Map();
    for (const element of panel.querySelectorAll('input, select, textarea')) {
        values.set(element, snapshotValue(element));
    }
    return values;
}

/**
 * @param {any} value
 * @returns {value is Element}
 */
function isElementLike(value) {
    return Boolean(value) && typeof value === 'object' && value.nodeType === 1 && typeof value.closest === 'function';
}

/**
 * @param {any} data
 * @returns {boolean}
 */
function isPresetEventData(data) {
    return Boolean(data) && typeof data === 'object' && data.source === 'preset';
}

/**
 * @param {any} element
 * @returns {string}
 */
function describeElement(element) {
    const id = typeof element.id === 'string' && element.id ? `#${element.id}` : '';
    const name = typeof element.getAttribute === 'function' ? element.getAttribute('name') : '';
    const classNames = typeof element.className === 'string' && element.className
        ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
    return `${element.tagName?.toLowerCase?.() ?? 'element'}${id}${name ? `[name="${name}"]` : ''}${classNames}`;
}

/**
 * @param {any} element
 * @returns {string}
 */
function snapshotValue(element) {
    const type = typeof element.type === 'string' ? element.type : '';
    if (type === 'checkbox' || type === 'radio') {
        return String(Boolean(element.checked));
    }
    return String(element.value ?? '');
}

/**
 * @param {object} options
 * @param {{ get: () => { coalescePresetEvents: boolean, reportPresetConflicts: boolean } }} options.settings
 * @param {{ info: Function, warn: Function, recordConflict: Function, noteOnce: Function }} options.diagnostics
 * @param {(summary: {
 *   reason: string,
 *   replayed: number,
 *   conflicts: Array<object>,
 *   durationMs: number,
 *   fieldLoopMs: number,
 *   chainMs: number,
 *   replayMs: number,
 *   unchanged: number,
 *   redundantChanges: number,
 *   closedAt: number,
 * }) => void} [options.onWindowEnd]
 * @param {() => void} [options.onWindowStart]
 * @param {() => Map<any, string> | null} [options.captureBaseline] Override for tests.
 */
export function createPresetWindowCoalescer({ settings, diagnostics, onWindowEnd, onWindowStart, captureBaseline = capturePanelValues }) {
    const stats = {
        windows: 0,
        deferred: 0,
        replayed: 0,
        conflicts: 0,
        unchanged: 0,
        redundantChanges: 0,
        lastDurationMs: 0,
        lastFieldLoopMs: 0,
        lastChainMs: 0,
        lastReplayMs: 0,
        lastUnchanged: 0,
        lastRedundantChanges: 0,
        lastClosedAt: 0,
    };

    let installed = false;
    let active = false;
    let openedAt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let safetyTimer = null;
    /** @type {any} */
    let jQueryRef = null;
    /** @type {((this: any, ...args: any[]) => any) | null} */
    let originalTrigger = null;

    /**
     * Dispatches through the untouched jQuery trigger.
     *
     * @param {any} jqueryCollection
     * @param {any[]} args
     * @returns {any}
     */
    function dispatchOriginal(jqueryCollection, args) {
        if (!originalTrigger) {
            return jqueryCollection;
        }
        return originalTrigger.apply(jqueryCollection, args);
    }

    /** @type {Map<any, { type: string, data: any }>} */
    let deferred = new Map();
    /** @type {Map<any, string> | null} */
    let baseline = null;
    let lastDeferredAt = 0;
    let windowRedundantChanges = 0;

    function clearSafetyTimer() {
        if (safetyTimer !== null) {
            clearTimeout(safetyTimer);
            safetyTimer = null;
        }
    }

    /**
     * True when the element still holds the value it had before the preset was
     * applied. Elements the snapshot does not know count as changed, so an
     * unknown field always keeps its handler.
     *
     * @param {any} element
     * @param {Map<any, string> | null} [values]
     * @returns {boolean}
     */
    function isUnchanged(element, values = baseline) {
        if (!values || !values.has(element)) {
            return false;
        }
        return values.get(element) === snapshotValue(element);
    }

    function open() {
        if (active) {
            return;
        }
        active = true;
        openedAt = Date.now();
        baseline = captureBaseline?.() ?? null;
        lastDeferredAt = 0;
        windowRedundantChanges = 0;
        stats.windows += 1;
        // Upstream can bail out of the apply loop without emitting the AFTER
        // event; the window must never stay open and swallow input events.
        clearSafetyTimer();
        safetyTimer = setTimeout(() => close('safety-timeout'), WINDOW_SAFETY_TIMEOUT_MS);
        onWindowStart?.();
    }

    /**
     * @param {string} reason
     */
    function close(reason) {
        if (!active) {
            return;
        }
        active = false;
        clearSafetyTimer();
        stats.lastClosedAt = Date.now();
        stats.lastDurationMs = stats.lastClosedAt - openedAt;
        stats.lastFieldLoopMs = lastDeferredAt > 0 ? lastDeferredAt - openedAt : 0;
        stats.lastChainMs = lastDeferredAt > 0 ? stats.lastClosedAt - lastDeferredAt : stats.lastDurationMs;
        stats.lastRedundantChanges = windowRedundantChanges;

        const entries = [...deferred.entries()];
        deferred = new Map();
        const valuesAtOpen = baseline;

        // Let the whole preset-apply task finish before replaying.
        setTimeout(() => {
            replay(entries, reason, valuesAtOpen);
        }, 0);
    }

    /**
     * @param {Array<[any, { type: string, data: any }]>} entries
     * @param {string} reason
     * @param {Map<any, string> | null} valuesAtOpen
     */
    function replay(entries, reason, valuesAtOpen) {
        stats.deferred += entries.length;
        const conflicts = [];
        const startedAt = Date.now();
        let unchanged = 0;

        for (const [element, record] of entries) {
            if (isUnchanged(element, valuesAtOpen)) {
                // The preset wrote the value that was already there: the handler
                // would repeat work that is already done.
                unchanged += 1;
                continue;
            }
            const before = snapshotValue(element);
            try {
                dispatchOriginal(jQueryRef(element), [record.type, record.data]);
            } catch (error) {
                diagnostics.warn('Coalesced preset event replay failed:', error);
                continue;
            }
            stats.replayed += 1;
            const after = snapshotValue(element);
            if (before !== after) {
                const conflict = { selector: describeElement(element), before, after };
                conflicts.push(conflict);
                stats.conflicts += 1;
                if (settings.get().reportPresetConflicts) {
                    diagnostics.recordConflict(conflict);
                }
            }
        }

        stats.unchanged += unchanged;
        stats.lastUnchanged = unchanged;
        stats.lastReplayMs = Date.now() - startedAt;

        if (conflicts.length > 0) {
            diagnostics.noteOnce(
                'preset-conflicts',
                `Coalesced preset handlers changed ${conflicts.length} preset field(s) afterwards; see diagnostics for details`,
            );
        }

        onWindowEnd?.({
            reason,
            replayed: stats.replayed,
            conflicts,
            durationMs: stats.lastDurationMs,
            fieldLoopMs: stats.lastFieldLoopMs,
            chainMs: stats.lastChainMs,
            replayMs: stats.lastReplayMs,
            unchanged,
            redundantChanges: stats.lastRedundantChanges,
            closedAt: stats.lastClosedAt,
        });
    }

    /**
     * @param {any} jQuery
     */
    function install(jQuery) {
        if (installed) {
            return;
        }
        if (!jQuery?.fn?.trigger) {
            throw new Error('[Preset Lite] jQuery trigger is unavailable');
        }

        jQueryRef = jQuery;
        originalTrigger = jQuery.fn.trigger;

        /**
         * @this {any}
         * @param {any} type
         * @param {any} data
         * @returns {any}
         */
        const wrapped = function triggerWithPresetCoalescing(type, data) {
            if (active && typeof type === 'string' && settings.get().coalescePresetEvents) {
                if (type === 'input' && isPresetEventData(data)) {
                    return deferInput(this, type, data);
                }
                if (type === 'change' && !isPresetEventData(data)) {
                    const elements = Array.from(this);
                    const unmovedSelects = elements.length > 0 && elements.every(element => isElementLike(element)
                        && String(element.tagName ?? '').toUpperCase() === 'SELECT'
                        && element.closest(LEFT_NAV_SELECTOR)
                        && isUnchanged(element));
                    if (unmovedSelects) {
                        // Upstream re-fires these selects after every preset apply,
                        // even when the preset did not move them. Their handlers
                        // rebuild model dropdowns, re-check the connection and
                        // re-tokenize the character editor: work that is already
                        // done for a value that did not change.
                        windowRedundantChanges += elements.length;
                        stats.redundantChanges += elements.length;
                        return this;
                    }
                }
            }

            return dispatchOriginal(this, Array.from(arguments));
        };

        /**
         * Records a preset `input` event instead of running its handlers.
         *
         * @param {any} collection
         * @param {string} type
         * @param {any} data
         * @returns {any}
         */
        function deferInput(collection, type, data) {
            let deferredAny = false;
            for (const element of collection) {
                if (!isElementLike(element) || !element.closest(LEFT_NAV_SELECTOR)) {
                    continue;
                }
                deferred.set(element, { type, data });
                deferredAny = true;
            }

            if (!deferredAny) {
                return dispatchOriginal(collection, [type, data]);
            }

            lastDeferredAt = Date.now();
            return collection;
        }

        jQuery.fn.trigger = wrapped;
        installed = true;
    }

    return {
        install,
        open,
        close,
        isActive: () => active,
        pendingCount: () => deferred.size,
        stats: () => ({ ...stats }),
        /** Used when the extension is switched off: nothing may stay deferred. */
        flushNow(reason = 'forced') {
            if (!active) {
                return;
            }
            close(reason);
        },
        uninstall() {
            if (installed && jQueryRef?.fn && originalTrigger) {
                jQueryRef.fn.trigger = originalTrigger;
            }
            installed = false;
            clearSafetyTimer();
            active = false;
            deferred = new Map();
        },
    };
}
