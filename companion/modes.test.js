// The helper's saved mode and prompts (settings.js): validated, partial
// patches, saved to disk, and reported to the options page and the panel.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPatch, emptySettings, loadSettings, publicView, resolveEffective, sanitizeStored, saveSettings, statusSummary } from './settings.js';
import { DEFAULT_PROMPTS } from '../extension/shared/tutor-prompt.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-modes-test-'));
  return path.join(dir, 'nested', 'settings.json');
}

const MINE = 'Be terse. Ask one question per reply and never give code.';
const GRILL = 'Grill me about complexity, one question at a time.';

test('a fresh record is in tutor mode with the default prompts', () => {
  const fresh = emptySettings();
  assert.equal(fresh.mode, 'tutor');
  assert.deepEqual(fresh.prompts, { tutor: null, interviewer: null });
});

test('a patch sets the mode and only the prompts it names; null goes back to the default', () => {
  let stored = applyPatch(emptySettings(), { mode: 'interviewer', prompts: { tutor: MINE } });
  assert.equal(stored.mode, 'interviewer');
  assert.deepEqual(stored.prompts, { tutor: MINE, interviewer: null });
  stored = applyPatch(stored, { prompts: { interviewer: GRILL } });
  assert.equal(stored.prompts.tutor, MINE, 'the other mode is left alone');
  stored = applyPatch(stored, { prompts: { tutor: null } });
  assert.deepEqual(stored.prompts, { tutor: null, interviewer: GRILL });
  // The default text itself is stored as "no change", so a later update can improve it.
  assert.equal(applyPatch(stored, { prompts: { interviewer: DEFAULT_PROMPTS.interviewer } }).prompts.interviewer, null);
});

test('a bad mode or prompt is refused and the original is untouched', () => {
  const stored = applyPatch(emptySettings(), { prompts: { tutor: MINE } });
  const before = JSON.stringify(stored);
  assert.throws(() => applyPatch(stored, { mode: 'pirate' }), /unknown mode/);
  assert.throws(() => applyPatch(stored, { prompts: { tutor: 'tiny' } }), /at least/);
  assert.throws(() => applyPatch(stored, { prompts: 'x' }), /must be an object/);
  assert.equal(JSON.stringify(stored), before);
});

test('mode and prompts survive a save and a load, and junk on disk falls back to the defaults', () => {
  const stored = applyPatch(emptySettings(), { mode: 'interviewer', prompts: { interviewer: GRILL } });
  const file = tmpFile();
  saveSettings(stored, file);
  const loaded = loadSettings(file).settings;
  assert.equal(loaded.mode, 'interviewer');
  assert.deepEqual(loaded.prompts, { tutor: null, interviewer: GRILL });
  const sane = sanitizeStored({ mode: 'pirate', prompts: { tutor: 7, interviewer: 'ok' } });
  assert.equal(sane.mode, 'tutor');
  assert.deepEqual(sane.prompts, { tutor: null, interviewer: null });
});

test('the options page and the panel are told the mode, and the page gets the defaults to edit and reset', () => {
  const stored = applyPatch(emptySettings(), { mode: 'interviewer', prompts: { tutor: MINE } });
  const view = publicView(stored, {}, tmpFile());
  assert.equal(view.mode, 'interviewer');
  assert.deepEqual(view.prompts, { tutor: MINE, interviewer: null });
  assert.equal(view.promptDefaults.tutor, DEFAULT_PROMPTS.tutor);
  assert.equal(view.promptDefaults.interviewer, DEFAULT_PROMPTS.interviewer);
  assert.ok(view.promptMaxChars > 1000);
  const effective = resolveEffective(stored, {});
  assert.equal(effective.mode, 'interviewer');
  assert.equal(statusSummary(effective).mode, 'interviewer');
});
