// content/resizer.js — Drag-to-resize elements
(() => {
'use strict';

// ─── Inline element tags to skip during bubble-up ────────────────────────────
const INLINE_TAGS = new Set([
  'SPAN', 'A', 'EM', 'STRONG', 'B', 'I', 'CODE', 'LABEL',
  'ABBR', 'SMALL', 'SUB', 'SUP', 'TIME', 'KBD', 'SAMP', 'VAR',
]);

const MIN_WIDTH = 120;
const MIN_HEIGHT = 60;

// ─── Hover overlay (blue) ────────────────────────────────────────────────────
const hoverOverlay = window.VellumUI.createHoverOverlay('vellum-resizer-overlay', '#3b82f6', 'rgba(59, 130, 246, 0.07)');

let hoveredEl = null;
let selectedEl = null;
let rawHoveredEl = null;   // the actual element under the cursor (before bubble-up)
let traverseDepth = 0;     // 0 = natural bubble-up target, >0 = walked up N parents

// ─── Handle elements ─────────────────────────────────────────────────────────
let handleLeft = null;
let handleRight = null;
let handleBottom = null;
let handleCorner = null;
let selectionBox = null;
let dismissBtn = null;

// ─── Drag state ──────────────────────────────────────────────────────────────
let dragAxis = null;       // 'x' | 'x-left' | 'y' | 'xy'
let dragStartX = 0;
let dragStartY = 0;
let startWidth = 0;
let startHeight = 0;
let startMarginLeft = 0;

// ─── Guard: Vellum-owned elements ────────────────────────────────────────────
const isVellumElement = window.VellumUI.isVellumElement;

// ─── Smart element targeting: bubble up to layout-significant elements ───────
// extraLevels: walk up N additional qualifying parents past the natural target
function findLayoutTarget(el, extraLevels = 0) {
  let current = el;
  let skipped = 0;
  while (current && current !== document.body && current !== document.documentElement) {
    if (isVellumElement(current)) return null;
    const rect = current.getBoundingClientRect();
    const isInline = INLINE_TAGS.has(current.tagName);
    const isBigEnough = rect.width >= MIN_WIDTH && rect.height >= MIN_HEIGHT;
    if (!isInline && isBigEnough) {
      if (skipped >= extraLevels) return current;
      skipped++;
    }
    current = current.parentElement;
  }
  return null;
}

// ─── CSS selector generation (shared from FuzzyAnchor) ──────────────────────
function generateCSSSelector(el) {
  return window.FuzzyAnchor.generateCSSSelector(el);
}

// ─── Style injection engine ──────────────────────────────────────────────────
function getStyleTag() {
  let tag = document.getElementById('vellum-style-overrides');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'vellum-style-overrides';
    tag.setAttribute('data-vellum-ui', '1');
    document.head.appendChild(tag);
  }
  return tag;
}

function injectRule(selector, cssText) {
  const tag = getStyleTag();
  tag.textContent += `${selector} { ${cssText} }\n`;
}

function removeRule(selector, cssText) {
  const tag = getStyleTag();
  const ruleString = `${selector} { ${cssText} }\n`;
  tag.textContent = tag.textContent.replace(ruleString, '');
}

// ─── Selection: show drag handles around an element ──────────────────────────
function selectElement(el) {
  deselectElement();
  selectedEl = el;
  hoverOverlay.style.display = 'none';

  const rect = el.getBoundingClientRect();
  const scrollY = window.pageYOffset || document.documentElement.scrollTop;
  const scrollX = window.pageXOffset || document.documentElement.scrollLeft;

  // Selection outline
  selectionBox = document.createElement('div');
  selectionBox.className = 'vellum-resizer-selection';
  selectionBox.setAttribute('data-vellum-ui', '1');
  positionBox(selectionBox, rect, scrollX, scrollY);
  document.documentElement.appendChild(selectionBox);

  // Left-edge handle (width — shrink by dragging right, or grow by dragging left)
  handleLeft = createHandle('vellum-resizer-handle-left', 'ew-resize');
  positionHandleLeft(handleLeft, rect, scrollX, scrollY);
  handleLeft.addEventListener('mousedown', (e) => startDrag(e, 'x-left'));
  document.documentElement.appendChild(handleLeft);

  // Right-edge handle (width)
  handleRight = createHandle('vellum-resizer-handle-right', 'ew-resize');
  positionHandleRight(handleRight, rect, scrollX, scrollY);
  handleRight.addEventListener('mousedown', (e) => startDrag(e, 'x'));
  document.documentElement.appendChild(handleRight);

  // Bottom-edge handle (height)
  handleBottom = createHandle('vellum-resizer-handle-bottom', 'ns-resize');
  positionHandleBottom(handleBottom, rect, scrollX, scrollY);
  handleBottom.addEventListener('mousedown', (e) => startDrag(e, 'y'));
  document.documentElement.appendChild(handleBottom);

  // Corner handle (both)
  handleCorner = createHandle('vellum-resizer-handle-corner', 'nwse-resize');
  positionHandleCorner(handleCorner, rect, scrollX, scrollY);
  handleCorner.addEventListener('mousedown', (e) => startDrag(e, 'xy'));
  document.documentElement.appendChild(handleCorner);

  // Dismiss / reset button (top-right corner)
  dismissBtn = document.createElement('button');
  dismissBtn.className = 'vellum-resizer-dismiss';
  dismissBtn.setAttribute('data-vellum-ui', '1');
  dismissBtn.innerHTML = '✕';
  dismissBtn.title = 'Reset all resizes on this element';
  positionDismiss(dismissBtn, rect, scrollX, scrollY);
  dismissBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  dismissBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    resetElement(el);
  });
  document.documentElement.appendChild(dismissBtn);
}

function deselectElement() {
  selectedEl = null;
  if (selectionBox) { selectionBox.remove(); selectionBox = null; }
  if (handleLeft)   { handleLeft.remove();   handleLeft = null; }
  if (handleRight)  { handleRight.remove();  handleRight = null; }
  if (handleBottom) { handleBottom.remove();  handleBottom = null; }
  if (handleCorner) { handleCorner.remove();  handleCorner = null; }
  if (dismissBtn)   { dismissBtn.remove();   dismissBtn = null; }
}

function createHandle(className, cursor) {
  const h = document.createElement('div');
  h.className = className;
  h.setAttribute('data-vellum-ui', '1');
  h.style.cursor = cursor;
  return h;
}

function positionBox(box, rect, sx, sy) {
  Object.assign(box.style, {
    top:    `${rect.top + sy}px`,
    left:   `${rect.left + sx}px`,
    width:  `${rect.width}px`,
    height: `${rect.height}px`,
  });
}

function clampToViewport(idealTop, idealLeft, handleW, handleH, sx, sy) {
  // Clamp so the handle stays within the visible viewport (with 4px margin)
  const vpTop  = sy + 4;
  const vpBot  = sy + window.innerHeight - handleH - 4;
  const vpLeft = sx + 4;
  const vpRight = sx + window.innerWidth - handleW - 4;
  return {
    top:  Math.max(vpTop, Math.min(vpBot, idealTop)),
    left: Math.max(vpLeft, Math.min(vpRight, idealLeft)),
  };
}

function positionHandleLeft(h, rect, sx, sy) {
  const idealTop  = rect.top + sy + rect.height / 2 - 14;
  const idealLeft = rect.left + sx - 4;
  const clamped = clampToViewport(idealTop, idealLeft, 8, 28, sx, sy);
  Object.assign(h.style, {
    top:  `${clamped.top}px`,
    left: `${clamped.left}px`,
  });
}

function positionHandleRight(h, rect, sx, sy) {
  const idealTop  = rect.top + sy + rect.height / 2 - 14;
  const idealLeft = rect.right + sx - 4;
  const clamped = clampToViewport(idealTop, idealLeft, 8, 28, sx, sy);
  Object.assign(h.style, {
    top:  `${clamped.top}px`,
    left: `${clamped.left}px`,
  });
}

function positionHandleBottom(h, rect, sx, sy) {
  const idealTop  = rect.bottom + sy - 4;
  const idealLeft = rect.left + sx + rect.width / 2 - 14;
  const clamped = clampToViewport(idealTop, idealLeft, 28, 8, sx, sy);
  Object.assign(h.style, {
    top:  `${clamped.top}px`,
    left: `${clamped.left}px`,
  });
}

function positionHandleCorner(h, rect, sx, sy) {
  const idealTop  = rect.bottom + sy - 5;
  const idealLeft = rect.right + sx - 5;
  const clamped = clampToViewport(idealTop, idealLeft, 10, 10, sx, sy);
  Object.assign(h.style, {
    top:  `${clamped.top}px`,
    left: `${clamped.left}px`,
  });
}

function positionDismiss(btn, rect, sx, sy) {
  const idealTop  = rect.top + sy - 10;
  const idealLeft = rect.right + sx - 10;
  const clamped = clampToViewport(idealTop, idealLeft, 20, 20, sx, sy);
  Object.assign(btn.style, {
    top:  `${clamped.top}px`,
    left: `${clamped.left}px`,
  });
}

function refreshHandles() {
  if (!selectedEl) return;
  const rect = selectedEl.getBoundingClientRect();
  const scrollY = window.pageYOffset || document.documentElement.scrollTop;
  const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
  if (selectionBox) positionBox(selectionBox, rect, scrollX, scrollY);
  if (handleLeft)   positionHandleLeft(handleLeft, rect, scrollX, scrollY);
  if (handleRight)  positionHandleRight(handleRight, rect, scrollX, scrollY);
  if (handleBottom) positionHandleBottom(handleBottom, rect, scrollX, scrollY);
  if (handleCorner) positionHandleCorner(handleCorner, rect, scrollX, scrollY);
  if (dismissBtn)   positionDismiss(dismissBtn, rect, scrollX, scrollY);
}

// ─── Reset: remove ALL resize rules for a given element ─────────────────────
async function resetElement(el) {
  const selector = generateCSSSelector(el);
  const domain = location.hostname;
  const path = location.pathname;

  // Remove all matching rules from the style tag
  const tag = getStyleTag();
  const regex = new RegExp(
    escapeRegExp(selector) + '\\s*\\{[^}]*\\}\\n?', 'g'
  );
  tag.textContent = tag.textContent.replace(regex, '');

  // Clear inline style leftovers
  el.style.removeProperty('width');
  el.style.removeProperty('max-width');
  el.style.removeProperty('height');
  el.style.removeProperty('max-height');
  el.style.removeProperty('margin-left');
  void el.offsetHeight; // force reflow

  // Remove from storage
  if (window.VellumStorage) {
    const data = await chrome.storage.local.get(domain);
    if (data[domain]) {
      data[domain].items = data[domain].items.filter(
        i => !(i.action === 'RESIZE' && i.selector === selector &&
               (i.path === path || i.path === '*'))
      );
      await chrome.storage.local.set({ [domain]: data[domain] });
    }
  }

  // Remove any undo entries for this selector
  window.VellumUndo._stack = window.VellumUndo._stack.filter(
    entry => entry._resizeSelector !== selector
  );

  deselectElement();
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Drag logic ──────────────────────────────────────────────────────────────
function startDrag(e, axis) {
  e.preventDefault();
  e.stopPropagation();
  if (!selectedEl) return;

  dragAxis = axis;
  dragStartX = e.clientX;
  dragStartY = e.clientY;

  const rect = selectedEl.getBoundingClientRect();
  startWidth = rect.width;
  startHeight = rect.height;
  startMarginLeft = parseFloat(getComputedStyle(selectedEl).marginLeft) || 0;

  // Add a full-viewport overlay to capture all mouse events during drag
  const dragOverlay = document.createElement('div');
  dragOverlay.id = 'vellum-resizer-drag-overlay';
  dragOverlay.setAttribute('data-vellum-ui', '1');
  Object.assign(dragOverlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    zIndex: '2147483647',
    cursor: (axis === 'x' || axis === 'x-left') ? 'ew-resize' : axis === 'y' ? 'ns-resize' : 'nwse-resize',
  });
  document.documentElement.appendChild(dragOverlay);

  function onMove(ev) {
    const dx = ev.clientX - dragStartX;
    const dy = ev.clientY - dragStartY;

    if (axis === 'x' || axis === 'xy') {
      const newW = Math.max(60, startWidth + dx);
      selectedEl.style.setProperty('width', newW + 'px', 'important');
      selectedEl.style.setProperty('max-width', 'none', 'important');
    }
    if (axis === 'x-left') {
      // Left handle: grow/shrink from the left edge, right edge stays fixed.
      // Offset margin-left relative to the original so the right edge stays pinned.
      const newW = Math.max(60, startWidth - dx);
      const widthDelta = newW - startWidth; // positive = grew, negative = shrank
      selectedEl.style.setProperty('width', newW + 'px', 'important');
      selectedEl.style.setProperty('max-width', 'none', 'important');
      selectedEl.style.setProperty('margin-left', (startMarginLeft - widthDelta) + 'px', 'important');
    }
    if (axis === 'y' || axis === 'xy') {
      const newH = Math.max(40, startHeight + dy);
      selectedEl.style.setProperty('height', newH + 'px', 'important');
      selectedEl.style.setProperty('max-height', 'none', 'important');
    }

    refreshHandles();
  }

  function onUp(ev) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    dragOverlay.remove();

    const dx = ev.clientX - dragStartX;
    const dy = ev.clientY - dragStartY;

    // Only persist if the user actually dragged (not just a click on a handle)
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
      dragAxis = null;
      return;
    }

    // Revert inline styles — the persisted <style> rule takes over
    selectedEl.style.removeProperty('width');
    selectedEl.style.removeProperty('max-width');
    selectedEl.style.removeProperty('height');
    selectedEl.style.removeProperty('max-height');
    selectedEl.style.removeProperty('margin-left');

    // Build CSS rule from final dimensions
    const cssParts = [];

    if (axis === 'x' || axis === 'xy') {
      const newW = Math.max(60, startWidth + dx);
      cssParts.push(`width: ${newW}px !important`);
      cssParts.push(`max-width: none !important`);
    }
    if (axis === 'x-left') {
      const newW = Math.max(60, startWidth - dx);
      const widthDelta = newW - startWidth;
      cssParts.push(`width: ${newW}px !important`);
      cssParts.push(`max-width: none !important`);
      cssParts.push(`margin-left: ${startMarginLeft - widthDelta}px !important`);
    }
    if (axis === 'y' || axis === 'xy') {
      const newH = Math.max(40, startHeight + dy);
      cssParts.push(`height: ${newH}px !important`);
      cssParts.push(`max-height: none !important`);
    }

    const cssText = cssParts.join('; ');
    persistResize(selectedEl, cssText, startWidth, startHeight);

    dragAxis = null;
    refreshHandles();
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ─── Persist resize to storage ───────────────────────────────────────────────
async function persistResize(el, cssText, originalWidth, originalHeight) {
  const selector = generateCSSSelector(el);
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  injectRule(selector, cssText);

  const domain = location.hostname;
  const path = location.pathname;

  const entry = {
    action: 'RESIZE',
    selector,
    cssText,
    _id: id,
    path,
    version: 1,
    timestamp: Date.now(),
  };

  if (window.VellumStorage) {
    const data = await chrome.storage.local.get(domain);
    const domainData = data[domain] || { items: [] };
    domainData.items.push(entry);
    await chrome.storage.local.set({ [domain]: domainData });
  }

  // ── Undo ─────────────────────────────────────────────────────────────────
  const undoEntry = {
    _resizeSelector: selector,
    undo: async () => {
      removeRule(selector, cssText);

      // Force the element back to its original size immediately so the
      // user sees the revert without needing to refresh the page.
      const target = document.querySelector(selector);
      if (target) {
        // Briefly apply original dimensions inline to flush the browser's
        // layout, then remove so the element returns to natural flow.
        target.style.setProperty('width', originalWidth + 'px', 'important');
        target.style.setProperty('height', originalHeight + 'px', 'important');
        // Force a reflow so the browser computes the new layout
        void target.offsetHeight;
        // Remove inline overrides — let the page's own CSS take over
        target.style.removeProperty('width');
        target.style.removeProperty('height');
        target.style.removeProperty('max-width');
        target.style.removeProperty('max-height');
        target.style.removeProperty('margin-left');
      }

      if (window.VellumStorage) {
        const data = await chrome.storage.local.get(domain);
        if (data[domain]) {
          data[domain].items = data[domain].items.filter(i => i._id !== id);
          await chrome.storage.local.set({ [domain]: data[domain] });
        }
      }
      window.VellumUndo.remove(undoEntry);
      refreshHandles();
    },
  };
  window.VellumUndo.push(undoEntry);

  // ── Toast ────────────────────────────────────────────────────────────────
  window.VellumUI.showToast('Element resized', {
    id: 'vellum-resizer-toast',
    onUndo: () => undoEntry.undo(),
  });
}

// ─── Message routing ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-resizer') {
    window.VellumState.set({
      mode: window.VellumState.mode === 'resizer' ? null : 'resizer',
    });
  }
});

// ─── React to mode changes ──────────────────────────────────────────────────
window.VellumState.subscribe((state) => {
  if (state.mode !== 'resizer') {
    hoverOverlay.style.display = 'none';
    hoveredEl = null;
    rawHoveredEl = null;
    traverseDepth = 0;
    deselectElement();
  }
});

// ─── Hover: highlight layout-significant elements ───────────────────────────
document.addEventListener('mousemove', (e) => {
  if (window.VellumState.mode !== 'resizer') return;
  if (dragAxis) return;       // Don't change hover while dragging
  if (selectedEl) return;     // Don't hover while handles are active

  const raw = document.elementFromPoint(e.clientX, e.clientY);
  if (!raw || isVellumElement(raw)) {
    hoveredEl = null;
    rawHoveredEl = null;
    hoverOverlay.style.display = 'none';
    return;
  }

  // Reset traverse depth when the cursor moves to a different raw element
  if (raw !== rawHoveredEl) {
    rawHoveredEl = raw;
    traverseDepth = 0;
  }

  updateHoverTarget();
}, { passive: true });

// ─── Shared: update the hover overlay from rawHoveredEl + traverseDepth ─────
function updateHoverTarget() {
  if (!rawHoveredEl) return;
  const target = findLayoutTarget(rawHoveredEl, traverseDepth);
  if (target) {
    hoveredEl = target;
    const rect = target.getBoundingClientRect();
    const scrollY = window.pageYOffset || document.documentElement.scrollTop;
    const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
    Object.assign(hoverOverlay.style, {
      display: 'block',
      top:    `${rect.top + scrollY}px`,
      left:   `${rect.left + scrollX}px`,
      width:  `${rect.width}px`,
      height: `${rect.height}px`,
    });
  } else {
    hoveredEl = null;
    hoverOverlay.style.display = 'none';
  }
}

// ─── Scroll wheel: walk up/down the DOM tree while hovering ─────────────────
document.addEventListener('wheel', (e) => {
  if (window.VellumState.mode !== 'resizer') return;
  if (selectedEl) return;     // Don't traverse while handles are active
  if (!rawHoveredEl) return;

  e.preventDefault();

  if (e.deltaY < 0) {
    // Scroll up → walk to parent
    traverseDepth++;
  } else {
    // Scroll down → walk back toward child
    traverseDepth = Math.max(0, traverseDepth - 1);
  }

  updateHoverTarget();
}, { passive: false });

// ─── Click: select element or deselect ──────────────────────────────────────
document.addEventListener('click', (e) => {
  if (window.VellumState.mode !== 'resizer') return;
  if (isVellumElement(e.target)) return;

  e.preventDefault();
  e.stopPropagation();

  // If we have a selection and clicked somewhere else, deselect first
  if (selectedEl) {
    deselectElement();
  }

  // Select new element if one is hovered
  if (hoveredEl) {
    selectElement(hoveredEl);
  }
}, true);

// ─── Reposition handles on scroll so they stay in the viewport ──────────────
window.addEventListener('scroll', () => {
  if (selectedEl && !dragAxis) refreshHandles();
}, { passive: true });

// ─── Escape to deselect ─────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (window.VellumState.mode !== 'resizer') return;
  if (e.key === 'Escape' && selectedEl) {
    deselectElement();
    e.preventDefault();
  }
});

})();
