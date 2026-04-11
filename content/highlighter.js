// content/highlighter.js

let isHighlightMode = false;
let activeHighlightColor = 'vellum-theme-yellow';

// Setup CSS Highlight Registry (Requires Chrome 105+)
const highlightRegistries = {
  'vellum-theme-yellow': new Highlight(),
  'vellum-theme-green': new Highlight(),
  'vellum-theme-blue': new Highlight(),
  'vellum-theme-pink': new Highlight()
};

// Graceful fallback check
if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
  for (const [theme, highlightObj] of Object.entries(highlightRegistries)) {
    CSS.highlights.set(theme, highlightObj);
  }
} else {
  console.warn("Vellum Highlighter requires Chrome 105+. CSS Custom Highlights API not supported in this browser.");
}

// Check storage for persisted color preference
chrome.storage.local.get(['vellumHighlightColor'], (result) => {
  if (result.vellumHighlightColor) {
    activeHighlightColor = result.vellumHighlightColor;
  }
});

// Create Toolbar
const highlightToolbar = document.createElement('div');
highlightToolbar.id = 'vellum-highlighter-widget';
highlightToolbar.style.display = 'none';
highlightToolbar.style.position = 'fixed';
highlightToolbar.style.bottom = '20px';
highlightToolbar.style.left = '50%';
highlightToolbar.style.transform = 'translateX(-50%)';
highlightToolbar.style.zIndex = '2147483647';
document.documentElement.appendChild(highlightToolbar);

const themes = {
  'vellum-theme-yellow': 'rgb(255, 235, 59)',
  'vellum-theme-green': 'rgb(76, 175, 80)',
  'vellum-theme-blue': 'rgb(33, 150, 243)',
  'vellum-theme-pink': 'rgb(233, 30, 99)'
};

for (const [themeClass, colorHex] of Object.entries(themes)) {
  const swatch = document.createElement('div');
  swatch.className = 'vellum-color-swatch';
  swatch.style.backgroundColor = colorHex;
  if (themeClass === activeHighlightColor) swatch.classList.add('active');
  
  swatch.onclick = () => {
    activeHighlightColor = themeClass;
    chrome.storage.local.set({ vellumHighlightColor: themeClass });
    Array.from(highlightToolbar.children).forEach(c => c.classList.remove('active'));
    swatch.classList.add('active');
  };
  highlightToolbar.appendChild(swatch);
}

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-highlighter') {
    isHighlightMode = !isHighlightMode;
    if (isHighlightMode) {
      document.body.style.cursor = 'text';
      highlightToolbar.style.display = 'flex';
    } else {
      document.body.style.cursor = '';
      highlightToolbar.style.display = 'none';
    }
  }
});

function getOccurrenceIndex(range, anchorElement) {
  const preSelectionRange = range.cloneRange();
  // Safe bounded select
  try {
    preSelectionRange.selectNodeContents(anchorElement);
    preSelectionRange.setEnd(range.startContainer, range.startOffset);
  } catch (e) {
    return 0; // Fallback if boundaries are messed up
  }
  
  const textBefore = preSelectionRange.toString();
  const highlightText = range.toString();
  
  if (!highlightText) return 0;

  let count = 0;
  let pos = textBefore.indexOf(highlightText);
  while (pos !== -1) {
    count++;
    pos = textBefore.indexOf(highlightText, pos + 1);
  }
  return count;
}

document.addEventListener('mouseup', async (e) => {
  if (!isHighlightMode) return;
  
  // Prevent toolbar clicks from triggering highlight logic
  if (e.target.closest('#vellum-highlighter-widget')) return;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  const range = selection.getRangeAt(0);
  const text = range.toString().trim();
  if (!text) return;

  // We need a stable parent to anchor to
  let anchorElement = range.commonAncestorContainer;
  if (anchorElement.nodeType !== Node.ELEMENT_NODE) {
    anchorElement = anchorElement.parentNode;
  }
  
  // Jump to nearest block-level container for stability
  const blockElement = anchorElement.closest('p, div, section, article, main, li, h1, h2, h3, h4, td') || document.body;

  const anchor = window.FuzzyAnchor.generate(blockElement);
  anchor._id = Date.now() + Math.random().toString();
  
  const payload = {
    ...anchor,
    action: 'HIGHLIGHT',
    text: range.toString(), // Exact raw string, spaces intact
    occurrenceIndex: getOccurrenceIndex(range, blockElement),
    color: activeHighlightColor,
    attachedNoteId: null 
  };

  // Natively render it right now 
  if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
    const registry = highlightRegistries[activeHighlightColor];
    if (registry) {
       registry.add(range.cloneRange()); // Add a detached clone
    }
  }
  
  // Clear native browser highlight so our CSS Highlight takes over
  selection.removeAllRanges();

  if (window.VellumStorage) {
    await window.VellumStorage.saveAnchor(location.hostname, location.pathname, payload);
  }
});

// We need an exposed API for restorer.js to call during page load to inject retrieved highlights
window.VellumHighlighter = {
  applyStoredHighlight: function(anchorElement, payload) {
    if (typeof CSS === 'undefined' || !('highlights' in CSS)) return false;
    
    // Build tree walker to hunt the exact occurrence down organically
    const treeWalker = document.createTreeWalker(anchorElement, NodeFilter.SHOW_TEXT, null, false);
    let node;
    let currentText = '';
    const textNodes = [];
    
    while ((node = treeWalker.nextNode())) {
      textNodes.push({
        node: node,
        start: currentText.length,
        end: currentText.length + node.nodeValue.length
      });
      currentText += node.nodeValue;
    }
    
    // Find the requested occurrence
    const textToFind = payload.text;
    let pos = -1;
    for (let i = 0; i <= payload.occurrenceIndex; i++) {
      pos = currentText.indexOf(textToFind, pos + 1);
      if (pos === -1) break;
    }
    
    if (pos !== -1) {
      const startOffsetGlobals = pos;
      const endOffsetGlobals = pos + textToFind.length;
      
      const range = new Range();
      let startSet = false;
      let endSet = false;
      
      for (const info of textNodes) {
        if (!startSet && startOffsetGlobals >= info.start && startOffsetGlobals < info.end) {
          range.setStart(info.node, startOffsetGlobals - info.start);
          startSet = true;
        }
        // Use <= instead of < for end constraints to allow exactly matching node edges
        if (!endSet && endOffsetGlobals > info.start && endOffsetGlobals <= info.end) {
          range.setEnd(info.node, endOffsetGlobals - info.start);
          endSet = true;
        }
      }
      
      if (startSet && endSet) {
        highlightRegistries[payload.color].add(range);
        return true;
      }
    }
    return false;
  }
};
