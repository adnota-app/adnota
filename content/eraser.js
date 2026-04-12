// content/eraser.js

let sessionUndoStack = [];

// Overlay to indicate the current erase target
const highlightOverlay = document.createElement('div');
highlightOverlay.id = 'vellum-highlight-overlay';
Object.assign(highlightOverlay.style, {
  position: 'absolute',
  pointerEvents: 'none',
  border: '2px solid red',
  backgroundColor: 'rgba(255, 0, 0, 0.1)',
  zIndex: '999999',
  transition: 'all 0.1s ease',
  display: 'none'
});
document.documentElement.appendChild(highlightOverlay);

let hoveredElement = null;

// Central guard: returns true for any element that is part of Vellum's own UI.
// Applied to both mousemove (hover targeting) and click (erase action) so our
// own chrome is completely invisible to the eraser tool.
function isVellumElement(el) {
  if (!el) return false;
  return !!(
    el.closest('#vellum-highlighter-widget') ||
    el.closest('#vellum-eraser-toast')       ||
    el.closest('.vellum-toast')              ||
    el.closest('.vellum-sticky-container')   ||
    el.closest('.vellum-marker-wrapper')     ||
    el.closest('#vellum-capture-canvas')     ||
    el.closest('#vellum-highlight-overlay')
  );
}

// Route the keyboard shortcut through VellumState — toggles eraser off if already active,
// which also automatically deactivates any other tool that was running.
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-eraser') {
    window.VellumState.set({ mode: window.VellumState.mode === 'eraser' ? null : 'eraser' });
  }
});

// React to VellumState changes — clean up highlight overlay whenever eraser is not the active mode.
window.VellumState.subscribe(state => {
  if (state.mode !== 'eraser') {
    highlightOverlay.style.display = 'none';
    hoveredElement = null;
  }
});

// Ctrl/Cmd+Z undo (session-only, eraser mode only)
document.addEventListener('keydown', (e) => {
  if (window.VellumState.mode === 'eraser' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undoLastRemoval();
  }
});

document.addEventListener('mousemove', (e) => {
  if (window.VellumState.mode !== 'eraser') return;
  const target = document.elementFromPoint(e.clientX, e.clientY);

  if (target && !isVellumElement(target)) {
    hoveredElement = target;
    const rect = target.getBoundingClientRect();
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    Object.assign(highlightOverlay.style, {
      display: 'block',
      top: `${rect.top + scrollTop}px`,
      left: `${rect.left + scrollLeft}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });
  } else {
    hoveredElement = null;
    highlightOverlay.style.display = 'none';
  }
}, { passive: true });

document.addEventListener('click', async (e) => {
  if (window.VellumState.mode !== 'eraser') return;

  // Pass through clicks on any Vellum-owned UI — the eraser must never
  // consume events meant for our own toolbar, toast, or sticky notes.
  if (isVellumElement(e.target)) return;

  if (hoveredElement) {
    e.preventDefault();
    e.stopPropagation();

    const target = hoveredElement;

    // Generate anchor before mutating the DOM
    const anchor = window.FuzzyAnchor.generate(target);

    // Scope: exact path or domain-wide on Shift+Click
    const pathScope = e.shiftKey ? '*' : location.pathname;
    const domain = location.hostname;

    anchor._id = Date.now() + Math.random().toString();

    sessionUndoStack.push({
      element: target,
      cssText: target.style.cssText,
      storageDomain: domain,
      storageId: anchor._id
    });

    target.style.setProperty('display', 'none', 'important');
    highlightOverlay.style.display = 'none';

    if (window.VellumStorage) {
      await window.VellumStorage.saveAnchor(domain, pathScope, anchor);
    }

    let existingToast = document.getElementById('vellum-eraser-toast');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.id = 'vellum-eraser-toast';
    toast.className = 'vellum-toast';
    toast.innerHTML = `<span>Element erased</span> <span class="vellum-toast-undo">Undo</span>`;
    document.body.appendChild(toast);

    let undoClicked = false;
    toast.querySelector('.vellum-toast-undo').addEventListener('click', () => {
      undoClicked = true;
      undoLastRemoval();
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    });

    setTimeout(() => {
      if (toast.parentNode && !undoClicked) {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      }
    }, 5000);
  }
}, true); // Capture phase so we intercept before page handlers

async function undoLastRemoval() {
  const entry = sessionUndoStack.pop();
  if (entry && entry.element) {
    entry.element.style.cssText = entry.cssText;

    const orphanedAlert = document.getElementById(`vellum-alert-${entry.storageId}`);
    if (orphanedAlert) orphanedAlert.remove();

    if (window.VellumStorage) {
      const data = await chrome.storage.local.get(entry.storageDomain);
      if (data[entry.storageDomain]) {
        data[entry.storageDomain].items = data[entry.storageDomain].items.filter(i => i._id !== entry.storageId);
        await chrome.storage.local.set({ [entry.storageDomain]: data[entry.storageDomain] });
      }
    }
  }
}
