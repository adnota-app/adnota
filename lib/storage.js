// lib/storage.js
// Utility for consistent data storage schema.

const CURRENT_SCHEMA_VERSION = 1;

const VellumStorage = {
  /**
   * Save a deleted element anchor.
   * @param {string} domain 
   * @param {string} path  Use '*' for domain-wide deletions
   * @param {object} anchor The fuzzy anchor data object
   */
  async saveAnchor(domain, path, anchor) {
    const data = await chrome.storage.local.get(domain);
    const domainData = data[domain] || { items: [] };

    const entry = {
      ...anchor,
      path: path,
      version: CURRENT_SCHEMA_VERSION,
      timestamp: Date.now()
    };
    
    domainData.items.push(entry);
    await chrome.storage.local.set({ [domain]: domainData });
  },

  /**
   * Fetch all anchors that apply to the current exact URL or the whole domain.
   * @param {string} url 
   * @returns {Promise<Array>} array of relevant anchor entries
   */
  async getAnchorsForUrl(url) {
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname;
      const path = parsed.pathname;
      
      const data = await chrome.storage.local.get(domain);
      const domainData = data[domain];
      if (!domainData || !domainData.items) return [];
      
      // Return entries that apply globally to domain, or specifically to this path.
      return domainData.items.filter(item => item.path === '*' || item.path === path);
    } catch (err) {
      console.warn("VellumStorage: Invalid URL parsing", err);
      return [];
    }
  },

  /**
   * Clear all exact-path edits for the given URL
   * @param {string} url 
   */
  async clearPage(url) {
    const parsed = new URL(url);
    const domain = parsed.hostname;
    const path = parsed.pathname;

    const data = await chrome.storage.local.get(domain);
    if (!data[domain] || !data[domain].items) return;

    // Filter out items that match this exact path. We preserve domain-wide items.
    const newItems = data[domain].items.filter(item => item.path !== path);
    data[domain].items = newItems;

    await chrome.storage.local.set({ [domain]: data[domain] });
  }
};

window.VellumStorage = VellumStorage;
