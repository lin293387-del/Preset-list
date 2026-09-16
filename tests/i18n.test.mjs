import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const settingsHtml = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
const zhCn = JSON.parse(await readFile(new URL('../i18n/zh-cn.json', import.meta.url), 'utf8'));

/**
 * The host splits `data-i18n` on semicolons to support multi-key entries, so a
 * sentence used as its own key must not contain one. A semicolon silently turns
 * the key into two keys that never match a translation, which is exactly how a
 * toggle description can stay English while every other label is translated.
 */
test('settings markup never hides a semicolon inside an i18n key', () => {
    const keys = [...settingsHtml.matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1]);
    assert.ok(keys.length > 0, 'the settings template must declare i18n keys');
    for (const key of keys) {
        assert.equal(key.includes(';'), false, `data-i18n key must not contain a semicolon: ${key}`);
    }
});

test('every settings string has a Chinese translation', () => {
    const keys = [...settingsHtml.matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1]);
    const missing = keys.filter(key => typeof zhCn[key] !== 'string');
    assert.deepEqual(missing, [], 'settings.html keys and i18n/zh-cn.json drifted apart');
});
