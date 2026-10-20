// @ts-check
/**
 * The input gate exists to change *when* the panel is allowed to write, so these
 * tests drive it with an injected clock, frame scheduler and timer queue: a test
 * that sleeps for real hold windows measures the machine, not the gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TYPE_HOLD_MS, createInputGate } from '../src/input.js';

/**
 * A gate wired to a fake clock, a manual frame queue and a manual timer queue.
 *
 * @param {{ onIdle?: (reason: string) => void }} [options]
 */
function fixtures(options = {}) {
    let time = 1000;
    /** @type {Array<() => void>} */
    let frames = [];
    /** @type {Array<{ at: number, callback: () => void, handle: number }>} */
    let timers = [];
    let nextHandle = 1;
    let scheduled = 0;

    const gate = createInputGate({
        now: () => time,
        scheduleFrame: callback => {
            scheduled += 1;
            const handle = nextHandle++;
            frames.push(callback);
            return handle;
        },
        cancelFrame: handle => {
            frames = [];
            nextHandle = Math.max(nextHandle, handle + 1);
        },
        setTimer: (callback, ms) => {
            const handle = nextHandle++;
            timers.push({ at: time + ms, callback, handle });
            return handle;
        },
        clearTimer: handle => {
            timers = timers.filter(timer => timer.handle !== handle);
        },
        onIdle: options.onIdle,
    });

    return {
        gate,
        advance(ms) {
            time += ms;
            // Timers fire in time order, exactly once.
            for (const timer of [...timers].sort((first, second) => first.at - second.at)) {
                if (timer.at <= time && timers.includes(timer)) {
                    timers = timers.filter(entry => entry !== timer);
                    timer.callback();
                }
            }
        },
        runFrame() {
            const pending = frames;
            frames = [];
            for (const callback of pending) {
                callback();
            }
        },
        get pendingFrames() {
            return frames.length;
        },
        get frameSchedules() {
            return scheduled;
        },
    };
}

test('a composition holds the panel for as long as it lasts', () => {
    const { gate, advance } = fixtures();
    gate.beginComposition();
    advance(10_000);

    assert.equal(gate.isComposing(), true);
    assert.equal(gate.isHeld(), true);

    gate.endComposition();
    assert.equal(gate.isHeld(), false);
});

test('composing does not expire on a timer the way typing does', () => {
    const { gate, advance, runFrame } = fixtures();
    gate.beginComposition();
    gate.noteInput();
    runFrame();
    advance(TYPE_HOLD_MS * 4);

    // The keystroke's hold has run out, the composition has not.
    assert.equal(gate.isHeld(), true);
});

test('nesting compositions does not release the hold early', () => {
    const { gate } = fixtures();
    gate.beginComposition();
    gate.beginComposition();
    gate.endComposition();
    assert.equal(gate.isHeld(), true);
    gate.endComposition();
    assert.equal(gate.isHeld(), false);
});

test('typing holds the panel until the hold window passes', () => {
    const { gate, advance, runFrame } = fixtures();
    gate.noteInput();
    runFrame();
    assert.equal(gate.isHeld(), true);

    advance(TYPE_HOLD_MS - 1);
    assert.equal(gate.isHeld(), true);

    advance(2);
    assert.equal(gate.isHeld(), false);
});

test('a burst of keystrokes is folded into one frame', () => {
    // The fixture object is kept whole: `frameSchedules` is a getter, and
    // destructuring it would read the value once, before anything ran.
    const fixture = fixtures();

    for (let index = 0; index < 40; index += 1) {
        fixture.gate.noteInput();
    }
    assert.equal(fixture.frameSchedules, 1, 'forty key presses scheduled one frame');

    fixture.runFrame();
    fixture.gate.noteInput();
    assert.equal(fixture.frameSchedules, 2, 'the next burst gets its own frame');
});

test('the hold is measured from the latest keystroke', () => {
    const { gate, advance, runFrame } = fixtures();
    gate.noteInput();
    runFrame();
    advance(TYPE_HOLD_MS - 10);
    gate.noteInput();
    runFrame();
    advance(20);

    // 20 ms after the second keystroke, the first keystroke's window is long gone.
    assert.equal(gate.isHeld(), true);
});

test('the end of the hold is reported once', () => {
    /** @type {string[]} */
    const reasons = [];
    const { gate, advance, runFrame } = fixtures({ onIdle: reason => reasons.push(reason) });

    gate.noteInput();
    runFrame();
    advance(TYPE_HOLD_MS + 1);
    assert.deepEqual(reasons, ['typing-end']);

    gate.beginComposition();
    gate.endComposition();
    assert.deepEqual(reasons, ['typing-end', 'composition-end']);
});

test('flush releases everything and reports why', () => {
    /** @type {string[]} */
    const reasons = [];
    const { gate, runFrame, pendingFrames } = fixtures({ onIdle: reason => reasons.push(reason) });

    gate.beginComposition();
    gate.noteInput();
    runFrame();
    gate.flush('test-flush');

    assert.equal(gate.isHeld(), false);
    assert.equal(pendingFrames, 0);
    assert.ok(reasons.includes('test-flush'));
});

test('clear leaves nothing scheduled', () => {
    const { gate, runFrame, pendingFrames } = fixtures();
    gate.noteInput();
    gate.clear();

    assert.equal(pendingFrames, 0);
    assert.equal(gate.isHeld(), false);
    runFrame();
    assert.equal(gate.isHeld(), false);
});
