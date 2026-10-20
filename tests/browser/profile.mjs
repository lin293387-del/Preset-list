/**
 * Samples a CPU profile while the panel scenarios run, then reports self time per
 * function.
 *
 * `run.mjs` answers "how long does a sync take"; it cannot answer "which function
 * spends it". Guessing at that is how a sync ends up micro-optimised in a place
 * that costs nothing, so this records the answer with V8's own sampler.
 *
 *   node tests/browser/profile.mjs               # all scenarios, top 25
 *   node tests/browser/profile.mjs --rows 60     # smaller list
 *
 * Requires a Chromium/Chrome binary (CHROME_BIN or one of the known names).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connect } from './cdp.mjs';
import { startServer } from './server.mjs';

const args = process.argv.slice(2);
const rowsArg = args.indexOf('--rows');
const ROWS = rowsArg >= 0 ? Number(args[rowsArg + 1]) : 200;
const TOP = 25;
const REPEATS = 8;

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

/**
 * Turns a V8 profile into self time per call frame.
 *
 * `timeDeltas[i]` is the time between sample `i - 1` and sample `i`, so a sample
 * is charged to the node that was on top of the stack when it was taken.
 *
 * @param {{ nodes: any[], samples: number[], timeDeltas: number[] }} profile
 * @param {(url: string) => boolean} include
 * @returns {Array<{ key: string, url: string, line: number, self: number }>}
 */
function selfTime(profile, include) {
    const byId = new Map(profile.nodes.map(node => [node.id, node]));
    const totals = new Map();
    for (let index = 0; index < profile.samples.length; index += 1) {
        const node = byId.get(profile.samples[index]);
        if (!node) {
            continue;
        }
        const frame = node.callFrame;
        const url = frame.url ?? '';
        if (!include(url)) {
            continue;
        }
        const key = `${frame.functionName || '(anonymous)'} @ ${url.split('/').pop()}:${frame.lineNumber + 1}`;
        const delta = Math.max(0, (profile.timeDeltas?.[index] ?? 0) / 1000);
        totals.set(key, (totals.get(key) ?? 0) + delta);
    }
    return [...totals.entries()]
        .map(([key, self]) => {
            const [, location] = key.split(' @ ');
            const [file, line] = location.split(':');
            return { key, url: file, line: Number(line), self };
        })
        .sort((first, second) => second.self - first.self);
}

/**
 * @param {Array<{ key: string, self: number }>} entries
 * @param {number} total
 */
function report(entries, total) {
    for (const entry of entries.slice(0, TOP)) {
        const share = total > 0 ? (entry.self / total) * 100 : 0;
        console.log(`  ${entry.self.toFixed(1).padStart(8)} ms  ${share.toFixed(1).padStart(5)}%  ${entry.key}`);
    }
}

const SCENARIOS = [
    ['idle sync (no change)', 'await window.__harness.sync();'],
    ['recount finished', 'await window.__harness.recount(i + 1);'],
    ['toggle one row', 'await window.__harness.toggleRow(i % 20);'],
    ['rename one row', 'await window.__harness.renameRow(i % 20, String(i));'],
    ['edit one prompt body', 'await window.__harness.editBody(i % 20, String(i));'],
    ['duplicate one row', 'await window.__harness.duplicateRow(10 + (i % 5));'],
    ['delete one row', 'await window.__harness.deleteRow(10 + (i % 5));'],
];

async function run() {
    const chrome = await findChrome();
    const server = await startServer();
    const port = 9000 + Math.floor(Math.random() * 900);
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir?.() ?? '/data/data/com.termux/files/home', 'to-prof-chrome-'));
    const child = launch(chrome, port, profileDir);

    try {
        const client = await connect(`http://127.0.0.1:${port}`);
        await client.send('Page.enable');
        await client.send('Runtime.enable');
        await client.send('Profiler.enable');
        await client.send('Profiler.setSamplingInterval', { interval: 100 });

        await client.send('Page.navigate', { url: `${server.url}/tests/browser/harness.html?rows=${ROWS}` });
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
                expression: `(async () => { ${expression} })()`,
                awaitPromise: true,
                returnByValue: true,
            });
            if (exceptionDetails) {
                throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
            }
            return result.value;
        };

        // Warm up on the same code paths the profile will sample: the first sync of
        // a run pays for parsing and the first layout, which are not what a user's
        // second interaction costs.
        for (const [, body] of SCENARIOS) {
            await evaluate(`
                for (let i = 0; i < 3; i += 1) {
                    ${body}
                    await new Promise(r => requestAnimationFrame(() => r()));
                }
            `);
        }

        console.log(`\nrows=${ROWS} repeats=${REPEATS} chromium=${chrome}`);
        console.log('Self time is charged to the frame that was on top of the stack when a');
        console.log('sample was taken, so a native frame (getBoundingClientRect, replaceChildren)');
        console.log('shows up as the cost of the script call that forced it.\n');

        const isScript = url => /\/src\/|harness\.js|harness\.html/.test(url);
        /** @type {Map<string, number>} */
        const aggregate = new Map();

        for (const [name, body] of SCENARIOS) {
            await client.send('Profiler.start');
            await evaluate(`
                for (let i = 0; i < ${REPEATS}; i += 1) {
                    ${body}
                    await new Promise(r => requestAnimationFrame(() => r()));
                }
            `);
            const { profile } = await client.send('Profiler.stop');

            const entries = selfTime(profile, isScript);
            const total = entries.reduce((sum, entry) => sum + entry.self, 0);
            const allEntries = selfTime(profile, () => true);
            const allTotal = allEntries.reduce((sum, entry) => sum + entry.self, 0);
            for (const entry of entries) {
                aggregate.set(entry.key, (aggregate.get(entry.key) ?? 0) + entry.self);
            }

            const perSync = total / REPEATS;
            const enginePerSync = (allTotal - total) / REPEATS;
            console.log(`--- ${name} (${perSync.toFixed(2)} ms script, ${enginePerSync.toFixed(2)} ms engine per sync) ---`);
            report(entries, total);
            console.log('');
        }

        const aggregated = [...aggregate.entries()]
            .map(([key, self]) => ({ key, self }))
            .sort((first, second) => second.self - first.self);
        const aggregateTotal = aggregated.reduce((sum, entry) => sum + entry.self, 0);
        console.log(`=== across all scenarios: ${aggregateTotal.toFixed(1)} ms script self time ===`);
        report(aggregated, aggregateTotal);

        await client.close();
    } finally {
        child.kill('SIGKILL');
        await server.close();
        await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
}

await run();
