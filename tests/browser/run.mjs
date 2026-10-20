/**
 * Headless-Chromium measurements for the preset panel.
 *
 * The unit tests prove behaviour; this proves *feel*. It drives a real browser
 * and reports, per scenario, how long the panel blocks the main thread and how
 * many blank frames a fast fling produces — the two things that are invisible to
 * a DOM-only test.
 *
 *   node tests/browser/run.mjs            # full report
 *   node tests/browser/run.mjs --quick    # fewer rows, fewer repetitions
 *
 * Requires a Chromium/Chrome binary (CHROME_BIN or one of the known names).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connect } from './cdp.mjs';
import { startServer } from './server.mjs';

const QUICK = process.argv.includes('--quick');
const ROWS = QUICK ? 80 : 200;
const REPEATS = QUICK ? 5 : 12;

const CANDIDATES = [
    process.env.CHROME_BIN,
    'chromium-browser',
    'chromium',
    'google-chrome',
    'google-chrome-stable',
    '/usr/bin/chromium',
].filter(Boolean);

async function findChrome() {
    for (const candidate of CANDIDATES) {
        try {
            await new Promise((resolve, reject) => {
                const child = spawn(candidate, ['--version'], { stdio: 'ignore' });
                child.once('error', reject);
                child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
            });
            return candidate;
        } catch {
            // try the next one
        }
    }
    throw new Error(`No Chromium binary found (tried ${CANDIDATES.join(', ')})`);
}

function launch(chrome, port, profileDir) {
    const child = spawn(chrome, [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--window-size=430,932',
        '--disable-features=Translate,MediaRouter',
        'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', () => {});
    return child;
}

/** @param {string} expression */
function evaluateExpression(expression) {
    return `(async () => { ${expression} })()`;
}

async function run() {
    const chrome = await findChrome();
    const server = await startServer();
    const port = 9000 + Math.floor(Math.random() * 900);
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir?.() ?? '/data/data/com.termux/files/home', 'pl-chrome-'));
    const child = launch(chrome, port, profileDir);

    /** @type {string[]} */
    const pageErrors = [];
    const results = [];
    /** Medians of the interaction scenarios only — the number a sync costs. */
    const panelMedians = [];
    /** @type {string[]} */
    const failures = [];

    try {
        const client = await connect(`http://127.0.0.1:${port}`);
        await client.send('Page.enable');
        await client.send('Runtime.enable');
        await client.send('Log.enable');
        await client.send('Emulation.setDeviceMetricsOverride', {
            width: 430, height: 932, deviceScaleFactor: 1, mobile: true,
        });

        client.on(event => {
            if (event.method === 'Runtime.exceptionThrown') {
                pageErrors.push(event.params?.exceptionDetails?.exception?.description ?? 'exception');
            }
            if (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error') {
                pageErrors.push(event.params.entry.text);
            }
        });

        const url = `${server.url}/tests/browser/harness.html?rows=${ROWS}`;
        await client.send('Page.navigate', { url });
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const { result } = await client.send('Runtime.evaluate', {
                expression: 'window.__harnessReady === true',
                returnByValue: true,
            });
            if (result.value === true) {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        const evaluate = async expression => {
            const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
                expression: evaluateExpression(expression),
                awaitPromise: true,
                returnByValue: true,
            });
            if (exceptionDetails) {
                throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
            }
            return result.value;
        };

        /**
         * Times a scenario on the page's own clock and samples frames while it runs,
         * so "jank" means "the browser missed frames", not "the promise was slow".
         */
        const scenario = async (name, body, { repeats = REPEATS } = {}) => {
            const outcome = await evaluate(`
                const samples = [];
                let last = performance.now();
                let running = true;
                const tick = () => {
                    const now = performance.now();
                    samples.push(now - last);
                    last = now;
                    if (running) requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);

                const durations = [];
                for (let i = 0; i < ${repeats}; i += 1) {
                    const started = performance.now();
                    ${body}
                    durations.push(performance.now() - started);
                    await new Promise(r => requestAnimationFrame(() => r()));
                }
                running = false;
                await new Promise(r => setTimeout(r, 60));

                const sorted = [...durations].sort((a, b) => a - b);
                const frames = samples.filter(ms => ms > 0);
                const longFrames = frames.filter(ms => ms > 50);
                return {
                    count: durations.length,
                    median: sorted[Math.floor(sorted.length / 2)],
                    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
                    max: sorted[sorted.length - 1],
                    frames: frames.length,
                    longFrames: longFrames.length,
                    worstFrame: frames.length ? Math.max(...frames) : 0,
                    path: window.__harness.state.lastPath,
                };
            `);
            results.push({ name, ...outcome });
            panelMedians.push(outcome.median);
            const line = `${name.padEnd(46)} median ${outcome.median.toFixed(1).padStart(7)} ms  p95 ${outcome.p95.toFixed(1).padStart(7)} ms  frames ${String(outcome.frames).padStart(4)}  >50ms ${String(outcome.longFrames).padStart(3)}  path=${outcome.path}`;
            console.log(line);
            return outcome;
        };

        console.log(`\nrows=${ROWS} repeats=${REPEATS} chromium=${chrome}\n`);

        // Calibration first, while the page is idle: the panel scenarios below are
        // one-shot operations whose absolute cost follows the device, this fixed
        // workload follows it too, and the ratio does not.
        const calibration = await evaluate(`
            let best = Infinity;
            for (let round = 0; round < 3; round += 1) {
                best = Math.min(best, window.__harness.calibrate());
            }
            return best;
        `);
        console.log(`calibration (fixed workload, min of 3) ${calibration.toFixed(1)} ms`);

        // The steady state has to be free: a no-op sync must not touch upstream.
        await scenario('idle sync (no change)', 'await window.__harness.sync();');

        await scenario('recount finished (all numbers move)', 'await window.__harness.recount(i + 1);');

        await scenario('toggle one row', 'await window.__harness.toggleRow(i % 20);');

        await scenario('rename one row', 'await window.__harness.renameRow(i % 20, String(i));');

        await scenario('edit one prompt body', 'await window.__harness.editBody(i % 20, String(i));');

        await scenario('duplicate one row', 'await window.__harness.duplicateRow(10 + (i % 5));');

        await scenario('delete one row', 'await window.__harness.deleteRow(10 + (i % 5));');

        /**
         * Screenshots the panel and reports how much of it is bare background.
         *
         * This is the only honest "is it blank" check: a skipped row still has a
         * box and still hit-tests, so geometry cannot tell painted from unpainted.
         * Pixels can. The PNG is decoded inside the page (createImageBitmap +
         * canvas), so no image library is needed here.
         *
         * @returns {Promise<{ blankRatio: number, rowBands: number }>}
         */
        /**
         * Screenshots the panel and reports how much *content* it shows.
         *
         * Geometry cannot answer "is it blank": a content-visibility-skipped row
         * still has a box, still hit-tests, and still paints its own background.
         * Only pixels can tell painted contents from reserved space, so the panel's
         * own background and the row fill are both subtracted and what is left is
         * text and icons. A blank panel therefore reads as a content ratio near
         * zero, which the control below verifies.
         *
         * @returns {Promise<{ contentRatio: number }>}
         */
        const samplePixels = async () => {
            const { data } = await client.send('Page.captureScreenshot', {
                format: 'png',
                clip: { x: 0, y: 0, width: 430, height: 932, scale: 1 },
                captureBeyondViewport: false,
            });
            return evaluate(`
                const image = await createImageBitmap(await (await fetch('data:image/png;base64,${data}')).blob());
                const canvas = document.createElement('canvas');
                canvas.width = image.width;
                canvas.height = image.height;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(image, 0, 0);
                const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height);

                // Row text is #d8dee9 (bright); the panel fill (#0e1116) and the row
                // fill (#1b212b) are both far darker than the threshold.
                let content = 0;
                let total = 0;
                for (let y = 40; y < canvas.height; y += 1) {
                    for (let x = 10; x < Math.min(canvas.width, 420) - 10; x += 2) {
                        const at = (y * canvas.width + x) * 4;
                        const brightness = (px[at] + px[at + 1] + px[at + 2]) / 3;
                        if (brightness > 90) {
                            content += 1;
                        }
                        total += 1;
                    }
                }
                return { contentRatio: content / total };
            `);
        };

        // ---- fast fling: does the list blank out or jump while it scrolls?
        //
        // The sampler deliberately never touches per-row geometry: measuring every
        // row would force layout for every row and hide the very thing under test.
        // It reads the scroll range (which is exactly what a placeholder height
        // distorts) and frame gaps (which is what a user feels as jank).
        const fling = async (variant, { flingMs = 300, flings = 6 } = {}) => {
            const outcome = await evaluate(`
                window.__harness.setVariant('${variant}');
                await new Promise(r => requestAnimationFrame(() => r()));
                const scroller = document.querySelector('.scrollableInner');
                const frameTimes = [];
                const scrollHeights = [];
                const tops = [];
                let last = performance.now();
                let sampling = true;
                const sample = () => {
                    const now = performance.now();
                    frameTimes.push(now - last);
                    last = now;
                    scrollHeights.push(scroller.scrollHeight);
                    tops.push(scroller.scrollTop);
                    if (sampling) requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);

                const max = scroller.scrollHeight - scroller.clientHeight;
                const legStarts = [];
                for (let f = 0; f < ${flings}; f += 1) {
                    const from = scroller.scrollTop;
                    const target = f % 2 === 0 ? max : 0;
                    legStarts.push(tops.length);
                    const started = performance.now();
                    while (performance.now() - started < ${flingMs}) {
                        const t = Math.min(1, (performance.now() - started) / ${flingMs});
                        scroller.scrollTop = from + (target - from) * t;
                        await new Promise(r => requestAnimationFrame(() => r()));
                    }
                }
                sampling = false;
                await new Promise(r => setTimeout(r, 100));

                const heights = scrollHeights.filter(h => h > 0);
                // Within one leg the offset must never go backwards; that would be
                // the "it jumped" symptom of a scroll range that shifts under it.
                let backwards = 0;
                for (let leg = 0; leg < legStarts.length; leg += 1) {
                    const end = leg + 1 < legStarts.length ? legStarts[leg + 1] : tops.length;
                    const forward = leg % 2 === 0;
                    for (let i = legStarts[leg] + 1; i < end; i += 1) {
                        const delta = tops[i] - tops[i - 1];
                        if (forward ? delta < -1 : delta > 1) backwards += 1;
                    }
                }
                return {
                    frames: frameTimes.length,
                    worstFrame: frameTimes.length ? Math.max(...frameTimes) : 0,
                    longFrames: frameTimes.filter(ms => ms > 50).length,
                    scrollRangeSpread: heights.length ? Math.max(...heights) - Math.min(...heights) : 0,
                    backwardsJumps: backwards,
                    rowHeight: window.__harness.rowHeight(),
                    publishedRowHeight: window.__harness.publishedRowHeight(),
                };
            `);

            // Pause the fling at three positions and look at actual pixels.
            const blank = [];
            for (const fraction of [0.15, 0.5, 0.85]) {
                await evaluate(`
                    const scroller = document.querySelector('.scrollableInner');
                    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * ${fraction};
                    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
                `);
                blank.push(await samplePixels());
            }
            const lowestContent = Math.min(...blank.map(sample => sample.contentRatio));

            const line = `fling ${variant.padEnd(4)}  frames ${String(outcome.frames).padStart(4)}  worst ${outcome.worstFrame.toFixed(1).padStart(7)} ms  >50ms ${String(outcome.longFrames).padStart(3)}  rangeDrift ${outcome.scrollRangeSpread.toFixed(0).padStart(4)} px  jumps ${String(outcome.backwardsJumps).padStart(3)}  content ${(lowestContent * 100).toFixed(1).padStart(5)}%  row ${outcome.rowHeight.toFixed(0)}/${outcome.publishedRowHeight || '-'}`;
            console.log(line);
            results.push({ name: `fling ${variant}`, ...outcome, contentRatio: lowestContent });
            return outcome;
        };

        console.log('');
        await fling('off');
        await fling('old');
        await fling('new');

        // ---- nothing may write to the panel while a fling is in progress
        //
        // This is the actual requirement: not "repaint fast" but "do not repaint".
        // A MutationObserver counts every write the panel makes while the gesture
        // is held; the recount below changes every single number, so a leak would
        // be obvious.
        const quiet = await evaluate(`
            window.__harness.setVariant('new');
            window.__harness.watchMutations();
            const scroller = document.querySelector('.scrollableInner');
            const max = scroller.scrollHeight - scroller.clientHeight;

            // A fling that also asks for panel work on every frame: a recount that
            // changes every number, plus a row rename and a duplicate. None of it may
            // reach the DOM while the gesture lasts.
            const started = performance.now();
            let requests = 0;
            while (performance.now() - started < 400) {
                const t = Math.min(1, (performance.now() - started) / 400);
                scroller.scrollTop = max * t;
                requests += 1;
                window.__harness.recount(requests);
                window.__harness.renameRow(requests % 20, 'q' + requests);
                if (requests % 3 === 0) window.__harness.duplicateRow(30 + (requests % 5));
                await new Promise(r => requestAnimationFrame(() => r()));
            }
            const duringGesture = window.__harness.stopWatchingMutations();
            const gate = window.__harness.gateState();

            // The gesture ends 160 ms after the last scroll event; give it that long,
            // then let the single deferred sync run.
            await new Promise(r => setTimeout(r, 260));
            await new Promise(r => requestAnimationFrame(() => r()));
            await new Promise(r => setTimeout(r, 80));

            return {
                requests,
                duringGesture,
                gate,
                rowsAfter: window.__harness.rowCount(),
            };
        `);
        console.log(`\nquiet fling (${quiet.requests} sync requests while flinging)  writes during gesture ${quiet.duringGesture.duringGesture} / ${quiet.duringGesture.total}  deferred=${quiet.gate.deferred}  rows ${quiet.rowsAfter}`);
        results.push({ name: 'quiet-fling', ...quiet });

        // Positive control: the same observer must see writes when the gate is not
        // in the way. Without this, "0 writes" could just mean "observer is broken".
        const controlWrites = await evaluate(`
            window.__harness.watchMutations();
            await window.__harness.recount(1);
            await window.__harness.toggleRow(2);
            // MutationObserver delivers on a microtask, so let it report before reading.
            await new Promise(r => setTimeout(r, 50));
            return window.__harness.stopWatchingMutations();
        `);
        console.log(`write control (one recount + one toggle, no gesture)  writes ${controlWrites.total}`);

        // ---- structural changes must never leave the list empty on screen
        //
        // Deleting or duplicating a prompt makes upstream rebuild the list. If the
        // rows are dropped before the new ones exist, the scroll container collapses
        // and the user sees a blank panel plus a jump to the top. This samples the
        // row count on every frame while that happens.
        const structural = await evaluate(`
            window.__harness.setVariant('new');
            const counts = [];
            let sampling = true;
            const sample = () => {
                counts.push(document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]').length);
                if (sampling) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);

            for (let i = 0; i < 8; i += 1) {
                await window.__harness.deleteRow(20 + (i % 4));
                await new Promise(r => requestAnimationFrame(() => r()));
                await window.__harness.duplicateRow(30 + (i % 4));
                await new Promise(r => requestAnimationFrame(() => r()));
            }
            sampling = false;
            await new Promise(r => setTimeout(r, 100));
            return {
                frames: counts.length,
                emptyFrames: counts.filter(count => count === 0).length,
                minRows: counts.length ? Math.min(...counts) : -1,
                finalRows: window.__harness.rowCount(),
            };
        `);
        console.log(`\nstructural churn (8x delete+duplicate, frame-sampled)  frames ${structural.frames}  empty ${structural.emptyFrames}  minRows ${structural.minRows}  final ${structural.finalRows}`);
        results.push({ name: 'structural', ...structural });

        // ---- the footer select follows the prompt list
        //
        // Adding or deleting a prompt no longer rebuilds the panel, so the select
        // is refreshed on its own. If that is wrong the panel looks fine and the
        // "insert prompt" dropdown silently offers the old set — the exact failure
        // a cheaper path invites, so it is asserted rather than assumed.
        const selectSync = await evaluate(`
            const seen = [];
            for (let i = 0; i < 4; i += 1) {
                await window.__harness.duplicateRow(15 + i);
                await new Promise(r => requestAnimationFrame(() => r()));
                seen.push({ step: 'duplicate', live: window.__harness.selectOptions(), expected: window.__harness.selectableOptions() });
                await window.__harness.deleteRow(15 + i);
                await new Promise(r => requestAnimationFrame(() => r()));
                seen.push({ step: 'delete', live: window.__harness.selectOptions(), expected: window.__harness.selectableOptions() });
            }
            const drifted = seen.filter(entry => entry.live.join('|') !== entry.expected.join('|'));
            return {
                checks: seen.length,
                drifted: drifted.length,
                sample: drifted.length ? drifted[0] : null,
            };
        `);
        console.log(`footer select after add/remove  checks ${selectSync.checks}  drifted ${selectSync.drifted}`);
        if (selectSync.drifted > 0) {
            const sample = selectSync.sample;
            failures.push(`the footer select stopped following the prompt list after ${sample.step} (live ${sample.live.length} options, expected ${sample.expected.length})`);
        }
        results.push({ name: 'select-sync', ...selectSync });

        // ---- the pixel instrument must be able to see a blank panel
        //
        // Without this control a "0% blank" reading is meaningless: it could just be
        // an instrument that never reports blank. Forcing every row to reserve a huge
        // placeholder pushes the viewport into a region with nothing painted, which
        // is exactly the failure mode a wrong placeholder height produces.
        const control = await evaluate(`
            const style = document.createElement('style');
            style.id = 'blank-control';
            // content-visibility: hidden skips painting entirely — the honest way to
            // prove the probe can see a blank panel at all.
            style.textContent = '.cv-forced #completion_prompt_manager_list > li.completion_prompt_manager_prompt { content-visibility: hidden; }';
            document.head.appendChild(style);
            window.__harness.setVariant('forced');
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
            return { rows: window.__harness.rowCount() };
        `);
        const controlPixels = await samplePixels();
        await evaluate(`
            document.getElementById('blank-control')?.remove();
            window.__harness.setVariant('new');
            const scroller = document.querySelector('.scrollableInner');
            scroller.scrollTop = 0;
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        `);
        console.log(`pixel control (rows forced to content-visibility: hidden): content ${(controlPixels.contentRatio * 100).toFixed(1)}%`);
        if (controlPixels.contentRatio > 0.015) {
            failures.push(`the blank-panel detector cannot see a forced blank viewport (content ${(controlPixels.contentRatio * 100).toFixed(1)}%)`);
        }

        // ---- extreme interaction: hammer actions back to back
        //
        // Two modes: `burst` runs 60 actions without ever yielding (worst case, no
        // frame can be painted — reported for information only) and `paced` leaves
        // one frame between actions, which is the fastest a user can physically
        // produce and the one that has a budget.
        const hammer = await evaluate(`
            window.__harness.setVariant('new');
            const run = async (paced) => {
                const frameTimes = [];
                let last = performance.now();
                let sampling = true;
                const sample = () => {
                    const now = performance.now();
                    frameTimes.push(now - last);
                    last = now;
                    if (sampling) requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);

                const started = performance.now();
                for (let i = 0; i < 60; i += 1) {
                    switch (i % 4) {
                        case 0: await window.__harness.toggleRow(i % 30); break;
                        case 1: await window.__harness.recount(i + 1); break;
                        case 2: await window.__harness.renameRow(i % 30, String(i)); break;
                        default: await window.__harness.editBody(i % 30, String(i)); break;
                    }
                    if (paced) await new Promise(r => requestAnimationFrame(() => r()));
                }
                const elapsed = performance.now() - started;
                sampling = false;
                await new Promise(r => setTimeout(r, 100));
                return {
                    elapsed,
                    worstFrame: frameTimes.length ? Math.max(...frameTimes) : 0,
                    longFrames: frameTimes.filter(ms => ms > 50).length,
                    frames: frameTimes.length,
                };
            };
            const burst = await run(false);
            const paced = await run(true);
            return { burst, paced, rows: window.__harness.rowCount() };
        `);
        console.log(`\nhammer burst (60 actions, never yields)  total ${hammer.burst.elapsed.toFixed(0)} ms  frames ${hammer.burst.frames}  worst ${hammer.burst.worstFrame.toFixed(0)} ms   [information only: nothing can paint during a synchronous burst]`);
        console.log(`hammer paced (60 actions, 1 frame apart)  total ${hammer.paced.elapsed.toFixed(0)} ms  frames ${hammer.paced.frames}  worst frame ${hammer.paced.worstFrame.toFixed(1)} ms  >50ms ${hammer.paced.longFrames}  rows ${hammer.rows}`);
        results.push({ name: 'hammer', ...hammer.paced });

        const diagnostics = await evaluate('return window.__harness.diagnostics();');
        const invalid = diagnostics.degradations ?? [];
        console.log(`\nconsole errors: ${pageErrors.length}`);
        for (const error of pageErrors.slice(0, 10)) {
            console.log(`  ! ${error.split('\n')[0]}`);
        }
        if (invalid.length > 0) {
            console.log('degradations:');
            for (const entry of invalid) {
                console.log(`  - ${entry.feature}: ${entry.reason}`);
            }
        }

        // ---- verdict
        //
        // Thresholds are set from what the paths can possibly cost: a token-only
        // sync writes text nodes, a local rebuild renders one row, and a full
        // rebuild renders all of them. Anything above the corresponding budget
        // means the cheap path silently did not run.
        const byName = new Map(results.map(entry => [entry.name, entry]));
        const budget = (name, limit) => {
            const entry = byName.get(name);
            if (entry && entry.median > limit) {
                failures.push(`${name} costs ${entry.median.toFixed(1)} ms (budget ${limit} ms)`);
            }
            return entry;
        };

        const idle = budget('idle sync (no change)', 8);
        if (idle && idle.path !== 'tokens') {
            failures.push(`idle sync took path "${idle.path}" instead of "tokens"`);
        }
        const recount = budget('recount finished (all numbers move)', 45);
        if (recount && recount.path !== 'tokens') {
            failures.push(`recount sync took path "${recount.path}" instead of "tokens"`);
        }
        const toggle = budget('toggle one row', 60);
        if (toggle && toggle.path !== 'local') {
            failures.push(`toggle took path "${toggle.path}" instead of "local"`);
        }
        const rename = budget('rename one row', 90);
        if (rename && rename.path !== 'local') {
            failures.push(`rename took path "${rename.path}" instead of "local"`);
        }
        const edit = budget('edit one prompt body', 10);
        if (edit && edit.path !== 'tokens') {
            failures.push(`editing a prompt body re-rendered (path "${edit.path}"); the body is not part of the row markup`);
        }

        const newFling = byName.get('fling new');
        const oldFling = byName.get('fling old');
        const offFling = byName.get('fling off');
        if (newFling && newFling.scrollRangeSpread > 2) {
            failures.push(`scroll range drifts by ${newFling.scrollRangeSpread.toFixed(0)} px during a fling (placeholder height is wrong)`);
        }
        if (newFling && newFling.backwardsJumps > 0) {
            failures.push(`the list jumped backwards ${newFling.backwardsJumps} time(s) during a forward fling`);
        }
        if (newFling && offFling && newFling.contentRatio < offFling.contentRatio * 0.6) {
            failures.push(`a fling drops the painted content to ${(newFling.contentRatio * 100).toFixed(1)}% (baseline without skipping: ${(offFling.contentRatio * 100).toFixed(1)}%)`);
        }
        if (oldFling && newFling && oldFling.scrollRangeSpread > newFling.scrollRangeSpread + 2) {
            console.log(`  (regression confirmed: the previous placeholder drifted ${oldFling.scrollRangeSpread.toFixed(0)} px, now ${newFling.scrollRangeSpread.toFixed(0)} px)`);
        }

        if (pageErrors.length > 0) {
            failures.push(`${pageErrors.length} console error(s)`);
        }
        if (quiet.duringGesture.duringGesture > 0) {
            failures.push(`${quiet.duringGesture.duringGesture} DOM write(s) reached the panel while a fling was in progress (expected 0)`);
        }
        if (controlWrites.total === 0) {
            failures.push('the mutation observer sees no writes even outside a gesture, so the quiet-fling check proves nothing');
        }
        if (structural.emptyFrames > 0) {
            failures.push(`the list was empty on ${structural.emptyFrames} frame(s) during a structural change (blank panel + scroll reset)`);
        }
        if (hammer.paced.worstFrame > 250) {
            failures.push(`hammer produced a ${hammer.paced.worstFrame.toFixed(0)} ms frame while paced (budget 250 ms)`);
        }
        if (hammer.paced.longFrames > 5) {
            failures.push(`hammer dropped ${hammer.paced.longFrames} frames over 50 ms while paced`);
        }

        // One machine-readable line so a measurement can be compared across
        // sessions: the panel sum is a one-shot-operation cost that follows the
        // device, the calibration is a fixed workload that follows it too.
        const panelSum = panelMedians.reduce((total, median) => total + median, 0);
        console.log(`summary panel-sum ${panelSum.toFixed(2)} calibration ${calibration.toFixed(2)}`);

        await client.close();

        if (failures.length > 0) {
            console.log('\nFAIL');
            for (const failure of failures) {
                console.log(`  - ${failure}`);
            }
            process.exitCode = 1;
            return;
        }
        console.log('\nPASS');
    } finally {
        child.kill('SIGKILL');
        await server.close();
        await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
}

await run();
