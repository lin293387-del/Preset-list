/**
 * Browser harness for the preset panel: a faithful stand-in for the upstream
 * PromptManager surface the extension patches, rendered in real Chromium.
 *
 * The upstream renderer below mirrors `renderPromptManager` /
 * `renderPromptManagerListItems` from the host (same markup, same four listener
 * lookups per row), because the cost this harness measures is mostly that work.
 */

import { createPanelState, syncPanel } from '../../src/render/panel.js';
import { createDiagnostics } from '../../src/diagnostics.js';
import { createGestureGate } from '../../src/gesture.js';
import { createInputGate } from '../../src/input.js';

const PREFIX = 'completion_';
const ROW_COUNT = Number(new URLSearchParams(location.search).get('rows') ?? 200);

const LIST_HEADER_HTML = `
    <li class="${PREFIX}prompt_manager_list_head"><span>Name</span><span></span><span class="prompt_manager_prompt_tokens">Tokens</span></li>
    <li class="${PREFIX}prompt_manager_list_separator"><hr></li>`;

function headerHtml(total) {
    return `<div class="range-block">
        <div class="${PREFIX}prompt_manager_header">
            <div class="${PREFIX}prompt_manager_header_advanced"><span>Prompts</span></div>
            <div><span>Total Tokens:</span> ${total} </div>
        </div>
        <ul id="${PREFIX}prompt_manager_list" class="text_pole"></ul>
    </div>`;
}

function footerHtml(options) {
    return `<div class="${PREFIX}prompt_manager_footer">
        <select id="${PREFIX}prompt_manager_footer_append_prompt" class="text_pole">${options}</select>
        <a class="menu_button fa-chain fa-solid fa-fw" title="Insert prompt"></a>
        <a class="caution menu_button fa-x fa-solid fa-fw" title="Delete prompt"></a>
        <a class="menu_button fa-plus-square fa-solid fa-fw" title="New prompt"></a>
    </div>`;
}

function rowHtml(prompt, { enabled, tokens }) {
    const disabledClass = enabled ? '' : `${PREFIX}prompt_manager_prompt_disabled`;
    const value = tokens ? tokens : '-';
    return `
    <li class="${PREFIX}prompt_manager_prompt ${PREFIX}prompt_manager_prompt_draggable ${disabledClass}" data-pm-identifier="${prompt.identifier}">
        <span class="drag-handle">☰</span>
        <span class="${PREFIX}prompt_manager_prompt_name" data-pm-name="${prompt.name}">
            <a title="${prompt.name}" class="prompt-manager-inspect-action">${prompt.name}</a>
        </span>
        <span>
            <span class="prompt_manager_prompt_controls">
                <span class="prompt-manager-detach-action caution fa-solid fa-chain-broken fa-xs"></span>
                <span class="prompt-manager-edit-action fa-solid fa-pencil fa-xs"></span>
                <span class="prompt-manager-toggle-action ${enabled ? 'fa-solid fa-toggle-on' : 'fa-solid fa-toggle-off'}"></span>
            </span>
        </span>
        <span class="prompt_manager_prompt_tokens" data-pm-tokens="${value}"><span class="" title=""> </span>${value}</span>
    </li>`;
}

// ---------------------------------------------------------------- fake instance

const prompts = [];
const counts = {};
const enabled = new Map();
for (let index = 0; index < ROW_COUNT; index += 1) {
    const identifier = index < 8 ? ['main', 'nsfw', 'jailbreak', 'worldInfoBefore', 'chatHistory', 'scenario', 'charDescription', 'dialogueExamples'][index] : `p${index}`;
    prompts.push({
        identifier,
        name: `Prompt entry ${String(index).padStart(3, '0')} with a fairly long display name`,
        role: index % 5 === 0 ? 'user' : 'system',
        content: `content ${index}`,
        system_prompt: index < 4,
        marker: index >= 4 && index < 6,
    });
    counts[identifier] = 10 + (index % 400);
    enabled.set(identifier, index % 4 !== 0);
}

const instance = {
    configuration: { prefix: PREFIX, containerIdentifier: 'completion_prompt_manager', sortableDelay: 100 },
    containerElement: document.getElementById('completion_prompt_manager'),
    listElement: null,
    activeCharacter: { id: 100001, name: 'Harness' },
    tokenUsage: 0,
    error: null,
    messages: null,
    overridablePrompts: ['scenario'],
    overriddenPrompts: [],
    serviceSettings: {
        prompts,
        prompt_order: [{
            character_id: 100001,
            order: prompts.map(prompt => ({ identifier: prompt.identifier, enabled: enabled.get(prompt.identifier) })),
        }],
        openai_max_context: 8192,
        openai_max_tokens: 300,
    },
    getPromptOrderForCharacter(character) {
        if (!character) {
            return [];
        }
        return this.serviceSettings.prompt_order.find(list => String(list.character_id) === String(character.id))?.order ?? [];
    },
    getPromptsForCharacter(character) {
        return this.getPromptOrderForCharacter(character).map(entry => this.getPromptById(entry.identifier)).filter(Boolean);
    },
    getPromptById(identifier) {
        return this.serviceSettings.prompts.find(prompt => prompt && prompt.identifier === identifier) ?? null;
    },
    getPromptOrderEntry(character, identifier) {
        return this.getPromptOrderForCharacter(character).find(entry => entry.identifier === identifier) ?? null;
    },
    isPromptDeletionAllowed(prompt) { return prompt.system_prompt !== true; },
    isPromptEditAllowed() { return true; },
    isPromptToggleAllowed() { return true; },
    isPromptInspectionAllowed() { return true; },
    tokenHandler: {
        getCounts: () => counts,
        getTotal: () => Object.values(counts).reduce((total, value) => total + value, 0),
    },
    makeDraggable() {},
    loadMessagesIntoInspectForm() {},
    handleToggle() {},
    handleInspect() {},
    handleEdit() {},
    handleDetach() {},

    async renderPromptManager() {
        const container = this.containerElement;
        container.innerHTML = '';
        container.insertAdjacentHTML('beforeend', headerHtml(this.tokenUsage));
        this.listElement = container.querySelector(`#${PREFIX}prompt_manager_list`);
        const selectable = [...this.serviceSettings.prompts]
            .filter(prompt => prompt && !prompt.system_prompt)
            .sort((left, right) => left.name.localeCompare(right.name));
        const options = selectable.reduce((acc, prompt) => acc + `<option value="${prompt.identifier}">${prompt.name}</option>`, '');
        container.querySelector(`.${PREFIX}prompt_manager_header`).insertAdjacentHTML('afterend', footerHtml(options));
    },

    async renderPromptManagerListItems() {
        const list = this.listElement;
        list.innerHTML = '';
        let html = LIST_HEADER_HTML;
        for (const prompt of this.getPromptsForCharacter(this.activeCharacter)) {
            const entry = this.getPromptOrderEntry(this.activeCharacter, prompt.identifier);
            html += rowHtml(prompt, { enabled: entry.enabled, tokens: counts[prompt.identifier] ?? 0 });
        }
        list.insertAdjacentHTML('beforeend', html);

        // Upstream re-attaches four listeners per row; keeping that here keeps the
        // measured cost honest.
        for (const el of Array.from(list.getElementsByClassName('prompt-manager-detach-action'))) el.addEventListener('click', this.handleDetach);
        for (const el of Array.from(list.getElementsByClassName('prompt-manager-inspect-action'))) el.addEventListener('click', this.handleInspect);
        for (const el of Array.from(list.getElementsByClassName('prompt-manager-edit-action'))) el.addEventListener('click', this.handleEdit);
        for (const el of Array.from(list.querySelectorAll('.prompt-manager-toggle-action'))) el.addEventListener('click', this.handleToggle);
    },
};

const originals = {
    renderPromptManager: instance.renderPromptManager,
    renderPromptManagerListItems: instance.renderPromptManagerListItems,
};

const settingsState = { keepStaleNumbers: true, enabled: true };
let pending = false;
const diagnostics = createDiagnostics();
const context = {
    instance,
    originals,
    state: createPanelState(),
    settings: { get: () => settingsState },
    diagnostics,
    isPending: () => pending,
};

// ------------------------------------------------------------------ public API

const scroller = document.querySelector('.scrollableInner');

let variantName = 'new';

function setVariant(variant) {
    variantName = variant;
    document.body.className = `cv-${variant}`;
}

scroller.addEventListener('scroll', () => markScrolling(), { passive: true });

/**
 * Same gate the runtime uses: while a gesture is held, panel writes are
 * remembered and applied once when it ends. The harness drives the real module so
 * the browser measurement covers the shipped logic, not a paraphrase of it.
 */
let gestureHeld = false;
let scrollHoldTimer = null;
// Mirrors the runtime wiring: the panel is held during a gesture *and* while the
// user is composing or typing, for the same reason and with the same gate.
const inputGate = createInputGate({
    diagnostics,
    onIdle: reason => {
        gate.flush(reason);
    },
});
const gate = createGestureGate({ isHeld: () => gestureHeld || inputGate.isHeld(), diagnostics });
const SCROLL_HOLD_MS = 160;

function markScrolling() {
    gestureHeld = true;
    if (scrollHoldTimer !== null) {
        clearTimeout(scrollHoldTimer);
    }
    scrollHoldTimer = setTimeout(() => {
        scrollHoldTimer = null;
        gestureHeld = false;
        gate.flush('scroll-end');
    }, SCROLL_HOLD_MS);
}

/**
 * A panel sync request, exactly as `runtime.js` issues it: held during a gesture.
 */
function requestSync() {
    let result = null;
    gate.run('harness', () => {
        result = syncPanel(context);
    });
    return result ?? Promise.resolve('deferred');
}

window.__harness = {
    rows: ROW_COUNT,
    sync: () => syncPanel(context),
    requestSync,
    /**
     * A fixed, DOM-heavy workload measured on the page's own clock.
     *
     * The panel scenarios time single one-shot operations, so their absolute
     * values follow the device — thermal state, background load — and move by 60%
     * between sessions on identical code. This number moves with them and not
     * with the extension, which makes `panel / calibration` comparable across
     * sessions. The sink keeps the work observable so a JIT cannot elide it.
     */
    calibrate(rounds = 1200) {
        const started = performance.now();
        let sink = 0;
        for (let index = 0; index < rounds; index += 1) {
            const holder = document.createElement('div');
            holder.innerHTML = `<li class="completion_prompt_manager_prompt" data-pm-identifier="c-${index}">`
                + '<span class="completion_prompt_manager_prompt_name">Calibration row</span>'
                + '<span class="completion_prompt_manager_prompt_tokens" data-pm-tokens="12"><span>12</span></span></li>';
            sink += holder.querySelectorAll('li').length;
            sink += holder.textContent.length & 1;
        }
        return performance.now() - started + sink * 0;
    },
    gateState: () => ({ held: gestureHeld, deferred: gate.isDeferred(), reason: gate.deferredReason() }),

    /**
     * The chat field, as the runtime sees it: composition and keystrokes.
     *
     * These call the same gate the runtime calls, with the same wiring, so the
     * assertions that follow measure the gate rather than a stand-in for it.
     */
    beginComposition: () => { inputGate.beginComposition(); return inputGate.isHeld(); },
    endComposition: () => { inputGate.endComposition(); return inputGate.isHeld(); },
    inputState: () => ({ composing: inputGate.isComposing(), held: inputGate.isHeld(), deferred: gate.isDeferred() }),
    /** A burst of keystrokes; the gate must fold them into one frame. */
    typeKeys(count = 10) {
        for (let index = 0; index < count; index += 1) {
            inputGate.noteInput();
        }
        return inputGate.isHeld();
    },
    /** Waits for the hold to expire the way a user stopping typing would. */
    waitForTypingHold: () => new Promise(resolve => setTimeout(resolve, 200)),
    /** Count DOM mutations the panel makes, so "no writes during a fling" is provable. */
    watchMutations() {
        const list = document.getElementById('completion_prompt_manager_list');
        const scroller = document.querySelector('.scrollableInner');
        window.__mutationLog = { total: 0, duringGesture: 0 };
        const observer = new MutationObserver(records => {
            window.__mutationLog.total += records.length;
            if (gestureHeld) {
                window.__mutationLog.duringGesture += records.length;
            }
        });
        observer.observe(list, { childList: true, subtree: true, characterData: true, attributes: true });
        observer.observe(scroller, { attributes: true });
        window.__mutationObserver = observer;
        return true;
    },
    stopWatchingMutations() {
        window.__mutationObserver?.disconnect();
        return window.__mutationLog ?? { total: 0, duringGesture: 0 };
    },
    get state() {
        return {
            lastPath: context.state.lastPath,
            lastStats: context.state.lastStats,
            structureInvalid: context.state.structureInvalid,
            slices: context.state.lastSlices,
        };
    },
    diagnostics: () => diagnostics.snapshot(),

    /** Token recount finished: every number changed. */
    async recount(factor = 1) {
        for (const key of Object.keys(counts)) {
            counts[key] = Math.max(1, Math.round(counts[key] * 0.9 + (Number(key.replace(/\D/g, '')) || 3) * factor) % 500);
        }
        instance.tokenUsage = Object.values(counts).reduce((total, value) => total + value, 0);
        return requestSync();
    },

    /** Toggle one prompt on/off (single row markup change). */
    async toggleRow(index = 0) {
        const order = instance.serviceSettings.prompt_order[0].order;
        const entry = order[index % order.length];
        entry.enabled = !entry.enabled;
        return requestSync();
    },

    /** Rename one prompt (single row markup change). */
    async renameRow(index = 0, suffix = '') {
        const prompt = prompts[index % prompts.length];
        prompt.name = `Renamed ${suffix} ${prompt.identifier}`;
        return requestSync();
    },

    /** Edit the body of one prompt: no markup change, only the numbers move later. */
    async editBody(index = 0, suffix = '') {
        const prompt = prompts[index % prompts.length];
        prompt.content = `edited body ${suffix}`;
        return requestSync();
    },

    /** Duplicate one prompt (row set change, the helper script's copy action). */
    async duplicateRow(index = 0) {
        const source = prompts[index % prompts.length];
        const copy = { ...source, identifier: `copy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
        prompts.splice(index + 1, 0, copy);
        counts[copy.identifier] = counts[source.identifier] ?? 5;
        instance.serviceSettings.prompt_order[0].order.splice(index + 1, 0, {
            identifier: copy.identifier,
            enabled: instance.serviceSettings.prompt_order[0].order[index]?.enabled ?? true,
        });
        return requestSync();
    },

    /**
     * Adds many prompts in one go (an import, or a character with a long list).
     *
     * The rows for them have to be built at once, which is the case the slicer
     * exists for: the work grows with the list and none of it is urgent.
     */
    async addBulk(count = 100) {
        const order = instance.serviceSettings.prompt_order[0].order;
        const template = prompts.find(prompt => prompt && !prompt.system_prompt) ?? prompts[0];
        for (let i = 0; i < count; i += 1) {
            const copy = { ...template, identifier: `bulk-${Date.now()}-${i}`, name: `Bulk ${i}` };
            prompts.push(copy);
            order.push({ identifier: copy.identifier, enabled: true });
            counts[copy.identifier] = 10 + i;
        }
        return requestSync();
    },

    /** Removes everything `addBulk` added, so a measurement does not change the page for later ones. */
    async removeBulk() {
        const order = instance.serviceSettings.prompt_order[0].order;
        for (let index = prompts.length - 1; index >= 0; index -= 1) {
            const prompt = prompts[index];
            if (!prompt || !String(prompt.identifier).startsWith('bulk-')) {
                continue;
            }
            prompts.splice(index, 1);
            delete counts[prompt.identifier];
            const at = order.findIndex(entry => entry.identifier === prompt.identifier);
            if (at >= 0) {
                order.splice(at, 1);
            }
        }
        return requestSync();
    },

    /** Delete one prompt (row set change, the helper script's delete action). */
    async deleteRow(index = 0) {
        const target = prompts[index % prompts.length];
        const at = prompts.indexOf(target);
        prompts.splice(at, 1);
        delete counts[target.identifier];
        const order = instance.serviceSettings.prompt_order[0].order;
        order.splice(order.findIndex(entry => entry.identifier === target.identifier), 1);
        return requestSync();
    },

    /** Simulate a prompt-assembly preview being pending / finished. */
    setPending(value) {
        pending = Boolean(value);
    },

    /** The footer select as it is on screen: whatever upstream last put in it. */
    selectOptions: () => Array.from(document.querySelectorAll('#completion_prompt_manager_footer_append_prompt option'))
        .map(option => `${option.value}\u0000${option.textContent}`),
    /** What the prompt model says the footer select should contain. */
    selectableOptions: () => [...instance.serviceSettings.prompts]
        .filter(prompt => prompt && !prompt.system_prompt)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(prompt => `${prompt.identifier}\u0000${prompt.name}`),

    rowCount: () => document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]').length,
    setVariant,
    variant: () => variantName,
    rowHeight: () => {
        const row = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier]');
        return row ? row.getBoundingClientRect().height : 0;
    },
    publishedRowHeight: () => getComputedStyle(document.getElementById('completion_prompt_manager_list'))
        .getPropertyValue('--tt-to-row-height').trim(),

    /** Reset the scroll position for the next measurement. */
    scrollTo: value => { scroller.scrollTop = value; },
    scrollHeight: () => scroller.scrollHeight,
    scrollTop: () => scroller.scrollTop,
    clientHeight: () => scroller.clientHeight,
};

// First paint, then tell the driver we are ready.
await syncPanel(context);
setVariant('new');
window.__harnessReady = true;
