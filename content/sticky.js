// content/sticky.js

let highestZIndex = 2147483640;
const DEBOUNCE_MS = 1500;
const activeNotes = new Map(); // uuid -> note data

// Round a float to `d` decimal places and strip trailing zeros.
// Keeps stored JSON compact without losing meaningful precision.
// 4 d.p. on a 0–1 fraction = 0.01% of page = ~0.2px on a 2000px page.
const r4 = n => parseFloat(n.toFixed(4));

// ---------------------------------------------------------------------------
// Inline DOM element classification — find the best block-level anchor target
// near a click point. Mirrors the eraser's logic of walking up past inline
// tags to find a meaningful container.
// ---------------------------------------------------------------------------

const _inlineTags = new Set([
  'A', 'ABBR', 'B', 'BDO', 'BR', 'CITE', 'CODE', 'DFN', 'EM', 'I',
  'IMG', 'KBD', 'LABEL', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG',
  'SUB', 'SUP', 'U', 'VAR', 'WBR', 'MARK', 'TIME',
]);

/**
 * Walk from a click target up to find the nearest meaningful block element
 * that FuzzyAnchor can reliably re-identify on reload.
 * Stops at <body>/<html> — we never anchor to those.
 */
function findAnchorTarget(el) {
  let current = el;
  while (current && current !== document.body && current !== document.documentElement) {
    // Skip Vellum's own UI
    if (current.closest('[data-vellum-ui]')) {
      current = current.parentElement;
      continue;
    }
    // Accept block-level elements with some visual substance
    if (!_inlineTags.has(current.tagName) && current.offsetHeight >= 20) {
      return current;
    }
    current = current.parentElement;
  }
  return null; // Couldn't find a good target — fall back to percent-only
}

// ---------------------------------------------------------------------------
// Sticky note color palette — matches the highlighter/marker theme names
// ---------------------------------------------------------------------------

const STICKY_THEMES = {
  'vellum-theme-yellow': { bg: '#FBE6A1', swatch: 'rgb(251, 230, 161)' },
  'vellum-theme-green':  { bg: '#B8F5B8', swatch: 'rgb(184, 245, 184)' },
  'vellum-theme-blue':   { bg: '#A3DDFB', swatch: 'rgb(163, 221, 251)' },
  'vellum-theme-pink':   { bg: '#FFC0C8', swatch: 'rgb(255, 192, 200)' },
  'vellum-theme-white':  { bg: '#F5F5F0', swatch: 'rgb(245, 245, 240)' },
};

// Track the active note color. Defaults to yellow, persisted to storage.
let activeStickyColor = 'vellum-theme-yellow';

// Restore persisted sticky color on load.
chrome.storage.local.get(['vellumStickyColor'], (result) => {
  if (result.vellumStickyColor && STICKY_THEMES[result.vellumStickyColor]) {
    activeStickyColor = result.vellumStickyColor;
    updateStickySwatches();
  }
});

// Mini sticky note SVG icon — a filled note shape with a folded corner
function stickyNoteSVG(fillColor) {
  return `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 2h12a1 1 0 011 1v9l-4 4H3a1 1 0 01-1-1V3a1 1 0 011-1z" fill="${fillColor}" stroke="rgba(0,0,0,0.15)" stroke-width="0.75"/>
    <path d="M12 12v4l4-4h-4z" fill="rgba(0,0,0,0.1)"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Sticky HUD Toolbar — frosted glass bar, matches marker/eraser aesthetic
// ---------------------------------------------------------------------------

const stickyToolbar = document.createElement('div');
stickyToolbar.id = 'vellum-sticky-toolbar';
stickyToolbar.setAttribute('data-vellum-ui', '1');
stickyToolbar.style.display = 'none';
stickyToolbar.style.bottom = '20px';
stickyToolbar.style.left = '50%';
stickyToolbar.style.transform = 'translateX(-50%)';
document.documentElement.appendChild(stickyToolbar);

// Drag handle (namespaced to avoid collision with highlighter.js)
const stickyDragHandle = document.createElement('span');
stickyDragHandle.className = 'vellum-toolbar-drag';
stickyDragHandle.textContent = '\u2847';
stickyDragHandle.title = 'Drag to reposition';
stickyToolbar.appendChild(stickyDragHandle);

// Logo chip
const stickyLogoChip = document.createElement('span');
stickyLogoChip.className = 'vellum-toolbar-logo';
stickyLogoChip.textContent = 'V';
stickyToolbar.appendChild(stickyLogoChip);

// Divider
stickyToolbar.appendChild(Object.assign(document.createElement('div'), { className: 'vellum-toolbar-divider' }));

// Color swatches — mini sticky note icons instead of plain circles
const stickySwatches = {};
for (const [themeClass, info] of Object.entries(STICKY_THEMES)) {
  const swatch = document.createElement('div');
  swatch.className = 'vellum-sticky-swatch';
  swatch.innerHTML = stickyNoteSVG(info.swatch);
  swatch.dataset.theme = themeClass;
  swatch.onclick = (e) => {
    e.stopPropagation();
    activeStickyColor = themeClass;
    chrome.storage.local.set({ vellumStickyColor: themeClass });
    updateStickySwatches();
  };
  stickySwatches[themeClass] = swatch;
  stickyToolbar.appendChild(swatch);
}

function updateStickySwatches() {
  for (const [theme, swatch] of Object.entries(stickySwatches)) {
    swatch.classList.toggle('active', theme === activeStickyColor);
  }
}
updateStickySwatches();

// Divider
stickyToolbar.appendChild(Object.assign(document.createElement('div'), { className: 'vellum-toolbar-divider' }));

// Trash — clears all sticky notes on this page
stickyToolbar.appendChild(window.VellumUI.createTrashButton({
  singular: 'sticky note',
  plural: 'sticky notes',
  actionTypes: ['NOTE'],
}));

// Undo
stickyToolbar.appendChild(window.VellumUI.createUndoButton());

// Make toolbar draggable
window.VellumUI.makeDraggable(stickyToolbar, stickyDragHandle);

// ---------------------------------------------------------------------------
// Keyboard / message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-sticky') {
    window.VellumState.set({ mode: window.VellumState.mode === 'sticky' ? null : 'sticky' });
  }
});

// Escape to exit sticky mode
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && window.VellumState.mode === 'sticky') {
    window.VellumState.set({ mode: null });
  }
});

// React to VellumState changes — show/hide toolbar, update cursor.
window.VellumState.subscribe(state => {
  document.body.classList.toggle('vellum-sticky-active', state.mode === 'sticky');

  const showToolbar = state.mode === 'sticky';
  stickyToolbar.style.display = showToolbar ? 'flex' : 'none';

  // Reset toolbar position when hidden
  if (!showToolbar) {
    stickyToolbar.style.left = '50%';
    stickyToolbar.style.top = '';
    stickyToolbar.style.bottom = '20px';
    stickyToolbar.style.transform = 'translateX(-50%)';
  }
});

// ---------------------------------------------------------------------------
// Click to drop a note — hybrid anchor + percentage fallback
// ---------------------------------------------------------------------------

document.addEventListener('click', async (e) => {
  if (window.VellumState.mode !== 'sticky') return;

  // Don't fire through any Vellum UI (toolbar, existing notes, toasts, radial menu, etc.)
  if (window.VellumUI.isVellumElement(e.target)) return;

  e.preventDefault();
  e.stopPropagation();

  // Hide mode must never obscure work. If the user is placing a note while
  // annotations are hidden, reveal everything so they can see the result.
  window.VellumVisibility.show();

  // ── Build hybrid placement ────────────────────────────────────────────────
  const placement = clientToPlacement(e.clientX, e.clientY);

  // Find the nearest meaningful DOM element to anchor to
  const anchorTarget = findAnchorTarget(e.target);
  let anchor = null;
  let anchorOffset = null;

  if (anchorTarget && window.FuzzyAnchor) {
    anchor = window.FuzzyAnchor.generate(anchorTarget);

    // Compute the note's offset from the anchor element's top-left corner
    const rect = anchorTarget.getBoundingClientRect();
    const scrollTop  = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    const noteAbsX = e.clientX + scrollLeft;
    const noteAbsY = e.clientY + scrollTop;
    const elAbsX   = rect.left + scrollLeft;
    const elAbsY   = rect.top  + scrollTop;

    anchorOffset = {
      dx: Math.round(noteAbsX - elAbsX),
      dy: Math.round(noteAbsY - elAbsY),
    };
  }

  // Stay in sticky mode — user exits via Escape or toggling the tool off
  const uuid     = Date.now() + Math.random().toString();
  const comments = [{ text: '', author: 'Me', createdAt: Date.now() }];
  const theme    = activeStickyColor;

  window.StickyEngine.renderNote(placement, comments, uuid, true, null, theme, anchor, anchorOffset);

  if (window.VellumStorage) {
    await window.VellumStorage.saveNote(
      location.hostname, location.pathname, uuid,
      { placement, comments, theme, anchor, anchorOffset }
    );
  }

  // Undo: remove the note from DOM and storage
  const domain = location.hostname;
  const undoEntry = {
    undo: async () => {
      const container = document.querySelector(`.vellum-sticky-container[data-uuid="${uuid}"]`);
      if (container) container.remove();
      activeNotes.delete(uuid);
      if (window.VellumStorage) {
        await window.VellumStorage.deleteItem(domain, 'uuid', uuid);
      }
      window.VellumUndo.remove(undoEntry);
    }
  };
  window.VellumUndo.push(undoEntry);
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
  const NOTE_W = 260;
  const NOTE_H = 140;
  const clampedX = Math.min(absX, totalWidth  - NOTE_W);
  const clampedY = Math.min(absY, totalHeight - NOTE_H);

  return {
    position:   'percent',
    xPct:       r4(clampedX / totalWidth),
    yScrollPct: r4(clampedY / totalHeight),
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
   * @param {object}  placement     { position:'percent', xPct, yScrollPct }
   *                                Legacy { position:'manual', top, left } also accepted.
   * @param {array}   comments      [{ text, author, createdAt }]
   * @param {string}  uuid
   * @param {boolean} isNew         Focus textarea when true.
   * @param {object}  dimensions    { width, height } or null
   * @param {string}  theme         CSS class name, e.g. 'vellum-theme-yellow'
   * @param {object}  anchor        FuzzyAnchor data or null
   * @param {object}  anchorOffset  { dx, dy } pixel offset from anchor element
   */
  renderNote(placement, comments, uuid, isNew = false, dimensions = null, theme = 'vellum-theme-yellow', anchor = null, anchorOffset = null) {
    // Guard duplicate renders.
    if (document.querySelector(`.vellum-sticky-container[data-uuid="${uuid}"]`)) return;

    const container = document.createElement('div');
    container.className = 'vellum-sticky-container ' + (theme || 'vellum-theme-yellow');
    container.setAttribute('data-vellum-ui', '1');
    container.dataset.uuid = uuid;
    container.style.position = 'absolute';

    const initialText = comments && comments.length > 0 ? comments[0].text : '';
    const createdAt   = comments && comments[0]?.createdAt ? new Date(comments[0].createdAt) : new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts  = `${pad(createdAt.getMonth() + 1)}/${pad(createdAt.getDate())}/${String(createdAt.getFullYear()).slice(-2)} ${pad(createdAt.getHours())}:${pad(createdAt.getMinutes())}`;

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

    // Apply stored dimensions before first paint so the restored size matches
    // exactly what the user left the note at.
    const card = container.querySelector('.vellum-sticky-card');
    if (dimensions && dimensions.width && dimensions.height) {
      card.style.width  = `${dimensions.width}px`;
      card.style.height = `${dimensions.height}px`;
    }

    // In-memory record holds a *mutable* copy of placement so drag updates
    // propagate to updatePosition without re-rendering.
    const noteState = {
      container,
      placement: { ...placement },
      anchor: anchor || null,
      anchorOffset: anchorOffset || null,
      theme: theme || 'vellum-theme-yellow',
    };
    activeNotes.set(uuid, noteState);

    this.updatePosition(uuid);

    // ── Persist resize dimensions ────────────────────────────────────────────
    // ResizeObserver fires whenever the user drags the card's resize handle.
    // We debounce at the same interval as the textarea autosave to avoid
    // hammering storage mid-drag.
    let resizeTimeout;
    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { inlineSize: width, blockSize: height } = entry.borderBoxSize[0];
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(async () => {
          if (!window.VellumStorage) return;
          const savedDimensions = { width: Math.round(width), height: Math.round(height) };
          await window.VellumStorage.saveNote(
            location.hostname, location.pathname, uuid,
            { placement: noteState.placement, comments, theme: noteState.theme, anchor: noteState.anchor, anchorOffset: noteState.anchorOffset, dimensions: savedDimensions }
          );
        }, DEBOUNCE_MS);
      }
    });
    resizeObserver.observe(card);

    // Clean up observer when the note is removed from the DOM.
    new MutationObserver((_, obs) => {
      if (!document.body.contains(container)) {
        resizeObserver.disconnect();
        obs.disconnect();
      }
    }).observe(document.body, { childList: true, subtree: true });

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
      container.style.top  = `${Math.max(0, e.clientY + scrollTop - dragOffsetY)}px`;
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
        xPct:       r4(newLeft / totalWidth),
        yScrollPct: r4(newTop  / totalHeight),
      };

      noteState.placement = updatedPlacement;

      // Re-anchor to whatever element is now underneath the note's position
      const centerX = newLeft + 130; // half of card width
      const centerY = newTop + 70;   // half of card height
      const scrollTop  = window.pageYOffset || document.documentElement.scrollTop;
      const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
      const elAtPoint = document.elementFromPoint(centerX - scrollLeft, centerY - scrollTop);

      if (elAtPoint) {
        const newAnchorTarget = findAnchorTarget(elAtPoint);
        if (newAnchorTarget && window.FuzzyAnchor) {
          noteState.anchor = window.FuzzyAnchor.generate(newAnchorTarget);
          const rect = newAnchorTarget.getBoundingClientRect();
          noteState.anchorOffset = {
            dx: Math.round(newLeft - (rect.left + scrollLeft)),
            dy: Math.round(newTop  - (rect.top  + scrollTop)),
          };
        } else {
          noteState.anchor = null;
          noteState.anchorOffset = null;
        }
      }

      if (window.VellumStorage) {
        await window.VellumStorage.saveNote(
          location.hostname, location.pathname, uuid,
          { placement: updatedPlacement, comments, theme: noteState.theme, anchor: noteState.anchor, anchorOffset: noteState.anchorOffset }
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
          location.hostname, location.pathname, uuid,
          { placement: noteState.placement, comments, theme: noteState.theme, anchor: noteState.anchor, anchorOffset: noteState.anchorOffset }
        );
      }, DEBOUNCE_MS);
    });

    // ── Delete with undo ─────────────────────────────────────────────────────
    const trashBtn = container.querySelector('.vellum-trash-btn');
    trashBtn.addEventListener('click', () => {
      container.style.display = 'none';

      let committed = false;
      let deleteTimeout;

      const performUndo = () => {
        if (committed) return;
        committed = true;
        clearTimeout(deleteTimeout);
        container.style.display = 'block';
        window.VellumUI.dismissToast(toast);
        window.VellumUndo.remove(undoEntry);
      };

      const toast = window.VellumUI.showToast('Note deleted', {
        onUndo: performUndo,
        timeout: 0, // managed by deleteTimeout below
      });

      deleteTimeout = setTimeout(async () => {
        if (committed) return;
        committed = true;
        window.VellumUndo.remove(undoEntry);
        window.VellumUI.dismissToast(toast);
        activeNotes.delete(uuid);
        container.remove();
        if (window.VellumStorage) {
          await window.VellumStorage.deleteItem(location.hostname, 'uuid', uuid);
        }
      }, 5000);

      const undoEntry = { undo: performUndo };
      window.VellumUndo.push(undoEntry);
    });
  },

  /**
   * Reposition a note based on its anchor (preferred) or placement (fallback).
   * Called after initial render and on window resize.
   */
  updatePosition(uuid) {
    const noteState = activeNotes.get(uuid);
    if (!noteState) return;

    const { container, placement, anchor, anchorOffset } = noteState;
    let left, top;
    let anchorResolved = false;

    // ── Primary: try FuzzyAnchor resolution ─────────────────────────────────
    if (anchor && anchorOffset && window.FuzzyAnchor) {
      const match = window.FuzzyAnchor.findMatch(anchor);
      if (match.confidence >= 40 && match.element) {
        const rect = match.element.getBoundingClientRect();
        const scrollTop  = window.pageYOffset || document.documentElement.scrollTop;
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

        left = rect.left + scrollLeft + anchorOffset.dx;
        top  = rect.top  + scrollTop  + anchorOffset.dy;
        anchorResolved = true;
      }
    }

    // ── Fallback: percentage placement (never lose your work) ───────────────
    if (!anchorResolved) {
      if (placement.position === 'percent') {
        ({ left, top } = placementToPixels(placement));
      } else if (placement.position === 'manual') {
        // Legacy format from before this refactor — treat stored px directly.
        left = placement.left;
        top  = placement.top;
      } else {
        return; // Unknown format — do nothing rather than misplace the note.
      }
    }

    container.style.left = `${left}px`;
    container.style.top  = `${Math.max(0, top)}px`;
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
