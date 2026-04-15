// content/marker.js

let currentPathNodes = [];
let captureSvg = null;
let capturePath = null;    // freehand live path
let captureShape = null;   // arrow/rect/ellipse live shape
let shapeOrigin = null;    // { x, y } screen coords at pointerdown for shape tools
let areMarkersVisible = true;

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

// Converts theme class to physical color code for SVG painting
function getStrokeColor() {
  const themes = {
    'vellum-theme-yellow': '#fbc02d',
    'vellum-theme-green': '#388e3c',
    'vellum-theme-blue': '#1976d2',
    'vellum-theme-pink': '#c2185b',
    'vellum-theme-black': '#111'
  };
  return themes[window.VellumState.color] || '#fbc02d';
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
  captureShape.setAttribute('stroke', getStrokeColor());
  captureShape.setAttribute('stroke-width', String(window.VellumState.strokeWidth));
  captureShape.setAttribute('fill', 'none');
  captureShape.setAttribute('stroke-linejoin', 'round');
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
    strokeWidth: window.VellumState.strokeWidth
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
  captureShape.setAttribute('stroke', getStrokeColor());
  captureShape.setAttribute('stroke-width', String(window.VellumState.strokeWidth));
  captureShape.setAttribute('fill', 'none');
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
    strokeWidth: window.VellumState.strokeWidth
  };

  captureShape.remove();
  captureShape = null;
  shapeOrigin = null;

  await saveMarkerPayload(blockElement, payload);
}

// ═════════════════════════════════════════════════════════════════════════════
// UNIFIED POINTER HANDLERS — dispatch to the active tool
// ═════════════════════════════════════════════════════════════════════════════

function handlePointerDown(e) {
  const mode = window.VellumState.mode;
  if (!_overlayModes.has(mode)) return;
  if (isToolbarHit(e)) return;
  e.preventDefault();

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

    // Freehand and arrow use drawing array; rect and ellipse use shape object
    if ((shapeType === 'freehand' || shapeType === 'arrow') && (!payload.drawing || !Array.isArray(payload.drawing))) return;
    if ((shapeType === 'rect' || shapeType === 'ellipse') && !payload.shape) return;

    const existing = document.querySelector(`.vellum-marker-wrapper[data-uuid="${payload.uuid}"]`);
    if (existing) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'vellum-marker-wrapper';
    wrapper.dataset.uuid = payload.uuid;
    wrapper.dataset.shapeType = shapeType;
    wrapper.style.display = areMarkersVisible ? 'block' : 'none';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    let shapeEl;

    const color = payload.color || '#fbc02d';
    const sw = String(payload.strokeWidth || 4);

    if (shapeType === 'rect') {
      shapeEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      shapeEl.setAttribute('rx', '2');
      shapeEl.setAttribute('stroke', color);
      shapeEl.setAttribute('stroke-width', sw);
      shapeEl.setAttribute('fill', 'none');
      shapeEl.setAttribute('stroke-linejoin', 'round');
    } else if (shapeType === 'ellipse') {
      shapeEl = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      shapeEl.setAttribute('stroke', color);
      shapeEl.setAttribute('stroke-width', sw);
      shapeEl.setAttribute('fill', 'none');
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
let selectDragState = null;

function clearSelection() {
  if (selectBox) {
    selectBox.remove();
    selectBox = null;
  }
  selectedWrapper = null;
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
  delBtn.title = 'Delete';
  delBtn.onclick = async (e) => {
    e.stopPropagation();
    const uuid = wrapper.dataset.uuid;
    wrapper.remove();
    clearSelection();
    if (window.VellumStorage) {
      await window.VellumStorage.deleteItem(location.hostname, 'uuid', uuid);
    }
  };
  selectBox.appendChild(delBtn);

  document.documentElement.appendChild(selectBox);

  function syncSelectBox() {
    if (!selectBox || !selectedWrapper || !selectedWrapper.parentNode) {
      clearSelection();
      return;
    }
    const r = selectedWrapper.getBoundingClientRect();
    Object.assign(selectBox.style, {
      position: 'fixed',
      top: (r.top - 2) + 'px',
      left: (r.left - 2) + 'px',
      width: (r.width + 4) + 'px',
      height: (r.height + 4) + 'px',
    });
  }

  syncSelectBox();
  window.addEventListener('scroll', syncSelectBox, { passive: true });
  window.addEventListener('resize', syncSelectBox);

  // Store cleanup refs on the selectBox for later removal
  selectBox._cleanup = () => {
    window.removeEventListener('scroll', syncSelectBox);
    window.removeEventListener('resize', syncSelectBox);
  };
}

function handleSelectClick(e) {
  if (window.VellumState.mode !== 'select') return;
  if (isToolbarHit(e)) return;

  // Find a marker wrapper at click point
  const els = document.elementsFromPoint(e.clientX, e.clientY);
  const wrapper = els.find(el => el.classList.contains('vellum-marker-wrapper'));

  if (wrapper) {
    e.preventDefault();
    e.stopPropagation();
    showSelectionUI(wrapper);
  } else if (!e.target.closest('.vellum-select-box')) {
    clearSelection();
  }
}

// Delete key handler for selected element
document.addEventListener('keydown', (e) => {
  if (!selectedWrapper || window.VellumState.mode !== 'select') return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    const uuid = selectedWrapper.dataset.uuid;
    selectedWrapper.remove();
    clearSelection();
    if (window.VellumStorage) {
      window.VellumStorage.deleteItem(location.hostname, 'uuid', uuid);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// OVERLAY INIT + STATE SUBSCRIPTION
// ═════════════════════════════════════════════════════════════════════════════

function initCaptureOverlay() {
  captureSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  captureSvg.id = 'vellum-capture-canvas';
  captureSvg.style.display = 'none';

  captureSvg.addEventListener('pointerdown', handlePointerDown);
  captureSvg.addEventListener('pointermove', handlePointerMove);
  captureSvg.addEventListener('pointerup', handlePointerUp);

  document.documentElement.appendChild(captureSvg);
}

initCaptureOverlay();

// Select tool click handler (on document, not on overlay — select doesn't use the overlay)
document.addEventListener('click', handleSelectClick, true);

// VellumState Subscription
window.VellumState.subscribe(state => {
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

  // Select mode: make marker wrappers clickable; otherwise keep them non-interactive
  document.querySelectorAll('.vellum-marker-wrapper').forEach(el => {
    el.style.pointerEvents = state.mode === 'select' ? 'auto' : 'none';
  });

  // Clear selection when leaving select mode
  if (state.mode !== 'select') {
    clearSelection();
  }
});

// External visibility handler
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-view') {
    areMarkersVisible = !areMarkersVisible;
    document.querySelectorAll('.vellum-marker-wrapper').forEach(el => {
      el.style.display = areMarkersVisible ? 'block' : 'none';
    });
  }
});
