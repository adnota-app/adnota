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
           window.StickyEngine.renderNote(match.element, item, item.placement, item.comments, item.uuid);
        }
        notesCount++;
      } else {
        match.element.style.setProperty('display', 'none', 'important');
        erasuresCount++;
      }
      processedItems.add(id);
    } else if (match.element && match.confidence > 0 && match.confidence < 70 && item.action !== 'NOTE') {
      if (!processedItems.has(id)) {
        match.element.style.outline = '3px solid orange';
        match.element.style.backgroundColor = 'rgba(255, 165, 0, 0.2)';
        
        const conf = document.createElement('div');
        conf.innerText = 'Vellum Alert: Delete this?';
        Object.assign(conf.style, {
          position: 'absolute', background: 'orange', color: 'black', padding: '4px',
          zIndex: '999999', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', borderRadius: '3px'
        });
        
        const rect = match.element.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
        conf.style.top = `${rect.top + scrollTop}px`;
        conf.style.left = `${rect.left + scrollLeft}px`;
        
        conf.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          match.element.style.setProperty('display', 'none', 'important');
          conf.remove();
        };
        document.documentElement.appendChild(conf);
        processedItems.add(id);
      }
    }
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
