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
};
