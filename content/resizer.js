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
// owns drag handle + A logo + tool row; we own the info span + trash + undo
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
      html += `<span style="color:#94a3b8">Drag a handle to resize`;
      if (isPositionable(selectedEl)) {
        html += ` · <span style="color:#93c5fd">drag body</span> to move · <span style="color:#93c5fd">arrows</span> nudge`;
      }
      html += ` · <span style="color:#93c5fd">↺</span> to reset</span>`;
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
let selectionClipChip = null;
let selectionLiftChip = null;
let selectionTextSizeDownChip = null;
let selectionTextSizeUpChip = null;
let selectionRecolorBgChip = null;
let selectionRecolorTextChip = null;
let selectionOverflowClipChip = null;
let selectionOverflowScrollChip = null;
let selectionChipCluster = null;
let chipRowStatus = null;   // row 2 — red warning/status chips

// Drag-time growth-blocker match. Set by onMove via AdnotaLayout.findGrowthOverflow,
// latched after pointerup so the chip's click handler can fire post-release.
// Cleared on selection change, mode exit, and at the top of each new startDrag.
let currentClipMatch = null;

// Position-drag occlusion match (higher-z neighbor that overlaps the dragged
// rect). Lifecycle mirrors currentClipMatch: set by position-drag onMove,
// latched on successful drop so the "Bring to front" chip's click handler can
// fire post-release, cleared on selection change / mode exit / tiny-drag cancel.
let currentLiftMatch = null;
// Last rect we ran findOcclusion against, used as a motion gate inside the
// position-drag rAF so we skip the elementsFromPoint sweep on frames where the
// rect barely moved.
let lastOcclusionCheckRect = null;

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
// all. `display: inline` ignores explicit width/height entirely (the
// canonical case being `<picture>` wrapping an `<img>` — the bubble-up
// IoU=1.0 climbs to picture, but resizing picture changes nothing
// because inline elements take their content's intrinsic size). None of
// these are valid resize targets; a bubble-up that lands on one needs
// to walk back down to a normal block descendant.
//
// `inline-block`, `inline-flex`, `inline-grid` all DO respect width and
// stay valid — they're not in this list.
function isUnresizableDisplay(el) {
  const display = getComputedStyle(el).display;
  return display === 'contents'
      || display === 'inline'
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

window.AdnotaResizeRules = new Map(); // id → { selector, cssText, kind? }

// Parse a cssText fragment into the Set of property names it declares.
// Used by drag-resize dedup to recognize when a new commit's prop set
// covers a prior commit's prop set on the same selector.
function cssTextProps(cssText) {
  const props = new Set();
  if (!cssText) return props;
  for (const decl of cssText.split(';')) {
    const colon = decl.indexOf(':');
    if (colon <= 0) continue;
    const name = decl.slice(0, colon).trim().toLowerCase();
    if (name) props.add(name);
  }
  return props;
}

function isPropsSuperset(superset, subset) {
  if (subset.size === 0) return false;   // empty = nothing to subsume
  for (const p of subset) {
    if (!superset.has(p)) return false;
  }
  return true;
}

// Kind-aware selector expansion for `text-size` and `recolor-text`. Authored
// CSS commonly sets `font-size` / `color` directly on these elements, so
// cascading from a parent selector alone (even with !important) doesn't reach
// them — inheritance loses to a child's own declaration. We add them to the
// selector list so the override hits each one directly.
//
// Two lists because the safety calculus differs:
//
// - `font-size` affects layout (line-box height, wrap points). Scaling a
//   structural <div> that happened to contain text could blow up badge
//   layouts, footer link rows, icon labels — anywhere the design intent
//   was "deliberately small text in a div." Stay conservative.
// - `color` doesn't affect layout. A div with no own color rule already
//   inherits, so adding it to the cascade is a no-op. A div with its own
//   color rule is deliberately not inheriting — and "recolor this card"
//   means "yes, recolor everything inside it." The over-color case is
//   loud (visible immediately) and recoverable (↺ reset), not silent.
//
// Common to both lists, deliberately excluded:
// - <a>: links must stay visually distinguishable
// - <button>, <input>, <select>, <textarea>: scaling/recoloring breaks
//   form affordances
// - <h1>–<h6>: heading hierarchy is part of the page's design intent
// - <code>, <kbd>, <samp>, <var>, <pre>: monospace relationship matters
// - <sub>, <sup>, <small>: their typography is already relative-smaller
//   by design; scaling/recoloring them breaks the visual relationship
const TEXT_SIZE_CASCADE_TAGS = [
  // Block prose
  'p', 'li', 'dd', 'dt', 'blockquote', 'caption', 'figcaption',
  // Inline text formatting — without these, snippets like Google's
  // <em>-wrapped query terms stay un-scaled inside the parent.
  'span', 'em', 'strong', 'b', 'i', 'mark', 'ins', 'del',
  'cite', 'q', 'dfn', 'time', 'abbr',
];

const RECOLOR_TEXT_CASCADE_TAGS = [
  ...TEXT_SIZE_CASCADE_TAGS,
  // Structural containers that real-world apps use for body text (Google
  // search snippets in <div class="VwiC3b">, Tailwind/React utility-CSS
  // apps, headless component libraries). Including them here means a
  // "recolor this card" actually recolors the body prose inside, not
  // just the inline emphasis. Safe to add for color (no layout effect).
  'div', 'section', 'article', 'aside',
  'header', 'footer', 'nav', 'main',
  'figure', 'details', 'summary',
];

function ruleSelectorFor(rule) {
  let cascade = null;
  if (rule.kind === 'text-size') cascade = TEXT_SIZE_CASCADE_TAGS;
  else if (rule.kind === 'recolor-text') cascade = RECOLOR_TEXT_CASCADE_TAGS;
  if (!cascade) return rule.selector;
  const s = rule.selector;
  return [s, ...cascade.map(tag => `${s} ${tag}`)].join(',');
}

function rebuildResizeStyleTag() {
  const tag = getStyleTag();
  const rules = [];
  for (const [, rule] of window.AdnotaResizeRules) {
    rules.push(`${ruleSelectorFor(rule)} { ${rule.cssText} }`);
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

// Is there a position override currently in the live Map for this selector?
// Used to suppress the redundant unstick chip on positioned elements (a
// position rule's cssText already includes `position: relative !important`,
// so the unstick chip would just revert the user's move).
function hasPositionOverride(selector) {
  for (const [, rule] of window.AdnotaResizeRules) {
    if (rule.selector === selector && rule.kind === 'position') return true;
  }
  return false;
}

// Is there a finite-scroll override currently in the live Map for this
// selector? Keyed on `rule.kind` rather than an `overflow: hidden` cssText
// grep — the clip chip (kind:'overflow') also writes `overflow: hidden`, so
// a cssText match would cross-trip the two. Used to flip the chip label
// between `finite scroll` and `infinite scroll`.
function hasFiniteScrollOverride(selector) {
  for (const [, rule] of window.AdnotaResizeRules) {
    if (rule.selector === selector && rule.kind === 'finite-scroll') return true;
  }
  return false;
}

// Is there an overflow (clip / scrollbar) override in the live Map for this
// selector? Returns the active overflow value ('hidden' | 'auto') or null.
// Used to drive the clip / scrollbar chip pair's label + active state.
function getOverflowOverride(selector) {
  for (const [, rule] of window.AdnotaResizeRules) {
    if (rule.selector === selector && rule.kind === 'overflow') {
      return rule.cssText.includes('overflow: auto') ? 'auto' : 'hidden';
    }
  }
  return null;
}

// Does this selector have a drag-resize override (the no-`kind` default)?
// The clip / scrollbar chips are gated on this — overflow only means
// something once the element's box has actually been constrained.
function hasDragResizeOverride(selector) {
  for (const [, rule] of window.AdnotaResizeRules) {
    if (rule.selector === selector && !rule.kind) return true;
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
  // cluster's flex layout instead, sitting at the right end as the readout.
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

  // Clip chip — surfaces during drag (and latches after pointerup) when an
  // ancestor's overflow:hidden|clip is masking growth, OR when the element's
  // own max-width/max-height is capping growth. Click promotes selection to
  // the constraining ancestor for the clip-ancestor case; size-cap is
  // warn-only (no click action in v2). Visibility driven by onMove via
  // AdnotaLayout.findGrowthOverflow.
  selectionClipChip = document.createElement('div');
  selectionClipChip.className = 'adnota-resizer-action-chip adnota-resizer-clip-chip';
  selectionClipChip.setAttribute('data-adnota-ui', '1');
  selectionClipChip.style.display = 'none';
  selectionClipChip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (currentClipMatch?.kind === 'clip-ancestor' && currentClipMatch.ancestor) {
      selectElement(currentClipMatch.ancestor);
    }
    // 'size-cap' is warn-only in v2 — no click action.
  });

  // Lift chip — surfaces during position drag when an overlapping non-Adnota
  // neighbor has a higher z-index than the dragged element. Latches after drop
  // so the click can fire post-release (same dance as the clip chip). Click
  // re-detects against fresh state (latched currentLiftMatch is only good for
  // "should chip exist") and commits a kind:'z-lift' rule above the occluder.
  selectionLiftChip = document.createElement('div');
  selectionLiftChip.className = 'adnota-resizer-action-chip adnota-resizer-lift-chip';
  selectionLiftChip.setAttribute('data-adnota-ui', '1');
  selectionLiftChip.style.display = 'none';
  selectionLiftChip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedEl) return;
    performLift(selectedEl);
  });

  // Text-size chips: Aa−/Aa+ scale the element + common text-bearing
  // descendants via the kind:'text-size' rule. See the text-size helpers
  // section for the cascade rationale (headings/code/forms preserved).
  // U+2212 (mathematical minus) is intentional — looks better than ASCII -.
  selectionTextSizeDownChip = document.createElement('div');
  selectionTextSizeDownChip.className = 'adnota-resizer-action-chip';
  selectionTextSizeDownChip.setAttribute('data-adnota-ui', '1');
  selectionTextSizeDownChip.textContent = 'Aa−';
  selectionTextSizeDownChip.setAttribute('data-adnota-tooltip', 'Smaller text (Shift+click for bigger step)');
  selectionTextSizeDownChip.style.display = 'none';
  selectionTextSizeDownChip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedEl) return;
    bumpTextSize(selectedEl, 'down', e.shiftKey);
    updateSelectionChip();
  });

  selectionTextSizeUpChip = document.createElement('div');
  selectionTextSizeUpChip.className = 'adnota-resizer-action-chip';
  selectionTextSizeUpChip.setAttribute('data-adnota-ui', '1');
  selectionTextSizeUpChip.textContent = 'Aa+';
  selectionTextSizeUpChip.setAttribute('data-adnota-tooltip', 'Bigger text (Shift+click for bigger step)');
  selectionTextSizeUpChip.style.display = 'none';
  selectionTextSizeUpChip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedEl) return;
    bumpTextSize(selectedEl, 'up', e.shiftKey);
    updateSelectionChip();
  });

  // Recolor chips: bucket (background) and A-with-underline (text). Each click
  // opens the native EyeDropper API; the picked color persists via a recolor-bg
  // or recolor-text rule. Re-clicking re-opens EyeDropper and replaces the
  // current color via same-kind dedup. ↺ remains the only way to fully clear.
  // Chips stay visually identical regardless of state — the element repainting
  // IS the user's confirmation, no need to mirror the color on the chip.
  selectionRecolorBgChip = document.createElement('div');
  selectionRecolorBgChip.className = 'adnota-resizer-action-chip';
  selectionRecolorBgChip.setAttribute('data-adnota-ui', '1');
  selectionRecolorBgChip.textContent = 'bg';
  selectionRecolorBgChip.setAttribute('data-adnota-tooltip', 'Background — pick any color from the page');
  selectionRecolorBgChip.style.display = 'none';
  selectionRecolorBgChip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedEl) return;
    pickColorAndApply(selectedEl, 'bg');
  });

  selectionRecolorTextChip = document.createElement('div');
  selectionRecolorTextChip.className = 'adnota-resizer-action-chip';
  selectionRecolorTextChip.setAttribute('data-adnota-ui', '1');
  selectionRecolorTextChip.textContent = 'text';
  selectionRecolorTextChip.setAttribute('data-adnota-tooltip', 'Text color — pick any color from the page');
  selectionRecolorTextChip.style.display = 'none';
  selectionRecolorTextChip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedEl) return;
    pickColorAndApply(selectedEl, 'text');
  });

  // Overflow chips: clip / scrollbar. A pair of two-state toggle chips that
  // decide what happens to content that no longer fits after a resize —
  // `clip` injects `overflow: hidden`, `scrollbar` injects `overflow: auto`.
  // Neither active = the page's own overflow, untouched (the resting state —
  // forcing overflow unconditionally caused trouble historically, so the
  // default is to leave it alone). Visibility + labels are driven entirely
  // by updateSelectionChip; each label describes its *next* action, matching
  // the unstick/finite-scroll idiom. Stored as kind:'overflow' — same-kind
  // dedup means clip and scrollbar can't coexist, and ↺ clears it like any
  // other kind.
  selectionOverflowClipChip = document.createElement('div');
  selectionOverflowClipChip.className = 'adnota-resizer-action-chip';
  selectionOverflowClipChip.setAttribute('data-adnota-ui', '1');
  selectionOverflowClipChip.style.display = 'none';
  selectionOverflowClipChip.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedEl) return;
    if (getOverflowOverride(generateCSSSelector(selectedEl)) === 'hidden') {
      await removeResizeRule(selectedEl, 'overflow');   // unclip → page's own overflow
    } else {
      await applyOverflowRule(selectedEl, 'hidden');    // clip
    }
    updateSelectionChip();
  });

  selectionOverflowScrollChip = document.createElement('div');
  selectionOverflowScrollChip.className = 'adnota-resizer-action-chip';
  selectionOverflowScrollChip.setAttribute('data-adnota-ui', '1');
  selectionOverflowScrollChip.style.display = 'none';
  selectionOverflowScrollChip.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedEl) return;
    if (getOverflowOverride(generateCSSSelector(selectedEl)) === 'auto') {
      await removeResizeRule(selectedEl, 'overflow');   // remove scrollbar → page's own overflow
    } else {
      await applyOverflowRule(selectedEl, 'auto');      // scrollbar
    }
    updateSelectionChip();
  });

  selectionChipCluster = document.createElement('div');
  selectionChipCluster.setAttribute('data-adnota-ui', '1');
  Object.assign(selectionChipCluster.style, {
    position: 'absolute',
    top: `${chipClusterTopOffset(rect, true)}px`,
    // The dismiss button (20px) straddles the corner — its left edge
    // sits 10px inside the selection box. 14px clears the button by 4px,
    // matching the hover cluster's right:4px breathing room.
    right: '14px',
    // Two stacked rows: tools on top, red status chips below. Column flex
    // with flex-end alignment keeps both rows right-pinned under the corner.
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '4px',
    zIndex: '2147483647',
  });

  // Row 1 — amber action chips + the blue dimension readout. The dimension
  // badge stays on row 1 (not pushed down with the status chips) so its
  // screen position matches the hover-state pill — deliberate hover↔selection
  // continuity. It's the lone blue chip and earns the exception.
  const chipRowPrimary = document.createElement('div');
  chipRowPrimary.setAttribute('data-adnota-ui', '1');
  Object.assign(chipRowPrimary.style, { display: 'flex', gap: '4px', alignItems: 'center' });

  // Row 2 — red warning/status chips. Starts hidden and only takes up space
  // when it has a visible child (see syncStatusRowVisibility) so it's never
  // a permanent empty band under row 1.
  chipRowStatus = document.createElement('div');
  chipRowStatus.setAttribute('data-adnota-ui', '1');
  Object.assign(chipRowStatus.style, { display: 'none', gap: '4px', alignItems: 'center' });

  // Row 1 order: parent → unstick → finite scroll → clip/scrollbar → text-size
  // → recolor → lift → dimension. Row 2: the red clip/size-cap warning chip.
  chipRowPrimary.appendChild(selectionParentChip);
  chipRowPrimary.appendChild(selectionActionChip);
  chipRowPrimary.appendChild(selectionInfiniteChip);
  // Static order: scrollbar before clip. The cluster grows leftward (right
  // edge pinned), so this order keeps clip→unclip stable under the cursor
  // (scrollbar appears to its left, clip stays put — the common entry path,
  // from a fresh shrink that's now spilling content). The mirror direction
  // (scrollbar→no-scrollbar) does wobble, but stable order wins over chasing
  // both — see the earlier dynamic-reorder attempt that swapped chip sides.
  chipRowPrimary.appendChild(selectionOverflowScrollChip);
  chipRowPrimary.appendChild(selectionOverflowClipChip);
  chipRowPrimary.appendChild(selectionTextSizeDownChip);
  chipRowPrimary.appendChild(selectionTextSizeUpChip);
  chipRowPrimary.appendChild(selectionRecolorBgChip);
  chipRowPrimary.appendChild(selectionRecolorTextChip);
  chipRowPrimary.appendChild(selectionLiftChip);
  chipRowPrimary.appendChild(selectionDimBadge);
  chipRowStatus.appendChild(selectionClipChip);
  selectionChipCluster.appendChild(chipRowPrimary);
  selectionChipCluster.appendChild(chipRowStatus);
  selectionBox.appendChild(selectionChipCluster);

  updateSelectionChip();
  updateHUD();
  updateReflowButtonStates();

  // Body-drag-to-position affordances. Cursor stays as page-default for
  // non-positionable selections (viewport-dominators, table-rows) so the
  // unavailable state is communicated by absence.
  //
  // `setProperty(..., 'important')` is required to beat the global cursor
  // lock injected by highlighter.js (`*:not([data-adnota-ui]) { cursor:
  // crosshair !important }` while resizer mode is active). Inline
  // !important beats stylesheet !important per cascade rules.
  if (isPositionable(el)) {
    el._adnotaPriorCursor = el.style.cursor;
    el.style.setProperty('cursor', 'move', 'important');
    el.dataset.adnotaPositionable = '1';
    ensurePositionCursorStyle();
    el.addEventListener('mousedown', onBodyDragStart, true);

    // First-use discovery toast. Mirrors the eraser's domain-tutorial
    // pattern at content/eraser.js:853 — chrome.storage.local for
    // cross-machine sync, gracefully no-ops if context is invalidated.
    const TUTORIAL_KEY = 'adnotaPositionTipShown';
    chrome.storage.local.get(TUTORIAL_KEY).then((data) => {
      if (data[TUTORIAL_KEY]) return;
      chrome.storage.local.set({ [TUTORIAL_KEY]: true });
      window.AdnotaUI?.showToast(
        'Tip: drag any element to move it — arrow keys nudge by 1px (10px with Shift).',
        { id: 'adnota-position-tip', timeout: 5000 }
      );
    }).catch(() => { /* context invalidated after extension reload */ });
  }
}

// Re-evaluate the selection chips' labels/visibility against the current
// selectedEl. Called from selectElement (initial), the chips' own click
// handlers, and any path that mutates AdnotaResizeRules for this selector
// (drag persist via refreshHandles, undo).
// Does the selectedEl have any rules (CSS or DOM-reorder) that ↺ would
// actually clear? Drives the dismissBtn's disabled affordance — clicking
// it on a clean selection just deselects, which is redundant with the
// corner-X dismiss path and confusing because the icon promises "undo
// my edits."
function hasResetableState(el) {
  if (!el) return false;
  const selector = generateCSSSelector(el);
  for (const [, rule] of window.AdnotaResizeRules) {
    if (rule.selector === selector) return true;
  }
  for (const [, rule] of window.AdnotaReorderRules || []) {
    if (rule.sourceEl === el) return true;
    if (rule.sourceAnchor?.cssSelector === selector) return true;
  }
  return false;
}

function updateSelectionChip() {
  if (!selectionActionChip || !selectedEl) return;
  const cs = getComputedStyle(selectedEl);
  const selector = generateCSSSelector(selectedEl);

  // ↺ dismiss button — dim when no rules apply. The button stays visible
  // (so the affordance is discoverable) but pointer-events:none and
  // dimmed so a click doesn't fire the no-op deselect.
  if (dismissBtn) {
    const resetable = hasResetableState(selectedEl);
    if (resetable) {
      dismissBtn.dataset.disabled = '0';
      dismissBtn.style.opacity = '';
      dismissBtn.style.pointerEvents = '';
      dismissBtn.style.cursor = '';
      dismissBtn.setAttribute('data-adnota-tooltip', 'Reset to original');
    } else {
      dismissBtn.dataset.disabled = '1';
      dismissBtn.style.opacity = '0.4';
      dismissBtn.style.pointerEvents = 'none';
      dismissBtn.style.cursor = 'default';
      dismissBtn.setAttribute('data-adnota-tooltip', 'Reset (nothing to undo)');
    }
  }

  // Parent chip — only when the cached layout context flags this as
  // flex-end-in-fixed-container. Click handler reads the same cached parent.
  if (selectionParentChip) {
    const isFlexEndInFixed = selectedEl?._adnotaLayoutContext?.isFlexEndInFixedContainer;
    selectionParentChip.style.display = isFlexEndInFixed ? '' : 'none';
  }

  // Unstick chip — suppressed when a position rule already covers the element.
  // The position cssText sets `position: relative !important` which subsumes
  // unstick's behavior; surfacing the chip would let the user inadvertently
  // strip part of their move.
  const unstickOverridden = hasUnstickOverride(selector);
  const positionOverridden = hasPositionOverride(selector);
  if (positionOverridden) {
    selectionActionChip.style.display = 'none';
    selectionActionChip._isOverridden = false;
  } else if (cs.position === 'sticky' || cs.position === 'fixed') {
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

  // Text-size chips — show on any selectable element except html/body/table-
  // components. Disable Aa- at the floor (8px) and Aa+ at the ceiling (96px)
  // so a click at the bound isn't a silent no-op.
  if (selectionTextSizeDownChip && selectionTextSizeUpChip) {
    if (isScalable(selectedEl)) {
      const px = currentTextSizePx(selectedEl, selector);
      setReflowBtnEnabled(selectionTextSizeDownChip, px > 8 + 1e-3);
      setReflowBtnEnabled(selectionTextSizeUpChip,   px < 96 - 1e-3);
      selectionTextSizeDownChip.style.display = '';
      selectionTextSizeUpChip.style.display   = '';
    } else {
      selectionTextSizeDownChip.style.display = 'none';
      selectionTextSizeUpChip.style.display   = 'none';
    }
  }

  // Recolor chips — show on the same predicate as text-size. No state
  // mirroring on the chip itself: the element repaint IS the user's feedback.
  if (selectionRecolorBgChip && selectionRecolorTextChip) {
    const show = isRecolorable(selectedEl) ? '' : 'none';
    selectionRecolorBgChip.style.display   = show;
    selectionRecolorTextChip.style.display = show;
  }

  // Overflow chips (clip / scrollbar) — gated on an existing drag-resize
  // override: overflow only means something once the element's box has
  // actually been constrained. Suppressed while finite-scroll owns overflow
  // on this element (it already injects overflow:hidden — the two would
  // fight). Contextual: `clip` surfaces when content is spilling out of the
  // box (or is the active override), `scrollbar` when content is being cut
  // off (or is the active override). Each is a two-state toggle — the label
  // describes the *next* action, so the active override reads as its inverse
  // (`unclip` / `no scrollbar`) and a second click returns to the page's own
  // overflow. getComputedStyle already reflects our injected rule, so
  // overflowX/Y accounts for an active clip/scrollbar override.
  if (selectionOverflowClipChip && selectionOverflowScrollChip) {
    const overflowState = getOverflowOverride(selector);   // 'hidden' | 'auto' | null
    if (!hasDragResizeOverride(selector) || hasFiniteScrollOverride(selector)) {
      selectionOverflowClipChip.style.display   = 'none';
      selectionOverflowScrollChip.style.display = 'none';
    } else {
      const overflowsY = selectedEl.scrollHeight > selectedEl.clientHeight + 1;
      const overflowsX = selectedEl.scrollWidth  > selectedEl.clientWidth  + 1;
      const hasOverflowContent = overflowsY || overflowsX;
      const ovY = cs.overflowY, ovX = cs.overflowX;
      const spilling   = hasOverflowContent && (ovY === 'visible' || ovX === 'visible');
      const clipped    = hasOverflowContent && (ovY === 'hidden' || ovY === 'clip' || ovX === 'hidden' || ovX === 'clip');
      const scrollable = hasOverflowContent && (ovY === 'auto' || ovY === 'scroll' || ovX === 'auto' || ovX === 'scroll');

      // clip chip: active override → `unclip`; otherwise offer `clip` when
      // content is spilling (contain it) or already scrollable (switch to it).
      if (overflowState === 'hidden') {
        selectionOverflowClipChip.textContent = 'unclip';
        selectionOverflowClipChip.setAttribute('data-adnota-tooltip', "Stop clipping — restore the page's own overflow");
        selectionOverflowClipChip.style.display = '';
      } else if (spilling || scrollable) {
        selectionOverflowClipChip.textContent = 'clip';
        selectionOverflowClipChip.setAttribute('data-adnota-tooltip', 'Cut off content that no longer fits the resized box');
        selectionOverflowClipChip.style.display = '';
      } else {
        selectionOverflowClipChip.style.display = 'none';
      }

      // scrollbar chip: active override → `no scrollbar`; otherwise offer
      // `scrollbar` when content is being cut off (make it reachable).
      if (overflowState === 'auto') {
        selectionOverflowScrollChip.textContent = 'no scrollbar';
        selectionOverflowScrollChip.setAttribute('data-adnota-tooltip', "Remove the scrollbar — restore the page's own overflow");
        selectionOverflowScrollChip.style.display = '';
      } else if (clipped) {
        selectionOverflowScrollChip.textContent = 'scrollbar';
        selectionOverflowScrollChip.setAttribute('data-adnota-tooltip', 'Add a scrollbar so the cut-off content stays reachable');
        selectionOverflowScrollChip.style.display = '';
      } else {
        selectionOverflowScrollChip.style.display = 'none';
      }
    }
  }

  // Keep the status row collapsed unless a row-2 chip is showing (future-
  // proofs against any row-2 chip whose state is driven from here).
  syncStatusRowVisibility();
}

function deselectElement() {
  const hadSelection = !!selectedEl;
  // Drop the cached layout-context expando before clearing the reference,
  // so nothing dangling (including the captured parent ref) survives on
  // the page DOM after the user leaves resizer mode.
  if (selectedEl) {
    delete selectedEl._adnotaLayoutContext;
    // Tear down position-drag affordances. The listener was bound only when
    // isPositionable was true at select-time; remove unconditionally because
    // removeEventListener with a non-matching listener is a no-op.
    selectedEl.removeEventListener('mousedown', onBodyDragStart, true);
    delete selectedEl.dataset.adnotaPositionable;
    if ('_adnotaPriorCursor' in selectedEl) {
      // Use removeProperty to clear the !important inline we set; if the
      // page had its own inline cursor (rare but possible), put it back.
      if (selectedEl._adnotaPriorCursor) {
        selectedEl.style.cursor = selectedEl._adnotaPriorCursor;
      } else {
        selectedEl.style.removeProperty('cursor');
      }
      delete selectedEl._adnotaPriorCursor;
    }
  }
  // Drop any in-flight arrow-nudge debounce so it can't fire after the user
  // has moved on to a different element (or out of resizer mode entirely).
  cancelPendingNudge();
  selectedEl = null;
  if (selectionBox) { selectionBox.remove(); selectionBox = null; }
  if (handleLeft)   { handleLeft.remove();   handleLeft = null; }
  if (handleRight)  { handleRight.remove();  handleRight = null; }
  if (handleTop)    { handleTop.remove();    handleTop = null; }
  if (handleBottom) { handleBottom.remove(); handleBottom = null; }
  if (handleCorner) { handleCorner.remove(); handleCorner = null; }
  if (dismissBtn)   { dismissBtn.remove();   dismissBtn = null; }
  // Cluster removal also drops the dim badge (it's a flex child).
  if (selectionChipCluster) { selectionChipCluster.remove(); selectionChipCluster = null; }
  selectionDimBadge = null;
  selectionActionChip = null;
  selectionInfiniteChip = null;
  selectionParentChip = null;
  selectionClipChip = null;
  selectionLiftChip = null;
  selectionTextSizeDownChip = null;
  selectionTextSizeUpChip = null;
  selectionRecolorBgChip = null;
  selectionRecolorTextChip = null;
  selectionOverflowClipChip = null;
  selectionOverflowScrollChip = null;
  chipRowStatus = null;
  currentClipMatch = null;
  currentLiftMatch = null;
  lastOcclusionCheckRect = null;
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
function chipClusterTopOffset(rect, twoRow) {
  // The selection cluster can carry a second row (red status chips), so it
  // reserves more vertical room than the single-row hover cluster. Both are
  // safety caps, not exact — over-reserving just keeps the cluster a little
  // higher on a short element, which is harmless.
  const CHIP_H = twoRow ? 60 : 32;
  const ideal = Math.max(4, 4 - rect.top);
  const cap   = Math.max(4, rect.height - CHIP_H);
  return Math.min(ideal, cap);
}

// The status row (row 2) only occupies space when it has a visible child —
// keeps it from being a permanent empty band under row 1. Called whenever a
// row-2 chip's visibility changes.
function syncStatusRowVisibility() {
  if (!chipRowStatus) return;
  const anyVisible = [...chipRowStatus.children].some(c => c.style.display !== 'none');
  chipRowStatus.style.display = anyVisible ? 'flex' : 'none';
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
function applyHeight(el, newH, startHeight, fillRisk) {
  if (newH <= startHeight) {
    el.style.removeProperty('height');
    el.style.setProperty('max-height', newH + 'px', 'important');
    el.style.setProperty('min-height', '0', 'important');
  } else {
    el.style.removeProperty('height');
    el.style.setProperty('min-height', newH + 'px', 'important');
    if (fillRisk) {
      // Cap the upper bound so a fill-mode descendant's intrinsic
      // aspect ratio can't push the rendered height past newH.
      el.style.setProperty('max-height', newH + 'px', 'important');
    } else {
      el.style.removeProperty('max-height');
    }
  }
}

// Height piece for the persisted CSS rule. Mirror of applyHeight on the
// cssParts side.
function pushHeight(cssParts, newH, startHeight, fillRisk) {
  if (newH <= startHeight) {
    cssParts.push(`max-height: ${newH}px !important`);
    cssParts.push(`min-height: 0 !important`);
  } else {
    cssParts.push(`min-height: ${newH}px !important`);
    // Same fillRisk reasoning as applyHeight — cap on grow rather than
    // leaving max-height open, since the persisted rule lives on across
    // reloads and would otherwise re-trigger the runaway every page load.
    cssParts.push(`max-height: ${fillRisk ? newH + 'px' : 'none'} !important`);
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
      const fillRisk = snap.fillModeRisk;
      // max-width: 'none' is the default to free up width-capped CSS rules
      // (e.g. .container { max-width: 1200px }). When fillRisk is set we
      // swap to a hard cap at newW — see snapshot.fillModeRisk in startDrag.
      const xMax = (newW) => fillRisk ? newW + 'px' : 'none';
      if (axis === 'x' || axis === 'xy') {
        const newW = Math.max(0, snap.startWidth + dx);
        el.style.setProperty('width', newW + 'px', 'important');
        el.style.setProperty('min-width', '0', 'important');
        el.style.setProperty('max-width', xMax(newW), 'important');
        el.style.setProperty('margin-left', snap.startMarginLeft + 'px', 'important');
      }
      if (axis === 'x-left') {
        const newW = Math.max(0, snap.startWidth - dx);
        const widthDelta = newW - snap.startWidth;
        el.style.setProperty('width', newW + 'px', 'important');
        el.style.setProperty('min-width', '0', 'important');
        el.style.setProperty('max-width', xMax(newW), 'important');
        el.style.setProperty('margin-left', (snap.startMarginLeft - widthDelta) + 'px', 'important');
      }
      if (axis === 'y' || axis === 'xy') {
        const newH = Math.max(0, snap.startHeight + dy);
        applyHeight(el, newH, snap.startHeight, fillRisk);
        el.style.setProperty('margin-top', snap.startMarginTop + 'px', 'important');
      }
      if (axis === 'y-top') {
        const newH = Math.max(0, snap.startHeight - dy);
        const heightDelta = newH - snap.startHeight;
        applyHeight(el, newH, snap.startHeight, fillRisk);
        el.style.setProperty('margin-top', (snap.startMarginTop - heightDelta) + 'px', 'important');
      }
      // Lock the non-dragged axis at start when fillRisk is present.
      // Single-axis drags otherwise leave the other axis unconstrained,
      // and a fill-mode descendant's intrinsic ratio fills the gap with
      // its source dimensions (the HackerNoon Yubico banner failure).
      if (fillRisk) {
        if (axis === 'x' || axis === 'x-left') {
          el.style.setProperty('max-height', snap.startHeight + 'px', 'important');
          el.style.setProperty('min-height', '0', 'important');
        } else if (axis === 'y' || axis === 'y-top') {
          el.style.setProperty('max-width', snap.startWidth + 'px', 'important');
          el.style.setProperty('min-width', '0', 'important');
        }
      }
    },
    buildPersistedCss(axis, dx, dy, snap) {
      const cssParts = [];
      const fillRisk = snap.fillModeRisk;
      const xMax = (newW) => fillRisk ? newW + 'px' : 'none';
      if (axis === 'x' || axis === 'xy') {
        const newW = Math.max(0, snap.startWidth + dx);
        cssParts.push(`width: ${newW}px !important`);
        cssParts.push(`min-width: 0 !important`);
        cssParts.push(`max-width: ${xMax(newW)} !important`);
        cssParts.push(`margin-left: ${snap.startMarginLeft}px !important`);
      }
      if (axis === 'x-left') {
        const newW = Math.max(0, snap.startWidth - dx);
        const widthDelta = newW - snap.startWidth;
        cssParts.push(`width: ${newW}px !important`);
        cssParts.push(`min-width: 0 !important`);
        cssParts.push(`max-width: ${xMax(newW)} !important`);
        cssParts.push(`margin-left: ${snap.startMarginLeft - widthDelta}px !important`);
      }
      if (axis === 'y' || axis === 'xy') {
        const newH = Math.max(0, snap.startHeight + dy);
        pushHeight(cssParts, newH, snap.startHeight, fillRisk);
        cssParts.push(`margin-top: ${snap.startMarginTop}px !important`);
      }
      if (axis === 'y-top') {
        const newH = Math.max(0, snap.startHeight - dy);
        const heightDelta = newH - snap.startHeight;
        pushHeight(cssParts, newH, snap.startHeight, fillRisk);
        cssParts.push(`margin-top: ${snap.startMarginTop - heightDelta}px !important`);
      }
      if (fillRisk) {
        if (axis === 'x' || axis === 'x-left') {
          cssParts.push(`max-height: ${snap.startHeight}px !important`);
          cssParts.push(`min-height: 0 !important`);
        } else if (axis === 'y' || axis === 'y-top') {
          cssParts.push(`max-width: ${snap.startWidth}px !important`);
          cssParts.push(`min-width: 0 !important`);
        }
      }
      return cssParts.join('; ');
    },
  },

  'flex-item': {
    applyDuringDrag(el, axis, dx, dy, snap) {
      const fillRisk = snap.fillModeRisk;
      const xMax = (newW) => fillRisk ? newW + 'px' : 'none';
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
        el.style.setProperty('max-width', xMax(newW), 'important');
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
        el.style.setProperty('max-width', xMax(newW), 'important');
        el.style.setProperty('margin-left', (snap.startMarginLeft - widthDelta) + 'px', 'important');
      }
      // Y-axis: identical to block strategy. flex-row pinning issues don't
      // apply on the cross axis, and column-flex y-inversion is out of v1.
      if (axis === 'y' || axis === 'xy') {
        const newH = Math.max(0, snap.startHeight + dy);
        applyHeight(el, newH, snap.startHeight, fillRisk);
        el.style.setProperty('margin-top', snap.startMarginTop + 'px', 'important');
      }
      if (axis === 'y-top') {
        const newH = Math.max(0, snap.startHeight - dy);
        const heightDelta = newH - snap.startHeight;
        applyHeight(el, newH, snap.startHeight, fillRisk);
        el.style.setProperty('margin-top', (snap.startMarginTop - heightDelta) + 'px', 'important');
      }
      // Lock the non-dragged axis at start when fillRisk is present.
      // See block.applyDuringDrag for reasoning.
      if (fillRisk) {
        if (axis === 'x' || axis === 'x-left') {
          el.style.setProperty('max-height', snap.startHeight + 'px', 'important');
          el.style.setProperty('min-height', '0', 'important');
        } else if (axis === 'y' || axis === 'y-top') {
          el.style.setProperty('max-width', snap.startWidth + 'px', 'important');
          el.style.setProperty('min-width', '0', 'important');
        }
      }
    },
    buildPersistedCss(axis, dx, dy, snap) {
      const cssParts = [];
      const fillRisk = snap.fillModeRisk;
      const xMax = (newW) => fillRisk ? newW + 'px' : 'none';
      if (axis === 'x' || axis === 'xy') {
        const newW = Math.max(0, snap.startWidth + dx);
        cssParts.push(`flex-basis: ${newW}px !important`);
        cssParts.push(`flex-shrink: 0 !important`);
        cssParts.push(`flex-grow: 0 !important`);
        cssParts.push(`width: ${newW}px !important`);
        cssParts.push(`min-width: 0 !important`);
        cssParts.push(`max-width: ${xMax(newW)} !important`);
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
        cssParts.push(`max-width: ${xMax(newW)} !important`);
        cssParts.push(`margin-left: ${snap.startMarginLeft - widthDelta}px !important`);
      }
      if (axis === 'y' || axis === 'xy') {
        const newH = Math.max(0, snap.startHeight + dy);
        pushHeight(cssParts, newH, snap.startHeight, fillRisk);
        cssParts.push(`margin-top: ${snap.startMarginTop}px !important`);
      }
      if (axis === 'y-top') {
        const newH = Math.max(0, snap.startHeight - dy);
        const heightDelta = newH - snap.startHeight;
        pushHeight(cssParts, newH, snap.startHeight, fillRisk);
        cssParts.push(`margin-top: ${snap.startMarginTop - heightDelta}px !important`);
      }
      if (fillRisk) {
        if (axis === 'x' || axis === 'x-left') {
          cssParts.push(`max-height: ${snap.startHeight}px !important`);
          cssParts.push(`min-height: 0 !important`);
        } else if (axis === 'y' || axis === 'y-top') {
          cssParts.push(`max-width: ${snap.startWidth}px !important`);
          cssParts.push(`min-width: 0 !important`);
        }
      }
      return cssParts.join('; ');
    },
  },
};
// v1 fallbacks — wire dispatch now so adding real strategies later is one line.
STRATEGIES['grid-item']       = STRATEGIES.block;
STRATEGIES.positioned         = STRATEGIES.block;
STRATEGIES['table-component'] = STRATEGIES.block;

// ─── REFLOW: container resolution for swap-panels / toggle-stack ────────────
// Only matches when `el` IS a flex/grid container, or its IMMEDIATE parent
// is one. No deep walk: a deep walk on a paragraph deep inside a flex-laid
// page finds the page's top-level flex container and would offer to
// reorganize the entire page — wildly out of scope from what the user
// selected. Restricting to (self | direct parent) keeps container verbs
// close to the user's selection scale. The resizer's bubble-up targeting
// already lands the selection on a layout-significant ancestor for typical
// clicks, so reaching the "correct" flex level (e.g., GitHub's PageLayout)
// usually requires zero or one Shift+Scroll traversal step from the
// initial click.
function findReflowContainer(el) {
  if (!el || isAdnotaElement(el)) return null;

  // Case 1: el itself is a flex/grid container — operate on its children.
  const ecs = getComputedStyle(el);
  const ed = ecs.display;
  if (ed === 'flex' || ed === 'inline-flex') return makeContainerInfo(el, ecs, 'flex');
  if (ed === 'grid' || ed === 'inline-grid') return makeContainerInfo(el, ecs, 'grid');

  // Case 2: el's immediate parent is flex/grid — operate on the parent.
  const parent = el.parentElement;
  if (!parent || parent === document.documentElement) return null;
  if (isAdnotaElement(parent)) return null;
  const pcs = getComputedStyle(parent);
  const pd = pcs.display;
  if (pd === 'flex' || pd === 'inline-flex') return makeContainerInfo(parent, pcs, 'flex');
  if (pd === 'grid' || pd === 'inline-grid') return makeContainerInfo(parent, pcs, 'grid');

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
  // Block-flow is intrinsically vertical, so set direction='column' so
  // every downstream consumer (nextOrderDirection sort axis, label flip)
  // works the same way as flex-column without needing kind-specific checks.
  const direction = kind === 'block' ? 'column' : (cs.flexDirection || 'row');
  return {
    el,
    kind,                             // 'flex' | 'grid' | 'block'
    direction,
    reversed: direction.includes('-reverse'),
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
  if (d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid') {
    const kind = (d === 'grid' || d === 'inline-grid') ? 'grid' : 'flex';
    return { container: makeContainerInfo(parent, pcs, kind), child: el };
  }
  // Block-flow fallback: enables DOM-reorder send-to-end/start when the
  // parent is a layout-significant block container with multiple visible
  // children. CSS verbs (flex-direction, order) don't apply here — the
  // commit path forks to commitDomReorder. Layout-significance gating
  // keeps inline tags / tiny wrappers from offering meaningless reorder.
  if (isLayoutSignificant(parent)) {
    const info = makeContainerInfo(parent, pcs, 'block');
    if (info.visibleChildren.length >= 2) {
      return { container: info, child: el };
    }
  }
  return null;
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
// the amber overlay preview). Anchored on selectedEl ONLY — REFLOW buttons
// require an explicit selection. Hovering alone doesn't enable them.
//
// Why selection-only: the buttons sit in the dock, far from the page
// element. During pure hover the user has no visual commitment to "this
// thing" until they mouse onto a button (and only then does the amber
// overlay flash). With selection, the dotted blue outline is a persistent
// "we're operating on this" cue, so by the time the user reaches the
// REFLOW button their target is unambiguous. Selection also stabilizes
// the target across the layout reflows the verbs themselves cause —
// hover bubble-up can otherwise drift to a different ancestor after a
// flex-direction flip changes element rect sizes.
function getReflowTarget(verb) {
  const anchorEl = selectedEl;
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
    // promises. Block-flow forks to DOM reorder because CSS `order` only
    // applies to flex/grid children; flex/grid stays on the cheaper, more
    // framework-safe stylesheet path.
    if (target.container.kind === 'block') {
      await commitDomReorder(target.el, target.container, target.direction);
    } else {
      const newOrder = orderValueForDirection(target.direction, target.container);
      await commitResizeRule(target.el, `order: ${newOrder} !important`, 'reflow:order-end');
    }
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
    // Block-flow direction is normalized to 'column' in makeContainerInfo,
    // so this single check covers flex-column AND block intrinsic-vertical.
    const isColumn = orderTarget.container.direction.startsWith('column');
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
    selectionChipCluster.style.top = `${chipClusterTopOffset(rect, true)}px`;
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

  // Drop every rule for this selector from the live map, then rebuild.
  for (const [id, rule] of window.AdnotaResizeRules) {
    if (rule.selector === selector) window.AdnotaResizeRules.delete(id);
  }
  rebuildResizeStyleTag();

  // Reorder rules key on sourceEl ref, not selector — walk the live Map and
  // unwind any rule whose source IS this element (or whose source resolves
  // to this element by anchor). Reverse the move via originalPrevAnchor and
  // detach the observer. Storage rows for matching reorders are dropped in
  // the storage-filter pass below alongside CSS rules.
  for (const [rid, rrule] of window.AdnotaReorderRules) {
    if (rrule.sourceEl !== el) continue;
    detachReorderGuard(rrule);
    try {
      if (rrule.originalPrevAnchor) {
        const m = window.FuzzyAnchor?.findMatch?.(rrule.originalPrevAnchor);
        if (m?.element && m.confidence >= REORDER_SOURCE_CONFIDENCE_MIN) {
          rrule.parentEl.insertBefore(rrule.sourceEl, m.element.nextElementSibling);
        }
      } else if (rrule.parentEl?.isConnected) {
        rrule.parentEl.insertBefore(rrule.sourceEl, firstNonAdnotaChild(rrule.parentEl));
      }
    } catch (_) {}
    window.AdnotaReorderRules.delete(rid);
  }

  // No inline-style cleanup here, by design. The resizer's persisted effects
  // live entirely in the `<style id="adnota-style-overrides">` tag; every
  // commit/cancel/nudge path already reverts its own inline writes via
  // restoreInline / restoreInlineSnapshot / the nudge cleanup. So at reset
  // time the inline `style` attribute is the page's own — anything that
  // looks like a resize prop on it (width/height/margin-left/top/position/
  // top-left-right-bottom/flex-*/overflow) is page-authored, not ours.
  //
  // A blanket inline removeProperty here can't distinguish provenance — it
  // would destroy page-authored inline styling whose property *happens* to
  // overlap something the resizer also writes (the canonical case: the page
  // sets `margin: 0 auto`, restoreInline correctly restores it, and we'd
  // then strip `margin-left:auto` and shift the element on reset). See the
  // `restoreInline` snapshot comment for the longhand-from-shorthand rationale.
  //
  // The only path this leaves uncovered is a drag that throws before its
  // restore runs — leaking a resizer inline value. That's a bug to fix at
  // its source (a try/finally on the commit critical sections) rather than
  // paper over destructively here.
  void el.offsetHeight; // force reflow against the now-empty style tag

  // Remove from storage — both CSS-keyed (selector match) and reorder-keyed
  // (sourceAnchor.cssSelector match, since reorder rows have no top-level
  // selector field).
  if (window.AdnotaStorage) {
    const data = await chrome.storage.local.get(domain);
    if (data[domain]) {
      data[domain].items = data[domain].items.filter(i => {
        if (i.action !== 'RESIZE') return true;
        if (!window.AdnotaStorage.matchesUrl(i, location.href)) return true;
        if (i.selector === selector) return false;
        if (i.kind === 'reflow:dom-reorder' && i.sourceAnchor?.cssSelector === selector) return false;
        return true;
      });
      await chrome.storage.local.set({ [domain]: data[domain] });
    }
  }

  // Remove any undo entries for this selector
  window.AdnotaUndo._stack = window.AdnotaUndo._stack.filter(
    entry => entry._resizeSelector !== selector
  );

  deselectElement();
}

// ─── Clip-chip state helpers ──────────────────────────────────────────────
// `match` is the result of AdnotaLayout.findGrowthOverflow — null when no
// growth blocker, or { kind, ancestor?, axis } when the live rect is being
// clipped (by an overflow:hidden ancestor) or capped (by max-width/max-height
// on the element itself). The chip is shared across both kinds; only the
// label / cursor / click action differ. See plan v2.

function clipMatchChanged(a, b) {
  if (a === b) return false;            // both null
  if (!a || !b) return true;            // one null, one set
  if (a.kind !== b.kind) return true;
  if (a.axis !== b.axis) return true;
  if (a.ancestor !== b.ancestor) return true;
  return false;
}

function applyClipChipState(match) {
  if (!selectionClipChip) return;
  if (!match) {
    selectionClipChip.style.display = 'none';
    syncStatusRowVisibility();
    return;
  }
  if (match.kind === 'clip-ancestor') {
    const verb = match.gesture === 'position' ? 'movement' : 'growth';
    selectionClipChip.textContent = 'Container clipping';
    selectionClipChip.setAttribute('data-adnota-tooltip',
      `Container is clipping ${verb} — click to resize parent instead`);
    selectionClipChip.removeAttribute('data-warn-only');
  } else {
    // size-cap — warn-only, no click action in v2.
    selectionClipChip.textContent = 'At max size';
    selectionClipChip.setAttribute('data-adnota-tooltip',
      'Element has hit its max-width/max-height — can\'t grow further on this axis');
    selectionClipChip.setAttribute('data-warn-only', '1');
  }
  selectionClipChip.style.display = '';
  syncStatusRowVisibility();
}


// ─── Lift-chip state helpers (Bring to front) ────────────────────────────────
// Surfaces during a position drag when an overlapping non-Adnota neighbor has
// a higher effective z-index than the dragged element. Scope is intentionally
// "elements we're touching" — sampling at the dragged rect's corners + center,
// gated by an area-overlap threshold so corner tooltips and focus rings don't
// trip the chip. Stacking-context boundaries can still foreclose the lift; we
// handle that empirically in performLift (re-check after commit, roll back if
// the occluder is still on top).

// Cap on candidates inspected per check. Deep portal stacks (Slack, Discord)
// can return many hits per point; cap keeps the loop bounded. Bumped from
// the old value when sample density increased — denser sampling sees more
// distinct candidates, so a tight cap would start dropping legitimate
// occluders on busy pages.
const OCCLUSION_MAX_SURVIVORS = 64;
// Sample grid spacing in CSS pixels. With the old 9-fixed-points layout,
// occluders ~30-150px (the canonical "small UI element" range — pills,
// favicons, badges, action buttons) often fell between samples and went
// undetected. 40px spacing guarantees any occluder ≥ 40×40 lands on at
// least one sample, and most 20-40px occluders land on one too because
// the grid offset doesn't align with their position.
const OCCLUSION_SAMPLE_SPACING_PX = 40;
// Hard cap on samples per axis (so the worst case for a viewport-filling
// selection is 24×24 = 576 elementsFromPoint calls — well under a frame
// budget given the motion gate at the call site).
const OCCLUSION_MAX_DIM_SAMPLES = 24;
// Minimum absolute pixel area an occluder must cover within the dragged
// element to qualify. Was previously a percentage of the dragged element's
// area, but that scaled the wrong way — a 3,000 px² occluder (e.g., Google's
// "View all" pill) was rejected on a tall sidebar tile (~0.4% of full area)
// even though it was visibly covering content the user wanted to lift above.
// An absolute pixel floor matches the actual question: "is this occluder
// big enough that lifting it would produce a visible change?" Below ~100 px²
// (10×10) the lift's visual effect is sub-pixel and the chip would feel
// broken if it surfaced; above that, the user has clear visible feedback
// either way. Filters focus rings, 1px borders, and shadow bleed; admits
// pills, badges, favicons, and small UI controls — exactly the things the
// "make any webpage yours" intent says users should be able to cover.
const OCCLUSION_MIN_AREA_PX = 100;
// Z-index cap. Some sites ship cookie banners at 2147483647 (max int);
// max + 1 would overflow / lose meaning. If we're already lifting near this
// ceiling, the element is effectively on the top layer — surface a distinct
// message instead of an invented bigger number.
const Z_LIFT_CEILING = 9999;

function _zIndexAsInt(el) {
  const z = getComputedStyle(el).zIndex;
  if (z === 'auto' || z === '') return 0;
  const n = parseInt(z, 10);
  return Number.isFinite(n) ? n : 0;
}

function findOcclusion(el) {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  // Clip the sampling rect to the viewport. Tall elements (sidebar widgets
  // dragged into the main column, infinite-scroll feeds) extend far past
  // the viewport; sampling the full rect concentrates valid points at the
  // visible top/bottom edges and misses occluders in the visible middle
  // band. Off-screen points can't be sampled anyway (elementsFromPoint
  // returns [] outside the viewport), and the visible portion is the only
  // thing competing for paint priority that the user can see right now.
  const vis = {
    left:   Math.max(rect.left,   0),
    top:    Math.max(rect.top,    0),
    right:  Math.min(rect.right,  window.innerWidth),
    bottom: Math.min(rect.bottom, window.innerHeight),
  };
  if (vis.right <= vis.left || vis.bottom <= vis.top) return null;

  // Skip elements where the entire visible portion can't even contain a
  // minimum-area occluder — no possible hit could pass the threshold below.
  const visW = vis.right - vis.left;
  const visH = vis.bottom - vis.top;
  if (visW * visH < OCCLUSION_MIN_AREA_PX) return null;

  // Grid of sample points spaced OCCLUSION_SAMPLE_SPACING_PX apart across
  // the visible rect, clamped to OCCLUSION_MAX_DIM_SAMPLES per axis. With
  // the old 9-fixed-points layout, occluders like Google's "View all" pill
  // or a Disney+ favicon fell between samples and went undetected — the
  // grid here guarantees coverage at small-UI scale.
  //
  // Corner-only sampling would fall apart on rounded elements — a card with
  // border-radius:16px has corner pixels inside the bounding rect but
  // OUTSIDE the painted area, so elementsFromPoint at those points doesn't
  // return the card. The interior grid sits safely inside the painted area
  // for any border-radius up to ~half the smaller dimension.
  const cols = Math.min(OCCLUSION_MAX_DIM_SAMPLES,
                        Math.max(3, Math.ceil(visW / OCCLUSION_SAMPLE_SPACING_PX)));
  const rows = Math.min(OCCLUSION_MAX_DIM_SAMPLES,
                        Math.max(3, Math.ceil(visH / OCCLUSION_SAMPLE_SPACING_PX)));
  // Inset by 1px (or less for tiny rects) so we sample the painted area,
  // not the bounding-rect corners that may be outside a rounded shape.
  const insetX = Math.min(1, visW / 4);
  const insetY = Math.min(1, visH / 4);
  const stepX = cols > 1 ? (visW - 2 * insetX) / (cols - 1) : 0;
  const stepY = rows > 1 ? (visH - 2 * insetY) / (rows - 1) : 0;
  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points.push([vis.left + insetX + c * stepX, vis.top + insetY + r * stepY]);
    }
  }

  const seen = new Set();
  let best = null;
  let bestZ = -Infinity;

  // Occlusion = "painted in front of el," which is exactly what
  // elementsFromPoint encodes: hits[0] is topmost, el sits somewhere in the
  // middle, anything BEFORE el's index is rendered above it at that point.
  // Comparing z-index alone misses the common case where a same-z (auto)
  // sibling paints over us via DOM order (later siblings stack on top), so
  // we use array-index order as the truth and only consult z-index to pick
  // the lift target. Area threshold weeds out tiny corner-clipping noise.
  for (const [x, y] of points) {
    // All points are within vis, which is itself within the viewport, so
    // the off-screen guard the old code needed here is no longer required.
    const hits = document.elementsFromPoint(x, y);
    const ourIdx = hits.indexOf(el);
    // If el isn't at this point (rounded-corner cutout, transformed beyond
    // bounds, etc.), the sample is unreliable — skip it. We still have 8
    // other points covering the rest of the rect.
    if (ourIdx < 0) continue;
    for (let i = 0; i < ourIdx; i++) {
      const hit = hits[i];
      if (seen.size >= OCCLUSION_MAX_SURVIVORS) break;
      if (!hit || hit === el) continue;
      if (el.contains(hit) || hit.contains(el)) continue;
      if (window.AdnotaUI?.isAdnotaElement(hit)) continue;
      if (seen.has(hit)) continue;
      seen.add(hit);

      const hRect = hit.getBoundingClientRect();
      const iw = Math.max(0, Math.min(hRect.right, rect.right) - Math.max(hRect.left, rect.left));
      const ih = Math.max(0, Math.min(hRect.bottom, rect.bottom) - Math.max(hRect.top, rect.top));
      const inter = iw * ih;
      if (inter < OCCLUSION_MIN_AREA_PX) continue;

      const hitZ = _zIndexAsInt(hit);
      if (hitZ > bestZ) { best = hit; bestZ = hitZ; }
    }
    if (seen.size >= OCCLUSION_MAX_SURVIVORS) break;
  }

  return best ? { maxZ: bestZ, top: best } : null;
}

function liftChipChanged(a, b) {
  if (a === b) return false;            // both null
  if (!a || !b) return true;            // one null, one set
  return a.top !== b.top;               // chip text doesn't depend on maxZ
}

function applyLiftChipState(match) {
  if (!selectionLiftChip) return;
  if (!match) {
    selectionLiftChip.style.display = 'none';
    return;
  }
  selectionLiftChip.textContent = 'Bring to front';
  selectionLiftChip.setAttribute(
    'data-adnota-tooltip',
    `Move above the overlapping ${match.top.tagName.toLowerCase()}`,
  );
  selectionLiftChip.style.display = '';
}

// Lift-chip click handler. The latched currentLiftMatch is only good for
// "should the chip exist" — by click time the page may have reflowed,
// scrolled, or mutated, so re-detect against fresh state before committing.
//
// Stacking-context boundaries can foreclose a z-index lift: if the dragged
// element's parent has a stacking context below the occluder's ancestor
// context, bumping our z-index does nothing. We don't try to reason about
// that statically; commit, re-check, roll back + toast on failure. The
// empirical check is the source of truth.
async function performLift(el) {
  if (!el) return;

  const fresh = findOcclusion(el);
  if (!fresh) {
    // Page moved out from under us between latch and click. Quietly hide
    // the chip — no toast (visible state didn't change, no user surprise).
    applyLiftChipState(null);
    currentLiftMatch = null;
    return;
  }

  if (fresh.maxZ >= Z_LIFT_CEILING) {
    // Sites that ship banners at max-int (2147483647) leave nowhere to go.
    // Distinct message from the stacking-context failure so the user knows
    // it's a ceiling, not a stacking-context defeat.
    window.AdnotaUI?.showToast(
      'This element is already on the page’s top layer',
      { timeout: 4000 }
    );
    return;
  }

  // Target needs to be (a) above the highest in-front occluder, AND (b) at
  // least 1 — z-index:0 still paints by DOM order against z:auto siblings,
  // so jumping to 1 is the floor that converts us into a positioned-with-
  // z-index element. Without this floor, lifting a z:auto card over a z:auto
  // mock that comes later in DOM order would compute target=1 already, but
  // a negative-z occluder (rare) would compute a non-positive target.
  const targetZ = Math.max(fresh.maxZ + 1, 1);

  // Defensive: position-drag commit already wrote position: relative|absolute|
  // fixed before this click became reachable, so computed position shouldn't
  // be 'static' here. Guard regardless — z-index does nothing on static
  // elements, and the cost of an extra `position: relative` line is nil.
  const needsPosition = getComputedStyle(el).position === 'static';
  const cssText = needsPosition
    ? `position: relative !important; z-index: ${targetZ} !important`
    : `z-index: ${targetZ} !important`;
  await commitResizeRule(el, cssText, 'z-lift');

  // Empirical re-check after the rebuilt style tag has rendered.
  requestAnimationFrame(() => {
    const recheck = findOcclusion(el);
    if (recheck && recheck.maxZ >= targetZ) {
      // Stacking-context blocked the lift. Surgically remove just our
      // z-lift rule and tell the user.
      removeResizeRule(el, 'z-lift');
      window.AdnotaUI?.showToast(
        `Couldn’t bring above ${recheck.top.tagName.toLowerCase()}`,
        { timeout: 4000 }
      );
    } else {
      // Success — the visible result is the feedback (element pops to
      // front). Hide chip and clear state; no success toast.
      applyLiftChipState(null);
      currentLiftMatch = null;
    }
  });
}


// ─── Position (body-drag to reposition) ─────────────────────────────────────
// Drag the body of a selected element to reposition it via injected CSS
// `top/left`. Drag a handle = resize (below). The two are mutually exclusive
// — handles attach their own pointerdown that runs first, and `dragAxis`
// truthiness gates re-entry.
//
// Layout-aware strategy dispatch (mirrors resize's per-kind strategies from
// layout-aware-v2):
//   - In-flow elements (static/relative/sticky): force position:relative +
//     compute a compensating top/left so the element doesn't visually jump
//     on pointerdown. Persisted rule writes `position: relative`. Element
//     re-enters flow; siblings may reflow but that's the gap-as-feature.
//   - Absolute elements: don't flip to relative (would collapse elements
//     that escape zero-size parent chains via absolute positioning — modal
//     dropdowns, autocomplete suggestions, etc.). Use cs.top/left or
//     offsetTop/Left as the starting offset; persist `position: absolute`.
//   - Fixed elements (without transformed ancestors): same offset math
//     against the viewport; persist `position: fixed`.
//   - Fixed elements inside a transformed ancestor: refused (the ancestor
//     becomes the containing block for fixed descendants, and the math to
//     handle that correctly is a v2 effort).
//
// No z-index is written for any kind: stacking during the drag is a
// faithful preview of where the element ends up on release.

// `transform`, `perspective`, `filter`, and certain `will-change` values
// create a new containing block for `position: fixed` descendants. We refuse
// those because computing CB-relative coordinates correctly across that
// boundary requires more math than v1 ships.
function hasTransformedAncestor(el) {
  let cur = el.parentElement;
  while (cur && cur !== document.documentElement) {
    const cs = getComputedStyle(cur);
    if (cs.transform !== 'none') return true;
    if (cs.perspective !== 'none') return true;
    if (cs.filter !== 'none') return true;
    if (cs.willChange && /transform|perspective|filter/.test(cs.willChange)) return true;
    cur = cur.parentElement;
  }
  return false;
}

// Returns either { kind: 'relative' | 'absolute' | 'fixed' } when the element
// can be position-dragged, or { error: <reason> } when it can't. The reason
// strings double as classification — useful for logging or surfacing in
// future diagnostic UI.
function getPositionStrategy(el) {
  if (!el || !el.isConnected) return { error: 'not-connected' };
  if (el === document.body || el === document.documentElement) return { error: 'page-root' };
  const ctx = el._adnotaLayoutContext || getLayoutContext(el);
  if (ctx?.kind === 'table-component') return { error: 'table-component' };
  if (window.AdnotaUI.dominatesViewport(el.getBoundingClientRect())) return { error: 'viewport-dominator' };

  const cs = getComputedStyle(el);
  if (cs.position === 'absolute') return { kind: 'absolute' };
  if (cs.position === 'fixed') {
    if (hasTransformedAncestor(el)) return { error: 'fixed-in-transformed-ancestor' };
    return { kind: 'fixed' };
  }
  // static / relative / sticky → in-flow strategy
  return { kind: 'relative' };
}

function isPositionable(el) {
  return !getPositionStrategy(el).error;
}

// Cursor override for the positionable element AND its descendants. The
// global cursor lock (highlighter.js setCursorLock) targets every non-Adnota
// element via a universal selector at !important — that means descendants of
// the selected element are matched directly and don't inherit our inline
// `cursor: move` from the parent. We work around it with a dedicated style
// tag re-appended on every selection so cascade order wins on the
// (0,0,2,0) specificity tie against the lock.
function ensurePositionCursorStyle() {
  let tag = document.getElementById('adnota-position-cursor');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'adnota-position-cursor';
    tag.setAttribute('data-adnota-ui', '1');
    tag.textContent =
      '[data-adnota-positionable]:not([data-adnota-positionable=""]),' +
      '[data-adnota-positionable]:not([data-adnota-positionable=""]) *' +
      '{ cursor: move !important; }';
  }
  // Re-append to move the tag to the end of <head>. Same-specificity ties
  // against the cursor-lock are broken by cascade order, so being last wins.
  document.head.appendChild(tag);
}

function onBodyDragStart(e) {
  if (e.button !== 0) return;
  if (window.AdnotaUI.isAdnotaElement(e.target)) return;
  if (dragAxis) return;
  if (!isPositionable(selectedEl)) return;
  startPositionDrag(e);
}

async function persistPosition(el, x, y, posType = 'relative', dims = null) {
  let cssText =
    `position: ${posType} !important; ` +
    `top: ${Math.round(y)}px !important; ` +
    `left: ${Math.round(x)}px !important; ` +
    `right: auto !important; bottom: auto !important`;
  // Pin width/height when the element was sized via stretch-anchoring
  // (left+right or top+bottom). Without these, nullifying right/bottom on
  // commit would collapse the element — e.g., a `nav { left:0; right:0 }`
  // that we drop to `right: auto` shrinks to its content width. Pinning
  // preserves the dimensions the user saw at drag time. Only set when the
  // strategy detected the anchor-stretch case (dims is null otherwise).
  if (dims) {
    if (dims.width  != null) cssText += `; width: ${Math.round(dims.width)}px !important`;
    if (dims.height != null) cssText += `; height: ${Math.round(dims.height)}px !important`;
  }
  return commitResizeRule(el, cssText, 'position');
}

function startPositionDrag(e) {
  e.preventDefault();
  e.stopPropagation();
  if (!selectedEl) return;

  // Capture the dragged element in a closure-local. `selectedEl` is module-
  // scope and can be nulled mid-drag (Esc exits resizer mode, click-outside
  // paths run deselectElement, etc.). The drag handlers below — onMove,
  // onUp, restoreInlineSnapshot — all need to operate on the element we
  // grabbed at drag-start, not on whatever `selectedEl` happens to be when
  // the next mouse event fires. Without this, mid-drag deselect crashes
  // `.style` access on null and leaves the element stuck in its inline
  // drag styles.
  const el = selectedEl;

  // Strategy dispatch — choose drag math based on the element's computed
  // position. In-flow elements get the force-relative + compensate-offset
  // dance; absolute/fixed elements keep their position type and use raw
  // CB-relative offsets. See getPositionStrategy + the section header
  // comment above for the full rationale.
  const strategy = getPositionStrategy(el);
  if (strategy.error) return;
  const posType = strategy.kind;                 // 'relative' | 'absolute' | 'fixed'
  const isOutOfFlow = posType === 'absolute' || posType === 'fixed';

  dragAxis = 'position';
  dragStartX = e.clientX;
  dragStartY = e.clientY;

  // Clear any latched clip-chip from a prior gesture so this drag re-evaluates
  // from scratch. (Selection-change paths already clear via deselectElement;
  // this catches resize → position on the same element.)
  if (currentClipMatch) {
    applyClipChipState(null);
    currentClipMatch = null;
  }
  // Same for any latched lift-chip from a prior position drag — fresh drag
  // re-detects from scratch (driven by movement, not selection).
  if (currentLiftMatch) {
    applyLiftChipState(null);
    currentLiftMatch = null;
  }
  lastOcclusionCheckRect = null;

  // Pre-compute the clip-ancestor list once so the rAF onMove only does the
  // per-frame rect compare. Mirrors the resize-drag snapshot at startDrag.
  // Position never trips the size-cap branch (translation doesn't change
  // width/height), so sizeCaps/fillModeRisk are deliberately omitted — the
  // detector returns null for those when the fields are absent.
  const posClipSnapshot = {
    clipAncestors: window.AdnotaLayout?.detectClippingAncestors(el) || [],
  };

  // Snapshot inline state with priority. After the first commit, a persisted
  // `<style>` rule exists for this selector with top/left/position/right/
  // bottom all at !important. To override that during the drag we must write
  // inline with !important too — non-!important writes silently lose to the
  // rule, leaving the element glued to its persisted position while the
  // cursor moves (felt as lag). Snapshot priority so we can restore exactly.
  // width/height are included because the out-of-flow branch may pin them
  // when the element is stretch-anchored.
  const POS_PROPS = ['top', 'left', 'right', 'bottom', 'position', 'width', 'height'];
  const inlineSnapshot = {};
  for (const p of POS_PROPS) {
    inlineSnapshot[p] = {
      value:    el.style.getPropertyValue(p),
      priority: el.style.getPropertyPriority(p),
    };
  }

  // Compute starting top/left in CB coordinates per strategy.
  let startLeft, startTop;
  // For out-of-flow elements sized via anchor-stretch (page set both
  // left+right or both top+bottom to size the element to fill its CB),
  // pin the current visual dimensions before nullifying right/bottom — and
  // pass them to persistPosition so they make it into the persisted rule.
  // Without this, a fixed nav with `left:0; right:0` collapses to its
  // content width the moment we drop the right anchor.
  let pinnedDims = null;
  if (isOutOfFlow) {
    // Out-of-flow: keep the element's position type. Read current top/left
    // from computed style if numeric; otherwise derive an equivalent from
    // offsetTop/Left (absolute) or boundingClientRect (fixed without
    // transformed ancestor — viewport IS the CB). We always switch to
    // top/left positioning on commit, so right/bottom must be cleared to
    // 'auto' to defeat any authored right/bottom rule pulling in the
    // opposite direction.
    const cs = getComputedStyle(el);
    const csLeft = parseFloat(cs.left);
    const csTop  = parseFloat(cs.top);
    if (posType === 'absolute') {
      startLeft = isFinite(csLeft) ? csLeft : el.offsetLeft;
      startTop  = isFinite(csTop)  ? csTop  : el.offsetTop;
    } else {
      const rect = el.getBoundingClientRect();
      startLeft = isFinite(csLeft) ? csLeft : rect.left;
      startTop  = isFinite(csTop)  ? csTop  : rect.top;
    }
    // Detect stretch-anchored sizing. If the page set both left+right (or
    // top+bottom) to non-auto, the element's width (or height) is the
    // resolved difference and would collapse when we drop the opposing
    // anchor. Pin the current rect dimension inline + remember to persist.
    const rect = el.getBoundingClientRect();
    const widthAnchored  = (cs.left   !== 'auto' && cs.right  !== 'auto');
    const heightAnchored = (cs.top    !== 'auto' && cs.bottom !== 'auto');
    pinnedDims = (widthAnchored || heightAnchored) ? {} : null;
    if (widthAnchored)  pinnedDims.width  = rect.width;
    if (heightAnchored) pinnedDims.height = rect.height;
    if (widthAnchored)  el.style.setProperty('width',  rect.width  + 'px', 'important');
    if (heightAnchored) el.style.setProperty('height', rect.height + 'px', 'important');
    el.style.setProperty('position', posType,           'important');
    el.style.setProperty('right',    'auto',            'important');
    el.style.setProperty('bottom',   'auto',            'important');
    el.style.setProperty('left',     startLeft + 'px',  'important');
    el.style.setProperty('top',      startTop  + 'px',  'important');
  } else {
    // In-flow: force position: relative + clear all offsets so we can
    // measure the element's natural in-flow position. Load-bearing for
    // sticky AND for any selector that already has a persisted position
    // rule — `auto` alone wouldn't beat the rule's `Xpx !important`.
    const grabbedRect = el.getBoundingClientRect();
    el.style.setProperty('position', 'relative', 'important');
    el.style.setProperty('top',      'auto',     'important');
    el.style.setProperty('left',     'auto',     'important');
    el.style.setProperty('right',    'auto',     'important');
    el.style.setProperty('bottom',   'auto',     'important');
    const naturalRect = el.getBoundingClientRect();
    // Compensating offset so the element stays at the grabbed position
    // visually. For static / relative-no-offset: 0,0. For relative-with-
    // offset (including a previously-persisted position rule): re-
    // establishes the active offset. For sticky: bridges threshold coords
    // to in-flow + offset.
    startLeft = grabbedRect.left - naturalRect.left;
    startTop  = grabbedRect.top  - naturalRect.top;
    el.style.setProperty('left', startLeft + 'px', 'important');
    el.style.setProperty('top',  startTop  + 'px', 'important');
  }

  // Fullscreen capture overlay so the mouse can travel anywhere without
  // hitting page event handlers mid-drag (mirrors resize drag's pattern).
  const dragOverlay = document.createElement('div');
  dragOverlay.setAttribute('data-adnota-ui', '1');
  Object.assign(dragOverlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    cursor: 'move',
    background: 'transparent',
  });
  document.documentElement.appendChild(dragOverlay);

  function restoreInlineSnapshot() {
    if (!el.isConnected) return;
    for (const p of POS_PROPS) {
      const snap = inlineSnapshot[p];
      if (snap.value) {
        el.style.setProperty(p, snap.value, snap.priority);
      } else {
        el.style.removeProperty(p);
      }
    }
  }

  // rAF-throttle the drag to coalesce mousemove events into one paint per
  // frame. Without this, each mousemove triggered layout invalidation (style
  // write) plus sync layout reads (getBoundingClientRect + getComputedStyle
  // inside the chip/HUD/reflow updaters fired by refreshHandles). On heavy
  // pages — especially long floated ancestors — that cascade made the drag
  // preview feel jumpy. We sample the latest pointer position on every
  // mousemove but only commit visual updates on rAF.
  //
  // Geometry-only refresh: chip/HUD/reflow state is invariant during a
  // position drag (selection didn't change, sticky/finite/parent-flex status
  // didn't change, dimensions didn't change). Skip the full refreshHandles
  // and do them once on release in onUp.
  let rafPending = false;
  let pendingDx = 0;
  let pendingDy = 0;

  function onMove(ev) {
    pendingDx = ev.clientX - dragStartX;
    pendingDy = ev.clientY - dragStartY;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (dragAxis !== 'position') return;   // drag ended before this rAF
      if (!el.isConnected) return;           // element gone mid-drag — bail
      // !important required to beat the persisted rule once one exists
      // (after first commit). Non-!important writes lose silently and the
      // element appears glued to its persisted position while the cursor
      // moves — that's the "second drag is laggy" failure mode.
      el.style.setProperty('left', (startLeft + pendingDx) + 'px', 'important');
      el.style.setProperty('top',  (startTop  + pendingDy) + 'px', 'important');
      const rect = el.getBoundingClientRect();
      const sy = window.pageYOffset || document.documentElement.scrollTop;
      const sx = window.pageXOffset || document.documentElement.scrollLeft;
      if (selectionBox) positionBox(selectionBox, rect, sx, sy);
      if (handleLeft)   positionHandleLeft(handleLeft, rect, sx, sy);
      if (handleRight)  positionHandleRight(handleRight, rect, sx, sy);
      if (handleTop)    positionHandleTop(handleTop, rect, sx, sy);
      if (handleBottom) positionHandleBottom(handleBottom, rect, sx, sy);
      if (handleCorner) positionHandleCorner(handleCorner, rect, sx, sy);
      if (dismissBtn)   positionDismiss(dismissBtn, rect, sx, sy);
      if (selectionChipCluster) {
        selectionChipCluster.style.top = `${chipClusterTopOffset(rect, true)}px`;
      }

      // Lift-chip occlusion check, motion-gated. Skipping the elementsFromPoint
      // sweep on frames where the rect barely moved keeps the drag cheap on
      // heavy pages without time-based throttling (which would add visible chip
      // latency at the start of a drag burst).
      const movedFar = !lastOcclusionCheckRect ||
        Math.abs(rect.left - lastOcclusionCheckRect.left) > 5 ||
        Math.abs(rect.top  - lastOcclusionCheckRect.top)  > 5;
      if (movedFar) {
        lastOcclusionCheckRect = { left: rect.left, top: rect.top };
        const match = findOcclusion(el);
        if (liftChipChanged(match, currentLiftMatch)) {
          applyLiftChipState(match);
          currentLiftMatch = match;
        }
      }

      // Clip-ancestor detection — same detector the resize-drag rAF uses.
      // Here it fires when the translated rect leaves a clipping ancestor's
      // padding box. Tagged gesture='position' so the chip tooltip reads
      // "movement" instead of "growth"; dedup via clipMatchChanged means we
      // only touch the DOM when the match flips (no every-frame writes).
      const clipMatch = window.AdnotaLayout?.findGrowthOverflow(el, posClipSnapshot) || null;
      if (clipMatch) clipMatch.gesture = 'position';
      if (clipMatchChanged(clipMatch, currentClipMatch)) {
        applyClipChipState(clipMatch);
        currentClipMatch = clipMatch;
      }
    });
  }

  function onUp(ev) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    dragOverlay.remove();

    const dx = ev.clientX - dragStartX;
    const dy = ev.clientY - dragStartY;

    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
      restoreInlineSnapshot();
      dragAxis = null;
      // Tiny-drag cancel — drop any lift/clip chip that surfaced mid-drag.
      // Position didn't actually change, so don't leave warning affordances
      // dangling against a nominally-no-op gesture.
      if (currentLiftMatch) {
        applyLiftChipState(null);
        currentLiftMatch = null;
      }
      if (currentClipMatch) {
        applyClipChipState(null);
        currentClipMatch = null;
      }
      lastOcclusionCheckRect = null;
      return;
    }

    const finalLeft = startLeft + dx;
    const finalTop  = startTop  + dy;

    // Order: persist FIRST so the !important rule is in the style tag, THEN
    // clear inline so the rule wins cleanly. Inverting this briefly leaves
    // the element with neither inline nor persisted offsets and produces a
    // visible flash back to natural position. Pass posType so absolute /
    // fixed elements don't get demoted to relative on commit, and
    // pinnedDims so anchor-stretch elements keep their dimensions.
    persistPosition(el, finalLeft, finalTop, posType, pinnedDims);
    restoreInlineSnapshot();

    dragAxis = null;
    refreshHandles();   // full refresh on release: chip/HUD/reflow re-sync

    // currentLiftMatch intentionally NOT cleared here — if it's truthy on the
    // final frame, the "Bring to front" chip stays latched (visible) so its
    // click handler can fire post-release. Cleared by selection change, mode
    // exit, the next position drag, or performLift's success/failure path.
    // Same dance as currentClipMatch in the resize-drag onUp.
    lastOcclusionCheckRect = null;
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Arrow-key nudge — bound at module load. Active only when resizer mode is
// on, an element is selected, and no drag is in progress. First keydown of a
// burst applies the same force-relative + compensate-offset dance as drag-
// start so sticky/fixed elements get correct live preview through nudges.
// 300ms debounce coalesces a key burst into one storage row + one undo step.
let positionNudgeDebounce = null;
let positionNudgeStartLeft = 0;
let positionNudgeStartTop  = 0;
let positionNudgeActive    = false;

function cancelPendingNudge() {
  if (positionNudgeDebounce) clearTimeout(positionNudgeDebounce);
  positionNudgeDebounce = null;
  positionNudgeActive = false;
}

// Track which strategy this burst started under, so the debounced commit
// persists the right position type. (Reset on every fresh burst.)
let positionNudgePosType = 'relative';
let positionNudgePinnedDims = null;   // anchor-stretch dims to persist (out-of-flow only)

window.addEventListener('keydown', (e) => {
  if (window.AdnotaState?.mode !== 'resizer') return;
  if (!selectedEl || dragAxis) return;
  const strategy = getPositionStrategy(selectedEl);
  if (strategy.error) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const delta = { ArrowUp: [0,-1], ArrowDown: [0,1], ArrowLeft: [-1,0], ArrowRight: [1,0] }[e.key];
  if (!delta) return;
  e.preventDefault();
  e.stopPropagation();
  const step = e.shiftKey ? 10 : 1;

  if (!positionNudgeActive) {
    // Same strategy dispatch as startPositionDrag — in-flow does the
    // force-relative + compensate-offset dance; out-of-flow keeps its
    // position type and uses CB-relative offsets so absolute/fixed
    // elements (modals, dropdowns, sticky chat) nudge correctly.
    positionNudgePosType = strategy.kind;
    positionNudgePinnedDims = null;
    const isOutOfFlow = strategy.kind === 'absolute' || strategy.kind === 'fixed';
    if (isOutOfFlow) {
      const cs = getComputedStyle(selectedEl);
      const csLeft = parseFloat(cs.left);
      const csTop  = parseFloat(cs.top);
      if (strategy.kind === 'absolute') {
        positionNudgeStartLeft = isFinite(csLeft) ? csLeft : selectedEl.offsetLeft;
        positionNudgeStartTop  = isFinite(csTop)  ? csTop  : selectedEl.offsetTop;
      } else {
        const rect = selectedEl.getBoundingClientRect();
        positionNudgeStartLeft = isFinite(csLeft) ? csLeft : rect.left;
        positionNudgeStartTop  = isFinite(csTop)  ? csTop  : rect.top;
      }
      // Stretch-anchor detection (mirrors startPositionDrag). If width or
      // height comes from left+right or top+bottom, pin them so they
      // survive the right:auto / bottom:auto we're about to write.
      const rect2 = selectedEl.getBoundingClientRect();
      const widthAnchored  = (cs.left !== 'auto' && cs.right  !== 'auto');
      const heightAnchored = (cs.top  !== 'auto' && cs.bottom !== 'auto');
      if (widthAnchored || heightAnchored) {
        positionNudgePinnedDims = {};
        if (widthAnchored)  positionNudgePinnedDims.width  = rect2.width;
        if (heightAnchored) positionNudgePinnedDims.height = rect2.height;
        if (widthAnchored)  selectedEl.style.setProperty('width',  rect2.width  + 'px', 'important');
        if (heightAnchored) selectedEl.style.setProperty('height', rect2.height + 'px', 'important');
      }
      selectedEl.style.setProperty('position', strategy.kind, 'important');
      selectedEl.style.setProperty('right',    'auto',        'important');
      selectedEl.style.setProperty('bottom',   'auto',        'important');
    } else {
      const grabbedRect = selectedEl.getBoundingClientRect();
      // !important needed to override any persisted position rule from a
      // prior drag/nudge — same reason as startPositionDrag.
      selectedEl.style.setProperty('position', 'relative', 'important');
      selectedEl.style.setProperty('top',      'auto',     'important');
      selectedEl.style.setProperty('left',     'auto',     'important');
      selectedEl.style.setProperty('right',    'auto',     'important');
      selectedEl.style.setProperty('bottom',   'auto',     'important');
      const naturalRect = selectedEl.getBoundingClientRect();
      positionNudgeStartLeft = grabbedRect.left - naturalRect.left;
      positionNudgeStartTop  = grabbedRect.top  - naturalRect.top;
    }
    positionNudgeActive = true;
  }

  positionNudgeStartLeft += delta[0] * step;
  positionNudgeStartTop  += delta[1] * step;
  selectedEl.style.setProperty('left', positionNudgeStartLeft + 'px', 'important');
  selectedEl.style.setProperty('top',  positionNudgeStartTop  + 'px', 'important');
  refreshHandles();

  // Capture el + final values + posType + pinnedDims now — selectedEl could
  // be cleared during the 300ms window if the user deselects mid-burst.
  const elAtNudge   = selectedEl;
  const posAtNudge  = positionNudgePosType;
  const dimsAtNudge = positionNudgePinnedDims;
  const finalLeft   = positionNudgeStartLeft;
  const finalTop    = positionNudgeStartTop;

  if (positionNudgeDebounce) clearTimeout(positionNudgeDebounce);
  positionNudgeDebounce = setTimeout(() => {
    positionNudgeDebounce = null;
    positionNudgeActive = false;
    if (!elAtNudge.isConnected) return;
    persistPosition(elAtNudge, finalLeft, finalTop, posAtNudge, dimsAtNudge);
    elAtNudge.style.removeProperty('left');
    elAtNudge.style.removeProperty('top');
    elAtNudge.style.removeProperty('right');
    elAtNudge.style.removeProperty('bottom');
    elAtNudge.style.removeProperty('position');
    if (dimsAtNudge) {
      if (dimsAtNudge.width  != null) elAtNudge.style.removeProperty('width');
      if (dimsAtNudge.height != null) elAtNudge.style.removeProperty('height');
    }
  }, 300);
}, true);

// ─── Text size (Aa+/Aa−) ────────────────────────────────────────────────────
// Bump the selected element's body-text size via a persisted RESIZE rule with
// `kind: 'text-size'`. The rule generator (rebuildResizeStyleTag) special-
// cases this kind to expand the selector at render time so the cssText also
// hits common prose-bearing descendants (p / li / blockquote / etc.) — that
// solves the "13px body text" failure mode where literal font-size on the
// container alone wouldn't override descendants with their own authored sizes.
//
// Headings (h1-h6), form controls, code (pre/code + their highlighter spans),
// sub/sup/small, and arbitrary divs are intentionally NOT in the cascade —
// their typography hierarchy / monospace relationship / form affordances stay
// intact. Acknowledged trade-off: prose written directly in <div> without
// <p> wrapping (Tailwind utility-CSS sites) won't scale on outer-container
// click; users can click an inner element directly for those cases.
//
// Also forces line-height: 1.5 to prevent cramping on sites with px-valued
// line-heights — without it, scaling 14px → 24px against a fixed 18px line-
// height collapses lines into overlapping text.

function isScalable(el) {
  if (!el || !el.isConnected) return false;
  if (el === document.body || el === document.documentElement) return false;
  const ctx = el._adnotaLayoutContext || getLayoutContext(el);
  if (ctx?.kind === 'table-component') return false;
  return true;
}

// Returns the current effective text size in px. Prefer the persisted rule's
// value (the active size after our override landed); fall back to the
// element's computed font-size for the first-ever click.
function currentTextSizePx(el, selector) {
  for (const [, r] of window.AdnotaResizeRules) {
    if (r.selector === selector && r.kind === 'text-size') {
      const m = /font-size:\s*([\d.]+)px/.exec(r.cssText);
      if (m) return parseFloat(m[1]);
    }
  }
  return parseFloat(getComputedStyle(el).fontSize) || 16;
}

async function persistTextSize(el, px) {
  const clamped = Math.max(8, Math.min(96, Math.round(px)));
  const cssText =
    `font-size: ${clamped}px !important; ` +
    `line-height: 1.5 !important`;
  return commitResizeRule(el, cssText, 'text-size');
}

function bumpTextSize(el, direction, big) {
  if (!isScalable(el)) return;
  const selector = generateCSSSelector(el);
  const current = currentTextSizePx(el, selector);
  const factor = big ? 1.25 : 1.10;
  const next = direction === 'up' ? current * factor : current / factor;
  persistTextSize(el, next);
  fireTextSizeTipOnce();
}

// Synchronous lock alongside the async write — prevents a rapid click-burst
// from racing past the storage flag check and firing the toast multiple times.
let _textSizeTipFired = false;
function fireTextSizeTipOnce() {
  if (_textSizeTipFired) return;
  _textSizeTipFired = true;
  const KEY = 'adnotaTextSizeTipShown';
  chrome.storage.local.get(KEY).then((data) => {
    if (data[KEY]) return;
    chrome.storage.local.set({ [KEY]: true });
    window.AdnotaUI?.showToast(
      'Tip: Aa+/Aa− to scale this section\'s body text · Shift+click for bigger steps · ↺ to reset.',
      { id: 'adnota-text-size-tip', timeout: 5000 }
    );
  }).catch(() => { /* context invalidated after extension reload */ });
}

// ─── Recolor helpers (background + text via EyeDropper) ─────────────────────
// Two chips, two kinds: 'recolor-bg' (element-only, no descendant cascade,
// since CSS background-color doesn't inherit) and 'recolor-text' (expands to
// the same prose-cascade list as text-size — see ruleSelectorFor — so authored
// `color` on <p>/<li>/etc. gets overridden). Links are deliberately NOT in
// the cascade so they stay visually distinguishable for navigation.

function isRecolorable(el) {
  if (!el || !el.isConnected) return false;
  if (el === document.body || el === document.documentElement) return false;
  // Only truly non-paintable cases excluded. Recolor was previously gated
  // on getLayoutContext's 'table-component' kind, but that predicate
  // exists for the *resize* affordance — it filters elements whose
  // width/height are ignored by their layout context (inline, table-row,
  // table-cell, display:contents, etc). Recolor uses background-color
  // and color, which paint fine on inline elements (<span>, <em>, <svg>
  // — the Google-logo case that prompted this) and on table-* elements.
  // The only cases where painting truly can't happen are display:none
  // (no rendering at all) and display:contents (no box of its own —
  // children render but the element itself doesn't).
  const display = getComputedStyle(el).display;
  if (display === 'none' || display === 'contents') return false;
  return true;
}

async function persistRecolor(el, which, hex) {
  const prop = which === 'bg' ? 'background-color' : 'color';
  const kind = which === 'bg' ? 'recolor-bg' : 'recolor-text';
  const cssText = `${prop}: ${hex} !important`;
  return commitResizeRule(el, cssText, kind);
}

// Single-flight guard. EyeDropper has no programmatic cancel API; once
// open, only a pick or Escape resolves it. If the user clicks a recolor
// chip while a previous dropper is mid-await, Chrome promotes the new
// EyeDropper to active and the old one is orphaned — its promise never
// resolves, and Chrome's magnifier-circle UI for it stays visible until
// the tab is reloaded.
let _dropperOpen = false;

async function pickColorAndApply(el, which) {
  if (_dropperOpen) return;
  if (!isRecolorable(el)) return;
  if (typeof window.EyeDropper !== 'function') {
    window.AdnotaUI?.showToast('Eyedropper requires Chrome 95+');
    return;
  }
  _dropperOpen = true;
  try {
    const dropper = new window.EyeDropper();
    const result = await dropper.open();
    if (result?.sRGBHex) {
      await persistRecolor(el, which, result.sRGBHex);
      fireRecolorTipOnce();
    }
  } catch {
    // User cancelled the picker — no-op.
  } finally {
    _dropperOpen = false;
  }
}

let _recolorTipFired = false;
function fireRecolorTipOnce() {
  if (_recolorTipFired) return;
  _recolorTipFired = true;
  const KEY = 'adnotaRecolorTipShown';
  chrome.storage.local.get(KEY).then((data) => {
    if (data[KEY]) return;
    chrome.storage.local.set({ [KEY]: true });
    window.AdnotaUI?.showToast(
      'Tip: Pick any color from this page or another tab · ↺ to reset.',
      { id: 'adnota-recolor-tip', timeout: 5000 }
    );
  }).catch(() => { /* context invalidated after extension reload */ });
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

  // Layout-aware growth-blocker detection. detectClippingAncestors walks up
  // looking for overflow:hidden|clip ancestors that would silently mask growth;
  // detectSizeCaps reads the element's own max-width/max-height. Both cached
  // here so onMove just compares the live rect against pre-computed boundaries.
  // Fresh drag clears any latched chip from a prior gesture before recompute.
  if (selectionClipChip) selectionClipChip.style.display = 'none';
  currentClipMatch = null;
  snapshot.clipAncestors = window.AdnotaLayout?.detectClippingAncestors(selectedEl) || [];
  snapshot.sizeCaps = window.AdnotaLayout?.detectSizeCaps(selectedEl) || null;
  // Fill-mode risk: when the selected subtree contains an absolutely-
  // positioned replaced element with min/max-100% on both axes (Next.js
  // <Image fill>, Gatsby gatsby-image, etc.), our X-axis writes that
  // clear min-width:0 and max-width:none expose the descendant's
  // intrinsic aspect ratio. Without an upper bound on the dragged axis
  // — and on the non-dragged axis — height (or width) runs away to
  // match the source image's intrinsic dimensions. Strategy reads this
  // flag and keeps both axes hard-bounded through the drag and in the
  // persisted rule.
  snapshot.fillModeRisk = window.AdnotaLayout?.detectFillModeRisk(selectedEl) || false;

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

  // Shift+drag on the corner handle constrains to aspect ratio (Photoshop /
  // Figma / Sketch convention). Only applies to the corner ('xy') axis —
  // single-axis drags don't have a ratio to maintain. Snapshot the start
  // ratio once so the constraint stays stable even if intermediate strategy
  // applies subtly drift the live rect.
  const startAspect = snapshot.startHeight > 0
    ? snapshot.startWidth / snapshot.startHeight
    : 1;
  function constrainToAspect(dx, dy) {
    if (Math.abs(dx) / startAspect > Math.abs(dy)) {
      return [dx, Math.sign(dy || 1) * Math.abs(dx) / startAspect];
    }
    return [Math.sign(dx || 1) * Math.abs(dy) * startAspect, dy];
  }

  // rAF-throttle the resize drag onMove. Each mousemove triggers a style
  // write (strategy.applyDuringDrag), a forced layout to read the new rect
  // (refreshHandles), and another sync read for findGrowthOverflow. On
  // heavy pages with floated ancestors or huge documents (mamagourmand.com
  // 27k tall) that round-trip can exceed 16ms, so without coalescing we
  // drop frames and the handles visibly lag the cursor. Same shape as
  // startPositionDrag's rAF: sample the latest pointer on every mousemove,
  // commit visuals on rAF.
  let rafPending = false;
  let pendingShift = false;
  let pendingX = 0;
  let pendingY = 0;
  function onMove(ev) {
    pendingX = ev.clientX;
    pendingY = ev.clientY;
    pendingShift = !!ev.shiftKey;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (dragAxis !== axis) return;   // drag ended before this rAF
      let dx = pendingX - dragStartX;
      let dy = pendingY - dragStartY;
      if (axis === 'xy' && pendingShift) {
        [dx, dy] = constrainToAspect(dx, dy);
      }
      strategy.applyDuringDrag(selectedEl, axis, dx, dy, snapshot);
      refreshHandles();

      // Layout-aware: check for silent growth blockers and toggle the warning
      // chip. Gated on match change (kind + ancestor + axis) so we only touch
      // the DOM when something flipped — every-frame style writes are wasted
      // work on the common no-blocker path.
      const match = window.AdnotaLayout?.findGrowthOverflow(selectedEl, snapshot) || null;
      if (clipMatchChanged(match, currentClipMatch)) {
        applyClipChipState(match);
        currentClipMatch = match;
      }
    });
  }

  function onUp(ev) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    dragOverlay.remove();

    let dx = ev.clientX - dragStartX;
    let dy = ev.clientY - dragStartY;
    if (axis === 'xy' && ev.shiftKey) {
      [dx, dy] = constrainToAspect(dx, dy);
    }

    // Only persist if the user actually dragged (not just a click on a handle)
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
      restoreInline();
      dragAxis = null;
      // Tiny-drag cancel — also clear any chip that toggled mid-aborted drag.
      if (currentClipMatch) {
        applyClipChipState(null);
        currentClipMatch = null;
      }
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
    // currentClipMatch intentionally NOT cleared here. If it's truthy on
    // the final frame, the chip stays latched (visible) so its click handler
    // can fire post-release. Cleared by selection change, mode exit, or the
    // next startDrag. See plan: yes-tidy-ladybug.md → "Click lifecycle".
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
// Known kinds: 'position', 'unstick', 'finite-scroll', 'text-size', 'recolor-bg',
// 'recolor-text', 'reflow:swap-panels', 'reflow:toggle-stack', 'reflow:order-end',
// 'reflow:dom-reorder', 'z-lift' (Bring-to-front lift on overlapping higher-z
// neighbors). All kind-bearing commits coexist on the same selector with
// orthogonal cssText; same-kind replays dedup via the loop below.
//
// Resizes default to site-wide (`path: '*'`). Unlike the eraser — where
// site-wide is an explicit user override (Shift+Click) or silent ad-scope
// promotion — resize targets are almost always structural containers (nav,
// sidebar, header, article wrapper) that recur across a site with the same
// selector. Scoping to just the current page would force the user to redo
// the same change on every sibling page. If the selector falls back to a
// structural `nth-child` path and matches something unintended on another
// page, the rule silently no-ops (worst case: reset from that page).
//
// Exception: domains in lib/urlScopeRegistry.js (e.g. google.com — where
// web and image search share `/search` but render under different layouts)
// save with a scope key like `scope:google-web` instead of `'*'`, so a
// rule made on web search doesn't bleed into image search.
// AdnotaStorage.pathForSave centralizes the resolution.
async function commitResizeRule(el, cssText, kind) {
  const selector = generateCSSSelector(el);
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  // De-dup: kind-bearing commits replace any prior rule with the same
  // selector + same kind. Without this, 17 toggle-stack clicks produce
  // 17 entries when only the last matters — bloating storage,
  // scratchpad rows, and the undo stack.
  //
  // Drag-resize (no kind) uses property-superset dedup: drop a prior
  // no-kind rule on the same selector if the new commit's cssText
  // covers all of its properties. This collapses repeated drags on the
  // same axis/handle into one rule, while preserving rules from
  // *different* axes (drag X then Y stays additive — Y's props don't
  // cover X's). Corner drags subsume both because their cssText
  // touches both width-side and height-side props.
  const supersededLive = [];

  // Cross-kind subsume: position is a strict superset of unstick (its cssText
  // sets the same `position: relative` plus explicit top/left/right/bottom).
  // Drop any unstick row for this selector before the regular dedup loop;
  // the existing supersededLive walk in the undo callback restores it on
  // Ctrl+Z, and the storage-side filter (lines below) propagates the drop
  // to disk via the supersededIds path.
  if (kind === 'position') {
    for (const [oldId, oldRule] of window.AdnotaResizeRules) {
      if (oldRule.selector !== selector) continue;
      if (oldRule.kind === 'unstick') {
        supersededLive.push({ id: oldId, ...oldRule });
        window.AdnotaResizeRules.delete(oldId);
      }
    }
  }

  const newProps = !kind ? cssTextProps(cssText) : null;
  for (const [oldId, oldRule] of window.AdnotaResizeRules) {
    if (oldRule.selector !== selector) continue;
    let supersede = false;
    if (kind) {
      supersede = oldRule.kind === kind;
    } else {
      // No-kind path: only dedup against other no-kind rules. Don't
      // touch kind-bearing rules (unstick / finite-scroll / reflow:*)
      // — those have orthogonal lifecycles.
      if (oldRule.kind) continue;
      const oldProps = cssTextProps(oldRule.cssText);
      supersede = isPropsSuperset(newProps, oldProps);
    }
    if (supersede) {
      supersededLive.push({ id: oldId, ...oldRule });
      window.AdnotaResizeRules.delete(oldId);
    }
  }

  window.AdnotaLog?.event('resizer', kind ? `${kind}-commit` : 'resize-commit', {
    id, sel: selector, el: window.AdnotaLog.el(el),
    handle: dragAxis, cssText,
    superseded: supersededLive.length || undefined,
  });

  window.AdnotaResizeRules.set(id, { selector, cssText, kind });
  rebuildResizeStyleTag();

  const domain = location.hostname;
  const path = window.AdnotaStorage?.pathForSave(location.href) ?? '*';

  const entry = {
    action: 'RESIZE',
    selector,
    cssText,
    _id: id,
    path,
    version: 1,
    timestamp: Date.now(),
    // sourceUrl captures the full URL where the rule was created. RESIZE
    // is typically site-wide (path: '*') — or a curated scope key like
    // `scope:google-web` for domains in urlScopeRegistry — so the Sites
    // page has no exact path to link to on its own; sourceUrl gives a
    // clickable "made here" anchor back to the original context. Sites
    // page falls back to the bare hostname for rules saved before this
    // field existed.
    sourceUrl: location.href,
  };
  if (kind) entry.kind = kind;

  // Snapshot the storage rows we're about to drop so undo can restore
  // exactly what was there. Captured outside the storage block so the
  // closure below doesn't depend on async-fetched state.
  const supersededStorage = [];

  if (window.AdnotaStorage) {
    const data = await chrome.storage.local.get(domain);
    const domainData = data[domain] || { items: [] };
    const supersededIds = new Set(supersededLive.map(r => r.id));
    // Two-tier storage filter:
    //   1. Drop rows whose _id matches a superseded live rule (the
    //      authoritative path).
    //   2. Belt-and-suspenders: also drop rows that this commit
    //      semantically supersedes by selector + kind / props-superset,
    //      even if they weren't in our live Map. Catches stale storage
    //      from before dedup was active and any read-write race in
    //      chrome.storage. Same logic as the live-Map loop above,
    //      applied to disk.
    domainData.items = domainData.items.filter(item => {
      if (item.action !== 'RESIZE') return true;
      if (supersededIds.has(item._id)) {
        supersededStorage.push({ ...item });
        return false;
      }
      if (item.selector !== selector) return true;
      let supersede = false;
      if (kind) {
        supersede = item.kind === kind;
      } else {
        if (item.kind) return true;
        const itemProps = cssTextProps(item.cssText);
        supersede = isPropsSuperset(newProps, itemProps);
      }
      if (supersede) {
        supersededStorage.push({ ...item });
        return false;
      }
      return true;
    });
    domainData.items.push(entry);
    await chrome.storage.local.set({ [domain]: domainData });
  }

  // ── Undo ─────────────────────────────────────────────────────────────────
  // Removes the new rule AND restores any superseded rules — Ctrl+Z walks
  // back to the prior state, not to the original natural layout. Multi-step
  // history is preserved at the kind level: each undo flips back one step.
  const undoEntry = {
    _resizeSelector: selector,
    undo: async () => {
      window.AdnotaLog?.event('resizer', 'undo', {
        id, sel: selector,
        restored: supersededLive.length || undefined,
      });
      window.AdnotaResizeRules.delete(id);
      for (const r of supersededLive) {
        window.AdnotaResizeRules.set(r.id, { selector: r.selector, cssText: r.cssText, kind: r.kind });
      }
      rebuildResizeStyleTag();

      // Force a reflow so the browser re-computes layout against the
      // updated stylesheet immediately — no refresh needed.
      const target = document.querySelector(selector);
      if (target) void target.offsetHeight;

      if (window.AdnotaStorage) {
        const data = await chrome.storage.local.get(domain);
        if (data[domain]) {
          data[domain].items = data[domain].items.filter(i => i._id !== id);
          for (const r of supersededStorage) data[domain].items.push(r);
          await chrome.storage.local.set({ [domain]: data[domain] });
        }
      }
      window.AdnotaUndo.remove(undoEntry);
      refreshHandles();
      updateReflowButtonStates();
    },
  };
  window.AdnotaUndo.push(undoEntry);
  // Stash a back-pointer from the live rule to its undo entry so callers like
  // performLift's failure path can rescind specifically THIS commit's undo
  // instead of popping AdnotaUndo's top (fragile if another commit raced in).
  const liveRule = window.AdnotaResizeRules.get(id);
  if (liveRule) liveRule._undoEntry = undoEntry;
  updateReflowButtonStates();
  return id;
}

// ─── Surgical rule removal (for empirical-fail rollbacks) ────────────────────
// Mirrors the rule-removal half of commitResizeRule's undo closure but takes a
// specific (element, kind) pair instead of popping the global undo stack. Used
// by the lift-chip empirical re-check: if the z-index commit didn't actually
// uncross a stacking context, we want to remove just OUR rule and leave the
// rest of the undo history untouched. Same-kind dedup guarantees at most one
// rule matches.
async function removeResizeRule(el, kind) {
  if (!el || !kind) return;
  const selector = generateCSSSelector(el);
  let removedId = null;
  let undoEntry = null;
  for (const [id, rule] of window.AdnotaResizeRules) {
    if (rule.selector === selector && rule.kind === kind) {
      removedId = id;
      undoEntry = rule._undoEntry || null;
      window.AdnotaResizeRules.delete(id);
      break;
    }
  }
  if (!removedId) return;
  rebuildResizeStyleTag();

  // Force reflow so the dropped rule's effects unwind immediately.
  if (el.isConnected) void el.offsetHeight;

  if (window.AdnotaStorage) {
    const domain = location.hostname;
    const data = await chrome.storage.local.get(domain);
    if (data[domain]) {
      data[domain].items = (data[domain].items || []).filter(i => i._id !== removedId);
      await chrome.storage.local.set({ [domain]: data[domain] });
    }
  }
  if (undoEntry) window.AdnotaUndo.remove(undoEntry);

  window.AdnotaLog?.event('resizer', `${kind}-rollback`, {
    id: removedId, sel: selector, el: window.AdnotaLog?.el?.(el),
  });
  refreshHandles();
  updateReflowButtonStates();
}

// Drag-resize commit: thin wrapper over commitResizeRule with no `kind`.
async function persistResize(el, cssText) {
  await commitResizeRule(el, cssText);
}

// ─── Overflow chip: apply the clip / scrollbar override ─────────────────────
// `value` is 'hidden' (clip — cut off the spillover) or 'auto' (scrollbar —
// keep it reachable). Stored with kind:'overflow'; commitResizeRule's
// same-kind dedup means the two values can't coexist — picking one replaces
// the other in place. removeResizeRule(el, 'overflow') is the inverse (back
// to the page's own overflow), and ↺ reset clears it like every other kind.
async function applyOverflowRule(el, value) {
  await commitResizeRule(el, `overflow: ${value} !important`, 'overflow');
}

// ─── REFLOW v1.5: DOM-reorder for block-flow pages ──────────────────────────
// CSS `order` only applies to flex/grid children, so block-flow pages need a
// physical DOM move (parent.appendChild / insertBefore) to reorder. The move
// itself is cheap, but it has to survive: (a) page reload (replay via
// FuzzyAnchor in restorer), (b) framework reconciliation (per-rule
// MutationObserver re-asserts the move, capped at REORDER_GUARD_MAX_FIGHTS),
// and (c) parent unmount (validateReorderRules piggybacks on the restorer's
// existing debounced pass to re-resolve via parentAnchor when the cached
// parentEl becomes detached).
//
// Storage shape mirrors RESIZE so scratchpad coexistence is automatic, but
// the rule lives in its own runtime Map (AdnotaReorderRules) — distinct
// from AdnotaResizeRules because reorder rules don't produce CSS and must
// not flow through rebuildResizeStyleTag.
window.AdnotaReorderRules = new Map();   // id → live rule record

const REORDER_GUARD_MAX_FIGHTS = 10;
const REORDER_PARENT_CONFIDENCE_MIN = 60;  // higher than the 40 used for content
const REORDER_SOURCE_CONFIDENCE_MIN = 40;
const _reorderGiveUpToasted = new Set();   // session-scoped; one toast per source

function previousNonAdnotaSibling(el) {
  let cur = el.previousElementSibling;
  while (cur && isAdnotaElement(cur)) cur = cur.previousElementSibling;
  return cur;
}

function firstNonAdnotaChild(parent) {
  let cur = parent.firstElementChild;
  while (cur && isAdnotaElement(cur)) cur = cur.nextElementSibling;
  return cur;
}

function lastNonAdnotaChild(parent) {
  let cur = parent.lastElementChild;
  while (cur && isAdnotaElement(cur)) cur = cur.previousElementSibling;
  return cur;
}

function applyReorderMove(source, parent, toPosition) {
  if (toPosition === 'first') {
    parent.insertBefore(source, firstNonAdnotaChild(parent));
  } else {
    parent.appendChild(source);
  }
}

function positionMatchesIntent(rule) {
  const { parentEl, sourceEl, toPosition } = rule;
  if (sourceEl.parentElement !== parentEl) return false;
  if (toPosition === 'first') return firstNonAdnotaChild(parentEl) === sourceEl;
  return lastNonAdnotaChild(parentEl) === sourceEl;
}

// Per-rule observer. Watches direct-child mutations on parentEl. When the
// framework moves source out of position, re-applies our move. Caps fights
// to prevent infinite loops with frameworks that diff aggressively. Re-
// resolves sourceEl via FuzzyAnchor if the framework replaced the node
// entirely (zombie ref) — fighting a stale ref produces a flicker war that
// burns through the fight cap to no effect.
function attachReorderGuard(rule) {
  const obs = new MutationObserver(() => {
    if (rule.fights >= REORDER_GUARD_MAX_FIGHTS) {
      obs.disconnect();
      rule.observer = null;
      window.AdnotaLog?.event('resizer', 'reorder-guard-gave-up', {
        sel: rule.sourceAnchor?.cssSelector,
      });
      const key = rule.sourceAnchor?.cssSelector || '?';
      if (!_reorderGiveUpToasted.has(key)) {
        _reorderGiveUpToasted.add(key);
        window.AdnotaUI?.showToast?.(
          "Couldn't keep this in place — reverted and removed.",
          { id: 'adnota-reorder-giveup-toast', timeout: 4000 }
        );
      }
      // Revert the move + drop from Map + storage. Without this, the page
      // is left in an unstable state (whichever side won the last fight)
      // and the storage entry persists into the next reload where it'll
      // lose the fight again — same toast, same failure, same bad UX. By
      // reverting on give-up, the failure is honest: original layout is
      // back, entry is gone, no phantom rules dragging on reloads.
      revertReorderRule(rule);
      return;
    }
    if (!rule.sourceEl?.isConnected) {
      const m = window.FuzzyAnchor?.findMatch?.(rule.sourceAnchor);
      if (m?.element && m.confidence >= REORDER_SOURCE_CONFIDENCE_MIN) rule.sourceEl = m.element;
      else return;
    }
    if (positionMatchesIntent(rule)) return;
    rule.fights++;
    applyReorderMove(rule.sourceEl, rule.parentEl, rule.toPosition);
  });
  obs.observe(rule.parentEl, { childList: true, subtree: false });
  rule.observer = obs;
}

// Used by attachReorderGuard's give-up path. Moves source back to its
// original previous-sibling position (or first-child if it had none),
// drops the rule from the live Map, and removes the storage entry. Async
// because the storage write is async; observer callback doesn't await it.
async function revertReorderRule(rule) {
  try {
    if (rule.originalPrevAnchor) {
      const m = window.FuzzyAnchor?.findMatch?.(rule.originalPrevAnchor);
      if (m?.element && m.confidence >= REORDER_SOURCE_CONFIDENCE_MIN
          && rule.parentEl?.isConnected && rule.sourceEl?.isConnected) {
        rule.parentEl.insertBefore(rule.sourceEl, m.element.nextElementSibling);
      }
    } else if (rule.parentEl?.isConnected && rule.sourceEl?.isConnected) {
      rule.parentEl.insertBefore(rule.sourceEl, firstNonAdnotaChild(rule.parentEl));
    }
  } catch (_) {}

  // Drop from live Map. rule.id is set at construction time (commit + restore
  // + applyOneReorder); falls back to ref-equality search if missing.
  if (rule.id && window.AdnotaReorderRules?.has(rule.id)) {
    window.AdnotaReorderRules.delete(rule.id);
  } else {
    for (const [oid, r] of window.AdnotaReorderRules || []) {
      if (r === rule) { window.AdnotaReorderRules.delete(oid); break; }
    }
  }

  // Drop from storage so reload doesn't replay a rule that already lost.
  if (window.AdnotaStorage && rule.id) {
    try {
      const domain = location.hostname;
      const data = await chrome.storage.local.get(domain);
      if (data[domain]) {
        data[domain].items = data[domain].items.filter(i => i._id !== rule.id);
        await chrome.storage.local.set({ [domain]: data[domain] });
      }
    } catch (_) {}
  }

  try { updateReflowButtonStates(); } catch (_) {}
  try { refreshHandles?.(); } catch (_) {}
  window.AdnotaLog?.event('resizer', 'reorder-reverted-on-giveup', {
    id: rule.id, sel: rule.sourceAnchor?.cssSelector,
  });
}

function detachReorderGuard(rule) {
  if (rule.observer) { rule.observer.disconnect(); rule.observer = null; }
}

// Catches the parent-unmount case the per-rule observer can't see: if the
// framework replaces parentEl above our subtree, our observer is attached
// to a detached node and fires nothing. Restorer calls this on its
// debounced mutation pass.
function validateReorderRules() {
  for (const [, rule] of window.AdnotaReorderRules) {
    if (rule.parentEl?.isConnected) continue;
    const pm = window.FuzzyAnchor?.findMatch?.(rule.parentAnchor);
    if (!pm?.element || pm.confidence < REORDER_PARENT_CONFIDENCE_MIN) continue;
    detachReorderGuard(rule);
    rule.parentEl = pm.element;
    if (!rule.sourceEl?.isConnected) {
      const sm = window.FuzzyAnchor?.findMatch?.(rule.sourceAnchor);
      if (!sm?.element || sm.confidence < REORDER_SOURCE_CONFIDENCE_MIN) continue;
      rule.sourceEl = sm.element;
    }
    rule.fights = 0;   // new parent gets a fresh fight budget
    applyReorderMove(rule.sourceEl, rule.parentEl, rule.toPosition);
    attachReorderGuard(rule);
    window.AdnotaLog?.event('resizer', 'reorder-parent-revalidated', {
      sel: rule.sourceAnchor?.cssSelector,
    });
  }
}

// Reorder commit. Mirrors commitResizeRule's dedup/storage/undo shape but
// keys on FuzzyAnchor instead of selector since DOM-moved entries don't
// have a stable selector after the move.
async function commitDomReorder(source, container, direction) {
  const parent = container.el;
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const toPosition = direction === 'start' ? 'first' : 'last';
  const label = `→ moved to ${direction} of parent`;

  const originalPrev = previousNonAdnotaSibling(source);
  const sourceAnchor = window.FuzzyAnchor.generate(source);
  const parentAnchor = window.FuzzyAnchor.generate(parent);
  const originalPrevAnchor = originalPrev ? window.FuzzyAnchor.generate(originalPrev) : null;

  // Live-Map dedup: identity by sourceEl ref. AdnotaReorderRules holds only
  // reorder rules, so no kind check is needed (and adding one would just be
  // a footgun if a code path forgot to stamp the field).
  const supersededLive = [];
  for (const [oldId, oldRule] of window.AdnotaReorderRules) {
    if (oldRule.sourceEl === source) {
      supersededLive.push({ id: oldId, ...oldRule });
      detachReorderGuard(oldRule);
      window.AdnotaReorderRules.delete(oldId);
    }
  }

  applyReorderMove(source, parent, toPosition);

  const liveRule = {
    id,                            // self-reference so observer give-up can revert + delete
    sourceEl: source, parentEl: parent,
    sourceAnchor, parentAnchor, originalPrevAnchor, toPosition,
    observer: null, fights: 0,
  };
  window.AdnotaReorderRules.set(id, liveRule);
  attachReorderGuard(liveRule);

  window.AdnotaLog?.event('resizer', 'reflow-dom-reorder-commit', {
    id, sel: sourceAnchor?.cssSelector, toPosition,
    superseded: supersededLive.length || undefined,
  });

  const domain = location.hostname;
  const path = window.AdnotaStorage?.pathForSave(location.href) ?? '*';
  const entry = {
    action: 'RESIZE', kind: 'reflow:dom-reorder',
    parentAnchor, sourceAnchor, originalPrevAnchor, toPosition,
    label,
    _id: id, path, version: 1, timestamp: Date.now(),
    sourceUrl: location.href,  // see commitResizeRule for rationale
  };

  // Storage dedup: drop prior reorder rows whose sourceAnchor.cssSelector
  // matches before pushing the new entry. Snapshot for undo so a Ctrl+Z
  // restores the prior state, not the natural DOM order. Mirrors the
  // selector+kind dedup in commitResizeRule but keyed on FuzzyAnchor since
  // reorder entries don't have a top-level `selector` field.
  // Storage dedup: drop only the rows whose `_id` is in supersededLive
  // (keyed by live sourceEl ref, the authoritative identity). An earlier
  // version also matched on sourceAnchor.cssSelector for cross-session
  // stale-row cleanup, but FuzzyAnchor can produce identical structural
  // selectors for genuinely different elements (sibling articles with
  // class-only selectors), so selector-based dedup risks erasing a valid
  // rule for element A when committing a new rule for element B. Stale
  // storage rows that failed to restore are silent dead weight, not
  // active harm — they can be cleared via scratchpad trash.
  const supersededStorage = [];
  if (window.AdnotaStorage) {
    const data = await chrome.storage.local.get(domain);
    const domainData = data[domain] || { items: [] };
    const supersededIds = new Set(supersededLive.map(r => r.id));
    domainData.items = domainData.items.filter(item => {
      if (supersededIds.has(item._id)) {
        supersededStorage.push({ ...item });
        return false;
      }
      return true;
    });
    domainData.items.push(entry);
    await chrome.storage.local.set({ [domain]: domainData });
  }

  // Undo: detach guard, reverse our move via originalPrevAnchor, drop from
  // Map + storage, restore any superseded rules. Each superseded restore
  // is wrapped because the page can mutate between commit and undo and
  // older anchors may no longer resolve cleanly.
  const undoEntry = {
    _resizeSelector: sourceAnchor?.cssSelector,
    undo: async () => {
      window.AdnotaLog?.event('resizer', 'undo', { id, kind: 'reflow:dom-reorder' });
      detachReorderGuard(liveRule);
      try {
        if (originalPrevAnchor) {
          const m = window.FuzzyAnchor?.findMatch?.(originalPrevAnchor);
          if (m?.element && m.confidence >= REORDER_SOURCE_CONFIDENCE_MIN) {
            parent.insertBefore(source, m.element.nextElementSibling);
          } else {
            window.AdnotaLog?.event('resizer', 'reorder-undo-degraded', { id });
          }
        } else {
          parent.insertBefore(source, firstNonAdnotaChild(parent));
        }
      } catch (_) {
        window.AdnotaLog?.event('resizer', 'reorder-undo-failed', { id });
      }
      window.AdnotaReorderRules.delete(id);
      if (window.AdnotaStorage) {
        const data = await chrome.storage.local.get(domain);
        if (data[domain]) {
          data[domain].items = data[domain].items.filter(i => i._id !== id);
          for (const r of supersededStorage) data[domain].items.push(r);
          await chrome.storage.local.set({ [domain]: data[domain] });
        }
      }
      // Restore superseded live rules. Each in its own try — a page that
      // mutated mid-session may have made the older anchors unresolvable.
      for (const r of supersededLive) {
        try {
          const restored = {
            id: r.id,                            // so a future give-up can revert by id
            sourceEl: r.sourceEl, parentEl: r.parentEl,
            sourceAnchor: r.sourceAnchor, parentAnchor: r.parentAnchor,
            originalPrevAnchor: r.originalPrevAnchor,
            toPosition: r.toPosition,
            observer: null, fights: 0,
          };
          if (restored.sourceEl?.isConnected && restored.parentEl?.isConnected) {
            applyReorderMove(restored.sourceEl, restored.parentEl, restored.toPosition);
            attachReorderGuard(restored);
            window.AdnotaReorderRules.set(r.id, restored);
          }
        } catch (_) {
          window.AdnotaLog?.event('resizer', 'superseded-restore-failed', { id: r.id });
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

// Scratchpad trash → reverse the move + drop from Map. Mirrors removeOneResize
// but operates on AdnotaReorderRules.
function removeOneReorder(id) {
  const rule = window.AdnotaReorderRules?.get(id);
  if (!rule) return;
  detachReorderGuard(rule);
  try {
    if (rule.originalPrevAnchor) {
      const m = window.FuzzyAnchor?.findMatch?.(rule.originalPrevAnchor);
      if (m?.element && m.confidence >= REORDER_SOURCE_CONFIDENCE_MIN) {
        rule.parentEl.insertBefore(rule.sourceEl, m.element.nextElementSibling);
      }
    } else if (rule.parentEl?.isConnected && rule.sourceEl?.isConnected) {
      rule.parentEl.insertBefore(rule.sourceEl, firstNonAdnotaChild(rule.parentEl));
    }
  } catch (_) {}
  window.AdnotaReorderRules.delete(id);
  try { refreshHandles?.(); } catch (_) {}
  window.AdnotaLog?.event('resizer', 'reorder-remove-one', { id });
}

// Scratchpad undo of a trashed entry → re-apply the move from a storage
// record. Mirrors applyOneResize.
function applyOneReorder(record) {
  if (!record || record.kind !== 'reflow:dom-reorder') return;
  const id = record._id;
  if (!id || !window.AdnotaReorderRules) return;
  const pm = window.FuzzyAnchor?.findMatch?.(record.parentAnchor);
  const sm = window.FuzzyAnchor?.findMatch?.(record.sourceAnchor);
  if (!pm?.element || pm.confidence < REORDER_PARENT_CONFIDENCE_MIN) return;
  if (!sm?.element || sm.confidence < REORDER_SOURCE_CONFIDENCE_MIN) return;
  const liveRule = {
    id,
    sourceEl: sm.element, parentEl: pm.element,
    sourceAnchor: record.sourceAnchor,
    parentAnchor: record.parentAnchor,
    originalPrevAnchor: record.originalPrevAnchor,
    toPosition: record.toPosition,
    observer: null, fights: 0,
  };
  applyReorderMove(liveRule.sourceEl, liveRule.parentEl, liveRule.toPosition);
  attachReorderGuard(liveRule);
  window.AdnotaReorderRules.set(id, liveRule);
  window.AdnotaLog?.event('resizer', 'reorder-apply-one', { id });
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
  // Cursor is anywhere on our dock chrome — preserve hover state. Without
  // this, mouse-over-dock clears hoveredEl, which (in pure-hover mode) hides
  // the REFLOW row, which shrinks the dock width, which can move the dock
  // out from under the cursor, which fires another mousemove that re-enables
  // REFLOW… an infinite flicker loop along the dock's edge. Subsumes the
  // earlier reflowRow.contains carve-out — the whole dock is a "hover hold"
  // zone since the user is interacting with our UI, not the page.
  const dockEl = document.getElementById('adnota-dock');
  if (raw && dockEl && dockEl.contains(raw)) return;
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
    //   - Position rule already applied -> hidden (redundant; would partially
    //     undo the user's move)
    //   - Naturally static and no override -> no chip
    const unstickOverridden = hasUnstickOverride(selector);
    const positionOverridden = hasPositionOverride(selector);
    if (positionOverridden) {
      hoveredHasUnstickOverride = false;
      actionChip.style.display = 'none';
    } else if (cs.position === 'sticky' || cs.position === 'fixed') {
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
  // Propagate `kind` so de-dup on subsequent commits can match against
  // restored rules (e.g., a stored toggle-stack survives reload, then a
  // new toggle-stack click should replace it, not stack on top).
  window.AdnotaResizeRules.set(id, { selector, cssText, kind: record.kind });
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
  // DOM-reorder (v1.5) — exposed so restorer can replay rules and
  // scratchpad trash can clean them up.
  removeOneReorder,
  applyOneReorder,
  applyReorderMove,
  attachReorderGuard,
  detachReorderGuard,
  validateReorderRules,
});

})();
