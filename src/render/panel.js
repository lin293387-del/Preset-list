// @ts-check
/**
 * Incremental rendering for the chat-completion prompt panel.
 *
 * Upstream renders the panel by clearing `#completion_prompt_manager` and
 * rebuilding header, footer and every row. That work is repeated for every
 * interaction and is what makes the panel feel heavy: the row builder alone
 * (HTML assembly + one `insertAdjacentHTML` + four listener lookups per row)
 * dominates a sync for long prompt lists.
 *
 * The sync therefore picks the cheapest path that can still be correct:
 *
 * - **fast path** — the prompt model and every row signature are unchanged, so
 *   only the token cells and the total are written in place; upstream is not
 *   called at all. This is what a finished recount and an idle panel hit.
 * - **local rebuild** — a single row changed: upstream still builds the markup
 *   (single source of truth) but is pointed at that one prompt, so one row is
 *   assembled instead of the whole list.
 * - **full rebuild** — anything else (add, delete, reorder, character change,
 *   a different error) rebuilds every row, which is the only safe answer when
 *   the row set itself moved.
 *
 * Every fast path is guarded by the same checks the slow path relies on, and a
 * guard that does not hold simply means the slow path runs; it is never a
 * silent no-op.
 */

import { RowParseError, extractRowMeta, planRowOps } from './plan.js';
import { applyLocalRows, applyRowPlan, createNodeFromHtml, syncHeadNodes, updateTokenNumbers } from './apply.js';

/** Consecutive unexpected render failures before the extension steps aside. */
const MAX_SYNC_FAILURES = 3;

/**
 * @returns {object} Fresh per-instance render state.
 */
export function createPanelState() {
    return {
        queue: Promise.resolve(),
        listElement: null,
        headerDiv: null,
        footerDiv: null,
        totalDiv: null,
        totalTextNode: null,
        select: null,
        nodeByKey: new Map(),
        previousByKey: new Map(),
        structureSignature: null,
        errorSignature: undefined,
        placeholderApplied: false,
        structureInvalid: false,
        syncFailures: 0,
        /** Keys whose token cell must be rewritten on the next sync. */
        forceTokenKeys: new Set(),
        delegationTarget: null,
        delegationHandler: null,
        lastStats: null,
        /** Which path the last sync took: `tokens`, `local`, `chrome` or `full`. */
        lastPath: null,
        /** Per-prompt fingerprint of everything the upstream row template reads. */
        rowSignatures: new Map(),
        /** Instance-wide inputs of the row template (token usage, budgets, overrides). */
        rowGlobals: '',
        /** Watches the first row so the CSS placeholder height matches reality. */
        rowObserver: null,
        rowObserverTarget: null,
        rowObserverList: null,
    };
}

/**
 * Finds the element that actually scrolls the prompt panel.
 *
 * Upstream reads and restores the offset through `.scrollableInner` as well, so
 * the same ancestor is used here.
 *
 * @param {HTMLElement | null | undefined} element
 * @returns {HTMLElement | null}
 */
function findScroller(element) {
    if (!(element instanceof HTMLElement)) {
        return null;
    }
    return element.closest('.scrollableInner') ?? element.parentElement?.closest?.('.scrollableInner') ?? null;
}

/**
 * Keeps the panel's scroll offset across one DOM update.
 *
 * The browser clamps `scrollTop` whenever the scrolled content shrinks — an
 * emptied list collapses the container and the offset is rewritten to 0. Upstream
 * restores its own offset around *its* render, but this extension's render is
 * asynchronous and runs after that restore, so anything the sync collapses would
 * stay collapsed: the panel jumped back to the top of the prompt list after a
 * delete or a duplicate.
 *
 * Checking the offset afterwards is not free: reading `scrollTop` after the sync
 * wrote to the DOM forces a synchronous layout of every row, which a CPU profile
 * charges to that read and which showed up as the single most expensive line in
 * the render path. A sync that only rewrote token cells cannot shrink the list, so
 * it asks for no check at all and keeps the layout out of the blocking window.
 *
 * @param {HTMLElement | null | undefined} element
 * @returns {{ end: (rowsTouched?: boolean) => void }}
 */
function preserveScroll(element) {
    const scroller = findScroller(element);
    if (!scroller) {
        return { end() {} };
    }
    const top = scroller.scrollTop;
    return {
        /** @param {boolean} [rowsTouched] */
        end(rowsTouched = true) {
            if (!rowsTouched) {
                return;
            }
            if (scroller.scrollTop !== top) {
                scroller.scrollTop = top;
            }
        },
    };
}

/**
 * Publishes the measured row height as a CSS custom property.
 *
 * The stylesheet skips painting rows that are scrolled out of view, and a skipped
 * row can only contribute a *guessed* height to the scroll range. Guessing wrong
 * is what makes a fast fling look broken: the browser reserves too little (or too
 * much) space, the scrollbar jumps, and rows that are flung into view are laid out
 * from a stale guess. Publishing the height a row really has keeps the scroll
 * range honest without forcing a layout in the sync path — the observer reports it
 * only when it changes (theme, font size, row content).
 *
 * @param {object} state
 * @param {HTMLElement} listElement
 */
function observeRowMetrics(state, listElement) {
    const first = listElement.querySelector('li[data-pm-identifier]');
    if (!first) {
        return;
    }
    // Rows survive a structural rebuild, so the row node alone cannot tell whether
    // this list element has already been measured: a rebuild hands the same rows to
    // a brand-new `<ul>`, which still needs the property.
    if (state.rowObserverTarget === first && state.rowObserver && state.rowObserverList === listElement) {
        return;
    }

    const publish = () => {
        const height = first.getBoundingClientRect().height;
        if (height > 0) {
            listElement.style.setProperty('--tt-to-row-height', `${height.toFixed(2)}px`);
        }
    };

    if (typeof ResizeObserver !== 'function') {
        publish();
        return;
    }

    state.rowObserver?.disconnect();
    state.rowObserver = new ResizeObserver(publish);
    state.rowObserver.observe(first);
    state.rowObserverTarget = first;
    state.rowObserverList = listElement;
    publish();
}

/**
 * @param {object} state
 */
function stopRowMetrics(state) {
    state.rowObserver?.disconnect();
    state.rowObserver = null;
    state.rowObserverTarget = null;
    state.rowObserverList = null;
}

/**
 * @param {HTMLElement | null} headerDiv
 * @returns {{ div: HTMLElement | null, textNode: Text | null }}
 */
function findTotalNodes(headerDiv) {
    if (!headerDiv) {
        return { div: null, textNode: null };
    }
    const divs = Array.from(headerDiv.querySelectorAll('div'));
    const totalDiv = divs.length > 0 ? divs[divs.length - 1] : null;
    if (!totalDiv) {
        return { div: null, textNode: null };
    }
    /** @type {Text | null} */
    let textNode = null;
    for (const node of Array.from(totalDiv.childNodes)) {
        if (node instanceof Text && String(node.nodeValue ?? '').trim().length > 0) {
            textNode = node;
        }
    }
    return { div: totalDiv, textNode };
}

/**
 * @param {any} instance
 * @returns {string}
 */
function getPrefix(instance) {
    return instance?.configuration?.prefix ?? 'completion_';
}

/**
 * Signature of everything the footer select and row set depend on. When it
 * changes the structure is rebuilt (add/delete/import/rename prompts), otherwise
 * the existing DOM is reused.
 *
 * @param {any} instance
 * @returns {string}
 */
export function structureSignature(instance) {
    const prompts = Array.isArray(instance?.serviceSettings?.prompts) ? instance.serviceSettings.prompts : [];
    const selectable = prompts
        .filter(prompt => prompt && !prompt.system_prompt)
        .map(prompt => `${prompt.identifier}\u0000${prompt.name}`)
        .sort();
    const characterId = instance?.activeCharacter?.id ?? '';
    return `${characterId}\u0001${selectable.join('\u0002')}`;
}

/**
 * Temporarily points the upstream renderer at a detached container.
 *
 * @param {any} instance
 * @param {HTMLElement} scratch
 * @returns {() => void}
 */
function swapRenderTarget(instance, scratch) {
    const previousContainer = instance.containerElement;
    const previousList = instance.listElement;
    instance.containerElement = scratch;
    instance.listElement = null;
    return () => {
        instance.containerElement = previousContainer;
        instance.listElement = previousList;
    };
}

/**
 * @param {any} instance
 * @param {object} state
 * @param {{ degrade: Function, info: Function, error: Function }} diagnostics
 */
function captureStructureRefs(instance, state, diagnostics) {
    const container = instance.containerElement;
    const prefix = getPrefix(instance);

    state.listElement = container.querySelector(`#${prefix}prompt_manager_list`);
    state.headerDiv = container.querySelector(`.${prefix}prompt_manager_header`);
    state.footerDiv = container.querySelector(`.${prefix}prompt_manager_footer`);
    state.select = container.querySelector(`#${prefix}prompt_manager_footer_append_prompt`);

    const total = findTotalNodes(state.headerDiv);
    state.totalDiv = total.div;
    state.totalTextNode = total.textNode;

    if (!(state.listElement instanceof HTMLElement)) {
        throw new RowParseError(`Upstream prompt list #${prefix}prompt_manager_list not found`);
    }
    if (!(state.headerDiv instanceof HTMLElement)) {
        throw new RowParseError(`Upstream prompt header .${prefix}prompt_manager_header not found`);
    }
    diagnostics.info('Panel structure captured');
}

/**
 * Wires row actions once per list element. Upstream binds four listeners per
 * row; delegation makes row replacement free of listener bookkeeping.
 *
 * @param {any} instance
 * @param {object} state
 */
function installRowDelegation(instance, state) {
    const list = state.listElement;
    if (!list || state.delegationTarget === list) {
        return;
    }

    if (state.delegationTarget && state.delegationHandler) {
        state.delegationTarget.removeEventListener('click', state.delegationHandler);
    }

    const handler = event => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }
        const action = target.closest('.prompt-manager-toggle-action, .prompt-manager-inspect-action, .prompt-manager-edit-action, .prompt-manager-detach-action');
        if (!action) {
            return;
        }

        if (action.classList.contains('prompt-manager-toggle-action')) {
            instance.handleToggle(event);
            return;
        }
        if (action.classList.contains('prompt-manager-inspect-action')) {
            instance.handleInspect(event);
            return;
        }
        if (action.classList.contains('prompt-manager-edit-action')) {
            instance.handleEdit(event);
            return;
        }
        instance.handleDetach(event);
    };

    list.addEventListener('click', handler, false);
    state.delegationTarget = list;
    state.delegationHandler = handler;
}

/**
 * Adopts the rows rendered before a structural rebuild.
 *
 * They are moved into the new list instead of being discarded with the old
 * structure, so the scroll container never loses its height, and they are
 * re-indexed from their own markup so the diff below can tell a row that only
 * changed its token number from one that really has to be rebuilt.
 *
 * @param {object} state
 * @returns {Element[]}
 */
function takeLiveRows(state) {
    const list = state.listElement;
    const rows = list ? Array.from(list.children).filter(node => node.getAttribute('data-pm-identifier')) : [];
    const indexedNodes = state.nodeByKey;
    const indexedMeta = state.previousByKey;
    state.nodeByKey = new Map();
    state.previousByKey = new Map();
    for (const node of rows) {
        const key = node.getAttribute('data-pm-identifier');
        // A row this extension indexed last sync, still the same node: its markup
        // is whatever it was rendered from, so the fingerprint is already known.
        // Re-deriving it means serialising and re-parsing every row — 200 of them
        // on a long list — to arrive at the answer that is already in hand.
        const known = indexedNodes.get(key);
        if (known === node && indexedMeta.has(key)) {
            state.nodeByKey.set(key, node);
            state.previousByKey.set(key, indexedMeta.get(key));
            continue;
        }
        try {
            const meta = extractRowMeta(node.outerHTML);
            state.previousByKey.set(meta.key, meta);
            state.nodeByKey.set(meta.key, node);
        } catch {
            // A row whose markup cannot be parsed is not indexed, so the next
            // sync replaces it instead of trusting a stale node.
        }
    }
    return rows;
}

/**
 * Puts previously rendered rows back into a freshly built list.
 *
 * This is what keeps the panel from scrolling to the top: an emptied list
 * collapses the scroll container, the browser clamps `scrollTop` to 0 while the
 * list is empty, and the offset cannot be restored afterwards. The rows stay
 * until their replacements are ready, so the container never loses its height.
 *
 * @param {Element | null} listElement
 * @param {Element[]} rows
 */
function appendRows(listElement, rows) {
    if (!listElement || rows.length === 0) {
        return;
    }
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
        fragment.appendChild(row);
    }
    listElement.appendChild(fragment);
}

/**
 * Rebuilds container/header/footer from upstream markup and adopts it.
 *
 * The rows rendered before the rebuild are moved into the new list instead of
 * being discarded with the old structure, so the scroll position survives the
 * empty window and the row diff below can reuse their nodes.
 *
 * @param {object} context
 * @returns {Promise<void>}
 */
async function rebuildStructure(context) {
    const { instance, originals, state, diagnostics } = context;
    const container = instance.containerElement;
    const scratch = document.createElement('div');
    const restore = swapRenderTarget(instance, scratch);

    try {
        await originals.renderPromptManager.call(instance);
    } finally {
        restore();
    }

    const liveRows = takeLiveRows(state);
    container.replaceChildren(...Array.from(scratch.childNodes));

    state.placeholderApplied = false;

    captureStructureRefs(instance, state, diagnostics);
    appendRows(state.listElement, liveRows);

    instance.listElement = state.listElement;
    try {
        instance.makeDraggable();
    } catch (error) {
        diagnostics.warn('Prompt reorder could not be initialized by the plugin:', error);
    }
    installRowDelegation(instance, state);
    observeRowMetrics(state, state.listElement);

    state.structureSignature = structureSignature(instance);
    state.errorSignature = instance.error;
}

/**
 * @param {HTMLElement} listElement
 * @returns {string[]}
 */
function currentRowKeys(listElement) {
    /** @type {string[]} */
    const keys = [];
    for (const node of Array.from(listElement.children)) {
        const key = node.getAttribute('data-pm-identifier');
        if (key) {
            keys.push(key);
        }
    }
    return keys;
}

/**
 * @param {HTMLElement} listElement
 * @returns {Element[]}
 */
function rowNodes(listElement) {
    return Array.from(listElement.children).filter(node => node.getAttribute('data-pm-identifier'));
}

/**
 * The prompt model upstream would render, in render order.
 *
 * A failed lookup throws instead of returning an empty list: "no prompts" and
 * "cannot tell" must never look the same to a caller that decides whether it may
 * reuse what is on screen.
 *
 * @param {any} instance
 * @returns {string[]}
 */
function promptModelKeys(instance) {
    let keys;
    try {
        keys = instance.getPromptsForCharacter?.(instance.activeCharacter)
            ?.filter(Boolean)
            ?.map(prompt => String(prompt.identifier));
    } catch (error) {
        throw new RowParseError(`Prompt model lookup failed: ${error instanceof Error ? error.message : error}`);
    }
    if (!Array.isArray(keys)) {
        throw new RowParseError('Prompt model lookup is unavailable; cannot verify rendered rows');
    }
    return keys;
}

/**
 * @param {string[]} expected
 * @param {Array<{ key: string }>} rows
 * @returns {boolean}
 */
function rowsMatchKeys(expected, rows) {
    return rows.length === expected.length && rows.every((row, index) => row.key === expected[index]);
}

/**
 * Cross-checks the freshly built rows against the prompt model upstream renders
 * from. A mismatch means the upstream list markup changed shape (or another
 * extension rewrote it), and reconciling would silently drop rows, so callers
 * must fall back to the upstream renderer instead.
 *
 * @param {any} instance
 * @param {Array<{ key: string }>} nextRows
 */
function assertRowsMatchPromptModel(instance, nextRows) {
    const expectedKeys = promptModelKeys(instance);
    if (!rowsMatchKeys(expectedKeys, nextRows)) {
        throw new RowParseError(
            `Rendered rows do not match the prompt model (rendered ${nextRows.length}, expected ${expectedKeys.length})`,
        );
    }
}

/**
 * The inputs of the upstream row template that do not belong to a single prompt.
 *
 * The chat-history warning is the only cross-row input: it appears when the total
 * usage crosses 80% of the context budget, so the *boolean* is what matters, not
 * the usage itself. Putting the raw number here would make every recount look
 * like a change and would throw away the token-only path exactly when it is most
 * useful. The remaining entries change rarely (character, override lists).
 *
 * @param {any} instance
 * @returns {string}
 */
function rowGlobals(instance) {
    const settings = instance?.serviceSettings ?? {};
    const overridable = Array.isArray(instance?.overridablePrompts) ? instance.overridablePrompts.join(',') : '';
    const overridden = Array.isArray(instance?.overriddenPrompts) ? instance.overriddenPrompts.join(',') : '';
    const budget = Number(settings.openai_max_context ?? 0) - Number(settings.openai_max_tokens ?? 0);
    const usage = Number(instance?.tokenUsage ?? 0);
    // The warning markup is the one thing a row can pick up from global state.
    const overBudget = budget > 0 && usage > budget * 0.8;
    return [
        instance?.activeCharacter?.id ?? 'null',
        overBudget ? 'over-budget' : 'under-budget',
        settings.openai_max_context ?? 0,
        settings.openai_max_tokens ?? 0,
        instance?.configuration?.prefix ?? '',
        overridable,
        overridden,
    ].join('\u0001');
}

/**
 * Fingerprint of everything the upstream row template reads for one prompt.
 *
 * `content` is deliberately absent: it never reaches the row markup, it only
 * feeds the token count, which the token stamp already covers. Editing a prompt
 * therefore costs nothing until the numbers come back.
 *
 * A prompt whose set of own keys differs from the one seen at the last full
 * render returns `null`: upstream may have started reading a field this
 * fingerprint does not know about, and only a full rebuild is safe then.
 *
 * @param {any} prompt
 * @param {string} globals Instance-wide fingerprint from `rowGlobals`.
 * @param {any} entry The prompt's order entry, from `createLookups`.
 * @returns {string | null}
 */
function rowSignature(prompt, globals, entry) {
    if (!prompt) {
        return null;
    }
    const position = typeof prompt.injection_position === 'number' ? prompt.injection_position : 0;
    return [
        globals,
        prompt.identifier,
        prompt.name,
        prompt.role,
        prompt.marker === true ? 'm' : '',
        prompt.system_prompt === true ? 's' : '',
        prompt.forbid_overrides === true ? 'f' : '',
        position,
        prompt.injection_depth ?? '',
        prompt.attach_side ?? '',
        prompt.attach_role ?? '',
        prompt.attach_index ?? '',
        entry ? (entry.enabled ? 'on' : 'off') : 'none',
    ].join('\u0002');
}

/**
 * @param {any} prompt
 * @returns {string}
 */
function promptShape(prompt) {
    return prompt && typeof prompt === 'object' ? Object.keys(prompt).sort().join(',') : '';
}

/**
 * Refreshes the per-prompt fingerprints from the model the panel was just synced
 * against. Runs after every sync that rendered rows, so the next sync compares
 * against what is really on screen.
 *
 * A sync that rebuilt only some rows (`onlyKeys`) only has to refresh those:
 * every other row on screen still shows what its stored fingerprint describes,
 * and a sync that got this far already proved the instance-wide fingerprint did
 * not move. Recomputing all of them would be work whose result is thrown away.
 *
 * @param {object} context
 * @param {string[] | null} [onlyKeys]
 */
function captureRowSignatures(context, onlyKeys = null) {
    const { instance, state } = context;
    const globals = rowGlobals(instance);
    if (Array.isArray(onlyKeys)) {
        const targeted = createLookups(instance);
        for (const key of onlyKeys) {
            const prompt = targeted.prompts.get(key) ?? null;
            const signature = rowSignature(prompt, globals, targeted.order.get(key) ?? null);
            state.rowSignatures.set(key, signature === null ? null : `${signature}\u0003${promptShape(prompt)}`);
        }
        return;
    }
    const lookups = createLookups(instance);
    state.rowGlobals = globals;
    state.rowSignatures = new Map();
    let prompts;
    try {
        prompts = instance.getPromptsForCharacter?.(instance.activeCharacter);
    } catch {
        return;
    }
    if (!Array.isArray(prompts)) {
        return;
    }
    for (const prompt of prompts) {
        if (!prompt) {
            continue;
        }
        const key = String(prompt.identifier);
        const signature = rowSignature(prompt, globals, lookups.order.get(key) ?? null);
        state.rowSignatures.set(key, signature === null ? null : `${signature}\u0003${promptShape(prompt)}`);
    }
}

/**
 * Per-sync lookup tables for the two upstream accessors the render path needs.
 *
 * Both are linear searches over the whole list — `PromptManager.getPromptById`
 * is a `find` over `serviceSettings.prompts`, `getPromptOrderEntry` a `find`
 * over the character's order. Asking them once per row makes a sync quadratic:
 * 200 prompts cost about 80k comparisons per pass, and a sync makes two passes.
 * Built once per sync, the same questions become hash lookups.
 *
 * `find` semantics are preserved: the first match wins.
 *
 * @param {any} instance
 * @returns {{ prompts: Map<string, any>, order: Map<string, any> }}
 */
function createLookups(instance) {
    const prompts = new Map();
    const list = instance?.serviceSettings?.prompts;
    if (Array.isArray(list)) {
        for (const prompt of list) {
            if (!prompt || prompt.identifier === undefined || prompt.identifier === null) {
                continue;
            }
            const key = String(prompt.identifier);
            if (!prompts.has(key)) {
                prompts.set(key, prompt);
            }
        }
    }

    const order = new Map();
    let entries = [];
    try {
        entries = instance?.getPromptOrderForCharacter?.(instance.activeCharacter) ?? [];
    } catch {
        entries = [];
    }
    if (Array.isArray(entries)) {
        for (const entry of entries) {
            if (!entry || entry.identifier === undefined || entry.identifier === null) {
                continue;
            }
            const key = String(entry.identifier);
            if (!order.has(key)) {
                order.set(key, entry);
            }
        }
    }

    return { prompts, order };
}

/**
 * Renders rows with the upstream builder into a detached list.
 *
 * @param {object} context
 * @param {string[] | null} onlyKeys When set, the upstream builder is pointed at
 *   these prompts only, so it assembles those rows instead of the whole list.
 * @returns {Promise<{ headNodes: Element[], nextRows: Array<{ key: string, structure: string, tokenValue: string, tokenInner: string, html: string }> }>}
 */
async function buildRows(context, onlyKeys = null) {
    const { instance, originals, state } = context;
    const liveList = state.listElement;
    const scratchList = document.createElement('ul');
    scratchList.className = liveList.className;

    const previousList = instance.listElement;
    const originalSelector = instance.getPromptsForCharacter;
    const scoped = Array.isArray(onlyKeys) && onlyKeys.length > 0;
    const wanted = new Set(onlyKeys ?? []);

    instance.listElement = scratchList;
    if (scoped) {
        // The upstream builder iterates exactly what this returns, so narrowing it
        // is all it takes to assemble a subset. The override is scoped to this one
        // call and removed again in `finally`.
        instance.getPromptsForCharacter = function scopedPrompts(character) {
            const all = originalSelector.call(this, character);
            return Array.isArray(all) ? all.filter(prompt => prompt && wanted.has(String(prompt.identifier))) : all;
        };
    }

    try {
        await originals.renderPromptManagerListItems.call(instance);
    } finally {
        instance.listElement = previousList;
        if (scoped) {
            instance.getPromptsForCharacter = originalSelector;
        }
    }

    const headNodes = [];
    const nextRows = [];
    for (const node of Array.from(scratchList.children)) {
        const key = node.getAttribute('data-pm-identifier');
        if (!key) {
            headNodes.push(node);
            continue;
        }
        const html = node.outerHTML;
        const meta = extractRowMeta(html);
        nextRows.push({ ...meta, html });
    }

    return { headNodes, nextRows };
}

/**
 * Writes the token numbers straight into the rows that are already on screen.
 *
 * This is the cheapest sync there is: the prompt model, the row set and every
 * row's markup are unchanged, so upstream does not have to produce anything.
 * Callers must have verified that much — `syncPanelNow` does.
 *
 * @param {object} context
 * @returns {object} Plan statistics.
 */
function syncTokensOnly(context) {
    const { instance, state } = context;
    if (state.placeholderApplied) {
        // The placeholder owns the cells right now; writing numbers here would
        // undo it until the next presentation pass. `forceTokenKeys` stays armed,
        // so the numbers come back the moment the placeholder is dropped.
        const stats = { created: 0, updated: 0, tokens: 0, removed: 0, moved: 0, rebuilt: 0, replaced: 0 };
        state.lastStats = stats;
        state.lastPath = 'tokens';
        return stats;
    }
    const liveList = state.listElement;
    const counts = instance?.tokenHandler?.getCounts?.() ?? {};
    const values = new Map();

    for (const node of rowNodes(liveList)) {
        const key = node.getAttribute('data-pm-identifier');
        if (!key) {
            continue;
        }
        const count = counts[key];
        const value = count ? String(count) : '-';
        if (state.forceTokenKeys.has(key) || !state.previousByKey.has(key)) {
            values.set(key, { value });
            continue;
        }
        const cell = node.querySelector('.prompt_manager_prompt_tokens');
        if (!cell || cell.getAttribute('data-pm-tokens') !== value) {
            values.set(key, { value });
        }
    }

    const applied = updateTokenNumbers(liveList, values);
    const stats = { created: 0, updated: 0, tokens: applied.tokens, removed: 0, moved: 0, rebuilt: applied.rebuilt, replaced: 0 };

    // A row whose cell could not be patched in place has to be rendered again on
    // the next sync; dropping it from the index is enough to force that.
    if (applied.rebuilt > 0) {
        for (const node of rowNodes(liveList)) {
            if (!node.querySelector('.prompt_manager_prompt_tokens')) {
                const key = node.getAttribute('data-pm-identifier');
                state.nodeByKey.delete(key);
                state.previousByKey.delete(key);
            }
        }
    }

    state.forceTokenKeys = new Set();
    state.lastStats = stats;
    state.lastPath = 'tokens';
    return stats;
}

/**
 * Builds rows with the upstream renderer in a detached list and applies the diff.
 *
 * @param {object} context
 * @param {string[] | null} onlyKeys Narrow the upstream build to these prompts.
 * @returns {Promise<object>} Applied plan statistics.
 */
async function syncRows(context, onlyKeys = null) {
    const { instance, state } = context;
    const liveList = state.listElement;
    const { headNodes, nextRows } = await buildRows(context, onlyKeys);
    const narrowed = Array.isArray(onlyKeys) && onlyKeys.length > 0;

    if (narrowed) {
        // A narrowed build cannot be cross-checked against the whole model; it is
        // verified against the rows it was asked to produce instead.
        const built = nextRows.map(row => row.key);
        const missing = onlyKeys.filter(key => !built.includes(key));
        if (missing.length > 0) {
            throw new RowParseError(`Upstream did not render the requested row(s): ${missing.join(', ')}`);
        }
        syncHeadNodes(liveList, headNodes);

        const stats = applyLocalRows({
            listElement: liveList,
            rows: nextRows,
            nodeByKey: state.nodeByKey,
            previousByKey: state.previousByKey,
        });
        if (stats.missing > 0) {
            // The rows on screen are not the ones this sync assumed; rebuild them
            // instead of leaving a half-applied update behind.
            throw new RowParseError(`${stats.missing} row(s) to re-render were no longer in the list`);
        }
        state.forceTokenKeys = new Set();
        for (const row of nextRows) {
            state.previousByKey.set(row.key, row);
        }
        state.lastStats = {
            created: 0,
            updated: stats.updated,
            tokens: stats.tokens,
            removed: 0,
            moved: 0,
            rebuilt: stats.rebuilt,
            replaced: 0,
        };
        state.lastPath = 'local';
        return state.lastStats;
    }

    assertRowsMatchPromptModel(instance, nextRows);
    syncHeadNodes(liveList, headNodes);

    const plan = planRowOps({
        currentKeys: currentRowKeys(liveList),
        previousByKey: state.previousByKey,
        nextRows,
        forceTokenKeys: state.forceTokenKeys,
    });

    const stats = applyRowPlan({ listElement: liveList, plan, nodeByKey: state.nodeByKey });
    state.forceTokenKeys = new Set();
    state.previousByKey = new Map(nextRows.map(row => [row.key, row]));
    state.lastStats = stats;
    state.lastPath = 'full';
    observeRowMetrics(state, liveList);
    return stats;
}

/**
 * Which prompts can be re-rendered on their own.
 *
 * Upstream decides a row's markup from that prompt's own fields plus the
 * character's order entry, with one exception: the chat-history warning also
 * depends on the total token usage and the configured budget. A row that carries
 * such a warning is therefore never re-rendered alone.
 *
 * @param {object} state
 * @param {string[]} keys
 * @returns {string[]}
 */
function locallyRenderableKeys(state, keys) {
    return keys.filter(key => {
        const previous = state.previousByKey.get(key);
        // The warning cell is the first child of the token cell and carries the
        // warning classes; a row that has one depends on more than itself.
        return Boolean(previous) && !previous.tokenInner.includes('fa-triangle-exclamation');
    });
}

/**
 * @param {object} context
 */
function updateTotal(context) {
    const { instance, state, settings, isPending } = context;
    const total = state.totalTextNode;
    if (!total) {
        return;
    }

    const pending = isPending();
    const value = pending && !settings.get().keepStaleNumbers ? '-' : String(instance.tokenUsage ?? 0);
    if (String(total.nodeValue ?? '').trim() === value) {
        return;
    }
    total.nodeValue = ` ${value} `;
}

/**
 * Applies the stale/placeholder presentation while a recount is pending.
 *
 * @param {object} context
 */
function applyStalePresentation(context) {
    const { state, settings, isPending } = context;
    const list = state.listElement;
    if (!list) {
        return;
    }

    const pending = isPending();
    const placeholder = pending && !settings.get().keepStaleNumbers;

    /** The screen no longer matches the rendered rows; force a full token rewrite. */
    const forceAllTokenCells = () => {
        for (const node of state.previousByKey.keys()) {
            state.forceTokenKeys.add(node);
        }
    };

    if (placeholder) {
        list.classList.remove('tt-to-stale');
        if (!state.placeholderApplied) {
            for (const cell of list.querySelectorAll('.prompt_manager_prompt_tokens')) {
                cell.setAttribute('data-pm-tokens', '-');
                cell.textContent = '-';
            }
            state.placeholderApplied = true;
            forceAllTokenCells();
        }
        return;
    }

    if (state.placeholderApplied) {
        state.placeholderApplied = false;
        forceAllTokenCells();
    }

    const stale = pending && settings.get().keepStaleNumbers;
    list.classList.toggle('tt-to-stale', stale);
    state.headerDiv?.classList.toggle('tt-to-stale', stale);
    const hint = stale ? 'Recalculating token counts…' : '';
    if (state.totalDiv && state.totalDiv.getAttribute('title') !== hint) {
        state.totalDiv.setAttribute('title', hint);
    }
}

/**
 * Decides how much of the panel really has to be rendered.
 *
 * `chrome` refreshes the header/footer only, `local` re-renders the rows whose
 * prompt model entry changed, `full` rebuilds every row. Anything unexpected
 * resolves to `full`: a guard that does not hold must cost time, never
 * correctness.
 *
 * @param {object} context
 * @param {string[]} modelKeys
 * @returns {{ path: 'chrome' | 'local' | 'full', keys: string[] }}
 */
function choosePath(context, modelKeys) {
    const { instance, state } = context;
    const globals = rowGlobals(instance);
    if (globals !== state.rowGlobals) {
        // Token usage, context budget, override lists or the character changed:
        // every row may look different.
        return { path: 'full', keys: modelKeys };
    }

    const lookups = createLookups(instance);
    const changed = modelKeys.filter(key => {
        const prompt = lookups.prompts.get(key) ?? null;
        const signature = rowSignature(prompt, globals, lookups.order.get(key) ?? null);
        const stored = state.rowSignatures.get(key);
        if (signature === null || stored === undefined) {
            return true;
        }
        return stored !== `${signature}\u0003${promptShape(prompt)}`;
    });

    if (changed.length === 0) {
        return { path: 'chrome', keys: [] };
    }
    if (changed.length === modelKeys.length) {
        return { path: 'full', keys: modelKeys };
    }
    return { path: 'local', keys: changed };
}

/**
 * Makes the active render path visible in the console the first time it is used.
 *
 * The extension's whole point is to skip upstream work, and a skipped path is
 * invisible by definition. One line per path, once per session, is enough to tell
 * "the fast path is running" from "everything silently fell back to a full
 * rebuild" in the host's log viewer.
 *
 * @param {object} context
 */
function announcePath(context) {
    const { state, diagnostics } = context;
    const path = state.lastPath;
    if (!path) {
        return;
    }
    const describe = {
        tokens: 'token-only sync (no upstream render)',
        local: 'local row rebuild (only the changed rows were re-rendered)',
        full: 'full row rebuild',
    };
    const label = describe[path];
    if (!label) {
        return;
    }
    diagnostics.announce?.(`path-${path}`, `render path: ${label}`);
}

/**
 * Recognises the one structural change that does not need every row rebuilt:
 * prompts were added and/or removed while every surviving row still carries its
 * old fingerprint.
 *
 * Upstream charges a whole-list row build for an add or a delete. The list only
 * has to gain the new rows (upstream still builds the markup, pointed at just
 * those prompts) and drop the departed ones. Anything this reasoning does not
 * cover — a different fingerprint, a moved budget, an unknown prompt shape —
 * returns null, which sends the sync back to the paths that handle everything.
 *
 * @param {object} context
 * @param {string[]} modelKeys
 * @returns {{ added: string[], removed: string[], reorder: boolean } | null}
 */
function planStructuralDelta(context, modelKeys) {
    const { instance, state } = context;
    const known = state.nodeByKey;
    if (known.size === 0) {
        return null;
    }

    const modelSet = new Set(modelKeys);
    const added = modelKeys.filter(key => !known.has(key));
    /** @type {string[]} */
    const removed = [];
    for (const key of known.keys()) {
        if (!modelSet.has(key)) {
            removed.push(key);
        }
    }
    // A pure reorder is structural too, and it needs no markup at all: the nodes
    // are already on screen, they are just in the old order.
    const survivingModelOrder = modelKeys.filter(key => known.has(key));
    /** @type {string[]} */
    const domOrder = [];
    for (const node of rowNodes(state.listElement)) {
        const key = node.getAttribute('data-pm-identifier');
        if (key !== null && known.has(key) && modelSet.has(key)) {
            domOrder.push(key);
        }
    }
    const reorder = survivingModelOrder.length === domOrder.length
        && survivingModelOrder.some((key, index) => key !== domOrder[index]);

    if (added.length === 0 && removed.length === 0 && !reorder) {
        return null;
    }

    const globals = rowGlobals(instance);
    if (globals !== state.rowGlobals) {
        // Token usage, the budget, the override lists or the character moved:
        // the rows that survived may look different too, so this is not a delta.
        return null;
    }

    const lookups = createLookups(instance);
    for (const key of modelKeys) {
        if (!known.has(key)) {
            continue;
        }
        const prompt = lookups.prompts.get(key) ?? null;
        const signature = rowSignature(prompt, globals, lookups.order.get(key) ?? null);
        const stored = state.rowSignatures.get(key);
        if (signature === null || stored === undefined) {
            return null;
        }
        if (stored !== `${signature}\u0003${promptShape(prompt)}`) {
            return null;
        }
    }

    return { added, removed, reorder };
}

/**
 * Applies a structural delta in place.
 *
 * Removals run first so the insertion point of an added row can be found among
 * the rows that actually survived.
 *
 * @param {object} context
 * @param {{ added: string[], removed: string[], reorder: boolean }} delta
 * @param {string[]} modelKeys
 * @returns {Promise<void>}
 */
async function syncStructuralDelta(context, delta, modelKeys) {
    const { state } = context;
    const list = state.listElement;

    for (const key of delta.removed) {
        const node = state.nodeByKey.get(key);
        node?.remove();
        state.nodeByKey.delete(key);
        state.previousByKey.delete(key);
        state.rowSignatures.delete(key);
    }

    if (delta.added.length > 0) {
        const { headNodes, nextRows } = await buildRows(context, delta.added);
        const built = nextRows.map(row => row.key);
        const missing = delta.added.filter(key => !built.includes(key));
        if (missing.length > 0) {
            throw new RowParseError(`Upstream did not render the requested row(s): ${missing.join(', ')}`);
        }
        syncHeadNodes(list, headNodes);

        for (const row of nextRows) {
            const node = createNodeFromHtml(row.html);
            const following = nextKnownRowNode(state, modelKeys, row.key);
            if (following) {
                following.before(node);
            } else {
                list.append(node);
            }
            state.nodeByKey.set(row.key, node);
            state.previousByKey.set(row.key, row);
        }
    }

    const moved = delta.reorder ? reorderRows(state, modelKeys) : 0;

    state.lastStats = {
        created: delta.added.length,
        updated: 0,
        tokens: 0,
        removed: delta.removed.length,
        moved,
        rebuilt: 0,
        replaced: 0,
    };
    state.lastPath = 'local';
}

/**
 * Puts the existing row nodes into model order, moving only the ones that are
 * out of place. Walks backwards so every node is inserted in front of a
 * reference that is already where it belongs.
 *
 * @param {object} state
 * @param {string[]} modelKeys
 * @returns {number} How many nodes had to be moved.
 */
function reorderRows(state, modelKeys) {
    const list = state.listElement;
    let moves = 0;
    /** @type {Element | null} */
    let following = null;

    for (let index = modelKeys.length - 1; index >= 0; index -= 1) {
        const node = state.nodeByKey.get(modelKeys[index]);
        if (!node) {
            continue;
        }
        if (following !== null && node.nextElementSibling !== following) {
            list.insertBefore(node, following);
            moves += 1;
        }
        following = node;
    }

    return moves;
}

/**
 * @param {object} state
 * @param {string[]} modelKeys
 * @param {string} key The row that was just inserted.
 * @returns {Element | null} The next row that is already on screen, if any.
 */
function nextKnownRowNode(state, modelKeys, key) {
    const position = modelKeys.indexOf(key);
    for (let index = position + 1; index < modelKeys.length; index += 1) {
        const node = state.nodeByKey.get(modelKeys[index]);
        if (node) {
            return node;
        }
    }
    return null;
}

/**
 * @param {object} context
 * @returns {Promise<void>}
 */
async function syncPanelNow(context) {
    const { instance, state } = context;
    const container = instance.containerElement;
    if (!(container instanceof HTMLElement)) {
        return;
    }

    const needsStructure = !state.listElement
        || !container.contains(state.listElement)
        || state.errorSignature !== instance.error
        || state.structureSignature !== structureSignature(instance);

    const scroll = preserveScroll(container);
    // Whether the row set itself moves. Only then can the scroller clamp its
    // offset, and only then is restoring it worth a forced layout.
    let rowsTouched = needsStructure;
    try {
        if (needsStructure) {
            await rebuildStructure(context);
        }

        // Presentation first: it decides whether the cells currently show a
        // placeholder, and the render path has to know that before it writes.
        applyStalePresentation(context);

        const modelKeys = promptModelKeys(instance);
        const live = rowNodes(state.listElement);
        // The list is ours as long as it still holds exactly the nodes this
        // extension put there. Someone else's node means the keyed plan is built
        // on sand and the answer is a full rebuild — but a row set that merely
        // changed in the *model* is not that case: an added or removed prompt is
        // reconciled as a delta below.
        const rowsIntact = live.length === state.nodeByKey.size
            && live.every(node => state.nodeByKey.get(node.getAttribute('data-pm-identifier')) === node);

        /** @type {string[] | null} */
        let renderedKeys = null;
        const delta = rowsIntact ? planStructuralDelta(context, modelKeys) : null;

        const decision = delta
            ? { path: /** @type {'local'} */ ('local'), keys: delta.added }
            : rowsIntact
                ? choosePath(context, modelKeys)
                : { path: /** @type {'full'} */ ('full'), keys: modelKeys };

        if (delta) {
            rowsTouched = true;
            await syncStructuralDelta(context, delta, modelKeys);
            // Only the inserted rows are new; the survivors kept their
            // fingerprints and the departed ones were dropped with their nodes.
            renderedKeys = delta.added;
        } else if (decision.path === 'chrome') {
            // No row can look different, so only the numbers have to be written.
            syncTokensOnly(context);
        } else {
            const keys = decision.path === 'local' ? locallyRenderableKeys(state, decision.keys) : [];
            const narrowed = keys.length > 0 && keys.length < modelKeys.length ? keys : null;
            // 'local' and 'full' both hand rows to the DOM layer.
            rowsTouched = true;
            await syncRows(context, narrowed);
            renderedKeys = narrowed;
        }

        if (state.lastPath !== 'tokens') {
            // Rows were just built from the model, so they show real numbers again;
            // let the presentation decide whether they have to be hidden.
            state.placeholderApplied = false;
            applyStalePresentation(context);
            captureRowSignatures(context, renderedKeys);
        }
        updateTotal(context);
        announcePath(context);
    } finally {
        // The sync may have emptied the list while it built the new markup, which
        // makes the browser clamp the offset to the top. Restore it here instead of
        // letting the panel jump away from the row the user just touched.
        scroll.end(rowsTouched);
    }
}

/**
 * Serializes panel syncs: upstream renderers swap instance fields while running,
 * so two overlapping syncs would corrupt each other.
 *
 * @param {object} context
 * @returns {Promise<void>}
 */
export function syncPanel(context) {
    const { state, diagnostics } = context;
    state.queue = state.queue
        .then(() => {
            state.syncFailures = 0;
            return syncPanelNow(context);
        })
        .catch(error => {
            if (error instanceof RowParseError) {
                state.structureInvalid = true;
                diagnostics.degrade('panel-sync', `upstream markup changed: ${error.message}`);
                return;
            }
            // An unexpected failure must not turn into a silently frozen panel:
            // after a few attempts the extension steps aside for good.
            state.syncFailures = (state.syncFailures ?? 0) + 1;
            diagnostics.error(`Panel sync failed (${state.syncFailures}x):`, error);
            if (state.syncFailures >= MAX_SYNC_FAILURES) {
                state.structureInvalid = true;
                diagnostics.degrade('panel-sync', `renderer failed ${state.syncFailures} times in a row`);
            }
        });
    return state.queue;
}

/**
 * Upstream fallback used when reconciliation is not safe any more.
 *
 * @param {object} context
 * @returns {Promise<void>}
 */
export async function fullRebuild(context) {
    const { instance, originals, state } = context;
    // The stock renderer rebuilds every row, so only the scroll offset is worth
    // carrying across: an emptied list collapses the scroller to its top.
    const scroll = preserveScroll(instance.containerElement);
    stopRowMetrics(state);
    state.listElement = null;
    state.nodeByKey = new Map();
    state.previousByKey = new Map();
    state.structureSignature = null;
    state.errorSignature = undefined;
    state.placeholderApplied = false;
    try {
        await originals.renderPromptManager.call(instance);
        await originals.renderPromptManagerListItems.call(instance);
        instance.makeDraggable();
    } finally {
        scroll.end();
    }
}
