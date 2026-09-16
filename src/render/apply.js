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
