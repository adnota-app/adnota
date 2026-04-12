// content/sticky.js

let areNotesVisible = true;
let highestZIndex = 2147483640;
const DEBOUNCE_MS = 1500;
const activeNotes = new Map(); // uuid -> note data

const stickyHighlight = document.createElement('div');
Object.assign(stickyHighlight.style, {
  position: 'absolute', pointerEvents: 'none',
  border: '2px dashed #fbc02d', backgroundColor: 'rgba(255, 235, 59, 0.1)',
  zIndex: '999999', transition: 'all 0.1s ease', display: 'none'
});
document.documentElement.appendChild(stickyHighlight);

let hoveredStickyTarget = null;

// Route the keyboard shortcut through VellumState — toggles sticky off if already active,
// which automatically deactivates any other tool that was running.
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-sticky') {
    window.VellumState.set({ mode: window.VellumState.mode === 'sticky' ? null : 'sticky' });
  }
  if (request.action === 'toggle-view') {
    areNotesVisible = !areNotesVisible;
    document.querySelectorAll('.vellum-sticky-container').forEach(el => {
      el.classList.toggle('hidden', !areNotesVisible);
    });
  }
});

// React to VellumState changes — clean up hover highlight whenever sticky mode is not active.
window.VellumState.subscribe(state => {
  if (state.mode !== 'sticky') {
    stickyHighlight.style.display = 'none';
    hoveredStickyTarget = null;
  }
});

document.addEventListener('mousemove', (e) => {
  if (window.VellumState.mode !== 'sticky') return;
  const target = document.elementFromPoint(e.clientX, e.clientY);

  if (target && !target.closest('.vellum-sticky-container') && !target.closest('.vellum-toast') && target !== stickyHighlight) {
    hoveredStickyTarget = target;
    const rect = target.getBoundingClientRect();
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    Object.assign(stickyHighlight.style, {
      display: 'block',
      top: `${rect.top + scrollTop}px`,
      left: `${rect.left + scrollLeft}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });
  } else {
    hoveredStickyTarget = null;
    stickyHighlight.style.display = 'none';
  }
}, { passive: true });

document.addEventListener('click', async (e) => {
  if (window.VellumState.mode !== 'sticky') return;
  if (hoveredStickyTarget) {
    e.preventDefault();
    e.stopPropagation();

    const target = hoveredStickyTarget;
    const anchor = window.FuzzyAnchor.generate(target);
    const uuid = Date.now() + Math.random().toString();
    const placement = calculatePlacement(target);

    // Deactivate sticky mode through VellumState — cursor and UI update automatically.
    window.VellumState.set({ mode: null });
    stickyHighlight.style.display = 'none';

    const comments = [{ text: '', author: 'Me', createdAt: Date.now() }];
    window.StickyEngine.renderNote(target, anchor, placement, comments, uuid, true);

    if (window.VellumStorage) {
      await window.VellumStorage.saveNote(location.hostname, location.pathname, anchor, placement, comments, uuid);
    }
  }
}, true);

function calculatePlacement(target) {
    const rect = target.getBoundingClientRect();
    const viewportWidth = window.innerWidth;

    const leftMargin = rect.left;
    const rightMargin = viewportWidth - rect.right;
    const NOTE_WIDTH = 240;

    if (rightMargin > NOTE_WIDTH + 20) {
      return { position: 'margin-right', percentOffset: 100 };
    } else if (leftMargin > NOTE_WIDTH + 20) {
      return { position: 'margin-left', percentOffset: 0 };
    } else {
      return { position: 'below', percentOffset: 100 };
    }
}

window.StickyEngine = {
  renderNote(targetElement, anchorData, placement, comments, uuid, isNew = false) {
    if (!targetElement) return;

    const container = document.createElement('div');

    // Force all post-it notes to be yellow for MVP
    const theme = 'vellum-theme-yellow';

    container.className = 'vellum-sticky-container ' + theme + (areNotesVisible ? '' : ' hidden');
    container.dataset.uuid = uuid;

    const initialText = comments && comments.length > 0 ? comments[0].text : '';
    const noteCount = document.querySelectorAll('.vellum-sticky-container').length + 1;

    container.innerHTML = `
      <svg class="vellum-leader-line-svg" style="position: absolute; pointer-events: none; z-index: -1;"></svg>
      <div class="vellum-sticky-card">
        <div class="vellum-sticky-header">
          <div class="vellum-header-left">Note ${noteCount}</div>
          <div class="vellum-header-right">
            <div class="vellum-header-pill">Type <span>T</span></div>
            <button class="vellum-trash-btn" title="Delete Note">✕</button>
          </div>
        </div>
        <textarea class="vellum-sticky-textarea" placeholder="Take a note...">${initialText}</textarea>
      </div>
    `;

    document.body.appendChild(container);
    activeNotes.set(uuid, { container, targetElement, placement });

    this.updatePosition(uuid);

    container.addEventListener('mousedown', () => {
      highestZIndex++;
      container.style.zIndex = highestZIndex;
    });

    const textarea = container.querySelector('textarea');
    if (isNew) textarea.focus();

    let saveTimeout;
    textarea.addEventListener('input', () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(async () => {
        if (!window.VellumStorage) return;
        comments[0].text = textarea.value;
        await window.VellumStorage.saveNote(location.hostname, location.pathname, anchorData, placement, comments, uuid);
      }, DEBOUNCE_MS);
    });

    const trashBtn = container.querySelector('.vellum-trash-btn');
    trashBtn.addEventListener('click', () => {
      container.style.display = 'none';

      const toast = document.createElement('div');
      toast.className = 'vellum-toast';
      toast.innerHTML = `<span>Note deleted</span> <span class="vellum-toast-undo">Undo</span>`;
      document.body.appendChild(toast);

      // Store the timeout ref so both Ctrl+Z and the toast button can cancel it.
      let committed = false;
      const deleteTimeout = setTimeout(async () => {
        committed = true;
        // Remove from undo stack so stale entries don't linger.
        const idx = stickyUndoStack.findIndex(e => e.uuid === uuid);
        if (idx !== -1) stickyUndoStack.splice(idx, 1);

        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
        activeNotes.delete(uuid);
        container.remove();
        if (window.VellumStorage) {
          await window.VellumStorage.deleteItem(location.hostname, 'uuid', uuid);
        }
      }, 5000);

      // Shared undo logic used by BOTH the toast button and Ctrl+Z.
      function performUndo() {
        if (committed) return; // Too late — deletion already committed.
        clearTimeout(deleteTimeout);
        container.style.display = 'block';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
        // Pull the entry out of the global undo stack.
        window.VellumUndo.remove(undoEntry);
      }

      // Push to the central VellumUndo stack so Ctrl+Z works alongside all other tools.
      const undoEntry = { undo: performUndo };
      window.VellumUndo.push(undoEntry);

      toast.querySelector('.vellum-toast-undo').addEventListener('click', () => {
        performUndo();
      });
    });
  },

  updatePosition(uuid) {
    const noteData = activeNotes.get(uuid);
    if (!noteData) return;

    const { container, targetElement, placement } = noteData;
    const rect = targetElement.getBoundingClientRect();
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    let top = rect.top + scrollTop;
    let left = rect.left + scrollLeft;
    let lineStart = {x: 0, y: 0};
    let lineEnd = {x: 0, y: 0};

    const NOTE_WIDTH = 240;

    if (placement.position === 'margin-right') {
      left = rect.right + scrollLeft + 20;
      lineStart = {x: -20, y: 15};
      lineEnd = {x: 0, y: 15};
    } else if (placement.position === 'margin-left') {
      left = rect.left + scrollLeft - NOTE_WIDTH - 20;
      lineStart = {x: NOTE_WIDTH + 20, y: 15};
      lineEnd = {x: NOTE_WIDTH, y: 15};
    } else {
      top = rect.bottom + scrollTop + 10;
      lineStart = {x: NOTE_WIDTH/2, y: -10};
      lineEnd = {x: NOTE_WIDTH/2, y: 0};
    }

    container.style.top = `${top}px`;
    container.style.left = `${left}px`;

    const svg = container.querySelector('svg');
    svg.style.left = `${Math.min(lineStart.x, lineEnd.x)}px`;
    svg.style.top = `${Math.min(lineStart.y, lineEnd.y)}px`;
    svg.style.width = `${Math.max(Math.abs(lineStart.x - lineEnd.x), 2)}px`;
    svg.style.height = `${Math.max(Math.abs(lineStart.y - lineEnd.y), 2)}px`;
    svg.style.overflow = 'visible';

    svg.innerHTML = `<line x1="${lineStart.x - parseFloat(svg.style.left)}" y1="${lineStart.y - parseFloat(svg.style.top)}" x2="${lineEnd.x - parseFloat(svg.style.left)}" y2="${lineEnd.y - parseFloat(svg.style.top)}" stroke="#ffca28" stroke-width="2" stroke-dasharray="4 4" />`;
  }
};

window.addEventListener('resize', () => {
  for (const uuid of activeNotes.keys()) {
    window.StickyEngine.updatePosition(uuid);
  }
});
