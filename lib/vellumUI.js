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
    trash: '<polyline points="3 6 5 6 17 6"/><path d="M15 6l-1 10a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M8 9v6"/><path d="M12 9v6"/><path d="M8 6V4h4v2"/>',
  },

  // ─── Toolbar icon button factory ────────────────────────────────────────────
  // Produces a button that matches the .vellum-undo-btn styling used across
  // all HUD toolbars. Use for trash/undo/any single-icon control.

  createToolbarIconButton(iconPath, title, onClick) {
    const btn = document.createElement('div');
    btn.className = 'vellum-undo-btn';
    btn.title = title;
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

  // ─── Page-wide annotation clear ─────────────────────────────────────────────
  // Filters out every item on the current page whose action matches one of the
  // given types. Returns the number of items removed. Legacy entries without
  // an `action` field are treated as ERASE (matches popup's per-stat clear).

  async clearPageAnnotations(actionTypes) {
    const domain = location.hostname;
    const path = location.pathname;
    const actionSet = new Set(actionTypes);

    const data = await chrome.storage.local.get(domain);
    const domainData = data[domain];
    if (!domainData?.items) return 0;

    const before = domainData.items.length;
    domainData.items = domainData.items.filter(item => {
      const onThisPage = item.path === path || item.path === '*';
      const itemAction = item.action || 'ERASE';
      return !(onThisPage && actionSet.has(itemAction));
    });
    const removed = before - domainData.items.length;

    if (removed > 0) {
      await chrome.storage.local.set({ [domain]: domainData });
    }
    return removed;
  },

  // ─── Trash button for HUD toolbars ──────────────────────────────────────────
  // Shared helper used by eraser/sticky/drawing HUDs. On click, confirms, then
  // clears the relevant items for the current page and reloads so DOM state
  // reflects storage. `label` is shown in both the hover tooltip and the
  // confirmation dialog message so they match.

  createTrashButton({ label, actionTypes, title }) {
    const hoverText = title || `Delete ${label}`;
    return window.VellumUI.createToolbarIconButton(
      window.VellumUI.ICONS.trash,
      hoverText,
      async () => {
        const ok = await window.VellumUI.confirmDialog({
          message: `${hoverText}?`,
        });
        if (!ok) return;
        await window.VellumUI.clearPageAnnotations(actionTypes);
        location.reload();
      }
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
