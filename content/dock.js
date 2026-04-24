// content/dock.js — The Vellum Dock
//
// One persistent fixed-position widget. Two visual states, toggled by which
// tool (if any) is active:
//
//   idle   — [drag][V][vis][eraser][sticky][marker][resizer]
//            Tool row is always visible, one click away.
//   active — [drag][← back][tool HUD body grows right →]
//            The tool row collapses, V morphs into an accent-colored back
//            arrow, and the tool's own controls fill the body slot.
//
// Back arrow / Escape / clicking the active tool again all exit the tool.
// Tools register their controls via VellumDock.mount(toolId, buildFn) on
// entry, VellumDock.unmount(toolId) on exit.

(function () {
  'use strict';

  // ── Icons ──────────────────────────────────────────────────────────────────
  const icons = {
    visibility:    `<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
    visibilityOff: `<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
    eraser:  `<svg viewBox="0 0 24 24"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>`,
    sticky:  `<svg viewBox="0 0 24 24"><path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z"/><polyline points="15 3 15 9 21 9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>`,
    marker:  `<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
    resizer: `<svg viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>`,
    back:    `<svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>`,
  };

  // Left-to-right order in the idle row. Tool modes (eraser/sticky/marker/
  // resizer) come first as a group, then Show/Hide at the end — it's a
  // global toggle, not a tool mode, and sits visually apart for that reason.
  const toolDefs = [
    { id: 'eraser',  tooltip: 'Eraser',          icon: 'eraser',     action: 'toggle-eraser',      mode: 'eraser',    accent: 'eraser'    },
    { id: 'sticky',  tooltip: 'Sticky Note',     icon: 'sticky',     action: 'toggle-sticky',      mode: 'sticky',    accent: 'sticky'    },
    { id: 'marker',  tooltip: 'Drawing Palette', icon: 'marker',     action: 'toggle-highlighter', mode: 'highlight', accent: 'highlight' },
    { id: 'resizer', tooltip: 'Resizer',         icon: 'resizer',    action: 'toggle-resizer',     mode: 'resizer',   accent: 'resizer'   },
    { id: 'vis',     tooltip: 'Show / Hide All', icon: 'visibility', action: 'toggle-view' },
  ];

  // Drawing sub-modes all count as "marker" for the active-state indicator.
  const MARKER_SUB_MODES = new Set(['highlight', 'pen', 'arrow', 'rect', 'ellipse', 'text', 'select']);

  // ── Build DOM ─────────────────────────────────────────────────────────────
  const dock = document.createElement('div');
  dock.id = 'vellum-dock';
  dock.setAttribute('data-vellum-ui', '1');

  const dragHandle = document.createElement('span');
  dragHandle.className = 'vellum-toolbar-drag';
  dragHandle.textContent = '⡇';
  dragHandle.setAttribute('data-tooltip', 'Drag to reposition');
  dock.appendChild(dragHandle);

  // Home chrome: V logo (idle) OR back arrow (active). They share a slot so
  // the dock's left edge is visually anchored across state transitions.
  const home = document.createElement('div');
  home.className = 'vellum-dock-home';

  const logo = document.createElement('span');
  logo.className = 'vellum-dock-logo';
  logo.textContent = 'V';
  logo.setAttribute('data-tooltip', 'My Edited Sites');
  logo.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ action: 'open-sites' }).catch(() => {});
  });
  home.appendChild(logo);

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'vellum-dock-back';
  back.setAttribute('data-tooltip', 'Exit tool (Esc)');
  back.innerHTML = icons.back;
  back.addEventListener('click', (e) => {
    e.stopPropagation();
    window.VellumState?.set({ mode: null });
  });
  home.appendChild(back);

  dock.appendChild(home);

  // Tool row — always-visible when idle, hidden when a tool is active.
  const toolRow = document.createElement('div');
  toolRow.className = 'vellum-dock-tools';

  const toolEls = [];
  for (const tool of toolDefs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vellum-dock-tool';
    btn.setAttribute('data-vellum-ui', '1');
    btn.setAttribute('data-tooltip', tool.tooltip);
    btn.setAttribute('data-tool-id', tool.id);
    if (tool.accent) btn.setAttribute('data-accent', tool.accent);
    btn.innerHTML = icons[tool.icon];
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleToolClick(tool);
    });
    toolRow.appendChild(btn);
    toolEls.push({ btn, tool });
  }

  dock.appendChild(toolRow);

  // Tool body — mounted into when a tool is active. Grows right from the
  // back arrow, shares the same frosted-glass panel.
  const body = document.createElement('div');
  body.className = 'vellum-dock-body';
  dock.appendChild(body);

  document.documentElement.appendChild(dock);

  // ── Position persistence ──────────────────────────────────────────────────
  // The dock starts centered (left:50% + transform). On first drag OR first
  // tool mount, commit to absolute px and persist so the spot survives reloads.
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

  // ── Drag anywhere on the dock ─────────────────────────────────────────────
  // 4px threshold distinguishes a drag from a click, and we swallow the
  // synthetic click that follows a real drag so tool buttons only fire when
  // the user genuinely meant to click.
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

  dock.addEventListener('click', (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  // ── Restore saved position ────────────────────────────────────────────────
  // Dock is visibility:hidden until this resolves so we never flash at the
  // default center position when a saved spot exists.
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

  // ── Tool button clicks ────────────────────────────────────────────────────
  function handleToolClick(tool) {
    if (tool.action === 'toggle-view') {
      window.VellumVisibility?.toggle();
      return;
    }
    // Fire the tool's toggle through the background relay so the content
    // script's runtime message listener handles it (same path keyboard
    // shortcuts take).
    chrome.runtime.sendMessage({
      action: 'relay-to-tab',
      payload: { action: tool.action },
    }).catch(() => {});
  }

  // ── Active-tool indicator on the idle row ────────────────────────────────
  // Briefly visible during mode transitions and during the window between
  // hitting a shortcut and the body mounting. Also keeps the row readable if
  // a tool fails to mount its body for some reason.
  function syncActiveState() {
    const mode = window.VellumState?.mode;
    for (const { btn, tool } of toolEls) {
      if (!tool.mode) continue;
      const isActive = tool.id === 'marker'
        ? MARKER_SUB_MODES.has(mode)
        : mode === tool.mode;
      btn.classList.toggle('active', isActive);
    }
  }

  if (window.VellumState?.subscribe) {
    window.VellumState.subscribe(syncActiveState);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'vellumActiveMode' in changes) {
      setTimeout(syncActiveState, 50);
    }
  });

  // ── Show/Hide icon swap (eye ↔ eye-off) ──────────────────────────────────
  function setVisibilityIcon(isHidden) {
    const visEntry = toolEls.find(t => t.tool.id === 'vis');
    if (!visEntry) return;
    visEntry.btn.innerHTML = isHidden ? icons.visibilityOff : icons.visibility;
    visEntry.btn.setAttribute('data-tooltip', isHidden ? 'Show All' : 'Hide All');
  }

  if (window.VellumVisibility?.subscribe) {
    window.VellumVisibility.subscribe(setVisibilityIcon);
  } else {
    setVisibilityIcon(false);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.VellumDock = {
    // Lock the dock to its current pixel coordinates BEFORE filling the
    // body — otherwise the body's growth pushes the dock left/right (it's
    // centered with translateX(-50%)) and hovering the active tool becomes
    // a moving target as its info text changes width.
    mount(toolId, buildBodyFn) {
      commitPositionIfCentered();
      body.replaceChildren();
      const frag = buildBodyFn?.();
      if (frag) body.appendChild(frag);
      dock.classList.add('vellum-dock-active');
      dock.setAttribute('data-accent', toolId);
    },
    // toolId gates unmount so the outgoing tool's subscriber (which fires
    // after the incoming tool's when switching modes) doesn't clear the body
    // the new tool just installed.
    unmount(toolId) {
      if (toolId && dock.getAttribute('data-accent') !== toolId) return;
      body.replaceChildren();
      dock.classList.remove('vellum-dock-active');
      dock.removeAttribute('data-accent');
    },
    element: dock,
    bodyElement: body,
  };
})();
