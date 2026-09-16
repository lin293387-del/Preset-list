// @ts-check
/**
 * Built-in A/B benchmark.
 *
 * It drives the real UI paths (row clicks, preset selection, scrolling) with the
 * extension disabled and enabled, so the reported numbers compare upstream
 * behaviour against the extension on the *same* device, chat and preset.
 */

import { summarize } from './metrics.js';

const DEFAULTS = Object.freeze({
    /** Number of prompt toggles per phase. */
    toggles: 60,
    /** Delay between toggles, in ms. */
    toggleIntervalMs: 120,
    /** Number of preset switches per phase. */
    presets: 6,
    /** Delay between preset switches, in ms. */
    presetIntervalMs: 1500,
    /** Scroll phase duration, in ms. */
    scrollMs: 2000,
    /** Quiet window measured after the interaction phases, in ms. */
    settleMs: 2500,
    /** 'ab' | 'optimized' | 'baseline' */
    mode: 'ab',
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {{ get: () => object, update: (patch: object) => void }} options.settings
 * @param {ReturnType<import('./metrics.js').createMetrics>} options.metrics
 * @param {{ info: Function, warn: Function }} options.diagnostics
 * @param {object} options.runtime Runtime hooks.
 * @param {() => any} options.getJQuery
 */
export function createBench({ settings, metrics, diagnostics, runtime, getJQuery }) {
    let running = false;
    let aborted = false;
    /** @type {Array<() => void | Promise<void>>} */
    let restorers = [];

    /**
     * @returns {HTMLElement}
     */
    function requireElement(id) {
        const element = document.getElementById(id);
        if (!(element instanceof HTMLElement)) {
            throw new Error(`Benchmark requires #${id} to be present`);
        }
        return element;
    }

    function requireOpenPanel() {
        const container = requireElement('completion_prompt_manager');
        const drawer = container.closest('.drawer-content');
        if (drawer && !drawer.classList.contains('openDrawer')) {
            throw new Error('Open the "AI Response Configuration" panel before running the benchmark');
        }
        return container;
    }

    function describeEnvironment() {
        const instance = runtime.getInstance();
        const list = document.getElementById('completion_prompt_manager_list');
        const presetSelect = document.getElementById('settings_preset_openai');
        let chatLength = null;
        try {
            chatLength = runtime.getChatLength();
        } catch {
            chatLength = null;
        }

        return {
            userAgent: String(globalThis.navigator?.userAgent ?? ''),
            hardwareConcurrency: Number(globalThis.navigator?.hardwareConcurrency ?? 0) || null,
            devicePixelRatio: Number(globalThis.devicePixelRatio ?? 0) || null,
            promptRows: list ? list.querySelectorAll('li[data-pm-identifier]').length : 0,
            prompts: Array.isArray(instance?.serviceSettings?.prompts) ? instance.serviceSettings.prompts.length : 0,
            chatLength,
            preset: presetSelect instanceof HTMLSelectElement ? String(presetSelect.selectedOptions?.[0]?.text ?? '') : '',
            tokenCache: runtime.cacheStats(),
        };
    }

    /**
     * @param {object} options
     */
    async function phaseToggles({ toggles, toggleIntervalMs }) {
        const instance = runtime.getInstance();
        const list = requireElement('completion_prompt_manager_list');
        const candidates = Array.from(list.children).filter(node => {
            if (!node.getAttribute('data-pm-identifier')) {
                return false;
            }
            const toggle = node.querySelector('.prompt-manager-toggle-action');
            if (!(toggle instanceof HTMLElement)) {
                return false;
            }
            return toggle.classList.contains('fa-toggle-on') || toggle.classList.contains('fa-toggle-off');
        });

        if (candidates.length === 0) {
            return { toggles: 0, candidates: 0, note: 'no toggleable prompts' };
        }

        /** @type {string[]} */
        const keys = [];
        for (const node of candidates) {
            const identifier = node.getAttribute('data-pm-identifier');
            if (identifier) {
                keys.push(identifier);
            }
        }
        const before = new Map();
        for (const key of keys) {
            before.set(key, Boolean(instance.getPromptOrderEntry(instance.activeCharacter, key)?.enabled));
        }
        restorers.push(async () => {
            for (const [key, enabled] of before) {
                const entry = instance.getPromptOrderEntry(instance.activeCharacter, key);
                if (entry) {
                    entry.enabled = enabled;
                }
            }
            await instance.saveServiceSettings?.();
        });

        let performed = 0;
        for (let index = 0; index < toggles && !aborted; index += 1) {
            const key = keys[index % keys.length];
            const row = Array.from(list.children).find(node => node.getAttribute('data-pm-identifier') === key);
            const toggle = row?.querySelector('.prompt-manager-toggle-action');
            if (!(toggle instanceof HTMLElement)) {
                continue;
            }
            toggle.click();
            performed += 1;
            await delay(toggleIntervalMs);
        }

        return { toggles: performed, candidates: keys.length };
    }

    /**
     * @param {object} options
     */
    async function phasePresetSwitch({ presets, presetIntervalMs }) {
        const select = document.getElementById('settings_preset_openai');
        if (!(select instanceof HTMLSelectElement)) {
            return { switches: 0, note: 'preset selector unavailable' };
        }

        const indexes = Array.from(select.options)
            .map((option, index) => ({ index, value: option.value }))
            .filter(option => option.value !== 'gui')
            .map(option => option.index);

        if (indexes.length < 2) {
            return { switches: 0, presets: indexes.length, note: 'fewer than two presets available' };
        }

        const originalIndex = select.selectedIndex;
        const jQuery = getJQuery();
        restorers.push(() => {
            select.selectedIndex = originalIndex;
            jQuery(select).trigger('change');
        });

        let switches = 0;
        for (let index = 0; index < presets && !aborted; index += 1) {
            const target = indexes[(index + 1) % indexes.length];
            if (target === select.selectedIndex) {
                continue;
            }
            select.selectedIndex = target;
            jQuery(select).trigger('change');
            switches += 1;
            await delay(presetIntervalMs);
        }

        return { switches, presets: indexes.length };
    }

    /**
     * @param {object} options
     */
    async function phaseScroll({ scrollMs }) {
        const container = requireElement('completion_prompt_manager');
        const scroller = container.closest('.scrollableInner');
        if (!(scroller instanceof HTMLElement)) {
            return { scrolled: false, note: 'scroller not found' };
        }

        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (max <= 0) {
            return { scrolled: false, note: 'panel is not scrollable' };
        }

        const original = scroller.scrollTop;
        restorers.push(() => {
            scroller.scrollTop = original;
        });

        const start = globalThis.performance?.now?.() ?? Date.now();
        let direction = 1;
        let position = original;
        let distance = 0;

        /** @type {Promise<void>} */
        const scrollDone = new Promise(resolve => {
            const finish = () => resolve();
            const step = () => {
                const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - start;
                if (elapsed >= scrollMs || aborted) {
                    finish();
                    return;
                }
                position += direction * 32;
                if (position >= max) {
                    position = max;
                    direction = -1;
                } else if (position <= 0) {
                    position = 0;
                    direction = 1;
                }
                scroller.scrollTop = position;
                distance += 32;
                globalThis.requestAnimationFrame(step);
            };
            globalThis.requestAnimationFrame(step);
        });
        await scrollDone;

        return { scrolled: true, distance };
    }

    /**
     * Waits out the quiet window so a pending recount can be observed.
     *
     * @param {object} options
     */
    async function phaseSettle({ settleMs }) {
        const before = metrics.snapshot().spans.recount?.count ?? 0;
        await delay(settleMs);
        const after = metrics.snapshot().spans.recount?.count ?? 0;
        return {
            recounts: after - before,
            scheduler: runtime.schedulerSnapshot(),
        };
    }

    /**
     * @param {object} options
     */
    async function runPhase(name, runner, options, sink) {
        metrics.sampling.begin();
        const startedAt = (globalThis.performance?.now?.() ?? Date.now());
        let details = null;
        let error = null;
        try {
            details = await runner(options);
        } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
        }
        const sampling = metrics.sampling.end();
        sink.push({
            name,
            mode: settings.get().enabled ? 'optimized' : 'baseline',
            durationMs: (globalThis.performance?.now?.() ?? Date.now()) - startedAt,
            sampling,
            frames: summarize([]),
            details,
            error,
        });
    }

    /**
     * @param {object} options
     */
    async function runMode(mode, options, sink) {
        settings.update({ enabled: mode === 'optimized' });
        await delay(0);

        await runPhase('toggles', phaseToggles, options, sink);
        await runPhase('settle', phaseSettle, options, sink);
        await runPhase('presetSwitch', phasePresetSwitch, options, sink);
        await runPhase('settle', phaseSettle, options, sink);
        await runPhase('scroll', phaseScroll, options, sink);
    }

    async function restoreAll() {
        const pending = restorers;
        restorers = [];
        for (const restore of pending.reverse()) {
            try {
                await restore();
            } catch (error) {
                diagnostics.warn('Benchmark restore step failed:', error);
            }
        }
        settings.update({ enabled: true });
        runtime.requestPanelSync('bench-restore');
        runtime.scheduleRecount('bench-restore');
    }

    return {
        isRunning: () => running,
        abort() {
            aborted = true;
        },
        /**
         * @param {Partial<typeof DEFAULTS>} overrides
         * @returns {Promise<object>} Benchmark report.
         */
        async run(overrides = {}) {
            if (running) {
                throw new Error('A benchmark is already running');
            }
            requireOpenPanel();
            runtime.assertIdleForBench();

            const options = { ...DEFAULTS, ...overrides };
            running = true;
            aborted = false;

            /** @type {object} */
            const report = {
                startedAt: Date.now(),
                environment: describeEnvironment(),
                phases: [],
                warnings: [],
                mode: options.mode,
            };

            try {
                const modes = options.mode === 'ab' ? ['baseline', 'optimized'] : [options.mode];
                for (const mode of modes) {
                    await runMode(mode, options, report.phases);
                }
                report.comparison = comparePhases(report.phases);
            } finally {
                await restoreAll();
                running = false;
                diagnostics.info('Benchmark finished');
            }

            return report;
        },
    };
}

/**
 * @param {Array<object>} phases
 * @returns {object}
 */
export function comparePhases(phases) {
    const byMode = mode => phases.filter(phase => phase.mode === mode);
    const summarizeMode = mode => {
        const selected = byMode(mode);
        const interactionPhases = selected.filter(phase => phase.name !== 'settle');
        return {
            phases: selected.length,
            longTasks: selected.reduce((total, phase) => total + (phase.sampling?.longTasks?.count ?? 0), 0),
            longTaskMaxMs: selected.reduce((max, phase) => Math.max(max, phase.sampling?.longTasks?.maxMs ?? 0), 0),
            frameP95Ms: Math.max(0, ...interactionPhases.map(phase => phase.sampling?.frames?.p95Ms ?? 0)),
            frameMaxMs: Math.max(0, ...interactionPhases.map(phase => phase.sampling?.frames?.maxMs ?? 0)),
            recounts: selected
                .filter(phase => phase.name === 'settle')
                .reduce((total, phase) => total + (phase.details?.recounts ?? 0), 0),
        };
    };

    const baseline = summarizeMode('baseline');
    const optimized = summarizeMode('optimized');
    return {
        baseline,
        optimized,
        delta: {
            longTasks: optimized.longTasks - baseline.longTasks,
            frameP95Ms: optimized.frameP95Ms - baseline.frameP95Ms,
        },
    };
}
