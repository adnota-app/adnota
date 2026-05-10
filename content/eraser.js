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
  top: '4px',
  right: '4px',
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

// Trash — opens scratch pad on Edits / Erased so the user can review and
// delete individual erasures (instead of nuking all of them). Badge shows
// the per-page count and refreshes on storage / SPA-nav events; the helper
// in adnotaUI.js handles all the wiring once mode/filter are passed.
const eraserTrashBtn = window.AdnotaUI.createTrashButton({
  singular: 'erasure',
  plural: 'erasures',
  actionTypes: ['ERASE'],
  mode: 'edits',
  filter: 'erased',
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

// ─── Find similar ads (signature → signal-confirm two-stage detector) ────────
// Two-stage by design: signatures FIND candidates, signals CONFIRM them.
// Signatures alone produce false positives (e.g., a non-ad sibling sharing
// classes with an ad-network class); re-running getEffectiveAdSignals per
// candidate is the safety net that keeps non-ad siblings out of the cluster.
//
// Returns { candidates: HTMLElement[], strategies: string[] } where candidates
// are document-ordered and exclude: the originally-erased target, Adnota
// chrome, page-level dominators, descendants of already-erased elements, and
// any candidate whose own getEffectiveAdSignals is empty.
//
// Stage 1 of the "Erase 7 similar?" feature: this is the detector only — the
// caller decides what to do with it (Stage 1 logs; Stage 3 will surface UI).
const SIMILAR_ADS_CAP = 50;
const ATTR_PREFIX_BROAD_THRESHOLD = 200; // skip prefixes broader than this — structural class, not ad cluster

// Stem extraction from id-style values like "ad-slot-1234" → "ad-slot-".
// Returns the stem with trailing hyphen, or null if the value lacks a
// recognizable variable trailing token. UUID-shaped values (single token of
// length ≥ 16, no hyphens, alphanumeric) are refused — too easy to match a
// structural prefix on those.
function _extractAdStem(value) {
  if (!value || typeof value !== 'string') return null;
  if (!value.includes('-') && value.length >= 16 && /^[A-Za-z0-9_]+$/.test(value)) return null;
  // Last hyphen-followed-by-[A-Za-z0-9]{2,} segment. Group 1 = stem (with trailing hyphen).
  const match = value.match(/^(.+-)([A-Za-z0-9]{2,})$/);
  if (!match) return null;
  const stem = match[1];
  if (!stem || stem === '-') return null;
  return stem;
}

function findSimilarAds(target) {
  if (!target || !target.tagName) return { candidates: [], strategies: [] };

  const strategies = [];
  const found = new Set();

  // Strategy 1: Tag-shape match.
  // If the clicked element is an ad-shaped custom tag (matches the shared
  // adIdentifierPattern), every other element with the same tag is a
  // strong candidate. Near-zero false-positive rate — the tag itself names
  // the slot.
  if (_adIdentifierPattern.test(target.tagName)) {
    try {
      document.querySelectorAll(target.tagName.toLowerCase()).forEach(c => found.add(c));
      strategies.push('tag-shape');
    } catch { /* malformed tag — skip */ }
  }

  // Strategy 2: Ad-attribute presence.
  // If the seed carries an ad-network attribute (data-freestar-ad,
  // data-google-query-id, data-prebid, etc., or any attribute matching
  // _adIdentifierPattern), find every other element with the same attribute.
  // This is the strongest per-site cluster signal: all slots in the same
  // ad-network family share the same attribute name regardless of class or
  // id. Catches sites (Neowin / Freestar, etc.) that use underscored ids and
  // generic class names but expose their network integration via data-attrs.
  // The per-candidate signal-confirm stage below still gates membership.
  if (target.attributes) {
    for (const attr of target.attributes) {
      const isAdAttr = _adNetworkAttrSet.has(attr.name) || _adIdentifierPattern.test(attr.name);
      if (!isAdAttr) continue;
      try {
        const selector = `[${CSS.escape(attr.name)}]`;
        const matches = document.querySelectorAll(selector);
        if (matches.length > 0 && matches.length <= ATTR_PREFIX_BROAD_THRESHOLD) {
          matches.forEach(c => found.add(c));
          if (!strategies.includes('ad-attr-presence')) strategies.push('ad-attr-presence');
        }
      } catch { /* malformed selector — skip */ }
    }
  }

  // Strategy 3: Class-signature match.
  // Filter target.classList to ad-keyword-matching classes; build a comma-
  // separated selector; querySelectorAll. Catches the classic
  // <div class="adsbygoogle"> × N pattern. CSS.escape handles the
  // weirder ad-network class names without a manual sanitizer.
  if (target.classList && target.classList.length > 0) {
    const adClasses = [];
    for (const cls of target.classList) {
      if (_adKeywordPattern.test(cls)) adClasses.push(cls);
    }
    if (adClasses.length > 0) {
      try {
        const selector = adClasses.map(c => '.' + CSS.escape(c)).join(', ');
        document.querySelectorAll(selector).forEach(c => found.add(c));
        strategies.push('class-signature');
      } catch { /* malformed selector — skip */ }
    }
  }

  // Strategy 4: Attribute-prefix match.
  // For id and data-* values like "ad-slot-1234", extract a stem and rewrite
  // to a prefix selector ([id^="ad-slot-"]). Skip the result if it matches
  // > 200 elements — that's not an ad cluster, that's a structural class.
  const prefixCandidates = [];
  if (target.id) {
    const stem = _extractAdStem(target.id);
    if (stem) prefixCandidates.push({ attr: 'id', stem });
  }
  if (target.attributes) {
    for (const attr of target.attributes) {
      if (!attr.name.startsWith('data-')) continue;
      const stem = _extractAdStem(attr.value);
      if (stem) prefixCandidates.push({ attr: attr.name, stem });
    }
  }
  for (const { attr, stem } of prefixCandidates) {
    try {
      // Attribute-selector value escaping: backslash + quote, no \" needed.
      const escapedStem = stem.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const selector = `[${attr}^="${escapedStem}"]`;
      const matches = document.querySelectorAll(selector);
      if (matches.length > 0 && matches.length <= ATTR_PREFIX_BROAD_THRESHOLD) {
        matches.forEach(c => found.add(c));
        if (!strategies.includes('attr-prefix')) strategies.push('attr-prefix');
      }
    } catch { /* malformed selector — skip */ }
  }

  // ── Signal-confirm stage ──
  const erasedSet = window.AdnotaErasedElements || new Set();
  const isErasedDescendant = (c) => {
    for (const e of erasedSet) {
      if (e !== c && e.contains && e.contains(c)) return true;
    }
    return false;
  };

  const candidates = [];
  for (const c of found) {
    if (c === target) continue;
    if (isAdnotaElement(c)) continue;
    if (erasedSet.has(c)) continue;
    if (isErasedDescendant(c)) continue;
    const rect = c.getBoundingClientRect();
    if (dominatesViewport(rect)) continue;
    // The double-verify: signature got us here, but each candidate must also
    // pass getEffectiveAdSignals on its own merits before joining the cluster.
    // This is the false-positive guard.
    if (getEffectiveAdSignals(c).length === 0) continue;
    candidates.push(c);
    if (candidates.length >= SIMILAR_ADS_CAP) break;
  }

  // Drop descendants whose ancestor is also in the candidate set — keeps
  // the outermost wrapper (what the user reads as "the ad"). Without this,
  // Google Ad Manager / Freestar slots that emit both an outer wrapper AND
  // an inner container (both carrying data-google-query-id or similar)
  // produce stacked overlays on visually-the-same ad.
  const deduped = candidates.filter(c => {
    for (const other of candidates) {
      if (other !== c && other.contains(c)) return false;
    }
    return true;
  });

  // Document-order sort so Prev/Next walks the page top-to-bottom.
  deduped.sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  return { candidates: deduped, strategies };
}

// True if a candidate is currently visible enough to be reviewable. Used to
// filter the post-settle candidate list — bare-tag widening on Reddit-style
// custom ads collapses cluster siblings synchronously via the injected style
// tag, so a match found by findSimilarAds may already be display:none by the
// time we surface a prompt. The user-facing count must reflect only what
// they'd actually be asked to confirm.
function isCandidateVisible(c) {
  if (!c || !c.isConnected) return false;
  const rect = c.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (c.offsetParent === null) return false; // catches display:none
  if (getComputedStyle(c).visibility === 'hidden') return false;
  return true;
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
  // Batch-pending state takes precedence over hover/idle — the user has
  // active business with the cluster the chip references, and we don't
  // want hover updates to overwrite it.
  if (batchState && batchState.candidates.length > 0) {
    // Hover-overlay badges (dimension + likely-ad pill) are owned by
    // highlightOverlay, not the HUD info section. They reflect whatever the
    // cursor's over — batch mode shouldn't blank them just because the
    // chip is in the info section. Non-candidate hovers during review
    // still get the standard W×H + ad-pill readout.
    if (target) {
      const rect = target.getBoundingClientRect();
      dimensionBadge.textContent = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
      const hoverSignals = getEffectiveAdSignals(target);
      adBadge.style.display = hoverSignals.length > 0 ? 'inline-block' : 'none';
    } else {
      dimensionBadge.textContent = '';
      adBadge.style.display = 'none';
    }
    const n = batchState.candidates.length;
    // Idempotent render: skip the rebuild if the chip is already showing
    // this N. Without this, every mousemove over the dock calls updateHUD
    // (via the isAdnotaElement branch) and tears down/recreates the buttons
    // mid-hover, resetting any in-flight transition — visible as a flicker.
    const stateKey = `batch:${n}`;
    if (eraserHudInfo.dataset.batchKey === stateKey) return;
    eraserHudInfo.dataset.batchKey = stateKey;

    // Brand-fit: status pill (informational) sits subtle; nav arrows are bare
    // glyphs with hover-tint only; the primary action mirrors the canonical
    // .adnota-select-delete red — so "yes" (Erase) and "no" (✕) read as a
    // decisive pair in the same red palette. Reading order: what's happening
    // → how to inspect → what to do.
    const navBtnStyle = 'display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;color:#fca5a5;font:600 12px/1 -apple-system,BlinkMacSystemFont,sans-serif;background:transparent;border:none;border-radius:4px;cursor:pointer;margin-right:2px;transition:background 0.12s;padding:0';
    // Solid red matching .adnota-select-delete (rgba(239,68,68,0.9) bg, white
    // text, soft drop-shadow). The dismiss ✕ uses the same palette — pairing
    // them as the decisive yes/no.
    const actionChipStyle = 'background:rgba(239,68,68,0.9);color:#fff;border:none;font:600 11px/1 -apple-system,BlinkMacSystemFont,sans-serif;padding:6px 12px;border-radius:4px;cursor:pointer;margin-right:6px;transition:background 0.15s;box-shadow:0 2px 6px rgba(0,0,0,0.3)';
    eraserHudInfo.innerHTML =
      `<button id="adnota-eraser-batch-prev" data-adnota-ui="1" data-adnota-tooltip="Previous similar (scroll into view)" style="${navBtnStyle}">◀</button>` +
      `<button id="adnota-eraser-batch-next" data-adnota-ui="1" data-adnota-tooltip="Next similar (scroll into view)" style="${navBtnStyle};margin-right:10px">▶</button>` +
      `<button id="adnota-eraser-batch-commit" data-adnota-ui="1" data-adnota-tooltip="Erase the remaining similar ads" style="${actionChipStyle}"><span style="margin-right:4px">⚠</span>Erase ${n} more?</button>` +
      `<div id="adnota-eraser-batch-deny" data-adnota-ui="1" data-adnota-tooltip="Dismiss without erasing" class="adnota-select-delete" style="position:relative;top:0;right:0">✕</div>`;
    // Wire button handlers — innerHTML wipes prior listeners every time, so
    // re-bind on each render.
    const commitBtn = document.getElementById('adnota-eraser-batch-commit');
    const denyBtn = document.getElementById('adnota-eraser-batch-deny');
    const prevBtn = document.getElementById('adnota-eraser-batch-prev');
    const nextBtn = document.getElementById('adnota-eraser-batch-next');
    const wireHover = (btn, hoverBg) => {
      if (!btn) return;
      const origBg = btn.style.background;
      btn.addEventListener('mouseenter', () => { btn.style.background = hoverBg; });
      btn.addEventListener('mouseleave', () => { btn.style.background = origBg; });
    };
    const wireNav = (btn, dir) => {
      if (!btn) return;
      btn.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        navigateBatch(dir);
      });
      wireHover(btn, 'rgba(239, 68, 68, 0.18)');
    };
    wireNav(prevBtn, -1);
    wireNav(nextBtn, 1);
    if (commitBtn) {
      commitBtn.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
      commitBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        commitBatch();
      });
      // Hover deepens to .adnota-select-delete:hover's color (rgba(220,38,38,1)).
      wireHover(commitBtn, 'rgba(220, 38, 38, 1)');
    }
    if (denyBtn) {
      denyBtn.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
      denyBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        denyBatch('user');
      });
    }
    // No animation here — enterBatch owns the entry fade-in via an opacity
    // transition on eraserHudInfo. updateHUD only rebuilds the innerHTML;
    // it doesn't choreograph the reveal.
    return;
  }

  // Non-batch render — clear the batch render-key so the next batch entry
  // doesn't false-positive against a stale match.
  delete eraserHudInfo.dataset.batchKey;

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

// Batch sweep state (helpers + lifecycle live below, after the click handler).
// Hoisted up here because both updateHUD() and the mode-change subscriber's
// initial synchronous fire reference batchState — declaring them next to the
// helpers further down would put us in the TDZ at script-load.
let batchState = null;
let batchOverlayMap = new Map(); // displayNumber → wrapper element
let _batchScrollRafPending = false;
let _focusedDn = null; // currently-focused candidate's displayNumber (Prev/Next nav)

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
    // Hover-overlay suppression on candidates during batch-pending — the
    // candidate's own dashed batch border + numbered badge already says
    // "this is a target," and a competing solid red hover overlay over a
    // dashed red border is visually noisy. Hover on non-candidates still
    // paints normally.
    if (batchState && isCandidateElement(target)) {
      highlightOverlay.style.display = 'none';
      updateHUD(null); // keeps the batch chip visible (HUD branch handles it)
      return;
    }
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
    if (batchState) denyBatch('mode-off');
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

// ─── Batch sweep ("Erase 7 similar?") ───────────────────────────────────────
// State + helpers for the batch-pending UX surfaced after an ad erase. The
// HUD chip and per-candidate overlays let the user inspect a cluster, remove
// individuals via the corner ✕, and commit the rest in one undo entry.
// Detection lives in findSimilarAds; this block owns the live UI.
//
// State shape: { candidates: [{ el, displayNumber }] } where displayNumber is
// stable across removals (removing #3 leaves the survivors at 4, 5, 6 — no
// renumbering, easier to track visually).

// (batchState / batchOverlayMap / _batchScrollRafPending are declared earlier
// in the file, just before the mode-change subscriber. They're hoisted up
// because the subscriber's initial fire happens at script-load time and
// references batchState — putting `let`s here would trip the TDZ.)

// Plain decimal label for the badge. Earlier iteration used Unicode circled
// digits (①②③), but the surrounding pill already provides the circle —
// rendering a circled digit inside a circular pill produced a double-circle
// look. Plain "1" / "2" / "10" inside the pill reads cleaner.
function _badgeLabel(n) {
  return String(n);
}

// Walk up from el to find the first ancestor (or el itself) that's a current
// batch candidate. Returns the entry { el, displayNumber } or null.
//
// Subtree-aware: candidates can be wrappers with padding, and the eraser's
// auto-bubble doesn't always promote a hover on a small inner element up to
// the wrapper (low IoU). Without walking ancestors, hovering / clicking the
// inner iframe of an ad we've already flagged would treat it as a different
// element and tear down the review. We treat the candidate's whole DOM
// subtree as part of the candidate.
function findContainingCandidate(el) {
  if (!batchState || !el) return null;
  let walker = el;
  while (walker && walker.nodeType === Node.ELEMENT_NODE) {
    for (const c of batchState.candidates) {
      if (c.el === walker) return c;
    }
    walker = walker.parentElement;
  }
  return null;
}

// Boolean form for the hover-suppression call site that doesn't need the entry.
function isCandidateElement(el) {
  return findContainingCandidate(el) !== null;
}

// Build (or rebuild) the per-candidate overlay positioned over a candidate's
// current bounding rect. Returns the wrapper element, or null if the candidate
// is off-viewport / detached / zero-size. Doc-coord positioning so the overlay
// scrolls naturally with the candidate; we recompute on scroll/resize via the
// listeners below.
function _paintBatchOverlay(entry) {
  if (!entry.el || !entry.el.isConnected) return null;
  const rect = entry.el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  // Viewport-only painting: skip candidates entirely off-screen so news sites
  // with 15+ ad slots don't carry 15 dashed boxes off-frame.
  if (rect.bottom < 0 || rect.top > window.innerHeight) return null;
  if (rect.right < 0 || rect.left > window.innerWidth) return null;

  const scrollY = window.pageYOffset || document.documentElement.scrollTop;
  const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
  const docLeft = rect.left + scrollX;
  const docTop = rect.top + scrollY;

  // Stack-shift the number badge horizontally if another overlay is already
  // painted at (approximately) this same doc-position — sites occasionally
  // render two ad-slot wrappers at identical coords (SPA quirks, layout
  // overlap), and stacked badges look like one when in fact the user has
  // two affordances to act on. Side-by-side reads honestly.
  let badgeStackOffset = 0;
  for (const otherWrapper of batchOverlayMap.values()) {
    const otherLeft = parseFloat(otherWrapper.style.left);
    const otherTop = parseFloat(otherWrapper.style.top);
    if (Math.abs(otherLeft - docLeft) < 4 && Math.abs(otherTop - docTop) < 4) {
      badgeStackOffset++;
    }
  }

  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-adnota-ui', '1');
  wrapper.dataset.batchNumber = String(entry.displayNumber);
  Object.assign(wrapper.style, {
    position: 'absolute',
    top: `${rect.top + scrollY}px`,
    left: `${rect.left + scrollX}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    border: '2px dashed #ef4444',
    background: 'rgba(239, 68, 68, 0.10)',
    boxSizing: 'border-box',
    pointerEvents: 'none', // body clicks fall through to candidate
    zIndex: '2147483647',
    borderRadius: '2px',
  });

  // Number badge — INSIDE the candidate's top-left corner (inset positioning
  // keeps it visible on candidates flush with the viewport top). Styled to
  // mirror the canonical .adnota-select-delete ✕: same semi-transparent red,
  // same drop-shadow depth, no hard white border. Distinguished from the ✕
  // only by size (26px vs 20px) — same visual language, scaled-up to read
  // as "review affordance" rather than "remove button."
  const numBadge = document.createElement('div');
  numBadge.setAttribute('data-adnota-ui', '1');
  numBadge.textContent = _badgeLabel(entry.displayNumber);
  Object.assign(numBadge.style, {
    position: 'absolute',
    top: '8px',
    // 26px badge + 4px gap = 30px stride per stacked peer
    left: `${8 + badgeStackOffset * 30}px`,
    background: 'rgba(239, 68, 68, 0.9)',
    color: '#fff',
    font: '600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    minWidth: '26px',
    height: '26px',
    padding: '0 7px',
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '13px',
    pointerEvents: 'none',
  });
  wrapper.appendChild(numBadge);

  // ✕ remove button (top-right, interactive — pointer-events: auto).
  // <div> not <button> so browser button defaults (gray border, default
  // typography) don't override .adnota-select-delete. Matches the canonical
  // pattern in dock.js / marker.js / highlighter.js etc.
  const xBtn = document.createElement('div');
  xBtn.className = 'adnota-select-delete';
  xBtn.setAttribute('data-adnota-ui', '1');
  xBtn.setAttribute('data-adnota-tooltip', 'Remove from batch');
  xBtn.textContent = '✕';
  // Explicit positioning override — .adnota-select-delete defaults to top:-10/
  // right:-10, which is what we want here too, but we want pointer-events:auto
  // explicitly since the parent wrapper sets pointer-events:none.
  xBtn.style.pointerEvents = 'auto';
  // Block mousedown's default + propagation so the eraser's window-capture
  // pointer blocker doesn't run anchorFocus and the click cleanly reaches us.
  xBtn.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
  xBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    removeBatchCandidate(entry.displayNumber);
  });
  wrapper.appendChild(xBtn);

  document.documentElement.appendChild(wrapper);
  return wrapper;
}

function _tearDownBatchOverlay(displayNumber) {
  const w = batchOverlayMap.get(displayNumber);
  if (w && w.parentNode) w.parentNode.removeChild(w);
  batchOverlayMap.delete(displayNumber);
}

function _tearDownAllBatchOverlays() {
  for (const w of batchOverlayMap.values()) {
    if (w && w.parentNode) w.parentNode.removeChild(w);
  }
  batchOverlayMap.clear();
}

// Recompute which candidates should currently have overlays: drop overlays
// for candidates that left the viewport, create overlays for ones that
// entered. Stale candidates (detached) are also pruned from batchState here —
// they survived the post-erase filter but the page mutated since. rAF-throttled
// so a frenetic scroll doesn't run this hundreds of times per second.
function _refreshBatchOverlays() {
  if (!batchState) return;
  const survivors = [];
  for (const entry of batchState.candidates) {
    if (!entry.el.isConnected) {
      // Stale candidate — drop silently.
      _tearDownBatchOverlay(entry.displayNumber);
      window.AdnotaLog?.event('eraser', 'batch-stale-skip', { displayNumber: entry.displayNumber });
      continue;
    }
    survivors.push(entry);
    const rect = entry.el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 &&
                    rect.bottom > 0 && rect.top < window.innerHeight &&
                    rect.right > 0 && rect.left < window.innerWidth;
    const existing = batchOverlayMap.get(entry.displayNumber);
    if (visible && !existing) {
      const w = _paintBatchOverlay(entry);
      if (w) batchOverlayMap.set(entry.displayNumber, w);
    } else if (!visible && existing) {
      _tearDownBatchOverlay(entry.displayNumber);
    } else if (visible && existing) {
      // Reposition in-place (resize might have shifted the candidate).
      const scrollY = window.pageYOffset || document.documentElement.scrollTop;
      const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
      Object.assign(existing.style, {
        top: `${rect.top + scrollY}px`,
        left: `${rect.left + scrollX}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    }
  }
  batchState.candidates = survivors;
  // Self-dismiss if everything went stale.
  if (batchState.candidates.length === 0) denyBatch('all-removed');
  else updateHUD(null); // refresh the chip's count
}

function _onBatchScrollOrResize() {
  if (_batchScrollRafPending) return;
  _batchScrollRafPending = true;
  requestAnimationFrame(() => {
    _batchScrollRafPending = false;
    _refreshBatchOverlays();
  });
}

// Slide-transition the eraserHudInfo content: old content slides up and out
// while new content slides up into its place from below. Pure vertical
// slide — no width animation, no growth-from-middle. The dock width is
// locked once at the start to fit whichever content is wider; that's the
// only dimensional change, and it happens within a single frame so it's
// not perceived as continuous growth.
//
// renderNewContent is called mid-transition; it must populate eraserHudInfo
// (typically via updateHUD which sets innerHTML and wires handlers).
function _slideTransitionHud(renderNewContent) {
  const oldRect = eraserHudInfo.getBoundingClientRect();

  // `width: max-content` makes each wrapper size to its own natural content
  // even when position:absolute, so we can measure new content's width
  // accurately before animation starts.
  const wrapperStyle = {
    position: 'absolute',
    left: '0',
    top: '0',
    height: '100%',
    width: 'max-content',
    display: 'inline-flex',
    alignItems: 'center',
    whiteSpace: 'nowrap',
    transition: 'transform 0.32s ease-out, opacity 0.32s ease-out',
  };

  // Capture current children into oldContent.
  const oldContent = document.createElement('span');
  oldContent.setAttribute('data-adnota-ui', '1');
  while (eraserHudInfo.firstChild) oldContent.appendChild(eraserHudInfo.firstChild);
  Object.assign(oldContent.style, wrapperStyle);
  oldContent.style.pointerEvents = 'none';
  oldContent.style.transform = 'translateY(0)';

  // Render the new innerHTML into eraserHudInfo (handlers wired by updateHUD
  // via getElementById, which still works because we've cleared old children
  // out of eraserHudInfo first).
  renderNewContent();

  // Move that fresh content into newContent (starts off-screen below).
  const newContent = document.createElement('span');
  newContent.setAttribute('data-adnota-ui', '1');
  while (eraserHudInfo.firstChild) newContent.appendChild(eraserHudInfo.firstChild);
  Object.assign(newContent.style, wrapperStyle);
  newContent.style.transform = 'translateY(100%)';
  newContent.style.opacity = '0';

  // Append both wrappers; measure new content's natural width.
  eraserHudInfo.appendChild(oldContent);
  eraserHudInfo.appendChild(newContent);
  const newWidth = newContent.offsetWidth;
  const lockWidth = Math.max(oldRect.width, newWidth);

  // Lock dimensions for the duration of the slide — set once, no transition.
  // The dock may snap-grow by a few px at this instant if new is wider than
  // old, but it's a one-frame change (not continuous), so it reads as part
  // of the slide kicking off rather than its own animation.
  const prev = {
    position: eraserHudInfo.style.position,
    overflow: eraserHudInfo.style.overflow,
    height: eraserHudInfo.style.height,
    width: eraserHudInfo.style.width,
    minWidth: eraserHudInfo.style.minWidth,
    transition: eraserHudInfo.style.transition,
  };
  Object.assign(eraserHudInfo.style, {
    position: 'relative',
    overflow: 'hidden',
    height: oldRect.height + 'px',
    width: lockWidth + 'px',
    minWidth: lockWidth + 'px',
    transition: '', // explicit: no transition on container dimensions
  });

  // Double rAF: commit initial state to layout, then trigger transition.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      oldContent.style.transform = 'translateY(-100%)';
      oldContent.style.opacity = '0';
      newContent.style.transform = 'translateY(0)';
      newContent.style.opacity = '1';
    });
  });

  setTimeout(() => {
    // Defensive: a denyBatch / mode-off / new render may have wiped
    // eraserHudInfo's children mid-flight. Only clean up wrappers we still
    // own.
    if (oldContent.parentNode === eraserHudInfo) {
      eraserHudInfo.removeChild(oldContent);
    }
    if (newContent.parentNode === eraserHudInfo) {
      while (newContent.firstChild) eraserHudInfo.appendChild(newContent.firstChild);
      eraserHudInfo.removeChild(newContent);
    }
    eraserHudInfo.style.position = prev.position;
    eraserHudInfo.style.overflow = prev.overflow;
    eraserHudInfo.style.height = prev.height;
    eraserHudInfo.style.width = prev.width;
    eraserHudInfo.style.minWidth = prev.minWidth;
    eraserHudInfo.style.transition = prev.transition;
  }, 360);
}

function enterBatch(candidates) {
  // candidates: HTMLElement[] (visible, document-ordered)
  if (!candidates || candidates.length === 0) return;
  // If a prior batch is somehow still active, deny it before enter.
  if (batchState) denyBatch('replaced');

  batchState = {
    candidates: candidates.map((el, i) => ({ el, displayNumber: i + 1 })),
  };

  // Capture-phase listeners catch scrolls inside nested overflow containers
  // (window scroll events don't bubble from inner scrollers).
  window.addEventListener('scroll', _onBatchScrollOrResize, { passive: true, capture: true });
  window.addEventListener('resize', _onBatchScrollOrResize, { passive: true });

  // HUD slide-transition: old content slides up and out, new batch chip
  // slides up into place. Smooth, deliberate, single coordinated movement.
  _slideTransitionHud(() => updateHUD(null));

  // Overlay stagger reveal — opacity-only, no transforms (pure scale on
  // absolutely-positioned elements read as "boundary calculation glitches"
  // in earlier iteration). Stagger gives the scanning feel.
  let visibleIdx = 0;
  for (const entry of batchState.candidates) {
    const w = _paintBatchOverlay(entry);
    if (!w) continue;
    batchOverlayMap.set(entry.displayNumber, w);
    const delay = visibleIdx * 50;
    visibleIdx++;
    w.style.opacity = '0';
    w.style.transition = `opacity 0.3s ease-out ${delay}ms`;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        w.style.opacity = '1';
      });
    });
  }

  window.AdnotaLog?.event('eraser', 'batch-enter', { count: batchState.candidates.length });
}

// Smooth-scroll the next/previous candidate into view. Wraps around at ends.
// Pure navigation aid — does not commit, remove, or otherwise mutate the
// batch. Tracks the "focused" candidate by displayNumber (stable across
// removals) so a remove of the currently-focused entry just reorients on
// the next nav click.
function navigateBatch(direction) {
  if (!batchState || batchState.candidates.length === 0) return;
  // Sort by displayNumber ascending — these were assigned in document order
  // at batch-enter time, so this matches "page top-to-bottom" navigation.
  const sorted = batchState.candidates.slice().sort((a, b) => a.displayNumber - b.displayNumber);
  let idx;
  if (_focusedDn === null) {
    idx = direction > 0 ? 0 : sorted.length - 1;
  } else {
    const cur = sorted.findIndex(c => c.displayNumber === _focusedDn);
    if (cur === -1) {
      // Focused candidate was removed — restart at the relevant end.
      idx = direction > 0 ? 0 : sorted.length - 1;
    } else {
      idx = (cur + direction + sorted.length) % sorted.length;
    }
  }
  const target = sorted[idx];
  _focusedDn = target.displayNumber;
  if (target.el && target.el.isConnected) {
    target.el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  }
  window.AdnotaLog?.event('eraser', 'batch-navigate', {
    displayNumber: target.displayNumber, direction,
  });
}

function removeBatchCandidate(displayNumber) {
  if (!batchState) return;
  const idx = batchState.candidates.findIndex(c => c.displayNumber === displayNumber);
  if (idx < 0) return;
  batchState.candidates.splice(idx, 1);
  _tearDownBatchOverlay(displayNumber);
  window.AdnotaLog?.event('eraser', 'batch-remove', {
    displayNumber, remaining: batchState.candidates.length,
  });
  if (batchState.candidates.length === 0) {
    denyBatch('all-removed');
  } else {
    updateHUD(null); // refresh chip count
  }
}

function denyBatch(reason) {
  if (!batchState) return;
  _tearDownAllBatchOverlays();
  window.removeEventListener('scroll', _onBatchScrollOrResize, { capture: true });
  window.removeEventListener('resize', _onBatchScrollOrResize);
  window.AdnotaLog?.event('eraser', 'batch-deny', { reason: reason || 'unknown' });
  batchState = null;
  _focusedDn = null;
  updateHUD(null); // clear the chip
}

function commitBatch() {
  if (!batchState || batchState.candidates.length === 0) return;
  const entries = batchState.candidates.slice();
  // Stash undo functions for the composite entry.
  const perItemUndos = [];
  let erasedCount = 0;
  for (const entry of entries) {
    if (!entry.el.isConnected) continue; // mid-flight stale
    try {
      // skipAnimation: 7 simultaneous dissolves would be visually chaotic.
      // skipStyleRebuild: rebuild once after the loop instead of N times.
      const result = commitErase(entry.el, {
        shiftKey: false, // ad-signaled targets auto-promote inside commitErase
        skipAnimation: true,
        skipStyleRebuild: true,
      });
      perItemUndos.push(result.undoEntry.undo);
      erasedCount++;
    } catch (err) {
      window.AdnotaLog?.event('eraser', 'batch-stale-skip', {
        displayNumber: entry.displayNumber, error: String(err),
      });
    }
  }
  // Single style-tag rebuild covering all newly-injected rules.
  rebuildEraseStyleTag();

  // One composite undo entry on the shared stack so Ctrl+Z reverses the whole
  // sweep in a single keystroke. Per-item undos inherit skipStyleRebuild from
  // commit time (closure capture), so they delete from AdnotaEraseRules
  // without re-rendering the style tag — we rebuild once at the end here,
  // matching the commit-side optimization.
  const compositeUndo = {
    undo: async () => {
      // Reverse order so storage row deletions back-track the insertion order.
      for (let i = perItemUndos.length - 1; i >= 0; i--) {
        try { await perItemUndos[i](); } catch { /* per-item already consumed */ }
      }
      rebuildEraseStyleTag();
      window.AdnotaUndo.remove(compositeUndo);
    },
  };
  window.AdnotaUndo.push(compositeUndo);

  window.AdnotaUI.showToast(`Erased ${erasedCount} ${erasedCount === 1 ? 'ad' : 'ads'}`, {
    id: 'adnota-eraser-batch-toast',
    onUndo: () => compositeUndo.undo(),
  });

  window.AdnotaLog?.event('eraser', 'batch-commit', { erasedCount });

  // Tear down the UI (state is null after this).
  _tearDownAllBatchOverlays();
  window.removeEventListener('scroll', _onBatchScrollOrResize, { capture: true });
  window.removeEventListener('resize', _onBatchScrollOrResize);
  batchState = null;
  _focusedDn = null;
  updateHUD(null);
}

// ─── commitErase: shared erase commit (single-click + future batch path) ────
// Extracted from the click handler so the future batch sweep can reuse the
// exact same anchor capture / rule injection / animation / storage / undo
// pipeline. Returns the constructed undo entry; the caller owns pushing it
// onto AdnotaUndo (single-click path pushes immediately; batch path collects
// per-item undos into one composite entry).
//
// Options:
//   shiftKey         — whether the original gesture held Shift (forces domain scope)
//   skipAnimation    — bypass dissolve + flash; apply display:none immediately
//                       (batch path: 7 simultaneous dissolves would be visually chaotic)
//   skipStyleRebuild — set the rule on AdnotaEraseRules but defer the style-tag
//                       rebuild to the caller (batch path: rebuild once after the
//                       loop instead of N times)
//
// Returns { undoEntry, id, adSignals, savedCssText }.
function commitErase(target, opts = {}) {
  const {
    shiftKey = false,
    skipAnimation = false,
    skipStyleRebuild = false,
  } = opts;

  const rect = target.getBoundingClientRect();
  const savedCssText = target.style.cssText;

  // Capture anchor before any DOM mutation.
  const anchor = window.FuzzyAnchor.generate(target);
  const cssSelector = window.FuzzyAnchor.generateCSSSelector(target);
  // Shift is the user's explicit "entire domain" override — unchanged behavior.
  // If the target looks like an ad we silently promote the scope to domain-wide
  // too, since nobody wants to erase the same ad on every article. No chip, no
  // messaging; it just works. Non-ad targets still scope to the current page.
  const adSignals = getEffectiveAdSignals(target);
  const useDomain = shiftKey || adSignals.length > 0;
  const pathScope = useDomain ? '*' : location.pathname;
  const domain = location.hostname;
  const id = Date.now() + Math.random().toString();

  // Inject CSS rule so the element stays hidden even if re-created. For ad-shaped
  // custom elements (Reddit's <shreddit-comments-page-ad> with rotating post-ids)
  // we widen the rule to also match the bare tag, so the next impression in the
  // same slot is hidden too without a second click. No-op for generic tags.
  const ruleSelector = window.AdnotaUI.maybeGeneralizeAdSelector(cssSelector, target.tagName);
  // Snapshot the element's inline style and a short outerHTML at click time —
  // when an erased ad reappears, the diagnostic question is almost always
  // "did the page have inline display:block !important that beats our rule?"
  // and "did we save what we think we saved?". Both answers live here.
  window.AdnotaLog?.event('eraser', 'click', {
    el: window.AdnotaLog.el(target),
    scope: useDomain ? 'domain' : 'page',
    promotedSilent: !shiftKey && adSignals.length > 0,
    shiftClick: !!shiftKey,
    adSignals,
    ruleSelector,
    savedSelector: cssSelector,
    anchorTag: anchor?.tagName || null,
    anchorAttrs: anchor?.attributes ? Object.keys(anchor.attributes) : [],
    inlineStyle: target.style.cssText || null,
    parentInlineStyle: target.parentElement?.style.cssText || null,
    outerHTML: (target.outerHTML || '').slice(0, 240),
    id,
  });
  window.AdnotaEraseRules.set(id, ruleSelector);
  if (!skipStyleRebuild) rebuildEraseStyleTag();

  // ── Animation + post-animation display:none ──
  let activeAnimation = null;
  let consumed = false;
  if (!skipAnimation) {
    spawnFlash(rect);
    activeAnimation = dissolveTarget(target);
    activeAnimation.finished.then(() => {
      if (!consumed) {
        target.style.setProperty('display', 'none', 'important');
        window.AdnotaErasedElements.add(target);
        window.AdnotaUI.attachEraseStyleGuard(target, {
          id, ruleSelector, reason: 'click',
        });
        try { activeAnimation.cancel(); } catch { }
        activeAnimation = null;
        // One-shot "did our erase actually take?" probe. Two rAFs to give the
        // browser a paint cycle for any ad-system MutationObserver to react and
        // re-assert inline display:block !important. If the element is still
        // visible, log it loudly — that's the Freestar-style override pattern.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try {
            if (!target.isConnected) return;
            const cs = getComputedStyle(target);
            if (cs.display !== 'none') {
              window.AdnotaLog?.event('eraser', 'erase-defeated', {
                id,
                ruleSelector,
                computedDisplay: cs.display,
                targetInlineStyle: target.style.cssText || null,
                parentInlineStyle: target.parentElement?.style.cssText || null,
                parentComputedDisplay: target.parentElement
                  ? getComputedStyle(target.parentElement).display : null,
              });
            }
          } catch { }
        }));
      }
    }).catch(() => {
      // Animation was cancelled by undo — do nothing.
    });
  } else {
    // Batch path: skip the dissolve, apply display:none + guard immediately.
    // The batch UI's overlay tear-down provides commit feedback instead.
    target.style.setProperty('display', 'none', 'important');
    window.AdnotaErasedElements.add(target);
    window.AdnotaUI.attachEraseStyleGuard(target, {
      id, ruleSelector, reason: 'batch-commit',
    });
  }

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

      // Restore element to exactly where it was. Detach the style guard
      // FIRST so the cssText reset isn't immediately fought back to none.
      window.AdnotaUI.detachEraseStyleGuard(target);
      target.style.cssText = savedCssText;
      window.AdnotaErasedElements.delete(target);

      // Remove the CSS rule that prevents re-creation.
      window.AdnotaEraseRules.delete(id);
      if (!skipStyleRebuild) rebuildEraseStyleTag();

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

  return { undoEntry, id, adSignals, savedCssText };
}

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

  // Manual erase within an active batch — if the user clicks anywhere inside
  // a highlighted candidate (including descendants like the inner iframe of
  // an ad), erase that candidate and stay in review. No findSimilarAds
  // rescan (we're already reviewing this cluster), no implicit deny. This
  // is literally what "Erase all N more?" does under the hood, but user-
  // driven one at a time. removeBatchCandidate self-dismisses the batch
  // when the count drops to zero.
  //
  // We check the click's actual DOM target (e.target) — not the eraser's
  // bubbled hoveredElement — so a click on a tiny inner ad (which the
  // auto-bubble may not have promoted to the wrapper, low IoU on padded
  // candidates) still resolves to its containing candidate via the
  // ancestor walk.
  if (batchState) {
    const entry = findContainingCandidate(e.target) || findContainingCandidate(target);
    if (entry) {
      highlightOverlay.style.display = 'none';
      hoveredElement = null;

      const result = commitErase(entry.el, { shiftKey: e.shiftKey });
      const innerUndo = result.undoEntry.undo;
      window.AdnotaUndo.push(result.undoEntry);

      window.AdnotaUI.showToast('Element erased', {
        id: 'adnota-eraser-toast',
        onUndo: () => innerUndo(),
      });

      removeBatchCandidate(entry.displayNumber);

      window.AdnotaLog?.event('eraser', 'batch-manual-erase', {
        displayNumber: entry.displayNumber,
        remaining: batchState ? batchState.candidates.length : 0,
      });
      return; // skip the rest of the click handler (no rescan)
    }
  }

  // Implicit deny: any erase click outside the active batch's candidates
  // signals the user is done with the current cluster. Tear it down before
  // running the standard erase so the new target's findSimilarAds
  // (post-settle) can surface a fresh batch on its own merits.
  if (batchState) denyBatch('second-erase');

  // Hover-state teardown — click-handler concern, not commitErase.
  highlightOverlay.style.display = 'none';
  updateHUD(null);
  hoveredElement = null;

  // Commit the erase: anchor + rule + animation + storage + undo entry.
  const { undoEntry, id, adSignals } = commitErase(target, { shiftKey: e.shiftKey });
  // Wrap the seed undo so undoing the trigger click also tears down any
  // batch UI surfaced from it. The batch was caused by this erase — if the
  // user reverses that decision, the batch context is stale.
  const seedUndoOriginal = undoEntry.undo;
  undoEntry.undo = async () => {
    if (batchState) denyBatch('seed-undo');
    await seedUndoOriginal();
  };
  window.AdnotaUndo.push(undoEntry);

  // ── Toast ──
  window.AdnotaUI.showToast('Element erased', {
    id: 'adnota-eraser-toast',
    onUndo: () => undoEntry.undo(),
  });

  // First-time domain-scope tutorial. Only fires on a plain click against a
  // non-ad target — Shift+Click means the user already knows the keystroke,
  // and ads are silently auto-promoted to domain scope so the lesson would
  // be redundant. If a user only ever erases ads, they never see this toast.
  if (!e.shiftKey && adSignals.length === 0) {
    const TUTORIAL_KEY = 'adnotaEraserDomainTutorialShown';
    chrome.storage.local.get(TUTORIAL_KEY).then((data) => {
      if (data[TUTORIAL_KEY]) return;
      chrome.storage.local.set({ [TUTORIAL_KEY]: true });
      window.AdnotaUI?.showToast(
        'Tip: hold Shift while clicking to erase across the entire domain.',
        { id: 'adnota-eraser-domain-tutorial', timeout: 7000 }
      );
    }).catch(() => { /* context invalidated after extension reload */ });
  }

  // ─── Post-settle: findSimilarAds → maybe surface batch ────────────────────
  // Two requestAnimationFrame callbacks intentionally — DO NOT collapse to one.
  // The dissolve animation collapses the erased element in the same frame as
  // the click, AND maybeGeneralizeAdSelector's bare-tag widening hides every
  // cluster sibling synchronously via the rebuilt style tag's !important
  // display:none. Running findSimilarAds synchronously means the visibility
  // filter sees transitional state — getBoundingClientRect returns pre-collapse
  // rects, getComputedStyle hasn't applied the new !important display:none yet.
  // Empirically: 1 rAF on Reddit reports 7 visible cluster siblings, 2 rAF
  // correctly reports 0 (the bare-tag widening already hid them).
  // Two frames is the conservative tradeoff between imperceptible (~32ms)
  // latency and correctness.
  if (target && target.tagName) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        const { candidates, strategies } = findSimilarAds(target);
        const visible = candidates.filter(isCandidateVisible);
        window.AdnotaLog?.event('eraser', 'similars-found', {
          seedId: id,
          seedTag: target.tagName,
          seedClasses: target.className || null,
          totalCount: candidates.length,
          visibleCount: visible.length,
          cappedAt: candidates.length === SIMILAR_ADS_CAP ? SIMILAR_ADS_CAP : null,
          strategies,
          // First few visible candidates for diagnostic — what did we actually find?
          sampleSelectors: visible.slice(0, 5).map(c => {
            try { return window.FuzzyAnchor.generateCSSSelector(c); } catch { return '?'; }
          }),
        });
        if (visible.length > 0 && window.AdnotaState.mode === 'eraser') {
          enterBatch(visible);
        }
      } catch (err) {
        window.AdnotaLog?.event('eraser', 'similars-found-error', { error: String(err) });
      }
    }));
  }

}, true); // Capture phase — intercept before the page's own handlers.

// ── Public API ───────────────────────────────────────────────────────────────
// removeOne(id): live-state revert for a single erasure, used by the scratch
// pad's per-row trash. Caller is responsible for storage deletion. Reverts:
// drops the selector from the rules Map and rebuilds the override style tag,
// clears the inline `display: none` on the resolved element, detaches the
// style guard, and drops the element from AdnotaErasedElements. Safe when
// the element is no longer in the DOM (e.g., page mutated after erase).
function removeOneErase(id) {
  const selector = window.AdnotaEraseRules?.get(id);
  let target = null;
  if (selector) {
    try { target = document.querySelector(selector); } catch (_) {}
  }
  if (target) {
    try { window.AdnotaUI?.detachEraseStyleGuard?.(target); } catch (_) {}
    target.style.removeProperty('display');
    try { window.AdnotaErasedElements?.delete(target); } catch (_) {}
  }
  window.AdnotaEraseRules?.delete(id);
  if (typeof window.rebuildEraseStyleTag === 'function') {
    window.rebuildEraseStyleTag();
  }
  window.AdnotaLog?.event('eraser', 'remove-one', { id, sel: selector || null, found: !!target });
}

// applyOne(record): inverse of removeOne — re-applies a single erasure to
// the live page from a storage record. Used when scratch pad undo restores
// a trashed entry. Sets the rule in AdnotaEraseRules + rebuilds the style
// tag (the CSS hide is the primary mechanism); also sets the inline guard
// state on the resolved element when present so override-resistant pages
// stay erased like they did before deletion.
function applyOneErase(record) {
  if (!record) return;
  const id = record._id;
  const selector = record.selector || record.anchor?.cssSelector;
  if (!id || !selector) return;
  if (!window.AdnotaEraseRules) return;
  window.AdnotaEraseRules.set(id, selector);
  if (typeof window.rebuildEraseStyleTag === 'function') {
    window.rebuildEraseStyleTag();
  }
  let target = null;
  try { target = document.querySelector(selector); } catch (_) {}
  if (target) {
    target.style.setProperty('display', 'none', 'important');
    try { window.AdnotaErasedElements?.add(target); } catch (_) {}
    try {
      window.AdnotaUI?.attachEraseStyleGuard?.(target, {
        id, ruleSelector: selector, reason: 'undo-restore',
      });
    } catch (_) {}
  }
  window.AdnotaLog?.event('eraser', 'apply-one', { id, sel: selector, found: !!target });
}

window.AdnotaEraser = Object.assign(window.AdnotaEraser || {}, {
  removeOne: removeOneErase,
  applyOne: applyOneErase,
});
