// content/restorer.js

const processedItems = new Set();
// Markers that rendered at a fallback tier (container ancestor or doc pixels)
// and are eligible for upgrade to tier 1 (FuzzyAnchor on the original block)
// on a later mutation pass. Held outside processedItems so the dispatch loop
// re-enters them; the dispatch checks this set to skip re-rendering at
// fallback when tier 1 still misses, preventing duplicate wrappers and an
// every-pass re-paint loop.
const pendingMarkerUpgrade = new Set();
let initialRestorationDone = false;
let lastProcessedUrl = null;
// In-flight guard: rapid SPA nav (claude.ai chat hopping) can fire the
// MutationObserver again while a previous performRestoration call is still
// awaiting storage I/O. Without the guard, two concurrent runs both clear
// processedItems and both run teardown — wasteful, and the second tearDown
// races with the first run's render writes. Cheap to prevent.
let restorationInFlight = false;

// Tear down every rendered annotation owned by the previous URL. Called on
// SPA URL change before re-running restoration for the new URL. Each engine
// owns its own DOM (#adnota-marker-overlay, .adnota-sticky-container,
// CSS Custom Highlights + fallback wrappers, ERASE/RESIZE <style> tags),
// all of which sit outside React's tree under data-adnota-ui — so React
// never unmounts them on its own. Storage is left untouched; the next pass
// repaints whatever belongs to the new URL.
async function tearDownAllAnnotations() {
  window.AdnotaLog?.event('restorer', 'spa-teardown', {
    fromUrl: lastProcessedUrl,
    toUrl: location.href,
    eraseRules: window.AdnotaEraseRules ? window.AdnotaEraseRules.size : 0,
    resizeRules: window.AdnotaResizeRules ? window.AdnotaResizeRules.size : 0,
    erasedElements: window.AdnotaErasedElements ? window.AdnotaErasedElements.size : 0,
  });
  if (window.AdnotaMarker?.tearDownAll) window.AdnotaMarker.tearDownAll();
  if (window.AdnotaHighlighter?.tearDownAll) window.AdnotaHighlighter.tearDownAll();
  if (window.StickyEngine?.tearDownAll) await window.StickyEngine.tearDownAll();

  if (window.AdnotaEraseRules) {
    window.AdnotaEraseRules.clear();
    if (window.rebuildEraseStyleTag) window.rebuildEraseStyleTag();
  }
  if (window.AdnotaResizeRules) {
    window.AdnotaResizeRules.clear();
    if (window.rebuildResizeStyleTag) window.rebuildResizeStyleTag();
  }
  // Inline-style erases tracked on real DOM nodes — those nodes are usually
  // already gone after the React swap, but clear the Set so we don't hold
  // stale references and the show/hide toggle starts fresh. Detach style
  // guards along the way; any element that survived the swap shouldn't keep
  // an idle MutationObserver into the next route.
  if (window.AdnotaErasedElements) {
    for (const el of window.AdnotaErasedElements) {
      window.AdnotaUI?.detachEraseStyleGuard(el);
    }
    window.AdnotaErasedElements.clear();
  }
  // Undo history is route-scoped. Without this, Ctrl+Z after a route
  // change pops entries whose closures reference DOM elements from the
  // previous route (already torn down above), silently mutating storage
  // for a page the user isn't on anymore. Full reload already clears the
  // stack by destroying the content-script context; this is the SPA-nav
  // equivalent.
  window.AdnotaUndo?.clear();
}

function showBrokenAnchorsToast(count) {
  // De-duplicate: only one broken-anchor toast at a time.
  if (document.getElementById('adnota-broken-toast')) return;

  const plural = count === 1 ? '' : 's';
  const toast = document.createElement('div');
  toast.id = 'adnota-broken-toast';
  toast.className = 'adnota-toast';
  toast.setAttribute('data-adnota-ui', '1');
  toast.innerHTML = `
    <div class="adnota-toast-logo">A</div>
    <span class="adnota-toast-message">${count} saved edit${plural} couldn't be reapplied — this page may have changed.</span>
    <div class="adnota-toast-actions">
      <span class="adnota-toast-btn" id="adnota-broken-dismiss">Dismiss</span>
    </div>
  `;

  // Wait for body to exist (may be called early on some pages).
  const attach = () => {
    (document.body || document.documentElement).appendChild(toast);

    document.getElementById('adnota-broken-dismiss').addEventListener('click', () => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    });

    // Auto-dismiss after 14 seconds — longer than the standard 5s delete toast
    // because this requires the user to actually read and comprehend it.
    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      }
    }, 14000);
  };

  if (document.body) {
    attach();
  } else {
    window.addEventListener('DOMContentLoaded', attach, { once: true });
  }
}

async function performRestoration(trigger) {
  if (!window.AdnotaStorage || !window.FuzzyAnchor) return;
  if (restorationInFlight) {
    window.AdnotaLog?.event('restorer', 'reentrant-drop', { url: location.href, trigger });
    return;
  }
  restorationInFlight = true;
  try {
    await _performRestoration(trigger);
  } finally {
    restorationInFlight = false;
  }
}

async function _performRestoration(trigger) {
  const passStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const isSpaNav = lastProcessedUrl !== null && lastProcessedUrl !== location.href;
  const resolvedTrigger = trigger || (isSpaNav ? 'spa-nav' : (lastProcessedUrl === null ? 'initial' : 'mutation'));
  // SPA in-app nav (/foo → /bar → /foo): processedItems is module-scoped and
  // not URL-keyed, so on return to /foo every ID is already present and the
  // loop below would skip the entire URL. Clear on URL change so each visit
  // gets a fresh restoration pass; the existing MutationObserver fires on
  // SPA-nav DOM swap, so no popstate/pushState hook is needed. Also tear
  // down the previous URL's rendered overlays — they live outside React's
  // tree under data-adnota-ui, so without an explicit teardown they
  // accumulate across SPA navigations on app shells like claude.ai.
  if (isSpaNav) {
    await tearDownAllAnnotations();
    processedItems.clear();
    pendingMarkerUpgrade.clear();
    initialRestorationDone = false;
  }
  lastProcessedUrl = location.href;

  // Re-validate previously-applied highlights before consulting
  // processedItems. React-driven SPAs (claude.ai, ChatGPT) commonly
  // swap text-node DOM under us *after* applyStoredHighlight succeeded,
  // leaving the registered Range pointing at detached nodes. CSS Custom
  // Highlights paints nothing in that state and we have no signal otherwise,
  // so each pass we drop stale entries from processedItems and let them
  // re-apply against the current DOM further down.
  if (window.AdnotaHighlighter?.pruneStaleHighlights) {
    const pruned = window.AdnotaHighlighter.pruneStaleHighlights();
    for (const id of pruned) processedItems.delete(id);
    if (pruned.length) {
      window.AdnotaLog?.event('restorer', 'pruned-stale', { count: pruned.length, ids: pruned });
    }
  }

  const anchors = await window.AdnotaStorage.getAnchorsForUrl(location.href);
  if (!anchors || anchors.length === 0) {
    document.documentElement.classList.remove('adnota-route-changing');
    return;
  }

  const sizeBefore = processedItems.size;
  let erasuresCount = 0;
  let notesCount = 0;
  let resizeCount = 0;
  let brokenThisPass = 0;

  for (const item of anchors) {
    const id = item.uuid || item._id || item.storageId || JSON.stringify(item);
    if (processedItems.has(id)) continue;

    window.AdnotaLog?.event('restorer', 'dispatch', {
      action: item.action,
      id,
      sel: item.anchor?.cssSelector || item.selector || null,
      tag: item.anchor?.tagName || null,
    });

    // ── Resize overrides: inject via <style> tag — no DOM anchoring needed. ────
    if (item.action === 'RESIZE') {
      // REFLOW v1.5 fork: dom-reorder rules don't produce CSS — they need a
      // physical DOM move re-applied via FuzzyAnchor + a guard observer.
      // Higher confidence on parent (60) than source (40) because parents
      // are often structural wrappers with weaker text/structure signals,
      // and a false-positive parent match plants the source inside a
      // wrong-but-similar container (silent visual bug). If anchors fail,
      // leave the item out of processedItems so the next MutationObserver
      // pass retries against the now-loaded DOM.
      if (item.kind === 'reflow:dom-reorder' && item._id) {
        // Resolve the SOURCE only — parent comes from source.parentElement.
        // Generic structural parents (`<div class="article-content">`) often
        // score low on FuzzyAnchor because their class alone isn't unique
        // enough for full CSS points. But once the source resolves, its
        // current DOM parent is authoritative — moving the source to the
        // end of *its own parent* doesn't need fuzzy matching, just a ref.
        // parentAnchor is kept on the storage entry for validateReorderRules
        // (the parent-unmount fallback path), but not consulted here.
        // Keep in sync with REORDER_SOURCE_CONFIDENCE_MIN in resizer.js —
        // a number small enough that exporting it would be heavier than
        // grepping if either drifts.
        const SOURCE_MIN = 40;
        const sm = window.FuzzyAnchor?.findMatch?.(item.sourceAnchor);
        if (!sm?.element || sm.confidence < SOURCE_MIN) {
          window.AdnotaLog?.event('restorer', 'reorder-anchor-fail', {
            id, sourceConf: sm?.confidence ?? null,
            sourceSel: item.sourceAnchor?.cssSelector,
          });
          continue;  // skip; retry on next pass
        }
        const source = sm.element;
        const parent = source.parentElement;
        if (!parent) {
          window.AdnotaLog?.event('restorer', 'reorder-no-parent', { id });
          continue;
        }
        if (!window.AdnotaResizer?.applyReorderMove || !window.AdnotaResizer?.attachReorderGuard) {
          window.AdnotaLog?.event('restorer', 'reorder-resizer-missing', { id });
          continue;
        }
        // Detach-before-overwrite: SPA route change re-runs restorer. The
        // prior liveRule (with its now-stale parentEl + observer attached
        // to detached DOM) is about to be replaced; disconnect first.
        const prior = window.AdnotaReorderRules?.get(item._id);
        if (prior) window.AdnotaResizer.detachReorderGuard(prior);
        window.AdnotaResizer.applyReorderMove(source, parent, item.toPosition);
        const liveRule = {
          id: item._id,
          sourceEl: source, parentEl: parent,
          sourceAnchor: item.sourceAnchor,
          parentAnchor: item.parentAnchor,
          originalPrevAnchor: item.originalPrevAnchor,
          toPosition: item.toPosition,
          observer: null, fights: 0,
        };
        window.AdnotaReorderRules?.set(item._id, liveRule);
        window.AdnotaResizer.attachReorderGuard(liveRule);
        window.AdnotaLog?.event('restorer', 'reorder-applied', {
          id, sourceConf: sm.confidence,
          toPosition: item.toPosition,
        });
        processedItems.add(id);
        resizeCount++;
        continue;
      }

      // Go through the shared Map so rebuild is the single source of truth.
      // Older fallback (plain textContent append) is kept for the rare case
      // where resizer.js hasn't loaded yet — extremely unlikely at restore time.
      if (window.AdnotaResizeRules && item._id) {
        // Carry `kind` through so commitResizeRule's de-dup matches against
        // restored rules — a stored toggle-stack that survives reload still
        // gets replaced by a fresh toggle-stack commit instead of stacking.
        window.AdnotaResizeRules.set(item._id, {
          selector: item.selector,
          cssText: item.cssText,
          kind: item.kind,
        });
        if (window.rebuildResizeStyleTag) window.rebuildResizeStyleTag();
      } else {
        let styleTag = document.getElementById('adnota-style-overrides');
        if (!styleTag) {
          styleTag = document.createElement('style');
          styleTag.id = 'adnota-style-overrides';
          styleTag.setAttribute('data-adnota-ui', '1');
          document.head.appendChild(styleTag);
        }
        styleTag.textContent += `${item.selector} { ${item.cssText} }\n`;
      }
      processedItems.add(id);
      resizeCount++;
      continue;
    }

    // ── Sticky notes: hybrid anchor + percentage fallback. ────────────────
    // Notes always render somewhere — if FuzzyAnchor misses, updatePosition()
    // falls back to percentage placement so no work is lost. But if the
    // anchor didn't resolve and the page still has anchor data we could
    // re-attempt against, leave the item out of processedItems so the next
    // MutationObserver pass can retry against a more-loaded DOM. Mirrors
    // the HIGHLIGHT applied/processed split.
    if (item.action === 'NOTE') {
      let anchorResolved = false;
      if (window.StickyEngine) {
        const existing = document.querySelector(`.adnota-sticky-container[data-uuid="${item.uuid}"]`);
        if (existing) {
          // Already rendered — just retry anchor resolution against the
          // current DOM. Snaps the note from its percentage-fallback spot
          // to the right one if the anchor element finally appeared.
          anchorResolved = window.StickyEngine.updatePosition(item.uuid);
        } else {
          anchorResolved = window.StickyEngine.renderNote(
            item.placement, item.comments, item.uuid, false,
            item.dimensions || null,
            item.theme || 'adnota-theme-yellow',
            item.anchor || null,
            item.anchorOffset || null,
            item.tag || '',
            item.fallback || null
          );
        }
      }
      // Only retryable if we actually have anchor data to resolve. Legacy
      // notes (placement-only) and a missing StickyEngine both mark
      // processed immediately so we don't loop forever on items where
      // percentage placement is the final answer.
      const retryable = !!(window.StickyEngine && item.anchor && item.anchorOffset);
      if (anchorResolved || !retryable) {
        processedItems.add(id);
      } else {
        brokenThisPass++;
        window.AdnotaLog?.event('restorer', 'apply-fail', {
          action: 'NOTE', id, sel: item.anchor?.cssSelector || null,
        });
      }
      notesCount++;
      continue;
    }

    // ── ERASE with CSS selector: inject rule + best-effort FuzzyAnchor ──────
    if (item.action === 'ERASE' && item.selector) {
      // CSS rule hides the element (and any future re-creations like ad rotations)
      let eraseTag = document.getElementById('adnota-erase-overrides');
      if (!eraseTag) {
        eraseTag = document.createElement('style');
        eraseTag.id = 'adnota-erase-overrides';
        eraseTag.setAttribute('data-adnota-ui', '1');
        document.head.appendChild(eraseTag);
      }
      // Widen ad-slot selectors so rotating impressions in the same slot stay
      // hidden across reloads. Older entries saved before this generalization
      // existed get upgraded transparently on the next restore pass — the
      // anchor.tagName carried in storage is enough to derive the wider rule.
      const ruleSelector = window.AdnotaUI
        ? window.AdnotaUI.maybeGeneralizeAdSelector(item.selector, item.anchor?.tagName)
        : item.selector;
      if (window.AdnotaEraseRules) {
        window.AdnotaEraseRules.set(id, ruleSelector);
        if (window.rebuildEraseStyleTag) window.rebuildEraseStyleTag();
      } else {
        eraseTag.textContent += `${ruleSelector} { display: none !important; }\n`;
      }

      // Best-effort: also add to AdnotaErasedElements for inline show/hide toggle
      const match = window.FuzzyAnchor.findMatch(item.anchor);
      if (match.confidence >= 40 && match.element) {
        match.element.style.setProperty('display', 'none', 'important');
        if (window.AdnotaErasedElements) window.AdnotaErasedElements.add(match.element);
        // Re-assert against late inline-style overrides (Freestar-style ad
        // slot init that fires seconds after page load and clobbers our rule).
        window.AdnotaUI?.attachEraseStyleGuard(match.element, {
          id, ruleSelector, reason: 'restore',
        });
      }
      // Two-rAF probe: if the page (Freestar et al.) re-asserts inline
      // display:block !important on the erased element after our rule fires,
      // computed display will still be visible. Inline !important beats our
      // stylesheet !important — the user sees the ad come back. Log loudly
      // so the failure mode is self-evident from the console.
      if (match.confidence >= 40 && match.element) {
        const probed = match.element;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try {
            if (!probed.isConnected) return;
            const cs = getComputedStyle(probed);
            if (cs.display !== 'none') {
              window.AdnotaLog?.event('restorer', 'erase-defeated', {
                id,
                ruleSelector,
                savedSelector: item.selector,
                computedDisplay: cs.display,
                targetInlineStyle: probed.style.cssText || null,
                parentInlineStyle: probed.parentElement?.style.cssText || null,
                parentComputedDisplay: probed.parentElement
                  ? getComputedStyle(probed.parentElement).display : null,
              });
            }
          } catch { }
        }));
      }
      // CSS rule has us covered — mark processed regardless of FuzzyAnchor result
      processedItems.add(id);
      erasuresCount++;
      continue;
    }

    // ── All other items need a DOM match via FuzzyAnchor. ───────────────────
    // For HIGHLIGHTs, hand the saved text to findMatch so it can skip
    // candidates that scored above threshold but don't actually contain
    // the highlighted text — common false-positive on heavy SPAs.
    const match = window.FuzzyAnchor.findMatch(
      item.anchor,
      item.action === 'HIGHLIGHT' && item.text ? { containsText: item.text } : undefined
    );

    const isMarkerPendingUpgrade = item.action === 'MARKER' && pendingMarkerUpgrade.has(id);

    if (match.confidence >= 40 && match.element) {
      // applyStoredHighlight can succeed at the FuzzyAnchor level but still
      // return false if the matched element doesn't actually contain the
      // saved text (false-positive candidate from word-overlap, or content
      // mid-stream on a slow-rendering SPA). Track that explicitly so we
      // don't lock the item into processedItems and lose retries on later
      // mutation passes. ERASE/MARKER paths don't have a return-value
      // signal — assume success there.
      let applied = false;
      if (item.action === 'HIGHLIGHT') {
        if (window.AdnotaHighlighter) {
          applied = !!window.AdnotaHighlighter.applyStoredHighlight(match.element, item);
        }
      } else if (item.action === 'MARKER') {
        if (window.AdnotaMarker) {
          // Tier 1 upgrade: if this marker was previously rendered at tier
          // 2/3 (visible at the fallback position but not following the
          // real anchor on app shells), tear the old wrapper down before
          // re-rendering. renderMarker's own duplicate-uuid guard would
          // otherwise short-circuit and leave the marker stuck at the
          // wrong spot forever.
          if (isMarkerPendingUpgrade) {
            window.AdnotaMarker.tearDownById?.(item.uuid);
            pendingMarkerUpgrade.delete(id);
            window.AdnotaLog?.event('restorer', 'marker-upgrade', {
              id, score: match.confidence, sel: item.anchor?.cssSelector || null,
            });
          }
          window.AdnotaMarker.renderMarker(match.element, item);
          applied = true;
        }
      } else {
        // ERASE (legacy items without selector) — inline style only
        match.element.style.setProperty('display', 'none', 'important');
        if (window.AdnotaErasedElements) window.AdnotaErasedElements.add(match.element);
        erasuresCount++;
        applied = true;
      }
      if (applied) {
        processedItems.add(id);
      } else {
        window.AdnotaLog?.event('restorer', 'apply-fail', {
          action: item.action, id, score: match.confidence,
          sel: item.anchor?.cssSelector || null,
        });
        brokenThisPass++;
      }
    } else if (isMarkerPendingUpgrade) {
      // Already rendered at tier 2/3 on a prior pass; tier 1 still missing.
      // No re-render (renderMarker's duplicate guard would early-return
      // anyway, but explicitly skipping avoids the wasted FuzzyAnchor work
      // on every mutation tick). Stay in pendingMarkerUpgrade so the next
      // pass tries tier 1 again. Steady-state silence: no broken bump, no
      // log spam — the existing render is visually fine, we're just
      // hoping for an upgrade.
    } else if (
      item.action === 'MARKER' &&
      item.fallbackBox &&
      window.AdnotaMarker
    ) {
      window.AdnotaLog?.event('restorer', 'resolve-fail', {
        action: item.action, id, score: match.confidence,
        sel: item.anchor?.cssSelector || null,
      });
      // FuzzyAnchor missed the original block. Try the scroll-container
      // ancestor first — it's usually a stable layout shell (main, app
      // wrapper) that FuzzyAnchor can resolve, and rendering against it
      // means the marker scrolls with content on app shells where the body
      // doesn't scroll. Fall through to documentElement only if that misses
      // too, so the marker still appears (drifted, doesn't follow scroll).
      let rendered = false;
      if (item.fallbackBox.containerAnchor) {
        const cMatch = window.FuzzyAnchor.findMatch(item.fallbackBox.containerAnchor);
        if (cMatch.confidence >= 40 && cMatch.element) {
          item._fallbackContainer = cMatch.element;
          window.AdnotaMarker.renderMarker(cMatch.element, item);
          rendered = true;
          window.AdnotaLog?.event('restorer', 'fallback-used', { id, tier: 'container' });
        }
      }
      if (!rendered && item.fallbackBox.docLeft != null) {
        window.AdnotaMarker.renderMarker(document.documentElement, item);
        rendered = true;
        window.AdnotaLog?.event('restorer', 'fallback-used', { id, tier: 'docpx' });
      }
      // Mark for upgrade rather than processed — tier 1 may resolve on a
      // later mutation pass once the host page finishes rendering, and we
      // want to swap the marker to its real anchor when it does. Without
      // this the marker is locked at tier 2/3 forever (the previous bug:
      // "doesn't reattach on page load on a lot of the AI sites").
      if (rendered) pendingMarkerUpgrade.add(id);
      else brokenThisPass++;
    } else {
      // Item hasn't been successfully applied yet — count it as broken for this pass.
      window.AdnotaLog?.event('restorer', 'resolve-fail', {
        action: item.action, id, score: match.confidence,
        sel: item.anchor?.cssSelector || null,
      });
      brokenThisPass++;
    }
  }

  // Reorder validation: catches the parent-unmount case the per-rule
  // observers can't see. The per-rule observer is bound to parentEl with
  // subtree:false, so when a framework component above the reorder target
  // re-renders and replaces parentEl entirely, the observer is stuck on a
  // detached node and our move silently disappears. This pass walks the
  // live Map, finds rules whose parentEl is no longer connected, re-resolves
  // via parentAnchor, and re-attaches a fresh observer. Cheap (O(rules) +
  // O(1) isConnected per rule) and piggybacks on this existing debounced
  // mutation pass — no separate page-wide observer needed.
  try { window.AdnotaResizer?.validateReorderRules?.(); } catch (_) {}

  // Steady-state guard: on heavy SPAs the MutationObserver wakes us every
  // ~2.5s for the lifetime of the tab. If nothing was newly processed and
  // nothing's broken, the chrome.storage write (and its onChanged fan-out
  // to popup + Sites page) is pure noise. Skip it.
  const grew = processedItems.size > sizeBefore;
  const hasBroken = brokenThisPass > 0;
  if (grew || hasBroken) {
    chrome.storage.local.set({
      adnota_stats: {
        [location.href]: { success: erasuresCount, notes: notesCount, resizes: resizeCount, broken: brokenThisPass }
      }
    });

    // Only toast on the first pass (initial page load).
    // MutationObserver re-runs silently retry — no toast spam.
    if (!initialRestorationDone && hasBroken) {
      showBrokenAnchorsToast(brokenThisPass);
    }
  }
  initialRestorationDone = true;

  // Reveal annotations now that the new URL's pass has completed. The class
  // was set by the Navigation API listener at route-start to hide the previous
  // URL's overlays; clearing it here means the user sees the new state appear,
  // not lingering ghosts. Cleared unconditionally so a no-op pass (no items
  // for this URL) still un-hides for any subsequent renders triggered later.
  if (document.documentElement.classList.contains('adnota-route-changing')) {
    document.documentElement.classList.remove('adnota-route-changing');
    window.AdnotaLog?.event('restorer', 'route-changing-off', { url: location.href });
  }

  // Steady-state silence: only log when something actually happened. Same
  // condition that gates the storage write below — the existing design point
  // is that idle MutationObserver ticks on long-lived SPA tabs should be a
  // no-op for downstream surfaces (popup, Sites page, console).
  if (grew || hasBroken) {
    window.AdnotaLog?.event('restorer', 'pass-end', {
      url: location.href,
      trigger: resolvedTrigger,
      itemCount: anchors.length,
      newItems: processedItems.size - sizeBefore,
      brokenThisPass,
      erasures: erasuresCount,
      notes: notesCount,
      resizes: resizeCount,
      durationMs: Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - passStart)),
    });
  }
}

// Initial fire
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  performRestoration('initial');
} else {
  window.addEventListener('load', () => performRestoration('initial'));
}

// Navigation API: zero-latency hide on SPA route start.
// The MutationObserver below would eventually catch the URL change and run
// teardown, but only after the 1s debounce + DOM swap settles — long enough
// that the previous route's marker overlay and sticky containers visibly
// linger over the new page on apps like claude.ai. The Navigation API fires
// synchronously the instant the SPA pushes/replaces state, so flipping a CSS
// class on <html> hides the old overlays immediately. performRestoration
// removes the class once the new URL's pass finishes (success or no-op).
// Feature-detected — Firefox/Safari fall through to the MutationObserver
// path, same as before.
if (window.navigation) {
  window.navigation.addEventListener('navigate', (e) => {
    try {
      const dest = new URL(e.destination.url);
      if (dest.href !== location.href) {
        document.documentElement.classList.add('adnota-route-changing');
        window.AdnotaLog?.event('restorer', 'route-changing-on', {
          fromUrl: location.href, toUrl: dest.href,
        });
        // Backstop: pathological case where the SPA pushes state without any
        // DOM mutation — MutationObserver never fires, performRestoration
        // never runs, and the class would stay set forever. 3s is a hair past
        // the MutationObserver max-wait clamp (2.5s), so on the happy path
        // performRestoration removes the class first and this is a no-op.
        setTimeout(() => {
          if (document.documentElement.classList.contains('adnota-route-changing')) {
            document.documentElement.classList.remove('adnota-route-changing');
            window.AdnotaLog?.event('restorer', 'route-changing-off', { url: location.href, viaBackstop: true });
          }
        }, 3000);
      }
    } catch (_) {
      // Malformed destination URL — ignore; MutationObserver will still cover it.
    }
  });
}

// Protect against dynamic SPAs fetching data late.
// Trailing 1s debounce so we wait for a mutation burst to settle, but with a
// hard 2.5s max-wait clamp: on heavy SPAs that mutate continuously, the plain
// debounce would keep resetting and never fire, leaving paint markers absent
// for the full hydration window. The clamp guarantees we run periodically
// even while mutations keep coming.
let mutationTimeout;
let mutationFirstPending = 0;
const MUTATION_DEBOUNCE_MS = 1000;
const MUTATION_MAX_WAIT_MS = 2500;

const observer = new MutationObserver(() => {
  const now = Date.now();
  if (mutationFirstPending === 0) mutationFirstPending = now;

  const elapsed = now - mutationFirstPending;
  const remaining = Math.max(0, MUTATION_MAX_WAIT_MS - elapsed);
  const wait = Math.min(MUTATION_DEBOUNCE_MS, remaining);

  clearTimeout(mutationTimeout);
  mutationTimeout = setTimeout(() => {
    mutationFirstPending = 0;
    performRestoration('mutation');
  }, wait);
});

observer.observe(document.body, { childList: true, subtree: true });
