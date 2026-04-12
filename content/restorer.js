// content/restorer.js

const processedItems = new Set();

async function performRestoration() {
  if (!window.VellumStorage || !window.FuzzyAnchor) return;

  const anchors = await window.VellumStorage.getAnchorsForUrl(location.href);
  if (!anchors || anchors.length === 0) return;

  let erasuresCount = 0;
  let notesCount = 0;

  for (const item of anchors) {
    const id = item.uuid || item.storageId || JSON.stringify(item);
    if (processedItems.has(id) && item.action !== 'NOTE') continue;
    // NOTE tracking keeps position updated natively

    const match = window.FuzzyAnchor.findMatch(item);
    
    // We only process if confidence is solid or if we haven't flagged it broken yet
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
    }
    // We intentionally fail silently on eroded anchors (< 70% confidence) 
    // to preserve page aesthetics, rather than aggressively drawing amber bounding boxes.
  }

  chrome.storage.local.set({ 
    vellum_stats: { 
      [location.href]: { success: erasuresCount, notes: notesCount }
    }
  });
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
