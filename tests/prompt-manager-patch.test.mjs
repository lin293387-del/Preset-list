import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptManagerPatch, isTargetInstance } from '../src/patches/prompt-manager.js';

/**
 * Minimal stand-in for the upstream class, with the methods the takeover needs
 * and spy counters so delegation can be observed.
 */
function createUpstreamFixture({ omit = [] } = {}) {
    const calls = {
        render: 0,
        renderNowAndRefresh: 0,
        renderPromptManager: 0,
        renderPromptManagerListItems: 0,
        setChatCompletion: 0,
        init: 0,
        toggle: 0,
        inspect: 0,
        renderDebounced: 0,
        renderDryRunLatest: 0,
        tokenCacheAttached: 0,
    };

    class PromptManager {
        constructor() {
            this.configuration = { containerIdentifier: 'completion_prompt_manager', prefix: 'completion_' };
            this.activeCharacter = { id: 100001 };
            this.error = null;
            this.tokenHandler = { getCounts: () => ({}) };
            this.renderDebounced = () => {
                calls.renderDebounced += 1;
            };
            this.renderDryRunLatest = () => {
                calls.renderDryRunLatest += 1;
            };
            this.handleToggle = () => {
                calls.toggle += 1;
            };
            this.handleInspect = () => {
                calls.inspect += 1;
            };
        }

        init() {
            calls.init += 1;
        }

        render() {
            calls.render += 1;
        }

        renderNowAndRefresh() {
            calls.renderNowAndRefresh += 1;
        }

        renderPromptManager() {
            calls.renderPromptManager += 1;
            return Promise.resolve();
        }

        renderPromptManagerListItems() {
            calls.renderPromptManagerListItems += 1;
            return Promise.resolve();
        }

        setChatCompletion() {
            calls.setChatCompletion += 1;
        }

        makeDraggable() {}

        getPromptsForCharacter() {
            return [];
        }

        getPromptOrderEntry() {
            return null;
        }
    }

    for (const name of omit) {
        delete /** @type {any} */ (PromptManager.prototype)[name];
    }

    return { PromptManager, calls };
}

function createHarness({ enabled = true, mainApi = 'openai', PromptManager, instance = null } = {}) {
    const hooks = [];
    const logs = [];
    const degraded = [];
    let enabledState = enabled;
    /** @type {any} */
    let live = instance;

    const patch = createPromptManagerPatch({
        PromptManager,
        getPromptManagerInstance: () => live,
        isEnabled: () => enabledState,
        diagnostics: {
            info(message) {
                logs.push(message);
            },
            warn(message) {
                logs.push(`warn:${message}`);
            },
            degrade(feature, reason) {
                degraded.push(`${feature}:${reason}`);
            },
        },
        hooks: {
            getMainApi: () => mainApi,
            requestPanelSync: reason => hooks.push(`sync:${reason}`),
            markDirty: reason => hooks.push(`dirty:${reason}`),
            scheduleRecount: reason => hooks.push(`recount:${reason}`),
            onAssemblyFresh: reason => hooks.push(`fresh:${reason}`),
            attachTokenCache: () => hooks.push('cache'),
            handleToggle: (target, event, original) => {
                hooks.push('toggle');
                return original.call(target, event);
            },
            handleInspect: (target, event, original) => {
                hooks.push('inspect');
                return original.call(target, event);
            },
        },
    });

    return {
        patch,
        hooks,
        logs,
        degraded,
        setEnabled(value) {
            enabledState = value;
        },
        setInstance(value) {
            live = value;
        },
        getInstance: () => live,
    };
}

test('install captures every upstream renderer it will replace', () => {
    const { PromptManager } = createUpstreamFixture();
    const harness = createHarness({ PromptManager });

    harness.patch.install();

    // Regression guard: a missing capture silently stops the panel from rendering.
    for (const name of ['render', 'renderNowAndRefresh', 'renderPromptManager', 'renderPromptManagerListItems', 'setChatCompletion', 'init']) {
        assert.equal(typeof harness.patch.originals[name], 'function', `${name} original must be captured`);
    }
});

test('missing upstream methods are refused instead of patched', () => {
    const { PromptManager } = createUpstreamFixture({ omit: ['renderPromptManagerListItems'] });
    const harness = createHarness({ PromptManager });

    assert.throws(() => harness.patch.assertSupported(), /renderPromptManagerListItems/);
    assert.throws(() => harness.patch.install(), /renderPromptManagerListItems/);
});

test('disabled extensions delegate every renderer back to upstream', async () => {
    const { PromptManager, calls } = createUpstreamFixture();
    const harness = createHarness({ PromptManager, enabled: false });
    harness.patch.install();

    const instance = /** @type {any} */ (Object.create(PromptManager.prototype));
    instance.configuration = { containerIdentifier: 'completion_prompt_manager', promptOrder: { strategy: 'global' } };
    instance.activeCharacter = { id: 1 };

    instance.render(false);
    instance.renderNowAndRefresh();
    await instance.renderPromptManager();
    await instance.renderPromptManagerListItems();

    assert.deepEqual(
        [calls.render, calls.renderNowAndRefresh, calls.renderPromptManager, calls.renderPromptManagerListItems],
        [1, 1, 1, 1],
    );
    assert.deepEqual(harness.hooks, [], 'no plugin hook may run while disabled');
});

test('enabled extensions route rendering into the panel sync', async () => {
    const { PromptManager, calls } = createUpstreamFixture();
    const harness = createHarness({ PromptManager });
    harness.patch.install();

    const instance = /** @type {any} */ (Object.create(PromptManager.prototype));
    instance.configuration = {
        containerIdentifier: 'completion_prompt_manager',
        promptOrder: { strategy: 'global' },
    };
    instance.activeCharacter = { id: 1 };
    instance.error = 'stale';

    instance.render(true);
    instance.renderNowAndRefresh();
    await instance.renderPromptManager(1);

    assert.equal(instance.error, null, 'the upstream error reset is preserved');
    assert.equal(calls.render, 0, 'upstream rendering must not run');
    assert.deepEqual(harness.hooks, [
        'sync:render',
        'recount:render',
        'dirty:renderNowAndRefresh',
        'sync:renderNowAndRefresh',
        'recount:renderNowAndRefresh',
        'sync:renderPromptManager',
    ]);
});

test('rendering is skipped for non chat-completion APIs', () => {
    const { PromptManager, calls } = createUpstreamFixture();
    const harness = createHarness({ PromptManager, mainApi: 'textgenerationwebui' });
    harness.patch.install();

    const instance = /** @type {any} */ (Object.create(PromptManager.prototype));
    instance.configuration = { containerIdentifier: 'completion_prompt_manager', promptOrder: { strategy: 'global' } };
    instance.activeCharacter = { id: 1 };

    instance.render(true);
    instance.renderNowAndRefresh();

    assert.equal(calls.render, 0);
    assert.deepEqual(harness.hooks, []);
});

test('untouched prompt manager instances keep upstream behaviour', () => {
    const { PromptManager, calls } = createUpstreamFixture();
    const harness = createHarness({ PromptManager });
    harness.patch.install();

    const other = /** @type {any} */ (Object.create(PromptManager.prototype));
    other.configuration = { containerIdentifier: 'completion_prompt_manager_headless', promptOrder: { strategy: 'global' } };
    other.activeCharacter = { id: 1 };

    assert.equal(isTargetInstance(other), false);
    other.render(true);
    other.renderNowAndRefresh();

    assert.equal(calls.render, 1);
    assert.equal(calls.renderNowAndRefresh, 1);
});

test('init patches the instance and the instance-level entry points', () => {
    const { PromptManager, calls } = createUpstreamFixture();
    const harness = createHarness({ PromptManager });
    harness.patch.install();

    const instance = /** @type {any} */ (Object.create(PromptManager.prototype));
    instance.configuration = { containerIdentifier: 'completion_prompt_manager', promptOrder: { strategy: 'global' } };
    instance.activeCharacter = { id: 1 };
    instance.tokenHandler = { getCounts: () => ({}) };
    instance.renderDebounced = () => {
        calls.renderDebounced += 1;
    };
    instance.renderDryRunLatest = () => {
        calls.renderDryRunLatest += 1;
    };
    instance.handleToggle = () => {
        calls.toggle += 1;
    };
    instance.handleInspect = () => {
        calls.inspect += 1;
    };

    instance.init();

    instance.renderDebounced();
    instance.renderDryRunLatest();
    instance.handleToggle({ type: 'click' });
    instance.handleInspect({ type: 'click' });

    assert.equal(calls.renderDebounced, 0);
    assert.equal(calls.renderDryRunLatest, 0);
    assert.equal(calls.toggle, 1, 'the upstream toggle still runs through the hook');
    assert.equal(calls.inspect, 1, 'the upstream inspect still runs through the hook');
    assert.deepEqual(harness.hooks, [
        'cache',
        'dirty:renderDebounced',
        'sync:renderDebounced',
        'recount:renderDebounced',
        'recount:renderDryRunLatest',
        'toggle',
        'inspect',
    ]);
    assert.ok(harness.logs.includes('Prompt manager instance patched'));
});

test('instance patching is idempotent and reverts on uninstall', () => {
    const { PromptManager, calls } = createUpstreamFixture();
    const instance = /** @type {any} */ (new PromptManager());
    const originalDebounced = instance.renderDebounced;
    const harness = createHarness({ PromptManager, instance });
    harness.patch.install();
    harness.patch.patchExistingInstance();

    instance.init();
    instance.init();

    assert.equal(harness.hooks.filter(hook => hook === 'cache').length, 1, 'cache hook must run once');

    harness.patch.uninstall();
    assert.equal(instance.renderDebounced, originalDebounced, 'instance originals come back');

    instance.renderDebounced();
    assert.equal(calls.renderDebounced, 1, 'upstream behaviour is restored');
});

test('an instance created before the extension loaded is patched in place', () => {
    const { PromptManager, calls } = createUpstreamFixture();
    const instance = /** @type {any} */ (new PromptManager());
    const harness = createHarness({ PromptManager, instance, enabled: false });
    harness.patch.install();

    assert.equal(harness.patch.patchExistingInstance(), true);
    harness.setEnabled(true);
    instance.renderDebounced();

    assert.equal(calls.renderDebounced, 0);
    assert.ok(harness.hooks.includes('sync:renderDebounced'));
});

test('setChatCompletion reports a fresh assembly', () => {
    const { PromptManager } = createUpstreamFixture();
    const harness = createHarness({ PromptManager });
    harness.patch.install();

    const instance = /** @type {any} */ (Object.create(PromptManager.prototype));
    instance.configuration = { containerIdentifier: 'completion_prompt_manager' };

    instance.setChatCompletion({ getMessages: () => ({}) });

    assert.deepEqual(harness.hooks, ['fresh:setChatCompletion']);
    assert.ok(harness.logs.includes('Prompt manager prototype patched'));
});
