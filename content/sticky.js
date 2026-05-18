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
 *
 * Rejects scroll containers as candidates (see AdnotaUI.isScrollContainer).
 * The bug this prevents: a click in bare whitespace inside Gemini's
 * <infinite-scroller> would walk up looking for a block ≥20px tall and
 * accept the infinite-scroller itself. Tier 1 then resolved against it on
 * every reload, but `top = scrollerRect.top + dy` pins the note to a fixed
 * viewport position — the scroller's rect doesn't move when its content
 * scrolls, only `scrollTop` does. Returning null here lets Tier 2 take over,
 * which stores the same scroller correctly (with `scrollTop` math) so the
 * note tracks content scroll. Same logic protects against any other
 * scroller-as-anchor case (Notion main, ChatGPT message log, etc.).
 */
function findAnchorTarget(el) {
  let current = el;
  while (current && current !== document.body && current !== document.documentElement) {
    // Skip Adnota's own UI
    if (current.closest('[data-adnota-ui]')) {
      current = current.parentElement;
      continue;
    }
    // Accept block-level elements with some visual substance, but never an
    // element that is itself a scroll container — those go to Tier 2.
    if (!_inlineTags.has(current.tagName) &&
        current.offsetHeight >= 20 &&
        !window.AdnotaUI?.isScrollContainer?.(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null; // Couldn't find a good target — fall back to Tier 2/3
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
// owns the drag handle + A logo + tool row; we own swatches + trash + undo.
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
  swatch.setAttribute('data-adnota-tooltip', tooltipName);
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

// Trash — opens scratch pad on Snippets / Notes for per-row review/delete.
// Badge auto-managed by createTrashButton when mode/filter are passed.
const stickyTrashBtn = window.AdnotaUI.createTrashButton({
  singular: 'sticky note',
  plural: 'sticky notes',
  actionTypes: ['NOTE'],
  mode: 'snippets',
  filter: 'notes',
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
let _stickyActive = false;
window.AdnotaState.subscribe(state => {
  document.body.classList.toggle('adnota-sticky-active', state.mode === 'sticky');

  const isSticky = state.mode === 'sticky';
  if (isSticky !== _stickyActive) {
    _stickyActive = isSticky;
    window.AdnotaLog?.event('sticky', isSticky ? 'mode-enter' : 'mode-exit');
  }
  if (isSticky && !stickyDockMounted) {
    window.AdnotaDock.mount('sticky', () => stickyBody);
    stickyDockMounted = true;
  } else if (!isSticky && stickyDockMounted) {
    window.AdnotaDock.unmount('sticky');
    stickyDockMounted = false;
  }
});

// ---------------------------------------------------------------------------
// Render-target overlay + per-note save payload
// ---------------------------------------------------------------------------

// Lazily-created fixed-position container that hosts every rendered sticky.
// See #adnota-sticky-overlay in sticky.css for the architectural rationale —
// short version: appending notes directly to <body> with `position: absolute`
// and document-pixel `top` values inflated documentElement.scrollHeight on
// app shells (chatgpt.com, claude.ai), creating swathes of empty whitespace.
// Mirrors getMarkerOverlay() in marker.js.
function getStickyOverlay() {
  let overlay = document.getElementById('adnota-sticky-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'adnota-sticky-overlay';
    overlay.setAttribute('data-adnota-ui', '1');
    document.documentElement.appendChild(overlay);
  }
  return overlay;
}

// Single source of truth for the saveNote payload. Six different code paths
// (initial create, drag commit, resize commit, textarea autosave, tag commit,
// SPA-teardown flush, delete-undo restore) used to inline this object literal
// — every new field had to be added in seven places and we already shipped at
// least one bug from missing one (AdnotaUI._restoreItems forgetting `tag`).
// `dimensions` is the only field that varies per call site (resize commit
// passes freshly-measured values; everything else inherits whatever's already
// in storage via the shallow merge in saveNote).
function buildSavePayload(noteState, dimensions) {
  const out = {
    placement:    noteState.placement,
    comments:     noteState.comments,
    theme:        noteState.theme,
    anchor:       noteState.anchor,
    anchorOffset: noteState.anchorOffset,
    fallback:     noteState.fallback,
    tag:          noteState.tag,
  };
  if (dimensions) out.dimensions = dimensions;
  return out;
}

// At save time, capture a Tier 2 fallback: the nearest scrolling ancestor of
// the click point + the click point's offset within that ancestor's
// scrollable content. On reload, if FuzzyAnchor can't re-resolve the original
// block (Tier 1 miss), the restorer's updatePosition() can still place the
// note at the right spot in the conversation by re-finding this scroll
// container and applying the offset. Without this, Tier 1 misses fell all
// the way to a percentage of `documentElement.scrollHeight` — which on
// app shells (chatgpt.com, claude.ai) where the doc itself doesn't scroll is
// a meaningless number, landing notes in dead whitespace at the page bottom.
// Mirrors marker.js's `fallbackBox.containerAnchor` (Tier 2 of its 3-tier
// cascade). Returns null when no inner scroller exists — the page itself is
// the scroll context and the percentage tier handles that case correctly.
//
// `walkSeedEl` is whatever DOM element the caller has at the click point.
// Prefer the Tier 1 anchor target when available (block-level, stable), but
// any non-null page element works — findScrollContainer just needs *something*
// to walk up from. Falling back to a less-stable seed is still strictly better
// than no Tier 2 at all on app shells.
function buildContainerFallback(clientX, clientY, walkSeedEl) {
  if (!walkSeedEl || !window.AdnotaUI?.findScrollContainer || !window.FuzzyAnchor) return null;
  // includeSelf because the walk seed may itself be the scroll container —
  // happens whenever findAnchorTarget rejected the seed for being a scroller
  // and returned null, leaving us to fall back to the raw click target. We
  // still want that scroller as our Tier 2 anchor.
  const sc = window.AdnotaUI.findScrollContainer(walkSeedEl, { includeSelf: true });
  if (!sc) return null;
  const scRect = sc.getBoundingClientRect();
  return {
    containerAnchor: window.FuzzyAnchor.generate(sc),
    containerOffsetX: Math.round(clientX - scRect.left + sc.scrollLeft),
    containerOffsetY: Math.round(clientY - scRect.top  + sc.scrollTop),
  };
}

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
    anchorOffset = {
      dx: Math.round(clientX - rect.left),
      dy: Math.round(clientY - rect.top),
    };
  }

  const fallback = buildContainerFallback(clientX, clientY, anchorTarget || target);

  const uuid     = Date.now() + Math.random().toString();
  const comments = [{ text: '', author: 'Me', createdAt: Date.now() }];
  const resolvedTheme = theme || activeStickyColor;

  window.AdnotaLog?.event('sticky', 'create', {
    id: uuid,
    color: resolvedTheme,
    anchor: anchor ? { sel: anchor.cssSelector, tag: anchor.tagName } : null,
    anchorOffset,
    fallback: fallback ? { containerSel: fallback.containerAnchor?.cssSelector } : null,
    placement,
  });

  window.StickyEngine.renderNote(placement, comments, uuid, true, null, resolvedTheme, anchor, anchorOffset, '', fallback);

  if (window.AdnotaStorage) {
    await window.AdnotaStorage.saveNote(
      location.hostname, location.pathname, uuid,
      { placement, comments, theme: resolvedTheme, anchor, anchorOffset, fallback, tag: '' }
    );
  }

  const domain = location.hostname;
  const undoEntry = {
    undo: async () => {
      window.AdnotaLog?.event('sticky', 'undo', { id: uuid });
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
  // Exit sticky mode after placement. Sticky is punctuated (place → type →
  // done), unlike pen/eraser/highlight which are continuous. The placed
  // note's textarea takes focus, so staying in mode would mean any click
  // outside it (scroll, copy text, click a link) drops a phantom sticky.
  // Re-entry via bare-key `s` or the dock button is one tap away if the
  // user wants to drop another.
  window.AdnotaState.set({ mode: null });
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

// ---------------------------------------------------------------------------
// StickyEngine — render, position, drag, save
// ---------------------------------------------------------------------------

window.StickyEngine = {
  createAt: createStickyAt,

  // Smooth-scrolls the source location of the given sticky into view.
  // Returns true on success, false if the note isn't currently rendered
  // (waiting on a restoration pass, or torn down by an SPA URL change).
  // The scratch pad's GOTO button uses the return value to surface a
  // "couldn't locate" toast.
  //
  // We can't call scrollIntoView on the sticky container — it lives inside
  // #adnota-sticky-overlay (position: fixed), so the browser treats it as
  // already viewport-anchored and the call no-ops. We also can't call
  // scrollIntoView on the resolved Tier 1 anchor: a sticky dropped in
  // page whitespace anchors to a tall wrapper (Wikipedia's <main> at
  // 24,000px is the canonical case) and centering the wrapper leaves the
  // sticky thousands of pixels away. Instead, mirror updatePosition's
  // tier cascade and compute a target scrollTop directly:
  //   Tier 1: math from anchor rect + anchorOffset.dy in scroller-content space
  //   Tier 2: containerOffsetY (already in scroller-content space)
  //   Tier 3: yScrollPct * scrollHeight
  // Centers the sticky vertically in the scroller (or window for Tier 3).
  scrollTo(uuid) {
    if (!uuid) return false;
    const noteState = activeNotes.get(uuid);
    if (!noteState) {
      window.AdnotaLog?.event('sticky', 'goto-no-state', { uuid });
      return false;
    }

    const { anchor, anchorOffset, fallback, placement, container } = noteState;
    const containerRect = container?.getBoundingClientRect();
    window.AdnotaLog?.event('sticky', 'goto-start', {
      uuid,
      hasAnchor: !!(anchor && anchorOffset),
      hasFallback: !!(fallback && fallback.containerAnchor),
      placement,
      anchorOffset,
      fallback: fallback ? {
        containerSel: fallback.containerAnchor?.cssSelector,
        containerOffsetX: fallback.containerOffsetX,
        containerOffsetY: fallback.containerOffsetY,
      } : null,
      containerViewport: containerRect ? {
        top: Math.round(containerRect.top),
        left: Math.round(containerRect.left),
      } : null,
      windowScrollY: Math.round(window.pageYOffset || document.documentElement.scrollTop),
      docScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    });

    // Tier 1: anchor resolved to a real page-DOM element. We can't just
    // call scrollIntoView on it: the sticky is offset *inside* the anchor
    // by anchorOffset.dy, so on a tall wrapper (e.g. Wikipedia's <main>
    // at 24,000px) scrollIntoView centers the wrapper and the sticky
    // ends up thousands of pixels from the viewport. Instead, compute
    // where the sticky's center *currently* lives in the scroller's
    // content space and scroll that point to viewport center. Walks up
    // from the anchor to find the right scroll container so this works
    // for both document scroll and inner scrollers (claude.ai, chatgpt.com).
    if (anchor && anchorOffset && window.FuzzyAnchor) {
      const match = window.FuzzyAnchor.findMatch(anchor);
      if (match.confidence >= 40 && match.element) {
        const r = match.element.getBoundingClientRect();
        // Use the same walker as buildContainerFallback so save-time and
        // goto-time agree on which ancestor is the scroll context.
        // findScrollContainer returns null when no inner scroller exists
        // — fall through to scrollingElement so the document case works.
        const sc = window.AdnotaUI?.findScrollContainer?.(match.element)
          || document.scrollingElement
          || document.documentElement;
        const isDoc = sc === document.scrollingElement || sc === document.documentElement || sc === document.body;
        const scRectTop = isDoc ? 0 : sc.getBoundingClientRect().top;
        // 140px = default sticky card height (sticky.css). Belt-and-
        // suspenders for the brief pendingAnchor/opacity:0 window where
        // offsetHeight could read 0 mid-restore.
        const containerH = container.offsetHeight || 140;
        // Position of sticky's vertical center, expressed in scroller-content space:
        //   (viewport y of sticky top) - (viewport y of scroller) + scroller's scrollTop + half-height
        const stickyCenterInContent =
          (r.top - scRectTop) + anchorOffset.dy + containerH / 2 + (sc.scrollTop || 0);
        const targetTop = Math.max(0, stickyCenterInContent - sc.clientHeight / 2);
        window.AdnotaLog?.event('sticky', 'goto-tier1', {
          uuid,
          confidence: match.confidence,
          el: window.AdnotaLog?.el(match.element),
          rectTop: Math.round(r.top),
          rectLeft: Math.round(r.left),
          anchorH: Math.round(r.height),
          dy: anchorOffset.dy,
          scTag: sc.tagName?.toLowerCase(),
          scIsDoc: isDoc,
          scScrollTop: Math.round(sc.scrollTop || 0),
          scClientHeight: sc.clientHeight,
          containerH,
          stickyCenterInContent: Math.round(stickyCenterInContent),
          targetTop: Math.round(targetTop),
        });
        try { sc.scrollTo({ top: targetTop, behavior: 'smooth' }); }
        catch (_) { sc.scrollTop = targetTop; }
        return true;
      }
      window.AdnotaLog?.event('sticky', 'goto-tier1-miss', {
        uuid, confidence: match.confidence,
      });
    }

    // Tier 2: container-fallback. The resolved element IS the scroll
    // container, so scrollIntoView on it would scroll the *parent* to
    // reveal the container, not adjust the container's own scrollTop —
    // visible as a tiny no-op scroll when the user drops a sticky in
    // page whitespace and Tier 1 doesn't latch. Set scrollTop directly
    // from containerOffsetY (the y-coord of the click within the
    // container's scrollable content) and center it in the viewport.
    if (fallback && fallback.containerAnchor && window.FuzzyAnchor) {
      const cMatch = window.FuzzyAnchor.findMatch(fallback.containerAnchor);
      if (cMatch.confidence >= 40 && cMatch.element) {
        const sc = cMatch.element;
        const top = Math.max(0, fallback.containerOffsetY - sc.clientHeight / 2);
        window.AdnotaLog?.event('sticky', 'goto-tier2', {
          uuid,
          confidence: cMatch.confidence,
          sc: window.AdnotaLog?.el(sc),
          scIsDocEl: sc === document.documentElement,
          scIsBody: sc === document.body,
          scScrollTop: sc.scrollTop,
          scScrollHeight: sc.scrollHeight,
          scClientHeight: sc.clientHeight,
          containerOffsetY: fallback.containerOffsetY,
          targetTop: Math.round(top),
        });
        try { sc.scrollTo({ top, behavior: 'smooth' }); }
        catch (_) { sc.scrollTop = top; }
        return true;
      }
      window.AdnotaLog?.event('sticky', 'goto-tier2-miss', {
        uuid, confidence: cMatch.confidence,
      });
    }

    // Tier 3: no resolvable anchor — scroll the window to the note's
    // stored document-y. Centers the note vertically in the viewport.
    let docTop;
    if (placement.position === 'percent') {
      docTop = placement.yScrollPct * Math.max(document.documentElement.scrollHeight, 1);
    } else if (placement.position === 'manual') {
      docTop = placement.top;
    } else {
      window.AdnotaLog?.event('sticky', 'goto-tier3-bad-placement', { uuid, placement });
      return false;
    }
    const targetY = Math.max(0, docTop - window.innerHeight / 2);
    window.AdnotaLog?.event('sticky', 'goto-tier3', {
      uuid,
      placementPosition: placement.position,
      yScrollPct: placement.yScrollPct,
      docScrollHeight: document.documentElement.scrollHeight,
      docTop: Math.round(docTop),
      innerHeight: window.innerHeight,
      targetY: Math.round(targetY),
      currentScrollY: Math.round(window.pageYOffset || document.documentElement.scrollTop),
    });
    try { window.scrollTo({ top: targetY, behavior: 'smooth' }); }
    catch (_) { window.scrollTo(0, targetY); }
    return true;
  },

  // Flush pending edits and drop every rendered note from the DOM. Called on
  // SPA URL change so notes from the previous path don't bleed into the next.
  // The flush reads each note's current textarea + tag value and saves
  // against the path the note belongs to (captured at render time) — without
  // it, the autosave debounce (1.5s) firing after navigation would write to
  // location.pathname of the *new* URL and corrupt the wrong path's items.
  // Storage is left untouched beyond the flush; restoration repaints whatever
  // belongs to the new URL.
  tearDownAll: async function () {
    if (!window.AdnotaStorage || activeNotes.size === 0) {
      activeNotes.forEach(s => s.container.remove());
      activeNotes.clear();
      return;
    }
    // Flush sequentially: every saveNote here targets the same domain key, so
    // running them in parallel races on the read-modify-write inside saveNote
    // and the last write wins, clobbering earlier flushes.
    for (const [uuid, state] of activeNotes) {
      const textarea = state.container.querySelector('textarea');
      const tagInput = state.container.querySelector('.adnota-sticky-tag-input');
      if (textarea && state.comments && state.comments[0]) {
        state.comments[0].text = textarea.value;
      }
      if (tagInput && window.AdnotaTags) {
        state.tag = window.AdnotaTags.normalize(tagInput.value);
      }
      const card = state.container.querySelector('.adnota-sticky-card');
      const dimensions = card
        ? { width: Math.round(card.offsetWidth), height: Math.round(card.offsetHeight) }
        : null;
      await window.AdnotaStorage.saveNote(
        state.originalHostname, state.originalPath, uuid,
        buildSavePayload(state, dimensions)
      );
    }

    activeNotes.forEach(s => s.container.remove());
    activeNotes.clear();
  },

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
   * @param {string}  tag           Optional user-supplied tag (≤40 chars)
   * @param {object}  fallback      Tier 2 container-anchor fallback or null
   *                                { containerAnchor, containerOffsetX, containerOffsetY }
   */
  renderNote(placement, comments, uuid, isNew = false, dimensions = null, theme = 'adnota-theme-yellow', anchor = null, anchorOffset = null, tag = '', fallback = null) {
    // Guard duplicate renders. Restorer retry passes route through
    // updatePosition() directly, so a hit here means an unexpected duplicate
    // render attempt — return false so the caller doesn't treat it as a
    // successful anchor resolution.
    if (document.querySelector(`.adnota-sticky-container[data-uuid="${uuid}"]`)) return false;

    const container = document.createElement('div');
    container.className = 'adnota-sticky-container ' + (theme || 'adnota-theme-yellow');
    container.setAttribute('data-adnota-ui', '1');
    container.dataset.uuid = uuid;
    container.style.position = 'absolute';

    // Hide until anchor resolves so we don't flash at percentage fallback
    // before snapping to the right spot. Only restoration calls with anchor
    // data get this treatment — fresh placements (isNew) are positioned by
    // the user's just-now click, so they reveal immediately. Legacy notes
    // without anchor data also reveal immediately since the percentage
    // fallback is their final position. Reveal happens in updatePosition()
    // on first anchor success or via the backstop timer below.
    const pendingAnchor = !isNew && !!(anchor && anchorOffset);
    if (pendingAnchor) container.style.opacity = '0';

    const initialText = comments && comments.length > 0 ? comments[0].text : '';
    const createdAt   = comments && comments[0]?.createdAt ? new Date(comments[0].createdAt) : new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts  = `${pad(createdAt.getMonth() + 1)}/${pad(createdAt.getDate())}/${String(createdAt.getFullYear()).slice(-2)} ${pad(createdAt.getHours())}:${pad(createdAt.getMinutes())}`;

    container.innerHTML = `
      <div class="adnota-sticky-card">
        <div class="adnota-sticky-header">
          <span class="adnota-timestamp">${ts}</span>
          <button class="adnota-trash-btn" data-adnota-tooltip="Delete note" aria-label="Delete note">
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="1" y1="1" x2="8" y2="8"/><line x1="8" y1="1" x2="1" y2="8"/>
            </svg>
          </button>
        </div>
        <textarea class="adnota-sticky-textarea" placeholder="Take a note..."></textarea>
        <div class="adnota-sticky-tag-row" data-adnota-ui="1">
          <span class="adnota-sticky-tag-icon">#</span>
          <input class="adnota-sticky-tag-input" type="text" placeholder="tag" maxlength="40" />
        </div>
      </div>
    `;
    // Seed the body via .value (not template interpolation) so untrusted note
    // text — e.g. a note brought in through Import/Export — can never break
    // out of the textarea and inject HTML. Same pattern as the tag input below.
    const textareaEl = container.querySelector('.adnota-sticky-textarea');
    if (textareaEl) textareaEl.value = initialText;

    getStickyOverlay().appendChild(container);

    // Apply stored dimensions before first paint so the restored size matches
    // exactly what the user left the note at.
    const card = container.querySelector('.adnota-sticky-card');
    if (dimensions && dimensions.width && dimensions.height) {
      card.style.width  = `${dimensions.width}px`;
      card.style.height = `${dimensions.height}px`;
    }

    // In-memory record holds a *mutable* copy of placement so drag updates
    // propagate to updatePosition without re-rendering. originalPath/Hostname
    // are pinned at render time so the SPA URL-change teardown can flush
    // pending edits to the path the note actually belongs to, even if
    // location has already changed by the time teardown runs.
    const noteState = {
      container,
      placement: { ...placement },
      anchor: anchor || null,
      anchorOffset: anchorOffset || null,
      fallback: fallback || null,
      theme: theme || 'adnota-theme-yellow',
      tag: window.AdnotaTags ? window.AdnotaTags.normalize(tag) : (tag || ''),
      comments,
      originalHostname: location.hostname,
      originalPath: location.pathname,
      pendingAnchor,
      revealTimer: null,
      deleted: false,
    };
    activeNotes.set(uuid, noteState);

    // Preload tag into the input — using .value rather than template
    // interpolation so we don't have to escape HTML into an attribute.
    const tagInput = container.querySelector('.adnota-sticky-tag-input');
    if (tagInput) tagInput.value = noteState.tag;

    const anchorResolved = this.updatePosition(uuid);

    // If we hid the container waiting for anchor resolution and the first
    // pass didn't resolve, set a backstop so a permanently-broken anchor
    // still surfaces the note at percentage fallback. ~1.8s gives the
    // restorer's mutation observer (1s debounce + 2.5s clamp) one full
    // retry cycle on app shells before we give up and reveal.
    if (pendingAnchor && !anchorResolved) {
      noteState.revealTimer = setTimeout(() => {
        noteState.revealTimer = null;
        if (noteState.pendingAnchor) {
          noteState.pendingAnchor = false;
          container.style.opacity = '1';
        }
      }, 1800);
    }

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
          if (noteState.deleted || !window.AdnotaStorage) return;
          const savedDimensions = { width: Math.round(width), height: Math.round(height) };
          await window.AdnotaStorage.saveNote(
            location.hostname, location.pathname, uuid,
            buildSavePayload(noteState, savedDimensions)
          );
        }, DEBOUNCE_MS);
      }
    });
    resizeObserver.observe(card);

    // Clean up the ResizeObserver if the container is detached. Watches the
    // sticky overlay (container.parentNode) with childList only — every note
    // previously registered a `document.body, { subtree: true }` observer
    // just to detect its own removal, which fired on every DOM mutation
    // anywhere on the page. With N notes on a heavy SPA (claude.ai, ChatGPT,
    // Notion) that meant N global subtree observers all firing on every
    // mutation. childList on the overlay parent fires only when notes are
    // added/removed; mirrors lib/adnotaUI.js bindAnchorSync.
    const overlay = container.parentNode;
    if (overlay) {
      const cleanupObserver = new MutationObserver(() => {
        if (!container.isConnected) {
          resizeObserver.disconnect();
          cleanupObserver.disconnect();
        }
      });
      cleanupObserver.observe(overlay, { childList: true });
    }

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

      // Container coords are now viewport-relative (note lives inside the
      // fixed #adnota-sticky-overlay), so the drag math drops the page-scroll
      // term entirely — clientX/Y *is* the same coordinate system as
      // container.style.left/top.
      dragOffsetX = e.clientX - parseFloat(container.style.left || 0);
      dragOffsetY = e.clientY - parseFloat(container.style.top  || 0);

      container.style.transition = 'none';
      e.preventDefault();
    });

    header.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      container.style.left = `${e.clientX - dragOffsetX}px`;
      container.style.top  = `${Math.max(0, e.clientY - dragOffsetY)}px`;
    });

    header.addEventListener('pointerup', async (e) => {
      if (!isDragging) return;
      isDragging = false;
      header.releasePointerCapture(e.pointerId);
      container.style.transition = '';

      // newLeft/newTop are viewport-px (fixed-overlay coord system). Storage
      // percentages are document-relative — convert via current scroll.
      const newLeft = parseFloat(container.style.left);
      const newTop  = parseFloat(container.style.top);
      const scrollTop  = window.pageYOffset || document.documentElement.scrollTop;
      const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

      const totalWidth  = Math.max(document.documentElement.scrollWidth,  1);
      const totalHeight = Math.max(document.documentElement.scrollHeight, 1);

      const updatedPlacement = {
        position:   'percent',
        xPct:       r4((newLeft + scrollLeft) / totalWidth),
        yScrollPct: r4((newTop  + scrollTop)  / totalHeight),
      };

      noteState.placement = updatedPlacement;

      // Re-anchor to whatever element is now underneath the note's center.
      // We must query the visual stack (elementsFromPoint, plural) and skip
      // every Adnota UI layer at the drop point, because the sticky note we
      // just dropped is sitting *exactly* on top of the page at this point.
      // document.elementFromPoint (singular) would return the sticky's own
      // card/textarea, findAnchorTarget would bubble up through
      // [data-adnota-ui] all the way to <body> and return null, and the note
      // would persist with anchor=null — making it scroll-broken (no anchor
      // to track on app shells) and "remember" the broken position across
      // reloads. The plural variant returns the full top-down stack so we
      // can ignore our own chrome and the page content underneath.
      // Card center uses measured offsetWidth/Height so a resized note
      // probes its actual visual center (was hardcoded 130/70 = the default
      // 260×140 card, off-by-the-resize-amount on any non-default size).
      const centerXViewport = newLeft + card.offsetWidth  / 2;
      const centerYViewport = newTop  + card.offsetHeight / 2;
      const stack = document.elementsFromPoint(centerXViewport, centerYViewport);
      const elAtPoint = stack.find(el => !el.closest('[data-adnota-ui]')) || null;

      let newAnchorTarget = null;
      if (elAtPoint) {
        newAnchorTarget = findAnchorTarget(elAtPoint);
        if (newAnchorTarget && window.FuzzyAnchor) {
          noteState.anchor = window.FuzzyAnchor.generate(newAnchorTarget);
          const rect = newAnchorTarget.getBoundingClientRect();
          noteState.anchorOffset = {
            dx: Math.round(newLeft - rect.left),
            dy: Math.round(newTop  - rect.top),
          };
        } else {
          noteState.anchor = null;
          noteState.anchorOffset = null;
        }
      } else {
        noteState.anchor = null;
        noteState.anchorOffset = null;
      }

      // Refresh Tier 2 fallback against the new drop position. Even when the
      // Tier 1 anchor goes null (drop landed on bare overlay area) the
      // container fallback still gives us scroll-tracking on app shells.
      noteState.fallback = buildContainerFallback(newLeft, newTop, newAnchorTarget || elAtPoint);

      window.AdnotaLog?.event('sticky', 'drag-commit', {
        id: uuid,
        placement: updatedPlacement,
        anchor: noteState.anchor ? { sel: noteState.anchor.cssSelector, tag: noteState.anchor.tagName } : null,
        anchorOffset: noteState.anchorOffset,
        fallback: noteState.fallback ? { containerSel: noteState.fallback.containerAnchor?.cssSelector } : null,
      });
      if (window.AdnotaStorage) {
        await window.AdnotaStorage.saveNote(
          location.hostname, location.pathname, uuid,
          buildSavePayload(noteState)
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
        if (noteState.deleted || !window.AdnotaStorage) return;
        comments[0].text = textarea.value;
        window.AdnotaLog?.event('sticky', 'autosave', {
          id: uuid, text: textarea.value, tag: noteState.tag,
        });
        await window.AdnotaStorage.saveNote(
          location.hostname, location.pathname, uuid,
          buildSavePayload(noteState)
        );
      }, DEBOUNCE_MS);
    });

    // ── Tag input: autocomplete + persist ───────────────────────────────────
    // Tags ride through the same saveNote merge path as every other field; we
    // keep a separate debounce timer so typing into the tag input doesn't
    // interfere with (and isn't interfered by) the textarea autosave.
    // tagSaveTimeout is hoisted to renderNote scope so the trash handler
    // below can clear it alongside saveTimeout / resizeTimeout.
    let tagSaveTimeout;
    if (tagInput && window.AdnotaTags) {
      window.AdnotaTags.buildAutocompleteDropdown(tagInput);

      const commitTag = async () => {
        if (noteState.deleted || !window.AdnotaStorage) return;
        await window.AdnotaStorage.saveNote(
          location.hostname, location.pathname, uuid,
          buildSavePayload(noteState)
        );
      };

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
        window.AdnotaLog?.event('sticky', 'tag-commit', { id: uuid, tag: normalized });
        commitTag();
      });
    }

    // ── Delete with undo ─────────────────────────────────────────────────────
    // Mirrors marker/highlighter delete: snapshot full payload, hard-tear-down
    // visual + drop activeNotes registration, *synchronously* delete from
    // storage, push an undo entry that re-saves and re-renders. The previous
    // pattern (display:none + 5s setTimeout to call deleteItem) lost the
    // delete entirely if the user refreshed within the undo window — the
    // timer died with the page and the storage row stayed intact, so the
    // restorer happily resurrected the note on the next load. Storage delete
    // is now committed before the user can refresh.
    const trashBtn = container.querySelector('.adnota-trash-btn');
    trashBtn.addEventListener('click', async () => {
      window.AdnotaLog?.event('sticky', 'delete', { id: uuid });

      // Block every save path that could resurrect this note. Without this,
      // a pending textarea/tag/resize debounce fires after deleteItem and
      // saveNote upserts the row back — restorer's next MutationObserver
      // pass then re-renders. Set the flag *before* anything async so the
      // blur->commitTag race triggered by clicking from a focused tag input
      // also gets blocked.
      noteState.deleted = true;
      clearTimeout(saveTimeout);
      clearTimeout(tagSaveTimeout);
      clearTimeout(resizeTimeout);

      // Flush latest text/tag/dimensions from DOM in case the autosave
      // debounce (textarea: 1.5s, ResizeObserver: same) hasn't fired yet.
      // Same trick tearDownAll uses on SPA route change.
      const textarea = container.querySelector('.adnota-sticky-textarea');
      const tagInput = container.querySelector('.adnota-sticky-tag-input');
      const card = container.querySelector('.adnota-sticky-card');
      if (textarea && noteState.comments && noteState.comments[0]) {
        noteState.comments[0].text = textarea.value;
      }
      if (tagInput && window.AdnotaTags) {
        noteState.tag = window.AdnotaTags.normalize(tagInput.value);
      }
      const savedDimensions = card
        ? { width: Math.round(card.offsetWidth), height: Math.round(card.offsetHeight) }
        : null;
      const snapshot = buildSavePayload(noteState, savedDimensions);

      // Hard teardown — clear the pending-anchor reveal timer (if any),
      // drop from activeNotes, remove from DOM. Storage delete next.
      if (noteState.revealTimer) clearTimeout(noteState.revealTimer);
      activeNotes.delete(uuid);
      container.remove();

      if (window.AdnotaStorage) {
        await window.AdnotaStorage.deleteItem(location.hostname, 'uuid', uuid);
      }

      let consumed = false;
      const undoEntry = {
        undo: async () => {
          if (consumed) return;
          consumed = true;
          if (window.AdnotaStorage) {
            await window.AdnotaStorage.saveNote(
              location.hostname, location.pathname, uuid, snapshot
            );
          }
          window.StickyEngine.renderNote(
            snapshot.placement, snapshot.comments, uuid, false,
            snapshot.dimensions, snapshot.theme,
            snapshot.anchor, snapshot.anchorOffset, snapshot.tag,
            snapshot.fallback
          );
          window.AdnotaUndo.remove(undoEntry);
        }
      };
      window.AdnotaUndo.push(undoEntry);

      window.AdnotaUI?.showToast?.('Note deleted', {
        id: 'adnota-sticky-toast',
        onUndo: () => undoEntry.undo(),
      });
    });

    return anchorResolved;
  },

  /**
   * Reposition a note based on its anchor (preferred) or placement (fallback).
   * Called after initial render and on window resize. Also serves as the
   * restorer's retry path — returns true when FuzzyAnchor (Tier 1) resolved
   * the note's saved element so the restorer can decide whether the note is
   * still eligible for re-attempt on the next MutationObserver pass.
   *
   * Three-tier fallback cascade — mirrors marker.js's resolveAnchorRect:
   *   1. FuzzyAnchor on the original block (`anchor` + `anchorOffset`)
   *   2. FuzzyAnchor on the nearest scrolling ancestor (`fallback.containerAnchor`
   *      + `containerOffsetX/Y`) — tracks inner-container scroll on app shells
   *      where the document itself doesn't move
   *   3. Percentage of `documentElement.scrollWidth/Height` — last-resort
   *      "never lose the work" fallback that lands somewhere reasonable on
   *      normal scrolling pages and somewhere arbitrary on app shells
   *
   * All tier outputs are written to container.style.left/top as VIEWPORT
   * coordinates because the container lives inside the fixed-position
   * #adnota-sticky-overlay. The capture-phase scroll listener
   * (_resyncAllNotes) re-runs this on every scroll so the values stay live
   * without a per-tier scroll listener.
   *
   * Returns true only on Tier 1 success. Tier 2/3 and "no note" early-outs
   * return false so the restorer keeps the item retryable until Tier 1
   * actually resolves; the resize/scroll handler ignores the value.
   */
  updatePosition(uuid) {
    const noteState = activeNotes.get(uuid);
    if (!noteState) return false;

    const { container, placement, anchor, anchorOffset, fallback } = noteState;
    let left, top;
    let anchorResolved = false;
    const scrollTop  = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    // ── Tier 1: FuzzyAnchor on the original block (viewport coords) ─────────
    if (anchor && anchorOffset && window.FuzzyAnchor) {
      const match = window.FuzzyAnchor.findMatch(anchor);
      if (match.confidence >= 40 && match.element) {
        const rect = match.element.getBoundingClientRect();
        left = rect.left + anchorOffset.dx;
        top  = rect.top  + anchorOffset.dy;
        anchorResolved = true;
      }
    }

    // ── Tier 2: container-scroll-anchor fallback ────────────────────────────
    // The fix for chatgpt.com / claude.ai: when Tier 1 misses (the specific
    // chat turn / paragraph / message wrapper has been re-rendered with a
    // different selector), re-resolve the surrounding scroll container and
    // place the note at its saved offset within that container's scrollable
    // content. The note now tracks the conversation's internal scroll instead
    // of falling all the way through to the meaningless `scrollHeight` tier.
    if (!anchorResolved && fallback && fallback.containerAnchor && window.FuzzyAnchor) {
      const cMatch = window.FuzzyAnchor.findMatch(fallback.containerAnchor);
      if (cMatch.confidence >= 40 && cMatch.element) {
        const scRect = cMatch.element.getBoundingClientRect();
        left = scRect.left + fallback.containerOffsetX - cMatch.element.scrollLeft;
        top  = scRect.top  + fallback.containerOffsetY - cMatch.element.scrollTop;
      }
    }

    // ── Tier 3: percentage placement (never lose your work) ─────────────────
    if (left === undefined) {
      if (placement.position === 'percent') {
        const docLeft = placement.xPct       * Math.max(document.documentElement.scrollWidth,  1);
        const docTop  = placement.yScrollPct * Math.max(document.documentElement.scrollHeight, 1);
        // Convert document px → viewport px since the container lives in the
        // fixed overlay. The capture-phase scroll listener fires on every
        // scroll to re-run this so the value tracks naturally.
        left = docLeft - scrollLeft;
        top  = docTop  - scrollTop;
      } else if (placement.position === 'manual') {
        // Legacy format from before this refactor — stored as document px.
        left = placement.left - scrollLeft;
        top  = placement.top  - scrollTop;
      } else {
        return false; // Unknown format — do nothing rather than misplace the note.
      }
    }

    container.style.left = `${left}px`;
    // No clamp on top: when an anchor element scrolls above the viewport, top
    // goes negative and the note correctly scrolls off-screen above. Clamping
    // pinned the note at viewport top forever, which is wrong on every scroll
    // model.
    container.style.top  = `${top}px`;

    // First successful Tier 1 resolution reveals a pending-anchor note.
    // Backstop timer is cleared because we beat it. Subsequent calls (resize,
    // scroll, restorer retry) hit the early-out since pendingAnchor is now
    // false. The 0.2s opacity transition on .adnota-sticky-container handles
    // the fade for free.
    if (anchorResolved && noteState.pendingAnchor) {
      noteState.pendingAnchor = false;
      if (noteState.revealTimer) {
        clearTimeout(noteState.revealTimer);
        noteState.revealTimer = null;
      }
      container.style.opacity = '1';
    }
    return anchorResolved;
  },
};

// ---------------------------------------------------------------------------
// Resize + scroll: recompute all note positions
// ---------------------------------------------------------------------------
// On a normal scrolling document, position: absolute on <body> is document-
// anchored, so notes scroll with content for free. App-shell pages
// (chatgpt.com, claude.ai, Notion) lock body at overflow: hidden and scroll
// an internal container — body never moves, so the note appears glued to
// the screen while the anchor element slides away underneath it. Capture-
// phase scroll catches scrolls on any element (scroll doesn't bubble but
// does go through capture), so a single window-level listener covers every
// scroll container without per-note registration. rAF-throttled because
// internal scroll containers can fire ~60 events per scroll. Mirrors the
// marker tool's bindAnchorSync triad — sticky just never got the scroll
// half until now.

let _stickyResyncRaf = 0;
function _resyncAllNotes() {
  if (_stickyResyncRaf) return;
  _stickyResyncRaf = requestAnimationFrame(() => {
    _stickyResyncRaf = 0;
    for (const uuid of activeNotes.keys()) {
      window.StickyEngine.updatePosition(uuid);
    }
  });
}

window.addEventListener('resize', _resyncAllNotes);
window.addEventListener('scroll', _resyncAllNotes, { capture: true, passive: true });
