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
    // Skip Adnota's own UI
    if (current.closest('[data-adnota-ui]')) {
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
  'adnota-theme-yellow': { bg: '#FBE6A1', swatch: 'rgb(251, 230, 161)' },
  'adnota-theme-green':  { bg: '#B8F5B8', swatch: 'rgb(184, 245, 184)' },
  'adnota-theme-blue':   { bg: '#A3DDFB', swatch: 'rgb(163, 221, 251)' },
  'adnota-theme-pink':   { bg: '#FFC0C8', swatch: 'rgb(255, 192, 200)' },
  'adnota-theme-white':  { bg: '#F5F5F0', swatch: 'rgb(245, 245, 240)' },
};

// Track the active note color. Defaults to yellow, persisted to storage.
let activeStickyColor = 'adnota-theme-yellow';

// Restore persisted sticky color on load.
chrome.storage.local.get(['adnotaStickyColor'], (result) => {
  if (result.adnotaStickyColor && STICKY_THEMES[result.adnotaStickyColor]) {
    activeStickyColor = result.adnotaStickyColor;
    updateStickySwatches();
    if (window.AdnotaState.mode === 'sticky') applyStickyCursor();
  }
});

// Mini sticky note SVG icon — a filled note shape with a folded corner.
// Reused for both HUD swatches and the cursor so the tool's identity is
// visually consistent.
function stickyNoteSVG(fillColor) {
  return `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 2h12a1 1 0 011 1v9l-4 4H3a1 1 0 01-1-1V3a1 1 0 011-1z" fill="${fillColor}" stroke="rgba(0,0,0,0.15)" stroke-width="0.75"/>
    <path d="M12 12v4l4-4h-4z" fill="rgba(0,0,0,0.1)"/>
  </svg>`;
}

// Re-apply the sticky cursor using whatever color is currently active. Called
// from highlighter.js on mode entry and from swatch clicks below so the cursor
// re-paints when the user picks a new color.
function applyStickyCursor() {
  const fill = STICKY_THEMES[activeStickyColor]?.bg || '#FBE6A1';
  const svg = stickyNoteSVG(fill).replace(/\n/g, '').replace(/\s+/g, ' ');
  // Hotspot (1, 1) — top-left of the note aligns with the click point, since
  // that's the anchor for placement.
  const cursor = window.AdnotaCursor.svgCursor(svg, 1, 1, 'crosshair');
  window.AdnotaCursor.set(cursor);
}
window.AdnotaSticky = { applyCursor: applyStickyCursor };

// ---------------------------------------------------------------------------
// Sticky HUD Toolbar — frosted glass bar, matches marker/eraser aesthetic
// ---------------------------------------------------------------------------

// Dock body \u2014 mounts into AdnotaDock when sticky mode is active. The dock
// owns the drag handle + V logo + tool row; we own swatches + trash + undo.
const stickyBody = document.createElement('div');
stickyBody.style.display = 'inline-flex';
stickyBody.style.alignItems = 'center';

// Color swatches — mini sticky note icons instead of plain circles
const stickySwatches = {};
for (const [themeClass, info] of Object.entries(STICKY_THEMES)) {
  const swatch = document.createElement('div');
  swatch.className = 'adnota-sticky-swatch';
  let tooltipName = themeClass.replace('adnota-theme-', '');
  tooltipName = tooltipName.charAt(0).toUpperCase() + tooltipName.slice(1);
  swatch.setAttribute('data-tooltip', tooltipName);
  swatch.innerHTML = stickyNoteSVG(info.swatch);
  swatch.dataset.theme = themeClass;
  swatch.onclick = (e) => {
    e.stopPropagation();
    activeStickyColor = themeClass;
    chrome.storage.local.set({ adnotaStickyColor: themeClass });
    updateStickySwatches();
    if (window.AdnotaState.mode === 'sticky') applyStickyCursor();
  };
  stickySwatches[themeClass] = swatch;
  stickyBody.appendChild(swatch);
}

function updateStickySwatches() {
  for (const [theme, swatch] of Object.entries(stickySwatches)) {
    swatch.classList.toggle('active', theme === activeStickyColor);
  }
}
updateStickySwatches();

// Divider
stickyBody.appendChild(Object.assign(document.createElement('div'), { className: 'adnota-toolbar-divider adnota-toolbar-divider-orange' }));

// Trash — clears all sticky notes on this page
const stickyTrashBtn = window.AdnotaUI.createTrashButton({
  singular: 'sticky note',
  plural: 'sticky notes',
  actionTypes: ['NOTE'],
});
stickyTrashBtn.classList.add('adnota-undo-btn-orange');
stickyBody.appendChild(stickyTrashBtn);

// Undo
const stickyUndoBtn = window.AdnotaUI.createUndoButton();
stickyUndoBtn.classList.add('adnota-undo-btn-orange');
stickyBody.appendChild(stickyUndoBtn);

// ---------------------------------------------------------------------------
// Keyboard / message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-sticky') {
    window.AdnotaState.set({ mode: window.AdnotaState.mode === 'sticky' ? null : 'sticky' });
  }
});

// React to AdnotaState changes — mount/unmount dock body.
let stickyDockMounted = false;
window.AdnotaState.subscribe(state => {
  document.body.classList.toggle('adnota-sticky-active', state.mode === 'sticky');

  const isSticky = state.mode === 'sticky';
  if (isSticky && !stickyDockMounted) {
    window.AdnotaDock.mount('sticky', () => stickyBody);
    stickyDockMounted = true;
  } else if (!isSticky && stickyDockMounted) {
    window.AdnotaDock.unmount('sticky');
    stickyDockMounted = false;
  }
});

// ---------------------------------------------------------------------------
// Click to drop a note — hybrid anchor + percentage fallback
// ---------------------------------------------------------------------------

// Shared note creation — used by the sticky click handler AND by the quick
// highlight popup's "add sticky" shortcut. Builds anchor + placement, renders,
// saves, and pushes an undo entry. Returns the new note's uuid.
async function createStickyAt(clientX, clientY, { targetEl = null, theme = null } = {}) {
  window.AdnotaVisibility.show();

  const placement = clientToPlacement(clientX, clientY);

  // If no explicit target was provided, probe the DOM at the click point.
  const target = targetEl || document.elementFromPoint(clientX, clientY);
  const anchorTarget = target ? findAnchorTarget(target) : null;
  let anchor = null;
  let anchorOffset = null;

  if (anchorTarget && window.FuzzyAnchor) {
    anchor = window.FuzzyAnchor.generate(anchorTarget);
    const rect = anchorTarget.getBoundingClientRect();
    const scrollTop  = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
    const noteAbsX = clientX + scrollLeft;
    const noteAbsY = clientY + scrollTop;
    const elAbsX   = rect.left + scrollLeft;
    const elAbsY   = rect.top  + scrollTop;
    anchorOffset = {
      dx: Math.round(noteAbsX - elAbsX),
      dy: Math.round(noteAbsY - elAbsY),
    };
  }

  const uuid     = Date.now() + Math.random().toString();
  const comments = [{ text: '', author: 'Me', createdAt: Date.now() }];
  const resolvedTheme = theme || activeStickyColor;

  window.StickyEngine.renderNote(placement, comments, uuid, true, null, resolvedTheme, anchor, anchorOffset, '');

  if (window.AdnotaStorage) {
    await window.AdnotaStorage.saveNote(
      location.hostname, location.pathname, uuid,
      { placement, comments, theme: resolvedTheme, anchor, anchorOffset, tag: '' }
    );
  }

  const domain = location.hostname;
  const undoEntry = {
    undo: async () => {
      const container = document.querySelector(`.adnota-sticky-container[data-uuid="${uuid}"]`);
      if (container) container.remove();
      activeNotes.delete(uuid);
      if (window.AdnotaStorage) {
        await window.AdnotaStorage.deleteItem(domain, 'uuid', uuid);
      }
      window.AdnotaUndo.remove(undoEntry);
    }
  };
  window.AdnotaUndo.push(undoEntry);

  return uuid;
}

document.addEventListener('click', async (e) => {
  if (window.AdnotaState.mode !== 'sticky') return;

  // Don't fire through any Adnota UI (dock, existing notes, toasts, etc.)
  if (window.AdnotaUI.isAdnotaElement(e.target)) return;

  e.preventDefault();
  e.stopPropagation();

  await createStickyAt(e.clientX, e.clientY, { targetEl: e.target });
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
  createAt: createStickyAt,

  /**
   * Render a sticky note from a placement object.
   *
   * @param {object}  placement     { position:'percent', xPct, yScrollPct }
   *                                Legacy { position:'manual', top, left } also accepted.
   * @param {array}   comments      [{ text, author, createdAt }]
   * @param {string}  uuid
   * @param {boolean} isNew         Focus textarea when true.
   * @param {object}  dimensions    { width, height } or null
   * @param {string}  theme         CSS class name, e.g. 'adnota-theme-yellow'
   * @param {object}  anchor        FuzzyAnchor data or null
   * @param {object}  anchorOffset  { dx, dy } pixel offset from anchor element
   */
  renderNote(placement, comments, uuid, isNew = false, dimensions = null, theme = 'adnota-theme-yellow', anchor = null, anchorOffset = null, tag = '') {
    // Guard duplicate renders.
    if (document.querySelector(`.adnota-sticky-container[data-uuid="${uuid}"]`)) return;

    const container = document.createElement('div');
    container.className = 'adnota-sticky-container ' + (theme || 'adnota-theme-yellow');
    container.setAttribute('data-adnota-ui', '1');
    container.dataset.uuid = uuid;
    container.style.position = 'absolute';

    const initialText = comments && comments.length > 0 ? comments[0].text : '';
    const createdAt   = comments && comments[0]?.createdAt ? new Date(comments[0].createdAt) : new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts  = `${pad(createdAt.getMonth() + 1)}/${pad(createdAt.getDate())}/${String(createdAt.getFullYear()).slice(-2)} ${pad(createdAt.getHours())}:${pad(createdAt.getMinutes())}`;

    container.innerHTML = `
      <div class="adnota-sticky-card">
        <div class="adnota-sticky-header">
          <span class="adnota-timestamp">${ts}</span>
          <button class="adnota-trash-btn" data-tooltip="Delete note" aria-label="Delete note">
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="1" y1="1" x2="8" y2="8"/><line x1="8" y1="1" x2="1" y2="8"/>
            </svg>
          </button>
        </div>
        <textarea class="adnota-sticky-textarea" placeholder="Take a note...">${initialText}</textarea>
        <div class="adnota-sticky-tag-row" data-adnota-ui="1">
          <span class="adnota-sticky-tag-icon">#</span>
          <input class="adnota-sticky-tag-input" type="text" placeholder="tag" maxlength="40" />
        </div>
      </div>
    `;

    document.body.appendChild(container);

    // Apply stored dimensions before first paint so the restored size matches
    // exactly what the user left the note at.
    const card = container.querySelector('.adnota-sticky-card');
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
      theme: theme || 'adnota-theme-yellow',
      tag: window.AdnotaTags ? window.AdnotaTags.normalize(tag) : (tag || ''),
    };
    activeNotes.set(uuid, noteState);

    // Preload tag into the input — using .value rather than template
    // interpolation so we don't have to escape HTML into an attribute.
    const tagInput = container.querySelector('.adnota-sticky-tag-input');
    if (tagInput) tagInput.value = noteState.tag;

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
          if (!window.AdnotaStorage) return;
          const savedDimensions = { width: Math.round(width), height: Math.round(height) };
          await window.AdnotaStorage.saveNote(
            location.hostname, location.pathname, uuid,
            { placement: noteState.placement, comments, theme: noteState.theme, anchor: noteState.anchor, anchorOffset: noteState.anchorOffset, dimensions: savedDimensions, tag: noteState.tag }
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
    const header    = container.querySelector('.adnota-sticky-header');
    let isDragging  = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.adnota-trash-btn')) return;
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

      if (window.AdnotaStorage) {
        await window.AdnotaStorage.saveNote(
          location.hostname, location.pathname, uuid,
          { placement: updatedPlacement, comments, theme: noteState.theme, anchor: noteState.anchor, anchorOffset: noteState.anchorOffset, tag: noteState.tag }
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
        if (!window.AdnotaStorage) return;
        comments[0].text = textarea.value;
        await window.AdnotaStorage.saveNote(
          location.hostname, location.pathname, uuid,
          { placement: noteState.placement, comments, theme: noteState.theme, anchor: noteState.anchor, anchorOffset: noteState.anchorOffset, tag: noteState.tag }
        );
      }, DEBOUNCE_MS);
    });

    // ── Tag input: autocomplete + persist ───────────────────────────────────
    // Tags ride through the same saveNote merge path as every other field; we
    // keep a separate debounce timer so typing into the tag input doesn't
    // interfere with (and isn't interfered by) the textarea autosave.
    if (tagInput && window.AdnotaTags) {
      window.AdnotaTags.buildAutocompleteDropdown(tagInput);

      const commitTag = async () => {
        if (!window.AdnotaStorage) return;
        await window.AdnotaStorage.saveNote(
          location.hostname, location.pathname, uuid,
          { placement: noteState.placement, comments, theme: noteState.theme, anchor: noteState.anchor, anchorOffset: noteState.anchorOffset, tag: noteState.tag }
        );
      };

      let tagSaveTimeout;
      tagInput.addEventListener('input', () => {
        noteState.tag = window.AdnotaTags.normalize(tagInput.value);
        clearTimeout(tagSaveTimeout);
        tagSaveTimeout = setTimeout(commitTag, DEBOUNCE_MS);
      });
      tagInput.addEventListener('blur', () => {
        // Snap the displayed value to the normalized form (trim, collapse
        // internal whitespace) so what the user sees matches what we stored.
        const normalized = window.AdnotaTags.normalize(tagInput.value);
        if (tagInput.value !== normalized) tagInput.value = normalized;
        noteState.tag = normalized;
        clearTimeout(tagSaveTimeout);
        commitTag();
      });
    }

    // ── Delete with undo ─────────────────────────────────────────────────────
    const trashBtn = container.querySelector('.adnota-trash-btn');
    trashBtn.addEventListener('click', () => {
      container.style.display = 'none';

      let committed = false;
      let deleteTimeout;

      const performUndo = () => {
        if (committed) return;
        committed = true;
        clearTimeout(deleteTimeout);
        container.style.display = 'block';
        window.AdnotaUI.dismissToast(toast);
        window.AdnotaUndo.remove(undoEntry);
      };

      const toast = window.AdnotaUI.showToast('Note deleted', {
        onUndo: performUndo,
        timeout: 0, // managed by deleteTimeout below
      });

      deleteTimeout = setTimeout(async () => {
        if (committed) return;
        committed = true;
        window.AdnotaUndo.remove(undoEntry);
        window.AdnotaUI.dismissToast(toast);
        activeNotes.delete(uuid);
        container.remove();
        if (window.AdnotaStorage) {
          await window.AdnotaStorage.deleteItem(location.hostname, 'uuid', uuid);
        }
      }, 5000);

      const undoEntry = { undo: performUndo };
      window.AdnotaUndo.push(undoEntry);
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
