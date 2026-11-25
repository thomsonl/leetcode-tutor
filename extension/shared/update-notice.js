// extension/shared/update-notice.js - telling the person an update happened.
//
// The browser updates the extension by itself and says nothing. When the
// version number really changes (runtime.onInstalled with reason "update"),
// the worker remembers { from, to } in storage.local and shows a "NEW" badge
// on the toolbar icon. The Tutor tab then offers a small card, and opening
// the Changelog tab counts as having seen it: the note and the badge go away.
//
// Not a first install (nothing to compare), and not an update to the version
// that is already running: the helper's setup reloads the extension, which
// fires the same event with the same version on both sides.
//
// Pure JavaScript with no Node API (extension/shared.test.js checks that).
//
// createUpdateNotice({ storage, badge, version, log })
//   storage: { get(keys), set(items), remove(keys) } (storage.local)
//   badge:   { set(text) }  the toolbar icon's badge text, '' for none
//   version: () => the running version, from the manifest

import { parseVersion } from './version.js';

export const UPDATE_KEY = 'updateNotice';
export const BADGE_TEXT = 'NEW';

// A stored note made safe: { from: string|null, to: string }, or null.
function clean(raw) {
  if (!raw || typeof raw !== 'object' || !parseVersion(raw.to)) return null;
  return { from: parseVersion(raw.from) ? raw.from : null, to: raw.to };
}

export function createUpdateNotice({ storage, badge, version, log = () => {} }) {
  async function read() {
    try {
      const stored = await storage.get([UPDATE_KEY]);
      return clean(stored && stored[UPDATE_KEY]);
    } catch (err) {
      log(`could not read the update note: ${err.message}`);
      return null;
    }
  }

  // The note for the version that is running now, or null. One for an older
  // version (the notes were never opened and the browser has since been
  // downgraded or reinstalled) is not shown.
  async function pending() {
    const note = await read();
    return note && note.to === version() ? note : null;
  }

  function setBadge(text) {
    try {
      return Promise.resolve(badge.set(text)).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  async function refreshBadge() {
    await setBadge((await pending()) ? BADGE_TEXT : '');
  }

  // runtime.onInstalled's details. Returns whether an update was noted.
  async function onInstalled(details) {
    if (!details || details.reason !== 'update') return false;
    const to = version();
    const from = details.previousVersion;
    if (!parseVersion(to) || from === to) return false;
    // An update on top of one nobody looked at keeps the first "from", so the
    // card says "from 1.2.0 to 1.4.0" rather than hiding the step before.
    const earlier = await read();
    const kept = earlier && earlier.to === from ? earlier.from : null;
    const note = { from: kept || (parseVersion(from) ? from : null), to };
    try {
      await storage.set({ [UPDATE_KEY]: note });
    } catch (err) {
      log(`could not save the update note: ${err.message}`);
      return false;
    }
    await setBadge(BADGE_TEXT);
    return true;
  }

  // The person has seen it (opened the Changelog tab or dismissed the card).
  async function seen() {
    try {
      await storage.remove([UPDATE_KEY]);
    } catch (err) {
      log(`could not clear the update note: ${err.message}`);
    }
    await setBadge('');
  }

  return { onInstalled, pending, seen, refreshBadge };
}
