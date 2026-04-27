// AdnotaLog — gated debug-event logger shared across content scripts,
// background service worker, popup, and the Sites page.
//
// Pre-release default: ON. Toggle off via either:
//   chrome.storage.local.set({ adnotaDebugLog: false })   // global
//   localStorage.setItem('adnotaDebugLog', '0')           // per-tab override
//
// Each log line: `[Adnota:<channel>:<action>] {…data}` — easy to filter
// in DevTools by typing `Adnota:` or `Adnota:eraser:` in the search box.
//
// Three console contexts to watch (logs are not unified across them):
//   - host page DevTools console (content scripts)
//   - chrome://extensions service-worker console (background.js)
//   - popup inspector / Sites page DevTools

(function () {
  const STORAGE_KEY = 'adnotaDebugLog';
  const isWorker = typeof window === 'undefined';
  const root = isWorker ? self : window;
  if (root.AdnotaLog) return;

  const state = { enabled: true, localKill: false };

  // localStorage kill-switch (page-side only). Service workers don't have
  // localStorage, so this branch only runs in content/popup/sites contexts.
  if (!isWorker) {
    try { state.localKill = localStorage.getItem(STORAGE_KEY) === '0'; } catch {}
  }

  // chrome.storage.local read + live-toggle listener. Available everywhere
  // (content scripts, service worker, popup, sites page).
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      if (chrome.runtime.lastError) return;
      if (result && Object.prototype.hasOwnProperty.call(result, STORAGE_KEY)) {
        state.enabled = !!result[STORAGE_KEY];
      } else {
        // Seed the key on first run so it's visible/flippable in DevTools.
        chrome.storage.local.set({ [STORAGE_KEY]: true });
        state.enabled = true;
      }
    });
    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[STORAGE_KEY]) return;
        state.enabled = !!changes[STORAGE_KEY].newValue;
      });
    }
  }

  // Source label so the same conceptual flow is reconstructable across
  // host-page / service-worker / popup consoles.
  const source = (() => {
    if (isWorker) return 'bg';
    try {
      if (location.protocol === 'chrome-extension:') {
        if (location.pathname.includes('popup')) return 'popup';
        if (location.pathname.includes('sites')) return 'sites';
        return 'ext';
      }
    } catch {}
    return 'cs';
  })();

  function isOn() { return state.enabled && !state.localKill; }

  // Element descriptor used by event payloads. Content-script-only — uses
  // FuzzyAnchor.generateCSSSelector when available (loaded later in the
  // content_scripts list, but el() is only called at event time).
  function el(node) {
    if (isWorker || !node || !(node instanceof Element)) return null;
    let sel = null;
    try {
      if (root.FuzzyAnchor && typeof root.FuzzyAnchor.generateCSSSelector === 'function') {
        sel = root.FuzzyAnchor.generateCSSSelector(node);
      }
    } catch {}
    const rect = (() => { try { return node.getBoundingClientRect(); } catch { return null; } })();
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      sel,
      tag: node.tagName ? node.tagName.toLowerCase() : null,
      w: rect ? Math.round(rect.width) : null,
      h: rect ? Math.round(rect.height) : null,
      text: text || null,
    };
  }

  function event(channel, action, data) {
    if (!isOn()) return;
    const tag = `[Adnota:${source}:${channel}:${action}]`;
    if (data === undefined) console.log(tag);
    else console.log(tag, data);
  }

  function group(channel, label, fn) {
    if (!isOn()) { try { return fn && fn(); } catch (e) { console.error(e); throw e; } }
    const tag = `[Adnota:${source}:${channel}] ${label}`;
    console.groupCollapsed(tag);
    try { return fn && fn(); }
    finally { console.groupEnd(); }
  }

  root.AdnotaLog = {
    get enabled() { return isOn(); },
    set enabled(v) { state.enabled = !!v; },
    event,
    el,
    group,
  };
})();
