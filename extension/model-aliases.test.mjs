import assert from 'node:assert/strict';
import test from 'node:test';
import { FALLBACK_NEWEST, FALLBACK_TIERS, canonicalModel, createOpenAIResolver, idsFromCodexCatalog, newestInTier, parseModelId, resolveFromIds, tierLabel, tierOf, tiersFrom } from './shared/model-aliases.js';
import { cleanProfile, modelName } from './shared/profiles.js';
import { PROVIDERS } from './shared/providers.js';

test('a plain gpt-<version>-<tier> id is understood; snapshots, variants and other names are not', () => {
  assert.deepEqual(parseModelId('gpt-6.2-sol'), { version: [6, 2], tier: 'sol' });
  assert.deepEqual(parseModelId('gpt-7-quasar'), { version: [7], tier: 'quasar' });
  for (const id of ['gpt-6.2-sol-2026-01-01', 'gpt-6-luna-mini', 'o3', 'gpt-reserve', 'codex-auto-review', 'claude-opus-5-5', null, 5]) assert.equal(parseModelId(id), null, String(id));
});

test('the newest of a tier is the highest plain version, with any tier name', () => {
  const ids = ['gpt-6-luna', 'gpt-6.1-luna', 'gpt-6.10-luna', 'gpt-6.2-luna', 'gpt-6.2-luna-2026-01-01', 'gpt-6.9-luna-mini', 'gpt-7-sol', 'gpt-5-luna', 'gpt-8-quasar'];
  assert.equal(newestInTier('luna', ids), 'gpt-6.10-luna');
  assert.equal(newestInTier('sol', ids), 'gpt-7-sol');
  assert.equal(newestInTier('quasar', ids), 'gpt-8-quasar', 'a tier nobody has heard of yet works');
  assert.equal(newestInTier('astra', ids), null);
  assert.equal(newestInTier('luna', null), null);
});

test('the tiers come from the list itself, those with the newest models first', () => {
  assert.deepEqual(tiersFrom(['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-reserve']), ['astra', 'sol', 'terra', 'luna']);
  assert.deepEqual(tiersFrom(['gpt-9-zenith', 'gpt-6.2-sol']), ['zenith', 'sol']);
  assert.deepEqual(tiersFrom([]), []);
  assert.equal(tierLabel('luna'), 'Luna');
  assert.equal(tierLabel('zenith'), 'Zenith');
});

test('a tier is a single lowercase word; an exact model name is never treated as one', () => {
  assert.equal(tierOf('luna'), 'luna');
  for (const exact of ['gpt-6.1-sol', 'o3', 'my-fine-tune', 'Luna', '', null]) assert.equal(tierOf(exact), null, String(exact));
  assert.equal(resolveFromIds('luna', ['gpt-6-luna', 'gpt-6.3-luna']), 'gpt-6.3-luna');
  assert.equal(resolveFromIds('gpt-6.1-sol', ['gpt-7-sol']), 'gpt-6.1-sol');
  assert.equal(resolveFromIds('zenith', ['gpt-6-luna']), null);
});

test('the Codex catalog gives the models it lists to people, and nothing hidden', () => {
  const catalog = { models: [{ slug: 'gpt-6.2-sol', visibility: 'list' }, { slug: 'gpt-reserve', visibility: 'hide' }, { slug: 'gpt-6-luna' }, { visibility: 'list' }] };
  assert.deepEqual(idsFromCodexCatalog(catalog), ['gpt-6.2-sol', 'gpt-6-luna']);
  assert.deepEqual(idsFromCodexCatalog(null), []);
  assert.deepEqual(idsFromCodexCatalog({ models: 'x' }), []);
});

test('the dropdown fallback names a real newest model for each tier it shows', () => {
  for (const tier of FALLBACK_TIERS) assert.equal(parseModelId(FALLBACK_NEWEST[tier]).tier, tier);
});

test('the exact IDs this extension once offered are saved as their tier; any other name is left alone', () => {
  assert.equal(canonicalModel('chatgpt', 'gpt-6-luna'), 'luna');
  assert.equal(canonicalModel('openai', 'gpt-6.2-sol'), 'sol');
  assert.equal(canonicalModel('openai', 'gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(canonicalModel('local', 'gpt-6-luna'), 'gpt-6-luna');
  assert.equal(cleanProfile({ id: 'chatgpt-1', provider: 'chatgpt', model: 'gpt-6-luna', label: null }, PROVIDERS).model, 'luna');
  assert.equal(cleanProfile({ id: 'local-1', provider: 'local', model: 'gpt-6-luna', label: null }, PROVIDERS).model, 'gpt-6-luna');
});

test('a tier is named by its label whatever the tier, an exact model by itself', () => {
  assert.equal(modelName('chatgpt', 'luna'), 'Luna');
  assert.equal(modelName('openai', 'zenith'), 'Zenith');
  assert.equal(modelName('openai', 'gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(modelName('claude', 'opus'), 'Opus');
  assert.equal(modelName('local', 'luna'), 'luna');
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
  const resolve = createOpenAIResolver({ fetchImpl: listFetch(['gpt-6-luna', 'gpt-6.3-luna', 'gpt-9-zenith'], calls), now: () => t });
  const opts = { baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-test' };
  assert.equal(await resolve('luna', opts), 'gpt-6.3-luna');
  assert.equal(await resolve('luna', opts), 'gpt-6.3-luna');
  assert.equal(await resolve('zenith', opts), 'gpt-9-zenith', 'a brand new tier works with no change here');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { url: 'https://api.openai.com/v1/models', auth: 'Bearer sk-test' });
  t += 61 * 60 * 1000;
  await resolve('luna', opts);
  assert.equal(calls.length, 3);
  assert.equal(await resolve('my-fine-tune', opts), 'my-fine-tune');
  assert.equal(await resolve('gpt-6.1-sol', opts), 'gpt-6.1-sol');
  assert.equal(calls.length, 3, 'an exact name never asks');
});

test('when the list cannot be read the last answer is kept; with none, the tier\'s fallback; a failure is retried soon', async () => {
  let t = 0;
  let mode = 'ok';
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (mode === 'down') throw new Error('offline');
    if (mode === 'refused') return { ok: false, status: 401 };
    return { ok: true, json: async () => ({ data: [{ id: 'gpt-6.4-sol' }] }) };
  };
  const resolve = createOpenAIResolver({ fetchImpl, now: () => t });
  const opts = { baseUrl: 'https://x/v1' };
  mode = 'down';
  assert.equal(await resolve('sol', opts), FALLBACK_NEWEST.sol, 'nothing known yet: the fallback');
  await resolve('sol', opts);
  assert.equal(attempts, 1, 'not retried at once');
  t += 61 * 1000;
  mode = 'ok';
  assert.equal(await resolve('sol', opts), 'gpt-6.4-sol');
  t += 61 * 60 * 1000;
  mode = 'refused';
  assert.equal(await resolve('sol', opts), 'gpt-6.4-sol', 'the last good answer survives a failed refresh');
  assert.equal(await resolve('zenith', opts), 'zenith', 'an unknown tier with no list stays as typed');
  mode = 'ok';
  t += 61 * 60 * 1000;
  assert.equal(await resolve('astra', opts), FALLBACK_NEWEST.astra, 'a tier the list lacks gets its fallback');
});
