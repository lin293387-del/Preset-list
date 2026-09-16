// @ts-check
/**
 * Extension settings panel.
 *
 * Owns the settings drawer block and the live status line. All values come from
 * (and go to) the shared extension settings object, so the panel never holds a
 * second copy of the user's configuration.
 */

const ID = 'preset-lite-settings';
const STATUS_INTERVAL_MS = 1000;
const NOTICE_MS = 4000;

const CONTROLS = Object.freeze({
    enabled: 'preset_lite_enabled',
    hudPassthrough: 'preset_lite_hud_passthrough',
    keepStaleNumbers: 'preset_lite_keep_stale',
    coalescePresetEvents: 'preset_lite_coalesce',
    reportPresetConflicts: 'preset_lite_report_conflicts',
    persistentTokenCache: 'preset_lite_persist_cache',
});

const NUMBER_CONTROLS = Object.freeze({
    idleDelayMs: 'preset_lite_idle_delay',
    tokenCacheLimit: 'preset_lite_cache_limit',
});

const CHECKBOX_KEYS = Object.freeze(Object.keys(CONTROLS));

/**
 * Phases of a preset switch, in the order the user experiences them. `numbers`
 * is the one that answers "how long until the panel is right again"; the others
 * are the last measured values of work that happens on every interaction.
 */
const TIMING_SPANS = Object.freeze([
    ['presetApply', 'apply'],
    ['presetReplay', 'replay'],
    ['panelSync', 'panel'],
    ['recount', 'recount'],
    ['tokenCount', 'token api'],
    ['numbersAfterSwitch', 'numbers'],
]);

/**
 * @param {object} options
 * @param {any} options.context Page context.
 * @param {{ get: () => any, update: (patch: object) => void, subscribe: (listener: () => void) => () => void }} options.settings
 * @param {object} options.runtime
 * @param {{ info: Function, warn: Function, error: Function }} options.diagnostics
 * @param {{ name: string }} options.identity
 */
export function createSettingsPanel({ context, settings, runtime, diagnostics, identity }) {
    let element = null;
    /** @type {(() => void) | null} */
    let unsubscribeSettings = null;
    let statusTimer = null;
    let noticeTimer = null;
    let notice = '';

    /**
     * @param {string} id
     * @returns {HTMLInputElement | null}
     */
    function input(id) {
        const node = document.getElementById(id);
        return node instanceof HTMLInputElement ? node : null;
    }

    function syncControlsFromSettings() {
        const current = settings.get();
        for (const key of CHECKBOX_KEYS) {
            const control = input(CONTROLS[key]);
            if (control) {
                control.checked = Boolean(current[key]);
            }
        }
        for (const [key, id] of Object.entries(NUMBER_CONTROLS)) {
            const control = input(id);
            if (control) {
                control.value = String(current[key]);
            }
        }
    }

    /**
     * Shows a short-lived line above the routine status.
     *
     * @param {string} text
     */
    function notify(text) {
        notice = text;
        if (noticeTimer !== null) {
            clearTimeout(noticeTimer);
        }
        noticeTimer = setTimeout(() => {
            noticeTimer = null;
            notice = '';
            refreshStatus();
        }, NOTICE_MS);
        refreshStatus();
    }

    function refreshStatus() {
        const snapshot = runtime.snapshot();
        const cache = snapshot.cache ?? {};
        const scheduler = snapshot.scheduler ?? {};
        const lines = [];
        if (notice) {
            lines.push(notice);
        }
        lines.push(
            `state: ${snapshot.enabled ? 'enabled' : 'disabled'}${snapshot.structureInvalid ? ' (degraded: upstream markup changed, using stock rendering)' : ''}`,
            `cache: ${cache.size ?? 0} entries, ${cache.hits ?? 0} hits / ${cache.misses ?? 0} misses, backend ${cache.backend ?? 'unknown'}`,
            `last panel sync: ${formatStats(snapshot.panel)}`,
            `pending recount: ${scheduler.dirty || scheduler.running ? 'yes' : 'no'}${scheduler.lastRun ? ` (last finished ${new Date(scheduler.lastRun).toLocaleTimeString()})` : ''}`,
        );
        const timing = formatTiming(snapshot.metrics?.spans ?? {});
        if (timing) {
            lines.push(timing);
        }
        const degraded = snapshot.diagnostics?.degradations ?? [];
        if (degraded.length > 0) {
            lines.push(`degraded: ${degraded.map(entry => entry.feature).join(', ')}`);
        }
        const conflicts = snapshot.diagnostics?.conflicts ?? [];
        if (conflicts.length > 0) {
            const last = conflicts[conflicts.length - 1];
            lines.push(`last preset conflict: ${last.selector} ${last.before} -> ${last.after}`);
        }
        setStatus(lines.join('\n'));
    }

    /**
     * @param {string} text
     */
    function setStatus(text) {
        const node = document.getElementById('preset_lite_status');
        if (node) {
            node.textContent = text;
        }
    }

    /**
     * Renders the measured phases of the last preset switch, skipping phases that
     * have not happened yet.
     *
     * @param {Record<string, { lastMs?: number }>} spans
     * @returns {string}
     */
    function formatTiming(spans) {
        const parts = [];
        for (const [label, text] of TIMING_SPANS) {
            const lastMs = spans?.[label]?.lastMs;
            if (typeof lastMs !== 'number' || !Number.isFinite(lastMs)) {
                continue;
            }
            parts.push(`${text} ${Math.round(lastMs)}ms`);
        }
        return parts.length > 0 ? `timing: ${parts.join(' · ')}` : '';
    }

    /**
     * @param {object | null} stats
     * @returns {string}
     */
    function formatStats(stats) {
        if (!stats) {
            return 'not rendered yet';
        }
        return `created=${stats.created} updated=${stats.updated} tokens=${stats.tokens} removed=${stats.removed} moved=${stats.moved}`;
    }

    function wireControls() {
        for (const [key, id] of Object.entries(CONTROLS)) {
            const control = input(id);
            if (!control) {
                continue;
            }
            control.addEventListener('change', () => {
                settings.update({ [key]: control.checked });
                refreshStatus();
            });
        }

        for (const [key, id] of Object.entries(NUMBER_CONTROLS)) {
            const control = input(id);
            if (!control) {
                continue;
            }
            control.addEventListener('change', () => {
                settings.update({ [key]: control.value });
                syncControlsFromSettings();
                refreshStatus();
            });
        }

        document.getElementById('preset_lite_clear_cache')?.addEventListener('click', async () => {
            await runtime.clearCache();
            notify('token cache cleared');
        });
    }

    return {
        /** @returns {Promise<boolean>} */
        async mount() {
            if (element) {
                return true;
            }
            const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
            if (!host) {
                diagnostics.warn('No extension settings container found; settings panel not mounted');
                return false;
            }

            const html = await context.renderExtensionTemplateAsync(identity.name, 'settings');
            host.insertAdjacentHTML('beforeend', html);

            element = document.getElementById(ID);
            if (!element) {
                diagnostics.warn('Settings template did not produce #preset-lite-settings');
                return false;
            }

            syncControlsFromSettings();
            wireControls();
            unsubscribeSettings = settings.subscribe(() => {
                syncControlsFromSettings();
                refreshStatus();
            });
            refreshStatus();
            statusTimer = setInterval(refreshStatus, STATUS_INTERVAL_MS);
            return true;
        },
        unmount() {
            unsubscribeSettings?.();
            unsubscribeSettings = null;
            if (statusTimer !== null) {
                clearInterval(statusTimer);
                statusTimer = null;
            }
            if (noticeTimer !== null) {
                clearTimeout(noticeTimer);
                noticeTimer = null;
            }
            notice = '';
            element?.remove();
            element = null;
        },
        refreshStatus,
        notify,
    };
}
