// content/restorer.js

const processedItems = new Set();
let initialRestorationDone = false;

function showBrokenAnchorsToast(count) {
  // De-duplicate: only one broken-anchor toast at a time.
  if (document.getElementById('vellum-broken-toast')) return;

  const plural = count === 1 ? '' : 's';
  const toast = document.createElement('div');
  toast.id = 'vellum-broken-toast';
  toast.className = 'vellum-toast';
  toast.setAttribute('data-vellum-ui', '1');
  toast.innerHTML = `
    <div class="vellum-toast-logo">V</div>
    <span class="vellum-toast-message">${count} saved edit${plural} couldn't be reapplied — this page may have changed.</span>
    <div class="vellum-toast-actions">
      <span class="vellum-toast-btn" id="vellum-broken-dismiss">Dismiss</span>
    </div>
  `;

  // Wait for body to exist (may be called early on some pages).
  const attach = () => {
    (document.body || document.documentElement).appendChild(toast);

    document.getElementById('vellum-broken-dismiss').addEventListener('click', () => {
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
  if (!window.VellumStorage || !window.FuzzyAnchor) return;

  const anchors = await window.VellumStorage.getAnchorsForUrl(location.href);
  if (!anchors || anchors.length === 0) return;

  // Check once whether annotations are currently hidden.
  const hiddenResult = await chrome.storage.local.get(['vellumHidden']);
  const isHidden = !!hiddenResult.vellumHidden;

  let erasuresCount = 0;
  let notesCount = 0;
  let resizeCount = 0;
  let brokenThisPass = 0;

  for (const item of anchors) {
    const id = item.uuid || item._id || item.storageId || JSON.stringify(item);
    if (processedItems.has(id)) continue;

    // ── Resize overrides: inject via <style> tag — no DOM anchoring needed. ────
    if (item.action === 'RESIZE') {
      let styleTag = document.getElementById('vellum-style-overrides');
      if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'vellum-style-overrides';
        styleTag.setAttribute('data-vellum-ui', '1');
        if (isHidden) styleTag.disabled = true;
        document.head.appendChild(styleTag);
      }
      styleTag.textContent += `${item.selector} { ${item.cssText} }\n`;
      processedItems.add(id);
      resizeCount++;
      continue;
    }

    // ── Sticky notes: placement is self-contained (percent-based coords). ────
    // No DOM anchoring needed — notes always restore regardless of page changes.
    if (item.action === 'NOTE') {
      if (window.StickyEngine) {
        window.StickyEngine.renderNote(item.placement, item.comments, item.uuid, false, item.dimensions || null);
      }
      processedItems.add(id);
      notesCount++;
      continue;
    }

    // ── All other items need a DOM match via FuzzyAnchor. ───────────────────
    const match = window.FuzzyAnchor.findMatch(item);

    if (match.confidence >= 70 && match.element) {
      if (item.action === 'HIGHLIGHT') {
        if (window.VellumHighlighter) {
          window.VellumHighlighter.applyStoredHighlight(match.element, item);
        }
      } else if (item.action === 'MARKER') {
        if (window.VellumMarker) {
          window.VellumMarker.renderMarker(match.element, item);
        }
      } else {
        // ERASE
        match.element.style.setProperty('display', 'none', 'important');
        erasuresCount++;
      }
      processedItems.add(id);
    } else {
      // Item hasn't been successfully applied yet — count it as broken for this pass.
      brokenThisPass++;
    }
  }

  chrome.storage.local.set({
    vellum_stats: {
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
