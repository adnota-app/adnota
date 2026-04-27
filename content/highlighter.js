// content/highlighter.js

// Setup CSS Highlight Registry (Requires Chrome 105+)
const highlightRegistries = {
  'adnota-theme-yellow': new Highlight(),
  'adnota-theme-green': new Highlight(),
  'adnota-theme-blue': new Highlight(),
  'adnota-theme-pink': new Highlight(),
  'adnota-theme-black': new Highlight()
};

if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
  for (const [theme, highlightObj] of Object.entries(highlightRegistries)) {
    CSS.highlights.set(theme, highlightObj);
  }
}

// ── SVG icon paths ──────────────────────────────────────────────────────────
const toolIcons = {
  select:    '<path d="M6 2l0 13 3.5-3.5 3 5 2-1-3-5 4.5-.5z" fill="currentColor" stroke="none"/>',
  pencil:    '<path d="M3 15l0 2 2 0L14 8l-2-2L3 15z"/><path d="M12 6l2-2 2 2-2 2z"/>',
  highlight: '<path d="M14.5 2.5a2.12 2.12 0 0 1 3 3L13 10l-3-3 4.5-4.5zM9 8l3 3-5 5H4v-3l5-5z" fill="currentColor" stroke="none"/>',
  arrow:     '<path d="M5 15L15 5"/><path d="M15 5H9M15 5v6"/>',
  rect:      '<rect x="4" y="4" width="12" height="12" rx="1"/>',
  ellipse:   '<circle cx="10" cy="10" r="6"/>',
  text:      '<path d="M6 5h8M6 5v2M14 5v2M10 5v10M8 15h4"/>',
  // Outline variant: hollow square + red diagonal slash to visually distinguish
  // "no fill" from the rectangle tool icon itself.
  fillOutline: '<rect x="4" y="4" width="12" height="12" rx="1"/><line class="adnota-outline-slash" x1="4" y1="16" x2="16" y2="4"/>',
  // Solid variant: filled square (fill painted via dedicated CSS to defeat the
  // global .adnota-tool-btn svg { fill: none } rule).
  fillSolid: '<rect class="adnota-fill-solid-rect" x="4" y="4" width="12" height="12" rx="1"/>',
  eyedropper: '<path d="M12 6l1-1a1.5 1.5 0 012 2l-1 1Z" fill="currentColor"/><path d="M11 5l4 4M12 6L6 12l-2 3 1 1 3-2L14 8"/>',
};

// ── Toolbar helpers ─────────────────────────────────────────────────────────
function svgIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.innerHTML = toolIcons[name];
  return svg;
}

function makeToolBtn(name, title, mode) {
  const btn = document.createElement('div');
  btn.className = 'adnota-tool-btn';
  btn.dataset.tool = mode;
  btn.setAttribute('data-tooltip', title);
  btn.appendChild(svgIcon(name));
  btn.onclick = (e) => {
    e.stopPropagation();
    window.AdnotaState.set({ mode: window.AdnotaState.mode === mode ? null : mode });
  };
  return btn;
}

// ── Create Toolbar UI ───────────────────────────────────────────────────────
// Dock body — mounts into AdnotaDock when a drawing-family mode is active.
// The dock owns drag handle + V logo + tool row; we own tools + swatches +
// stroke widths + fill toggle + trash + undo.
const highlightToolbar = document.createElement('div');
highlightToolbar.style.display = 'inline-flex';
highlightToolbar.style.alignItems = 'center';

// Tool buttons — drawing sub-tools are all "pen-family" modes that share the SVG overlay
const drawingModes = ['pen', 'highlight', 'arrow', 'rect', 'ellipse', 'text', 'select'];
const toolLabels = { pen: 'Pencil', highlight: 'Highlight', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Circle', text: 'Text', select: 'Select' };
const toolIconMap = { pen: 'pencil', highlight: 'highlight', arrow: 'arrow', rect: 'rect', ellipse: 'ellipse', text: 'text', select: 'select' };
const toolBtns = {};

// select goes first.
// 'highlight' is intentionally omitted from the toolbar — the quick-highlight
// popup (content/quickHighlight.js) covers text highlighting with tag support,
// which the toolbar button doesn't have. The mode itself, keyboard shortcut,
// and rendering codepath are all preserved in case we bring the button back;
// remove the rest of the highlight-mode plumbing if we decide to drop it.
for (const mode of ['select', 'pen', 'arrow', 'rect', 'ellipse', 'text']) {
  const btn = makeToolBtn(toolIconMap[mode], toolLabels[mode], mode);
  toolBtns[mode] = btn;
  highlightToolbar.appendChild(btn);
}

// Divider
highlightToolbar.appendChild(Object.assign(document.createElement('div'), { className: 'adnota-toolbar-divider' }));

// ── Fill group — outline / solid radio pair, shown only in rect/ellipse modes.
// Placed right after the shape tool buttons so the option surfaces next to
// the tool that triggered it.
function makeFillBtn({ iconKey, cls, title, filled }) {
  const btn = document.createElement('div');
  btn.className = `adnota-tool-btn ${cls}`;
  btn.setAttribute('data-tooltip', title);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.innerHTML = toolIcons[iconKey];
  btn.appendChild(svg);
  btn.onclick = (e) => {
    e.stopPropagation();
    window.AdnotaState.set({ filled });
  };
  return btn;
}
const fillOutlineBtn = makeFillBtn({
  iconKey: 'fillOutline', cls: 'adnota-fill-outline-btn', title: 'Outline', filled: false,
});
const fillSolidBtn = makeFillBtn({
  iconKey: 'fillSolid', cls: 'adnota-fill-solid-btn', title: 'Solid fill', filled: true,
});
const fillGroupDivider = Object.assign(document.createElement('div'), { className: 'adnota-toolbar-divider' });
const fillGroupEls = [fillOutlineBtn, fillSolidBtn, fillGroupDivider];
highlightToolbar.appendChild(fillOutlineBtn);
highlightToolbar.appendChild(fillSolidBtn);
highlightToolbar.appendChild(fillGroupDivider);

// Color swatches
const themes = {
  'adnota-theme-yellow': 'rgb(255, 235, 59)',
  'adnota-theme-green': 'rgb(76, 175, 80)',
  'adnota-theme-blue': 'rgb(33, 150, 243)',
  'adnota-theme-pink': 'rgb(233, 30, 99)',
  'adnota-theme-black': '#111'
};

function resolvePaintColor(c) {
  if (typeof c === 'string' && (c.startsWith('#') || c.startsWith('rgb'))) return c;
  return themes[c] || themes['adnota-theme-yellow'];
}

// ── Eyedropper swatch — doubles as current-color indicator and picker. Its
// background always mirrors the current paint color; clicking opens the native
// EyeDropper API (Chrome 95+) to pick a new one. Sits to the LEFT of the
// palette with dividers on both sides so it reads as its own control, not a
// sixth swatch. For highlights, custom hex routes through the fallback overlay
// renderer since CSS Custom Highlights need pre-registered theme names.
const eyedropperSwatch = document.createElement('div');
eyedropperSwatch.className = 'adnota-color-swatch adnota-eyedropper-swatch';
eyedropperSwatch.setAttribute('data-tooltip', 'Current color — click to pick any color from the page');
const eyeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
eyeSvg.setAttribute('viewBox', '0 0 20 20');
eyeSvg.innerHTML = toolIcons.eyedropper;
eyedropperSwatch.appendChild(eyeSvg);
eyedropperSwatch.onclick = async (e) => {
  e.stopPropagation();
  if (typeof window.EyeDropper !== 'function') {
    window.AdnotaUI.showToast('Eyedropper requires Chrome 95+');
    return;
  }
  try {
    const dropper = new window.EyeDropper();
    const result = await dropper.open();
    if (result?.sRGBHex) {
      window.AdnotaState.set({ color: result.sRGBHex });
    }
  } catch (err) {
    // User cancelled picker — no-op.
  }
};
highlightToolbar.appendChild(eyedropperSwatch);

// Divider between eyedropper (current-color control) and the palette.
highlightToolbar.appendChild(Object.assign(document.createElement('div'), { className: 'adnota-toolbar-divider' }));

const swatches = {};
for (const [themeClass, colorHex] of Object.entries(themes)) {
  const swatch = document.createElement('div');
  swatch.className = 'adnota-color-swatch';
  swatch.style.backgroundColor = colorHex;
  if (themeClass === 'adnota-theme-black') {
    swatch.setAttribute('data-tooltip', 'Redact');
  } else {
    let tooltipName = themeClass.replace('adnota-theme-', '');
    tooltipName = tooltipName.charAt(0).toUpperCase() + tooltipName.slice(1);
    swatch.setAttribute('data-tooltip', tooltipName);
  }
  swatch.onclick = (e) => {
    e.stopPropagation();
    window.AdnotaState.set({ color: themeClass });
  };
  swatches[themeClass] = swatch;
  highlightToolbar.appendChild(swatch);
}

// Divider
highlightToolbar.appendChild(Object.assign(document.createElement('div'), { className: 'adnota-toolbar-divider' }));

// Stroke width presets
const strokePresets = [
  { width: 2, dotSize: 4, label: 'Small' },
  { width: 4, dotSize: 6, label: 'Medium' },
  { width: 8, dotSize: 9, label: 'Large' },
];
const strokeBtns = {};
for (const preset of strokePresets) {
  const btn = document.createElement('div');
  btn.className = 'adnota-stroke-btn';
  btn.setAttribute('data-tooltip', preset.label);
  const dot = document.createElement('div');
  dot.className = 'adnota-stroke-dot';
  dot.style.width = preset.dotSize + 'px';
  dot.style.height = preset.dotSize + 'px';
  btn.appendChild(dot);
  btn.onclick = (e) => {
    e.stopPropagation();
    window.AdnotaState.set({ strokeWidth: preset.width });
  };
  strokeBtns[preset.width] = btn;
  highlightToolbar.appendChild(btn);
}

// Divider — trailing edge of the stroke-width group; hides with the strokes.
const strokeGroupDivider = Object.assign(document.createElement('div'), { className: 'adnota-toolbar-divider' });
highlightToolbar.appendChild(strokeGroupDivider);
const strokeGroupEls = [...Object.values(strokeBtns), strokeGroupDivider];

// Trash — clears every drawing annotation on this page (highlights + markers)
highlightToolbar.appendChild(window.AdnotaUI.createTrashButton({
  singular: 'highlight or drawing',
  plural: 'highlights & drawings',
  actionTypes: ['HIGHLIGHT', 'MARKER'],
}));

// Undo
highlightToolbar.appendChild(window.AdnotaUI.createUndoButton());

// All drawing-family modes that show the dock body
const _drawingModes = new Set(['pen', 'highlight', 'arrow', 'rect', 'ellipse', 'text', 'select']);

// ── Per-tool cursor icons ─────────────────────────────────────────────────
// Distinctive cursors per tool so "tool mode" is visually unambiguous.
// Trailing `, <fallback>` keeps things sane if the data URL fails to parse.
function svgCursor(svg, hx, hy, fallback = 'crosshair') {
  // `%22` = `"` — required for a well-formed data: URL with inline attributes.
  const encoded = svg.replace(/"/g, '%22').replace(/#/g, '%23').replace(/\n/g, '');
  return `url("data:image/svg+xml;utf8,${encoded}") ${hx} ${hy}, ${fallback}`;
}

const CURSORS = {
  crosshair: 'crosshair',
  // I-beam for highlight + text. Plain native cursor gives the crispest
  // selection feedback — a custom SVG on a slant confused the hotspot.
  text: 'text',
  // White arrow for select mode — reads as "tool active" on any page background.
  select: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
       <path d="M2 1 L2 14 L5 11 L7 15 L9 14 L7 10 L12 10 Z"
             fill="white" stroke="black" stroke-width="1.2" stroke-linejoin="round"/>
     </svg>`, 2, 1, 'default')
};

// Inject/update a stylesheet that forces the tool cursor on every non-Adnota
// element with `!important`. Page-defined `cursor: pointer` on links/buttons
// would otherwise win over an inline body cursor — that's the exact bug where
// hovering a link made the cursor look clickable, then sticky mode dropped a
// note instead of following the link.
//
// `html.adnota-dragging` override lets marker-drag swap to `grabbing` without
// fighting the lock.
function setCursorLock(cursor) {
  let tag = document.getElementById('adnota-cursor-lock');
  if (!cursor) {
    if (tag) tag.remove();
    return;
  }
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'adnota-cursor-lock';
    tag.setAttribute('data-adnota-ui', '1');
    document.head.appendChild(tag);
  }
  // `:not([data-adnota-ui] *)` excludes descendants of Adnota UI — the project
  // convention is every Adnota UI element carries `data-adnota-ui="1"`, so
  // toolbars/buttons/sticky notes keep their own cursors (grab, pointer, etc.).
  const scope = '*:not([data-adnota-ui]):not([data-adnota-ui] *)';
  tag.textContent =
    `${scope} { cursor: ${cursor} !important; }\n` +
    // Drag override: beats the base lock on page elements via specificity, and
    // beats marker.css's select-mode `grab` rule on wrappers via !important.
    `html.adnota-dragging ${scope} { cursor: grabbing !important; }\n` +
    `html.adnota-dragging .adnota-marker-wrapper,\n` +
    `html.adnota-dragging .adnota-marker-wrapper * { cursor: grabbing !important; }`;
}

// Expose for other content scripts (sticky.js re-applies the cursor when its
// color swatch changes so the sticky-note cursor tracks the active color).
window.AdnotaCursor = { set: setCursorLock, svgCursor };

// Global AdnotaState Subscription — single place that owns cursor and toolbar state
// for ALL modes. Eraser and sticky manage their own overlays but delegate cursor here.
let highlightDockMounted = false;
let _drawActive = false;
let _drawSubMode = null;
window.AdnotaState.subscribe(state => {
  // Mount the dock body for all drawing-family modes (pen, highlight, arrow,
  // rect, ellipse, text, select). Switching between sub-modes keeps the body
  // mounted — the dock just stays active and the body's internal state
  // (active tool button, fill group visibility, etc.) updates below.
  const showToolbar = _drawingModes.has(state.mode);
  const newSubMode = showToolbar ? state.mode : null;
  if (newSubMode !== _drawSubMode) {
    if (_drawActive && newSubMode === null) {
      window.AdnotaLog?.event('draw', 'mode-exit', { from: _drawSubMode });
    } else if (!_drawActive && newSubMode !== null) {
      window.AdnotaLog?.event('draw', 'mode-enter', { sub: newSubMode });
    } else if (_drawActive && newSubMode !== null) {
      window.AdnotaLog?.event('draw', 'submode-change', { from: _drawSubMode, to: newSubMode });
    }
    _drawSubMode = newSubMode;
    _drawActive = newSubMode !== null;
  }
  if (showToolbar && !highlightDockMounted) {
    window.AdnotaDock.mount('highlight', () => highlightToolbar);
    highlightDockMounted = true;
  } else if (!showToolbar && highlightDockMounted) {
    window.AdnotaDock.unmount('highlight');
    highlightDockMounted = false;
  }

  // Central cursor management for every mode. Custom icons for sticky/eraser
  // make "tool mode" visually unambiguous — a plain `text` or `crosshair`
  // cursor still reads ambiguously when hovering links.
  //
  // The cursor is applied via an injected stylesheet with `!important` so that
  // link/button `cursor: pointer` rules on the host page can't override it.
  // Without this lock, hovering any link flips the cursor back to pointer and
  // the user thinks they're about to click — instead they drop a text field.
  switch (state.mode) {
    case 'highlight': setCursorLock(CURSORS.text);   break;
    case 'select':    setCursorLock(CURSORS.select); break;
    case 'text':      setCursorLock(CURSORS.text);   break;
    // Sticky owns its cursor so the icon can recolor when the user picks a
    // swatch in the HUD — see window.AdnotaSticky.applyCursor in sticky.js.
    case 'sticky':    window.AdnotaSticky?.applyCursor(); break;
    // Resizer — crosshair keeps mode intent clear; resize handles set their
    // own ew-resize/ns-resize/nwse-resize cursors inline, overriding this.
    case 'resizer':
    case 'eraser':
    case 'pen':
    case 'arrow':
    case 'rect':
    case 'ellipse':
      setCursorLock(CURSORS.crosshair); break;
    default: setCursorLock(null); break;
  }
  // Drive the `grab` cursor on marker hover + any other select-mode-only CSS.
  document.documentElement.classList.toggle('adnota-select-mode', state.mode === 'select');

  // Update tool button active states
  for (const [mode, btn] of Object.entries(toolBtns)) {
    btn.classList.toggle('active', state.mode === mode);
  }

  // Update swatch active states
  Object.values(swatches).forEach(s => s.classList.remove('active'));
  const isCustomColor = typeof state.color === 'string' &&
                        (state.color.startsWith('#') || state.color.startsWith('rgb'));
  if (!isCustomColor && swatches[state.color]) {
    swatches[state.color].classList.add('active');
  }

  // Eyedropper swatch always mirrors the current paint color (theme or custom).
  // Its icon uses mix-blend-mode: difference so it stays readable on any fill.
  eyedropperSwatch.classList.toggle('active', isCustomColor);
  eyedropperSwatch.style.backgroundColor = resolvePaintColor(state.color);

  // Update stroke width active states
  for (const [w, btn] of Object.entries(strokeBtns)) {
    btn.classList.toggle('active', state.strokeWidth === Number(w));
  }

  // Fill group: visible only when a fillable shape is active. Outline/Solid
  // act as a radio pair — exactly one is always active.
  const isFillableShape = state.mode === 'rect' || state.mode === 'ellipse';
  fillGroupEls.forEach(el => { el.style.display = isFillableShape ? '' : 'none'; });
  fillOutlineBtn.classList.toggle('active', !state.filled);
  fillSolidBtn.classList.toggle('active', !!state.filled);

  // Stroke width: hidden when width has no effect — select mode draws nothing,
  // and solid-filled rect/ellipse render with stroke=none. Text still uses
  // strokeWidth to derive font size, so it stays visible there.
  const isSolidShape = isFillableShape && !!state.filled;
  const strokeUnused = state.mode === 'select' || isSolidShape;
  strokeGroupEls.forEach(el => { el.style.display = strokeUnused ? 'none' : ''; });
});

// Keyboard shortcut / popup toggle — opens the drawing palette in pen mode, or
// closes it if any drawing tool is already active. Pen is the default because
// it's the most natural "I want to draw" action; the old default ('highlight')
// no longer has a toolbar button.
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-highlighter') {
    const isDrawing = _drawingModes.has(window.AdnotaState.mode);
    window.AdnotaState.set({ mode: isDrawing ? null : 'pen' });
  }
});

// ── Hover affordances: #tag tooltip + delete ✕ ───────────────────────────────
// CSS Custom Highlights don't receive pointer events, and fallback overlays use
// pointer-events: none so links beneath stay clickable. So no `title` attribute
// or DOM listener on the highlight itself would work. Instead we keep a Map of
// every live highlight, hit-test on mousemove, and render:
//   • a floating `#tag` chip near the cursor (when the highlight has a tag)
//   • a clickable red ✕ at the highlight's top-right (always)
// The ✕ reuses .adnota-select-delete styling for consistency with the Select
// tool's per-item delete affordance on markers.
const liveHighlights = new Map(); // _id → { tag, color, text, range?, fallbackEl? }

function registerLiveHighlight(id, entry) {
  if (!id) return;
  liveHighlights.set(id, entry);
}

function unregisterLiveHighlight(id) {
  liveHighlights.delete(id);
}

// Returns the bounding client rects that cover the highlight on screen, or
// null if the entry's underlying range/element has gone stale. Stale entries
// self-clean from the Map — _rebuildLiveHighlights() clears/re-adds CSS
// ranges during bulk trash, and soft-deletes remove fallback wrappers.
function rectsForHighlight(entry, id) {
  if (entry.fallbackEl) {
    if (!entry.fallbackEl.isConnected) {
      liveHighlights.delete(id);
      return null;
    }
    const rects = [];
    for (const child of entry.fallbackEl.children) rects.push(child.getBoundingClientRect());
    return rects;
  }
  if (entry.range) {
    const registry = highlightRegistries[entry.color];
    if (!registry || !registry.has(entry.range)) {
      liveHighlights.delete(id);
      return null;
    }
    return Array.from(entry.range.getClientRects());
  }
  return null;
}

function findHighlightAt(x, y) {
  for (const [id, entry] of liveHighlights) {
    const rects = rectsForHighlight(entry, id);
    if (!rects) continue;
    for (const r of rects) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return { id, entry, rects };
      }
    }
  }
  return null;
}

// ── Tag tooltip layer ───────────────────────────────────────────────────────
let tagTooltipEl = null;
function ensureTagTooltip() {
  if (tagTooltipEl) return tagTooltipEl;
  tagTooltipEl = document.createElement('div');
  tagTooltipEl.className = 'adnota-highlight-tag-tooltip';
  tagTooltipEl.setAttribute('data-adnota-ui', '1');
  tagTooltipEl.style.display = 'none';
  document.documentElement.appendChild(tagTooltipEl);
  return tagTooltipEl;
}

function hideTagTooltip() {
  if (tagTooltipEl) tagTooltipEl.style.display = 'none';
}

function showTagTooltip(tag, x, y) {
  const el = ensureTagTooltip();
  el.textContent = '#' + tag;
  el.style.display = 'block';
  const r = el.getBoundingClientRect();
  const OX = 12, OY = 14;
  let left = x + OX;
  let top = y + OY;
  if (left + r.width + 4 > window.innerWidth) left = x - r.width - OX;
  if (top + r.height + 4 > window.innerHeight) top = y - r.height - OY;
  if (left < 4) left = 4;
  if (top < 4) top = 4;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

// ── Delete ✕ button layer ───────────────────────────────────────────────────
// A single shared button, repositioned to whichever highlight the cursor is
// currently over. pointer-events: auto so it's clickable.
let deleteBtnEl = null;
let deleteBtnHighlightId = null;
function ensureDeleteBtn() {
  if (deleteBtnEl) return deleteBtnEl;
  deleteBtnEl = document.createElement('div');
  // Reuse the Select-tool's red-circle class for visual consistency; our own
  // class overrides positioning to fixed and scopes any tweaks.
  deleteBtnEl.className = 'adnota-select-delete adnota-highlight-delete-btn';
  deleteBtnEl.setAttribute('data-adnota-ui', '1');
  deleteBtnEl.setAttribute('title', 'Delete highlight');
  deleteBtnEl.textContent = '✕';
  deleteBtnEl.style.display = 'none';
  deleteBtnEl.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    const id = deleteBtnHighlightId;
    if (!id) return;
    hideDeleteBtn();
    hideTagTooltip();
    await deleteHighlight(id);
  });
  document.documentElement.appendChild(deleteBtnEl);
  return deleteBtnEl;
}

function hideDeleteBtn() {
  if (deleteBtnEl) deleteBtnEl.style.display = 'none';
  deleteBtnHighlightId = null;
}

function showDeleteBtn(id, rects) {
  const el = ensureDeleteBtn();
  // Anchor to the first rect's top-right — the natural "start of this
  // highlight" corner, matching how Select hangs its ✕ off marker wrappers.
  // Nudge up + right so the ✕ sits clear of the highlighted text instead of
  // overlapping the first character.
  const first = rects[0];
  const SIZE = 20; // matches .adnota-select-delete width/height
  const NUDGE = 6;
  let left = first.right - SIZE / 2 + NUDGE;
  let top = first.top - SIZE / 2 - NUDGE;
  left = Math.max(2, Math.min(window.innerWidth - SIZE - 2, left));
  top = Math.max(2, Math.min(window.innerHeight - SIZE - 2, top));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.display = 'flex';
  deleteBtnHighlightId = id;
}

let pendingHitTest = 0;
let lastPointer = null;
document.addEventListener('mousemove', (e) => {
  lastPointer = { x: e.clientX, y: e.clientY, target: e.target };
  if (pendingHitTest) return;
  pendingHitTest = requestAnimationFrame(() => {
    pendingHitTest = 0;
    if (!lastPointer) return;
    if (liveHighlights.size === 0) { hideTagTooltip(); hideDeleteBtn(); return; }
    // Cursor on the ✕ itself → keep it visible, no tooltip.
    if (deleteBtnEl && lastPointer.target === deleteBtnEl) {
      hideTagTooltip();
      return;
    }
    // Any other Adnota UI surface → stand down.
    if (window.AdnotaUI?.isAdnotaElement(lastPointer.target)) {
      hideTagTooltip();
      hideDeleteBtn();
      return;
    }
    const hit = findHighlightAt(lastPointer.x, lastPointer.y);
    if (!hit) {
      hideTagTooltip();
      hideDeleteBtn();
      return;
    }
    if (hit.entry.tag) showTagTooltip(hit.entry.tag, lastPointer.x, lastPointer.y);
    else hideTagTooltip();
    showDeleteBtn(hit.id, hit.rects);
  });
}, { passive: true });

// Viewport changes invalidate cached rects. Hiding is cheaper than tracking;
// the next mousemove re-tests.
window.addEventListener('scroll', () => { hideTagTooltip(); hideDeleteBtn(); }, { passive: true, capture: true });
window.addEventListener('resize', () => { hideTagTooltip(); hideDeleteBtn(); }, { passive: true });

// Single-item delete. Tears down visual (CSS registry entry or fallback
// wrapper), drops the storage row, pushes an undo, and shows a 5s toast —
// matches the eraser/sticky pattern. The `consumed` guard inside the undo
// closure makes Ctrl+Z and the toast Undo button safely idempotent.
async function deleteHighlight(id) {
  const entry = liveHighlights.get(id);
  if (!entry) return null;
  const items = await window.AdnotaStorage.getAnchorsForUrl(location.href);
  const payload = items.find(i => i._id === id);
  if (!payload) return null;
  window.AdnotaLog?.event('highlight', 'delete', { id, color: payload.color, text: payload.text });

  if (entry.fallbackEl) {
    entry.fallbackEl._adnotaCleanup?.();
    entry.fallbackEl.remove();
  } else if (entry.range) {
    highlightRegistries[entry.color]?.delete(entry.range);
  }
  liveHighlights.delete(id);

  await window.AdnotaStorage.deleteItem(location.hostname, '_id', id);

  let consumed = false;
  const undoEntry = {
    undo: async () => {
      if (consumed) return;
      consumed = true;
      await window.AdnotaStorage.saveItem(location.hostname, location.pathname, payload);
      const match = window.FuzzyAnchor.findMatch(payload.anchor);
      if (match.confidence >= 40 && match.element) {
        if (payload.isFallback) {
          window.AdnotaHighlighter.renderFallback(match.element, payload);
        } else {
          window.AdnotaHighlighter.applyStoredHighlight(match.element, payload);
        }
      }
      window.AdnotaUndo.remove(undoEntry);
    }
  };
  window.AdnotaUndo.push(undoEntry);

  window.AdnotaUI?.showToast?.('Highlight deleted', {
    id: 'adnota-highlight-toast',
    onUndo: () => undoEntry.undo(),
  });
  return payload;
}

function getOccurrenceIndex(range, anchorElement) {
  const preSelectionRange = range.cloneRange();
  try {
    preSelectionRange.selectNodeContents(anchorElement);
    preSelectionRange.setEnd(range.startContainer, range.startOffset);
  } catch (e) {
    return 0;
  }

  const textBefore = preSelectionRange.toString();
  const highlightText = range.toString();

  if (!highlightText) return 0;

  let count = 0;
  let pos = textBefore.indexOf(highlightText);
  while (pos !== -1) {
    count++;
    pos = textBefore.indexOf(highlightText, pos + 1);
  }
  return count;
}

// Shared highlight creation — used by the Draw-HUD highlight mouseup handler
// AND by the contextual "quick highlight" popup. Accepts any range and color,
// writes to storage, adds to the CSS Highlights registry (or renders fallback),
// and pushes an undo entry. Selection clearing is the caller's responsibility.
async function createHighlightFromRange(range, color, tag = '') {
  let anchorElement = range.commonAncestorContainer;
  if (anchorElement.nodeType !== Node.ELEMENT_NODE) {
    anchorElement = anchorElement.parentNode;
  }

  const blockElement = anchorElement.closest('p, div, section, article, main, li, h1, h2, h3, h4, td') || document.body;
  const anchor = window.FuzzyAnchor.generate(blockElement);
  const _id = Date.now() + Math.random().toString();

  // Only attach the tag field when it's actually set, so the untagged
  // mouseup-auto-apply path (and any other caller that doesn't pass a tag)
  // leaves no empty-string debris in storage.
  const normalizedTag = window.AdnotaTags
    ? window.AdnotaTags.normalize(tag)
    : (typeof tag === 'string' ? tag.trim() : '');

  // text uses AdnotaUI.rangeText so highlights inside <pre> blocks store
  // their actual line structure (range.toString() collapses syntax-
  // highlighter-rendered code to one line because the lines are spans, not
  // text nodes with \n). occurrenceIndex stays on range.toString() because
  // its internal indexOf matching needs both strings extracted the same way.
  const payload = {
    anchor,
    _id,
    action: 'HIGHLIGHT',
    text: window.AdnotaUI?.rangeText?.(range) ?? range.toString(),
    occurrenceIndex: getOccurrenceIndex(range, blockElement),
    color,
    attachedNoteId: null
  };
  if (normalizedTag) payload.tag = normalizedTag;

  // Custom hex (eyedropper) colors aren't registered in CSS.highlights — route
  // them through the fallback overlay renderer instead.
  const isCustomColor = typeof color === 'string' &&
                        (color.startsWith('#') || color.startsWith('rgb'));

  if (isCustomColor) {
    payload.isFallback = true;
    const box = blockElement.getBoundingClientRect();
    payload.fallbackRects = Array.from(range.getClientRects()).map(r => ({
      left: ((r.left - box.left) / box.width) * 100,
      top: ((r.top - box.top) / box.height) * 100,
      width: (r.width / box.width) * 100,
      height: (r.height / box.height) * 100
    }));
    window.AdnotaHighlighter?.renderFallback?.(blockElement, payload);
  } else if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
    const registry = highlightRegistries[color];
    if (registry) {
      try {
        const clonedRange = range.cloneRange();
        registry.add(clonedRange);
        payload._clonedRange = clonedRange;
        registerLiveHighlight(_id, {
          tag: normalizedTag || '',
          color,
          text: payload.text,
          range: clonedRange,
        });
      } catch (err) {
        console.warn("Adnota: CSS Highlight API rejected range, likely crossing a Shadow DOM boundary. Range:", range);
        payload.isFallback = true;
        const box = blockElement.getBoundingClientRect();
        payload.fallbackRects = Array.from(range.getClientRects()).map(r => ({
          left: ((r.left - box.left) / box.width) * 100,
          top: ((r.top - box.top) / box.height) * 100,
          width: (r.width / box.width) * 100,
          height: (r.height / box.height) * 100
        }));
        window.AdnotaHighlighter?.renderFallback?.(blockElement, payload);
      }
    }
  }

  if (window.AdnotaStorage) {
    await window.AdnotaStorage.saveItem(location.hostname, location.pathname, payload);
  }

  window.AdnotaLog?.event('highlight', 'create', {
    id: _id,
    color,
    path: payload.isFallback ? 'fallback' : 'css',
    tag: normalizedTag || null,
    text: payload.text,
    anchor: anchor ? { sel: anchor.cssSelector, tag: anchor.tagName } : null,
  });

  const capturedId = _id;
  const capturedColor = color;
  const capturedRange = payload._clonedRange || null;
  const capturedFallback = payload.isFallback || false;
  window.AdnotaUndo.push({
    undo: async () => {
      window.AdnotaLog?.event('highlight', 'undo', { id: capturedId });
      if (capturedFallback) {
        const fallbackEl = document.querySelector(`.adnota-highlight-fallback[data-highlight-id="${capturedId}"]`);
        if (fallbackEl) fallbackEl.remove();
      } else if (capturedRange) {
        highlightRegistries[capturedColor]?.delete(capturedRange);
      }
      unregisterLiveHighlight(capturedId);
      if (window.AdnotaStorage) {
        await window.AdnotaStorage.deleteItem(location.hostname, '_id', capturedId);
      }
    }
  });

  return payload;
}

document.addEventListener('mouseup', async (e) => {
  if (window.AdnotaState.mode !== 'highlight') return;

  if (window.AdnotaUI.isAdnotaElement(e.target)) return;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    return; // Do nothing on standard clicks, allow double-clicks to form selections safely.
  }

  const range = selection.getRangeAt(0);
  const text = range.toString().trim();
  if (!text) return;

  // Hide mode must never obscure work — reveal everything before applying.
  window.AdnotaVisibility.show();

  await createHighlightFromRange(range, window.AdnotaState.color);

  try {
    selection.removeAllRanges();
  } catch (e) { }
});

window.AdnotaHighlighter = {
  createHighlightFromRange,
  deleteHighlight,

  // Drop every rendered highlight (CSS Custom Highlights + fallback
  // wrappers) from the page. Called on SPA URL change so highlights
  // from the previous path don't survive into the next. CSS-path entries
  // would already render nothing after a React swap (their stored Range
  // points at detached DOM), but the registry entries are still there
  // and need to be cleared explicitly. Storage is left alone.
  tearDownAll: function () {
    for (const reg of Object.values(highlightRegistries)) reg.clear();
    for (const entry of liveHighlights.values()) {
      if (entry.fallbackEl) {
        entry.fallbackEl._adnotaCleanup?.();
        entry.fallbackEl.remove();
      }
    }
    liveHighlights.clear();
  },

  // Returns the tag of the live highlight covering (x, y) in viewport
  // coordinates, or '' if there's no highlight there or it's untagged.
  // Used by the quick-highlight popup to pre-fill the tag input when the user
  // re-selects text inside a tagged highlight.
  tagAtPoint(x, y) {
    const hit = findHighlightAt(x, y);
    return hit?.entry?.tag || '';
  },

  // Smooth-scrolls the highlight with the given _id into view and paints a
  // brief purple pulse over its rects so the user sees where they landed.
  // Returns true on success, false if the highlight isn't currently rendered
  // (CSS Custom Highlights entry whose Range went stale, or fallback wrapper
  // whose DOM was torn down). The scratch pad's GOTO button uses the return
  // value to surface a "couldn't locate" toast.
  scrollTo(id) {
    const entry = liveHighlights.get(id);
    if (!entry) return false;
    // Pick the right scroll target. Fallback path has its own DOM wrapper;
    // CSS path has only a Range, so scroll the parent of the start node —
    // scrollIntoView walks up to find the right scroll container, which
    // matters on app shells (claude.ai) where the document itself doesn't
    // scroll.
    let target = null;
    if (entry.fallbackEl && entry.fallbackEl.isConnected) {
      target = entry.fallbackEl;
    } else if (entry.range) {
      const node = entry.range.startContainer;
      target = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    }
    if (!target || !target.scrollIntoView) return false;
    try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    catch (_) { target.scrollIntoView(); }
    return true;
  },

  renderFallback: function (anchorElement, payload) {
    if (!payload.fallbackRects) return;
    const themeColors = {
      'adnota-theme-yellow': 'rgba(255, 235, 59, 0.4)',
      'adnota-theme-green': 'rgba(76, 175, 80, 0.4)',
      'adnota-theme-blue': 'rgba(33, 150, 243, 0.4)',
      'adnota-theme-pink': 'rgba(233, 30, 99, 0.4)',
      // Redaction: fully opaque, no blend mode — must completely cover the text.
      'adnota-theme-black': '#000'
    };
    // Custom eyedropper colors are painted opaquely (cover-up intent) — no blend mode.
    const isCustomColor = typeof payload.color === 'string' &&
                          (payload.color.startsWith('#') || payload.color.startsWith('rgb'));
    const isSolidRedaction = payload.color === 'adnota-theme-black' || isCustomColor;
    const paintColor = themeColors[payload.color] || payload.color;

    const wrapper = document.createElement('div');
    wrapper.className = 'adnota-highlight-fallback';
    wrapper.dataset.highlightId = payload._id; // Needed for undo lookup.
    wrapper.style.position = 'absolute';
    wrapper.style.pointerEvents = 'none';
    wrapper.style.zIndex = '2147483640';
    document.documentElement.appendChild(wrapper);

    payload.fallbackRects.forEach(rect => {
      const div = document.createElement('div');
      div.style.position = 'absolute';
      div.style.backgroundColor = paintColor || themeColors['adnota-theme-yellow'];
      // Redaction + custom colors must be fully opaque — multiply lets text bleed through.
      if (!isSolidRedaction) div.style.mixBlendMode = 'multiply';
      wrapper.appendChild(div);
    });

    function syncBounds() {
      if (!wrapper.parentNode) return;
      const box = anchorElement.getBoundingClientRect();
      const children = wrapper.children;
      for (let i = 0; i < children.length; i++) {
        const r = payload.fallbackRects[i];
        children[i].style.left = `${box.left + window.pageXOffset + (r.left / 100) * box.width}px`;
        children[i].style.top = `${box.top + window.pageYOffset + (r.top / 100) * box.height}px`;
        children[i].style.width = `${(r.width / 100) * box.width}px`;
        children[i].style.height = `${(r.height / 100) * box.height}px`;
      }
    }

    window.AdnotaUI.bindAnchorSync(wrapper, anchorElement, syncBounds);

    if (payload._id) {
      registerLiveHighlight(payload._id, {
        tag: payload.tag || '',
        color: payload.color,
        text: payload.text,
        fallbackEl: wrapper,
      });
    }
  },

  applyStoredHighlight: function (anchorElement, payload) {
    if (payload.isFallback && payload.fallbackRects) {
      this.renderFallback(anchorElement, payload);
      return true;
    }

    if (typeof CSS === 'undefined' || !('highlights' in CSS)) return false;

    const treeWalker = document.createTreeWalker(anchorElement, NodeFilter.SHOW_TEXT, null, false);
    let node;
    let currentText = '';
    const textNodes = [];

    while ((node = treeWalker.nextNode())) {
      textNodes.push({
        node: node,
        start: currentText.length,
        end: currentText.length + node.nodeValue.length
      });
      currentText += node.nodeValue;
    }

    const textToFind = payload.text;
    let pos = -1;
    for (let i = 0; i <= payload.occurrenceIndex; i++) {
      pos = currentText.indexOf(textToFind, pos + 1);
      if (pos === -1) break;
    }

    if (pos !== -1) {
      const startOffsetGlobals = pos;
      const endOffsetGlobals = pos + textToFind.length;

      const range = new Range();
      let startSet = false;
      let endSet = false;

      for (const info of textNodes) {
        if (!startSet && startOffsetGlobals >= info.start && startOffsetGlobals < info.end) {
          range.setStart(info.node, startOffsetGlobals - info.start);
          startSet = true;
        }
        if (!endSet && endOffsetGlobals > info.start && endOffsetGlobals <= info.end) {
          range.setEnd(info.node, endOffsetGlobals - info.start);
          endSet = true;
        }
      }

      if (startSet && endSet) {
        highlightRegistries[payload.color].add(range);
        if (payload._id) {
          registerLiveHighlight(payload._id, {
            tag: payload.tag || '',
            color: payload.color,
            text: payload.text,
            range,
          });
        }
        return true;
      }
    }
    return false;
  }
};
