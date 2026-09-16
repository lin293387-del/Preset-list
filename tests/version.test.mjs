import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { VERSION } from '../src/version.js';

test('manifest, package and runtime versions agree', async () => {
    const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));

    assert.equal(manifest.version, VERSION, 'manifest.json version must match src/version.js');
    assert.equal(pkg.version, VERSION, 'package.json version must match src/version.js');
});
