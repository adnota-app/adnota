# Adnota — The Persistent Canvas

> Treat any website like your personal canvas. Erase what you don't need. Annotate what matters. Highlight, redact, and draw — all persistent across sessions, all stored privately on your machine.

Adnota is a Manifest V3 Chrome Extension built around a single core idea: **your annotations live with the page, not in a silo.** Every change you make to a website persists automatically, restores on the next visit, and is instantly accessible from a dedicated history view. No accounts, no cloud, no data leaving the browser.

Highlight what's notable, eliminate what's not.

Mark it up. Block it out. Make it yours.

NOTE: WE ARE NOT IN PRODUCTION YET, SO MAKE AN EFFORT TO CLEAN UP CODE AND REDUCE DUPLICATE AS WE GO!

NOTE 2: This project was originally written with a name of VELLUM, but that name is taken, so we are rebranding to ADNOTA.

NOTE: I think my brand color purple is: #7c3aed ?

Annotate your web, your way.

Adnota: Annotate the web.

The product North Star: Adnota today is "make any webpage yours" (destructive + additive edits on any specific page)

---

## Architecture

### Extension Shell

#### `manifest.json`
MV3 manifest. Permissions: `storage` only (host permissions `*://*/*` cover everything else — `activeTab`, `scripting`, and `tabs` are deliberately *not* requested because static `content_scripts` + `chrome.tabs.sendMessage` to a known tab id don't need them, and the install-time prompt stays minimal). Declares two keyboard commands: `Alt+A` (toggle dock) and `Alt+S` (show / hide all annotations). Tool activation is layered on top — bare keys `e/r/s/d/f` toggle each tool when the dock is visible (see Keyboard Shortcuts section). Declares `web_accessible_resources` for the `pages/` directory (Sites history page). Content scripts are injected at `document_idle` in this exact order — JS first: `lib/log.js` (loaded first so every later script can use `AdnotaLog`) → `lib/storage.js` → `lib/annotationState.js` → `lib/adnotaUI.js` → `lib/adnotaLayout.js` → `lib/tagIndex.js` → `content/scratchPad.js` → `content/dock.js` → `content/fuzzyAnchor.js` → tools (eraser, sticky, highlighter, marker, resizer) → `content/restorer.js` → `content/quickHighlight.js` → `content/debugCapture.js`. CSS is injected in parallel: `lib/adnotaTokens.css` (design tokens, must load before everything that consumes them) → `lib/adnotaUI.css` (shared UI surface) → per-content-script stylesheets (`content/scratchPad.css`, `dock.css`, `sticky.css`, `marker.css`, `highlighter.css`, `resizer.css`, `quickHighlight.css`).

#### `background.js`
Minimal service worker. `importScripts('lib/log.js')` at the top so the worker shares the same logger surface as content scripts. Routes keyboard command events from the browser to the active tab's content scripts via `chrome.tabs.sendMessage`. Also relays messages from the dock (content scripts can't `sendMessage` to their own tab): `open-sites` and `relay-to-tab`.

---

### Shared Libraries (injected into every page)

#### `lib/log.js` — `window.AdnotaLog`
Gated debug-event logger shared across content scripts, the background service worker, popup, and the Sites page. Default-on for pre-release; toggle off via `chrome.storage.local.set({ adnotaDebugLog: false })` (global, live — `storage.onChanged` flips the flag without reload) or `localStorage.setItem('adnotaDebugLog', '0')` (per-tab override on the page side only).

**Surface**: `event(channel, action, data)`, `el(node)` returns `{sel, tag, w, h, text}`, `group(channel, label, fn)`. Output format: `[Adnota:<source>:<channel>:<action>] {…data}`. Source tag distinguishes the four console contexts (`cs` content script / `bg` service worker / `popup` / `sites`) so a single flow can be reconstructed across them. Filter in DevTools by typing `Adnota:` (all), `Adnota:restorer:` (one channel), or `Adnota:cs:eraser:click` (one event).

**What's instrumented**: tool commits only (mode-enter/exit, click, drag-up, undo, delete, trash-all) plus page/route-load events. Hover/mousemove/wheel are deliberately not logged. Restorer's `pass-end` only emits when something actually changed (matches the storage write-gate) so the every-2.5s observer wake-up stays silent on long-lived SPA tabs.

#### `lib/storage.js` — `window.AdnotaStorage`
Wrapper around `chrome.storage.local`. All data is keyed by `hostname`, and each entry lives in a `items[]` array. Every item carries:
- `action`: `'ERASE'` | `'NOTE'` | `'HIGHLIGHT'` | `'MARKER'` | `'RESIZE'`
- `version`: schema version field (currently `2`) — future-proofs migrations
- `anchor`: nested object containing all FuzzyAnchor signals (cssSelector, tagName, textFingerprint, attributes, structure, geometry) — present on ERASE, HIGHLIGHT, MARKER, and NOTE (for hybrid anchor placement)
- `timestamp` / `createdAt` / `updatedAt` as appropriate per action type
- FuzzyAnchor fields for restoration
- `tag`: optional user-supplied string, NOTE and HIGHLIGHT only. Normalized on write (trim + collapse interior whitespace, 40-char cap). Field is omitted entirely when empty so the untagged path leaves no empty-string debris in storage.

Methods: `saveItem`, `saveNote` (generic upsert-by-uuid — caller passes full payload), `deleteItem`, `getAnchorsForUrl`, `clearPage`.

#### `lib/annotationState.js` — `window.AdnotaState`, `window.AdnotaUndo`, `window.AdnotaVisibility`
**`AdnotaState`**: Single source of truth for active tool mode (`null` | `'eraser'` | `'sticky'` | `'highlight'` | `'pen'` | `'arrow'` | `'rect'` | `'ellipse'` | `'text'` | `'select'`), active color, stroke width, and shape fill modifier. `color` holds either a theme class (`adnota-theme-*`) or a raw hex string from the eyedropper — consumers must handle both. `filled` is a boolean modifier that only affects rect/ellipse. Persists `adnotaActiveMode`, `adnotaHighlightColor`, `adnotaStrokeWidth`, and `adnotaShapeFilled` to storage for cross-component sync (popup reads these live). Subscriber pattern — all tools react to state changes without polling.

**`AdnotaUndo`**: Central undo stack shared by all tools. Pressing `Ctrl+Z` / `Cmd+Z` anywhere on the page pops and executes the most recent `{ undo: async fn }` entry, regardless of which tool created it.

**Universal Escape + focus anchor**: window-capture keydown clears `AdnotaState.mode` on Escape from any tool. A hidden `<div id="adnota-focus-anchor">` (zero-size, `tabindex="-1"`, `data-adnota-ui`) is focused on mode entry; a `focusin` capture listener reclaims focus from anything outside Adnota UI; `visibilitychange` re-anchors on tab round-trips. `AdnotaState.anchorFocus()` is exposed for tools that `preventDefault` pointer events (eraser page-click blocker) to reclaim focus after suppressing the implicit transfer. Re-entrance guard prevents a synchronous loop on sites with their own focus management (GitHub) where `.focus()` triggers a focusin that the page's handler reacts to by re-focusing one of its own elements.

**`AdnotaVisibility`**: ephemeral show/hide-all controller. `toggle()` flips a `adnota-hidden` class on `<html>`, iterates `AdnotaErasedElements` to flip inline `display:none`, disables/re-enables the `adnota-erase-overrides` + `adnota-style-overrides` style tags, and injects/removes a stylesheet zeroing out CSS Custom Highlights backgrounds. Not persisted — every page load starts visible. `show()` idempotently reveals; called from sticky/highlight/marker handlers so hide mode can't block new work. Owns the `toggle-view` / `get-view` message handler and `visibility-changed` broadcast for popup icon sync.

#### `lib/adnotaUI.js` — `window.AdnotaUI`                                                                           
Shared UI utilities that prevent duplication across content scripts.                                                                                                     

**`data-adnota-ui` convention**: Every Adnota UI element (overlays, toolbars, toasts, sticky notes, marker wrappers, etc.) must be tagged with `data-adnota-ui="1"`. This is how the eraser, resizer, and marker know to ignore Adnota's own elements — `isAdnotaElement(el)` is a single `.closest('[data-adnota-ui]')` check. When adding new UI elements, always set this attribute or they will be erasable/selectable by the user's own tools.

**Shared HUD button helpers**: `createToolbarIconButton`, `createUndoButton`, and `createTrashButton` produce the dark-frosted `adnota-undo-btn`-styled controls used across every HUD. `softDeleteItems({singular, plural, actionTypes})` is the single implementation behind every bulk trash action (popup stat cards, popup "Clear All," and HUD trash buttons): it snapshots matching items by ID, removes them from storage, hides them from the DOM, and shows a 3-second toast with Undo. Undo re-writes storage and re-renders in place; Ctrl+Z also pops the batch off `AdnotaUndo`.

**Shared DOM-walk helpers**: `bubbleToVisualRoot(el, opts)` walks up parents whose bounding box matches `el` within a small tolerance — the "visually-identical wrapper" climb used by both the eraser and resizer so a hover/click on an inner element lands on the outer container users almost always actually mean. `dominatesViewport(rect, threshold)` guards the walk (and the eraser's better-target nudge) against ever promoting to a page-level container.

**Anchor-sync listener triad**: `bindAnchorSync(wrapper, anchorElement, syncFn)` registers `window.resize` + capture-phase `window.scroll` + `ResizeObserver` for every persisted overlay (highlighter fallback wrappers, marker text/SVG wrappers), returns an idempotent cleanup, stashes it as `wrapper._adnotaCleanup` for the delete paths, and installs a parent-childList `MutationObserver` that auto-cleans when the wrapper is detached. Without this, the listener bag outlives the wrapper for the life of the tab — a real cost on long-lived SPA tabs.

**Layout-aware text from a Range**: `rangeText(range)` preserves line breaks even when a syntax highlighter (Prism, Highlight.js, ChatGPT's) renders the source as inline `<span>` tokens with no `\n`s in the DOM. Inside `<pre>`, it clones the range into a hidden off-screen `<pre>` and reads `innerText` (browser inserts `\n`s where it draws line breaks); outside `<pre>` it falls through to `range.toString()`. Wired into `createHighlightFromRange` at storage-write time so the scratch pad can render captured code as multi-line prose; structural extractions like `getOccurrenceIndex` keep using `range.toString()` so `indexOf` matches both strings extracted the same way.

#### `lib/adnotaLayout.js` — `window.AdnotaLayout`
Shared layout-detection helpers for spotting "silent growth blockers" — situations where a tool changes an element's size and the visible result is masked. Two cases covered: a clipping ancestor (`overflow: hidden | clip` somewhere up the chain) and an element-level cap (`max-width` / `max-height` on the element itself). The resizer is the first consumer (drives the `Container clipping` / `At max size` chip on the selection box and the live drag-time clip detection); eraser / marker / sticky may layer on later.

Holds the canonical `SAME_RECT_IOU_THRESHOLD = 0.85` constant — the same threshold `bubbleToVisualRoot` (in `lib/adnotaUI.js`) uses for its outermost-wins climb. Both consumers reference this single constant so a future tune of eraser/resizer auto-bubble can't drift away from any layout classification that depends on it (see `feedback_eraser_outermost_walk.md`).

#### `lib/tagIndex.js` — `window.AdnotaTags`
Single source of truth for the optional tag layer on NOTE and HIGHLIGHT items. Consumed by the sticky note tag input, the quick-highlight popup tag input, and the Sites page filter chip row.

- `normalize(raw)` — trims, collapses interior whitespace, caps at 40 chars. Used everywhere a tag is read or written so "legos", "Legos ", and "  LEGOS  " never coexist in storage.
- `getAllTags()` — async; reads all storage, flattens `items[]`, returns `[{ tag, count }]` sorted by count desc then alphabetically. No caching (single read per tag-input focus; bounded by the 10 MB storage cap).
- `buildAutocompleteDropdown(inputEl, { onPick })` — attaches a dropdown: prefix+substring match, keyboard nav (Arrow↑↓, Tab/Enter to pick top, Shift+Tab to escape, Escape to hide; first item auto-highlights once typing starts), mousedown-pick so blur doesn't hide before the click lands. Appended to `<body>` with `position: fixed !important` + max z-index so it escapes parent stacking contexts and host-site CSS bleed. Styling under `.adnota-tag-suggest*` in `lib/adnotaUI.css`.

#### `lib/adnotaTokens.css` — design tokens
HUD surfaces (`--adnota-hud-bg`, `--adnota-hud-bg-strong`, `--adnota-hud-border`, `--adnota-hud-text`), brand accent (`--adnota-accent`, `--adnota-brand-gradient`), tool colors (`--adnota-red`, `--adnota-amber`, `--adnota-blue`, `--adnota-green`, `--adnota-pink`). Loaded by both content scripts and the popup/sites pages. All custom properties are namespaced `--adnota-*` to avoid colliding with host design systems. The popup and sites pages still keep their own un-prefixed `:root` blocks for surface/text/shadow tokens — pending consolidation.

---

### Content Scripts

#### `content/fuzzyAnchor.js` — `window.FuzzyAnchor`
Candidate-tournament element-identification system that generates rich anchors and resolves them across page reloads via multi-signal scoring:

1. **CSS Selector** (max 30 pts) — stable `#id`, unique class combination (auto-generated CSS-in-JS classes filtered out), stable attribute selector (`[data-testid]`, `[role]`, etc.), or structural `nth-child` path as fallback
2. **Tag Name** (max 5 pts) — basic filter; wrong tag = early exit
3. **Text Fingerprint** (max 30 pts) — fuzzy Jaccard word-overlap on sampled distinctive words (stopwords filtered), with prefix/suffix and word-count bonuses. Survives minor text edits
4. **Attributes** (max 15 pts) — matches stable HTML attributes (`data-testid`, `role`, `aria-label`, `name`, `src`, `alt`, etc.)
5. **Structural Context** (max 10 pts) — parent tag/classes, child count, child tag sequence, DOM depth
6. **Visual Geometry** (max 10 pts) — viewport-relative position and size ratios with distance-scaled scoring

**Resolution**: `findMatch` collects candidates from CSS selector queries, attribute queries, and tag-name scans, then scores every candidate against all six signals additively (max 100). Returns the highest-scoring candidate above a **≥ 40 point** threshold. Scores above 85 short-circuit immediately.

The tag-name scan walks **every** element of the matching tag (no cap — heavy SPAs like Claude.ai / Notion bury content hundreds of divs deep). The quick filter uses `textContent` (no layout cost) and prioritizes elements whose text contains the fingerprint's `prefix` or `suffix` so anchored matches reliably enter the candidate pool; layout-aware `innerText` only runs in `_textScore` on the trimmed pool.

Also exposes `generateCSSSelector(el)` as a shared utility (used by the resizer).

#### `content/eraser.js`
- Activated via popup tool card, dock button, or bare-key `e` (when dock is visible)
- Red outline hover preview tracks the cursor; Adnota's own UI elements are guarded and invisible to the eraser
- **Top-right badge cluster on the hover outline**: `W×H` pill + a soft-red `likely ad` pill that lights up whenever `getEffectiveAdSignals()` fires (same detection that drives silent domain-wide promotion). Both follow the cursor with the outline so the most actionable signals don't require a glance down at the HUD
- **HUD strip**: fixed bottom-center bar, draggable, visible while eraser is active. Layout: drag handle → A logo chip → info section → trash → undo. Info updates live while hovering:
  - **Confidence score** with contextual label — "likely ad" (red, when ad signals detected), "strong anchor" (green, ≥70), "moderate" (amber, ≥40), "weak anchor" (red, <40)
  - **Ad signal badges** — colored pills (`ad-keyword`, `ad-tag`, `ad-network`, `ad-label`, `iframe`, `sponsored-link`) when detected. Detection scans `id`/`className` keywords, custom-element tag names via a hyphen-segmented pattern, ad-flavored attribute names (`ad-type`, `is-ad`, `data-ad-*`), `aria-label` text, and a combined subtree pass for descendant iframes + `rel="sponsored"` links
  - **Scroll nudge** — "▲ ⇧+Scroll up N× for better target" shown when `findBetterTarget()` identifies a higher parent with a stronger anchor score
  - **Help (?), trash, undo** — `?` opens a tail-anchored popover with shortcut tips (click scope, Shift+Click domain-wide, auto-promotion, scroll-to-traverse, Esc); trash deletes every erasure on the current page after a confirm; undo fires `AdnotaUndo.undo()`
  - **Draggable** — grab handle + pointer capture drag; position resets on mode exit
- **Visual-root auto-bubble**: on hover, the outline climbs past any parent whose bounding box matches the child (edges within 4px, size within 5%) so one click hits the outermost visually-identical container. Stops the moment a parent meaningfully grows or would dominate ≥85% of the viewport (page-level containers never auto-selected). Padding/margins break edge-match so small inner targets stay distinct
- **Scroll-wheel DOM traversal**: `Shift+Scroll` up walks to the parent, `Shift+Scroll` down walks back toward the auto-bubbled baseline. No minimum-size filter (unlike resizer) so small elements like links and icons stay erasable. Plain scroll passes through to the page; `Shift+Click` is read independently of prior wheel events and still means "domain-wide"
- Click to erase: fires a 3-stage animation sequence (ripples → bounding-box flash → dissolve) then hard-hides the element with `display: none !important`
- `Shift+Click` for domain-wide erasure (stored with `path: '*'`). First-erase tutorial: a one-time toast (`adnotaEraserDomainTutorialShown`) names the keystroke after the user's first plain-click erase against a *non-ad* target — ads are silently domain-scoped already so users who only erase ads never see the toast
- **Silent ad-scope promotion**: a plain click on an ad-fingerprinted target (`getEffectiveAdSignals` non-empty) is silently promoted to domain-wide storage — no HUD chip, no messaging. Non-ad targets stay page-scoped; viewport-dominating containers are always treated as non-ad regardless of subtree iframes
- **Ad-slot selector widening**: when the erase target is an ad-shaped custom element (tag matches `AdnotaUI.adIdentifierPattern` — `<shreddit-comments-page-ad>` etc.), the injected CSS rule widens from the specific selector to `<specific>, <tagname>` so the next impression in the same slot stays hidden. Applied at both live-click and restore time (older entries widen on the next page load, no migration needed). No-op for generic tags like `div`
- Undo: shared `AdnotaUndo` stack + 3s toast button, both cancel mid-flight animations
- Show/Hide (`Alt+S`): erased elements are tracked in the shared `AdnotaErasedElements` Set (populated by both eraser clicks and restorer); `AdnotaVisibility` iterates this set to toggle inline `display:none` on each node
- Storage write is non-blocking (does not delay animation)
- **Ad-popup defense**: while eraser is active, `mousedown` / `pointerdown` / `auxclick` on non-Adnota targets are window-capture `preventDefault`-ed so ads can't call `window.open()` from the earliest pointer event. Right-click (`button === 2`) passes through (Inspect still works). Every block calls `AdnotaState.anchorFocus()` to reclaim keyboard focus that `preventDefault` would otherwise suppress
- **Iframe pointer shield**: `AdnotaUI.setIframeShield('eraser', true)` on mode entry injects `iframe { pointer-events: none !important }` so cross-origin iframes don't swallow wheel/click — events route to the iframe's container in the parent doc (usually the full ad wrapper). Per-tool keyed; resizer uses the same mechanism with a `'resizer'` key

#### `content/sticky.js` — `window.StickyEngine`
- Activated via popup tool card, dock button, or bare-key `s` (when dock is visible)
- Click anywhere on the page to drop a sticky note; mode auto-exits on placement so a stray click while writing the note doesn't drop a phantom sticky. Re-enter via bare-key `s` or the dock button to place another
- **Dark frosted-glass toolbar** (fixed, bottom-center, draggable) — matches marker/eraser HUD aesthetic
- **Toolbar layout**: drag handle → A logo chip → 5 sticky-note-shaped color swatches → trash → undo. Trash clears every sticky note on the current page after a confirm.
- **Five colors**: yellow, green, blue, pink, white — swatches are mini sticky note icons (folded corner shape) filled with the theme color. Active swatch gets a purple glow ring. Choice persists to `adnotaStickyColor` in storage.
- **Three-tier anchor cascade** (mirrors marker.js's resolveAnchorRect):
  - **Tier 1 — block-level FuzzyAnchor**: on click, `findAnchorTarget` picks the nearest block element and stores `anchor` + `anchorOffset {dx, dy}`. Restore: FuzzyAnchor scoring re-resolves the block, the offset places the note. Tracks the anchor on every scroll/resize via the capture-phase listener below
  - **Tier 2 — container-scroll-anchor `fallback`**: at save time, `AdnotaUI.findScrollContainer` walks up to the nearest inner scrolling ancestor and stores its FuzzyAnchor + offset within its scrollable content. When Tier 1 misses (paragraph wrapper got a new selector — common on chatgpt.com / claude.ai chat turns), Tier 2 re-resolves the surrounding scroll container and lands the note in the right spot in the conversation
  - **Tier 3 — percentage placement** (`placement.xPct`, `placement.yScrollPct`): last-resort "never lose your work" fallback against `documentElement.scrollWidth/Height`
- **Fixed-position overlay** (`#adnota-sticky-overlay`): every container lives inside a single viewport-sized, `position: fixed; pointer-events: none` overlay on documentElement; container coords are viewport-relative. Keeps note bounds out of `scrollHeight` so a saved doc-px top can't inflate `<body>` and pull in a phantom scrollbar on app shells (same trick `#adnota-marker-overlay` uses)
- **Scroll re-anchoring**: a single capture-phase `window.scroll` listener (rAF-throttled) re-runs `updatePosition()` for every active note. Capture phase is required because `scroll` doesn't bubble — one listener catches scrolls on every container, including the internal scrollers on `overflow: hidden` app shells. Mirrors the marker tool's `bindAnchorSync` triad
- **Drag and drop**: header-drag repositions; on drop, re-anchors to the element under the note's center (`elementsFromPoint` + `findAnchorTarget`) and refreshes the Tier 2 `fallback` so the note still tracks the inner scroll container even when the new Tier 1 anchor is null
- Autosaves content on a 1.5s debounce; smart z-index elevation on focus; `Alt+S` toggles visibility via `AdnotaVisibility`
- **`scrollTo(uuid)`**: smooth-scrolls `.adnota-sticky-container[data-uuid="${uuid}"]` into view. Returns `false` if not rendered (mid-restoration / post-SPA-teardown) so the scratch pad's GOTO can surface a miss-toast
- Undo: Ctrl+Z immediately after placement removes the note; toolbar undo and 3s post-delete toast share the consumed-flag pattern (synchronous storage commit, snapshot captures live textarea/tag/dimensions in case the autosave debounce hasn't fired)
- **Tag row**: thin bar at the bottom of each note card (below the textarea, symmetric with the 28px header) holding a `#` glyph and text input. Optional. Focusing the input opens the `AdnotaTags` autocomplete dropdown; writes go through the same `saveNote` merge path as textarea and drag/resize persist

#### `content/highlighter.js` — `window.AdnotaHighlighter`
- Activated via popup tool card, dock button, or bare-key `d` (when dock is visible)
- **Dark frosted-glass toolbar** (fixed, bottom-center, draggable) — matches eraser HUD aesthetic with `var(--adnota-hud-bg)` background, `backdrop-filter: blur(8px)`, and purple accent border
- **Toolbar layout**: drag handle → A logo chip → tool icons → color swatches → stroke width presets → trash → undo. Trash clears every highlight and marker shape on the current page after a confirm.
- **Seven tool buttons** (SVG icons with purple hover/active states):
  - **Select** — click to select existing annotations; delete via red ✕ or Delete/Backspace key; double-click text to re-edit
  - **Pencil** — freehand drawing (original pen mode)
  - **Highlight** — text selection highlight via CSS Custom Highlights API
  - **Arrow** — click-drag to draw straight arrows with SVG `<marker>` arrowheads
  - **Rectangle** — click-drag to draw outlined rectangles
  - **Circle** — click-drag to draw outlined ellipses
  - **Text** — click to place editable text; Enter to commit, Shift+Enter for newline, Escape to cancel
- **Five color swatches**: yellow, green, blue, pink, and **black (redaction)** — active swatch shows white border + purple ring
- **Eyedropper / current-color control**: divider-flanked control to the left of the palette (reads as its own control, not a sixth swatch). Background mirrors the current paint color; icon uses `mix-blend-mode: difference` so it stays readable on any fill. Clicking opens the native `EyeDropper` API (Chrome 95+) — works across all drawing tools, ideal for background-matching a solid shape over an ad. Custom-color highlights route through the fallback renderer (CSS Custom Highlights API requires pre-registered theme names).
- **Three stroke width presets**: thin (2px), medium (4px), thick (8px) — shown as graduated dots; also controls text font size (16px, 24px, 36px)
- **Fill group** (outline / solid radio pair) — visible only when Rectangle or Circle is active (buttons + trailing divider hide together). Outline variant carries a red diagonal slash to disambiguate it from the rect tool icon. Sets `AdnotaState.filled` (persisted as `adnotaShapeFilled`); payload stores `filled: bool` on `MARKER` items with `shapeType: 'rect' | 'ellipse'`. Solid shapes are the primary redaction for non-text content (ads, images, iframes) that can't be erased without breaking layout.
- **Undo button**: triggers `AdnotaUndo.undo()` directly from the toolbar
- **Draggable**: pointer-capture drag via handle (same pattern as eraser HUD); position resets when toolbar hides
- **Highlight mode**: text selection applies color via the **CSS Custom Highlights API** (`CSS.highlights`, Chrome 105+) — zero DOM mutation, React/Vue safe. Shadow DOM / cross-boundary ranges fall back to absolutely-positioned overlay divs with `mix-blend-mode: multiply`. Pastels render at `rgba(..., 0.4)` via `::highlight` CSS rules; **black** uses `color: #000; background-color: #000` for full opacity (text invisible underneath), and the fallback path drops `mix-blend-mode` so the cover stays solid
- Persists last-chosen color and stroke width to storage across sessions
- Undo: removes range from CSS Highlights registry and deletes from storage
- Schema stores: `text`, `occurrenceIndex`, `color`, `isFallback`, `fallbackRects`, `attachedNoteId` (reserved for future note cross-linking), optional `tag`
- **`scrollTo(id)`**: resolves the live entry from `liveHighlights`, picks the right scroll target (fallback wrapper when present, else the range's start-node parent — `scrollIntoView` walks up to find the scroll container, which matters on app shells like claude.ai where the document doesn't scroll). Returns `false` when the entry is missing or stale so the scratch pad GOTO can surface a miss-toast
- **Hover affordances**: live highlights are tracked in a module-level `liveHighlights` Map keyed by `_id`. An rAF-throttled `mousemove` handler hit-tests via `range.getClientRects()` (CSS path) or the fallback wrapper's children, then paints two layers — both rendered ourselves because CSS Custom Highlights + `pointer-events: none` overlays can't receive `title` or DOM listeners:
  - **`#tag` chip** tracks the cursor when the highlight has a tag (viewport-clamped, hides on scroll/resize)
  - **Delete ✕** anchored to the first-rect top-right runs `AdnotaHighlighter.deleteHighlight(id)`: tears down the visual, drops the storage row, pushes `AdnotaUndo`, and shows a 3s `Highlight deleted` toast. Toast Undo and Ctrl+Z share one `undoEntry` (consumed-flag guard) so restore is idempotent
- **Self-healing registry**: stale entries drop from the Map on the next hit-test — CSS-path entries when `highlightRegistries[color].has(range)` returns false (after `_rebuildLiveHighlights()` clears the registry on bulk trash), fallback entries when `fallbackEl.isConnected` goes false. So bulk deletions don't need to know about the Map

#### `content/resizer.js` — Element Resizer
- Activated via popup tool card, dock button, or bare-key `r` (when dock is visible)
- **Smart element targeting** (two-stage, order matters): (1) climb to the nearest layout-significant block ancestor (≥120×60px, non-inline) to escape tiny hovers; (2) *then* run `AdnotaUI.bubbleToVisualRoot` seeded from that ancestor to promote past visually-identical outer wrappers. Seeding the IoU climb from a real layout element rather than the raw hover (the eraser's approach) is what lets a hover on a 220×36 menu link reach the 220×356 `nav` two hops above
- **Hover chip cluster** (top-right of the hover overlay): a flex row holding the read-only blue `W×H` dimension pill plus up to two amber **action chips** (`unstick` / `restick`, `finite scroll` / `infinite scroll`). The dimension pill is the same shape used in the selection state so the readout stays where the user is looking; the HUD info area carries only the action hint
- **Unstick / restick**: on hover of a `position: sticky` / `fixed` element, an amber `unstick` chip appears — click overrides the element to `position: relative !important` (with `top/left/right/bottom: auto`) for that selector. `relative` rather than `static` is deliberate so descendants that absolutely-position against the unstuck parent (dropdowns, tooltips — Squarespace's PRODUCTS dropdown is the canonical case) keep the same positioning ancestor instead of escaping to `<body>`. The chip flips to `restick` on the inverse path; removing only that entry preserves any width/height resize on the same selector. Also surfaced on the selection state so a hard-to-hover sticky bar can be pinned first. Stored as `RESIZE` with `kind: 'unstick'`; the override string lives once in `UNSTICK_CSS_TEXT`. Single label for both sticky and fixed — same user intent. Domain-wide by default
- **Finite scroll / infinite scroll**: when the hovered element is taller than the viewport (the only case where capping it shortens anything), an amber `finite scroll` chip appears — click it to inject `overflow: hidden !important` + a `max-height` clamp so the page stops growing as the user scrolls. The chip flips to `infinite scroll` on the inverse path. Detected by an `overflow: hidden` signature in the rule's cssText (the unique fingerprint of finite-scroll rules — drag-resize and unstick don't touch overflow)
- **`isLayoutSignificant` overrides for sticky/fixed**: the 120×60 floor is bypassed for `position: sticky` / `fixed` elements (any non-zero size qualifies) — short sticky bars like GitHub's nav (~52px) or HN's header (~30px) would otherwise fail the threshold and `findLayoutTarget` would silently climb past them with no overlay drawn
- **Max-int z-index + DOM-order tie-break**: every resizer overlay sits at `z-index: 2147483647`. Modern ad/banner chrome uses the same value, so the resizer re-appends the hover overlay to `documentElement` on every show (`updateHoverTarget`) — DOM order breaks the tie in our favor and stops fixed page chrome from silently occluding the blue outline
- **Scroll-wheel DOM traversal**: while hovering, `Shift+Scroll` up walks to the next layout-significant parent and `Shift+Scroll` down walks back toward children (past the auto-bubbled baseline if needed), then one final step into a single iframe descendant when present — the iframe shield masks iframes from `elementFromPoint`, so this is the only path to a direct iframe target. `traverseDepth` only commits when the depth actually changes the target, so over-scrolling past either end doesn't inflate the value and reversing direction is immediate. Plain scroll passes through to the page
- **Iframe pointer shield**: same mechanism as the eraser (see above). `AdnotaUI.setIframeShield('resizer', true)` is installed on mode entry so cross-origin iframes don't swallow hover/click and the resizer can outline the iframe's parent wrapper
- **HUD body** (mounted into the dock when resizer mode is active): info section → help (?) button → trash → undo → REFLOW row (contextual, hidden when nothing applies). The dock owns drag handle + A logo + tool row; the resizer body fills the active slot. Matches the eraser HUD aesthetic, tinted with the resizer's blue accent. Info section updates live:
  - **Idle / Hovering / Selected** — short labels; the full tip list (click to select, ⇧+Scroll to traverse, drag handles, unstick, finite-scroll, ↺ reset, Esc) lives behind the `?` popover so the info area never wraps
  - **Trash button** — deletes every resize on the current page (same code path as the popup's Resized stat card)
  - **Undo button** — fires the shared `AdnotaUndo.undo()` stack
  - **REFLOW row** (3 icon buttons; whole row hides when no verb applies): `swap-panels` (flips flex `direction` row↔row-reverse / column↔column-reverse), `toggle-stack` (row-axis ↔ column-axis), `order-end` (sets `order` on a flex child to push it last). Each button paints its target on hover via an amber preview overlay so the user sees *what* will change before committing. Persists as `RESIZE` with `kind: 'reflow:swap-panels'` / `'reflow:dom-reorder'`
- Click to select: dashed blue outline with **handles + dismiss + chip cluster**. Every handle pins its opposite edge via a resolved-pixel margin written to both the live drag and the persisted CSS rule, so growth/shrinkage is always directional (and the move-via-resize trick — drag left out, drag right in — relocates an element without changing its size):
  - **Left / right / top / bottom / corner handles** — drag to resize from that edge; the opposite edge is pinned via `margin-left` / `margin-top` compensation. Corner pins top + left
  - **Blue reset button** (top-right, circular reset arrow icon) — resets ALL resize overrides for this element, removing injected CSS from both the `<style>` tag and storage. Deliberately blue (not a red ✕) so it doesn't collide semantically with the marker select tool's red ✕ delete affordance
  - **Tradeoff:** baking the resolved-pixel margin into the persisted rule means an element that was originally `margin: 0 auto` no longer re-centers on viewport resize. Deliberate — without the pin, an auto-centered element re-centers on every release and the move-via-resize trick is impossible. Reset (↺) restores the page's original auto-centering behavior
- **Selection chip cluster** (top-right of the selection box, ordered: parent → unstick/restick → finite/infinite scroll → text-size → recolor → clip → dimension; pinned to the *visible* top edge via `chipClusterTopOffset` so it slides down to stay on-screen when the user has scrolled into a tall selected element):
  - **`resize parent` chip** — surfaces when the selected element is a flex item pinned by its container (the canonical case is a flex-end child inside a fixed-width parent — resizing the child is a no-op because the parent caps it). Click promotes selection up to the parent so the user resizes the thing that actually controls the layout
  - **`unstick` / `restick` chip** — same behavior as the hover-state chip (see above), surfaced here so a sticky bar that's hard to hover can be pinned with a click first
  - **`finite scroll` / `infinite scroll` chip** — same behavior as the hover-state chip
  - **Text-size chips (`Aa−` / `Aa+`)** — scale `font-size` through a clamped scale (8px floor, 96px ceiling, disabled at bounds; Shift+click for a bigger step). Persists as `RESIZE` with `kind: 'text-size'`. `ruleSelectorFor` expands the stored selector to also hit prose-bearing descendants (`p, li, dd, dt, blockquote, caption, figcaption`) so authored child font-sizes can't override — solves the "13px body text" failure mode. Headings, code, and form controls are deliberately not in the cascade
  - **Recolor chips (`bg` / `text`)** — each opens the native `EyeDropper` API (Chrome 95+) to pick any pixel color from the page; persists as `recolor-bg` (element-only — `background-color` doesn't inherit) or `recolor-text` (same prose-cascade as text-size so authored child colors can't override). Re-clicking replaces the color via same-kind dedup. ↺ is the only way to fully clear; the chips don't mirror the picked color (the element repainting IS the user's confirmation — see `feedback_no_double_encode_state.md`)
  - **Clip chip** (`Container clipping` / `At max size`) — fires during drag (and latches after pointerup) when `AdnotaLayout.findGrowthOverflow` finds an `overflow: hidden | clip` parent that's silently masking the resize, or when the element's own `max-width` / `max-height` is capping growth. Click promotes selection to the clipping ancestor for the `clip-ancestor` case so the user can address the actual blocker; `size-cap` is warn-only in v2 (no click action)
  - **Dimension badge** (read-only) — current `W×H` in pixels, live-updated during drag. Same shape as the hover state's pill so the readout stays in the same spot
- **Body drag-to-position**: on `isPositionable` selections (not table components, not viewport-dominators), pointerdown on the body + 3px threshold translates the element; arrow keys nudge by 1px (Shift+arrow 10px). Cursor switches to `move` via `setProperty('cursor', 'move', 'important')` (must beat the global cursor lock). Persists as `RESIZE` with `kind: 'position'`
- **Cursor lock**: `AdnotaCursor.set` forces `default` on every non-Adnota element with `!important` while resizer is active so hovering links/buttons can't flip the cursor; handles keep their own `ew-resize` / `ns-resize` / `nwse-resize` cursors via higher specificity
- All resizes persist as CSS rules in `<style id="adnota-style-overrides">` (survives React/Vue re-renders). Driven by a `window.AdnotaResizeRules` Map keyed by `_id`, with `window.rebuildResizeStyleTag()` rewriting the tag from the Map after every mutation. Mirrors the eraser's `AdnotaEraseRules` — every path (drag, Ctrl+Z, trash, ↺, restorer) goes through map + rebuild so there's no string surgery and no zombie rule can survive undo/delete
- **Domain-wide by default**: every resize is stored with `path: '*'` (vs the eraser's per-page default) — resize targets are almost always structural containers (nav, sidebar, header, article wrapper) that recur across a site, so per-page scoping would force the user to redo the same resize on every sibling page. Misfires silently no-op, and the blue ↺ on that page wipes the rule
- CSS selector generation uses the shared `FuzzyAnchor.generateCSSSelector()` utility
- CSS rule format for a drag-resize: `overflow: hidden; <width|height>: Xpx; <min|max>-<W|H>: <0|none>; margin-<left|top>: Ypx` (all `!important`). `overflow: hidden` clips children to the new bounds; the `min-*: 0` / `max-*: none` pair unsets the page's own caps so the user can shrink to 0; the margin pin keeps the opposite edge fixed across reflows. Drag math floors at `Math.max(0, ...)` — shrinking to 0 is legitimate (the alternative-to-erase for flex/grid children where `display: none` would break the surrounding layout), and the still-visible ↺ on the selection box keeps recovery reachable around a 0×0 element
- Handles are viewport-clamped + reposition on scroll. Undo via shared `AdnotaUndo` stack + 3s toast button
- Storage action type: `RESIZE`. The optional `kind` discriminator distinguishes overrides on the same selector — drag-resize (no `kind`, the default), `unstick`, `text-size`, `position`, `recolor-bg`, `recolor-text`, `reflow:swap-panels`, `reflow:dom-reorder`. Multiple kinds can coexist on the same selector (e.g. an unstick + a width drag); each is its own row keyed by `_id`, and each chip's inverse path finds its own entry by matching `selector` + `kind`. Same-kind rewrites (re-picking a recolor, re-bumping text-size) replace in place. The blue ↺ reset wipes *all* rules for the selector regardless of kind

#### `content/marker.js` — `window.AdnotaMarker`
- Full drawing engine powering pencil, arrow, rectangle, ellipse, text, and select tools
- Transparent SVG canvas overlay captures pointer events across the full page while active
- Toolbar-area clicks are explicitly guarded (both by DOM check and bounding box) to prevent strokes firing through the toolbar
- **Scroll passthrough while idle**: plain wheel events are forwarded to the topmost non-Adnota scrollable ancestor under the cursor (`elementsFromPoint` skips Adnota chrome; loop walks up for `overflow: auto/scroll` + content overflow, then `scrollBy`s). Required because `#adnota-capture-canvas` is full-viewport `pointer-events: auto`, so the browser's native scroll-chain dies on it on `overflow: hidden` app shells. `touch-action: pan-x pan-y` keeps trackpad scroll native on normal documents. Mid-stroke wheel is blocked instead — scrolling through a gesture would produce cross-viewport shapes and disconnected pen lines
- **Pencil tool**: freehand drawing with **Ramer-Douglas-Peucker** path simplification (ε = 2.0) to reduce point density before storage
- **Arrow tool**: click-drag creates a straight line with SVG `<marker>` arrowhead; minimum distance threshold prevents accidental tiny arrows
- **Rectangle tool**: click-drag creates a `<rect>` with rounded corners; handles any drag direction (origin can be any corner). Honors the toolbar Fill toggle — outlined by default, solid fill when enabled
- **Ellipse tool**: click-drag creates an `<ellipse>`; center is midpoint of drag, radii from extent. Honors the toolbar Fill toggle (outline or solid fill)
- **Text tool**: click to place a `contentEditable` text box; Enter commits, Shift+Enter for newline, Escape cancels; font size derived from stroke width preset (thin=16px, medium=24px, thick=8=36px); rendered as HTML (not SVG `<text>`) for natural multi-line editing; double-click to re-edit existing text
- **Select tool**: click near any marker/shape/text to select (SVG `getBBox()` hit-test picks the smallest overlapping shape); dashed purple selection box, red ✕ delete, Delete/Backspace key. Body cursor switches to a white SVG arrow; hovering a `.adnota-marker-wrapper` upgrades to `grab` via `html.adnota-select-mode`. **Drag-to-move**: pointerdown + 3px threshold translates any shape (rect/ellipse/arrow/freehand/text) live via CSS transform; on pointerup the delta is converted to a percentage of the anchor rect, applied to the payload's coord fields (`shape`, `textPos`, `drawing[]`), persisted, and pushed onto `AdnotaUndo`. A `suppressNextClick` flag swallows the synthetic click after a committed drag.
- **Stroke width**: all tools read `AdnotaState.strokeWidth` (2, 4, or 8) for line thickness; persisted per stroke in storage
- **Unified persistence**: all shapes stored as `MARKER` action with a `shapeType` field (`freehand`, `arrow`, `rect`, `ellipse`, `text`) — same anchor/restore pipeline via `renderMarker()`. Rect/ellipse payloads also carry `filled: bool`; solid payloads render with `fill=color, stroke=none`
- Rendered markers re-anchor to their block element via `ResizeObserver` + scroll listener — no drift on long pages
- **Fixed-position overlay**: every wrapper lives inside `#adnota-marker-overlay` (`position: fixed`, viewport-sized, `pointer-events: none`); coords are viewport-relative. Keeps wrapper bounds out of `scrollHeight` so a shape near the page edge can't pull a phantom scrollbar in on `overflow: hidden` app shells. Same trick `#adnota-capture-canvas` and `.adnota-select-box` use
- **Five colors**: same palette as highlighter (yellow, green, blue, pink, black)
- A tap with fewer than 3 points (pencil) or too-small drag (shapes) cancels the action
- **Hover affordances**: an rAF-throttled `mousemove` handler runs `hitTestMarker(x, y)` and paints a floating ✕ at the wrapper's `getShapeBBox` top-right. Click flows through the shared `deleteSelectedMarker(wrapper)` — same path as the Select-tool ✕ and Backspace — using the consumed-flag pattern so the toast Undo and Ctrl+Z share one `undoEntry`. Works in every paint mode (including Select); suppressed when paint is hidden, mid-stroke, or when the hovered wrapper is already `selectedWrapper`. Belt-and-suspenders hides on Shift `keydown` and document `pointerdown` so a stranded ✕ can't linger through a drag

#### `content/quickHighlight.js`
- Medium-style contextual popup that appears above any non-empty text selection after a ~400 ms dwell — independent of the Draw HUD's highlight mode
- **Two-row layout**. Row 1: Adnota "A" brand chip (visually distinct from the host site's own toolbar) → five color swatches → session-dismiss `✕`. Row 2: an optional tag input (`#` glyph + text field). Clicking a swatch reads the current tag value and forwards it to `AdnotaHighlighter.createHighlightFromRange(range, color, tag)` so the created HIGHLIGHT carries the tag; leaving the input blank preserves the original one-tap flow
- Each new selection re-prompts — colors and tag are not "sticky" between highlights; the user picks per-action. The tag input clears on every `hidePopup`
- **Selection preservation**: clicking the tag input collapses the live selection, so the popup caches a clone of the range at show-time and `applyHighlight()` falls back to it. `selectionchange` hide is suppressed while the tag input has focus
- Tag autocomplete via `AdnotaTags.buildAutocompleteDropdown`; the dropdown lives outside the popup (`<body>` + `position: fixed`), so the outside-click hide-handler has an explicit bypass for `.adnota-tag-suggest`
- Dismisses on: selection collapse, `Escape`, scroll, resize, click-away, or `Ctrl/Cmd+C` (copy is never intercepted)
- Skips editable contexts (`input`, `textarea`, `contenteditable`) and selections inside Adnota UI
- Suppressed while `AdnotaState.mode === 'highlight'` so it doesn't double up with the Draw-HUD's auto-apply mouseup (the HUD path stays a zero-UI fast path with no tag input)
- Reuses `AdnotaHighlighter.createHighlightFromRange()`; feature-gated by `chrome.storage.local.adnotaQuickHighlightEnabled` (default `true`)

#### `content/debugCapture.js` — developer-only DOM/state capture
Curated DOM/style snapshot of the page plus any registered Adnota tool state, copied to the clipboard as a JSON bundle for pasting into Claude Code while iterating on heuristics. **Hotkey**: `Cmd+Shift+K` (Mac) / `Ctrl+Shift+K` (Win/Linux). **Console**: `window.adnotaDebugCapture("optional label")`. Each capture flashes a green outline on the captured element, surfaces a top-right toast naming the target + bundle size, and console-logs the full bundle.

Tools opt into richer state by registering `window.__adnotaDebug.tools[name] = () => stateObject`; whatever they return is included verbatim. Per-tab developer surface only — no equivalent in the popup or Sites page. The hotkey is bound by `e.code` (physical key) so it survives Mac Alt-remapping and non-US keyboard layouts.

#### `content/restorer.js`
- Runs at `document_idle` and on `DOMContentLoaded`
- **MutationObserver** with a 1s trailing debounce + 2.5s max-wait clamp watches for SPA/lazy-loaded content and re-runs restoration — handles React, Vue, and infinite-scroll sites. The clamp prevents continuously-mutating apps from deferring restoration indefinitely (each new mutation would otherwise reset the debounce); after 2.5s of sustained mutation we force a pass instead of waiting for the burst to settle
- Dispatches to the correct engine by `action` type:
  - `RESIZE` → `AdnotaResizeRules.set(id, { selector, cssText })` + `rebuildResizeStyleTag()` — **bypasses FuzzyAnchor entirely** since the CSS selector is self-contained. Idempotent: re-processing an item already in the Map is a no-op (prevents the duplicate-rule class of bug where undo/delete would leave a stale copy behind)
  - `ERASE` → injects a CSS rule into the shared `<style id="adnota-erase-overrides">` tag via `AdnotaEraseRules.set(id, selector)` + `rebuildEraseStyleTag()`, so the element stays hidden even if the host page re-creates it (ad rotation, React re-mount). Selector is run through `AdnotaUI.maybeGeneralizeAdSelector` first so ad-shaped custom-element tags (`<shreddit-comments-page-ad>` etc.) widen to `<specific>, <tagname>` and the next impression in the same slot is auto-hidden without re-erasing. As a sidecar, FuzzyAnchor is consulted to resolve the original element — if found, also tagged with inline `display:none` and added to `AdnotaErasedElements` so `Alt+S` show/hide can toggle it
  - `NOTE` → `StickyEngine.renderNote()` with stored `anchor`, `anchorOffset`, `fallback`, `placement`, `theme`, and `dimensions` — runs the 3-tier cascade (Tier 1 FuzzyAnchor on the original block → Tier 2 FuzzyAnchor on the saved scroll-container ancestor + offset → Tier 3 percentage of `scrollWidth/Height`). The note always renders somewhere, but `processedItems` only locks in when Tier 1 succeeds; Tier 2/3 renders leave the item retryable so the next MutationObserver pass can snap up to Tier 1 once the host page finishes hydrating. Legacy placement-only notes (no anchor data) mark processed immediately. Same applied-vs-found split the HIGHLIGHT path uses
  - `HIGHLIGHT` → `AdnotaHighlighter.applyStoredHighlight()`
  - `MARKER` → `AdnotaMarker.renderMarker()` with a 3-tier cascade: (1) FuzzyAnchor on the original block; (2) saved `fallbackBox.containerAnchor` (nearest scrolling ancestor at save time) + offset within it — scrolls with content on app shells; (3) absolute doc-pixel coords as last resort. **Tier upgrade**: tier 2/3 renders go into `pendingMarkerUpgrade` rather than `processedItems`, so later passes keep retrying tier 1. When it resolves, `AdnotaMarker.tearDownById(uuid)` re-renders against the real anchor — fixes claude.ai markers that would otherwise stay glued to the viewport at tier 3. Pending-upgrade is silent in steady state; a `restorer:marker-upgrade` log fires when one upgrades
- Deduplicates with a `processedItems` Set so MutationObserver re-runs don't re-render already-applied annotations. The Set is cleared whenever `location.href` changes between passes so an SPA in-app nav (`/foo → /bar → /foo`) gets a fresh restoration on the return visit instead of silently skipping every item; the existing MutationObserver fires on the SPA-nav DOM swap, so no popstate/pushState hook is needed
- **SPA URL-change teardown**: when `lastProcessedUrl !== location.href`, the restorer tears down every overlay (`AdnotaMarker.tearDownAll`, `AdnotaHighlighter.tearDownAll`, `StickyEngine.tearDownAll` — sequential `await` so each tool flushes pending autosaves to the path it belongs to before removing, since the debounce captures `location.pathname` at fire time), then clears the rule Maps + erased-elements Set and rebuilds the style tags from scratch. Storage is untouched — the next pass repaints whatever belongs to the new URL. Without this, app-shell SPAs (claude.ai, etc.) would bleed the previous URL's annotations into the next one
- **In-flight guard**: a `restorationInFlight` flag drops re-entrant `performRestoration` calls so rapid SPA nav can't race two teardowns + renders
- **Steady-state write guard**: per-URL stat writes (and their `storage.onChanged` fan-out) only fire when `processedItems.size` grew or anchors are still broken — keeps the every-~2.5s observer wake-up silent on long-lived SPA tabs
- **Navigation API zero-latency hide**: a `window.navigation.addEventListener('navigate', ...)` listener (Chromium 102+, feature-detected) sets `html.adnota-route-changing` synchronously on every SPA `pushState`/`replaceState`; CSS in `lib/adnotaUI.css` hides only the three annotation containers (`#adnota-marker-overlay`, `.adnota-highlight-fallback`, `.adnota-sticky-container`) so the dock and HUD chrome don't flicker. `_performRestoration` clears the class at end of pass; a 3s backstop `setTimeout` covers the case where state pushes without any DOM mutation

---

### UI

#### `popup/index.html` + `popup/popup.js` + `popup/style.css`
Premium dark-header popup (360px wide). Features:
- **Tool cards** for Eraser, Sticky Note, Draw, and Resizer — icon chip, shortcut badge (`e`/`s`/`d`/`r`), active-state indicator (colored border + pulsing dot) syncs live via `storage.onChanged` (catches shortcuts fired while popup is open). The Draw card opens a HUD with seven sub-tools (Highlight, Pen, Arrow, Rect, Circle, Text, Select); text highlighting also has the separate auto-popup path (`content/quickHighlight.js`), so the Draw HUD is primarily a drawing surface
- **Bare-key listener**: `e/r/s/d` in popup focus fires the same toggle as the card click and closes the popup. Mirrors the dock's bare-key handler so users see consistent behavior even when the dock is dismissed (popup itself is the modal indicator, and tool activation auto-restores the dock)
- **Per-page stats** (Erased / Notes / Highlights / Resized / Strokes) — each stat card cross-fades to a trash icon on hover; clicking clears that category from the current page
- **Show/Hide Changes button** (`Alt+S`) in the header — eye icon with a diagonal slash overlay when annotations are hidden. Reads live state via `get-view` message to the content script on open; optimistically toggles on click for instant UI response
- **My Edited Sites** button in footer (purple outline) — opens the Sites history page
- **Clear All Page Edits** button in footer (red outline)

#### `content/dock.js` + `content/dock.css` — The Adnota Dock
One persistent floating widget (fixed, bottom-center, draggable) that is the only Adnota chrome on the page. Two visual states, toggled by which tool (if any) is active:
- **Idle**: a single favicon-style A mark — rounded-square, same purple→magenta gradient as `icons/favicon.svg` so the on-page chrome reads as the same brand as the extension bar icon. Hovering blooms the row to `[A][eraser][sticky][marker][resizer][scratch][vis]` (300ms `max-width` transition on `.adnota-dock-tools` with a 180ms post-slide timer that lifts `overflow: clip` so edge-button tooltips can render past the row), while the A morphs to a translucent circle in parallel. Sits at `opacity: 0.55` collapsed, `1` expanded; `cursor: grab` signals draggability. The scratch button greys to 30% opacity when the page has no HIGHLIGHT or NOTE items so it never teases when there's nothing to recall.
- **Active**: `[drag][← back (tinted)][tool's HUD body]` — tool row collapses, A morphs into an accent-colored back arrow, the tool's own controls fill the body slot.
- **Back arrow / Escape / clicking the active tool again** all exit and return to idle. First-tool-activation across the profile fires a one-time toast (`adnotaToolEscTutorialShown`) naming the Esc shortcut — tooltips need a hover, a user mid-task isn't reading chrome.
- **A logo** opens the Sites history page in a new tab.
- **Dismiss X** (red circle, reuses `.adnota-select-delete` styling) fades in on hover when idle — click to hide the dock on the current domain. **Per-domain persisted** as a symmetric toggle: the X writes the hostname to `chrome.storage.local.adnotaHiddenDomains`, and any of `Alt+A`, opening the popup, or activating a tool from the popup removes it — whatever the user last did on a domain is what sticks. First-dismiss across the profile fires a one-time educational toast (`adnotaDockDismissTutorialShown`) naming the recovery paths; subsequent dismisses are silent. Bare-key shortcuts (`e/r/s/d/f`) deliberately do *not* restore — the dock-visible gate stays meaningful.
- **Drag anywhere** on the dock to reposition. 4px threshold distinguishes drag from click; saved position persists to `chrome.storage.local.adnotaDockPosition`. A never-positioned dock sits at `left:50%; transform:translateX(-50%)` so the first hover-expand blooms symmetrically around the cursor; the first drag commits to absolute `left:Xpx; transform:none` via `commitPositionIfCentered`, after which the dock always expands rightward.
- **Position flash prevention**: `visibility: hidden` until JS has read the saved position and added `.adnota-dock-ready`, so a repositioned dock never blinks at the default center on page load.
- **Print hide**: `@media print { #adnota-dock { display: none !important; } }` — Ctrl+P never includes the dock.
- **Per-tool accent** (`data-accent` attribute set on mount): back arrow + dock border both pick up the active tool's color (red / amber / purple / blue).
- **Public API**: `AdnotaDock.mount(toolId, buildBodyFn)` on mode entry, `AdnotaDock.unmount(toolId)` on exit. The `toolId` guards against cross-tool races where an outgoing tool's subscriber would clear the body the incoming tool just installed.
- All elements marked `data-adnota-ui` so eraser/resizer ignore them.

#### `content/scratchPad.js` + `content/scratchPad.css` — Page Snippets (the scratch pad)
Per-page floating panel that lists every HIGHLIGHT and sticky-note body for the current URL. Designed as the **TEXT-IS-KING** counter to the Sites/Snippets feed — austere on purpose: no per-item color border, no source chip, no card chrome, no visual difference between a highlight and a note. Just the text, an optional muted `#tag`, and a hover-revealed copy button. The use case is in-page recall during long-text reading (ChatGPT/Claude conversations, longform articles) where scrolling back to the original is the friction the user is trying to escape.
- **Header**: filter pills (`All` / `Highlights` / `Notes`, the active one rendered in `var(--adnota-accent)` purple with a thin underline + inline count), `Copy all`, `✕`. The whole header is the drag handle (excluding the buttons themselves). Filter selection persists globally to `chrome.storage.local.adnotaScratchFilter` (one preference for the user, not per-host).
- **Body**: snippets stacked newest-first with hairline `rgba(255,255,255,0.08)` dividers between them. Inter, 14px, line-height 1.5, `white-space: pre-wrap` so multi-paragraph highlights keep their breaks. Black-redaction highlights (`color === 'adnota-theme-black'`) render as a `█` bar with the same length-clamping formula as the Sites feed (6–48 glyphs) instead of leaking the hidden text. Sticky notes with empty bodies are silently skipped.
- **Per-snippet copy**: `:hover` on a row reveals a single floating glyph in the top-right corner — no card around it. Click → ✓ flash, 1.4s revert. **Copy all** in the header writes every visible (post-filter) snippet, joined by `\n\n`.
- **Per-snippet GOTO**: `:hover` also reveals a crosshair button left of the copy. Click smooth-scrolls the source into view via `AdnotaHighlighter.scrollTo(id)` / `StickyEngine.scrollTo(uuid)`. If the engine returns `false` (broken anchor, mid-restoration, SPA URL teardown), an inline 2s toast `Couldn't locate this on the page.` surfaces inside the panel
- **Selection guard**: panel never auto-closes on outside click (would interfere with copy/paste); `pointerdown` on the header skips the drag handler when there's an active selection inside the panel
- **Idle transparency**: fades to `opacity: 0.6` after 600ms with no cursor over it, `mouseenter` snaps back to 1.0. Header stays at parent opacity
- **Drag + resize + persistence**: header-drag repositions; native `resize: both` handles size. Both persist **per-hostname** under `adnotaScratchPosition` and `adnotaScratchSize` (each a `{ host: {...} }` map). Defaults: 420×360px, bottom-right of viewport above the dock
- **Live updates**: a `chrome.storage.onChanged` listener tied to the current hostname rebuilds the list on any storage change
- **Invocation**: dock button and bare-key `f` when the dock is visible. Dock button is `data-disabled="1"` (30% opacity) when the page has no snippets — re-checked on `storage.onChanged` and on SPA nav via `window.navigation.addEventListener('navigate', ...)` (Chromium 102+) with `popstate` fallback. Bare-key `f` honors the same gate
- **Escape**: bubble-phase keydown closes the panel, but defers to `AdnotaState.mode` first — if a tool is active, Escape exits the tool and the panel stays open (two presses to close both)
- **Reuse**: borrows `AdnotaStorage.getAnchorsForUrl` and the redaction-bar formula. Deliberately does *not* share the Sites/Snippets `buildQuoteBlock` renderer — the scratch pad is the austere reference
- **Public API**: `window.AdnotaScratchPad = { toggle(), open(), close(), isOpen(), refresh(), pageSnippetCount() }`. The dock calls `toggle()` and `pageSnippetCount()`.

#### `pages/sites.html` + `pages/sites.js` + `pages/sites.css`
Dedicated extension page (opened as a new tab via `chrome.runtime.getURL`). Two tabs share a common sticky header; each tab owns its own chrome.

**Shared header** (sticky)
- **View tabs** (primary nav, centered in the dark header): `Snippets` (prose feed, default) and `Sites` (per-domain browser). Each carries a live count badge. Active tab persists to `chrome.storage.local.adnotaHomeTab`.
- **Tag filter chip row** inside the sticky header (never scrolls off). Rendered from `AdnotaTags.getAllTags()`; hidden entirely when no tagged items exist. Chips sorted count desc + alpha tiebreak. Active tag is mirrored to the URL hash (`#tag=foo`) so filters survive reloads and are shareable; a `hashchange` listener syncs back/forward. Auto-clears if the active tag disappears.
- **Search** adapts per tab: on Snippets it matches body text OR domain; on Sites it matches hostname only. Same `<input>`, placeholder swaps.
- **Sort** adapts per tab: `Newest` / `Oldest` on Snippets, `Recent` / `A→Z` / `Most Edits` / `Largest` on Sites. Each tab's last-selected sort is preserved across tab switches.
- **Live updates**: a `chrome.storage.onChanged` listener rebuilds both tabs automatically on any write.

**Snippets tab** — prose feed of captured text (the research payoff surface)
- **Mingled chronological stream** of highlights + sticky notes, newest first. Derived per render from storage; no new persisted schema — both types already carry the fields this view needs.
- **Highlight blocks**: 3px left border in the highlight color, plain body text. Black redactions render as a `█` bar scaled to the original length rather than leaking the hidden text into the feed.
- **Note blocks**: 3px theme-color left strip + faint color tint bleeding in from the edge. Blank-body notes are skipped on the feed (still counted on Sites).
- **Type filter** centered above the feed: `All` / `Highlights` / `Notes`, persisted to `adnotaHomeFeedType`.
- **Source chip** under each item: favicon + domain + relative time + optional `#tag`. Click on the card opens the source page in a new tab.
- **Per-item hover actions** (top-right): **Copy** writes the raw text (newlines preserved) to the clipboard with a green flash on success; **Trash** soft-deletes with a 3s Undo toast via `AdnotaUI.softDeleteItems` — single-id batch, same plumbing as the HUD bulk-delete.
- **Paragraph fidelity**: `range.toString()` captures newlines at block boundaries; `.feed-text` uses `white-space: pre-wrap` so multi-paragraph highlights render with their breaks intact (Copy button reads the same `item.text` so it stays in sync)
- **Selection guard**: card click checks `getSelection().isCollapsed` + block containment so a drag-select inside the card doesn't hijack into a tab-open

**Sites tab** — per-domain browser (kept as the management surface for non-text annotations: erasures, drawings, resizes have no body text and can only be managed here)
- **Per-domain cards**: favicon, hostname, page count, last-edited timestamp, size
- **Annotation type pills**: Erased / Notes / Highlights / Resized / Strokes with color-coded badges
- **Expandable page drawer**: chevron reveals every individual path within a domain, each with its own pills. The path itself is a `target="_blank"` hyperlink with an external-link icon to the right (icon brightens + nudges on hover); domain-wide `*` entries stay as non-clickable labels
- **Visit button**: opens the most recently edited page for that domain
- **Delete-domain button**: red trash icon next to Visit wipes every edit for that hostname in one confirmation step (uses the shared branded confirmDialog)
- **Active tag filter** (when set on the shared chip row) narrows cards + drawer rows to items carrying that tag, and a purple `#tag · N` pill is appended to matching cards and page rows so the match is visible in place
- **Summary bar** (scoped to this tab — per-domain aggregates don't belong on a prose feed): total sites, total edits, total pages
- **Storage meter**: live `chrome.storage.local.getBytesInUse(null)` reading against `QUOTA_BYTES` (10 MB on MV3). Shows `X.XX MB / 10 MB · N%` with a gradient progress bar that turns amber at ≥80% and red at ≥95% so users can self-manage before hitting the cap

---

## Known Constraints & Deliberate Cuts

| Item | Decision |
|---|---|
| Storage | `chrome.storage.local` only, 10 MB cap on MV3. Cloud sync deferred. Sites-page meter surfaces usage |
| Cross-origin iframe contents | Out of scope — users can erase the top-level `<iframe>` element but not reach into its document |

---

## Keyboard Shortcuts

Two layers: **global** (work anywhere, always) and **bare-key** (work only when the dock is visible AND no input/textarea/contenteditable is focused AND no modifier is held). The dock-visible gate makes the dock itself the "annotation mode armed" indicator — if you can see it, the bare keys are live.

**Global**

| Shortcut | Action |
|---|---|
| `Alt+A` | Toggle the Adnota dock on the current domain. Pressing on a hidden domain restores and un-blacklists; pressing on a visible domain hides and blacklists (per-domain persisted). While a tool is active, exits the tool *and* hides the dock in one keystroke. Symmetric counterpart to clicking the dock's X |
| `Alt+S` | Show / Hide all annotations |
| `Ctrl+Z` / `Cmd+Z` | Undo last action (any tool) |
| `Escape` | Deactivate active tool (universal — works from any tool, any state) / cancel text input |

**Bare-key (when dock is visible)**

| Shortcut | Action |
|---|---|
| `e` | Toggle Eraser |
| `r` | Toggle Resizer |
| `s` | Toggle Sticky Notes |
| `d` | Toggle Draw HUD (enters `pen` by default) |
| `f` | Toggle the page snippets scratch pad (no-op when the page has no highlights or notes) |

**Tool-specific**

| Shortcut | Action |
|---|---|
| `Shift` (hold) | Paint annotations become first-class objects — click to select, drag to move, Delete to remove. Drawing tools (pen/arrow/rect/ellipse/text) are suspended while Shift is held, so there's no overlap between drawing and selecting. Links/buttons under empty canvas still behave normally — only paint items are hijacked |
| `Shift+Click` | (Eraser only) Domain-wide deletion |
| `Enter` | (Text tool) Commit text |
| `Shift+Enter` | (Text tool) Insert newline |
| `Delete` / `Backspace` | (Select tool) Delete selected annotation |
| `Double-click` | (Select/Text tool) Re-edit existing text annotation |
| `Shift+Scroll Wheel` | (Eraser & Resizer) Walk up/down DOM tree to target parent or child elements. Plain scroll (no Shift) is left alone so the user can scroll the page while a tool is active |

