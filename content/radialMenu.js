// content/radialMenu.js — Animated radial quick-access menu
//
// A floating "V" button (bottom-left) that fans out satellite buttons on hover:
//   1. Show/Hide all   2. Eraser   3. Sticky Note
//   4. Marker          5. Resizer  6. My Edited Sites
// Clicking any satellite collapses the menu. Mousing away auto-collapses after 1.5s.

(function () {
  'use strict';

  // ── SVG icon markup for each satellite ──────────────────────────────────
  const icons = {
    visibility: `<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
    visibilityOff: `<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
    eraser: `<svg viewBox="0 0 24 24"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>`,
    sticky: `<svg viewBox="0 0 24 24"><path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z"/><polyline points="15 3 15 9 21 9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>`,
    marker: `<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
    resizer: `<svg viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>`,
    sites: `<svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  };

  // ── Satellite definitions ───────────────────────────────────────────────
  // Each satellite has: id, tooltip, icon key, accent color, and click action.
  const satellites = [
    {
      id: 'vis',
      tooltip: 'Show / Hide All',
      icon: 'visibility',
      color: '#a78bfa',      // soft purple
      glow: 'rgba(167,139,250,0.3)',
      action: 'toggle-view',
    },
    {
      id: 'eraser',
      tooltip: 'Eraser',
      icon: 'eraser',
      color: '#ef4444',
      glow: 'rgba(239,68,68,0.3)',
      action: 'toggle-eraser',
      mode: 'eraser',
    },
    {
      id: 'sticky',
      tooltip: 'Sticky Note',
      icon: 'sticky',
      color: '#f59e0b',
      glow: 'rgba(245,158,11,0.3)',
      action: 'toggle-sticky',
      mode: 'sticky',
    },
    {
      id: 'marker',
      tooltip: 'Drawing Palette',
      icon: 'marker',
      color: '#7c3aed',
      glow: 'rgba(124,58,237,0.3)',
      action: 'toggle-highlighter',
      mode: 'highlight',
    },
    {
      id: 'resizer',
      tooltip: 'Resizer',
      icon: 'resizer',
      color: '#3b82f6',
      glow: 'rgba(59,130,246,0.3)',
      action: 'toggle-resizer',
      mode: 'resizer',
    },
    {
      id: 'sites',
      tooltip: 'My Edited Sites',
      icon: 'sites',
      color: '#10b981',
      glow: 'rgba(16,185,129,0.3)',
      action: 'open-sites',
    },
  ];

  // ── Geometry: fan arc from ~10° to ~100° (measuring from bottom-right, CCW) ──
  // This produces a quarter-circle arc fanning upward and to the right from bottom-left.
  const RADIUS = 58;           // px from center of V to center of satellite
  const START_ANGLE = -40;     // degrees — below horizontal (sweeps down-right)
  const END_ANGLE = 120;       // degrees — just past straight-up
  const count = satellites.length;

  function angleForIndex(i) {
    return START_ANGLE + (END_ANGLE - START_ANGLE) * (i / (count - 1));
  }

  // ── Build DOM ───────────────────────────────────────────────────────────
  const menu = document.createElement('div');
  menu.id = 'vellum-radial-menu';
  menu.setAttribute('data-vellum-ui', '1');

  // Invisible hit-zone keeps the menu open when moving between buttons
  const hitzone = document.createElement('div');
  hitzone.id = 'vellum-radial-hitzone';
  menu.appendChild(hitzone);

  // Center button
  const center = document.createElement('div');
  center.id = 'vellum-radial-center';
  center.textContent = 'V';
  menu.appendChild(center);

  // Satellite buttons
  const satEls = [];
  satellites.forEach((sat, i) => {
    const el = document.createElement('div');
    el.className = 'vellum-radial-satellite';
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

    menu.appendChild(el);
    satEls.push({ el, sat, index: i });
  });

  document.documentElement.appendChild(menu);

  // ── Position satellites when expanded ───────────────────────────────────
  function positionSatellites(expanded) {
    satEls.forEach(({ el, index }) => {
      if (expanded) {
        const angleDeg = angleForIndex(index);
        const angleRad = (angleDeg * Math.PI) / 180;
        const x = Math.cos(angleRad) * RADIUS;
        const y = -Math.sin(angleRad) * RADIUS; // negative because CSS y is down
        // Offset so satellite center aligns with center button's center
        // Center is 34px, satellite is 30px → offset = (34-30)/2 = 2
        el.style.left = (2 + x) + 'px';
        el.style.top = (2 + y) + 'px';
      } else {
        el.style.left = '2px';
        el.style.top = '2px';
      }
    });
  }

  // ── Expand / Collapse ───────────────────────────────────────────────────
  let collapseTimer = null;

  function expand() {
    clearTimeout(collapseTimer);
    if (menu.classList.contains('expanded')) return;
    menu.classList.add('expanded');
    positionSatellites(true);
    syncActiveState();
    updateVisibilityIcon();
  }

  function collapse() {
    clearTimeout(collapseTimer);
    menu.classList.remove('expanded');
    positionSatellites(false);
  }

  function scheduleCollapse() {
    clearTimeout(collapseTimer);
    collapseTimer = setTimeout(collapse, 1500);
  }

  // Hover to expand
  menu.addEventListener('mouseenter', expand);
  menu.addEventListener('mouseleave', scheduleCollapse);

  // Also support click on center to toggle
  center.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('expanded')) {
      collapse();
    } else {
      expand();
    }
  });

  // ── Satellite click handler ─────────────────────────────────────────────
  function handleSatelliteClick(sat) {
    if (sat.action === 'open-sites') {
      // Open My Edited Sites in a new tab
      chrome.runtime.sendMessage({ action: 'open-sites' });
      collapse();
      return;
    }

    if (sat.action === 'toggle-view') {
      // Visibility lives in the same page context — call it directly.
      window.VellumVisibility?.toggle();
      collapse();
      return;
    }

    // Tool toggles — send directly to this tab's content scripts
    // VellumState is on the same page, so we can call it directly.
    if (sat.action === 'toggle-eraser') {
      window.dispatchEvent(new CustomEvent('vellum-radial-action', { detail: { action: 'toggle-eraser' } }));
    } else if (sat.action === 'toggle-sticky') {
      window.dispatchEvent(new CustomEvent('vellum-radial-action', { detail: { action: 'toggle-sticky' } }));
    } else if (sat.action === 'toggle-highlighter') {
      window.dispatchEvent(new CustomEvent('vellum-radial-action', { detail: { action: 'toggle-highlighter' } }));
    } else if (sat.action === 'toggle-resizer') {
      window.dispatchEvent(new CustomEvent('vellum-radial-action', { detail: { action: 'toggle-resizer' } }));
    }

    collapse();
  }

  // ── Listen for tool actions from the radial menu (content script context) ──
  window.addEventListener('vellum-radial-action', (e) => {
    const { action } = e.detail;
    // These mirror the chrome.runtime.onMessage handlers in each tool file.
    // We use a simulated message approach via the existing message listener.
    chrome.runtime.sendMessage({ action: 'relay-to-tab', payload: { action } });
  });

  // ── Sync active tool state ──────────────────────────────────────────────
  function syncActiveState() {
    const mode = window.VellumState?.mode;
    satEls.forEach(({ el, sat }) => {
      if (sat.mode) {
        // For the marker satellite, it covers multiple sub-modes
        const isActive = sat.id === 'marker'
          ? ['highlight', 'pen', 'arrow', 'rect', 'ellipse', 'text', 'select'].includes(mode)
          : mode === sat.mode;
        el.classList.toggle('active', isActive);
      }
    });
  }

  // Listen for state changes
  if (window.VellumState?.subscribe) {
    window.VellumState.subscribe(() => syncActiveState());
  }

  // Also listen for storage changes (catches keyboard shortcut triggers)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'vellumActiveMode' in changes) {
      // Small delay to let VellumState update first
      setTimeout(syncActiveState, 50);
    }
  });

  // ── Sync the visibility satellite icon directly from VellumVisibility ──
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

})();
