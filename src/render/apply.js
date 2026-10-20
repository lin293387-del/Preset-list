// @ts-check
/**
 * DOM executor for the reconciliation plans produced by `plan.js`.
 *
 * The upstream list is rebuilt through `innerHTML`, which re-parses every row and
 * re-attaches four listeners per row. Here the existing row nodes are reused, the
 * token cells are written in place, and rows are only re-created when their
 * structure really changed.
 */

import { TOKEN_CELL_CLASS, TOKEN_VALUE_ATTRIBUTE } from './plan.js';

/**
 * @param {string} html
 * @returns {Element}
 */
export function createNodeFromHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html).trim();
    const node = template.content.firstElementChild;
    if (!node) {
        throw new Error('[Preset Lite] Row markup produced no element');
    }
    return node;
}

/**
 * @param {Element} node
 * @returns {Element | null}
 */
function findTokenCell(node) {
    return node.querySelector(`.${TOKEN_CELL_CLASS}`);
}

/**
 * Writes the token value and warning markup of a single row.
 *
 * @param {Element} node
 * @param {{ value: string, inner: string }} update
 */
function applyTokenUpdate(node, update) {
    const cell = findTokenCell(node);
    if (!cell) {
        return false;
    }
    if (cell.getAttribute(TOKEN_VALUE_ATTRIBUTE) !== update.value) {
        cell.setAttribute(TOKEN_VALUE_ATTRIBUTE, update.value);
    }
    if (cell.innerHTML !== update.inner) {
        cell.innerHTML = update.inner;
    }
    return true;
}

/**
 * Finds an existing row node by key.
 *
 * The reconciler normally knows every key, but a defensive lookup here means a
 * drifted index can never leave two rows with the same identifier in the list.
 *
 * @param {Element} listElement
 * @param {string} key
 * @returns {Element | null}
 */
function findRowByKey(listElement, key) {
    for (const node of Array.from(listElement.children)) {
        if (node.getAttribute('data-pm-identifier') === key) {
            return node;
        }
    }
    return null;
}

/**
 * Applies a row plan to the live list.
 *
 * @param {object} input
 * @param {Element} input.listElement
 * @param {ReturnType<import('./plan.js').planRowOps>} input.plan
 * @param {Map<string, Element>} input.nodeByKey
 * @returns {{ created: number, updated: number, tokens: number, removed: number, moved: number, rebuilt: number, replaced: number }}
 */
export function applyRowPlan({ listElement, plan, nodeByKey }) {
    const stats = { created: 0, updated: 0, tokens: 0, removed: 0, moved: 0, rebuilt: 0, replaced: 0 };

    for (const key of plan.removed) {
        const node = nodeByKey.get(key);
        if (!node) {
            continue;
        }
        node.remove();
        nodeByKey.delete(key);
        stats.removed += 1;
    }

    for (const item of plan.updated) {
        const node = nodeByKey.get(item.key);
        const replacement = createNodeFromHtml(item.html);
        if (node) {
            node.replaceWith(replacement);
        } else {
            listElement.appendChild(replacement);
            stats.created += 1;
        }
        nodeByKey.set(item.key, replacement);
        stats.updated += 1;
    }

    for (const item of plan.tokens) {
        const node = nodeByKey.get(item.key);
        if (node && applyTokenUpdate(node, item)) {
            stats.tokens += 1;
            continue;
        }
        // A row whose token cell disappeared cannot be patched in place; rebuild it
        // instead of silently rendering a stale number.
        const replacement = createNodeFromHtml(item.html);
        if (node) {
            node.replaceWith(replacement);
        } else {
            listElement.appendChild(replacement);
            stats.created += 1;
        }
        nodeByKey.set(item.key, replacement);
        stats.rebuilt += 1;
    }

    for (const item of plan.created) {
        const node = createNodeFromHtml(item.html);
        const stale = findRowByKey(listElement, item.key);
        if (stale) {
            // The DOM already had this row: replace it rather than adding a twin.
            stale.replaceWith(node);
            stats.replaced += 1;
        } else {
            listElement.appendChild(node);
            stats.created += 1;
        }
        nodeByKey.set(item.key, node);
    }

    // Order pass: walk the target order backwards and only touch nodes whose
    // position is wrong, so an unchanged list performs zero DOM writes.
    let anchor = null;
    for (let index = plan.order.length - 1; index >= 0; index -= 1) {
        const node = nodeByKey.get(plan.order[index]);
        if (!node) {
            continue;
        }
        if (node.nextSibling !== anchor) {
            listElement.insertBefore(node, anchor);
            stats.moved += 1;
        }
        anchor = node;
    }

    return stats;
}

/**
 * Applies rows that were re-rendered on their own.
 *
 * Unlike `applyRowPlan` this never removes or reorders anything: the caller
 * verified that the row set and its order are unchanged and only handed over the
 * rows whose prompt model entry moved. A plan built from a partial row set would
 * look like "every other row was deleted", which is exactly what must not happen.
 *
 * @param {object} input
 * @param {Element} input.listElement
 * @param {Array<{ key: string, structure: string, tokenValue: string, tokenInner: string, html: string }>} input.rows
 * @param {Map<string, Element>} input.nodeByKey
 * @param {Map<string, { structure: string, tokenValue: string, tokenInner: string }>} input.previousByKey
 * @returns {{ updated: number, tokens: number, rebuilt: number, missing: number }}
 */
export function applyLocalRows({ listElement, rows, nodeByKey, previousByKey }) {
    const stats = { updated: 0, tokens: 0, rebuilt: 0, missing: 0 };

    for (const row of rows) {
        const node = nodeByKey.get(row.key);
        if (!node || !listElement.contains(node)) {
            stats.missing += 1;
            continue;
        }

        const previous = previousByKey.get(row.key);
        if (previous && previous.structure === row.structure) {
            // Only the number moved: patch the cell, keep the node.
            if (applyTokenUpdate(node, { value: row.tokenValue, inner: row.tokenInner })) {
                stats.tokens += 1;
            } else {
                const replacement = createNodeFromHtml(row.html);
                node.replaceWith(replacement);
                nodeByKey.set(row.key, replacement);
                stats.rebuilt += 1;
            }
            continue;
        }

        const replacement = createNodeFromHtml(row.html);
        node.replaceWith(replacement);
        nodeByKey.set(row.key, replacement);
        stats.updated += 1;
    }

    return stats;
}

/**
 * Replaces only the token numbers of rows that are already on screen.
 *
 * The upstream token cell is `<span class="..._tokens" data-pm-tokens="N"><span
 * class="warning" title="..."> </span>N</span>`: the warning markup stays
 * untouched and only the trailing text node is rewritten, so this never
 * duplicates the row template.
 *
 * @param {Element} listElement
 * @param {Map<string, { value: string }>} valuesByKey
 * @returns {{ tokens: number, rebuilt: number }}
 */
export function updateTokenNumbers(listElement, valuesByKey) {
    let tokens = 0;
    let rebuilt = 0;

    for (const node of Array.from(listElement.children)) {
        const key = node.getAttribute('data-pm-identifier');
        if (!key) {
            continue;
        }
        const update = valuesByKey.get(key);
        if (!update) {
            continue;
        }
        const cell = findTokenCell(node);
        if (!cell) {
            rebuilt += 1;
            continue;
        }
        if (cell.getAttribute(TOKEN_VALUE_ATTRIBUTE) === update.value
            && String(cell.lastChild?.nodeValue ?? '').trim() === update.value) {
            continue;
        }
        cell.setAttribute(TOKEN_VALUE_ATTRIBUTE, update.value);
        const last = cell.lastChild;
        if (last && last.nodeType === 3) {
            last.nodeValue = update.value;
        } else {
            cell.appendChild(document.createTextNode(update.value));
        }
        tokens += 1;
    }

    return { tokens, rebuilt };
}

/**
 * Replaces the static list header rows (the "Name / Tokens" head and separator)
 * when the freshly built ones differ.
 *
 * @param {Element} listElement
 * @param {Element[]} freshHeadNodes
 * @returns {boolean} True when the head nodes were replaced.
 */
export function syncHeadNodes(listElement, freshHeadNodes) {
    const liveHeadNodes = Array.from(listElement.children).filter(node => !node.getAttribute('data-pm-identifier'));
    const unchanged = freshHeadNodes.length === liveHeadNodes.length
        && freshHeadNodes.every((node, index) => node.outerHTML === liveHeadNodes[index].outerHTML);
    if (unchanged) {
        return false;
    }

    const firstRow = Array.from(listElement.children).find(node => node.getAttribute('data-pm-identifier')) ?? null;
    for (const node of liveHeadNodes) {
        node.remove();
    }

    const fragment = document.createDocumentFragment();
    for (const node of freshHeadNodes) {
        fragment.appendChild(node);
    }
    listElement.insertBefore(fragment, firstRow);
    return true;
}
