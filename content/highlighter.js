// content/highlighter.js

// Setup CSS Highlight Registry (Requires Chrome 105+)
const highlightRegistries = {
  'vellum-theme-yellow': new Highlight(),
  'vellum-theme-green': new Highlight(),
  'vellum-theme-blue': new Highlight(),
  'vellum-theme-pink': new Highlight(),
  'vellum-theme-black': new Highlight()
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
  highlight: '<path d="M4 16h10"/><path d="M6 3l-3 9h3l1 4h4l1-4h3L12 3z" fill="currentColor" opacity="0.25" stroke="none"/><path d="M6 3l-3 9h3l1 4h4l1-4h3L12 3H6z"/>',
  arrow:     '<path d="M5 15L15 5"/><path d="M15 5H9M15 5v6"/>',
  rect:      '<rect x="4" y="5" width="12" height="10" rx="1"/>',
  ellipse:   '<ellipse cx="10" cy="10" rx="7" ry="5"/>',
  text:      '<text x="4" y="15" font-size="14" font-weight="700" font-family="serif" fill="currentColor" stroke="none">T</text>',
  // Outline variant: hollow square + red diagonal slash to visually distinguish
  // "no fill" from the rectangle tool icon itself.
  fillOutline: '<rect x="4" y="5" width="12" height="10" rx="1"/><line class="vellum-outline-slash" x1="4" y1="15" x2="16" y2="5"/>',
  // Solid variant: filled square (fill painted via dedicated CSS to defeat the
  // global .vellum-tool-btn svg { fill: none } rule).
  fillSolid: '<rect class="vellum-fill-solid-rect" x="4" y="5" width="12" height="10" rx="1"/>',
  eyedropper:'<path d="M13 2l5 5-2 2-1-1-6 6-3 1 1-3 6-6-1-1z" fill="currentColor" stroke="none"/>',
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
  btn.className = 'vellum-tool-btn';
  btn.dataset.tool = mode;
  btn.setAttribute('title', title);
  btn.appendChild(svgIcon(name));
  btn.onclick = (e) => {
    e.stopPropagation();
    window.VellumState.set({ mode: window.VellumState.mode === mode ? null : mode });
  };
  return btn;
}

// ── Create Toolbar UI ───────────────────────────────────────────────────────
const highlightToolbar = document.createElement('div');
highlightToolbar.id = 'vellum-highlighter-widget';
highlightToolbar.setAttribute('data-vellum-ui', '1');
highlightToolbar.style.display = 'none';
highlightToolbar.style.bottom = '20px';
highlightToolbar.style.left = '50%';
highlightToolbar.style.transform = 'translateX(-50%)';
document.documentElement.appendChild(highlightToolbar);

// Drag handle
const dragHandle = document.createElement('span');
dragHandle.className = 'vellum-toolbar-drag';
dragHandle.textContent = '\u2847';
dragHandle.title = 'Drag to reposition';
highlightToolbar.appendChild(dragHandle);

// Logo chip
const logoChip = document.createElement('span');
logoChip.className = 'vellum-toolbar-logo';
logoChip.textContent = 'V';
highlightToolbar.appendChild(logoChip);

// Divider
highlightToolbar.appendChild(Object.assign(document.createElement('div'), { className: 'vellum-toolbar-divider' }));

// Tool buttons — drawing sub-tools are all "pen-family" modes that share the SVG overlay
const drawingModes = ['pen', 'highlight', 'arrow', 'rect', 'ellipse', 'text', 'select'];
const toolLabels = { pen: 'Pencil', highlight: 'Highlight', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Circle', text: 'Text', select: 'Select' };
const toolIconMap = { pen: 'pencil', highlight: 'highlight', arrow: 'arrow', rect: 'rect', ellipse: 'ellipse', text: 'text', select: 'select' };
const toolBtns = {};

// select goes first
for (const mode of ['select', 'pen', 'highlight', 'arrow', 'rect', 'ellipse', 'text']) {
  const btn = makeToolBtn(toolIconMap[mode], toolLabels[mode], mode);
  toolBtns[mode] = btn;
  highlightToolbar.appendChild(btn);
}

// Divider
highlightToolbar.appendChild(Object.assign(document.createElement('div'), { className: 'vellum-toolbar-divider' }));

// ── Fill group — outline / solid radio pair, shown only in rect/ellipse modes.
// Placed right after the shape tool buttons so the option surfaces next to
// the tool that triggered it.
function makeFillBtn({ iconKey, cls, title, filled }) {
  const btn = document.createElement('div');
  btn.className = `vellum-tool-btn ${cls}`;
  btn.title = title;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.innerHTML = toolIcons[iconKey];
  btn.appendChild(svg);
  btn.onclick = (e) => {
    e.stopPropagation();
    window.VellumState.set({ filled });
  };
  return btn;
}
const fillOutlineBtn = makeFillBtn({
  iconKey: 'fillOutline', cls: 'vellum-fill-outline-btn', title: 'Outline', filled: false,
});
const fillSolidBtn = makeFillBtn({
  iconKey: 'fillSolid', cls: 'vellum-fill-solid-btn', title: 'Solid fill', filled: true,
});
const fillGroupDivider = Object.assign(document.createElement('div'), { className: 'vellum-toolbar-divider' });
const fillGroupEls = [fillOutlineBtn, fillSolidBtn, fillGroupDivider];
highlightToolbar.appendChild(fillOutlineBtn);
highlightToolbar.appendChild(fillSolidBtn);
highlightToolbar.appendChild(fillGroupDivider);

// Color swatches
const themes = {
  'vellum-theme-yellow': 'rgb(255, 235, 59)',
  'vellum-theme-green': 'rgb(76, 175, 80)',
  'vellum-theme-blue': 'rgb(33, 150, 243)',
  'vellum-theme-pink': 'rgb(233, 30, 99)',
  'vellum-theme-black': '#111'
};

function resolvePaintColor(c) {
  if (typeof c === 'string' && (c.startsWith('#') || c.startsWith('rgb'))) return c;
  return themes[c] || themes['vellum-theme-yellow'];
}

// ── Eyedropper swatch — doubles as current-color indicator and picker. Its
// background always mirrors the current paint color; clicking opens the native
// EyeDropper API (Chrome 95+) to pick a new one. Sits to the LEFT of the
// palette with dividers on both sides so it reads as its own control, not a
// sixth swatch. For highlights, custom hex routes through the fallback overlay
// renderer since CSS Custom Highlights need pre-registered theme names.
const eyedropperSwatch = document.createElement('div');
eyedropperSwatch.className = 'vellum-color-swatch vellum-eyedropper-swatch';
eyedropperSwatch.title = 'Current color — click to pick any color from the page';
const eyeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
eyeSvg.setAttribute('viewBox', '0 0 20 20');
eyeSvg.innerHTML = toolIcons.eyedropper;
eyedropperSwatch.appendChild(eyeSvg);
eyedropperSwatch.onclick = async (e) => {
  e.stopPropagation();
  if (typeof window.EyeDropper !== 'function') {
    window.VellumUI.showToast('Eyedropper requires Chrome 95+');
    return;
  }
  try {
    const dropper = new window.EyeDropper();
    const result = await dropper.open();
    if (result?.sRGBHex) {
      window.VellumState.set({ color: result.sRGBHex });
    }
  } catch (err) {
    // User cancelled picker — no-op.
  }
};
highlightToolbar.appendChild(eyedropperSwatch);

// Divider between eyedropper (current-color control) and the palette.
highlightToolbar.appendChild(Object.assign(document.createElement('div'), { className: 'vellum-toolbar-divider' }));

const swatches = {};
for (const [themeClass, colorHex] of Object.entries(themes)) {
  const swatch = document.createElement('div');
  swatch.className = 'vellum-color-swatch';
  swatch.style.backgroundColor = colorHex;
  if (themeClass === 'vellum-theme-black') {
    swatch.title = 'Redact';
  }
  swatch.onclick = (e) => {
    e.stopPropagation();
    window.VellumState.set({ color: themeClass });
  };
  swatches[themeClass] = swatch;
  highlightToolbar.appendChild(swatch);
}

// Divider
highlightToolbar.appendChild(Object.assign(document.createElement('div'), { className: 'vellum-toolbar-divider' }));

// Stroke width presets
const strokePresets = [
  { width: 2, dotSize: 4, label: 'Thin' },
  { width: 4, dotSize: 6, label: 'Medium' },
  { width: 8, dotSize: 9, label: 'Thick' },
];
const strokeBtns = {};
for (const preset of strokePresets) {
  const btn = document.createElement('div');
  btn.className = 'vellum-stroke-btn';
  btn.title = preset.label;
  const dot = document.createElement('div');
  dot.className = 'vellum-stroke-dot';
  dot.style.width = preset.dotSize + 'px';
  dot.style.height = preset.dotSize + 'px';
  btn.appendChild(dot);
  btn.onclick = (e) => {
    e.stopPropagation();
    window.VellumState.set({ strokeWidth: preset.width });
  };
  strokeBtns[preset.width] = btn;
  highlightToolbar.appendChild(btn);
}

// Divider
highlightToolbar.appendChild(Object.assign(document.createElement('div'), { className: 'vellum-toolbar-divider' }));

// Trash — clears every drawing annotation on this page (highlights + markers)
highlightToolbar.appendChild(window.VellumUI.createTrashButton({
  singular: 'highlight or drawing',
  plural: 'highlights & drawings',
  actionTypes: ['HIGHLIGHT', 'MARKER'],
}));

// Undo
highlightToolbar.appendChild(window.VellumUI.createUndoButton());

// ── Toolbar drag logic ──────────────────────────────────────────────────────
window.VellumUI.makeDraggable(highlightToolbar, dragHandle);

// All drawing-family modes that show this toolbar
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
     </svg>`, 2, 1, 'default'),
  // Eraser — pink rubber tipped tool tilted at -30°; hotspot at the tip (bottom-left).
  eraser: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
       <g transform="rotate(-35 12 13)">
         <rect x="2" y="9" width="20" height="8" rx="1.5" fill="#fca5a5" stroke="black" stroke-width="1.5"/>
         <line x1="9" y1="9" x2="9" y2="17" stroke="black" stroke-width="1.5"/>
       </g>
     </svg>`, 3, 20, 'crosshair'),
};

// Inject/update a stylesheet that forces the tool cursor on every non-Vellum
// element with `!important`. Page-defined `cursor: pointer` on links/buttons
// would otherwise win over an inline body cursor — that's the exact bug where
// hovering a link made the cursor look clickable, then sticky mode dropped a
// note instead of following the link.
//
// `html.vellum-dragging` override lets marker-drag swap to `grabbing` without
// fighting the lock.
function setCursorLock(cursor) {
  let tag = document.getElementById('vellum-cursor-lock');
  if (!cursor) {
    if (tag) tag.remove();
    return;
  }
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'vellum-cursor-lock';
    tag.setAttribute('data-vellum-ui', '1');
    document.head.appendChild(tag);
  }
  // `:not([data-vellum-ui] *)` excludes descendants of Vellum UI — the project
  // convention is every Vellum UI element carries `data-vellum-ui="1"`, so
  // toolbars/buttons/sticky notes keep their own cursors (grab, pointer, etc.).
  const scope = '*:not([data-vellum-ui]):not([data-vellum-ui] *)';
  tag.textContent =
    `${scope} { cursor: ${cursor} !important; }\n` +
    // Drag override: beats the base lock on page elements via specificity, and
    // beats marker.css's select-mode `grab` rule on wrappers via !important.
    `html.vellum-dragging ${scope} { cursor: grabbing !important; }\n` +
    `html.vellum-dragging .vellum-marker-wrapper,\n` +
    `html.vellum-dragging .vellum-marker-wrapper * { cursor: grabbing !important; }`;
}

// Expose for other content scripts (sticky.js re-applies the cursor when its
// color swatch changes so the sticky-note cursor tracks the active color).
window.VellumCursor = { set: setCursorLock, svgCursor };

// Global VellumState Subscription — single place that owns cursor and toolbar state
// for ALL modes. Eraser and sticky manage their own overlays but delegate cursor here.
window.VellumState.subscribe(state => {
  // Toolbar is visible for all drawing-family modes — not eraser or sticky.
  const showToolbar = _drawingModes.has(state.mode);
  highlightToolbar.style.display = showToolbar ? 'flex' : 'none';

  // Reset toolbar position when hidden
  if (!showToolbar) {
    highlightToolbar.style.left = '50%';
    highlightToolbar.style.top = '';
    highlightToolbar.style.bottom = '20px';
    highlightToolbar.style.transform = 'translateX(-50%)';
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
    case 'eraser':    setCursorLock(CURSORS.eraser); break;
    // Sticky owns its cursor so the icon can recolor when the user picks a
    // swatch in the HUD — see window.VellumSticky.applyCursor in sticky.js.
    case 'sticky':    window.VellumSticky?.applyCursor(); break;
    case 'pen':
    case 'arrow':
    case 'rect':
    case 'ellipse':
      setCursorLock(CURSORS.crosshair); break;
    default: setCursorLock(null); break;
  }
  // Drive the `grab` cursor on marker hover + any other select-mode-only CSS.
  document.documentElement.classList.toggle('vellum-select-mode', state.mode === 'select');

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
});

// Keyboard shortcut / popup toggle — switches to highlight mode, or off if already active.
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-highlighter') {
    // If any drawing tool is active, deactivate. Otherwise activate highlight mode.
    const isDrawing = _drawingModes.has(window.VellumState.mode);
    window.VellumState.set({ mode: isDrawing ? null : 'highlight' });
  }
});

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

// Shared highlight creation — used by the Alt+H mouseup handler AND by the
// contextual "quick highlight" popup. Accepts any range and color, writes to
// storage, adds to the CSS Highlights registry (or renders fallback), and
// pushes an undo entry. Selection clearing is the caller's responsibility.
async function createHighlightFromRange(range, color) {
  let anchorElement = range.commonAncestorContainer;
  if (anchorElement.nodeType !== Node.ELEMENT_NODE) {
    anchorElement = anchorElement.parentNode;
  }

  const blockElement = anchorElement.closest('p, div, section, article, main, li, h1, h2, h3, h4, td') || document.body;
  const anchor = window.FuzzyAnchor.generate(blockElement);
  const _id = Date.now() + Math.random().toString();

  const payload = {
    anchor,
    _id,
    action: 'HIGHLIGHT',
    text: range.toString(),
    occurrenceIndex: getOccurrenceIndex(range, blockElement),
    color,
    attachedNoteId: null
  };

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
    window.VellumHighlighter?.renderFallback?.(blockElement, payload);
  } else if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
    const registry = highlightRegistries[color];
    if (registry) {
      try {
        const clonedRange = range.cloneRange();
        registry.add(clonedRange);
        payload._clonedRange = clonedRange;
      } catch (err) {
        console.warn("Vellum: CSS Highlight API rejected range, likely crossing a Shadow DOM boundary. Range:", range);
        payload.isFallback = true;
        const box = blockElement.getBoundingClientRect();
        payload.fallbackRects = Array.from(range.getClientRects()).map(r => ({
          left: ((r.left - box.left) / box.width) * 100,
          top: ((r.top - box.top) / box.height) * 100,
          width: (r.width / box.width) * 100,
          height: (r.height / box.height) * 100
        }));
        window.VellumHighlighter?.renderFallback?.(blockElement, payload);
      }
    }
  }

  if (window.VellumStorage) {
    await window.VellumStorage.saveItem(location.hostname, location.pathname, payload);
  }

  const capturedId = _id;
  const capturedColor = color;
  const capturedRange = payload._clonedRange || null;
  const capturedFallback = payload.isFallback || false;
  window.VellumUndo.push({
    undo: async () => {
      if (capturedFallback) {
        const fallbackEl = document.querySelector(`.vellum-highlight-fallback[data-highlight-id="${capturedId}"]`);
        if (fallbackEl) fallbackEl.remove();
      } else if (capturedRange) {
        highlightRegistries[capturedColor]?.delete(capturedRange);
      }
      if (window.VellumStorage) {
        await window.VellumStorage.deleteItem(location.hostname, '_id', capturedId);
      }
    }
  });

  return payload;
}

document.addEventListener('mouseup', async (e) => {
  if (window.VellumState.mode !== 'highlight') return;

  if (e.target.closest('#vellum-highlighter-widget')) return;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    return; // Do nothing on standard clicks, allow double-clicks to form selections safely.
  }

  const range = selection.getRangeAt(0);
  const text = range.toString().trim();
  if (!text) return;

  // Hide mode must never obscure work — reveal everything before applying.
  window.VellumVisibility.show();

  await createHighlightFromRange(range, window.VellumState.color);

  try {
    selection.removeAllRanges();
  } catch (e) { }
});

window.VellumHighlighter = {
  createHighlightFromRange,

  renderFallback: function (anchorElement, payload) {
    if (!payload.fallbackRects) return;
    const themeColors = {
      'vellum-theme-yellow': 'rgba(255, 235, 59, 0.4)',
      'vellum-theme-green': 'rgba(76, 175, 80, 0.4)',
      'vellum-theme-blue': 'rgba(33, 150, 243, 0.4)',
      'vellum-theme-pink': 'rgba(233, 30, 99, 0.4)',
      // Redaction: fully opaque, no blend mode — must completely cover the text.
      'vellum-theme-black': '#000'
    };
    // Custom eyedropper colors are painted opaquely (cover-up intent) — no blend mode.
    const isCustomColor = typeof payload.color === 'string' &&
                          (payload.color.startsWith('#') || payload.color.startsWith('rgb'));
    const isSolidRedaction = payload.color === 'vellum-theme-black' || isCustomColor;
    const paintColor = themeColors[payload.color] || payload.color;

    const wrapper = document.createElement('div');
    wrapper.className = 'vellum-highlight-fallback';
    wrapper.dataset.highlightId = payload._id; // Needed for undo lookup.
    wrapper.style.position = 'absolute';
    wrapper.style.pointerEvents = 'none';
    wrapper.style.zIndex = '2147483640';
    document.documentElement.appendChild(wrapper);

    payload.fallbackRects.forEach(rect => {
      const div = document.createElement('div');
      div.style.position = 'absolute';
      div.style.backgroundColor = paintColor || themeColors['vellum-theme-yellow'];
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

    syncBounds();
    window.addEventListener('resize', syncBounds);
    // Bug 4 fix: Re-sync on scroll so fallback highlight rects don't drift on long pages.
    window.addEventListener('scroll', syncBounds, { passive: true });
    const observer = new ResizeObserver(() => syncBounds());
    observer.observe(anchorElement);
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
        return true;
      }
    }
    return false;
  }
};
