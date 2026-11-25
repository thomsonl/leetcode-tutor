// shared/update-notice.js: an update is noticed once, only when the version
// really changed, and goes away when seen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BADGE_TEXT, UPDATE_KEY, createUpdateNotice } from './shared/update-notice.js';

function setup(version = '1.4.0', initial = {}) {
  const data = { ...initial };
  const badges = [];
  const storage = {
    data,
    async get(keys) {
      const out = {};
      for (const key of keys) if (key in data) out[key] = structuredClone(data[key]);
      return out;
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const key of keys) delete data[key];
    },
  };
  const state = { version };
  const notice = createUpdateNotice({ storage, badge: { set: async (text) => badges.push(text) }, version: () => state.version });
  return { notice, storage, badges, state };
}

test('an update to a new version is remembered and badged', async () => {
  const { notice, storage, badges } = setup('1.4.0');
  assert.equal(await notice.onInstalled({ reason: 'update', previousVersion: '1.3.0' }), true);
  assert.deepEqual(storage.data[UPDATE_KEY], { from: '1.3.0', to: '1.4.0' });
  assert.deepEqual(badges, [BADGE_TEXT]);
  assert.deepEqual(await notice.pending(), { from: '1.3.0', to: '1.4.0' });
});

test('a first install, a reload at the same version, a browser update and junk are not updates', async () => {
  const { notice, storage, badges } = setup('1.4.0');
  for (const details of [
    { reason: 'install' },
    { reason: 'update', previousVersion: '1.4.0' },
    { reason: 'chrome_update' },
    { reason: 'shared_module_update' },
    {},
    null,
    undefined,
  ]) assert.equal(await notice.onInstalled(details), false, JSON.stringify(details));
  assert.deepEqual(storage.data, {});
  assert.deepEqual(badges, []);
  // A manifest with no proper version cannot be an update either.
  const odd = setup('dev');
  assert.equal(await odd.notice.onInstalled({ reason: 'update', previousVersion: '1.3.0' }), false);
});

test('an update from a version nobody can name is still noted, without a from', async () => {
  const { notice, storage } = setup('1.4.0');
  assert.equal(await notice.onInstalled({ reason: 'update' }), true);
  assert.deepEqual(storage.data[UPDATE_KEY], { from: null, to: '1.4.0' });
});

test('an update on top of one that was never looked at keeps the first from', async () => {
  const { notice, storage, state } = setup('1.4.0');
  await notice.onInstalled({ reason: 'update', previousVersion: '1.2.0' });
  state.version = '1.5.0';
  await notice.onInstalled({ reason: 'update', previousVersion: '1.4.0' });
  assert.deepEqual(storage.data[UPDATE_KEY], { from: '1.2.0', to: '1.5.0' });
  // An unrelated earlier note does not leak in.
  state.version = '1.7.0';
  await notice.onInstalled({ reason: 'update', previousVersion: '1.6.0' });
  assert.deepEqual(storage.data[UPDATE_KEY], { from: '1.6.0', to: '1.7.0' });
});

test('seeing it clears the note and the badge, and it does not come back at the next start', async () => {
  const { notice, storage, badges } = setup('1.4.0');
  await notice.onInstalled({ reason: 'update', previousVersion: '1.3.0' });
  await notice.seen();
  assert.deepEqual(storage.data, {});
  assert.equal(badges.at(-1), '');
  assert.equal(await notice.pending(), null);
  await notice.refreshBadge();
  assert.equal(badges.at(-1), '');
});

test('the badge comes back at the next start while the update is unseen, and a stale note is ignored', async () => {
  const { notice, badges, state, storage } = setup('1.4.0', { [UPDATE_KEY]: { from: '1.3.0', to: '1.4.0' } });
  await notice.refreshBadge();
  assert.equal(badges.at(-1), BADGE_TEXT);
  state.version = '1.3.0';
  await notice.refreshBadge();
  assert.equal(badges.at(-1), '', 'a note for a version that is not running is not shown');
  assert.equal(await notice.pending(), null);
  assert.ok(storage.data[UPDATE_KEY], 'but it is not thrown away');
});

test('a storage or badge failure never throws', async () => {
  const broken = createUpdateNotice({
    storage: { get: async () => { throw new Error('no storage'); }, set: async () => { throw new Error('no storage'); }, remove: async () => { throw new Error('no storage'); } },
    badge: { set: () => { throw new Error('no badge'); } },
    version: () => '1.4.0',
  });
  assert.equal(await broken.pending(), null);
  assert.equal(await broken.onInstalled({ reason: 'update', previousVersion: '1.3.0' }), false);
  await broken.seen();
  await broken.refreshBadge();
});

test('junk in storage is not a note', async () => {
  for (const junk of [null, 7, 'x', [], {}, { to: 5 }, { to: '1.4' }, { from: '1.3.0' }]) {
    const { notice } = setup('1.4.0', { [UPDATE_KEY]: junk });
    assert.equal(await notice.pending(), null, JSON.stringify(junk));
  }
  const { notice } = setup('1.4.0', { [UPDATE_KEY]: { from: 'weird', to: '1.4.0' } });
  assert.deepEqual(await notice.pending(), { from: null, to: '1.4.0' });
});
