// extension/shared/version.js - plain x.y.z version numbers, as the manifest
// and the release notes use them.
//
// Pure JavaScript with no Node API (extension/shared.test.js checks that).

export function parseVersion(text) {
  const match = /^(\d{1,4})\.(\d{1,5})\.(\d{1,6})$/.exec(typeof text === 'string' ? text : '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// Negative when a is older than b, positive when newer, 0 when equal or when
// either is not a version number.
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
