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
  const MODE_KEY      = 'adnotaScratchMode';
  const TAG_BAR_KEY   = 'adnotaScratchTagBarVisible';
  const POSITION_KEY  = 'adnotaScratchPosition';
  const SIZE_KEY      = 'adnotaScratchSize';
  const REDACTION     = 'adnota-theme-black';
  const FADE_DELAY_MS = 600;
  const COPY_REVERT_MS = 1400;

  // Top-level content categories. Snippets is the panel's original TEXT-IS-KING
  // mission (highlights + notes). Edits is the new debug-flavored feed for
  // ERASE + RESIZE records — selector-first rows, click to expand for full _id /
  // selector / timestamp / cssText. The mode pill at the start of the tab strip
  // toggles between them; sub-tabs are mode-dependent.
  // Snippets keeps 'All' because highlights and notes are categorically alike
  // (both prose, both readable as a unified reference list). Edits omits 'All'
  // — ERASE / RESIZE / MARKER are different actions with different row
  // formats (monospace selectors vs color swatches), and a mixed list reads
  // as undifferentiated noise. The default tab for each mode is the first
  // entry below.
  const TABS_BY_MODE = {
    snippets: [['all', 'All'], ['highlights', 'Highlights'], ['notes', 'Notes']],
    edits:    [['erased', 'Erased'], ['resized', 'Resized'], ['drawing', 'Drawings']],
  };
  const TYPES_BY_MODE = {
    snippets: new Set(['highlight', 'note']),
    edits:    new Set(['erase', 'resize', 'drawing']),
  };
  // Generic delete plumbing — keyed by snippet.type. NOTE and MARKER both
  // use `uuid` as their identifier; the rest use `_id`.
  const ACTION_BY_TYPE  = { highlight: 'HIGHLIGHT', note: 'NOTE', erase: 'ERASE', resize: 'RESIZE', drawing: 'MARKER' };
  const ID_FIELD_BY_TYPE = { highlight: '_id', note: 'uuid', erase: '_id', resize: '_id', drawing: 'uuid' };

  // ── class / data-role mirror helpers ────────────────────────────────────
  // CSS rules in scratchPad.css key off `[data-role~="X"]` instead of `.X`.
  // Reason: third-party DOM mutators — notably AdBlock's anti-circumvention
  // scrambler on certain recipe sites (e.g. mamagourmand.com) — periodically
  // rewrite the `class` attribute on dynamically-inserted DOM, breaking any
  // class-scoped CSS. data-* attributes are left alone.
  //
  // These helpers wrap class mutations so they ALSO update data-role. We
  // keep className intact too (cheap, and any 3rd-party scrambler that
  // doesn't fire just leaves it working). State checks (active, copied,
  // visible, expanded, etc.) MUST go through hasClass() not classList,
  // because the class attribute may have been overwritten between writes.
  function setClass(el, name) {
    el.className = name;
    el.dataset.role = name;
    return el;
  }
  function addClass(el, ...names) {
    for (const n of names) el.classList.add(n);
    const tokens = new Set((el.dataset.role || '').split(/\s+/).filter(Boolean));
    for (const n of names) tokens.add(n);
    el.dataset.role = [...tokens].join(' ');
  }
  function removeClass(el, ...names) {
    for (const n of names) el.classList.remove(n);
    if (!el.dataset.role) return;
    const drop = new Set(names);
    el.dataset.role = el.dataset.role.split(/\s+/).filter(t => t && !drop.has(t)).join(' ');
  }
  function toggleClass(el, name, on) {
    if (on === undefined) on = !hasClass(el, name);
    if (on) addClass(el, name); else removeClass(el, name);
    return on;
  }
  function hasClass(el, name) {
    return (el.dataset.role || '').split(/\s+/).includes(name);
  }

  let panel        = null;
  let bodyEl       = null;
  let copyAllBtn   = null;
  let filtersEl    = null;
  let filterEls    = [];
  let modeBtnEl   = null;
  let tagBarEl     = null;
  let tagToggleBtn = null;
  let snippetCache = [];
  let activeFilter = 'all';
  let activeMode   = 'snippets';
  // Per-row expansion state (Edits mode only). Keyed by snippet.id so it
  // survives re-renders triggered by storage onChanged. Cleared on close().
  const expandedIds = new Set();
  // Per-row mute state (Edits mode only). Ephemeral — never persisted to
  // chrome.storage. Resets on page reload, same model as Alt+S global
  // show/hide-all. Keyed by snippet.id. A muted row stays in the scratchpad
  // (just dimmed) and the underlying storage row is untouched; only the
  // live effect on the page is removed via tool.removeOne(). Click again
  // to re-apply via tool.applyOne(). Cleared on close().
  const mutedIds = new Set();
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

  // Strip a CSS selector down to its leaf segment — everything past the final
  // descendant combinator '>'. For purely structural nth-child paths this
  // is still gibberish, but a single segment of it instead of the whole 30-
  // segment chain. The id-tail suffix below disambiguates collisions when
  // two different elements end up with the same leaf.
  function leafSelector(sel) {
    if (!sel) return '(unknown selector)';
    const idx = sel.lastIndexOf('>');
    return idx >= 0 ? sel.slice(idx + 1).trim() : sel;
  }

  // Short id-tail (last 6 chars of the record's _id) — used as a stable
  // disambiguator on Edits rows, the way Git uses 7-char short SHAs.
  function shortIdTail(id) {
    if (id == null) return '';
    const s = String(id);
    return s.length <= 6 ? s : s.slice(-6);
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
  // Chevron-down — universal "click to open a menu" affordance for the
  // mode button. The popover's labels carry the actual category semantics;
  // the icon just needs to say "this is a dropdown."
  // Horizontal-swap arrows for the binary Snippets ↔ Edits toggle. Replaces
  // the old chevron-down (which implied "opens a menu" — true when this was
  // a popover, misleading now that the button is a direct one-click flip).
  const ICON_SWAP = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="14 4 17 7 14 10"/><path d="M3 7h14"/><polyline points="6 16 3 13 6 10"/><path d="M17 13H3"/></svg>`;
  // Eye / eye-off — per-row mute toggle on Edit-mode rows. Eye = currently
  // applied, click to mute. Eye-off = currently muted, click to re-apply.
  // Ephemeral (resets on page reload), same model as global Alt+S show/hide.
  const ICON_EYE     = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z"/><circle cx="10" cy="10" r="2.5"/></svg>`;
  const ICON_EYE_OFF = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 14.5A8 8 0 0 1 10 16c-5 0-8-6-8-6a14 14 0 0 1 3.5-4"/><path d="M8 4.2A8 8 0 0 1 10 4c5 0 8 6 8 6a14 14 0 0 1-1.5 2.2"/><line x1="2" y1="2" x2="18" y2="18"/></svg>`;
  // Globe — small leading hint on rows whose record is site-wide
  // (path === '*'). Tells the user "this rule applies everywhere on the
  // site, not just this URL," which avoids the confusion of seeing edits
  // on a fresh page.
  const ICON_GLOBE = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><line x1="3" y1="10" x2="17" y2="10"/><path d="M10 3 C 6 6 6 14 10 17"/><path d="M10 3 C 14 6 14 14 10 17"/></svg>`;

  // ── Snippet derivation ────────────────────────────────────────────────────
  // Projects all four record types into a unified shape so the panel can
  // render them through one buildRow() pipeline. Each ERASE/RESIZE projection
  // resolves the live element via querySelector once at load time and stashes
  // it on the snippet so buildRow can compute stale state and the text excerpt
  // without re-querying. `record` is the raw storage record — kept around so
  // the click-to-expand detail block can show full _id / cssText / etc.
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
      } else if (item.action === 'ERASE' || item.action === 'RESIZE') {
        const type = item.action === 'ERASE' ? 'erase' : 'resize';
        // REFLOW v1.5 dom-reorder rows have no top-level selector or anchor;
        // their identity lives in sourceAnchor. Fall back to that so the row
        // gets a usable selector for liveness + display.
        const selector = item.selector
          || item.anchor?.cssSelector
          || item.sourceAnchor?.cssSelector
          || '';
        // Resolve the live element once. For ERASEs the element is still in
        // the DOM (just display:none'd), so querySelector finds it. Stash it
        // so buildRow can compute the snippet text fallback and the stale
        // class without re-querying. null = stale.
        let liveEl = null;
        if (selector) {
          try { liveEl = document.querySelector(selector); } catch (_) {}
        }
        // Snippet text ladder: textFingerprint excerpt → alt/title/aria-label
        // → empty (selector becomes the only identifier in buildRow).
        let excerpt = '';
        const fp = item.anchor?.textFingerprint || item.sourceAnchor?.textFingerprint;
        if (fp) {
          if (typeof fp === 'string') excerpt = fp;
          else if (typeof fp === 'object') {
            // FuzzyAnchor stores prefix + words + suffix; prefix alone reads cleanest.
            excerpt = (fp.prefix || fp.text || '').trim();
          }
        }
        if (!excerpt && liveEl) {
          excerpt = (liveEl.getAttribute('alt') ||
                     liveEl.getAttribute('title') ||
                     liveEl.getAttribute('aria-label') || '').trim();
        }
        if (excerpt.length > 120) excerpt = excerpt.slice(0, 117) + '…';
        out.push({
          id: item._id ?? `${type}-${item.timestamp ?? Math.random()}`,
          type,
          selector,
          excerpt,
          stale: !liveEl,
          liveEl,
          record: item,
          ts: item.timestamp ?? 0,
        });
      } else if (item.action === 'MARKER') {
        // Drawings are visual overlays — no text content. The row label
        // comes from the shape type (Pencil / Arrow / Rectangle / Circle /
        // Text), with the color surfaced as a leading swatch in buildRow.
        // Liveness is checked against the marker overlay (each rendered
        // wrapper carries data-uuid), so a missing wrapper means the
        // anchor didn't match on this load → stale.
        const SHAPE_LABELS = {
          freehand: 'Pencil',
          arrow:    'Arrow',
          rect:     'Rectangle',
          ellipse:  'Circle',
          text:     'Text',
        };
        const shapeType = item.shapeType || (item.isArrow ? 'arrow' : 'freehand');
        const label = SHAPE_LABELS[shapeType] || 'Shape';
        let liveEl = null;
        try {
          liveEl = document.querySelector(`.adnota-marker-wrapper[data-uuid="${item.uuid}"]`);
        } catch (_) {}
        // For text shapes, the actual text content is the most identifying
        // suffix — surfaces e.g. `● Text — "Sale!"` in the row.
        let excerpt = '';
        if (shapeType === 'text' && item.text) {
          excerpt = String(item.text).trim();
          if (excerpt.length > 80) excerpt = excerpt.slice(0, 77) + '…';
        }
        out.push({
          id: item.uuid,
          type: 'drawing',
          shapeType,
          label,
          color: item.color || '#888',
          excerpt,
          stale: !liveEl,
          liveEl,
          record: item,
          ts: item.timestamp ?? 0,
        });
      }
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }

  // Mode-gated filter. Snippets mode only ever returns highlights/notes;
  // Edits mode only ever returns erases/resizes. The activeFilter sub-tab
  // narrows further within the active mode (or 'all' = the full mode union).
  // Tag filter applies on top, but only ERASE/RESIZE records typically lack
  // a tag, so the tag chip strip stays a Snippets-mode tool in practice.
  function filtered() {
    const allowed = TYPES_BY_MODE[activeMode];
    let list = snippetCache.filter(s => allowed.has(s.type));
    if (activeMode === 'snippets') {
      if (activeFilter === 'highlights') list = list.filter(s => s.type === 'highlight');
      else if (activeFilter === 'notes') list = list.filter(s => s.type === 'note');
    } else {
      // Edits mode has no 'all' tab; activeFilter is one of the per-type
      // values. Stale persisted filters (e.g., 'all' from before the tab
      // was removed) fall through to the default tab (erased).
      if (activeFilter === 'resized')      list = list.filter(s => s.type === 'resize');
      else if (activeFilter === 'drawing') list = list.filter(s => s.type === 'drawing');
      else                                 list = list.filter(s => s.type === 'erase');
    }
    if (activeTag) list = list.filter(s => s.tag === activeTag);
    return list;
  }

  // ── Public helper used by the dock to drive its disabled state ───────────
  // Returns the current page's total annotation count (all four types) so
  // the dock's scratch button stays enabled when the user has erases/resizes
  // even with no highlights/notes — Edits mode is reachable from the panel.
  async function pageSnippetCount() {
    const list = await loadSnippets();
    return list.length;
  }

  // ── Per-action count for tool-trash badges ───────────────────────────────
  // Returns the number of records on the current page (path + site-wide
  // mixed via getAnchorsForUrl) whose `action` is in the supplied list.
  // Cheap — one storage read; intended for small badges that refresh on
  // storage onChanged. Caller passes e.g. ['ERASE'] or ['HIGHLIGHT','MARKER'].
  async function pageActionCount(actionTypes) {
    if (!window.AdnotaStorage || !Array.isArray(actionTypes) || !actionTypes.length) return 0;
    const items = await AdnotaStorage.getAnchorsForUrl(location.href);
    const wanted = new Set(actionTypes);
    let n = 0;
    for (const it of items) if (wanted.has(it.action)) n++;
    return n;
  }

  // ── DOM ──────────────────────────────────────────────────────────────────
  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'adnota-scratchpad';
    panel.setAttribute('data-adnota-ui', '1');

    const header = document.createElement('div');
    setClass(header, 'adnota-scratchpad-header');

    // Mode-switcher icon button — far-left of the header. Outermost-left
    // reads as the primary category control (Snippets vs Edits); the
    // sub-tabs that follow are filters within that category. Direct toggle
    // (no popover) since there are exactly two modes — one click flips.
    modeBtnEl = document.createElement('button');
    modeBtnEl.type = 'button';
    setClass(modeBtnEl, 'adnota-scratchpad-mode-btn');
    updateModeBtnTooltip();
    modeBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      setMode(activeMode === 'snippets' ? 'edits' : 'snippets');
    });
    header.appendChild(modeBtnEl);

    filtersEl = document.createElement('div');
    setClass(filtersEl, 'adnota-scratchpad-filters');
    buildSubTabs();
    header.appendChild(filtersEl);

    tagToggleBtn = document.createElement('button');
    tagToggleBtn.type = 'button';
    setClass(tagToggleBtn, 'adnota-scratchpad-filterbtn');
    tagToggleBtn.title = 'Filter by tag';
    tagToggleBtn.innerHTML = ICON_FILTER;
    tagToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setTagBarVisible(!tagBarVisible);
    });
    header.appendChild(tagToggleBtn);

    copyAllBtn = document.createElement('button');
    copyAllBtn.type = 'button';
    setClass(copyAllBtn, 'adnota-scratchpad-copyall');
    copyAllBtn.title = 'Copy all';
    copyAllBtn.innerHTML = ICON_COPY_ALL;
    copyAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyAll();
    });
    header.appendChild(copyAllBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    setClass(closeBtn, 'adnota-scratchpad-close');
    closeBtn.title = 'Close';
    closeBtn.innerHTML = ICON_CLOSE;
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
    });
    header.appendChild(closeBtn);

    panel.appendChild(header);

    tagBarEl = document.createElement('div');
    setClass(tagBarEl, 'adnota-scratchpad-tagbar');
    tagBarEl.hidden = true;
    panel.appendChild(tagBarEl);

    bodyEl = document.createElement('div');
    setClass(bodyEl, 'adnota-scratchpad-body');
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
      removeClass(panel, 'adnota-scratchpad-idle');
    });
    panel.addEventListener('mouseleave', () => {
      clearTimeout(mouseLeaveTimer);
      mouseLeaveTimer = setTimeout(() => {
        if (panel) addClass(panel, 'adnota-scratchpad-idle');
      }, FADE_DELAY_MS);
    });

    document.documentElement.appendChild(panel);

    restoreSize();
    restorePosition();
  }

  // ── Sub-tab construction ─────────────────────────────────────────────────
  // Rebuilds the sub-tab buttons inside filtersEl. Called from buildPanel()
  // on initial mount and from setMode() when the user flips the mode pill —
  // each mode has its own tab list (TABS_BY_MODE). Preserves the mode pill
  // (always at index 0 inside filtersEl) and replaces only the tab buttons.
  function buildSubTabs() {
    if (!filtersEl) return;
    // Drop existing tab buttons but keep the mode pill (modeBtnEl is the
    // first child and isn't a .adnota-scratchpad-filter).
    for (const node of Array.from(filtersEl.children)) {
      if (node !== modeBtnEl) node.remove();
    }
    filterEls = [];
    for (const [val, label] of TABS_BY_MODE[activeMode]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      setClass(btn, 'adnota-scratchpad-filter');
      btn.dataset.value = val;
      btn.dataset.label = label;
      btn.textContent = label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setFilter(val);
      });
      filtersEl.appendChild(btn);
      filterEls.push({ btn, value: val, label });
    }
  }

  // setMode() flips the active content category. It rebuilds the sub-tab
  // strip (different tabs per mode), resets the active sub-filter to 'all'
  // (no per-mode filter memory in Phase 1), persists the choice, and
  // re-renders. Doesn't touch the mode-pill DOM beyond what render() does.
  // Default sub-tab for a mode = first entry in TABS_BY_MODE[mode]. Used by
  // setMode() and the open()/refresh() validators below.
  function defaultFilterForMode(mode) {
    const tabs = TABS_BY_MODE[mode];
    return tabs?.[0]?.[0] ?? 'all';
  }
  function isValidFilterForMode(mode, filter) {
    return TABS_BY_MODE[mode]?.some(([val]) => val === filter) ?? false;
  }

  function setMode(mode) {
    if (mode !== 'snippets' && mode !== 'edits') return;
    if (activeMode === mode) return;
    activeMode = mode;
    activeFilter = defaultFilterForMode(mode);
    // Clear the tag chip too — ERASE/RESIZE records don't carry tags, so a
    // stale active tag would silently hide every Edits row. Tag filter is
    // in-memory anyway (matches existing behavior on mode-irrelevant changes).
    activeTag = null;
    safeStorageSet({ [MODE_KEY]: mode, [FILTER_KEY]: activeFilter });
    buildSubTabs();
    updateModeBtnTooltip();
    // Collapse any expanded edit-detail blocks when switching modes —
    // expansions belong to the previous mode's view.
    expandedIds.clear();
    render();
    window.AdnotaLog?.event('scratchpad', 'mode-change', { mode });
  }

  // Tooltip names the destination, not the source — "Switch to Edits" reads
  // as a direct verb. Refreshed on every setMode so it always points at the
  // mode the user would land on next.
  function updateModeBtnTooltip() {
    if (!modeBtnEl) return;
    modeBtnEl.title = activeMode === 'snippets' ? 'Switch to Edits' : 'Switch to Snippets';
  }

  // ── Mode switcher (isolated render) ──────────────────────────────────────
  // Single point of truth for the Snippets/Edits affordance. The button
  // sits at the far-left of the header — outermost = primary category,
  // sub-tabs after it = filter within that category, right cluster = utility.
  // Horizontal-swap glyph: clicking flips between the two modes directly
  // (no popover — there are only two, and the tooltip names the destination).
  function renderModeButton() {
    if (!modeBtnEl) return;
    while (modeBtnEl.firstChild) modeBtnEl.firstChild.remove();
    const glyph = document.createElement('span');
    setClass(glyph, 'adnota-scratchpad-mode-btn-glyph');
    glyph.innerHTML = ICON_SWAP;
    modeBtnEl.appendChild(glyph);
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function render() {
    if (!panel) return;
    const list = filtered();

    renderModeButton();

    // Copy-All affordance reads honestly per mode: prose join in Snippets,
    // raw-storage JSON dump in Edits (where there's no meaningful text to
    // copy). Tooltip updated here so it tracks mode/filter switches.
    if (copyAllBtn) {
      copyAllBtn.title = activeMode === 'edits' ? 'Copy all as JSON' : 'Copy all';
    }

    // Sub-tab counts — within the active mode only. The mode-gated filtered()
    // list above is post-tag-filter, so we recompute against the cache scoped
    // to this mode for the displayed counts.
    const allowed = TYPES_BY_MODE[activeMode];
    const modeList = snippetCache.filter(s => allowed.has(s.type));
    const counts = activeMode === 'snippets'
      ? {
          all:        modeList.length,
          highlights: modeList.filter(s => s.type === 'highlight').length,
          notes:      modeList.filter(s => s.type === 'note').length,
        }
      : {
          erased:  modeList.filter(s => s.type === 'erase').length,
          resized: modeList.filter(s => s.type === 'resize').length,
          drawing: modeList.filter(s => s.type === 'drawing').length,
        };
    for (const { btn, value, label } of filterEls) {
      toggleClass(btn, 'active', value === activeFilter);
      btn.textContent = '';
      btn.append(`${label} · `);
      const c = document.createElement('span');
      setClass(c, 'adnota-scratchpad-filter-count');
      c.textContent = String(counts[value] ?? 0);
      btn.appendChild(c);
    }

    renderTagBar();

    bodyEl.replaceChildren();
    if (!list.length) {
      const empty = document.createElement('div');
      setClass(empty, 'adnota-scratchpad-empty');
      const EMPTY_LABELS = {
        all:        'snippets',
        highlights: 'highlights',
        notes:      'notes',
        erased:     'erased elements',
        resized:    'resized elements',
        drawing:    'drawings',
      };
      empty.textContent = `No ${EMPTY_LABELS[activeFilter] ?? 'items'} on this page yet.`;
      bodyEl.appendChild(empty);
      copyAllBtn.disabled = true;
      removeClass(copyAllBtn, 'copied');
      return;
    }
    copyAllBtn.disabled = false;

    list.forEach((snippet) => {
      bodyEl.appendChild(buildRow(snippet));
    });
  }

  // Per-row mute dispatcher. Routes to the right tool's removeOne/applyOne
  // based on the snippet type — same dispatch shape as lib/adnotaUI.js's
  // softDeleteItems uses for restore. Only handles Edit-mode types
  // (erase / resize / drawing). Returns true on success so the caller can
  // gate the icon swap. RESIZE has two sub-paths because REFLOW v1.5
  // dom-reorder rules live in a separate Map and need their own apply.
  function setEditMuted(snippet, mute) {
    const rec = snippet.record;
    if (!rec) return false;
    try {
      if (snippet.type === 'erase') {
        if (mute) window.AdnotaEraser?.removeOne?.(snippet.id);
        else      window.AdnotaEraser?.applyOne?.(rec);
      } else if (snippet.type === 'resize') {
        if (rec.kind === 'reflow:dom-reorder') {
          if (mute) window.AdnotaResizer?.removeOneReorder?.(snippet.id);
          else      window.AdnotaResizer?.applyOneReorder?.(rec);
        } else {
          if (mute) window.AdnotaResizer?.removeOne?.(snippet.id);
          else      window.AdnotaResizer?.applyOne?.(rec);
        }
      } else if (snippet.type === 'drawing') {
        if (mute) window.AdnotaMarker?.removeOne?.(snippet.id);
        else      window.AdnotaMarker?.applyOne?.(rec);
      } else {
        return false;
      }
    } catch (_) { return false; }
    return true;
  }

  function buildRow(snippet) {
    const row = document.createElement('div');
    setClass(row, 'adnota-scratchpad-row');
    const isEdit = snippet.type === 'erase' || snippet.type === 'resize' || snippet.type === 'drawing';
    if (isEdit) {
      addClass(row, 'adnota-scratchpad-row-edit');
      if (snippet.stale) addClass(row, 'adnota-scratchpad-row-stale');
    }

    const text = document.createElement('div');
    setClass(text, 'adnota-scratchpad-text');
    if (snippet.type === 'erase' || snippet.type === 'resize') {
      // Edits row: leaf segment of the selector (everything past the final
      // '>') in monospace, plus a short id-tail disambiguator (last 6 chars
      // of _id, like a Git short SHA). The full selector lives in the
      // click-to-expand detail. Optional text excerpt suffix follows when
      // textFingerprint or alt/title is present. Site-wide records (path
      // === '*') get a leading globe icon so the user can tell at a glance
      // which rows are inherited site-wide rules vs page-specific edits.
      addClass(text, 'adnota-scratchpad-row-mono');
      if (snippet.record?.path === '*') {
        const globe = document.createElement('span');
        setClass(globe, 'adnota-scratchpad-row-globe');
        globe.title = 'Site-wide — applies across this site';
        globe.innerHTML = ICON_GLOBE;
        // Globe is informational only — clicks shouldn't bubble up and
        // toggle the row's expanded-detail pane.
        globe.addEventListener('click', (e) => e.stopPropagation());
        text.appendChild(globe);
      }
      const sel = document.createElement('span');
      setClass(sel, 'adnota-scratchpad-row-selector');
      sel.textContent = leafSelector(snippet.selector);
      text.appendChild(sel);
      const idTail = shortIdTail(snippet.id);
      if (idTail) {
        const idSpan = document.createElement('span');
        setClass(idSpan, 'adnota-scratchpad-row-suffix');
        idSpan.textContent = ` · ${idTail}`;
        text.appendChild(idSpan);
      }
      if (snippet.excerpt) {
        const suffix = document.createElement('span');
        setClass(suffix, 'adnota-scratchpad-row-suffix');
        // Quote text-derived excerpts; leave alt/title bare. Heuristic: if
        // the excerpt looks like text (has a space), quote it. Same '·'
        // separator as the id-tail for a uniform suffix rhythm.
        const quoted = /\s/.test(snippet.excerpt) ? `"${snippet.excerpt}"` : snippet.excerpt;
        suffix.textContent = ` · ${quoted}`;
        text.appendChild(suffix);
      }
    } else if (snippet.type === 'drawing') {
      // Drawing row: leading color swatch, shape label, optional text
      // excerpt suffix (only meaningful for shapeType === 'text'). No
      // monospace — drawings aren't selector-shaped.
      addClass(text, 'adnota-scratchpad-row-drawing');
      const swatch = document.createElement('span');
      setClass(swatch, 'adnota-scratchpad-row-swatch');
      swatch.style.background = snippet.color;
      // Outline a tiny ring so very-light or very-dark colors stay visible
      // against the dark panel background.
      swatch.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.18) inset';
      text.appendChild(swatch);
      const label = document.createElement('span');
      setClass(label, 'adnota-scratchpad-row-label');
      label.textContent = snippet.label;
      text.appendChild(label);
      if (snippet.excerpt) {
        const suffix = document.createElement('span');
        setClass(suffix, 'adnota-scratchpad-row-suffix');
        suffix.textContent = ` · "${snippet.excerpt}"`;
        text.appendChild(suffix);
      }
    } else if (isRedaction(snippet)) {
      addClass(text, 'adnota-scratchpad-redaction');
      text.textContent = redactionBar(snippet.text);
      text.title = 'Redacted';
    } else {
      text.textContent = snippet.text;
    }

    if (isEdit) {
      // Selection guard: clicks that follow a drag-select shouldn't toggle
      // the expansion (the user is trying to copy). Same pattern as the
      // panel's drag handler.
      text.addEventListener('click', (e) => {
        if (e.target.closest('button')) return; // hover actions handle their own clicks
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && row.contains(sel.anchorNode)) return;
        toggleExpanded(snippet, row);
      });
      text.style.cursor = 'pointer';
    }
    row.appendChild(text);

    // Tags deliberately omitted from the row — they pollute drag-select copy.
    // Use the funnel button in the header to filter by tag instead.

    // Re-attach the expanded detail block immediately if this row was
    // expanded before a re-render (e.g., storage onChanged tick).
    if (isEdit && expandedIds.has(snippet.id)) {
      row.appendChild(buildExpandedDetail(snippet));
      addClass(row, 'adnota-scratchpad-row-expanded');
    }

    // Eye toggle — Edit-mode rows only, and skip stale rows (nothing to
    // toggle if the edit didn't apply in the first place). Order in the
    // row's action cluster: [eye] [goto] [copy] [trash] = preview →
    // navigate → copy → destroy intensity gradient.
    //
    // Tooltip is just "Show" / "Hide" regardless of edit type — the eye
    // icon does the cognitive work, and the verb describes the gesture's
    // effect on the edit (Hide = mute the edit, Show = re-apply it).
    // Consistent across erase / resize / drawing avoids 5-different-verbs
    // tooltip noise that earlier framings produced.
    if (isEdit && !snippet.stale) {
      const eyeBtn = document.createElement('button');
      eyeBtn.type = 'button';
      setClass(eyeBtn, 'adnota-scratchpad-roweye');
      const muted = mutedIds.has(snippet.id);
      eyeBtn.innerHTML = muted ? ICON_EYE_OFF : ICON_EYE;
      eyeBtn.title = muted ? 'Show' : 'Hide';
      if (muted) addClass(row, 'adnota-scratchpad-row-muted');
      eyeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const wasMuted = mutedIds.has(snippet.id);
        const ok = setEditMuted(snippet, !wasMuted);
        if (!ok) return;
        if (wasMuted) {
          mutedIds.delete(snippet.id);
          eyeBtn.innerHTML = ICON_EYE;
          eyeBtn.title = 'Hide';
          removeClass(row, 'adnota-scratchpad-row-muted');
        } else {
          mutedIds.add(snippet.id);
          eyeBtn.innerHTML = ICON_EYE_OFF;
          eyeBtn.title = 'Show';
          addClass(row, 'adnota-scratchpad-row-muted');
        }
        window.AdnotaLog?.event('scratchpad', 'mute-toggle', {
          type: snippet.type, muted: !wasMuted,
        });
      });
      row.appendChild(eyeBtn);
    }

    const gotoBtn = document.createElement('button');
    gotoBtn.type = 'button';
    setClass(gotoBtn, 'adnota-scratchpad-rowgoto');
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
    setClass(copyBtn, 'adnota-scratchpad-rowcopy');
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = ICON_COPY;
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      // Copy payload mirrors the visible row content — what you see is
      // what you paste. For ERASE/RESIZE that's leaf · id-tail · excerpt;
      // for drawings it's label · excerpt; for highlights/notes it's
      // the prose text. Power-user paths (full selector, full record
      // JSON) live in the click-to-expand detail.
      let payload;
      if (snippet.type === 'erase' || snippet.type === 'resize') {
        const parts = [leafSelector(snippet.selector)];
        const tail = shortIdTail(snippet.id);
        if (tail) parts.push(tail);
        if (snippet.excerpt) {
          const quoted = /\s/.test(snippet.excerpt) ? `"${snippet.excerpt}"` : snippet.excerpt;
          parts.push(quoted);
        }
        payload = parts.join(' · ');
      } else if (snippet.type === 'drawing') {
        const parts = [snippet.label || 'Drawing'];
        if (snippet.excerpt) parts.push(`"${snippet.excerpt}"`);
        payload = parts.join(' · ');
      } else {
        payload = isRedaction(snippet) ? redactionBar(snippet.text) : snippet.text;
      }
      if (!payload) return;
      try { await navigator.clipboard.writeText(payload); }
      catch (_) { return; }
      addClass(copyBtn, 'copied');
      copyBtn.innerHTML = ICON_CHECK;
      setTimeout(() => {
        if (!copyBtn.isConnected) return;
        removeClass(copyBtn, 'copied');
        copyBtn.innerHTML = ICON_COPY;
      }, COPY_REVERT_MS);
      window.AdnotaLog?.event('scratchpad', 'copy', { type: snippet.type, len: payload.length });
    });
    row.appendChild(copyBtn);

    const trashBtn = document.createElement('button');
    trashBtn.type = 'button';
    setClass(trashBtn, 'adnota-scratchpad-rowtrash');
    trashBtn.title =
      snippet.type === 'highlight' ? 'Delete this quote' :
      snippet.type === 'note'      ? 'Delete this note' :
      snippet.type === 'erase'     ? 'Restore this element' :
      snippet.type === 'resize'    ? 'Revert this resize' :
      snippet.type === 'drawing'   ? 'Delete this drawing' :
      'Delete';
    trashBtn.innerHTML = ICON_TRASH;
    trashBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      deleteSnippet(snippet);
    });
    row.appendChild(trashBtn);

    return row;
  }

  // ── Click-to-expand: full debug detail for ERASE / RESIZE rows ───────────
  // Toggles the inline expansion below an Edits-mode row. Tracks state in
  // expandedIds so re-renders (storage onChanged) preserve the open state.
  function toggleExpanded(snippet, row) {
    if (snippet.type !== 'erase' && snippet.type !== 'resize' && snippet.type !== 'drawing') return;
    if (expandedIds.has(snippet.id)) {
      expandedIds.delete(snippet.id);
      removeClass(row, 'adnota-scratchpad-row-expanded');
      const detail = row.querySelector('[data-role~="adnota-scratchpad-detail"]');
      if (detail) detail.remove();
    } else {
      expandedIds.add(snippet.id);
      addClass(row, 'adnota-scratchpad-row-expanded');
      row.appendChild(buildExpandedDetail(snippet));
    }
    window.AdnotaLog?.event('scratchpad', 'expand-toggle', {
      type: snippet.type, expanded: expandedIds.has(snippet.id),
    });
  }

  // Inline expansion DOM. Surfaces the noisy debug fields (full _id, full
  // selector, ISO timestamp, RESIZE cssText) and a "copy as JSON" button —
  // single click → clipboard contains the raw storage record.
  function buildExpandedDetail(snippet) {
    const wrap = document.createElement('div');
    setClass(wrap, 'adnota-scratchpad-detail');

    const rec = snippet.record || {};
    const rows = [];
    rows.push(['ID', String(snippet.id)]);
    if (snippet.type === 'erase' || snippet.type === 'resize') {
      rows.push(['Selector', snippet.selector || '(unknown)']);
    }
    if (snippet.type === 'drawing') {
      rows.push(['Shape', rec.shapeType || '(unknown)']);
      if (rec.color) rows.push(['Color', rec.color]);
      if (rec.strokeWidth != null) rows.push(['Stroke', String(rec.strokeWidth)]);
      if (rec.shapeType === 'freehand' && Array.isArray(rec.drawing)) {
        rows.push(['Points', String(rec.drawing.length)]);
      }
      if (rec.text) rows.push(['Text', rec.text]);
      if (rec.fontSize != null) rows.push(['Font', String(rec.fontSize)]);
    }
    if (snippet.type === 'resize' && rec.cssText) rows.push(['CSS', rec.cssText]);
    // DOM-reorder rules (kind === 'reflow:dom-reorder') have no cssText —
    // they store a human-readable `label` instead, e.g. "→ moved to end of
    // parent". Fall back to that so the detail view is non-empty.
    if (snippet.type === 'resize' && !rec.cssText && rec.label) rows.push(['Move', rec.label]);
    if (snippet.type === 'resize' && rec.kind)    rows.push(['Kind', rec.kind]);
    if (rec.path) rows.push(['Path', rec.path]);
    if (rec.timestamp) {
      try { rows.push(['When', new Date(rec.timestamp).toISOString()]); }
      catch (_) {}
    }
    if (snippet.stale) {
      rows.push(['Status', snippet.type === 'drawing'
        ? 'stale (anchor not on this page)'
        : 'stale (selector did not match)']);
    }

    for (const [k, v] of rows) {
      const row = document.createElement('div');
      setClass(row, 'adnota-scratchpad-detail-row');
      const key = document.createElement('span');
      setClass(key, 'adnota-scratchpad-detail-key');
      key.textContent = k;
      const val = document.createElement('span');
      setClass(val, 'adnota-scratchpad-detail-val');
      val.textContent = v;
      row.append(key, val);
      wrap.appendChild(row);
    }

    const copyJsonBtn = document.createElement('button');
    copyJsonBtn.type = 'button';
    setClass(copyJsonBtn, 'adnota-scratchpad-detail-copyjson');
    copyJsonBtn.textContent = 'Copy as JSON';
    copyJsonBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(JSON.stringify(rec, null, 2));
        copyJsonBtn.textContent = 'Copied';
        setTimeout(() => {
          if (copyJsonBtn.isConnected) copyJsonBtn.textContent = 'Copy as JSON';
        }, COPY_REVERT_MS);
        window.AdnotaLog?.event('scratchpad', 'copy-json', { type: snippet.type });
      } catch (_) {}
    });
    wrap.appendChild(copyJsonBtn);

    // Stop click propagation inside the detail so clicking text/copy doesn't
    // trigger the row's collapse handler.
    wrap.addEventListener('click', (e) => e.stopPropagation());

    return wrap;
  }

  // ── Per-item soft-delete ─────────────────────────────────────────────────
  // Mirrors pages/sites.js deleteFeedItem: snapshot the storage form, splice
  // it out by id, show a 5s undo toast that re-pushes the snapshot if used.
  // The storage.onChanged listener already wired up at panel-open re-renders
  // the body in both directions, so no manual re-render is needed here.
  async function deleteSnippet(snippet) {
    const hostname = location.hostname;
    const actionType = ACTION_BY_TYPE[snippet.type];
    const idField = ID_FIELD_BY_TYPE[snippet.type];
    if (!actionType || !idField) return;
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

    // Live-state revert. Highlights/notes are managed by their own engines
    // observing storage changes, but ERASE/RESIZE/MARKER need explicit
    // cleanup so the page reflects the deletion immediately, not on next
    // refresh. Each tool exposes a removeOne(id) symmetric with applyOne.
    if (snippet.type === 'erase') {
      try { window.AdnotaEraser?.removeOne?.(snippet.id); } catch (_) {}
    } else if (snippet.type === 'resize') {
      try { window.AdnotaResizer?.removeOne?.(snippet.id); } catch (_) {}
    } else if (snippet.type === 'drawing') {
      try { window.AdnotaMarker?.removeOne?.(snippet.id); } catch (_) {}
    }

    expandedIds.delete(snippet.id);
    // Clear any mute entry too — if this was a muted row, the live effect
    // was already removed; deleting the storage row makes the mute moot.
    // If user undoes the delete, the row comes back un-muted (applyOne in
    // the undo handler re-applies, and mutedIds no longer claims it's off).
    mutedIds.delete(snippet.id);

    window.AdnotaLog?.event('scratchpad', 'delete', { type: snippet.type });

    const message =
      snippet.type === 'highlight' ? 'Snippet deleted' :
      snippet.type === 'note'      ? 'Note deleted' :
      snippet.type === 'erase'     ? 'Erase reverted' :
      snippet.type === 'resize'    ? 'Resize reverted' :
      snippet.type === 'drawing'   ? 'Drawing deleted' : 'Item deleted';
    showUndoToast(message, async () => {
      try {
        const again = await chrome.storage.local.get(hostname);
        const rec = again[hostname] || { items: [] };
        rec.items = (rec.items || []).concat([snapshot]);
        await chrome.storage.local.set({ [hostname]: rec });
        // For ERASE/RESIZE/MARKER, putting the record back into storage
        // isn't enough — the live state was cleared by removeOne(). Call
        // applyOne() to re-apply the edit live so the page reflects the
        // undo without a refresh.
        if (snippet.type === 'erase') {
          try { window.AdnotaEraser?.applyOne?.(snapshot); } catch (_) {}
        } else if (snippet.type === 'resize') {
          try { window.AdnotaResizer?.applyOne?.(snapshot); } catch (_) {}
        } else if (snippet.type === 'drawing') {
          try { window.AdnotaMarker?.applyOne?.(snapshot); } catch (_) {}
        }
        window.AdnotaLog?.event('scratchpad', 'delete-undo', { type: snippet.type });
      } catch (err) {
        console.error('[Adnota Scratchpad] Undo failed:', err);
      }
    });
  }

  function showUndoToast(message, onUndo, duration = 5000) {
    if (!panel) return;
    let toast = panel.querySelector('[data-role~="adnota-scratchpad-toast"]');
    if (!toast) {
      toast = document.createElement('div');
      setClass(toast, 'adnota-scratchpad-toast');
      panel.appendChild(toast);
    }
    toast.textContent = '';
    addClass(toast, 'has-undo');

    const msg = document.createElement('span');
    setClass(msg, 'adnota-scratchpad-toast-msg');
    msg.textContent = message;
    toast.appendChild(msg);

    const btn = document.createElement('button');
    btn.type = 'button';
    setClass(btn, 'adnota-scratchpad-toast-undo');
    btn.textContent = 'Undo';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      clearTimeout(_toastTimer);
      try { await onUndo?.(); } catch (_) {}
      removeClass(toast, 'visible', 'has-undo');
    });
    toast.appendChild(btn);

    addClass(toast, 'visible');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      removeClass(toast, 'visible', 'has-undo');
    }, duration);
  }

  async function copyAll() {
    const list = filtered();
    if (!list.length) return;
    // Snippets mode (highlights/notes): prose join — TEXT-IS-KING, the
    // user wrote/grabbed this text and wants it back exactly.
    // Edits mode (erase/resize/drawing): no meaningful prose payload, so
    // dump the raw storage rows as a JSON array. Round-trips into a debug
    // paste, mirrors the per-row "Copy as JSON" button in expanded detail.
    // Filter-aware: only the visible sub-tab's records are copied.
    const payload = activeMode === 'edits'
      ? JSON.stringify(list.map(s => s.record).filter(Boolean), null, 2)
      : list.map(s => isRedaction(s) ? redactionBar(s.text) : s.text).join('\n\n');
    if (!payload) return;
    try { await navigator.clipboard.writeText(payload); }
    catch (_) { return; }
    showScratchToast('Copied all');
    addClass(copyAllBtn, 'copied');
    copyAllBtn.innerHTML = ICON_CHECK;
    setTimeout(() => {
      if (!copyAllBtn?.isConnected) return;
      removeClass(copyAllBtn, 'copied');
      copyAllBtn.innerHTML = ICON_COPY_ALL;
    }, COPY_REVERT_MS);
    window.AdnotaLog?.event('scratchpad', 'copy-all', {
      count: list.length, mode: activeMode, format: activeMode === 'edits' ? 'json' : 'prose',
    });
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
    } else if (snippet.type === 'erase' || snippet.type === 'resize') {
      ok = scrollToEditElement(snippet);
    } else if (snippet.type === 'drawing') {
      ok = scrollToDrawing(snippet);
    }
    if (!ok) {
      showScratchToast("Couldn't locate this on the page.");
      window.AdnotaLog?.event('scratchpad', 'goto-miss', { type: snippet.type });
      return;
    }
    window.AdnotaLog?.event('scratchpad', 'goto', { type: snippet.type });
  }

  // Locate logic for ERASE / RESIZE rows. For RESIZE the element is fully
  // visible — straightforward scroll + pulse. For ERASE the element is
  // display:none'd (its bounding rect is zero, so a pulse on it is
  // invisible), so we briefly override to a ghosted, non-interactive
  // state for the duration of the pulse, then drop the override and let
  // the override style tag keep it hidden. pointer-events:none on the
  // override prevents a re-emerged modal/popup from hijacking the page.
  function scrollToEditElement(snippet) {
    if (!snippet.selector) return false;
    let target = null;
    try { target = document.querySelector(snippet.selector); } catch (_) {}
    if (!target) return false;
    try {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_) {
      try { target.scrollIntoView(); } catch (_) {}
    }
    const accent = snippet.type === 'erase' ? '#ef4444' : '#3b82f6';
    if (snippet.type === 'erase') {
      revealAndPulse(target, accent, snippet.id);
    } else {
      spawnEditPulse(target, accent);
    }
    return true;
  }

  // Locate logic for DRAWING rows. The marker engine exposes scrollTo, and
  // the pulse animates the wrapper's bounding rect — drawings are visible
  // on the page already, so no reveal-and-pulse hack is needed.
  function scrollToDrawing(snippet) {
    if (!window.AdnotaMarker?.scrollTo?.(snippet.id)) return false;
    let wrapper = null;
    try {
      wrapper = document.querySelector(`.adnota-marker-wrapper[data-uuid="${snippet.id}"]`);
    } catch (_) {}
    if (wrapper) spawnEditPulse(wrapper, snippet.color || '#a78bfa');
    return true;
  }

  // Briefly un-hide an erased element so the user can see *where* it was
  // before clicking trash to permanently restore. Uses inline overrides
  // with !important to beat the override style tag, including
  // pointer-events:none so a popup-shaped element can't intercept clicks.
  // The eraser may have attached a MutationObserver guard at restore-time
  // to re-assert display:none against page mutations — detach it for the
  // duration of the pulse, then re-attach with the same config.
  function revealAndPulse(target, accent, eraseId) {
    const ruleSelector = (eraseId && window.AdnotaEraseRules?.get?.(eraseId)) || null;
    let guardWasAttached = false;
    try {
      // detachEraseStyleGuard returns truthy when a guard existed (depends
      // on lib/adnotaUI.js implementation; safe to call either way).
      const detached = window.AdnotaUI?.detachEraseStyleGuard?.(target);
      guardWasAttached = !!detached;
    } catch (_) {}
    const props = {
      display: 'revert',
      visibility: 'visible',
      opacity: '0.55',
      outline: `2px dashed ${accent}`,
      'outline-offset': '2px',
      'pointer-events': 'none',
    };
    const prev = {};
    for (const [k, v] of Object.entries(props)) {
      prev[k] = target.style.getPropertyValue(k);
      target.style.setProperty(k, v, 'important');
    }
    // Defer the pulse one frame so the browser has a chance to lay out the
    // newly-visible element and produce a non-zero bounding rect.
    requestAnimationFrame(() => {
      try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
      spawnEditPulse(target, accent);
    });
    setTimeout(() => {
      for (const k of Object.keys(props)) {
        if (prev[k]) target.style.setProperty(k, prev[k]);
        else target.style.removeProperty(k);
      }
      // Re-attach the guard with its original config (id + ruleSelector)
      // so override-resistant pages stay erased after the pulse fades.
      if (guardWasAttached && ruleSelector && eraseId) {
        try {
          window.AdnotaUI?.attachEraseStyleGuard?.(target, {
            id: eraseId, ruleSelector, reason: 'locate-restore',
          });
        } catch (_) {}
      }
    }, 1400);
  }

  // Brief outline + fill pulse on an element's bounding box. Lives in the
  // viewport-fixed layer so layout shifts don't drag it. Auto-removes after
  // the animation completes. Uses Web Animations API so we don't have to
  // inject keyframes into the document.
  function spawnEditPulse(target, accent) {
    const rect = target.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const pulse = document.createElement('div');
    pulse.setAttribute('data-adnota-ui', '1');
    Object.assign(pulse.style, {
      position: 'fixed',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      pointerEvents: 'none',
      zIndex: '2147483646',
      borderRadius: '4px',
      outline: `3px solid ${accent}`,
      outlineOffset: '0px',
      background: accent + '22', // ~13% alpha
      boxShadow: `0 0 12px ${accent}66`,
      opacity: '0',
    });
    document.documentElement.appendChild(pulse);
    try {
      pulse.animate(
        [
          { opacity: 0,    transform: 'scale(1.04)' },
          { opacity: 1,    transform: 'scale(1)' },
          { opacity: 1,    transform: 'scale(1)' },
          { opacity: 0,    transform: 'scale(1)' },
        ],
        { duration: 1200, easing: 'ease-out' }
      ).onfinish = () => pulse.remove();
    } catch (_) {
      setTimeout(() => pulse.remove(), 1300);
    }
  }

  // Tiny scoped toast — lives inside the panel, dismisses itself after 2s.
  // Inline-styled to keep CSS surface minimal; only a single toast at a time.
  let _toastTimer = null;
  function showScratchToast(msg) {
    if (!panel) return;
    let toast = panel.querySelector('[data-role~="adnota-scratchpad-toast"]');
    if (!toast) {
      toast = document.createElement('div');
      setClass(toast, 'adnota-scratchpad-toast');
      panel.appendChild(toast);
    }
    toast.textContent = msg;
    removeClass(toast, 'has-undo');
    addClass(toast, 'visible');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => removeClass(toast, 'visible'), 2000);
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
    toggleClass(tagToggleBtn, 'active', tagBarVisible);
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
      setClass(empty, 'adnota-scratchpad-tagbar-empty');
      empty.textContent = 'No tags on this page yet.';
      tagBarEl.appendChild(empty);
      return;
    }

    const allChip = document.createElement('button');
    allChip.type = 'button';
    setClass(allChip, 'adnota-scratchpad-tagchip' + (activeTag === null ? ' active' : ''));
    allChip.textContent = 'All';
    allChip.addEventListener('click', (e) => {
      e.stopPropagation();
      setActiveTag(null);
    });
    tagBarEl.appendChild(allChip);

    for (const tag of sorted) {
      const chip = document.createElement('button');
      chip.type = 'button';
      setClass(chip, 'adnota-scratchpad-tagchip' + (activeTag === tag ? ' active' : ''));
      const hash = document.createElement('span');
      setClass(hash, 'adnota-scratchpad-tagchip-hash');
      hash.textContent = '#';
      const name = document.createElement('span');
      setClass(name, 'adnota-scratchpad-tagchip-name');
      name.textContent = tag;
      const count = document.createElement('span');
      setClass(count, 'adnota-scratchpad-tagchip-count');
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
        if (pos?.left && pos?.top) {
          panel.style.right = 'auto';
          panel.style.bottom = 'auto';
          panel.style.left = pos.left;
          panel.style.top = pos.top;
          // Re-clamp in case the viewport shrank since the saved position.
          const r = panel.getBoundingClientRect();
          const c = clampPosition(parseFloat(pos.left), parseFloat(pos.top), r.width, r.height);
          panel.style.left = c.left + 'px';
          panel.style.top  = c.top + 'px';
        } else {
          // No saved position — convert the right/bottom CSS defaults to the
          // equivalent left/top so native resize:both grows in the cursor
          // direction. Without this, the bottom-right resize handle drags
          // the panel's left/top edges (right/bottom are pinned), which
          // reads as backwards.
          const r = panel.getBoundingClientRect();
          panel.style.right = 'auto';
          panel.style.bottom = 'auto';
          panel.style.left = r.left + 'px';
          panel.style.top  = r.top + 'px';
        }
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
      // Persist position alongside size: with left/top anchoring the panel's
      // top-left edge stays fixed during a resize, but its visual extent
      // changes. Without saving position too, a resize-only session would
      // bounce back to the CSS-default bottom-right corner on refresh — even
      // though the user clearly "left" the panel in a different spot.
      resizePersistTimer = setTimeout(() => {
        persistSize();
        persistPosition();
      }, 400);
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
      const data = await chrome.storage.local.get([FILTER_KEY, TAG_BAR_KEY, MODE_KEY]);
      activeFilter = data[FILTER_KEY] ?? 'all';
      tagBarVisible = !!data[TAG_BAR_KEY];
      const savedMode = data[MODE_KEY];
      if (savedMode === 'snippets' || savedMode === 'edits') {
        activeMode = savedMode;
        // Re-build sub-tabs after a non-default mode is loaded so the tab
        // strip matches the active mode before the first render() runs.
        buildSubTabs();
      }
      // Normalize the persisted activeFilter against the current mode's
      // tab list. Old installs may have 'all' saved while in Edits mode
      // (the tab no longer exists) — fall back to the mode's default tab.
      if (!isValidFilterForMode(activeMode, activeFilter)) {
        activeFilter = defaultFilterForMode(activeMode);
      }
    } catch (_) {}

    snippetCache = await loadSnippets();

    // Auto-flip on initial open: if the resolved mode has no records on this
    // page but the other mode does, show what's actually here instead of an
    // empty "No snippets/edits yet." Only flips in-memory — storage retains
    // the user's last explicit pick, so when both modes have content next
    // time, that pick wins again. Caller-specified opens (openOn) bypass.
    const otherMode = activeMode === 'snippets' ? 'edits' : 'snippets';
    const activeHas = snippetCache.some(s => TYPES_BY_MODE[activeMode].has(s.type));
    const otherHas  = snippetCache.some(s => TYPES_BY_MODE[otherMode].has(s.type));
    if (!activeHas && otherHas) {
      activeMode = otherMode;
      activeFilter = defaultFilterForMode(activeMode);
      buildSubTabs();
    }

    // Same idea one level down: if the resolved sub-tab is empty but another
    // sub-tab in this mode has content, land on a populated one. Snippets has
    // an 'all' tab that subsumes everything (the natural fallback); Edits
    // has no 'all', so walk its tabs in order and pick the first non-empty.
    const FILTER_TYPE = {
      highlights: 'highlight', notes: 'note',
      erased: 'erase', resized: 'resize', drawing: 'drawing',
    };
    const subTabHas = (f) => f === 'all'
      ? snippetCache.some(s => TYPES_BY_MODE[activeMode].has(s.type))
      : snippetCache.some(s => s.type === FILTER_TYPE[f]);
    if (!subTabHas(activeFilter)) {
      if (activeMode === 'snippets') {
        activeFilter = 'all';
      } else {
        for (const [val] of TABS_BY_MODE.edits) {
          if (subTabHas(val)) { activeFilter = val; break; }
        }
      }
    }

    render();

    // Live updates: storage changes for this domain key OR the global filter
    // pref re-render in place.
    storageListener = (changes, area) => {
      if (area !== 'local') return;
      if (changes[host()] || changes[FILTER_KEY] || changes[MODE_KEY]) refresh();
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
    filtersEl = null;
    modeBtnEl = null;
    filterEls = [];
    expandedIds.clear();
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

  // Pulse every visible row's trash glyph red 3× to teach "this is where
  // per-item delete lives." Fired by openOn() so a tool dock-trash click
  // routes here AND points at the row affordance instead of silently
  // landing on a list. No-op when the view is empty (the empty-state copy
  // already explains "nothing to delete here").
  function blinkAllRows() {
    if (!bodyEl) return;
    const trashes = bodyEl.querySelectorAll('[data-role~="adnota-scratchpad-rowtrash"]');
    if (!trashes.length) return;
    for (const t of trashes) {
      removeClass(t, 'adnota-blink');
    }
    // Force reflow so re-adding the class restarts the animation when a
    // user clicks a tool-trash twice in quick succession.
    void bodyEl.offsetWidth;
    for (const t of trashes) {
      addClass(t, 'adnota-blink');
      // 3 pulses × 0.42s = 1.26s; clean up just after.
      setTimeout(() => removeClass(t, 'adnota-blink'), 1300);
    }
  }

  // openOn(mode, filter): opens the panel pre-applied to a specific view, or
  // switches to that view in-place if already open. Used by dock-trash
  // buttons to route directly to "review the items I'd otherwise nuke."
  // Mode/filter are persisted so subsequent open()s remember the choice.
  async function openOn(mode, filter) {
    if (mode !== 'snippets' && mode !== 'edits') return;
    const validFilter = isValidFilterForMode(mode, filter)
      ? filter
      : defaultFilterForMode(mode);
    if (!panel) {
      // Persist first so open()'s storage read picks up the new state.
      try {
        await chrome.storage.local.set({ [MODE_KEY]: mode, [FILTER_KEY]: validFilter });
      } catch (_) {
        // Fall through to open(); it'll fix activeMode/activeFilter from
        // the in-memory state we set just below.
      }
      activeMode = mode;
      activeFilter = validFilter;
      await open();
      blinkAllRows();
      return;
    }
    // Already open — switch in-place. setMode handles mode swap (rebuilds
    // sub-tabs, resets activeFilter to mode default), then setFilter
    // narrows to the requested sub-tab if different. Both call render()
    // synchronously, so rows are present before the blink fires.
    if (activeMode !== mode) setMode(mode);
    if (activeFilter !== validFilter) setFilter(validFilter);
    blinkAllRows();
  }

  function isOpen() { return !!panel; }

  async function refresh() {
    if (!panel) return;
    try {
      const data = await chrome.storage.local.get([FILTER_KEY, MODE_KEY]);
      const m = data[MODE_KEY];
      if ((m === 'snippets' || m === 'edits') && m !== activeMode) {
        activeMode = m;
        buildSubTabs();
        expandedIds.clear();
      }
      const f = data[FILTER_KEY] ?? 'all';
      activeFilter = isValidFilterForMode(activeMode, f)
        ? f
        : defaultFilterForMode(activeMode);
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
    openOn,
    close,
    isOpen,
    refresh,
    pageSnippetCount,
    pageActionCount,
  };
})();
