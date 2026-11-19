// extension/shared/extension-update.js - taking the extension's own update as
// soon as the browser has it.
//
// The browser checks the store for a new version every few hours and applies
// it at a restart or when the extension is idle. This asks right away when the
// browser starts (`runtime.requestUpdateCheck`), and when a new version is
// ready reloads the extension (`runtime.reload`) at a moment nothing is
// using it, so the student is on the newest version without waiting.
//
// "Nothing is using it" is the caller's `busy()`: a Tutor panel open on a
// LeetCode tab (a reload would cut off its reply), or the options page open (a
// reload would close it under the student's hands). While busy it waits and
// tries again, and the worker calls `tryApply` when a panel closes. If it never
// gets a quiet moment the browser still applies the update by itself later.
//
// The browser only offers this for an extension installed from its store: an
// unpacked copy reports no update, and an error or a throttled answer (the
// browser limits how often it will ask) is simply ignored.
//
// Pure JavaScript with no Node API (extension/shared.test.js checks that).

export const RETRY_MS = 60 * 1000;
export const MAX_RETRIES = 120;

export function createExtensionUpdater({ runtime, busy = () => false, timers, retryMs = RETRY_MS, maxRetries = MAX_RETRIES, log = () => {} } = {}) {
  let pending = null; // the version that is ready, or true when the browser did not say
  let retryTimer = null;
  let tries = 0;
  let reloading = false;

  function schedule() {
    if (retryTimer !== null || tries >= maxRetries || !timers) return;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      tries += 1;
      tryApply();
    }, retryMs);
  }

  // Reloads the extension when an update is ready and nothing is using it.
  async function tryApply() {
    if (!pending || reloading) return false;
    let inUse = true;
    try {
      inUse = Boolean(await busy());
    } catch {
      inUse = true;
    }
    if (inUse) {
      schedule();
      return false;
    }
    reloading = true;
    log(`reloading to take the update${typeof pending === 'string' ? ` to ${pending}` : ''}`);
    try {
      runtime.reload();
      return true;
    } catch (err) {
      reloading = false;
      log(`could not reload: ${err && err.message ? err.message : err}`);
      return false;
    }
  }

  // Asks the browser's store check now. Returns { status } (or { status: 'unsupported' }).
  async function check() {
    if (!runtime || typeof runtime.requestUpdateCheck !== 'function') return { status: 'unsupported' };
    let result;
    try {
      result = await runtime.requestUpdateCheck();
    } catch (err) {
      log(`update check failed: ${err && err.message ? err.message : err}`);
      return { status: 'error' };
    }
    // Chrome answers { status, version }; an older callback shape gives the status first.
    const status = Array.isArray(result) ? result[0] : result && result.status;
    const version = Array.isArray(result) ? (result[1] && result[1].version) : result && result.version;
    if (status === 'update_available') {
      pending = typeof version === 'string' && version ? version : true;
      tryApply();
    }
    return { status: typeof status === 'string' ? status : 'error' };
  }

  // `runtime.onUpdateAvailable`: the new version is downloaded and waiting.
  function onUpdateAvailable(details) {
    pending = details && typeof details.version === 'string' && details.version ? details.version : true;
    tryApply();
  }

  return { check, onUpdateAvailable, tryApply, pending: () => pending };
}
