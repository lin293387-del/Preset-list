/** Minimal ambient contract for the upstream chat-completion module. */

import type { PromptManager } from './upstream-prompt-manager';

/** Live binding: null until the chat-completion module is initialised. */
export let promptManager: PromptManager | null;
