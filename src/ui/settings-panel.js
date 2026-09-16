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
 * Phases of a preset switch, in the order the user experiences them. `apply` and
 * `replay` are rendered with their detail; `numbers` is the one that answers
 * "how long until the panel is right again"; the rest are the last measured
 * values of work that happens on every interaction.
 */
const TIMING_SPANS = Object.freeze([
    ['panelSync', 'panel'],
    ['recount', 'recount'],
    ['tokenCount', 'token api'],
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
        const timing = formatTiming(snapshot.metrics?.spans ?? {}, snapshot.presetWindow ?? {});
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
     * have not happened yet. The apply phase is split into the field loop and the
     * chain that follows it, and the replay reports how many fields the preset did
     * not move (and how many redundant `change` triggers were dropped).
     *
     * @param {Record<string, { lastMs?: number }>} spans
     * @param {{ lastUnchanged?: number, lastRedundantChanges?: number }} window
     * @returns {string}
     */
    function formatTiming(spans, window) {
        /**
         * @param {string} label
         * @returns {number | null}
         */
        function lastMs(label) {
            const value = spans?.[label]?.lastMs;
            return typeof value === 'number' && Number.isFinite(value) ? value : null;
        }

        const parts = [];
        const apply = lastMs('presetApply');
        if (apply !== null) {
            const fields = lastMs('presetApplyFields');
            const chain = lastMs('presetApplyChain');
            const detail = fields !== null && chain !== null
                ? ` [fields ${Math.round(fields)} · chain ${Math.round(chain)}]`
                : '';
            parts.push(`apply ${Math.round(apply)}ms${detail}`);
        }
        const replay = lastMs('presetReplay');
        if (replay !== null) {
            const notes = [];
            if (Number(window?.lastUnchanged) > 0) {
                notes.push(`${window.lastUnchanged} unchanged`);
            }
            if (Number(window?.lastRedundantChanges) > 0) {
                notes.push(`${window.lastRedundantChanges} redundant change`);
            }
            const detail = notes.length > 0 ? ` [${notes.join(' · ')}]` : '';
            parts.push(`replay ${Math.round(replay)}ms${detail}`);
        }
        for (const [label, text] of TIMING_SPANS) {
            const value = lastMs(label);
            if (value === null) {
                continue;
            }
            parts.push(`${text} ${Math.round(value)}ms`);
        }
        const numbers = lastMs('numbersAfterSwitch');
        if (numbers !== null) {
            const wait = lastMs('presetRecountWait');
            const detail = wait !== null ? ` [wait ${Math.round(wait)}ms]` : '';
            parts.push(`numbers ${Math.round(numbers)}ms${detail}`);
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
