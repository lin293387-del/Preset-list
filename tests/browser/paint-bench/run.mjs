/**
 * Paint bench: what scrolling the real TavernTavern chrome costs, on this device.
 *
 * The preset-panel harness (`../run.mjs`) answers "how long does a panel sync
 * block the main thread". It cannot answer "how expensive is a blurred top bar
 * over a scrolling chat", because it never loads TT's stylesheet. This one does:
 * it serves `TT/src/style.css` straight out of the TT checkout and scrolls a
 * surface built from TT's own ids and class names.
 *
 *   node tests/browser/paint-bench/run.mjs
 *   TT_SRC=/path/to/TT/src node tests/browser/paint-bench/run.mjs
 *   BENCH_GPU=1 node tests/browser/paint-bench/run.mjs
 *
 * Reports, per pass, the median frame interval while scrolling. It then runs the
 * same scroll with the simulated A1 layer injected and fails loudly if the two
 * passes do not separate — a blind instrument is worse than no instrument.
 *
 * Raster runs on SwiftShader unless BENCH_GPU=1, so absolute numbers are
 * pessimistic and are only comparable to each other on the same machine.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_SRC = process.env.TT_SRC
    ? path.resolve(process.env.TT_SRC)
    : path.resolve(HERE, '../../../../TT/src');
const TT_STYLE = path.join(TT_SRC, 'style.css');
const STEPS = Number(process.env.BENCH_STEPS ?? 180);
const ROWS = Number(process.env.BENCH_ROWS ?? 40);
const WARMUP_PASSES = 2;
/** The two passes must differ by at least this factor to call the bench blind. */
const MIN_SENSITIVITY = 1.15;

const CANDIDATES = [
    process.env.CHROME_BIN,
    'chromium-browser',
    'chromium',
    'google-chrome',
    'google-chrome-stable',
    '/usr/bin/chromium',
].filter(Boolean);

const LOCAL_FILES = {
    '/page.html': ['page.html', 'text/html; charset=utf-8'],
    '/theme.css': ['theme.css', 'text/css; charset=utf-8'],
    '/bench.css': ['bench.css', 'text/css; charset=utf-8'],
    '/bench.js': ['bench.js', 'text/javascript; charset=utf-8'],
    '/degrade.css': ['degrade.css', 'text/css; charset=utf-8'],
};

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

/**
 * Serves the bench assets plus TT's real stylesheet.
 *
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
async function startServer() {
    const style = await fs.readFile(TT_STYLE, 'utf8');

    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname === '/tt-style.css') {
            response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }).end(style);
            return;
        }
        const local = LOCAL_FILES[url.pathname];
        if (!local) {
            response.writeHead(404).end('not found');
            return;
        }
        try {
            const body = await fs.readFile(path.join(HERE, local[0]), 'utf8');
            response.writeHead(200, { 'content-type': local[1] }).end(body);
        } catch (error) {
            response.writeHead(500).end(String(error));
        }
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = /** @type {{ port: number }} */ (server.address());
    return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

function launch(chrome, port, profileDir) {
    const args = [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--window-size=430,932',
        '--disable-features=Translate,MediaRouter',
    ];
    if (!process.env.BENCH_GPU) {
        args.push('--disable-gpu');
    }
    args.push('about:blank');

    const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', () => {});
    return child;
}

/** @param {number[]} frames */
function summarize(frames) {
    const usable = frames.filter(ms => ms > 0).sort((a, b) => a - b);
    const at = percentile => usable[Math.min(usable.length - 1, Math.floor(usable.length * percentile))];
    return {
        frames: usable.length,
        median: at(0.5),
        p95: at(0.95),
        worst: usable[usable.length - 1],
    };
}

/**
 * @param {(expression: string) => Promise<any>} evaluate
 * @param {string} label
 */
async function scrollPass(evaluate, label) {
    const outcome = await evaluate(`
        const result = await window.__benchScroll(${STEPS});
        return { frames: result.frames, scrolled: result.scrolled };
    `);
    if (!outcome?.frames?.length) {
        throw new Error(`bench pass "${label}" produced no frames`);
    }
    if (!(outcome.scrolled > 0)) {
        throw new Error(`bench pass "${label}" never scrolled (the page cannot scroll, so there is nothing to measure)`);
    }
    return summarize(outcome.frames);
}

async function main() {
    await fs.access(TT_STYLE);

    const chrome = await findChrome();
    const server = await startServer();
    const port = 9000 + Math.floor(Math.random() * 900);
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir?.() ?? '/data/data/com.termux/files/home', 'bench-chrome-'));
    const child = launch(chrome, port, profileDir);

    try {
        const client = await connect(`http://127.0.0.1:${port}`);
        await client.send('Page.enable');
        await client.send('Runtime.enable');
        await client.send('Emulation.setDeviceMetricsOverride', {
            width: 430, height: 932, deviceScaleFactor: 1, mobile: true,
        });

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

        await client.send('Page.navigate', { url: `${server.url}/page.html?rows=${ROWS}` });
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const ready = await evaluate('return window.__benchReady === true;');
            if (ready === true) {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        for (let warmup = 0; warmup < WARMUP_PASSES; warmup += 1) {
            await scrollPass(evaluate, `warmup ${warmup + 1}`);
        }

        const plain = await scrollPass(evaluate, 'tt-css');

        const degradeCss = await fs.readFile(path.join(HERE, 'degrade.css'), 'utf8');
        await evaluate(`return window.__benchInject(${JSON.stringify(degradeCss)});`);
        await scrollPass(evaluate, 'degraded warmup');
        const degraded = await scrollPass(evaluate, 'degraded');

        const line = (label, s) => `${label.padEnd(10)} frames ${String(s.frames).padStart(4)}  median-frame ${s.median.toFixed(1).padStart(6)} ms  p95 ${s.p95.toFixed(1).padStart(6)} ms  worst ${s.worst.toFixed(1).padStart(6)} ms`;
        console.log(`\nrows=${ROWS} steps=${STEPS} tt=${TT_SRC} gpu=${process.env.BENCH_GPU ? 'on' : 'swiftshader'}\n`);
        console.log(line('tt-css', plain));
        console.log(line('degraded', degraded));

        const ratio = degraded.median > 0 ? plain.median / degraded.median : 0;
        console.log(`\nsensitivity ${ratio.toFixed(2)}x  (the bench must separate the two worlds by ${MIN_SENSITIVITY}x)`);

        if (!(ratio >= MIN_SENSITIVITY)) {
            throw new Error(`bench is blind: dropping the blur/shadows changed the median frame by only ${ratio.toFixed(2)}x`);
        }
    } finally {
        child.kill('SIGKILL');
        await server.close();
        await fs.rm(profileDir, { recursive: true, force: true });
    }
}

await main();
