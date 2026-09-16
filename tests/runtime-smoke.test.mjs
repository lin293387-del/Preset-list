import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

/**
 * End-to-end smoke test of the runtime composition.
 *
 * The upstream modules are replaced by test doubles through a Node resolve hook,
 * so this exercises the same wiring the device runs: prototype takeover,
 * instance patching, event registration, incremental rendering, deferred token
 * recounts, the preset-apply window, and the restore path of `stop()`.
 *
 * happy-dom is an optional devDependency: run `npm install` first.
 */
const { Window } = await import('happy-dom').catch(() => ({ Window: null }));

register('./fixtures/scripts-loader.mjs', import.meta.url);

describe('runtime smoke test', { skip: Window ? false : 'happy-dom is not installed (run npm install)' }, () => {
    const window = new Window({ url: 'https://localhost/' });
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.Node = window.Node;
    globalThis.Element = window.Element;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.HTMLInputElement = window.HTMLInputElement;
    globalThis.HTMLSelectElement = window.HTMLSelectElement;
    globalThis.Text = window.Text;
    globalThis.IntersectionObserver = class {
        observe() {}
        disconnect() {}
    };
    globalThis.requestAnimationFrame = fn => setTimeout(() => fn(Date.now()), 0);
    globalThis.cancelAnimationFrame = handle => clearTimeout(handle);

    /**
     * Minimal event source matching the upstream EventEmitter surface.
     */
    function createEventSource() {
        const listeners = new Map();
        return {
            on(event, listener) {
                const list = listeners.get(event) ?? [];
                list.push(listener);
                listeners.set(event, list);
            },
            once(event, listener) {
                const wrapper = (...args) => {
                    this.removeListener(event, wrapper);
                    listener(...args);
                };
                this.on(event, wrapper);
            },
            removeListener(event, listener) {
                const list = listeners.get(event) ?? [];
                const index = list.indexOf(listener);
                if (index >= 0) {
                    list.splice(index, 1);
                }
            },
            async emit(event, ...args) {
                for (const listener of [...(listeners.get(event) ?? [])]) {
                    await listener(...args);
                }
            },
            count(event) {
                return (listeners.get(event) ?? []).length;
            },
        };
    }

    /**
     * `$` stand-in: collections expose `trigger`, `on`/`off` for the sortable
     * bracket, and iteration for the coalescer.
     */
    function createJQuery() {
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

        /**
         * jQuery event types may be namespaced and space separated
         * (`'sortstart.ttPresetLite sortbegin.ttPresetLite'`); DOM listeners only
         * understand the bare names.
         *
         * @param {any} type
         * @returns {string[]}
         */
        function bareEventNames(type) {
            return String(type)
                .split(/\s+/)
                .map(name => name.split('.')[0])
                .filter(Boolean);
        }

        $.fn = {
            trigger(type, data) {
                for (const element of this) {
                    if (element instanceof Element && typeof type === 'string') {
                        for (const name of bareEventNames(type)) {
                            element.dispatchEvent(new window.CustomEvent(name, { bubbles: true, detail: data }));
                        }
                    }
                }
                return this;
            },
            on(type, handler) {
                for (const element of this) {
                    if (!(element instanceof Element)) {
                        continue;
                    }
                    for (const name of bareEventNames(type)) {
                        element.addEventListener(name, handler);
                    }
                }
                return this;
            },
            off(type, handler) {
                for (const element of this) {
                    if (!(element instanceof Element)) {
                        continue;
                    }
                    for (const name of bareEventNames(type)) {
                        element.removeEventListener(name, handler);
                    }
                }
                return this;
            },
        };

        return $;
    }

    async function waitFor(predicate, { timeoutMs = 2000, step = 5 } = {}) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            if (predicate()) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, step));
        }
        throw new Error('Condition was not met in time');
    }

    function createApp() {
        document.body.innerHTML = `
            <div id="left-nav-panel" class="drawer-content openDrawer">
                <div class="scrollableInner">
                    <input id="temp_openai" class="text_pole" value="1">
                    <div id="completion_prompt_manager"></div>
                </div>
            </div>
            <div id="completion_prompt_manager_popup" style="display:none;">
                <div id="completion_prompt_manager_popup_inspect" style="display:none;"></div>
            </div>`;

        const eventSource = createEventSource();
        const eventTypes = {
            APP_READY: 'app_ready',
            GENERATION_STARTED: 'generation_started',
            GENERATION_STOPPED: 'generation_stopped',
            GENERATION_ENDED: 'generation_ended',
            OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before',
            OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
            PRESET_CHANGED: 'preset_changed',
            CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
            SETTINGS_UPDATED: 'settings_updated',
        };

        const context = {
            mainApi: 'openai',
            chat: [],
            extensionSettings: {},
            eventSource,
            eventTypes,
            saveSettingsDebounced() {},
            renderExtensionTemplateAsync: async () => '<div id="preset-lite-settings"></div>',
        };
        /** @type {any} */ (globalThis).__TEST_CONTEXT__ = context;

        return { context, eventSource, eventTypes };
    }

    /**
     * @returns {Promise<{ runtime: any, app: any, openai: any, calls: any, settings: any }>}
     */
    async function bootRuntime({ enabled = true } = {}) {
        const app = createApp();
        const openai = await import('/scripts/openai.js');
        const { createSettings } = await import('../src/config.js');
        const { createDiagnostics } = await import('../src/diagnostics.js');
        const { createRuntime } = await import('../src/runtime.js');
        const { PromptManager } = await import('/scripts/PromptManager.js');

        const settings = createSettings(app.context);
        settings.update({ enabled, idleDelayMs: 0, diagnostics: false });

        const diagnostics = createDiagnostics({ isVerbose: () => false });
        const runtime = createRuntime({
            context: app.context,
            settings,
            diagnostics,
            identity: { name: 'third-party/Preset-list', folder: 'Preset-list' },
        });
        runtime.start();

        // The chat-completion module creates the prompt manager on first use.
        const instance = new PromptManager();
        instance.containerElement = document.getElementById('completion_prompt_manager');
        instance.serviceSettings.prompts = [
            { identifier: 'main', name: 'Main Prompt', system_prompt: true, role: 'system', content: 'main' },
            { identifier: 'userOne', name: 'User One', role: 'user', content: 'one' },
            { identifier: 'chatHistory', name: 'Chat History', marker: true },
        ];
        instance.serviceSettings.prompt_order = [{
            character_id: 100001,
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'userOne', enabled: true },
                { identifier: 'chatHistory', enabled: true },
            ],
        }];
        instance.tokenHandler = {
            counts: { main: 12, userOne: 34, chatHistory: 567 },
            getCounts() {
                return this.counts;
            },
            countTokenAsyncFn: async () => 1,
        };
        instance.error = null;
        instance.init();
        openai.__setPromptManager(instance);

        return { runtime, app, openai, instance, settings, PromptManager };
    }

    test('the runtime takes over the panel and renders without rebuilding rows', async () => {
        const { runtime, instance, PromptManager } = await bootRuntime();

        try {
            assert.match(String(PromptManager.prototype.render), /patchedRender/);

            instance.render(true);
            await waitFor(() => document.querySelectorAll('li[data-pm-identifier]').length === 3);

            const list = document.getElementById('completion_prompt_manager_list');
            const nodes = Array.from(list.children);

            // A second render must be a no-op for unchanged rows.
            instance.renderNowAndRefresh();
            await new Promise(resolve => setTimeout(resolve, 20));

            assert.deepEqual(Array.from(list.children), nodes, 'rows must be reused');

            const mainRow = list.querySelector('li[data-pm-identifier="main"]');
            assert.equal(mainRow.querySelector('.prompt_manager_prompt_tokens').getAttribute('data-pm-tokens'), '12');
        } finally {
            runtime.stop();
        }
    });

    test('a recount runs only while idle and writes the numbers in place', async () => {
        const { runtime, instance } = await bootRuntime();

        try {
            instance.render(true);
            await waitFor(() => document.querySelectorAll('li[data-pm-identifier]').length === 3);

            await waitFor(() => (instance.tryGenerateCalls ?? 0) === 1, { timeoutMs: 3000 });

            const list = document.getElementById('completion_prompt_manager_list');
            const row = list.querySelector('li[data-pm-identifier="main"]');
            assert.ok(row.querySelector('.prompt_manager_prompt_tokens'));

            // Real recount: counts change, DOM updates in place, nodes survive.
            instance.tokenHandler.counts.main = 99;
            instance.tokenUsage = 680;
            instance.setChatCompletion({ getMessages: () => ({}) });
            await waitFor(() => list.querySelector('li[data-pm-identifier="main"] .prompt_manager_prompt_tokens').getAttribute('data-pm-tokens') === '99');
            assert.equal(list.querySelector('li[data-pm-identifier="main"]'), row, 'the row node must survive the recount');
        } finally {
            runtime.stop();
        }
    });

    test('toggling a prompt keeps the last number and schedules one recount', async () => {
        const { runtime, instance } = await bootRuntime();

        try {
            instance.render(true);
            await waitFor(() => document.querySelectorAll('li[data-pm-identifier]').length === 3);

            const list = document.getElementById('completion_prompt_manager_list');
            const toggle = list.querySelector('li[data-pm-identifier="userOne"] .prompt-manager-toggle-action');
            toggle.click();

            await waitFor(() => (instance.handleToggleCalls ?? 0) === 1);
            await new Promise(resolve => setTimeout(resolve, 20));

            const cell = list.querySelector('li[data-pm-identifier="userOne"] .prompt_manager_prompt_tokens');
            assert.equal(cell.getAttribute('data-pm-tokens'), '34', 'the previous number stays visible');
            assert.match(cell.className, /prompt_manager_prompt_tokens/);
            assert.match(list.querySelector('li[data-pm-identifier="userOne"]').className, /prompt_manager_prompt_disabled/);
        } finally {
            runtime.stop();
        }
    });

    test('the preset apply window defers and replays panel input events', async () => {
        const $ = createJQuery();
        globalThis.jQuery = $;
        const { runtime, app } = await bootRuntime();

        try {
            const field = document.getElementById('temp_openai');
            let handlerCalls = 0;
            $(field).on('input', () => {
                handlerCalls += 1;
            });

            await app.eventSource.emit(app.eventTypes.OAI_PRESET_CHANGED_BEFORE, {});
            $(field).trigger('input', { source: 'preset' });
            assert.equal(handlerCalls, 0, 'preset input events are deferred inside the window');

            await app.eventSource.emit(app.eventTypes.OAI_PRESET_CHANGED_AFTER);
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(handlerCalls, 1, 'the deferred event is replayed once');
        } finally {
            runtime.stop();
        }
    });

    test('disabling the extension hands the panel back to upstream', async () => {
        const { runtime, instance, PromptManager, settings } = await bootRuntime();
        const patchedRender = PromptManager.prototype.render;

        try {
            settings.update({ enabled: false });

            // The wrapper stays installed but must delegate to upstream, so no
            // reload is needed to get stock behaviour back.
            assert.equal(PromptManager.prototype.render, patchedRender, 'the wrapper is not removed, only bypassed');

            instance.render(true);
            instance.renderNowAndRefresh();

            assert.equal(instance.renderCalls ?? 0, 1, 'upstream render runs while disabled');
            assert.equal(instance.renderNowAndRefreshCalls ?? 0, 1, 'upstream refresh runs while disabled');
        } finally {
            runtime.stop();
        }
    });

    test('the benchmark drives the panel, reports progress and restores state', async () => {
        const { runtime, instance } = await bootRuntime();

        try {
            instance.render(true);
            await waitFor(() => document.querySelectorAll('li[data-pm-identifier]').length === 3);

            const messages = [];
            const report = await runtime.bench.run({
                mode: 'optimized',
                toggles: 3,
                toggleIntervalMs: 5,
                presets: 1,
                presetIntervalMs: 5,
                scrollMs: 50,
                settleMs: 30,
                onProgress: ({ message }) => messages.push(message),
            });

            assert.ok(messages.some(message => message.startsWith('sample:')), 'a preflight sample summary is reported');
            assert.ok(messages.some(message => message.includes('=== OPTIMIZED run ===')));
            assert.ok(messages.some(message => message.includes('phase 1: toggles')), 'phase progress is reported');
            assert.ok(messages.some(message => message.includes('restored prompt states')), 'restoration is reported');

            assert.ok(report.phases.length >= 3, 'the report contains the phases');
            assert.equal(runtime.bench.isRunning(), false);
            assert.equal(instance.handleToggleCalls, 3, 'three prompt toggles were performed');

            const order = instance.serviceSettings.prompt_order[0].order;
            assert.ok(order.every(entry => entry.enabled === true), 'toggled prompts are restored');
        } finally {
            runtime.stop();
        }
    });

    test('a benchmark that has nothing to exercise says so instead of failing', async () => {
        const { runtime, instance } = await bootRuntime();

        try {
            // An empty prompt set (not a hand-cleared DOM: the panel would rebuild it).
            instance.serviceSettings.prompts = [];
            instance.serviceSettings.prompt_order[0].order = [];
            instance.renderNowAndRefresh();
            await waitFor(() => document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]').length === 0);

            const messages = [];
            const report = await runtime.bench.run({
                mode: 'optimized',
                toggles: 2,
                toggleIntervalMs: 5,
                presets: 2,
                presetIntervalMs: 5,
                scrollMs: 20,
                settleMs: 20,
                onProgress: ({ message }) => messages.push(message),
            });

            assert.ok(messages.some(message => message.includes('no toggleable prompt rows')));
            assert.ok(messages.some(message => message.includes('fewer than two presets')));
            const toggles = report.phases.find(phase => phase.name === 'toggles');
            assert.equal(toggles.details.toggles, 0);
            assert.equal(instance.handleToggleCalls ?? 0, 0);
        } finally {
            runtime.stop();
        }
    });

    test('stop restores the upstream prototype and removes listeners', async () => {
        const { runtime, app, instance, PromptManager, openai } = await bootRuntime();
        const prototypeRender = PromptManager.prototype.render;

        try {
            runtime.stop();
        } finally {
            assert.notEqual(PromptManager.prototype.render, prototypeRender, 'prototype is restored');
            assert.equal(document.body.classList.contains('tt-pl-on'), false);
            assert.equal(app.eventSource.count(app.eventTypes.OAI_PRESET_CHANGED_BEFORE), 0, 'listeners are removed');
            openai.__setPromptManager(null);
        }
    });
});
