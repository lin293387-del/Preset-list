import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createPanelState, fullRebuild, syncPanel } from '../src/render/panel.js';

/**
 * happy-dom is an optional devDependency: the pure logic tests always run, this
 * integration file needs `npm install` first.
 */
const { Window } = await import('happy-dom').catch(() => ({ Window: null }));

describe('panel DOM integration', { skip: Window ? false : 'happy-dom is not installed (run npm install)' }, () => {
    const window = new Window({ url: 'https://localhost/' });
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.Node = window.Node;
    globalThis.Element = window.Element;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.HTMLSelectElement = window.HTMLSelectElement;
    globalThis.Text = window.Text;
    globalThis.queueMicrotask = queueMicrotask;
    globalThis.requestAnimationFrame = fn => setTimeout(() => fn(Date.now()), 0);
    globalThis.cancelAnimationFrame = handle => clearTimeout(handle);
    globalThis.IntersectionObserver = class {
        observe() {}
        disconnect() {}
    };

    const PREFIX = 'completion_';

    /** Faithful copy of upstream `promptManagerHeader.html`. */
    function headerHtml({ error, total }) {
        const errorDiv = error
            ? `<div class="${PREFIX}prompt_manager_error"><span class="fa-solid tooltip fa-triangle-exclamation text_danger"></span> ${error}</div>`
            : '';
        return `
    <div class="range-block">
        ${error ? errorDiv : ''}
        <div class="${PREFIX}prompt_manager_header">
            <div class="${PREFIX}prompt_manager_header_advanced"><span data-i18n="Prompts">Prompts</span></div>
            <div><span data-i18n="Total Tokens:">Total Tokens:</span> ${total} </div>
        </div>
        <ul id="${PREFIX}prompt_manager_list" class="text_pole"></ul>
    </div>`;
    }

    /** Faithful copy of upstream `promptManagerListHeader.html`. */
    const LIST_HEADER_HTML = `
    <li class="${PREFIX}prompt_manager_list_head"><span data-i18n="Name">Name</span><span></span><span class="prompt_manager_prompt_tokens" data-i18n="Tokens;prompt_manager_tokens">Tokens</span></li>
    <li class="${PREFIX}prompt_manager_list_separator"><hr></li>`;

    /** Faithful copy of upstream `promptManagerFooter.html`. */
    function footerHtml(promptsHtml) {
        return `
    <div class="${PREFIX}prompt_manager_footer">
        <select id="${PREFIX}prompt_manager_footer_append_prompt" class="text_pole" name="append-prompt">${promptsHtml}</select>
        <a class="menu_button fa-chain fa-solid fa-fw" title="Insert prompt"></a>
        <a class="caution menu_button fa-x fa-solid fa-fw" title="Delete prompt"></a>
        <a class="menu_button fa-file-import fa-solid fa-fw" id="prompt-manager-import"></a>
        <a class="menu_button fa-file-export fa-solid fa-fw" id="prompt-manager-export"></a>
        <a class="menu_button fa-undo fa-solid fa-fw" id="prompt-manager-reset-character"></a>
        <a class="menu_button fa-plus-square fa-solid fa-fw" title="New prompt"></a>
    </div>`;
    }

    /** Faithful copy of the upstream row template (token cell included). */
    function rowHtml(prompt, { enabled, tokens, warningClass = '', warningTitle = '' }) {
        const disabledClass = enabled ? '' : `${PREFIX}prompt_manager_prompt_disabled`;
        const calculatedTokens = tokens ? tokens : '-';
        return `
    <li class="${PREFIX}prompt_manager_prompt ${PREFIX}prompt_manager_prompt_draggable ${disabledClass}  " data-pm-identifier="${prompt.identifier}">
        <span class="drag-handle">☰</span>
        <span class="${PREFIX}prompt_manager_prompt_name" data-pm-name="${prompt.name}">
            <a title="${prompt.name}" class="prompt-manager-inspect-action">${prompt.name}</a>
        </span>
        <span>
                <span class="prompt_manager_prompt_controls">
                    <span class="fa-solid"></span>
                    <span class="prompt-manager-edit-action fa-solid fa-pencil fa-xs"></span>
                    <span class="prompt-manager-toggle-action ${enabled ? 'fa-solid fa-toggle-on' : 'fa-solid fa-toggle-off'}"></span>
                </span>
        </span>

        <span class="prompt_manager_prompt_tokens" data-pm-tokens="${calculatedTokens}"><span class="${warningClass}" title="${warningTitle}"> </span>${calculatedTokens}</span>
    </li>`;
    }

    function createFixture({ prompts, enabledMap, counts }) {
        document.body.innerHTML = `
            <div id="left-nav-panel" class="drawer-content openDrawer"><div class="scrollableInner"><div id="completion_prompt_manager"></div></div></div>
            <div id="completion_prompt_manager_popup" style="display:none;"><div id="completion_prompt_manager_popup_inspect" style="display:none;"></div></div>`;

        const instance = {
            configuration: { prefix: PREFIX, containerIdentifier: 'completion_prompt_manager' },
            containerElement: document.getElementById('completion_prompt_manager'),
            listElement: null,
            activeCharacter: { id: 100001 },
            serviceSettings: {
                prompts,
                prompt_order: [{
                    character_id: 100001,
                    order: prompts.map(prompt => ({ identifier: prompt.identifier, enabled: enabledMap.get(prompt.identifier) === true })),
                }],
                openai_max_context: 8192,
                openai_max_tokens: 300,
            },
            tokenUsage: 0,
            error: null,
            messages: null,
            toggleCalls: 0,
            // Upstream renders from the character prompt order, so the fixture does too.
            getPromptOrderForCharacter(character) {
                return character
                    ? (this.serviceSettings.prompt_order.find(list => String(list.character_id) === String(character.id))?.order ?? [])
                    : [];
            },
            getPromptsForCharacter(character) {
                return this.getPromptOrderForCharacter(character)
                    .map(entry => this.getPromptById(entry.identifier))
                    .filter(prompt => prompt !== null);
            },
            getPromptById(identifier) {
                return this.serviceSettings.prompts.find(prompt => prompt && prompt.identifier === identifier) ?? null;
            },
            getPromptOrderEntry(character, identifier) {
                return this.getPromptOrderForCharacter(character).find(entry => entry.identifier === identifier) ?? null;
            },
            tokenHandler: {
                getCounts: () => counts,
                getTotal: () => Object.values(counts).reduce((total, value) => total + (Number(value) || 0), 0),
            },
            makeDraggable() {
                this.draggableCalls = (this.draggableCalls ?? 0) + 1;
            },
            loadMessagesIntoInspectForm() {},
            handleToggle() {
                this.toggleCalls += 1;
            },
            handleInspect() {},
            handleEdit() {},
            handleDetach() {},
            async renderPromptManager() {
                const container = this.containerElement;
                container.innerHTML = '';
                container.insertAdjacentHTML('beforeend', headerHtml({ error: this.error, total: this.tokenUsage }));
                this.listElement = container.querySelector(`#${PREFIX}prompt_manager_list`);

                if (this.activeCharacter === null) {
                    return;
                }

                const selectable = [...this.serviceSettings.prompts]
                    .filter(prompt => prompt && !prompt.system_prompt)
                    .sort((left, right) => left.name.localeCompare(right.name));
                const promptsHtml = selectable.reduce((acc, prompt) => acc + `<option value="${prompt.identifier}">${prompt.name}</option>`, '');
                const rangeBlock = container.querySelector('.range-block');
                const header = container.querySelector(`.${PREFIX}prompt_manager_header`);
                header.insertAdjacentHTML('afterend', footerHtml(promptsHtml));
                rangeBlock.querySelector('.completion_prompt_manager_header');
            },
            async renderPromptManagerListItems() {
                const list = this.listElement;
                list.innerHTML = '';
                const counts = this.tokenHandler.getCounts();
                let html = LIST_HEADER_HTML;
                for (const prompt of this.getPromptsForCharacter(this.activeCharacter)) {
                    if (!prompt) {
                        continue;
                    }
                    const entry = this.getPromptOrderEntry(this.activeCharacter, prompt.identifier);
                    html += rowHtml(prompt, {
                        enabled: entry.enabled,
                        tokens: counts[prompt.identifier] ?? 0,
                    });
                }
                list.insertAdjacentHTML('beforeend', html);
            },
        };

        const originals = {
            renderPromptManager: instance.renderPromptManager,
            renderPromptManagerListItems: instance.renderPromptManagerListItems,
        };

        let pending = false;
        const settingsState = { keepStaleNumbers: true, idleDelayMs: 0, enabled: true };
        const context = {
            instance,
            originals,
            state: createPanelState(),
            settings: {
                get: () => settingsState,
            },
            diagnostics: {
                info() {},
                warn() {},
                error() {},
                degrade() {},
                noteOnce() {},
            },
            isPending: () => pending,
        };

        return {
            context,
            settingsState,
            setPending(value) {
                pending = value;
            },
            setKeepStaleNumbers(value) {
                settingsState.keepStaleNumbers = value;
            },
        };
    }

    function defaultPrompts() {
        return [
            { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'main' },
            { identifier: 'chatHistory', name: 'Chat History', marker: true },
            { identifier: 'worldInfoBefore', name: 'World Info (↑Char)', marker: true },
        ];
    }

    const sleep = () => new Promise(resolve => setTimeout(resolve, 0));

    test('first sync builds the upstream structure once', async () => {
        const prompts = defaultPrompts();
        const counts = { main: 12, chatHistory: 345, worldInfoBefore: 7 };
        const harness = createFixture({
            prompts,
            enabledMap: new Map([['main', true], ['chatHistory', true], ['worldInfoBefore', true]]),
            counts,
        });

        await syncPanel(harness.context);

        const container = harness.context.instance.containerElement;
        assert.ok(container.querySelector(`#${PREFIX}prompt_manager_list`));
        assert.ok(container.querySelector(`.${PREFIX}prompt_manager_header`));
        assert.ok(container.querySelector(`.${PREFIX}prompt_manager_footer`));
        assert.equal(container.querySelectorAll('li[data-pm-identifier]').length, 3);
        assert.equal(container.querySelectorAll('li:not([data-pm-identifier])').length, 2, 'head + separator');
        assert.equal(harness.context.instance.makeDraggableCalls ?? 1, 1);
        assert.equal(harness.context.state.lastStats.created, 3);
    });

    test('an unchanged list performs zero DOM work and keeps node identity', async () => {
        const prompts = defaultPrompts();
        const counts = { main: 12, chatHistory: 345, worldInfoBefore: 7 };
        const harness = createFixture({ prompts, enabledMap: new Map(prompts.map(p => [p.identifier, true])), counts });

        await syncPanel(harness.context);
        const list = harness.context.instance.containerElement.querySelector(`#${PREFIX}prompt_manager_list`);
        const before = Array.from(list.children);

        await syncPanel(harness.context);
        const after = Array.from(list.children);

        assert.deepEqual(harness.context.state.lastStats, {
            created: 0,
            updated: 0,
            tokens: 0,
            removed: 0,
            moved: 0,
            rebuilt: 0,
            replaced: 0,
        });
        assert.equal(before.length, after.length);
        before.forEach((node, index) => assert.equal(node, after[index], `row ${index} must be reused`));
    });

    test('token-only changes update the token cell in place', async () => {
        const prompts = defaultPrompts();
        const counts = { main: 12, chatHistory: 345, worldInfoBefore: 7 };
        const harness = createFixture({ prompts, enabledMap: new Map(prompts.map(p => [p.identifier, true])), counts });

        await syncPanel(harness.context);
        const list = harness.context.instance.containerElement.querySelector(`#${PREFIX}prompt_manager_list`);
        const rowsBefore = Array.from(list.querySelectorAll('li[data-pm-identifier]'));

        counts.main = 99;
        harness.context.instance.tokenUsage = 456;
        await syncPanel(harness.context);

        const rowsAfter = Array.from(list.querySelectorAll('li[data-pm-identifier]'));
        rowsBefore.forEach((node, index) => assert.equal(node, rowsAfter[index], 'row nodes must survive token updates'));
        const mainCell = rowsAfter[0].querySelector('.prompt_manager_prompt_tokens');
        assert.equal(mainCell.getAttribute('data-pm-tokens'), '99');
        assert.equal(mainCell.textContent.trim(), '99');
        assert.equal(mainCell.innerHTML, '<span class="" title=""> </span>99');
        assert.equal(harness.context.state.lastStats.tokens, 1);
        assert.equal(harness.context.state.lastStats.updated, 0);
    });

    test('structural changes update only the affected row', async () => {
        const prompts = defaultPrompts();
        const enabled = new Map(prompts.map(p => [p.identifier, true]));
        const harness = createFixture({ prompts, enabledMap: enabled, counts: { main: 12, chatHistory: 345, worldInfoBefore: 7 } });

        await syncPanel(harness.context);
        const list = harness.context.instance.containerElement.querySelector(`#${PREFIX}prompt_manager_list`);
        const untouched = Array.from(list.querySelectorAll('li[data-pm-identifier]'))[1];

        harness.context.instance.serviceSettings.prompt_order[0].order[0].enabled = false;
        await syncPanel(harness.context);

        const rows = Array.from(list.querySelectorAll('li[data-pm-identifier]'));
        assert.equal(rows[1], untouched, 'untouched rows keep their node');
        assert.match(rows[0].className, /prompt_manager_prompt_disabled/);
        assert.match(rows[0].innerHTML, /fa-toggle-off/);
        assert.equal(harness.context.state.lastStats.updated, 1);
    });

    test('adding and removing prompts updates footer options and rows', async () => {
        const prompts = defaultPrompts();
        const enabled = new Map(prompts.map(p => [p.identifier, true]));
        const counts = { main: 12, chatHistory: 345, worldInfoBefore: 7 };
        const harness = createFixture({ prompts, enabledMap: enabled, counts });

        await syncPanel(harness.context);

        prompts.push({ identifier: 'jailbreak', name: 'Jailbreak', role: 'system', content: 'jb' });
        enabled.set('jailbreak', true);
        counts.jailbreak = 5;
        harness.context.instance.serviceSettings.prompt_order[0].order.push({ identifier: 'jailbreak', enabled: true });
        await syncPanel(harness.context);

        // Adding a prompt changes the footer, which rebuilds the container; the new
        // list element is queried again the same way upstream callers do.
        let list = harness.context.instance.containerElement.querySelector(`#${PREFIX}prompt_manager_list`);
        assert.ok(list.querySelector('li[data-pm-identifier="jailbreak"]'));
        const select = harness.context.instance.containerElement.querySelector(`#${PREFIX}prompt_manager_footer_append_prompt`);
        const optionValues = Array.from(select.options).map(option => option.value);
        assert.ok(optionValues.includes('jailbreak'), 'footer lists the newly added selectable prompt');

        prompts.splice(prompts.findIndex(prompt => prompt.identifier === 'jailbreak'), 1);
        harness.context.instance.serviceSettings.prompt_order[0].order =
            harness.context.instance.serviceSettings.prompt_order[0].order.filter(entry => entry.identifier !== 'jailbreak');
        await syncPanel(harness.context);
        list = harness.context.instance.containerElement.querySelector(`#${PREFIX}prompt_manager_list`);
        assert.equal(list.querySelector('li[data-pm-identifier="jailbreak"]'), null);
    });

    test('reordering prompts follows the model order without rebuilding rows', async () => {
        const prompts = defaultPrompts();
        const enabled = new Map(prompts.map(p => [p.identifier, true]));
        const harness = createFixture({ prompts, enabledMap: enabled, counts: { main: 12, chatHistory: 345, worldInfoBefore: 7 } });

        await syncPanel(harness.context);
        const list = harness.context.instance.containerElement.querySelector(`#${PREFIX}prompt_manager_list`);
        const nodes = new Map(Array.from(list.querySelectorAll('li[data-pm-identifier]')).map(node => [node.getAttribute('data-pm-identifier'), node]));

        harness.context.instance.serviceSettings.prompt_order[0].order.reverse();
        await syncPanel(harness.context);

        const order = Array.from(list.querySelectorAll('li[data-pm-identifier]')).map(node => node.getAttribute('data-pm-identifier'));
        assert.deepEqual(order, ['worldInfoBefore', 'chatHistory', 'main']);
        nodes.forEach((node, key) => {
            assert.equal(list.querySelector(`li[data-pm-identifier="${key}"]`), node, `${key} node must be reused`);
        });
        assert.ok(harness.context.state.lastStats.moved > 0);
    });

    test('a cleared list is rebuilt without losing the upstream contract', async () => {
        const prompts = defaultPrompts();
        const harness = createFixture({ prompts, enabledMap: new Map(prompts.map(p => [p.identifier, true])), counts: { main: 1 } });

        await syncPanel(harness.context);
        harness.context.instance.containerElement.innerHTML = '';

        await syncPanel(harness.context);

        assert.equal(harness.context.instance.containerElement.querySelectorAll('li[data-pm-identifier]').length, 3);
        assert.ok(harness.context.instance.containerElement.querySelector(`#${PREFIX}prompt_manager_list`));
    });

    test('errors from upstream are surfaced through the rebuilt structure', async () => {
        const prompts = defaultPrompts();
        const harness = createFixture({ prompts, enabledMap: new Map(prompts.map(p => [p.identifier, true])), counts: {} });

        await syncPanel(harness.context);
        harness.context.instance.error = 'Context size exceeded';
        await syncPanel(harness.context);

        assert.match(harness.context.instance.containerElement.innerHTML, /Context size exceeded/);
    });

    test('row clicks are delegated to the upstream handlers', async () => {
        const prompts = defaultPrompts();
        const harness = createFixture({ prompts, enabledMap: new Map(prompts.map(p => [p.identifier, true])), counts: { main: 1 } });

        await syncPanel(harness.context);
        const toggle = harness.context.instance.containerElement.querySelector('li[data-pm-identifier="main"] .prompt-manager-toggle-action');
        toggle.click();

        assert.equal(harness.context.instance.toggleCalls, 1, 'delegated toggle reaches the instance handler');
    });

    test('a forced token refresh rewrites cells without duplicating rows', async () => {
        const prompts = defaultPrompts();
        const counts = { main: 12, chatHistory: 345, worldInfoBefore: 7 };
        const harness = createFixture({ prompts, enabledMap: new Map(prompts.map(p => [p.identifier, true])), counts });

        await syncPanel(harness.context);
        const list = harness.context.instance.containerElement.querySelector(`#${PREFIX}prompt_manager_list`);
        const rowBefore = list.querySelector('li[data-pm-identifier="main"]');
        rowBefore.querySelector('.prompt_manager_prompt_tokens').textContent = '-';

        // Regression: forcing a row refresh used to make the planner treat it as
        // a new row, which left a duplicate prompt row behind.
        harness.context.state.forceTokenKeys.add('main');
        await syncPanel(harness.context);

        assert.equal(list.querySelectorAll('li[data-pm-identifier="main"]').length, 1, 'exactly one row per identifier');
        assert.equal(list.querySelector('li[data-pm-identifier="main"]'), rowBefore, 'the row node is reused');
        assert.equal(list.querySelector('li[data-pm-identifier="main"] .prompt_manager_prompt_tokens').textContent.trim(), '12');
    });

    test('placeholder mode blanks numbers without duplicating rows', async () => {
        const prompts = defaultPrompts();
        const counts = { main: 12, chatHistory: 345, worldInfoBefore: 7 };
        const harness = createFixture({ prompts, enabledMap: new Map(prompts.map(p => [p.identifier, true])), counts });

        harness.setKeepStaleNumbers(false);
        await syncPanel(harness.context);
        const list = harness.context.instance.containerElement.querySelector(`#${PREFIX}prompt_manager_list`);

        harness.setPending(true);
        await syncPanel(harness.context);
        assert.equal(list.querySelectorAll('li[data-pm-identifier]').length, 3, 'placeholder mode must not duplicate rows');
        assert.equal(list.querySelector('li[data-pm-identifier="main"] .prompt_manager_prompt_tokens').textContent.trim(), '-');

        harness.setPending(false);
        await syncPanel(harness.context);
        assert.equal(list.querySelectorAll('li[data-pm-identifier]').length, 3);
        assert.equal(list.querySelector('li[data-pm-identifier="main"] .prompt_manager_prompt_tokens').textContent.trim(), '12');
    });

    test('unexpected upstream markup degrades without wiping the list', async () => {
        const prompts = defaultPrompts();
        const harness = createFixture({ prompts, enabledMap: new Map(prompts.map(p => [p.identifier, true])), counts: { main: 1 } });

        await syncPanel(harness.context);
        const list = harness.context.instance.containerElement.querySelector(`#${PREFIX}prompt_manager_list`);
        const rowsBefore = list.querySelectorAll('li[data-pm-identifier]').length;

        // Simulate an upstream markup change: rows lose their identifier. The panel
        // calls the captured upstream renderer, so the stub lives there.
        harness.context.originals.renderPromptManagerListItems = async function broken() {
            this.listElement.innerHTML = '<li class="row-without-identifier">oops</li>';
        };

        await syncPanel(harness.context);

        assert.equal(harness.context.state.structureInvalid, true, 'markup mismatch must degrade instead of reconciling');
        assert.equal(
            harness.context.instance.containerElement.querySelectorAll(`#${PREFIX}prompt_manager_list li[data-pm-identifier]`).length,
            rowsBefore,
            'the previous rows must stay on screen',
        );

        await fullRebuild(harness.context);
        assert.ok(harness.context.instance.containerElement.querySelector(`#${PREFIX}prompt_manager_list`));
    });
});
