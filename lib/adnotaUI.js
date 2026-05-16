// lib/adnotaUI.js — Shared Adnota UI utilities
//
// Loaded before all content scripts. Provides common helpers so that
// eraser, resizer, highlighter, sticky, and marker don't duplicate
// the same DOM patterns.

// Internal: compact rect summary for console output in debug mode.
function _rectToObj(r) {
  return {
    x: Math.round(r.left), y: Math.round(r.top),
    w: Math.round(r.width), h: Math.round(r.height),
    right: Math.round(r.right), bottom: Math.round(r.bottom),
  };
}

window.AdnotaUI = {

  // ─── Element identification ─────────────────────────────────────────────────
  // Every Adnota UI element is tagged with data-adnota-ui="1".
  // A single .closest() check is all that's needed — no selector list to maintain.

  isAdnotaElement(el) {
    return !!el?.closest('[data-adnota-ui]');
  },

  // ─── Ad identifier pattern ──────────────────────────────────────────────────
  // Hyphen-segmented match for tag names and attribute names that smell like
  // ad infrastructure. Anchored at hyphen boundaries so generic words ("address",
  // "gradient", "data-radio", "aria-describedby") don't trip it. Catches custom
  // elements like <shreddit-comments-page-ad> / <shreddit-dynamic-ad-link> and
  // attribute names like ad-type, is-ad, is-promoted, post-promoted, data-ad-*.
  // Single source of truth — read by eraser detection and by the restorer's
  // ad-slot selector generalization (see maybeGeneralizeAdSelector below).
  adIdentifierPattern: /(^|-)(ad|ads|promoted|sponsored|advert)(-|s?$)/i,

  // If `tagName` is ad-shaped, widen the saved CSS selector to also match the
  // bare tag — so an ERASE rule for a rotating ad slot survives the next
  // impression. Reddit re-emits <shreddit-comments-page-ad id="t3_<random>">
  // with a fresh post-id every page load; the original specific selector
  // misses, but the bare-tag fallback catches every future instance. Idempotent
  // (won't double-append) and a no-op for generic tags like 'div' so non-ad
  // erasures stay tightly scoped.
  maybeGeneralizeAdSelector(specificSelector, tagName) {
    if (!specificSelector || !tagName) return specificSelector;
    const lower = String(tagName).toLowerCase();
    if (!this.adIdentifierPattern.test(lower)) return specificSelector;
    const parts = specificSelector.split(',').map(s => s.trim());
    if (parts.includes(lower)) return specificSelector;
    return `${specificSelector}, ${lower}`;
  },

  // ─── Shared DOM-walking helpers ─────────────────────────────────────────────
  // Eraser and resizer share a "smart parent selection" flow: auto-bubble past
  // visually-redundant wrappers on hover, then let the scroll wheel walk further
  // up or back down. The helpers below are the single implementation.

  // Is this rect's visible area at least `threshold` fraction of the viewport?
  // Used as a guard so we never auto-bubble up to a page-level container.
  dominatesViewport(rect, threshold = 0.85) {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (vw <= 0 || vh <= 0) return false;
    const w = Math.min(rect.right, vw) - Math.max(rect.left, 0);
    const h = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
    const visible = Math.max(0, w) * Math.max(0, h);
    return visible / (vw * vh) >= threshold;
  },

  // Debug toggle. Enable from the page console:
  //   localStorage.setItem('adnota-debug-bubble', '1')
  // Disable with `removeItem`. localStorage is shared between the page and
  // this content script (same origin), so the flag round-trips without any
  // extension plumbing.
  _bubbleDebug() {
    try { return localStorage.getItem('adnota-debug-bubble') === '1'; }
    catch { return false; }
  },

  // Walk up through ancestors looking for the outermost one whose bounding box
  // visually matches `el`, so a click on an inner element hits the outer
  // visually-identical wrapper users almost always actually want.
  //
  // Matching metric: Intersection-over-Union (IoU) against the STARTING rect.
  // IoU = overlap_area / (start_area + candidate_area - overlap_area). Two
  // rects with IoU ≥ `minIoU` cover approximately the same screen region,
  // regardless of which edges absorb slack. This is robust against asymmetric
  // layouts (flush top-left children inside padded wrappers, overflow-hidden
  // clipping, uneven margin/padding) where edge-diff comparisons are fragile.
  //
  // Leapfrog walk: we go all the way to `maxHops`, breaking only on structural
  // bailouts (no parent, Adnota UI, viewport-dominating). A non-matching hop
  // doesn't abort the climb — a better match could live just above a bulging
  // wrapper, e.g. <nav 220×356> → <div 228×364> → <div 228×364> → <ul 220×356>.
  // A strict walk stops at the first bulge and returns the <ul>; the leapfrog
  // walk continues, recognizes <nav> as a perfect IoU=1.0 match, and promotes.
  bubbleToVisualRoot(el, {
    maxHops = 8,
    minIoU = 0.85,
  } = {}) {
    const startRect = el.getBoundingClientRect();
    const startArea = Math.max(0, startRect.width) * Math.max(0, startRect.height);
    if (startArea <= 0) return el;
    const isAdnota = window.AdnotaUI.isAdnotaElement;
    const debug = window.AdnotaUI._bubbleDebug();
    const trace = debug ? [] : null;

    let current = el;
    let bestMatch = el;
    let bestIoU = 1; // start matches itself
    for (let i = 0; i < maxHops; i++) {
      const parent = current.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) {
        if (trace) trace.push({ hop: i + 1, skipped: 'no parent / hit body' });
        break;
      }
      if (isAdnota(parent)) {
        if (trace) trace.push({ hop: i + 1, skipped: 'Adnota UI' });
        break;
      }
      const pRect = parent.getBoundingClientRect();
      if (window.AdnotaUI.dominatesViewport(pRect)) {
        if (trace) trace.push({
          hop: i + 1, tag: parent.tagName, rect: _rectToObj(pRect),
          skipped: 'dominates viewport',
        });
        break;
      }

      const iw = Math.max(0, Math.min(pRect.right, startRect.right) - Math.max(pRect.left, startRect.left));
      const ih = Math.max(0, Math.min(pRect.bottom, startRect.bottom) - Math.max(pRect.top, startRect.top));
      const inter = iw * ih;
      const pArea = Math.max(0, pRect.width) * Math.max(0, pRect.height);
      const unionArea = startArea + pArea - inter;
      const iou = unionArea > 0 ? inter / unionArea : 0;
      const matches = iou >= minIoU;

      if (matches) { bestMatch = parent; bestIoU = iou; }

      if (trace) trace.push({
        hop: i + 1,
        tag: parent.tagName + (parent.id ? '#' + parent.id : '') +
             (parent.className && typeof parent.className === 'string'
               ? '.' + parent.className.trim().split(/\s+/).slice(0, 2).join('.')
               : ''),
        rect: _rectToObj(pRect),
        iou: +iou.toFixed(3),
        matches,
      });
      current = parent;
    }

    if (trace) {
      console.groupCollapsed(
        '[Adnota.bubble]',
        el.tagName + (el.id ? '#' + el.id : ''),
        `start=${Math.round(startRect.width)}\u00d7${Math.round(startRect.height)}`,
        `→ ${bestMatch === el ? 'no promotion' : bestMatch.tagName + ' (IoU=' + bestIoU.toFixed(3) + ')'}`,
      );
      for (const row of trace) console.log(row);
      console.log('start element:', el);
      console.log('best match:', bestMatch);
      console.groupEnd();
    }
    return bestMatch;
  },

  // ─── Scroll-container detection ─────────────────────────────────────────────
  // Is `el` itself an inner scroll container? Used to (a) walk up to find
  // the nearest scroller (findScrollContainer below), and (b) reject scroll
  // containers as Tier 1 sticky-note anchors — anchoring against a scroller's
  // bounding rect produces a viewport-pinned note because the rect doesn't
  // move when its inner content scrolls; only scrollTop changes. <html> and
  // <body> are deliberately excluded — the page itself is the scroll context
  // and is handled by tier 3 (doc-pixel / percentage of scrollHeight) without
  // needing a synthetic anchor.
  isScrollContainer(el) {
    if (!el || el === document.documentElement || el === document.body) return false;
    const cs = getComputedStyle(el);
    const yScrolls = (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'overlay') && el.scrollHeight > el.clientHeight;
    const xScrolls = (cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowX === 'overlay') && el.scrollWidth  > el.clientWidth;
    return yScrolls || xScrolls;
  },

  // Walk up to the nearest inner scrolling ancestor. App shells (claude.ai,
  // chatgpt.com, Notion, etc.) keep body at overflow:hidden and scroll an
  // inner div — that's what we want to anchor against for the marker's Tier 2
  // container fallback and the sticky's Tier 2 container fallback.
  //
  // `includeSelf: true` accepts `el` itself as a match (sticky's Tier 2 needs
  // this when the click landed in whitespace and the walk-seed element IS the
  // scroll container — a bare-whitespace click on Gemini's <infinite-scroller>
  // is the canonical example). Default false preserves the marker tool's
  // existing semantic (caller passes its block element, wants the scroller
  // *containing* it).
  findScrollContainer(el, { includeSelf = false } = {}) {
    let cur = el && (includeSelf ? el : el.parentElement);
    while (cur && cur !== document.documentElement && cur !== document.body) {
      if (this.isScrollContainer(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  },

  // ─── Anchor-sync listener triad ─────────────────────────────────────────────
  // Highlighter fallback overlays and marker wrappers all need the same set of
  // listeners to keep their position synced to an anchor element: window
  // resize, window scroll (capture, to catch nested scrollers), and a
  // ResizeObserver on the anchor itself. Without explicit teardown those leak
  // for the life of the tab — every delete or page-restructure that drops the
  // wrapper leaves the listener bag and the ResizeObserver behind, and on a
  // long-lived SPA tab they pile up enough to slow scrolls. This helper bundles
  // the registration + cleanup so the listener bag can't outlive the wrapper.
  //
  // Stashes the cleanup as `wrapper._adnotaCleanup` for explicit teardown
  // (delete paths) and installs a parent-childList MutationObserver to
  // auto-clean if the wrapper is removed by anything else (bulk-delete sweeps,
  // page mutations). Cleanup is idempotent.

  bindAnchorSync(wrapper, anchorElement, syncFn) {
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; syncFn(); });
    };

    syncFn();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(anchorElement);

    let cleaned = false;
    let mo = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, { capture: true });
      ro.disconnect();
      if (mo) mo.disconnect();
    };
    wrapper._adnotaCleanup = cleanup;

    // Watch the wrapper's parent rather than the wrapper itself — a node can't
    // observe its own removal. childList only (no subtree) keeps the observer
    // cheap on busy SPA pages.
    const parent = wrapper.parentNode;
    if (parent) {
      mo = new MutationObserver(() => {
        if (!wrapper.isConnected) cleanup();
      });
      mo.observe(parent, { childList: true });
    }

    return cleanup;
  },

  // ─── Hover overlay factory ──────────────────────────────────────────────────
  // Both eraser (red) and resizer (blue) use the same absolutely-positioned
  // overlay to highlight the element under the cursor.

  createHoverOverlay(id, borderColor, bgColor) {
    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.setAttribute('data-adnota-ui', '1');
    Object.assign(overlay.style, {
      position: 'absolute',
      pointerEvents: 'none',
      border: `2px solid ${borderColor}`,
      backgroundColor: bgColor,
      // Max int32 — modern ad/banner chrome (cookie banners, sticky promos,
      // chat widgets) routinely uses 2147483647, so anything lower can get
      // occluded. At the max, ties are broken by DOM order — callers should
      // re-append the overlay to documentElement on show to win the tie
      // (see resizer.js updateHoverTarget).
      zIndex: '2147483647',
      transition: 'all 0.08s ease',
      display: 'none',
      borderRadius: '2px',
    });
    document.documentElement.appendChild(overlay);
    return overlay;
  },

  // ─── Pointer-capture drag ───────────────────────────────────────────────────
  // Used by the eraser HUD and highlighter toolbar. Converts a fixed-position
  // element from centered (left:50% + transform) to absolute left/top on first
  // drag, and restores grab cursor on release.
  //
  //   AdnotaUI.makeDraggable(eraserHud)              — whole element is handle
  //   AdnotaUI.makeDraggable(toolbar, dragHandle)    — only handle starts drag

  makeDraggable(element, handle) {
    if (!handle) handle = element;
    let dragState = null;

    element.addEventListener('pointerdown', (e) => {
      if (handle !== element && !handle.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      dragState = {
        startX: e.clientX,
        startY: e.clientY,
        startLeft: element.getBoundingClientRect().left,
        startTop: element.getBoundingClientRect().top,
      };
      handle.style.cursor = 'grabbing';
      element.setPointerCapture(e.pointerId);
    });

    element.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      element.style.left = (dragState.startLeft + dx) + 'px';
      element.style.top = (dragState.startTop + dy) + 'px';
      element.style.bottom = 'auto';
      element.style.transform = 'none';
    });

    element.addEventListener('pointerup', (e) => {
      if (!dragState) return;
      dragState = null;
      handle.style.cursor = 'grab';
      element.releasePointerCapture(e.pointerId);
    });
  },

  // ─── Toast notifications ────────────────────────────────────────────────────
  // Consistent "V"-branded toast with optional Undo button and auto-dismiss.
  //
  //   AdnotaUI.showToast('Element erased', { id: 'adnota-eraser-toast', onUndo: fn })
  //   AdnotaUI.dismissToast(toast)

  showToast(message, options = {}) {
    const { id, onUndo, timeout = 3000 } = options;

    if (id) {
      const existing = document.getElementById(id);
      if (existing) existing.remove();
    }

    const toast = document.createElement('div');
    if (id) toast.id = id;
    toast.className = 'adnota-toast';
    toast.setAttribute('data-adnota-ui', '1');

    let actionsHtml = '';
    if (onUndo) {
      actionsHtml = '<div class="adnota-toast-actions"><span class="adnota-toast-undo">Undo</span></div>';
    }

    // Every Adnota surface gets a corner dismiss — "we never get in your way."
    // Reuses .adnota-select-delete (the red-X circle from marker.css) and adds
    // .adnota-toast-dismiss for top-right positioning inside the toast.
    toast.innerHTML = `
      <div class="adnota-toast-logo">A</div>
      <span class="adnota-toast-message">${message}</span>
      ${actionsHtml}
      <span class="adnota-select-delete adnota-toast-dismiss" aria-label="Dismiss">✕</span>
    `;
    (document.body || document.documentElement).appendChild(toast);

    toast.querySelector('.adnota-toast-dismiss').addEventListener('click', () => {
      window.AdnotaUI.dismissToast(toast);
    });

    // Entrance animation: toast is created in its "off-screen" state
    // (opacity:0 + translateY(20px) per content/sticky.css). Double-rAF
    // guarantees the browser commits that initial paint before we add
    // .adnota-toast-visible — a single rAF occasionally batches both
    // operations into one frame, skipping the slide-in entirely.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => toast.classList.add('adnota-toast-visible'));
    });

    if (onUndo) {
      toast.querySelector('.adnota-toast-undo').addEventListener('click', () => {
        onUndo();
        window.AdnotaUI.dismissToast(toast);
      });
    }

    if (timeout > 0) {
      setTimeout(() => window.AdnotaUI.dismissToast(toast), timeout);
    }

    return toast;
  },

  dismissToast(toast) {
    if (!toast || !toast.parentNode) return;
    // Exit animation: remove the visible class so the toast fades + slides
    // back down (0.2s in content/sticky.css). Remove from DOM just after
    // the transition completes — 220ms covers the 200ms transition plus
    // a small buffer for jank.
    toast.classList.remove('adnota-toast-visible');
    setTimeout(() => toast.remove(), 220);
  },

  // ─── Shared toolbar icons ──────────────────────────────────────────────────
  // Any HUD toolbar can pull from here to stay visually consistent.

  ICONS: {
    undo:  '<path d="M4 8h10a3 3 0 010 6H10"/><path d="M7 5L4 8l3 3"/>',
    trash: '<polyline points="3 6 17 6"/><path d="M15 6v10a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 9v6"/><path d="M12 9v6"/><path d="M8 6V4h4v2"/>',
    help:  '<circle cx="10" cy="10" r="7.5"/><path d="M7.7 7.6c.3-1.3 1.3-2.1 2.5-2.1 1.4 0 2.4.9 2.4 2.2 0 1-.6 1.5-1.6 2-.7.4-1 .8-1 1.5"/><circle cx="10" cy="14.4" r="0.7" fill="currentColor" stroke="none"/>',
  },

  // ─── Toolbar icon button factory ────────────────────────────────────────────
  // Produces a button that matches the .adnota-undo-btn styling used across
  // all HUD toolbars. Use for trash/undo/any single-icon control.

  createToolbarIconButton(iconPath, title, onClick) {
    const btn = document.createElement('div');
    btn.className = 'adnota-undo-btn';
    btn.setAttribute('data-adnota-tooltip', title);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.innerHTML = iconPath;
    btn.appendChild(svg);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick(e);
    });
    return btn;
  },

  // Choose singular or plural form based on count.
  pluralize(n, singular, plural) {
    return n === 1 ? singular : (plural || singular + 's');
  },

  // Key an item uses for identity in storage (uuid for notes/markers, _id for others).
  _itemId(item) {
    return item.uuid ?? item._id;
  },

  // ─── Erase style guard ────────────────────────────────────────────────────
  // Inline `display: block !important` beats stylesheet `display: none !important`
  // (CSS spec — inline trumps stylesheet at the same specificity). Ad slots
  // (Freestar, GAM) re-assert their inline style after our restorer runs, so
  // erasures appear to revert seconds after page load. The guard watches the
  // erased element's `style` attribute and re-applies `display: none` whenever
  // the page mutates display back.
  //
  // Cost: one idle MutationObserver per erased element, attribute-filtered to
  // `style`, no subtree. Wakes only when *that one element's* style attr
  // mutates — typically zero or one time per page load. Hard cap on
  // re-assertions so a page that battles in a tight loop doesn't burn CPU.
  ERASE_GUARD_MAX_FIGHTS: 10,

  attachEraseStyleGuard(el, { id, ruleSelector, reason } = {}) {
    if (!el || el._adnotaEraseGuard) return;
    let fights = 0;
    const MAX = window.AdnotaUI.ERASE_GUARD_MAX_FIGHTS;
    const observer = new MutationObserver(() => {
      // "Show all" mode is the user explicitly asking to see the page as
      // shipped — don't fight the visibility toggle's removeProperty.
      if (window.AdnotaVisibility?.hidden) return;
      // Echo of our own re-assert; nothing to do.
      if (el.style.getPropertyValue('display') === 'none' &&
          el.style.getPropertyPriority('display') === 'important') {
        return;
      }
      if (fights >= MAX) {
        observer.disconnect();
        delete el._adnotaEraseGuard;
        window.AdnotaLog?.event('eraser', 'guard-gave-up', {
          id, ruleSelector, reason, fights,
          finalInlineStyle: el.style.cssText || null,
        });
        return;
      }
      fights++;
      el.style.setProperty('display', 'none', 'important');
      // Log the first re-assertion so a defeat-then-recover cycle is visible.
      // Subsequent fights stay silent — no per-mutation log spam.
      if (fights === 1) {
        window.AdnotaLog?.event('eraser', 'guard-reasserted', {
          id, ruleSelector, reason,
        });
      }
    });
    observer.observe(el, { attributes: true, attributeFilter: ['style'] });
    el._adnotaEraseGuard = observer;
  },

  detachEraseStyleGuard(el) {
    if (el?._adnotaEraseGuard) {
      el._adnotaEraseGuard.disconnect();
      delete el._adnotaEraseGuard;
    }
  },

  // ─── Soft-delete with undo ──────────────────────────────────────────────────
  // Snapshot matching items, pull them from storage immediately, hide from the
  // DOM, and show a 5s toast with Undo. If the user undoes (button or Ctrl+Z),
  // items are written back and re-rendered. Otherwise they stay deleted.
  // This mirrors the per-item sticky/eraser delete flow for bulk operations.

  async softDeleteItems({ singular, plural, actionTypes, skipConfirm, scope }) {
    const domain = location.hostname;
    const path = location.pathname;
    const actionSet = new Set(actionTypes);
    // Scope:
    //   'page' — items where path === currentPath (strict page-only)
    //   'site' — items where path === '*' (site-wide rules only)
    //   default — both, the legacy "applies to this page" union
    const scopeFilter = (item) => {
      if (scope === 'page') return item.path === path;
      if (scope === 'site') return item.path === '*';
      return item.path === path || item.path === '*';
    };
    const scopeLabel = scope === 'site' ? 'this site' : 'this page';

    const data = await chrome.storage.local.get(domain);
    const all = data[domain]?.items || [];
    const snapshot = all.filter(item => {
      const itemAction = item.action || 'ERASE';
      return scopeFilter(item) && actionSet.has(itemAction);
    });

    if (snapshot.length === 0) {
      window.AdnotaLog?.event('trash-all', 'noop', { actionTypes, scope });
      window.AdnotaUI.showToast(`No ${plural} on ${scopeLabel} to delete`);
      return;
    }

    const n = snapshot.length;
    const noun = window.AdnotaUI.pluralize(n, singular, plural);
    // Per-item summary so a deletion can be traced back to a specific anchor /
    // selector after the fact. Otherwise "{count: 3}" tells us nothing about
    // which erasures vanished — and "this ad keeps coming back" debugging
    // hinges on knowing which entry was nuked vs. which is still in storage.
    window.AdnotaLog?.event('trash-all', 'invoke', {
      actionTypes,
      count: n,
      items: snapshot.map(i => ({
        action: i.action || 'ERASE',
        id: window.AdnotaUI._itemId(i),
        selector: i.selector || i.anchor?.cssSelector || null,
        tag: i.anchor?.tagName || null,
        path: i.path || null,
      })),
    });
    
    if (!skipConfirm) {
      const ok = await window.AdnotaUI.confirmDialog({
        message: `Delete ${n} ${noun} from ${scopeLabel}?`,
        subtext: '',
      });
      if (!ok) return;
    }

    // Pull matching items out of storage by identity so items created during
    // the undo window (different IDs) stay untouched.
    const snapshotIds = new Set(snapshot.map(i => window.AdnotaUI._itemId(i)));
    const fresh = await chrome.storage.local.get(domain);
    const freshData = fresh[domain];
    if (freshData?.items) {
      freshData.items = freshData.items.filter(
        i => !snapshotIds.has(window.AdnotaUI._itemId(i))
      );
      await chrome.storage.local.set({ [domain]: freshData });
    }

    // Hide from DOM. For non-fallback highlights we can't delete individual
    // ranges from CSS.highlights, so flag a bulk rebuild once at the end.
    const needsHighlightRebuild = window.AdnotaUI._hideItems(snapshot);
    if (needsHighlightRebuild) await window.AdnotaUI._rebuildLiveHighlights();

    let committed = false;
    let commitTimeout;
    let undoEntry;

    const performUndo = async () => {
      if (committed) return;
      committed = true;
      clearTimeout(commitTimeout);
      window.AdnotaUI.dismissToast(toast);

      const again = await chrome.storage.local.get(domain);
      const againData = again[domain] || { items: [] };
      againData.items = (againData.items || []).concat(snapshot);
      await chrome.storage.local.set({ [domain]: againData });

      await window.AdnotaUI._restoreItems(snapshot);
      if (needsHighlightRebuild) await window.AdnotaUI._rebuildLiveHighlights();

      window.AdnotaUndo.remove(undoEntry);
    };

    const performCommit = () => {
      if (committed) return;
      committed = true;
      window.AdnotaUI.dismissToast(toast);
      window.AdnotaUndo.remove(undoEntry);
    };

    const toast = window.AdnotaUI.showToast(
      n === 1 ? `${noun} deleted` : `${n} ${noun} deleted`,
      { onUndo: performUndo, timeout: 0 }
    );
    commitTimeout = setTimeout(performCommit, 3000);
    undoEntry = { undo: performUndo };
    window.AdnotaUndo.push(undoEntry);
  },

  // Hide each item from the live DOM. Returns true if any non-fallback
  // HIGHLIGHT was hidden, meaning the caller must rebuild CSS.highlights.
  _hideItems(items) {
    let needsHighlightRebuild = false;
    let eraseMutated = false;
    let resizeMutated = false;

    for (const item of items) {
      const action = item.action || 'ERASE';

      if (action === 'NOTE' && item.uuid) {
        const el = document.querySelector(
          `.adnota-sticky-container[data-uuid="${item.uuid}"]`
        );
        if (el) el.remove();
      } else if (action === 'MARKER' && item.uuid) {
        const el = document.querySelector(
          `.adnota-marker-wrapper[data-uuid="${item.uuid}"]`
        );
        if (el) el.remove();
      } else if (action === 'HIGHLIGHT') {
        if (item.isFallback && item._id) {
          const el = document.querySelector(
            `.adnota-highlight-fallback[data-highlight-id="${item._id}"]`
          );
          if (el) el.remove();
        } else {
          needsHighlightRebuild = true;
        }
      } else if (action === 'ERASE') {
        if (item._id && window.AdnotaEraseRules?.has(item._id)) {
          window.AdnotaEraseRules.delete(item._id);
          eraseMutated = true;
        }
        if (item.anchor && window.FuzzyAnchor) {
          const match = window.FuzzyAnchor.findMatch(item.anchor);
          if (match.confidence >= 40 && match.element) {
            window.AdnotaUI.detachEraseStyleGuard(match.element);
            match.element.style.removeProperty('display');
            window.AdnotaErasedElements?.delete(match.element);
          }
        }
      } else if (action === 'RESIZE') {
        // REFLOW v1.5 DOM-reorder rules live in AdnotaReorderRules and
        // need a physical move-back, not just a Map delete + stylesheet
        // rebuild. Dispatch to removeOneReorder which detaches the guard
        // and reverses the move via originalPrevAnchor.
        if (item.kind === 'reflow:dom-reorder' && item._id) {
          window.AdnotaResizer?.removeOneReorder?.(item._id);
        } else if (item._id && window.AdnotaResizeRules?.has(item._id)) {
          window.AdnotaResizeRules.delete(item._id);
          resizeMutated = true;
        }
      }
    }

    if (eraseMutated && window.rebuildEraseStyleTag) window.rebuildEraseStyleTag();
    if (resizeMutated && window.rebuildResizeStyleTag) window.rebuildResizeStyleTag();

    return needsHighlightRebuild;
  },

  // Re-render a batch of items after an undo. Uses the same render paths the
  // restorer uses on page load — no DOM reload required.
  async _restoreItems(items) {
    let eraseMutated = false;
    let resizeMutated = false;
    for (const item of items) {
      const action = item.action || 'ERASE';

      if (action === 'NOTE' && window.StickyEngine) {
        window.StickyEngine.renderNote(
          item.placement, item.comments, item.uuid, false,
          item.dimensions || null,
          item.theme || 'adnota-theme-yellow',
          item.anchor || null,
          item.anchorOffset || null,
          item.tag || '',
          item.fallback || null
        );
      } else if (action === 'MARKER' && window.FuzzyAnchor && window.AdnotaMarker) {
        const match = window.FuzzyAnchor.findMatch(item.anchor);
        if (match.confidence >= 40 && match.element) {
          window.AdnotaMarker.renderMarker(match.element, item);
        }
      } else if (action === 'HIGHLIGHT') {
        if (item.isFallback && window.FuzzyAnchor && window.AdnotaHighlighter) {
          const match = window.FuzzyAnchor.findMatch(item.anchor);
          if (match.confidence >= 40 && match.element) {
            window.AdnotaHighlighter.renderFallback(match.element, item);
          }
        }
        // Non-fallback highlights are re-applied by _rebuildLiveHighlights()
        // which the caller runs after restoring storage.
      } else if (action === 'ERASE') {
        if (item._id && item.selector && window.AdnotaEraseRules) {
          window.AdnotaEraseRules.set(item._id, item.selector);
          eraseMutated = true;
        }
        if (item.anchor && window.FuzzyAnchor) {
          const match = window.FuzzyAnchor.findMatch(item.anchor);
          if (match.confidence >= 40 && match.element) {
            match.element.style.setProperty('display', 'none', 'important');
            window.AdnotaErasedElements?.add(match.element);
            window.AdnotaUI.attachEraseStyleGuard(match.element, {
              id: item._id, ruleSelector: item.selector, reason: 'undo-restore',
            });
          }
        }
      } else if (action === 'RESIZE') {
        // REFLOW v1.5 DOM-reorder restore: re-apply the move via
        // FuzzyAnchor + re-attach the guard. Branches before the
        // CSS-path check because dom-reorder rows have no top-level
        // selector/cssText fields.
        if (item.kind === 'reflow:dom-reorder' && item._id) {
          window.AdnotaResizer?.applyOneReorder?.(item);
        } else if (item.selector && item.cssText && item._id && window.AdnotaResizeRules) {
          window.AdnotaResizeRules.set(item._id, {
            selector: item.selector,
            cssText: item.cssText,
            kind: item.kind,
          });
          resizeMutated = true;
        }
      }
    }
    if (eraseMutated && window.rebuildEraseStyleTag) window.rebuildEraseStyleTag();
    if (resizeMutated && window.rebuildResizeStyleTag) window.rebuildResizeStyleTag();
  },

  // CSS.highlights doesn't expose per-range removal, so rebuild each theme
  // registry from current storage. Runs after storage is updated, so it
  // naturally reflects both hides and undoes.
  async _rebuildLiveHighlights() {
    if (typeof CSS === 'undefined' || !CSS.highlights) return;
    for (const reg of CSS.highlights.values()) {
      if (reg?.clear) reg.clear();
    }
    if (!window.AdnotaStorage || !window.AdnotaHighlighter || !window.FuzzyAnchor) return;

    const items = await window.AdnotaStorage.getAnchorsForUrl(location.href);
    for (const item of items) {
      if (item.action !== 'HIGHLIGHT' || item.isFallback) continue;
      const match = window.FuzzyAnchor.findMatch(item.anchor);
      if (match.confidence >= 40 && match.element) {
        window.AdnotaHighlighter.applyStoredHighlight(match.element, item);
      }
    }
  },

  // ─── Trash button for HUD toolbars ──────────────────────────────────────────
  // Two modes:
  // (1) Routed (mode + filter passed): the button renders a count badge and
  //     clicking opens scratch pad on that view so the user can review and
  //     delete individual items. Used by per-tool dock trashes (eraser,
  //     resizer, sticky). Auto-refreshes the badge on storage onChanged +
  //     SPA nav so the count is always current.
  // (2) Fallback (no mode/filter): legacy nuke-all path through
  //     softDeleteItems. Used by the highlighter palette's shared trash.
  //     The popup also reaches softDeleteItems via its own message channel.

  createTrashButton({ singular, plural, actionTypes, title, mode, filter }) {
    const isRouted = !!(mode && filter);
    const hoverText = title || (isRouted
      ? `Review & delete ${plural}`
      : `Delete all ${plural} from this page`);
    const btn = window.AdnotaUI.createToolbarIconButton(
      window.AdnotaUI.ICONS.trash,
      hoverText,
      isRouted
        ? () => window.AdnotaScratchPad?.openOn?.(mode, filter)
        : () => window.AdnotaUI.softDeleteItems({ singular, plural, actionTypes })
    );

    if (isRouted) {
      // Append count badge. Hidden at 0; updated by the refresher below.
      const badge = document.createElement('span');
      badge.className = 'adnota-count-badge';
      badge.hidden = true;
      btn.appendChild(badge);

      // Refresh hook — initial read + chrome.storage.onChanged subscription
      // for the current hostname + SPA nav events. The button's lifetime
      // matches the tool's body element (created once at module load,
      // mounted/unmounted as the user enters/exits the tool), so listeners
      // never need teardown.
      const refresh = async () => {
        try {
          const n = await window.AdnotaScratchPad?.pageActionCount?.(actionTypes) ?? 0;
          badge.textContent = String(n);
          badge.hidden = n === 0;
        } catch (_) {}
      };

      refresh();
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local') return;
          if (changes[location.hostname]) refresh();
        });
      } catch (_) { /* extension context invalidated */ }

      // SPA URL change (popstate + window.navigation when supported).
      // 50ms defer matches scratchPad.js's pattern so the new URL has
      // settled before we re-query storage.
      const onNav = () => setTimeout(refresh, 50);
      if (typeof window.navigation?.addEventListener === 'function') {
        try { window.navigation.addEventListener('navigate', onNav); }
        catch (_) {}
      }
      window.addEventListener('popstate', onNav);
    }

    return btn;
  },

  // ─── Branded confirmation dialog ────────────────────────────────────────────
  // Drop-in replacement for window.confirm() with Adnota styling. Returns a
  // Promise<boolean>. Used by HUD trash buttons and the popup so every
  // destructive action shares the same look and copy. Keyboard: Enter confirms,
  // Escape cancels, backdrop click cancels.

  confirmDialog(options = {}) {
    const {
      title = 'Confirm',
      message = 'Are you sure?',
      subtext = 'This cannot be undone.',
      confirmText = 'Delete',
      cancelText = 'Cancel',
    } = options;

    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'adnota-modal-backdrop';
      backdrop.setAttribute('data-adnota-ui', '1');
      backdrop.innerHTML = `
        <div class="adnota-modal" role="dialog" aria-modal="true">
          <div class="adnota-modal-header">
            <div class="adnota-modal-logo">A</div>
            <div class="adnota-modal-title"></div>
          </div>
          <div class="adnota-modal-message"></div>
          <div class="adnota-modal-subtext"></div>
          <div class="adnota-modal-actions">
            <button type="button" class="adnota-modal-btn adnota-modal-cancel"></button>
            <button type="button" class="adnota-modal-btn adnota-modal-danger"></button>
          </div>
        </div>
      `;

      // textContent assignments avoid HTML injection from dynamic labels.
      backdrop.querySelector('.adnota-modal-title').textContent = title;
      backdrop.querySelector('.adnota-modal-message').textContent = message;
      const subEl = backdrop.querySelector('.adnota-modal-subtext');
      if (subtext) subEl.textContent = subtext;
      else subEl.remove();
      const cancelBtn = backdrop.querySelector('.adnota-modal-cancel');
      const confirmBtn = backdrop.querySelector('.adnota-modal-danger');
      cancelBtn.textContent = cancelText;
      confirmBtn.textContent = confirmText;

      const cleanup = (result) => {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        resolve(result);
      };

      const onKey = (e) => {
        if (e.key === 'Escape')      { e.stopPropagation(); cleanup(false); }
        else if (e.key === 'Enter')  { e.stopPropagation(); cleanup(true); }
      };

      cancelBtn.addEventListener('click', () => cleanup(false));
      confirmBtn.addEventListener('click', () => cleanup(true));
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) cleanup(false);
      });
      document.addEventListener('keydown', onKey, true);

      (document.body || document.documentElement).appendChild(backdrop);
      confirmBtn.focus();
    });
  },

  // ─── Help button + popover for HUD toolbars ─────────────────────────────────
  // Single ? button that toggles a tail-anchored popover with a list of tips.
  // The popover is appended to <body> with position: fixed so it escapes any
  // parent stacking context, and tracks the button's position every frame
  // while open — so it follows the HUD if the user drags the dock.
  //
  //   tips:   array of HTML strings (each rendered as one row)
  //   accent: 'red' | 'blue' | 'purple' | 'orange' — tail/border tint

  createHelpButton({ tips, accent = 'purple' }) {
    const btn = document.createElement('div');
    btn.className = 'adnota-undo-btn adnota-help-btn';
    btn.setAttribute('data-adnota-ui', '1');
    btn.setAttribute('data-adnota-tooltip', 'Tips');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.innerHTML = window.AdnotaUI.ICONS.help;
    btn.appendChild(svg);

    let popover = null;
    let rafId = null;
    let outsideHandler = null;

    const reposition = () => {
      if (!popover) return;
      const r = btn.getBoundingClientRect();
      const popW = popover.offsetWidth;
      const popH = popover.offsetHeight;
      const margin = 8; // gap above the button (room for the tail)
      const vpW = window.innerWidth;

      // Center on button, clamp to viewport horizontally.
      const btnCenter = r.left + r.width / 2;
      let left = btnCenter - popW / 2;
      left = Math.max(8, Math.min(vpW - popW - 8, left));
      const top = r.top - popH - margin;

      popover.style.left = left + 'px';
      popover.style.top = Math.max(8, top) + 'px';

      // Tail offset: keep it pointing at the button center even after clamp.
      const tailX = btnCenter - left;
      popover.style.setProperty('--adnota-help-tail-x', tailX + 'px');
    };

    const close = () => {
      if (!popover) return;
      popover.remove();
      popover = null;
      btn.classList.remove('adnota-help-btn-active');
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      if (outsideHandler) {
        document.removeEventListener('pointerdown', outsideHandler, true);
        outsideHandler = null;
      }
    };

    const open = () => {
      popover = document.createElement('div');
      popover.className = `adnota-help-popover adnota-help-popover-${accent}`;
      popover.setAttribute('data-adnota-ui', '1');
      popover.innerHTML =
        tips.map(t => `<div class="adnota-help-tip">${t}</div>`).join('') +
        '<div class="adnota-help-tail"></div>';
      (document.body || document.documentElement).appendChild(popover);
      btn.classList.add('adnota-help-btn-active');

      reposition();
      const tick = () => {
        if (!popover) return;
        reposition();
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);

      // Click-outside to close (capture phase so it beats other handlers).
      outsideHandler = (e) => {
        if (popover && popover.contains(e.target)) return;
        if (btn.contains(e.target)) return;
        close();
      };
      document.addEventListener('pointerdown', outsideHandler, true);
    };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (popover) close();
      else open();
    });

    btn.close = close;
    return btn;
  },

  // ─── Undo button for HUD toolbars ───────────────────────────────────────────
  // Thin wrapper over createToolbarIconButton that fires AdnotaUndo.undo().

  createUndoButton() {
    return window.AdnotaUI.createToolbarIconButton(
      window.AdnotaUI.ICONS.undo,
      'Undo',
      () => window.AdnotaUndo.undo()
    );
  },

  // ─── Layout-aware text extraction from a Range ────────────────────────────
  // range.toString() is fast and preserves \n at block-element boundaries —
  // good for normal prose. But syntax highlighters (Prism, Highlight.js, the
  // bespoke one ChatGPT uses) emit each line of a code block as inline <span>
  // tokens with no \n in the DOM; the visible line break is pure layout.
  // range.toString() then collapses a 7-line code block to one wrapping line
  // — fine on the source page (the highlight still paints per-line) but
  // disastrous in the scratch pad, which renders the captured text.
  //
  // For ranges inside <pre>, fall back to innerText, which respects rendered
  // layout and inserts \n where the browser draws line breaks. The clone is
  // appended off-screen because innerText requires the element to be in the
  // document and laid out — without that step it returns the same as
  // textContent.
  rangeText(range) {
    if (!range) return '';
    const fallback = range.toString();
    const ancestor = range.commonAncestorContainer;
    const el = ancestor?.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor?.parentElement;
    if (!el) return fallback;
    // innerText is preferable to range.toString() in two distinct cases that
    // cover almost every highlight:
    //   1) <pre>/code blocks where lines are separated by <br> or per-line
    //      wrapper spans with `display: block` — range.toString() collapses
    //      them to one wrapping line, innerText respects layout.
    //   2) Prose with multiple block elements (heading + list, multi-paragraph
    //      selection). range.toString() inserts MULTIPLE \n at each block
    //      boundary, rendering as "line + 2 blank lines" between bullets.
    //      innerText inserts exactly one \n per visible line break.
    // For <pre>, mount inside the original so the syntax-highlighter classes
    // keep their layout-driving display rules. For everything else,
    // document.body is fine — block elements still have user-agent default
    // block display, and the prose CSS contexts we care about (h*, p, li,
    // div) work without the original parent's stylesheet.
    const pre = el.closest('pre');
    const host = pre ? (pre.querySelector('code') || pre) : document.body;
    const clone = document.createElement('div');
    clone.setAttribute('data-adnota-ui', '1');
    clone.style.cssText = 'position:absolute;left:-99999px;top:0;pointer-events:none;';
    clone.appendChild(range.cloneContents());
    // innerText drops ::marker pseudo-element content (the • / 1. 2. 3.
    // bullets you see in the rendered list). Inject them as real text nodes
    // before reading. Counter is per-<ol> via WeakMap so siblings don't
    // collide and nested lists each restart at 1. start=N / value=N attrs
    // are intentionally not honored — partial-range selections wouldn't
    // give them meaningful values anyway.
    //
    // Drill into the deepest first-element descendant before inserting:
    // ChatGPT and most rich-text renderers wrap each <li>'s text in a <p>
    // (block display). If we prepend the bullet as a sibling of that <p>,
    // innerText puts the bullet on its own line because <p> opens a new
    // block. Drilling past <p>/<div>/<span> until we hit a text node lands
    // the bullet adjacent to the text. Stop at nested <ul>/<ol> since
    // those have their own items to mark.
    // Skip whitespace-only text nodes when walking — ChatGPT's markdown
    // formats <li>\n  <p>...</p>\n</li> which puts a whitespace text node
    // as li.firstChild. Without this skip the drill loop exits at that
    // text node, the marker gets inserted before <p>, and innerText puts
    // the bullet on its own line because <p> opens a new block.
    const firstMeaningfulChild = (parent) => {
      let n = parent.firstChild;
      while (n) {
        if (n.nodeType === Node.ELEMENT_NODE) return n;
        if (n.nodeType === Node.TEXT_NODE && n.nodeValue.trim()) return n;
        n = n.nextSibling;
      }
      return null;
    };
    const orderedCounters = new WeakMap();
    for (const li of clone.querySelectorAll('li')) {
      const list = li.parentElement;
      let marker = '• ';
      if (list && list.tagName === 'OL') {
        const next = (orderedCounters.get(list) || 0) + 1;
        orderedCounters.set(list, next);
        marker = `${next}. `;
      }
      let target = li;
      while (true) {
        const first = firstMeaningfulChild(target);
        if (!first || first.nodeType !== Node.ELEMENT_NODE) break;
        const tag = first.tagName;
        if (tag === 'UL' || tag === 'OL') break;
        target = first;
      }
      // Insert at the very front of `target`. White-space:normal will
      // collapse any leading whitespace, so the bullet renders adjacent
      // to the text either way.
      target.insertBefore(document.createTextNode(marker), target.firstChild);
    }
    host.appendChild(clone);
    let text;
    try { text = clone.innerText; }
    finally { clone.remove(); }
    // Collapse blank lines that immediately precede a list-marker line.
    // <p>-wrapped <li> content (ChatGPT's structure) emits \n\n at block
    // boundaries because the inner <p> carries margin, which makes lists
    // render with a blank line between every item. Tightening only when
    // the next line begins with one of our injected markers preserves
    // genuine paragraph breaks in prose-only highlights.
    let final = text || fallback;
    if (text) {
      final = final.replace(/\n+(\s*(?:•|\d+\.)\s)/g, '\n$1').trim();
    }
    // Diagnostic — surfaces both extraction paths so we can tell whether the
    // capture-time helper is doing its job. Filter DevTools by
    // `Adnota:cs:text:range-extract` to see one line per highlight.
    window.AdnotaLog?.event('text', 'range-extract', {
      hostTag: host.tagName?.toLowerCase(),
      fromToString: fallback,
      fromInnerText: text,
      chosen: final === text ? 'innerText' : 'toString',
    });
    return final;
  },

};
