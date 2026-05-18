# Adnota — Dev Knobs

Console snippets, debug flags, and developer-only affordances for working on the extension. For architecture see [CODE.md](CODE.md); for install / build / release see [README.md](README.md).

---

## Debug logging

`AdnotaLog` is the gated event logger threaded through every surface (content scripts, background worker, popup, Sites page). Default OFF.

```js
// Global — every Adnota surface, persists until cleared
chrome.storage.local.set({ adnotaDebugLog: true })
chrome.storage.local.set({ adnotaDebugLog: false })

// Per-tab override — page console only, doesn't touch other tabs
localStorage.setItem('adnotaDebugLog', '1')
localStorage.removeItem('adnotaDebugLog')
```

Output format: `[Adnota:<source>:<channel>:<action>] {…data}`. Filter in DevTools by typing:

- `Adnota:` — every event
- `Adnota:restorer:` — one channel
- `Adnota:cs:eraser:click` — one event in the content-script context
- Source tags: `cs` (content script) · `bg` (service worker) · `popup` · `sites`

**Three console contexts to inspect** — logs aren't unified:
- Host page DevTools console → content scripts
- `chrome://extensions` → Adnota → service worker → DevTools → background.js
- Right-click popup → Inspect → popup / Sites page → its own DevTools

## Bubble-climb debug (eraser & resizer)

Verbose logging for `AdnotaUI.bubbleToVisualRoot` — every IoU hop, why it stopped, the final pick. Useful when an eraser or resizer hover lands on the wrong element.

```js
localStorage.setItem('adnota-debug-bubble', '1')
localStorage.removeItem('adnota-debug-bubble')
```

## DOM / state capture (Claude Code workflow)

Curated DOM + computed-style + Adnota-tool-state snapshot, copied to clipboard as JSON for pasting into Claude while iterating on heuristics.

- Hotkey: **`Cmd+Shift+K`** (Mac) / **`Ctrl+Shift+K`** (Win/Linux) — captures the element under the cursor
- Console: `window.adnotaDebugCapture("optional label")`

Each capture flashes a green outline on the target, surfaces a top-right toast with target + bundle size, and `console.log`s the full bundle. Tools opt into richer state by registering `window.__adnotaDebug.tools[name] = () => stateObject`.

---

## Reset state

Tutorial / first-run flags — useful for re-testing the educational toasts:

```js
chrome.storage.local.remove([
  'adnotaDockDismissTutorialShown',
  'adnotaToolEscTutorialShown',
  'adnotaEraserDomainTutorialShown',
  'adnotaPositionTipShown',
  'adnotaTextSizeTipShown',
  'adnotaRecolorTipShown',
])
```

Dock position (snap back to default centered):

```js
chrome.storage.local.remove('adnotaDockPosition')
```

Un-hide every domain where the dock was dismissed:

```js
chrome.storage.local.remove('adnotaHiddenDomains')
```

## Inspect storage

Dump every key Adnota has written (every annotated hostname is its own key, plus the global prefs):

```js
chrome.storage.local.get(null, (d) => console.log(JSON.stringify(d, null, 2)))
```

One hostname:

```js
chrome.storage.local.get('google.com', (d) => console.log(JSON.stringify(d, null, 2)))
```

Bytes used vs MV3's 10 MB cap:

```js
chrome.storage.local.getBytesInUse(null, (b) => console.log(b, 'bytes'))
```

## Feature gates

```js
// Quick-highlight popup (the post-selection one) — default true
chrome.storage.local.set({ adnotaQuickHighlightEnabled: false })
```

---

## Window-exposed surfaces

Available in any host-page DevTools console while Adnota is injected. Useful for ad-hoc poking — call methods directly, read state, force renders.

| Surface | What it is |
|---|---|
| `AdnotaState` | Active mode, color, stroke width, fill modifier — subscribe via `.subscribe(fn)` |
| `AdnotaUndo` | Central undo stack — `.undo()` pops and runs the latest entry |
| `AdnotaVisibility` | Show/hide all annotations — `.toggle()` / `.show()` |
| `AdnotaStorage` | Storage wrapper — `saveItem`, `saveNote`, `deleteItem`, `getAnchorsForUrl`, `clearPage` |
| `AdnotaTags` | Tag index — `.getAllTags()` async returns `[{ tag, count }]` |
| `AdnotaUI` | Shared helpers — `bubbleToVisualRoot`, `dominatesViewport`, `setIframeShield`, etc. |
| `AdnotaLayout` | `findGrowthOverflow`, `detectClippingAncestors` — layout-blocker detection |
| `AdnotaCursor` | Global cursor lock (resizer uses this) |
| `AdnotaDock` | `.mount(toolId, buildBodyFn)` / `.unmount(toolId)` |
| `AdnotaEraser` / `AdnotaResizer` / `AdnotaSticky` / `AdnotaHighlighter` / `AdnotaMarker` | Per-tool engines |
| `AdnotaScratchPad` | `.toggle()`, `.open()`, `.close()`, `.refresh()`, `.pageSnippetCount()` |
| `FuzzyAnchor` | `.findMatch(anchor)`, `.generateCSSSelector(el)` |
| `AdnotaEraseRules` / `AdnotaResizeRules` | The Maps backing the injected `<style>` tags |
| `AdnotaErasedElements` | Set of currently-hidden nodes (toggled by Show/Hide) |
| `__adnotaDebug.tools` | Registry for `debugCapture` state contributors |
