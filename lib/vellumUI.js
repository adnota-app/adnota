// lib/vellumUI.js — Shared Vellum UI utilities
//
// Loaded before all content scripts. Provides common helpers so that
// eraser, resizer, highlighter, sticky, and marker don't duplicate
// the same DOM patterns.

window.VellumUI = {

  // ─── Element identification ─────────────────────────────────────────────────
  // Every Vellum UI element is tagged with data-vellum-ui="1".
  // A single .closest() check is all that's needed — no selector list to maintain.

  isVellumElement(el) {
    return !!el?.closest('[data-vellum-ui]');
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

  // Walk up through parents that have the same bounding box as `el` (within
  // small tolerances) so a click on an inner element hits the outer visually-
  // identical wrapper users almost always actually want. Stops at Vellum UI,
  // viewport-dominating containers, or as soon as a parent meaningfully drifts
  // from the starting element's rect.
  //
  // All edge / size comparisons are against the STARTING rect, not the running
  // one. Comparing to the running rect accumulates across a chain — a 220→228
  // step is exactly at the old 4px edge tolerance and one sub-pixel rounding
  // (4.1px) aborts the climb, so a nav → div → div → ul stack where every hop
  // is just-barely-tolerable gets stuck on the innermost. Anchoring to the
  // start instead caps total drift once, and the whole chain either passes or
  // fails against that same budget. edgeTolerancePx bumped 4 → 6 for rendering
  // rounding headroom.
  bubbleToVisualRoot(el, {
    maxHops = 8,
    edgeTolerancePx = 6,
    sizeToleranceRatio = 0.06,
  } = {}) {
    let current = el;
    const startRect = current.getBoundingClientRect();
    const startW = startRect.width, startH = startRect.height;
    const isVellum = window.VellumUI.isVellumElement;
    for (let i = 0; i < maxHops; i++) {
      const parent = current.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (isVellum(parent)) break;
      const pRect = parent.getBoundingClientRect();
      if (window.VellumUI.dominatesViewport(pRect)) break;
      if (Math.abs(pRect.top - startRect.top) > edgeTolerancePx) break;
      if (Math.abs(pRect.left - startRect.left) > edgeTolerancePx) break;
      if (Math.abs(pRect.right - startRect.right) > edgeTolerancePx) break;
      if (Math.abs(pRect.bottom - startRect.bottom) > edgeTolerancePx) break;
      const wDiff = startW > 0 ? Math.abs(pRect.width - startW) / startW : 0;
      const hDiff = startH > 0 ? Math.abs(pRect.height - startH) / startH : 0;
      if (wDiff > sizeToleranceRatio || hDiff > sizeToleranceRatio) break;
      current = parent;
    }
    return current;
  },

  // ─── Hover overlay factory ──────────────────────────────────────────────────
  // Both eraser (red) and resizer (blue) use the same absolutely-positioned
  // overlay to highlight the element under the cursor.

  createHoverOverlay(id, borderColor, bgColor) {
    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.setAttribute('data-vellum-ui', '1');
    Object.assign(overlay.style, {
      position: 'absolute',
      pointerEvents: 'none',
      border: `2px solid ${borderColor}`,
      backgroundColor: bgColor,
      zIndex: '999999',
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
  //   VellumUI.makeDraggable(eraserHud)              — whole element is handle
  //   VellumUI.makeDraggable(toolbar, dragHandle)    — only handle starts drag

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
  //   VellumUI.showToast('Element erased', { id: 'vellum-eraser-toast', onUndo: fn })
  //   VellumUI.dismissToast(toast)

  showToast(message, options = {}) {
    const { id, onUndo, timeout = 5000 } = options;

    if (id) {
      const existing = document.getElementById(id);
      if (existing) existing.remove();
    }

    const toast = document.createElement('div');
    if (id) toast.id = id;
    toast.className = 'vellum-toast';
    toast.setAttribute('data-vellum-ui', '1');

    let actionsHtml = '';
    if (onUndo) {
      actionsHtml = '<div class="vellum-toast-actions"><span class="vellum-toast-undo">Undo</span></div>';
    }

    toast.innerHTML = `
      <div class="vellum-toast-logo">V</div>
      <span class="vellum-toast-message">${message}</span>
      ${actionsHtml}
    `;
    (document.body || document.documentElement).appendChild(toast);

    if (onUndo) {
      toast.querySelector('.vellum-toast-undo').addEventListener('click', () => {
        onUndo();
        window.VellumUI.dismissToast(toast);
      });
    }

    if (timeout > 0) {
      setTimeout(() => window.VellumUI.dismissToast(toast), timeout);
    }

    return toast;
  },

  dismissToast(toast) {
    if (!toast || !toast.parentNode) return;
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  },

  // ─── Shared toolbar icons ──────────────────────────────────────────────────
  // Any HUD toolbar can pull from here to stay visually consistent.

  ICONS: {
    undo:  '<path d="M4 8h10a3 3 0 010 6H10"/><path d="M7 5L4 8l3 3"/>',
    trash: '<polyline points="3 6 17 6"/><path d="M15 6v10a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 9v6"/><path d="M12 9v6"/><path d="M8 6V4h4v2"/>',
  },

  // ─── Toolbar icon button factory ────────────────────────────────────────────
  // Produces a button that matches the .vellum-undo-btn styling used across
  // all HUD toolbars. Use for trash/undo/any single-icon control.

  createToolbarIconButton(iconPath, title, onClick) {
    const btn = document.createElement('div');
    btn.className = 'vellum-undo-btn';
    btn.setAttribute('data-tooltip', title);
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

  // ─── Soft-delete with undo ──────────────────────────────────────────────────
  // Snapshot matching items, pull them from storage immediately, hide from the
  // DOM, and show a 5s toast with Undo. If the user undoes (button or Ctrl+Z),
  // items are written back and re-rendered. Otherwise they stay deleted.
  // This mirrors the per-item sticky/eraser delete flow for bulk operations.

  async softDeleteItems({ singular, plural, actionTypes, skipConfirm }) {
    const domain = location.hostname;
    const path = location.pathname;
    const actionSet = new Set(actionTypes);

    const data = await chrome.storage.local.get(domain);
    const all = data[domain]?.items || [];
    const snapshot = all.filter(item => {
      const onThisPage = item.path === path || item.path === '*';
      const itemAction = item.action || 'ERASE';
      return onThisPage && actionSet.has(itemAction);
    });

    if (snapshot.length === 0) {
      window.VellumUI.showToast(`No ${plural} on this page to delete`);
      return;
    }

    const n = snapshot.length;
    const noun = window.VellumUI.pluralize(n, singular, plural);
    
    if (!skipConfirm) {
      const ok = await window.VellumUI.confirmDialog({
        message: `Delete ${n} ${noun} from this page?`,
        subtext: 'You\u2019ll have 5 seconds to undo.',
      });
      if (!ok) return;
    }

    // Pull matching items out of storage by identity so items created during
    // the undo window (different IDs) stay untouched.
    const snapshotIds = new Set(snapshot.map(i => window.VellumUI._itemId(i)));
    const fresh = await chrome.storage.local.get(domain);
    const freshData = fresh[domain];
    if (freshData?.items) {
      freshData.items = freshData.items.filter(
        i => !snapshotIds.has(window.VellumUI._itemId(i))
      );
      await chrome.storage.local.set({ [domain]: freshData });
    }

    // Hide from DOM. For non-fallback highlights we can't delete individual
    // ranges from CSS.highlights, so flag a bulk rebuild once at the end.
    const needsHighlightRebuild = window.VellumUI._hideItems(snapshot);
    if (needsHighlightRebuild) await window.VellumUI._rebuildLiveHighlights();

    let committed = false;
    let commitTimeout;
    let undoEntry;

    const performUndo = async () => {
      if (committed) return;
      committed = true;
      clearTimeout(commitTimeout);
      window.VellumUI.dismissToast(toast);

      const again = await chrome.storage.local.get(domain);
      const againData = again[domain] || { items: [] };
      againData.items = (againData.items || []).concat(snapshot);
      await chrome.storage.local.set({ [domain]: againData });

      await window.VellumUI._restoreItems(snapshot);
      if (needsHighlightRebuild) await window.VellumUI._rebuildLiveHighlights();

      window.VellumUndo.remove(undoEntry);
    };

    const performCommit = () => {
      if (committed) return;
      committed = true;
      window.VellumUndo.remove(undoEntry);
    };

    const toast = window.VellumUI.showToast(
      n === 1 ? `${noun} deleted` : `${n} ${noun} deleted`,
      { onUndo: performUndo, timeout: 0 }
    );
    commitTimeout = setTimeout(performCommit, 5000);
    undoEntry = { undo: performUndo };
    window.VellumUndo.push(undoEntry);
  },

  // Hide each item from the live DOM. Returns true if any non-fallback
  // HIGHLIGHT was hidden, meaning the caller must rebuild CSS.highlights.
  _hideItems(items) {
    let needsHighlightRebuild = false;
    let eraseMutated = false;
    const styleTag = document.getElementById('vellum-style-overrides');
    let resizeText = styleTag ? styleTag.textContent : null;

    for (const item of items) {
      const action = item.action || 'ERASE';

      if (action === 'NOTE' && item.uuid) {
        const el = document.querySelector(
          `.vellum-sticky-container[data-uuid="${item.uuid}"]`
        );
        if (el) el.remove();
      } else if (action === 'MARKER' && item.uuid) {
        const el = document.querySelector(
          `.vellum-marker-wrapper[data-uuid="${item.uuid}"]`
        );
        if (el) el.remove();
      } else if (action === 'HIGHLIGHT') {
        if (item.isFallback && item._id) {
          const el = document.querySelector(
            `.vellum-highlight-fallback[data-highlight-id="${item._id}"]`
          );
          if (el) el.remove();
        } else {
          needsHighlightRebuild = true;
        }
      } else if (action === 'ERASE') {
        if (item._id && window.VellumEraseRules?.has(item._id)) {
          window.VellumEraseRules.delete(item._id);
          eraseMutated = true;
        }
        if (item.anchor && window.FuzzyAnchor) {
          const match = window.FuzzyAnchor.findMatch(item.anchor);
          if (match.confidence >= 40 && match.element) {
            match.element.style.removeProperty('display');
            window.VellumErasedElements?.delete(match.element);
          }
        }
      } else if (action === 'RESIZE') {
        if (resizeText != null && item.selector && item.cssText) {
          resizeText = resizeText.replace(
            `${item.selector} { ${item.cssText} }\n`,
            ''
          );
        }
      }
    }

    if (eraseMutated && window.rebuildEraseStyleTag) window.rebuildEraseStyleTag();
    if (styleTag && resizeText !== styleTag.textContent) styleTag.textContent = resizeText;

    return needsHighlightRebuild;
  },

  // Re-render a batch of items after an undo. Uses the same render paths the
  // restorer uses on page load — no DOM reload required.
  async _restoreItems(items) {
    let eraseMutated = false;
    for (const item of items) {
      const action = item.action || 'ERASE';

      if (action === 'NOTE' && window.StickyEngine) {
        window.StickyEngine.renderNote(
          item.placement, item.comments, item.uuid, false,
          item.dimensions || null,
          item.theme || 'vellum-theme-yellow',
          item.anchor || null,
          item.anchorOffset || null
        );
      } else if (action === 'MARKER' && window.FuzzyAnchor && window.VellumMarker) {
        const match = window.FuzzyAnchor.findMatch(item.anchor);
        if (match.confidence >= 40 && match.element) {
          window.VellumMarker.renderMarker(match.element, item);
        }
      } else if (action === 'HIGHLIGHT') {
        if (item.isFallback && window.FuzzyAnchor && window.VellumHighlighter) {
          const match = window.FuzzyAnchor.findMatch(item.anchor);
          if (match.confidence >= 40 && match.element) {
            window.VellumHighlighter.renderFallback(match.element, item);
          }
        }
        // Non-fallback highlights are re-applied by _rebuildLiveHighlights()
        // which the caller runs after restoring storage.
      } else if (action === 'ERASE') {
        if (item._id && item.selector && window.VellumEraseRules) {
          window.VellumEraseRules.set(item._id, item.selector);
          eraseMutated = true;
        }
        if (item.anchor && window.FuzzyAnchor) {
          const match = window.FuzzyAnchor.findMatch(item.anchor);
          if (match.confidence >= 40 && match.element) {
            match.element.style.setProperty('display', 'none', 'important');
            window.VellumErasedElements?.add(match.element);
          }
        }
      } else if (action === 'RESIZE' && item.selector && item.cssText) {
        let tag = document.getElementById('vellum-style-overrides');
        if (!tag) {
          tag = document.createElement('style');
          tag.id = 'vellum-style-overrides';
          tag.setAttribute('data-vellum-ui', '1');
          document.head.appendChild(tag);
        }
        tag.textContent += `${item.selector} { ${item.cssText} }\n`;
      }
    }
    if (eraseMutated && window.rebuildEraseStyleTag) window.rebuildEraseStyleTag();
  },

  // CSS.highlights doesn't expose per-range removal, so rebuild each theme
  // registry from current storage. Runs after storage is updated, so it
  // naturally reflects both hides and undoes.
  async _rebuildLiveHighlights() {
    if (typeof CSS === 'undefined' || !CSS.highlights) return;
    for (const reg of CSS.highlights.values()) {
      if (reg?.clear) reg.clear();
    }
    if (!window.VellumStorage || !window.VellumHighlighter || !window.FuzzyAnchor) return;

    const items = await window.VellumStorage.getAnchorsForUrl(location.href);
    for (const item of items) {
      if (item.action !== 'HIGHLIGHT' || item.isFallback) continue;
      const match = window.FuzzyAnchor.findMatch(item.anchor);
      if (match.confidence >= 40 && match.element) {
        window.VellumHighlighter.applyStoredHighlight(match.element, item);
      }
    }
  },

  // ─── Trash button for HUD toolbars ──────────────────────────────────────────
  // Shared helper used by eraser/sticky/drawing HUDs. Clicking confirms, then
  // routes through softDeleteItems so the HUD trash and popup trash share one
  // undo-backed code path.

  createTrashButton({ singular, plural, actionTypes, title }) {
    const hoverText = title || `Delete all ${plural} from this page`;
    return window.VellumUI.createToolbarIconButton(
      window.VellumUI.ICONS.trash,
      hoverText,
      () => window.VellumUI.softDeleteItems({ singular, plural, actionTypes })
    );
  },

  // ─── Branded confirmation dialog ────────────────────────────────────────────
  // Drop-in replacement for window.confirm() with Vellum styling. Returns a
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
      backdrop.className = 'vellum-modal-backdrop';
      backdrop.setAttribute('data-vellum-ui', '1');
      backdrop.innerHTML = `
        <div class="vellum-modal" role="dialog" aria-modal="true">
          <div class="vellum-modal-header">
            <div class="vellum-modal-logo">V</div>
            <div class="vellum-modal-title"></div>
          </div>
          <div class="vellum-modal-message"></div>
          <div class="vellum-modal-subtext"></div>
          <div class="vellum-modal-actions">
            <button type="button" class="vellum-modal-btn vellum-modal-cancel"></button>
            <button type="button" class="vellum-modal-btn vellum-modal-danger"></button>
          </div>
        </div>
      `;

      // textContent assignments avoid HTML injection from dynamic labels.
      backdrop.querySelector('.vellum-modal-title').textContent = title;
      backdrop.querySelector('.vellum-modal-message').textContent = message;
      const subEl = backdrop.querySelector('.vellum-modal-subtext');
      if (subtext) subEl.textContent = subtext;
      else subEl.remove();
      const cancelBtn = backdrop.querySelector('.vellum-modal-cancel');
      const confirmBtn = backdrop.querySelector('.vellum-modal-danger');
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

  // ─── Undo button for HUD toolbars ───────────────────────────────────────────
  // Thin wrapper over createToolbarIconButton that fires VellumUndo.undo().

  createUndoButton() {
    return window.VellumUI.createToolbarIconButton(
      window.VellumUI.ICONS.undo,
      'Undo',
      () => window.VellumUndo.undo()
    );
  },
};
