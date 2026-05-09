// Walks raw recorder events into the harness's typed op vocabulary.
//
// The reducer is intentionally narrow: it recognizes the workflow patterns the
// op vocabulary already supports (activateTool, hoverElement, clickToSelect,
// dragHandle). Anything outside those patterns is dropped or surfaced as a
// console warning so the user can patch ops.json by hand.

const DRAG_THRESHOLD_PX = 5;
const CLICK_GAP_MS = 600;

export function reduceEvents(events, { initialUrl, viewport } = {}) {
  // Drop noise: the very first init event(s) and any events at coords outside
  // the viewport (e.g., browser chrome on macOS sometimes leaks negative y).
  const ev = events.filter(e => e.type !== 'init');

  const ops = [];
  let lastMoveSel = null; // last hovered selector (for hoverElement pairing)
  let i = 0;

  while (i < ev.length) {
    const e = ev[i];

    // ── pointerdown: starts either a click or a drag ────────────────────────
    if (e.type === 'pointerdown' && e.data.button === 0) {
      const downSel = e.data.sel;
      const downX = e.data.x, downY = e.data.y;
      const downT = e.t;

      // Find the matching pointerup. Walk forward until we see one or run out.
      let upIdx = -1;
      for (let j = i + 1; j < ev.length; j++) {
        if (ev[j].type === 'pointerup' && ev[j].data.button === 0) { upIdx = j; break; }
      }
      if (upIdx < 0) { i++; continue; }
      const up = ev[upIdx];

      const dx = up.data.x - downX;
      const dy = up.data.y - downY;
      const dist = Math.hypot(dx, dy);
      const gap = up.t - downT;

      // Dock-button click → activateTool (matches data-tool-id selectors).
      const toolMatch = downSel && downSel.match(/^\[data-tool-id="([^"]+)"\]$/);
      if (toolMatch && dist < DRAG_THRESHOLD_PX) {
        ops.push({ type: 'activateTool', tool: toolMatch[1] });
        lastMoveSel = null;
        i = upIdx + 1;
        continue;
      }

      // Resizer handle drag → dragHandle.
      const handleMatch = downSel && downSel.match(/^\.adnota-resizer-handle-(left|right|top|bottom|corner)$/);
      if (handleMatch) {
        ops.push({ type: 'dragHandle', handle: handleMatch[1], dx: Math.round(dx), dy: Math.round(dy) });
        lastMoveSel = null;
        i = upIdx + 1;
        continue;
      }

      // Click on a non-Adnota element → hoverElement + clickToSelect.
      if (dist < DRAG_THRESHOLD_PX && gap < CLICK_GAP_MS && downSel && !isAdnotaUiSelector(downSel)) {
        // Prefer the element the resizer ACTUALLY selected (captured in the
        // post-click selectionState snapshot) over the cursor's hover target.
        // This handles Shift+Scroll-traversed selections — the snapshot
        // records what the resizer ended up with, not what the cursor was over.
        const selState = findSelectionStateAfter(ev, upIdx);

        let hoverSel = lastMoveSel || downSel;
        let expectedSelection = undefined;
        if (selState?.target) {
          hoverSel = selState.target.sel;
          expectedSelection = {
            text: selState.target.text,
            w: selState.target.w,
            h: selState.target.h,
          };
        } else if (selState && !selState.present) {
          // Click confirmed deselect-only; replay shouldn't strict-assert.
          expectedSelection = null;
        }

        const last = ops[ops.length - 1];
        if (!last || last.type !== 'hoverElement' || last.selector !== hoverSel) {
          ops.push({ type: 'hoverElement', selector: hoverSel });
        }
        const click = { type: 'clickToSelect' };
        if (expectedSelection !== undefined) click.expectedSelection = expectedSelection;
        ops.push(click);
        i = upIdx + 1;
        continue;
      }

      // Anything else: log and skip so the user knows something dropped.
      console.warn(`[record] unrecognized pointer interaction (sel=${downSel} dist=${dist.toFixed(1)}px) — skipped`);
      i = upIdx + 1;
      continue;
    }

    // ── pointermove: track most-recent hovered non-Adnota selector ──────────
    if (e.type === 'pointermove') {
      const sel = e.data.sel;
      if (sel && !isAdnotaUiSelector(sel)) lastMoveSel = sel;
      i++;
      continue;
    }

    // ── keydown: bare-key tool activation, Escape, Alt+A, Ctrl+Z ───────────
    if (e.type === 'keydown' && !e.data.inField) {
      const op = reduceKey(e.data);
      if (op) ops.push(op);
      i++;
      continue;
    }

    i++;
  }

  return collapseToggles(ops);
}

// activateTool is really toggleTool: dock-button click and bare-key r/e/s/d
// both toggle the active mode. Two consecutive activations of the same tool
// cancel (toggle off, toggle on). Drop pairs so replay doesn't visibly flicker
// through the toggle dance. Odd-count runs leave one residual op, which is
// what the user actually intended.
function collapseToggles(ops) {
  const out = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (op.type === 'activateTool' && last?.type === 'activateTool' && last.tool === op.tool) {
      out.pop();
    } else {
      out.push(op);
    }
  }
  return out;
}

function reduceKey(d) {
  const noMods = !d.alt && !d.ctrl && !d.meta;
  // Bare-key tool activations (the dock-visible gate is implicit during
  // recording — if the user is recording, the dock is up).
  if (noMods && !d.shift) {
    const tool = { e: 'eraser', r: 'resizer', s: 'sticky', d: 'highlight' }[d.key];
    if (tool) return { type: 'activateTool', tool };
    if (d.key === 'f') return { type: 'pressKey', key: 'f' };
  }
  if (d.key === 'Escape') return { type: 'pressKey', key: 'Escape' };
  if (d.alt && (d.key === 'a' || d.key === 'A')) return { type: 'pressKey', key: 'a', alt: true };
  if (d.alt && (d.key === 's' || d.key === 'S')) return { type: 'pressKey', key: 's', alt: true };
  if ((d.ctrl || d.meta) && (d.key === 'z' || d.key === 'Z')) return { type: 'pressKey', key: 'z', ctrl: true };
  return null;
}

function isAdnotaUiSelector(sel) {
  if (!sel) return false;
  return sel.includes('adnota-') || sel.includes('[data-tool-id') || sel.includes('[data-adnota-ui');
}

// Find the selectionState event that the shim emitted ~80ms after this
// pointerup. We walk forward through pointermove/keydown noise and stop at
// any new pointerdown — that means a fresh interaction has begun and the
// snapshot we wanted has been overwritten.
function findSelectionStateAfter(ev, upIdx) {
  for (let j = upIdx + 1; j < ev.length; j++) {
    if (ev[j].type === 'selectionState') return ev[j].data;
    if (ev[j].type === 'pointerdown') break;
  }
  return null;
}
