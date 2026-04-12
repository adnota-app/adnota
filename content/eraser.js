// content/eraser.js

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

// Route the keyboard shortcut through VellumState — toggles eraser off if already active.
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-eraser') {
    window.VellumState.set({ mode: window.VellumState.mode === 'eraser' ? null : 'eraser' });
  }
});

// React to VellumState changes — clean up overlay whenever eraser is not the active mode.
window.VellumState.subscribe(state => {
  if (state.mode !== 'eraser') {
    highlightOverlay.style.display = 'none';
    hoveredElement = null;
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

    // Capture state before any mutation.
    const savedCssText = target.style.cssText;
    const anchor = window.FuzzyAnchor.generate(target);
    const pathScope = e.shiftKey ? '*' : location.pathname;
    const domain = location.hostname;
    anchor._id = Date.now() + Math.random().toString();

    target.style.setProperty('display', 'none', 'important');
    highlightOverlay.style.display = 'none';

    if (window.VellumStorage) {
      await window.VellumStorage.saveAnchor(domain, pathScope, anchor);
    }

    // Build shared undo closure — used by BOTH the toast button and Ctrl+Z.
    // The `consumed` flag prevents a double-undo if both fire.
    let consumed = false;
    const undoEntry = {
      undo: async () => {
        if (consumed) return;
        consumed = true;
        target.style.cssText = savedCssText;
        const orphanedAlert = document.getElementById(`vellum-alert-${anchor._id}`);
        if (orphanedAlert) orphanedAlert.remove();
        if (window.VellumStorage) {
          const data = await chrome.storage.local.get(domain);
          if (data[domain]) {
            data[domain].items = data[domain].items.filter(i => i._id !== anchor._id);
            await chrome.storage.local.set({ [domain]: data[domain] });
          }
        }
        // Pull the entry out of the global stack so Ctrl+Z can't hit it again.
        window.VellumUndo.remove(undoEntry);
      }
    };
    window.VellumUndo.push(undoEntry);

    // Toast — calls the same closure so Ctrl+Z and toast are always in sync.
    let existingToast = document.getElementById('vellum-eraser-toast');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.id = 'vellum-eraser-toast';
    toast.className = 'vellum-toast';
    toast.innerHTML = `<span>Element erased</span> <span class="vellum-toast-undo">Undo</span>`;
    document.body.appendChild(toast);

    toast.querySelector('.vellum-toast-undo').addEventListener('click', () => {
      undoEntry.undo();
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    });

    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      }
    }, 5000);
  }
}, true); // Capture phase so we intercept before page handlers
