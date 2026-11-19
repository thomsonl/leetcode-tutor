// The helper's self-update (update.js), its use by the host, and the `update`
// command. A fake registry, a fake npm and temporary folders: nothing here
// reaches the network, npm or the real browser folders.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createDecoder } from './framing.js';
import { createHost } from './host.js';
import { install, layout } from './install.js';
import { run } from './cli.js';
import { VERSION } from './config.js';
import {
  CHECK_EVERY_MS,
  PACKAGE_NAME,
  checkForUpdate,
  fetchLatest,
  findNpm,
  isNewer,
  makeUpdater,
  parseVersion,
  readAutoUpdate,
  readResult,
  recordResult,
  runUpdate,
  updateCommand,
  writeAutoUpdate,
} from './update.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..');
const ID = 'abcdefghijklmnopabcdefghijklmnop';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-helper-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const registry = (version, { name = PACKAGE_NAME, status = 200 } = {}) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: status === 200, status, json: async () => ({ name, version }) };
  };
  return { fetchImpl, calls };
};

test('only plain x.y.z versions are read, and compared by number', () => {
  assert.deepEqual(parseVersion('0.1.10'), [0, 1, 10]);
  for (const bad of ['1.2', '1.2.3-beta.1', 'v1.2.3', '1.2.3 ', '^1.2.3', 'latest', '1.2.3; rm -rf', '', null, 7]) assert.equal(parseVersion(bad), null, String(bad));
  assert.equal(isNewer('0.1.10', '0.1.9'), true, 'numeric, not text');
  assert.equal(isNewer('0.2.0', '0.1.9'), true);
  assert.equal(isNewer('0.1.5', '0.1.5'), false);
  assert.equal(isNewer('0.1.4', '0.1.5'), false, 'an older one is never an update');
  assert.equal(isNewer('nonsense', '0.1.5'), false);
});

test('the latest version comes from the registry, and only a sensible answer counts', async () => {
  const ok = registry('0.1.6');
  assert.equal(await fetchLatest({ fetchImpl: ok.fetchImpl }), '0.1.6');
  assert.deepEqual(ok.calls, ['https://registry.npmjs.org/leetcode-capture-helper/latest']);
  await assert.rejects(fetchLatest({ fetchImpl: registry('0.1.6', { status: 503 }).fetchImpl }), /answered 503/);
  await assert.rejects(fetchLatest({ fetchImpl: registry('0.1.6', { name: 'someone-else' }).fetchImpl }), /no usable version/);
  await assert.rejects(fetchLatest({ fetchImpl: registry('1.0.0-evil').fetchImpl }), /no usable version/);
});

test('a check is cached for a day, can be forced, and a failure is an answer, not a throw', async (t) => {
  const dir = temp(t);
  let clock = 1_000_000;
  const now = () => clock;
  const first = registry('0.1.6');
  const a = await checkForUpdate({ dir, current: '0.1.5', fetchImpl: first.fetchImpl, now });
  assert.deepEqual([a.latest, a.newer, a.error], ['0.1.6', true, null]);
  clock += CHECK_EVERY_MS - 1000;
  const b = await checkForUpdate({ dir, current: '0.1.5', fetchImpl: first.fetchImpl, now });
  assert.equal(first.calls.length, 1, 'asked once for the whole day');
  assert.equal(b.latest, '0.1.6');
  const forced = await checkForUpdate({ dir, current: '0.1.5', fetchImpl: first.fetchImpl, now, force: true });
  assert.equal(first.calls.length, 2);
  assert.equal(forced.newer, true);
  clock += CHECK_EVERY_MS + 1;
  const offline = await checkForUpdate({ dir, current: '0.1.6', fetchImpl: async () => { throw new Error('ENOTFOUND'); }, now });
  assert.equal(offline.error, 'ENOTFOUND');
  assert.equal(offline.latest, '0.1.6', 'what was known before stays known');
  assert.equal(offline.newer, false);
  const none = await checkForUpdate({ dir: temp(t), current: '0.1.5', fetchImpl: async () => { throw new Error('offline'); }, now });
  assert.deepEqual([none.latest, none.newer], [null, false]);
});

test('npm is found next to the node that runs the helper, and run without a shell', () => {
  const cli = '/home/u/.nvm/versions/node/v22/lib/node_modules/npm/bin/npm-cli.js';
  const found = findNpm({ execPath: '/home/u/.nvm/versions/node/v22/bin/node', platform: 'linux', exists: (p) => p === cli });
  assert.equal(found.command, '/home/u/.nvm/versions/node/v22/bin/node');
  assert.deepEqual(found.args, [cli]);
  assert.equal(findNpm({ execPath: 'C:\\node\\node.exe', platform: 'win32', exists: () => false }).command, 'npm.cmd');
  assert.equal(findNpm({ execPath: '/usr/bin/node', platform: 'linux', exists: () => false }).command, 'npm');
});

test('the update command installs exactly the version found, and refuses anything else', () => {
  const cmd = updateCommand({ version: '0.1.6', execPath: '/usr/bin/node', platform: 'linux', exists: () => false });
  assert.deepEqual(cmd.args, ['exec', '--yes', '--package=leetcode-capture-helper@0.1.6', '--', 'leetcode-capture-helper', 'update']);
  assert.throws(() => updateCommand({ version: 'latest' }), /not a version/);
  assert.throws(() => updateCommand({ version: '0.1.6 && calc' }), /not a version/);
});

class FakeProc extends EventEmitter {
  constructor() {
    super();
    this.unrefed = false;
    this.killed = false;
  }
  unref() {
    this.unrefed = true;
  }
  kill() {
    this.killed = true;
  }
}

test('the update runs as its own detached process, and can be waited for or left running', async () => {
  const spawns = [];
  const make = (after) => (command, args, options) => {
    const proc = new FakeProc();
    spawns.push({ command, args, options, proc });
    if (after) setImmediate(() => after(proc));
    return proc;
  };
  const common = { version: '0.1.6', execPath: '/usr/bin/node', platform: 'linux', exists: () => false, logFd: 5 };
  assert.deepEqual(await runUpdate({ ...common, spawn: make((p) => p.emit('exit', 0)) }), { ok: true, code: 0 });
  assert.equal(spawns[0].options.detached, true, 'it outlives the host, which the browser ends soon after closing its pipe');
  assert.deepEqual(spawns[0].options.stdio, ['ignore', 5, 5], 'its output goes to the helper log, never to the browser channel');
  assert.equal(spawns[0].options.env.npm_config_update_notifier, 'false');
  const failed = await runUpdate({ ...common, spawn: make((p) => p.emit('exit', 1)) });
  assert.deepEqual([failed.ok, failed.code], [false, 1]);
  assert.equal((await runUpdate({ ...common, spawn: make((p) => p.emit('error', new Error('ENOENT'))) })).error, 'ENOENT');
  const left = await runUpdate({ ...common, wait: false, spawn: make() });
  assert.equal(left.started, true);
  assert.equal(spawns.at(-1).proc.unrefed, true, 'the host can exit without waiting for it');
  const slow = await runUpdate({ ...common, timeoutMs: 5, spawn: make() });
  assert.equal(slow.error, 'the update took too long');
  assert.equal(spawns.at(-1).proc.killed, true);
});

function installedDir(t, { autoUpdate } = {}) {
  const dir = temp(t);
  const appDir = path.join(dir, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'helper-config.json'), JSON.stringify({ root: REPO, ...(autoUpdate === undefined ? {} : { autoUpdate }) }));
  return { dir, appDir };
}

test('auto update is on unless the student or the environment turned it off, and the choice keeps the recorded root', (t) => {
  const { appDir } = installedDir(t);
  assert.equal(readAutoUpdate({ appDir, env: {} }), true);
  assert.equal(writeAutoUpdate({ appDir, enabled: false }), true);
  assert.equal(readAutoUpdate({ appDir, env: {} }), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(appDir, 'helper-config.json'), 'utf8')).root, REPO, 'the root is kept');
  writeAutoUpdate({ appDir, enabled: true });
  assert.equal(readAutoUpdate({ appDir, env: {} }), true);
  assert.equal(readAutoUpdate({ appDir, env: { LEETCODE_CAPTURE_NO_AUTO_UPDATE: '1' } }), false);
  assert.equal(writeAutoUpdate({ appDir: path.join(appDir, 'nowhere'), enabled: false }), false, 'nothing is created for a helper that is not installed');
});

function updaterFor(t, { latest = '0.1.6', current = '0.1.5', autoUpdate, spawnExit = 0, now } = {}) {
  const { dir, appDir } = installedDir(t, { autoUpdate });
  const spawns = [];
  const updater = makeUpdater({
    appDir,
    dir,
    current,
    env: {},
    fetchImpl: registry(latest).fetchImpl,
    execPath: '/usr/bin/node',
    platform: 'linux',
    exists: () => false,
    ...(now ? { now } : {}),
    spawn: (command, args, options) => {
      const proc = new FakeProc();
      spawns.push({ command, args, options, proc });
      if (spawnExit !== null) setImmediate(() => proc.emit('exit', spawnExit));
      return proc;
    },
  });
  return { updater, spawns, dir, appDir };
}

test('the updater: nothing to do before it has checked, or when already current', async (t) => {
  const idle = updaterFor(t);
  assert.deepEqual(await idle.updater.run(), { ok: false, error: 'there is no newer version' });
  assert.deepEqual(await idle.updater.autoRun(), { ok: false, skipped: true });
  const current = updaterFor(t, { latest: '0.1.5' });
  await current.updater.check();
  assert.equal(current.updater.view().newer, false);
  assert.equal(current.spawns.length, 0);
});

test('the updater: a manual update installs the version found and reports how it went', async (t) => {
  const ok = updaterFor(t);
  await ok.updater.check();
  assert.equal(ok.updater.view().newer, true);
  const done = await ok.updater.run({ wait: true });
  assert.deepEqual([done.ok, done.version], [true, '0.1.6']);
  assert.ok(ok.spawns[0].args.includes('--package=leetcode-capture-helper@0.1.6'));
  assert.equal(ok.updater.view().state, 'idle');
  assert.equal(ok.updater.view().newer, false, 'what was just installed is no longer "newer"');
  assert.deepEqual(await ok.updater.autoRun(), { ok: false, skipped: true }, 'so the shutdown that follows does not install it again');
  assert.equal(ok.spawns.length, 1);
  const bad = updaterFor(t, { spawnExit: 1 });
  await bad.updater.check();
  const failed = await bad.updater.run({ wait: true });
  assert.equal(failed.ok, false);
  assert.equal(bad.updater.view().state, 'failed');
  assert.match(bad.updater.view().error, /npm exited with 1/);
  assert.equal(readResult(bad.dir).ok, false);
});

test('the updater: an automatic update records that it started, skips when off, and is not repeated after a failure within a day', async (t) => {
  let clock = 5_000_000;
  const now = () => clock;
  const off = updaterFor(t, { autoUpdate: false });
  await off.updater.check();
  assert.deepEqual(await off.updater.autoRun(), { ok: false, skipped: true });
  assert.equal(off.spawns.length, 0, 'turned off means no update');

  const on = updaterFor(t, { spawnExit: null, now });
  await on.updater.check();
  const started = await on.updater.autoRun();
  assert.equal(started.started, true);
  assert.equal(on.spawns.length, 1);
  assert.deepEqual([readResult(on.dir).ok, readResult(on.dir).to], [false, '0.1.6'], 'written down before anyone waits for it');
  assert.deepEqual(await on.updater.autoRun(), { ok: false, skipped: true }, 'not tried again at once');
  clock += 24 * 60 * 60 * 1000 + 1;
  assert.equal((await on.updater.autoRun()).started, true, 'tried again the next day');
  recordResult({ dir: on.dir, ok: true, from: '0.1.5', to: '0.1.6', now });
});

// ---- the host ----

function hostWith(updater) {
  const input = new PassThrough();
  const output = new PassThrough();
  const received = [];
  const decoder = createDecoder({ onMessage: (m) => received.push(m), onError: () => {} });
  output.on('data', (c) => decoder.push(c));
  const exits = [];
  const host = createHost({
    input,
    output,
    root: '/repo',
    env: { CAPTURE_PORT: '18998' },
    spawn: () => {
      throw new Error('no child expected');
    },
    fetchImpl: async () => ({ ok: true, status: 204 }),
    exit: (code) => exits.push(code),
    updater,
    timers: { setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout },
  });
  const ask = async (message) => {
    await host.handle(message);
    await new Promise((r) => setImmediate(r));
    return received.filter((m) => m.id === message.id).pop();
  };
  return { host, ask, received, exits };
}

function fakeUpdater(overrides = {}) {
  const calls = [];
  const state = { newer: true, auto: true };
  return {
    calls,
    view: () => ({ current: '0.1.5', latest: '0.1.6', newer: state.newer, checkedAt: 1, auto: state.auto, state: 'idle', error: null }),
    check: async (force) => calls.push(['check', force]),
    run: async (o) => {
      calls.push(['run', o]);
      return { ok: true, version: '0.1.6' };
    },
    autoRun: async () => {
      calls.push(['autoRun']);
      return { started: true };
    },
    setAuto: (enabled) => {
      state.auto = enabled;
      calls.push(['setAuto', enabled]);
    },
    ...overrides,
  };
}

test('host: status carries what is known about updates', async () => {
  const { ask } = hostWith(fakeUpdater());
  const status = await ask({ type: 'status', id: 1 });
  assert.deepEqual(status.update, { current: '0.1.5', latest: '0.1.6', newer: true, checkedAt: 1, auto: true, state: 'idle', error: null });
  const bare = await hostWith(null).ask({ type: 'status', id: 2 });
  assert.equal(bare.update, null, 'a host that cannot update itself says so');
});

test('host: update-check asks the registry now; set-auto-update remembers the choice', async () => {
  const updater = fakeUpdater();
  const { ask } = hostWith(updater);
  const checked = await ask({ type: 'update-check', id: 1 });
  assert.equal(checked.update.newer, true);
  assert.deepEqual(updater.calls[0], ['check', true]);
  const after = await ask({ type: 'set-auto-update', id: 2, enabled: false });
  assert.equal(after.update.auto, false);
  assert.deepEqual(updater.calls.at(-1), ['setAuto', false]);
});

test('host: update installs the newer version, answers, and exits so the browser starts the new copy', async () => {
  const updater = fakeUpdater();
  const { ask, exits } = hostWith(updater);
  const result = await ask({ type: 'update', id: 1 });
  assert.deepEqual([result.ok, result.version], [true, '0.1.6']);
  assert.deepEqual(updater.calls.filter((c) => c[0] === 'run'), [['run', { wait: true }]]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [0]);
});

test('host: a failed update is reported and the host stays', async () => {
  const updater = fakeUpdater({ run: async () => ({ ok: false, error: 'npm exited with 1' }) });
  const { ask, exits } = hostWith(updater);
  const result = await ask({ type: 'update', id: 1 });
  assert.deepEqual([result.ok, result.error], [false, 'npm exited with 1']);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, []);
  const none = await hostWith(null).ask({ type: 'update', id: 2 });
  assert.equal(none.ok, false);
});

test('host: a clean shutdown installs a newer helper by itself, a failed one does not', async () => {
  const clean = fakeUpdater();
  const a = hostWith(clean);
  await a.host.shutdown(0);
  assert.deepEqual(clean.calls, [['autoRun']]);
  assert.deepEqual(a.exits, [0]);
  const broken = fakeUpdater();
  const b = hostWith(broken);
  await b.host.shutdown(1);
  assert.deepEqual(broken.calls, [], 'a crash never starts an update');
  const throwing = fakeUpdater({ autoRun: async () => { throw new Error('boom'); } });
  const c = hostWith(throwing);
  await c.host.shutdown(0);
  assert.deepEqual(c.exits, [0], 'an update that cannot start still lets the host leave');
});

// ---- the update command ----

test('update: registers the new copy for the same browsers and extension ids, keeps the settings, and records it', (t) => {
  const home = temp(t);
  install({ platform: 'linux', home, env: {}, root: REPO, chromeIds: [ID], browsers: ['chromium', 'firefox'], autoUpdate: false });
  const where = layout({ platform: 'linux', home, env: {} });
  fs.mkdirSync(where.settingsDir, { recursive: true });
  fs.writeFileSync(path.join(where.settingsDir, 'settings.json'), '{"providers":{"openai":{"apiKey":"secret"}}}\n');
  const out = [];
  const code = run(['update'], { home, env: {}, platform: 'linux', print: (m) => out.push(m) });
  assert.equal(code, 0, out.join('\n'));
  const manifest = JSON.parse(fs.readFileSync(path.join(home, '.config', 'chromium', 'NativeMessagingHosts', 'dev.thomsonklee.leetcode_capture.json'), 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${ID}/`], 'the extension id was not asked for again');
  assert.equal(fs.existsSync(path.join(home, '.mozilla', 'native-messaging-hosts', 'dev.thomsonklee.leetcode_capture.json')), true, 'Firefox too');
  assert.equal(fs.readFileSync(path.join(where.settingsDir, 'settings.json'), 'utf8').includes('secret'), true, 'settings kept');
  assert.equal(JSON.parse(fs.readFileSync(path.join(where.appDir, 'helper-config.json'), 'utf8')).autoUpdate, false, 'a student\'s choice to stop automatic updates is kept');
  assert.equal(fs.existsSync(path.join(where.appDir, 'update.js')), true, 'the host copy can update itself');
  assert.deepEqual([readResult(where.dataDir).ok, readResult(where.dataDir).to], [true, VERSION]);
  assert.match(out.join('\n'), /already at version|Updated the helper from/);
  // The flag turns it back on.
  run(['update', '--auto-update'], { home, env: {}, platform: 'linux', print: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(path.join(where.appDir, 'helper-config.json'), 'utf8')).autoUpdate, true);
});

test('update: with nothing installed it says so and writes nothing', (t) => {
  const home = temp(t);
  const out = [];
  assert.equal(run(['update'], { home, env: {}, platform: 'linux', print: (m) => out.push(m) }), 1);
  assert.match(out.join(' '), /not installed/);
  assert.deepEqual(fs.readdirSync(home), []);
});
