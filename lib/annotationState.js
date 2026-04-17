// lib/annotationState.js

const listeners = [];

window.VellumState = {
  // Single source of truth for active tool.
  // null = no tool active | 'eraser' | 'sticky' | 'highlight' | 'pen' | 'resizer'
  // pen sub-tools: 'pen' (freehand), 'arrow', 'rect', 'ellipse', 'select'
  mode: null,
  color: 'vellum-theme-yellow',
  strokeWidth: 4,

  // Derived — true whenever any tool is active. Never set this directly;
  // it is computed automatically from mode so call sites stay simple.
  get isVisible() {
    return this.mode !== null;
  },

  set(patch) {
    // Whitelist allowed writable keys. 'isVisible' is intentionally excluded —
    // it is a derived getter and must not be overwritten via patch.
    const allowed = ['mode', 'color', 'strokeWidth'];
    for (const key of allowed) {
      if (key in patch) this[key] = patch[key];
    }
    if (patch.color) {
      chrome.storage.local.set({ vellumHighlightColor: patch.color });
    }
    if (patch.strokeWidth) {
      chrome.storage.local.set({ vellumStrokeWidth: patch.strokeWidth });
    }
    if ('mode' in patch) {
      // Persist the active mode so the popup can update its active-tool indicator
      // in real time when a keyboard shortcut fires while the popup is open.
      chrome.storage.local.set({ vellumActiveMode: this.mode });
    }
    listeners.forEach(fn => fn(this));
  },

  subscribe(fn) {
    listeners.push(fn);
    fn(this); // Fire immediately so subscribers can initialize from current state.
  }
};

// ---------------------------------------------------------------------------
// Central Undo Stack — shared across ALL Vellum tools.
// Every tool pushes { undo: async fn } here instead of maintaining its own
// stack and keydown listener. This guarantees Ctrl+Z always undoes the most
// recent action regardless of which tool made it.
// ---------------------------------------------------------------------------
window.VellumUndo = {
  _stack: [],

  push(entry) {
    this._stack.push(entry);
  },

  // Pops and executes the latest undo entry. Returns true if one was found.
  undo() {
    if (this._stack.length === 0) return false;
    this._stack.pop().undo();
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
    if (window.VellumUndo.undo()) {
      e.preventDefault(); // Only suppress the event if we actually consumed it.
    }
  }
});

// Restore persisted color preference on load.
chrome.storage.local.get(['vellumHighlightColor', 'vellumStrokeWidth'], (result) => {
  if (result.vellumHighlightColor) {
    window.VellumState.set({ color: result.vellumHighlightColor });
  }
  if (result.vellumStrokeWidth) {
    window.VellumState.set({ strokeWidth: result.vellumStrokeWidth });
  }
});

// ---------------------------------------------------------------------------
// Ephemeral visibility controller — single source of truth for "show vs hide
// all annotations". State is intentionally NOT persisted: every page load
// starts visible. This is a quick "get it out of my way" toggle, not a setting.
// ---------------------------------------------------------------------------

window.VellumVisibility = {
  hidden: false,
  _subs: [],

  toggle() {
    this.hidden = !this.hidden;
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

    // 1. Root class drives CSS-based hiding for all Vellum DOM elements
    //    (sticky notes, marker wrappers, fallback highlight overlays).
    document.documentElement.classList.toggle('vellum-hidden', hidden);

    // 2. Inline-style erasures: tracked in a shared Set by eraser/restorer.
    if (window.VellumErasedElements) {
      for (const el of window.VellumErasedElements) {
        if (hidden) el.style.removeProperty('display');
        else el.style.setProperty('display', 'none', 'important');
      }
    }

    // 3. Toggle CSS-rule style tags that drive erasure + resize persistence.
    const eraseTag = document.getElementById('vellum-erase-overrides');
    if (eraseTag) eraseTag.disabled = hidden;
    const resizeTag = document.getElementById('vellum-style-overrides');
    if (resizeTag) resizeTag.disabled = hidden;

    // 4. CSS Custom Highlights API can't be toggled via display — inject a
    //    transient stylesheet that zeroes out every theme's background.
    const SHEET_ID = 'vellum-highlights-hidden';
    const existing = document.getElementById(SHEET_ID);
    if (hidden && !existing) {
      const s = document.createElement('style');
      s.id = SHEET_ID;
      s.setAttribute('data-vellum-ui', '1');
      s.textContent = `
        ::highlight(vellum-theme-yellow) { background-color: transparent !important; }
        ::highlight(vellum-theme-green)  { background-color: transparent !important; }
        ::highlight(vellum-theme-blue)   { background-color: transparent !important; }
        ::highlight(vellum-theme-pink)   { background-color: transparent !important; }
        ::highlight(vellum-theme-black)  { background-color: transparent !important; color: inherit !important; }
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
    sendResponse({ mode: window.VellumState.mode });
    return true; // Keep channel open for the async response.
  }
  if (request.action === 'toggle-view') {
    window.VellumVisibility.toggle();
    return;
  }
  if (request.action === 'get-view') {
    sendResponse({ hidden: window.VellumVisibility.hidden });
    return true;
  }
});
