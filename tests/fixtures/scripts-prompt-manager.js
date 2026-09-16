// @ts-check
/**
 * Test double for the upstream `/scripts/PromptManager.js` module.
 *
 * It renders the same markup upstream does (through the shared builders) so the
 * runtime smoke test exercises the real reconciliation path.
 */

import { LIST_HEADER_HTML, footerHtml, headerHtml, rowHtml } from './upstream-panel-markup.js';

export class PromptManager {
    constructor() {
        this.configuration = {
            prefix: 'completion_',
            containerIdentifier: 'completion_prompt_manager',
            promptOrder: { strategy: 'global', dummyId: 100001 },
        };
        this.containerElement = null;
        this.listElement = null;
        this.activeCharacter = { id: 100001 };
        this.serviceSettings = {
            prompts: [],
            prompt_order: [],
            openai_max_context: 8192,
            openai_max_tokens: 300,
        };
        this.tokenHandler = null;
        this.tokenUsage = 0;
        this.error = null;
        this.messages = null;
        this.renderDebounced = () => {
            this.renderDebouncedCalls = (this.renderDebouncedCalls ?? 0) + 1;
        };
        this.renderDryRunLatest = () => {
            this.dryRunLatestCalls = (this.dryRunLatestCalls ?? 0) + 1;
        };
        this.handleToggle = event => {
            const row = event.target.closest('.completion_prompt_manager_prompt');
            const entry = this.getPromptOrderEntry(this.activeCharacter, row.dataset.pmIdentifier);
            entry.enabled = !entry.enabled;
            this.handleToggleCalls = (this.handleToggleCalls ?? 0) + 1;
            this.renderDebounced();
        };
        this.handleInspect = () => {
            this.handleInspectCalls = (this.handleInspectCalls ?? 0) + 1;
        };
        this.handleEdit = () => {};
        this.handleDetach = () => {};
        this.tryGenerate = async () => {
            this.tryGenerateCalls = (this.tryGenerateCalls ?? 0) + 1;
            this.setChatCompletion({ getMessages: () => ({}) });
        };
        this.saveServiceSettings = async () => {};
    }

    init() {
        this.initCalls = (this.initCalls ?? 0) + 1;
    }

    render() {
        this.renderCalls = (this.renderCalls ?? 0) + 1;
    }

    renderNowAndRefresh() {
        this.renderNowAndRefreshCalls = (this.renderNowAndRefreshCalls ?? 0) + 1;
    }

    async renderPromptManager() {
        const container = this.containerElement;
        container.innerHTML = '';
        container.insertAdjacentHTML('beforeend', headerHtml({ error: this.error, total: this.tokenUsage }));
        this.listElement = container.querySelector('#completion_prompt_manager_list');
        if (this.activeCharacter === null) {
            return;
        }
        const selectable = [...this.serviceSettings.prompts]
            .filter(prompt => prompt && !prompt.system_prompt)
            .sort((left, right) => left.name.localeCompare(right.name));
        const promptsHtml = selectable.reduce((acc, prompt) => acc + `<option value="${prompt.identifier}">${prompt.name}</option>`, '');
        const header = container.querySelector('.completion_prompt_manager_header');
        header.insertAdjacentHTML('afterend', footerHtml(promptsHtml));
    }

    async renderPromptManagerListItems() {
        const list = this.listElement;
        list.innerHTML = '';
        const counts = this.tokenHandler?.getCounts?.() ?? {};
        let html = LIST_HEADER_HTML;
        for (const prompt of this.getPromptsForCharacter(this.activeCharacter)) {
            if (!prompt) {
                continue;
            }
            const entry = this.getPromptOrderEntry(this.activeCharacter, prompt.identifier);
            html += rowHtml(prompt, { enabled: Boolean(entry?.enabled), tokens: counts[prompt.identifier] ?? 0 });
        }
        list.insertAdjacentHTML('beforeend', html);
    }

    makeDraggable() {
        this.makeDraggableCalls = (this.makeDraggableCalls ?? 0) + 1;
    }

    setChatCompletion() {
        this.setChatCompletionCalls = (this.setChatCompletionCalls ?? 0) + 1;
    }

    getPromptOrderForCharacter(character) {
        return character
            ? (this.serviceSettings.prompt_order.find(list => String(list.character_id) === String(character.id))?.order ?? [])
            : [];
    }

    getPromptsForCharacter(character, onlyEnabled = false) {
        return this.getPromptOrderForCharacter(character)
            .map(entry => (onlyEnabled && !entry.enabled ? null : this.getPromptById(entry.identifier)))
            .filter(prompt => prompt !== null);
    }

    getPromptById(identifier) {
        return this.serviceSettings.prompts.find(prompt => prompt && prompt.identifier === identifier) ?? null;
    }

    getPromptOrderEntry(character, identifier) {
        return this.getPromptOrderForCharacter(character).find(entry => entry.identifier === identifier) ?? null;
    }

    loadMessagesIntoInspectForm() {
        this.inspectRenders = (this.inspectRenders ?? 0) + 1;
    }
}
