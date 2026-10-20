/**
 * Minimal static server for the browser harness.
 *
 * Serves the repository root so the harness can import `../../src/*.js` exactly
 * as the extension ships it (no bundling, no build step).
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

/**
 * @param {number} [port]
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startServer(port = 0) {
    const server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? '/', 'http://localhost');
            if (url.pathname === '/favicon.ico') {
                response.writeHead(204).end();
                return;
            }
            const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
            const file = path.resolve(ROOT, relative || 'tests/browser/harness.html');
            if (!file.startsWith(ROOT)) {
                response.writeHead(403).end('forbidden');
                return;
            }
            const body = await fs.readFile(file);
            response.writeHead(200, {
                'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
                'cache-control': 'no-store',
            });
            response.end(body);
        } catch {
            response.writeHead(404).end('not found');
        }
    });

    return new Promise(resolve => {
        server.listen(port, '127.0.0.1', () => {
            const address = server.address();
            const actual = typeof address === 'object' && address ? address.port : port;
            resolve({
                url: `http://127.0.0.1:${actual}`,
                close: () => new Promise(done => server.close(() => done())),
            });
        });
    });
}
