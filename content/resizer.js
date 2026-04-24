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
// Matched to the eraser's outline+fill visual weight so both tools feel the same
// — just recolored to the resizer's blue accent.
const hoverOverlay = window.VellumUI.createHoverOverlay('vellum-resizer-overlay', '#3b82f6', 'rgba(59, 130, 246, 0.09)');

// ─── Dimension badge (top-right corner of hover outline) ─────────────────────
// Same idea as the eraser's dimension chip — shows current W×H in pixels so
// users can gauge element size before picking it up.
const dimensionBadge = document.createElement('div');
dimensionBadge.id = 'vellum-resizer-dimension-badge';
dimensionBadge.setAttribute('data-vellum-ui', '1');
Object.assign(dimensionBadge.style, {
  position: 'absolute',
  top: '-1px',
  right: '-1px',
  transform: 'translateY(-100%)',
  background: 'rgba(15, 15, 15, 0.85)',
  color: '#93c5fd',
  fontSize: '10px',
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  lineHeight: '1',
  padding: '2px 6px',
  borderRadius: '3px 3px 0 3px',
  whiteSpace: 'nowrap',
});
hoverOverlay.appendChild(dimensionBadge);

// ─── HUD strip (fixed bottom bar, draggable) ────────────────────────────────
// Mirrors the eraser HUD but tinted with the resizer's blue accent. Persistent
// chrome (drag handle + logo + info + trash + undo) so trash/undo stay reachable
// even when nothing is hovered or selected.
// Dock body — mounted into VellumDock when resizer mode is active. The dock
// owns drag handle + V logo + tool row; we own the info span + trash + undo.
const resizerBody = document.createElement('div');
resizerBody.style.display = 'inline-flex';
resizerBody.style.alignItems = 'center';

// Info section (dynamic — updated on hover / selection)
const resizerHudInfo = document.createElement('span');
resizerHudInfo.id = 'vellum-resizer-hud-info';
resizerHudInfo.style.display = 'inline-flex';
resizerHudInfo.style.alignItems = 'center';
resizerHudInfo.style.minWidth = '220px';
resizerBody.appendChild(resizerHudInfo);

// Divider
resizerBody.appendChild(Object.assign(document.createElement('div'), { className: 'vellum-toolbar-divider vellum-toolbar-divider-blue' }));

// Trash — clears all resize rules on this page
resizerBody.appendChild(window.VellumUI.createTrashButton({
  singular: 'resize',
  plural: 'resizes',
  actionTypes: ['RESIZE'],
}));

// Undo
resizerBody.appendChild(window.VellumUI.createUndoButton());

// ─── Rotating help tips (idle state) ───────────────────────────────────────
const hudTips = [
  '<span style="color:#94a3b8">Click to <span style="color:#e4e4e7;font-weight:600">select</span> an element for resizing</span>',
  '<span style="color:#94a3b8">Scroll \u2191\u2193 to <span style="color:#e4e4e7;font-weight:600">traverse DOM</span> (select parents/children)</span>',
  '<span style="color:#94a3b8">Drag any <span style="color:#93c5fd;font-weight:600">blue handle</span> to resize from that edge</span>',
  '<span style="color:#94a3b8">Click the <span style="color:#93c5fd;font-weight:600">blue \u21BA</span> to reset this element\u2019s resizes</span>',
  '<span style="color:#94a3b8">Press <span style="background:rgba(59,130,246,0.25);color:#93c5fd;padding:1px 4px;border-radius:3px;font-size:11px;font-weight:600;margin-right:2px">Esc</span> to exit resizer</span>',
];
let hudTipIndex = 0;
let hudTipInterval = null;

function stopHudTips() {
  if (hudTipInterval) { clearInterval(hudTipInterval); hudTipInterval = null; }
}

function ensureTipRotation() {
  if (hudTipInterval) return;
  hudTipInterval = setInterval(() => {
    hudTipIndex = (hudTipIndex + 1) % hudTips.length;
    const tipEl = document.getElementById('vellum-resizer-hud-tip');
    if (tipEl) {
      tipEl.style.opacity = '0';
      tipEl.style.transition = 'opacity 0.2s ease';
      setTimeout(() => {
        tipEl.innerHTML = hudTips[hudTipIndex];
        tipEl.style.opacity = '1';
      }, 200);
    }
  }, 4000);
}

let resizerDockMounted = false;
function setHudVisible(visible) {
  if (visible && !resizerDockMounted) {
    window.VellumDock.mount('resizer', () => resizerBody);
    resizerDockMounted = true;
  } else if (!visible && resizerDockMounted) {
    window.VellumDock.unmount('resizer');
    resizerDockMounted = false;
  }
}

// Render the info section based on current hover/selection.
function updateHUD() {
  const dot = '<span style="color:#525264;margin:0 8px">\u00b7</span>';
  let html = '';

  if (selectedEl) {
    // Selected state: show current dimensions of the locked target.
    const r = selectedEl.getBoundingClientRect();
    html += `<span style="color:#93c5fd;font-weight:600">${Math.round(r.width)}\u00d7${Math.round(r.height)}</span>`;
    html += `<span style="color:#6ee7b7;margin-left:4px">selected</span>`;
    html += dot;
    html += `<span style="color:#94a3b8">Drag a handle to resize \u00b7 <span style="color:#93c5fd">\u21BA</span> to reset</span>`;
    resizerHudInfo.innerHTML = html;
    stopHudTips();
    return;
  }

  if (hoveredEl) {
    const r = hoveredEl.getBoundingClientRect();
    html += `<span style="color:#93c5fd;font-weight:600">${Math.round(r.width)}\u00d7${Math.round(r.height)}</span>`;
    html += `<span style="color:#93c5fd;margin-left:4px">target</span>`;
    // Scroll hint — always available on hover since parents may be larger.
    html += dot;
    html += `<span style="color:#94a3b8">Scroll \u2191\u2193 to walk the DOM</span>`;
    resizerHudInfo.innerHTML = html;
    stopHudTips();
    return;
  }

  // Idle — rotating help tips.
  resizerHudInfo.innerHTML =
    `<span id="vellum-resizer-hud-tip" style="display:inline-block;min-width:180px">${hudTips[hudTipIndex]}</span>`;
  ensureTipRotation();
}

let hoveredEl = null;
let selectedEl = null;
let rawHoveredEl = null;   // the actual element under the cursor (before bubble-up)
let traverseDepth = 0;     // 0 = natural bubble-up target, >0 = walked up N parents

// ─── Handle elements ─────────────────────────────────────────────────────────
let handleLeft = null;
let handleRight = null;
let handleTop = null;
let handleBottom = null;
let handleCorner = null;
let selectionBox = null;
let dismissBtn = null;

// ─── Drag state ──────────────────────────────────────────────────────────────
let dragAxis = null;       // 'x' | 'x-left' | 'y' | 'y-top' | 'xy'
let dragStartX = 0;
let dragStartY = 0;
let startWidth = 0;
let startHeight = 0;
let startMarginLeft = 0;
let startMarginTop = 0;

// ─── Guard: Vellum-owned elements ────────────────────────────────────────────
const isVellumElement = window.VellumUI.isVellumElement;

// ─── Smart element targeting ─────────────────────────────────────────────────
// Three steps, in a specific order that matters:
//   1. Escape tiny elements FIRST — climb to the nearest layout-significant
//      block-level ancestor. Resizing a 220×36 menu link is rarely useful;
//      the user almost always wants to reshape a bigger container. This also
//      gives step 2 a meaningful seed rect.
//   2. THEN bubble past visually-identical wrappers. With a layout-sig seed
//      (e.g., 220×356 UL) the IoU comparison is against a real block, so a
//      same-sized outer NAV correctly promotes. Before the reorder, the
//      bubble was seeded with the 220×36 link and could never match the nav
//      (IoU = 220×36 / 220×356 ≈ 0.10 — a link occupies ~10% of the nav, not
//      "visually identical").
//   3. Scroll-wheel walk further up, counting only more block elements so
//      each scroll tick hops to the next meaningful parent, not a wrapper.
//
// Eraser keeps bubble-first on purpose: a user may legitimately want to erase
// a tiny link, so the bubble there runs on the raw hover. The resizer's
// tiny-element-is-not-a-resize-target rule doesn't apply to erase.
function isLayoutSignificant(el) {
  if (INLINE_TAGS.has(el.tagName)) return false;
  const rect = el.getBoundingClientRect();
  return rect.width >= MIN_WIDTH && rect.height >= MIN_HEIGHT;
}

function findLayoutTarget(raw, extraLevels = 0) {
  if (!raw || isVellumElement(raw)) return null;

  // Step 1: climb to the nearest layout-significant block-level ancestor.
  let current = raw;
  while (current && current !== document.body && current !== document.documentElement) {
    if (isVellumElement(current)) return null;
    if (isLayoutSignificant(current)) break;
    current = current.parentElement;
  }
  if (!current || current === document.body || current === document.documentElement) return null;

  // Step 2: bubble past visually-identical wrappers, seeded from the layout-
  // significant ancestor (not the raw hover). This is the key fix for the
  // "hovering a menu link returns the UL instead of the NAV" case.
  current = window.VellumUI.bubbleToVisualRoot(current);
  if (isVellumElement(current)) return null;

  // Step 3: scroll-wheel walk — each level up must also be layout-significant.
  let walked = 0;
  while (walked < extraLevels && current.parentElement &&
         current.parentElement !== document.body &&
         current.parentElement !== document.documentElement) {
    const parent = current.parentElement;
    if (isVellumElement(parent)) return null;
    current = parent;
    // Stop before reaching a page-dominating container.
    if (window.VellumUI.dominatesViewport(current.getBoundingClientRect())) return current;
    if (isLayoutSignificant(current)) walked++;
  }
  return current;
}

// ─── CSS selector generation (shared from FuzzyAnchor) ──────────────────────
function generateCSSSelector(el) {
  return window.FuzzyAnchor.generateCSSSelector(el);
}

// ─── Style injection engine ──────────────────────────────────────────────────
// Map of active resize rules, keyed by the storage `_id`. Mirrors the eraser's
// `VellumEraseRules` architecture: rules live in the map, the <style> tag is
// rebuilt from the map after every mutation. This replaced an earlier string-
// replace approach that could leave zombie rules behind whenever any path
// (notably the restorer) double-injected — String.prototype.replace with a
// string argument only strips the first occurrence, so Ctrl+Z and the trash
// button appeared to do nothing live even though storage was clean.
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

window.VellumResizeRules = new Map(); // id → { selector, cssText }

function rebuildResizeStyleTag() {
  const tag = getStyleTag();
  const rules = [];
  for (const [, rule] of window.VellumResizeRules) {
    rules.push(`${rule.selector} { ${rule.cssText} }`);
  }
  tag.textContent = rules.join('\n');
}
window.rebuildResizeStyleTag = rebuildResizeStyleTag;

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

  // Top-edge handle (height from the top — bottom stays pinned via margin-top)
  handleTop = createHandle('vellum-resizer-handle-top', 'ns-resize');
  positionHandleTop(handleTop, rect, scrollX, scrollY);
  handleTop.addEventListener('mousedown', (e) => startDrag(e, 'y-top'));
  document.documentElement.appendChild(handleTop);

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

  // Reset button (top-right corner) — blue so it doesn't collide with the red
  // ✕ delete affordance used when you select something you've drawn. Icon is a
  // circular reset arrow to read as "revert" rather than "delete".
  dismissBtn = document.createElement('button');
  dismissBtn.className = 'vellum-resizer-dismiss';
  dismissBtn.setAttribute('data-vellum-ui', '1');
  dismissBtn.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M3 3v4h4"/>' +
    '<path d="M3 7a5.5 5.5 0 1 1 1.6 3.9"/>' +
    '</svg>';
  dismissBtn.setAttribute('data-tooltip', 'Reset all resizes on this element');
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

  updateHUD();
}

function deselectElement() {
  const hadSelection = !!selectedEl;
  selectedEl = null;
  if (selectionBox) { selectionBox.remove(); selectionBox = null; }
  if (handleLeft)   { handleLeft.remove();   handleLeft = null; }
  if (handleRight)  { handleRight.remove();  handleRight = null; }
  if (handleTop)    { handleTop.remove();    handleTop = null; }
  if (handleBottom) { handleBottom.remove(); handleBottom = null; }
  if (handleCorner) { handleCorner.remove(); handleCorner = null; }
  if (dismissBtn)   { dismissBtn.remove();   dismissBtn = null; }
  if (hadSelection && window.VellumState.mode === 'resizer') updateHUD();
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

function positionHandleTop(h, rect, sx, sy) {
  const idealTop  = rect.top + sy - 4;
  const idealLeft = rect.left + sx + rect.width / 2 - 14;
  const clamped = clampToViewport(idealTop, idealLeft, 28, 8, sx, sy);
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
  if (handleTop)    positionHandleTop(handleTop, rect, scrollX, scrollY);
  if (handleBottom) positionHandleBottom(handleBottom, rect, scrollX, scrollY);
  if (handleCorner) positionHandleCorner(handleCorner, rect, scrollX, scrollY);
  if (dismissBtn)   positionDismiss(dismissBtn, rect, scrollX, scrollY);
  // HUD dimensions track the element live during drag.
  updateHUD();
}

// ─── Reset: remove ALL resize rules for a given element ─────────────────────
async function resetElement(el) {
  const selector = generateCSSSelector(el);
  const domain = location.hostname;
  const path = location.pathname;

  // Drop every rule for this selector from the live map, then rebuild.
  for (const [id, rule] of window.VellumResizeRules) {
    if (rule.selector === selector) window.VellumResizeRules.delete(id);
  }
  rebuildResizeStyleTag();

  // Clear inline style leftovers
  el.style.removeProperty('width');
  el.style.removeProperty('max-width');
  el.style.removeProperty('height');
  el.style.removeProperty('max-height');
  el.style.removeProperty('margin-left');
  el.style.removeProperty('margin-top');
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

// ─── Drag logic ──────────────────────────────────────────────────────────────
function startDrag(e, axis) {
  e.preventDefault();
  e.stopPropagation();
  if (!selectedEl) return;

  dragAxis = axis;
  dragStartX = e.clientX;
  dragStartY = e.clientY;

  const rect = selectedEl.getBoundingClientRect();
  const cs = getComputedStyle(selectedEl);
  startWidth = rect.width;
  startHeight = rect.height;
  startMarginLeft = parseFloat(cs.marginLeft) || 0;
  startMarginTop = parseFloat(cs.marginTop) || 0;

  // Add a full-viewport overlay to capture all mouse events during drag
  const dragOverlay = document.createElement('div');
  dragOverlay.id = 'vellum-resizer-drag-overlay';
  dragOverlay.setAttribute('data-vellum-ui', '1');
  Object.assign(dragOverlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    zIndex: '2147483647',
    cursor: (axis === 'x' || axis === 'x-left') ? 'ew-resize'
          : (axis === 'y' || axis === 'y-top') ? 'ns-resize'
          : 'nwse-resize',
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
    if (axis === 'y-top') {
      // Top handle: grow/shrink from the top edge, bottom edge stays pinned via
      // margin-top compensation — mirrors the left-handle math.
      const newH = Math.max(40, startHeight - dy);
      const heightDelta = newH - startHeight;
      selectedEl.style.setProperty('height', newH + 'px', 'important');
      selectedEl.style.setProperty('max-height', 'none', 'important');
      selectedEl.style.setProperty('margin-top', (startMarginTop - heightDelta) + 'px', 'important');
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
    selectedEl.style.removeProperty('margin-top');

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
    if (axis === 'y-top') {
      const newH = Math.max(40, startHeight - dy);
      const heightDelta = newH - startHeight;
      cssParts.push(`height: ${newH}px !important`);
      cssParts.push(`max-height: none !important`);
      cssParts.push(`margin-top: ${startMarginTop - heightDelta}px !important`);
    }

    const cssText = cssParts.join('; ');
    persistResize(selectedEl, cssText);

    dragAxis = null;
    refreshHandles();
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ─── Persist resize to storage ───────────────────────────────────────────────
async function persistResize(el, cssText) {
  const selector = generateCSSSelector(el);
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  window.VellumResizeRules.set(id, { selector, cssText });
  rebuildResizeStyleTag();

  const domain = location.hostname;
  // Resizes default to domain-wide (`path: '*'`). Unlike the eraser — where
  // domain-wide is an explicit user override (Shift+Click) or silent ad-scope
  // promotion — resize targets are almost always structural containers (nav,
  // sidebar, header, article wrapper) that recur across a site with the same
  // selector. Scoping to just the current page would force the user to redo
  // the same resize on every sibling page. If the selector falls back to a
  // structural `nth-child` path and matches something unintended on another
  // page, the rule silently no-ops (worst case: reset from that page).
  const path = '*';

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
      window.VellumResizeRules.delete(id);
      rebuildResizeStyleTag();

      // Force a reflow so the browser re-computes layout against the
      // updated stylesheet immediately — no refresh needed.
      const target = document.querySelector(selector);
      if (target) void target.offsetHeight;

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
  if (state.mode === 'resizer') {
    setHudVisible(true);
    updateHUD();
  } else {
    hoverOverlay.style.display = 'none';
    hoveredEl = null;
    rawHoveredEl = null;
    traverseDepth = 0;
    deselectElement();
    setHudVisible(false);
    stopHudTips();
    hudTipIndex = 0;
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
    traverseDepth = 0;
    hoverOverlay.style.display = 'none';
    dimensionBadge.textContent = '';
    updateHUD();
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
    dimensionBadge.textContent = `${Math.round(rect.width)}\u00d7${Math.round(rect.height)}`;
  } else {
    hoveredEl = null;
    hoverOverlay.style.display = 'none';
    dimensionBadge.textContent = '';
  }
  updateHUD();
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
// The resizer has two modes:
//   1. Target-select — solid blue hover overlay. Click commits, scroll
//      traverses, Escape exits the tool.
//   2. Edit — dashed outline with handles. Drag handles to resize (repeatable);
//      click the blue ↺ to reset; click anywhere off-selection to leave edit
//      mode and drop back to (1). Escape still exits the tool entirely.
//
// Click-away never chain-selects a new target — it just exits edit mode. The
// next explicit click is what picks the new target, matching the two-phase
// mental model the tool already signals with its two visual states.
document.addEventListener('click', (e) => {
  if (window.VellumState.mode !== 'resizer') return;
  if (isVellumElement(e.target)) return;

  e.preventDefault();
  e.stopPropagation();

  if (selectedEl) {
    // Any click off the selection exits edit mode back to target-select.
    // Handles and the reset button are data-vellum-ui, so they're excluded
    // by the guard above and don't trigger this.
    deselectElement();
    // Refresh hover from the click point so the solid blue overlay reappears
    // immediately under the cursor instead of waiting for a mouse wiggle.
    rawHoveredEl = e.target;
    traverseDepth = 0;
    updateHoverTarget();
    return;
  }

  // Target-select mode — use hoveredEl so scroll-wheel traversal is honored.
  if (hoveredEl) {
    selectElement(hoveredEl);
  }
}, true);

// ─── Reposition handles on scroll so they stay in the viewport ──────────────
window.addEventListener('scroll', () => {
  if (selectedEl && !dragAxis) refreshHandles();
}, { passive: true });

})();
