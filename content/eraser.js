// content/eraser.js

// ─── Hover overlay ────────────────────────────────────────────────────────────
const highlightOverlay = document.createElement('div');
highlightOverlay.id = 'vellum-highlight-overlay';
Object.assign(highlightOverlay.style, {
  position: 'absolute',
  pointerEvents: 'none',
  border: '2px solid red',
  backgroundColor: 'rgba(255, 0, 0, 0.07)',
  zIndex: '999999',
  transition: 'all 0.08s ease',
  display: 'none',
  borderRadius: '2px',
});
document.documentElement.appendChild(highlightOverlay);

let hoveredElement = null;
let rawHoveredEl = null;     // actual element under cursor (before traversal)
let traverseDepth = 0;       // 0 = raw element, >0 = walked up N parents
let areErasuresVisible = true;

// Shared set of erased elements — restorer.js also adds to this.
window.VellumErasedElements = new Set();

// ─── CSS rule injection for persistent erasure ──────────────────────────────
// Erased elements get a CSS rule so that if the element is destroyed and re-created
// (e.g. ad rotation timers), the browser automatically hides the new instance.
window.VellumEraseRules = new Map(); // id → cssSelector

function getOrCreateEraseStyleTag() {
  let tag = document.getElementById('vellum-erase-overrides');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'vellum-erase-overrides';
    tag.setAttribute('data-vellum-ui', '1');
    document.head.appendChild(tag);
  }
  return tag;
}

function rebuildEraseStyleTag() {
  const tag = getOrCreateEraseStyleTag();
  const rules = [];
  for (const [, selector] of window.VellumEraseRules) {
    rules.push(`${selector} { display: none !important; }`);
  }
  tag.textContent = rules.join('\n');
}
window.rebuildEraseStyleTag = rebuildEraseStyleTag;

// ─── Guard: Vellum-owned elements are invisible to the eraser ─────────────────
function isVellumElement(el) {
  if (!el) return false;
  return !!(
    el.closest('[data-vellum-ui]') ||
    el.closest('#vellum-highlighter-widget') ||
    el.closest('#vellum-eraser-toast') ||
    el.closest('.vellum-toast') ||
    el.closest('.vellum-sticky-container') ||
    el.closest('.vellum-marker-wrapper') ||
    el.closest('#vellum-capture-canvas') ||
    el.closest('#vellum-highlight-overlay')
  );
}

// ─── DOM traversal: walk up N parents, skip Vellum elements ─────────────────
function getEraserTarget(raw, depth) {
  if (!raw || isVellumElement(raw)) return null;
  let current = raw;
  let walked = 0;
  while (walked < depth && current.parentElement &&
         current.parentElement !== document.body &&
         current.parentElement !== document.documentElement) {
    current = current.parentElement;
    if (isVellumElement(current)) return null;
    walked++;
  }
  return current;
}

function updateEraserOverlay() {
  const target = getEraserTarget(rawHoveredEl, traverseDepth);
  if (target) {
    hoveredElement = target;
    const rect = target.getBoundingClientRect();
    const scrollY = window.pageYOffset || document.documentElement.scrollTop;
    const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
    Object.assign(highlightOverlay.style, {
      display: 'block',
      top: `${rect.top + scrollY}px`,
      left: `${rect.left + scrollX}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  } else {
    hoveredElement = null;
    highlightOverlay.style.display = 'none';
  }
}

// ─── Animation helpers ────────────────────────────────────────────────────────

function spawnRipples(x, y) {
  // Reserved for future re-enablement.
}

/**
 * Momentary red-tinted border flash that traces the element's bounding box.
 */
function spawnFlash(rect) {
  const flash = document.createElement('div');
  flash.setAttribute('data-vellum-ui', '1');
  Object.assign(flash.style, {
    position: 'fixed',
    left: rect.left + 'px',
    top: rect.top + 'px',
    width: rect.width + 'px',
    height: rect.height + 'px',
    background: 'rgba(239,68,68,0.09)',
    border: '10px solid rgba(239,68,68,0.25)',
    borderRadius: '3px',
    pointerEvents: 'none',
    zIndex: '2147483646',
    boxSizing: 'border-box',
  });
  document.documentElement.appendChild(flash);

  flash.animate([
    { opacity: 1 },
    { opacity: 0 }
  ], { duration: 260, easing: 'ease-out' })
    .finished.then(() => flash.remove()).catch(() => { });
}

/**
 * Dissolve animation on the target element itself.
 */
function dissolveTarget(target) {
  return target.animate([
    { opacity: '1', transform: 'scale(1)', filter: 'blur(0px)' },
    { opacity: '.92', transform: 'scale(1.03)', filter: 'blur(0px)', offset: 0.12 },
    { opacity: '0.4', transform: 'scale(0.97)', filter: 'blur(2.5px)', offset: 0.50 },
    { opacity: '0', transform: 'scale(0.8) translateY(6px)', filter: 'blur(9px)' }
  ], {
    duration: 440,
    easing: 'ease-in',
    fill: 'forwards',
  });
}

// ─── Message routing ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-eraser') {
    window.VellumState.set({ mode: window.VellumState.mode === 'eraser' ? null : 'eraser' });
  }

  if (request.action === 'toggle-view') {
    areErasuresVisible = !areErasuresVisible;
    for (const el of window.VellumErasedElements) {
      if (areErasuresVisible) {
        el.style.setProperty('display', 'none', 'important');
      } else {
        el.style.removeProperty('display');
      }
    }
    // Also toggle the CSS rule style tag (covers re-created elements like ads)
    const eraseTag = document.getElementById('vellum-erase-overrides');
    if (eraseTag) eraseTag.disabled = !areErasuresVisible;
  }
});

// ─── Seed erase visibility from storage on load ─────────────────────────────
chrome.storage.local.get(['vellumHidden'], (result) => {
  if (result.vellumHidden) {
    areErasuresVisible = false;
    const eraseTag = document.getElementById('vellum-erase-overrides');
    if (eraseTag) eraseTag.disabled = true;
  }
});

// ─── React to mode changes ────────────────────────────────────────────────────
window.VellumState.subscribe(state => {
  if (state.mode !== 'eraser') {
    highlightOverlay.style.display = 'none';
    hoveredElement = null;
    rawHoveredEl = null;
    traverseDepth = 0;
  }
});

// ─── Hover: track raw element and update overlay ─────────────────────────────
document.addEventListener('mousemove', (e) => {
  if (window.VellumState.mode !== 'eraser') return;
  const raw = document.elementFromPoint(e.clientX, e.clientY);

  if (!raw || isVellumElement(raw)) {
    hoveredElement = null;
    rawHoveredEl = null;
    highlightOverlay.style.display = 'none';
    return;
  }

  // Reset traverse depth when cursor moves to a different element
  if (raw !== rawHoveredEl) {
    rawHoveredEl = raw;
    traverseDepth = 0;
  }

  updateEraserOverlay();
}, { passive: true });

// ─── Scroll wheel: walk up/down the DOM tree while hovering ─────────────────
document.addEventListener('wheel', (e) => {
  if (window.VellumState.mode !== 'eraser') return;
  if (!rawHoveredEl) return;

  e.preventDefault();

  if (e.deltaY < 0) {
    // Scroll up → walk to parent
    traverseDepth++;
  } else {
    // Scroll down → walk back toward child
    traverseDepth = Math.max(0, traverseDepth - 1);
  }

  updateEraserOverlay();
}, { passive: false });

// ─── Click: erase with animation ─────────────────────────────────────────────
document.addEventListener('click', async (e) => {
  if (window.VellumState.mode !== 'eraser') return;
  if (isVellumElement(e.target)) return;
  if (!hoveredElement) return;

  e.preventDefault();
  e.stopPropagation();

  const target = hoveredElement;
  const rect = target.getBoundingClientRect();
  const savedCssText = target.style.cssText;

  // Capture anchor before any DOM mutation.
  const anchor = window.FuzzyAnchor.generate(target);
  const cssSelector = window.FuzzyAnchor.generateCSSSelector(target);
  const pathScope = e.shiftKey ? '*' : location.pathname;
  const domain = location.hostname;
  const id = Date.now() + Math.random().toString();

  // Inject CSS rule so the element stays hidden even if re-created (ad rotation, etc.)
  window.VellumEraseRules.set(id, cssSelector);
  rebuildEraseStyleTag();

  highlightOverlay.style.display = 'none';
  hoveredElement = null;

  // ── Fire all three animation effects in parallel ──
  spawnRipples(e.clientX, e.clientY);
  spawnFlash(rect);
  let activeAnimation = dissolveTarget(target);

  // After dissolve completes → apply permanent display:none.
  let consumed = false;
  activeAnimation.finished.then(() => {
    if (!consumed) {
      target.style.setProperty('display', 'none', 'important');
      window.VellumErasedElements.add(target);
      try { activeAnimation.cancel(); } catch { }
      activeAnimation = null;
    }
  }).catch(() => {
    // Animation was cancelled by undo — do nothing.
  });

  // Save to storage immediately (don't block the animation on I/O).
  if (window.VellumStorage) {
    window.VellumStorage.saveItem(domain, pathScope, { action: 'ERASE', anchor, selector: cssSelector, _id: id }).catch(() => { });
  }

  // ── Shared undo closure — used by both toast button and Ctrl+Z ──
  const undoEntry = {
    undo: async () => {
      if (consumed) return;
      consumed = true;

      // Kill the dissolve if it's still mid-flight.
      if (activeAnimation) {
        try { activeAnimation.cancel(); } catch { }
        activeAnimation = null;
      }

      // Restore element to exactly where it was.
      target.style.cssText = savedCssText;
      window.VellumErasedElements.delete(target);

      // Remove the CSS rule that prevents re-creation.
      window.VellumEraseRules.delete(id);
      rebuildEraseStyleTag();

      // Delete the erasure record from storage.
      if (window.VellumStorage) {
        const data = await chrome.storage.local.get(domain);
        if (data[domain]) {
          data[domain].items = data[domain].items.filter(i => i._id !== id);
          await chrome.storage.local.set({ [domain]: data[domain] });
        }
      }

      window.VellumUndo.remove(undoEntry);
    }
  };
  window.VellumUndo.push(undoEntry);

  // ── Toast ──
  let existingToast = document.getElementById('vellum-eraser-toast');
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.id = 'vellum-eraser-toast';
  toast.className = 'vellum-toast';
  toast.setAttribute('data-vellum-ui', '1');
  toast.innerHTML = `
    <div class="vellum-toast-logo">V</div>
    <span class="vellum-toast-message">Element erased</span>
    <div class="vellum-toast-actions">
      <span class="vellum-toast-undo">Undo</span>
    </div>
  `;
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

}, true); // Capture phase — intercept before the page's own handlers.
