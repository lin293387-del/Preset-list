// @ts-check
/**
 * Extension settings panel.
 *
 * Owns the settings drawer block, the live status line and the benchmark report.
 * All values come from (and go to) the shared extension settings object, so the
 * panel never holds a second copy of the user's configuration.
 */

const ID = 'preset-lite-settings';
const STATUS_INTERVAL_MS = 1000;

const CONTROLS = Object.freeze({
    enabled: 'preset_lite_enabled',
    hudPassthrough: 'preset_lite_hud_passthrough',
    keepStaleNumbers: 'preset_lite_keep_stale',
    coalescePresetEvents: 'preset_lite_coalesce',
    reportPresetConflicts: 'preset_lite_report_conflicts',
    persistentTokenCache: 'preset_lite_persist_cache',
    diagnostics: 'preset_lite_diagnostics',
});

const NUMBER_CONTROLS = Object.freeze({
    idleDelayMs: 'preset_lite_idle_delay',
    tokenCacheLimit: 'preset_lite_cache_limit',
});

const CHECKBOX_KEYS = Object.freeze(Object.keys(CONTROLS));

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
    let lastReport = null;

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
     * Routine snapshot; refreshed on a timer, so transient messages never go here.
     *
     * @param {string} text
     */
    function setStatus(text) {
        const node = document.getElementById('preset_lite_status');
        if (node) {
            node.textContent = text;
        }
    }

    /**
     * Sticky action feedback: benchmark progress, failures and confirmations.
     * Appends with a timestamp so a failed run cannot flash by unnoticed.
     *
     * @param {string} text
     */
    function pushBenchMessage(text) {
        const node = document.getElementById('preset_lite_bench');
        if (!node) {
            return;
        }
        const stamp = new Date().toLocaleTimeString();
        const line = `[${stamp}] ${text}`;
        node.textContent = node.textContent ? `${node.textContent}\n${line}` : line;
        node.scrollTop = node.scrollHeight;
    }

    function setBenchBusy(busy) {
        const button = document.getElementById('preset_lite_run_bench');
        button?.classList.toggle('tt-pl-busy', busy);
        if (button instanceof HTMLElement) {
            button.setAttribute('aria-busy', busy ? 'true' : 'false');
        }
    }

    function renderReport(report) {
        const node = document.getElementById('preset_lite_report');
        if (node) {
            node.textContent = formatReport(report);
        }
    }

    function refreshStatus() {
        const snapshot = runtime.snapshot();
        const cache = snapshot.cache ?? {};
        const lines = [
            `state: ${snapshot.enabled ? 'enabled' : 'disabled'}${snapshot.structureInvalid ? ' (degraded: upstream markup changed, using stock rendering)' : ''}`,
            `cache: ${cache.size ?? 0} entries, ${cache.hits ?? 0} hits / ${cache.misses ?? 0} misses, backend ${cache.backend ?? 'unknown'}`,
            `last panel sync: ${formatStats(snapshot.panel)}`,
            `pending recount: ${snapshot.scheduler?.dirty || snapshot.scheduler?.running ? 'yes' : 'no'}`,
        ];
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
     * @param {object} report
     * @returns {string}
     */
    function formatReport(report) {
        const lines = [];
        const environment = report.environment ?? {};
        lines.push(`Preset Lite benchmark ${new Date(report.startedAt ?? Date.now()).toISOString()}`);
        lines.push(`environment: rows=${environment.promptRows} prompts=${environment.prompts} chat=${environment.chatLength} preset="${environment.preset}" cores=${environment.hardwareConcurrency ?? '-'}`);
        lines.push('');
        lines.push('phase          mode       dur(ms)  frames p95/max   longTasks count/max/block   notes');

        for (const phase of report.phases ?? []) {
            const frames = phase.sampling?.frames ?? {};
            const longTasks = phase.sampling?.longTasks ?? {};
            const notes = phase.error
                ? `error: ${phase.error}`
                : Object.entries(phase.details ?? {})
                    .filter(([key]) => key !== 'scheduler')
                    .map(([key, value]) => `${key}=${value}`)
                    .join(' ');
            lines.push([
                String(phase.name).padEnd(14),
                String(phase.mode).padEnd(10),
                String(Math.round(phase.durationMs ?? 0)).padStart(7),
                `${formatNumber(frames.p95Ms)}/${formatNumber(frames.maxMs)}`.padStart(16),
                `${longTasks.count ?? 0}/${formatNumber(longTasks.maxMs)}/${formatNumber(longTasks.blockingMs)}`.padStart(28),
                notes,
            ].join(' '));
        }

        const comparison = report.comparison;
        if (comparison) {
            lines.push('');
            lines.push(`baseline : longTasks=${comparison.baseline.longTasks} frameP95=${formatNumber(comparison.baseline.frameP95Ms)}ms frameMax=${formatNumber(comparison.baseline.frameMaxMs)}ms recounts=${comparison.baseline.recounts}`);
            lines.push(`optimized: longTasks=${comparison.optimized.longTasks} frameP95=${formatNumber(comparison.optimized.frameP95Ms)}ms frameMax=${formatNumber(comparison.optimized.frameMaxMs)}ms recounts=${comparison.optimized.recounts}`);
            lines.push(`delta    : longTasks=${comparison.delta.longTasks} frameP95=${formatNumber(comparison.delta.frameP95Ms)}ms`);
        }

        return lines.join('\n');
    }

    function formatNumber(value) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric.toFixed(1) : '-';
    }

    function formatStats(stats) {
        if (!stats) {
            return 'not rendered yet';
        }
        return `created=${stats.created} updated=${stats.updated} tokens=${stats.tokens} removed=${stats.removed} moved=${stats.moved}`;
    }

    async function copyText(text) {
        try {
            if (globalThis.navigator?.clipboard?.writeText) {
                await globalThis.navigator.clipboard.writeText(text);
                return true;
            }
        } catch (error) {
            diagnostics.warn('Clipboard write failed:', error);
        }
        try {
            const area = document.createElement('textarea');
            area.value = text;
            area.setAttribute('readonly', 'true');
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand?.('copy');
            area.remove();
            return Boolean(ok);
        } catch {
            return false;
        }
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

        document.getElementById('preset_lite_run_bench')?.addEventListener('click', async () => {
            if (runtime.bench.isRunning()) {
                pushBenchMessage('benchmark already running');
                return;
            }

            pushBenchMessage('benchmark started — keep the AI Response Configuration panel open and do not interact with the device');
            setBenchBusy(true);
            try {
                lastReport = await runtime.bench.run({
                    onProgress: ({ message }) => {
                        pushBenchMessage(message);
                        // Also visible in DevTools, so a run can be watched from there.
                        console.log(`[Preset Lite][benchmark] ${message}`);
                    },
                });
                renderReport(lastReport);
                const phases = lastReport.phases?.length ?? 0;
                pushBenchMessage(`benchmark finished (${phases} phases). The report below can be copied.`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                diagnostics.warn('Benchmark failed:', error);
                pushBenchMessage(`benchmark failed: ${message}`);
            } finally {
                setBenchBusy(false);
            }
            refreshStatus();
        });

        document.getElementById('preset_lite_clear_cache')?.addEventListener('click', async () => {
            await runtime.clearCache();
            pushBenchMessage('token cache cleared');
            refreshStatus();
        });

        document.getElementById('preset_lite_copy_report')?.addEventListener('click', async () => {
            const payload = lastReport
                ? JSON.stringify({ report: lastReport, snapshot: runtime.snapshot() }, null, 2)
                : JSON.stringify({ snapshot: runtime.snapshot() }, null, 2);
            const copied = await copyText(payload);
            pushBenchMessage(copied ? 'report copied to clipboard' : 'copy failed, see console');
            if (!copied) {
                console.log('[Preset Lite] report', payload);
            }
        });

        document.getElementById('preset_lite_enable_hud')?.addEventListener('click', () => {
            setHudEnabled(!isHudEnabled());
        });
    }

    /** @returns {boolean} Whether the host perf HUD was requested for this install. */
    function isHudEnabled() {
        try {
            return globalThis.localStorage?.getItem('tt:perf') === '1';
        } catch {
            return false;
        }
    }

    function refreshHudButton() {
        const button = document.getElementById('preset_lite_enable_hud');
        if (!button) {
            return;
        }
        const forced = typeof globalThis.__TAURITAVERN_PERF_ENABLED__ === 'boolean';
        const on = forced || isHudEnabled();
        button.textContent = on ? 'Disable perf HUD' : 'Enable perf HUD';
        button.setAttribute('data-i18n', on ? 'Disable perf HUD' : 'Enable perf HUD');
        button.title = forced
            ? 'The perf HUD is forced on by the runtime flag of this build'
            : (on ? 'Turn the perf HUD off (restart required)' : 'Turn the perf HUD on (restart required)');
    }

    /**
     * @param {boolean} enable
     */
    function setHudEnabled(enable) {
        if (typeof globalThis.__TAURITAVERN_PERF_ENABLED__ === 'boolean') {
            pushBenchMessage('the perf HUD is forced on by the runtime flag of this build');
            return;
        }
        try {
            globalThis.localStorage?.setItem('tt:perf', enable ? '1' : '0');
        } catch (error) {
            diagnostics.warn('Could not write the perf HUD flag:', error);
            pushBenchMessage('could not write the perf HUD flag');
            return;
        }

        if (!enable) {
            // The flag only affects the next start, so hide the live HUD too.
            try {
                globalThis.__TAURITAVERN_PERF__?.disable?.();
            } catch (error) {
                diagnostics.warn('Could not hide the live perf HUD:', error);
            }
        }

        refreshHudButton();
        pushBenchMessage(enable
            ? 'perf HUD enabled; restart the app (Ctrl+Alt+P toggles it live)'
            : 'perf HUD disabled; it stays hidden after the next restart');
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
            refreshHudButton();
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
            element?.remove();
            element = null;
        },
        refreshStatus,
        getLastReport: () => lastReport,
    };
}
