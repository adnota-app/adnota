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
  let tagInput = null;
  // Cached clone of the selection range at popup-show time. Lets the tag input
  // steal focus (which collapses the live selection) without losing the range
  // we actually want to highlight when a swatch is clicked.
  let cachedRange = null;
  // Suppress re-showing until the next selection change (set after Ctrl+C so
  // the popup doesn't reappear from the still-live selection post-copy).
  let suppressUntilSelectionChange = false;

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
    // on the popup frame or a swatch. The tag input needs real focus to accept
    // typing, so we re-allow mousedown to propagate normally inside the tag
    // row below.
    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('.vellum-qh-tag-row')) return;
      e.preventDefault();
    });

    // Row 1: [logo][swatches][dismiss] — unchanged one-tap highlight path.
    const row = document.createElement('div');
    row.className = 'vellum-qh-row';

    const logo = document.createElement('span');
    logo.className = 'vellum-qh-logo';
    logo.textContent = 'A';
    logo.setAttribute('title', 'Adnota');
    row.appendChild(logo);

    for (const theme of THEMES) {
      const dot = document.createElement('div');
      dot.className = 'vellum-qh-swatch';
      dot.setAttribute('title', theme.label);
      dot.style.backgroundColor = theme.color;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        applyHighlight(theme.key);
      });
      row.appendChild(dot);
    }

    const dismiss = document.createElement('div');
    dismiss.className = 'vellum-select-delete vellum-qh-dismiss';
    dismiss.textContent = '✕';
    dismiss.setAttribute('title', 'Dismiss');
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation();
      hidePopup();
    });
    row.appendChild(dismiss);

    el.appendChild(row);

    // Row 2: tag input. Optional — leaving it empty preserves the original
    // one-tap flow (select → click swatch). Typing attaches the tag to the
    // created highlight; autocomplete pulls from every prior tag in storage.
    const tagRow = document.createElement('div');
    tagRow.className = 'vellum-qh-tag-row';

    const tagIcon = document.createElement('span');
    tagIcon.className = 'vellum-qh-tag-icon';
    tagIcon.textContent = '#';
    tagRow.appendChild(tagIcon);

    tagInput = document.createElement('input');
    tagInput.className = 'vellum-qh-tag-input';
    tagInput.type = 'text';
    tagInput.placeholder = 'tag (optional)';
    tagInput.maxLength = 40;
    tagInput.setAttribute('autocomplete', 'off');
    tagInput.setAttribute('spellcheck', 'false');
    tagRow.appendChild(tagInput);

    el.appendChild(tagRow);

    if (window.VellumTags) {
      window.VellumTags.buildAutocompleteDropdown(tagInput);
    }

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
    // Reset the tag input so each new selection starts from a blank tag.
    // Per-highlight tagging is a conscious opt-in, not a sticky preference.
    if (tagInput) tagInput.value = '';
    cachedRange = null;
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
      cachedRange = cur.range.cloneRange();
      positionPopup(rect);
      // If the selection overlaps a tagged highlight, pre-fill the tag input
      // so the user can re-apply or edit the same tag without retyping it.
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const existingTag = window.VellumHighlighter?.tagAtPoint?.(cx, cy) || '';
      if (tagInput) tagInput.value = existingTag;
    }, SHOW_DELAY_MS);
  }, true);

  document.addEventListener('selectionchange', () => {
    suppressUntilSelectionChange = false;
    // Skip the hide while the user is interacting with the tag input — the
    // selection collapses the moment focus moves, but cachedRange preserves
    // what we actually want to highlight.
    if (document.activeElement === tagInput) return;
    if (!getCurrentSelection()) hidePopup();
  });

  // Capture-phase scroll on document also fires when the tag input scrolls
  // horizontally to keep the cursor in view as the user types. Filter out
  // scrolls originating inside the popup so a long tag doesn't make the popup
  // vanish mid-typing.
  document.addEventListener('scroll', (e) => {
    if (popup && popup.contains(e.target)) return;
    hidePopup();
  }, true);
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
    // Tag autocomplete dropdown lives outside the popup (appended to <body>
    // with position:fixed). Don't hide when the user is picking a suggestion.
    if (e.target.closest && e.target.closest('.vellum-tag-suggest')) return;
    hidePopup();
  }, true);

  // ── Actions ───────────────────────────────────────────────────────────────

  async function applyHighlight(colorKey) {
    // Prefer the live selection; fall back to the cached range if the user
    // typed in the tag input (which collapses the visible selection).
    const cur = getCurrentSelection();
    const range = cur ? cur.range.cloneRange()
                      : (cachedRange ? cachedRange.cloneRange() : null);
    if (!range) { hidePopup(); return; }
    window.VellumVisibility?.show?.();
    // Snapshot the tag *before* hidePopup clears the input.
    const tag = window.VellumTags
      ? window.VellumTags.normalize(tagInput?.value || '')
      : (tagInput?.value || '').trim();
    hidePopup();
    try { cur?.selection?.removeAllRanges(); } catch (err) {}
    await window.VellumHighlighter?.createHighlightFromRange?.(range, colorKey, tag);
  }
})();
