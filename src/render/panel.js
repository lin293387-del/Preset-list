// @ts-check
/**
 * Incremental rendering for the chat-completion prompt panel.
 *
 * Upstream renders the panel by clearing `#completion_prompt_manager` and
 * rebuilding header, footer and every row. That work is repeated for every
 * interaction and is what makes the panel feel heavy.
 *
 * This module keeps the upstream markup as the single source of truth (rows and
 * structure are built by the *original* upstream methods into a detached
 * container) and only adopts what changed:
 *
 * - the container/header/footer are built once and reused,
 * - rows are reconciled by `data-pm-identifier`,
 * - token numbers are written in place instead of rebuilding the list.
 */

import { RowParseError, extractRowMeta, planRowOps } from './plan.js';
import { applyRowPlan, syncHeadNodes } from './apply.js';

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
    };
}

/**
 * @param {HTMLElement} element
 * @returns {number | null}
 */
function getScrollTop(element) {
    const scroller = element.closest('.scrollableInner') ?? element.parentElement?.closest?.('.scrollableInner') ?? null;
    return scroller ? scroller.scrollTop : null;
}

/**
 * @param {HTMLElement} element
 * @param {number} value
 */
function setScrollTop(element, value) {
    const scroller = element.closest('.scrollableInner') ?? null;
    if (scroller) {
        scroller.scrollTop = value;
    }
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
 * Rebuilds container/header/footer from upstream markup and adopts it.
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

    const scrollTop = getScrollTop(container);
    container.replaceChildren(...Array.from(scratch.childNodes));

    state.nodeByKey = new Map();
    state.previousByKey = new Map();
    state.placeholderApplied = false;

    captureStructureRefs(instance, state, diagnostics);

    instance.listElement = state.listElement;
    try {
        instance.makeDraggable();
    } catch (error) {
        diagnostics.warn('Prompt reorder could not be initialized by the plugin:', error);
    }
    installRowDelegation(instance, state);

    if (scrollTop !== null) {
        setScrollTop(container, scrollTop);
    }

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
 * Cross-checks the freshly built rows against the prompt model upstream renders
 * from. A mismatch means the upstream list markup changed shape (or another
 * extension rewrote it), and reconciling would silently drop rows, so callers
 * must fall back to the upstream renderer instead.
 *
 * @param {any} instance
 * @param {Array<{ key: string }>} nextRows
 */
function assertRowsMatchPromptModel(instance, nextRows) {
    let expectedKeys;
    try {
        expectedKeys = instance.getPromptsForCharacter?.(instance.activeCharacter)
            ?.filter(Boolean)
            ?.map(prompt => String(prompt.identifier));
    } catch (error) {
        throw new RowParseError(`Prompt model lookup failed: ${error instanceof Error ? error.message : error}`);
    }
    if (!Array.isArray(expectedKeys)) {
        throw new RowParseError('Prompt model lookup is unavailable; cannot verify rendered rows');
    }
    if (nextRows.length !== expectedKeys.length || nextRows.some((row, index) => row.key !== expectedKeys[index])) {
        throw new RowParseError(
            `Rendered rows do not match the prompt model (rendered ${nextRows.length}, expected ${expectedKeys.length})`,
        );
    }
}

/**
 * Builds rows with the upstream renderer in a detached list and applies the diff.
 *
 * @param {object} context
 * @returns {Promise<object>} Applied plan statistics.
 */
async function syncRows(context) {
    const { instance, originals, state } = context;
    const liveList = state.listElement;
    const scratchList = document.createElement('ul');
    scratchList.className = liveList.className;

    const previousList = instance.listElement;
    instance.listElement = scratchList;
    try {
        await originals.renderPromptManagerListItems.call(instance);
    } finally {
        instance.listElement = previousList;
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
    return stats;
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
        list.classList.remove('tt-pl-stale');
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
    list.classList.toggle('tt-pl-stale', stale);
    state.headerDiv?.classList.toggle('tt-pl-stale', stale);
    const hint = stale ? 'Recalculating token counts…' : '';
    if (state.totalDiv && state.totalDiv.getAttribute('title') !== hint) {
        state.totalDiv.setAttribute('title', hint);
    }
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

    if (needsStructure) {
        await rebuildStructure(context);
    }

    await syncRows(context);
    updateTotal(context);
    applyStalePresentation(context);
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
    state.listElement = null;
    state.nodeByKey = new Map();
    state.previousByKey = new Map();
    state.structureSignature = null;
    state.errorSignature = undefined;
    state.placeholderApplied = false;
    await originals.renderPromptManager.call(instance);
    await originals.renderPromptManagerListItems.call(instance);
    instance.makeDraggable();
}
