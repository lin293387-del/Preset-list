/**
 * Ambient declarations for the host globals the extension touches.
 *
 * They are intentionally permissive: the host owns these shapes and the
 * extension only needs the few members it actually reads.
 */

declare global {
    var __TAURITAVERN__: { ready?: Promise<unknown>; api?: { extension?: { store?: any } } } | undefined;
    var __TAURITAVERN_MAIN_READY__: Promise<unknown> | undefined;
    var __TAURITAVERN_PERF__: { snapshot?: () => unknown } | undefined;
    var requestIdleCallback: ((callback: () => void, options?: { timeout?: number }) => number) | undefined;
    var cancelIdleCallback: ((handle: number) => void) | undefined;
}

export {};
