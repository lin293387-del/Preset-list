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
 *   through the untouched jQuery trigger, so handlers observe the final values,
 * - fields whose value a replayed handler changed afterwards are reported, since
 *   that means a handler disagreed with the preset.
 *
 * `change` events and every other `input` event keep their original timing.
 */

const WINDOW_SAFETY_TIMEOUT_MS = 1500;
const LEFT_NAV_SELECTOR = '#left-nav-panel';

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
 * @param {(summary: { reason: string, replayed: number, conflicts: Array<object>, durationMs: number }) => void} [options.onWindowEnd]
 * @param {() => void} [options.onWindowStart]
 */
export function createPresetWindowCoalescer({ settings, diagnostics, onWindowEnd, onWindowStart }) {
    const stats = { windows: 0, deferred: 0, replayed: 0, conflicts: 0, lastDurationMs: 0 };

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

    function clearSafetyTimer() {
        if (safetyTimer !== null) {
            clearTimeout(safetyTimer);
            safetyTimer = null;
        }
    }

    function open() {
        if (active) {
            return;
        }
        active = true;
        openedAt = Date.now();
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
        stats.lastDurationMs = Date.now() - openedAt;

        const entries = [...deferred.entries()];
        deferred = new Map();

        // Let the whole preset-apply task finish before replaying.
        setTimeout(() => {
            replay(entries, reason);
        }, 0);
    }

    /**
     * @param {Array<[any, { type: string, data: any }]>} entries
     * @param {string} reason
     */
    function replay(entries, reason) {
        stats.deferred += entries.length;
        const conflicts = [];

        for (const [element, record] of entries) {
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

        if (conflicts.length > 0) {
            diagnostics.noteOnce(
                'preset-conflicts',
                `Coalesced preset handlers changed ${conflicts.length} preset field(s) afterwards; see diagnostics for details`,
            );
        }

        onWindowEnd?.({ reason, replayed: stats.replayed, conflicts, durationMs: stats.lastDurationMs });
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
            const shouldDefer = active
                && typeof type === 'string'
                && type === 'input'
                && isPresetEventData(data)
                && settings.get().coalescePresetEvents;

            if (!shouldDefer) {
                return dispatchOriginal(this, Array.from(arguments));
            }

            let deferredAny = false;
            for (const element of this) {
                if (!isElementLike(element) || !element.closest(LEFT_NAV_SELECTOR)) {
                    continue;
                }
                deferred.set(element, { type, data });
                deferredAny = true;
            }

            if (!deferredAny) {
                return dispatchOriginal(this, Array.from(arguments));
            }

            return this;
        };

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
