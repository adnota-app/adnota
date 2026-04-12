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
    listeners.forEach(fn => fn(this));
  },

  subscribe(fn) {
    listeners.push(fn);
    fn(this); // Fire immediately so subscribers can initialize from current state.
  }
};

// Restore persisted color preference on load.
chrome.storage.local.get(['vellumHighlightColor'], (result) => {
  if (result.vellumHighlightColor) {
    window.VellumState.set({ color: result.vellumHighlightColor });
  }
});
