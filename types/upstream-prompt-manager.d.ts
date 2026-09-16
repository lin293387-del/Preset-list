/**
 * Minimal ambient contract for the upstream `PromptManager` module.
 *
 * TauriTavern does not publish types for its frontend modules, so the extension
 * declares exactly the surface it relies on. Member names are therefore checked
 * at build time while unknown values stay `any` on purpose.
 */

export type PromptRecord = {
    identifier: string;
    name: string;
    system_prompt?: boolean;
    marker?: boolean;
    [key: string]: unknown;
};

export type PromptOrderEntry = {
    identifier: string;
    enabled: boolean;
    [key: string]: unknown;
};

export type TokenHandlerLike = {
    countTokenAsyncFn?: ((messages: unknown, full?: boolean, settings?: unknown) => Promise<number>) | null;
    getCounts(): Record<string, number | null>;
    [key: string]: unknown;
};

export type MessageCollectionLike = {
    hasItemWithIdentifier?: (identifier: string) => boolean;
    getItemByIdentifier?: (identifier: string) => unknown;
    [key: string]: unknown;
};

export type PromptManagerConfiguration = {
    prefix?: string;
    containerIdentifier?: string;
    listIdentifier?: string;
    promptOrder?: { strategy?: string; dummyId?: number; [key: string]: unknown };
    [key: string]: unknown;
};

export type ChatCompletionSettingsLike = {
    prompts?: PromptRecord[];
    prompt_order?: Array<{ character_id?: unknown; order?: PromptOrderEntry[] }>;
    openai_max_context?: number;
    openai_max_tokens?: number;
    [key: string]: unknown;
};

export declare class PromptManager {
    configuration: PromptManagerConfiguration;
    containerElement: HTMLElement;
    listElement: HTMLElement | null;
    activeCharacter: { id?: unknown; name?: string } | null;
    serviceSettings: ChatCompletionSettingsLike;
    tokenHandler: TokenHandlerLike | null;
    tokenUsage: number;
    error: string | null;
    messages: MessageCollectionLike | null;
    renderDebounced: () => void;
    renderDryRunLatest: () => void;
    handleToggle: (event: Event) => unknown;
    handleInspect: (event: Event) => unknown;
    handleEdit: (event: Event) => unknown;
    handleDetach: (event: Event) => unknown;
    saveServiceSettings: () => Promise<unknown>;
    tryGenerate: () => Promise<unknown>;
    init(moduleConfiguration?: unknown, serviceSettings?: unknown): void;
    render(afterTryGenerate?: boolean): void;
    renderNowAndRefresh(): void;
    renderPromptManager(generation?: number): Promise<void>;
    renderPromptManagerListItems(generation?: number): Promise<void>;
    makeDraggable(): void;
    setChatCompletion(chatCompletion: unknown): void;
    getPromptsForCharacter(character: unknown, onlyEnabled?: boolean): PromptRecord[];
    getPromptOrderForCharacter(character: unknown): PromptOrderEntry[];
    getPromptOrderEntry(character: unknown, identifier: string): PromptOrderEntry | null;
    getPromptById(identifier: string): PromptRecord | null;
    loadMessagesIntoInspectForm(messages: unknown): void;
    log(output: string): void;
}
