// content/eraser.js

let isEraserMode = false;
let sessionUndoStack = [];

// Overlay to indicate target
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

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-eraser') {
    isEraserMode = !isEraserMode;
    toggleEraserState(isEraserMode);
  }
});

function toggleEraserState(active) {
  if (active) {
    document.body.style.cursor = 'crosshair';
  } else {
    document.body.style.cursor = '';
    highlightOverlay.style.display = 'none';
    hoveredElement = null;
  }
}

// Keyboard shortcut (Alt+E as backup or main if background doesn't catch)
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key.toLowerCase() === 'e') {
    // Rely mostly on the background script intercept, but we can do a localized toggle if needed
  }
  if (isEraserMode && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undoLastRemoval();
  }
});

document.addEventListener('mousemove', (e) => {
  if (!isEraserMode) return;
  const target = document.elementFromPoint(e.clientX, e.clientY);
  
  if (target && target !== highlightOverlay && !target.closest('.vellum-toast') && !target.closest('.vellum-sticky-container')) {
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
  if (!isEraserMode) return;
  
  if (hoveredElement) {
    e.preventDefault();
    e.stopPropagation();

    const target = hoveredElement;
    
    // Generate anchor before mutating styles
    const anchor = window.FuzzyAnchor.generate(target);
    
    // Calculate scope
    const pathScope = e.shiftKey ? '*' : location.pathname;
    const domain = location.hostname;
    
    // Add internal unique ID to anchor to allow undo removing it from storage
    anchor._id = Date.now() + Math.random().toString();
    
    // Undo stack push
    sessionUndoStack.push({
      element: target,
      cssText: target.style.cssText,
      storageDomain: domain,
      storageId: anchor._id
    });

    // Remove
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
}, true); // Use capture phase

async function undoLastRemoval() {
  const entry = sessionUndoStack.pop();
  if (entry && entry.element) {
    // Restore element
    entry.element.style.cssText = entry.cssText;
    
    // Clean up any orphaned amber UI alerts
    const orphanedAlert = document.getElementById(`vellum-alert-${entry.storageId}`);
    if (orphanedAlert) orphanedAlert.remove();

    // Attempt to remove from DB for MVP so it's a true undo
    if (window.VellumStorage) {
      const data = await chrome.storage.local.get(entry.storageDomain);
      if (data[entry.storageDomain]) {
        data[entry.storageDomain].items = data[entry.storageDomain].items.filter(i => i._id !== entry.storageId);
        await chrome.storage.local.set({ [entry.storageDomain]: data[entry.storageDomain] });
      }
    }
  }
}
