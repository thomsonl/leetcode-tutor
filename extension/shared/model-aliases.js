// extension/shared/model-aliases.js - OpenAI models named by family, and the
// newest model of each family found when it is used.
//
// A student picks "Sol", "Astra" or "Luna", not a version. What runs is the
// newest model of that family at the time of the request, so the tutor never
// keeps using an older one once a newer one is out. (The Claude subscription
// already works this way: Claude Code's own aliases, sonnet, opus and haiku,
// always mean the newest of that kind.)
//
// Pure data and functions with no Node or browser API of their own: a fetch
// is passed in, so the extension's worker and the companion share this file.

export const OPENAI_FAMILIES = ['sol', 'astra', 'luna'];

export const OPENAI_FAMILY_NAMES = { sol: 'Sol', astra: 'Astra', luna: 'Luna' };

// The newest model of each family on OpenAI's models page
// (developers.openai.com/api/docs/models), as of 2026-11-24. Used only when
// the live list cannot be read: with no API key to read it (the ChatGPT
// subscription) or when the request fails. Update these when a newer one is
// published; shared.test.js checks that every family has an entry.
export const OPENAI_NEWEST_KNOWN = { sol: 'gpt-6.2-sol', astra: 'gpt-6.2-astra', luna: 'gpt-6-luna' };

// A saved model from before families were named: these three exact IDs are
// the ones this extension used to offer, and mean "the newest" of the family.
export function canonicalModel(provider, model) {
  if (provider !== 'openai' && provider !== 'chatgpt') return model;
  const family = OPENAI_FAMILIES.find((f) => OPENAI_NEWEST_KNOWN[f] === model);
  return family || model;
}

// "luna" -> "luna"; anything else (a typed model name) -> null.
export function familyOf(model) {
  return typeof model === 'string' && OPENAI_FAMILIES.includes(model) ? model : null;
}

function versionOf(id, family) {
  const match = new RegExp(`^gpt-(\\d+(?:\\.\\d+)*)-${family}$`).exec(id);
  return match ? match[1].split('.').map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

// The newest "gpt-<version>-<family>" among `ids` (plain versions only, so a
// dated snapshot or a "-mini" variant is never taken), or null.
export function newestInFamily(family, ids) {
  let best = null;
  let bestVersion = null;
  for (const id of ids || []) {
    const version = typeof id === 'string' ? versionOf(id, family) : null;
    if (version && (!bestVersion || compareVersions(version, bestVersion) > 0)) {
      best = id;
      bestVersion = version;
    }
  }
  return best;
}

// The model to send for a saved one, without asking anyone: a family name
// becomes the newest known model of it; a typed model name stays as it is.
export function resolveKnown(model) {
  const family = familyOf(model);
  return family ? OPENAI_NEWEST_KNOWN[family] : model;
}

// Resolves a saved model against the API's own model list, remembering the
// answer for `ttlMs` (a failure for a minute, then it asks again). A family
// the list does not have, or a list that cannot be read, gives the newest
// known model of it.
export function createOpenAIResolver({ fetchImpl = (...args) => fetch(...args), ttlMs = 60 * 60 * 1000, failTtlMs = 60 * 1000, now = () => Date.now(), timeoutMs = 8000 } = {}) {
  const cache = new Map();
  return async function resolve(model, { baseUrl, apiKey } = {}) {
    const family = familyOf(model);
    if (!family) return model;
    const key = `${baseUrl || ''}|${family}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.id;
    let id = null;
    let failed = false;
    try {
      const res = await fetchImpl(`${String(baseUrl || '').replace(/\/+$/, '')}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`the model list answered ${res.status}`);
      const body = await res.json();
      id = newestInFamily(family, ((body && body.data) || []).map((m) => m && m.id));
    } catch {
      failed = true;
    }
    const resolved = id || OPENAI_NEWEST_KNOWN[family];
    cache.set(key, { id: resolved, until: now() + (failed ? failTtlMs : ttlMs) });
    return resolved;
  };
}
