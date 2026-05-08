# bing fixture

Pins the resize-on-bing scroll-survival behavior introduced by:

- `1d25823` Fixing bing.com RESIZE bug. Making resize use max-height on SHRINK and just height on EXPAND
- `6a83ac7` Per-axis overflow snapshot during drag (xWasScrollable / yWasScrollable)
- `70463fc` Stop forcing overflow:hidden on resize. Page CSS wins.

The third commit is the current state of the world: the resizer should never
inject `overflow:*` into the persisted CSS rule, and the page's pre-resize
overflow CSS should remain in effect after the drag.

## What this fixture exercises

1. Activates the resizer tool from the dock.
2. Hovers `#b_results` (Bing's main results column) to surface the selection.
3. Clicks to select.
4. Drags the bottom handle 200px upward (shrink height).

## Pinned invariants

- `page-scrollable-after-resize` — `documentElement.scrollHeight` still exceeds
  the viewport. If a future change re-introduces overflow clipping that breaks
  page scroll, this fails.
- `results-container-overflow-y-not-hidden` — the resized element's computed
  `overflow-y` is anything but `hidden`. Directly tracks the "page CSS wins"
  invariant from `70463fc`.

## Re-pinning

If Bing ships a layout change that legitimately moves the captured cssText or
storage shape:

```
node scripts/capture.js --site=bing
```

Then sanity-check `outcomes.json` and commit it with a note about why the
pinning shifted.
