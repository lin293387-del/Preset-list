/** Minimal ambient contract for the upstream extension/page module. */

export type PageContext = {
    mainApi?: string;
    chat?: unknown[];
    extensionSettings?: Record<string, any>;
    eventSource: {
        on(event: string, listener: (...args: any[]) => unknown): void;
        once(event: string, listener: (...args: any[]) => unknown): void;
        removeListener(event: string, listener: (...args: any[]) => unknown): void;
    };
    eventTypes: Record<string, string>;
    saveSettingsDebounced?: () => void;
    renderExtensionTemplateAsync?: (extensionName: string, templateId: string, data?: unknown) => Promise<string>;
    jQuery?: any;
    [key: string]: any;
};

export function getContext(): PageContext;
