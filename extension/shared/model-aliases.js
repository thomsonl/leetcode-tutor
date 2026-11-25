// extension/shared/model-aliases.js - OpenAI models named by tier, and the
// newest model of each tier found when it is used.
//
// OpenAI names a model "gpt-<version>-<tier>" (gpt-6.2-sol, gpt-6-luna,
// gpt-6.1-terra). A student picks a tier ("Sol"), not a version, and what runs
// is the newest model of that tier at the time of the request, so the tutor
// never keeps using an older one once a newer one is out. Nothing here lists
// the tiers or versions that exist: they are read from the live model list
// (OpenAI's API for an API key, the Codex CLI's own catalog for the ChatGPT
// subscription), so a new version, or a whole new tier, works as soon as it is
// published, with no update to this extension. (The Claude subscription
// already works this way: Claude Code's own aliases, sonnet, opus and haiku,
// always mean the newest of that kind.)
//
// Pure data and functions with no Node or browser API of their own: a fetch
// is passed in, so the extension's worker and the companion share this file.

// Only what the dropdown shows, and what a request falls back to, while no
// live list can be read (no key yet, offline, no helper). The live list
// replaces both as soon as it is there.
export const FALLBACK_TIERS = ['sol', 'astra', 'terra', 'luna'];
export const FALLBACK_NEWEST = { sol: 'gpt-6.2-sol', astra: 'gpt-6.2-astra', terra: 'gpt-6.1-terra', luna: 'gpt-6-luna' };

// A saved model from before tiers were named: the exact IDs this extension
// once offered mean "the newest" of their tier. (A fixed list of the past, so
// it never needs adding to.)
const LEGACY_IDS = { 'gpt-6.2-sol': 'sol', 'gpt-6.2-astra': 'astra', 'gpt-6-luna': 'luna' };

export function canonicalModel(provider, model) {
  if (provider !== 'openai' && provider !== 'chatgpt') return model;
  return Object.prototype.hasOwnProperty.call(LEGACY_IDS, model) ? LEGACY_IDS[model] : model;
}

// { version: [6, 2], tier: 'sol' } for a plain "gpt-<version>-<tier>" ID (not a
// dated snapshot or a variant such as -mini), else null.
export function parseModelId(id) {
  const match = typeof id === 'string' ? /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/.exec(id) : null;
  return match ? { version: match[1].split('.').map(Number), tier: match[2] } : null;
}

// "luna" -> "luna": a saved model that is a single lowercase word names a
// tier. Anything else (a typed model name such as o3 or gpt-6.1-sol) is an
// exact model and is sent as it is.
export function tierOf(model) {
  return typeof model === 'string' && /^[a-z]+$/.test(model) ? model : null;
}

export function tierLabel(tier) {
  return tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : '';
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

// The newest "gpt-<version>-<tier>" among `ids`, or null.
export function newestInTier(tier, ids) {
  let best = null;
  let bestVersion = null;
  for (const id of ids || []) {
    const parsed = parseModelId(id);
    if (parsed && parsed.tier === tier && (!bestVersion || compareVersions(parsed.version, bestVersion) > 0)) {
      best = id;
      bestVersion = parsed.version;
    }
  }
  return best;
}

// The tiers present in `ids`, the ones with the newest models first.
export function tiersFrom(ids) {
  const newest = new Map();
  for (const id of ids || []) {
    const parsed = parseModelId(id);
    if (!parsed) continue;
    const have = newest.get(parsed.tier);
    if (!have || compareVersions(parsed.version, have) > 0) newest.set(parsed.tier, parsed.version);
  }
  return [...newest.entries()].sort((a, b) => compareVersions(b[1], a[1]) || a[0].localeCompare(b[0])).map(([tier]) => tier);
}

// The model to send for a saved one given a live list of IDs: a tier becomes
// its newest model; an exact model stays. null when the tier is not in the list.
export function resolveFromIds(model, ids) {
  const tier = tierOf(model);
  return tier ? newestInTier(tier, ids) : model;
}

// The Codex CLI's catalog (`codex debug models`): the IDs it lists to people.
export function idsFromCodexCatalog(catalog) {
  const models = catalog && Array.isArray(catalog.models) ? catalog.models : [];
  return models.filter((m) => m && typeof m.slug === 'string' && (m.visibility === undefined || m.visibility === 'list')).map((m) => m.slug);
}

// Resolves a saved model against the API's own model list, remembering the
// answer for `ttlMs`. When the list cannot be read it keeps the last answer it
// had (a failure is retried after a minute), and only with none the tier's
// fallback model, so a request offline still names a real model.
export function createOpenAIResolver({ fetchImpl = (...args) => fetch(...args), ttlMs = 60 * 60 * 1000, failTtlMs = 60 * 1000, now = () => Date.now(), timeoutMs = 8000 } = {}) {
  const cache = new Map();
  return async function resolve(model, { baseUrl, apiKey } = {}) {
    const tier = tierOf(model);
    if (!tier) return model;
    const key = `${baseUrl || ''}|${tier}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.id;
    let id = null;
    try {
      const res = await fetchImpl(`${String(baseUrl || '').replace(/\/+$/, '')}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`the model list answered ${res.status}`);
      const body = await res.json();
      id = newestInTier(tier, ((body && body.data) || []).map((m) => m && m.id));
    } catch {
      cache.set(key, { id: (hit && hit.id) || FALLBACK_NEWEST[tier] || model, until: now() + failTtlMs });
      return cache.get(key).id;
    }
    const resolved = id || (hit && hit.id) || FALLBACK_NEWEST[tier] || model;
    cache.set(key, { id: resolved, until: now() + ttlMs });
    return resolved;
  };
}
