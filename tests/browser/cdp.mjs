/**
 * A very small Chrome DevTools Protocol client.
 *
 * The harness only needs "navigate, evaluate, screenshot, collect console
 * errors", so this stays dependency-free: the browser is driven over the
 * WebSocket that `--remote-debugging-port` exposes.
 */
import WebSocket from 'ws';

/**
 * @param {string} baseUrl
 * @returns {Promise<{ wsUrl: string }>}
 */
async function findPageTarget(baseUrl) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            const response = await fetch(`${baseUrl}/json/list`);
            const targets = await response.json();
            const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
            if (page) {
                return { wsUrl: page.webSocketDebuggerUrl };
            }
        } catch {
            // The port is not listening yet.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Chromium did not expose a page target');
}

/**
 * @param {string} baseUrl DevTools HTTP endpoint, e.g. `http://127.0.0.1:9222`.
 * @returns {Promise<{
 *   send: (method: string, params?: object) => Promise<any>,
 *   on: (handler: (event: { method: string, params: any }) => void) => void,
 *   close: () => Promise<void>,
 * }>}
 */
export async function connect(baseUrl) {
    const { wsUrl } = await findPageTarget(baseUrl);
    const socket = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });

    let nextId = 1;
    const pending = new Map();
    /** @type {Array<(event: { method: string, params: any }) => void>} */
    const listeners = [];

    socket.on('message', raw => {
        const message = JSON.parse(String(raw));
        if (message.id && pending.has(message.id)) {
            const { resolve, reject } = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) {
                reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? '')})`));
            } else {
                resolve(message.result);
            }
            return;
        }
        for (const listener of listeners) {
            listener(message);
        }
    });

    return {
        send(method, params = {}) {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                socket.send(JSON.stringify({ id, method, params }));
            });
        },
        on(handler) {
            listeners.push(handler);
        },
        close() {
            return new Promise(resolve => {
                socket.once('close', () => resolve());
                socket.close();
            });
        },
    };
}
