import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNINSTALL_PAGE, registerUninstallPage } from './shared/uninstall-page.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('registers the uninstall page with the browser', () => {
  const seen = [];
  assert.equal(registerUninstallPage({ setUninstallURL: (url) => seen.push(url) }), true);
  assert.deepEqual(seen, [UNINSTALL_PAGE]);
});

test('the uninstall page address is a plain https link that carries nothing about the user', () => {
  const url = new URL(UNINSTALL_PAGE);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.search, '');
  assert.equal(url.hash, '#uninstall');
});

test('a browser without the call, or one that rejects or throws, is skipped quietly', async () => {
  assert.equal(registerUninstallPage({}), false);
  assert.equal(registerUninstallPage(null), false);
  assert.equal(registerUninstallPage({ setUninstallURL: () => { throw new Error('no'); } }), false);
  assert.equal(registerUninstallPage({ setUninstallURL: () => Promise.reject(new Error('no')) }), true);
  await new Promise((resolve) => setImmediate(resolve));
});

test('the worker registers it and the README has the section it points at', () => {
  const worker = fs.readFileSync(path.join(here, 'background.js'), 'utf8');
  assert.match(worker, /registerUninstallPage\(api\.runtime\)/);
  const readme = fs.readFileSync(path.join(here, '..', 'README.md'), 'utf8');
  assert.match(readme, /^## Uninstall$/m);
  assert.match(readme, /npx leetcode-capture-helper uninstall/);
});
