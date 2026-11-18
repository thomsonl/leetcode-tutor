// The extension's own saved mode and prompts (shared/extension-settings.js):
// a backend is built with the mode's instructions, a change to either
// rebuilds it, and bad input is refused.

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, backendKey, buildBackend, emptySecrets, emptySettings, normalizeSettings, publicView, statusSummary } from './shared/extension-settings.js';
import { DEFAULT_PROMPTS, systemMessageFor } from './shared/tutor-prompt.js';

const MINE = 'Be terse. Ask one question per reply and never give code.';

function local() {
  return applyPatch(emptySettings(), emptySecrets(), { provider: 'local', providers: { local: { model: 'm1' } } });
}

test('a backend is built with the instructions of the mode, the student\'s own or the default', () => {
  const base = local();
  assert.equal(base.settings.mode, 'tutor');
  assert.equal(buildBackend(base.settings, base.secrets).systemMessage.content, systemMessageFor('tutor'));
  const interviewer = applyPatch(base.settings, base.secrets, { mode: 'interviewer' });
  assert.equal(buildBackend(interviewer.settings, interviewer.secrets).systemMessage.content, systemMessageFor('interviewer'));
  const custom = applyPatch(interviewer.settings, interviewer.secrets, { mode: 'tutor', prompts: { tutor: MINE } });
  assert.ok(buildBackend(custom.settings, custom.secrets).systemMessage.content.startsWith(MINE));
  // The Anthropic provider takes it too.
  const anthropic = applyPatch(base.settings, base.secrets, { provider: 'anthropic', providers: { anthropic: { apiKey: 'sk-ant-x' } }, mode: 'interviewer' });
  assert.equal(buildBackend(anthropic.settings, anthropic.secrets).systemMessage.content, systemMessageFor('interviewer'));
});

test('a new mode or prompt rebuilds the backend; the same settings keep it', () => {
  const base = local();
  const interviewer = applyPatch(base.settings, base.secrets, { mode: 'interviewer' });
  const custom = applyPatch(base.settings, base.secrets, { prompts: { tutor: MINE } });
  assert.notEqual(backendKey(base.settings, base.secrets), backendKey(interviewer.settings, interviewer.secrets));
  assert.notEqual(backendKey(base.settings, base.secrets), backendKey(custom.settings, custom.secrets));
  assert.equal(backendKey(base.settings, base.secrets), backendKey(normalizeSettings(base.settings), base.secrets));
});

test('patches name only the prompts that change, null resets one, and bad input is refused', () => {
  const base = local();
  const both = applyPatch(base.settings, base.secrets, { prompts: { tutor: MINE, interviewer: 'Grill me about complexity, one question at a time.' } });
  const reset = applyPatch(both.settings, both.secrets, { prompts: { tutor: null } });
  assert.deepEqual(reset.settings.prompts, { tutor: null, interviewer: 'Grill me about complexity, one question at a time.' });
  assert.equal(applyPatch(both.settings, both.secrets, { prompts: { tutor: DEFAULT_PROMPTS.tutor } }).settings.prompts.tutor, null, 'the default text is stored as no change');
  assert.throws(() => applyPatch(base.settings, base.secrets, { mode: 'pirate' }), /unknown mode/);
  assert.throws(() => applyPatch(base.settings, base.secrets, { prompts: { tutor: 'tiny' } }), /at least/);
  assert.throws(() => applyPatch(base.settings, base.secrets, { prompts: [] }), /must be an object/);
  assert.equal(normalizeSettings({ mode: 'pirate', prompts: { tutor: 5 } }).mode, 'tutor');
});

test('the page and the panel are told the mode, and the page gets the defaults to edit and reset', () => {
  const base = local();
  const custom = applyPatch(base.settings, base.secrets, { mode: 'interviewer', prompts: { tutor: MINE } });
  const view = publicView(custom.settings, custom.secrets);
  assert.equal(view.mode, 'interviewer');
  assert.deepEqual(view.prompts, { tutor: MINE, interviewer: null });
  assert.equal(view.promptDefaults.interviewer, DEFAULT_PROMPTS.interviewer);
  assert.ok(view.promptMaxChars > 1000);
  assert.equal(statusSummary(custom.settings).mode, 'interviewer');
});
