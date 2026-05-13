// content/quickHighlight.js
//
// Contextual highlight popup — appears above any non-empty text selection after
// a brief dwell. Offers the 5-color Adnota palette + a "drop a sticky note"
// shortcut. Designed to never interfere with a plain Ctrl/Cmd+C copy.
//
// Settings: chrome.storage.local.adnotaQuickHighlightEnabled (default true).
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

  // Shared with the dock — dismissing the dock on a site also silences this
  // popup. One off-switch for the whole product per site.
  const hiddenDomains = new Set();
  const isHiddenHere = () => hiddenDomains.has(location.hostname);

  chrome.storage.local.get(['adnotaQuickHighlightEnabled', 'adnotaHiddenDomains'], (result) => {
    if (result.adnotaQuickHighlightEnabled === false) enabled = false;
    if (Array.isArray(result.adnotaHiddenDomains)) {
      for (const host of result.adnotaHiddenDomains) hiddenDomains.add(host);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.adnotaQuickHighlightEnabled) {
      enabled = changes.adnotaQuickHighlightEnabled.newValue !== false;
      if (!enabled) hidePopup();
    }
    if (changes.adnotaHiddenDomains) {
      hiddenDomains.clear();
      const next = changes.adnotaHiddenDomains.newValue;
      if (Array.isArray(next)) for (const host of next) hiddenDomains.add(host);
      if (isHiddenHere()) hidePopup();
    }
  });

  const THEMES = [
    { key: 'adnota-theme-yellow', color: 'rgb(255, 235, 59)', label: 'Yellow' },
    { key: 'adnota-theme-green',  color: 'rgb(76, 175, 80)',  label: 'Green' },
    { key: 'adnota-theme-blue',   color: 'rgb(33, 150, 243)', label: 'Blue' },
    { key: 'adnota-theme-pink',   color: 'rgb(233, 30, 99)',  label: 'Pink' },
    { key: 'adnota-theme-black',  color: '#111',              label: 'Redact' },
  ];

  // ── Popup construction ────────────────────────────────────────────────────

  function buildPopup() {
    const el = document.createElement('div');
    el.id = 'adnota-quick-highlight';
    el.setAttribute('data-adnota-ui', '1');
    // Prevent the selection from collapsing the moment the user presses down
    // on the popup frame or a swatch. The tag input needs real focus to accept
    // typing, so we re-allow mousedown to propagate normally inside the tag
    // row below.
    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('.adnota-qh-tag-row')) return;
      e.preventDefault();
    });

    // Row 1: [logo][swatches][dismiss] — unchanged one-tap highlight path.
    const row = document.createElement('div');
    row.className = 'adnota-qh-row';

    const logo = document.createElement('span');
    logo.className = 'adnota-qh-logo';
    logo.textContent = 'A';
    logo.setAttribute('data-adnota-tooltip', 'My Edited Sites');
    logo.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ action: 'open-sites' }).catch(() => {});
      } catch (_) {
        /* extension context invalidated after a reload — no-op */
      }
    });
    row.appendChild(logo);

    for (const theme of THEMES) {
      const dot = document.createElement('div');
      dot.className = 'adnota-qh-swatch';
      dot.setAttribute('data-adnota-tooltip', theme.label);
      dot.style.backgroundColor = theme.color;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        applyHighlight(theme.key);
      });
      row.appendChild(dot);
    }

    const dismiss = document.createElement('div');
    dismiss.className = 'adnota-select-delete adnota-qh-dismiss';
    dismiss.textContent = '✕';
    dismiss.setAttribute('data-adnota-tooltip', 'Dismiss');
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
    tagRow.className = 'adnota-qh-tag-row';

    const tagIcon = document.createElement('span');
    tagIcon.className = 'adnota-qh-tag-icon';
    tagIcon.textContent = '#';
    tagRow.appendChild(tagIcon);

    tagInput = document.createElement('input');
    tagInput.className = 'adnota-qh-tag-input';
    tagInput.type = 'text';
    tagInput.placeholder = 'tag (optional)';
    tagInput.maxLength = 40;
    tagInput.setAttribute('autocomplete', 'off');
    tagInput.setAttribute('spellcheck', 'false');
    tagRow.appendChild(tagInput);

    el.appendChild(tagRow);

    if (window.AdnotaTags) {
      window.AdnotaTags.buildAutocompleteDropdown(tagInput);
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
    if (anchorEl?.closest('[data-adnota-ui]')) return null;
    if (isEditableNode(anchorNode) || isEditableNode(selection.focusNode)) return null;

    return { selection, range };
  }

  // ── Triggers ──────────────────────────────────────────────────────────────

  document.addEventListener('mouseup', (e) => {
    if (!enabled) return;
    if (isHiddenHere()) return;
    if (suppressUntilSelectionChange) return;
    // When classic highlight mode is on, its mouseup handler auto-applies the
    // active color. Showing the popup on top would be redundant.
    if (window.AdnotaState?.mode === 'highlight') return;
    if (popup && popup.contains(e.target)) return;

    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      const cur = getCurrentSelection();
      if (!cur) return;
      const rect = cur.range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      cachedRange = cur.range.cloneRange();
      window.AdnotaLog?.event('quickhighlight', 'popup-show', {
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        text: cur.range.toString(),
      });
      positionPopup(rect);
      // Pre-fill the tag input from the highlight the selection will
      // supersede (if any). Sharing tagFromSupersedeTargets with the
      // commit path means pre-fill and click can never disagree on which
      // highlight is being edited — they consult the same target list.
      const existingTag =
        window.AdnotaHighlighter?.tagFromSupersedeTargets?.(cur.range) || '';
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
    if (e.target.closest && e.target.closest('.adnota-tag-suggest')) return;
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
    window.AdnotaVisibility?.show?.();
    // Snapshot the tag *before* hidePopup clears the input. The popup's tag
    // is taken verbatim — '' means the user explicitly cleared it, which is
    // an intentional "remove the tag" action distinct from "no tag passed."
    const tag = window.AdnotaTags
      ? window.AdnotaTags.normalize(tagInput?.value || '')
      : (tagInput?.value || '').trim();
    hidePopup();
    try { cur?.selection?.removeAllRanges(); } catch (err) {}

    // If the selection meets the supersede threshold against existing
    // highlights, edit them instead of creating a duplicate. Otherwise
    // create a fresh highlight (any sub-threshold overlap zone keeps its
    // natural CSS-Highlights blend).
    const targets = window.AdnotaHighlighter?.findSupersedeTargets?.(range) || [];
    if (targets.length > 0) {
      await window.AdnotaHighlighter.supersedeWithRange(
        targets.map(t => t.id), range, colorKey, tag);
    } else {
      await window.AdnotaHighlighter?.createHighlightFromRange?.(range, colorKey, tag);
    }
  }
})();
