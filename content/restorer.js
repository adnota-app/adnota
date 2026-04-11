// content/restorer.js

async function performRestoration() {
  if (!window.VellumStorage || !window.FuzzyAnchor) return;

  const anchors = await window.VellumStorage.getAnchorsForUrl(location.href);
  if (!anchors || anchors.length === 0) return;

  let successCount = 0;
  let brokenCount = 0;

  for (const item of anchors) {
    const match = window.FuzzyAnchor.findMatch(item);
    
    if (match.confidence >= 70 && match.element) {
      match.element.style.setProperty('display', 'none', 'important');
      successCount++;
    } else if (match.element && match.confidence > 0 && match.confidence < 70) {
      // Highlight amber for user confirmation
      match.element.style.outline = '3px solid orange';
      match.element.style.backgroundColor = 'rgba(255, 165, 0, 0.2)';
      
      const conf = document.createElement('div');
      conf.innerText = 'Vellum Alert: Delete this?';
      Object.assign(conf.style, {
        position: 'absolute',
        background: 'orange',
        color: 'black',
        padding: '4px',
        zIndex: '999999',
        fontSize: '12px',
        fontWeight: 'bold',
        cursor: 'pointer',
        borderRadius: '3px'
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
      
      brokenCount++; // We consider <70% "broken" in stats since it requires manual intervention
    } else {
      brokenCount++;
    }
  }

  // Save stats for the popup to read
  chrome.storage.local.set({ 
    vellum_stats: { 
      [location.href]: { success: successCount, broken: brokenCount }
    }
  });
}

// In Manifest V3, "document_idle" means the script might be injected AFTER the load event.
// We should check the readyState and execute immediately if it's already loaded or interactive.
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  performRestoration();
} else {
  window.addEventListener('load', performRestoration);
}
