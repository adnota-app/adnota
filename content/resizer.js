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
const hoverOverlay = window.AdnotaUI.createHoverOverlay('adnota-resizer-overlay', '#3b82f6', 'rgba(59, 130, 246, 0.09)');

// ─── Hover chip cluster (top-right corner of hover outline) ─────────────────
// Three chips share a flex cluster pinned at the overlay's top-right. The
// dimension badge is read-only; the action chips surface structural overrides
// (unstick / restick for sticky+fixed elements, finite scroll / infinite scroll
// for tall growing containers) and are the only clickable hit zones inside the
// otherwise pointer-events:none overlay.
const chipCluster = document.createElement('div');
chipCluster.className = 'adnota-resizer-hover-chips';
chipCluster.setAttribute('data-adnota-ui', '1');
hoverOverlay.appendChild(chipCluster);

// Action chip (leftmost — actions on the left, readouts on the right is a
// common HUD convention). Hidden unless the hovered element is sticky/fixed
// or already has our unstick override applied. Click toggles the override.
const actionChip = document.createElement('div');
actionChip.className = 'adnota-resizer-action-chip';
actionChip.setAttribute('data-adnota-ui', '1');
actionChip.style.display = 'none';
chipCluster.appendChild(actionChip);

// Infinite-scroll chip — caps the element's height and clips overflow so the
// page stops growing as the user scrolls. Hidden unless the hovered element
// is taller than the viewport (the only case where capping shortens anything)
// or already has our finite-scroll override applied. Click toggles.
const infiniteChip = document.createElement('div');
infiniteChip.className = 'adnota-resizer-action-chip';
infiniteChip.setAttribute('data-adnota-ui', '1');
infiniteChip.style.display = 'none';
chipCluster.appendChild(infiniteChip);

// Dimension badge — shows current W×H in pixels. Reuses the selection chip's
// styling so hover and selected states share the same visual readout.
const dimensionBadge = document.createElement('div');
dimensionBadge.id = 'adnota-resizer-dimension-badge';
dimensionBadge.className = 'adnota-resizer-selection-dim';
dimensionBadge.setAttribute('data-adnota-ui', '1');
chipCluster.appendChild(dimensionBadge);

// ─── HUD strip (fixed bottom bar, draggable) ────────────────────────────────
// Mirrors the eraser HUD but tinted with the resizer's blue accent. Persistent
// chrome (drag handle + logo + info + trash + undo) so trash/undo stay reachable
// even when nothing is hovered or selected.
// Dock body — mounted into AdnotaDock when resizer mode is active. The dock
// owns drag handle + V logo + tool row; we own the info span + trash + undo.
const resizerBody = document.createElement('div');
resizerBody.style.display = 'inline-flex';
resizerBody.style.alignItems = 'center';

// Info section (dynamic — updated on hover / selection)
const resizerHudInfo = document.createElement('span');
resizerHudInfo.id = 'adnota-resizer-hud-info';
resizerHudInfo.style.display = 'inline-flex';
resizerHudInfo.style.alignItems = 'center';
resizerHudInfo.style.minWidth = '220px';
resizerBody.appendChild(resizerHudInfo);

// Help (?) button — opens a tail-anchored popover with the full tip list.
// Replaces the old rotating tip; always reachable, no waiting for the right
// tip to cycle around.
const resizerHelpBtn = window.AdnotaUI.createHelpButton({
  accent: 'blue',
  tips: [
    '<span style="color:#94a3b8">Click to <span style="color:#e4e4e7;font-weight:600">select</span> an element for resizing</span>',
    '<span style="color:#94a3b8"><span style="background:rgba(59,130,246,0.25);color:#93c5fd;padding:1px 4px;border-radius:3px;font-size:11px;font-weight:600;margin-right:4px">⇧+Scroll ↑↓</span>to <span style="color:#e4e4e7;font-weight:600">traverse DOM</span> (select parents/children)</span>',
    '<span style="color:#94a3b8">Drag any <span style="color:#93c5fd;font-weight:600">blue handle</span> to resize from that edge</span>',
    '<span style="color:#94a3b8">Hover a sticky bar → click <span style="color:#fbbf24;font-weight:600">unstick</span> to stop it following you</span>',
    '<span style="color:#94a3b8">Hover an infinite feed → click <span style="color:#fbbf24;font-weight:600">finite scroll</span> to give it an end</span>',
    '<span style="color:#94a3b8">Click the <span style="color:#93c5fd;font-weight:600">↺</span> to completely reset this element</span>',
    '<span style="color:#94a3b8">Press <span style="background:rgba(59,130,246,0.25);color:#93c5fd;padding:1px 4px;border-radius:3px;font-size:11px;font-weight:600;margin-right:2px">Esc</span> to exit any tool</span>',
  ],
});
resizerBody.appendChild(resizerHelpBtn);

// Divider
resizerBody.appendChild(Object.assign(document.createElement('div'), { className: 'adnota-toolbar-divider adnota-toolbar-divider-blue' }));

// Trash — opens scratch pad on Edits / Resized for per-row review/delete.
// Badge auto-managed by createTrashButton when mode/filter are passed.
resizerBody.appendChild(window.AdnotaUI.createTrashButton({
  singular: 'resize',
  plural: 'resizes',
  actionTypes: ['RESIZE'],
  mode: 'edits',
  filter: 'resized',
}));

// Undo
resizerBody.appendChild(window.AdnotaUI.createUndoButton());

// Idle-state placeholder for the info section. The full tip list lives behind
// the ? button — this just keeps the strip from looking empty.
const IDLE_HUD_LABEL = '<span style="color:#94a3b8">Hover an element to resize</span>';

let resizerDockMounted = false;
function setHudVisible(visible) {
  if (visible && !resizerDockMounted) {
    window.AdnotaDock.mount('resizer', () => resizerBody);
    resizerDockMounted = true;
  } else if (!visible && resizerDockMounted) {
    window.AdnotaDock.unmount('resizer');
    resizerDockMounted = false;
  }
}

// Render the info section based on current hover/selection.
function updateHUD() {
  const dot = '<span style="color:#525264;margin:0 8px">·</span>';
  let html = '';

  if (selectedEl) {
    // Selected state: dimensions live on the selection box itself (the
    // top-right chip next to the reset button), so the HUD just carries
    // the action hint here.
    html += `<span style="color:#6ee7b7">Selected</span>`;
    html += dot;
    html += `<span style="color:#94a3b8">Drag a handle to resize · <span style="color:#93c5fd">↺</span> to reset</span>`;
    resizerHudInfo.innerHTML = html;
    return;
  }

  if (hoveredEl) {
    // Dimension is shown on the hover overlay’s top-right badge, so the
    // HUD info area only needs the scroll hint.
    html += `<span style="color:#94a3b8"><span style="background:rgba(59,130,246,0.25);color:#93c5fd;padding:1px 4px;border-radius:3px;font-size:11px;font-weight:600;margin-right:4px">⇧+Scroll ↑↓</span>to walk the DOM</span>`;
    resizerHudInfo.innerHTML = html;
    return;
  }

  // Idle: short static label. Full tip list is behind the ? button.
  resizerHudInfo.innerHTML = IDLE_HUD_LABEL;
}

let hoveredEl = null;
let selectedEl = null;
let rawHoveredEl = null;   // the actual element under the cursor (before bubble-up)
let traverseDepth = 0;     // 0 = natural bubble-up target, >0 = walked up N parents
let hoveredHasUnstickOverride = false;        // unstick chip state — drives apply vs remove on click
let hoveredHasFiniteScrollOverride = false;   // finite-scroll chip state — same role for the second chip

// ─── Handle elements ─────────────────────────────────────────────────────────
let handleLeft = null;
let handleRight = null;
let handleTop = null;
let handleBottom = null;
let handleCorner = null;
let selectionBox = null;
let dismissBtn = null;
let selectionDimBadge = null;
let selectionActionChip = null;
let selectionInfiniteChip = null;
let selectionChipCluster = null;

// ─── Drag state ──────────────────────────────────────────────────────────────
let dragAxis = null;       // 'x' | 'x-left' | 'y' | 'y-top' | 'xy'
let dragStartX = 0;
let dragStartY = 0;
let startWidth = 0;
let startHeight = 0;
let startMarginLeft = 0;
let startMarginTop = 0;

// ─── Guard: Adnota-owned elements ────────────────────────────────────────────
const isAdnotaElement = window.AdnotaUI.isAdnotaElement;

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
  // Sticky/fixed elements are inherently structural chrome — the page
  // explicitly placed them in viewport-affecting positions, so they're
  // always a valid resize/unstick target even when shorter than MIN_HEIGHT
  // (real-world sticky bars: GitHub nav ~52px, HN header ~30px, news-site
  // banners ~48px — all of which previously fell below the 60px floor and
  // were silently climbed past).
  const cs = getComputedStyle(el);
  if (cs.position === 'sticky' || cs.position === 'fixed') {
    return rect.width > 0 && rect.height > 0;
  }
  return rect.width >= MIN_WIDTH && rect.height >= MIN_HEIGHT;
}

function findLayoutTarget(raw, extraLevels = 0) {
  if (!raw || isAdnotaElement(raw)) return null;

  // Step 1: climb to the nearest layout-significant block-level ancestor.
  let layoutSig = raw;
  while (layoutSig && layoutSig !== document.body && layoutSig !== document.documentElement) {
    if (isAdnotaElement(layoutSig)) return null;
    if (isLayoutSignificant(layoutSig)) break;
    layoutSig = layoutSig.parentElement;
  }
  if (!layoutSig || layoutSig === document.body || layoutSig === document.documentElement) return null;

  // Step 2: bubble past visually-identical wrappers, seeded from the layout-
  // significant ancestor (not the raw hover). This is the key fix for the
  // "hovering a menu link returns the UL instead of the NAV" case.
  const baseline = window.AdnotaUI.bubbleToVisualRoot(layoutSig);
  if (isAdnotaElement(baseline)) return null;

  // Step 3a (positive extraLevels): scroll-wheel walk up — each level up must
  // also be layout-significant.
  if (extraLevels > 0) {
    let current = baseline;
    let walked = 0;
    while (walked < extraLevels && current.parentElement &&
           current.parentElement !== document.body &&
           current.parentElement !== document.documentElement) {
      const parent = current.parentElement;
      if (isAdnotaElement(parent)) return null;
      current = parent;
      // Stop before reaching a page-dominating container.
      if (window.AdnotaUI.dominatesViewport(current.getBoundingClientRect())) return current;
      if (isLayoutSignificant(current)) walked++;
    }
    return current;
  }

  // Step 3b (negative extraLevels): walk back DOWN from the bubbled baseline
  // toward raw, then optionally one step further into a single iframe
  // descendant. The iframe shield masks iframes from elementFromPoint, so this
  // is the only way to reach an iframe child as the hover target.
  if (extraLevels < 0) {
    const chain = [baseline];
    if (baseline !== layoutSig) chain.push(layoutSig);  // un-bubble step
    if (raw !== layoutSig) {
      // Path from raw up to (but not including) layoutSig, reversed so we
      // descend in DOM order.
      const descent = [];
      let cur = raw;
      while (cur && cur !== layoutSig) {
        if (isAdnotaElement(cur)) { descent.length = 0; break; }
        descent.unshift(cur);
        cur = cur.parentElement;
      }
      for (const el of descent) chain.push(el);
    }
    // Iframe child special case: when the deepest reachable target contains
    // exactly one iframe in its subtree, one more scroll-down targets it.
    const last = chain[chain.length - 1];
    const iframes = last.querySelectorAll('iframe');
    if (iframes.length === 1 && !isAdnotaElement(iframes[0])) {
      chain.push(iframes[0]);
    }
    const idx = Math.min(-extraLevels, chain.length - 1);
    return chain[idx];
  }

  return baseline;
}

// ─── CSS selector generation (shared from FuzzyAnchor) ──────────────────────
function generateCSSSelector(el) {
  return window.FuzzyAnchor.generateCSSSelector(el);
}

// ─── Style injection engine ──────────────────────────────────────────────────
// Map of active resize rules, keyed by the storage `_id`. Mirrors the eraser's
// `AdnotaEraseRules` architecture: rules live in the map, the <style> tag is
// rebuilt from the map after every mutation. This replaced an earlier string-
// replace approach that could leave zombie rules behind whenever any path
// (notably the restorer) double-injected — String.prototype.replace with a
// string argument only strips the first occurrence, so Ctrl+Z and the trash
// button appeared to do nothing live even though storage was clean.
function getStyleTag() {
  let tag = document.getElementById('adnota-style-overrides');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'adnota-style-overrides';
    tag.setAttribute('data-adnota-ui', '1');
    document.head.appendChild(tag);
  }
  return tag;
}

window.AdnotaResizeRules = new Map(); // id → { selector, cssText }

function rebuildResizeStyleTag() {
  const tag = getStyleTag();
  const rules = [];
  for (const [, rule] of window.AdnotaResizeRules) {
    rules.push(`${rule.selector} { ${rule.cssText} }`);
  }
  tag.textContent = rules.join('\n');
}
window.rebuildResizeStyleTag = rebuildResizeStyleTag;

// ─── Unstick override (single source of truth for the cssText) ──────────────
// Single label `unstick` for both `position: sticky` and `position: fixed`.
// User intent ("stop following me") and override are the same; the CSS
// distinction is invisible to the user.
//
// Why `relative` instead of `static`: an absolutely-positioned descendant
// resolves its top/left/right/bottom against its nearest *positioned*
// ancestor. When we override a fixed/sticky parent to `static`, descendants
// (dropdowns, tooltips, popovers) escape upward to <body> and land in
// nonsensical places (Squarespace's PRODUCTS dropdown ends up in the hero
// text mid-page). `position: relative` with no offsets keeps the parent as
// a positioning ancestor — descendants stay where the page intended — while
// still removing the sticky/fixed viewport-pinning behavior. We also zero
// out top/left/right/bottom because `relative` honors those values; without
// that, a sticky bar with `top: 0` would shift down by the same offset.
const UNSTICK_CSS_TEXT =
  'position: relative !important; top: auto !important; left: auto !important; right: auto !important; bottom: auto !important';

// Is there an unstick override currently in the live Map for this selector?
// Used to flip the chip label between `unstick` and `restick`.
function hasUnstickOverride(selector) {
  for (const [, rule] of window.AdnotaResizeRules) {
    if (rule.selector === selector && rule.cssText === UNSTICK_CSS_TEXT) return true;
  }
  return false;
}

// Is there a finite-scroll override currently in the live Map for this
// selector? Detected by `overflow: hidden` in the cssText — the unique
// signature of finite-scroll rules in this codebase (drag-resize and unstick
// don't touch overflow). Used to flip the chip label between `finite scroll`
// and `infinite scroll`.
function hasFiniteScrollOverride(selector) {
  for (const [, rule] of window.AdnotaResizeRules) {
    if (rule.selector === selector && rule.cssText.includes('overflow: hidden')) return true;
  }
  return false;
}

// ─── Selection: show drag handles around an element ──────────────────────────
function selectElement(el) {
  window.AdnotaLog?.event('resizer', 'select', { el: window.AdnotaLog.el(el) });
  deselectElement();
  selectedEl = el;
  hoverOverlay.style.display = 'none';

  const rect = el.getBoundingClientRect();
  const scrollY = window.pageYOffset || document.documentElement.scrollTop;
  const scrollX = window.pageXOffset || document.documentElement.scrollLeft;

  // Selection outline
  selectionBox = document.createElement('div');
  selectionBox.className = 'adnota-resizer-selection';
  selectionBox.setAttribute('data-adnota-ui', '1');
  positionBox(selectionBox, rect, scrollX, scrollY);
  document.documentElement.appendChild(selectionBox);

  // Bicolor SVG resize cursors so they stay visible against any background and
  // any Win11 system-pointer color (see CURSORS in highlighter.js).
  const cursors = window.AdnotaCursor?.cursors;
  const ewResize   = cursors?.ewResize   ?? 'ew-resize';
  const nsResize   = cursors?.nsResize   ?? 'ns-resize';
  const nwseResize = cursors?.nwseResize ?? 'nwse-resize';

  // Left-edge handle (width — shrink by dragging right, or grow by dragging left)
  handleLeft = createHandle('adnota-resizer-handle-left', ewResize);
  positionHandleLeft(handleLeft, rect, scrollX, scrollY);
  handleLeft.addEventListener('mousedown', (e) => startDrag(e, 'x-left'));
  document.documentElement.appendChild(handleLeft);

  // Right-edge handle (width)
  handleRight = createHandle('adnota-resizer-handle-right', ewResize);
  positionHandleRight(handleRight, rect, scrollX, scrollY);
  handleRight.addEventListener('mousedown', (e) => startDrag(e, 'x'));
  document.documentElement.appendChild(handleRight);

  // Top-edge handle (height from the top — bottom stays pinned via margin-top)
  handleTop = createHandle('adnota-resizer-handle-top', nsResize);
  positionHandleTop(handleTop, rect, scrollX, scrollY);
  handleTop.addEventListener('mousedown', (e) => startDrag(e, 'y-top'));
  document.documentElement.appendChild(handleTop);

  // Bottom-edge handle (height)
  handleBottom = createHandle('adnota-resizer-handle-bottom', nsResize);
  positionHandleBottom(handleBottom, rect, scrollX, scrollY);
  handleBottom.addEventListener('mousedown', (e) => startDrag(e, 'y'));
  document.documentElement.appendChild(handleBottom);

  // Corner handle (both)
  handleCorner = createHandle('adnota-resizer-handle-corner', nwseResize);
  positionHandleCorner(handleCorner, rect, scrollX, scrollY);
  handleCorner.addEventListener('mousedown', (e) => startDrag(e, 'xy'));
  document.documentElement.appendChild(handleCorner);

  // Reset button (top-right corner) — blue so it doesn't collide with the red
  // ✕ delete affordance used when you select something you've drawn. Icon is a
  // circular reset arrow to read as "revert" rather than "delete".
  dismissBtn = document.createElement('button');
  dismissBtn.className = 'adnota-resizer-dismiss';
  dismissBtn.setAttribute('data-adnota-ui', '1');
  dismissBtn.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M3 3v4h4"/>' +
    '<path d="M3 7a5.5 5.5 0 1 1 1.6 3.9"/>' +
    '</svg>';
  dismissBtn.setAttribute('data-adnota-tooltip', 'Reset to original');
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

  // Selection chip cluster — flex row holding the action chips (left) and the
  // dimension badge (right). Sits just to the left of the dismiss button
  // (16px right offset = dismiss button's 10px outdent + 6px gap), entirely
  // above the top edge to mirror the hover chip's placement. Mirrors the
  // hover state's cluster so users get the same chip surface in both modes.
  // The selection-state chips exist specifically so the user can pin a
  // hard-to-hover sticky bar with a click, then move the cursor freely to
  // reach the chip without losing the hover state.
  selectionDimBadge = document.createElement('div');
  selectionDimBadge.className = 'adnota-resizer-selection-dim';
  selectionDimBadge.setAttribute('data-adnota-ui', '1');
  // Strip absolute positioning from the dim badge — it'll participate in the
  // cluster's flex layout instead.
  selectionDimBadge.style.position = 'static';
  selectionDimBadge.textContent = `${Math.round(rect.width)}×${Math.round(rect.height)}`;

  selectionActionChip = document.createElement('div');
  selectionActionChip.className = 'adnota-resizer-action-chip';
  selectionActionChip.setAttribute('data-adnota-ui', '1');
  selectionActionChip.style.display = 'none';
  // Toggle on click: same code path as the hover chip.
  selectionActionChip.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedEl) return;
    if (selectionActionChip._isOverridden) {
      await removeUnstickRule(selectedEl);
    } else {
      await applyUnstickRule(selectedEl);
    }
    updateSelectionChip();
  });

  selectionInfiniteChip = document.createElement('div');
  selectionInfiniteChip.className = 'adnota-resizer-action-chip';
  selectionInfiniteChip.setAttribute('data-adnota-ui', '1');
  selectionInfiniteChip.style.display = 'none';
  selectionInfiniteChip.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedEl) return;
    if (selectionInfiniteChip._isOverridden) {
      await removeFiniteScrollRule(selectedEl);
    } else {
      await applyFiniteScrollRule(selectedEl);
    }
    updateSelectionChip();
  });

  selectionChipCluster = document.createElement('div');
  selectionChipCluster.setAttribute('data-adnota-ui', '1');
  Object.assign(selectionChipCluster.style, {
    position: 'absolute',
    top: '4px',
    right: '32px',
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
    zIndex: '2147483647',
  });
  selectionChipCluster.appendChild(selectionActionChip);
  selectionChipCluster.appendChild(selectionInfiniteChip);
  selectionChipCluster.appendChild(selectionDimBadge);
  selectionBox.appendChild(selectionChipCluster);

  updateSelectionChip();
  updateHUD();
}

// Re-evaluate the selection chips' labels/visibility against the current
// selectedEl. Called from selectElement (initial), the chips' own click
// handlers, and any path that mutates AdnotaResizeRules for this selector
// (drag persist via refreshHandles, undo).
function updateSelectionChip() {
  if (!selectionActionChip || !selectedEl) return;
  const cs = getComputedStyle(selectedEl);
  const selector = generateCSSSelector(selectedEl);

  // Unstick chip
  const unstickOverridden = hasUnstickOverride(selector);
  if (cs.position === 'sticky' || cs.position === 'fixed') {
    selectionActionChip.textContent = 'unstick';
    selectionActionChip.setAttribute('data-adnota-tooltip', 'Stop this from following you when scrolling');
    selectionActionChip.style.display = '';
    selectionActionChip._isOverridden = false;
  } else if (unstickOverridden) {
    selectionActionChip.textContent = 'restick';
    selectionActionChip.setAttribute('data-adnota-tooltip', 'Restore the original sticky behavior');
    selectionActionChip.style.display = '';
    selectionActionChip._isOverridden = true;
  } else {
    selectionActionChip.style.display = 'none';
    selectionActionChip._isOverridden = false;
  }

  // Finite-scroll chip — surface only on tall elements (where capping would
  // actually shorten the page) or when the override is already applied (so
  // the user can flip it back).
  if (selectionInfiniteChip) {
    const rect = selectedEl.getBoundingClientRect();
    const tallEnough = rect.height > window.innerHeight;
    const finiteOverridden = hasFiniteScrollOverride(selector);
    if (finiteOverridden) {
      selectionInfiniteChip.textContent = 'infinite scroll';
      selectionInfiniteChip.setAttribute('data-adnota-tooltip', 'Restore the page\'s natural infinite scrolling');
      selectionInfiniteChip.style.display = '';
      selectionInfiniteChip._isOverridden = true;
    } else if (tallEnough) {
      selectionInfiniteChip.textContent = 'finite scroll';
      selectionInfiniteChip.setAttribute('data-adnota-tooltip', 'Stop this from growing as you scroll');
      selectionInfiniteChip.style.display = '';
      selectionInfiniteChip._isOverridden = false;
    } else {
      selectionInfiniteChip.style.display = 'none';
      selectionInfiniteChip._isOverridden = false;
    }
  }
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
  // Cluster removal also drops its children (badge + action + infinite chips).
  if (selectionChipCluster) { selectionChipCluster.remove(); selectionChipCluster = null; }
  selectionDimBadge = null;
  selectionActionChip = null;
  selectionInfiniteChip = null;
  if (hadSelection && window.AdnotaState.mode === 'resizer') updateHUD();
}

function createHandle(className, cursor) {
  const h = document.createElement('div');
  h.className = className;
  h.setAttribute('data-adnota-ui', '1');
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
  if (selectionDimBadge) {
    selectionDimBadge.textContent = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
  }
  // Re-evaluate chip state in case an undo/restick happened while selection
  // is still active (e.g., user hits Ctrl+Z mid-selection).
  updateSelectionChip();
  updateHUD();
}

// ─── Reset: remove ALL resize rules for a given element ─────────────────────
async function resetElement(el) {
  const selector = generateCSSSelector(el);
  window.AdnotaLog?.event('resizer', 'reset', { sel: selector, el: window.AdnotaLog.el(el) });
  const domain = location.hostname;
  const path = location.pathname;

  // Drop every rule for this selector from the live map, then rebuild.
  for (const [id, rule] of window.AdnotaResizeRules) {
    if (rule.selector === selector) window.AdnotaResizeRules.delete(id);
  }
  rebuildResizeStyleTag();

  // Clear inline style leftovers
  el.style.removeProperty('width');
  el.style.removeProperty('min-width');
  el.style.removeProperty('max-width');
  el.style.removeProperty('height');
  el.style.removeProperty('min-height');
  el.style.removeProperty('max-height');
  el.style.removeProperty('margin-left');
  el.style.removeProperty('margin-top');
  el.style.removeProperty('overflow');
  void el.offsetHeight; // force reflow

  // Remove from storage
  if (window.AdnotaStorage) {
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
  window.AdnotaUndo._stack = window.AdnotaUndo._stack.filter(
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

  // Snapshot the page's pre-drag inline values for the props we'll touch.
  // A blanket removeProperty on release would strip longhands the page's own
  // shorthand expanded into — e.g. inline `margin: 24px auto 0` becomes
  // margin-left:auto / margin-top:24px, and dropping those snaps the element.
  const savedInline = {
    width: selectedEl.style.width,
    minWidth: selectedEl.style.minWidth,
    maxWidth: selectedEl.style.maxWidth,
    height: selectedEl.style.height,
    minHeight: selectedEl.style.minHeight,
    maxHeight: selectedEl.style.maxHeight,
    marginLeft: selectedEl.style.marginLeft,
    marginTop: selectedEl.style.marginTop,
  };
  const restoreInline = () => {
    const apply = (prop, value) => {
      if (value) selectedEl.style.setProperty(prop, value);
      else selectedEl.style.removeProperty(prop);
    };
    apply('width', savedInline.width);
    apply('min-width', savedInline.minWidth);
    apply('max-width', savedInline.maxWidth);
    apply('height', savedInline.height);
    apply('min-height', savedInline.minHeight);
    apply('max-height', savedInline.maxHeight);
    apply('margin-left', savedInline.marginLeft);
    apply('margin-top', savedInline.marginTop);
  };

  // Shrink with max-height, grow with min-height. Pages like bing.com use
  // `top: calc(100% - <rem>)` on descendants of an auto-height container; the
  // descendants' percentage resolves to ~0 while the container is auto, but
  // jumps to the container's full height the moment we pin it with `height:
  // <px>` — flinging children thousands of pixels off-screen. Both max-height
  // (shrink) and min-height (grow) keep the container's height "indefinite"
  // for percentage resolution while still constraining the element to the
  // user's chosen size, so neither path triggers the jump.
  const applyHeight = (newH) => {
    if (newH <= startHeight) {
      selectedEl.style.removeProperty('height');
      selectedEl.style.setProperty('max-height', newH + 'px', 'important');
      selectedEl.style.setProperty('min-height', '0', 'important');
    } else {
      selectedEl.style.removeProperty('height');
      selectedEl.style.removeProperty('max-height');
      selectedEl.style.setProperty('min-height', newH + 'px', 'important');
    }
  };

  // Add a full-viewport overlay to capture all mouse events during drag
  const dragOverlay = document.createElement('div');
  dragOverlay.id = 'adnota-resizer-drag-overlay';
  dragOverlay.setAttribute('data-adnota-ui', '1');
  Object.assign(dragOverlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    zIndex: '2147483647',
    cursor: (axis === 'x' || axis === 'x-left')
              ? (window.AdnotaCursor?.cursors?.ewResize   ?? 'ew-resize')
          : (axis === 'y' || axis === 'y-top')
              ? (window.AdnotaCursor?.cursors?.nsResize   ?? 'ns-resize')
              : (window.AdnotaCursor?.cursors?.nwseResize ?? 'nwse-resize'),
  });
  document.documentElement.appendChild(dragOverlay);

  function onMove(ev) {
    const dx = ev.clientX - dragStartX;
    const dy = ev.clientY - dragStartY;

    if (axis === 'x' || axis === 'xy') {
      // Right handle: grow/shrink from the right edge, left edge pinned.
      // Pinning lets users move auto-centered elements via two operations
      // (drag left handle out, drag right handle in) instead of having the
      // element re-center every release.
      const newW = Math.max(0, startWidth + dx);
      selectedEl.style.setProperty('width', newW + 'px', 'important');
      selectedEl.style.setProperty('min-width', '0', 'important');
      selectedEl.style.setProperty('max-width', 'none', 'important');
      selectedEl.style.setProperty('margin-left', startMarginLeft + 'px', 'important');
    }
    if (axis === 'x-left') {
      // Left handle: grow/shrink from the left edge, right edge stays fixed.
      // Offset margin-left relative to the original so the right edge stays pinned.
      const newW = Math.max(0, startWidth - dx);
      const widthDelta = newW - startWidth; // positive = grew, negative = shrank
      selectedEl.style.setProperty('width', newW + 'px', 'important');
      selectedEl.style.setProperty('min-width', '0', 'important');
      selectedEl.style.setProperty('max-width', 'none', 'important');
      selectedEl.style.setProperty('margin-left', (startMarginLeft - widthDelta) + 'px', 'important');
    }
    if (axis === 'y' || axis === 'xy') {
      // Bottom handle: grow/shrink from the bottom edge, top edge pinned.
      const newH = Math.max(0, startHeight + dy);
      applyHeight(newH);
      selectedEl.style.setProperty('margin-top', startMarginTop + 'px', 'important');
    }
    if (axis === 'y-top') {
      // Top handle: grow/shrink from the top edge, bottom edge stays pinned via
      // margin-top compensation — mirrors the left-handle math.
      const newH = Math.max(0, startHeight - dy);
      const heightDelta = newH - startHeight;
      applyHeight(newH);
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
      restoreInline();
      dragAxis = null;
      return;
    }

    // Revert inline styles to the page's originals — the persisted <style>
    // rule's !important takes over for the props we resized.
    restoreInline();

    // Build CSS rule from final dimensions.
    const cssParts = [];

    if (axis === 'x' || axis === 'xy') {
      const newW = Math.max(0, startWidth + dx);
      cssParts.push(`width: ${newW}px !important`);
      cssParts.push(`min-width: 0 !important`);
      cssParts.push(`max-width: none !important`);
      cssParts.push(`margin-left: ${startMarginLeft}px !important`);
    }
    if (axis === 'x-left') {
      const newW = Math.max(0, startWidth - dx);
      const widthDelta = newW - startWidth;
      cssParts.push(`width: ${newW}px !important`);
      cssParts.push(`min-width: 0 !important`);
      cssParts.push(`max-width: none !important`);
      cssParts.push(`margin-left: ${startMarginLeft - widthDelta}px !important`);
    }
    const pushHeight = (newH) => {
      if (newH <= startHeight) {
        cssParts.push(`max-height: ${newH}px !important`);
        cssParts.push(`min-height: 0 !important`);
      } else {
        cssParts.push(`min-height: ${newH}px !important`);
        cssParts.push(`max-height: none !important`);
      }
    };
    if (axis === 'y' || axis === 'xy') {
      const newH = Math.max(0, startHeight + dy);
      pushHeight(newH);
      cssParts.push(`margin-top: ${startMarginTop}px !important`);
    }
    if (axis === 'y-top') {
      const newH = Math.max(0, startHeight - dy);
      const heightDelta = newH - startHeight;
      pushHeight(newH);
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

// ─── Commit a CSS rule for an element ────────────────────────────────────────
// Shared dance: add to live Map → rebuild style tag → persist to storage →
// register undo. Used by both the drag-resize commits (width/height/margin)
// and the unstick chip toggle. The optional `kind` discriminator is written to
// the storage row so the chip handler can find a specific entry to remove
// (the unstick entry vs a coexisting width/height entry on the same selector).
//
// Resizes default to domain-wide (`path: '*'`). Unlike the eraser — where
// domain-wide is an explicit user override (Shift+Click) or silent ad-scope
// promotion — resize targets are almost always structural containers (nav,
// sidebar, header, article wrapper) that recur across a site with the same
// selector. Scoping to just the current page would force the user to redo
// the same change on every sibling page. If the selector falls back to a
// structural `nth-child` path and matches something unintended on another
// page, the rule silently no-ops (worst case: reset from that page).
async function commitResizeRule(el, cssText, kind) {
  const selector = generateCSSSelector(el);
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  window.AdnotaLog?.event('resizer', kind ? `${kind}-commit` : 'resize-commit', {
    id, sel: selector, el: window.AdnotaLog.el(el),
    handle: dragAxis, cssText,
  });

  window.AdnotaResizeRules.set(id, { selector, cssText });
  rebuildResizeStyleTag();

  const domain = location.hostname;
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
  if (kind) entry.kind = kind;

  if (window.AdnotaStorage) {
    const data = await chrome.storage.local.get(domain);
    const domainData = data[domain] || { items: [] };
    domainData.items.push(entry);
    await chrome.storage.local.set({ [domain]: domainData });
  }

  // ── Undo ─────────────────────────────────────────────────────────────────
  const undoEntry = {
    _resizeSelector: selector,
    undo: async () => {
      window.AdnotaLog?.event('resizer', 'undo', { id, sel: selector });
      window.AdnotaResizeRules.delete(id);
      rebuildResizeStyleTag();

      // Force a reflow so the browser re-computes layout against the
      // updated stylesheet immediately — no refresh needed.
      const target = document.querySelector(selector);
      if (target) void target.offsetHeight;

      if (window.AdnotaStorage) {
        const data = await chrome.storage.local.get(domain);
        if (data[domain]) {
          data[domain].items = data[domain].items.filter(i => i._id !== id);
          await chrome.storage.local.set({ [domain]: data[domain] });
        }
      }
      window.AdnotaUndo.remove(undoEntry);
      refreshHandles();
    },
  };
  window.AdnotaUndo.push(undoEntry);
  return id;
}

// Drag-resize commit: thin wrapper over commitResizeRule with no `kind`.
async function persistResize(el, cssText) {
  await commitResizeRule(el, cssText);
}

// ─── Unstick chip: apply / remove the override ──────────────────────────────
// Apply is a thin wrapper over commitResizeRule with the unstick cssText and
// `kind: 'unstick'` so the storage row is findable on the inverse path.
async function applyUnstickRule(el) {
  await commitResizeRule(el, UNSTICK_CSS_TEXT, 'unstick');
}

// Targeted removal: deletes only the unstick entry for this selector. Any
// coexisting width/height resize entry on the same selector is preserved
// (e.g. user resized AND unstuck a header — restick should keep the resize).
// The blue ↺ reset on the selection box is the scorched-earth alternative.
async function removeUnstickRule(el) {
  const selector = generateCSSSelector(el);
  const domain = location.hostname;

  if (!window.AdnotaStorage) return;
  const data = await chrome.storage.local.get(domain);
  if (!data[domain]) return;

  const matching = data[domain].items.filter(
    i => i.action === 'RESIZE' && i.selector === selector && i.kind === 'unstick'
  );
  if (matching.length === 0) return;

  // Snapshot for undo before mutating.
  const snapshot = matching.map(i => ({ ...i }));

  // Drop from live Map + rebuild style tag.
  for (const entry of matching) window.AdnotaResizeRules.delete(entry._id);
  rebuildResizeStyleTag();

  // Drop from storage.
  const removedIds = new Set(matching.map(i => i._id));
  data[domain].items = data[domain].items.filter(i => !removedIds.has(i._id));
  await chrome.storage.local.set({ [domain]: data[domain] });

  // Force reflow so the page's natural sticky/fixed CSS takes effect now.
  void el.offsetHeight;

  window.AdnotaLog?.event('resizer', 'restick-commit', {
    sel: selector, count: matching.length, el: window.AdnotaLog.el(el),
  });

  // Undo: re-add the entries to both the Map and storage.
  const undoEntry = {
    _resizeSelector: selector,
    undo: async () => {
      window.AdnotaLog?.event('resizer', 'undo', { sel: selector, kind: 'restick' });
      for (const entry of snapshot) {
        window.AdnotaResizeRules.set(entry._id, { selector: entry.selector, cssText: entry.cssText });
      }
      rebuildResizeStyleTag();
      const fresh = await chrome.storage.local.get(domain);
      const domainData = fresh[domain] || { items: [] };
      for (const entry of snapshot) domainData.items.push(entry);
      await chrome.storage.local.set({ [domain]: domainData });
      window.AdnotaUndo.remove(undoEntry);
    },
  };
  window.AdnotaUndo.push(undoEntry);
}

// ─── Finite-scroll chip: apply / remove the override ───────────────────────
// Apply caps the element's *current* rendered height and clips overflow so
// the page stops growing as the user scrolls. Future scroll-loaded content
// renders into the clipped region invisibly. Stored with `kind:
// 'finite-scroll'` so the inverse path can find and remove it.
async function applyFiniteScrollRule(el) {
  const h = Math.round(el.getBoundingClientRect().height);
  const cssText = `max-height: ${h}px !important; overflow: hidden !important`;
  await commitResizeRule(el, cssText, 'finite-scroll');
}

// Targeted removal: deletes only the finite-scroll entries for this selector,
// preserving any coexisting width/height/unstick rules. Mirrors
// removeUnstickRule's structure (live Map → storage → reflow → undo).
async function removeFiniteScrollRule(el) {
  const selector = generateCSSSelector(el);
  const domain = location.hostname;

  if (!window.AdnotaStorage) return;
  const data = await chrome.storage.local.get(domain);
  if (!data[domain]) return;

  const matching = data[domain].items.filter(
    i => i.action === 'RESIZE' && i.selector === selector && i.kind === 'finite-scroll'
  );
  if (matching.length === 0) return;

  const snapshot = matching.map(i => ({ ...i }));

  for (const entry of matching) window.AdnotaResizeRules.delete(entry._id);
  rebuildResizeStyleTag();

  const removedIds = new Set(matching.map(i => i._id));
  data[domain].items = data[domain].items.filter(i => !removedIds.has(i._id));
  await chrome.storage.local.set({ [domain]: data[domain] });

  void el.offsetHeight;

  window.AdnotaLog?.event('resizer', 'infinite-scroll-restore', {
    sel: selector, count: matching.length, el: window.AdnotaLog.el(el),
  });

  const undoEntry = {
    _resizeSelector: selector,
    undo: async () => {
      window.AdnotaLog?.event('resizer', 'undo', { sel: selector, kind: 'restore-finite-scroll' });
      for (const entry of snapshot) {
        window.AdnotaResizeRules.set(entry._id, { selector: entry.selector, cssText: entry.cssText });
      }
      rebuildResizeStyleTag();
      const fresh = await chrome.storage.local.get(domain);
      const domainData = fresh[domain] || { items: [] };
      for (const entry of snapshot) domainData.items.push(entry);
      await chrome.storage.local.set({ [domain]: domainData });
      window.AdnotaUndo.remove(undoEntry);
    },
  };
  window.AdnotaUndo.push(undoEntry);
}

// Chip click handler. Fires before the document-level click handler bails on
// `isAdnotaElement(e.target)`, but the stopPropagation is a defensive belt —
// the document-level handler already short-circuits on Adnota targets.
actionChip.addEventListener('click', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!hoveredEl) return;
  const target = hoveredEl;
  if (hoveredHasUnstickOverride) {
    await removeUnstickRule(target);
  } else {
    await applyUnstickRule(target);
  }
  // Re-evaluate chip state (label flips) after the action settles.
  updateHoverTarget();
});

// Infinite-scroll chip click handler. Mirrors actionChip's flow.
infiniteChip.addEventListener('click', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!hoveredEl) return;
  const target = hoveredEl;
  if (hoveredHasFiniteScrollOverride) {
    await removeFiniteScrollRule(target);
  } else {
    await applyFiniteScrollRule(target);
  }
  updateHoverTarget();
});

// ─── Message routing ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-resizer') {
    window.AdnotaState.set({
      mode: window.AdnotaState.mode === 'resizer' ? null : 'resizer',
    });
  }
});

// ─── Iframe pointer shield ──────────────────────────────────────────────────
// Cross-origin iframes swallow pointer events — the parent doc never sees the
// hover, so the resizer can't outline the iframe's wrapper. Disabling
// pointer-events on every iframe while resizer is active routes hover/click
// through to the iframe's container, which is the resizable layout element.
let iframeShieldStyleTag = null;
function setIframeShield(active) {
  if (active && !iframeShieldStyleTag) {
    iframeShieldStyleTag = document.createElement('style');
    iframeShieldStyleTag.id = 'adnota-resizer-iframe-shield';
    iframeShieldStyleTag.setAttribute('data-adnota-ui', '1');
    iframeShieldStyleTag.textContent = 'iframe { pointer-events: none !important; }';
    document.head.appendChild(iframeShieldStyleTag);
  } else if (!active && iframeShieldStyleTag) {
    iframeShieldStyleTag.remove();
    iframeShieldStyleTag = null;
  }
}

// ─── React to mode changes ──────────────────────────────────────────────────
let _resizerActive = false;
window.AdnotaState.subscribe((state) => {
  const isResizer = state.mode === 'resizer';
  if (isResizer !== _resizerActive) {
    _resizerActive = isResizer;
    window.AdnotaLog?.event('resizer', isResizer ? 'mode-enter' : 'mode-exit');
  }
  setIframeShield(isResizer);
  if (isResizer) {
    setHudVisible(true);
    updateHUD();
  } else {
    hoverOverlay.style.display = 'none';
    hoveredEl = null;
    rawHoveredEl = null;
    traverseDepth = 0;
    deselectElement();
    setHudVisible(false);
    if (resizerHelpBtn.close) resizerHelpBtn.close();
  }
});

// ─── Hover: highlight layout-significant elements ───────────────────────────
document.addEventListener('mousemove', (e) => {
  if (window.AdnotaState.mode !== 'resizer') return;
  if (dragAxis) return;       // Don't change hover while dragging
  if (selectedEl) return;     // Don't hover while handles are active

  const raw = document.elementFromPoint(e.clientX, e.clientY);
  // Special case: cursor moved onto our own chip cluster. Don't clear the
  // hover state — the chip lives INSIDE the hover overlay and dissolving
  // the overlay the moment the cursor lands on it would make the chip
  // impossible to click. Hold the previous hover state until the cursor
  // moves back to the page.
  if (raw && chipCluster.contains(raw)) return;
  if (!raw || isAdnotaElement(raw)) {
    hoveredEl = null;
    rawHoveredEl = null;
    traverseDepth = 0;
    hoverOverlay.style.display = 'none';
    dimensionBadge.textContent = '';
    actionChip.style.display = 'none';
    infiniteChip.style.display = 'none';
    hoveredHasUnstickOverride = false;
    hoveredHasFiniteScrollOverride = false;
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
    // Move overlay to the end of <html> on every show so it wins DOM-order
    // tie-breaks against page chrome that uses the same max z-index. Cheap
    // — appendChild on an attached node just relocates it, no reflow of
    // siblings.
    document.documentElement.appendChild(hoverOverlay);
    Object.assign(hoverOverlay.style, {
      display: 'block',
      top:    `${rect.top + scrollY}px`,
      left:   `${rect.left + scrollX}px`,
      width:  `${rect.width}px`,
      height: `${rect.height}px`,
    });
    dimensionBadge.textContent = `${Math.round(rect.width)}×${Math.round(rect.height)}`;

    const cs = getComputedStyle(target);
    const selector = generateCSSSelector(target);

    // Unstick chip: surface only when there's something to act on.
    //   - Naturally sticky/fixed -> show `unstick`
    //   - Naturally static but our override is winning -> show `restick`
    //   - Naturally static and no override -> no chip
    const unstickOverridden = hasUnstickOverride(selector);
    if (cs.position === 'sticky' || cs.position === 'fixed') {
      hoveredHasUnstickOverride = false;
      actionChip.textContent = 'unstick';
      actionChip.setAttribute('data-adnota-tooltip', 'Stop this from following you when scrolling');
      actionChip.style.display = '';
    } else if (unstickOverridden) {
      hoveredHasUnstickOverride = true;
      actionChip.textContent = 'restick';
      actionChip.setAttribute('data-adnota-tooltip', 'Restore the original sticky behavior');
      actionChip.style.display = '';
    } else {
      hoveredHasUnstickOverride = false;
      actionChip.style.display = 'none';
    }

    // Infinite-scroll chip: surface only when capping would actually shorten
    // the visible page (rect.height > viewport) or when the override is
    // already applied (so the user can flip it back).
    const finiteOverridden = hasFiniteScrollOverride(selector);
    const tallEnough = rect.height > window.innerHeight;
    if (finiteOverridden) {
      hoveredHasFiniteScrollOverride = true;
      infiniteChip.textContent = 'infinite scroll';
      infiniteChip.setAttribute('data-adnota-tooltip', 'Restore the page\'s natural infinite scrolling');
      infiniteChip.style.display = '';
    } else if (tallEnough) {
      hoveredHasFiniteScrollOverride = false;
      infiniteChip.textContent = 'finite scroll';
      infiniteChip.setAttribute('data-adnota-tooltip', 'Stop this from growing as you scroll');
      infiniteChip.style.display = '';
    } else {
      hoveredHasFiniteScrollOverride = false;
      infiniteChip.style.display = 'none';
    }
  } else {
    hoveredEl = null;
    hoverOverlay.style.display = 'none';
    dimensionBadge.textContent = '';
    actionChip.style.display = 'none';
    infiniteChip.style.display = 'none';
    hoveredHasUnstickOverride = false;
    hoveredHasFiniteScrollOverride = false;
  }
  updateHUD();
}

// ─── Scroll wheel: walk up/down the DOM tree while hovering ─────────────────
document.addEventListener('wheel', (e) => {
  if (window.AdnotaState.mode !== 'resizer') return;
  if (selectedEl) return;     // Don't traverse while handles are active
  if (!rawHoveredEl) return;
  if (!e.shiftKey) return;    // Plain scroll passes through; Shift to walk the DOM

  e.preventDefault();

  // Only commit the depth change when it actually moves to a different
  // target. Keeps traverseDepth bounded by the real chain in both directions
  // — otherwise over-scrolling past the top (or bottom) inflates the value
  // and reversing direction takes the same number of clicks to "spend down"
  // before any visual change.
  // Browsers swap deltaY → deltaX while Shift is held, so read whichever axis
  // has signal — otherwise direction reads as zero and we always step "down".
  const delta = e.deltaY || e.deltaX;
  const tentative = traverseDepth + (delta < 0 ? 1 : -1);
  const newTarget = findLayoutTarget(rawHoveredEl, tentative);
  if (newTarget && newTarget !== hoveredEl) {
    traverseDepth = tentative;
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
  if (window.AdnotaState.mode !== 'resizer') return;
  if (isAdnotaElement(e.target)) return;

  e.preventDefault();
  e.stopPropagation();

  if (selectedEl) {
    // Any click off the selection exits edit mode back to target-select.
    // Handles and the reset button are data-adnota-ui, so they're excluded
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
// Capture phase catches scrolls inside nested overflow containers (window
// scroll events don't bubble from inner scrollers). rAF-throttle to coalesce
// the high-frequency scroll firings into one layout read+write per frame.
let scrollSyncPending = false;
window.addEventListener('scroll', () => {
  if (!selectedEl || dragAxis || scrollSyncPending) return;
  scrollSyncPending = true;
  requestAnimationFrame(() => { scrollSyncPending = false; refreshHandles(); });
}, { passive: true, capture: true });

// ─── Public API ──────────────────────────────────────────────────────────────
// removeOne(id): live-state revert for a single resize entry, used by the
// scratch pad's per-row trash. Caller is responsible for storage deletion.
// Reverts: drops the rule from the Map, rebuilds the override style tag, and
// forces a reflow on the matching element (if still in the DOM) so the new
// natural layout takes effect immediately. Mirrors the undo callback in
// commitResizeRule but without storage I/O or undo-stack management.
function removeOneResize(id) {
  const rule = window.AdnotaResizeRules?.get(id);
  window.AdnotaResizeRules?.delete(id);
  if (typeof window.rebuildResizeStyleTag === 'function') {
    window.rebuildResizeStyleTag();
  }
  if (rule?.selector) {
    let target = null;
    try { target = document.querySelector(rule.selector); } catch (_) {}
    if (target) void target.offsetHeight; // force reflow
  }
  // If the user is currently selected on the same element, refresh handles
  // so the selection box matches the new natural size.
  try { refreshHandles?.(); } catch (_) {}
  window.AdnotaLog?.event('resizer', 'remove-one', { id, sel: rule?.selector || null });
}

// applyOne(record): inverse of removeOne — re-applies a single resize to
// the live page from a storage record. Used when scratch pad undo restores
// a trashed entry. Adds the rule back to AdnotaResizeRules and rebuilds
// the style tag; forces a reflow so the new layout takes effect immediately.
function applyOneResize(record) {
  if (!record) return;
  const id = record._id;
  const selector = record.selector;
  const cssText = record.cssText;
  if (!id || !selector || !cssText) return;
  if (!window.AdnotaResizeRules) return;
  window.AdnotaResizeRules.set(id, { selector, cssText });
  if (typeof window.rebuildResizeStyleTag === 'function') {
    window.rebuildResizeStyleTag();
  }
  let target = null;
  try { target = document.querySelector(selector); } catch (_) {}
  if (target) void target.offsetHeight;
  try { refreshHandles?.(); } catch (_) {}
  window.AdnotaLog?.event('resizer', 'apply-one', { id, sel: selector });
}

window.AdnotaResizer = Object.assign(window.AdnotaResizer || {}, {
  removeOne: removeOneResize,
  applyOne: applyOneResize,
});

})();
