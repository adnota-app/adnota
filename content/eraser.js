// content/eraser.js

// ─── Hover overlay ────────────────────────────────────────────────────────────
const highlightOverlay = window.AdnotaUI.createHoverOverlay('adnota-highlight-overlay', '#ef4444', 'rgba(239, 68, 68, 0.15)');

// ─── Top-right badge cluster on the hover outline ───────────────────────────
// Lives where the user's eye already is — the element they're hovering — so
// the most actionable signals (dimensions, "likely ad") don't require a
// glance down at the HUD strip. The cluster is a flex row pinned to the
// outline's top-right; badges sit side by side with consistent height and
// disappear when not relevant.
const overlayBadgeRow = document.createElement('div');
overlayBadgeRow.setAttribute('data-adnota-ui', '1');
Object.assign(overlayBadgeRow.style, {
  position: 'absolute',
  top: '-2px',
  right: '-3px',
  transform: 'translateY(-50%)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
});
highlightOverlay.appendChild(overlayBadgeRow);

// "likely ad" pill — only shown when getEffectiveAdSignals() returns non-empty
// (same detection that drives the silent domain-wide promotion on click).
// Sits to the left of the dimension chip; small text pill, no border.
const adBadge = document.createElement('div');
adBadge.id = 'adnota-ad-badge';
adBadge.setAttribute('data-adnota-ui', '1');
adBadge.textContent = 'likely ad';
Object.assign(adBadge.style, {
  background: 'rgba(220, 38, 38, 0.92)',
  color: '#fff',
  fontSize: '10px',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontWeight: '600',
  lineHeight: '1',
  padding: '3px 6px',
  borderRadius: '4px',
  whiteSpace: 'nowrap',
  display: 'none',
});
overlayBadgeRow.appendChild(adBadge);

// Dimension chip — mirrors the resizer's blue chip in red so the two tools
// share a consistent W×H readout style.
const dimensionBadge = document.createElement('div');
dimensionBadge.id = 'adnota-dimension-badge';
dimensionBadge.setAttribute('data-adnota-ui', '1');
Object.assign(dimensionBadge.style, {
  background: '#ef4444',
  color: '#fff',
  font: '600 11px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  padding: '3px 8px 2px',
  borderRadius: '4px',
  border: '2px solid #fff',
  boxShadow: '0 1px 4px rgba(0, 0, 0, 0.3)',
  whiteSpace: 'nowrap',
});
overlayBadgeRow.appendChild(dimensionBadge);

// ─── HUD body (mounts into the unified AdnotaDock on activation) ───────────
// The dock owns the chrome (drag handle, V logo, tool row, position).
// The eraser owns its controls — info strip + trash + undo — built once
// and mounted into the dock body slot when the tool is active.
const eraserBody = document.createElement('div');
eraserBody.style.display = 'inline-flex';
eraserBody.style.alignItems = 'center';

// Info section (dynamic — updated on hover)
const eraserHudInfo = document.createElement('span');
eraserHudInfo.id = 'adnota-eraser-hud-info';
eraserHudInfo.style.display = 'inline-flex';
eraserHudInfo.style.alignItems = 'center';
eraserHudInfo.style.minWidth = '220px';
eraserBody.appendChild(eraserHudInfo);

// Help (?) button — opens a tail-anchored popover with the full tip list.
// Replaces the old rotating tip; always reachable, no waiting for the right
// tip to cycle around.
const eraserHelpBtn = window.AdnotaUI.createHelpButton({
  accent: 'red',
  tips: [
    '<span style="color:#94a3b8">Click to erase on <span style="color:#e4e4e7;font-weight:600">this page</span></span>',
    '<span style="color:#94a3b8"><span style="background:rgba(239,68,68,0.25);color:#fca5a5;padding:1px 4px;border-radius:3px;font-size:11px;font-weight:600;margin-right:4px">⇧+Click</span>erase across <span style="color:#e4e4e7;font-weight:600">entire domain</span></span>',
    '<span style="color:#94a3b8"><span style="background:rgba(239,68,68,0.25);color:#fca5a5;padding:1px 4px;border-radius:3px;font-size:11px;font-weight:600;margin-right:4px">⇧+Scroll ↑↓</span>to <span style="color:#e4e4e7;font-weight:600">traverse DOM</span> (select parents/children)</span>',
    '<span style="color:#94a3b8">When you see <span style="background:rgba(220,38,38,0.92);color:#fff;padding:1px 5px;border-radius:3px;font-size:11px;font-weight:600">likely ad</span>, erasing it also blocks it across the domain</span>',
    '<span style="color:#94a3b8">Press <span style="background:rgba(239,68,68,0.25);color:#fca5a5;padding:1px 4px;border-radius:3px;font-size:11px;font-weight:600;margin-right:2px">Esc</span> to exit any tool</span>',
  ],
});
eraserHelpBtn.classList.add('adnota-undo-btn-red');
eraserBody.appendChild(eraserHelpBtn);

// Divider
eraserBody.appendChild(Object.assign(document.createElement('div'), {
  className: 'adnota-toolbar-divider adnota-toolbar-divider-red',
}));

// Trash — clears all erasures on this page
const eraserTrashBtn = window.AdnotaUI.createTrashButton({
  singular: 'erasure',
  plural: 'erasures',
  actionTypes: ['ERASE'],
});
eraserTrashBtn.classList.add('adnota-undo-btn-red');
eraserBody.appendChild(eraserTrashBtn);

// Undo
const eraserUndoBtn = window.AdnotaUI.createUndoButton();
eraserUndoBtn.classList.add('adnota-undo-btn-red');
eraserBody.appendChild(eraserUndoBtn);

// ─── Idle-state info label ──────────────────────────────────────────────────
// The full tip list lives behind the ? button in the HUD. IDLE_HUD_LABEL is
// the static placeholder shown in the info section when nothing is hovered.
const IDLE_HUD_LABEL = '<span style="color:#94a3b8">Hover an element to erase</span>';

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Ad signal detection ─────────────────────────────────────────────────────
// Lightweight heuristics to flag elements that look like ad infrastructure.
// Not blocking anything — just informing the user's scroll-wheel decision.
const _adKeywordPattern = /\bad[s]?\b|ad[-_]|[-_]ad\b|advert|banner|sponsor|promo|dfp|prebid|adsense|doubleclick|freestar|taboola|outbrain|criteo|pubmatic/i;
// Hyphen-segmented identifier match for tag names and attribute names. Lives
// on AdnotaUI so the restorer's ad-slot fallback uses the same definition.
const _adIdentifierPattern = window.AdnotaUI.adIdentifierPattern;
// Network-specific attribute names that don't fit the hyphen-segmented pattern.
const _adNetworkAttrSet = new Set(['data-google-query-id', 'data-dfp', 'data-zone',
  'data-adunit', 'data-prebid']);

function _hasAdAttribute(el) {
  if (!el.attributes) return false;
  for (const attr of el.attributes) {
    if (_adNetworkAttrSet.has(attr.name)) return true;
    if (_adIdentifierPattern.test(attr.name)) return true;
  }
  return false;
}

/** Quick check: does a single element (not its subtree) have ad fingerprints? */
function hasAdFingerprint(el) {
  const idAndClass = (el.id || '') + ' ' + (el.className || '');
  if (_adKeywordPattern.test(idAndClass)) return true;
  if (_adIdentifierPattern.test(el.tagName || '')) return true;
  if (_hasAdAttribute(el)) return true;
  if (el.tagName === 'IFRAME') return true;
  return false;
}

function detectAdSignals(el) {
  const signals = [];
  const outerHTML = el.outerHTML.slice(0, 2000); // cap scan length

  // Check the element itself
  const idAndClass = (el.id || '') + ' ' + (el.className || '');
  if (_adKeywordPattern.test(idAndClass)) signals.push('ad-keyword');

  // Custom-element tag names (e.g. <shreddit-comments-page-ad>)
  if (_adIdentifierPattern.test(el.tagName || '')) signals.push('ad-tag');

  // Attribute-name scan — replaces the old fixed list, catches the whole
  // ad-type / is-ad / is-promoted / post-promoted / data-ad-* family
  if (_hasAdAttribute(el)) signals.push('ad-network');

  // aria-label like "Advertisement: ..." — strong textual signal sites use
  // for accessibility on ad slots even when class/id are neutral
  const ariaLabel = (el.getAttribute && el.getAttribute('aria-label')) || '';
  if (ariaLabel && _adKeywordPattern.test(ariaLabel.slice(0, 200))) {
    signals.push('ad-label');
  }

  // Single subtree pass: iframe descendants and rel="sponsored" links — the
  // canonical W3C signal for paid links. One walk instead of two.
  const adChildren = el.querySelectorAll('iframe, a[rel~="sponsored"]');
  let hasIframe = false;
  let hasSponsoredLink = false;
  let hasAdIframe = false;
  for (const child of adChildren) {
    if (child.tagName === 'IFRAME') {
      hasIframe = true;
      const src = child.getAttribute('src') || '';
      if (!hasAdIframe && (!src || src === 'about:blank' || _adKeywordPattern.test(src))) {
        hasAdIframe = true;
      }
    } else {
      hasSponsoredLink = true;
    }
  }
  if (hasIframe) signals.push('iframe');
  if (hasSponsoredLink) signals.push('sponsored-link');
  if (hasAdIframe) signals.push('ad-iframe');

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
// Actual bubble/viewport logic lives in AdnotaUI — shared with the resizer.
const dominatesViewport = window.AdnotaUI.dominatesViewport;
// Scroll-up nudge won't suggest a parent that's this many times larger than
// the element the user is actually hovering — at that point we've walked past
// the ad and into real content regardless of what the ad-density heuristic says.
// 1.4× area ≈ 1.18× linear, i.e. roughly "an 18% wider/taller wrapper" — small
// enough that it's plausibly the ad slot wrapper, not the surrounding column.
const BETTER_TARGET_MAX_AREA_RATIO = 1.4;
// Per-hop growth cap — a single step-up that grows this much usually means
// we've crossed a layout boundary (ad slot → sidebar column, card → grid row).
// The visual-root auto-bubble already nails the starting element most of the
// time, so big jumps between recommended levels are almost always wrong.
const BETTER_TARGET_MAX_HOP_RATIO = 1.25;

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
    .filter(c => !c.startsWith('adnota-') && /^[a-zA-Z][\w-]*$/.test(c) && !window.FuzzyAnchor._autoClassPattern.test(c));
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
    if (isAdnotaElement(cur)) { cur = cur.parentElement; continue; }

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

function updateHUD(target) {
  if (!target) {
    dimensionBadge.textContent = '';
    adBadge.style.display = 'none';
    eraserHudInfo.innerHTML = IDLE_HUD_LABEL;
    return;
  }

  // ── Dimension badge ──
  const rect = target.getBoundingClientRect();
  dimensionBadge.textContent = `${Math.round(rect.width)}\u00d7${Math.round(rect.height)}`;

  // ── HUD info section ──
  const anchor = getAnchorStrength(target);
  const adSignals = getEffectiveAdSignals(target);
  const betterTarget = findBetterTarget(target);

  // ── Likely-ad badge on the overlay (visible only when ad signals fire) ──
  adBadge.style.display = adSignals.length > 0 ? 'inline-block' : 'none';

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

  // Confidence score — UI commented out for now; the raw 0–100 number isn't
  // meaningful to most users. Replaced with a Shift+Scroll usage hint that
  // mirrors the resizer HUD's pattern. Score is still computed above because
  // findBetterTarget() and getEffectiveAdSignals() consume `anchor`. Revisit
  // with a friendlier confidence surface (icon? word?) when ready.
  // html += `<span style="color:${confColor};font-weight:600">${anchor.score}/100</span>`;
  // html += `<span style="color:${confColor};margin-left:4px">${confLabel}</span>`;

  // Pills first — descriptive status about the hovered element.
  if (adSignals.length > 0) {
    for (const s of adSignals) {
      html += `<span style="background:rgba(239,68,68,0.18);color:#fca5a5;padding:1px 6px;border-radius:4px;margin-left:6px;font-size:11px">${escapeHtml(s)}</span>`;
    }
  }

  // Scroll info trails the pills — imperative ("here's what to do").
  // Better-target nudge wins when present (more actionable, more attention-
  // grabbing); otherwise the static usage hint anchors the strip so it
  // never reads empty during a hover.
  const scrollInfo = betterTarget
    ? `<span style="color:#6ee7b7">▲ ⇧+Scroll up ${betterTarget.stepsUp}× for better target</span>`
    : `<span style="color:#94a3b8"><span style="background:rgba(239,68,68,0.18);color:#fca5a5;padding:1px 4px;border-radius:3px;font-size:11px;font-weight:600;margin-right:4px">⇧+Scroll ↑↓</span>to walk the DOM</span>`;
  if (html) html += dot;
  html += scrollInfo;

  eraserHudInfo.innerHTML = html;
}


// Show/hide the entire HUD shell. Visible whenever eraser mode is active so
// the trash/undo buttons stay reachable even when no element is hovered.
function setHudVisible(visible) {
  if (visible) {
    window.AdnotaDock.mount('eraser', () => eraserBody);
  } else {
    window.AdnotaDock.unmount('eraser');
  }
}

let hoveredElement = null;
let rawHoveredEl = null;     // actual element under cursor (before traversal)
let traverseDepth = 0;       // 0 = raw element, >0 = walked up N parents

// Shared set of erased elements — restorer.js also adds to this.
// AdnotaVisibility iterates this set to toggle show/hide on each erased node.
window.AdnotaErasedElements = new Set();

// ─── CSS rule injection for persistent erasure ──────────────────────────────
// Erased elements get a CSS rule so that if the element is destroyed and re-created
// (e.g. ad rotation timers), the browser automatically hides the new instance.
window.AdnotaEraseRules = new Map(); // id → cssSelector

function getOrCreateEraseStyleTag() {
  let tag = document.getElementById('adnota-erase-overrides');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'adnota-erase-overrides';
    tag.setAttribute('data-adnota-ui', '1');
    document.head.appendChild(tag);
  }
  return tag;
}

function rebuildEraseStyleTag() {
  const tag = getOrCreateEraseStyleTag();
  const rules = [];
  for (const [, selector] of window.AdnotaEraseRules) {
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
    iframeShieldStyleTag.id = 'adnota-iframe-shield';
    iframeShieldStyleTag.setAttribute('data-adnota-ui', '1');
    iframeShieldStyleTag.textContent = 'iframe { pointer-events: none !important; }';
    document.head.appendChild(iframeShieldStyleTag);
  } else if (!active && iframeShieldStyleTag) {
    iframeShieldStyleTag.remove();
    iframeShieldStyleTag = null;
  }
}

// ─── Guard: Adnota-owned elements are invisible to the eraser ─────────────────
const isAdnotaElement = window.AdnotaUI.isAdnotaElement;

// ─── DOM traversal: walk up N parents, skip Adnota elements ─────────────────
// At depth=0, bubble past visually-identical parent wrappers so clicking the
// inner element hits the outer container users almost always actually want.
// Scroll-wheel traversal walks further up from that bubbled baseline.
function getEraserTarget(raw, depth) {
  if (!raw || isAdnotaElement(raw)) return null;
  let current = window.AdnotaUI.bubbleToVisualRoot(raw);
  if (isAdnotaElement(current)) return null;
  let walked = 0;
  while (walked < depth && current.parentElement &&
    current.parentElement !== document.body &&
    current.parentElement !== document.documentElement) {
    current = current.parentElement;
    if (isAdnotaElement(current)) return null;
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
  flash.setAttribute('data-adnota-ui', '1');
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
    window.AdnotaState.set({ mode: window.AdnotaState.mode === 'eraser' ? null : 'eraser' });
  }
});

// ─── React to mode changes ────────────────────────────────────────────────────
let _eraserActive = false;
window.AdnotaState.subscribe(state => {
  const isEraser = state.mode === 'eraser';
  if (isEraser !== _eraserActive) {
    _eraserActive = isEraser;
    window.AdnotaLog?.event('eraser', isEraser ? 'mode-enter' : 'mode-exit');
  }
  setIframeShield(isEraser);
  if (isEraser) {
    // Show HUD as soon as the tool is active — trash/undo are always reachable.
    setHudVisible(true);
    updateHUD(null);
  } else {
    highlightOverlay.style.display = 'none';
    setHudVisible(false);
    if (eraserHelpBtn.close) eraserHelpBtn.close();
    hoveredElement = null;
    rawHoveredEl = null;
    traverseDepth = 0;
  }
});

// ─── Block page interactions in eraser mode ─────────────────────────────────
// Ads commonly open new tabs from mousedown/pointerdown (before `click` fires),
// which both bypasses our click-capture handler and steals keyboard focus so
// Escape stops working. Intercept the earliest pointer events on window-capture
// and kill them for non-Adnota targets. Right-click is left alone so users can
// still Inspect. Adnota UI (HUD, drag handle, buttons) passes through normally.
function blockPageInteraction(e) {
  if (window.AdnotaState.mode !== 'eraser') return;
  if (isAdnotaElement(e.target)) return;
  if (e.button === 2) return;
  e.preventDefault();
  e.stopPropagation();
  // preventDefault blocks the implicit focus transfer, so nothing would bring
  // focus back into our document — pull it home via the shared anchor.
  window.AdnotaState.anchorFocus?.();
}
window.addEventListener('mousedown', blockPageInteraction, true);
window.addEventListener('pointerdown', blockPageInteraction, true);
window.addEventListener('auxclick', blockPageInteraction, true);

// ─── Hover: track raw element and update overlay ─────────────────────────────
document.addEventListener('mousemove', (e) => {
  if (window.AdnotaState.mode !== 'eraser') return;
  const raw = document.elementFromPoint(e.clientX, e.clientY);

  if (!raw) {
    hoveredElement = null;
    rawHoveredEl = null;
    highlightOverlay.style.display = 'none';
    updateHUD(null);
    return;
  }

  // When cursor is over Adnota UI (dock, HUD, etc.), hide the hover
  // overlay so our own controls aren't visually framed as erase targets.
  if (isAdnotaElement(raw)) {
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
// Gated on Shift so plain scroll passes through to the page — otherwise the
// user can't scroll-explore for ads two screens away without exiting the tool.
document.addEventListener('wheel', (e) => {
  if (window.AdnotaState.mode !== 'eraser') return;
  if (!rawHoveredEl) return;
  if (!e.shiftKey) return;

  e.preventDefault();

  // Browsers convert vertical wheel input into horizontal scroll while Shift
  // is held — deltaY drops to 0 and the value moves to deltaX. Read whichever
  // axis carries signal so the user's "up = parent" expectation holds.
  const delta = e.deltaY || e.deltaX;
  if (delta < 0) {
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
  if (window.AdnotaState.mode !== 'eraser') return;
  if (isAdnotaElement(e.target)) return;

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

  // Inject CSS rule so the element stays hidden even if re-created. For ad-shaped
  // custom elements (Reddit's <shreddit-comments-page-ad> with rotating post-ids)
  // we widen the rule to also match the bare tag, so the next impression in the
  // same slot is hidden too without a second click. No-op for generic tags.
  const ruleSelector = window.AdnotaUI.maybeGeneralizeAdSelector(cssSelector, target.tagName);
  const adSignals = getEffectiveAdSignals(target);
  window.AdnotaLog?.event('eraser', 'click', {
    el: window.AdnotaLog.el(target),
    scope: useDomain ? 'domain' : 'page',
    promotedSilent: !e.shiftKey && adSignals.length > 0,
    shiftClick: !!e.shiftKey,
    adSignals,
    ruleSelector,
    id,
  });
  window.AdnotaEraseRules.set(id, ruleSelector);
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
      window.AdnotaErasedElements.add(target);
      try { activeAnimation.cancel(); } catch { }
      activeAnimation = null;
    }
  }).catch(() => {
    // Animation was cancelled by undo — do nothing.
  });

  // Save to storage immediately (don't block the animation on I/O).
  if (window.AdnotaStorage) {
    window.AdnotaStorage.saveItem(domain, pathScope, { action: 'ERASE', anchor, selector: cssSelector, _id: id }).catch(() => { });
  }

  // ── Shared undo closure — used by both toast button and Ctrl+Z ──
  const undoEntry = {
    undo: async () => {
      if (consumed) return;
      consumed = true;
      window.AdnotaLog?.event('eraser', 'undo', { id, sel: cssSelector });

      // Kill the dissolve if it's still mid-flight.
      if (activeAnimation) {
        try { activeAnimation.cancel(); } catch { }
        activeAnimation = null;
      }

      // Restore element to exactly where it was.
      target.style.cssText = savedCssText;
      window.AdnotaErasedElements.delete(target);

      // Remove the CSS rule that prevents re-creation.
      window.AdnotaEraseRules.delete(id);
      rebuildEraseStyleTag();

      // Delete the erasure record from storage.
      if (window.AdnotaStorage) {
        const data = await chrome.storage.local.get(domain);
        if (data[domain]) {
          data[domain].items = data[domain].items.filter(i => i._id !== id);
          await chrome.storage.local.set({ [domain]: data[domain] });
        }
      }

      window.AdnotaUndo.remove(undoEntry);
    }
  };
  window.AdnotaUndo.push(undoEntry);

  // ── Toast ──
  window.AdnotaUI.showToast('Element erased', {
    id: 'adnota-eraser-toast',
    onUndo: () => undoEntry.undo(),
  });

}, true); // Capture phase — intercept before the page's own handlers.
