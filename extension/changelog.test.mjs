// The release notes, the script that turns them into changelog.json, the
// version helpers, and what the Changelog tab shows from them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTES_DIR, NotesError, OUTPUT, buildChangelog, parseNotes, serialize } from './scripts/changelog.mjs';
import { compareVersions, parseVersion } from './shared/version.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('versions parse as x.y.z and compare by number, not by text', () => {
  assert.deepEqual(parseVersion('1.10.2'), [1, 10, 2]);
  for (const bad of ['1.2', '1.2.3.4', 'v1.2.3', '1.2.x', '', null, undefined, 7]) assert.equal(parseVersion(bad), null, String(bad));
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0, '1.10 is newer than 1.9');
  assert.ok(compareVersions('1.2.9', '1.3.0') < 0);
  assert.equal(compareVersions('1.3.0', '1.3.0'), 0);
  assert.equal(compareVersions('nonsense', '1.0.0'), 0, 'not a version: no order');
});

test('a notes file is a date, a blank line and bullets', () => {
  assert.deepEqual(parseNotes('date: 2026-11-18\n\n- Added one.\n- Fixed two.\n'), { date: '2026-11-18', items: ['Added one.', 'Fixed two.'] });
  assert.deepEqual(parseNotes('date: 2026-11-18\r\n\r\n- Added one.\r\n').items, ['Added one.']);
  for (const [text, reason] of [
    ['', /first line must be "date/],
    ['2026-11-18\n\n- A.\n', /first line must be "date/],
    ['date: 2026-13-45\n\n- A.\n', /not a date/],
    ['date: 2026-11-18\n- A.\n', /blank line/],
    ['date: 2026-11-18\n\nAdded something.\n', /must be a bullet/],
    ['date: 2026-11-18\n\n- Added — something.\n', /has a dash/],
    ['date: 2026-11-18\n\n- Added – something.\n', /has a dash/],
    ['date: 2026-11-18\n\n', /at least one bullet/],
  ]) assert.throws(() => parseNotes(text, 'x.md'), (err) => err instanceof NotesError && reason.test(err.message), JSON.stringify(text));
});

test('buildChangelog reads every notes file, newest version first, and refuses a badly named one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-notes-'));
  try {
    fs.writeFileSync(path.join(dir, '1.9.0.md'), 'date: 2026-01-01\n\n- Old.\n');
    fs.writeFileSync(path.join(dir, '1.10.0.md'), 'date: 2026-02-01\n\n- New.\n');
    fs.writeFileSync(path.join(dir, 'README.txt'), 'ignored');
    assert.deepEqual(buildChangelog(dir).releases.map((r) => r.version), ['1.10.0', '1.9.0']);
    fs.writeFileSync(path.join(dir, 'next.md'), 'date: 2026-03-01\n\n- X.\n');
    assert.throws(() => buildChangelog(dir), /must be a version/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('changelog.json is exactly what the release notes generate, so nobody edits it by hand', () => {
  assert.equal(fs.readFileSync(OUTPUT, 'utf8'), serialize(buildChangelog(NOTES_DIR)), 'run: node extension/scripts/changelog.mjs');
});

test('the manifest version has release notes, and no notes are older than the first release listed', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));
  const versions = buildChangelog(NOTES_DIR).releases.map((r) => r.version);
  assert.ok(versions.includes(manifest.version), `write docs/release-notes/${manifest.version}.md for the version in manifest.json`);
});

test('the tab shows only releases that have shipped, newest first', async () => {
  globalThis.chrome = { runtime: { getURL: (f) => f, getManifest: () => ({ version: '1.3.0' }), sendMessage: async () => ({}) } };
  const { releasesUpTo, formatReleaseDate } = await import('./changelog.js');
  const releases = [
    { version: '1.2.0', date: '2026-11-05', items: ['a'] },
    { version: '1.4.0', date: '2026-11-18', items: ['c'] },
    { version: '1.3.0', date: '2026-11-16', items: ['b'] },
    { version: '1.10.0', date: '2027-01-01', items: ['d'] },
    { version: 'junk', date: '2026-01-01', items: ['x'] },
    { version: '1.1.0', date: '2026-01-01' },
  ];
  assert.deepEqual(releasesUpTo(releases, '1.3.0').map((r) => r.version), ['1.3.0', '1.2.0'], 'nothing newer than the running version, nothing malformed');
  assert.deepEqual(releasesUpTo(releases, '1.10.0').map((r) => r.version), ['1.10.0', '1.4.0', '1.3.0', '1.2.0']);
  assert.deepEqual(releasesUpTo(null, '1.3.0'), []);
  assert.match(formatReleaseDate('2026-11-16'), /2026/);
  assert.equal(formatReleaseDate('not a date'), '');
});
