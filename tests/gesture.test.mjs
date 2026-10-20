import test from 'node:test';
import assert from 'node:assert/strict';

import { createGestureGate } from '../src/gesture.js';

function harness({ held = false } = {}) {
    const state = { held };
    /** @type {string[]} */
    const runs = [];
    const gate = createGestureGate({ isHeld: () => state.held });
    return {
        state,
        runs,
        gate,
        request(reason = 'test') {
            return gate.run(reason, () => runs.push(reason));
        },
    };
}

test('work runs immediately when no gesture is held', () => {
    const { gate, runs } = harness();
    assert.equal(gate.run('now', () => runs.push('now')), 'ran');
    assert.deepEqual(runs, ['now']);
    assert.equal(gate.isDeferred(), false);
});

test('work is held for the whole gesture and runs once when it ends', () => {
    const { state, gate, runs } = harness({ held: true });

    assert.equal(gate.run('first', () => runs.push('first')), 'deferred');
    assert.equal(gate.run('second', () => runs.push('second')), 'deferred');
    assert.deepEqual(runs, [], 'nothing may run while the gesture lasts');
    assert.equal(gate.deferredReason(), 'second', 'the latest request wins');

    state.held = false;
    assert.equal(gate.flush('scroll-end'), true);
    assert.deepEqual(runs, ['second'], 'many requests collapse into one run');
    assert.equal(gate.isDeferred(), false);
});

test('flushing without pending work does nothing', () => {
    const { gate, runs } = harness();
    assert.equal(gate.flush('scroll-end'), false);
    assert.deepEqual(runs, []);
});

test('clearing drops waiting work without running it', () => {
    const { gate, runs } = harness({ held: true });
    gate.run('stale', () => runs.push('stale'));
    gate.clear();
    assert.equal(gate.isDeferred(), false);
    assert.equal(gate.flush('later'), false);
    assert.deepEqual(runs, [], 'a stopped extension must not render afterwards');
});

test('work requested right after a flush runs immediately', () => {
    const { state, gate, runs } = harness({ held: true });
    gate.run('during', () => runs.push('during'));
    state.held = false;
    gate.flush('scroll-end');
    gate.run('after', () => runs.push('after'));
    assert.deepEqual(runs, ['during', 'after']);
});
