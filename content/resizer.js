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

// ─── Reflow overlay (amber) ─────────────────────────────────────────────────
// Separate overlay used to preview the *target* of a REFLOW button (the flex/
// grid container or the child whose `order` will change). Mutually exclusive
// with the blue hover overlay — see updateReflowOverlayForVerb / hideReflowOverlay.
const reflowHoverOverlay = window.AdnotaUI.createHoverOverlay('adnota-reflow-overlay', '#f59e0b', 'rgba(245, 158, 11, 0.10)');

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
// owns drag handle + V logo + tool row; we own the info span + trash + undo
// + the contextual REFLOW buttons (added after undo with a divider, hidden
// when nothing applies).
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

// Static divider (always visible, between help and the rest)
resizerBody.appendChild(Object.assign(document.createElement('div'), { className: 'adnota-toolbar-divider adnota-toolbar-divider-blue' }));

// ── REFLOW group (inline, contextual) ──────────────────────────────────────
// Three layout-flow buttons: Swap panels, Toggle stack, Send to end. Each
// enables only when the page's flex/grid context supports it; the group +
// trailing divider hide together when none enable. Sits between the static
// divider and trash/undo so persistent utility buttons stay last (matches
// every other tool dock). Click handlers route through applyReflowVerb
// (function declarations hoist).
const reflowRow = document.createElement('div');
reflowRow.id = 'adnota-resizer-reflow-row';
reflowRow.style.display = 'none';   // shown by updateReflowButtonStates
reflowRow.style.gap = '4px';
reflowRow.style.alignItems = 'center';

// Trailing divider — separates REFLOW group from trash/undo. Hidden when
// the group is hidden so single-row dock collapses cleanly to the original
// `[?] | [trash] [undo]` layout.
const reflowDivider = Object.assign(document.createElement('div'), { className: 'adnota-toolbar-divider adnota-toolbar-divider-blue' });
reflowDivider.style.display = 'none';

// Swap panels — flex: flex-direction toggle. Grid: order:-1 on visually-first child.
const REFLOW_SWAP_ICON = '<rect x="2.5" y="5.5" width="5" height="9" rx="1"/><rect x="12.5" y="5.5" width="5" height="9" rx="1"/><path d="M7.5 8 L12.5 12"/><path d="M7.5 12 L12.5 8"/>';
const reflowSwapBtn = window.AdnotaUI.createToolbarIconButton(
  REFLOW_SWAP_ICON,
  'Swap panels',
  () => { if (reflowSwapBtn.dataset.disabled !== '1') applyReflowVerb('swap-panels'); }
);

// Toggle stack — flex-only. Toggles row ↔ column.
const REFLOW_STACK_ICON = '<rect x="3" y="3.5" width="14" height="5" rx="1"/><rect x="3" y="11.5" width="14" height="5" rx="1"/>';
const reflowStackBtn = window.AdnotaUI.createToolbarIconButton(
  REFLOW_STACK_ICON,
  'Stack vertically',
  () => { if (reflowStackBtn.dataset.disabled !== '1') applyReflowVerb('toggle-stack'); }
);

// Send to end / start — applies order on the hovered/selected flex or grid child.
const REFLOW_END_ICON = '<path d="M3 10 L12 10"/><path d="M9 7 L12 10 L9 13"/><path d="M16 4 L16 16"/>';
const reflowEndBtn = window.AdnotaUI.createToolbarIconButton(
  REFLOW_END_ICON,
  'Send to end of the row',
  () => { if (reflowEndBtn.dataset.disabled !== '1') applyReflowVerb('order-end'); }
);

// Mouseenter/leave on each button drives the amber hover-overlay mutex.
for (const btn of [reflowSwapBtn, reflowStackBtn, reflowEndBtn]) {
  const verb = btn === reflowSwapBtn ? 'swap-panels'
            : btn === reflowStackBtn ? 'toggle-stack'
            : 'order-end';
  btn.addEventListener('mouseenter', () => {
    if (btn.dataset.disabled === '1') return;
    showReflowOverlayForVerb(verb);
  });
  btn.addEventListener('mouseleave', () => {
    hideReflowOverlay();
  });
}

reflowRow.appendChild(reflowSwapBtn);
reflowRow.appendChild(reflowStackBtn);
reflowRow.appendChild(reflowEndBtn);
resizerBody.appendChild(reflowRow);
resizerBody.appendChild(reflowDivider);

// Trash — opens scratch pad on Edits / Resized for per-row review/delete.
// Badge auto-managed by createTrashButton when mode/filter are passed.
// Trash + undo always come last to match the rest of the tool docks.
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
    // Selected state: the dotted blue outline already signals selection,
    // so the HUD info area carries the action hint only — no redundant
    // "Selected" badge. When the layout context flags structural gesture
    // inversion (flex-end pinned in a fixed container), surface the
    // warning + a hint to use the parent chip.
    const ctx = selectedEl._adnotaLayoutContext;
    if (ctx?.isFlexEndInFixedContainer) {
      html += `<span style="color:#fbbf24">right handle grows leftward (flex pinned)</span>`;
      html += dot;
      html += `<span style="color:#94a3b8">try resize parent · <span style="color:#93c5fd">↺</span> to reset</span>`;
    } else {
      html += `<span style="color:#94a3b8">Drag a handle to resize · <span style="color:#93c5fd">↺</span> to reset</span>`;
    }
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
let selectionParentChip = null;
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

// CSS display values whose width/height are governed by their parent's
// layout rather than by their own style. Setting CSS `width` on a
// `display: table-row` has no visual effect — the table's column layout
// decides the row's dimensions. `display: contents` has no layout box at
// all. None of these are valid resize targets; a bubble-up that lands on
// one needs to walk back down to a normal block descendant.
function isUnresizableDisplay(el) {
  const display = getComputedStyle(el).display;
  return display === 'contents'
      || display === 'table-row'
      || display === 'table-cell'
      || display === 'table-row-group'
      || display === 'table-header-group'
      || display === 'table-footer-group'
      || display === 'table-column'
      || display === 'table-column-group';
}

// Layout context detection — runs once at drag-start so the strategy stays
// stable for the duration of one drag. Returns:
//   { kind, parent, flexDirection?, isFlexEndInFixedContainer? }
//   kind: 'block' (default) | 'flex-item' | 'grid-item' | 'positioned' | 'table-component'
//
// Detection order matters: position: absolute/fixed wins over flex/grid
// because abs/fixed elements are pulled out of flow and don't participate
// in their parent's layout algorithm.
function getLayoutContext(el) {
  const cs = getComputedStyle(el);
  if (cs.position === 'absolute' || cs.position === 'fixed') {
    return { kind: 'positioned', parent: el.parentElement };
  }
  if (isUnresizableDisplay(el)) {
    return { kind: 'table-component', parent: el.parentElement };
  }
  const parent = el.parentElement;
  if (!parent) return { kind: 'block', parent: null };
  const pcs = getComputedStyle(parent);
  const pdisp = pcs.display;
  if (pdisp === 'flex' || pdisp === 'inline-flex') {
    const flexDirection = pcs.flexDirection || 'row';
    return {
      kind: 'flex-item',
      parent,
      flexDirection,
      isFlexEndInFixedContainer: detectFlexEndInFixed(el, parent, pcs, flexDirection),
    };
  }
  if (pdisp === 'grid' || pdisp === 'inline-grid') {
    return { kind: 'grid-item', parent };
  }
  return { kind: 'block', parent };
}

// The structural pattern where flex layout pins the right edge and forces
// any width grow to come from the left, against the user's gesture intent.
// Conservative predicates — false positives clutter the HUD.
//
// Known imperfection (acknowledged, defer to v1.5): the proximity fallback
// fires for any terminal item filling its parent in row-flex, even when
// justify-content is flex-start and growing the item would actually push
// siblings rightward as expected. Tightening to only flag space-* layouts
// would miss our canonical case (GitHub's PageLayout, which uses default
// flex-start with the pane filling to the right edge of a fixed-width
// container). v1 trades some false positives for reliable detection of the
// real cases; the parent chip is a low-cost suggestion, not a forced action.
function detectFlexEndInFixed(el, parent, pcs, flexDirection) {
  // Row direction only — the inversion is an x-axis phenomenon. Column
  // flex has the analogous y-axis problem but it's out of scope for v1.
  if (flexDirection.startsWith('column')) return false;
  // Parent isn't itself overflowing horizontally — if it were, growing the
  // child would just push more overflow into a region that was already
  // scrolling, not invert the gesture.
  if (parent.scrollWidth > parent.clientWidth + 1) return false;
  // Element anchored at the right edge: explicit justify-content: flex-end,
  // OR rect.right within 4px of the parent's content-box right edge (4px
  // tolerance handles sub-pixel rounding without flagging mid-row items).
  if (pcs.justifyContent === 'flex-end') return true;
  const elRect = el.getBoundingClientRect();
  const pRect = parent.getBoundingClientRect();
  const padR = parseFloat(pcs.paddingRight) || 0;
  return Math.abs(elRect.right - (pRect.right - padR)) < 4;
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
  let baseline = window.AdnotaUI.bubbleToVisualRoot(layoutSig);
  if (isAdnotaElement(baseline)) return null;

  // Step 2.5: walk back down past layout-special display values. Without
  // this, a target hovered inside a CSS table (display: table) — e.g.
  // GitHub's BorderGrid sidebar — bubbles to the table-row level. Setting
  // CSS width on a table-row is ignored by table layout, so the persisted
  // resize rule has zero visual effect and the user thinks resize is broken.
  // Walk down toward layoutSig until we land on a resizable block.
  while (isUnresizableDisplay(baseline) && baseline !== layoutSig) {
    let child = layoutSig;
    while (child && child.parentElement !== baseline) {
      child = child.parentElement;
    }
    if (!child || child === baseline) break;
    baseline = child;
  }

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
  // Cache layout context once at selection time. Used by updateHUD (warning
  // visibility), updateSelectionChip (parent chip visibility), and startDrag
  // (strategy dispatch). Survives until deselectElement clears selectedEl.
  selectedEl._adnotaLayoutContext = getLayoutContext(el);
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

  // Parent-chip: when this element is a flex-end child in a fixed-width
  // container, the right-handle's intent (grow rightward) is structurally
  // impossible — flex pins the right edge. The chip lets the user
  // one-click promote selection to the constraining parent and resize that
  // instead. Visibility decided in updateSelectionChip from the cached
  // layout context.
  selectionParentChip = document.createElement('div');
  selectionParentChip.className = 'adnota-resizer-action-chip';
  selectionParentChip.setAttribute('data-adnota-ui', '1');
  selectionParentChip.style.display = 'none';
  selectionParentChip.textContent = 'resize parent';
  selectionParentChip.setAttribute('data-adnota-tooltip', 'Pane is pinned by its container — resize the container instead');
  selectionParentChip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const parent = selectedEl?._adnotaLayoutContext?.parent;
    if (parent) selectElement(parent);
  });

  selectionChipCluster = document.createElement('div');
  selectionChipCluster.setAttribute('data-adnota-ui', '1');
  Object.assign(selectionChipCluster.style, {
    position: 'absolute',
    top: `${chipClusterTopOffset(rect)}px`,
    right: '32px',
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
    zIndex: '2147483647',
  });
  // Order: parent (when present) → unstick/restick → finite scroll → dimension.
  selectionChipCluster.appendChild(selectionParentChip);
  selectionChipCluster.appendChild(selectionActionChip);
  selectionChipCluster.appendChild(selectionInfiniteChip);
  selectionChipCluster.appendChild(selectionDimBadge);
  selectionBox.appendChild(selectionChipCluster);

  updateSelectionChip();
  updateHUD();
  updateReflowButtonStates();
}

// Re-evaluate the selection chips' labels/visibility against the current
// selectedEl. Called from selectElement (initial), the chips' own click
// handlers, and any path that mutates AdnotaResizeRules for this selector
// (drag persist via refreshHandles, undo).
function updateSelectionChip() {
  if (!selectionActionChip || !selectedEl) return;
  const cs = getComputedStyle(selectedEl);
  const selector = generateCSSSelector(selectedEl);

  // Parent chip — only when the cached layout context flags this as
  // flex-end-in-fixed-container. Click handler reads the same cached parent.
  if (selectionParentChip) {
    const isFlexEndInFixed = selectedEl?._adnotaLayoutContext?.isFlexEndInFixedContainer;
    selectionParentChip.style.display = isFlexEndInFixed ? '' : 'none';
  }

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
  // Drop the cached layout-context expando before clearing the reference,
  // so nothing dangling (including the captured parent ref) survives on
  // the page DOM after the user leaves resizer mode.
  if (selectedEl) delete selectedEl._adnotaLayoutContext;
  selectedEl = null;
  if (selectionBox) { selectionBox.remove(); selectionBox = null; }
  if (handleLeft)   { handleLeft.remove();   handleLeft = null; }
  if (handleRight)  { handleRight.remove();  handleRight = null; }
  if (handleTop)    { handleTop.remove();    handleTop = null; }
  if (handleBottom) { handleBottom.remove(); handleBottom = null; }
  if (handleCorner) { handleCorner.remove(); handleCorner = null; }
  if (dismissBtn)   { dismissBtn.remove();   dismissBtn = null; }
  // Cluster removal also drops its children (badge + action + infinite + parent chips).
  if (selectionChipCluster) { selectionChipCluster.remove(); selectionChipCluster = null; }
  selectionDimBadge = null;
  selectionActionChip = null;
  selectionInfiniteChip = null;
  selectionParentChip = null;
  if (hadSelection && window.AdnotaState.mode === 'resizer') updateHUD();
  updateReflowButtonStates();
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

// Pin the hover/selection chip cluster to the visible top edge of its
// element. When the element's own top is above the viewport (the user has
// scrolled into a tall element), slide the chip down so it stays in view —
// capped so it doesn't push past the element's bottom. Returns the desired
// `top` offset within the cluster's parent (overlay / selection box).
function chipClusterTopOffset(rect) {
  const CHIP_H = 32;  // approximate cluster height; safety cap, not exact
  const ideal = Math.max(4, 4 - rect.top);
  const cap   = Math.max(4, rect.height - CHIP_H);
  return Math.min(ideal, cap);
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

// ─── Drag strategy: helpers shared by all strategies ──────────────────────
// Originally local consts inside startDrag/onUp. Promoted to module scope
// so the per-context strategies below can call them. `startHeight` is now
// passed in rather than closed over.

// Height application during drag (live inline styles). Shrink uses max-height,
// grow uses min-height — both keep the box "indefinite" for percentage
// resolution on absolutely-positioned descendants. See the `Fix bing.com
// RESIZE EXPAND` commit for the full rationale.
function applyHeight(el, newH, startHeight) {
  if (newH <= startHeight) {
    el.style.removeProperty('height');
    el.style.setProperty('max-height', newH + 'px', 'important');
    el.style.setProperty('min-height', '0', 'important');
  } else {
    el.style.removeProperty('height');
    el.style.removeProperty('max-height');
    el.style.setProperty('min-height', newH + 'px', 'important');
  }
}

// Height piece for the persisted CSS rule. Mirror of applyHeight on the
// cssParts side.
function pushHeight(cssParts, newH, startHeight) {
  if (newH <= startHeight) {
    cssParts.push(`max-height: ${newH}px !important`);
    cssParts.push(`min-height: 0 !important`);
  } else {
    cssParts.push(`min-height: ${newH}px !important`);
    cssParts.push(`max-height: none !important`);
  }
}

// ─── Drag strategies ──────────────────────────────────────────────────────
// Each strategy exposes `applyDuringDrag(el, axis, dx, dy, snap)` for live
// inline-style feedback during a drag, and `buildPersistedCss(axis, dx, dy,
// snap)` for the persisted style-tag rule on commit. `snap` carries
// startWidth / startHeight / startMarginLeft / startMarginTop / ctx.
//
// `block` is the default — current behavior, byte-for-byte the same CSS as
// before this refactor on any non-flex element.
//
// `flex-item` uses `flex-basis` + `flex-shrink: 0` for x-axis instead of
// width + margin-left. Margin-left pinning is theater on flex children: the
// flex algorithm decides slot position, our margin offsets are ignored for
// placement. Y-axis still goes through the block path (column-flex inversion
// is a v2 problem).
//
// grid-item / positioned / table-component fall through to block for v1.
// The dispatch infrastructure makes adding real strategies a one-line change
// later.
const STRATEGIES = {
  block: {
    applyDuringDrag(el, axis, dx, dy, snap) {
      if (axis === 'x' || axis === 'xy') {
        const newW = Math.max(0, snap.startWidth + dx);
        el.style.setProperty('width', newW + 'px', 'important');
        el.style.setProperty('min-width', '0', 'important');
        el.style.setProperty('max-width', 'none', 'important');
        el.style.setProperty('margin-left', snap.startMarginLeft + 'px', 'important');
      }
      if (axis === 'x-left') {
        const newW = Math.max(0, snap.startWidth - dx);
        const widthDelta = newW - snap.startWidth;
        el.style.setProperty('width', newW + 'px', 'important');
        el.style.setProperty('min-width', '0', 'important');
        el.style.setProperty('max-width', 'none', 'important');
        el.style.setProperty('margin-left', (snap.startMarginLeft - widthDelta) + 'px', 'important');
      }
      if (axis === 'y' || axis === 'xy') {
        const newH = Math.max(0, snap.startHeight + dy);
        applyHeight(el, newH, snap.startHeight);
        el.style.setProperty('margin-top', snap.startMarginTop + 'px', 'important');
      }
      if (axis === 'y-top') {
        const newH = Math.max(0, snap.startHeight - dy);
        const heightDelta = newH - snap.startHeight;
        applyHeight(el, newH, snap.startHeight);
        el.style.setProperty('margin-top', (snap.startMarginTop - heightDelta) + 'px', 'important');
      }
    },
    buildPersistedCss(axis, dx, dy, snap) {
      const cssParts = [];
      if (axis === 'x' || axis === 'xy') {
        const newW = Math.max(0, snap.startWidth + dx);
        cssParts.push(`width: ${newW}px !important`);
        cssParts.push(`min-width: 0 !important`);
        cssParts.push(`max-width: none !important`);
        cssParts.push(`margin-left: ${snap.startMarginLeft}px !important`);
      }
      if (axis === 'x-left') {
        const newW = Math.max(0, snap.startWidth - dx);
        const widthDelta = newW - snap.startWidth;
        cssParts.push(`width: ${newW}px !important`);
        cssParts.push(`min-width: 0 !important`);
        cssParts.push(`max-width: none !important`);
        cssParts.push(`margin-left: ${snap.startMarginLeft - widthDelta}px !important`);
      }
      if (axis === 'y' || axis === 'xy') {
        const newH = Math.max(0, snap.startHeight + dy);
        pushHeight(cssParts, newH, snap.startHeight);
        cssParts.push(`margin-top: ${snap.startMarginTop}px !important`);
      }
      if (axis === 'y-top') {
        const newH = Math.max(0, snap.startHeight - dy);
        const heightDelta = newH - snap.startHeight;
        pushHeight(cssParts, newH, snap.startHeight);
        cssParts.push(`margin-top: ${snap.startMarginTop - heightDelta}px !important`);
      }
      return cssParts.join('; ');
    },
  },

  'flex-item': {
    applyDuringDrag(el, axis, dx, dy, snap) {
      // X-axis: flex-basis + flex-shrink: 0 + flex-grow: 0 force the new
      // size in the flex algorithm (no auto-shrink-back). margin-left is
      // ALSO needed: flex layout owns slot placement, but margin still
      // applies after placement. The same margin-left math as block (pin
      // for right handle, compensate by widthDelta for left handle) gives
      // the correct anchor behavior — without it, left-handle drag has no
      // way to shift the box leftward and growth ends up on the right.
      if (axis === 'x' || axis === 'xy') {
        const newW = Math.max(0, snap.startWidth + dx);
        el.style.setProperty('flex-basis', newW + 'px', 'important');
        el.style.setProperty('flex-shrink', '0', 'important');
        el.style.setProperty('flex-grow', '0', 'important');
        el.style.setProperty('width', newW + 'px', 'important');
        el.style.setProperty('min-width', '0', 'important');
        el.style.setProperty('max-width', 'none', 'important');
        el.style.setProperty('margin-left', snap.startMarginLeft + 'px', 'important');
      }
      if (axis === 'x-left') {
        const newW = Math.max(0, snap.startWidth - dx);
        const widthDelta = newW - snap.startWidth;
        el.style.setProperty('flex-basis', newW + 'px', 'important');
        el.style.setProperty('flex-shrink', '0', 'important');
        el.style.setProperty('flex-grow', '0', 'important');
        el.style.setProperty('width', newW + 'px', 'important');
        el.style.setProperty('min-width', '0', 'important');
        el.style.setProperty('max-width', 'none', 'important');
        el.style.setProperty('margin-left', (snap.startMarginLeft - widthDelta) + 'px', 'important');
      }
      // Y-axis: identical to block strategy. flex-row pinning issues don't
      // apply on the cross axis, and column-flex y-inversion is out of v1.
      if (axis === 'y' || axis === 'xy') {
        const newH = Math.max(0, snap.startHeight + dy);
        applyHeight(el, newH, snap.startHeight);
        el.style.setProperty('margin-top', snap.startMarginTop + 'px', 'important');
      }
      if (axis === 'y-top') {
        const newH = Math.max(0, snap.startHeight - dy);
        const heightDelta = newH - snap.startHeight;
        applyHeight(el, newH, snap.startHeight);
        el.style.setProperty('margin-top', (snap.startMarginTop - heightDelta) + 'px', 'important');
      }
    },
    buildPersistedCss(axis, dx, dy, snap) {
      const cssParts = [];
      if (axis === 'x' || axis === 'xy') {
        const newW = Math.max(0, snap.startWidth + dx);
        cssParts.push(`flex-basis: ${newW}px !important`);
        cssParts.push(`flex-shrink: 0 !important`);
        cssParts.push(`flex-grow: 0 !important`);
        cssParts.push(`width: ${newW}px !important`);
        cssParts.push(`min-width: 0 !important`);
        cssParts.push(`max-width: none !important`);
        cssParts.push(`margin-left: ${snap.startMarginLeft}px !important`);
      }
      if (axis === 'x-left') {
        const newW = Math.max(0, snap.startWidth - dx);
        const widthDelta = newW - snap.startWidth;
        cssParts.push(`flex-basis: ${newW}px !important`);
        cssParts.push(`flex-shrink: 0 !important`);
        cssParts.push(`flex-grow: 0 !important`);
        cssParts.push(`width: ${newW}px !important`);
        cssParts.push(`min-width: 0 !important`);
        cssParts.push(`max-width: none !important`);
        cssParts.push(`margin-left: ${snap.startMarginLeft - widthDelta}px !important`);
      }
      if (axis === 'y' || axis === 'xy') {
        const newH = Math.max(0, snap.startHeight + dy);
        pushHeight(cssParts, newH, snap.startHeight);
        cssParts.push(`margin-top: ${snap.startMarginTop}px !important`);
      }
      if (axis === 'y-top') {
        const newH = Math.max(0, snap.startHeight - dy);
        const heightDelta = newH - snap.startHeight;
        pushHeight(cssParts, newH, snap.startHeight);
        cssParts.push(`margin-top: ${snap.startMarginTop - heightDelta}px !important`);
      }
      return cssParts.join('; ');
    },
  },
};
// v1 fallbacks — wire dispatch now so adding real strategies later is one line.
STRATEGIES['grid-item']       = STRATEGIES.block;
STRATEGIES.positioned         = STRATEGIES.block;
STRATEGIES['table-component'] = STRATEGIES.block;

// ─── REFLOW: lazy ancestor walk for layout-flow operations ──────────────────
// Given any element, walks upward until it finds a flex or grid container, or
// hits documentElement. ~30 reads max. Runs only on hover/selection change
// and when REFLOW button states need to be evaluated — no caching. The cost-
// benefit of an eager `document.querySelectorAll('*') + getComputedStyle`
// scan didn't pay off (large pages have thousands of nodes; we'd revisit on
// every DOM mutation), and per-hover lazy is plenty fast.
function findReflowContainer(el) {
  if (!el) return null;
  let cur = el.parentElement;
  let depth = 0;
  while (cur && cur !== document.documentElement && depth < 30) {
    if (isAdnotaElement(cur)) return null;
    const cs = getComputedStyle(cur);
    const d = cs.display;
    if (d === 'flex' || d === 'inline-flex') {
      return makeContainerInfo(cur, cs, 'flex');
    }
    if (d === 'grid' || d === 'inline-grid') {
      return makeContainerInfo(cur, cs, 'grid');
    }
    cur = cur.parentElement;
    depth++;
  }
  return null;
}

// Build the metadata object the verb dispatchers need. `visibleChildren`
// excludes Adnota chrome and zero-rect children so swap/order ops act on
// the elements the user actually sees.
function makeContainerInfo(el, cs, kind) {
  const visibleChildren = [];
  for (const c of el.children) {
    if (isAdnotaElement(c)) continue;
    const r = c.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    visibleChildren.push(c);
  }
  return {
    el,
    kind,                             // 'flex' | 'grid'
    direction: cs.flexDirection || 'row',  // meaningful only for flex
    reversed: (cs.flexDirection || '').includes('-reverse'),
    childCount: visibleChildren.length,
    visibleChildren,
  };
}

// If `el` is a direct flex/grid child, return { container, child }. Otherwise
// null. The walk uses immediate parent only — `order` operates on direct
// children of the flex/grid container.
function findReflowChildContext(el) {
  if (!el || !el.parentElement) return null;
  if (isAdnotaElement(el)) return null;
  const parent = el.parentElement;
  if (parent === document.documentElement) return null;
  if (isAdnotaElement(parent)) return null;
  const pcs = getComputedStyle(parent);
  const d = pcs.display;
  if (d !== 'flex' && d !== 'inline-flex' && d !== 'grid' && d !== 'inline-grid') return null;
  const kind = (d === 'grid' || d === 'inline-grid') ? 'grid' : 'flex';
  return { container: makeContainerInfo(parent, pcs, kind), child: el };
}

// Determine which way an `order` move on `child` should go, based on its
// *visual* position among siblings. Returns 'start' if the next click
// should send it visually first, 'end' if last, or null if there's only
// one visible child (nothing to reorder against). Anchored on visual rect
// so it handles row-reverse / column-reverse correctly — the actual order
// value still gets reverse-aware translation in applyReflowVerb.
function nextOrderDirection(child, container) {
  if (!container || !container.visibleChildren) return null;
  if (container.visibleChildren.length < 2) return null;
  const isColumn = container.kind === 'flex' && container.direction.startsWith('column');
  const sorted = [...container.visibleChildren].sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return isColumn ? (ra.top - rb.top) : (ra.left - rb.left);
  });
  const idx = sorted.indexOf(child);
  if (idx < 0) return null;
  return idx === 0 ? 'end' : 'start';
}

// Translate a logical direction ('start' / 'end') into an `order` value,
// accounting for row-reverse / column-reverse where the numeric axis is
// inverted relative to visual position. Sentinel values: max-int beats any
// plausible site CSS, -1 beats the default 0 most pages use.
function orderValueForDirection(direction, container) {
  const isReverse = container.kind === 'flex' && container.direction.includes('-reverse');
  if (direction === 'start') return isReverse ? 2147483647 : -1;
  return isReverse ? -1 : 2147483647;
}

// Top-left visible child by document position. Used by the grid swap path:
// applying `order: -1` to whichever child currently anchors the top-left
// produces a visible "swap" against the rest of the auto-flow grid.
function pickVisuallyFirstChild(visibleChildren) {
  if (!visibleChildren || visibleChildren.length === 0) return null;
  let best = null;
  let bestRect = null;
  for (const c of visibleChildren) {
    const r = c.getBoundingClientRect();
    if (!best ||
        r.top < bestRect.top - 1 ||
        (Math.abs(r.top - bestRect.top) < 1 && r.left < bestRect.left)) {
      best = c;
      bestRect = r;
    }
  }
  return best;
}

// Resolve a verb to the element it would act on (for both dispatching and
// the amber overlay preview). Anchored on selectedEl first (stable user
// commitment), falling back to hoveredEl when nothing is selected. Picking
// selection over hover keeps the REFLOW target stable across the layout
// reflows the verbs themselves cause — hover bubble-up can otherwise drift
// to a different ancestor after a flex-direction flip changes element
// rect sizes, making the buttons "act on a different container each click."
function getReflowTarget(verb) {
  const anchorEl = selectedEl || hoveredEl;
  if (!anchorEl) return null;

  if (verb === 'swap-panels') {
    const ctx = findReflowContainer(anchorEl);
    if (!ctx || ctx.childCount < 2) return null;
    if (ctx.kind === 'flex') return { container: ctx, el: ctx.el };
    const firstChild = pickVisuallyFirstChild(ctx.visibleChildren);
    if (!firstChild) return null;
    return { container: ctx, el: firstChild };
  }
  if (verb === 'toggle-stack') {
    const ctx = findReflowContainer(anchorEl);
    if (!ctx || ctx.kind !== 'flex') return null;
    return { container: ctx, el: ctx.el };
  }
  if (verb === 'order-end') {
    const childCtx = findReflowChildContext(anchorEl);
    if (!childCtx) return null;
    const direction = nextOrderDirection(childCtx.child, childCtx.container);
    if (!direction) return null;   // single-child container — no reorder to do
    return { container: childCtx.container, el: childCtx.child, direction };
  }
  return null;
}

// ─── REFLOW dispatcher ──────────────────────────────────────────────────────
async function applyReflowVerb(verb) {
  const target = getReflowTarget(verb);
  if (!target) return;

  if (verb === 'swap-panels') {
    if (target.container.kind === 'flex') {
      const cur = target.container.direction;
      const newDir = cur.includes('-reverse')
        ? cur.replace('-reverse', '')
        : `${cur}-reverse`;
      await commitResizeRule(target.el, `flex-direction: ${newDir} !important`, 'reflow:swap-panels');
    } else {
      // Grid: toggle order: -1 on the visually-first child. If it already has
      // a negative order (from us or the page), revert to 0.
      const child = target.el;
      const currentOrder = parseInt(getComputedStyle(child).order, 10) || 0;
      const newOrder = currentOrder < 0 ? 0 : -1;
      await commitResizeRule(child, `order: ${newOrder} !important`, 'reflow:swap-panels');
    }
  } else if (verb === 'toggle-stack') {
    const cur = target.container.direction;
    const base = cur.replace('-reverse', '');
    const reverseSuffix = cur.includes('-reverse') ? '-reverse' : '';
    const newBase = base === 'column' ? 'row' : 'column';
    await commitResizeRule(target.el, `flex-direction: ${newBase}${reverseSuffix} !important`, 'reflow:toggle-stack');
  } else if (verb === 'order-end') {
    // target.direction is computed from visual position (not numeric order)
    // so the first click always produces the visible move the label
    // promises. The numeric `order` value flips for reverse containers so
    // CSS row-reverse / column-reverse don't reverse the user's intent.
    const newOrder = orderValueForDirection(target.direction, target.container);
    await commitResizeRule(target.el, `order: ${newOrder} !important`, 'reflow:order-end');
  }

  // The page reflowed — selection box, handles, and overlays are all now
  // sitting at stale positions. Force a layout read on documentElement to
  // ensure new boxes have settled, then refresh.
  void document.documentElement.offsetHeight;
  if (selectedEl) refreshHandles();
  if (rawHoveredEl) updateHoverTarget();
  // If the cursor is still on the REFLOW button (the common case after a
  // click), the amber overlay is showing at the verb target's *old*
  // position — re-show to reposition it over the new layout.
  if (reflowHoverOverlay.style.display !== 'none') {
    hideReflowOverlay();
    showReflowOverlayForVerb(verb);
  }
  updateReflowButtonStates();
}

// ─── REFLOW button state machine ────────────────────────────────────────────
// Computes per-button enable, label flips, and row-level visibility from the
// current hover/selection. Hide-when-empty keeps the row out of the way on
// pages where no flex/grid context is under the cursor.
function setReflowBtnEnabled(btn, enabled) {
  if (enabled) {
    btn.dataset.disabled = '0';
    btn.style.opacity = '';
    btn.style.pointerEvents = '';
    btn.style.cursor = '';
  } else {
    btn.dataset.disabled = '1';
    btn.style.opacity = '0.3';
    btn.style.pointerEvents = 'none';
    btn.style.cursor = 'default';
  }
}

function updateReflowButtonStates() {
  if (window.AdnotaState.mode !== 'resizer') {
    reflowRow.style.display = 'none';
    reflowDivider.style.display = 'none';
    return;
  }

  const swapTarget  = getReflowTarget('swap-panels');
  const stackTarget = getReflowTarget('toggle-stack');
  const orderTarget = getReflowTarget('order-end');

  setReflowBtnEnabled(reflowSwapBtn, !!swapTarget);
  setReflowBtnEnabled(reflowStackBtn, !!stackTarget);
  setReflowBtnEnabled(reflowEndBtn, !!orderTarget);

  // Toggle-stack label flips with current direction.
  if (stackTarget) {
    const isColumn = stackTarget.container.direction.replace('-reverse', '') === 'column';
    reflowStackBtn.setAttribute('data-adnota-tooltip', isColumn ? 'Lay horizontally' : 'Stack vertically');
  } else {
    reflowStackBtn.setAttribute('data-adnota-tooltip', 'Stack vertically');
  }

  // Send-to-end label tracks visual position: if the child is already
  // visually first, the next move is "to end"; otherwise "to start". Axis
  // wording adapts to the container's direction (row → row, column → column).
  // Icon flips horizontally when sending to start so the arrow visually
  // matches the action — direction='start' means an arrow pointing left.
  const orderSvg = reflowEndBtn.querySelector('svg');
  if (orderTarget) {
    const isColumn = orderTarget.container.kind === 'flex'
      && orderTarget.container.direction.startsWith('column');
    const axis = isColumn ? 'column' : 'row';
    const where = orderTarget.direction;  // 'start' | 'end'
    reflowEndBtn.setAttribute('data-adnota-tooltip', `Send to ${where} of the ${axis}`);
    if (orderSvg) orderSvg.style.transform = where === 'start' ? 'scaleX(-1)' : '';
  } else {
    reflowEndBtn.setAttribute('data-adnota-tooltip', 'Send to end of the row');
    if (orderSvg) orderSvg.style.transform = '';
  }

  const anyEnabled = !!(swapTarget || stackTarget || orderTarget);
  reflowRow.style.display = anyEnabled ? 'inline-flex' : 'none';
  reflowDivider.style.display = anyEnabled ? '' : 'none';
}

// ─── REFLOW amber overlay (mutex with blue hover overlay) ───────────────────
// On REFLOW button mouseenter: hide blue, position amber over the verb's
// target, show. On mouseleave: hide amber. The page's next mousemove
// re-enters updateHoverTarget which restores blue naturally — no explicit
// "restore blue" call needed here.
function showReflowOverlayForVerb(verb) {
  const target = getReflowTarget(verb);
  if (!target) return;
  hoverOverlay.style.display = 'none';
  const rect = target.el.getBoundingClientRect();
  const scrollY = window.pageYOffset || document.documentElement.scrollTop;
  const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
  document.documentElement.appendChild(reflowHoverOverlay);
  Object.assign(reflowHoverOverlay.style, {
    display: 'block',
    top:    `${rect.top + scrollY}px`,
    left:   `${rect.left + scrollX}px`,
    width:  `${rect.width}px`,
    height: `${rect.height}px`,
  });
}

function hideReflowOverlay() {
  reflowHoverOverlay.style.display = 'none';
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
  // Pin chip cluster to the visible top edge — keeps it in view when the
  // selection extends above the viewport.
  if (selectionChipCluster) {
    selectionChipCluster.style.top = `${chipClusterTopOffset(rect)}px`;
  }
  // Re-evaluate chip state in case an undo/restick happened while selection
  // is still active (e.g., user hits Ctrl+Z mid-selection).
  updateSelectionChip();
  updateHUD();
  updateReflowButtonStates();
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
  el.style.removeProperty('flex-basis');
  el.style.removeProperty('flex-shrink');
  el.style.removeProperty('flex-grow');
  // REFLOW props — clear so ↺ undoes Swap/Stack/Send-to-end too.
  el.style.removeProperty('flex-direction');
  el.style.removeProperty('order');
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
    // Flex-item strategy may write these; snapshot so a tiny-drag-cancel
    // or a clean release restores the page's pre-drag inline state.
    flexBasis: selectedEl.style.flexBasis,
    flexShrink: selectedEl.style.flexShrink,
    flexGrow: selectedEl.style.flexGrow,
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
    apply('flex-basis', savedInline.flexBasis);
    apply('flex-shrink', savedInline.flexShrink);
    apply('flex-grow', savedInline.flexGrow);
  };

  // Pick the layout strategy once at drag-start. It stays stable for the
  // life of one drag — onMove/onUp dispatch through the same `strategy`
  // and `snapshot`. The block path is byte-identical to pre-strategy
  // behavior on any non-flex element.
  const ctx = selectedEl._adnotaLayoutContext || getLayoutContext(selectedEl);
  const strategy = STRATEGIES[ctx.kind] || STRATEGIES.block;
  const snapshot = { startWidth, startHeight, startMarginLeft, startMarginTop, ctx };

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
    strategy.applyDuringDrag(selectedEl, axis, dx, dy, snapshot);
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

    // Build CSS rule from final dimensions via the chosen strategy.
    const cssText = strategy.buildPersistedCss(axis, dx, dy, snapshot);
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
      updateReflowButtonStates();
    },
  };
  window.AdnotaUndo.push(undoEntry);
  updateReflowButtonStates();
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
    updateReflowButtonStates();
  } else {
    hoverOverlay.style.display = 'none';
    reflowHoverOverlay.style.display = 'none';
    reflowRow.style.display = 'none';
    reflowDivider.style.display = 'none';
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
  // Same carve-out for the REFLOW button row in the dock — its buttons
  // operate on the *previous* hover/selection target, so clearing on
  // mouseenter would leave nothing to act on.
  if (raw && reflowRow.contains(raw)) return;
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
    updateReflowButtonStates();
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
    // Pin chip cluster to the visible top edge — keeps it in view when the
    // hovered element extends above the viewport.
    chipCluster.style.top = `${chipClusterTopOffset(rect)}px`;
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
  updateReflowButtonStates();
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
  if (dragAxis || scrollSyncPending) return;
  if (!selectedEl && !hoveredEl) return;
  scrollSyncPending = true;
  requestAnimationFrame(() => {
    scrollSyncPending = false;
    if (selectedEl) {
      refreshHandles();
    } else if (hoveredEl) {
      // Hover overlay is in document coords and doesn't move on scroll —
      // we only need to reposition the chip cluster within it.
      const rect = hoveredEl.getBoundingClientRect();
      chipCluster.style.top = `${chipClusterTopOffset(rect)}px`;
    }
  });
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
