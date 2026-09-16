import test from 'node:test';
import assert from 'node:assert/strict';

import { createPresetWindowCoalescer } from '../src/patches/preset-window.js';

/**
 * Minimal jQuery stand-in: only `fn.trigger` and collection iteration are used.
 */
function createFakeJQuery(onDispatch) {
    function $(value) {
        const elements = Array.isArray(value) ? value : [value];
        const collection = Object.create($.fn);
        collection.length = elements.length;
        collection[Symbol.iterator] = () => elements[Symbol.iterator]();
        elements.forEach((element, index) => {
            collection[index] = element;
        });
        return collection;
    }

    $.fn = {
        trigger(type, data) {
            onDispatch?.([...this], type, data);
            return this;
        },
    };

    return $;
}

function createElement({ id = 'field', inLeftNav = true, value = 'v', type = 'text', tagName = 'INPUT' } = {}) {
    return {
        nodeType: 1,
        id,
        type,
        value,
        checked: false,
        className: '',
        tagName,
        getAttribute: () => null,
        closest: selector => (selector === '#left-nav-panel' && inLeftNav ? { nodeType: 1 } : null),
    };
}

function createHarness({
    captureBaseline,
    coalescePresetEvents = true,
    onDispatch,
    onWindowEnd,
    reportPresetConflicts = true,
} = {}) {
    const dispatched = [];
    const conflicts = [];
    const $ = createFakeJQuery((elements, type, data) => {
        dispatched.push({ elements, type, data });
        onDispatch?.(elements, type, data);
    });

    const coalescer = createPresetWindowCoalescer({
        settings: {
            get: () => ({
                coalescePresetEvents,
                reportPresetConflicts,
            }),
        },
        diagnostics: {
            info() {},
            warn() {},
            noteOnce() {},
            recordConflict: conflict => conflicts.push(conflict),
        },
        captureBaseline,
        onWindowEnd,
    });

    coalescer.install($);

    return { $, dispatched, conflicts, coalescer };
}

const flushMacrotask = () => new Promise(resolve => setTimeout(resolve, 0));

test('preset input events are coalesced inside the window and replayed once per field', async () => {
    const { $, dispatched, coalescer } = createHarness();
    const field = createElement({ id: 'temp_openai', value: '1' });

    coalescer.open();
    $(field).trigger('input', { source: 'preset' });
    $(field).trigger('input', { source: 'preset' });
    field.value = '2';
    $(field).trigger('input', { source: 'preset' });

    assert.equal(dispatched.length, 0, 'nothing is dispatched while the window is open');
    assert.equal(coalescer.pendingCount(), 1);

    coalescer.close('after');
    await flushMacrotask();

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, 'input');
    assert.deepEqual(dispatched[0].data, { source: 'preset' });
    assert.equal(coalescer.pendingCount(), 0);
});

test('the window summary reports how long the apply loop and the replay took', async () => {
    /** @type {any[]} */
    const summaries = [];
    const { $, coalescer } = createHarness({ onWindowEnd: summary => summaries.push(summary) });
    const field = createElement({ id: 'temp_openai' });

    coalescer.open();
    $(field).trigger('input', { source: 'preset' });
    coalescer.close('preset-changed-after');
    await flushMacrotask();

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].reason, 'preset-changed-after');
    assert.equal(summaries[0].replayed, 1);
    assert.equal(Number.isFinite(summaries[0].durationMs), true, 'the apply loop is timed');
    assert.equal(Number.isFinite(summaries[0].fieldLoopMs), true, 'the field loop is timed separately');
    assert.equal(Number.isFinite(summaries[0].chainMs), true, 'the chain after the loop is timed separately');
    assert.equal(Number.isFinite(summaries[0].replayMs), true, 'the replay is timed');
    assert.equal(Number.isFinite(summaries[0].closedAt), true, 'the close timestamp is reported');
});

test('fields the preset did not move are not replayed', async () => {
    const untouched = createElement({ id: 'temp_openai', value: '1' });
    const moved = createElement({ id: 'top_p_openai', value: '1' });
    const { $, dispatched, coalescer } = createHarness({
        captureBaseline: () => new Map([[untouched, '1'], [moved, '1']]),
    });

    coalescer.open();
    $(untouched).trigger('input', { source: 'preset' });
    moved.value = '2';
    $(moved).trigger('input', { source: 'preset' });

    coalescer.close('preset-changed-after');
    await flushMacrotask();

    assert.deepEqual(dispatched.map(call => call.elements[0].id), ['top_p_openai']);
    assert.equal(coalescer.stats().lastUnchanged, 1, 'the skipped field is reported');
    assert.equal(coalescer.stats().replayed, 1);
});

test('a change trigger on a select the preset did not move is dropped', () => {
    const source = createElement({ id: 'chat_completion_source', value: 'openai', tagName: 'SELECT' });
    const { $, dispatched, coalescer } = createHarness({
        captureBaseline: () => new Map([[source, 'openai']]),
    });

    coalescer.open();
    $(source).trigger('change');

    assert.equal(dispatched.length, 0, 'an unchanged select does not re-run its handler');
    assert.equal(coalescer.stats().redundantChanges, 1);
});

test('a change trigger whose select moved is still dispatched', () => {
    const source = createElement({ id: 'chat_completion_source', value: 'openai', tagName: 'SELECT' });
    const { $, dispatched, coalescer } = createHarness({
        captureBaseline: () => new Map([[source, 'openai']]),
    });

    coalescer.open();
    source.value = 'custom';
    $(source).trigger('change');

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, 'change');
    assert.equal(coalescer.stats().redundantChanges, 0);
});

test('a change trigger on another element type is never dropped', () => {
    const toggle = createElement({ id: 'stream_toggle', type: 'checkbox', value: 'on' });
    const { $, dispatched, coalescer } = createHarness({
        captureBaseline: () => new Map([[toggle, 'on']]),
    });

    coalescer.open();
    $(toggle).trigger('change');

    assert.equal(dispatched.length, 1, 'only the selects upstream re-fires may be skipped');
    assert.equal(coalescer.stats().redundantChanges, 0);
});

test('without a baseline every deferred event is replayed', async () => {
    const field = createElement({ id: 'temp_openai', value: '1' });
    const { $, dispatched, coalescer } = createHarness({ captureBaseline: () => null });

    coalescer.open();
    $(field).trigger('input', { source: 'preset' });
    coalescer.close('preset-changed-after');
    await flushMacrotask();

    assert.equal(dispatched.length, 1, 'an unknown previous value must keep the handler');
    assert.equal(coalescer.stats().lastUnchanged, 0);
});

test('non preset events keep their original timing', async () => {
    const { $, dispatched, coalescer } = createHarness();
    const field = createElement({ id: 'temp_openai' });

    coalescer.open();
    $(field).trigger('input');
    $(field).trigger('change', { source: 'preset' });
    $(field).trigger('input', { source: 'user' });

    assert.equal(dispatched.length, 3);
    assert.equal(coalescer.pendingCount(), 0);
});

test('fields outside the left navigation panel are never deferred', async () => {
    const { $, dispatched, coalescer } = createHarness();
    const outside = createElement({ id: 'elsewhere', inLeftNav: false });

    coalescer.open();
    $(outside).trigger('input', { source: 'preset' });

    assert.equal(dispatched.length, 1);
    assert.equal(coalescer.pendingCount(), 0);
});

test('events outside the window are dispatched immediately', async () => {
    const { $, dispatched } = createHarness();
    const field = createElement({ id: 'temp_openai' });

    $(field).trigger('input', { source: 'preset' });

    assert.equal(dispatched.length, 1);
});

test('coalescing can be switched off without uninstalling', async () => {
    const { $, dispatched, coalescer } = createHarness({ coalescePresetEvents: false });
    const field = createElement({ id: 'temp_openai' });

    coalescer.open();
    $(field).trigger('input', { source: 'preset' });

    assert.equal(dispatched.length, 1);
    assert.equal(coalescer.pendingCount(), 0);
});

test('handlers that contradict the preset are reported', async () => {
    const field = createElement({ id: 'openai_max_tokens', value: '300' });
    const { $, conflicts, coalescer } = createHarness({
        onDispatch: ([element]) => {
            element.value = '999';
        },
    });

    coalescer.open();
    $(field).trigger('input', { source: 'preset' });
    coalescer.close('after');
    await flushMacrotask();

    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].selector, 'input#openai_max_tokens');
    assert.equal(conflicts[0].before, '300');
    assert.equal(conflicts[0].after, '999');
});

test('checkbox fields are compared through their checked state', async () => {
    const checkbox = createElement({ id: 'stream_toggle', type: 'checkbox' });
    const toggleHarness = createHarness({
        onDispatch: ([element]) => {
            element.checked = true;
        },
    });

    toggleHarness.coalescer.open();
    toggleHarness.$(checkbox).trigger('input', { source: 'preset' });
    toggleHarness.coalescer.close('after');
    await flushMacrotask();

    assert.equal(toggleHarness.conflicts.length, 1, 'a checkbox handler that flips checked is a conflict');
    assert.deepEqual(
        { before: toggleHarness.conflicts[0].before, after: toggleHarness.conflicts[0].after },
        { before: 'false', after: 'true' },
    );

    const valueOnly = createElement({ id: 'stream_toggle', type: 'checkbox' });
    const valueHarness = createHarness({
        onDispatch: ([element]) => {
            element.value = 'ignored';
        },
    });

    valueHarness.coalescer.open();
    valueHarness.$(valueOnly).trigger('input', { source: 'preset' });
    valueHarness.coalescer.close('after');
    await flushMacrotask();

    assert.equal(valueHarness.conflicts.length, 0, 'the value property of a checkbox is irrelevant');
});

test('a window that never closes still replays through the safety timer', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const { $, dispatched, coalescer } = createHarness();
    const field = createElement({ id: 'temp_openai' });

    coalescer.open();
    $(field).trigger('input', { source: 'preset' });
    assert.equal(dispatched.length, 0);

    t.mock.timers.tick(1600);
    t.mock.timers.tick(0);

    assert.equal(coalescer.isActive(), false);
    assert.equal(dispatched.length, 1);
});

test('opening twice keeps a single window', async () => {
    const { $, coalescer, dispatched } = createHarness();
    const field = createElement({ id: 'temp_openai' });

    coalescer.open();
    coalescer.open();
    $(field).trigger('input', { source: 'preset' });
    coalescer.close('after');
    await flushMacrotask();

    assert.equal(coalescer.stats().windows, 1);
    assert.equal(dispatched.length, 1);
});

test('uninstall restores the original trigger', async () => {
    const { $, dispatched, coalescer } = createHarness();
    const field = createElement({ id: 'temp_openai' });

    coalescer.uninstall();
    coalescer.open();
    $(field).trigger('input', { source: 'preset' });

    assert.equal(dispatched.length, 1);
});
