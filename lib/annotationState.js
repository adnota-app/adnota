// lib/annotationState.js

const listeners = [];

window.AdnotaState = {
  // Single source of truth for active tool.
  // null = no tool active | 'eraser' | 'sticky' | 'highlight' | 'pen' | 'resizer'
  // pen sub-tools: 'pen' (freehand), 'arrow', 'rect', 'ellipse', 'select'
  mode: null,
  // Either a theme class ('adnota-theme-yellow') or a raw hex ('#ff0033') picked
  // via the eyedropper. Consumers must handle both forms.
  color: 'adnota-theme-yellow',
  strokeWidth: 4,
  // Outline vs solid-fill modifier for rect/ellipse shapes (ignored by other tools).
  filled: false,

  // Derived — true whenever any tool is active. Never set this directly;
  // it is computed automatically from mode so call sites stay simple.
  get isVisible() {
    return this.mode !== null;
  },

  set(patch) {
    // Whitelist allowed writable keys. 'isVisible' is intentionally excluded —
    // it is a derived getter and must not be overwritten via patch.
    const allowed = ['mode', 'color', 'strokeWidth', 'filled'];
    const prevMode = this.mode;
    for (const key of allowed) {
      if (key in patch) this[key] = patch[key];
    }
    if ('mode' in patch && prevMode !== this.mode) {
      window.AdnotaLog?.event('state', 'mode', { from: prevMode, to: this.mode });
    }
    // Persist any changed cross-component keys in one batched write. The popup
    // reads these live (e.g. adnotaActiveMode lights up the active-tool indicator
    // when a keyboard shortcut fires while the popup is open).
    const writes = {};
    if (patch.color) writes.adnotaHighlightColor = patch.color;
    if (patch.strokeWidth) writes.adnotaStrokeWidth = patch.strokeWidth;
    if ('filled' in patch) writes.adnotaShapeFilled = !!patch.filled;
    if ('mode' in patch) writes.adnotaActiveMode = this.mode;
    if (Object.keys(writes).length) {
      // try/catch swallows "Extension context invalidated" — fires when the
      // extension reloads (dev iteration / auto-update) while content scripts
      // are still alive on open tabs. The page-side state update below must
      // still run, so we only guard the chrome.* call.
      try { chrome.storage.local.set(writes); } catch (_) {}
    }
    listeners.forEach(fn => fn(this));
  },

  subscribe(fn) {
    listeners.push(fn);
    fn(this); // Fire immediately so subscribers can initialize from current state.
  }
};

// ---------------------------------------------------------------------------
// Central Undo Stack — shared across ALL Adnota tools.
// Every tool pushes { undo: async fn } here instead of maintaining its own
// stack and keydown listener. This guarantees Ctrl+Z always undoes the most
// recent action regardless of which tool made it.
// ---------------------------------------------------------------------------
window.AdnotaUndo = {
  _stack: [],

  push(entry) {
    this._stack.push(entry);
    window.AdnotaLog?.event('state', 'undo-push', { stackDepth: this._stack.length });
  },

  // Pops and executes the latest undo entry. Returns true if one was found.
  undo() {
    if (this._stack.length === 0) return false;
    this._stack.pop().undo();
    window.AdnotaLog?.event('state', 'undo-pop', { stackDepth: this._stack.length });
    return true;
  },

  // Removes a specific entry from anywhere in the stack (used when the toast
  // "Undo" button fires first so Ctrl+Z doesn't re-run a stale entry).
  remove(entry) {
    const idx = this._stack.indexOf(entry);
    if (idx !== -1) this._stack.splice(idx, 1);
  }
};

// Single Ctrl+Z / Cmd+Z handler for the entire extension.
// Tools no longer need their own keydown listeners.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    // Defer to the browser's native text undo when focus is in an editable
    // surface (sticky textarea, host-page input, contenteditable). Otherwise
    // typing in a freshly placed sticky and pressing Ctrl+Z to fix a typo
    // would pop the "remove note" entry and delete the whole note.
    const el = e.target?.nodeType === 1 ? e.target : e.target?.parentElement;
    if (el?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
    if (window.AdnotaUndo.undo()) {
      e.preventDefault(); // Only suppress the event if we actually consumed it.
    }
  }
});

// ---------------------------------------------------------------------------
// Universal Escape = exit active tool.
//
// Window-capture beats page-level keydown listeners. The focus anchor below
// is the other half of the guarantee: cross-origin iframe ads (and any page
// script that calls .focus() on something) can steal focus away from our
// document, which routes keystrokes into their own event target and makes
// Escape unreachable. We park focus on a hidden Adnota-owned element whenever
// any tool is active, and yank it back if anything else grabs it.
// ---------------------------------------------------------------------------
const adnotaFocusAnchor = document.createElement('div');
adnotaFocusAnchor.id = 'adnota-focus-anchor';
adnotaFocusAnchor.setAttribute('data-adnota-ui', '1');
adnotaFocusAnchor.setAttribute('tabindex', '-1');
adnotaFocusAnchor.setAttribute('aria-hidden', 'true');
adnotaFocusAnchor.style.cssText =
  'position:fixed;top:0;left:0;width:0;height:0;opacity:0;pointer-events:none;outline:none;';

function anchorAdnotaFocus() {
  if (!window.AdnotaState.mode) return;
  if (!adnotaFocusAnchor.isConnected) {
    (document.body || document.documentElement).appendChild(adnotaFocusAnchor);
  }
  try { adnotaFocusAnchor.focus({ preventScroll: true }); } catch {}
}
// Exposed so tools that preventDefault on pointer events (eraser's page-click
// blocker) can explicitly reclaim focus after suppressing the implicit transfer.
window.AdnotaState.anchorFocus = anchorAdnotaFocus;

window.AdnotaState.subscribe((state) => {
  if (state.mode) anchorAdnotaFocus();
});

// Any focus move outside Adnota UI while a tool is active → steal it back.
window.addEventListener('focusin', (e) => {
  if (!window.AdnotaState.mode) return;
  if (!e.target || e.target === adnotaFocusAnchor) return;
  if (e.target.closest && e.target.closest('[data-adnota-ui]')) return;
  anchorAdnotaFocus();
}, true);

// Tab-switch round-trip (user clicked through an ad popup, came back) —
// browsers leave focus wherever it happened to land; re-anchor on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') anchorAdnotaFocus();
});

// Escape always exits the active tool. No preventDefault/stopPropagation so
// element-scoped handlers (e.g. marker text-editor cancel) still run after.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && window.AdnotaState.mode) {
    window.AdnotaState.set({ mode: null });
  }
}, true);

// Restore persisted color preference on load.
chrome.storage.local.get(['adnotaHighlightColor', 'adnotaStrokeWidth', 'adnotaShapeFilled'], (result) => {
  if (result.adnotaHighlightColor) {
    window.AdnotaState.set({ color: result.adnotaHighlightColor });
  }
  if (result.adnotaStrokeWidth) {
    window.AdnotaState.set({ strokeWidth: result.adnotaStrokeWidth });
  }
  if (typeof result.adnotaShapeFilled === 'boolean') {
    window.AdnotaState.set({ filled: result.adnotaShapeFilled });
  }
});

// ---------------------------------------------------------------------------
// Ephemeral visibility controller — single source of truth for "show vs hide
// all annotations". State is intentionally NOT persisted: every page load
// starts visible. This is a quick "get it out of my way" toggle, not a setting.
// ---------------------------------------------------------------------------

window.AdnotaVisibility = {
  hidden: false,
  _subs: [],

  toggle() {
    this.hidden = !this.hidden;
    window.AdnotaLog?.event('state', 'visibility', { hidden: this.hidden });
    this._apply();
    this._notify();
  },

  // Idempotently force annotations visible. Called whenever the user starts
  // doing work while hidden — hide mode must never block or obscure new edits.
  show() {
    if (!this.hidden) return;
    this.hidden = false;
    this._apply();
    this._notify();
  },

  subscribe(fn) {
    this._subs.push(fn);
    fn(this.hidden);
  },

  _notify() {
    this._subs.forEach(fn => fn(this.hidden));
    // Broadcast so extension contexts (popup) can sync their icon without
    // polling. Silently ignore when no listener is open.
    try {
      chrome.runtime.sendMessage({ action: 'visibility-changed', hidden: this.hidden })
        .catch(() => {});
    } catch {}
  },

  _apply() {
    const hidden = this.hidden;

    // 1. Root class drives CSS-based hiding for all Adnota DOM elements
    //    (sticky notes, marker wrappers, fallback highlight overlays).
    document.documentElement.classList.toggle('adnota-hidden', hidden);

    // 2. Inline-style erasures: tracked in a shared Set by eraser/restorer.
    if (window.AdnotaErasedElements) {
      for (const el of window.AdnotaErasedElements) {
        if (hidden) el.style.removeProperty('display');
        else el.style.setProperty('display', 'none', 'important');
      }
    }

    // 3. Toggle CSS-rule style tags that drive erasure + resize persistence.
    const eraseTag = document.getElementById('adnota-erase-overrides');
    if (eraseTag) eraseTag.disabled = hidden;
    const resizeTag = document.getElementById('adnota-style-overrides');
    if (resizeTag) resizeTag.disabled = hidden;

    // 4. CSS Custom Highlights API can't be toggled via display — inject a
    //    transient stylesheet that zeroes out every theme's background.
    const SHEET_ID = 'adnota-highlights-hidden';
    const existing = document.getElementById(SHEET_ID);
    if (hidden && !existing) {
      const s = document.createElement('style');
      s.id = SHEET_ID;
      s.setAttribute('data-adnota-ui', '1');
      s.textContent = `
        ::highlight(adnota-theme-yellow) { background-color: transparent !important; }
        ::highlight(adnota-theme-green)  { background-color: transparent !important; }
        ::highlight(adnota-theme-blue)   { background-color: transparent !important; }
        ::highlight(adnota-theme-pink)   { background-color: transparent !important; }
        ::highlight(adnota-theme-black)  { background-color: transparent !important; color: inherit !important; }
      `;
      document.head.appendChild(s);
    } else if (!hidden && existing) {
      existing.remove();
    }
  }
};

// Respond to cross-context queries: popup mode indicator and visibility sync.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'get-mode') {
    sendResponse({ mode: window.AdnotaState.mode });
    return true; // Keep channel open for the async response.
  }
  if (request.action === 'toggle-view') {
    window.AdnotaVisibility.toggle();
    return;
  }
  if (request.action === 'get-view') {
    sendResponse({ hidden: window.AdnotaVisibility.hidden });
    return true;
  }
  if (request.action === 'adnota-soft-delete') {
    window.AdnotaUI?.softDeleteItems({
      singular: request.singular,
      plural: request.plural,
      actionTypes: request.actionTypes,
      skipConfirm: request.skipConfirm,
    });
    return;
  }
});
