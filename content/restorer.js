// content/restorer.js

const processedItems = new Set();
let initialRestorationDone = false;
let lastProcessedUrl = null;
// In-flight guard: rapid SPA nav (claude.ai chat hopping) can fire the
// MutationObserver again while a previous performRestoration call is still
// awaiting storage I/O. Without the guard, two concurrent runs both clear
// processedItems and both run teardown — wasteful, and the second tearDown
// races with the first run's render writes. Cheap to prevent.
let restorationInFlight = false;

// Tear down every rendered annotation owned by the previous URL. Called on
// SPA URL change before re-running restoration for the new URL. Each engine
// owns its own DOM (#adnota-marker-overlay, .adnota-sticky-container,
// CSS Custom Highlights + fallback wrappers, ERASE/RESIZE <style> tags),
// all of which sit outside React's tree under data-adnota-ui — so React
// never unmounts them on its own. Storage is left untouched; the next pass
// repaints whatever belongs to the new URL.
async function tearDownAllAnnotations() {
  if (window.AdnotaMarker?.tearDownAll) window.AdnotaMarker.tearDownAll();
  if (window.AdnotaHighlighter?.tearDownAll) window.AdnotaHighlighter.tearDownAll();
  if (window.StickyEngine?.tearDownAll) await window.StickyEngine.tearDownAll();

  if (window.AdnotaEraseRules) {
    window.AdnotaEraseRules.clear();
    if (window.rebuildEraseStyleTag) window.rebuildEraseStyleTag();
  }
  if (window.AdnotaResizeRules) {
    window.AdnotaResizeRules.clear();
    if (window.rebuildResizeStyleTag) window.rebuildResizeStyleTag();
  }
  // Inline-style erases tracked on real DOM nodes — those nodes are usually
  // already gone after the React swap, but clear the Set so we don't hold
  // stale references and the show/hide toggle starts fresh.
  if (window.AdnotaErasedElements) window.AdnotaErasedElements.clear();
}

function showBrokenAnchorsToast(count) {
  // De-duplicate: only one broken-anchor toast at a time.
  if (document.getElementById('adnota-broken-toast')) return;

  const plural = count === 1 ? '' : 's';
  const toast = document.createElement('div');
  toast.id = 'adnota-broken-toast';
  toast.className = 'adnota-toast';
  toast.setAttribute('data-adnota-ui', '1');
  toast.innerHTML = `
    <div class="adnota-toast-logo">A</div>
    <span class="adnota-toast-message">${count} saved edit${plural} couldn't be reapplied — this page may have changed.</span>
    <div class="adnota-toast-actions">
      <span class="adnota-toast-btn" id="adnota-broken-dismiss">Dismiss</span>
    </div>
  `;

  // Wait for body to exist (may be called early on some pages).
  const attach = () => {
    (document.body || document.documentElement).appendChild(toast);

    document.getElementById('adnota-broken-dismiss').addEventListener('click', () => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    });

    // Auto-dismiss after 14 seconds — longer than the standard 5s delete toast
    // because this requires the user to actually read and comprehend it.
    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      }
    }, 14000);
  };

  if (document.body) {
    attach();
  } else {
    window.addEventListener('DOMContentLoaded', attach, { once: true });
  }
}

async function performRestoration() {
  if (!window.AdnotaStorage || !window.FuzzyAnchor) return;
  if (restorationInFlight) return;
  restorationInFlight = true;
  try {
    await _performRestoration();
  } finally {
    restorationInFlight = false;
  }
}

async function _performRestoration() {
  // SPA in-app nav (/foo → /bar → /foo): processedItems is module-scoped and
  // not URL-keyed, so on return to /foo every ID is already present and the
  // loop below would skip the entire URL. Clear on URL change so each visit
  // gets a fresh restoration pass; the existing MutationObserver fires on
  // SPA-nav DOM swap, so no popstate/pushState hook is needed. Also tear
  // down the previous URL's rendered overlays — they live outside React's
  // tree under data-adnota-ui, so without an explicit teardown they
  // accumulate across SPA navigations on app shells like claude.ai.
  if (lastProcessedUrl !== null && lastProcessedUrl !== location.href) {
    await tearDownAllAnnotations();
    processedItems.clear();
    initialRestorationDone = false;
  }
  lastProcessedUrl = location.href;

  const anchors = await window.AdnotaStorage.getAnchorsForUrl(location.href);
  if (!anchors || anchors.length === 0) return;

  const sizeBefore = processedItems.size;
  let erasuresCount = 0;
  let notesCount = 0;
  let resizeCount = 0;
  let brokenThisPass = 0;

  for (const item of anchors) {
    const id = item.uuid || item._id || item.storageId || JSON.stringify(item);
    if (processedItems.has(id)) continue;

    // ── Resize overrides: inject via <style> tag — no DOM anchoring needed. ────
    if (item.action === 'RESIZE') {
      // Go through the shared Map so rebuild is the single source of truth.
      // Older fallback (plain textContent append) is kept for the rare case
      // where resizer.js hasn't loaded yet — extremely unlikely at restore time.
      if (window.AdnotaResizeRules && item._id) {
        window.AdnotaResizeRules.set(item._id, {
          selector: item.selector,
          cssText: item.cssText,
        });
        if (window.rebuildResizeStyleTag) window.rebuildResizeStyleTag();
      } else {
        let styleTag = document.getElementById('adnota-style-overrides');
        if (!styleTag) {
          styleTag = document.createElement('style');
          styleTag.id = 'adnota-style-overrides';
          styleTag.setAttribute('data-adnota-ui', '1');
          document.head.appendChild(styleTag);
        }
        styleTag.textContent += `${item.selector} { ${item.cssText} }\n`;
      }
      processedItems.add(id);
      resizeCount++;
      continue;
    }

    // ── Sticky notes: hybrid anchor + percentage fallback. ────────────────
    // Anchor resolution happens inside StickyEngine.updatePosition() —
    // we just pass through all stored fields. Notes always render; if the
    // anchor can't be resolved, percentage placement ensures no work is lost.
    if (item.action === 'NOTE') {
      if (window.StickyEngine) {
        window.StickyEngine.renderNote(
          item.placement, item.comments, item.uuid, false,
          item.dimensions || null,
          item.theme || 'adnota-theme-yellow',
          item.anchor || null,
          item.anchorOffset || null,
          item.tag || ''
        );
      }
      processedItems.add(id);
      notesCount++;
      continue;
    }

    // ── ERASE with CSS selector: inject rule + best-effort FuzzyAnchor ──────
    if (item.action === 'ERASE' && item.selector) {
      // CSS rule hides the element (and any future re-creations like ad rotations)
      let eraseTag = document.getElementById('adnota-erase-overrides');
      if (!eraseTag) {
        eraseTag = document.createElement('style');
        eraseTag.id = 'adnota-erase-overrides';
        eraseTag.setAttribute('data-adnota-ui', '1');
        document.head.appendChild(eraseTag);
      }
      // Widen ad-slot selectors so rotating impressions in the same slot stay
      // hidden across reloads. Older entries saved before this generalization
      // existed get upgraded transparently on the next restore pass — the
      // anchor.tagName carried in storage is enough to derive the wider rule.
      const ruleSelector = window.AdnotaUI
        ? window.AdnotaUI.maybeGeneralizeAdSelector(item.selector, item.anchor?.tagName)
        : item.selector;
      if (window.AdnotaEraseRules) {
        window.AdnotaEraseRules.set(id, ruleSelector);
        if (window.rebuildEraseStyleTag) window.rebuildEraseStyleTag();
      } else {
        eraseTag.textContent += `${ruleSelector} { display: none !important; }\n`;
      }

      // Best-effort: also add to AdnotaErasedElements for inline show/hide toggle
      const match = window.FuzzyAnchor.findMatch(item.anchor);
      if (match.confidence >= 40 && match.element) {
        match.element.style.setProperty('display', 'none', 'important');
        if (window.AdnotaErasedElements) window.AdnotaErasedElements.add(match.element);
      }
      // CSS rule has us covered — mark processed regardless of FuzzyAnchor result
      processedItems.add(id);
      erasuresCount++;
      continue;
    }

    // ── All other items need a DOM match via FuzzyAnchor. ───────────────────
    const match = window.FuzzyAnchor.findMatch(item.anchor);

    if (match.confidence >= 40 && match.element) {
      if (item.action === 'HIGHLIGHT') {
        if (window.AdnotaHighlighter) {
          window.AdnotaHighlighter.applyStoredHighlight(match.element, item);
        }
      } else if (item.action === 'MARKER') {
        if (window.AdnotaMarker) {
          window.AdnotaMarker.renderMarker(match.element, item);
        }
      } else {
        // ERASE (legacy items without selector) — inline style only
        match.element.style.setProperty('display', 'none', 'important');
        if (window.AdnotaErasedElements) window.AdnotaErasedElements.add(match.element);
        erasuresCount++;
      }
      processedItems.add(id);
    } else if (
      item.action === 'MARKER' &&
      item.fallbackBox &&
      window.AdnotaMarker
    ) {
      // FuzzyAnchor missed the original block. Try the scroll-container
      // ancestor first — it's usually a stable layout shell (main, app
      // wrapper) that FuzzyAnchor can resolve, and rendering against it
      // means the marker scrolls with content on app shells where the body
      // doesn't scroll. Fall through to documentElement only if that misses
      // too, so the marker still appears (drifted, doesn't follow scroll).
      let rendered = false;
      if (item.fallbackBox.containerAnchor) {
        const cMatch = window.FuzzyAnchor.findMatch(item.fallbackBox.containerAnchor);
        if (cMatch.confidence >= 40 && cMatch.element) {
          item._fallbackContainer = cMatch.element;
          window.AdnotaMarker.renderMarker(cMatch.element, item);
          rendered = true;
        }
      }
      if (!rendered && item.fallbackBox.docLeft != null) {
        window.AdnotaMarker.renderMarker(document.documentElement, item);
        rendered = true;
      }
      if (rendered) processedItems.add(id);
      else brokenThisPass++;
    } else {
      // Item hasn't been successfully applied yet — count it as broken for this pass.
      brokenThisPass++;
    }
  }

  // Steady-state guard: on heavy SPAs the MutationObserver wakes us every
  // ~2.5s for the lifetime of the tab. If nothing was newly processed and
  // nothing's broken, the chrome.storage write (and its onChanged fan-out
  // to popup + Sites page) is pure noise. Skip it.
  const grew = processedItems.size > sizeBefore;
  const hasBroken = brokenThisPass > 0;
  if (grew || hasBroken) {
    chrome.storage.local.set({
      adnota_stats: {
        [location.href]: { success: erasuresCount, notes: notesCount, resizes: resizeCount, broken: brokenThisPass }
      }
    });

    // Only toast on the first pass (initial page load).
    // MutationObserver re-runs silently retry — no toast spam.
    if (!initialRestorationDone && hasBroken) {
      showBrokenAnchorsToast(brokenThisPass);
    }
  }
  initialRestorationDone = true;

  // Reveal annotations now that the new URL's pass has completed. The class
  // was set by the Navigation API listener at route-start to hide the previous
  // URL's overlays; clearing it here means the user sees the new state appear,
  // not lingering ghosts. Cleared unconditionally so a no-op pass (no items
  // for this URL) still un-hides for any subsequent renders triggered later.
  document.documentElement.classList.remove('adnota-route-changing');
}

// Initial fire
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  performRestoration();
} else {
  window.addEventListener('load', performRestoration);
}

// Navigation API: zero-latency hide on SPA route start.
// The MutationObserver below would eventually catch the URL change and run
// teardown, but only after the 1s debounce + DOM swap settles — long enough
// that the previous route's marker overlay and sticky containers visibly
// linger over the new page on apps like claude.ai. The Navigation API fires
// synchronously the instant the SPA pushes/replaces state, so flipping a CSS
// class on <html> hides the old overlays immediately. performRestoration
// removes the class once the new URL's pass finishes (success or no-op).
// Feature-detected — Firefox/Safari fall through to the MutationObserver
// path, same as before.
if (window.navigation) {
  window.navigation.addEventListener('navigate', (e) => {
    try {
      const dest = new URL(e.destination.url);
      if (dest.href !== location.href) {
        document.documentElement.classList.add('adnota-route-changing');
        // Backstop: pathological case where the SPA pushes state without any
        // DOM mutation — MutationObserver never fires, performRestoration
        // never runs, and the class would stay set forever. 3s is a hair past
        // the MutationObserver max-wait clamp (2.5s), so on the happy path
        // performRestoration removes the class first and this is a no-op.
        setTimeout(() => {
          document.documentElement.classList.remove('adnota-route-changing');
        }, 3000);
      }
    } catch (_) {
      // Malformed destination URL — ignore; MutationObserver will still cover it.
    }
  });
}

// Protect against dynamic SPAs fetching data late.
// Trailing 1s debounce so we wait for a mutation burst to settle, but with a
// hard 2.5s max-wait clamp: on heavy SPAs that mutate continuously, the plain
// debounce would keep resetting and never fire, leaving paint markers absent
// for the full hydration window. The clamp guarantees we run periodically
// even while mutations keep coming.
let mutationTimeout;
let mutationFirstPending = 0;
const MUTATION_DEBOUNCE_MS = 1000;
const MUTATION_MAX_WAIT_MS = 2500;

const observer = new MutationObserver(() => {
  const now = Date.now();
  if (mutationFirstPending === 0) mutationFirstPending = now;

  const elapsed = now - mutationFirstPending;
  const remaining = Math.max(0, MUTATION_MAX_WAIT_MS - elapsed);
  const wait = Math.min(MUTATION_DEBOUNCE_MS, remaining);

  clearTimeout(mutationTimeout);
  mutationTimeout = setTimeout(() => {
    mutationFirstPending = 0;
    performRestoration();
  }, wait);
});

observer.observe(document.body, { childList: true, subtree: true });
