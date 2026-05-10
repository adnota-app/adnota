// AdnotaLayout — shared layout-detection helpers for content scripts.
//
// Today: detect "silent growth blockers" — situations where a tool changes
// an element's size or position but the visible result is masked. Two
// causes covered:
//   1. Clipping ancestor (overflow: hidden | clip on a parent / grandparent)
//   2. Element-level cap (max-width / max-height on the element itself)
//
// Designed to be called from any content script. The resizer is the first
// consumer; eraser / marker / sticky may layer on later.

(function () {
  if (window.AdnotaLayout) return;

  const VIEWPORT_SLACK_PX = 8;
  const DEFAULT_MAX_DEPTH = 30;
  const OVERFLOW_CLIPS = new Set(['hidden', 'clip']);

  // Same-rect IoU threshold — load-bearing constant. `bubbleToVisualRoot`
  // in lib/adnotaUI.js uses the same threshold for its outermost-wins
  // climb (see feedback_eraser_outermost_walk.md memory). The breadcrumb's
  // visibility rule references it for "would Shift+scroll skip this
  // ancestor?" classification. Both consumers MUST reference this single
  // constant so a future tune of the eraser/resizer behavior can't drift
  // away from the breadcrumb's classification.
  const SAME_RECT_IOU_THRESHOLD = 0.85;

  function detectClippingAncestors(el, opts) {
    const { maxDepth = DEFAULT_MAX_DEPTH, skipViewport = true } = opts || {};
    const out = [];
    if (!el || !el.parentElement) return out;
    let cur = el.parentElement;
    let depth = 0;
    const html = document.documentElement;
    const body = document.body;
    while (cur && depth < maxDepth) {
      if (skipViewport && (cur === html || cur === body)) break;
      const cs = getComputedStyle(cur);
      const clipX = OVERFLOW_CLIPS.has(cs.overflowX);
      const clipY = OVERFLOW_CLIPS.has(cs.overflowY);
      if (clipX || clipY) {
        const r = cur.getBoundingClientRect();
        const isViewportSizedW = r.width >= window.innerWidth - VIEWPORT_SLACK_PX;
        const isViewportSizedH = r.height >= window.innerHeight - VIEWPORT_SLACK_PX;
        if (!(isViewportSizedW && isViewportSizedH)) {
          out.push({ el: cur, axes: { x: clipX, y: clipY }, distance: depth });
        }
      }
      cur = cur.parentElement;
      depth++;
    }
    return out;
  }

  function readPxCap(value) {
    if (!value || value === 'none') return null;
    const n = parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function detectSizeCaps(el) {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const maxW = readPxCap(cs.maxWidth);
    const maxH = readPxCap(cs.maxHeight);
    if (maxW == null && maxH == null) return null;
    return { maxW, maxH };
  }

  function paddingBoxOf(ancestor) {
    const r = ancestor.getBoundingClientRect();
    const left = r.left + ancestor.clientLeft;
    const top = r.top + ancestor.clientTop;
    return {
      left,
      top,
      right: left + ancestor.clientWidth,
      bottom: top + ancestor.clientHeight,
    };
  }

  function findGrowthOverflow(el, snapshot) {
    if (!el || !snapshot) return null;
    const r = el.getBoundingClientRect();

    const clipAncestors = snapshot.clipAncestors || [];
    for (const c of clipAncestors) {
      const pb = paddingBoxOf(c.el);
      let xOver = false, yOver = false;
      if (c.axes.x) {
        if (r.right > pb.right + 1 || r.left < pb.left - 1) xOver = true;
      }
      if (c.axes.y) {
        if (r.bottom > pb.bottom + 1 || r.top < pb.top - 1) yOver = true;
      }
      if (xOver || yOver) {
        const axis = xOver && yOver ? 'both' : (xOver ? 'x' : 'y');
        return { kind: 'clip-ancestor', ancestor: c.el, axis };
      }
    }

    // Size-cap pass — element at its own max-width / max-height. We fire only
    // when the rect is APPROXIMATELY AT the cap (within ~1.5px), not when it
    // exceeds it. Reason: caps in computed-style aren't always binding —
    // negative margins, table layouts, and some overflow configurations let
    // an element grow past its declared max. When rect.width > cap the cap
    // is effectively non-binding, so flagging "capped" misleads the user.
    // Equality-within-tolerance distinguishes "at the cap" (binding) from
    // "above the cap" (overridden) cleanly.
    //
    // Skip this pass entirely when fillModeRisk is set: the resizer's fill-
    // mode strategy writes its own max-width/max-height to lock the
    // non-dragged axis and prevent intrinsic-aspect-ratio runaway. Those
    // caps would then read back as "user-set" and fire the chip every time
    // the rect matches our own writes — pure self-referential noise.
    const caps = !snapshot.fillModeRisk ? snapshot.sizeCaps : null;
    if (caps) {
      let xCap = false, yCap = false;
      if (caps.maxW != null && Math.abs(r.width - caps.maxW) < 1.5) xCap = true;
      if (caps.maxH != null && Math.abs(r.height - caps.maxH) < 1.5) yCap = true;
      if (xCap || yCap) {
        const axis = xCap && yCap ? 'both' : (xCap ? 'x' : 'y');
        return { kind: 'size-cap', axis };
      }
    }

    return null;
  }

  // Fill-mode-risk detection — does the selected element (or a descendant)
  // use the "absolute + inset:0 + min/max:100% on both axes" pattern that
  // Next.js / Gatsby / similar libraries use to make a replaced element
  // (img/video/canvas) fill its container?
  //
  // Why we care: the resizer's drag strategy clears `min-width: 0; max-width:
  // none` on X-axis writes to free the element from inline width constraints.
  // When that pattern exists below the resize target, clearing the X-axis
  // 100%-pin exposes the descendant's intrinsic aspect ratio. With no
  // upper height bound on the grow path, height runs away to match width
  // (e.g. a square source image makes the whole banner grow square). This
  // detector flags the risk so the strategy can keep both axes hard-bounded
  // through the drag.
  function detectFillModeRisk(el, opts) {
    const { maxDescendants = 30 } = opts || {};
    if (!el) return false;
    if (looksLikeFillTarget(el)) return true;
    let count = 0;
    const candidates = el.querySelectorAll('img, video, canvas');
    for (const c of candidates) {
      if (++count > maxDescendants) break;
      if (looksLikeFillTarget(c)) return true;
      // Next.js explicit signal — `<Image fill>` adds `data-nimg="fill"`.
      // Catch it even if the inline-style sniff misses (older next versions).
      const nimg = c.getAttribute && c.getAttribute('data-nimg');
      if (nimg === 'fill') return true;
    }
    return false;
  }

  function looksLikeFillTarget(el) {
    if (!el || !el.style) return false;
    const s = el.style;
    // Cheap inline-style sniff first — the Next.js / Gatsby fill pattern
    // always sets these inline literally as `100%`. Computed values would
    // resolve to px and require a parent comparison, so the inline check
    // is both faster and more reliable for this signature.
    if (s.minWidth !== '100%' || s.maxWidth !== '100%' ||
        s.minHeight !== '100%' || s.maxHeight !== '100%') return false;
    const cs = getComputedStyle(el);
    return cs.position === 'absolute';
  }

  function getElementConstraints(el) {
    return {
      clippingAncestors: detectClippingAncestors(el),
      sizeCaps: detectSizeCaps(el),
      fillModeRisk: detectFillModeRisk(el),
    };
  }

  // Intersection-over-union of two element rects. Mirrors the IoU math
  // inside bubbleToVisualRoot but stand-alone so any tool can classify
  // "are these two rects effectively the same visual unit?" against the
  // shared SAME_RECT_IOU_THRESHOLD without re-implementing the math.
  function getRectIoU(elA, elB) {
    if (!elA || !elB) return 0;
    const a = elA.getBoundingClientRect();
    const b = elB.getBoundingClientRect();
    const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const inter = ix * iy;
    const union = a.width * a.height + b.width * b.height - inter;
    return union > 0 ? inter / union : 0;
  }

  // Walk ancestors up from `el`, capped at viewport-dominating ancestor
  // (matches Shift+scroll's upper bound). Used by the breadcrumb to render
  // the structural path. Includes ALL ancestors regardless of layout
  // significance — the breadcrumb classifies / hides via its own rules
  // (same-rect collapse + constraint surfacing) rather than gating here.
  function getAncestorChain(el, opts) {
    const { maxDepth = DEFAULT_MAX_DEPTH } = opts || {};
    if (!el) return [];
    const chain = [el];
    let cur = el.parentElement;
    let depth = 0;
    const isAdnotaElement = window.AdnotaUI?.isAdnotaElement;
    const dominatesViewport = window.AdnotaUI?.dominatesViewport;
    while (cur && depth < maxDepth) {
      if (isAdnotaElement && isAdnotaElement(cur)) break;
      if (cur === document.body || cur === document.documentElement) break;
      chain.unshift(cur);
      if (dominatesViewport && dominatesViewport(cur.getBoundingClientRect())) break;
      cur = cur.parentElement;
      depth++;
    }
    return chain;
  }

  // Per-ancestor constraint lookup. Returns the constraint kind that
  // applies to `ancestorEl` from `selectedEl`'s perspective, or null.
  // For batch callers (the breadcrumb iterating the ancestor chain),
  // pass a pre-computed `clips` list so this doesn't re-walk
  // detectClippingAncestors per ancestor — that walk is ~30 ancestors
  // × getComputedStyle each, easily ~600 reads per breadcrumb build
  // on Tailwind-heavy pages without batching.
  function getAncestorConstraint(selectedEl, ancestorEl, opts) {
    if (!ancestorEl || !selectedEl) return null;
    if (ancestorEl === selectedEl) return null;
    if (!ancestorEl.contains(selectedEl)) return null;
    const clips = (opts && opts.clips) || detectClippingAncestors(selectedEl);
    const clipMatch = clips.find((c) => c.el === ancestorEl);
    if (clipMatch) return { kind: 'clip-ancestor', axes: clipMatch.axes };
    // size-cap and fill-mode are properties of the SELECTED element and
    // surface in the chip cluster (not the breadcrumb). Per-ancestor
    // versions would require running detectors against each ancestor as
    // the hypothetical resize target — deferred to v1.1+.
    return null;
  }

  window.AdnotaLayout = {
    SAME_RECT_IOU_THRESHOLD,
    detectClippingAncestors,
    detectSizeCaps,
    detectFillModeRisk,
    findGrowthOverflow,
    getElementConstraints,
    getRectIoU,
    getAncestorChain,
    getAncestorConstraint,
  };
})();
