import test from 'node:test';
import assert from 'node:assert/strict';

import { createRecountScheduler } from '../src/tokens/scheduler.js';

/** Virtual clock + timer heap so scheduling behaviour is deterministic. */
function createFakeScheduler() {
    let currentTime = 0;
    let nextHandle = 1;
    const timers = new Map();

    async function flush() {
        for (let index = 0; index < 25; index += 1) {
            await Promise.resolve();
        }
    }

    return {
        now: () => currentTime,
        setTimer(fn, ms) {
            const handle = nextHandle++;
            timers.set(handle, { at: currentTime + Math.max(0, ms), fn });
            return handle;
        },
        clearTimer(handle) {
            timers.delete(handle);
        },
        requestIdle(fn) {
            const handle = nextHandle++;
            timers.set(handle, { at: currentTime + 1, fn });
            return handle;
        },
        cancelIdle(handle) {
            timers.delete(handle);
        },
        async advance(ms) {
            const target = currentTime + ms;
            for (let pass = 0; pass < 200; pass += 1) {
                // Promise continuations may schedule new timers; drain them first.
                await flush();

                let selected = null;
                for (const [handle, timer] of timers) {
                    if (timer.at <= target && (selected === null || timer.at < selected.timer.at)) {
                        selected = { handle, timer };
                    }
                }
                if (!selected) {
                    break;
                }
                currentTime = selected.timer.at;
                timers.delete(selected.handle);
                selected.timer.fn();
            }
            currentTime = target;
            await flush();
        },
    };
}

function createHarness(overrides = {}) {
    const config = {
        enabled: true,
        idleDelayMs: 250,
        idleTimeoutMs: 3000,
        deferDuringScroll: true,
        ...overrides.settings,
    };
    const scheduler = createFakeScheduler();
    const calls = { runs: 0, fresh: 0, errors: 0, visible: true, busy: false, held: false, pendingWhenFresh: [] };

    /** Optional gate so a test can decide when a dry run finishes. */
    let releaseRun = null;
    let runGate = overrides.gated ? new Promise(resolve => { releaseRun = resolve; }) : null;

    const instance = {
        async tryGenerate() {
            calls.runs += 1;
            if (overrides.failGeneration) {
                throw new Error('dry run failed');
            }
            if (runGate) {
                await runGate;
            }
        },
    };

    /** @type {any} */
    let apiRef = null;

    const schedulerApi = createRecountScheduler({
        settings: { get: () => config },
        diagnostics: { info() {}, warn() {}, noteOnce() {} },
        getInstance: () => (overrides.noInstance ? null : instance),
        isVisible: () => calls.visible,
        isBusy: () => calls.busy,
        isInteractionHeld: () => calls.held,
        onNumbersFresh: () => {
            calls.fresh += 1;
            calls.pendingWhenFresh.push(apiRef?.isPending() ?? null);
        },
        onRecountError: () => { calls.errors += 1; },
        scheduler,
    });
    apiRef = schedulerApi;

    return {
        scheduler,
        api: schedulerApi,
        calls,
        config,
        finishRun() {
            releaseRun?.();
            releaseRun = null;
            runGate = null;
        },
    };
}

test('a scheduled recount runs while idle', async () => {
    const { scheduler, api, calls } = createHarness();

    api.schedule('test');
    assert.equal(calls.runs, 0);

    await scheduler.advance(10);

    assert.equal(calls.runs, 1);
    assert.equal(calls.fresh, 1);
    assert.equal(api.isPending(), false);
});

test('fresh numbers are reported after the recount has finished', async () => {
    const { scheduler, api, calls } = createHarness();

    api.schedule('test');
    await scheduler.advance(10);

    // The panel sync that follows reads the scheduler state to decide between real
    // numbers and the "still recalculating" presentation, so the callback must not
    // observe this run as pending.
    assert.deepEqual(calls.pendingWhenFresh, [false]);
    assert.equal(api.isPending(), false);
});

test('interactions push the recount past the quiet window', async () => {
    const { scheduler, api, calls } = createHarness();

    api.noteInteraction('toggle');
    api.schedule('first');
    await scheduler.advance(100);

    assert.equal(calls.runs, 0, 'recount must not start inside the quiet window');

    await scheduler.advance(400);
    assert.equal(calls.runs, 1);
});

test('a hidden panel parks the recount until it becomes visible again', async () => {
    const { scheduler, api, calls } = createHarness();

    calls.visible = false;
    api.schedule('hidden');
    await scheduler.advance(5000);
    assert.equal(calls.runs, 0);

    calls.visible = true;
    api.wake('visible');
    await scheduler.advance(10);

    assert.equal(calls.runs, 1);
});

test('a running generation blocks the recount', async () => {
    const { scheduler, api, calls } = createHarness();

    calls.busy = true;
    api.schedule('busy');
    await scheduler.advance(5000);
    assert.equal(calls.runs, 0);

    calls.busy = false;
    api.wake('idle generation');
    await scheduler.advance(10);

    assert.equal(calls.runs, 1);
});

test('scrolling holds the recount while deferDuringScroll is on', async () => {
    const { scheduler, api, calls } = createHarness();

    calls.held = true;
    api.schedule('scroll');
    await scheduler.advance(1000);
    assert.equal(calls.runs, 0);

    calls.held = false;
    await scheduler.advance(1000);
    assert.equal(calls.runs, 1);
});

test('recounts are single flight and coalesce bursts', async () => {
    const harness = createHarness({ gated: true });
    const { scheduler, api, calls } = harness;

    api.schedule('burst-1');
    await scheduler.advance(2);
    assert.equal(calls.runs, 1);

    api.schedule('burst-2');
    api.schedule('burst-3');
    await scheduler.advance(50);
    assert.equal(calls.runs, 1, 'a running recount must not be started twice');

    harness.finishRun();
    await scheduler.advance(50);

    assert.equal(calls.runs, 2, 'the queued change triggers exactly one follow-up run');
});

test('recountNow forces a fresh assembly and clears the stale flag', async () => {
    const { api, calls } = createHarness();

    api.markDirty('toggle');
    const fresh = await api.recountNow('inspect');

    assert.equal(fresh, true);
    assert.equal(calls.runs, 1);
    assert.equal(api.isPending(), false);
});

test('recountNow reports freshness without running when nothing is stale', async () => {
    const { api, calls } = createHarness();

    const fresh = await api.recountNow('inspect');

    assert.equal(fresh, true);
    assert.equal(calls.runs, 0);
});

test('failures surface once and do not loop', async () => {
    const { scheduler, api, calls } = createHarness({ failGeneration: true });

    api.schedule('failing');
    await scheduler.advance(1000);

    assert.equal(calls.runs, 1);
    assert.equal(calls.errors, 1);
    assert.equal(api.isPending(), false);
});

test('disabling the extension stops all recount work', async () => {
    const { scheduler, api, calls, config } = createHarness();

    config.enabled = false;
    api.schedule('disabled');
    await scheduler.advance(5000);

    assert.equal(calls.runs, 0);
});

test('a missing prompt manager clears the pending flag instead of spinning', async () => {
    const { scheduler, api, calls } = createHarness({ noInstance: true });

    api.schedule('no instance');
    await scheduler.advance(1000);

    assert.equal(calls.runs, 0);
    assert.equal(api.isPending(), false);
});

test('stop cancels pending work', async () => {
    const { scheduler, api, calls } = createHarness();

    api.schedule('pending');
    api.stop();
    await scheduler.advance(5000);

    assert.equal(calls.runs, 0);
});
