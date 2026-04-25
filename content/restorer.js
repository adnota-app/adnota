// content/restorer.js

const processedItems = new Set();
let initialRestorationDone = false;

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

  const anchors = await window.AdnotaStorage.getAnchorsForUrl(location.href);
  if (!anchors || anchors.length === 0) return;

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
      if (window.AdnotaEraseRules) {
        window.AdnotaEraseRules.set(id, item.selector);
        if (window.rebuildEraseStyleTag) window.rebuildEraseStyleTag();
      } else {
        eraseTag.textContent += `${item.selector} { display: none !important; }\n`;
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
    } else {
      // Item hasn't been successfully applied yet — count it as broken for this pass.
      brokenThisPass++;
    }
  }

  chrome.storage.local.set({
    adnota_stats: {
      [location.href]: { success: erasuresCount, notes: notesCount, resizes: resizeCount, broken: brokenThisPass }
    }
  });

  // Only toast on the first pass (initial page load).
  // MutationObserver re-runs silently retry — no toast spam.
  if (!initialRestorationDone && brokenThisPass > 0) {
    showBrokenAnchorsToast(brokenThisPass);
  }
  initialRestorationDone = true;
}

// Initial fire
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  performRestoration();
} else {
  window.addEventListener('load', performRestoration);
}

// Protect against dynamic SPAs fetching data late
let mutationTimeout;
const observer = new MutationObserver(() => {
  clearTimeout(mutationTimeout);
  mutationTimeout = setTimeout(() => {
    performRestoration();
  }, 1000); // 1-second debounce for DOM mutations guarantees smooth performance
});

observer.observe(document.body, { childList: true, subtree: true });
