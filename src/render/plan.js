// @ts-check
/**
 * Pure row-reconciliation helpers for the chat-completion prompt list.
 *
 * The upstream list builder rebuilds every row on every interaction
 * (`innerHTML = ''` + fresh listeners). This module converts that markup into a
 * keyed reconciliation plan so the DOM layer can touch only what changed.
 *
 * Everything here is DOM-free on purpose: it is the part that is unit tested.
 */

const TOKEN_CELL_CLASS = 'prompt_manager_prompt_tokens';
const TOKEN_VALUE_ATTRIBUTE = 'data-pm-tokens';
const IDENTIFIER_ATTRIBUTE = 'data-pm-identifier';

/** Raised when upstream row markup is not shaped the way the reconciler needs. */
export class RowParseError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RowParseError';
    }
}

/**
 * @param {string} html
 * @param {number} start Index of a '<' character.
 * @returns {number} Index of the '>' that closes the tag, or -1.
 */
function scanTagEnd(html, start) {
    let quote = '';
    for (let index = start; index < html.length; index += 1) {
        const char = html[index];
        if (quote) {
            if (char === quote) {
                quote = '';
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '>') {
            return index;
        }
    }
    return -1;
}

/**
 * @param {string} html
 * @param {number} index
 * @param {string} tagName
 * @returns {boolean} True when `index` starts a tag named `tagName`.
 */
function isTagStart(html, index, tagName) {
    if (html[index] !== '<') {
        return false;
    }
    const afterNameIndex = index + 1 + tagName.length;
    const afterName = html[afterNameIndex];
    return html.startsWith(tagName, index + 1)
        && (afterName === undefined || afterName === '>' || afterName === '/' || afterName === ' ' || afterName === '\n' || afterName === '\t');
}

/**
 * Finds the element that starts at `start` and returns its extent.
 *
 * @param {string} html
 * @param {number} start Index of the opening '<'.
 * @param {string} tagName Lower-case tag name.
 * @returns {{ tagEnd: number, closeStart: number, end: number } | null}
 */
function findElementExtent(html, start, tagName) {
    const openTagEnd = scanTagEnd(html, start);
    if (openTagEnd < 0) {
        return null;
    }

    let depth = 1;
    let cursor = openTagEnd + 1;

    while (cursor < html.length) {
        const nextOpen = html.indexOf(`<${tagName}`, cursor);
        const nextClose = html.indexOf(`</${tagName}`, cursor);
        if (nextClose < 0) {
            return null;
        }

        if (nextOpen >= 0 && nextOpen < nextClose && isTagStart(html, nextOpen, tagName)) {
            const nestedEnd = scanTagEnd(html, nextOpen);
            if (nestedEnd < 0) {
                return null;
            }
            if (html[nestedEnd - 1] === '/') {
                cursor = nestedEnd + 1;
                continue;
            }
            depth += 1;
            cursor = nestedEnd + 1;
            continue;
        }

        if (!html.startsWith('</', nextClose)) {
            cursor = nextClose + 2;
            continue;
        }
        if (!isTagStart(html, nextClose, `/${tagName}`)) {
            cursor = nextClose + 2;
            continue;
        }

        depth -= 1;
        const closeTagEnd = scanTagEnd(html, nextClose);
        if (closeTagEnd < 0) {
            return null;
        }
        if (depth === 0) {
            return { tagEnd: openTagEnd, closeStart: nextClose, end: closeTagEnd + 1 };
        }
        cursor = closeTagEnd + 1;
    }

    return null;
}

/**
 * @param {string} tagHtml Opening tag markup.
 * @param {string} name Attribute name.
 * @returns {string | null}
 */
function readAttribute(tagHtml, name) {
    const pattern = new RegExp(`\\s${name}="([^"]*)"`);
    const match = pattern.exec(tagHtml);
    return match ? match[1] : null;
}

/**
 * @param {string} html
 * @returns {{ start: number, end: number, tagEnd: number } | null} Extent of the token cell.
 */
function findTokenCell(html) {
    // The token cell is the last element carrying that class, so search backwards:
    // prompt names and data attributes can legally contain similar text.
    const classIndex = html.lastIndexOf(`class="${TOKEN_CELL_CLASS}"`);
    if (classIndex < 0) {
        return null;
    }

    const start = html.lastIndexOf('<span', classIndex);
    if (start < 0) {
        return null;
    }

    const extent = findElementExtent(html, start, 'span');
    if (!extent) {
        return null;
    }

    return { start, end: extent.end, tagEnd: extent.tagEnd };
}

/**
 * Splits one upstream row into a stable key, a structure signature and the token cell.
 *
 * `structure` is the row markup with the whole token cell replaced by a fixed
 * marker, so a row that only changed its token number keeps an identical
 * signature and can be updated in place.
 *
 * @param {string} rowHtml
 * @returns {{ key: string, structure: string, tokenValue: string, tokenInner: string }}
 */
export function extractRowMeta(rowHtml) {
    const html = String(rowHtml ?? '').trim();
    if (!html) {
        throw new RowParseError('Row markup is empty');
    }

    const tagEnd = scanTagEnd(html, 0);
    if (tagEnd < 0) {
        throw new RowParseError('Row markup has no closing tag bracket');
    }

    const openTag = html.slice(0, tagEnd + 1);
    const key = readAttribute(openTag, IDENTIFIER_ATTRIBUTE);
    if (!key) {
        throw new RowParseError(`Row markup has no ${IDENTIFIER_ATTRIBUTE}`);
    }

    const cell = findTokenCell(html);
    if (!cell) {
        throw new RowParseError(`Row "${key}" has no .${TOKEN_CELL_CLASS} element`);
    }

    const cellOpenTag = html.slice(cell.start, cell.tagEnd + 1);
    const tokenValue = readAttribute(cellOpenTag, TOKEN_VALUE_ATTRIBUTE);
    if (tokenValue === null) {
        throw new RowParseError(`Row "${key}" token cell has no ${TOKEN_VALUE_ATTRIBUTE}`);
    }

    const tokenInner = html.slice(cell.tagEnd + 1, cell.end - '</span>'.length);
    const structure = `${html.slice(0, cell.start)}<span class="${TOKEN_CELL_CLASS}" ${TOKEN_VALUE_ATTRIBUTE}="@"></span>${html.slice(cell.end)}`;

    return { key, structure, tokenValue, tokenInner };
}

/**
 * Computes the DOM operations needed to move from the currently rendered rows to
 * the freshly built ones.
 *
 * @param {object} input
 * @param {string[]} input.currentKeys Keys currently present in the list, in DOM order.
 * @param {Map<string, { structure: string, tokenValue: string, tokenInner: string }>} input.previousByKey Rows rendered by the previous sync. Also the DOM index: a key that is absent here is treated as a new row.
 * @param {Array<{ key: string, structure: string, tokenValue: string, tokenInner: string, html: string }>} input.nextRows Rows built from upstream markup, in target order.
 * @param {Set<string> | string[] | null} [input.forceTokenKeys] Keys whose token cell must be written even when it looks unchanged.
 * @returns {{
 *   created: Array<{ key: string, html: string }>,
 *   updated: Array<{ key: string, html: string }>,
 *   tokens: Array<{ key: string, value: string, inner: string, html: string }>,
 *   removed: string[],
 *   order: string[],
 *   unchanged: number,
 * }}
 */
export function planRowOps({ currentKeys = [], previousByKey, nextRows, forceTokenKeys = null }) {
    if (!(previousByKey instanceof Map)) {
        throw new TypeError('planRowOps requires previousByKey to be a Map');
    }
    if (!Array.isArray(nextRows)) {
        throw new TypeError('planRowOps requires nextRows to be an array');
    }

    const order = [];
    const seen = new Set();
    for (const row of nextRows) {
        if (seen.has(row.key)) {
            throw new RowParseError(`Duplicate prompt row key: ${row.key}`);
        }
        seen.add(row.key);
        order.push(row.key);
    }

    const forced = forceTokenKeys instanceof Set
        ? forceTokenKeys
        : new Set(Array.isArray(forceTokenKeys) ? forceTokenKeys : []);

    const removed = currentKeys.filter(key => !seen.has(key));
    const created = [];
    const updated = [];
    const tokens = [];
    let unchanged = 0;

    for (const row of nextRows) {
        const previous = previousByKey.get(row.key);
        if (!previous) {
            created.push({ key: row.key, html: row.html });
            continue;
        }
        if (previous.structure !== row.structure) {
            updated.push({ key: row.key, html: row.html });
            continue;
        }
        if (forced.has(row.key) || previous.tokenValue !== row.tokenValue || previous.tokenInner !== row.tokenInner) {
            tokens.push({ key: row.key, value: row.tokenValue, inner: row.tokenInner, html: row.html });
            continue;
        }
        unchanged += 1;
    }

    return { created, updated, tokens, removed, order, unchanged };
}

/**
 * @param {string} value
 * @returns {string} The token text upstream would render for a count.
 */
export function formatTokenText(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric !== 0 ? String(numeric) : '-';
}

export { TOKEN_CELL_CLASS, TOKEN_VALUE_ATTRIBUTE };
