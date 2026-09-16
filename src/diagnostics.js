// @ts-check
/**
 * Diagnostics: bounded, greppable evidence for everything this extension does
 * behind the scenes. Warnings and errors always reach the console; verbose
 * logging and the in-panel report are opt-in.
 */

const MAX_NOTES = 60;
const MAX_CONFLICTS = 40;

export function createDiagnostics({ isVerbose }) {
    const prefix = '[Preset Lite]';
    /** @type {Array<{ at: number, kind: string, message: string }>} */
    const notes = [];
    /** @type {Map<string, number>} */
    const onceKeys = new Map();
    /** @type {Array<{ at: number, selector: string, before: string, after: string }>} */
    const conflicts = [];
    /** @type {Map<string, string>} */
    const degradations = new Map();

    function push(kind, message) {
        notes.push({ at: Date.now(), kind, message });
        if (notes.length > MAX_NOTES) {
            notes.splice(0, notes.length - MAX_NOTES);
        }
    }

    return {
        info(message, ...args) {
            if (!isVerbose()) {
                return;
            }
            console.log(`${prefix} ${message}`, ...args);
            push('info', message);
        },
        warn(message, ...args) {
            console.warn(`${prefix} ${message}`, ...args);
            push('warn', message);
        },
        error(message, ...args) {
            console.error(`${prefix} ${message}`, ...args);
            push('error', message);
        },
        /** Logs once per key so hot paths cannot flood the console. */
        noteOnce(key, message, ...args) {
            const count = (onceKeys.get(key) ?? 0) + 1;
            onceKeys.set(key, count);
            if (count === 1) {
                this.info(message, ...args);
                push('note', message);
            }
        },
        /** Records that a patched path stepped aside; keeps the first reason per feature. */
        degrade(feature, reason) {
            if (degradations.get(feature) === reason) {
                return;
            }
            degradations.set(feature, reason);
            this.warn(`degraded: ${feature} -> ${reason}`);
        },
        clearDegradation(feature) {
            degradations.delete(feature);
        },
        recordConflict(conflict) {
            conflicts.push({ at: Date.now(), ...conflict });
            if (conflicts.length > MAX_CONFLICTS) {
                conflicts.splice(0, conflicts.length - MAX_CONFLICTS);
            }
        },
        snapshot() {
            return {
                notes: notes.map(note => ({ ...note })),
                degradations: [...degradations].map(([feature, reason]) => ({ feature, reason })),
                conflicts: conflicts.map(conflict => ({ ...conflict })),
            };
        },
    };
}
