// content/scratchPad.js — per-page text snippet quick view
//
// A floating frosted-glass panel that lists the current URL's HIGHLIGHT and
// NOTE items as plain prose. TEXT IS KING — no per-item color borders, no
// source chips, no card chrome. Just the text, optional #tag, and per-item
// copy. Companion to a new dock button (left of the visibility eye) and the
// bare-key 'p' shortcut.
//
// Public API on window.AdnotaScratchPad:
//   toggle(), open(), close(), isOpen(), refresh()

(function () {
  'use strict';

  const FILTER_KEY    = 'adnotaScratchFilter';
  const POSITION_KEY  = 'adnotaScratchPosition';
  const SIZE_KEY      = 'adnotaScratchSize';
  const REDACTION     = 'adnota-theme-black';
  const FADE_DELAY_MS = 600;
  const COPY_REVERT_MS = 1400;

  let panel        = null;
  let bodyEl       = null;
  let countEl      = null;
  let copyAllBtn   = null;
  let filterEls    = [];
  let snippetCache = [];
  let activeFilter = 'all';
  let storageListener = null;
  let resizeObserver  = null;
  let resizePersistTimer = null;
  let mouseLeaveTimer = null;
  let navListener     = null;
  let popstateListener = null;

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
    if (activeFilter === 'highlights') return snippetCache.filter(s => s.type === 'highlight');
    if (activeFilter === 'notes')      return snippetCache.filter(s => s.type === 'note');
    return snippetCache;
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
      btn.textContent = label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setFilter(val);
      });
      filters.appendChild(btn);
      filterEls.push({ btn, value: val });
    }
    header.appendChild(filters);

    countEl = document.createElement('span');
    countEl.className = 'adnota-scratchpad-count';
    header.appendChild(countEl);

    copyAllBtn = document.createElement('button');
    copyAllBtn.type = 'button';
    copyAllBtn.className = 'adnota-scratchpad-copyall';
    copyAllBtn.textContent = 'Copy all';
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

    bodyEl = document.createElement('div');
    bodyEl.className = 'adnota-scratchpad-body';
    panel.appendChild(bodyEl);

    // Drag from the header (buttons are excluded inside the handler).
    header.addEventListener('pointerdown', (e) => onDragStart(e));

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

    const counts = {
      all:        snippetCache.length,
      highlights: snippetCache.filter(s => s.type === 'highlight').length,
      notes:      snippetCache.filter(s => s.type === 'note').length,
    };
    for (const { btn, value } of filterEls) {
      btn.classList.toggle('active', value === activeFilter);
    }
    countEl.textContent = String(counts[activeFilter] ?? 0);

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

    list.forEach((snippet, i) => {
      if (i > 0) {
        const sep = document.createElement('div');
        sep.className = 'adnota-scratchpad-sep';
        bodyEl.appendChild(sep);
      }
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

    if (snippet.tag) {
      const tag = document.createElement('div');
      tag.className = 'adnota-scratchpad-tag';
      tag.textContent = `#${snippet.tag}`;
      row.appendChild(tag);
    }

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

    return row;
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
    const original = copyAllBtn.textContent;
    copyAllBtn.textContent = 'Copied';
    setTimeout(() => {
      if (!copyAllBtn?.isConnected) return;
      copyAllBtn.classList.remove('copied');
      copyAllBtn.textContent = original;
    }, COPY_REVERT_MS);
    window.AdnotaLog?.event('scratchpad', 'copy-all', { count: list.length });
  }

  function setFilter(value) {
    if (activeFilter === value) return;
    activeFilter = value;
    safeStorageSet({ [FILTER_KEY]: value });
    render();
    window.AdnotaLog?.event('scratchpad', 'filter-change', { filter: value });
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

  function restorePosition() {
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
  }

  function restoreSize() {
    chrome.storage.local.get(SIZE_KEY).then((data) => {
      const all = data[SIZE_KEY] || {};
      const size = all[host()];
      if (size?.width && size?.height) {
        panel.style.width  = size.width + 'px';
        panel.style.height = size.height + 'px';
      }
    }).catch(() => {});
  }

  function persistPosition() {
    chrome.storage.local.get(POSITION_KEY).then((data) => {
      const all = data[POSITION_KEY] || {};
      all[host()] = { left: panel.style.left, top: panel.style.top };
      safeStorageSet({ [POSITION_KEY]: all });
    }).catch(() => {});
  }

  function persistSize() {
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    chrome.storage.local.get(SIZE_KEY).then((data) => {
      const all = data[SIZE_KEY] || {};
      all[host()] = { width: Math.round(r.width), height: Math.round(r.height) };
      safeStorageSet({ [SIZE_KEY]: all });
    }).catch(() => {});
  }

  // ── Drag ──────────────────────────────────────────────────────────────────
  function onDragStart(e) {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;
    // Selection guard: if the user finished a drag-select inside the panel,
    // don't initiate a panel drag — they're trying to copy text.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && panel.contains(sel.anchorNode)) return;

    const r = panel.getBoundingClientRect();
    panel.style.right  = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left   = r.left + 'px';
    panel.style.top    = r.top + 'px';

    const startX = e.clientX, startY = e.clientY;
    const startLeft = r.left, startTop = r.top;
    const w = r.width, h = r.height;

    function move(ev) {
      const targetLeft = startLeft + (ev.clientX - startX);
      const targetTop  = startTop + (ev.clientY - startY);
      const c = clampPosition(targetLeft, targetTop, w, h);
      panel.style.left = c.left + 'px';
      panel.style.top  = c.top + 'px';
      ev.preventDefault();
    }
    function end() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      persistPosition();
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
      const data = await chrome.storage.local.get(FILTER_KEY);
      activeFilter = data[FILTER_KEY] ?? 'all';
    } catch (_) {}

    snippetCache = await loadSnippets();
    render();

    // Live updates: storage changes for this domain key OR the global filter
    // pref re-render in place.
    storageListener = (changes, area) => {
      if (area !== 'local') return;
      if (changes[host()] || changes[FILTER_KEY]) refresh();
    };
    chrome.storage.onChanged.addListener(storageListener);

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
    countEl = null;
    copyAllBtn = null;
    filterEls = [];
    if (storageListener) {
      chrome.storage.onChanged.removeListener(storageListener);
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
