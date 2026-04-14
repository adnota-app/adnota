// content/eraser.js

// ─── Hover overlay ────────────────────────────────────────────────────────────
const highlightOverlay = document.createElement('div');
highlightOverlay.id = 'vellum-highlight-overlay';
Object.assign(highlightOverlay.style, {
  position: 'absolute',
  pointerEvents: 'none',
  border: '2px solid red',
  backgroundColor: 'rgba(255, 0, 0, 0.07)',
  zIndex: '999999',
  transition: 'all 0.08s ease',
  display: 'none',
  borderRadius: '2px',
});
document.documentElement.appendChild(highlightOverlay);

// ─── DOM Inspector panel ─────────────────────────────────────────────────────
const inspectorPanel = document.createElement('div');
inspectorPanel.id = 'vellum-eraser-inspector';
inspectorPanel.setAttribute('data-vellum-ui', '1');
Object.assign(inspectorPanel.style, {
  position: 'fixed',
  // bottom: '12px',
  top: '150px',
  left: '12px',
  maxWidth: '460px',
  maxHeight: '45vh',
  overflowY: 'auto',
  background: 'rgba(15, 15, 15, 0.92)',
  backdropFilter: 'blur(8px)',
  color: '#e4e4e7',
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  fontSize: '11.5px',
  lineHeight: '1.45',
  padding: '10px 12px',
  borderRadius: '8px',
  border: '1px solid rgba(124, 58, 237, 0.45)',
  boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
  zIndex: '2147483646',
  pointerEvents: 'none',
  display: 'none',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
});
document.documentElement.appendChild(inspectorPanel);

function buildAncestorChain(el, maxDepth) {
  const chain = [];
  let cur = el;
  for (let i = 0; i < maxDepth && cur && cur !== document.documentElement; i++) {
    let label = cur.tagName.toLowerCase();
    if (cur.id) label += '#' + cur.id;
    else if (cur.classList.length) label += '.' + Array.from(cur.classList).slice(0, 2).join('.');
    chain.push(label);
    cur = cur.parentElement;
  }
  return chain;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Ad signal detection ─────────────────────────────────────────────────────
// Lightweight heuristics to flag elements that look like ad infrastructure.
// Not blocking anything — just informing the user's scroll-wheel decision.
const _adKeywordPattern = /\bad[s]?\b|ad[-_]|[-_]ad\b|advert|banner|sponsor|promo|dfp|prebid|adsense|doubleclick|freestar|taboola|outbrain|criteo|pubmatic/i;
const _adNetworkAttrs = ['data-freestar-ad', 'data-google-query-id', 'data-ad-slot',
  'data-ad-client', 'data-adunit', 'data-ad', 'data-dfp', 'data-zone'];

/** Quick check: does a single element (not its subtree) have ad fingerprints? */
function hasAdFingerprint(el) {
  const idAndClass = (el.id || '') + ' ' + (el.className || '');
  if (_adKeywordPattern.test(idAndClass)) return true;
  for (const a of _adNetworkAttrs) {
    if (el.hasAttribute(a)) return true;
  }
  if (el.tagName === 'IFRAME') return true;
  return false;
}

function detectAdSignals(el) {
  const signals = [];
  const outerHTML = el.outerHTML.slice(0, 2000); // cap scan length

  // Check the element itself
  const idAndClass = (el.id || '') + ' ' + (el.className || '');
  if (_adKeywordPattern.test(idAndClass)) signals.push('ad-keyword');

  // Check attributes for ad network fingerprints
  for (const a of _adNetworkAttrs) {
    if (el.hasAttribute(a)) { signals.push('ad-network'); break; }
  }

  // Contains iframe (common ad delivery mechanism)
  if (el.querySelector('iframe')) signals.push('iframe');

  // Contains iframe pointing to ad domain or about:blank
  const iframes = el.querySelectorAll('iframe');
  for (const iframe of iframes) {
    const src = iframe.getAttribute('src') || '';
    if (!src || src === 'about:blank' || _adKeywordPattern.test(src)) {
      signals.push('ad-iframe');
      break;
    }
  }

  // Fixed/sticky positioning + high z-index (popup/overlay pattern)
  const style = getComputedStyle(el);
  if ((style.position === 'fixed' || style.position === 'sticky') &&
      parseInt(style.zIndex, 10) > 999) {
    signals.push('popup');
  }

  // Inline ad script markers in subtree HTML
  if (/prebid|header.?bidding|googletag|adsbygoogle|__ads/i.test(outerHTML)) {
    signals.push('ad-script');
  }

  return [...new Set(signals)]; // dedupe
}

// ─── Erase target quality scoring ───────────────────────────────────────────
// Combines anchorability (how reliably FuzzyAnchor re-finds it) with erase
// safety (is this scoped to unwanted content, or will it nuke real stuff?).
// The highest ad-scoped container with a stable anchor wins.

/**
 * Check what fraction of an element's direct children look like ad infrastructure.
 * Returns { adChildren, totalChildren, ratio }.
 */
function getSubtreeAdDensity(el) {
  const children = Array.from(el.children);
  // Skip trivial wrappers (0-1 children aren't meaningful for density)
  if (children.length <= 1) {
    // For single-child wrappers, check if the subtree as a whole smells like an ad
    const hasAd = hasAdFingerprint(el) || el.querySelector('iframe') !== null ||
                  _adKeywordPattern.test((el.innerHTML || '').slice(0, 1000));
    return { adChildren: hasAd ? 1 : 0, totalChildren: 1, ratio: hasAd ? 1 : 0 };
  }

  let adCount = 0;
  for (const child of children) {
    // A child counts as "ad-related" if it or any of its subtree has ad fingerprints
    if (hasAdFingerprint(child)) { adCount++; continue; }
    // Check one level deeper for nested ad wrappers
    if (child.querySelector('iframe, [data-freestar-ad], [data-ad-slot], [data-google-query-id]')) {
      adCount++;
      continue;
    }
    // Also check if child's id/class subtree matches ad patterns
    const childHtml = (child.id || '') + ' ' + (child.className || '');
    if (_adKeywordPattern.test(childHtml)) { adCount++; continue; }
    // script and style tags inside ad containers are infrastructure, not content
    if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'LINK') {
      adCount++;
    }
  }

  return {
    adChildren: adCount,
    totalChildren: children.length,
    ratio: children.length > 0 ? adCount / children.length : 0,
  };
}

function getAnchorStrength(el) {
  if (!window.FuzzyAnchor) return { score: 0, reasons: [] };

  let score = 0;
  const reasons = [];

  // ── Anchorability signals (how findable is this element?) ──

  // Stable unique ID (strongest signal)
  if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) {
    try {
      if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
        score += 35;
        reasons.push('unique #id');
      }
    } catch { }
  }

  // Stable class combination
  const stableClasses = Array.from(el.classList)
    .filter(c => !c.startsWith('vellum-') && /^[a-zA-Z][\w-]*$/.test(c) && !window.FuzzyAnchor._autoClassPattern.test(c));
  if (stableClasses.length > 0) {
    const sel = el.tagName.toLowerCase() + '.' + stableClasses.map(c => CSS.escape(c)).join('.');
    try {
      const count = document.querySelectorAll(sel).length;
      if (count === 1) { score += 25; reasons.push('unique class combo'); }
      else if (count <= 3) { score += 12; reasons.push(`class combo (${count} matches)`); }
    } catch { }
  }

  // Stable attributes
  for (const attr of ['data-testid', 'data-id', 'role', 'name']) {
    if (el.getAttribute(attr)) { score += 8; reasons.push(attr); break; }
  }

  // Parent has stable ID (structural anchor)
  const parent = el.parentElement;
  if (parent && parent.id && /^[a-zA-Z][\w-]*$/.test(parent.id)) {
    score += 7;
    reasons.push('parent has #id');
  }

  // ── Erase quality signals (is this the right thing to erase?) ──

  const adSignals = detectAdSignals(el);

  if (adSignals.length > 0) {
    // Element itself has ad signals — good erase candidate
    score += 10;
    reasons.push('has ad signals');

    // Check subtree: is this element scoped to ad content?
    const density = getSubtreeAdDensity(el);
    if (density.ratio >= 0.8) {
      // Nearly all children are ad infrastructure — this IS the ad container
      score += 15;
      reasons.push(`ad-scoped (${density.adChildren}/${density.totalChildren})`);
    } else if (density.ratio >= 0.5) {
      // Mixed content — partial bonus, warn user
      score += 5;
      reasons.push(`mixed (${density.adChildren}/${density.totalChildren} ad)`);
    }
    // ratio < 0.5 → mostly real content with some ad children → no bonus
  }

  return { score: Math.min(100, score), reasons };
}

// ─── Better-target nudge ─────────────────────────────────────────────────────
// Walk up the DOM looking for the highest parent that's still ad-scoped and
// has a stronger anchor. Stops when a parent has too much non-ad content
// (erasing it would be collateral damage).
function findBetterTarget(el) {
  let cur = el.parentElement;
  const self = getAnchorStrength(el);
  let stepsUp = 0;
  let bestCandidate = null;

  while (cur && cur !== document.body && cur !== document.documentElement && stepsUp < 6) {
    stepsUp++;
    if (isVellumElement(cur)) { cur = cur.parentElement; continue; }

    const parentStrength = getAnchorStrength(cur);

    // If parent has ad signals and is still ad-scoped, it could be a better target
    const parentAdSignals = detectAdSignals(cur);
    const parentDensity = getSubtreeAdDensity(cur);

    if (parentStrength.score > self.score) {
      // Parent is stronger — check if it's safe to erase
      if (parentAdSignals.length > 0 && parentDensity.ratio >= 0.5) {
        // Parent is ad-related and mostly ad content — good candidate
        let label = cur.tagName.toLowerCase();
        if (cur.id) label += '#' + cur.id;
        else if (cur.classList.length) label += '.' + Array.from(cur.classList).slice(0, 2).join('.');
        bestCandidate = { label, stepsUp, score: parentStrength.score };
        // Keep walking — there might be an even better (higher) container
      } else if (parentDensity.ratio < 0.5 && parentAdSignals.length === 0) {
        // Parent is mostly real content — stop here, going higher is dangerous
        break;
      }
    }
    cur = cur.parentElement;
  }
  return bestCandidate;
}

function updateInspector(target) {
  if (!target) {
    inspectorPanel.style.display = 'none';
    return;
  }
  inspectorPanel.style.display = 'block';

  const tag = target.tagName.toLowerCase();
  const id = target.id ? `#${target.id}` : '';
  const classes = Array.from(target.classList);
  const rect = target.getBoundingClientRect();
  const childCount = target.children.length;

  // DOM depth
  let depth = 0;
  let cur = target;
  while (cur && cur !== document.body) { depth++; cur = cur.parentElement; }

  // Ancestor chain (target → ... → body)
  const chain = buildAncestorChain(target, 6);

  // CSS selector that FuzzyAnchor would generate
  const selector = window.FuzzyAnchor
    ? window.FuzzyAnchor.generateCSSSelector(target)
    : '(fuzzyAnchor not loaded)';

  // Stable attributes present on this element
  const stableAttrs = ['data-testid', 'data-id', 'data-name', 'data-type',
    'data-slot', 'data-section', 'role', 'aria-label', 'name', 'alt', 'title'];
  const attrs = [];
  for (const a of stableAttrs) {
    const v = target.getAttribute(a);
    if (v) attrs.push(`${a}="${v}"`);
  }

  // Anchor strength & ad signals
  const anchor = getAnchorStrength(target);
  const adSignals = detectAdSignals(target);
  const betterTarget = findBetterTarget(target);

  // Build display
  const sColor = 'color:#c084fc';    // purple
  const dColor = 'color:#60a5fa';    // blue
  const gColor = 'color:#6ee7b7';    // green
  const mColor = 'color:#94a3b8';    // muted
  const wColor = 'color:#fbbf24';    // amber
  const rColor = 'color:#f87171';    // red

  let html = '';

  // Line 1: element signature + anchor strength bar
  html += `<span style="${sColor};font-weight:600">&lt;${tag}${escapeHtml(id)}&gt;</span>`;
  html += `  <span style="${mColor}">${Math.round(rect.width)}×${Math.round(rect.height)}px</span>`;
  html += `  <span style="${mColor}">depth ${depth}</span>`;
  html += `  <span style="${mColor}">${childCount} child${childCount !== 1 ? 'ren' : ''}</span>\n`;

  // Line 2: anchor strength
  const barFull = 10;
  const barFilled = Math.round((anchor.score / 100) * barFull);
  const barColor = anchor.score >= 60 ? gColor : anchor.score >= 30 ? wColor : rColor;
  const bar = '\u2588'.repeat(barFilled) + '\u2591'.repeat(barFull - barFilled);
  html += `<span style="${barColor}">anc</span>  `;
  html += `<span style="${barColor}">${bar} ${anchor.score}/100</span>`;
  if (anchor.reasons.length > 0) {
    html += `  <span style="${mColor}">${escapeHtml(anchor.reasons.join(', '))}</span>`;
  }
  html += '\n';

  // Line 3: ad signal badges (only if any detected)
  if (adSignals.length > 0) {
    html += `<span style="${rColor}">sig</span>  `;
    for (const s of adSignals) {
      html += `<span style="background:rgba(239,68,68,0.18);color:#fca5a5;padding:0 4px;border-radius:3px;margin-right:4px">${escapeHtml(s)}</span>`;
    }
    html += '\n';
  }

  // Line 4: classes
  if (classes.length > 0) {
    html += `<span style="${dColor}">cls</span>  `;
    html += `<span style="${mColor}">${escapeHtml(classes.join('  '))}</span>\n`;
  }

  // Line 5: stable attributes
  if (attrs.length > 0) {
    html += `<span style="${gColor}">attr</span> `;
    html += `<span style="${mColor}">${escapeHtml(attrs.join('  '))}</span>\n`;
  }

  // Line 6: ancestor chain
  html += `<span style="${wColor}">dom</span>  `;
  html += `<span style="${mColor}">${escapeHtml(chain.join('  ›  '))}</span>\n`;

  // Line 7: CSS selector
  html += `<span style="${sColor}">sel</span>  `;
  html += `<span style="color:#f0abfc">${escapeHtml(selector)}</span>\n`;

  // Line 8: better target nudge (if available)
  if (betterTarget) {
    html += `<span style="${gColor}">  ▲  scroll up ${betterTarget.stepsUp}×  →  </span>`;
    html += `<span style="${gColor};font-weight:600">&lt;${escapeHtml(betterTarget.label)}&gt;</span>`;
    html += `  <span style="${gColor}">anchor ${betterTarget.score}/100</span>\n`;
  }

  // Line 9: traverse depth indicator
  html += `<span style="${mColor}">scroll ↑↓ to traverse  ·  depth offset: ${traverseDepth}</span>`;

  inspectorPanel.innerHTML = html;
}

let hoveredElement = null;
let rawHoveredEl = null;     // actual element under cursor (before traversal)
let traverseDepth = 0;       // 0 = raw element, >0 = walked up N parents
let areErasuresVisible = true;

// Shared set of erased elements — restorer.js also adds to this.
window.VellumErasedElements = new Set();

// ─── CSS rule injection for persistent erasure ──────────────────────────────
// Erased elements get a CSS rule so that if the element is destroyed and re-created
// (e.g. ad rotation timers), the browser automatically hides the new instance.
window.VellumEraseRules = new Map(); // id → cssSelector

function getOrCreateEraseStyleTag() {
  let tag = document.getElementById('vellum-erase-overrides');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'vellum-erase-overrides';
    tag.setAttribute('data-vellum-ui', '1');
    document.head.appendChild(tag);
  }
  return tag;
}

function rebuildEraseStyleTag() {
  const tag = getOrCreateEraseStyleTag();
  const rules = [];
  for (const [, selector] of window.VellumEraseRules) {
    rules.push(`${selector} { display: none !important; }`);
  }
  tag.textContent = rules.join('\n');
}
window.rebuildEraseStyleTag = rebuildEraseStyleTag;

// ─── Guard: Vellum-owned elements are invisible to the eraser ─────────────────
function isVellumElement(el) {
  if (!el) return false;
  return !!(
    el.closest('[data-vellum-ui]') ||
    el.closest('#vellum-highlighter-widget') ||
    el.closest('#vellum-eraser-toast') ||
    el.closest('.vellum-toast') ||
    el.closest('.vellum-sticky-container') ||
    el.closest('.vellum-marker-wrapper') ||
    el.closest('#vellum-capture-canvas') ||
    el.closest('#vellum-highlight-overlay')
  );
}

// ─── DOM traversal: walk up N parents, skip Vellum elements ─────────────────
function getEraserTarget(raw, depth) {
  if (!raw || isVellumElement(raw)) return null;
  let current = raw;
  let walked = 0;
  while (walked < depth && current.parentElement &&
    current.parentElement !== document.body &&
    current.parentElement !== document.documentElement) {
    current = current.parentElement;
    if (isVellumElement(current)) return null;
    walked++;
  }
  return current;
}

function updateEraserOverlay() {
  const target = getEraserTarget(rawHoveredEl, traverseDepth);
  if (target) {
    hoveredElement = target;
    const rect = target.getBoundingClientRect();
    const scrollY = window.pageYOffset || document.documentElement.scrollTop;
    const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
    Object.assign(highlightOverlay.style, {
      display: 'block',
      top: `${rect.top + scrollY}px`,
      left: `${rect.left + scrollX}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    updateInspector(target);
  } else {
    hoveredElement = null;
    highlightOverlay.style.display = 'none';
    updateInspector(null);
  }
}

// ─── Animation helpers ────────────────────────────────────────────────────────

function spawnRipples(x, y) {
  // Reserved for future re-enablement.
}

/**
 * Momentary red-tinted border flash that traces the element's bounding box.
 */
function spawnFlash(rect) {
  const flash = document.createElement('div');
  flash.setAttribute('data-vellum-ui', '1');
  Object.assign(flash.style, {
    position: 'fixed',
    left: rect.left + 'px',
    top: rect.top + 'px',
    width: rect.width + 'px',
    height: rect.height + 'px',
    background: 'rgba(239,68,68,0.09)',
    border: '10px solid rgba(239,68,68,0.25)',
    borderRadius: '3px',
    pointerEvents: 'none',
    zIndex: '2147483646',
    boxSizing: 'border-box',
  });
  document.documentElement.appendChild(flash);

  flash.animate([
    { opacity: 1 },
    { opacity: 0 }
  ], { duration: 260, easing: 'ease-out' })
    .finished.then(() => flash.remove()).catch(() => { });
}

/**
 * Dissolve animation on the target element itself.
 */
function dissolveTarget(target) {
  return target.animate([
    { opacity: '1', transform: 'scale(1)', filter: 'blur(0px)' },
    { opacity: '.92', transform: 'scale(1.03)', filter: 'blur(0px)', offset: 0.12 },
    { opacity: '0.4', transform: 'scale(0.97)', filter: 'blur(2.5px)', offset: 0.50 },
    { opacity: '0', transform: 'scale(0.8) translateY(6px)', filter: 'blur(9px)' }
  ], {
    duration: 440,
    easing: 'ease-in',
    fill: 'forwards',
  });
}

// ─── Message routing ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggle-eraser') {
    window.VellumState.set({ mode: window.VellumState.mode === 'eraser' ? null : 'eraser' });
  }

  if (request.action === 'toggle-view') {
    areErasuresVisible = !areErasuresVisible;
    for (const el of window.VellumErasedElements) {
      if (areErasuresVisible) {
        el.style.setProperty('display', 'none', 'important');
      } else {
        el.style.removeProperty('display');
      }
    }
    // Also toggle the CSS rule style tag (covers re-created elements like ads)
    const eraseTag = document.getElementById('vellum-erase-overrides');
    if (eraseTag) eraseTag.disabled = !areErasuresVisible;
  }
});

// ─── Seed erase visibility from storage on load ─────────────────────────────
chrome.storage.local.get(['vellumHidden'], (result) => {
  if (result.vellumHidden) {
    areErasuresVisible = false;
    const eraseTag = document.getElementById('vellum-erase-overrides');
    if (eraseTag) eraseTag.disabled = true;
  }
});

// ─── React to mode changes ────────────────────────────────────────────────────
window.VellumState.subscribe(state => {
  if (state.mode !== 'eraser') {
    highlightOverlay.style.display = 'none';
    inspectorPanel.style.display = 'none';
    hoveredElement = null;
    rawHoveredEl = null;
    traverseDepth = 0;
  }
});

// ─── Hover: track raw element and update overlay ─────────────────────────────
document.addEventListener('mousemove', (e) => {
  if (window.VellumState.mode !== 'eraser') return;
  const raw = document.elementFromPoint(e.clientX, e.clientY);

  if (!raw || isVellumElement(raw)) {
    hoveredElement = null;
    rawHoveredEl = null;
    highlightOverlay.style.display = 'none';
    updateInspector(null);
    return;
  }

  // Reset traverse depth when cursor moves to a different element
  if (raw !== rawHoveredEl) {
    rawHoveredEl = raw;
    traverseDepth = 0;
  }

  updateEraserOverlay();
}, { passive: true });

// ─── Scroll wheel: walk up/down the DOM tree while hovering ─────────────────
document.addEventListener('wheel', (e) => {
  if (window.VellumState.mode !== 'eraser') return;
  if (!rawHoveredEl) return;

  e.preventDefault();

  if (e.deltaY < 0) {
    // Scroll up → walk to parent
    traverseDepth++;
  } else {
    // Scroll down → walk back toward child
    traverseDepth = Math.max(0, traverseDepth - 1);
  }

  updateEraserOverlay();
}, { passive: false });

// ─── Click: erase with animation ─────────────────────────────────────────────
document.addEventListener('click', async (e) => {
  if (window.VellumState.mode !== 'eraser') return;
  if (isVellumElement(e.target)) return;
  if (!hoveredElement) return;

  e.preventDefault();
  e.stopPropagation();

  const target = hoveredElement;
  const rect = target.getBoundingClientRect();
  const savedCssText = target.style.cssText;

  // Capture anchor before any DOM mutation.
  const anchor = window.FuzzyAnchor.generate(target);
  const cssSelector = window.FuzzyAnchor.generateCSSSelector(target);
  const pathScope = e.shiftKey ? '*' : location.pathname;
  const domain = location.hostname;
  const id = Date.now() + Math.random().toString();

  // Inject CSS rule so the element stays hidden even if re-created (ad rotation, etc.)
  window.VellumEraseRules.set(id, cssSelector);
  rebuildEraseStyleTag();

  highlightOverlay.style.display = 'none';
  updateInspector(null);
  hoveredElement = null;

  // ── Fire all three animation effects in parallel ──
  spawnRipples(e.clientX, e.clientY);
  spawnFlash(rect);
  let activeAnimation = dissolveTarget(target);

  // After dissolve completes → apply permanent display:none.
  let consumed = false;
  activeAnimation.finished.then(() => {
    if (!consumed) {
      target.style.setProperty('display', 'none', 'important');
      window.VellumErasedElements.add(target);
      try { activeAnimation.cancel(); } catch { }
      activeAnimation = null;
    }
  }).catch(() => {
    // Animation was cancelled by undo — do nothing.
  });

  // Save to storage immediately (don't block the animation on I/O).
  if (window.VellumStorage) {
    window.VellumStorage.saveItem(domain, pathScope, { action: 'ERASE', anchor, selector: cssSelector, _id: id }).catch(() => { });
  }

  // ── Shared undo closure — used by both toast button and Ctrl+Z ──
  const undoEntry = {
    undo: async () => {
      if (consumed) return;
      consumed = true;

      // Kill the dissolve if it's still mid-flight.
      if (activeAnimation) {
        try { activeAnimation.cancel(); } catch { }
        activeAnimation = null;
      }

      // Restore element to exactly where it was.
      target.style.cssText = savedCssText;
      window.VellumErasedElements.delete(target);

      // Remove the CSS rule that prevents re-creation.
      window.VellumEraseRules.delete(id);
      rebuildEraseStyleTag();

      // Delete the erasure record from storage.
      if (window.VellumStorage) {
        const data = await chrome.storage.local.get(domain);
        if (data[domain]) {
          data[domain].items = data[domain].items.filter(i => i._id !== id);
          await chrome.storage.local.set({ [domain]: data[domain] });
        }
      }

      window.VellumUndo.remove(undoEntry);
    }
  };
  window.VellumUndo.push(undoEntry);

  // ── Toast ──
  let existingToast = document.getElementById('vellum-eraser-toast');
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.id = 'vellum-eraser-toast';
  toast.className = 'vellum-toast';
  toast.setAttribute('data-vellum-ui', '1');
  toast.innerHTML = `
    <div class="vellum-toast-logo">V</div>
    <span class="vellum-toast-message">Element erased</span>
    <div class="vellum-toast-actions">
      <span class="vellum-toast-undo">Undo</span>
    </div>
  `;
  document.body.appendChild(toast);

  toast.querySelector('.vellum-toast-undo').addEventListener('click', () => {
    undoEntry.undo();
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  });

  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }
  }, 5000);

}, true); // Capture phase — intercept before the page's own handlers.
