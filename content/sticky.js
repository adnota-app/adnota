// content/sticky.js

let areNotesVisible = true;
let highestZIndex = 2147483640;
const DEBOUNCE_MS = 1500;
const activeNotes = new Map(); // uuid -> note data

// ---------------------------------------------------------------------------
// Keyboard / message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'toggle-sticky') {
    window.VellumState.set({ mode: window.VellumState.mode === 'sticky' ? null : 'sticky' });
  }
  if (request.action === 'toggle-view') {
    areNotesVisible = !areNotesVisible;
    document.querySelectorAll('.vellum-sticky-container').forEach(el => {
      el.classList.toggle('hidden', !areNotesVisible);
    });
    chrome.storage.local.set({ vellumHidden: !areNotesVisible });
  }
  if (request.action === 'get-view') {
    sendResponse({ hidden: !areNotesVisible });
    return true;
  }
});

// React to VellumState changes — no cursor overlay needed anymore (free-placement).
window.VellumState.subscribe(state => {
  document.body.classList.toggle('vellum-sticky-active', state.mode === 'sticky');
});

// ---------------------------------------------------------------------------
// Click to drop a note — pure coordinate capture, zero DOM anchoring
// ---------------------------------------------------------------------------

document.addEventListener('click', async (e) => {
  if (window.VellumState.mode !== 'sticky') return;
  if (e.target.closest('.vellum-sticky-container') || e.target.closest('.vellum-toast')) return;

  e.preventDefault();
  e.stopPropagation();

  // Capture percentage-based position relative to the full scrollable document.
  const placement = clientToPlacement(e.clientX, e.clientY);

  window.VellumState.set({ mode: null });

  const uuid     = Date.now() + Math.random().toString();
  const comments = [{ text: '', author: 'Me', createdAt: Date.now() }];

  window.StickyEngine.renderNote(placement, comments, uuid, true);

  if (window.VellumStorage) {
    await window.VellumStorage.saveNote(
      location.hostname, location.pathname,
      null,      // anchor is intentionally null — position is self-contained
      placement, comments, uuid
    );
  }
}, true);

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

/**
 * Convert a clientX/Y click into a percentage-based placement object.
 *
 * xPct       — left edge of the note card as % of total page scroll width
 * yScrollPct — top edge of the note card as % of total page scroll height
 *
 * Using scrollHeight for Y gives scroll-relative persistence: if content above
 * the note shifts, the note drifts slightly, but it is *never lost*.
 */
function clientToPlacement(clientX, clientY) {
  const scrollTop  = window.pageYOffset || document.documentElement.scrollTop;
  const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

  const absX = clientX + scrollLeft;
  const absY = clientY + scrollTop;

  const totalWidth  = Math.max(document.documentElement.scrollWidth,  1);
  const totalHeight = Math.max(document.documentElement.scrollHeight, 1);

  // Clamp so the note card stays fully on-page.
  const NOTE_W = 240;
  const NOTE_H = 120;
  const clampedX = Math.min(absX, totalWidth  - NOTE_W);
  const clampedY = Math.min(absY, totalHeight - NOTE_H);

  return {
    position:   'percent',
    xPct:       clampedX / totalWidth,
    yScrollPct: clampedY / totalHeight,
  };
}

/**
 * Convert a stored percentage placement back into absolute pixel coordinates,
 * resolved against the current page dimensions at call time.
 */
function placementToPixels(placement) {
  const totalWidth  = Math.max(document.documentElement.scrollWidth,  1);
  const totalHeight = Math.max(document.documentElement.scrollHeight, 1);
  return {
    left: placement.xPct       * totalWidth,
    top:  placement.yScrollPct * totalHeight,
  };
}

// ---------------------------------------------------------------------------
// StickyEngine — render, position, drag, save
// ---------------------------------------------------------------------------

window.StickyEngine = {
  /**
   * Render a sticky note from a placement object.
   *
   * @param {object}  placement  { position:'percent', xPct, yScrollPct }
   *                             Legacy { position:'manual', top, left } also accepted.
   * @param {array}   comments   [{ text, author, createdAt }]
   * @param {string}  uuid
   * @param {boolean} isNew      Focus textarea when true.
   */
  renderNote(placement, comments, uuid, isNew = false) {
    // Guard duplicate renders.
    if (document.querySelector(`.vellum-sticky-container[data-uuid="${uuid}"]`)) return;

    const container = document.createElement('div');
    container.className = 'vellum-sticky-container vellum-theme-yellow' + (areNotesVisible ? '' : ' hidden');
    container.dataset.uuid = uuid;
    container.style.position = 'absolute';

    const initialText = comments && comments.length > 0 ? comments[0].text : '';
    const createdAt   = comments && comments[0]?.createdAt ? new Date(comments[0].createdAt) : new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts  = `${createdAt.getFullYear()}-${pad(createdAt.getMonth() + 1)}-${pad(createdAt.getDate())} ${pad(createdAt.getHours())}:${pad(createdAt.getMinutes())}`;

    container.innerHTML = `
      <div class="vellum-sticky-card">
        <div class="vellum-sticky-header">
          <span class="vellum-timestamp">${ts}</span>
          <button class="vellum-trash-btn" title="Delete note" aria-label="Delete note">
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="1" y1="1" x2="8" y2="8"/><line x1="8" y1="1" x2="1" y2="8"/>
            </svg>
          </button>
        </div>
        <textarea class="vellum-sticky-textarea" placeholder="Take a note...">${initialText}</textarea>
      </div>
    `;

    document.body.appendChild(container);

    // In-memory record holds a *mutable* copy of placement so drag updates
    // propagate to updatePosition without re-rendering.
    const noteState = { container, placement: { ...placement } };
    activeNotes.set(uuid, noteState);

    this.updatePosition(uuid);

    // ── Bring to front on focus ──────────────────────────────────────────────
    container.addEventListener('mousedown', () => {
      highestZIndex++;
      container.style.zIndex = highestZIndex;
    });

    // ── Drag on header ───────────────────────────────────────────────────────
    const header    = container.querySelector('.vellum-sticky-header');
    let isDragging  = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.vellum-trash-btn')) return;
      isDragging = true;
      header.setPointerCapture(e.pointerId);

      const scrollTop  = window.pageYOffset || document.documentElement.scrollTop;
      const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
      dragOffsetX = e.clientX + scrollLeft - parseFloat(container.style.left || 0);
      dragOffsetY = e.clientY + scrollTop  - parseFloat(container.style.top  || 0);

      container.style.transition = 'none';
      e.preventDefault();
    });

    header.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const scrollTop  = window.pageYOffset || document.documentElement.scrollTop;
      const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
      container.style.left = `${e.clientX + scrollLeft - dragOffsetX}px`;
      container.style.top  = `${e.clientY + scrollTop  - dragOffsetY}px`;
    });

    header.addEventListener('pointerup', async (e) => {
      if (!isDragging) return;
      isDragging = false;
      header.releasePointerCapture(e.pointerId);
      container.style.transition = '';

      // Convert new pixel position back to percentages for durable storage.
      const newLeft = parseFloat(container.style.left);
      const newTop  = parseFloat(container.style.top);

      const totalWidth  = Math.max(document.documentElement.scrollWidth,  1);
      const totalHeight = Math.max(document.documentElement.scrollHeight, 1);

      const updatedPlacement = {
        position:   'percent',
        xPct:       newLeft / totalWidth,
        yScrollPct: newTop  / totalHeight,
      };

      noteState.placement = updatedPlacement;

      if (window.VellumStorage) {
        await window.VellumStorage.saveNote(
          location.hostname, location.pathname,
          null, updatedPlacement, comments, uuid
        );
      }
    });

    // ── Textarea autosave ────────────────────────────────────────────────────
    const textarea = container.querySelector('textarea');
    if (isNew) textarea.focus();

    let saveTimeout;
    textarea.addEventListener('input', () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(async () => {
        if (!window.VellumStorage) return;
        comments[0].text = textarea.value;
        await window.VellumStorage.saveNote(
          location.hostname, location.pathname,
          null, noteState.placement, comments, uuid
        );
      }, DEBOUNCE_MS);
    });

    // ── Delete with undo ─────────────────────────────────────────────────────
    const trashBtn = container.querySelector('.vellum-trash-btn');
    trashBtn.addEventListener('click', () => {
      container.style.display = 'none';

      const toast = document.createElement('div');
      toast.className = 'vellum-toast';
      toast.innerHTML = `
        <div class="vellum-toast-logo">V</div>
        <span class="vellum-toast-message">Note deleted</span>
        <div class="vellum-toast-actions">
          <span class="vellum-toast-undo">Undo</span>
        </div>
      `;
      document.body.appendChild(toast);

      let committed = false;
      const deleteTimeout = setTimeout(async () => {
        committed = true;
        window.VellumUndo.remove(undoEntry);
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
        activeNotes.delete(uuid);
        container.remove();
        if (window.VellumStorage) {
          await window.VellumStorage.deleteItem(location.hostname, 'uuid', uuid);
        }
      }, 5000);

      function performUndo() {
        if (committed) return;
        clearTimeout(deleteTimeout);
        container.style.display = 'block';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
        window.VellumUndo.remove(undoEntry);
      }

      const undoEntry = { undo: performUndo };
      window.VellumUndo.push(undoEntry);
      toast.querySelector('.vellum-toast-undo').addEventListener('click', performUndo);
    });
  },

  /**
   * Reposition a note based on its current placement object.
   * Called after initial render and on window resize.
   */
  updatePosition(uuid) {
    const noteState = activeNotes.get(uuid);
    if (!noteState) return;

    const { container, placement } = noteState;
    let left, top;

    if (placement.position === 'percent') {
      ({ left, top } = placementToPixels(placement));
    } else if (placement.position === 'manual') {
      // Legacy format from before this refactor — treat stored px directly.
      left = placement.left;
      top  = placement.top;
    } else {
      return; // Unknown format — do nothing rather than misplace the note.
    }

    container.style.left = `${left}px`;
    container.style.top  = `${top}px`;
  },
};

// ---------------------------------------------------------------------------
// Resize: recompute all note positions (page dimensions may have changed)
// ---------------------------------------------------------------------------

window.addEventListener('resize', () => {
  for (const uuid of activeNotes.keys()) {
    window.StickyEngine.updatePosition(uuid);
  }
});
