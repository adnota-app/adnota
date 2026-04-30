// content/marker.js

let currentPathNodes = [];
let captureSvg = null;
let capturePath = null;    // freehand live path
let captureShape = null;   // arrow/rect/ellipse live shape
let shapeOrigin = null;    // { x, y } screen coords at pointerdown for shape tools

// ── Utility: Ramer-Douglas-Peucker (RDP) Algorithm ─────────────────────────
function pointLineDistance(p, a, b) {
  const num = Math.abs((b.y - a.y) * p.x - (b.x - a.x) * p.y + b.x * a.y - b.y * a.x);
  const den = Math.sqrt(Math.pow(b.y - a.y, 2) + Math.pow(b.x - a.x, 2));
  return den === 0 ? Math.sqrt(Math.pow(p.x - a.x, 2) + Math.pow(p.y - a.y, 2)) : num / den;
}

function simplifyPathRDP(points, epsilon) {
  if (points.length < 3) return points;
  let maxDistance = 0;
  let index = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const d = pointLineDistance(points[i], points[0], points[end]);
    if (d > maxDistance) {
      index = i;
      maxDistance = d;
    }
  }

  if (maxDistance > epsilon) {
    const left = simplifyPathRDP(points.slice(0, index + 1), epsilon);
    const right = simplifyPathRDP(points.slice(index), epsilon);
    return left.slice(0, left.length - 1).concat(right);
  } else {
    return [points[0], points[end]];
  }
}

// Resolves the active color to a CSS color string. Accepts either a theme class
// or a raw hex (from the eyedropper swatch).
function getStrokeColor() {
  const themes = {
    'adnota-theme-yellow': '#fbc02d',
    'adnota-theme-green': '#388e3c',
    'adnota-theme-blue': '#1976d2',
    'adnota-theme-pink': '#c2185b',
    'adnota-theme-black': '#111'
  };
  const c = window.AdnotaState.color;
  if (typeof c === 'string' && (c.startsWith('#') || c.startsWith('rgb'))) return c;
  return themes[c] || '#fbc02d';
}

// ── Mode sets ───────────────────────────────────────────────────────────────
// All modes that use the SVG capture overlay
const _overlayModes = new Set(['pen', 'arrow', 'rect', 'ellipse']);
// Freehand only
const _freehandModes = new Set(['pen']);
// Shape tools (click-drag geometry)
const _shapeModes = new Set(['arrow', 'rect', 'ellipse']);

function isToolbarHit(e) {
  const toolbar = document.getElementById('adnota-highlighter-widget');
  if (!toolbar) return false;
  if (toolbar.contains(e.target)) return true;
  const rect = toolbar.getBoundingClientRect();
  return e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
}

// ── Raycast helper: find anchor block element at a screen point ─────────────
function findAnchorBlock(screenX, screenY) {
  captureSvg.style.pointerEvents = 'none';
  captureSvg.style.display = 'none';
  let targetNode = document.elementFromPoint(screenX, screenY);
  if (!targetNode || targetNode.nodeType !== Node.ELEMENT_NODE) {
    targetNode = document.body;
  }
  let blockElement = targetNode.closest('p, div, section, article, main, li, h1, h2, h3, h4, td') || document.body;

  // Reject degenerate anchors. The `closest()` call above happily picks a
  // matching block even if its box is 0×0 — the selector list isn't doing
  // the filtering, this walk-up is. YouTube's `div.html5-video-container`
  // is the poster child: position:absolute with 0×0 getBoundingClientRect
  // even when the video paints visibly (the actual pixels come from a
  // sibling <video>). Drawing handlers normalize coords by dividing by
  // box.width / box.height, so a zero-sized block produces NaN/Infinity and
  // the saved payload renders as <rect y="NaN">. Walk up until we find an
  // ancestor with real, finite dimensions; <body> is the floor and
  // effectively always qualifies.
  while (blockElement && blockElement !== document.body) {
    const r = blockElement.getBoundingClientRect();
    if (Number.isFinite(r.width) && Number.isFinite(r.height) && r.width > 0 && r.height > 0) break;
    blockElement = blockElement.parentElement;
  }
  return blockElement || document.body;
}

// Walk up to the nearest *inner* scrolling ancestor. App shells (claude.ai,
// Notion, etc.) have body { overflow: hidden } and a scrollable inner div —
// that's what we want to anchor against. Returns null when no inner scroller
// exists; the page itself is the scroll context, and the doc-pixel fallback
// (which uses window.scrollY directly) handles that case correctly without
// needing a synthetic anchor.
function findScrollContainer(el) {
  let cur = el && el.parentElement;
  while (cur && cur !== document.documentElement && cur !== document.body) {
    const cs = getComputedStyle(cur);
    const oy = cs.overflowY, ox = cs.overflowX;
    const yScrolls = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && cur.scrollHeight > cur.clientHeight;
    const xScrolls = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && cur.scrollWidth  > cur.clientWidth;
    if (yScrolls || xScrolls) return cur;
    cur = cur.parentElement;
  }
  return null;
}

// Fallback positioning data for restorer.js when FuzzyAnchor can't resolve
// the original block. Two layers, tried in order:
//
//   1. Container-anchored — render relative to the nearest *inner* scrolling
//      ancestor (offset within its scroll-content). Only written when an
//      inner scroller exists; window.scroll-capture fires on its scroll, so
//      syncBounds re-reads container rect + scrollTop and the marker tracks
//      content. The whole point is app shells where the page itself doesn't
//      scroll.
//
//   2. Doc-pixel — absolute (docLeft, docTop, docWidth, docHeight). Used
//      both when the inner scroller can't be re-resolved AND as the *only*
//      fallback when the page itself is the scroll context (no inner
//      scroller — `fb.docTop - window.scrollY` already tracks page scroll
//      correctly via the fixed overlay).
function computeFallbackBox(blockElement) {
  const rect = blockElement.getBoundingClientRect();
  const scrollTop  = window.pageYOffset || document.documentElement.scrollTop;
  const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

  const out = {
    docLeft:   parseFloat((rect.left + scrollLeft).toFixed(1)),
    docTop:    parseFloat((rect.top  + scrollTop).toFixed(1)),
    docWidth:  parseFloat(rect.width.toFixed(1)),
    docHeight: parseFloat(rect.height.toFixed(1)),
  };

  const sc = findScrollContainer(blockElement);
  if (sc) {
    const scRect = sc.getBoundingClientRect();
    out.containerAnchor  = window.FuzzyAnchor.generate(sc);
    out.containerOffsetX = parseFloat((rect.left - scRect.left + sc.scrollLeft).toFixed(1));
    out.containerOffsetY = parseFloat((rect.top  - scRect.top  + sc.scrollTop ).toFixed(1));
  }

  return out;
}

function restoreOverlay() {
  const stillActive = window.AdnotaState.isVisible && _overlayModes.has(window.AdnotaState.mode);
  captureSvg.style.display = stillActive ? 'block' : 'none';
  captureSvg.style.pointerEvents = stillActive ? 'auto' : 'none';
}

// Fixed-position container for every marker wrapper. Lazily created on first
// render. See #adnota-marker-overlay in marker.css for why this exists.
function getMarkerOverlay() {
  let overlay = document.getElementById('adnota-marker-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'adnota-marker-overlay';
    overlay.setAttribute('data-adnota-ui', '1');
    document.documentElement.appendChild(overlay);
  }
  return overlay;
}

// ── Save + undo helper ──────────────────────────────────────────────────────
async function saveMarkerPayload(blockElement, payload) {
  payload.fallbackBox = computeFallbackBox(blockElement);
  window.AdnotaLog?.event('marker', 'commit', {
    id: payload.uuid,
    shapeType: payload.shapeType,
    color: payload.color,
    strokeWidth: payload.strokeWidth,
    filled: payload.filled,
    anchor: payload.anchor ? { sel: payload.anchor.cssSelector, tag: payload.anchor.tagName } : null,
    block: window.AdnotaLog.el(blockElement),
  });
  window.AdnotaMarker.renderMarker(blockElement, payload);
  restoreOverlay();

  if (window.AdnotaStorage) {
    await window.AdnotaStorage.saveItem(location.hostname, location.pathname, payload);
  }

  const capturedUuid = payload.uuid;
  const capturedDomain = location.hostname;
  const capturedShape = payload.shapeType;
  window.AdnotaUndo.push({
    undo: async () => {
      window.AdnotaLog?.event('marker', 'undo', { id: capturedUuid, shapeType: capturedShape });
      const el = document.querySelector(`.adnota-marker-wrapper[data-uuid="${capturedUuid}"]`);
      if (el) el.remove();
      if (window.AdnotaStorage) {
        await window.AdnotaStorage.deleteItem(capturedDomain, 'uuid', capturedUuid);
      }
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// FREEHAND PEN
// ═════════════════════════════════════════════════════════════════════════════

function handlePenDown(e) {
  currentPathNodes = [{ x: e.clientX, y: e.clientY }];
  capturePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  capturePath.setAttribute('stroke', getStrokeColor());
  capturePath.setAttribute('stroke-width', String(window.AdnotaState.strokeWidth));
  capturePath.setAttribute('fill', 'none');
  capturePath.setAttribute('stroke-linecap', 'round');
  capturePath.setAttribute('stroke-linejoin', 'round');
  captureSvg.appendChild(capturePath);
  updateLivePath();
}

function handlePenMove(e) {
  if (!capturePath) return;
  currentPathNodes.push({ x: e.clientX, y: e.clientY });
  updateLivePath();
}

async function handlePenUp(e) {
  if (!capturePath) return;

  // A tap with no real stroke — drop it and stay in pen mode (matches the
  // shape tools' "too-small drag cancels" behavior, so a misclick doesn't
  // kick the user out).
  if (currentPathNodes.length < 3) {
    capturePath.remove();
    capturePath = null;
    currentPathNodes = [];
    return;
  }

  const blockElement = findAnchorBlock(currentPathNodes[0].x, currentPathNodes[0].y);
  const anchor = window.FuzzyAnchor.generate(blockElement);
  const _id = Date.now() + Math.random().toString();

  const simplifiedPoints = simplifyPathRDP(currentPathNodes, 2.0);
  const box = blockElement.getBoundingClientRect();
  const normalizedPath = simplifiedPoints.map(p => ({
    px: parseFloat(((p.x - box.left) / box.width  * 100).toFixed(2)),
    py: parseFloat(((p.y - box.top)  / box.height * 100).toFixed(2))
  }));

  const payload = {
    anchor, _id,
    action: 'MARKER',
    uuid: _id,
    shapeType: 'freehand',
    drawing: normalizedPath,
    color: getStrokeColor(),
    strokeWidth: window.AdnotaState.strokeWidth
  };

  capturePath.remove();
  capturePath = null;

  await saveMarkerPayload(blockElement, payload);
}

function updateLivePath() {
  if (currentPathNodes.length < 2) return;
  const d = currentPathNodes.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(' ');
  capturePath.setAttribute('d', d);
}

// ═════════════════════════════════════════════════════════════════════════════
// ARROW TOOL
// ═════════════════════════════════════════════════════════════════════════════

function handleArrowDown(e) {
  shapeOrigin = { x: e.clientX, y: e.clientY };

  // Create a <line> for live preview
  captureShape = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  captureShape.setAttribute('x1', e.clientX);
  captureShape.setAttribute('y1', e.clientY);
  captureShape.setAttribute('x2', e.clientX);
  captureShape.setAttribute('y2', e.clientY);
  captureShape.setAttribute('stroke', getStrokeColor());
  captureShape.setAttribute('stroke-width', String(window.AdnotaState.strokeWidth));
  captureShape.setAttribute('stroke-linecap', 'round');

  // Live arrowhead marker
  const defs = captureSvg.querySelector('defs#adnota-live-defs') || (() => {
    const d = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    d.id = 'adnota-live-defs';
    captureSvg.insertBefore(d, captureSvg.firstChild);
    return d;
  })();
  // Remove old live arrow marker if any
  const oldMarker = defs.querySelector('#adnota-live-arrowhead');
  if (oldMarker) oldMarker.remove();

  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'adnota-live-arrowhead');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('refX', '5');
  marker.setAttribute('refY', '3');
  marker.setAttribute('orient', 'auto');
  marker.setAttribute('markerUnits', 'strokeWidth');
  const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  polygon.setAttribute('points', '0 0, 6 3, 0 6');
  polygon.setAttribute('fill', getStrokeColor());
  marker.appendChild(polygon);
  defs.appendChild(marker);

  captureShape.setAttribute('marker-end', 'url(#adnota-live-arrowhead)');
  captureSvg.appendChild(captureShape);
}

function handleArrowMove(e) {
  if (!captureShape) return;
  captureShape.setAttribute('x2', e.clientX);
  captureShape.setAttribute('y2', e.clientY);
}

async function handleArrowUp(e) {
  if (!captureShape || !shapeOrigin) return;
  const endX = e.clientX, endY = e.clientY;

  // Too small — cancel
  const dist = Math.sqrt(Math.pow(endX - shapeOrigin.x, 2) + Math.pow(endY - shapeOrigin.y, 2));
  if (dist < 8) {
    captureShape.remove();
    captureShape = null;
    shapeOrigin = null;
    return;
  }

  const blockElement = findAnchorBlock(shapeOrigin.x, shapeOrigin.y);
  const anchor = window.FuzzyAnchor.generate(blockElement);
  const _id = Date.now() + Math.random().toString();
  const box = blockElement.getBoundingClientRect();

  const normalizedPath = [
    { px: parseFloat(((shapeOrigin.x - box.left) / box.width * 100).toFixed(2)),
      py: parseFloat(((shapeOrigin.y - box.top) / box.height * 100).toFixed(2)) },
    { px: parseFloat(((endX - box.left) / box.width * 100).toFixed(2)),
      py: parseFloat(((endY - box.top) / box.height * 100).toFixed(2)) }
  ];

  const payload = {
    anchor, _id,
    action: 'MARKER',
    uuid: _id,
    shapeType: 'arrow',
    drawing: normalizedPath,
    isArrow: true,
    color: getStrokeColor(),
    strokeWidth: window.AdnotaState.strokeWidth
  };

  captureShape.remove();
  captureShape = null;
  shapeOrigin = null;

  await saveMarkerPayload(blockElement, payload);
}

// ═════════════════════════════════════════════════════════════════════════════
// RECTANGLE TOOL
// ═════════════════════════════════════════════════════════════════════════════

function handleRectDown(e) {
  shapeOrigin = { x: e.clientX, y: e.clientY };
  captureShape = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  captureShape.setAttribute('x', e.clientX);
  captureShape.setAttribute('y', e.clientY);
  captureShape.setAttribute('width', '0');
  captureShape.setAttribute('height', '0');
  captureShape.setAttribute('rx', '2');
  const color = getStrokeColor();
  if (window.AdnotaState.filled) {
    captureShape.setAttribute('fill', color);
    captureShape.setAttribute('stroke', 'none');
  } else {
    captureShape.setAttribute('stroke', color);
    captureShape.setAttribute('stroke-width', String(window.AdnotaState.strokeWidth));
    captureShape.setAttribute('fill', 'none');
    captureShape.setAttribute('stroke-linejoin', 'round');
  }
  captureSvg.appendChild(captureShape);
}

function handleRectMove(e) {
  if (!captureShape || !shapeOrigin) return;
  const x = Math.min(shapeOrigin.x, e.clientX);
  const y = Math.min(shapeOrigin.y, e.clientY);
  const w = Math.abs(e.clientX - shapeOrigin.x);
  const h = Math.abs(e.clientY - shapeOrigin.y);
  captureShape.setAttribute('x', x);
  captureShape.setAttribute('y', y);
  captureShape.setAttribute('width', w);
  captureShape.setAttribute('height', h);
}

async function handleRectUp(e) {
  if (!captureShape || !shapeOrigin) return;
  const endX = e.clientX, endY = e.clientY;
  const w = Math.abs(endX - shapeOrigin.x);
  const h = Math.abs(endY - shapeOrigin.y);

  // Too small — cancel
  if (w < 5 && h < 5) {
    captureShape.remove();
    captureShape = null;
    shapeOrigin = null;
    return;
  }

  const topLeft = { x: Math.min(shapeOrigin.x, endX), y: Math.min(shapeOrigin.y, endY) };
  const blockElement = findAnchorBlock(topLeft.x + w / 2, topLeft.y + h / 2);
  const anchor = window.FuzzyAnchor.generate(blockElement);
  const _id = Date.now() + Math.random().toString();
  const box = blockElement.getBoundingClientRect();

  const payload = {
    anchor, _id,
    action: 'MARKER',
    uuid: _id,
    shapeType: 'rect',
    shape: {
      x:  parseFloat(((topLeft.x - box.left) / box.width * 100).toFixed(2)),
      y:  parseFloat(((topLeft.y - box.top) / box.height * 100).toFixed(2)),
      w:  parseFloat((w / box.width * 100).toFixed(2)),
      h:  parseFloat((h / box.height * 100).toFixed(2)),
    },
    color: getStrokeColor(),
    strokeWidth: window.AdnotaState.strokeWidth,
    filled: !!window.AdnotaState.filled
  };

  captureShape.remove();
  captureShape = null;
  shapeOrigin = null;

  await saveMarkerPayload(blockElement, payload);
}

// ═════════════════════════════════════════════════════════════════════════════
// ELLIPSE TOOL
// ═════════════════════════════════════════════════════════════════════════════

function handleEllipseDown(e) {
  shapeOrigin = { x: e.clientX, y: e.clientY };
  captureShape = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
  captureShape.setAttribute('cx', e.clientX);
  captureShape.setAttribute('cy', e.clientY);
  captureShape.setAttribute('rx', '0');
  captureShape.setAttribute('ry', '0');
  const color = getStrokeColor();
  if (window.AdnotaState.filled) {
    captureShape.setAttribute('fill', color);
    captureShape.setAttribute('stroke', 'none');
  } else {
    captureShape.setAttribute('stroke', color);
    captureShape.setAttribute('stroke-width', String(window.AdnotaState.strokeWidth));
    captureShape.setAttribute('fill', 'none');
  }
  captureSvg.appendChild(captureShape);
}

function handleEllipseMove(e) {
  if (!captureShape || !shapeOrigin) return;
  const cx = (shapeOrigin.x + e.clientX) / 2;
  const cy = (shapeOrigin.y + e.clientY) / 2;
  const rx = Math.abs(e.clientX - shapeOrigin.x) / 2;
  const ry = Math.abs(e.clientY - shapeOrigin.y) / 2;
  captureShape.setAttribute('cx', cx);
  captureShape.setAttribute('cy', cy);
  captureShape.setAttribute('rx', rx);
  captureShape.setAttribute('ry', ry);
}

async function handleEllipseUp(e) {
  if (!captureShape || !shapeOrigin) return;
  const endX = e.clientX, endY = e.clientY;
  const rx = Math.abs(endX - shapeOrigin.x) / 2;
  const ry = Math.abs(endY - shapeOrigin.y) / 2;

  // Too small — cancel
  if (rx < 4 && ry < 4) {
    captureShape.remove();
    captureShape = null;
    shapeOrigin = null;
    return;
  }

  const cx = (shapeOrigin.x + endX) / 2;
  const cy = (shapeOrigin.y + endY) / 2;
  const blockElement = findAnchorBlock(cx, cy);
  const anchor = window.FuzzyAnchor.generate(blockElement);
  const _id = Date.now() + Math.random().toString();
  const box = blockElement.getBoundingClientRect();

  const payload = {
    anchor, _id,
    action: 'MARKER',
    uuid: _id,
    shapeType: 'ellipse',
    shape: {
      cx: parseFloat(((cx - box.left) / box.width * 100).toFixed(2)),
      cy: parseFloat(((cy - box.top) / box.height * 100).toFixed(2)),
      rx: parseFloat((rx / box.width * 100).toFixed(2)),
      ry: parseFloat((ry / box.height * 100).toFixed(2)),
    },
    color: getStrokeColor(),
    strokeWidth: window.AdnotaState.strokeWidth,
    filled: !!window.AdnotaState.filled
  };

  captureShape.remove();
  captureShape = null;
  shapeOrigin = null;

  await saveMarkerPayload(blockElement, payload);
}

// ═════════════════════════════════════════════════════════════════════════════
// TEXT TOOL
// ═════════════════════════════════════════════════════════════════════════════

const _textFontSizes = { 2: 16, 4: 24, 8: 36 };
let activeTextEditor = null; // the currently open editable text element

function getTextFontSize() {
  return _textFontSizes[window.AdnotaState.strokeWidth] || 24;
}

function commitActiveText() {
  if (!activeTextEditor) return;
  const editor = activeTextEditor;
  activeTextEditor = null;

  const text = editor.el.textContent.trim();
  if (!text) {
    // Empty — discard
    if (editor.wrapper) editor.wrapper.remove();
    return;
  }

  // Finalize: make non-editable, save to storage
  editor.el.contentEditable = 'false';
  editor.el.style.cursor = 'default';
  editor.el.style.outline = 'none';
  editor.el.style.minWidth = '';
  editor.el.blur();

  const blockElement = editor.blockElement;
  const box = blockElement.getBoundingClientRect();
  const elRect = editor.el.getBoundingClientRect();

  // If this is an edit of an existing text, update payload in place
  if (editor.isEdit && editor.wrapper._adnotaPayload) {
    const payload = editor.wrapper._adnotaPayload;
    payload.text = text;
    // Re-save
    if (window.AdnotaStorage) {
      window.AdnotaStorage.deleteItem(location.hostname, 'uuid', payload.uuid).then(() => {
        window.AdnotaStorage.saveItem(location.hostname, location.pathname, payload);
      });
    }
    return;
  }

  const anchor = window.FuzzyAnchor.generate(blockElement);
  const _id = Date.now() + Math.random().toString();

  const payload = {
    anchor, _id,
    action: 'MARKER',
    uuid: _id,
    shapeType: 'text',
    text: text,
    textPos: {
      x: parseFloat(((editor.screenX - box.left) / box.width * 100).toFixed(2)),
      y: parseFloat(((editor.screenY - box.top) / box.height * 100).toFixed(2)),
    },
    color: editor.color,
    fontSize: editor.fontSize,
    strokeWidth: window.AdnotaState.strokeWidth
  };

  // Remove the live-editing wrapper and re-render via renderMarker for proper sync
  editor.wrapper.remove();
  saveMarkerPayload(blockElement, payload);
}

function handleTextClick(e) {
  if (window.AdnotaState.mode !== 'text') return;
  if (e.shiftKey) return;                              // Shift shortcut owns the click
  if (isToolbarHit(e)) return;
  if (e.target.closest('.adnota-select-box')) return;
  if (e.target.closest('[data-adnota-ui]')) return;

  // If clicking on an existing text marker, start editing it instead
  const existingText = e.target.closest('.adnota-text-content');
  if (existingText) return; // let dblclick handle editing

  // Commit any active editor first
  commitActiveText();

  e.preventDefault();
  e.stopPropagation();

  // Hide mode must never block work — reveal before placing the editor.
  window.AdnotaVisibility.show();

  const screenX = e.clientX;
  const screenY = e.clientY;

  // Find anchor block
  let targetNode = document.elementFromPoint(screenX, screenY);
  if (!targetNode || targetNode.nodeType !== Node.ELEMENT_NODE) targetNode = document.body;
  // Skip Adnota UI elements
  if (targetNode.closest('[data-adnota-ui]')) {
    targetNode = document.body;
  }
  const blockElement = targetNode.closest('p, div, section, article, main, li, h1, h2, h3, h4, td') || document.body;

  const color = getStrokeColor();
  const fontSize = getTextFontSize();

  // Create a temporary wrapper for live editing — pin to document origin
  // so the textEl's absolute coordinates work correctly.
  const wrapper = document.createElement('div');
  wrapper.className = 'adnota-marker-wrapper adnota-text-wrapper';
  wrapper.setAttribute('data-adnota-ui', '1');
  wrapper.style.pointerEvents = 'auto';
  wrapper.style.top = '0';
  wrapper.style.left = '0';
  wrapper.style.width = '100%';
  wrapper.style.height = '0';

  const textEl = document.createElement('div');
  textEl.className = 'adnota-text-content';
  textEl.contentEditable = 'true';
  textEl.spellcheck = false;
  Object.assign(textEl.style, {
    position: 'absolute',
    left: screenX + 'px',
    top: (screenY + window.pageYOffset) + 'px',
    color: color,
    fontSize: fontSize + 'px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontWeight: '500',
    lineHeight: '1.3',
    minWidth: '20px',
    padding: '2px 4px',
    outline: '1px dashed rgba(124, 58, 237, 0.5)',
    background: 'rgba(15, 15, 15, 0.05)',
    borderRadius: '2px',
    cursor: 'text',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxWidth: '400px',
    zIndex: '2147483644',
  });
  wrapper.appendChild(textEl);
  document.documentElement.appendChild(wrapper);

  // Focus the editor
  textEl.focus();

  activeTextEditor = {
    el: textEl,
    wrapper: wrapper,
    blockElement: blockElement,
    screenX: screenX,
    screenY: screenY,
    color: color,
    fontSize: fontSize,
    isEdit: false,
  };

  // Commit on blur (clicking away)
  textEl.addEventListener('blur', () => {
    // Small delay to avoid race with other click handlers
    setTimeout(() => {
      if (activeTextEditor && activeTextEditor.el === textEl) {
        commitActiveText();
      }
    }, 100);
  });

  // Commit on Enter (Shift+Enter for newline), Escape to cancel
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      textEl.textContent = '';
      commitActiveText(); // will discard empty
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitActiveText();
    }
    // Stop propagation so Ctrl+Z doesn't trigger AdnotaUndo while typing
    e.stopPropagation();
  });
}

// Double-click to edit existing text (works in both text and select modes)
function handleTextDblClick(e) {
  if (window.AdnotaState.mode !== 'select' && window.AdnotaState.mode !== 'text') return;

  const textContent = e.target.closest('.adnota-text-content');
  if (!textContent) return;

  const wrapper = textContent.closest('.adnota-marker-wrapper');
  if (!wrapper || !wrapper._adnotaPayload) return;

  e.preventDefault();
  e.stopPropagation();

  // Clear select UI if active
  clearSelection();

  // Commit any active editor first
  commitActiveText();

  // Make editable
  textContent.contentEditable = 'true';
  textContent.style.cursor = 'text';
  textContent.style.outline = '1px dashed rgba(124, 58, 237, 0.5)';
  textContent.style.minWidth = '20px';
  wrapper.style.pointerEvents = 'auto';
  textContent.focus();

  // Select all text for easy replacement
  const range = document.createRange();
  range.selectNodeContents(textContent);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  activeTextEditor = {
    el: textContent,
    wrapper: wrapper,
    blockElement: wrapper._adnotaAnchorElement || document.body,
    screenX: 0, screenY: 0, // not needed for edits
    color: wrapper._adnotaPayload.color,
    fontSize: wrapper._adnotaPayload.fontSize,
    isEdit: true,
  };

  textContent.addEventListener('blur', () => {
    setTimeout(() => {
      if (activeTextEditor && activeTextEditor.el === textContent) {
        commitActiveText();
      }
    }, 100);
  }, { once: true });

  textContent.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      // Restore original text on cancel
      textContent.textContent = wrapper._adnotaPayload.text;
      commitActiveText();
    } else if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      commitActiveText();
    }
    ev.stopPropagation();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// UNIFIED POINTER HANDLERS — dispatch to the active tool
// ═════════════════════════════════════════════════════════════════════════════

// Abort any in-flight draw and reset capture state. Used by pointercancel
// (browser-killed gesture: context menu, etc.) and the pointermove reconcile
// (released-outside-window detection). All four shape tools share the same
// transient state, so one helper resets all of it.
function abortInFlightDraw() {
  if (!capturePath && !captureShape) return;
  if (capturePath)  { capturePath.remove();  capturePath  = null; }
  if (captureShape) { captureShape.remove(); captureShape = null; }
  currentPathNodes = [];
  shapeOrigin = null;
}

function handlePointerDown(e) {
  const mode = window.AdnotaState.mode;
  if (!_overlayModes.has(mode)) return;
  if (isToolbarHit(e)) return;
  e.preventDefault();

  // Capture pointer events for this gesture so a release outside the
  // browser viewport still fires pointerup here. Without this, the user
  // could mousedown inside, drag outside, release outside, and find the
  // draw "stuck in progress" because pointerup was never delivered. The
  // pointermove reconcile below is the belt-and-suspenders for the case
  // where the OS swallows mouseup entirely (alt-tab to another app, etc.).
  try { captureSvg.setPointerCapture(e.pointerId); } catch (_) {}

  // Hide mode must never block work — reveal before the stroke starts so the
  // user can see what they're drawing.
  window.AdnotaVisibility.show();

  switch (mode) {
    case 'pen':     handlePenDown(e); break;
    case 'arrow':   handleArrowDown(e); break;
    case 'rect':    handleRectDown(e); break;
    case 'ellipse': handleEllipseDown(e); break;
  }
}

function handlePointerMove(e) {
  const mode = window.AdnotaState.mode;
  if (!_overlayModes.has(mode)) return;

  // Reconcile-on-activity, mirrors reconcileShiftState's pattern: if we
  // think we're mid-draw but the pointer reports no buttons pressed, the
  // user released somewhere we never heard about (alt-tabbed and released
  // on another app, OS swallowed the mouseup, etc.). Abort cleanly so the
  // next pointerdown starts fresh — without this the live shape keeps
  // tracking the cursor and the user has to click to "finish" it, often
  // saving a malformed shape at the wrong coords.
  if (e.buttons === 0 && (capturePath || captureShape)) {
    abortInFlightDraw();
    return;
  }

  e.preventDefault();

  switch (mode) {
    case 'pen':     handlePenMove(e); break;
    case 'arrow':   handleArrowMove(e); break;
    case 'rect':    handleRectMove(e); break;
    case 'ellipse': handleEllipseMove(e); break;
  }
}

async function handlePointerUp(e) {
  const mode = window.AdnotaState.mode;
  if (!_overlayModes.has(mode)) return;
  e.preventDefault();

  switch (mode) {
    case 'pen':     await handlePenUp(e); break;
    case 'arrow':   await handleArrowUp(e); break;
    case 'rect':    await handleRectUp(e); break;
    case 'ellipse': await handleEllipseUp(e); break;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// RENDER MARKER — handles all shape types for both live creation and restore
// ═════════════════════════════════════════════════════════════════════════════

// Bug 1 fix: Define AdnotaMarker BEFORE initCaptureOverlay and AdnotaState.subscribe
//
// resolveAnchorRect — viewport-coords bounding box of the marker's anchor.
// Normally just `anchorElement.getBoundingClientRect()`, but when the restorer
// is rendering via fallback (FuzzyAnchor missed the original block), we
// reconstruct the rect from persisted offsets:
//
//   - Container fallback: anchorElement is the scroll-container ancestor and
//     payload._fallbackContainer === anchorElement is the in-memory sentinel.
//     Rect = container's viewport rect + stored offset - current scroll.
//     Tracks the user's scroll naturally on every site.
//
//   - Doc-pixel fallback: anchorElement === document.documentElement and we
//     return absolute document-pixel coords. Used only when the scroll
//     container can't be re-found.
function resolveAnchorRect(anchorElement, payload) {
  const fb = payload.fallbackBox;
  if (!fb) return anchorElement.getBoundingClientRect();

  if (anchorElement === payload._fallbackContainer && fb.containerOffsetY != null) {
    const scRect = anchorElement.getBoundingClientRect();
    return {
      left:   scRect.left + fb.containerOffsetX - anchorElement.scrollLeft,
      top:    scRect.top  + fb.containerOffsetY - anchorElement.scrollTop,
      width:  fb.docWidth,
      height: fb.docHeight,
    };
  }

  if (anchorElement === document.documentElement && fb.docLeft != null) {
    const scrollTop  = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
    return {
      left:   fb.docLeft - scrollLeft,
      top:    fb.docTop  - scrollTop,
      width:  fb.docWidth,
      height: fb.docHeight,
    };
  }

  return anchorElement.getBoundingClientRect();
}

window.AdnotaMarker = {
  // Drop every rendered shape from the DOM. Called on SPA URL change so
  // shapes from /chats/<uuid-A> don't bleed into /chats/<uuid-B> on app
  // shells where React doesn't unmount our overlay (it lives outside
  // React's tree under data-adnota-ui). Storage is left untouched —
  // subsequent restoration will repaint whatever belongs to the new URL.
  // Listener triads on each wrapper auto-clean via the parent-childList
  // MutationObserver installed by AdnotaUI.bindAnchorSync.
  tearDownAll: function () {
    const overlay = document.getElementById('adnota-marker-overlay');
    if (overlay) overlay.replaceChildren();
  },

  // Tear down a single marker wrapper by uuid. Used by the restorer's tier
  // upgrade path: when a marker initially rendered at tier 2 (container
  // ancestor) or tier 3 (doc pixels) and a later mutation pass finally
  // resolves the original tier 1 anchor, the existing wrapper has to be
  // removed before renderMarker can re-render at the right spot
  // (renderMarker's own duplicate-uuid guard would otherwise short-circuit).
  // Idempotent — returns false if no wrapper exists for the given uuid.
  tearDownById: function (uuid) {
    const overlay = document.getElementById('adnota-marker-overlay');
    if (!overlay) return false;
    const wrapper = overlay.querySelector(`.adnota-marker-wrapper[data-uuid="${uuid}"]`);
    if (!wrapper) return false;
    wrapper._adnotaCleanup?.();
    wrapper.remove();
    return true;
  },

  renderMarker: function (anchorElement, payload) {
    const shapeType = payload.shapeType || (payload.isArrow ? 'arrow' : 'freehand');

    // Validate payload per shape type
    if ((shapeType === 'freehand' || shapeType === 'arrow') && (!payload.drawing || !Array.isArray(payload.drawing))) return;
    if ((shapeType === 'rect' || shapeType === 'ellipse') && !payload.shape) return;
    if (shapeType === 'text' && !payload.text) return;

    const existing = document.querySelector(`.adnota-marker-wrapper[data-uuid="${payload.uuid}"]`);
    if (existing) return;

    // ── TEXT SHAPE — uses HTML, not SVG ──────────────────────────────────
    if (shapeType === 'text') {
      const wrapper = document.createElement('div');
      wrapper.className = 'adnota-marker-wrapper';
      wrapper.setAttribute('data-adnota-ui', '1');
      wrapper.dataset.uuid = payload.uuid;
      wrapper.dataset.shapeType = 'text';
      // Pin to document origin so textEl absolute coords work correctly
      wrapper.style.top = '0';
      wrapper.style.left = '0';
      wrapper.style.width = '0';
      wrapper.style.height = '0';
      wrapper.style.overflow = 'visible';

      const textEl = document.createElement('div');
      textEl.className = 'adnota-text-content';
      textEl.textContent = payload.text;
      Object.assign(textEl.style, {
        position: 'absolute',
        color: payload.color || '#fbc02d',
        fontSize: (payload.fontSize || 24) + 'px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontWeight: '500',
        lineHeight: '1.3',
        padding: '2px 4px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxWidth: '400px',
        width: 'max-content',
        cursor: 'default',
        userSelect: 'none',
      });
      wrapper.appendChild(textEl);
      wrapper._adnotaPayload = payload;
      wrapper._adnotaAnchorElement = anchorElement;
      getMarkerOverlay().appendChild(wrapper);

      function syncTextPos() {
        if (!wrapper.parentNode) return;
        const rect = resolveAnchorRect(anchorElement, payload);
        // Defensive: bail on a degenerate anchor rect. Same shape as the
        // SVG syncBounds guard — without this, "NaNpx" silently fails CSS
        // parsing and the text marker parks at a stale or default position
        // (worse UX than the console-spamming SVG path because nothing
        // signals the problem). Next observer/scroll tick retries.
        if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) ||
            rect.width <= 0 || rect.height <= 0) {
          return;
        }
        // Also skip if the legacy payload itself has non-finite coords.
        const tp = payload.textPos;
        if (!tp || !Number.isFinite(tp.x) || !Number.isFinite(tp.y)) return;
        // Wrapper lives in the fixed-position #adnota-marker-overlay, so its
        // children use viewport coords (no scrollY/X addition needed).
        textEl.style.left = (rect.left + (tp.x / 100) * rect.width) + 'px';
        textEl.style.top  = (rect.top  + (tp.y / 100) * rect.height) + 'px';
      }

      window.AdnotaUI.bindAnchorSync(wrapper, anchorElement, syncTextPos);
      return;
    }

    // ── SVG SHAPES (freehand, arrow, rect, ellipse) ─────────────────────
    const wrapper = document.createElement('div');
    wrapper.className = 'adnota-marker-wrapper';
    wrapper.setAttribute('data-adnota-ui', '1');
    wrapper.dataset.uuid = payload.uuid;
    wrapper.dataset.shapeType = shapeType;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    let shapeEl;

    const color = payload.color || '#fbc02d';
    const sw = String(payload.strokeWidth || 4);

    if (shapeType === 'rect') {
      shapeEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      shapeEl.setAttribute('rx', '2');
      if (payload.filled) {
        shapeEl.setAttribute('fill', color);
        shapeEl.setAttribute('stroke', 'none');
      } else {
        shapeEl.setAttribute('stroke', color);
        shapeEl.setAttribute('stroke-width', sw);
        shapeEl.setAttribute('fill', 'none');
        shapeEl.setAttribute('stroke-linejoin', 'round');
      }
    } else if (shapeType === 'ellipse') {
      shapeEl = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      if (payload.filled) {
        shapeEl.setAttribute('fill', color);
        shapeEl.setAttribute('stroke', 'none');
      } else {
        shapeEl.setAttribute('stroke', color);
        shapeEl.setAttribute('stroke-width', sw);
        shapeEl.setAttribute('fill', 'none');
      }
    } else {
      // freehand or arrow — use a <path>
      shapeEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      shapeEl.setAttribute('stroke', color);
      shapeEl.setAttribute('stroke-width', sw);
      shapeEl.setAttribute('fill', 'none');
      shapeEl.setAttribute('stroke-linecap', 'round');
      shapeEl.setAttribute('stroke-linejoin', 'round');

      if (shapeType === 'arrow' || payload.isArrow) {
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.setAttribute('id', `arrowhead-${payload.uuid}`);
        marker.setAttribute('markerWidth', '6');
        marker.setAttribute('markerHeight', '6');
        marker.setAttribute('refX', '5');
        marker.setAttribute('refY', '3');
        marker.setAttribute('orient', 'auto');
        marker.setAttribute('markerUnits', 'strokeWidth');
        const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        polygon.setAttribute('points', '0 0, 6 3, 0 6');
        polygon.setAttribute('fill', color);
        marker.appendChild(polygon);
        defs.appendChild(marker);
        svg.appendChild(defs);
        shapeEl.setAttribute('marker-end', `url(#arrowhead-${payload.uuid})`);
      }
    }

    svg.appendChild(shapeEl);
    wrapper.appendChild(svg);
    // Stash payload + anchor for select-tool operations (delete, undo, move).
    wrapper._adnotaPayload = payload;
    wrapper._adnotaAnchorElement = anchorElement;
    getMarkerOverlay().appendChild(wrapper);

    function syncBounds() {
      if (!wrapper.parentNode) return;
      const rect = resolveAnchorRect(anchorElement, payload);
      // Defensive: bail if the anchor's rect is degenerate. The next
      // ResizeObserver / scroll tick will retry once the host has laid out
      // the element. Belt-and-suspenders against findAnchorBlock's walk-up
      // (which fixes new draws) — this also silences legacy payloads stored
      // before the walk-up fix when they re-render against a sibling that
      // still reports zero dims.
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) ||
          rect.width <= 0 || rect.height <= 0) {
        return;
      }
      // Wrapper lives in the fixed-position #adnota-marker-overlay, so its
      // top/left use viewport coords directly — no scrollY/X addition.
      wrapper.style.top = `${rect.top}px`;
      wrapper.style.left = `${rect.left}px`;
      wrapper.style.width = `${rect.width}px`;
      wrapper.style.height = `${rect.height}px`;

      // Skip non-finite computed values — old payloads may have NaN coords
      // from pre-walk-up draws on degenerate anchors. Don't error, just
      // don't paint that attribute (the SVG retains its previous value or
      // default; the marker will look wrong but won't spam the console).
      const setNum = (attr, val) => {
        if (Number.isFinite(val)) shapeEl.setAttribute(attr, val);
      };

      if (shapeType === 'rect') {
        const s = payload.shape;
        setNum('x', (s.x / 100) * rect.width);
        setNum('y', (s.y / 100) * rect.height);
        setNum('width', (s.w / 100) * rect.width);
        setNum('height', (s.h / 100) * rect.height);
      } else if (shapeType === 'ellipse') {
        const s = payload.shape;
        setNum('cx', (s.cx / 100) * rect.width);
        setNum('cy', (s.cy / 100) * rect.height);
        setNum('rx', (s.rx / 100) * rect.width);
        setNum('ry', (s.ry / 100) * rect.height);
      } else if (shapeType === 'arrow' || payload.isArrow) {
        const start = payload.drawing[0];
        const end = payload.drawing[payload.drawing.length - 1];
        const x1 = (start.px / 100) * rect.width;
        const y1 = (start.py / 100) * rect.height;
        const x2 = (end.px / 100) * rect.width;
        const y2 = (end.py / 100) * rect.height;
        if (Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2)) {
          shapeEl.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`);
        }
      } else {
        // freehand
        const parts = [];
        let allFinite = true;
        for (let i = 0; i < payload.drawing.length; i++) {
          const p = payload.drawing[i];
          const px = (p.px / 100) * rect.width;
          const py = (p.py / 100) * rect.height;
          if (!Number.isFinite(px) || !Number.isFinite(py)) { allFinite = false; break; }
          parts.push((i === 0 ? `M ${px} ${py}` : `L ${px} ${py}`));
        }
        if (allFinite) shapeEl.setAttribute('d', parts.join(' '));
      }
    }

    window.AdnotaUI.bindAnchorSync(wrapper, anchorElement, syncBounds);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SELECT TOOL
// ═════════════════════════════════════════════════════════════════════════════

let selectedWrapper = null;
let selectBox = null;

function clearSelection() {
  if (selectBox) {
    if (selectBox._cleanup) selectBox._cleanup();
    selectBox.remove();
    selectBox = null;
  }
  selectedWrapper = null;
}

// Get the tight bounding box of the actual SVG shape content within a wrapper,
// returned in screen (viewport) coordinates.
function getShapeBBox(wrapper) {
  // Text wrappers have no SVG — use the text content element directly
  const textContent = wrapper.querySelector('.adnota-text-content');
  if (textContent) {
    const r = textContent.getBoundingClientRect();
    const pad = 4;
    return { top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
  }

  const svg = wrapper.querySelector('svg');
  if (!svg) return wrapper.getBoundingClientRect();

  // Find the actual shape element (path, rect, ellipse, line) — skip <defs>
  const shapeEl = svg.querySelector('path, rect, ellipse, line, circle');
  if (!shapeEl) return wrapper.getBoundingClientRect();

  try {
    const bbox = shapeEl.getBBox();
    // getBBox returns coordinates in SVG-local space. The SVG fills the wrapper
    // 1:1 (no viewBox transform), and the wrapper is absolutely positioned on the
    // page. Convert bbox to screen coords via the wrapper's position.
    const wrapperRect = wrapper.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    // SVG local coords map directly to the SVG element's client rect since there's
    // no viewBox (SVG uses default viewport = element size).
    const scaleX = svgRect.width / (svg.clientWidth || svgRect.width || 1);
    const scaleY = svgRect.height / (svg.clientHeight || svgRect.height || 1);

    const sw = parseFloat(shapeEl.getAttribute('stroke-width') || '4');
    const pad = sw / 2 + 4; // padding for stroke + comfort margin

    return {
      top:    svgRect.top + bbox.y * scaleY - pad,
      left:   svgRect.left + bbox.x * scaleX - pad,
      width:  bbox.width * scaleX + pad * 2,
      height: bbox.height * scaleY + pad * 2,
    };
  } catch {
    return wrapper.getBoundingClientRect();
  }
}

// Hit-test: is a screen point close to the actual shape content?
function isPointNearShape(wrapper, screenX, screenY) {
  const bbox = getShapeBBox(wrapper);
  // Generous hit area — 12px tolerance around the tight bounding box
  const tolerance = 12;
  return (
    screenX >= bbox.left - tolerance &&
    screenX <= bbox.left + bbox.width + tolerance &&
    screenY >= bbox.top - tolerance &&
    screenY <= bbox.top + bbox.height + tolerance
  );
}

// Undoable delete: hides the element, removes from storage, pushes undo to restore both.
// Shared by the Select-tool ✕ and the hover-✕. The `consumed` guard makes Ctrl+Z
// and the toast Undo button safely idempotent (matches highlighter.deleteHighlight).
async function deleteSelectedMarker(wrapper) {
  const uuid = wrapper.dataset.uuid;
  const payload = wrapper._adnotaPayload;
  const anchorElement = wrapper._adnotaAnchorElement;
  window.AdnotaLog?.event('marker', 'delete', {
    id: uuid, shapeType: payload?.shapeType, color: payload?.color,
  });

  // Hard remove (was display:none) so the wrapper's listener bag — window
  // scroll/resize + ResizeObserver — actually tears down. Hidden wrappers kept
  // those alive across the session and accumulated on long-lived tabs.
  wrapper._adnotaCleanup?.();
  wrapper.remove();
  clearSelection();
  hideHoverDeleteBtn();

  if (window.AdnotaStorage) {
    await window.AdnotaStorage.deleteItem(location.hostname, 'uuid', uuid);
  }

  let consumed = false;
  const undoEntry = {
    undo: async () => {
      if (consumed) return;
      consumed = true;
      if (window.AdnotaStorage && payload) {
        await window.AdnotaStorage.saveItem(location.hostname, location.pathname, payload);
      }
      if (anchorElement && payload) {
        window.AdnotaMarker.renderMarker(anchorElement, payload);
      }
      window.AdnotaUndo.remove(undoEntry);
    }
  };
  window.AdnotaUndo.push(undoEntry);

  window.AdnotaUI?.showToast?.('Marker deleted', {
    id: 'adnota-marker-toast',
    onUndo: () => undoEntry.undo(),
  });
}

// ── Hover delete ✕ for painted markers ──────────────────────────────────────
// Same pattern as the highlighter's hover-✕: a single floating button that
// follows whichever marker the cursor is over. Marker wrappers are
// pointer-events: none by default (so links underneath stay clickable), so we
// hit-test off mousemove rather than per-element pointerover. Suppressed in
// select / shift modes — those have their own select-box ✕ affordance.
let hoverDeleteBtnEl = null;
let hoverDeleteWrapper = null;

function ensureHoverDeleteBtn() {
  if (hoverDeleteBtnEl) return hoverDeleteBtnEl;
  hoverDeleteBtnEl = document.createElement('div');
  hoverDeleteBtnEl.className = 'adnota-select-delete adnota-marker-hover-delete';
  hoverDeleteBtnEl.setAttribute('data-adnota-ui', '1');
  hoverDeleteBtnEl.setAttribute('title', 'Delete');
  hoverDeleteBtnEl.textContent = '✕';
  hoverDeleteBtnEl.style.position = 'fixed';
  hoverDeleteBtnEl.style.display = 'none';
  hoverDeleteBtnEl.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    const wrapper = hoverDeleteWrapper;
    if (!wrapper) return;
    await deleteSelectedMarker(wrapper);
  });
  document.documentElement.appendChild(hoverDeleteBtnEl);
  return hoverDeleteBtnEl;
}

function hideHoverDeleteBtn() {
  if (hoverDeleteBtnEl) hoverDeleteBtnEl.style.display = 'none';
  hoverDeleteWrapper = null;
}

function showHoverDeleteBtn(wrapper) {
  const el = ensureHoverDeleteBtn();
  const bbox = getShapeBBox(wrapper);
  const SIZE = 20; // matches .adnota-select-delete width/height
  let left = bbox.left + bbox.width - SIZE / 2;
  let top = bbox.top - SIZE / 2;
  left = Math.max(2, Math.min(window.innerWidth - SIZE - 2, left));
  top = Math.max(2, Math.min(window.innerHeight - SIZE - 2, top));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.display = 'flex';
  hoverDeleteWrapper = wrapper;
}

let pendingMarkerHitTest = 0;
let lastMarkerPointer = null;
document.addEventListener('mousemove', (e) => {
  lastMarkerPointer = { x: e.clientX, y: e.clientY, target: e.target };
  if (pendingMarkerHitTest) return;
  pendingMarkerHitTest = requestAnimationFrame(() => {
    pendingMarkerHitTest = 0;
    if (!lastMarkerPointer) return;
    // Hidden mode (paint toggled off) is the only mode-level suppression — the
    // selected-wrapper carve-out below handles the overlap with the Select-tool's
    // own ✕ on whichever item is currently selected.
    if (document.documentElement.classList.contains('adnota-hidden')) {
      hideHoverDeleteBtn();
      return;
    }
    // Mid-stroke (active freehand path or shape drag) — never paint UI on top.
    if (capturePath || captureShape) {
      hideHoverDeleteBtn();
      return;
    }
    // Cursor on the ✕ itself → keep it visible.
    if (hoverDeleteBtnEl && lastMarkerPointer.target === hoverDeleteBtnEl) return;
    // Stand down on Adnota UI surfaces (dock, sticky, toolbar) — but allow
    // marker wrappers AND the captureSvg drawing overlay through, so hover-✕
    // works in pen / arrow / rect / ellipse modes too. In those modes wrappers
    // are pointer-events: none and the captureSvg owns the pointer, so without
    // these carve-outs the ✕ would never appear while a paint tool is active.
    const target = lastMarkerPointer.target;
    const isMarkerWrapper = target?.closest?.('.adnota-marker-wrapper');
    const isCaptureSvg = target === captureSvg;
    if (window.AdnotaUI?.isAdnotaElement(target) && !isMarkerWrapper && !isCaptureSvg) {
      hideHoverDeleteBtn();
      return;
    }
    const wrapper = hitTestMarker(lastMarkerPointer.x, lastMarkerPointer.y);
    // If the hovered wrapper is already selected (post SHIFT+drag, or any active
    // selection), the Select-tool's select-box ✕ is already painted on it — a
    // second hover-✕ stacks underneath and looks like a doubled ring.
    if (!wrapper || wrapper === selectedWrapper) {
      hideHoverDeleteBtn();
      return;
    }
    showHoverDeleteBtn(wrapper);
  });
}, { passive: true });

// Viewport changes invalidate cached bbox; next mousemove re-tests.
window.addEventListener('scroll', hideHoverDeleteBtn, { passive: true, capture: true });
window.addEventListener('resize', hideHoverDeleteBtn, { passive: true });

// Shift down or pointerdown both signal an intent that ends the hover state
// (drag-to-move, click-to-select, etc). Hiding here closes a gap where neither
// keydown nor pointerdown emits a mousemove, leaving the ✕ stranded at its
// last hover position throughout a drag.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') hideHoverDeleteBtn();
}, true);
document.addEventListener('pointerdown', (e) => {
  // Pointerdown on the ✕ itself is the click that's about to delete — keep it
  // visible so the click handler sees `hoverDeleteWrapper`.
  if (e.target === hoverDeleteBtnEl) return;
  hideHoverDeleteBtn();
}, true);

function showSelectionUI(wrapper) {
  clearSelection();
  selectedWrapper = wrapper;

  selectBox = document.createElement('div');
  selectBox.className = 'adnota-select-box';
  selectBox.setAttribute('data-adnota-ui', '1');

  // Delete button
  const delBtn = document.createElement('div');
  delBtn.className = 'adnota-select-delete';
  delBtn.textContent = '\u2715';
  delBtn.setAttribute('data-tooltip', 'Delete');
  delBtn.onclick = async (e) => {
    e.stopPropagation();
    await deleteSelectedMarker(wrapper);
  };
  selectBox.appendChild(delBtn);

  document.documentElement.appendChild(selectBox);

  function syncSelectBoxNow() {
    if (!selectBox || !selectedWrapper || !selectedWrapper.parentNode) {
      clearSelection();
      return;
    }
    const bbox = getShapeBBox(selectedWrapper);
    Object.assign(selectBox.style, {
      position: 'fixed',
      top: bbox.top + 'px',
      left: bbox.left + 'px',
      width: bbox.width + 'px',
      height: bbox.height + 'px',
    });
  }

  // rAF-throttled wrapper. Has to match the cadence of bindAnchorSync (which
  // uses the same pattern in lib/adnotaUI.js:183) — running synchronously
  // here would read the marker wrapper's getBoundingClientRect *before*
  // bindAnchorSync's rAF callback repositioned it, so the box would freeze
  // at the wrapper's stale pre-scroll position and only catch up on the
  // next wheel. Native browser scroll usually fires many tiny scroll events
  // per gesture so this race was invisible — but our wheel-passthrough
  // forwarder in DRAW mode emits one big scrollBy per wheel, exposing it.
  // Both rAF callbacks register during the same scroll event and run in
  // registration order next frame; bindAnchorSync was registered first
  // (when the wrapper was rendered) so its wrapper update lands before
  // syncSelectBox reads.
  let _selectBoxRaf = 0;
  function syncSelectBox() {
    if (_selectBoxRaf) return;
    _selectBoxRaf = requestAnimationFrame(() => {
      _selectBoxRaf = 0;
      syncSelectBoxNow();
    });
  }

  syncSelectBoxNow();
  // Capture-phase so we catch scrolls on internal scroll containers (app
  // shells like claude.ai / chatgpt.com put overflow:hidden on <body> and
  // scroll an inner div — scroll doesn't bubble, so a bubble-phase listener
  // would miss those events).
  window.addEventListener('scroll', syncSelectBox, { capture: true, passive: true });
  window.addEventListener('resize', syncSelectBox);

  selectBox._cleanup = () => {
    if (_selectBoxRaf) cancelAnimationFrame(_selectBoxRaf);
    window.removeEventListener('scroll', syncSelectBox, { capture: true });
    window.removeEventListener('resize', syncSelectBox);
  };
}

// Hit-test helper shared by click-to-select and pointerdown-to-drag. Picks the
// smallest visible wrapper whose shape is near the pointer.
function hitTestMarker(clientX, clientY) {
  const wrappers = document.querySelectorAll('.adnota-marker-wrapper');
  let bestWrapper = null;
  let bestArea = Infinity;
  for (const wrapper of wrappers) {
    // Hidden wrappers (direct display:none or ancestor .adnota-hidden) are not targetable.
    if (window.getComputedStyle(wrapper).display === 'none') continue;
    if (!isPointNearShape(wrapper, clientX, clientY)) continue;
    const bbox = getShapeBBox(wrapper);
    const area = bbox.width * bbox.height;
    if (area < bestArea) {
      bestArea = area;
      bestWrapper = wrapper;
    }
  }
  return bestWrapper;
}

// Drag state for move-in-select-mode. A single pointerdown kicks this off;
// pointermove only promotes to an active drag after the pointer travels beyond
// DRAG_THRESHOLD_PX, so a plain click still falls through to selection.
const DRAG_THRESHOLD_PX = 3;
let moveDragState = null;
let suppressNextClick = false;

function handleSelectPointerDown(e) {
  const inSelectMode = window.AdnotaState.mode === 'select';
  const shiftShortcut = e.shiftKey;
  if (!inSelectMode && !shiftShortcut) return;
  if (isToolbarHit(e)) return;
  if (e.button !== 0) return; // left-click only
  if (e.target.closest('.adnota-select-box')) return; // delete button handles itself
  if (e.target.closest('.adnota-text-content[contenteditable="true"]')) return; // editing — don't drag
  // Shift-shortcut defers to interactive page targets (links, buttons, inputs)
  // when the geometric hit would overlap them — but only when there's no paint
  // item directly in the way. We check hit-test first below, then decide.

  const wrapper = hitTestMarker(e.clientX, e.clientY);
  if (!wrapper) return;

  // Shift-shortcut with a paint item under the pointer: take the click. This
  // is the key win — a solid rect/ellipse used for redaction now absorbs
  // clicks instead of passing through to the link it was covering. Suppressing
  // the browser's default also kills the text-drag-selection that otherwise
  // paints highlights across the page while dragging.
  if (shiftShortcut && !inSelectMode) {
    e.preventDefault();
  }

  moveDragState = {
    wrapper,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    pointerId: e.pointerId,
  };
}

function handleSelectPointerMove(e) {
  if (!moveDragState) return;
  const dx = e.clientX - moveDragState.startX;
  const dy = e.clientY - moveDragState.startY;

  if (!moveDragState.moved) {
    if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    moveDragState.moved = true;
    // Cursor swap; the cursor-lock stylesheet in highlighter.js has an
    // `html.adnota-dragging` override that swaps every descendant to
    // `grabbing !important`, beating the select-mode arrow.
    document.documentElement.classList.add('adnota-dragging');
    // Retarget the selection box onto the wrapper we're actually dragging,
    // otherwise a stale bbox from a prior selection follows the drag.
    if (selectedWrapper !== moveDragState.wrapper) {
      showSelectionUI(moveDragState.wrapper);
    }
  }

  moveDragState.wrapper.style.transform = `translate(${dx}px, ${dy}px)`;
  if (selectBox) selectBox.style.transform = `translate(${dx}px, ${dy}px)`;
}

async function handleSelectPointerUp(e) {
  if (!moveDragState) return;
  const { wrapper, moved, startX, startY } = moveDragState;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  moveDragState = null;

  document.documentElement.classList.remove('adnota-dragging');

  if (!moved) {
    // Fall through to the normal click-to-select flow.
    return;
  }

  // Suppress the synthetic click that fires right after this pointerup — a
  // move shouldn't also register as a click on the (new) element beneath.
  suppressNextClick = true;

  const payload = wrapper._adnotaPayload;
  const anchorElement = wrapper._adnotaAnchorElement;
  if (!payload || !anchorElement) {
    wrapper.style.transform = '';
    return;
  }

  // Convert pixel delta to a percentage of the anchor rect, matching the
  // anchor-relative coord system used everywhere else. Route through
  // resolveAnchorRect so fallback-rendered markers (anchor = scroll
  // container, but coords are still original-block-relative) drag correctly.
  const rect = resolveAnchorRect(anchorElement, payload);
  if (rect.width === 0 || rect.height === 0) {
    wrapper.style.transform = '';
    return;
  }
  const dxPct = (dx / rect.width) * 100;
  const dyPct = (dy / rect.height) * 100;

  // Deep-clone original coords for undo; shallow copy is enough for shape/textPos.
  const oldSnapshot = {
    shape: payload.shape ? { ...payload.shape } : null,
    textPos: payload.textPos ? { ...payload.textPos } : null,
    drawing: payload.drawing ? payload.drawing.map(p => ({ ...p })) : null,
  };

  shiftMarkerPayload(payload, dxPct, dyPct);

  window.AdnotaLog?.event('marker', 'drag-commit', {
    id: payload.uuid,
    shapeType: payload.shapeType,
    dxPct: Math.round(dxPct * 100) / 100,
    dyPct: Math.round(dyPct * 100) / 100,
  });

  // Re-render from the updated payload. renderMarker early-exits if the uuid
  // is already on the page, so we must remove the old wrapper first.
  wrapper.remove();
  if (selectBox) { selectBox.style.transform = ''; clearSelection(); }
  window.AdnotaMarker.renderMarker(anchorElement, payload);

  // Persist: delete old row, save updated payload.
  if (window.AdnotaStorage) {
    await window.AdnotaStorage.deleteItem(location.hostname, 'uuid', payload.uuid);
    await window.AdnotaStorage.saveItem(location.hostname, location.pathname, payload);
  }

  // Re-select the moved marker so the user sees where it landed.
  const fresh = document.querySelector(`.adnota-marker-wrapper[data-uuid="${payload.uuid}"]`);
  if (fresh) showSelectionUI(fresh);

  // Undo: restore old coords + storage row.
  window.AdnotaUndo.push({
    undo: async () => {
      if (oldSnapshot.shape) payload.shape = oldSnapshot.shape;
      if (oldSnapshot.textPos) payload.textPos = oldSnapshot.textPos;
      if (oldSnapshot.drawing) payload.drawing = oldSnapshot.drawing;
      const current = document.querySelector(`.adnota-marker-wrapper[data-uuid="${payload.uuid}"]`);
      if (current) current.remove();
      clearSelection();
      window.AdnotaMarker.renderMarker(anchorElement, payload);
      if (window.AdnotaStorage) {
        await window.AdnotaStorage.deleteItem(location.hostname, 'uuid', payload.uuid);
        await window.AdnotaStorage.saveItem(location.hostname, location.pathname, payload);
      }
    },
  });
}

// Shifts all coordinate fields on a MARKER payload by (dxPct, dyPct). Every
// shape type stores its position as percentages of the anchor rect, so a
// uniform shift is all we need.
function shiftMarkerPayload(payload, dxPct, dyPct) {
  const type = payload.shapeType || (payload.isArrow ? 'arrow' : 'freehand');
  if (type === 'rect' && payload.shape) {
    payload.shape = { ...payload.shape, x: payload.shape.x + dxPct, y: payload.shape.y + dyPct };
  } else if (type === 'ellipse' && payload.shape) {
    payload.shape = { ...payload.shape, cx: payload.shape.cx + dxPct, cy: payload.shape.cy + dyPct };
  } else if (type === 'text' && payload.textPos) {
    payload.textPos = { x: payload.textPos.x + dxPct, y: payload.textPos.y + dyPct };
  } else if (payload.drawing) {
    payload.drawing = payload.drawing.map(p => ({ px: p.px + dxPct, py: p.py + dyPct }));
  }
}

function handleSelectClick(e) {
  const inSelectMode = window.AdnotaState.mode === 'select';
  const shiftShortcut = e.shiftKey;
  if (!inSelectMode && !shiftShortcut) return;
  if (isToolbarHit(e)) return;

  // A drag just committed — its pointerup bubbles into a synthetic click that
  // would otherwise clear or re-select. Swallow exactly one click.
  if (suppressNextClick) {
    suppressNextClick = false;
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  // Don't deselect when clicking the select box itself
  if (e.target.closest('.adnota-select-box')) return;

  const bestWrapper = hitTestMarker(e.clientX, e.clientY);
  if (bestWrapper) {
    e.preventDefault();
    e.stopPropagation();
    showSelectionUI(bestWrapper);
  } else if (inSelectMode) {
    // Select mode clicks on empty canvas clear the selection. Shift+click on
    // empty canvas in non-select mode is just a normal shift+click — let the
    // plain-click dismiss handler manage teardown.
    clearSelection();
  }
}

// Delete key handler for selected element. Works both inside Select mode and
// for ephemeral Shift+click selections in any other mode. Guarded against
// typing in inputs/textareas/contenteditable so the user's own Backspace in a
// page form doesn't nuke an annotation they happened to have selected.
document.addEventListener('keydown', (e) => {
  if (!selectedWrapper) return;
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
  e.preventDefault();
  deleteSelectedMarker(selectedWrapper);
});

// Plain click outside the selection while NOT in select mode dismisses a live
// Shift+click selection. Select mode has its own dismiss path inside
// handleSelectClick above so it doesn't need to run here.
function handleShiftSelectionDismiss(e) {
  if (!selectedWrapper) return;
  if (window.AdnotaState.mode === 'select') return;
  if (e.shiftKey) return;                               // shift+click = re-select, handled by handleSelectClick
  if (e.button !== 0) return;
  if (e.target.closest('.adnota-select-box')) return;   // ✕ button handles itself
  if (hitTestMarker(e.clientX, e.clientY) === selectedWrapper) return; // clicking the same item is a no-op
  clearSelection();
}

// Global Shift-held tracking. While Shift is down:
//   - Paint annotations become first-class interactive objects (CSS in
//     marker.css flips `pointer-events` + cursor to grab).
//   - The marker capture overlay is suspended so holding Shift temporarily
//     turns off any drawing tool. User wanted this to be an absolute rule —
//     there's no reason to Shift while drawing, so collapsing the overlap
//     kills whole categories of jank.
function syncOverlayForShift() {
  if (!captureSvg) return;
  const overlayActive = window.AdnotaState.isVisible && _overlayModes.has(window.AdnotaState.mode);
  if (!overlayActive) return;                             // nothing to suspend
  const shiftHeld = document.documentElement.classList.contains('adnota-shift-mode');
  captureSvg.style.pointerEvents = shiftHeld ? 'none' : 'auto';
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Shift') return;
  document.documentElement.classList.add('adnota-shift-mode');
  // Abort any in-progress drawing stroke — user changed intent mid-gesture.
  if (capturePath) { capturePath.remove(); capturePath = null; }
  if (captureShape) { captureShape.remove(); captureShape = null; }
  shapeOrigin = null;
  syncOverlayForShift();
}, true);
document.addEventListener('keyup', (e) => {
  if (e.key !== 'Shift') return;
  document.documentElement.classList.remove('adnota-shift-mode');
  syncOverlayForShift();
}, true);
// Dropped focus (alt-tab, devtools) never fires a keyup for still-held Shift.
// Clear the class so the page doesn't get stuck in shift-mode, and restore
// the overlay.
window.addEventListener('blur', () => {
  document.documentElement.classList.remove('adnota-shift-mode');
  syncOverlayForShift();
});

// Self-correct stale shift-mode state. The blur backstop above catches
// alt-tab and devtools, but macOS Shift+Cmd+4 (the screenshot crosshair)
// intercepts the Shift keyup at the OS level *without* dropping browser
// focus — so we receive the keydown but never the keyup, the blur listener
// never fires, and the class stays stuck. Symptom: every .adnota-marker-
// wrapper keeps pointer-events:auto via the html.adnota-shift-mode CSS rule
// in marker.css, wheel events that land on a marker wrapper die in the
// fixed-overlay's no-scrollable-ancestor chain, and the page appears to
// have scroll-locked. Pressing Shift again produces a clean keydown→keyup
// pair that finally clears the class — but users shouldn't have to know
// that recovery dance.
//
// e.shiftKey is the browser's authoritative read of the modifier at event
// time. If it says Shift isn't held, our class is stale by definition.
// Capture-phase so we reconcile before any handler that branches on the
// class. Wired to a few common events so any user activity recovers — the
// early-out is a single ANDed boolean check, so this is essentially free
// when state already matches.
const reconcileShiftState = (e) => {
  if (e.shiftKey) return;
  if (!document.documentElement.classList.contains('adnota-shift-mode')) return;
  document.documentElement.classList.remove('adnota-shift-mode');
  syncOverlayForShift();
};
document.addEventListener('pointermove', reconcileShiftState, { capture: true, passive: true });
document.addEventListener('wheel', reconcileShiftState, { capture: true, passive: true });
document.addEventListener('keydown', reconcileShiftState, { capture: true });
document.addEventListener('pointerdown', reconcileShiftState, { capture: true });

// ═════════════════════════════════════════════════════════════════════════════
// OVERLAY INIT + STATE SUBSCRIPTION
// ═════════════════════════════════════════════════════════════════════════════

function initCaptureOverlay() {
  captureSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  captureSvg.id = 'adnota-capture-canvas';
  captureSvg.setAttribute('data-adnota-ui', '1');
  captureSvg.style.display = 'none';

  captureSvg.addEventListener('pointerdown', handlePointerDown);
  captureSvg.addEventListener('pointermove', handlePointerMove);
  captureSvg.addEventListener('pointerup', handlePointerUp);
  // Browser-killed gestures (context menu, focus loss in some cases). Pair
  // with the setPointerCapture call in handlePointerDown — pointercancel
  // fires when the capture is broken without a normal pointerup.
  captureSvg.addEventListener('pointercancel', abortInFlightDraw);

  document.documentElement.appendChild(captureSvg);
}

initCaptureOverlay();

// Let other Adnota UI (sticky headers, HUDs, toolbars) pierce the capture
// overlay. Without this, the full-page SVG swallows pointerdown so you can't
// drag a sticky note or click a HUD button while a shape tool is active.
document.addEventListener('pointermove', (e) => {
  if (!_overlayModes.has(window.AdnotaState.mode)) return;
  if (capturePath || captureShape) return; // mid-stroke — keep capturing
  const stack = document.elementsFromPoint(e.clientX, e.clientY);
  const overUI = stack.some(el => el !== captureSvg && el.closest('[data-adnota-ui]'));
  captureSvg.style.pointerEvents = overUI ? 'none' : 'auto';
}, true);

// Select tool click handler (on document, not on overlay — select doesn't use the overlay).
// Also handles Shift+click selections in any other mode via the relaxed gate
// inside handleSelectClick itself.
document.addEventListener('click', handleSelectClick, true);
// Outside-click dismiss for Shift+click selections while NOT in select mode.
document.addEventListener('click', handleShiftSelectionDismiss, true);
// Drag-to-move handlers for select mode. Capture phase so we see the pointerdown
// before the marker wrapper's own handlers (e.g., text re-edit double-click).
document.addEventListener('pointerdown', handleSelectPointerDown, true);
document.addEventListener('pointermove', handleSelectPointerMove, true);
document.addEventListener('pointerup', handleSelectPointerUp, true);
// Text tool click handler
document.addEventListener('click', handleTextClick, true);
// Double-click to edit text (works in select and text modes)
document.addEventListener('dblclick', handleTextDblClick, true);

// AdnotaState Subscription
let _prevAdnotaMode = window.AdnotaState.mode;
window.AdnotaState.subscribe(state => {
  // Commit any in-progress text when switching modes
  if (activeTextEditor) commitActiveText();

  const isOverlayActive = state.isVisible && _overlayModes.has(state.mode);

  if (isOverlayActive) {
    captureSvg.style.display = 'block';
    // Shift held: suspend the overlay's pointer capture so holding Shift
    // temporarily turns off any drawing tool in favor of the select shortcut.
    // Restored when Shift is released via the keyup listener.
    captureSvg.style.pointerEvents = document.documentElement.classList.contains('adnota-shift-mode') ? 'none' : 'auto';
  } else {
    captureSvg.style.display = 'none';
    captureSvg.style.pointerEvents = 'none';
    // Clean up any in-progress drawing
    if (capturePath) { capturePath.remove(); capturePath = null; }
    if (captureShape) { captureShape.remove(); captureShape = null; }
    shapeOrigin = null;
  }

  // Select mode: all wrappers interactive (click-to-select needs hit testing).
  // Text mode: only TEXT wrappers interactive (so dblclick-to-edit still fires
  // on `.adnota-text-content`). Shape wrappers stay non-interactive because
  // they're sized to their anchor block's bbox — making them clickable would
  // swallow click-to-place-text across the entire surrounding paragraph.
  const inSelect = state.mode === 'select';
  const inText = state.mode === 'text';
  document.querySelectorAll('.adnota-marker-wrapper').forEach(el => {
    const isText = el.classList.contains('adnota-text-wrapper');
    el.style.pointerEvents = (inSelect || (inText && isText)) ? 'auto' : 'none';
  });

  // Clear selection on a real mode transition — not on HUD color/strokeWidth
  // emits (those keep the mode but would otherwise clobber a live Shift+click
  // selection).
  if (state.mode !== _prevAdnotaMode) {
    clearSelection();
    _prevAdnotaMode = state.mode;
  }
});

// ─── Scroll passthrough while DRAW mode is idle ─────────────────────────────
// Entering a tool shouldn't lock the user out of scrolling the page they're
// reading — the extension should feel invisible. The capture canvas is
// position:fixed full-viewport with pointer-events:auto, which is fine on
// normal scrolling documents (browser's native scroll-chain finds <html>
// and scrolls), but app shells like claude.ai / chatgpt.com put
// overflow:hidden on <body> and scroll an internal container. The wheel
// event hits the canvas, the browser walks up the canvas's ancestor chain
// looking for a scrollable element, finds none, and the scroll dies.
//
// Forward the wheel to the topmost non-Adnota scrollable ancestor under
// the cursor instead. Mid-stroke (capturePath / captureShape / drag-to-move)
// we deliberately block scroll — letting it through would create cross-
// viewport shapes and disconnected pen lines as the page slides under the
// gesture's coords.
document.addEventListener('wheel', (e) => {
  // Gate on "marker.js is intercepting wheel right now." Two cases:
  // (1) The capture canvas is visible (pen/arrow/rect/ellipse modes) — it
  //     covers the full viewport and blocks the wheel from reaching the
  //     page underneath.
  // (2) Select mode is active — the AdnotaState subscriber flips every
  //     marker wrapper to pointer-events:auto so click-to-select works,
  //     and wheel events that hit a wrapper die because the wrapper sits
  //     in the fixed-position #adnota-marker-overlay with no scrollable
  //     ancestor. Without this case the user can't scroll over any marker
  //     while the Select tool is on.
  // Text and highlight modes aren't included: highlight uses native
  // selection (no wheel intercept), and text wrappers are tiny so it's
  // rare for the wheel to land on one — the native chain handles it.
  const canvasActive = captureSvg && captureSvg.style.display === 'block';
  const inSelectMode = window.AdnotaState?.mode === 'select';
  if (!canvasActive && !inSelectMode) return;

  // Mid-action: block scroll so the in-progress gesture doesn't end up
  // spanning a viewport's worth of scroll delta.
  if (capturePath || captureShape || moveDragState) {
    e.preventDefault();
    return;
  }

  // Idle: find the page element under the cursor (skipping our own chrome —
  // toolbars, sticky notes, dock — so a wheel over a sticky note doesn't
  // try to scroll it as a page). Then walk up to its nearest scrollable
  // ancestor and dispatch the scroll there. Mirrors the browser's own
  // scroll-chain logic: overflow auto/scroll AND content overflows the box.
  const stack = document.elementsFromPoint(e.clientX, e.clientY);
  const target = stack.find(el => !el.closest('[data-adnota-ui]'));
  if (!target) return;

  let node = target;
  while (node && node !== document.documentElement) {
    const cs = getComputedStyle(node);
    const scrollsY = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
                     node.scrollHeight > node.clientHeight;
    const scrollsX = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') &&
                     node.scrollWidth > node.clientWidth;
    if (scrollsY || scrollsX) {
      e.preventDefault();
      node.scrollBy(e.deltaX, e.deltaY);
      return;
    }
    node = node.parentElement;
  }

  // No scrollable ancestor found in the page subtree. On a normally-
  // scrolling document the browser's native chain reaches <html> and
  // scrolls it for free (touch-action: pan-x pan-y on the canvas allows
  // this). On overflow:hidden app shells with no internal scroll container
  // under the cursor, there's genuinely nothing to scroll — bail.
}, { passive: false, capture: true });

