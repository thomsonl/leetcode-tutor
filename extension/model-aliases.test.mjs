import assert from 'node:assert/strict';
import test from 'node:test';
import { OPENAI_FAMILIES, OPENAI_NEWEST_KNOWN, canonicalModel, createOpenAIResolver, familyOf, newestInFamily, resolveKnown } from './shared/model-aliases.js';
import { cleanProfile } from './shared/profiles.js';
import { PROVIDERS } from './shared/providers.js';

test('every family has a known newest model of its own', () => {
  for (const family of OPENAI_FAMILIES) assert.match(OPENAI_NEWEST_KNOWN[family], new RegExp(`^gpt-\\d+(\\.\\d+)*-${family}$`));
});

test('the newest of a family is the highest plain version, never a snapshot or a variant', () => {
  const ids = ['gpt-6-luna', 'gpt-6.1-luna', 'gpt-6.2-luna', 'gpt-6.10-luna', 'gpt-6.2-luna-2026-01-01', 'gpt-6.9-luna-mini', 'gpt-7-sol', 'gpt-5-luna'];
  assert.equal(newestInFamily('luna', ids), 'gpt-6.10-luna');
  assert.equal(newestInFamily('sol', ids), 'gpt-7-sol');
  assert.equal(newestInFamily('astra', ids), null);
  assert.equal(newestInFamily('luna', null), null);
});

test('a family name resolves to the newest known model; a typed name stays', () => {
  assert.equal(familyOf('luna'), 'luna');
  assert.equal(familyOf('gpt-6-luna'), null);
  assert.equal(resolveKnown('luna'), OPENAI_NEWEST_KNOWN.luna);
  assert.equal(resolveKnown('my-fine-tune'), 'my-fine-tune');
});

test('the three IDs this extension used to offer are saved as their family; other names are left alone', () => {
  assert.equal(canonicalModel('chatgpt', 'gpt-6-luna'), 'luna');
  assert.equal(canonicalModel('openai', 'gpt-6.2-sol'), 'sol');
  assert.equal(canonicalModel('openai', 'gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(canonicalModel('local', 'gpt-6-luna'), 'gpt-6-luna');
  assert.equal(cleanProfile({ id: 'chatgpt-1', provider: 'chatgpt', model: 'gpt-6-luna', label: null }, PROVIDERS).model, 'luna');
  assert.equal(cleanProfile({ id: 'local-1', provider: 'local', model: 'gpt-6-luna', label: null }, PROVIDERS).model, 'gpt-6-luna');
});

function listFetch(ids, calls) {
  return async (url, options) => {
    calls.push({ url, auth: options.headers.Authorization });
    return { ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) };
  };
}

test('the resolver reads the live list, uses the newest, and asks again only after an hour', async () => {
  const calls = [];
  let t = 0;
  const resolve = createOpenAIResolver({ fetchImpl: listFetch(['gpt-6-luna', 'gpt-6.3-luna'], calls), now: () => t });
  const opts = { baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-test' };
  assert.equal(await resolve('luna', opts), 'gpt-6.3-luna');
  assert.equal(await resolve('luna', opts), 'gpt-6.3-luna');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { url: 'https://api.openai.com/v1/models', auth: 'Bearer sk-test' });
  t += 61 * 60 * 1000;
  await resolve('luna', opts);
  assert.equal(calls.length, 2);
  assert.equal(await resolve('my-fine-tune', opts), 'my-fine-tune');
  assert.equal(calls.length, 2, 'a typed name never asks');
});

test('when the list cannot be read, or lacks the family, the newest known model is used, and a failure is retried soon', async () => {
  let t = 0;
  let attempts = 0;
  const broken = createOpenAIResolver({ fetchImpl: async () => { attempts += 1; throw new Error('offline'); }, now: () => t });
  assert.equal(await broken('sol', { baseUrl: 'https://x/v1' }), OPENAI_NEWEST_KNOWN.sol);
  await broken('sol', { baseUrl: 'https://x/v1' });
  assert.equal(attempts, 1);
  t += 61 * 1000;
  await broken('sol', { baseUrl: 'https://x/v1' });
  assert.equal(attempts, 2);
  const refused = createOpenAIResolver({ fetchImpl: async () => ({ ok: false, status: 401 }), now: () => t });
  assert.equal(await refused('astra', { baseUrl: 'https://x/v1' }), OPENAI_NEWEST_KNOWN.astra);
  const without = createOpenAIResolver({ fetchImpl: listFetch(['gpt-4o'], []), now: () => t });
  assert.equal(await without('luna', { baseUrl: 'https://x/v1' }), OPENAI_NEWEST_KNOWN.luna);
});
