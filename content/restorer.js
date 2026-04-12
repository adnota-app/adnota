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

  let erasuresCount = 0;
  let notesCount = 0;
  let brokenThisPass = 0;

  for (const item of anchors) {
    const id = item.uuid || item.storageId || JSON.stringify(item);
    if (processedItems.has(id) && item.action !== 'NOTE') continue;
    // NOTE tracking keeps position updated natively

    const match = window.FuzzyAnchor.findMatch(item);

    if (match.confidence >= 70 && match.element) {
      if (item.action === 'NOTE') {
        if (!processedItems.has(id)) {
          const existing = document.querySelector(`.vellum-sticky-container[data-uuid="${item.uuid}"]`);
          if (!existing) {
            window.StickyEngine.renderNote(match.element, item, item.placement, item.comments, item.uuid);
          }
        }
        notesCount++;
      } else if (item.action === 'HIGHLIGHT') {
        if (!processedItems.has(id)) {
          if (window.VellumHighlighter) {
            window.VellumHighlighter.applyStoredHighlight(match.element, item);
          }
        }
      } else if (item.action === 'MARKER') {
        if (!processedItems.has(id)) {
          if (window.VellumMarker) {
            window.VellumMarker.renderMarker(match.element, item);
          }
        }
      } else {
        match.element.style.setProperty('display', 'none', 'important');
        erasuresCount++;
      }
      processedItems.add(id);
    } else {
      // Item hasn't been successfully applied yet — count it as broken for this pass.
      if (!processedItems.has(id)) {
        brokenThisPass++;
      }
    }
  }

  chrome.storage.local.set({
    vellum_stats: {
      [location.href]: { success: erasuresCount, notes: notesCount, broken: brokenThisPass }
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
