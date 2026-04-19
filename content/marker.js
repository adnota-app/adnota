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
    'vellum-theme-yellow': '#fbc02d',
    'vellum-theme-green': '#388e3c',
    'vellum-theme-blue': '#1976d2',
    'vellum-theme-pink': '#c2185b',
    'vellum-theme-black': '#111'
  };
  const c = window.VellumState.color;
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
  const toolbar = document.getElementById('vellum-highlighter-widget');
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
  const blockElement = targetNode.closest('p, div, section, article, main, li, h1, h2, h3, h4, td') || document.body;
  return blockElement;
}

function restoreOverlay() {
  const stillActive = window.VellumState.isVisible && _overlayModes.has(window.VellumState.mode);
  captureSvg.style.display = stillActive ? 'block' : 'none';
  captureSvg.style.pointerEvents = stillActive ? 'auto' : 'none';
}

// ── Save + undo helper ──────────────────────────────────────────────────────
async function saveMarkerPayload(blockElement, payload) {
  window.VellumMarker.renderMarker(blockElement, payload);
  restoreOverlay();

  if (window.VellumStorage) {
    await window.VellumStorage.saveItem(location.hostname, location.pathname, payload);
  }

  const capturedUuid = payload.uuid;
  const capturedDomain = location.hostname;
  window.VellumUndo.push({
    undo: async () => {
      const el = document.querySelector(`.vellum-marker-wrapper[data-uuid="${capturedUuid}"]`);
      if (el) el.remove();
      if (window.VellumStorage) {
        await window.VellumStorage.deleteItem(capturedDomain, 'uuid', capturedUuid);
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
  capturePath.setAttribute('stroke-width', String(window.VellumState.strokeWidth));
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

  // A tap with no real stroke — dismiss the tool entirely.
  if (currentPathNodes.length < 3) {
    capturePath.remove();
    capturePath = null;
    window.VellumState.set({ mode: null });
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
    strokeWidth: window.VellumState.strokeWidth
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
  captureShape.setAttribute('stroke-width', String(window.VellumState.strokeWidth));
  captureShape.setAttribute('stroke-linecap', 'round');

  // Live arrowhead marker
  const defs = captureSvg.querySelector('defs#vellum-live-defs') || (() => {
    const d = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    d.id = 'vellum-live-defs';
    captureSvg.insertBefore(d, captureSvg.firstChild);
    return d;
  })();
  // Remove old live arrow marker if any
  const oldMarker = defs.querySelector('#vellum-live-arrowhead');
  if (oldMarker) oldMarker.remove();

  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'vellum-live-arrowhead');
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

  captureShape.setAttribute('marker-end', 'url(#vellum-live-arrowhead)');
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
    strokeWidth: window.VellumState.strokeWidth
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
  if (window.VellumState.filled) {
    captureShape.setAttribute('fill', color);
    captureShape.setAttribute('stroke', 'none');
  } else {
    captureShape.setAttribute('stroke', color);
    captureShape.setAttribute('stroke-width', String(window.VellumState.strokeWidth));
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
    strokeWidth: window.VellumState.strokeWidth,
    filled: !!window.VellumState.filled
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
  if (window.VellumState.filled) {
    captureShape.setAttribute('fill', color);
    captureShape.setAttribute('stroke', 'none');
  } else {
    captureShape.setAttribute('stroke', color);
    captureShape.setAttribute('stroke-width', String(window.VellumState.strokeWidth));
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
    strokeWidth: window.VellumState.strokeWidth,
    filled: !!window.VellumState.filled
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
  return _textFontSizes[window.VellumState.strokeWidth] || 24;
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
  if (editor.isEdit && editor.wrapper._vellumPayload) {
    const payload = editor.wrapper._vellumPayload;
    payload.text = text;
    // Re-save
    if (window.VellumStorage) {
      window.VellumStorage.deleteItem(location.hostname, 'uuid', payload.uuid).then(() => {
        window.VellumStorage.saveItem(location.hostname, location.pathname, payload);
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
    strokeWidth: window.VellumState.strokeWidth
  };

  // Remove the live-editing wrapper and re-render via renderMarker for proper sync
  editor.wrapper.remove();
  saveMarkerPayload(blockElement, payload);
}

function handleTextClick(e) {
  if (window.VellumState.mode !== 'text') return;
  if (isToolbarHit(e)) return;
  if (e.target.closest('.vellum-select-box')) return;
  if (e.target.closest('[data-vellum-ui]')) return;

  // If clicking on an existing text marker, start editing it instead
  const existingText = e.target.closest('.vellum-text-content');
  if (existingText) return; // let dblclick handle editing

  // Commit any active editor first
  commitActiveText();

  e.preventDefault();
  e.stopPropagation();

  // Hide mode must never block work — reveal before placing the editor.
  window.VellumVisibility.show();

  const screenX = e.clientX;
  const screenY = e.clientY;

  // Find anchor block
  let targetNode = document.elementFromPoint(screenX, screenY);
  if (!targetNode || targetNode.nodeType !== Node.ELEMENT_NODE) targetNode = document.body;
  // Skip Vellum UI elements
  if (targetNode.closest('[data-vellum-ui]')) {
    targetNode = document.body;
  }
  const blockElement = targetNode.closest('p, div, section, article, main, li, h1, h2, h3, h4, td') || document.body;

  const color = getStrokeColor();
  const fontSize = getTextFontSize();

  // Create a temporary wrapper for live editing — pin to document origin
  // so the textEl's absolute coordinates work correctly.
  const wrapper = document.createElement('div');
  wrapper.className = 'vellum-marker-wrapper vellum-text-wrapper';
  wrapper.setAttribute('data-vellum-ui', '1');
  wrapper.style.pointerEvents = 'auto';
  wrapper.style.top = '0';
  wrapper.style.left = '0';
  wrapper.style.width = '100%';
  wrapper.style.height = '0';

  const textEl = document.createElement('div');
  textEl.className = 'vellum-text-content';
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
    // Stop propagation so Ctrl+Z doesn't trigger VellumUndo while typing
    e.stopPropagation();
  });
}

// Double-click to edit existing text (works in both text and select modes)
function handleTextDblClick(e) {
  if (window.VellumState.mode !== 'select' && window.VellumState.mode !== 'text') return;

  const textContent = e.target.closest('.vellum-text-content');
  if (!textContent) return;

  const wrapper = textContent.closest('.vellum-marker-wrapper');
  if (!wrapper || !wrapper._vellumPayload) return;

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
    blockElement: wrapper._vellumAnchorElement || document.body,
    screenX: 0, screenY: 0, // not needed for edits
    color: wrapper._vellumPayload.color,
    fontSize: wrapper._vellumPayload.fontSize,
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
      textContent.textContent = wrapper._vellumPayload.text;
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

function handlePointerDown(e) {
  const mode = window.VellumState.mode;
  if (!_overlayModes.has(mode)) return;
  if (isToolbarHit(e)) return;
  e.preventDefault();

  // Hide mode must never block work — reveal before the stroke starts so the
  // user can see what they're drawing.
  window.VellumVisibility.show();

  switch (mode) {
    case 'pen':     handlePenDown(e); break;
    case 'arrow':   handleArrowDown(e); break;
    case 'rect':    handleRectDown(e); break;
    case 'ellipse': handleEllipseDown(e); break;
  }
}

function handlePointerMove(e) {
  const mode = window.VellumState.mode;
  if (!_overlayModes.has(mode)) return;
  e.preventDefault();

  switch (mode) {
    case 'pen':     handlePenMove(e); break;
    case 'arrow':   handleArrowMove(e); break;
    case 'rect':    handleRectMove(e); break;
    case 'ellipse': handleEllipseMove(e); break;
  }
}

async function handlePointerUp(e) {
  const mode = window.VellumState.mode;
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

// Bug 1 fix: Define VellumMarker BEFORE initCaptureOverlay and VellumState.subscribe
window.VellumMarker = {
  renderMarker: function (anchorElement, payload) {
    const shapeType = payload.shapeType || (payload.isArrow ? 'arrow' : 'freehand');

    // Validate payload per shape type
    if ((shapeType === 'freehand' || shapeType === 'arrow') && (!payload.drawing || !Array.isArray(payload.drawing))) return;
    if ((shapeType === 'rect' || shapeType === 'ellipse') && !payload.shape) return;
    if (shapeType === 'text' && !payload.text) return;

    const existing = document.querySelector(`.vellum-marker-wrapper[data-uuid="${payload.uuid}"]`);
    if (existing) return;

    // ── TEXT SHAPE — uses HTML, not SVG ──────────────────────────────────
    if (shapeType === 'text') {
      const wrapper = document.createElement('div');
      wrapper.className = 'vellum-marker-wrapper';
      wrapper.setAttribute('data-vellum-ui', '1');
      wrapper.dataset.uuid = payload.uuid;
      wrapper.dataset.shapeType = 'text';
      // Pin to document origin so textEl absolute coords work correctly
      wrapper.style.top = '0';
      wrapper.style.left = '0';
      wrapper.style.width = '0';
      wrapper.style.height = '0';
      wrapper.style.overflow = 'visible';

      const textEl = document.createElement('div');
      textEl.className = 'vellum-text-content';
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
      wrapper._vellumPayload = payload;
      wrapper._vellumAnchorElement = anchorElement;
      document.documentElement.appendChild(wrapper);

      function syncTextPos() {
        if (!wrapper.parentNode) return;
        const rect = anchorElement.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
        textEl.style.left = (rect.left + scrollLeft + (payload.textPos.x / 100) * rect.width) + 'px';
        textEl.style.top = (rect.top + scrollTop + (payload.textPos.y / 100) * rect.height) + 'px';
      }

      syncTextPos();
      window.addEventListener('resize', syncTextPos);
      window.addEventListener('scroll', syncTextPos, { passive: true });
      const observer = new ResizeObserver(() => syncTextPos());
      observer.observe(anchorElement);
      return;
    }

    // ── SVG SHAPES (freehand, arrow, rect, ellipse) ─────────────────────
    const wrapper = document.createElement('div');
    wrapper.className = 'vellum-marker-wrapper';
    wrapper.setAttribute('data-vellum-ui', '1');
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
    wrapper._vellumPayload = payload;
    wrapper._vellumAnchorElement = anchorElement;
    document.documentElement.appendChild(wrapper);

    function syncBounds() {
      if (!wrapper.parentNode) return;
      const rect = anchorElement.getBoundingClientRect();
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

      wrapper.style.top = `${rect.top + scrollTop}px`;
      wrapper.style.left = `${rect.left + scrollLeft}px`;
      wrapper.style.width = `${rect.width}px`;
      wrapper.style.height = `${rect.height}px`;

      if (shapeType === 'rect') {
        const s = payload.shape;
        shapeEl.setAttribute('x', (s.x / 100) * rect.width);
        shapeEl.setAttribute('y', (s.y / 100) * rect.height);
        shapeEl.setAttribute('width', (s.w / 100) * rect.width);
        shapeEl.setAttribute('height', (s.h / 100) * rect.height);
      } else if (shapeType === 'ellipse') {
        const s = payload.shape;
        shapeEl.setAttribute('cx', (s.cx / 100) * rect.width);
        shapeEl.setAttribute('cy', (s.cy / 100) * rect.height);
        shapeEl.setAttribute('rx', (s.rx / 100) * rect.width);
        shapeEl.setAttribute('ry', (s.ry / 100) * rect.height);
      } else if (shapeType === 'arrow' || payload.isArrow) {
        const start = payload.drawing[0];
        const end = payload.drawing[payload.drawing.length - 1];
        shapeEl.setAttribute('d',
          `M ${(start.px / 100) * rect.width} ${(start.py / 100) * rect.height} ` +
          `L ${(end.px / 100) * rect.width} ${(end.py / 100) * rect.height}`
        );
      } else {
        // freehand
        const d = payload.drawing.map((p, i) => {
          const px = (p.px / 100) * rect.width;
          const py = (p.py / 100) * rect.height;
          return (i === 0 ? `M ${px} ${py}` : `L ${px} ${py}`);
        }).join(' ');
        shapeEl.setAttribute('d', d);
      }
    }

    syncBounds();
    window.addEventListener('resize', syncBounds);
    window.addEventListener('scroll', syncBounds, { passive: true });
    const observer = new ResizeObserver(() => syncBounds());
    observer.observe(anchorElement);
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
  const textContent = wrapper.querySelector('.vellum-text-content');
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
async function deleteSelectedMarker(wrapper) {
  const uuid = wrapper.dataset.uuid;
  const payload = wrapper._vellumPayload;

  // Hide immediately
  wrapper.style.display = 'none';
  clearSelection();

  // Delete from storage
  if (window.VellumStorage) {
    await window.VellumStorage.deleteItem(location.hostname, 'uuid', uuid);
  }

  // Push undo: re-show the wrapper and re-save to storage
  window.VellumUndo.push({
    undo: async () => {
      wrapper.style.display = '';
      if (window.VellumStorage && payload) {
        await window.VellumStorage.saveItem(location.hostname, location.pathname, payload);
      }
    }
  });
}

function showSelectionUI(wrapper) {
  clearSelection();
  selectedWrapper = wrapper;

  selectBox = document.createElement('div');
  selectBox.className = 'vellum-select-box';
  selectBox.setAttribute('data-vellum-ui', '1');

  // Delete button
  const delBtn = document.createElement('div');
  delBtn.className = 'vellum-select-delete';
  delBtn.textContent = '\u2715';
  delBtn.setAttribute('data-tooltip', 'Delete');
  delBtn.onclick = async (e) => {
    e.stopPropagation();
    await deleteSelectedMarker(wrapper);
  };
  selectBox.appendChild(delBtn);

  document.documentElement.appendChild(selectBox);

  function syncSelectBox() {
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

  syncSelectBox();
  window.addEventListener('scroll', syncSelectBox, { passive: true });
  window.addEventListener('resize', syncSelectBox);

  selectBox._cleanup = () => {
    window.removeEventListener('scroll', syncSelectBox);
    window.removeEventListener('resize', syncSelectBox);
  };
}

// Hit-test helper shared by click-to-select and pointerdown-to-drag. Picks the
// smallest visible wrapper whose shape is near the pointer.
function hitTestMarker(clientX, clientY) {
  const wrappers = document.querySelectorAll('.vellum-marker-wrapper');
  let bestWrapper = null;
  let bestArea = Infinity;
  for (const wrapper of wrappers) {
    // Hidden wrappers (direct display:none or ancestor .vellum-hidden) are not targetable.
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
  if (window.VellumState.mode !== 'select') return;
  if (isToolbarHit(e)) return;
  if (e.button !== 0) return; // left-click only
  if (e.target.closest('.vellum-select-box')) return; // delete button handles itself
  if (e.target.closest('.vellum-text-content[contenteditable="true"]')) return; // editing — don't drag

  const wrapper = hitTestMarker(e.clientX, e.clientY);
  if (!wrapper) return;

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
    // `html.vellum-dragging` override that swaps every descendant to
    // `grabbing !important`, beating the select-mode arrow.
    document.documentElement.classList.add('vellum-dragging');
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

  document.documentElement.classList.remove('vellum-dragging');

  if (!moved) {
    // Fall through to the normal click-to-select flow.
    return;
  }

  // Suppress the synthetic click that fires right after this pointerup — a
  // move shouldn't also register as a click on the (new) element beneath.
  suppressNextClick = true;

  const payload = wrapper._vellumPayload;
  const anchorElement = wrapper._vellumAnchorElement;
  if (!payload || !anchorElement) {
    wrapper.style.transform = '';
    return;
  }

  // Convert pixel delta to a percentage of the anchor rect, matching the
  // anchor-relative coord system used everywhere else.
  const rect = anchorElement.getBoundingClientRect();
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

  // Re-render from the updated payload. renderMarker early-exits if the uuid
  // is already on the page, so we must remove the old wrapper first.
  wrapper.remove();
  if (selectBox) { selectBox.style.transform = ''; clearSelection(); }
  window.VellumMarker.renderMarker(anchorElement, payload);

  // Persist: delete old row, save updated payload.
  if (window.VellumStorage) {
    await window.VellumStorage.deleteItem(location.hostname, 'uuid', payload.uuid);
    await window.VellumStorage.saveItem(location.hostname, location.pathname, payload);
  }

  // Re-select the moved marker so the user sees where it landed.
  const fresh = document.querySelector(`.vellum-marker-wrapper[data-uuid="${payload.uuid}"]`);
  if (fresh) showSelectionUI(fresh);

  // Undo: restore old coords + storage row.
  window.VellumUndo.push({
    undo: async () => {
      if (oldSnapshot.shape) payload.shape = oldSnapshot.shape;
      if (oldSnapshot.textPos) payload.textPos = oldSnapshot.textPos;
      if (oldSnapshot.drawing) payload.drawing = oldSnapshot.drawing;
      const current = document.querySelector(`.vellum-marker-wrapper[data-uuid="${payload.uuid}"]`);
      if (current) current.remove();
      clearSelection();
      window.VellumMarker.renderMarker(anchorElement, payload);
      if (window.VellumStorage) {
        await window.VellumStorage.deleteItem(location.hostname, 'uuid', payload.uuid);
        await window.VellumStorage.saveItem(location.hostname, location.pathname, payload);
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
  if (window.VellumState.mode !== 'select') return;
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
  if (e.target.closest('.vellum-select-box')) return;

  const bestWrapper = hitTestMarker(e.clientX, e.clientY);
  if (bestWrapper) {
    e.preventDefault();
    e.stopPropagation();
    showSelectionUI(bestWrapper);
  } else {
    clearSelection();
  }
}

// Delete key handler for selected element
document.addEventListener('keydown', (e) => {
  if (!selectedWrapper || window.VellumState.mode !== 'select') return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelectedMarker(selectedWrapper);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// OVERLAY INIT + STATE SUBSCRIPTION
// ═════════════════════════════════════════════════════════════════════════════

function initCaptureOverlay() {
  captureSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  captureSvg.id = 'vellum-capture-canvas';
  captureSvg.setAttribute('data-vellum-ui', '1');
  captureSvg.style.display = 'none';

  captureSvg.addEventListener('pointerdown', handlePointerDown);
  captureSvg.addEventListener('pointermove', handlePointerMove);
  captureSvg.addEventListener('pointerup', handlePointerUp);

  document.documentElement.appendChild(captureSvg);
}

initCaptureOverlay();

// Let other Vellum UI (sticky headers, HUDs, toolbars) pierce the capture
// overlay. Without this, the full-page SVG swallows pointerdown so you can't
// drag a sticky note or click a HUD button while a shape tool is active.
document.addEventListener('pointermove', (e) => {
  if (!_overlayModes.has(window.VellumState.mode)) return;
  if (capturePath || captureShape) return; // mid-stroke — keep capturing
  const stack = document.elementsFromPoint(e.clientX, e.clientY);
  const overUI = stack.some(el => el !== captureSvg && el.closest('[data-vellum-ui]'));
  captureSvg.style.pointerEvents = overUI ? 'none' : 'auto';
}, true);

// Select tool click handler (on document, not on overlay — select doesn't use the overlay)
document.addEventListener('click', handleSelectClick, true);
// Drag-to-move handlers for select mode. Capture phase so we see the pointerdown
// before the marker wrapper's own handlers (e.g., text re-edit double-click).
document.addEventListener('pointerdown', handleSelectPointerDown, true);
document.addEventListener('pointermove', handleSelectPointerMove, true);
document.addEventListener('pointerup', handleSelectPointerUp, true);
// Text tool click handler
document.addEventListener('click', handleTextClick, true);
// Double-click to edit text (works in select and text modes)
document.addEventListener('dblclick', handleTextDblClick, true);

// VellumState Subscription
window.VellumState.subscribe(state => {
  // Commit any in-progress text when switching modes
  if (activeTextEditor) commitActiveText();

  const isOverlayActive = state.isVisible && _overlayModes.has(state.mode);

  if (isOverlayActive) {
    captureSvg.style.display = 'block';
    captureSvg.style.pointerEvents = 'auto';
  } else {
    captureSvg.style.display = 'none';
    captureSvg.style.pointerEvents = 'none';
    // Clean up any in-progress drawing
    if (capturePath) { capturePath.remove(); capturePath = null; }
    if (captureShape) { captureShape.remove(); captureShape = null; }
    shapeOrigin = null;
  }

  // Select and text modes: make marker wrappers clickable for hit testing
  const interactive = state.mode === 'select' || state.mode === 'text';
  document.querySelectorAll('.vellum-marker-wrapper').forEach(el => {
    el.style.pointerEvents = interactive ? 'auto' : 'none';
  });

  // Clear selection when leaving select mode
  if (state.mode !== 'select') {
    clearSelection();
  }
});

