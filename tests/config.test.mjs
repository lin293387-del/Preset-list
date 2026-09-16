import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, createSettings } from '../src/config.js';

/**
 * @param {Record<string, any>} [stored]
 */
function createHarness(stored) {
    const context = {
        extensionSettings: stored ? { 'preset-lite': stored } : {},
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
    assert.equal(settings.get().hudPassthrough, true, 'the HUD never blocks touches by default');
    assert.deepEqual(context.extensionSettings['preset-lite'], { ...DEFAULT_SETTINGS });
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
