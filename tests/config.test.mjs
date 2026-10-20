import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, createSettings } from '../src/config.js';

/**
 * @param {Record<string, any>} [stored]
 */
function createHarness(stored) {
    const context = {
        extensionSettings: stored ? { 'tavern-optimize': stored } : {},
        saveCalls: 0,
        saveSettingsDebounced() {
            this.saveCalls += 1;
        },
    };
    return { context, settings: createSettings(context) };
}

test('defaults are used when nothing is stored yet', () => {
    const { context, settings } = createHarness();

    assert.equal(settings.get().enabled, DEFAULT_SETTINGS.enabled);
    assert.equal(settings.get().idleDelayMs, 100, 'the default recount delay stays at 100 ms');
    assert.deepEqual(context.extensionSettings['tavern-optimize'], { ...DEFAULT_SETTINGS });
});

test('stored values are coerced and clamped, unknown keys are dropped', () => {
    const { settings } = createHarness({
        enabled: 'yes',
        idleDelayMs: -400,
        tokenCacheLimit: 10 ** 9,
        deferDuringScroll: false,
        unknownKey: 'ignored',
    });

    assert.equal(settings.get().enabled, DEFAULT_SETTINGS.enabled, 'non booleans fall back to the default');
    assert.equal(settings.get().idleDelayMs, 0, 'numbers are clamped to the documented range');
    assert.equal(settings.get().tokenCacheLimit, 200000);
    assert.equal(settings.get().deferDuringScroll, false, 'real booleans are kept');
    assert.equal('unknownKey' in settings.get(), false);
});

test('updates persist once and notify subscribers only on real changes', () => {
    const { context, settings } = createHarness();
    let notifications = 0;
    const unsubscribe = settings.subscribe(() => {
        notifications += 1;
    });

    settings.update({ enabled: false });
    settings.update({ enabled: false });
    settings.update({ idleDelayMs: 500 });

    assert.equal(notifications, 2, 'no notification for a no-op update');
    assert.equal(context.saveCalls, 2, 'settings are persisted on change');
    assert.equal(settings.get().idleDelayMs, 500);

    unsubscribe();
    settings.update({ enabled: true });
    assert.equal(notifications, 2, 'unsubscribed listeners are not called');
});

test('settings stored under the pre-rename namespace are adopted, not discarded', () => {
    const context = {
        extensionSettings: { 'preset-lite': { idleDelayMs: 750, coalescePresetEvents: false } },
        saveCalls: 0,
        saveSettingsDebounced() {
            this.saveCalls += 1;
        },
    };
    const settings = createSettings(context);

    assert.equal(settings.get().idleDelayMs, 750, 'a configured delay survives the rename');
    assert.equal(settings.get().coalescePresetEvents, false);
    assert.deepEqual(context.extensionSettings['tavern-optimize'], settings.get(), 'state now lives under the new namespace');
});

test('the mobile paint layer is a switch, on by default', () => {
    const context = { extensionSettings: {}, saveSettingsDebounced() {} };
    const settings = createSettings(context);

    assert.equal(settings.get().mobilePaintLayer, true, 'a phone gets the paint layer without opting in');

    settings.update({ mobilePaintLayer: false });
    assert.equal(settings.get().mobilePaintLayer, false);
    assert.equal(context.extensionSettings['tavern-optimize'].mobilePaintLayer, false, 'the choice is persisted');

    // Anything that is not a boolean falls back to the default instead of turning
    // a look-for-speed trade on or off by accident.
    settings.update({ mobilePaintLayer: 'off' });
    assert.equal(settings.get().mobilePaintLayer, true);
});
