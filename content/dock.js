// content/dock.js — The Adnota Dock
//
// One persistent fixed-position widget. Two visual states, toggled by which
// tool (if any) is active:
//
//   idle   — [drag][V][eraser][sticky][marker][resizer][scratch][vis]
//            Tool row is always visible, one click away.
//   active — [drag][← back][tool HUD body grows right →]
//            The tool row collapses, V morphs into an accent-colored back
//            arrow, and the tool's own controls fill the body slot.
//
// Back arrow / Escape / clicking the active tool again all exit the tool.
// Tools register their controls via AdnotaDock.mount(toolId, buildFn) on
// entry, AdnotaDock.unmount(toolId) on exit.

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
    scratch: `<svg viewBox="0 0 24 24"><line x1="6" y1="5" x2="14" y2="5"/><line x1="6" y1="10" x2="18" y2="10"/><line x1="6" y1="15" x2="18" y2="15"/><line x1="6" y1="20" x2="14" y2="20"/></svg>`,
    back:    `<svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>`,
  };

  // Left-to-right order in the idle row. Tool modes (eraser/sticky/marker/
  // resizer) come first as a group, then Show/Hide at the end — it's a
  // global toggle, not a tool mode, and sits visually apart for that reason.
  const toolDefs = [
    { id: 'eraser',  tooltip: 'Eraser (e)',              icon: 'eraser',     action: 'toggle-eraser',      mode: 'eraser',    accent: 'eraser'    },
    { id: 'sticky',  tooltip: 'Sticky Note (s)',         icon: 'sticky',     action: 'toggle-sticky',      mode: 'sticky',    accent: 'sticky'    },
    { id: 'marker',  tooltip: 'Draw (d)',                icon: 'marker',     action: 'toggle-highlighter', mode: 'highlight', accent: 'highlight' },
    { id: 'resizer', tooltip: 'Resizer (r)',             icon: 'resizer',    action: 'toggle-resizer',     mode: 'resizer',   accent: 'resizer'   },
    { id: 'scratch', tooltip: 'Page snippets (p)',       icon: 'scratch',    action: 'toggle-scratch' },
    { id: 'vis',     tooltip: 'Show / Hide All (Alt+S)', icon: 'visibility', action: 'toggle-view' },
  ];

  // Drawing sub-modes all count as "marker" for the active-state indicator.
  const MARKER_SUB_MODES = new Set(['highlight', 'pen', 'arrow', 'rect', 'ellipse', 'text', 'select']);

  // ── Build DOM ─────────────────────────────────────────────────────────────
  const dock = document.createElement('div');
  dock.id = 'adnota-dock';
  dock.setAttribute('data-adnota-ui', '1');

  const dragHandle = document.createElement('span');
  dragHandle.className = 'adnota-toolbar-drag';
  dragHandle.textContent = '⡇';
  dragHandle.setAttribute('data-tooltip', 'Drag to reposition');
  dock.appendChild(dragHandle);

  // Home chrome: V logo (idle) OR back arrow (active). They share a slot so
  // the dock's left edge is visually anchored across state transitions.
  const home = document.createElement('div');
  home.className = 'adnota-dock-home';

  const logo = document.createElement('span');
  logo.className = 'adnota-dock-logo';
  logo.textContent = 'A';
  logo.setAttribute('data-tooltip', 'My Edited Sites');
  logo.addEventListener('click', (e) => {
    e.stopPropagation();
    // Try/catch + .catch: after a Adnota reload, any tab already loaded
    // has a stale content-script context. chrome.runtime.sendMessage
    // throws SYNCHRONOUSLY in that case ("Extension context invalidated"),
    // so .catch() alone doesn't help — it only handles async rejection.
    try {
      chrome.runtime.sendMessage({ action: 'open-sites' }).catch(() => {});
    } catch (_) {
      /* context invalidated after extension reload — reload the page */
    }
  });
  home.appendChild(logo);

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'adnota-dock-back';
  back.setAttribute('data-tooltip', 'Exit tool (Esc)');
  back.innerHTML = icons.back;
  back.addEventListener('click', (e) => {
    e.stopPropagation();
    window.AdnotaState?.set({ mode: null });
  });
  home.appendChild(back);

  dock.appendChild(home);

  // Tool row — always-visible when idle, hidden when a tool is active.
  const toolRow = document.createElement('div');
  toolRow.className = 'adnota-dock-tools';

  const toolEls = [];
  for (const tool of toolDefs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'adnota-dock-tool';
    btn.setAttribute('data-adnota-ui', '1');
    btn.setAttribute('data-tooltip', tool.tooltip);
    btn.setAttribute('data-tool-id', tool.id);
    if (tool.accent) btn.setAttribute('data-accent', tool.accent);
    btn.innerHTML = icons[tool.icon];
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleToolClick(tool, btn);
    });
    toolRow.appendChild(btn);
    toolEls.push({ btn, tool });
  }

  dock.appendChild(toolRow);

  // Tool body — mounted into when a tool is active. Grows right from the
  // back arrow, shares the same frosted-glass panel.
  const body = document.createElement('div');
  body.className = 'adnota-dock-body';
  dock.appendChild(body);

  // Dismiss X — "get off my screen" button. Appears on hover, only when
  // idle (a tool being active means the dock IS the HUD, so hiding it would
  // strand the user). Clicking hides the dock until the user activates a
  // tool (via popup or keyboard shortcut) or reloads the page.
  // Reuses .adnota-select-delete — identical red-X affordance as the marker
  // select-tool delete. .adnota-dock-dismiss layers on the hover-reveal +
  // positioning behavior.
  const dismissBtn = document.createElement('div');
  dismissBtn.className = 'adnota-select-delete adnota-dock-dismiss';
  dismissBtn.textContent = '✕';
  dismissBtn.setAttribute('data-tooltip', 'Hide on this site (Alt+A restores)');
  dock.appendChild(dismissBtn);

  document.documentElement.appendChild(dock);

  // ── Position persistence ──────────────────────────────────────────────────
  // The dock starts centered (left:50% + transform). On first drag OR first
  // tool mount, commit to absolute px and persist so the spot survives reloads.
  const POSITION_KEY = 'adnotaDockPosition';
  const HIDDEN_DOMAINS_KEY = 'adnotaHiddenDomains';
  const TUTORIAL_KEY = 'adnotaDockDismissTutorialShown';

  // Per-domain dismiss state. Mirrored to chrome.storage.local as an array;
  // a Set in memory for O(1) checks. The X persists this. Alt+A and any
  // popup-driven restore (popup-open, tool activation) clear it. Symmetric
  // toggle — whatever the user last did is what sticks.
  const hiddenDomains = new Set();

  function persistHiddenDomains() {
    try {
      chrome.storage.local.set({
        [HIDDEN_DOMAINS_KEY]: Array.from(hiddenDomains),
      }).catch(() => {});
    } catch (_) { /* context invalidated after extension reload */ }
  }

  function commitPositionIfCentered() {
    if (dock.style.left === '50%' || dock.style.left === '') {
      const rect = dock.getBoundingClientRect();
      dock.style.left = rect.left + 'px';
      dock.style.top = rect.top + 'px';
      dock.style.bottom = 'auto';
      dock.style.transform = 'none';
    }
  }

  // Keep at least this many pixels of the dock on-screen in every direction so
  // a user can always grab it back. Without this guard the dock can be dragged
  // fully off the viewport and that off-screen position then persists across
  // reloads, leaving the dock invisible and unreachable.
  const MIN_VISIBLE_PX = 40;
  function clampToViewport(left, top) {
    const r = dock.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      left: Math.max(MIN_VISIBLE_PX - r.width, Math.min(vw - MIN_VISIBLE_PX, left)),
      top:  Math.max(0,                        Math.min(vh - MIN_VISIBLE_PX, top)),
    };
  }

  // Same stale-context guard as the V-logo and tool-click handlers: after a
  // Adnota reload, chrome.storage.local.set throws SYNCHRONOUSLY ("Extension
  // context invalidated"), so .catch() alone won't help — it only handles
  // async rejection.
  function persistPosition() {
    if (dock.style.left && dock.style.left !== '50%') {
      try {
        chrome.storage.local.set({
          [POSITION_KEY]: { left: dock.style.left, top: dock.style.top },
        }).catch(() => {});
      } catch (_) { /* context invalidated after extension reload */ }
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
    const targetLeft = dragState.startLeft + (e.clientX - dragState.startX);
    const targetTop  = dragState.startTop  + (e.clientY - dragState.startY);
    const clamped = clampToViewport(targetLeft, targetTop);
    dock.style.left = clamped.left + 'px';
    dock.style.top = clamped.top + 'px';
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

  // ── Restore saved position + dismiss state ───────────────────────────────
  // Dock is visibility:hidden until this resolves so we never flash at the
  // default center position when a saved spot exists. Reading hidden-domains
  // here too means a blacklisted domain never flashes the dock visible
  // either — applyDismissState runs before .adnota-dock-ready is added.
  function markReady() {
    dock.classList.add('adnota-dock-ready');
  }
  chrome.storage.local.get([POSITION_KEY, HIDDEN_DOMAINS_KEY]).then((data) => {
    const pos = data[POSITION_KEY];
    if (pos?.left && pos?.top) {
      dock.style.left = pos.left;
      dock.style.top = pos.top;
      dock.style.bottom = 'auto';
      dock.style.transform = 'none';
      // Saved position may now be off-screen (window resized to a smaller
      // display, or pre-clamp build dragged it off). Pull it back in and
      // re-persist so the dock is reachable from the next load on.
      const left = parseFloat(pos.left);
      const top  = parseFloat(pos.top);
      const clamped = clampToViewport(left, top);
      if (clamped.left !== left || clamped.top !== top) {
        dock.style.left = clamped.left + 'px';
        dock.style.top = clamped.top + 'px';
        persistPosition();
      }
    }
    const stored = data[HIDDEN_DOMAINS_KEY];
    if (Array.isArray(stored)) {
      for (const h of stored) hiddenDomains.add(h);
    }
    applyDismissState();
    markReady();
  }).catch(markReady);

  // ── Tool button clicks ────────────────────────────────────────────────────
  function handleToolClick(tool, btn) {
    // Honor the disabled affordance on utility buttons (currently only the
    // scratch button uses this, when there's nothing to recall on the page).
    if (btn?.getAttribute('data-disabled') === '1') return;
    if (tool.action === 'toggle-view') {
      window.AdnotaVisibility?.toggle();
      return;
    }
    if (tool.action === 'toggle-scratch') {
      window.AdnotaScratchPad?.toggle();
      return;
    }
    // Fire the tool's toggle through the background relay so the content
    // script's runtime message listener handles it (same path keyboard
    // shortcuts take). Same stale-context guard as the V-logo handler —
    // sendMessage throws synchronously when the extension has been
    // reloaded since this tab was opened.
    try {
      chrome.runtime.sendMessage({
        action: 'relay-to-tab',
        payload: { action: tool.action },
      }).catch(() => {});
    } catch (_) { /* context invalidated */ }
  }

  // ── Dismiss / restore ────────────────────────────────────────────────────
  // Per-domain persisted via the hiddenDomains Set. Symmetric toggle:
  // X writes hidden, Alt+A / popup-open / tool-activation-via-popup all
  // clear hidden. Whatever the user last did is what sticks.
  function isHiddenHere() {
    return hiddenDomains.has(location.hostname);
  }

  function applyDismissState() {
    const modeActive = window.AdnotaState?.mode != null;
    if (isHiddenHere() && !modeActive) {
      dock.style.display = 'none';
      return;
    }
    dock.style.display = '';
    // Tool activation is a strong "I want this here" signal — un-blacklist
    // the domain so it persists visible on the next load too. Symmetric to
    // the X writing hidden.
    if (modeActive && isHiddenHere()) {
      hiddenDomains.delete(location.hostname);
      persistHiddenDomains();
    }
  }

  async function maybeShowDismissTutorial() {
    try {
      const data = await chrome.storage.local.get(TUTORIAL_KEY);
      if (data[TUTORIAL_KEY]) return;
      await chrome.storage.local.set({ [TUTORIAL_KEY]: true });
      window.AdnotaUI?.showToast(
        `Adnota hidden on ${location.hostname}. It'll stay hidden here until you bring it back with Alt+A or the extension icon.`,
        { id: 'adnota-dock-dismiss-tutorial', timeout: 7000 }
      );
    } catch (_) { /* context invalidated after extension reload */ }
  }

  dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.AdnotaLog?.event('dock', 'dismiss-x', { host: location.hostname });
    hiddenDomains.add(location.hostname);
    persistHiddenDomains();
    applyDismissState();
    maybeShowDismissTutorial();
  });

  // ── Alt+A → toggle dock visibility (per-domain persisted) ─────────────────
  // Symmetric counterpart to the X button: press on a hidden domain → restore
  // and un-blacklist; press on a visible domain → hide and blacklist. While
  // a tool is active, exits the tool AND hides in one keystroke.
  // applyDismissState would otherwise force-show + un-blacklist when mode !=
  // null, so we clear the mode BEFORE flipping the hidden state.
  //
  // restore-dock is the popup's "I'm engaging — bring it back" ping. It only
  // un-hides; it doesn't toggle, so opening the popup on an already-visible
  // dock is a no-op rather than accidentally hiding it.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === 'toggle-dock') {
      const willHide = dock.style.display !== 'none';
      if (willHide && window.AdnotaState?.mode != null) {
        window.AdnotaState.set({ mode: null });
      }
      if (willHide) {
        hiddenDomains.add(location.hostname);
      } else {
        hiddenDomains.delete(location.hostname);
      }
      persistHiddenDomains();
      applyDismissState();
      return;
    }
    if (msg?.action === 'restore-dock') {
      if (isHiddenHere()) {
        hiddenDomains.delete(location.hostname);
        persistHiddenDomains();
        applyDismissState();
      }
    }
  });

  // Cross-tab consistency: if another tab on the same domain (or the popup)
  // mutates the hidden set, mirror it here within ~1 frame. Pattern matches
  // lib/log.js's live debug-flag listener.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(HIDDEN_DOMAINS_KEY in changes)) return;
    const next = changes[HIDDEN_DOMAINS_KEY].newValue;
    hiddenDomains.clear();
    if (Array.isArray(next)) {
      for (const h of next) hiddenDomains.add(h);
    }
    applyDismissState();
  });

  // ── Bare-key tool activation ──────────────────────────────────────────────
  // Modal-by-presence: the dock being on screen IS "annotation mode armed."
  // No leader-key timeout — if you can see the dock, e/r/s/d toggle tools.
  // If the dock is dismissed, bare keys do nothing (Alt+A brings it back).
  const BARE_KEY_ACTIONS = {
    e: 'toggle-eraser',
    r: 'toggle-resizer',
    s: 'toggle-sticky',
    d: 'toggle-highlighter',
  };

  // Bare keys that bypass the relay path because the target lives in this
  // same content-script context. Disabled-state on the dock button still
  // gates the keypress so the affordances stay in sync.
  const BARE_KEY_DIRECT = {
    p: () => {
      const entry = toolEls.find(t => t.tool.id === 'scratch');
      if (entry?.btn.getAttribute('data-disabled') === '1') return;
      window.AdnotaScratchPad?.toggle();
    },
  };

  function isEditableNode(node) {
    if (!node) return false;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!el?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]');
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (dock.style.display === 'none') return;
    if (isEditableNode(document.activeElement)) return;
    const key = e.key?.toLowerCase();
    const direct = BARE_KEY_DIRECT[key];
    if (direct) {
      e.preventDefault();
      e.stopPropagation();
      direct();
      return;
    }
    const action = BARE_KEY_ACTIONS[key];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    // Same relay path the popup and dock-button clicks use, so every
    // tool's existing toggle listener handles the actual mode flip.
    try {
      chrome.runtime.sendMessage({
        action: 'relay-to-tab',
        payload: { action },
      }).catch(() => {});
    } catch (_) { /* context invalidated after extension reload */ }
  }, true);

  // ── Active-tool indicator on the idle row ────────────────────────────────
  // Briefly visible during mode transitions and during the window between
  // hitting a shortcut and the body mounting. Also keeps the row readable if
  // a tool fails to mount its body for some reason.
  function syncActiveState() {
    const mode = window.AdnotaState?.mode;
    for (const { btn, tool } of toolEls) {
      if (!tool.mode) continue;
      const isActive = tool.id === 'marker'
        ? MARKER_SUB_MODES.has(mode)
        : mode === tool.mode;
      btn.classList.toggle('active', isActive);
    }
  }

  if (window.AdnotaState?.subscribe) {
    window.AdnotaState.subscribe(() => {
      syncActiveState();
      applyDismissState();
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'adnotaActiveMode' in changes) {
      setTimeout(() => {
        syncActiveState();
        applyDismissState();
      }, 50);
    }
  });

  // ── Show/Hide icon swap (eye ↔ eye-off) ──────────────────────────────────
  function setVisibilityIcon(isHidden) {
    const visEntry = toolEls.find(t => t.tool.id === 'vis');
    if (!visEntry) return;
    visEntry.btn.innerHTML = isHidden ? icons.visibilityOff : icons.visibility;
    visEntry.btn.setAttribute('data-tooltip', isHidden ? 'Show All (Alt+S)' : 'Hide All (Alt+S)');
  }

  if (window.AdnotaVisibility?.subscribe) {
    window.AdnotaVisibility.subscribe(setVisibilityIcon);
  } else {
    setVisibilityIcon(false);
  }

  // ── Scratch-pad button: disabled when the page has no text snippets ──────
  // The user explicitly wanted the button to "tease" only when there's
  // something to recall. AdnotaScratchPad.pageSnippetCount() reads the same
  // getAnchorsForUrl path the panel itself uses, so the affordance can never
  // disagree with what the panel would show.
  function refreshScratchEnabled() {
    const entry = toolEls.find(t => t.tool.id === 'scratch');
    if (!entry || !window.AdnotaScratchPad?.pageSnippetCount) return;
    window.AdnotaScratchPad.pageSnippetCount().then((count) => {
      if (count > 0) {
        entry.btn.removeAttribute('data-disabled');
        entry.btn.removeAttribute('aria-disabled');
      } else {
        entry.btn.setAttribute('data-disabled', '1');
        entry.btn.setAttribute('aria-disabled', 'true');
      }
    }).catch(() => {});
  }

  // Initial check + every time storage for this domain changes (the only
  // path that creates/removes snippets). Cheap — getAnchorsForUrl reads one
  // domain key.
  refreshScratchEnabled();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[location.hostname]) refreshScratchEnabled();
  });

  // SPA URL changes (claude.ai, ChatGPT, etc.) don't touch storage but do
  // change the page's path, so what counts as "this page's snippets" can
  // shift. Mirrors the Navigation API hook the restorer already uses, with
  // a popstate fallback.
  if (typeof window.navigation?.addEventListener === 'function') {
    try {
      window.navigation.addEventListener('navigate', () => {
        setTimeout(refreshScratchEnabled, 50);
      });
    } catch (_) {}
  } else {
    window.addEventListener('popstate', () => {
      setTimeout(refreshScratchEnabled, 50);
    });
  }

  // The body's CSS uses overflow-x: clip during the slide-in so contents don't
  // bleed past the growing max-width box. Once expanded, we lift the clip so
  // tooltips on the leftmost/rightmost buttons (which are wider than their
  // host buttons) can render past the body's edges. Matches the max-width
  // transition duration in dock.css.
  const SLIDE_MS = 180;
  let unclipTimer = null;

  // ── Public API ────────────────────────────────────────────────────────────
  window.AdnotaDock = {
    // Lock the dock to its current pixel coordinates BEFORE filling the
    // body — otherwise the body's growth pushes the dock left/right (it's
    // centered with translateX(-50%)) and hovering the active tool becomes
    // a moving target as its info text changes width.
    mount(toolId, buildBodyFn) {
      window.AdnotaLog?.event('dock', 'mount', { toolId });
      commitPositionIfCentered();
      body.replaceChildren();
      const frag = buildBodyFn?.();
      if (frag) body.appendChild(frag);
      dock.classList.add('adnota-dock-active');
      dock.setAttribute('data-accent', toolId);
      body.style.overflow = '';
      clearTimeout(unclipTimer);
      unclipTimer = setTimeout(() => { body.style.overflow = 'visible'; }, SLIDE_MS);
    },
    // toolId gates unmount so the outgoing tool's subscriber (which fires
    // after the incoming tool's when switching modes) doesn't clear the body
    // the new tool just installed.
    unmount(toolId) {
      if (toolId && dock.getAttribute('data-accent') !== toolId) return;
      window.AdnotaLog?.event('dock', 'unmount', { toolId });
      clearTimeout(unclipTimer);
      body.style.overflow = '';
      body.replaceChildren();
      dock.classList.remove('adnota-dock-active');
      dock.removeAttribute('data-accent');
    },
    element: dock,
    bodyElement: body,
  };
})();
