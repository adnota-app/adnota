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
    await chrome.storage.local.set({ [domain]: domainData });
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

    await chrome.storage.local.set({ [domain]: domainData });
  },
  
  async deleteItem(domain, idKey, idValue) {
      const data = await chrome.storage.local.get(domain);
      if (data[domain]) {
         data[domain].items = data[domain].items.filter(i => i[idKey] !== idValue);
         await chrome.storage.local.set({ [domain]: data[domain] });
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

    await chrome.storage.local.set({ [domain]: data[domain] });
  }
};

window.AdnotaStorage = AdnotaStorage;
