// @ts-check
/**
 * Preset Lite — TauriTavern third-party extension entry point.
 *
 * The extension takes over the chat-completion preset/prompt panel at runtime:
 * rows are reconciled instead of rebuilt, token recounts move out of the
 * interaction path, and the preset-apply event storm is coalesced. No
 * application file is modified, and every patched path delegates back to
 * upstream while the extension is switched off.
 */

import { createSettings } from './src/config.js';
import { VERSION } from './src/version.js';
import { createDiagnostics } from './src/diagnostics.js';
import { getContext, resolveExtensionIdentity, waitForAppReady } from './src/host.js';
import { createRuntime } from './src/runtime.js';
import { createSettingsPanel } from './src/ui/settings-panel.js';

let booted = false;

/**
 * Extension hook referenced from `manifest.json` (`hooks.activate`).
 *
 * @returns {Promise<void>}
 */
export async function init() {
    if (booted) {
        return;
    }
    booted = true;

    /** @type {ReturnType<typeof createRuntime> | null} */
    let runtime = null;
    /** @type {ReturnType<typeof createSettingsPanel> | null} */
    let panel = null;

    try {
        const identity = resolveExtensionIdentity(import.meta.url);
        await waitForAppReady();

        const context = getContext();
        const settings = createSettings(context);
        const diagnostics = createDiagnostics({ isVerbose: () => settings.get().diagnostics });

        runtime = createRuntime({
            context,
            settings,
            diagnostics,
            identity,
            hooks: {
                onStop() {
                    panel?.unmount();
                },
            },
        });
        panel = createSettingsPanel({ context, settings, runtime, diagnostics, identity });

        runtime.start();
        await panel.mount();

        const activeRuntime = runtime;

        globalThis.__PRESET_LITE__ = {
            version: VERSION,
            folder: identity.folder,
            get enabled() {
                return settings.get().enabled;
            },
            enable(value) {
                activeRuntime.setEnabled(value);
            },
            snapshot: () => activeRuntime.snapshot(),
            clearCache: () => activeRuntime.clearCache(),
            recountNow: reason => activeRuntime.recountNow(String(reason ?? 'manual')),
            stop: () => activeRuntime.stop(),
        };

        diagnostics.info(`Preset Lite ready (${identity.name})`);
    } catch (error) {
        booted = false;
        try {
            runtime?.stop();
        } catch (stopError) {
            console.error('[Preset Lite] Cleanup after a failed start also failed:', stopError);
        }
        console.error('[Preset Lite] Initialization failed; the panel keeps stock behaviour:', error);
        throw error;
    }
}

/** Allows a manual re-activation from the console after a failed boot. */
globalThis.__PRESET_LITE_RETRY__ = () => init();
