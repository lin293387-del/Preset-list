// @ts-check
/**
 * Single source of truth for the extension version.
 *
 * `manifest.json` and `package.json` are checked against it by
 * `tests/version.test.mjs`, because forgetting one of the three is the classic
 * way a release ends up reporting the wrong version.
 */
export const VERSION = '0.1.4';
