// @ts-check
/**
 * The slicer decides when a loop is long enough to be worth interrupting, so the
 * two things worth proving are the boundaries: a loop that fits the budget must
 * not yield at all, and a loop that does not must hand control back rather than
 * keep the task alive. Both are checked with an injected clock, because a test
 * that waits for real 8 ms slices is a test that measures the machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SLICE_BUDGET_MS, runSliced, yieldToMain } from '../src/perf/slicer.js';

/** @param {number[]} timestamps */
function clockOf(timestamps) {
    let index = 0;
    return () => {
        const value = timestamps[Math.min(index, timestamps.length - 1)];
        index += 1;
        return value;
    };
}

const instantYield = async () => {};

test('a loop that fits the budget never yields', async () => {
    /** @type {number[]} */
    const seen = [];
    let yields = 0;
    const slices = await runSliced([1, 2, 3], value => seen.push(value), {
        now: clockOf([0, 1, 2, 3, 4]),
        yieldFn: async () => { yields += 1; },
    });

    assert.equal(slices, 0);
    assert.equal(yields, 0);
    assert.deepEqual(seen, [1, 2, 3]);
});

test('a loop that passes the budget hands control back', async () => {
    /** @type {number[]} */
    const seen = [];
    const slices = await runSliced([1, 2, 3, 4], value => seen.push(value), {
        now: clockOf([0, 9, 10, 21, 22]),
        yieldFn: instantYield,
    });

    // 9 - 0 >= 8 after the first item, 21 - 9 >= 8 after the third.
    assert.equal(slices, 2);
    assert.deepEqual(seen, [1, 2, 3, 4]);
});

test('the budget is measured from the last yield, not from the start', async () => {
    let yields = 0;
    const slices = await runSliced([1, 2, 3, 4, 5, 6], () => {}, {
        // 6 ms per item: three items per slice, never four.
        now: clockOf([0, 6, 12, 18, 24, 30, 36, 42]),
        yieldFn: async () => { yields += 1; },
    });

    assert.equal(yields, slices);
    assert.equal(slices, 2);
});

test('the budget is configurable', async () => {
    const slices = await runSliced([1, 2, 3], () => {}, {
        budgetMs: 100,
        now: clockOf([0, 50, 100, 150]),
        yieldFn: instantYield,
    });

    assert.equal(slices, 1);
    assert.equal(SLICE_BUDGET_MS, 8);
});

test('yieldToMain resolves on every host', async () => {
    await assert.doesNotReject(() => yieldToMain());
});

test('yieldToMain prefers the scheduler api when the host has one', async () => {
    const calls = [];
    const host = /** @type {any} */ (globalThis);
    const previous = host.scheduler;
    host.scheduler = {
        yield: () => {
            calls.push('yield');
            return Promise.resolve();
        },
        postTask: () => {
            calls.push('postTask');
            return Promise.resolve();
        },
    };
    try {
        await yieldToMain();
        assert.deepEqual(calls, ['yield']);
    } finally {
        host.scheduler = previous;
    }
});

test('yieldToMain falls back to postTask, then to a timer', async () => {
    const calls = [];
    const host = /** @type {any} */ (globalThis);
    const previous = host.scheduler;

    host.scheduler = {
        postTask: () => {
            calls.push('postTask');
            return Promise.resolve();
        },
    };
    try {
        await yieldToMain();
        assert.deepEqual(calls, ['postTask']);
    } finally {
        host.scheduler = previous;
    }

    // The timer path is the one every host has: prove it still hands control back.
    await new Promise(resolve => setTimeout(resolve, 0));
    await assert.doesNotReject(() => yieldToMain());
});
