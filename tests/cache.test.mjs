import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCountKey, createTokenCountCache, describeCountableMessage, hashContent } from '../src/tokens/cache.js';

function createMemoryStorage(initial = null) {
    return {
        backend: 'memory',
        value: initial,
        writes: 0,
        async read() {
            return this.value;
        },
        async write(value) {
            this.value = value;
            this.writes += 1;
        },
        async clear() {
            this.value = null;
        },
    };
}

function createCache({ settings = {}, onCount = () => 10, storage = createMemoryStorage() } = {}) {
    const config = {
        persistentTokenCache: true,
        tokenCacheLimit: 100,
        ...settings,
    };
    const diagnostics = { info() {}, warn() {}, noteOnce() {} };
    const cache = createTokenCountCache({
        settings: { get: () => config },
        diagnostics,
        namespace: 'test',
        resolveModel: settings2 => settings2?.model ?? 'gpt-4o',
        storage,
    });
    const original = async (messages, full) => {
        const calls = original.calls += 1;
        return onCount(messages, full, calls);
    };
    original.calls = 0;
    return { cache, original, config, storage };
}

test('hashContent is stable and content sensitive', () => {
    assert.equal(hashContent('hello'), hashContent('hello'));
    assert.equal(hashContent('hello').length, 16);
    assert.notEqual(hashContent('hello'), hashContent('hello '));
});

test('count keys separate model, role, name and length', () => {
    const base = { model: 'gpt-4o', full: false, role: 'system', name: '', content: 'abc' };
    const expected = buildCountKey(base);

    assert.equal(buildCountKey({ ...base }), expected);
    assert.notEqual(buildCountKey({ ...base, model: 'claude' }), expected);
    assert.notEqual(buildCountKey({ ...base, full: true }), expected);
    assert.notEqual(buildCountKey({ ...base, role: 'user' }), expected);
    assert.notEqual(buildCountKey({ ...base, name: 'Main' }), expected);
    assert.notEqual(buildCountKey({ ...base, content: 'abcd' }), expected);
});

test('only plain single messages are countable', () => {
    assert.deepEqual(describeCountableMessage({ role: 'system', content: 'x' }), { role: 'system', name: '', content: 'x' });
    assert.equal(describeCountableMessage([{ role: 'system', content: 'x' }]), null);
    assert.equal(describeCountableMessage({ role: 'system', content: [{ type: 'text' }] }), null);
    assert.equal(describeCountableMessage(null), null);
});

test('identical messages are counted once', async () => {
    const { cache, original } = createCache();
    const counting = cache.memoize(original);
    const message = { role: 'system', content: 'Main prompt' };

    assert.equal(await counting(message, false, { model: 'gpt-4o' }), 10);
    assert.equal(await counting({ ...message }, false, { model: 'gpt-4o' }), 10);
    assert.equal(original.calls, 1);
    assert.equal(cache.stats.hits, 1);
});

test('different roles, models and full flags do not share entries', async () => {
    const { cache, original } = createCache();
    const counting = cache.memoize(original);

    await counting({ role: 'system', content: 'x' }, false, { model: 'gpt-4o' });
    await counting({ role: 'user', content: 'x' }, false, { model: 'gpt-4o' });
    await counting({ role: 'system', content: 'x' }, true, { model: 'gpt-4o' });
    await counting({ role: 'system', content: 'x' }, false, { model: 'claude' });

    assert.equal(original.calls, 4);
});

test('array inputs always go to the upstream function', async () => {
    const { cache, original } = createCache();
    const counting = cache.memoize(original);
    const messages = [{ role: 'system', content: 'x' }];

    await counting(messages, false, { model: 'gpt-4o' });
    await counting(messages, false, { model: 'gpt-4o' });

    assert.equal(original.calls, 2);
    assert.equal(cache.stats.hits, 0);
});

test('a failing model resolver degrades to the upstream call', async () => {
    const { cache, original } = createCache();
    const counting = cache.memoize(original);
    const unusable = createTokenCountCache({
        settings: { get: () => ({ persistentTokenCache: true, tokenCacheLimit: 10 }) },
        diagnostics: { info() {}, warn() {}, noteOnce() {} },
        namespace: 'test',
        resolveModel: () => {
            throw new Error('no tokenizer');
        },
        storage: createMemoryStorage(),
    }).memoize(original);

    await counting({ role: 'system', content: 'x' }, false, { model: 'gpt-4o' });
    await unusable({ role: 'system', content: 'x' }, false, { model: 'gpt-4o' });
    await unusable({ role: 'system', content: 'x' }, false, { model: 'gpt-4o' });

    assert.equal(original.calls, 3);
});

test('the LRU bound evicts the oldest entry', async () => {
    const { cache, original, config } = createCache({ settings: { tokenCacheLimit: 100 } });
    const counting = cache.memoize(original);
    config.tokenCacheLimit = 2;

    await counting({ role: 'system', content: 'a' }, false, { model: 'm' });
    await counting({ role: 'system', content: 'b' }, false, { model: 'm' });
    await counting({ role: 'system', content: 'c' }, false, { model: 'm' });

    assert.equal(cache.size(), 2);
    assert.equal(cache.stats.evictions, 1);
});

test('persisted entries are restored and reused across sessions', async () => {
    const storage = createMemoryStorage();

    const first = createCache({ storage });
    await first.cache.memoize(first.original)({ role: 'system', content: 'persisted' }, false, { model: 'm' });
    await first.cache.flush();

    assert.equal(storage.writes, 1);

    const second = createCache({ storage });
    const counting = second.cache.memoize(second.original);
    const value = await counting({ role: 'system', content: 'persisted' }, false, { model: 'm' });

    assert.equal(value, 10);
    assert.equal(second.original.calls, 0);
    assert.equal(second.cache.stats.hits, 1);
});

test('unknown persisted shapes are ignored instead of poisoning the cache', async () => {
    const storage = createMemoryStorage({ version: 99, entries: [['a', 1]] });
    const { cache, original } = createCache({ storage });
    const counting = cache.memoize(original);

    await counting({ role: 'system', content: 'x' }, false, { model: 'm' });

    assert.equal(original.calls, 1);
    assert.equal(cache.stats.hits, 0);
});

test('disabling persistence keeps the cache in memory only', async () => {
    const storage = createMemoryStorage();
    const { cache, original } = createCache({ settings: { persistentTokenCache: false }, storage });
    const counting = cache.memoize(original);

    await counting({ role: 'system', content: 'x' }, false, { model: 'm' });
    await cache.flush();

    assert.equal(storage.writes, 0);
    assert.equal(storage.value, null);
    assert.equal(await counting({ role: 'system', content: 'x' }, false, { model: 'm' }), 10);
    assert.equal(original.calls, 1);
});

test('clear empties both memory and storage', async () => {
    const storage = createMemoryStorage();
    const { cache, original } = createCache({ storage });
    const counting = cache.memoize(original);

    await counting({ role: 'system', content: 'x' }, false, { model: 'm' });
    await cache.flush();
    await cache.clear();
    await counting({ role: 'system', content: 'x' }, false, { model: 'm' });

    assert.equal(storage.value, null);
    assert.equal(original.calls, 2);
});
