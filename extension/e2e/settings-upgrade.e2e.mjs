// End-to-end check that a student's data survives an update, in the REAL
// unpacked extension (Playwright's cached Chromium).
//
// The browser's own update cannot be staged here, but what it does to the
// data is the same as reloading the extension: storage.local stays and the
// worker starts again on the new code. So the records the 1.3.0 release wrote
// (settings with their saved models, an API key, solved problems, stars, the
// chosen list and the Tutor tab's place) are put in storage, the extension is
// reloaded, and everything is read back through the real options page.
//
// Run with:  node extension/e2e/settings-upgrade.e2e.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionCopy, launch } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');

const OLD = {
  tutorSettings: {
    version: 2,
    provider: 'local',
    runtimes: { local: 'extension', anthropic: 'extension', openai: 'extension' },
    providers: {
      local: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', contextTokens: 32768 },
      anthropic: { model: null },
      openai: { model: 'gpt-5-mini', baseUrl: 'https://api.openai.com/v1' },
    },
    options: { autoClearContext: false, localMaxHistoryTurns: 3 },
    profiles: [
      { id: 'default', provider: 'local', model: 'qwen3:8b', label: 'Qwen' },
      { id: 'openai-1a2b3c4d', provider: 'openai', model: 'gpt-5-mini', label: null },
    ],
    activeProfile: 'default',
  },
  tutorSecrets: { local: null, anthropic: null, openai: 'sk-saved-for-the-upgrade-test-0002' },
  solvedProblems: { 'two-sum': { at: 1760000000000, count: 2 }, 'valid-parentheses': { at: 1760000100000, count: 1, manual: true } },
  starredProblems: { 'two-sum': true },
  activeProgressList: 'blind75',
  solvedSyncedAt: 1760000200000,
  tutorTabPosition: { mode: 'tabset', anchors: ['description'], after: true, index: 1 },
};

const copy = extensionCopy(extensionDir, { extraHosts: ['http://127.0.0.1/*'] });
const browser = await launch({ extensionDir: copy.dir });
let failed = false;
try {
  await browser.serviceWorkerEval(`chrome.storage.local.set(${JSON.stringify(OLD)})`);
  // The browser's update restarts the worker on the new code; this does the same.
  await browser.reloadExtension();

  const options = await browser.openPage('about:blank');
  await options.failFetch('http://localhost:8135/*');
  await options.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html` });
  await options.waitFor(`document.getElementById('connection-text').textContent !== 'Connecting'`, { what: 'the options page' });

  const rows = await options.eval(`[...document.querySelectorAll('#profiles .profile')].map((r) => ({ name: r.querySelector('.profile-name').textContent, isDefault: r.hasAttribute('data-default') }))`);
  assert.deepEqual(rows, [{ name: 'Qwen', isDefault: true }, { name: 'gpt-5-mini', isDefault: false }], 'every saved model, its name, and which is the default');
  assert.equal(await options.eval(`document.getElementById('local-baseUrl').value`), 'http://127.0.0.1:11434/v1');
  assert.equal(await options.eval(`document.getElementById('local-contextTokens').value`), '32768');
  assert.equal(await options.eval(`document.getElementById('autoClearContext').checked`), false);
  assert.equal(await options.eval(`document.getElementById('localMaxHistoryTurns').value`), '3');
  assert.match(await options.eval(`document.getElementById('connection-text').textContent`), /Tutor running in the browser: Local model, qwen3:8b/);
  // Nothing the update added changes what the tutor does until the student chooses: the Tutor prompt, as shipped.
  assert.match(await options.eval(`document.getElementById('prompts-body').textContent`), /Default prompt/);

  const stored = await browser.serviceWorkerEval(`chrome.storage.local.get(null)`);
  assert.equal(stored.tutorSecrets.openai, OLD.tutorSecrets.openai, 'the saved API key');
  assert.deepEqual(stored.solvedProblems, OLD.solvedProblems, 'solved problems');
  assert.deepEqual(stored.starredProblems, OLD.starredProblems, 'stars');
  assert.equal(stored.activeProgressList, 'blind75', 'the chosen list');
  assert.equal(stored.solvedSyncedAt, OLD.solvedSyncedAt, 'the last sync time');
  assert.deepEqual(stored.tutorTabPosition, OLD.tutorTabPosition, 'the Tutor tab\'s place');
  assert.deepEqual(stored.tutorSettings, OLD.tutorSettings, 'opening the page rewrote nothing');
  assert.equal(await options.eval(`document.documentElement.outerHTML.includes('sk-saved-for-the-upgrade-test-0002')`), false, 'the key is not in the page');
  console.log('ok   a 1.3.0 student\'s settings, key, progress and tab place survive an update');
} catch (err) {
  failed = true;
  console.log(`FAIL a 1.3.0 student's data after an update\n     ${err.stack.split('\n').slice(0, 8).join('\n     ')}`);
} finally {
  await browser.close();
  copy.cleanup();
}
process.exit(failed ? 1 : 0);
