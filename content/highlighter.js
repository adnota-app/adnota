// content/highlighter.js

// Setup CSS Highlight Registry (Requires Chrome 105+)
const highlightRegistries = {
  'vellum-theme-yellow': new Highlight(),
  'vellum-theme-green': new Highlight(),
  'vellum-theme-blue': new Highlight(),
  'vellum-theme-pink': new Highlight(),
  'vellum-theme-black': new Highlight()
};

if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
  for (const [theme, highlightObj] of Object.entries(highlightRegistries)) {
    CSS.highlights.set(theme, highlightObj);
  }
}

// Create Toolbar UI
const highlightToolbar = document.createElement('div');
highlightToolbar.id = 'vellum-highlighter-widget';
highlightToolbar.style.display = 'none';
highlightToolbar.style.position = 'fixed';
highlightToolbar.style.bottom = '20px';
highlightToolbar.style.left = '50%';
highlightToolbar.style.transform = 'translateX(-50%)';
highlightToolbar.style.zIndex = '2147483646'; // One below max — toast is always on top.
highlightToolbar.style.cursor = 'default';
document.documentElement.appendChild(highlightToolbar);

// Mode UI
const modePen = document.createElement('div');
modePen.className = 'vellum-mode-btn';
modePen.innerText = 'Pen';
modePen.onclick = () => window.VellumState.set({ mode: 'pen' });

const modeHighlighter = document.createElement('div');
modeHighlighter.className = 'vellum-mode-btn';
modeHighlighter.innerText = 'Highlight';
modeHighlighter.onclick = () => window.VellumState.set({ mode: 'highlight' });

highlightToolbar.appendChild(modePen);
highlightToolbar.appendChild(modeHighlighter);

const divider = document.createElement('div');
divider.className = 'vellum-toolbar-divider';
highlightToolbar.appendChild(divider);

// Color UI
const themes = {
  'vellum-theme-yellow': 'rgb(255, 235, 59)',
  'vellum-theme-green': 'rgb(76, 175, 80)',
  'vellum-theme-blue': 'rgb(33, 150, 243)',
  'vellum-theme-pink': 'rgb(233, 30, 99)',
  'vellum-theme-black': '#111'
};

const swatches = {};
for (const [themeClass, colorHex] of Object.entries(themes)) {
  const swatch = document.createElement('div');
  swatch.className = 'vellum-color-swatch';
  swatch.style.backgroundColor = colorHex;
  // Black swatch: tooltip only — appearance is identical to other swatches.
  if (themeClass === 'vellum-theme-black') {
    swatch.title = 'Redact (great for sharing screenshots without sensitive info)';
  }
  swatch.onclick = () => window.VellumState.set({ color: themeClass });
  swatches[themeClass] = swatch;
  highlightToolbar.appendChild(swatch);
}

// Global VellumState Subscription — single place that owns cursor and toolbar state
// for ALL modes. Eraser and sticky manage their own overlays but delegate cursor here.
window.VellumState.subscribe(state => {
  // Toolbar is only visible in highlight/pen modes — not eraser or sticky.
  const showToolbar = state.mode === 'highlight' || state.mode === 'pen';
  highlightToolbar.style.display = showToolbar ? 'flex' : 'none';

  // Central cursor management for every mode.
  switch (state.mode) {
    case 'highlight': document.body.style.cursor = 'text'; break;
    case 'pen': document.body.style.cursor = 'crosshair'; break;
    case 'eraser': document.body.style.cursor = 'crosshair'; break;
    case 'sticky': document.body.style.cursor = 'crosshair'; break;
    default: document.body.style.cursor = ''; break; // null — no tool
  }

  // Update mode button active states
  modePen.classList.toggle('active', state.mode === 'pen');
  modeHighlighter.classList.toggle('active', state.mode === 'highlight');

  Object.values(swatches).forEach(s => s.classList.remove('active'));
  if (swatches[state.color]) swatches[state.color].classList.add('active');
});

let areHighlightsVisible = true;

// Keyboard shortcut / popup toggle — switches to highlight mode, or off if already active.
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-highlighter') {
    window.VellumState.set({ mode: window.VellumState.mode === 'highlight' ? null : 'highlight' });
  }

  if (request.action === 'toggle-view') {
    areHighlightsVisible = !areHighlightsVisible;

    // Fallback overlay divs: standard display toggle.
    document.querySelectorAll('.vellum-highlight-fallback').forEach(el => {
      el.style.display = areHighlightsVisible ? '' : 'none';
    });

    // CSS Custom Highlights can't be toggled via display — inject/remove a stylesheet
    // that overrides every theme's background-color to transparent when hidden.
    const SHEET_ID = 'vellum-highlights-hidden';
    const existingSheet = document.getElementById(SHEET_ID);
    if (!areHighlightsVisible && !existingSheet) {
      const style = document.createElement('style');
      style.id = SHEET_ID;
      style.textContent = `
        ::highlight(vellum-theme-yellow) { background-color: transparent !important; }
        ::highlight(vellum-theme-green)  { background-color: transparent !important; }
        ::highlight(vellum-theme-blue)   { background-color: transparent !important; }
        ::highlight(vellum-theme-pink)   { background-color: transparent !important; }
        ::highlight(vellum-theme-black)  { background-color: transparent !important; color: inherit !important; }
      `;
      document.head.appendChild(style);
    } else if (areHighlightsVisible && existingSheet) {
      existingSheet.remove();
    }
  }
});

// Escape always fully deactivates whichever tool is running.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && window.VellumState.isVisible) {
    window.VellumState.set({ mode: null });
  }
});

function getOccurrenceIndex(range, anchorElement) {
  const preSelectionRange = range.cloneRange();
  try {
    preSelectionRange.selectNodeContents(anchorElement);
    preSelectionRange.setEnd(range.startContainer, range.startOffset);
  } catch (e) {
    return 0;
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
  if (window.VellumState.mode !== 'highlight') return;

  if (e.target.closest('#vellum-highlighter-widget')) return;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    return; // Do nothing on standard clicks, allow double-clicks to form selections safely.
  }

  const range = selection.getRangeAt(0);
  const text = range.toString().trim();
  if (!text) return;

  let anchorElement = range.commonAncestorContainer;
  if (anchorElement.nodeType !== Node.ELEMENT_NODE) {
    anchorElement = anchorElement.parentNode;
  }

  const blockElement = anchorElement.closest('p, div, section, article, main, li, h1, h2, h3, h4, td') || document.body;

  const anchor = window.FuzzyAnchor.generate(blockElement);
  anchor._id = Date.now() + Math.random().toString();

  const payload = {
    ...anchor,
    action: 'HIGHLIGHT',
    text: range.toString(),
    occurrenceIndex: getOccurrenceIndex(range, blockElement),
    color: window.VellumState.color,
    attachedNoteId: null
  };

  if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
    const registry = highlightRegistries[window.VellumState.color];
    if (registry) {
      try {
        // Keep a ref to the cloned range so undo can delete it from the registry.
        const clonedRange = range.cloneRange();
        registry.add(clonedRange);
        payload._clonedRange = clonedRange;
      } catch (e) {
        console.warn("Vellum: CSS Highlight API rejected range, likely crossing a Shadow DOM boundary. Range:", range);
        payload.isFallback = true;
        const box = blockElement.getBoundingClientRect();
        payload.fallbackRects = Array.from(range.getClientRects()).map(r => ({
          left: ((r.left - box.left) / box.width) * 100,
          top: ((r.top - box.top) / box.height) * 100,
          width: (r.width / box.width) * 100,
          height: (r.height / box.height) * 100
        }));
        if (window.VellumHighlighter && window.VellumHighlighter.renderFallback) {
          window.VellumHighlighter.renderFallback(blockElement, payload);
        }
      }
    }
  }

  try {
    selection.removeAllRanges();
  } catch (e) { }

  if (window.VellumStorage) {
    await window.VellumStorage.saveAnchor(location.hostname, location.pathname, payload);
  }

  // Push to the central undo stack so Ctrl+Z can remove this highlight.
  const capturedId = anchor._id;
  const capturedColor = window.VellumState.color;
  const capturedRange = payload._clonedRange || null;
  const capturedFallback = payload.isFallback || false;
  window.VellumUndo.push({
    undo: async () => {
      if (capturedFallback) {
        const fallbackEl = document.querySelector(`.vellum-highlight-fallback[data-highlight-id="${capturedId}"]`);
        if (fallbackEl) fallbackEl.remove();
      } else if (capturedRange) {
        highlightRegistries[capturedColor]?.delete(capturedRange);
      }
      if (window.VellumStorage) {
        await window.VellumStorage.deleteItem(location.hostname, '_id', capturedId);
      }
    }
  });
});

window.VellumHighlighter = {
  renderFallback: function (anchorElement, payload) {
    if (!payload.fallbackRects) return;
    const themeColors = {
      'vellum-theme-yellow': 'rgba(255, 235, 59, 0.4)',
      'vellum-theme-green': 'rgba(76, 175, 80, 0.4)',
      'vellum-theme-blue': 'rgba(33, 150, 243, 0.4)',
      'vellum-theme-pink': 'rgba(233, 30, 99, 0.4)',
      // Redaction: fully opaque, no blend mode — must completely cover the text.
      'vellum-theme-black': '#000'
    };
    const isSolidRedaction = payload.color === 'vellum-theme-black';

    const wrapper = document.createElement('div');
    wrapper.className = 'vellum-highlight-fallback';
    wrapper.dataset.highlightId = payload._id; // Needed for undo lookup.
    wrapper.style.position = 'absolute';
    wrapper.style.pointerEvents = 'none';
    wrapper.style.zIndex = '2147483640';
    document.documentElement.appendChild(wrapper);

    payload.fallbackRects.forEach(rect => {
      const div = document.createElement('div');
      div.style.position = 'absolute';
      div.style.backgroundColor = themeColors[payload.color] || themeColors['vellum-theme-yellow'];
      // Redaction must be fully opaque — mix-blend-mode: multiply lets the text bleed through.
      if (!isSolidRedaction) div.style.mixBlendMode = 'multiply';
      wrapper.appendChild(div);
    });

    function syncBounds() {
      if (!wrapper.parentNode) return;
      const box = anchorElement.getBoundingClientRect();
      const children = wrapper.children;
      for (let i = 0; i < children.length; i++) {
        const r = payload.fallbackRects[i];
        children[i].style.left = `${box.left + window.pageXOffset + (r.left / 100) * box.width}px`;
        children[i].style.top = `${box.top + window.pageYOffset + (r.top / 100) * box.height}px`;
        children[i].style.width = `${(r.width / 100) * box.width}px`;
        children[i].style.height = `${(r.height / 100) * box.height}px`;
      }
    }

    syncBounds();
    window.addEventListener('resize', syncBounds);
    // Bug 4 fix: Re-sync on scroll so fallback highlight rects don't drift on long pages.
    window.addEventListener('scroll', syncBounds, { passive: true });
    const observer = new ResizeObserver(() => syncBounds());
    observer.observe(anchorElement);
  },

  applyStoredHighlight: function (anchorElement, payload) {
    if (payload.isFallback && payload.fallbackRects) {
      this.renderFallback(anchorElement, payload);
      return true;
    }

    if (typeof CSS === 'undefined' || !('highlights' in CSS)) return false;

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
