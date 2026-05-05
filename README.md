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
MV3 manifest. Permissions: `storage`, `activeTab`, `scripting`, `tabs`. Host permissions: `*://*/*`. Declares two keyboard commands: `Alt+A` (toggle dock) and `Alt+S` (show / hide all annotations). Tool activation is layered on top — bare keys `e/r/s/d` toggle each tool when the dock is visible (see Keyboard Shortcuts section). Declares `web_accessible_resources` for the `pages/` directory (Sites history page). Content scripts inject `lib/log.js` (loaded first so every later script can use `AdnotaLog`), `lib/storage.js`, `lib/annotationState.js`, `lib/adnotaUI.js`, `lib/tagIndex.js`, then the content modules in dependency order.

#### `background.js`
Minimal service worker. `importScripts('lib/log.js')` at the top so the worker shares the same logger surface as content scripts. Routes keyboard command events from the browser to the active tab's content scripts via `chrome.tabs.sendMessage`. Also relays messages from the dock (content scripts can't `sendMessage` to their own tab): `open-sites` and `relay-to-tab`.

---

### Shared Libraries (injected into every page)

#### `lib/log.js` — `window.AdnotaLog`
Gated debug-event logger shared across content scripts, the background service worker, popup, and the Sites page. Default-on for pre-release; toggle off via `chrome.storage.local.set({ adnotaDebugLog: false })` (global, live — `storage.onChanged` flips the flag without reload) or `localStorage.setItem('adnotaDebugLog', '0')` (per-tab override on the page side only).

**Surface**: `event(channel, action, data)`, `el(node)` (returns `{sel, tag, w, h, text}` for an element — uses `FuzzyAnchor.generateCSSSelector`), `group(channel, label, fn)`. Output format: `[Adnota:<source>:<channel>:<action>] {…data}`. The source tag is `cs` (content script), `bg` (service worker), `popup`, or `sites` — these are three separate console contexts (host page DevTools, chrome://extensions service-worker console, popup inspector) and the label is what lets a single flow be reconstructed across them. Filter in DevTools by typing `Adnota:` (all), `Adnota:restorer:` (one channel), or `Adnota:cs:eraser:click` (one event).

**What's instrumented**: tool commits only (mode-enter/exit, click, drag-up, undo, delete, trash-all) plus page/route-load events in the restorer. Hover, mousemove, and wheel ticks are deliberately not logged — they fire dozens of times a second. Restorer also enforces steady-state silence: `pass-end` only emits when something actually changed (`grew || hasBroken`), matching the existing storage write-gate, so the every-~2.5s MutationObserver wake-up on long-lived SPA tabs stays silent.

#### `lib/storage.js` — `window.AdnotaStorage`
Wrapper around `chrome.storage.local`. All data is keyed by `hostname`, and each entry lives in a `items[]` array. Every item carries:
- `action`: `'ERASE'` | `'NOTE'` | `'HIGHLIGHT'` | `'MARKER'`
- `version`: schema version field (currently `2`) — future-proofs migrations
- `anchor`: nested object containing all FuzzyAnchor signals (cssSelector, tagName, textFingerprint, attributes, structure, geometry) — present on ERASE, HIGHLIGHT, MARKER, and NOTE (for hybrid anchor placement)
- `timestamp` / `createdAt` / `updatedAt` as appropriate per action type
- FuzzyAnchor fields for restoration
- `tag`: optional user-supplied string, NOTE and HIGHLIGHT only. Normalized on write (trim + collapse interior whitespace, 40-char cap). Field is omitted entirely when empty so the untagged path leaves no empty-string debris in storage.

Methods: `saveItem`, `saveNote` (generic upsert-by-uuid — caller passes full payload), `deleteItem`, `getAnchorsForUrl`, `clearPage`.

#### `lib/annotationState.js` — `window.AdnotaState`, `window.AdnotaUndo`, `window.AdnotaVisibility`
**`AdnotaState`**: Single source of truth for active tool mode (`null` | `'eraser'` | `'sticky'` | `'highlight'` | `'pen'` | `'arrow'` | `'rect'` | `'ellipse'` | `'text'` | `'select'`), active color, stroke width, and shape fill modifier. `color` holds either a theme class (`adnota-theme-*`) or a raw hex string from the eyedropper — consumers must handle both. `filled` is a boolean modifier that only affects rect/ellipse. Persists `adnotaActiveMode`, `adnotaHighlightColor`, `adnotaStrokeWidth`, and `adnotaShapeFilled` to storage for cross-component sync (popup reads these live). Subscriber pattern — all tools react to state changes without polling.

**`AdnotaUndo`**: Central undo stack shared by all tools. Pressing `Ctrl+Z` / `Cmd+Z` anywhere on the page pops and executes the most recent `{ undo: async fn }` entry, regardless of which tool created it.

**Universal Escape + focus anchor**: a single `window`-capture keydown handler clears `AdnotaState.mode` on Escape — no matter which tool is active, Escape always exits. To keep Escape reachable even when cross-origin iframe ads try to trap keyboard focus, a hidden focusable `<div id="adnota-focus-anchor">` (zero-size, `tabindex="-1"`, `data-adnota-ui`) is focused on mode entry. A `focusin` capture listener yanks focus back whenever anything outside Adnota UI grabs it; `visibilitychange` re-anchors on tab round-trips. `AdnotaState.anchorFocus()` is exposed for tools that `preventDefault` pointer events (eraser page-click blocker) to explicitly reclaim focus after suppressing the implicit transfer.

**`AdnotaVisibility`**: Ephemeral show/hide-all controller. `toggle()` flips a `adnota-hidden` class on `<html>` (which component CSS rules target), iterates `AdnotaErasedElements` to flip inline `display:none`, disables/re-enables the `adnota-erase-overrides` + `adnota-style-overrides` style tags, and injects/removes a transient stylesheet that zeroes out CSS Custom Highlights backgrounds. State is NOT persisted — every page load starts visible. `show()` idempotently reveals; called from sticky/highlight/marker handlers so hide mode can't block or obscure new work. The central `toggle-view` / `get-view` message handler and a `visibility-changed` broadcast (for popup icon sync) also live here.

#### `lib/adnotaUI.js` — `window.AdnotaUI`                                                                           
Shared UI utilities that prevent duplication across content scripts.                                                                                                     

**`data-adnota-ui` convention**: Every Adnota UI element (overlays, toolbars, toasts, sticky notes, marker wrappers, etc.) must be tagged with `data-adnota-ui="1"`. This is how the eraser, resizer, and marker know to ignore Adnota's own elements — `isAdnotaElement(el)` is a single `.closest('[data-adnota-ui]')` check. When adding new UI elements, always set this attribute or they will be erasable/selectable by the user's own tools.

**Shared HUD button helpers**: `createToolbarIconButton`, `createUndoButton`, and `createTrashButton` produce the dark-frosted `adnota-undo-btn`-styled controls used across every HUD. `softDeleteItems({singular, plural, actionTypes})` is the single implementation behind every bulk trash action (popup stat cards, popup "Clear All," and HUD trash buttons): it snapshots matching items by ID, removes them from storage, hides them from the DOM, and shows a 3-second toast with Undo. Undo re-writes storage and re-renders in place; Ctrl+Z also pops the batch off `AdnotaUndo`.

**Shared DOM-walk helpers**: `bubbleToVisualRoot(el, opts)` walks up parents whose bounding box matches `el` within a small tolerance — the "visually-identical wrapper" climb used by both the eraser and resizer so a hover/click on an inner element lands on the outer container users almost always actually mean. `dominatesViewport(rect, threshold)` guards the walk (and the eraser's better-target nudge) against ever promoting to a page-level container.

**Anchor-sync listener triad**: `bindAnchorSync(wrapper, anchorElement, syncFn)` is the single source of the `window.resize` + capture-phase `window.scroll` + `ResizeObserver` listener bag every persisted overlay needs (highlighter fallback wrappers, marker text wrappers, marker SVG wrappers). Registers all three, returns an idempotent cleanup that tears them down, stashes the cleanup as `wrapper._adnotaCleanup` for the delete paths, and installs a parent-childList `MutationObserver` that auto-cleans when the wrapper is detached by anything else (bulk-delete sweeps, page mutations). Without this the listener bag outlived the wrapper for the life of the tab — fine on a single article page, painful on a long-lived SPA tab where every undone or re-rendered annotation left a permanent scroll-listener tax.

**Layout-aware text from a Range**: `rangeText(range)` returns the text of a Range, preserving line breaks even when the surrounding code is rendered by a syntax highlighter (Prism, Highlight.js, ChatGPT's bespoke one) as inline `<span>` tokens with no `\n` characters in the DOM. `range.toString()` walks text nodes and would collapse a 7-line code block to a single wrapping line — fine for the per-line highlight on the page, but disastrous in the scratch pad which renders the captured text as prose. Inside a `<pre>`, this helper clones the range's contents into a hidden, off-screen `<pre>` and reads `innerText`, which respects rendered layout and inserts `\n` where the browser draws line breaks. Outside `<pre>`, it falls through to `range.toString()` for the fast path. Wired into `content/highlighter.js`'s `createHighlightFromRange` at storage-write time; structural extractions like `getOccurrenceIndex` keep using `range.toString()` because their `indexOf` matching needs both strings extracted the same way.

#### `lib/tagIndex.js` — `window.AdnotaTags`
Single source of truth for the optional tag layer on NOTE and HIGHLIGHT items. Consumed by the sticky note tag input, the quick-highlight popup tag input, and the Sites page filter chip row.

- `normalize(raw)` — trims, collapses interior whitespace, caps at 40 chars. Used everywhere a tag is read or written so "legos", "Legos ", and "  LEGOS  " never coexist in storage.
- `getAllTags()` — async; reads all storage, flattens `items[]`, returns `[{ tag, count }]` sorted by count desc then alphabetically. No caching (single read per tag-input focus; bounded by the 10 MB storage cap).
- `buildAutocompleteDropdown(inputEl, { onPick })` — attaches a dropdown under an input: prefix+substring match against existing tags, keyboard nav (Arrow↑/↓ to move, Tab/Enter to pick the top match — first item auto-highlights once the user starts typing, Shift+Tab escapes the field, Escape hides), mousedown-pick (so blur doesn't hide before the click lands). Dropdown is appended to `<body>` with `position: fixed !important` + max z-index so it escapes every parent stacking context and host-site CSS bleed. Styling lives in `lib/adnotaUI.css` under `.adnota-tag-suggest*`.

#### `lib/adnotaTokens.css` — design tokens
Single source of truth for HUD surface colors (`--adnota-hud-bg`, `--adnota-hud-bg-strong`, `--adnota-hud-border`, `--adnota-hud-text`), brand accent (`--adnota-accent`, `--adnota-brand-gradient`), and semantic tool colors (`--adnota-red`, `--adnota-amber`, `--adnota-blue`, `--adnota-green`, `--adnota-pink`). Loaded by both content_scripts and the popup/sites pages. All custom properties are namespaced `--adnota-*` because this file ships into every host page and would otherwise collide with host design systems. The popup and sites pages still keep their own un-prefixed `:root` blocks for surface/text/shadow tokens — pending consolidation on the next dashboard visual pass.

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

The tag-name scan walks **every** element of the matching tag — no element cap. The previous 200-element cap was a defensive guess that prevented matches on heavy SPAs (Claude.ai, ChatGPT, Notion) where the first 200 `<div>`s are page chrome (sidebar, header, conversation list) and the highlighted content sits hundreds of divs deeper. The quick filter uses `textContent` (no layout cost) and prioritizes elements containing the fingerprint's `prefix` or `suffix` substring — those anchored matches are far stronger than the single-word overlap fallback, so on long pages with thousands of partial matches the right block reliably enters the candidate pool. Layout-aware `innerText` only runs in `_textScore` on the trimmed pool.

Also exposes `generateCSSSelector(el)` as a shared utility (used by the resizer).

#### `content/eraser.js`
- Activated via popup tool card, dock button, or bare-key `e` (when dock is visible)
- Red outline hover preview tracks the cursor; Adnota's own UI elements are guarded and invisible to the eraser
- **Top-right badge cluster on the hover outline**: pinned where the user's eye already is. `W×H` dimension pill plus a soft-red `likely ad` pill that lights up whenever `getEffectiveAdSignals()` fires (same detection that drives silent domain-wide promotion). Both follow the cursor with the outline so the most actionable signals don't require a glance down at the HUD strip
- **HUD strip**: fixed bottom-center bar (draggable) that stays visible whenever the eraser is active. Layout: drag handle → A logo chip → info section → trash → undo. Info section updates live while hovering:
  - **Confidence score** with contextual label — "likely ad" (red, when ad signals detected), "strong anchor" (green, ≥70), "moderate" (amber, ≥40), "weak anchor" (red, <40)
  - **Ad signal badges** — colored pills (e.g., `ad-keyword`, `ad-tag`, `ad-network`, `ad-label`, `iframe`, `sponsored-link`) shown when detected. Detection scans `id`/`className` keywords, custom-element tag names (`<shreddit-comments-page-ad>`, `<shreddit-dynamic-ad-link>`, etc.) via a hyphen-segmented identifier pattern, ad-flavored attribute names (`ad-type`, `is-ad`, `is-promoted`, `data-ad-*`), `aria-label` text ("Advertisement: ..."), and one combined subtree pass for descendant iframes plus `rel="sponsored"` links
  - **Scroll nudge** — "▲ ⇧+Scroll up N× for better target" shown when `findBetterTarget()` identifies a higher parent with a stronger anchor score
  - **Help (?) button** — opens a tail-anchored popover above the HUD with the shortcut tips: click scope, Shift+Click for domain-wide, the "likely ad" auto-promotion behavior, scroll-to-traverse, and Escape. Click outside or click `?` again to dismiss
  - **Trash button** — deletes every erasure on the current page after a confirm (same action as the popup's "Erased" stat card)
  - **Undo button** — fires the shared `AdnotaUndo.undo()` stack
  - **Draggable** — grab handle + pointer capture drag; position resets on mode exit
- **Visual-root auto-bubble**: on hover, the outline automatically climbs past any parent wrapper whose bounding box matches the child (edges within 4px, size within 5%) so a single click hits the outermost visually-identical container. Stops the moment a parent meaningfully grows or would dominate ≥85% of the viewport, so page-level containers are never auto-selected. Small elements stay erasable — padding/margins break edge-match and keep inner targets distinct
- **Scroll-wheel DOM traversal**: while hovering, hold `Shift` and scroll up to walk to the parent element, `Shift+Scroll` down to walk back toward the auto-bubbled baseline — no minimum size filter (unlike resizer), so small elements like links and icons can be erased too. Plain scroll (no modifier) passes through to the page so a user can scroll-explore for an ad two screens away without exiting the tool. `Shift+Click` still means "domain-wide" — the click's modifier is read independently of any prior wheel events, and the silent ad-scope promotion already pushes most ad erasures domain-wide regardless
- Click to erase: fires a 3-stage animation sequence (ripples → bounding-box flash → dissolve) then hard-hides the element with `display: none !important`
- `Shift+Click` for domain-wide erasure (stored with `path: '*'`) — explicit user override, unchanged semantic. First-erase tutorial: a one-time toast (gated by `adnotaEraserDomainTutorialShown`) names the keystroke after the user's first plain-click erase against a non-ad target. Ads are skipped because the silent ad-scope promotion below already domain-scopes them; users who only ever erase ads never see the toast
- **Silent ad-scope promotion**: a plain click on a target with ad fingerprints (`getEffectiveAdSignals` non-empty — same detection the HUD "likely ad" label uses) is silently promoted to domain-wide storage, because nobody wants to re-erase the same ad on every article. No HUD chip, no messaging — it just works. Non-ad targets stay page-scoped. Page-level viewport-dominating containers are always treated as non-ad regardless of subtree iframes
- **Ad-slot selector widening**: paired with the ad-scope promotion above. When the erase target is an ad-shaped custom element (tag name matches `AdnotaUI.adIdentifierPattern` — `<shreddit-comments-page-ad>`, `<shreddit-dynamic-ad-link>`, `<shreddit-comment-tree-ad>`, etc.), the injected CSS rule is widened from the specific selector (e.g. `#t3_1qkzjbk` — Reddit re-emits a fresh post-id every page load) to `<specific>, <tagname>`, so the next impression in the same slot is hidden too without a second click. Lives in `AdnotaUI.maybeGeneralizeAdSelector` and is applied at both live-click (eraser) and restore time (restorer) so older entries widen on the next page load with no migration. Idempotent and a no-op for generic tags like `div`, so non-ad erasures stay tightly scoped
- Undo: shared `AdnotaUndo` stack + 3s toast button, both cancel mid-flight animations
- Show/Hide (`Alt+S`): erased elements are tracked in the shared `AdnotaErasedElements` Set (populated by both eraser clicks and restorer); `AdnotaVisibility` iterates this set to toggle inline `display:none` on each node
- Storage write is non-blocking (does not delay animation)
- **Ad-popup defense**: while eraser is active, `mousedown` / `pointerdown` / `auxclick` on any non-Adnota target are intercepted on `window`-capture and `preventDefault`-ed. Stops ads that hijack the earliest pointer event to call `window.open()` before our click handler fires. Right-click (`button === 2`) is left alone so Inspect still works. Every blocked interaction calls `AdnotaState.anchorFocus()` to re-anchor keyboard focus, since `preventDefault` on mousedown suppresses the browser's implicit focus transfer
- **Iframe pointer shield**: cross-origin iframes swallow wheel events (parent doc never sees them, so scroll-to-traverse fails and the browser chain-scrolls the page instead) and their internal clicks never reach our handlers. While eraser is active, `AdnotaUI.setIframeShield('eraser', true)` injects a scoped `<style id="adnota-iframe-shield-eraser">` setting `iframe { pointer-events: none !important }` on every iframe, routing wheel and click through to the iframe's container in the parent doc — which is usually the full ad wrapper the user actually means to erase. Removed on mode exit. The helper lives in `lib/adnotaUI.js` and is keyed per tool; the resizer uses the same mechanism (`'resizer'` key) so it can hover and resize iframe wrappers

#### `content/sticky.js` — `window.StickyEngine`
- Activated via popup tool card, dock button, or bare-key `s` (when dock is visible)
- Click anywhere on the page to drop a sticky note; mode auto-exits on placement so a stray click while writing the note doesn't drop a phantom sticky. Re-enter via bare-key `s` or the dock button to place another
- **Dark frosted-glass toolbar** (fixed, bottom-center, draggable) — matches marker/eraser HUD aesthetic
- **Toolbar layout**: drag handle → A logo chip → 5 sticky-note-shaped color swatches → trash → undo. Trash clears every sticky note on the current page after a confirm.
- **Five colors**: yellow, green, blue, pink, white — swatches are mini sticky note icons (folded corner shape) filled with the theme color. Active swatch gets a purple glow ring. Choice persists to `adnotaStickyColor` in storage.
- **Three-tier anchor cascade** (mirrors marker.js's resolveAnchorRect):
  - **Tier 1 — block-level FuzzyAnchor**: on click, finds the nearest block-level DOM element via `findAnchorTarget` and stores `anchor` + `anchorOffset {dx, dy}` against it. On restore, FuzzyAnchor tournament scoring re-resolves the element and the saved offset places the note relative to it. The note tracks the anchor element on every scroll/resize via the capture-phase listener below
  - **Tier 2 — container-scroll-anchor `fallback`**: at save time, `AdnotaUI.findScrollContainer` walks up to the nearest inner scrolling ancestor and stores its FuzzyAnchor + the click point's offset within its scrollable content (`containerOffsetX/Y`). When Tier 1 misses on a reload (the specific paragraph wrapper was re-rendered with a different selector — common on chatgpt.com / claude.ai chat turns), Tier 2 re-resolves the surrounding scroll container and places the note at the right spot in the conversation. Without Tier 2, Tier 1 misses fell straight through to a percentage of `documentElement.scrollHeight` — meaningless on app shells where the doc itself doesn't scroll, landing notes in dead whitespace at the page bottom
  - **Tier 3 — percentage placement** (`placement.xPct`, `placement.yScrollPct`): last-resort "never lose your work" fallback against `documentElement.scrollWidth/Height`. Lands somewhere reasonable on normal scrolling pages, somewhere arbitrary on app shells, but always somewhere visible
- **Fixed-position overlay** (`#adnota-sticky-overlay`): every container lives inside a single viewport-sized, `position: fixed; pointer-events: none` overlay appended to documentElement. Container coords are viewport-relative as a result. Same reasoning as `#adnota-marker-overlay`: appending notes directly to `<body>` with `position: absolute; top: <document-px>` extended `documentElement.scrollHeight` on every site that doesn't strictly clip. On long chatgpt.com conversations a sticky persisted with a doc-px top in the thousands inflated the body to that height on reload, pulling a body-level scrollbar into existence and creating swathes of empty whitespace. The fixed overlay keeps note bounds out of `scrollHeight` entirely
- **Scroll re-anchoring**: a single capture-phase `window.scroll` listener (rAF-throttled) re-runs `updatePosition()` for every active note on every scroll event. Without this, app-shell pages that lock `<body>` at `overflow: hidden` and scroll an internal container left notes glued to the screen. Capture phase is required because `scroll` doesn't bubble: a single window-level listener catches scrolls on every container without per-note registration. Mirrors the marker tool's `bindAnchorSync` triad.
- **Drag and Drop**: pointer-event drag on the header repositions notes freely. On drop, re-anchors to the element underneath the note's measured center (`elementsFromPoint` + `findAnchorTarget`) and refreshes the Tier 2 `fallback` against the new drop position so the note still tracks the inner scroll container even when the new Tier 1 anchor is null.
- Autosaves content on a 1.5s debounce
- **`scrollTo(uuid)`**: public method on `StickyEngine`. Queries `.adnota-sticky-container[data-uuid="${uuid}"]` and smooth-scrolls it into view. Returns `false` when the container isn't currently rendered (mid-restoration, post-SPA-teardown), feeding the scratch pad's GOTO miss-toast.
- Create undo: `Ctrl+Z` / `Cmd+Z` immediately after placing a note removes it from DOM and storage; also available via toolbar undo button
- Delete: synchronous storage commit + visual teardown + 3s undo toast that re-saves and re-renders. Matches marker/highlighter — refreshing the page during the undo window leaves the deletion stuck (the storage row is already gone), unlike the older deferred-commit pattern where a refresh would lose the delete entirely and resurrect the note on next load. Snapshot captures live textarea/tag/dimensions in case the autosave debounce hasn't fired
- `Alt+S` toggles note visibility via the shared `AdnotaVisibility` controller (see below)
- Smart Z-index elevation on focus
- **Tag row**: thin bar at the bottom of each note card (below the textarea, symmetric with the 28px header) holding a `#` glyph and a text input. Optional — leave it blank and the note stores no `tag` field. Focusing the input opens the `AdnotaTags` autocomplete dropdown; writes ride through the same `saveNote` merge path as the textarea and drag/resize persist, so the tag is never lost on reload

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
- **Eyedropper / current-color control**: sits to the left of the palette, separated by dividers on both sides to read as its own control rather than a sixth swatch. Background always mirrors the current paint color (theme or custom); icon uses `mix-blend-mode: difference` so it stays readable on any fill. Clicking opens the native `EyeDropper` API (Chrome 95+) to pick any pixel color from the page. Works across all drawing tools (pen, shapes, text, highlight). Ideal for background-matching a solid shape to cover an ad cleanly on any site (light, dark, off-white, gradient). Custom-color highlights route through the fallback overlay renderer (opaque cover, no blend mode) since the CSS Custom Highlights API requires pre-registered theme names.
- **Three stroke width presets**: thin (2px), medium (4px), thick (8px) — shown as graduated dots; also controls text font size (16px, 24px, 36px)
- **Fill group** (outline / solid radio pair): placed right after the shape tool buttons so the option surfaces next to the tool that triggered it. Visible only when Rectangle or Circle is the active tool (the buttons and their trailing divider hide together, leaving no empty gap). Outline variant carries a red diagonal slash to disambiguate it from the rectangle tool icon. Exactly one is active at any time; clicking either sets `AdnotaState.filled` (persisted as `adnotaShapeFilled`). Payload stores `filled: bool` on `MARKER` items with `shapeType: 'rect' | 'ellipse'`. Solid shapes are the primary redaction mechanism for non-text content (ads, images, iframes) that can't be erased without breaking layout.
- **Undo button**: triggers `AdnotaUndo.undo()` directly from the toolbar
- **Draggable**: pointer-capture drag via handle (same pattern as eraser HUD); position resets when toolbar hides
- **Highlight mode**: text selection applies color via the **CSS Custom Highlights API** (`CSS.highlights`, Chrome 105+) — zero DOM mutation, React/Vue safe
- **Fallback**: for Shadow DOM / cross-boundary ranges, falls back to absolutely-positioned overlay divs with `mix-blend-mode: multiply`
- **Five colors**: yellow, green, blue, pink, and **black (redaction)**
  - Pastel colors are semi-transparent (`rgba(..., 0.4)`) via `::highlight` CSS rules
  - **Black uses `color: #000; background-color: #000`** — fully opaque, text invisible underneath. Fallback path uses normal blend mode (not multiply) so the cover is solid
- Persists last-chosen color and stroke width to storage across sessions
- Undo: removes range from CSS Highlights registry and deletes from storage
- Schema stores: `text`, `occurrenceIndex`, `color`, `isFallback`, `fallbackRects`, `attachedNoteId` (reserved for future note cross-linking), optional `tag`
- **`scrollTo(id)`**: public method on `AdnotaHighlighter`. Resolves the live entry from the `liveHighlights` registry, picks the right scroll target (the fallback wrapper when present, otherwise the parent element of the range's start node — `scrollIntoView` walks up to find the right scroll container, which matters on app shells like claude.ai where the document itself doesn't scroll). Returns `false` when the entry is missing or its underlying range/wrapper has gone stale, so the scratch pad's GOTO button can surface a "couldn't locate" toast.
- **Hover affordances**: every live highlight is tracked in a module-level `liveHighlights` Map keyed by `_id` (`{ tag, color, text, range?, fallbackEl? }`). An rAF-throttled `mousemove` handler hit-tests via `range.getClientRects()` (CSS path) or the fallback wrapper's children, then paints two layers — both rendered ourselves because CSS Custom Highlights and `pointer-events: none` overlays can't receive a `title` or DOM listener:
  - **`#tag` chip** tracks the cursor when the highlight has a tag (viewport-clamped, hides on scroll/resize)
  - **Delete ✕** — clickable red circle (reuses `.adnota-select-delete` styling from the Select tool, position-overridden to `fixed`) anchored to the first-rect top-right. Click runs `AdnotaHighlighter.deleteHighlight(id)`: tears down the visual (CSS registry entry or fallback wrapper), drops the storage row, pushes a `AdnotaUndo` entry and shows a 3s `Highlight deleted` toast. The toast Undo and Ctrl+Z share the same `undoEntry` (consumed-flag guard prevents double-restore); restore re-saves the original payload and re-renders via `renderFallback` / `applyStoredHighlight`
- **Self-healing registry**: stale entries drop from the Map on the next hit-test — CSS-path entries when `highlightRegistries[color].has(range)` returns false (after `_rebuildLiveHighlights()` clears the registry on bulk trash), fallback entries when `fallbackEl.isConnected` goes false. So bulk deletions don't need to know about the Map

#### `content/resizer.js` — Element Resizer
- Activated via popup tool card, dock button, or bare-key `r` (when dock is visible)
- **Smart element targeting** (two-stage, order matters): (1) climb to the nearest layout-significant block-level ancestor (≥120×60px, non-inline) — escapes tiny hovers like a menu link before any bubbling happens; (2) *then* use the shared `AdnotaUI.bubbleToVisualRoot` helper, seeded from that ancestor, to promote past visually-identical outer wrappers. This ordering is important: the eraser bubbles from the raw hover because any size element is a legitimate erase target, but the resizer almost always wants a meaningful block, so seeding the IoU comparison from a real layout element (not a 220×36 link) lets it correctly reach a 220×356 `nav` two hops above
- **Hover chip cluster** (top-right of the hover overlay): a flex row holding the read-only blue `W×H` dimension pill and an optional **action chip**. The dimension pill is the same shape used in the selection state so the readout stays where the user is looking; the HUD info area carries only the action hint
- **Unstick / restick** (the action chip): when the hovered element has computed `position: sticky` or `position: fixed`, an amber `unstick` pill appears to the left of the dimension pill — click it to inject `position: static !important` for that selector and stop the element following the user as they scroll. After the override is applied, the chip flips to `restick` on next hover; clicking removes only the unstick entry (any width/height resize on the same selector is preserved). The same chip is also surfaced on the **selection state** (after click-to-select), so a hard-to-hover sticky bar can be pinned with a click and the chip then reached without losing hover. Stored as a regular `RESIZE` storage row with one extra discriminator field `kind: 'unstick'` so the chip can find its own entry on the inverse path. Single label `unstick` for both `sticky` and `fixed` — same user intent ("stop following me"), same override; CSS distinction is not user-facing. The shared cssText constant `UNSTICK_CSS_TEXT` (in `content/resizer.js`) is the only place the override string is defined. The blue ↺ reset still wipes everything for the selector (including any unstick); the popup's "Resized" stat-card trash and the resizer HUD trash do the same. Domain-wide by default (`path: '*'`) — sticky chrome recurs across a site
- **`isLayoutSignificant` overrides for sticky/fixed**: the 120×60 minimum-size floor is bypassed for elements with computed `position: sticky` or `position: fixed`. Without this, short sticky bars (GitHub nav ~52px, HN header ~30px, news-site banners ~48px) failed the height threshold and `findLayoutTarget` silently climbed past them — no overlay drew, no chip surfaced. Sticky/fixed elements are inherently structural chrome, so any non-zero size qualifies
- **Max-int z-index + DOM-order tie-break**: the hover overlay, selection box, handles, dismiss button, dim badge, and chip clusters all sit at `z-index: 2147483647` (max int32). Modern ad/banner chrome (cookie banners, sticky promos, chat widgets) routinely uses the same value, so the resizer also re-appends the hover overlay to `documentElement` on every show (`updateHoverTarget`) so DOM order breaks the tie in our favor. Without this, fixed-position page chrome with the same z-index that loaded later in the document silently occluded the resizer's blue overlay and chip cluster, leaving sticky elements visually un-targetable even when the resizer correctly identified them
- **Scroll-wheel DOM traversal**: while hovering, hold `Shift` and scroll up to walk to the next layout-significant parent (Step 3a in `findLayoutTarget`), `Shift+Scroll` down to walk back toward children — past the auto-bubbled baseline if needed (un-bubble through the visual-root and layout-significant climbs, Step 3b), then one more step into a single iframe descendant when one exists in the subtree. The iframe shield masks iframes from `elementFromPoint`, so this descent is the only way to ever target an iframe element directly. Both directions clamp at the actual chain ends — `traverseDepth` only commits when the new depth changes the target, so over-scrolling past the top or bottom doesn't inflate the value and reversing direction is immediate. Plain scroll (no modifier) passes through to the page so a user can scroll-explore the document while in resizer mode without exiting the tool
- **Iframe pointer shield**: same mechanism as the eraser (see above). `AdnotaUI.setIframeShield('resizer', true)` is installed on mode entry so cross-origin iframes don't swallow hover/click and the resizer can outline the iframe's parent wrapper
- **HUD strip**: fixed bottom-center bar (draggable) that stays visible whenever the resizer is active. Layout: drag handle → A logo chip (blue) → info section → trash → undo. Matches the eraser HUD aesthetic, tinted with the resizer's blue accent. Info section updates live:
  - **Idle** — short static label ("Hover an element to resize"); the full tip list lives behind a `?` popover (click to select, scroll to traverse, drag handles, hover a sticky bar to unstick, ↺ to reset, Esc to exit)
  - **Hovering** — scroll-to-walk hint (dimensions live on the hover overlay's chip, not in the HUD)
  - **Selected** — `Selected · Drag a handle to resize · ↺ to reset` (dimensions live on the selection box's chip next to the reset button, live-updated during drag)
  - **Trash button** — deletes every resize on the current page (same code path as the popup's Resized stat card)
  - **Undo button** — fires the shared `AdnotaUndo.undo()` stack
- Click to select: dashed blue outline with **6 interactive controls** appears. Every handle pins its opposite edge via a resolved-pixel margin written to both the live drag and the persisted CSS rule, so growth/shrinkage is always directional (and the move-via-resize trick — drag left out, drag right in — relocates an element without changing its size):
  - **Left handle** — drag to resize width from the left edge; right edge pinned via `margin-left` compensation
  - **Right handle** — drag to resize width from the right edge; left edge pinned by writing `margin-left: ${startMarginLeft}px`
  - **Top handle** — drag to resize height from the top edge; bottom edge pinned via `margin-top` compensation
  - **Bottom handle** — drag to resize height from the bottom edge; top edge pinned by writing `margin-top: ${startMarginTop}px`
  - **Corner handle** — drag to resize both width and height simultaneously; pins top and left edges
  - **Blue reset button** (top-right, circular reset arrow icon) — resets ALL resize overrides for this element, removing injected CSS from both the `<style>` tag and storage. Deliberately blue (not a red ✕) so it doesn't collide semantically with the marker select tool's red ✕ delete affordance
  - **Tradeoff:** baking the resolved-pixel margin into the persisted rule means an element that was originally `margin: 0 auto` no longer re-centers on viewport resize. Deliberate — without the pin, an auto-centered element re-centers on every release and the move-via-resize trick is impossible. Reset (↺) restores the page's original auto-centering behavior
- **Cursor lock**: while resizer mode is active, the central `AdnotaCursor.set` stylesheet forces a stable `default` arrow on every non-Adnota element with `!important`, so hovering links or buttons can't flip the cursor to `pointer`. Handles keep their own inline `ew-resize` / `ns-resize` / `nwse-resize` cursors via higher specificity on the handle elements
- All resizes persist as CSS rules in a `<style id="adnota-style-overrides">` tag — survives React/Vue re-renders. The tag's contents are driven by a `window.AdnotaResizeRules` Map (keyed by storage `_id`, valued `{ selector, cssText }`), with `window.rebuildResizeStyleTag()` rewriting the tag from the Map after every mutation. Mirrors the eraser's `AdnotaEraseRules` pattern — every path (drag persist, Ctrl+Z, trash button, blue ↺ reset, restorer) goes through the same map + rebuild so there's no string surgery on the tag's `textContent` and no way for a zombie rule to survive undo/delete
- **Domain-wide by default**: every resize is stored with `path: '*'` so it applies to every page of the domain. Unlike the eraser (which scopes to the current page unless Shift+Click or ad-fingerprint detection promotes it), resize targets are almost always structural containers (nav, sidebar, header, article wrapper) that recur across a site with the same selector — scoping per-page would force the user to redo the same resize on every sibling page. If a structural-`nth-child` selector ever matches something unintended on another page the rule silently no-ops, and the blue ↺ reset on that page wipes it
- CSS selector generation uses the shared `FuzzyAnchor.generateCSSSelector()` utility
- CSS rule format: `width: Xpx !important; min-width: 0 !important; max-width: none !important; margin-left: Ypx !important` for any width-changing handle (left or right) and `height: Xpx !important; min-height: 0 !important; max-height: none !important; margin-top: Ypx !important` for any height-changing handle (top or bottom). The `min-*: 0` pair is symmetric with `max-*: none` and unsets the page's own min-width/min-height so the user can shrink an element to 0 if they want — without it, a `min-width: 240px` set by the page silently caps any sub-240 width override. The margin pin is always written so the opposite edge stays put on subsequent reflows; left/top handles compute the pin via delta math (`startMarginLeft - widthDelta`), right/bottom handles use the resolved start value as-is. The drag math floors at `Math.max(0, ...)` (no minimum) — shrinking to 0 is a legitimate alternative to erase for elements where `display: none` would break the surrounding flex/grid layout. Recovery is via Ctrl+Z, the still-visible blue ↺ reset on the selection box (handles stay reachable around a 0×0 element), or the popup's "Resized" stat-card trash
- Handles are viewport-clamped so they remain visible even on elements taller/wider than the screen
- Handles reposition on scroll
- Undo via shared `AdnotaUndo` stack + 3s toast button
- Storage action type: `RESIZE`

#### `content/marker.js` — `window.AdnotaMarker`
- Full drawing engine powering pencil, arrow, rectangle, ellipse, text, and select tools
- Transparent SVG canvas overlay captures pointer events across the full page while active
- Toolbar-area clicks are explicitly guarded (both by DOM check and bounding box) to prevent strokes firing through the toolbar
- **Scroll passthrough while idle**: entering a draw tool shouldn't lock the user out of scrolling the page. Plain wheel events are forwarded to the topmost non-Adnota scrollable ancestor under the cursor — `elementsFromPoint` skips Adnota chrome, the loop walks up looking for `overflow: auto/scroll` AND a content overflow, then `scrollBy`s. Required because `#adnota-capture-canvas` is full-viewport and pointer-events:auto, so on app shells with `overflow: hidden` body the browser's native scroll-chain dies on the canvas with nothing scrollable above it. CSS-side, `touch-action: pan-x pan-y` (was `none`) lets trackpad scroll work natively on documents that do scroll. Mid-stroke (`capturePath`/`captureShape`/`moveDragState` set) wheel is blocked instead — letting scroll through mid-gesture would produce cross-viewport shapes and disconnected pen lines
- **Pencil tool**: freehand drawing with **Ramer-Douglas-Peucker** path simplification (ε = 2.0) to reduce point density before storage
- **Arrow tool**: click-drag creates a straight line with SVG `<marker>` arrowhead; minimum distance threshold prevents accidental tiny arrows
- **Rectangle tool**: click-drag creates a `<rect>` with rounded corners; handles any drag direction (origin can be any corner). Honors the toolbar Fill toggle — outlined by default, solid fill when enabled
- **Ellipse tool**: click-drag creates an `<ellipse>`; center is midpoint of drag, radii from extent. Honors the toolbar Fill toggle (outline or solid fill)
- **Text tool**: click to place a `contentEditable` text box; Enter commits, Shift+Enter for newline, Escape cancels; font size derived from stroke width preset (thin=16px, medium=24px, thick=8=36px); rendered as HTML (not SVG `<text>`) for natural multi-line editing; double-click to re-edit existing text
- **Select tool**: click near any marker/shape/text to select it (proper SVG `getBBox()` hit testing picks the smallest overlapping shape); dashed purple selection box with red ✕ delete button; Delete/Backspace key support. Deletes flow through the shared `deleteSelectedMarker()` — see Hover affordances below. Body cursor switches to a white SVG arrow while select mode is active (distinct from the system default so the "tool is on" state is unambiguous); hovering any `.adnota-marker-wrapper` upgrades to `grab` via a `html.adnota-select-mode` class toggle. **Drag-to-move**: pointerdown on a marker, travel past a 3px threshold, and all shape types (rect/ellipse/arrow/freehand/text) reposition live via CSS transform; on pointerup the delta is converted to a percentage of the anchor rect, applied to the payload's coord fields (`shape`, `textPos`, or `drawing[]`), re-rendered, persisted (delete-then-save by uuid), and pushed onto `AdnotaUndo`. A click below the drag threshold falls through to normal selection; a `suppressNextClick` flag swallows the synthetic click that follows a committed drag.
- **Stroke width**: all tools read `AdnotaState.strokeWidth` (2, 4, or 8) for line thickness; persisted per stroke in storage
- **Unified persistence**: all shapes stored as `MARKER` action with a `shapeType` field (`freehand`, `arrow`, `rect`, `ellipse`, `text`) — same anchor/restore pipeline via `renderMarker()`. Rect/ellipse payloads also carry `filled: bool`; solid payloads render with `fill=color, stroke=none`
- Rendered markers re-anchor to their block element via `ResizeObserver` + scroll listener — no drift on long pages
- **Fixed-position overlay**: every marker wrapper lives inside a single `#adnota-marker-overlay` (`position: fixed`, viewport-sized, `pointer-events: none`) instead of being appended directly to `<html>`. Wrapper coords are viewport-relative as a result. The whole point is to keep wrapper bounds out of `documentElement.scrollHeight` — without this, a shape placed near a page edge inflates the document and triggers a body-level scrollbar on `overflow:hidden` app shells (claude.ai, Notion, etc.). Same trick `#adnota-capture-canvas` and `.adnota-select-box` already use
- **Five colors**: same palette as highlighter (yellow, green, blue, pink, black)
- A tap with fewer than 3 points (pencil) or too-small drag (shapes) cancels the action
- **Hover affordances**: an rAF-throttled `mousemove` handler runs `hitTestMarker(x, y)` and paints a single floating ✕ at the wrapper's `getShapeBBox` top-right (reuses `.adnota-select-delete` styling, position-overridden to `fixed` inline so no new CSS rule). Click runs the shared `deleteSelectedMarker(wrapper)` — same path as the Select-tool ✕ and Backspace — which uses the consumed-flag pattern: pushes a `AdnotaUndo` entry, shows a 3s `Marker deleted` toast, and the toast Undo + Ctrl+Z share the same `undoEntry` (idempotent). Suppressed when paint is hidden, mid-stroke (`capturePath || captureShape`), and when the hovered wrapper is already `selectedWrapper` (avoids the stacked-ring artifact with the Select-tool's own ✕, which is the only real overlap case — works uniformly across all paint modes including Select itself). Stand-down also fires for any non-marker `[data-adnota-ui]` target — but `captureSvg` and marker wrappers themselves are explicitly carved out of that check, so the ✕ works in pen / arrow / rect / ellipse modes too (where the captureSvg owns the pointer and wrappers are `pointer-events: none`). Belt-and-suspenders hides on Shift `keydown` and document `pointerdown` (with a carve-out for the ✕ itself) close the gap where neither event emits a `mousemove`, so a stranded ✕ can't linger through a drag

#### `content/quickHighlight.js`
- Medium-style contextual popup that appears above any non-empty text selection after a ~400 ms dwell — independent of the Draw HUD's highlight mode
- **Two-row layout**. Row 1: Adnota "A" brand chip (visually distinct from the host site's own toolbar) → five color swatches → session-dismiss `✕`. Row 2: an optional tag input (`#` glyph + text field). Clicking a swatch reads the current tag value and forwards it to `AdnotaHighlighter.createHighlightFromRange(range, color, tag)` so the created HIGHLIGHT carries the tag; leaving the input blank preserves the original one-tap flow
- Each new selection re-prompts — colors and tag are not "sticky" between highlights; the user picks per-action. The tag input clears on every `hidePopup`
- **Selection preservation**: clicking into the tag input collapses the browser's live text selection. To work around this, the popup caches a clone of the selection range at show-time; `applyHighlight()` prefers the live selection but falls back to the cached range. The `selectionchange` hide is also suppressed while the tag input has focus
- Tag autocomplete is wired via `AdnotaTags.buildAutocompleteDropdown`. The dropdown lives outside the popup (appended to `<body>` with `position: fixed`), so the outside-click hide-handler has an explicit bypass for `.adnota-tag-suggest`
- Dismisses on: selection collapse (except during tag-input focus), `Escape`, scroll, resize, click-away, or `Ctrl/Cmd+C` (copy is never intercepted — the popup just gets out of the way)
- Skips editable contexts (`input`, `textarea`, `contenteditable`) and any selection inside an Adnota UI element
- Suppressed while `AdnotaState.mode === 'highlight'` so it doesn't double up with the classic auto-apply mouseup. The Draw-HUD highlight auto-apply path itself does **not** read a tag — it stays a zero-UI fast path. Tagging a highlight created that way is deferred to v2 (Select-tool integration or Home-page retrofit)
- Reuses `AdnotaHighlighter.createHighlightFromRange()` — no duplicate save/undo logic
- Feature-gated by `chrome.storage.local.adnotaQuickHighlightEnabled` (default `true`); a future toggle UI can flip this without touching the content script

#### `content/restorer.js`
- Runs at `document_idle` and on `DOMContentLoaded`
- **MutationObserver** with a 1s trailing debounce + 2.5s max-wait clamp watches for SPA/lazy-loaded content and re-runs restoration — handles React, Vue, and infinite-scroll sites. The clamp prevents continuously-mutating apps from deferring restoration indefinitely (each new mutation would otherwise reset the debounce); after 2.5s of sustained mutation we force a pass instead of waiting for the burst to settle
- Dispatches to the correct engine by `action` type:
  - `RESIZE` → `AdnotaResizeRules.set(id, { selector, cssText })` + `rebuildResizeStyleTag()` — **bypasses FuzzyAnchor entirely** since the CSS selector is self-contained. Idempotent: re-processing an item already in the Map is a no-op (prevents the duplicate-rule class of bug where undo/delete would leave a stale copy behind)
  - `ERASE` → injects a CSS rule into the shared `<style id="adnota-erase-overrides">` tag via `AdnotaEraseRules.set(id, selector)` + `rebuildEraseStyleTag()`, so the element stays hidden even if the host page re-creates it (ad rotation, React re-mount). Selector is run through `AdnotaUI.maybeGeneralizeAdSelector` first so ad-shaped custom-element tags (`<shreddit-comments-page-ad>` etc.) widen to `<specific>, <tagname>` and the next impression in the same slot is auto-hidden without re-erasing. As a sidecar, FuzzyAnchor is consulted to resolve the original element — if found, also tagged with inline `display:none` and added to `AdnotaErasedElements` so `Alt+S` show/hide can toggle it
  - `NOTE` → `StickyEngine.renderNote()` with stored `anchor`, `anchorOffset`, `fallback`, `placement`, `theme`, and `dimensions` — runs the 3-tier cascade (Tier 1 FuzzyAnchor on the original block → Tier 2 FuzzyAnchor on the saved scroll-container ancestor + offset → Tier 3 percentage of `scrollWidth/Height`). The note always renders somewhere, but `processedItems` only locks in when Tier 1 succeeds; Tier 2/3 renders leave the item retryable so the next MutationObserver pass can snap up to Tier 1 once the host page finishes hydrating. Legacy placement-only notes (no anchor data) mark processed immediately. Same applied-vs-found split the HIGHLIGHT path uses
  - `HIGHLIGHT` → `AdnotaHighlighter.applyStoredHighlight()`
  - `MARKER` → `AdnotaMarker.renderMarker()` with a 3-tier fallback cascade so drawings always render somewhere even when the page has shifted: (1) FuzzyAnchor on the original block; (2) the saved `fallbackBox.containerAnchor` (the nearest scrolling ancestor at save time) plus stored offset within it — scrolls with content on app shells where the page itself doesn't scroll; (3) absolute doc-pixel coords (`fallbackBox.docLeft/docTop/docWidth/docHeight`) as the last resort. New markers always carry `fallbackBox`; legacy items without it skip directly to "broken anchor" if FuzzyAnchor misses. **Tier upgrade**: tier 2/3 renders are tracked in `pendingMarkerUpgrade` rather than `processedItems`, so later mutation passes keep retrying tier 1. When tier 1 finally resolves (the host page has finished React-rendering its conversation tree, etc.), the existing wrapper is torn down via `AdnotaMarker.tearDownById(uuid)` and re-rendered against the real anchor — fixes the prior bug where a marker on claude.ai/chatgpt.com would render at tier 3 (doc pixels) on first pass and stay glued to the viewport because the doc never scrolls. The pending-upgrade branch is silent in steady state (no `brokenThisPass++`, no `apply-fail`/`fallback-used` log spam every 2.5s) — fallback render is visually fine, we're just hoping for an upgrade. A `restorer:marker-upgrade` log fires when one happens
- Deduplicates with a `processedItems` Set so MutationObserver re-runs don't re-render already-applied annotations. The Set is cleared whenever `location.href` changes between passes so an SPA in-app nav (`/foo → /bar → /foo`) gets a fresh restoration on the return visit instead of silently skipping every item; the existing MutationObserver fires on the SPA-nav DOM swap, so no popstate/pushState hook is needed
- **SPA URL-change teardown**: every Adnota overlay (marker shapes in `#adnota-marker-overlay`, sticky containers, highlight CSS Custom Highlights + fallback wrappers, ERASE/RESIZE `<style>` tag rules) lives outside the host page's React/Vue tree under `data-adnota-ui`. On a full-page reload (wikipedia) the document is replaced and everything goes with it; on app shells like claude.ai, React only swaps its own subtree, so without an explicit teardown the previous URL's annotations bleed into the next URL. When `lastProcessedUrl !== location.href` the restorer calls `AdnotaMarker.tearDownAll()`, `AdnotaHighlighter.tearDownAll()`, `StickyEngine.tearDownAll()` (sequential `await` to flush each note's pending textarea/tag input to the path it belongs to before removing — the autosave debounce captures `location.pathname` at firing time, so a delayed save after nav would otherwise corrupt the new path's items), then clears the `AdnotaEraseRules`/`AdnotaResizeRules` Maps + `AdnotaErasedElements` Set and rebuilds the style tags from scratch. Storage is untouched throughout — the next restoration pass repaints whatever belongs to the new URL
- **In-flight guard**: rapid SPA nav can fire the MutationObserver while a previous `performRestoration` call is still mid-`await`. A `restorationInFlight` flag drops re-entrant calls so two passes can't both run teardown and race each other's renders
- **Steady-state write guard**: the per-URL stat write (and its `chrome.storage.onChanged` fan-out to popup + Sites page) only fires when something actually changed this pass — either a new item was processed (`processedItems.size` grew) or anchors are still broken. On heavy SPAs the observer keeps waking us every ~2.5s for the life of the tab; without the gate every wake-up wrote zeros and pinged every other extension surface for nothing
- **Navigation API zero-latency hide**: relying on the `MutationObserver` alone meant the previous route's marker overlay and sticky containers visibly lingered over the new page until the 1s debounce settled and teardown ran. A `window.navigation.addEventListener('navigate', ...)` listener (Chromium 102+, feature-detected so Firefox/Safari fall through to the existing observer path) sets `html.adnota-route-changing` synchronously the instant an SPA `pushState`/`replaceState` fires; CSS in `lib/adnotaUI.css` hides only the three annotation containers (`#adnota-marker-overlay`, `.adnota-highlight-fallback`, `.adnota-sticky-container`) so the dock and other `data-adnota-ui` HUD chrome don't flicker on every in-app nav. `_performRestoration` clears the class at the end of the next pass, and a 3s backstop `setTimeout` (just past the `MutationObserver` 2.5s max-wait clamp) covers the pathological case where an SPA pushes state without any DOM mutation, so annotations can't get permanently stuck hidden

---

### UI

#### `popup/index.html` + `popup/popup.js` + `popup/style.css`
Premium dark-header popup (360px wide). Features:
- **Tool cards** for Eraser, Sticky Note, Draw, and Resizer — each with icon chip, lowercase shortcut badge (`e`/`s`/`d`/`r`), and active-state indicator (colored border + pulsing dot) that syncs in real time via `storage.onChanged` (catches keyboard shortcuts fired while popup is open). The Draw card opens a HUD with seven sub-tools (Highlight, Pen, Arrow, Rectangle, Circle, Text, Select) — text highlighting also has a separate auto-popup path on text selection (`content/quickHighlight.js`), so the Draw HUD is primarily a freeform drawing surface
- **Bare-key listener** in `popup.js`: pressing `e/r/s/d` while the popup is focused fires the same toggle the corresponding card click does, then closes the popup. Mirrors the dock's bare-key handler so users who see the badges in popup get the expected behavior even when the dock is dismissed (the dock-visible gate doesn't apply here — the popup itself is the modal indicator, and tool activation auto-restores the dock)
- **Per-page stats** (Erased / Notes / Highlights / Resized / Strokes) — each stat card cross-fades to a trash icon on hover; clicking clears that category from the current page
- **Show/Hide Changes button** (`Alt+S`) in the header — eye icon with a diagonal slash overlay when annotations are hidden. Reads live state via `get-view` message to the content script on open; optimistically toggles on click for instant UI response
- **My Edited Sites** button in footer (purple outline) — opens the Sites history page
- **Clear All Page Edits** button in footer (red outline)

#### `content/dock.js` + `content/dock.css` — The Adnota Dock
One persistent floating widget (fixed, bottom-center, draggable) that is the only Adnota chrome on the page. Two visual states, toggled by which tool (if any) is active:
- **Idle**: a single favicon-style A mark — rounded-square with the same purple→magenta gradient as `icons/favicon.svg`, so the on-page chrome reads as the same brand as the extension bar icon. Hovering blooms the row open rightward to `[A][eraser][sticky][marker][resizer][scratch][vis]` while the A morphs to the translucent circle treatment in a parallel 300ms transition (`border-radius` + background + color all shift together so the shape change reads as one intentional move). The collapsed footprint cedes real estate back to the host page when the user isn't reaching for the dock; the row expands via a `max-width` transition on `.adnota-dock-tools` (same overflow-x:clip pattern the body slot uses on tool mount, with a `pointerenter`-driven 180ms timer that lifts the clip after the slide so tooltips on the leftmost/rightmost buttons can render past the row's edges). Sits at `opacity: 0.55` while collapsed, `1` while expanded. `cursor: grab` on the dock itself signals it can be moved — the whole dock has been draggable from anywhere since day one, so the previous `⡇` handle glyph was decorative and was dropped when the idle state collapsed to the logo. The scratch button is a non-tool utility (no mode), greyed to 30% opacity when the page has no HIGHLIGHT or NOTE items so it never teases when there's nothing to recall.
- **Active**: `[drag][← back (tinted)][tool's HUD body]` — tool row collapses, A morphs into an accent-colored back arrow, the tool's own controls fill the body slot.
- **Back arrow / Escape / clicking the active tool again** all exit the tool and return to idle. The first time the user activates any tool across the whole profile, a one-time educational toast (gated by `adnotaToolEscTutorialShown`) surfaces "Tip: press Esc to exit any tool" — the back-arrow tooltip names the same shortcut but tooltips need a hover, and a user mid-task isn't reading chrome.
- **A logo** opens the Sites history page in a new tab.
- **Dismiss X** (red circle, reuses `.adnota-select-delete` styling) fades in on hover when idle — click to hide the dock on the current domain. **Per-domain persisted** as a symmetric toggle: the X writes the hostname to `chrome.storage.local.adnotaHiddenDomains`, and any of `Alt+A`, opening the popup, or activating a tool from the popup removes it. Whatever the user last did on a domain is what sticks. The first time across the whole profile that the X is clicked, a one-time educational toast (gated by `adnotaDockDismissTutorialShown`) names the recovery paths; subsequent dismisses are silent so the extension doesn't argue with the user's "go away" gesture. A `chrome.storage.onChanged` listener keeps multiple tabs of the same domain in sync within ~1 frame. Bare-key shortcuts (`e/r/s/d/f`) deliberately do *not* restore — the dock-visible gate stays meaningful.
- **Drag anywhere** on the dock to reposition. 4px threshold distinguishes drag from click; saved position persists to `chrome.storage.local.adnotaDockPosition` and survives reloads.
- **Default-load bloom-from-center**: a never-positioned dock sits at `left:50%; transform:translateX(-50%)` so the very first hover-expand blooms symmetrically around the cursor (the natural place a user's mouse ends up on a centered widget). The first drag commits to absolute `left:Xpx + transform:none` via `commitPositionIfCentered`, after which the dock grows rightward on hover-expand and tool-mount regardless of where it's parked. One predictable behavior beats three position-dependent ones — a parked-at-right-edge dock that overflows is self-correcting because the user just re-drags.
- **Position flash prevention**: `visibility: hidden` until JS has read the saved position and added `.adnota-dock-ready`, so a repositioned dock never blinks at the default center on page load.
- **Print hide**: `@media print { #adnota-dock { display: none !important; } }` — Ctrl+P never includes the dock.
- **Per-tool accent** (`data-accent` attribute set on mount): back arrow + dock border both pick up the active tool's color (red / amber / purple / blue).
- **Public API**: tools mount their body via `AdnotaDock.mount(toolId, buildBodyFn)` on mode entry and `AdnotaDock.unmount(toolId)` on exit. The `toolId` on unmount guards against cross-tool races where the outgoing tool's subscriber would clear the body the incoming tool just installed.
- All elements marked `data-adnota-ui` so eraser/resizer ignore them.

#### `content/scratchPad.js` + `content/scratchPad.css` — Page Snippets (the scratch pad)
Per-page floating panel that lists every HIGHLIGHT and sticky-note body for the current URL. Designed as the **TEXT-IS-KING** counter to the Sites/Snippets feed — austere on purpose: no per-item color border, no source chip, no card chrome, no visual difference between a highlight and a note. Just the text, an optional muted `#tag`, and a hover-revealed copy button. The use case is in-page recall during long-text reading (ChatGPT/Claude conversations, longform articles) where scrolling back to the original is the friction the user is trying to escape.
- **Header**: filter pills (`All` / `Highlights` / `Notes`, the active one rendered in `var(--adnota-accent)` purple with a thin underline + inline count), `Copy all`, `✕`. The whole header is the drag handle (excluding the buttons themselves). Filter selection persists globally to `chrome.storage.local.adnotaScratchFilter` (one preference for the user, not per-host).
- **Body**: snippets stacked newest-first with hairline `rgba(255,255,255,0.08)` dividers between them. Inter, 14px, line-height 1.5, `white-space: pre-wrap` so multi-paragraph highlights keep their breaks. Black-redaction highlights (`color === 'adnota-theme-black'`) render as a `█` bar with the same length-clamping formula as the Sites feed (6–48 glyphs) instead of leaking the hidden text. Sticky notes with empty bodies are silently skipped.
- **Per-snippet copy**: `:hover` on a row reveals a single floating glyph in the top-right corner — no card around it. Click → ✓ flash, 1.4s revert. **Copy all** in the header writes every visible (post-filter) snippet, joined by `\n\n`.
- **Per-snippet GOTO**: `:hover` also reveals a crosshair button to the left of the copy button. Click → smooth-scrolls the source highlight or sticky note into view (`block: 'center'`, `behavior: 'smooth'`). Routes by snippet type to `AdnotaHighlighter.scrollTo(id)` or `StickyEngine.scrollTo(uuid)`. If the engine returns `false` (annotation isn't currently rendered — broken anchor, mid-restoration, or torn down by an SPA URL change), an inline toast `Couldn't locate this on the page.` surfaces inside the panel for 2s instead of leaving the user wondering why nothing happened.
- **Selection guard**: the panel never auto-closes on outside click (would interfere with copy/paste flow), and `pointerdown` on the header skips the drag handler when `getSelection().isCollapsed === false` and the selection is inside the panel — so a drag-select that ends on the header doesn't hijack into a panel drag.
- **Idle transparency**: the whole panel fades to `opacity: 0.6` after 600ms with no cursor over it; `mouseenter` snaps back to 1.0. The panel becomes ambient when you're reading the page, full-clarity when you reach for it. Header stays at parent opacity.
- **Drag + resize + persistence**: pointer-drag from the header repositions; native `resize: both` on the panel handles size. Position and size are persisted **per-hostname** under `adnotaScratchPosition` and `adnotaScratchSize` (each is a `{ host: {...} }` map) so the user's mental model of "the pad lives here on this site" survives reloads. Initial defaults: 420×360px, bottom-right of the viewport above the dock.
- **Live updates**: a `chrome.storage.onChanged` listener tied to the current hostname rebuilds the list when storage changes, so a new highlight made while the panel is open appears immediately without manual refresh.
- **Invocation**: dock button (left of the visibility eye) and bare-key `f` when the dock is visible. The dock button is `data-disabled="1"` (30% opacity, no pointer events) when the page has no snippets — re-checked on every relevant `chrome.storage.onChanged` and on SPA URL changes via `window.navigation.addEventListener('navigate', ...)` (Chromium 102+) with a `popstate` fallback. Bare-key `f` honors the same disabled state.
- **Escape**: bubble-phase keydown handler closes the panel — but defers to `AdnotaState.mode` first, so if a tool is active, Escape exits the tool and the panel stays open. Two presses to close both.
- **Reuse**: borrows `AdnotaStorage.getAnchorsForUrl` and the redaction-bar formula. Deliberately **does not** share the Sites/Snippets `buildQuoteBlock` renderer — the scratch pad is the new austere reference; the Sites feed may be retrofitted toward this aesthetic in a later pass.
- **Public API**: `window.AdnotaScratchPad = { toggle(), open(), close(), isOpen(), refresh(), pageSnippetCount() }`. The dock calls `toggle()` and `pageSnippetCount()`.

#### `pages/sites.html` + `pages/sites.js` + `pages/sites.css`
Dedicated extension page (opened as a new tab via `chrome.runtime.getURL`). Two tabs share a common sticky header; each tab owns its own chrome.

**Shared header** (sticky)
- **View tabs** (primary nav, centered in the dark header): `Snippets` (prose feed, default) and `Sites` (per-domain browser). Each carries a live count badge. Active tab persists to `chrome.storage.local.adnotaHomeTab`.
- **Tag filter chip row** lives inside the sticky header so it never scrolls off. Rendered from `AdnotaTags.getAllTags()`; hidden entirely when no tagged items exist so untagged users see the original UI. Chips are sorted by count desc with alphabetical tiebreak and each carry a `#tag count` pill. Active tag is mirrored to the URL hash (`#tag=foo`) so filters survive reloads and are shareable; a `hashchange` listener keeps the view in sync with back/forward. If the active tag disappears (last item deleted), the filter auto-clears on next render.
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
- **Paragraph fidelity**: `range.toString()` captures newlines at block-element boundaries in the source page, so a multi-paragraph highlight is stored with its paragraph breaks intact. `.feed-text` uses `white-space: pre-wrap` so those breaks render in the feed instead of collapsing to one blob. Copy button and visual output stay in sync because both read the same `item.text`.
- **Selection guard**: a click handler that opens a new tab would hijack drag-select. The handler checks `window.getSelection().isCollapsed` + block containment; if the user finished a selection inside the card, the click no-ops instead of navigating. Drag-select + Ctrl+C then copies the visible text with the same newlines the Copy button writes.

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
| Cloud sync | Deferred — all data is `chrome.storage.local` only (10 MB cap on MV3; meter in Sites page surfaces usage) |
| Amber "broken anchor" UI | Toast notification shown on initial page load when anchors can't be resolved |
| Cross-origin iframe contents | Out of scope — users can erase the top-level `<iframe>` element |
| Multi-color sticky notes | 5 colors (yellow, green, blue, pink, white) with HUD toolbar |
| `<40 point` confidence restoration | Silent skip on MutationObserver retries; toast notification on initial page load |

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

---

## What's Next — Possible Directions
NOTE: CLAUDE PLEASE IGNORE THIS SECTION!!! It's not relevent to any current work!
------------------------------------------






The core engine is solid. Here are the most natural next directions, ranked by alignment to the core vision:

### High Alignment

**1. Cloud Sync (v2 backend)**
The schema was designed for this from day one. Every item has a `version` field and structured timestamps. The migration path from local-only to synced is: add a user identity layer (OAuth), swap the storage adapter, and merge on conflict by `updatedAt`. This is the biggest unlock for cross-device use and is the clearest monetization path.

**2. Broken Anchor Recovery UI**
Anchors with confidence < 40 points now show a dismissible toast on page load ("N saved edits couldn't be reapplied"). The next step is surfacing these in the popup with a way to manually re-pin or dismiss individual broken anchors.

**3. Export / Share**
Users annotate pages for a reason — research, review, redaction for screenshots. A one-click "Export annotations as JSON" or "Copy redacted screenshot" feature directly serves this. The redaction/black highlight makes this especially compelling.

### Medium Alignment

**4. Highlighter ↔ Note Cross-Linking**
`attachedNoteId` is already reserved in the highlight schema. Clicking a highlight could summon a linked sticky note ("Note on this highlight"), connecting the two tools natively.

**5. Annotation Search**
From the Sites page, allow searching by annotation *content* (not just hostname) — find every page where you highlighted the word "privacy" or left a note mentioning "follow up."

### Lower Priority / Later

**6. Team Sharing**
Requires cloud sync first. Share your annotated version of a page with a link — collaborator opens it, Adnota re-applies all annotations on their end. Powerful for editorial review, research handoff, redaction sign-off.

**7. Presentation / Focus Mode**
`Alt+S` already hides everything. A dedicated presentation mode could selectively show only highlights (no sticky notes) or only notes (no erasures) depending on context.
