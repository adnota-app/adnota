// lib/annotationState.js

const listeners = [];

window.VellumState = {
  // Single source of truth for active tool.
  // null = no tool active | 'eraser' | 'sticky' | 'highlight' | 'pen'
  mode: null,
  color: 'vellum-theme-yellow',

  // Derived — true whenever any tool is active. Never set this directly;
  // it is computed automatically from mode so call sites stay simple.
  get isVisible() {
    return this.mode !== null;
  },

  set(patch) {
    // Whitelist allowed writable keys. 'isVisible' is intentionally excluded —
    // it is a derived getter and must not be overwritten via patch.
    const allowed = ['mode', 'color'];
    for (const key of allowed) {
      if (key in patch) this[key] = patch[key];
    }
    if (patch.color) {
      chrome.storage.local.set({ vellumHighlightColor: patch.color });
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
chrome.storage.local.get(['vellumHighlightColor'], (result) => {
  if (result.vellumHighlightColor) {
    window.VellumState.set({ color: result.vellumHighlightColor });
  }
});

// Respond to the popup's mode query so it can highlight the active tool card.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'get-mode') {
    sendResponse({ mode: window.VellumState.mode });
    return true; // Keep channel open for the async response.
  }
});
