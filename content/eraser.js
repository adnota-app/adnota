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

// ─── Animation helpers ────────────────────────────────────────────────────────

/**
 * Two expanding ring ripples at the cursor's click position, staggered 90ms apart.
 * Feels like pressing a physical button — satisfying and tactile.
 */
function spawnRipples(x, y) {
  // [0, 90].forEach(delay => {
  //   setTimeout(() => {
  //     const ring = document.createElement('div');
  //     ring.setAttribute('data-vellum-ui', '1');
  //     Object.assign(ring.style, {
  //       position: 'fixed',
  //       left: x + 'px',
  //       top: y + 'px',
  //       width: '5px',
  //       height: '5px',
  //       borderRadius: '50%',
  //       border: '1px solid rgba(239,68,68,0.75)',
  //       background: 'transparent',
  //       transform: 'translate(-50%,-50%)',
  //       pointerEvents: 'none',
  //       zIndex: '2147483647',
  //     });
  //     document.documentElement.appendChild(ring);

  //     ring.animate([
  //       { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
  //       { transform: 'translate(-50%,-50%) scale(9)', opacity: 0 }
  //     ], {
  //       duration: 520,
  //       easing: 'cubic-bezier(0.15, 0, 0.75, 1)',
  //     }).finished.then(() => ring.remove()).catch(() => { });
  //   }, delay);
  // });
}

/**
 * Momentary red-tinted border flash that traces the element's bounding box.
 * Confirms to the eye exactly what's being erased before it dissolves.
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
 * Returns the Animation object so the undo handler can cancel it.
 *
 * Sequence:
 *   0%→12%  slight scale-up (resistance/awareness)
 *   12%→50% blur begins, opacity drops
 *   50%→100% full blur + fade + downward drift (vaporises)
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
});

// ─── React to mode changes ────────────────────────────────────────────────────
window.VellumState.subscribe(state => {
  if (state.mode !== 'eraser') {
    highlightOverlay.style.display = 'none';
    hoveredElement = null;
  }
});

// ─── Hover: keep overlay pinned to the target ─────────────────────────────────
document.addEventListener('mousemove', (e) => {
  if (window.VellumState.mode !== 'eraser') return;
  const target = document.elementFromPoint(e.clientX, e.clientY);

  if (target && !isVellumElement(target)) {
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
}, { passive: true });

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
  const pathScope = e.shiftKey ? '*' : location.pathname;
  const domain = location.hostname;
  anchor._id = Date.now() + Math.random().toString();

  highlightOverlay.style.display = 'none';
  hoveredElement = null;

  // ── Fire all three animation effects in parallel ──
  spawnRipples(e.clientX, e.clientY);
  spawnFlash(rect);
  let activeAnimation = dissolveTarget(target);

  // After dissolve completes → apply permanent display:none.
  // Wrapped in a `consumed` check so undo can safely cancel mid-flight.
  let consumed = false;
  activeAnimation.finished.then(() => {
    if (!consumed) {
      target.style.setProperty('display', 'none', 'important');
      try { activeAnimation.cancel(); } catch { }
      activeAnimation = null;
    }
  }).catch(() => {
    // Animation was cancelled by undo — do nothing.
  });

  // Save to storage immediately (don't block the animation on I/O).
  if (window.VellumStorage) {
    window.VellumStorage.saveAnchor(domain, pathScope, anchor).catch(() => { });
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

      // Delete the erasure record from storage.
      if (window.VellumStorage) {
        const data = await chrome.storage.local.get(domain);
        if (data[domain]) {
          data[domain].items = data[domain].items.filter(i => i._id !== anchor._id);
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

}, true); // Capture phase — intercept before the page's own handlers.
