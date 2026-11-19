// What a student's saved settings do across an update: the records every
// shipped version wrote (storage.local keeps them through an update, so the
// code must read them back whole) and the ones this version writes.
//
// The fixtures are written out in full, not built by emptySettings(), so a
// change to the code cannot change the old record with it. When a version
// changes what it stores, add that version's record here and keep the old ones.

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, normalizeSecrets, normalizeSettings, publicView } from './shared/extension-settings.js';

// 1.2.0: one provider and its fields, no list of models yet.
const V1_2_0 = {
  version: 2,
  provider: 'anthropic',
  runtimes: { local: 'extension', anthropic: 'extension', openai: 'extension' },
  providers: {
    local: { baseUrl: 'http://localhost:11434/v1', model: null, contextTokens: 16384 },
    anthropic: { model: 'claude-opus-5-5' },
    openai: { model: null, baseUrl: 'https://api.openai.com/v1' },
  },
  options: { autoClearContext: false, localMaxHistoryTurns: 9 },
};

// 1.3.0: the list of models and the default, still no mode or prompts.
const V1_3_0 = {
  version: 2,
  provider: 'local',
  runtimes: { local: 'extension', anthropic: 'extension', openai: 'extension' },
  providers: {
    local: { baseUrl: 'http://192.168.1.20:11434/v1', model: 'qwen3:8b', contextTokens: 32768 },
    anthropic: { model: null },
    openai: { model: 'gpt-5-mini', baseUrl: 'https://api.openai.com/v1' },
  },
  options: { autoClearContext: true, localMaxHistoryTurns: 3 },
  profiles: [
    { id: 'default', provider: 'local', model: 'qwen3:8b', label: 'Qwen' },
    { id: 'openai-1a2b3c4d', provider: 'openai', model: 'gpt-5-mini', label: null },
    { id: 'claude-5e6f7a8b', provider: 'claude', model: 'sonnet', label: null },
  ],
  activeProfile: 'default',
};

const SECRETS = { local: 'lm-studio-key', anthropic: 'sk-ant-saved-0001', openai: 'sk-saved-0002' };

test('a 1.3.0 record reads back whole, and gains the default mode and prompts', () => {
  const s = normalizeSettings(V1_3_0);
  assert.equal(s.provider, 'local');
  assert.deepEqual(s.providers.local, V1_3_0.providers.local);
  assert.deepEqual(s.providers.openai, V1_3_0.providers.openai);
  assert.deepEqual(s.options, V1_3_0.options);
  assert.deepEqual(s.profiles, V1_3_0.profiles, 'every saved model, its name and its order');
  assert.equal(s.activeProfile, 'default');
  assert.equal(s.mode, 'tutor');
  assert.deepEqual(s.prompts, { tutor: null, interviewer: null }, 'nobody edited a prompt, so the shipped default is used');
});

test('a 1.2.0 record (no list of models) becomes one saved model with its fields intact', () => {
  const s = normalizeSettings(V1_2_0);
  assert.equal(s.provider, 'anthropic');
  assert.deepEqual(s.profiles.map((p) => [p.provider, p.model]), [['anthropic', 'claude-opus-5-5']]);
  assert.equal(s.activeProfile, s.profiles[0].id);
  assert.deepEqual(s.providers.local, V1_2_0.providers.local, 'the other providers keep what was set');
  assert.deepEqual(s.options, V1_2_0.options);
});

test('saved API keys are read back for every shipped record, and the page is only ever told that one exists', () => {
  assert.deepEqual(normalizeSecrets(SECRETS), SECRETS);
  for (const record of [V1_2_0, V1_3_0]) {
    const view = publicView(record, SECRETS);
    assert.deepEqual([view.providers.anthropic.hasKey, view.providers.openai.hasKey, view.providers.local.hasKey], [true, true, true]);
    assert.equal(JSON.stringify(view).includes('sk-ant-saved-0001'), false);
  }
});

test('the first change after an update keeps everything the student had set', () => {
  const { settings, secrets } = applyPatch(V1_3_0, SECRETS, { options: { autoClearContext: false } });
  assert.equal(settings.options.autoClearContext, false);
  assert.equal(settings.options.localMaxHistoryTurns, 3);
  assert.deepEqual(settings.profiles, V1_3_0.profiles);
  assert.equal(settings.activeProfile, 'default');
  assert.deepEqual(settings.providers.local, V1_3_0.providers.local);
  assert.deepEqual(secrets, SECRETS);
});

test('this version\'s record, with a student\'s own prompt and the interviewer mode, round trips', () => {
  const mine = { ...normalizeSettings(V1_3_0), mode: 'interviewer', prompts: { tutor: 'Be brief. Ask me one question at a time.', interviewer: null } };
  const again = normalizeSettings(JSON.parse(JSON.stringify(mine)));
  assert.deepEqual(again, mine);
});

test('a record with something invalid in it keeps the rest instead of resetting', () => {
  const broken = {
    ...V1_3_0,
    providers: { ...V1_3_0.providers, local: { ...V1_3_0.providers.local, baseUrl: 'not a url', contextTokens: 5 } },
    options: { autoClearContext: 'yes', localMaxHistoryTurns: 3 },
  };
  const s = normalizeSettings(broken);
  assert.equal(s.providers.local.model, 'qwen3:8b', 'the model survives a bad URL');
  assert.deepEqual(s.profiles, V1_3_0.profiles);
  assert.equal(s.options.localMaxHistoryTurns, 3);
  assert.equal(s.provider, 'local');
});
