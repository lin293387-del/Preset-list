// @ts-check
/**
 * Shared markup builders used by the DOM-facing tests.
 *
 * They are faithful copies of the upstream templates that the extension diffs
 * against (`promptManagerHeader.html`, `promptManagerListHeader.html`,
 * `promptManagerFooter.html` and the row template in
 * `PromptManager.renderPromptManagerListItems`). Keeping them in one place means
 * the render integration test and the runtime smoke test cannot drift apart.
 */

export const PREFIX = 'completion_';

/**
 * @param {{ error?: string | null, total?: number }} options
 * @returns {string}
 */
export function headerHtml({ error = null, total = 0 } = {}) {
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
export const LIST_HEADER_HTML = `
<li class="${PREFIX}prompt_manager_list_head"><span data-i18n="Name">Name</span><span></span><span class="prompt_manager_prompt_tokens" data-i18n="Tokens;prompt_manager_tokens">Tokens</span></li>
<li class="${PREFIX}prompt_manager_list_separator"><hr></li>`;

/**
 * @param {string} promptsHtml
 * @returns {string}
 */
export function footerHtml(promptsHtml) {
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

/**
 * @param {{ identifier: string, name: string }} prompt
 * @param {{ enabled: boolean, tokens: number | string, warningClass?: string, warningTitle?: string }} state
 * @returns {string}
 */
export function rowHtml(prompt, { enabled, tokens, warningClass = '', warningTitle = '' }) {
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

/**
 * @returns {Array<{ identifier: string, name: string, role?: string, content?: string, marker?: boolean }>}
 */
export function defaultPrompts() {
    return [
        { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'main' },
        { identifier: 'chatHistory', name: 'Chat History', marker: true },
        { identifier: 'worldInfoBefore', name: 'World Info (↑Char)', marker: true },
    ];
}
