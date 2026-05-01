// content/scratchPad.js — per-page text snippet quick view
//
// A floating frosted-glass panel that lists the current URL's HIGHLIGHT and
// NOTE items as plain prose. TEXT IS KING — no per-item color borders, no
// source chips, no card chrome. Just the text, optional #tag, and per-item
// copy. Companion to a new dock button (left of the visibility eye) and the
// bare-key 'f' shortcut.
//
// Public API on window.AdnotaScratchPad:
//   toggle(), open(), close(), isOpen(), refresh()

(function () {
  'use strict';

  const FILTER_KEY    = 'adnotaScratchFilter';
  const TAG_BAR_KEY   = 'adnotaScratchTagBarVisible';
  const POSITION_KEY  = 'adnotaScratchPosition';
  const SIZE_KEY      = 'adnotaScratchSize';
  const REDACTION     = 'adnota-theme-black';
  const FADE_DELAY_MS = 600;
  const COPY_REVERT_MS = 1400;

  let panel        = null;
  let bodyEl       = null;
  let copyAllBtn   = null;
  let filterEls    = [];
  let tagBarEl     = null;
  let tagToggleBtn = null;
  let snippetCache = [];
  let activeFilter = 'all';
  // Tag filter is in-memory only — resets when the panel closes. The bar's
  // visibility persists globally so opening the panel restores the user's
  // chrome preference, but the active chip clears so a stale tag doesn't
  // hide everything on a new host.
  let activeTag    = null;
  let tagBarVisible = false;
  let storageListener = null;
  let resizeObserver  = null;
  let resizePersistTimer = null;
  let mouseLeaveTimer = null;
  let navListener     = null;
  let popstateListener = null;
  // Set true on a committed drag (pointer moved past the threshold) so the
  // synthetic click that fires on pointerup gets swallowed. Otherwise a
  // drag that started on the Copy-all or filter pill would fire that
  // button's action on release.
  let suppressNextClick = false;
  const DRAG_THRESHOLD = 4;

  // Cooperate with the universal Escape handler in lib/annotationState.js.
  // That handler is window-capture phase and clears AdnotaState.mode
  // synchronously; our onEscape runs in the bubble phase, so by the time it
  // fires, mode is already null and we can't tell whether the user was
  // actually exiting a tool. Subscribing to AdnotaState gives us a
  // synchronous hook inside the set() call — when mode flips to null we
  // raise a 100ms "tool just exited" flag and let our Escape handler defer.
  // Mounted at script load (not panel open) so the subscription doesn't
  // churn on every open/close.
  let _toolJustExited = false;
  let _toolJustExitedTimer = null;
  let _lastMode = null;
  if (typeof window.AdnotaState?.subscribe === 'function') {
    window.AdnotaState.subscribe(() => {
      const m = window.AdnotaState?.mode ?? null;
      if (_lastMode != null && m == null) {
        _toolJustExited = true;
        clearTimeout(_toolJustExitedTimer);
        _toolJustExitedTimer = setTimeout(() => { _toolJustExited = false; }, 100);
      }
      _lastMode = m;
    });
  }

  function host() { return location.hostname || '_'; }

  function isRedaction(s) {
    return s.type === 'highlight' && s.color === REDACTION;
  }

  function redactionBar(text) {
    const n = Math.max(6, Math.min(48, (text || '').length));
    return '█'.repeat(n);
  }

  function safeStorageSet(payload) {
    try { chrome.storage.local.set(payload).catch(() => {}); } catch (_) {}
  }

  // ── Icons ──────────────────────────────────────────────────────────────────
  const ICON_COPY  = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M3 13V5a2 2 0 0 1 2-2h8"/></svg>`;
  const ICON_CHECK = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 11 8 15 16 5"/></svg>`;
  const ICON_CLOSE = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/></svg>`;
  // Crosshair / target — clearer "go to this" affordance than an arrow,
  // which reads as "move" or "drag."
  const ICON_GOTO  = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6"/><line x1="10" y1="2" x2="10" y2="5"/><line x1="10" y1="15" x2="10" y2="18"/><line x1="2" y1="10" x2="5" y2="10"/><line x1="15" y1="10" x2="18" y2="10"/></svg>`;
  // Trash glyph mirrors lib/adnotaUI.js ICONS.trash and pages/sites.js so the
  // delete affordance reads identically across Home, HUD, and scratch pad.
  const ICON_TRASH = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 17 6"/><path d="M15 6v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 9v6"/><path d="M12 9v6"/><path d="M8 6V4h4v2"/></svg>`;
  // Funnel — toggles the tag-filter sub-header. Mirrors the FILTER label on
  // pages/sites.js but as an icon to keep the panel header dense.
  const ICON_FILTER = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h14l-5.5 7v5l-3 1.5V11L3 4z"/></svg>`;
  // Clipboard with list lines — "copy everything" semantics, distinct from
  // ICON_COPY's duplicate-rectangle glyph used for the per-row action.
  const ICON_COPY_ALL = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="10" height="13" rx="1.5"/><path d="M8 3h4v3H8z"/><line x1="7.5" y1="9.5" x2="12.5" y2="9.5"/><line x1="7.5" y1="12" x2="12.5" y2="12"/><line x1="7.5" y1="14.5" x2="11" y2="14.5"/></svg>`;

  // ── Snippet derivation ────────────────────────────────────────────────────
  async function loadSnippets() {
    if (!window.AdnotaStorage) return [];
    const items = await AdnotaStorage.getAnchorsForUrl(location.href);
    const out = [];
    for (const item of items) {
      if (item.action === 'HIGHLIGHT') {
        out.push({
          id: item._id ?? `h-${item.timestamp ?? Math.random()}`,
          type: 'highlight',
          text: item.text ?? '',
          color: item.color,
          tag: item.tag,
          ts: item.timestamp ?? item.createdAt ?? 0,
        });
      } else if (item.action === 'NOTE') {
        const body = (item.comments?.[0]?.text ?? '').trim();
        if (!body) continue;
        out.push({
          id: item.uuid,
          type: 'note',
          text: body,
          tag: item.tag,
          ts: item.updatedAt ?? item.createdAt ?? 0,
        });
      }
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }

  function filtered() {
    let list = snippetCache;
    if (activeFilter === 'highlights') list = list.filter(s => s.type === 'highlight');
    else if (activeFilter === 'notes') list = list.filter(s => s.type === 'note');
    if (activeTag) list = list.filter(s => s.tag === activeTag);
    return list;
  }

  // ── Public helper used by the dock to drive its disabled state ───────────
  // Returns the current page's HIGHLIGHT + NOTE count without forcing the
  // panel to be open. The dock greys its scratch button out at zero.
  async function pageSnippetCount() {
    const list = await loadSnippets();
    return list.length;
  }

  // ── DOM ──────────────────────────────────────────────────────────────────
  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'adnota-scratchpad';
    panel.setAttribute('data-adnota-ui', '1');

    const header = document.createElement('div');
    header.className = 'adnota-scratchpad-header';

    const filters = document.createElement('div');
    filters.className = 'adnota-scratchpad-filters';
    filterEls = [];
    for (const [val, label] of [['all', 'All'], ['highlights', 'Highlights'], ['notes', 'Notes']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'adnota-scratchpad-filter';
      btn.dataset.value = val;
      btn.dataset.label = label;
      btn.textContent = label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setFilter(val);
      });
      filters.appendChild(btn);
      filterEls.push({ btn, value: val, label });
    }
    header.appendChild(filters);

    tagToggleBtn = document.createElement('button');
    tagToggleBtn.type = 'button';
    tagToggleBtn.className = 'adnota-scratchpad-filterbtn';
    tagToggleBtn.title = 'Filter by tag';
    tagToggleBtn.innerHTML = ICON_FILTER;
    tagToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setTagBarVisible(!tagBarVisible);
    });
    header.appendChild(tagToggleBtn);

    copyAllBtn = document.createElement('button');
    copyAllBtn.type = 'button';
    copyAllBtn.className = 'adnota-scratchpad-copyall';
    copyAllBtn.title = 'Copy all';
    copyAllBtn.innerHTML = ICON_COPY_ALL;
    copyAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyAll();
    });
    header.appendChild(copyAllBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'adnota-scratchpad-close';
    closeBtn.title = 'Close';
    closeBtn.innerHTML = ICON_CLOSE;
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
    });
    header.appendChild(closeBtn);

    panel.appendChild(header);

    tagBarEl = document.createElement('div');
    tagBarEl.className = 'adnota-scratchpad-tagbar';
    tagBarEl.hidden = true;
    panel.appendChild(tagBarEl);

    bodyEl = document.createElement('div');
    bodyEl.className = 'adnota-scratchpad-body';
    panel.appendChild(bodyEl);

    // Drag from anywhere on the header — buttons included. The handler
    // distinguishes click from drag via a movement threshold.
    header.addEventListener('pointerdown', (e) => onDragStart(e));

    // Capture-phase click suppressor — swallows the synthetic click that
    // fires on pointerup after a real drag, so the button under the
    // starting pointer doesn't trigger (e.g., dragging from Copy all
    // shouldn't actually copy on release).
    panel.addEventListener('click', (e) => {
      if (!suppressNextClick) return;
      suppressNextClick = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);

    // Idle transparency: 60% when cursor hasn't been over the panel for a
    // grace period; snaps to 100% on mouseenter. The header keeps a higher
    // alpha via its own CSS so the panel stays findable when faded.
    panel.addEventListener('mouseenter', () => {
      clearTimeout(mouseLeaveTimer);
      panel.classList.remove('adnota-scratchpad-idle');
    });
    panel.addEventListener('mouseleave', () => {
      clearTimeout(mouseLeaveTimer);
      mouseLeaveTimer = setTimeout(() => {
        if (panel) panel.classList.add('adnota-scratchpad-idle');
      }, FADE_DELAY_MS);
    });

    document.documentElement.appendChild(panel);

    restoreSize();
    restorePosition();
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function render() {
    if (!panel) return;
    const list = filtered();

    // Type-filter counts reflect total per type, ignoring the active tag —
    // mirrors how the home page tag chips work, so each chip group shows
    // absolute availability rather than a recursive intersection.
    const counts = {
      all:        snippetCache.length,
      highlights: snippetCache.filter(s => s.type === 'highlight').length,
      notes:      snippetCache.filter(s => s.type === 'note').length,
    };
    for (const { btn, value, label } of filterEls) {
      btn.classList.toggle('active', value === activeFilter);
      btn.textContent = '';
      btn.append(`${label} · `);
      const c = document.createElement('span');
      c.className = 'adnota-scratchpad-filter-count';
      c.textContent = String(counts[value] ?? 0);
      btn.appendChild(c);
    }

    renderTagBar();

    bodyEl.replaceChildren();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'adnota-scratchpad-empty';
      empty.textContent = activeFilter === 'all'
        ? 'No snippets on this page yet.'
        : `No ${activeFilter} on this page.`;
      bodyEl.appendChild(empty);
      copyAllBtn.disabled = true;
      copyAllBtn.classList.remove('copied');
      return;
    }
    copyAllBtn.disabled = false;

    list.forEach((snippet) => {
      bodyEl.appendChild(buildRow(snippet));
    });
  }

  function buildRow(snippet) {
    const row = document.createElement('div');
    row.className = 'adnota-scratchpad-row';

    const text = document.createElement('div');
    text.className = 'adnota-scratchpad-text';
    if (isRedaction(snippet)) {
      text.classList.add('adnota-scratchpad-redaction');
      text.textContent = redactionBar(snippet.text);
      text.title = 'Redacted';
    } else {
      text.textContent = snippet.text;
    }
    row.appendChild(text);

    // Tags deliberately omitted from the row — they pollute drag-select copy.
    // Use the funnel button in the header to filter by tag instead.

    const gotoBtn = document.createElement('button');
    gotoBtn.type = 'button';
    gotoBtn.className = 'adnota-scratchpad-rowgoto';
    gotoBtn.title = 'Go to this on the page';
    gotoBtn.innerHTML = ICON_GOTO;
    gotoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      gotoSnippet(snippet);
    });
    row.appendChild(gotoBtn);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'adnota-scratchpad-rowcopy';
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = ICON_COPY;
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const payload = isRedaction(snippet) ? redactionBar(snippet.text) : snippet.text;
      try { await navigator.clipboard.writeText(payload); }
      catch (_) { return; }
      copyBtn.classList.add('copied');
      copyBtn.innerHTML = ICON_CHECK;
      setTimeout(() => {
        if (!copyBtn.isConnected) return;
        copyBtn.classList.remove('copied');
        copyBtn.innerHTML = ICON_COPY;
      }, COPY_REVERT_MS);
      window.AdnotaLog?.event('scratchpad', 'copy', { type: snippet.type, len: payload.length });
    });
    row.appendChild(copyBtn);

    const trashBtn = document.createElement('button');
    trashBtn.type = 'button';
    trashBtn.className = 'adnota-scratchpad-rowtrash';
    trashBtn.title = snippet.type === 'highlight' ? 'Delete this quote' : 'Delete this note';
    trashBtn.innerHTML = ICON_TRASH;
    trashBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      deleteSnippet(snippet);
    });
    row.appendChild(trashBtn);

    return row;
  }

  // ── Per-item soft-delete ─────────────────────────────────────────────────
  // Mirrors pages/sites.js deleteFeedItem: snapshot the storage form, splice
  // it out by id, show a 5s undo toast that re-pushes the snapshot if used.
  // The storage.onChanged listener already wired up at panel-open re-renders
  // the body in both directions, so no manual re-render is needed here.
  async function deleteSnippet(snippet) {
    const hostname = location.hostname;
    const actionType = snippet.type === 'highlight' ? 'HIGHLIGHT' : 'NOTE';
    const idField = snippet.type === 'highlight' ? '_id' : 'uuid';
    let snapshot;

    try {
      const data = await chrome.storage.local.get(hostname);
      const record = data[hostname];
      if (!record?.items) return;

      const found = record.items.find(
        i => i.action === actionType && i[idField] === snippet.id
      );
      if (!found) return;
      snapshot = JSON.parse(JSON.stringify(found));

      record.items = record.items.filter(
        i => !(i.action === actionType && i[idField] === snippet.id)
      );
      await chrome.storage.local.set({ [hostname]: record });
    } catch (err) {
      console.error('[Adnota Scratchpad] Delete failed:', err);
      return;
    }

    window.AdnotaLog?.event('scratchpad', 'delete', { type: snippet.type });

    const noun = snippet.type === 'highlight' ? 'Snippet' : 'Note';
    showUndoToast(`${noun} deleted`, async () => {
      try {
        const again = await chrome.storage.local.get(hostname);
        const rec = again[hostname] || { items: [] };
        rec.items = (rec.items || []).concat([snapshot]);
        await chrome.storage.local.set({ [hostname]: rec });
        window.AdnotaLog?.event('scratchpad', 'delete-undo', { type: snippet.type });
      } catch (err) {
        console.error('[Adnota Scratchpad] Undo failed:', err);
      }
    });
  }

  function showUndoToast(message, onUndo, duration = 5000) {
    if (!panel) return;
    let toast = panel.querySelector('.adnota-scratchpad-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'adnota-scratchpad-toast';
      panel.appendChild(toast);
    }
    toast.textContent = '';
    toast.classList.add('has-undo');

    const msg = document.createElement('span');
    msg.className = 'adnota-scratchpad-toast-msg';
    msg.textContent = message;
    toast.appendChild(msg);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'adnota-scratchpad-toast-undo';
    btn.textContent = 'Undo';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      clearTimeout(_toastTimer);
      try { await onUndo?.(); } catch (_) {}
      toast.classList.remove('visible', 'has-undo');
    });
    toast.appendChild(btn);

    toast.classList.add('visible');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      toast.classList.remove('visible', 'has-undo');
    }, duration);
  }

  async function copyAll() {
    const list = filtered();
    if (!list.length) return;
    const payload = list
      .map(s => isRedaction(s) ? redactionBar(s.text) : s.text)
      .join('\n\n');
    try { await navigator.clipboard.writeText(payload); }
    catch (_) { return; }
    copyAllBtn.classList.add('copied');
    copyAllBtn.innerHTML = ICON_CHECK;
    setTimeout(() => {
      if (!copyAllBtn?.isConnected) return;
      copyAllBtn.classList.remove('copied');
      copyAllBtn.innerHTML = ICON_COPY_ALL;
    }, COPY_REVERT_MS);
    window.AdnotaLog?.event('scratchpad', 'copy-all', { count: list.length });
  }

  // ── GOTO: scroll the source annotation into view + flash ─────────────────
  // Routes by snippet type. The engine returns false when the rendered
  // annotation isn't currently in the DOM (e.g., its anchor is broken or it
  // hasn't been re-restored after an SPA URL change). We surface that as a
  // small toast so the user isn't left wondering why nothing happened.
  function gotoSnippet(snippet) {
    let ok = false;
    if (snippet.type === 'highlight') {
      ok = !!window.AdnotaHighlighter?.scrollTo?.(snippet.id);
    } else if (snippet.type === 'note') {
      ok = !!window.StickyEngine?.scrollTo?.(snippet.id);
    }
    if (!ok) {
      showScratchToast("Couldn't locate this on the page.");
      window.AdnotaLog?.event('scratchpad', 'goto-miss', { type: snippet.type });
      return;
    }
    window.AdnotaLog?.event('scratchpad', 'goto', { type: snippet.type });
  }

  // Tiny scoped toast — lives inside the panel, dismisses itself after 2s.
  // Inline-styled to keep CSS surface minimal; only a single toast at a time.
  let _toastTimer = null;
  function showScratchToast(msg) {
    if (!panel) return;
    let toast = panel.querySelector('.adnota-scratchpad-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'adnota-scratchpad-toast';
      panel.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.remove('has-undo');
    toast.classList.add('visible');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove('visible'), 2000);
  }

  function setFilter(value) {
    if (activeFilter === value) return;
    activeFilter = value;
    safeStorageSet({ [FILTER_KEY]: value });
    render();
    window.AdnotaLog?.event('scratchpad', 'filter-change', { filter: value });
  }

  function setActiveTag(tag) {
    const next = tag || null;
    if (activeTag === next) return;
    activeTag = next;
    render();
    window.AdnotaLog?.event('scratchpad', 'tag-filter-change', { tag: activeTag });
  }

  function setTagBarVisible(visible) {
    tagBarVisible = !!visible;
    safeStorageSet({ [TAG_BAR_KEY]: tagBarVisible });
    if (!tagBarVisible && activeTag) {
      // Clearing the bar also clears any active tag — otherwise the panel
      // would silently filter with no visible affordance.
      activeTag = null;
      render();
    } else {
      renderTagBar();
    }
    window.AdnotaLog?.event('scratchpad', 'tag-bar-toggle', { visible: tagBarVisible });
  }

  // Aggregate tag counts across the full snippet cache (ignores the active
  // type filter, same approach as pages/sites.js so the chip strip shows
  // absolute availability).
  function computeTagCounts() {
    const counts = {};
    for (const s of snippetCache) {
      if (s.tag) counts[s.tag] = (counts[s.tag] || 0) + 1;
    }
    return counts;
  }

  function renderTagBar() {
    if (!tagBarEl || !tagToggleBtn) return;
    tagToggleBtn.classList.toggle('active', tagBarVisible);
    if (!tagBarVisible) {
      tagBarEl.hidden = true;
      tagBarEl.replaceChildren();
      return;
    }
    tagBarEl.hidden = false;
    tagBarEl.replaceChildren();

    const tagCounts = computeTagCounts();
    const sorted = Object.keys(tagCounts).sort((a, b) =>
      (tagCounts[b] - tagCounts[a]) || a.localeCompare(b)
    );

    if (sorted.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'adnota-scratchpad-tagbar-empty';
      empty.textContent = 'No tags on this page yet.';
      tagBarEl.appendChild(empty);
      return;
    }

    const allChip = document.createElement('button');
    allChip.type = 'button';
    allChip.className = 'adnota-scratchpad-tagchip' + (activeTag === null ? ' active' : '');
    allChip.textContent = 'All';
    allChip.addEventListener('click', (e) => {
      e.stopPropagation();
      setActiveTag(null);
    });
    tagBarEl.appendChild(allChip);

    for (const tag of sorted) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'adnota-scratchpad-tagchip' + (activeTag === tag ? ' active' : '');
      const hash = document.createElement('span');
      hash.className = 'adnota-scratchpad-tagchip-hash';
      hash.textContent = '#';
      const name = document.createElement('span');
      name.className = 'adnota-scratchpad-tagchip-name';
      name.textContent = tag;
      const count = document.createElement('span');
      count.className = 'adnota-scratchpad-tagchip-count';
      count.textContent = String(tagCounts[tag]);
      chip.append(hash, name, count);
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        setActiveTag(activeTag === tag ? null : tag);
      });
      tagBarEl.appendChild(chip);
    }
  }

  // ── Position + size persistence (per-host) ────────────────────────────────
  function clampPosition(left, top, w, h) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const MIN_VISIBLE = 60;
    return {
      left: Math.max(MIN_VISIBLE - w, Math.min(vw - MIN_VISIBLE, left)),
      top:  Math.max(0,                Math.min(vh - MIN_VISIBLE, top)),
    };
  }

  // chrome.storage calls can throw SYNCHRONOUSLY (not just reject) when the
  // extension context is invalidated — e.g., when the extension is reloaded
  // while a tab still has old content scripts. .catch() doesn't catch sync
  // throws, so each chrome.* call is wrapped in try/catch here.
  function restorePosition() {
    try {
      chrome.storage.local.get(POSITION_KEY).then((data) => {
        const all = data[POSITION_KEY] || {};
        const pos = all[host()];
        if (!pos?.left || !pos?.top) return;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = pos.left;
        panel.style.top = pos.top;
        // Re-clamp in case the viewport shrank since the saved position.
        const r = panel.getBoundingClientRect();
        const c = clampPosition(parseFloat(pos.left), parseFloat(pos.top), r.width, r.height);
        panel.style.left = c.left + 'px';
        panel.style.top  = c.top + 'px';
      }).catch(() => {});
    } catch (_) {}
  }

  function restoreSize() {
    try {
      chrome.storage.local.get(SIZE_KEY).then((data) => {
        const all = data[SIZE_KEY] || {};
        const size = all[host()];
        if (size?.width && size?.height) {
          panel.style.width  = size.width + 'px';
          panel.style.height = size.height + 'px';
        }
      }).catch(() => {});
    } catch (_) {}
  }

  function persistPosition() {
    try {
      chrome.storage.local.get(POSITION_KEY).then((data) => {
        const all = data[POSITION_KEY] || {};
        all[host()] = { left: panel.style.left, top: panel.style.top };
        safeStorageSet({ [POSITION_KEY]: all });
      }).catch(() => {});
    } catch (_) {}
  }

  function persistSize() {
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    try {
      chrome.storage.local.get(SIZE_KEY).then((data) => {
        const all = data[SIZE_KEY] || {};
        all[host()] = { width: Math.round(r.width), height: Math.round(r.height) };
        safeStorageSet({ [SIZE_KEY]: all });
      }).catch(() => {});
    } catch (_) {}
  }

  // ── Drag ──────────────────────────────────────────────────────────────────
  // Whole header is the drag handle — including the filter pills, Copy all,
  // and the close ✕. A 4px movement threshold disambiguates click from drag
  // so a normal click on any button still fires its action; only after the
  // pointer travels past the threshold do we commit to a drag and swallow
  // the synthetic click that follows.
  function onDragStart(e) {
    if (e.button !== 0) return;
    // Selection guard: if the user finished a drag-select inside the panel,
    // don't initiate a panel drag — they're trying to copy text.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && panel.contains(sel.anchorNode)) return;

    const r = panel.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = r.left, startTop = r.top;
    const w = r.width, h = r.height;
    let dragging = false;

    function move(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        dragging = true;
        // Commit to absolute coords on the first real drag movement —
        // not on pointerdown — so a click without movement leaves the
        // panel's right/bottom anchoring untouched.
        panel.style.right  = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left   = startLeft + 'px';
        panel.style.top    = startTop + 'px';
      }
      const c = clampPosition(startLeft + dx, startTop + dy, w, h);
      panel.style.left = c.left + 'px';
      panel.style.top  = c.top + 'px';
      ev.preventDefault();
    }
    function end() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (dragging) {
        suppressNextClick = true;
        persistPosition();
      }
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  // ── Resize watcher ────────────────────────────────────────────────────────
  function attachResizeObserver() {
    if (resizeObserver) return;
    // Debounce so the initial observe fire (and rapid drag-resize) only
    // commits one storage write per gesture.
    resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizePersistTimer);
      resizePersistTimer = setTimeout(persistSize, 400);
    });
    resizeObserver.observe(panel);
  }
  function detachResizeObserver() {
    resizeObserver?.disconnect();
    resizeObserver = null;
    clearTimeout(resizePersistTimer);
  }

  // ── Open / close / refresh ───────────────────────────────────────────────
  async function open() {
    if (panel) return;
    buildPanel();

    try {
      const data = await chrome.storage.local.get([FILTER_KEY, TAG_BAR_KEY]);
      activeFilter = data[FILTER_KEY] ?? 'all';
      tagBarVisible = !!data[TAG_BAR_KEY];
    } catch (_) {}

    snippetCache = await loadSnippets();
    render();

    // Live updates: storage changes for this domain key OR the global filter
    // pref re-render in place.
    storageListener = (changes, area) => {
      if (area !== 'local') return;
      if (changes[host()] || changes[FILTER_KEY]) refresh();
    };
    try { chrome.storage.onChanged.addListener(storageListener); } catch (_) {}

    // SPA URL change → re-pull snippets for the new path. Mirrors the dock's
    // own scratch-button refresh, kept independent so the panel doesn't have
    // to know about dock internals.
    if (typeof window.navigation?.addEventListener === 'function') {
      navListener = () => setTimeout(() => refresh(), 50);
      try { window.navigation.addEventListener('navigate', navListener); }
      catch (_) { navListener = null; }
    }
    if (!navListener) {
      popstateListener = () => setTimeout(() => refresh(), 50);
      window.addEventListener('popstate', popstateListener);
    }

    window.addEventListener('keydown', onEscape);

    setTimeout(attachResizeObserver, 0);

    window.AdnotaLog?.event('scratchpad', 'open', { count: snippetCache.length });
  }

  function close() {
    if (!panel) return;
    detachResizeObserver();
    panel.remove();
    panel = null;
    bodyEl = null;
    copyAllBtn = null;
    tagBarEl = null;
    tagToggleBtn = null;
    filterEls = [];
    activeTag = null;
    if (storageListener) {
      try { chrome.storage.onChanged.removeListener(storageListener); } catch (_) {}
      storageListener = null;
    }
    if (navListener && window.navigation?.removeEventListener) {
      try { window.navigation.removeEventListener('navigate', navListener); } catch (_) {}
      navListener = null;
    }
    if (popstateListener) {
      window.removeEventListener('popstate', popstateListener);
      popstateListener = null;
    }
    window.removeEventListener('keydown', onEscape);
    clearTimeout(mouseLeaveTimer);
    window.AdnotaLog?.event('scratchpad', 'close');
  }

  function toggle() {
    if (panel) close();
    else open();
  }

  function isOpen() { return !!panel; }

  async function refresh() {
    if (!panel) return;
    try {
      const data = await chrome.storage.local.get(FILTER_KEY);
      const f = data[FILTER_KEY] ?? 'all';
      if (f !== activeFilter) activeFilter = f;
    } catch (_) {}
    snippetCache = await loadSnippets();
    render();
  }

  // Bubble-phase Escape. By the time we fire, the universal Escape handler
  // has already run (capture-phase) and cleared any active tool mode. If
  // _toolJustExited was raised in that pass, defer — the user pressed
  // Escape to exit the tool, not to close the pad. Otherwise close.
  function onEscape(e) {
    if (e.key !== 'Escape') return;
    if (!panel) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (_toolJustExited) return;
    e.preventDefault();
    close();
  }

  window.AdnotaScratchPad = {
    toggle,
    open,
    close,
    isOpen,
    refresh,
    pageSnippetCount,
  };
})();
