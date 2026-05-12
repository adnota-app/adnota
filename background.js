// background.js

importScripts('lib/log.js');

// ─── First-run welcome ───────────────────────────────────────────────────────
// Open the welcome tab the first time the extension is installed. Skipped on
// browser-restart wake-ups and on updates — `reason === 'update'` is reserved
// for a future changelog page.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/welcome.html') });
  }
});

// ─── Badge helpers ────────────────────────────────────────────────────────────

/**
 * Reads the annotation count for the given URL's hostname and updates the
 * extension icon badge for that tab. Purple badge = edits exist. No badge = clean page.
 */
async function updateBadgeForTab(tabId, url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const pathname = parsed.pathname;

    if (!hostname) {
      await chrome.action.setBadgeText({ text: '', tabId });
      await chrome.action.setTitle({ title: 'Adnota', tabId });
      return;
    }

    const data = await chrome.storage.local.get(hostname);
    const items = data[hostname]?.items || [];
    const count = items.length;

    let pageCount = 0;
    let siteCount = 0;
    for (const item of items) {
      if (item.path === '*') siteCount++;
      else if (item.path === pathname) pageCount++;
    }

    if (count > 0) {
      const label = count > 99 ? '99+' : String(count);
      await chrome.action.setBadgeText({ text: label, tabId });
      await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed', tabId });
      // setBadgeTextColor requires Chrome 110+ — graceful no-op on older builds.
      try { await chrome.action.setBadgeTextColor({ color: '#ffffff', tabId }); } catch { }
    } else {
      await chrome.action.setBadgeText({ text: '', tabId });
    }

    await chrome.action.setTitle({ title: buildTooltip(count, pageCount, siteCount), tabId });
  } catch {
    // chrome://, about:blank, file://, and other restricted URLs — clear silently.
    try { await chrome.action.setBadgeText({ text: '', tabId }); } catch { }
    try { await chrome.action.setTitle({ title: 'Adnota', tabId }); } catch { }
  }
}

function buildTooltip(total, pageCount, siteCount) {
  if (total === 0) return 'Adnota';
  const plural = (n) => (n === 1 ? '' : 's');
  const parts = [];
  if (pageCount > 0) parts.push(`${pageCount} page edit${plural(pageCount)}`);
  if (siteCount > 0) parts.push(`${siteCount} site-wide edit${plural(siteCount)}`);
  // Items scoped to other paths on the same host fall outside both buckets;
  // surface them so the tooltip total reconciles with the badge count.
  const otherCount = total - pageCount - siteCount;
  if (otherCount > 0) parts.push(`${otherCount} edit${plural(otherCount)} elsewhere on this site`);
  return parts.length ? `Adnota — ${parts.join(' · ')}` : 'Adnota';
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

// Storage changes (annotation added or removed) — re-sync badge for the active
// tab. Trailing-debounced so a fast burst of writes (a long pencil stroke
// auto-saving, drag-to-move re-anchoring, the autosave debounce flushing)
// collapses to one chrome.tabs.query instead of one per write. Adnota's own
// pref keys are all camelCase `adnota*`; domain keys are bare hostnames — so
// pref-only changes (debug-log toggle, dock position, active mode, etc.)
// short-circuit before scheduling any work.
let pendingBadgeUpdate = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  let hasDomainKey = false;
  for (const key in changes) {
    if (!key.startsWith('adnota')) { hasDomainKey = true; break; }
  }
  if (!hasDomainKey) return;

  if (pendingBadgeUpdate) clearTimeout(pendingBadgeUpdate);
  pendingBadgeUpdate = setTimeout(async () => {
    pendingBadgeUpdate = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) await updateBadgeForTab(tab.id, tab.url);
    } catch { }
  }, 150);
});

// ─── Keyboard command relay ───────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command, tab) => {
  AdnotaLog.event('bg', 'cmd', { command, tabId: tab && tab.id });
  if (tab.id && (command === 'toggle-dock' || command === 'toggle-view')) {
    chrome.tabs.sendMessage(tab.id, { action: command }).catch(() => {
      // Ignore errors if content script unavailable on this page.
    });
  }
});

// ─── Dock message relay ──────────────────────────────────────────────────────
// Content scripts can't send messages to themselves via chrome.tabs.sendMessage,
// so the dock sends to the background which relays back to the same tab.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'open-sites') {
    AdnotaLog.event('bg', 'open-sites', { fromTab: sender.tab && sender.tab.id });
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/sites.html') });
    return;
  }

  if (msg.action === 'relay-to-tab' && sender.tab?.id && msg.payload?.action) {
    AdnotaLog.event('bg', 'relay', { tabId: sender.tab.id, payload: msg.payload });
    chrome.tabs.sendMessage(sender.tab.id, { action: msg.payload.action }).catch(() => {});
    return;
  }
});
