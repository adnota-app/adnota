// content/quickHighlight.js
//
// Contextual highlight popup — appears above any non-empty text selection after
// a brief dwell. Offers the 5-color Vellum palette + a "drop a sticky note"
// shortcut. Designed to never interfere with a plain Ctrl/Cmd+C copy.
//
// Settings: chrome.storage.local.vellumQuickHighlightEnabled (default true).
//   false → feature is silent. Anticipates a future popup/radial toggle UI;
//   no content-script change needed when that lands.

(function () {
  // Short dwell — just enough to debounce against transient mid-drag mouseups.
  // Ctrl+C protection comes from the keydown handler, not from a long delay.
  const SHOW_DELAY_MS = 120;

  let enabled = true;
  let showTimer = null;
  let popup = null;
  // Suppress re-showing until the next selection change (set after Ctrl+C so
  // the popup doesn't reappear from the still-live selection post-copy).
  let suppressUntilSelectionChange = false;
  // Session-level dismiss: user clicked the × to banish the popup for this
  // page. Cleared on reload (nothing persisted), mirrors the dock's dismiss.
  let sessionDismissed = false;

  chrome.storage.local.get(['vellumQuickHighlightEnabled'], (result) => {
    if (result.vellumQuickHighlightEnabled === false) enabled = false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.vellumQuickHighlightEnabled) return;
    enabled = changes.vellumQuickHighlightEnabled.newValue !== false;
    if (!enabled) hidePopup();
  });

  const THEMES = [
    { key: 'vellum-theme-yellow', color: 'rgb(255, 235, 59)', label: 'Yellow' },
    { key: 'vellum-theme-green',  color: 'rgb(76, 175, 80)',  label: 'Green' },
    { key: 'vellum-theme-blue',   color: 'rgb(33, 150, 243)', label: 'Blue' },
    { key: 'vellum-theme-pink',   color: 'rgb(233, 30, 99)',  label: 'Pink' },
    { key: 'vellum-theme-black',  color: '#111',              label: 'Redact' },
  ];

  // ── Popup construction ────────────────────────────────────────────────────

  function buildPopup() {
    const el = document.createElement('div');
    el.id = 'vellum-quick-highlight';
    el.setAttribute('data-vellum-ui', '1');
    // Prevent the selection from collapsing the moment the user presses down
    // on any popup control — without this, the selection vanishes before the
    // click handler reads it.
    el.addEventListener('mousedown', (e) => e.preventDefault());

    // Vellum logo chip on the left — signals the popup is ours, not the
    // host site's own toolbar (Medium, Substack, etc.).
    const logo = document.createElement('span');
    logo.className = 'vellum-qh-logo';
    logo.textContent = 'V';
    logo.setAttribute('title', 'Vellum');
    el.appendChild(logo);

    for (const theme of THEMES) {
      const dot = document.createElement('div');
      dot.className = 'vellum-qh-swatch';
      dot.setAttribute('title', theme.label);
      dot.style.backgroundColor = theme.color;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        applyHighlight(theme.key);
      });
      el.appendChild(dot);
    }

    // Dismiss X — session-level "don't show me this again until I reload."
    // Reuses .vellum-select-delete styling (same red circle as the dock's X).
    const dismiss = document.createElement('div');
    dismiss.className = 'vellum-select-delete vellum-qh-dismiss';
    dismiss.textContent = '✕';
    dismiss.setAttribute('title', 'Hide on this page (reload restores)');
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation();
      sessionDismissed = true;
      hidePopup();
    });
    el.appendChild(dismiss);

    return el;
  }

  function ensurePopup() {
    if (!popup) {
      popup = buildPopup();
      document.documentElement.appendChild(popup);
    }
    return popup;
  }

  function positionPopup(rect) {
    const el = ensurePopup();
    // Measure invisibly so we can flip above/below correctly.
    el.style.visibility = 'hidden';
    el.style.display = 'flex';
    el.classList.remove('visible');
    const popupRect = el.getBoundingClientRect();

    const margin = 8;
    const viewportW = document.documentElement.clientWidth;

    let left = rect.left + (rect.width / 2) - (popupRect.width / 2);
    left = Math.max(margin, Math.min(viewportW - popupRect.width - margin, left));

    let top = rect.top - popupRect.height - margin;
    if (top < margin) top = rect.bottom + margin;

    el.style.left = `${left + window.pageXOffset}px`;
    el.style.top  = `${top  + window.pageYOffset}px`;
    el.style.visibility = '';
    // Next frame so the opacity transition fires.
    requestAnimationFrame(() => el.classList.add('visible'));
  }

  function hidePopup() {
    clearTimeout(showTimer);
    showTimer = null;
    if (popup) {
      popup.classList.remove('visible');
      popup.style.display = 'none';
    }
  }

  // ── Selection gating ──────────────────────────────────────────────────────

  function isEditableNode(node) {
    if (!node) return false;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!el?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]');
  }

  function getCurrentSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!range.toString().trim()) return null;

    const anchorNode = selection.anchorNode;
    const anchorEl = anchorNode?.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode?.parentElement;
    if (anchorEl?.closest('[data-vellum-ui]')) return null;
    if (isEditableNode(anchorNode) || isEditableNode(selection.focusNode)) return null;

    return { selection, range };
  }

  // ── Triggers ──────────────────────────────────────────────────────────────

  document.addEventListener('mouseup', (e) => {
    if (!enabled) return;
    if (sessionDismissed) return;
    if (suppressUntilSelectionChange) return;
    // When classic highlight mode is on, its mouseup handler auto-applies the
    // active color. Showing the popup on top would be redundant.
    if (window.VellumState?.mode === 'highlight') return;
    if (popup && popup.contains(e.target)) return;

    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      const cur = getCurrentSelection();
      if (!cur) return;
      const rect = cur.range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      positionPopup(rect);
    }, SHOW_DELAY_MS);
  }, true);

  document.addEventListener('selectionchange', () => {
    suppressUntilSelectionChange = false;
    if (!getCurrentSelection()) hidePopup();
  });

  document.addEventListener('scroll', hidePopup, true);
  window.addEventListener('resize', hidePopup);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hidePopup();
      return;
    }
    // Treat Ctrl/Cmd+C as an explicit "I wanted to copy" signal — hide the
    // popup and suppress it until the user starts a new selection. Never
    // preventDefault: the browser's copy must still fire.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      hidePopup();
      suppressUntilSelectionChange = true;
    }
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (popup && popup.contains(e.target)) return;
    hidePopup();
  }, true);

  // ── Actions ───────────────────────────────────────────────────────────────

  async function applyHighlight(colorKey) {
    const cur = getCurrentSelection();
    if (!cur) { hidePopup(); return; }
    window.VellumVisibility?.show?.();
    const range = cur.range.cloneRange();
    hidePopup();
    try { cur.selection.removeAllRanges(); } catch (err) {}
    await window.VellumHighlighter?.createHighlightFromRange?.(range, colorKey);
  }
})();
