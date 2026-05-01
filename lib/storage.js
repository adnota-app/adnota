// lib/storage.js
const CURRENT_SCHEMA_VERSION = 2;

// Strip in-memory-only fields before persistence. Convention: any top-level
// field named with a leading underscore is transient and not saved (the lone
// exception is `_id`, the original storage primary key). chrome.storage.local
// uses structured clone, which throws on DOM Elements — so a tool stashing a
// transient DOM ref on a payload (e.g., `_fallbackContainer` on a
// fallback-rendered marker) would otherwise break the save on every drag.
function scrubTransientFields(payload) {
  const out = {};
  for (const k in payload) {
    if (k[0] !== '_' || k === '_id') out[k] = payload[k];
  }
  return out;
}

// chrome.storage.local has a 10 MB cap (QUOTA_BYTES). Hitting it makes every
// subsequent set() reject — without this wrapper, that rejection surfaces as
// an unhandled promise and the user's annotation silently vanishes on the
// next page load. We catch, surface a single toast (rate-limited), and rethrow
// so callers that care can roll back optimistic UI.
let lastQuotaToastAt = 0;
async function safeSet(obj) {
  try {
    await chrome.storage.local.set(obj);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const isQuota = /quota|QUOTA/i.test(msg);
    if (window.AdnotaLog) {
      window.AdnotaLog.event('storage', isQuota ? 'quota-exceeded' : 'set-failed', { msg });
    }
    if (isQuota && window.AdnotaUI && typeof window.AdnotaUI.showToast === 'function') {
      // Rate-limit so a burst of failed writes (e.g., autosave debounce
      // re-firing) doesn't stack toasts.
      const now = Date.now();
      if (now - lastQuotaToastAt > 5000) {
        lastQuotaToastAt = now;
        window.AdnotaUI.showToast(
          'Adnota storage is full. Open My Edited Sites to delete pages and free space.',
          { id: 'adnota-quota-toast', timeout: 8000 }
        );
      }
    }
    throw err;
  }
}

const AdnotaStorage = {
  async saveItem(domain, path, payload) {
    const data = await chrome.storage.local.get(domain);
    const domainData = data[domain] || { items: [] };

    const entry = {
      ...scrubTransientFields(payload),
      path,
      version: CURRENT_SCHEMA_VERSION,
      timestamp: Date.now()
    };

    domainData.items.push(entry);
    await safeSet({ [domain]: domainData });
  },

  async saveNote(domain, path, uuid, payload) {
    const data = await chrome.storage.local.get(domain);
    const domainData = data[domain] || { items: [] };

    const existingIndex = domainData.items.findIndex(i => i.uuid === uuid);
    const cleanPayload = scrubTransientFields(payload);

    if (existingIndex > -1) {
      domainData.items[existingIndex] = {
        ...domainData.items[existingIndex],
        ...cleanPayload,
        updatedAt: Date.now(),
      };
    } else {
      domainData.items.push({
        ...cleanPayload,
        path,
        action: 'NOTE',
        uuid,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: CURRENT_SCHEMA_VERSION,
      });
    }

    await safeSet({ [domain]: domainData });
  },

  async deleteItem(domain, idKey, idValue) {
      const data = await chrome.storage.local.get(domain);
      if (data[domain]) {
         data[domain].items = data[domain].items.filter(i => i[idKey] !== idValue);
         await safeSet({ [domain]: data[domain] });
      }
  },

  async getAnchorsForUrl(url) {
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname;
      const path = parsed.pathname;

      const data = await chrome.storage.local.get(domain);
      const domainData = data[domain];
      if (!domainData || !domainData.items) return [];

      return domainData.items.filter(item => item.path === '*' || item.path === path);
    } catch (err) {
      return [];
    }
  },

  async clearPage(url) {
    const parsed = new URL(url);
    const domain = parsed.hostname;
    const path = parsed.pathname;

    const data = await chrome.storage.local.get(domain);
    if (!data[domain] || !data[domain].items) return;

    const newItems = data[domain].items.filter(item => item.path !== path);
    data[domain].items = newItems;

    await safeSet({ [domain]: data[domain] });
  }
};

window.AdnotaStorage = AdnotaStorage;
