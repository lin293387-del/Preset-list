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

function createElement({ id = 'field', inLeftNav = true, value = 'v', type = 'text' } = {}) {
    return {
        nodeType: 1,
        id,
        type,
        value,
        checked: false,
        className: '',
        tagName: 'INPUT',
        getAttribute: () => null,
        closest: selector => (selector === '#left-nav-panel' && inLeftNav ? { nodeType: 1 } : null),
    };
}

function createHarness({ coalescePresetEvents = true, onDispatch, reportPresetConflicts = true } = {}) {
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
