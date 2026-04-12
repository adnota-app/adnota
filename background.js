// background.js

// ─── Badge helpers ────────────────────────────────────────────────────────────

/**
 * Reads the annotation count for the given URL's hostname and updates the
 * extension icon badge for that tab. Purple badge = edits exist. No badge = clean page.
 */
async function updateBadgeForTab(tabId, url) {
  try {
    const hostname = new URL(url).hostname;

    if (!hostname) {
      await chrome.action.setBadgeText({ text: '', tabId });
      return;
    }

    const data = await chrome.storage.local.get(hostname);
    const items = data[hostname]?.items || [];
    const count = items.length;

    if (count > 0) {
      const label = count > 99 ? '99+' : String(count);
      await chrome.action.setBadgeText({ text: label, tabId });
      await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed', tabId });
      // setBadgeTextColor requires Chrome 110+ — graceful no-op on older builds.
      try { await chrome.action.setBadgeTextColor({ color: '#ffffff', tabId }); } catch { }
    } else {
      await chrome.action.setBadgeText({ text: '', tabId });
    }
  } catch {
    // chrome://, about:blank, file://, and other restricted URLs — clear silently.
    try { await chrome.action.setBadgeText({ text: '', tabId }); } catch { }
  }
}

// ─── Triggers ─────────────────────────────────────────────────────────────────

// User switches tabs.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) await updateBadgeForTab(tabId, tab.url);
  } catch { }
});

// Page navigates (full or SPA-style URL change) and finishes loading.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    updateBadgeForTab(tabId, tab.url);
  }
});

// Storage changes (annotation added or removed) — re-sync badge for the active tab.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) await updateBadgeForTab(tab.id, tab.url);
  } catch { }
});

// ─── Keyboard command relay ───────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command, tab) => {
  if (tab.id && (command === 'toggle-eraser' || command === 'toggle-sticky' || command === 'toggle-highlighter' || command === 'toggle-view')) {
    chrome.tabs.sendMessage(tab.id, { action: command }).catch(() => {
      // Ignore errors if content script unavailable on this page.
    });
  }
});
