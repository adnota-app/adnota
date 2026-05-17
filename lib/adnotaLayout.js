// AdnotaLayout — shared layout-detection helpers for content scripts.
//
// Today: detect "silent growth blockers" — situations where a tool changes
// an element's size or position but the visible result is masked by a
// clipping ancestor (overflow: hidden | clip on a parent / grandparent).
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

  window.AdnotaLayout = {
    detectClippingAncestors,
    detectFillModeRisk,
    findGrowthOverflow,
  };
})();
