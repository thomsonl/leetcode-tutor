// extension/shared/helper-version.js - the oldest helper this version of the
// extension works with.
//
// The extension updates through the browser's store and the helper through
// npm, so they can drift apart. When the extension starts to need something
// the helper only has from a version on (a new request it must answer), raise
// MIN_HELPER_VERSION to that version: the options page then tells the student
// to update the helper, with the command, instead of a feature failing with no
// explanation. Helpers from 0.1.6 on update themselves (helper/update.js); an
// older one needs the install command run again once.
//
// Pure JavaScript with no Node API (extension/shared.test.js checks that).

import { compareVersions, parseVersion } from './version.js';

// 0.1.6: the mode switch (`switchMode`), the editable prompts, and the helper
// updating itself.
export const MIN_HELPER_VERSION = '0.1.6';

// True when the helper reports a version older than the minimum. A helper that
// reports nothing readable is not called old: nothing is known about it.
export function helperTooOld(version, min = MIN_HELPER_VERSION) {
  return parseVersion(version) !== null && compareVersions(version, min) < 0;
}
