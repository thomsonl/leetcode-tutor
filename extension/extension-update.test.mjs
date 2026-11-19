// Taking the extension's own update when the browser has it: asked for at
// browser start, applied by reloading only when nothing is using the
// extension. A fake runtime and fake timers; no browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionUpdater, MAX_RETRIES } from './shared/extension-update.js';

function fakeTimers() {
  const queue = [];
  return {
    queue,
    setTimeout: (fn, ms) => {
      queue.push({ fn, ms });
      return queue.length;
    },
    clearTimeout() {},
    // Runs the oldest waiting timer.
    async fire() {
      const next = queue.shift();
      if (next) await next.fn();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
  };
}

function setup({ answer = { status: 'no_update' }, inUse = false, reloadThrows = false } = {}) {
  const state = { inUse, reloads: 0, asked: 0, logs: [] };
  const timers = fakeTimers();
  const runtime = {
    requestUpdateCheck: async () => {
      state.asked += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    reload: () => {
      if (reloadThrows) throw new Error('no reload');
      state.reloads += 1;
    },
  };
  const updater = createExtensionUpdater({ runtime, busy: () => state.inUse, timers, log: (t) => state.logs.push(t), retryMs: 1000 });
  return { updater, state, timers, runtime };
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

test('browser start: asks the store, and with nothing open an update is taken at once', async () => {
  const { updater, state } = setup({ answer: { status: 'update_available', version: '1.4.0' } });
  assert.deepEqual(await updater.check(), { status: 'update_available' });
  await flush();
  assert.equal(state.asked, 1);
  assert.equal(state.reloads, 1);
  assert.match(state.logs.join(' '), /to 1\.4\.0/);
});

test('no update, throttled, an error or an unpacked copy: nothing reloads, nothing throws', async () => {
  for (const answer of [{ status: 'no_update' }, { status: 'throttled' }, new Error('Update check failed'), {}, null]) {
    const { updater, state } = setup({ answer });
    const result = await updater.check();
    await flush();
    assert.equal(state.reloads, 0, JSON.stringify(answer));
    assert.equal(typeof result.status, 'string');
  }
  const bare = createExtensionUpdater({ runtime: {}, timers: fakeTimers() });
  assert.deepEqual(await bare.check(), { status: 'unsupported' });
  assert.deepEqual(await createExtensionUpdater({ runtime: null }).check(), { status: 'unsupported' });
});

test('an older callback shape of the answer is understood too', async () => {
  const { updater, state } = setup({ answer: ['update_available', { version: '1.4.0' }] });
  await updater.check();
  await flush();
  assert.equal(state.reloads, 1);
});

test('while a Tutor panel or Settings is open it waits, retries, and reloads at the first quiet moment', async () => {
  const { updater, state, timers } = setup({ answer: { status: 'update_available', version: '1.4.0' }, inUse: true });
  await updater.check();
  await flush();
  assert.equal(state.reloads, 0, 'never in the middle of a reply');
  assert.equal(timers.queue.length, 1, 'one retry is waiting');
  await timers.fire();
  assert.equal(state.reloads, 0, 'still in use');
  state.inUse = false;
  await timers.fire();
  assert.equal(state.reloads, 1);
  assert.equal(timers.queue.length, 0, 'nothing is left waiting');
});

test('a closing panel can apply a waiting update at once, and nothing waits when there is no update', async () => {
  const idle = setup();
  assert.equal(await idle.updater.tryApply(), false);
  assert.equal(idle.state.reloads, 0);
  const waiting = setup({ inUse: true });
  waiting.updater.onUpdateAvailable({ version: '1.4.0' });
  await flush();
  assert.equal(waiting.updater.pending(), '1.4.0');
  waiting.state.inUse = false;
  assert.equal(await waiting.updater.tryApply(), true, 'the last panel closed');
  assert.equal(waiting.state.reloads, 1);
  assert.equal(await waiting.updater.tryApply(), false, 'only once');
  assert.equal(waiting.state.reloads, 1);
});

test('the browser telling it an update is ready is enough, with or without a version', async () => {
  for (const details of [{ version: '1.4.0' }, {}, undefined]) {
    const { updater, state } = setup();
    updater.onUpdateAvailable(details);
    await flush();
    assert.equal(state.reloads, 1, JSON.stringify(details));
  }
});

test('a check that cannot tell if the extension is in use counts as in use, and a failed reload is survived', async () => {
  const timers = fakeTimers();
  let reloads = 0;
  const unsure = createExtensionUpdater({ runtime: { reload: () => (reloads += 1) }, busy: () => { throw new Error('boom'); }, timers });
  unsure.onUpdateAvailable({ version: '1.4.0' });
  await flush();
  assert.equal(reloads, 0);
  const broken = setup({ reloadThrows: true });
  broken.updater.onUpdateAvailable({ version: '1.4.0' });
  await flush();
  assert.equal(broken.state.reloads, 0);
  assert.match(broken.state.logs.join(' '), /could not reload/);
  assert.equal(await broken.updater.tryApply(), false, 'it may try again');
});

test('it gives up waiting after a long time and leaves the update to the browser', async () => {
  const { updater, timers, state } = setup({ inUse: true });
  updater.onUpdateAvailable({ version: '1.4.0' });
  await flush();
  for (let i = 0; i < MAX_RETRIES + 5 && timers.queue.length; i += 1) await timers.fire();
  assert.equal(timers.queue.length, 0);
  assert.equal(state.reloads, 0);
});
