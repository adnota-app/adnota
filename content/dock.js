// content/dock.js — The Vellum Dock
//
// One persistent fixed-position widget that replaces both the old radial
// menu and the per-tool HUD strips. It is the ONLY Vellum chrome that
// sits on the page at all times.
//
//   idle           → drag handle + V logo
//   radial open    → satellites fan out in a half-dome above the V
//   tool active    → body slot grows right with the tool's controls
//
// Tools register their controls via VellumDock.mount(toolId, buildFn)
// when they enter their mode, and call VellumDock.unmount() when they
// leave. The dock handles its own drag, radial, and state-sync.

(function () {
  'use strict';

  // ── Satellite icon markup ───────────────────────────────────────────────
  const icons = {
    visibility:    `<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
    visibilityOff: `<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
    eraser:  `<svg viewBox="0 0 24 24"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>`,
    sticky:  `<svg viewBox="0 0 24 24"><path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z"/><polyline points="15 3 15 9 21 9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>`,
    marker:  `<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
    resizer: `<svg viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>`,
    sites:   `<svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  };

  // Order here = rendering order = DOM order = left-to-right arc order.
  const satellites = [
    { id: 'vis',     tooltip: 'Show / Hide All', icon: 'visibility', color: '#a78bfa', glow: 'rgba(167,139,250,0.3)', action: 'toggle-view' },
    { id: 'eraser',  tooltip: 'Eraser',          icon: 'eraser',     color: '#ef4444', glow: 'rgba(239,68,68,0.3)',   action: 'toggle-eraser',      mode: 'eraser'  },
    { id: 'sticky',  tooltip: 'Sticky Note',     icon: 'sticky',     color: '#f59e0b', glow: 'rgba(245,158,11,0.3)',  action: 'toggle-sticky',      mode: 'sticky'  },
    { id: 'marker',  tooltip: 'Drawing Palette', icon: 'marker',     color: '#7c3aed', glow: 'rgba(124,58,237,0.3)',  action: 'toggle-highlighter', mode: 'highlight' },
    { id: 'resizer', tooltip: 'Resizer',         icon: 'resizer',    color: '#3b82f6', glow: 'rgba(59,130,246,0.3)',  action: 'toggle-resizer',     mode: 'resizer' },
    { id: 'sites',   tooltip: 'My Edited Sites', icon: 'sites',      color: '#10b981', glow: 'rgba(16,185,129,0.3)',  action: 'open-sites' },
  ];

  // ── Radial geometry ─────────────────────────────────────────────────────
  // Satellites form a rigid arc: fixed spacing between neighbors, fixed radius
  // from the V. Idle vs active only changes the CENTER ANGLE — i.e. the whole
  // cluster rotates as a single unit. This way the satellites keep the same
  // order, spacing, and distance from the logo across the swivel, and each
  // one travels the same arc length to its new home.
  //   IDLE   — cluster centered straight up (90°). Symmetric above the V.
  //   ACTIVE — cluster rotated 45° CCW (135°). All satellites are upper-LEFT
  //            of the V, leaving the body slot to the right uncovered.
  const RADIUS = 80;
  const SAT_SPACING_DEG = 22;          // angular gap between adjacent satellites
  const IDLE_CENTER_DEG   =  90;       // straight up
  const ACTIVE_CENTER_DEG = 135;       // upper-left
  const count = satellites.length;
  const HALF_SPAN_DEG = ((count - 1) * SAT_SPACING_DEG) / 2;

  function currentCenterDeg() {
    return dock.classList.contains('vellum-dock-active')
      ? ACTIVE_CENTER_DEG
      : IDLE_CENTER_DEG;
  }

  // Sat 0 sits at the highest angle (which corresponds to upper-LEFT in the
  // idle arc, reading left-to-right: vis, eraser, sticky, marker, resizer,
  // sites). After rotation, that ordering is preserved — sat 0 just moves
  // along the arc to wherever the new center puts it.
  function angleForIndex(i) {
    return currentCenterDeg() + HALF_SPAN_DEG - i * SAT_SPACING_DEG;
  }

  // ── Build DOM ───────────────────────────────────────────────────────────
  const dock = document.createElement('div');
  dock.id = 'vellum-dock';
  dock.setAttribute('data-vellum-ui', '1');

  const anchor = document.createElement('div');
  anchor.className = 'vellum-dock-anchor';
  dock.appendChild(anchor);

  // Drag handle (reuses the existing .vellum-toolbar-drag class).
  const dragHandle = document.createElement('span');
  dragHandle.className = 'vellum-toolbar-drag';
  dragHandle.textContent = '\u2847';
  dragHandle.setAttribute('data-tooltip', 'Drag to reposition');
  anchor.appendChild(dragHandle);

  // V logo — the radial anchor. Click or hover to fan.
  const logo = document.createElement('span');
  logo.className = 'vellum-dock-logo';
  logo.textContent = 'V';
  anchor.appendChild(logo);

  // Invisible hit zone to the upper-left of the logo — keeps the radial open
  // while the cursor crosses the empty space between the V and a satellite.
  // Lives INSIDE the logo so its coordinates are relative to the logo's box
  // and so leaving the logo's parent (anchor) doesn't accidentally exit it.
  const hitzone = document.createElement('div');
  hitzone.className = 'vellum-dock-hitzone';
  logo.appendChild(hitzone);

  // Satellite buttons — children of the logo so positioning is relative to
  // its center. Order here matches the nth-of-type cascade rules in dock.css.
  const satEls = [];
  satellites.forEach((sat, i) => {
    const el = document.createElement('div');
    el.className = 'vellum-dock-satellite';
    el.setAttribute('data-vellum-ui', '1');
    el.setAttribute('data-tooltip', sat.tooltip);
    el.setAttribute('data-sat-id', sat.id);
    el.style.setProperty('--sat-color', sat.color);
    el.style.setProperty('--sat-glow', sat.glow);
    el.innerHTML = icons[sat.icon];
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      handleSatelliteClick(sat);
    });
    logo.appendChild(el);
    satEls.push({ el, sat, index: i });
  });

  // Tool body slot — tools mount their controls here.
  const body = document.createElement('div');
  body.className = 'vellum-dock-body';
  dock.appendChild(body);

  document.documentElement.appendChild(dock);

  // ── Drag + position persistence ─────────────────────────────────────────
  // The dock starts centered (left:50% + transform). On first drag — or first
  // tool mount, see commitPositionIfCentered() — it commits to absolute left/
  // top. We persist the committed coordinates to chrome.storage.local so the
  // user's chosen spot survives page reloads and Chrome restarts.
  const POSITION_KEY = 'vellumDockPosition';

  function commitPositionIfCentered() {
    if (dock.style.left === '50%' || dock.style.left === '') {
      const rect = dock.getBoundingClientRect();
      dock.style.left = rect.left + 'px';
      dock.style.top = rect.top + 'px';
      dock.style.bottom = 'auto';
      dock.style.transform = 'none';
    }
  }

  function persistPosition() {
    if (dock.style.left && dock.style.left !== '50%') {
      chrome.storage.local.set({
        [POSITION_KEY]: { left: dock.style.left, top: dock.style.top },
      }).catch(() => {});
    }
  }

  // Drag-anywhere: the whole dock is a drag surface. A short movement
  // threshold distinguishes drag from click, and we cancel the synthetic
  // click that follows a real drag so satellite / logo clicks still work
  // when the user means to click without moving.
  const DRAG_THRESHOLD_PX = 4;
  let dragState = null;
  let suppressNextClick = false;

  function onDragMove(e) {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      dragState.dragging = true;
      // Commit position BEFORE the first positional update so the transform-
      // based center shift can't fight our absolute coordinates.
      commitPositionIfCentered();
      const r = dock.getBoundingClientRect();
      dragState.startLeft = r.left;
      dragState.startTop = r.top;
      dragState.startX = e.clientX;
      dragState.startY = e.clientY;
      dock.style.cursor = 'grabbing';
      return;
    }
    dock.style.left = (dragState.startLeft + (e.clientX - dragState.startX)) + 'px';
    dock.style.top = (dragState.startTop + (e.clientY - dragState.startY)) + 'px';
    dock.style.bottom = 'auto';
    dock.style.transform = 'none';
    e.preventDefault();
  }

  function onDragEnd() {
    if (!dragState) return;
    const wasDragging = dragState.dragging;
    dragState = null;
    dock.style.cursor = '';
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
    if (wasDragging) {
      suppressNextClick = true;
      persistPosition();
    }
  }

  dock.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = dock.getBoundingClientRect();
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: r.left,
      startTop: r.top,
      dragging: false,
    };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  });

  // Swallow the click that fires right after a drag so the drop doesn't
  // double-activate whatever happened to be under the cursor.
  dock.addEventListener('click', (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  // Restore saved position on init. The dock is visibility:hidden until this
  // resolves (success OR failure) so we never flash at the default center
  // when a saved position exists.
  function markReady() {
    dock.classList.add('vellum-dock-ready');
  }
  chrome.storage.local.get(POSITION_KEY).then((data) => {
    const pos = data[POSITION_KEY];
    if (pos?.left && pos?.top) {
      dock.style.left = pos.left;
      dock.style.top = pos.top;
      dock.style.bottom = 'auto';
      dock.style.transform = 'none';
    }
    markReady();
  }).catch(markReady);

  // ── Radial expand / collapse ────────────────────────────────────────────
  function positionSatellites(expanded) {
    satEls.forEach(({ el, index }) => {
      if (expanded) {
        const angleRad = (angleForIndex(index) * Math.PI) / 180;
        const x = Math.cos(angleRad) * RADIUS;
        const y = -Math.sin(angleRad) * RADIUS; // negative: CSS y grows down
        el.style.left = (-2 + x) + 'px';
        el.style.top  = (-2 + y) + 'px';
      } else {
        el.style.left = '-2px';
        el.style.top  = '-2px';
      }
    });
  }

  let collapseTimer = null;

  function expand() {
    clearTimeout(collapseTimer);
    if (dock.classList.contains('vellum-dock-radial-open')) return;
    dock.classList.add('vellum-dock-radial-open');
    positionSatellites(true);
    syncActiveState();
  }

  function collapse() {
    clearTimeout(collapseTimer);
    dock.classList.remove('vellum-dock-radial-open');
    positionSatellites(false);
  }

  function scheduleCollapse(delayMs = 1500) {
    clearTimeout(collapseTimer);
    collapseTimer = setTimeout(collapse, delayMs);
  }

  // Re-orbit satellites to the current arc. No-op if the radial isn't open.
  // Used when the dock toggles between idle and active so the satellites
  // visibly swivel as the body grows/shrinks.
  function reorbitIfOpen() {
    if (dock.classList.contains('vellum-dock-radial-open')) {
      positionSatellites(true);
    }
  }

  // Open trigger: hovering the V. The drag handle does NOT open the radial
  // (so the user can grab and drag without summoning the menu).
  // Close trigger: leaving the whole dock. As long as the cursor is anywhere
  // in the dock (logo, satellites, body, drag handle), the radial stays open.
  // This avoids spurious collapses when moving from a satellite back across
  // the dock to grab the drag handle, or to click a body control.
  logo.addEventListener('mouseenter', expand);
  dock.addEventListener('mouseenter', () => clearTimeout(collapseTimer));
  dock.addEventListener('mouseleave', scheduleCollapse);

  // Click on the logo toggles — useful on touch or when hover is flaky.
  logo.addEventListener('click', (e) => {
    // Don't toggle if the click came from a satellite (its own handler runs).
    if (e.target !== logo) return;
    e.stopPropagation();
    if (dock.classList.contains('vellum-dock-radial-open')) collapse();
    else expand();
  });

  // ── Satellite click → fire tool action ──────────────────────────────────
  function handleSatelliteClick(sat) {
    if (sat.action === 'open-sites') {
      chrome.runtime.sendMessage({ action: 'open-sites' }).catch(() => {});
      collapse();
      return;
    }

    if (sat.action === 'toggle-view') {
      window.VellumVisibility?.toggle();
      collapse();
      return;
    }

    // Tool toggles — relay through the background so the content scripts'
    // runtime message listeners fire (same path keyboard shortcuts take).
    // Collapse immediately: the user clicked a tool, so the radial should
    // disappear right away. The body growing to include the tool's controls
    // is a separate animation owned by .vellum-dock-active.
    chrome.runtime.sendMessage({
      action: 'relay-to-tab',
      payload: { action: sat.action },
    }).catch(() => {});
    collapse();
  }

  // ── Active-state sync (border glow on the right satellite) ──────────────
  const MARKER_SUB_MODES = new Set(['highlight', 'pen', 'arrow', 'rect', 'ellipse', 'text', 'select']);

  function syncActiveState() {
    const mode = window.VellumState?.mode;
    satEls.forEach(({ el, sat }) => {
      if (!sat.mode) return;
      const isActive = sat.id === 'marker'
        ? MARKER_SUB_MODES.has(mode)
        : mode === sat.mode;
      el.classList.toggle('active', isActive);
    });
  }

  // ── Visibility icon swap (eye ↔ eye-off) ────────────────────────────────
  function setVisibilityIcon(isHidden) {
    const visSat = satEls.find(s => s.sat.id === 'vis');
    if (!visSat) return;
    visSat.el.innerHTML = isHidden ? icons.visibilityOff : icons.visibility;
    visSat.el.setAttribute('data-tooltip', isHidden ? 'Show All' : 'Hide All');
  }

  if (window.VellumVisibility?.subscribe) {
    window.VellumVisibility.subscribe(setVisibilityIcon);
  } else {
    setVisibilityIcon(false);
  }

  // All tools mount their controls into the dock body — it's the only Vellum
  // chrome on the page, visible at all times.
  if (window.VellumState?.subscribe) {
    window.VellumState.subscribe(syncActiveState);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'vellumActiveMode' in changes) {
      setTimeout(syncActiveState, 50);
    }
  });

  // ── Public API ──────────────────────────────────────────────────────────
  // A tool mounts its body fragment when it activates; unmount on exit.
  // The dock owns the chrome (drag, logo, radial, accent); the tool owns
  // its controls (info strip, swatches, trash, undo).
  window.VellumDock = {
    mount(toolId, buildBodyFn) {
      // Lock the dock to its current pixel coordinates BEFORE filling the
      // body. Otherwise the body's content width pushes the dock left/right
      // (it's centered with transform:translateX(-50%)), and any subsequent
      // info-text changes inside the body will keep shifting the dock —
      // which causes the cursor to keep falling on/off the dock's hover
      // boundary, looping the :hover state.
      commitPositionIfCentered();

      body.replaceChildren();
      const frag = buildBodyFn?.();
      if (frag) body.appendChild(frag);
      dock.classList.add('vellum-dock-active');
      dock.setAttribute('data-accent', toolId);
      // Swivel satellites to the active arc so they don't overlap the body.
      reorbitIfOpen();
    },
    // toolId is optional but recommended — when supplied, unmount no-ops if
    // the dock is currently owned by a different tool. This avoids a race when
    // switching tools: the outgoing tool's VellumState subscriber fires AFTER
    // the incoming tool's (registration order), so an unconditional unmount
    // would clear the body the new tool just installed.
    unmount(toolId) {
      if (toolId && dock.getAttribute('data-accent') !== toolId) return;
      body.replaceChildren();
      dock.classList.remove('vellum-dock-active');
      dock.removeAttribute('data-accent');
      // If the radial was still open (e.g. user hit Escape while hovering the
      // logo, so the satellites were fanned to the active upper-left arc),
      // collapse straight to the closed state — do NOT re-orbit to the idle
      // arc first. Re-orbiting produces a confusing two-stage animation
      // (satellites sweep to idle arc, then collapse) that makes Escape feel
      // unresponsive. The exit translate in CSS gives a single consistent
      // "down-and-left" swivel regardless of the arc they were on.
      if (dock.classList.contains('vellum-dock-radial-open')) {
        collapse();
      }
    },
    // Escape hatch — the dock element itself, for tools that need to attach
    // extra listeners or measure (e.g. the eraser's iframe shield).
    element: dock,
    bodyElement: body,
    logoElement: logo,
    dragHandle,
  };
})();
