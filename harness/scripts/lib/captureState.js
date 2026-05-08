// Snapshots the post-op state of the world for diffing against a pinned baseline:
//   - chrome.storage.local (read from the extension's service worker)
//   - the two style override tags injected into the page
//   - the boolean result of each declared DOM invariant expression

export async function captureState({ page, worker, domInvariants = [] }) {
  const storage = await worker.evaluate(async () => {
    return await chrome.storage.local.get(null);
  });

  const overrides = await page.evaluate(() => ({
    style: document.getElementById('adnota-style-overrides')?.textContent ?? '',
    erase: document.getElementById('adnota-erase-overrides')?.textContent ?? '',
  }));

  const invariants = [];
  for (const inv of domInvariants) {
    let result;
    try {
      // Wrap in a function so the expr can be a single expression OR a block
      // ending in an explicit return. Most invariants are single expressions.
      result = await page.evaluate(`(() => (${inv.expr}))()`);
    } catch (err) {
      result = { error: String(err?.message ?? err) };
    }
    invariants.push({ name: inv.name, expr: inv.expr, result });
  }

  return {
    storage: redactVolatile(storage),
    styleOverrides: overrides.style,
    eraseOverrides: overrides.erase,
    domInvariants: invariants,
  };
}

// Per-run nondeterminism we strip before diffing:
//   - Items: `_id`, `timestamp`, `createdAt`, `updatedAt`
//   - URL-shaped keys (e.g. inside `adnota_stats`): query params that change
//     each session (Bing's `rdrig`, redirect markers like `rdr`)
// Add new params to VOLATILE_URL_PARAMS as more sites surface them.
const VOLATILE_URL_PARAMS = new Set(['rdrig', 'rdr']);

function redactVolatile(storage) {
  const out = {};
  for (const [topKey, payload] of Object.entries(storage ?? {})) {
    if (payload && Array.isArray(payload.items)) {
      out[topKey] = { ...payload, items: payload.items.map(redactItem) };
    } else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      // Sub-keyed maps (adnota_stats etc.) — normalize URL keys.
      out[topKey] = redactUrlKeyedMap(payload);
    } else {
      out[topKey] = payload;
    }
  }
  return out;
}

function redactUrlKeyedMap(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[normalizeUrlKey(k)] = v;
  }
  return out;
}

function normalizeUrlKey(key) {
  if (!/^https?:\/\//.test(key)) return key;
  try {
    const u = new URL(key);
    for (const p of [...u.searchParams.keys()]) {
      if (VOLATILE_URL_PARAMS.has(p)) u.searchParams.delete(p);
    }
    return u.toString();
  } catch {
    return key;
  }
}

function redactItem(item) {
  const r = { ...item };
  if ('_id' in r) r._id = '<id>';
  if ('timestamp' in r) r.timestamp = '<ts>';
  if ('createdAt' in r) r.createdAt = '<ts>';
  if ('updatedAt' in r) r.updatedAt = '<ts>';
  return r;
}
