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
    const caps = snapshot.sizeCaps;
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

  function getElementConstraints(el) {
    return {
      clippingAncestors: detectClippingAncestors(el),
      sizeCaps: detectSizeCaps(el),
    };
  }

  window.AdnotaLayout = {
    detectClippingAncestors,
    detectSizeCaps,
    findGrowthOverflow,
    getElementConstraints,
  };
})();
