// Keeping the helper up to date.
//
// The helper is an npm package the student installs once with npx, and the
// extension updates itself through the browser's store, so the two drift
// apart unless the helper follows. This module is the helper's half:
//
//   - check: ask the npm registry for the newest published version, at most
//     once a day (the answer is cached in the data folder), and say whether it
//     is newer than the running one;
//   - run: install exactly that version with `npm exec --package
//     leetcode-capture-helper@<version> -- leetcode-capture-helper update`,
//     which is the same command a student would run by hand, and which
//     re-registers the browsers with the new copy and keeps the settings;
//   - auto: unless the student turned it off, the host runs that as it shuts
//     down (the browser closed or the last LeetCode tab went), when nothing
//     is using the helper. The browser ends a host soon after closing its
//     pipe, so the update is a separate detached process that outlives it.
//
// Everything is injected (fetch, spawn, clock, file existence), so tests run
// it against a fake registry and a fake npm. It never writes to stdout, which
// is the browser's channel in the host.

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

export const PACKAGE_NAME = 'leetcode-capture-helper';
export const REGISTRY = 'https://registry.npmjs.org';
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
// After a failed update the same version is not tried again for this long.
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
export const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

const CHECK_FILE = 'update-check.json';
const RESULT_FILE = 'update-result.json';
const CONFIG_FILE = 'helper-config.json';

// Only plain x.y.z is ever taken from the registry or compared: no tags, no
// ranges, nothing that could stand for something else when put on a command line.
export function parseVersion(text) {
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  } catch {
    // a missing cache only means asking again
  }
}

// The newest published version, from the registry's `latest` tag.
export async function fetchLatest({ fetchImpl = fetch, registry = REGISTRY, name = PACKAGE_NAME, timeoutMs = 5000, timers = { setTimeout, clearTimeout } } = {}) {
  const controller = new AbortController();
  const timer = timers.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${registry}/${name}/latest`, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`the registry answered ${res.status}`);
    const body = await res.json();
    if (!body || body.name !== name || !parseVersion(body.version)) throw new Error('the registry sent no usable version');
    return body.version;
  } finally {
    timers.clearTimeout(timer);
  }
}

// { current, latest, newer, checkedAt, error } from the cache while it is
// fresh, otherwise from the registry (and cached). A failure to ask is an
// `error`, not a throw: a student offline loses nothing.
export async function checkForUpdate({ dir, current, fetchImpl, registry, name, now = () => Date.now(), force = false, timers } = {}) {
  const file = path.join(dir, CHECK_FILE);
  const cached = readJson(file);
  const fresh = cached && parseVersion(cached.latest) && typeof cached.checkedAt === 'number' && now() - cached.checkedAt < CHECK_EVERY_MS && cached.checkedAt <= now();
  if (fresh && !force) return { current, latest: cached.latest, newer: isNewer(cached.latest, current), checkedAt: cached.checkedAt, error: null };
  try {
    const latest = await fetchLatest({ fetchImpl, registry, name, timers });
    const checkedAt = now();
    writeJson(file, { checkedAt, latest });
    return { current, latest, newer: isNewer(latest, current), checkedAt, error: null };
  } catch (err) {
    const error = err && err.name === 'AbortError' ? 'the registry did not answer in time' : String((err && err.message) || err);
    return { current, latest: cached && parseVersion(cached.latest) ? cached.latest : null, newer: cached ? isNewer(cached.latest, current) : false, checkedAt: cached ? cached.checkedAt : null, error };
  }
}

// npm, found next to the node that runs the helper (a browser starts the host
// with the desktop session's PATH, which often lacks an nvm or volta node's
// npm), as `node <npm-cli.js>` so no shell is involved on any platform; PATH's
// `npm` only as a last resort.
export function findNpm({ execPath = process.execPath, platform = process.platform, exists = fs.existsSync } = {}) {
  const nodeDir = path.dirname(execPath);
  const candidates = platform === 'win32'
    ? [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const cli of candidates) if (exists(cli)) return { command: execPath, args: [cli] };
  return { command: platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: platform === 'win32' };
}

// The command that installs exactly `version` and runs its `update`.
export function updateCommand({ version, name = PACKAGE_NAME, ...npmOptions }) {
  if (!parseVersion(version)) throw new Error('not a version');
  const npm = findNpm(npmOptions);
  return { command: npm.command, shell: Boolean(npm.shell), args: [...npm.args, 'exec', '--yes', `--package=${name}@${version}`, '--', name, 'update'] };
}

// Starts the update as its own process. With `wait` it resolves when that
// process ends ({ ok, code }); without, it resolves at once, the process left
// to finish after this one is gone.
export function runUpdate({ version, spawn = nodeSpawn, logFd = 'ignore', env = process.env, wait = true, timeoutMs = UPDATE_TIMEOUT_MS, timers = { setTimeout, clearTimeout }, ...npmOptions } = {}) {
  const { command, args, shell } = updateCommand({ version, ...npmOptions });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        shell,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' },
      });
    } catch (err) {
      resolve({ ok: false, code: null, error: err.message });
      return;
    }
    if (!wait) {
      child.on('error', () => {});
      if (typeof child.unref === 'function') child.unref();
      resolve({ ok: true, code: null, started: true });
      return;
    }
    const timer = timers.setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve({ ok: false, code: null, error: 'the update took too long' });
    }, timeoutMs);
    child.on('error', (err) => {
      timers.clearTimeout(timer);
      resolve({ ok: false, code: null, error: err.message });
    });
    child.on('exit', (code) => {
      timers.clearTimeout(timer);
      resolve(code === 0 ? { ok: true, code } : { ok: false, code, error: `npm exited with ${code}` });
    });
  });
}

// ---- what the student chose, and what the last attempt did ---------------------------

// helper-config.json (next to the host) holds the root the installer recorded
// and `autoUpdate`. On unless set to false, or LEETCODE_CAPTURE_NO_AUTO_UPDATE is set.
export function readAutoUpdate({ appDir, env = process.env }) {
  if (env.LEETCODE_CAPTURE_NO_AUTO_UPDATE) return false;
  const config = readJson(path.join(appDir, CONFIG_FILE));
  return !(config && config.autoUpdate === false);
}

export function writeAutoUpdate({ appDir, enabled }) {
  const file = path.join(appDir, CONFIG_FILE);
  const config = readJson(file);
  if (!config) return false;
  writeJson(file, { ...config, autoUpdate: Boolean(enabled) });
  return true;
}

export function recordResult({ dir, ok, from, to, error = null, now = () => Date.now() }) {
  writeJson(path.join(dir, RESULT_FILE), { at: now(), ok: Boolean(ok), from, to, error });
}

export function readResult(dir) {
  return readJson(path.join(dir, RESULT_FILE));
}

// ---- the host's view -----------------------------------------------------------------------

// One object the host holds. `appDir` is where the installed host lives (the
// config is there); `dir` is the data folder (cache, result, log).
export function makeUpdater({ appDir, dir, current, env = process.env, fetchImpl, registry, spawn, logFd = 'ignore', now = () => Date.now(), timers, execPath, platform, exists } = {}) {
  let info = { current, latest: null, newer: false, checkedAt: null, error: null };
  let state = 'idle'; // idle | updating | failed
  let lastError = null;
  const npmOptions = { ...(execPath ? { execPath } : {}), ...(platform ? { platform } : {}), ...(exists ? { exists } : {}) };

  const auto = () => readAutoUpdate({ appDir, env });

  async function check(force = false) {
    info = await checkForUpdate({ dir, current, fetchImpl, registry, now, force, timers });
    return view();
  }

  // A version whose last update failed is not tried again for a day.
  function recentlyFailed(version) {
    const last = readResult(dir);
    return Boolean(last && last.ok === false && last.to === version && typeof last.at === 'number' && now() - last.at < RETRY_AFTER_MS);
  }

  function view() {
    const last = readResult(dir);
    return {
      current,
      latest: info.latest,
      newer: info.newer,
      checkedAt: info.checkedAt,
      auto: auto(),
      state,
      error: lastError || (info.error && !info.latest ? info.error : null) || (last && last.ok === false && last.to === info.latest ? last.error || 'the last update failed' : null),
    };
  }

  // Installs the newest known version. `wait`: resolve when it has finished.
  async function run({ wait = true } = {}) {
    if (!info.newer || !info.latest) return { ok: false, error: 'there is no newer version' };
    if (state === 'updating') return { ok: false, error: 'an update is already running' };
    state = 'updating';
    lastError = null;
    const to = info.latest;
    const result = await runUpdate({ version: to, spawn, logFd, env, wait, timers, ...npmOptions });
    if (wait) {
      // Installed: what this running copy knows as newer is now behind it, so
      // the shutdown that follows does not start the same update again.
      if (result.ok) info = { ...info, newer: false };
      state = result.ok ? 'idle' : 'failed';
      lastError = result.ok ? null : result.error || 'the update failed';
      if (!result.ok) recordResult({ dir, ok: false, from: current, to, error: lastError, now });
    } else {
      state = 'idle';
    }
    return { ...result, version: to };
  }

  // At shutdown: update without waiting, if the student wants that and a newer
  // version is known and has not just failed.
  async function autoRun() {
    if (!auto() || !info.newer || !info.latest || recentlyFailed(info.latest)) return { ok: false, skipped: true };
    // Nobody waits for this one, so the attempt is written down first as not
    // finished; `leetcode-capture-helper update` replaces it when it succeeds.
    recordResult({ dir, ok: false, from: current, to: info.latest, error: 'the last automatic update did not finish', now });
    return run({ wait: false });
  }

  return { check, run, autoRun, view, auto, setAuto: (enabled) => writeAutoUpdate({ appDir, enabled }) };
}
