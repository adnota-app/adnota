// content/marker.js

let currentPathNodes = [];
let captureSvg = null;
let capturePath = null;
let areMarkersVisible = true;

// Utility: Ramer-Douglas-Peucker (RDP) Algorithm
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

function detectArrow(points) {
  // if (points.length < 5) return false;
  // const start = points[0];
  // const end = points[points.length - 1]; 

  // let pathDist = 0;
  // for (let i = 1; i < points.length; i++) {
  //   pathDist += Math.sqrt(Math.pow(points[i].x - points[i-1].x, 2) + Math.pow(points[i].y - points[i-1].y, 2));
  // }

  // const vectorDist = Math.sqrt(Math.pow(start.x - end.x, 2) + Math.pow(start.y - end.y, 2));
  // if (vectorDist < 30) return false; 

  // const ratio = vectorDist / pathDist;
  // if (ratio > 0.65 && ratio < 0.98) {
  //   return true; 
  // }
  // return false;
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

function handlePointerDown(e) {
  if (window.VellumState.mode !== 'pen') return;

  // Explicitly protect the toolbar area from interception if z-index acts up
  const toolbar = document.getElementById('vellum-highlighter-widget');
  if (toolbar && toolbar.contains(e.target)) return;
  // Also physically check bounds since the SVG might be capturing the event ON TOP of the toolbar
  if (toolbar) {
    const rect = toolbar.getBoundingClientRect();
    if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
      return; // Treat as a pass-through miss 
    }
  }

  e.preventDefault();

  currentPathNodes = [{ x: e.clientX, y: e.clientY }];
  capturePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  capturePath.setAttribute('stroke', getStrokeColor());
  capturePath.setAttribute('stroke-width', '4');
  capturePath.setAttribute('fill', 'none');
  capturePath.setAttribute('stroke-linecap', 'round');
  capturePath.setAttribute('stroke-linejoin', 'round');

  captureSvg.appendChild(capturePath);
  updateLivePath();
}

function handlePointerMove(e) {
  if (!capturePath || window.VellumState.mode !== 'pen') return;
  e.preventDefault();
  currentPathNodes.push({ x: e.clientX, y: e.clientY });
  updateLivePath();
}

async function handlePointerUp(e) {
  if (!capturePath || window.VellumState.mode !== 'pen') return;
  e.preventDefault();

  // A tap with no real stroke — dismiss the tool entirely.
  if (currentPathNodes.length < 3) {
    capturePath.remove();
    capturePath = null;
    window.VellumState.set({ mode: null });
    return;
  }

  // Turn off overlay to raycast to DOM
  captureSvg.style.pointerEvents = 'none';
  captureSvg.style.display = 'none';

  const startScreenX = currentPathNodes[0].x;
  const startScreenY = currentPathNodes[0].y;
  let targetNode = document.elementFromPoint(startScreenX, startScreenY);

  if (!targetNode || targetNode.nodeType !== Node.ELEMENT_NODE) {
    targetNode = document.body;
  }
  const blockElement = targetNode.closest('p, div, section, article, main, li, h1, h2, h3, h4, td') || document.body;

  const anchor = window.FuzzyAnchor.generate(blockElement);
  anchor._id = Date.now() + Math.random().toString();

  let simplifiedPoints = simplifyPathRDP(currentPathNodes, 2.0);
  const isArrow = detectArrow(simplifiedPoints);

  const box = blockElement.getBoundingClientRect();
  const normalizedPath = simplifiedPoints.map(p => ({
    px: parseFloat(((p.x - box.left) / box.width  * 100).toFixed(2)),
    py: parseFloat(((p.y - box.top)  / box.height * 100).toFixed(2))
  }));

  const payload = {
    ...anchor,
    action: 'MARKER',
    uuid: anchor._id,
    drawing: normalizedPath,
    isArrow: isArrow,
    color: getStrokeColor()
  };

  capturePath.remove();
  capturePath = null;

  window.VellumMarker.renderMarker(blockElement, payload);

  // Re-enable overlay based on current state (Bug 2 fix: respect any mid-stroke mode change).
  const stillActive = window.VellumState.isVisible && window.VellumState.mode === 'pen';
  captureSvg.style.display = stillActive ? 'block' : 'none';
  captureSvg.style.pointerEvents = stillActive ? 'auto' : 'none';

  if (window.VellumStorage) {
    await window.VellumStorage.saveAnchor(location.hostname, location.pathname, payload);
  }

  // Push to the central undo stack — removes the wrapper div and deletes from storage.
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

function updateLivePath() {
  if (currentPathNodes.length < 2) return;
  const d = currentPathNodes.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(' ');
  capturePath.setAttribute('d', d);
}

// Bug 1 fix: Define VellumMarker BEFORE initCaptureOverlay and VellumState.subscribe
// so that any immediate subscriber callbacks or pointer events can safely call renderMarker.
window.VellumMarker = {
  renderMarker: function (anchorElement, payload) {
    if (!payload.drawing || !Array.isArray(payload.drawing)) {
      return;
    }
    const existing = document.querySelector(`.vellum-marker-wrapper[data-uuid="${payload.uuid}"]`);
    if (existing) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'vellum-marker-wrapper';
    wrapper.dataset.uuid = payload.uuid;
    wrapper.style.display = areMarkersVisible ? 'block' : 'none';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

    path.setAttribute('stroke', payload.color || '#fbc02d');
    path.setAttribute('stroke-width', '4');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');

    if (payload.isArrow) {
      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', `arrowhead-${payload.uuid}`);
      marker.setAttribute('markerWidth', '6');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('refX', '5');
      marker.setAttribute('refY', '3');
      marker.setAttribute('orient', 'auto-start-reverse');
      marker.setAttribute('markerUnits', 'strokeWidth');

      const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      polygon.setAttribute('points', '0 0, 6 3, 0 6');
      polygon.setAttribute('fill', payload.color || '#fbc02d');

      marker.appendChild(polygon);
      defs.appendChild(marker);
      svg.appendChild(defs);
      path.setAttribute('marker-end', `url(#arrowhead-${payload.uuid})`);
    }

    svg.appendChild(path);
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

      // Map SVG points dynamically to physical pixels to avoid viewBox distortions!
      if (payload.isArrow) {
        const start = payload.drawing[0];
        const end = payload.drawing[payload.drawing.length - 1];
        const startX = (start.px / 100) * rect.width;
        const startY = (start.py / 100) * rect.height;
        const endX = (end.px / 100) * rect.width;
        const endY = (end.py / 100) * rect.height;
        path.setAttribute('d', `M ${startX} ${startY} L ${endX} ${endY}`);
      } else {
        const d = payload.drawing.map((p, i) => {
          const px = (p.px / 100) * rect.width;
          const py = (p.py / 100) * rect.height;
          return (i === 0 ? `M ${px} ${py}` : `L ${px} ${py}`);
        }).join(' ');
        path.setAttribute('d', d);
      }
    }

    syncBounds();
    // Bug 3 fix: Re-sync on both resize AND scroll so markers don't drift on long pages.
    window.addEventListener('resize', syncBounds);
    window.addEventListener('scroll', syncBounds, { passive: true });

    const observer = new ResizeObserver(() => syncBounds());
    observer.observe(anchorElement);
  }
};

function initCaptureOverlay() {
  captureSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  captureSvg.id = 'vellum-capture-canvas';
  captureSvg.style.display = 'none';

  captureSvg.addEventListener('pointerdown', handlePointerDown);
  captureSvg.addEventListener('pointermove', handlePointerMove);
  captureSvg.addEventListener('pointerup', handlePointerUp);

  document.documentElement.appendChild(captureSvg);
}

// Ensure overlay exists
initCaptureOverlay();

// VellumState Subscription — registered after VellumMarker is defined (Bug 1 fix).
window.VellumState.subscribe(state => {
  const isPenActive = state.isVisible && state.mode === 'pen';

  if (isPenActive) {
    captureSvg.style.display = 'block';
    captureSvg.style.pointerEvents = 'auto';
  } else {
    captureSvg.style.display = 'none';
    captureSvg.style.pointerEvents = 'none';
    if (capturePath) {
      capturePath.remove();
      capturePath = null;
    }
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
