// lib/storage.js
const CURRENT_SCHEMA_VERSION = 2;

const VellumStorage = {
  async saveItem(domain, path, payload) {
    const data = await chrome.storage.local.get(domain);
    const domainData = data[domain] || { items: [] };

    const entry = {
      ...payload,
      path,
      version: CURRENT_SCHEMA_VERSION,
      timestamp: Date.now()
    };

    domainData.items.push(entry);
    await chrome.storage.local.set({ [domain]: domainData });
  },

  async saveNote(domain, path, anchor, placement, comments, uuid, dimensions = null) {
    const data = await chrome.storage.local.get(domain);
    const domainData = data[domain] || { items: [] };

    const existingIndex = domainData.items.findIndex(i => i.uuid === uuid);
    
    if (existingIndex > -1) {
      domainData.items[existingIndex] = {
        ...domainData.items[existingIndex],
        placement,
        comments,
        updatedAt: Date.now(),
        ...(dimensions ? { dimensions } : {})
      };
    } else {
      const entry = {
        ...anchor,
        path: path,
        action: 'NOTE',
        uuid: uuid,
        placement: placement,
        comments: comments,
        ...(dimensions ? { dimensions } : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: CURRENT_SCHEMA_VERSION
      };
      domainData.items.push(entry);
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

window.VellumStorage = VellumStorage;
