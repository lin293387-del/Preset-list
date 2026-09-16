import test from 'node:test';
import assert from 'node:assert/strict';

import { RowParseError, extractRowMeta, formatTokenText, planRowOps } from '../src/render/plan.js';

/**
 * Row markup mirroring the upstream `renderPromptManagerListItems` template.
 *
 * @param {object} options
 * @returns {string}
 */
function buildRow({
    identifier = 'mainPrompt',
    name = 'Main Prompt',
    enabled = true,
    tokens = '42',
    warningClass = '',
    warningTitle = '',
    roleIcon = '',
    injectionDepth = null,
} = {}) {
    const disabledClass = enabled ? '' : 'completion_prompt_manager_prompt_disabled';
    return `
                <li class="completion_prompt_manager_prompt completion_prompt_manager_prompt_draggable ${disabledClass}  " data-pm-identifier="${identifier}">
                    <span class="drag-handle">☰</span>
                    <span class="completion_prompt_manager_prompt_name" data-pm-name="${name}">
                        <a title="${name}" class="prompt-manager-inspect-action">${name}</a>
                        ${roleIcon}
                        ${injectionDepth === null ? '' : `<small class="prompt-manager-injection-depth">@ ${injectionDepth}</small>`}
                    </span>
                    <span>
                            <span class="prompt_manager_prompt_controls">
                                <span class="fa-solid"></span>
                                <span class="prompt-manager-edit-action fa-solid fa-pencil fa-xs"></span>
                                <span class="prompt-manager-toggle-action ${enabled ? 'fa-solid fa-toggle-on' : 'fa-solid fa-toggle-off'}"></span>
                            </span>
                    </span>

                    <span class="prompt_manager_prompt_tokens" data-pm-tokens="${tokens}"><span class="${warningClass}" title="${warningTitle}"> </span>${tokens}</span>
                </li>
            `;
}

test('extractRowMeta keeps the structure stable across token-only changes', () => {
    const before = extractRowMeta(buildRow({ tokens: '42' }));
    const after = extractRowMeta(buildRow({ tokens: '43' }));

    assert.equal(before.key, 'mainPrompt');
    assert.equal(before.tokenValue, '42');
    assert.equal(before.tokenInner, '<span class="" title=""> </span>42');
    assert.equal(before.structure, after.structure);
    assert.notEqual(before.tokenValue, after.tokenValue);
});

test('extractRowMeta reflects real row changes in the structure', () => {
    const base = extractRowMeta(buildRow());
    assert.notEqual(base.structure, extractRowMeta(buildRow({ enabled: false })).structure);
    assert.notEqual(base.structure, extractRowMeta(buildRow({ name: 'Renamed' })).structure);
    assert.notEqual(base.structure, extractRowMeta(buildRow({ roleIcon: '<span data-role="user" class="fa-xs fa-solid fa-user" title="t"></span>' })).structure);
    assert.notEqual(base.structure, extractRowMeta(buildRow({ injectionDepth: 4 })).structure);
    assert.equal(base.structure, extractRowMeta(buildRow()).structure);
});

test('extractRowMeta captures warning markup inside the token cell', () => {
    const meta = extractRowMeta(buildRow({
        identifier: 'chatHistory',
        tokens: '12',
        warningClass: 'fa-solid tooltip fa-triangle-exclamation text_warning',
        warningTitle: 'Only a few messages worth chat history are being sent.',
    }));

    assert.equal(meta.tokenValue, '12');
    assert.match(meta.tokenInner, /text_warning/);
    assert.match(meta.tokenInner, /Only a few messages/);
    assert.match(meta.tokenInner, /12$/);
});

test('extractRowMeta survives angle brackets and quotes inside names', () => {
    const meta = extractRowMeta(buildRow({
        identifier: 'nested',
        name: 'Weird &quot;name&quot; &gt; tail &lt;head&gt;',
    }));

    assert.equal(meta.key, 'nested');
    assert.equal(meta.tokenValue, '42');
    assert.match(meta.structure, /Weird/);
});

test('extractRowMeta fails loudly on unexpected markup', () => {
    assert.throws(() => extractRowMeta('<li class="x">no identifier</li>'), RowParseError);
    assert.throws(() => extractRowMeta('<li data-pm-identifier="a"></li>'), RowParseError);
    assert.throws(
        () => extractRowMeta('<li data-pm-identifier="a"><span class="prompt_manager_prompt_tokens">1</span></li>'),
        RowParseError,
    );
});

test('planRowOps reports no work when nothing changed', () => {
    const first = extractRowMeta(buildRow({ identifier: 'a' }));
    const second = extractRowMeta(buildRow({ identifier: 'b' }));

    const plan = planRowOps({
        currentKeys: ['a', 'b'],
        previousByKey: new Map([[first.key, first], [second.key, second]]),
        nextRows: [first, second].map(row => ({ ...row, html: 'html' })),
    });

    assert.deepEqual(plan.created, []);
    assert.deepEqual(plan.updated, []);
    assert.deepEqual(plan.tokens, []);
    assert.deepEqual(plan.removed, []);
    assert.deepEqual(plan.order, ['a', 'b']);
    assert.equal(plan.unchanged, 2);
});

test('planRowOps isolates token-only updates', () => {
    const previous = extractRowMeta(buildRow({ identifier: 'a', tokens: '10' }));
    const next = extractRowMeta(buildRow({ identifier: 'a', tokens: '11' }));

    const plan = planRowOps({
        currentKeys: ['a'],
        previousByKey: new Map([[previous.key, previous]]),
        nextRows: [{ ...next, html: 'next-html' }],
    });

    assert.equal(plan.tokens.length, 1);
    assert.deepEqual(plan.tokens[0], { key: 'a', value: '11', inner: next.tokenInner, html: 'next-html' });
    assert.deepEqual(plan.updated, []);
    assert.equal(plan.unchanged, 0);
});

test('planRowOps reports structural updates, insertions and removals', () => {
    const kept = extractRowMeta(buildRow({ identifier: 'kept' }));
    const changedBefore = extractRowMeta(buildRow({ identifier: 'changed', tokens: '5' }));
    const changedAfter = extractRowMeta(buildRow({ identifier: 'changed', tokens: '6', enabled: false }));
    const added = extractRowMeta(buildRow({ identifier: 'added' }));

    const plan = planRowOps({
        currentKeys: ['kept', 'changed', 'gone'],
        previousByKey: new Map([
            ['kept', kept],
            ['changed', changedBefore],
        ]),
        nextRows: [
            { ...added, html: 'added-html' },
            { ...kept, html: 'kept-html' },
            { ...changedAfter, html: 'changed-html' },
        ],
    });

    assert.deepEqual(plan.created, [{ key: 'added', html: 'added-html' }]);
    assert.deepEqual(plan.updated, [{ key: 'changed', html: 'changed-html' }]);
    assert.deepEqual(plan.removed, ['gone']);
    assert.deepEqual(plan.order, ['added', 'kept', 'changed']);
    assert.deepEqual(plan.tokens, []);
    assert.equal(plan.unchanged, 1);
});

test('planRowOps refuses duplicate keys', () => {
    const row = extractRowMeta(buildRow({ identifier: 'a' }));

    assert.throws(
        () => planRowOps({ currentKeys: [], previousByKey: new Map(), nextRows: [row, row] }),
        RowParseError,
    );
});

test('formatTokenText mirrors upstream placeholder rules', () => {
    assert.equal(formatTokenText(0), '-');
    assert.equal(formatTokenText(''), '-');
    assert.equal(formatTokenText('12'), '12');
    assert.equal(formatTokenText('-'), '-');
});
