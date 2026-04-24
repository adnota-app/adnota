// content/eraser.js

// ─── Hover overlay ────────────────────────────────────────────────────────────
const highlightOverlay = window.VellumUI.createHoverOverlay('vellum-highlight-overlay', '#ef4444', 'rgba(239, 68, 68, 0.15)');

// ─── Dimension badge (top-right corner of hover outline) ─────────────────────
const dimensionBadge = document.createElement('div');
dimensionBadge.id = 'vellum-dimension-badge';
dimensionBadge.setAttribute('data-vellum-ui', '1');
Object.assign(dimensionBadge.style, {
  position: 'absolute',
  top: '-1px',
  right: '-1px',
  transform: 'translateY(-100%)',
  background: 'rgba(15, 15, 15, 0.85)',
  color: '#e4e4e7',
  fontSize: '10px',
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  lineHeight: '1',
  padding: '2px 6px',
  borderRadius: '3px 3px 0 3px',
  whiteSpace: 'nowrap',
});
highlightOverlay.appendChild(dimensionBadge);

// ─── HUD body (mounts into the unified VellumDock on activation) ───────────
// The dock owns the chrome (drag handle, V logo, radial menu, position).
// The eraser owns its controls — info strip + trash + undo — built once
// and mounted into the dock body slot when the tool is active.
const eraserBody = document.createElement('div');
eraserBody.style.display = 'inline-flex';
eraserBody.style.alignItems = 'center';

// Info section (dynamic — updated on hover)
const eraserHudInfo = document.createElement('span');
eraserHudInfo.id = 'vellum-eraser-hud-info';
eraserHudInfo.style.display = 'inline-flex';
eraserHudInfo.style.alignItems = 'center';
eraserHudInfo.style.minWidth = '220px';
eraserBody.appendChild(eraserHudInfo);

// Divider
eraserBody.appendChild(Object.assign(document.createElement('div'), {
  className: 'vellum-toolbar-divider vellum-toolbar-divider-red',
}));

// Trash — clears all erasures on this page
const eraserTrashBtn = window.VellumUI.createTrashButton({
  singular: 'erasure',
  plural: 'erasures',
  actionTypes: ['ERASE'],
});
eraserTrashBtn.classList.add('vellum-undo-btn-red');
eraserBody.appendChild(eraserTrashBtn);

// Undo
const eraserUndoBtn = window.VellumUI.createUndoButton();
eraserUndoBtn.classList.add('vellum-undo-btn-red');
eraserBody.appendChild(eraserUndoBtn);

// ─── Rotating help tips ─────────────────────────────────────────────────────
const hudTips = [
  '<span style="color:#94a3b8">Click to erase on <span style="color:#e4e4e7;font-weight:600">this page</span></span>',
  '<span style="color:#94a3b8"><span style="background:rgba(124,58,237,0.25);color:#c084fc;padding:1px 4px;border-radius:3px;font-size:11px;font-weight:600;margin-right:4px">\u21e7+Click</span>erase across <span style="color:#e4e4e7;font-weight:600">entire domain</span></span>',
  '<span style="color:#94a3b8">Scroll \u2191\u2193 to <span style="color:#e4e4e7;font-weight:600">traverse DOM</span> (select parents/children)</span>',
  '<span style="color:#94a3b8">Press <span style="background:rgba(124,58,237,0.25);color:#c084fc;padding:1px 4px;border-radius:3px;font-size:11px;font-weight:600;margin-right:2px">Esc</span> to exit eraser</span>',
];
let hudTipIndex = 0;
let hudTipInterval = null;

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

// ─── Visual-root auto-bubble ────────────────────────────────────────────────
// Modern web pages stack visually-redundant wrapper divs. Bubbling past them to
// the outermost same-sized parent picks a better anchor and spares users the
// scroll-wheel walk. Manual scroll still walks further from this baseline.
// Actual bubble/viewport logic lives in VellumUI — shared with the resizer.
const dominatesViewport = window.VellumUI.dominatesViewport;
// Scroll-up nudge won't suggest a parent that's this many times larger than
// the element the user is actually hovering — at that point we've walked past
// the ad and into real content regardless of what the ad-density heuristic says.
const BETTER_TARGET_MAX_AREA_RATIO = 2.0;
// Per-hop growth cap — a single step-up that grows this much usually means
// we've crossed a layout boundary (ad slot → sidebar column, card → grid row).
// The visual-root auto-bubble already nails the starting element most of the
// time, so big jumps between recommended levels are almost always wrong.
const BETTER_TARGET_MAX_HOP_RATIO = 1.5;

// Ad signals used for both HUD display and click-scope decisions. Page-level
// containers are exempt — their subtrees always happen to contain an iframe
// or two, which doesn't make the whole page an ad.
function getEffectiveAdSignals(target) {
  const rect = target.getBoundingClientRect();
  return dominatesViewport(rect) ? [] : detectAdSignals(target);
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
  const selfRect = el.getBoundingClientRect();
  // Already on a viewport-dominating element — any parent is necessarily
  // even larger, so there's no meaningful "better target" to suggest.
  if (dominatesViewport(selfRect)) return null;

  const selfArea = Math.max(1, selfRect.width * selfRect.height);
  let cur = el.parentElement;
  const self = getAnchorStrength(el);
  let stepsUp = 0;
  let bestCandidate = null;
  let prevArea = selfArea;

  while (cur && cur !== document.body && cur !== document.documentElement && stepsUp < 6) {
    stepsUp++;
    if (isVellumElement(cur)) { cur = cur.parentElement; continue; }

    const curRect = cur.getBoundingClientRect();
    const curArea = curRect.width * curRect.height;
    // Page-level containers are never the target — kill the nudge here.
    if (dominatesViewport(curRect)) break;
    // Single-hop grew too much — we crossed out of the ad into layout.
    if (curArea > prevArea * BETTER_TARGET_MAX_HOP_RATIO) break;
    // Total growth from the hovered element is too much even if per-hop was
    // gradual. Absolute ceiling; visual-root bubble means we rarely need many hops.
    if (curArea > selfArea * BETTER_TARGET_MAX_AREA_RATIO) break;

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
    prevArea = curArea;
    cur = cur.parentElement;
  }
  return bestCandidate;
}

function stopHudTips() {
  if (hudTipInterval) { clearInterval(hudTipInterval); hudTipInterval = null; }
}


function updateHUD(target) {
  if (!target) {
    dimensionBadge.textContent = '';
    // Idle state: rotating help tip, no confidence/ad info.
    eraserHudInfo.innerHTML = `<span id="vellum-hud-tip" style="display:inline-block;min-width:180px">${hudTips[hudTipIndex]}</span>`;
    ensureTipRotation();
    return;
  }

  // ── Dimension badge ──
  const rect = target.getBoundingClientRect();
  dimensionBadge.textContent = `${Math.round(rect.width)}\u00d7${Math.round(rect.height)}`;

  // ── HUD info section ──
  const anchor = getAnchorStrength(target);
  const adSignals = getEffectiveAdSignals(target);
  const betterTarget = findBetterTarget(target);

  // Confidence label + color
  let confLabel, confColor;
  if (adSignals.length > 0) {
    confLabel = 'likely ad';
    confColor = '#fca5a5'; // soft red
  } else if (anchor.score >= 70) {
    confLabel = 'strong anchor';
    confColor = '#6ee7b7'; // green
  } else if (anchor.score >= 40) {
    confLabel = 'moderate';
    confColor = '#fbbf24'; // amber
  } else {
    confLabel = 'weak anchor';
    confColor = '#f87171'; // red
  }

  const dot = '<span style="color:#525264;margin:0 8px">\u00b7</span>';

  let html = '';

  // Confidence score
  html += `<span style="color:${confColor};font-weight:600">${anchor.score}/100</span>`;
  html += `<span style="color:${confColor};margin-left:4px">${confLabel}</span>`;

  // Ad signal badges (only when present)
  if (adSignals.length > 0) {
    for (const s of adSignals) {
      html += `<span style="background:rgba(239,68,68,0.18);color:#fca5a5;padding:1px 6px;border-radius:4px;margin-left:6px;font-size:11px">${escapeHtml(s)}</span>`;
    }
  }

  // Scroll nudge (only when a better target exists) — takes priority over rotating tip
  if (betterTarget) {
    html += dot;
    html += `<span style="color:#6ee7b7">\u25b2 Scroll up ${betterTarget.stepsUp}\u00d7 for better target</span>`;
  } else {
    // Rotating help tip
    html += dot;
    html += `<span id="vellum-hud-tip" style="display:inline-block;min-width:180px">${hudTips[hudTipIndex]}</span>`;
  }

  eraserHudInfo.innerHTML = html;
  ensureTipRotation();
}

function ensureTipRotation() {
  if (hudTipInterval) return;
  hudTipInterval = setInterval(() => {
    hudTipIndex = (hudTipIndex + 1) % hudTips.length;
    const tipEl = document.getElementById('vellum-hud-tip');
    if (tipEl) {
      tipEl.style.opacity = '0';
      tipEl.style.transition = 'opacity 0.2s ease';
      setTimeout(() => {
        tipEl.innerHTML = hudTips[hudTipIndex];
        tipEl.style.opacity = '1';
      }, 200);
    }
  }, 4000);
}

// Show/hide the entire HUD shell. Visible whenever eraser mode is active so
// the trash/undo buttons stay reachable even when no element is hovered.
function setHudVisible(visible) {
  if (visible) {
    window.VellumDock.mount('eraser', () => eraserBody);
  } else {
    window.VellumDock.unmount();
  }
}

let hoveredElement = null;
let rawHoveredEl = null;     // actual element under cursor (before traversal)
let traverseDepth = 0;       // 0 = raw element, >0 = walked up N parents

// Shared set of erased elements — restorer.js also adds to this.
// VellumVisibility iterates this set to toggle show/hide on each erased node.
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

// ─── Iframe pointer shield ──────────────────────────────────────────────────
// Cross-origin iframes swallow wheel events — the parent document never sees
// them — so scroll-to-traverse fails and the browser scroll-chains the wheel
// back into the parent page. Disabling pointer-events on every iframe while
// eraser is active routes wheel/click through to the iframe's container in the
// parent doc, which is usually what the user wants to erase anyway.
let iframeShieldStyleTag = null;
function setIframeShield(active) {
  if (active && !iframeShieldStyleTag) {
    iframeShieldStyleTag = document.createElement('style');
    iframeShieldStyleTag.id = 'vellum-iframe-shield';
    iframeShieldStyleTag.setAttribute('data-vellum-ui', '1');
    iframeShieldStyleTag.textContent = 'iframe { pointer-events: none !important; }';
    document.head.appendChild(iframeShieldStyleTag);
  } else if (!active && iframeShieldStyleTag) {
    iframeShieldStyleTag.remove();
    iframeShieldStyleTag = null;
  }
}

// ─── Guard: Vellum-owned elements are invisible to the eraser ─────────────────
const isVellumElement = window.VellumUI.isVellumElement;

// ─── DOM traversal: walk up N parents, skip Vellum elements ─────────────────
// At depth=0, bubble past visually-identical parent wrappers so clicking the
// inner element hits the outer container users almost always actually want.
// Scroll-wheel traversal walks further up from that bubbled baseline.
function getEraserTarget(raw, depth) {
  if (!raw || isVellumElement(raw)) return null;
  let current = window.VellumUI.bubbleToVisualRoot(raw);
  if (isVellumElement(current)) return null;
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
    updateHUD(target);
  } else {
    hoveredElement = null;
    highlightOverlay.style.display = 'none';
    updateHUD(null);
  }
}

// ─── Animation helpers ────────────────────────────────────────────────────────

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
});

// ─── React to mode changes ────────────────────────────────────────────────────
window.VellumState.subscribe(state => {
  const isEraser = state.mode === 'eraser';
  setIframeShield(isEraser);
  if (isEraser) {
    // Show HUD as soon as the tool is active — trash/undo are always reachable.
    setHudVisible(true);
    updateHUD(null);
  } else {
    highlightOverlay.style.display = 'none';
    setHudVisible(false);
    stopHudTips();
    hudTipIndex = 0;
    hoveredElement = null;
    rawHoveredEl = null;
    traverseDepth = 0;
  }
});

// ─── Block page interactions in eraser mode ─────────────────────────────────
// Ads commonly open new tabs from mousedown/pointerdown (before `click` fires),
// which both bypasses our click-capture handler and steals keyboard focus so
// Escape stops working. Intercept the earliest pointer events on window-capture
// and kill them for non-Vellum targets. Right-click is left alone so users can
// still Inspect. Vellum UI (HUD, drag handle, buttons) passes through normally.
function blockPageInteraction(e) {
  if (window.VellumState.mode !== 'eraser') return;
  if (isVellumElement(e.target)) return;
  if (e.button === 2) return;
  e.preventDefault();
  e.stopPropagation();
  // preventDefault blocks the implicit focus transfer, so nothing would bring
  // focus back into our document — pull it home via the shared anchor.
  window.VellumState.anchorFocus?.();
}
window.addEventListener('mousedown', blockPageInteraction, true);
window.addEventListener('pointerdown', blockPageInteraction, true);
window.addEventListener('auxclick', blockPageInteraction, true);

// ─── Hover: track raw element and update overlay ─────────────────────────────
document.addEventListener('mousemove', (e) => {
  if (window.VellumState.mode !== 'eraser') return;
  const raw = document.elementFromPoint(e.clientX, e.clientY);

  if (!raw) {
    hoveredElement = null;
    rawHoveredEl = null;
    highlightOverlay.style.display = 'none';
    updateHUD(null);
    return;
  }

  // When cursor is over Vellum UI (radial menu, HUD, etc.), hide the hover
  // overlay so our own controls aren't visually framed as erase targets.
  if (isVellumElement(raw)) {
    hoveredElement = null;
    rawHoveredEl = null;
    traverseDepth = 0;
    highlightOverlay.style.display = 'none';
    updateHUD(null);
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

  // Always suppress the page's click — no erase target is better than letting
  // an ad navigate. A click without a hovered target (e.g. raced the mousemove)
  // becomes a no-op instead of a page navigation.
  e.preventDefault();
  e.stopPropagation();

  if (!hoveredElement) return;

  const target = hoveredElement;
  const rect = target.getBoundingClientRect();
  const savedCssText = target.style.cssText;

  // Capture anchor before any DOM mutation.
  const anchor = window.FuzzyAnchor.generate(target);
  const cssSelector = window.FuzzyAnchor.generateCSSSelector(target);
  // Shift is the user's explicit "entire domain" override — unchanged behavior.
  // If the target looks like an ad we silently promote the scope to domain-wide
  // too, since nobody wants to erase the same ad on every article. No chip, no
  // messaging; it just works. Non-ad targets still scope to the current page.
  const useDomain = e.shiftKey || getEffectiveAdSignals(target).length > 0;
  const pathScope = useDomain ? '*' : location.pathname;
  const domain = location.hostname;
  const id = Date.now() + Math.random().toString();

  // Inject CSS rule so the element stays hidden even if re-created (ad rotation, etc.)
  window.VellumEraseRules.set(id, cssSelector);
  rebuildEraseStyleTag();

  highlightOverlay.style.display = 'none';
  updateHUD(null);
  hoveredElement = null;

  // ── Fire animation effects in parallel ──
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
  window.VellumUI.showToast('Element erased', {
    id: 'vellum-eraser-toast',
    onUndo: () => undoEntry.undo(),
  });

}, true); // Capture phase — intercept before the page's own handlers.
