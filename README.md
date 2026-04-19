# Vellum — The Persistent Canvas

> Treat any website like your personal canvas. Erase what you don't need. Annotate what matters. Highlight, redact, and draw — all persistent across sessions, all stored privately on your machine.

Vellum is a Manifest V3 Chrome Extension built around a single core idea: **your annotations live with the page, not in a silo.** Every change you make to a website persists automatically, restores on the next visit, and is instantly accessible from a dedicated history view. No accounts, no cloud, no data leaving the browser.

Highlight what's notable, eliminate what's not.

Mark it up. Block it out. Make it yours.

NOTE: WE ARE NOT IN PRODUCTION YET, SO MAKE AN EFFORT TO CLEAN UP CODE AND REDUCE DUPLICATE AS WE GO!

Annotate your web, your way.

---

## Shipped: Current Architecture

### Extension Shell

#### `manifest.json`
MV3 manifest. Permissions: `storage`, `activeTab`, `scripting`, `tabs`. Host permissions: `*://*/*`. Declares keyboard commands for all four tools (Alt+E, Alt+S, Alt+H, Alt+V). Declares `web_accessible_resources` for the `pages/` directory (Sites history page).

#### `background.js`
Minimal service worker. Routes keyboard command events from the browser to the active tab's content scripts via `chrome.tabs.sendMessage`. Also relays messages from the radial quick-access menu (content scripts can't `sendMessage` to their own tab): `open-sites` and `relay-to-tab`.

---

### Shared Libraries (injected into every page)

#### `lib/storage.js` — `window.VellumStorage`
Wrapper around `chrome.storage.local`. All data is keyed by `hostname`, and each entry lives in a `items[]` array. Every item carries:
- `action`: `'ERASE'` | `'NOTE'` | `'HIGHLIGHT'` | `'MARKER'`
- `version`: schema version field (currently `2`) — future-proofs migrations
- `anchor`: nested object containing all FuzzyAnchor signals (cssSelector, tagName, textFingerprint, attributes, structure, geometry) — present on ERASE, HIGHLIGHT, MARKER, and NOTE (for hybrid anchor placement)
- `timestamp` / `createdAt` / `updatedAt` as appropriate per action type
- FuzzyAnchor fields for restoration

Methods: `saveItem`, `saveNote` (generic upsert-by-uuid — caller passes full payload), `deleteItem`, `getAnchorsForUrl`, `clearPage`.

#### `lib/annotationState.js` — `window.VellumState`, `window.VellumUndo`, `window.VellumVisibility`
**`VellumState`**: Single source of truth for active tool mode (`null` | `'eraser'` | `'sticky'` | `'highlight'` | `'pen'` | `'arrow'` | `'rect'` | `'ellipse'` | `'text'` | `'select'`), active color, stroke width, and shape fill modifier. `color` holds either a theme class (`vellum-theme-*`) or a raw hex string from the eyedropper — consumers must handle both. `filled` is a boolean modifier that only affects rect/ellipse. Persists `vellumActiveMode`, `vellumHighlightColor`, `vellumStrokeWidth`, and `vellumShapeFilled` to storage for cross-component sync (popup reads these live). Subscriber pattern — all tools react to state changes without polling.

**`VellumUndo`**: Central undo stack shared by all tools. Pressing `Ctrl+Z` / `Cmd+Z` anywhere on the page pops and executes the most recent `{ undo: async fn }` entry, regardless of which tool created it.

**Universal Escape + focus anchor**: a single `window`-capture keydown handler clears `VellumState.mode` on Escape — no matter which tool is active, Escape always exits. To keep Escape reachable even when cross-origin iframe ads try to trap keyboard focus, a hidden focusable `<div id="vellum-focus-anchor">` (zero-size, `tabindex="-1"`, `data-vellum-ui`) is focused on mode entry. A `focusin` capture listener yanks focus back whenever anything outside Vellum UI grabs it; `visibilitychange` re-anchors on tab round-trips. `VellumState.anchorFocus()` is exposed for tools that `preventDefault` pointer events (eraser page-click blocker) to explicitly reclaim focus after suppressing the implicit transfer.

**`VellumVisibility`**: Ephemeral show/hide-all controller. `toggle()` flips a `vellum-hidden` class on `<html>` (which component CSS rules target), iterates `VellumErasedElements` to flip inline `display:none`, disables/re-enables the `vellum-erase-overrides` + `vellum-style-overrides` style tags, and injects/removes a transient stylesheet that zeroes out CSS Custom Highlights backgrounds. State is NOT persisted — every page load starts visible. `show()` idempotently reveals; called from sticky/highlight/marker handlers so hide mode can't block or obscure new work. The central `toggle-view` / `get-view` message handler and a `visibility-changed` broadcast (for popup icon sync) also live here.

#### `lib/vellumUI.js` — `window.VellumUI`                                                                           
Shared UI utilities that prevent duplication across content scripts.                                                                                                     

**`data-vellum-ui` convention**: Every Vellum UI element (overlays, toolbars, toasts, sticky notes, marker wrappers, etc.) must be tagged with `data-vellum-ui="1"`. This is how the eraser, resizer, and marker know to ignore Vellum's own elements — `isVellumElement(el)` is a single `.closest('[data-vellum-ui]')` check. When adding new UI elements, always set this attribute or they will be erasable/selectable by the user's own tools.

**Shared HUD button helpers**: `createToolbarIconButton`, `createUndoButton`, and `createTrashButton` produce the dark-frosted `vellum-undo-btn`-styled controls used across every HUD. `softDeleteItems({singular, plural, actionTypes})` is the single implementation behind every bulk trash action (popup stat cards, popup "Clear All," and HUD trash buttons): it snapshots matching items by ID, removes them from storage, hides them from the DOM, and shows a 5-second toast with Undo. Undo re-writes storage and re-renders in place; Ctrl+Z also pops the batch off `VellumUndo`.

**Shared DOM-walk helpers**: `bubbleToVisualRoot(el, opts)` walks up parents whose bounding box matches `el` within a small tolerance — the "visually-identical wrapper" climb used by both the eraser and resizer so a hover/click on an inner element lands on the outer container users almost always actually mean. `dominatesViewport(rect, threshold)` guards the walk (and the eraser's better-target nudge) against ever promoting to a page-level container.

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

Also exposes `generateCSSSelector(el)` as a shared utility (used by the resizer).

#### `content/eraser.js`
- Activated via popup or `Alt+E` keyboard shortcut
- Red outline hover preview tracks the cursor; Vellum's own UI elements are guarded and invisible to the eraser
- **Dimension badge**: small `W×H` pixel label in the top-right corner of the red hover outline — useful for gauging element size, especially when parts extend off-screen
- **HUD strip**: fixed bottom-center bar (draggable) that stays visible whenever the eraser is active. Layout: drag handle → V logo chip → info section → trash → undo. Info section updates live while hovering:
  - **Confidence score** with contextual label — "likely ad" (red, when ad signals detected), "strong anchor" (green, ≥70), "moderate" (amber, ≥40), "weak anchor" (red, <40)
  - **Ad signal badges** — colored pills (e.g., `ad-keyword`, `iframe`, `ad-network`) shown when detected
  - **Scroll nudge** — "▲ Scroll up N× for better target" shown when `findBetterTarget()` identifies a higher parent with a stronger anchor score
  - **Rotating help tips** — cycles every 4s with crossfade: click scope (page vs domain), scroll traversal, Escape to exit
  - **Trash button** — deletes every erasure on the current page after a confirm (same action as the popup's "Erased" stat card)
  - **Undo button** — fires the shared `VellumUndo.undo()` stack
  - **Draggable** — grab handle + pointer capture drag; position resets on mode exit
- **Visual-root auto-bubble**: on hover, the outline automatically climbs past any parent wrapper whose bounding box matches the child (edges within 4px, size within 5%) so a single click hits the outermost visually-identical container. Stops the moment a parent meaningfully grows or would dominate ≥85% of the viewport, so page-level containers are never auto-selected. Small elements stay erasable — padding/margins break edge-match and keep inner targets distinct
- **Scroll-wheel DOM traversal**: while hovering, scroll up to walk to the parent element, scroll down to walk back toward the auto-bubbled baseline — no minimum size filter (unlike resizer), so small elements like links and icons can be erased too
- Click to erase: fires a 3-stage animation sequence (ripples → bounding-box flash → dissolve) then hard-hides the element with `display: none !important`
- `Shift+Click` for domain-wide erasure (stored with `path: '*'`) — explicit user override, unchanged semantic
- **Silent ad-scope promotion**: a plain click on a target with ad fingerprints (`getEffectiveAdSignals` non-empty — same detection the HUD "likely ad" label uses) is silently promoted to domain-wide storage, because nobody wants to re-erase the same ad on every article. No HUD chip, no messaging — it just works. Non-ad targets stay page-scoped. Page-level viewport-dominating containers are always treated as non-ad regardless of subtree iframes
- Undo: shared `VellumUndo` stack + 5s toast button, both cancel mid-flight animations
- Show/Hide (`Alt+V`): erased elements are tracked in the shared `VellumErasedElements` Set (populated by both eraser clicks and restorer); `VellumVisibility` iterates this set to toggle inline `display:none` on each node
- Storage write is non-blocking (does not delay animation)
- **Ad-popup defense**: while eraser is active, `mousedown` / `pointerdown` / `auxclick` on any non-Vellum target are intercepted on `window`-capture and `preventDefault`-ed. Stops ads that hijack the earliest pointer event to call `window.open()` before our click handler fires. Right-click (`button === 2`) is left alone so Inspect still works. Every blocked interaction calls `VellumState.anchorFocus()` to re-anchor keyboard focus, since `preventDefault` on mousedown suppresses the browser's implicit focus transfer
- **Iframe pointer shield**: cross-origin iframes swallow wheel events (parent doc never sees them, so scroll-to-traverse fails and the browser chain-scrolls the page instead) and their internal clicks never reach our handlers. While eraser is active, a scoped `<style id="vellum-iframe-shield">` sets `iframe { pointer-events: none !important }` on every iframe, routing wheel and click through to the iframe's container in the parent doc — which is usually the full ad wrapper the user actually means to erase. Removed on mode exit

#### `content/sticky.js` — `window.StickyEngine`
- Activated via popup or `Alt+S`
- Click anywhere on the page to drop a sticky note; stays in sticky mode for rapid placement — exit via `Escape` or re-toggle
- **Dark frosted-glass toolbar** (fixed, bottom-center, draggable) — matches marker/eraser HUD aesthetic
- **Toolbar layout**: drag handle → V logo chip → 5 sticky-note-shaped color swatches → trash → undo. Trash clears every sticky note on the current page after a confirm.
- **Five colors**: yellow, green, blue, pink, white — swatches are mini sticky note icons (folded corner shape) filled with the theme color. Active swatch gets a purple glow ring. Choice persists to `vellumStickyColor` in storage.
- **Hybrid anchor placement**: on click, finds the nearest block-level DOM element via `FuzzyAnchor.generate()` and stores the note's pixel offset (`dx`, `dy`) from that element alongside a percentage-based fallback (`xPct`, `yScrollPct`). On restore, tries the anchor first (element re-found via FuzzyAnchor tournament scoring → apply offset). If the anchor can't be resolved (score < 40 — page was restructured), falls back to percentage placement. **You never lose your work.**
- **Drag and Drop**: pointer-event drag on the header repositions notes freely. On drop, re-anchors to the element underneath the new position and persists updated coordinates.
- Autosaves content on a 1.5s debounce
- Create undo: `Ctrl+Z` / `Cmd+Z` immediately after placing a note removes it from DOM and storage; also available via toolbar undo button
- Delete: instant visual hide + 5s undo window before storage commit
- `Alt+V` toggles note visibility via the shared `VellumVisibility` controller (see below)
- Smart Z-index elevation on focus

#### `content/highlighter.js` — `window.VellumHighlighter`
- Activated via popup or `Alt+H`
- **Dark frosted-glass toolbar** (fixed, bottom-center, draggable) — matches eraser HUD aesthetic with `rgba(15,15,15,0.92)` background, `backdrop-filter: blur(8px)`, and purple accent border
- **Toolbar layout**: drag handle → V logo chip → tool icons → color swatches → stroke width presets → trash → undo. Trash clears every highlight and marker shape on the current page after a confirm.
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
- **Fill group** (outline / solid radio pair): placed right after the shape tool buttons so the option surfaces next to the tool that triggered it. Visible only when Rectangle or Circle is the active tool (the buttons and their trailing divider hide together, leaving no empty gap). Outline variant carries a red diagonal slash to disambiguate it from the rectangle tool icon. Exactly one is active at any time; clicking either sets `VellumState.filled` (persisted as `vellumShapeFilled`). Payload stores `filled: bool` on `MARKER` items with `shapeType: 'rect' | 'ellipse'`. Solid shapes are the primary redaction mechanism for non-text content (ads, images, iframes) that can't be erased without breaking layout.
- **Undo button**: triggers `VellumUndo.undo()` directly from the toolbar
- **Draggable**: pointer-capture drag via handle (same pattern as eraser HUD); position resets when toolbar hides
- **Highlight mode**: text selection applies color via the **CSS Custom Highlights API** (`CSS.highlights`, Chrome 105+) — zero DOM mutation, React/Vue safe
- **Fallback**: for Shadow DOM / cross-boundary ranges, falls back to absolutely-positioned overlay divs with `mix-blend-mode: multiply`
- **Five colors**: yellow, green, blue, pink, and **black (redaction)**
  - Pastel colors are semi-transparent (`rgba(..., 0.4)`) via `::highlight` CSS rules
  - **Black uses `color: #000; background-color: #000`** — fully opaque, text invisible underneath. Fallback path uses normal blend mode (not multiply) so the cover is solid
- Persists last-chosen color and stroke width to storage across sessions
- Undo: removes range from CSS Highlights registry and deletes from storage
- Schema stores: `text`, `occurrenceIndex`, `color`, `isFallback`, `fallbackRects`, `attachedNoteId` (reserved for future note cross-linking)

#### `content/resizer.js` — Element Resizer
- Activated via popup tool card (no keyboard shortcut — Chrome limits extensions to 4)
- **Smart element targeting** (two-stage, order matters): (1) climb to the nearest layout-significant block-level ancestor (≥120×60px, non-inline) — escapes tiny hovers like a menu link before any bubbling happens; (2) *then* use the shared `VellumUI.bubbleToVisualRoot` helper, seeded from that ancestor, to promote past visually-identical outer wrappers. This ordering is important: the eraser bubbles from the raw hover because any size element is a legitimate erase target, but the resizer almost always wants a meaningful block, so seeding the IoU comparison from a real layout element (not a 220×36 link) lets it correctly reach a 220×356 `nav` two hops above
- **Dimension badge**: small `W×H` pixel label in the top-right corner of the blue hover outline
- **Scroll-wheel DOM traversal**: while hovering, scroll up to walk to the next layout-significant parent, scroll down to walk back toward children. Stops before reaching a viewport-dominating container
- **HUD strip**: fixed bottom-center bar (draggable) that stays visible whenever the resizer is active. Layout: drag handle → V logo chip (blue) → info section → trash → undo. Matches the eraser HUD aesthetic, tinted with the resizer's blue accent. Info section updates live:
  - **Idle** — rotating help tips (click to select, scroll to traverse, drag handles, ✕ to reset, Esc to exit)
  - **Hovering** — current target dimensions in `W×H` + scroll-to-walk hint
  - **Selected** — locked target dimensions (live-updated during drag) + reset hint
  - **Trash button** — deletes every resize on the current page (same code path as the popup's Resized stat card)
  - **Undo button** — fires the shared `VellumUndo.undo()` stack
- Click to select: dashed blue outline with **6 interactive controls** appears:
  - **Left handle** — drag to resize width from the left edge (right edge stays pinned via `margin-left` compensation)
  - **Right handle** — drag to resize width from the right edge
  - **Top handle** — drag to resize height from the top edge (bottom edge stays pinned via `margin-top` compensation)
  - **Bottom handle** — drag to resize height
  - **Corner handle** — drag to resize both width and height simultaneously
  - **Blue reset button** (top-right, circular reset arrow icon) — resets ALL resize overrides for this element, removing injected CSS from both the `<style>` tag and storage. Deliberately blue (not a red ✕) so it doesn't collide semantically with the marker select tool's red ✕ delete affordance
- **Cursor lock**: while resizer mode is active, the central `VellumCursor.set` stylesheet forces a stable `default` arrow on every non-Vellum element with `!important`, so hovering links or buttons can't flip the cursor to `pointer`. Handles keep their own inline `ew-resize` / `ns-resize` / `nwse-resize` cursors via higher specificity on the handle elements
- All resizes persist as CSS rules injected into a `<style id="vellum-style-overrides">` tag — survives React/Vue re-renders
- CSS selector generation uses the shared `FuzzyAnchor.generateCSSSelector()` utility
- CSS rule format: `width: Xpx !important; max-width: none !important` (plus `margin-left` for left-handle resizes, `margin-top` for top-handle resizes, `height`/`max-height` for vertical resizes)
- Handles are viewport-clamped so they remain visible even on elements taller/wider than the screen
- Handles reposition on scroll
- Undo via shared `VellumUndo` stack + 5s toast button
- Storage action type: `RESIZE`

#### `content/marker.js` — `window.VellumMarker`
- Full drawing engine powering pencil, arrow, rectangle, ellipse, text, and select tools
- Transparent SVG canvas overlay captures pointer events across the full page while active
- Toolbar-area clicks are explicitly guarded (both by DOM check and bounding box) to prevent strokes firing through the toolbar
- **Pencil tool**: freehand drawing with **Ramer-Douglas-Peucker** path simplification (ε = 2.0) to reduce point density before storage
- **Arrow tool**: click-drag creates a straight line with SVG `<marker>` arrowhead; minimum distance threshold prevents accidental tiny arrows
- **Rectangle tool**: click-drag creates a `<rect>` with rounded corners; handles any drag direction (origin can be any corner). Honors the toolbar Fill toggle — outlined by default, solid fill when enabled
- **Ellipse tool**: click-drag creates an `<ellipse>`; center is midpoint of drag, radii from extent. Honors the toolbar Fill toggle (outline or solid fill)
- **Text tool**: click to place a `contentEditable` text box; Enter commits, Shift+Enter for newline, Escape cancels; font size derived from stroke width preset (thin=16px, medium=24px, thick=8=36px); rendered as HTML (not SVG `<text>`) for natural multi-line editing; double-click to re-edit existing text
- **Select tool**: click near any marker/shape/text to select it (proper SVG `getBBox()` hit testing picks the smallest overlapping shape); dashed purple selection box with red ✕ delete button; Delete/Backspace key support; all deletes are undoable via `VellumUndo`. Body cursor switches to a white SVG arrow while select mode is active (distinct from the system default so the "tool is on" state is unambiguous); hovering any `.vellum-marker-wrapper` upgrades to `grab` via a `html.vellum-select-mode` class toggle. **Drag-to-move**: pointerdown on a marker, travel past a 3px threshold, and all shape types (rect/ellipse/arrow/freehand/text) reposition live via CSS transform; on pointerup the delta is converted to a percentage of the anchor rect, applied to the payload's coord fields (`shape`, `textPos`, or `drawing[]`), re-rendered, persisted (delete-then-save by uuid), and pushed onto `VellumUndo`. A click below the drag threshold falls through to normal selection; a `suppressNextClick` flag swallows the synthetic click that follows a committed drag.
- **Stroke width**: all tools read `VellumState.strokeWidth` (2, 4, or 8) for line thickness; persisted per stroke in storage
- **Unified persistence**: all shapes stored as `MARKER` action with a `shapeType` field (`freehand`, `arrow`, `rect`, `ellipse`, `text`) — same anchor/restore pipeline via `renderMarker()`. Rect/ellipse payloads also carry `filled: bool`; solid payloads render with `fill=color, stroke=none`
- Rendered markers re-anchor to their block element via `ResizeObserver` + scroll listener — no drift on long pages
- **Five colors**: same palette as highlighter (yellow, green, blue, pink, black)
- A tap with fewer than 3 points (pencil) or too-small drag (shapes) cancels the action

#### `content/quickHighlight.js`
- Medium-style contextual popup that appears above any non-empty text selection after a ~400 ms dwell — independent of the Alt+H highlight mode
- Single-purpose: a Vellum "V" brand chip on the left (so it's visually distinct from the host site's own toolbar) followed by the five color swatches; clicking one applies the highlight and dismisses the popup
- Each new selection re-prompts — colors are not "sticky" between highlights; the user picks per-action
- Dismisses on: selection collapse, `Escape`, scroll, resize, click-away, or `Ctrl/Cmd+C` (copy is never intercepted — the popup just gets out of the way)
- Skips editable contexts (`input`, `textarea`, `contenteditable`) and any selection inside a Vellum UI element
- Suppressed while `VellumState.mode === 'highlight'` so it doesn't double up with the classic auto-apply mouseup
- Reuses `VellumHighlighter.createHighlightFromRange()` — no duplicate save/undo logic
- Feature-gated by `chrome.storage.local.vellumQuickHighlightEnabled` (default `true`); a future toggle UI can flip this without touching the content script

#### `content/restorer.js`
- Runs at `document_idle` and on `DOMContentLoaded`
- **MutationObserver** with 1s debounce watches for SPA/lazy-loaded content and re-runs restoration — handles React, Vue, and infinite-scroll sites
- Dispatches to the correct engine by `action` type:
  - `RESIZE` → injects stored CSS rule into `<style id="vellum-style-overrides">` — **bypasses FuzzyAnchor entirely** since the CSS selector is self-contained
  - `ERASE` → `element.style.setProperty('display', 'none', 'important')` + adds element to `VellumErasedElements` for show/hide toggling
  - `NOTE` → `StickyEngine.renderNote()` with stored `anchor`, `anchorOffset`, `placement`, `theme`, and `dimensions` — tries FuzzyAnchor resolution first, falls back to percentage placement
  - `HIGHLIGHT` → `VellumHighlighter.applyStoredHighlight()`
  - `MARKER` → `VellumMarker.renderMarker()`
- Deduplicates with a `processedItems` Set so MutationObserver re-runs don't re-render already-applied annotations

---

### UI

#### `popup/index.html` + `popup/popup.js` + `popup/style.css`
Premium dark-header popup (360px wide). Features:
- **Tool cards** for Eraser, Sticky Note, Drawing Palette (Highlight, Pen, Arrow, Rectangle, Circle, Text, Select), and Resizer — each with icon chip, shortcut badge (where available), and active-state indicator (colored border + pulsing dot) that syncs in real time via `storage.onChanged` (catches keyboard shortcuts fired while popup is open)
- **Per-page stats** (Erased / Notes / Highlights / Resized / Strokes) — each stat card cross-fades to a trash icon on hover; clicking clears that category from the current page
- **Show/Hide Changes button** (`Alt+V`) in the header — eye icon with a diagonal slash overlay when annotations are hidden. Reads live state via `get-view` message to the content script on open; optimistically toggles on click for instant UI response
- **My Edited Sites** button in footer (purple outline) — opens the Sites history page
- **Clear All Page Edits** button in footer (red outline)

#### `content/radialMenu.js` + `content/radialMenu.css` — Radial Quick-Access Menu
Animated floating widget (fixed bottom-left) that provides one-click access to all tools without opening the popup:
- **Center button**: branded "V" monogram circle (34px, frosted dark glass matching HUD aesthetic) — hover or click to expand
- **Six satellite buttons** fan out in a radial arc (−40° to 120°, 58px radius) with staggered spring animation:
  - **Show / Hide All** (purple) — toggles annotation visibility, icon swaps between eye/eye-off
  - **Eraser** (red) — toggles eraser mode
  - **Sticky Note** (amber) — toggles sticky note mode
  - **Drawing Palette** (purple) — toggles highlighter/marker toolbar
  - **Resizer** (blue) — toggles resizer mode
  - **My Edited Sites** (green) — opens the Sites history page in a new tab
- **Active tool sync**: satellite borders glow with their accent color when the corresponding tool is active, synced via `VellumState.subscribe()` and `storage.onChanged`
- **Collapse behavior**: clicking any satellite collapses immediately; mousing away auto-collapses after 1.5s with reverse-staggered animation
- **Tooltips**: appear to the right on satellite hover
- Invisible circular hit-zone prevents accidental collapse when moving between buttons
- All elements marked `data-vellum-ui` so eraser/resizer ignore them

#### `pages/sites.html` + `pages/sites.js` + `pages/sites.css`
Dedicated extension page (opened as a new tab via `chrome.runtime.getURL`). Aggregates all `chrome.storage.local` data and renders a browseable history of every site Vellum has touched:
- **Per-domain cards**: favicon, hostname, page count, last-edited timestamp
- **Annotation type pills**: Erased / Notes / Highlights / Resized / Strokes with color-coded badges
- **Expandable page drawer**: chevron reveals every individual path within a domain, each with its own pills. The path itself is a `target="_blank"` hyperlink with an external-link icon to the right (icon brightens + nudges on hover); domain-wide `*` entries stay as non-clickable labels
- **Visit button**: opens the most recently edited page for that domain
- **Delete-domain button**: red trash icon next to Visit wipes every edit for that hostname in one confirmation step (uses the shared branded confirmDialog)
- **Search + Sort**: real-time filter by hostname; sort by Most Recent / A→Z / Most Edits
- **Live updates**: `storage.onChanged` listener refreshes the view automatically
- **Summary bar**: total sites, total edits, total pages at a glance
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

| Shortcut | Action |
|---|---|
| `Alt+E` | Toggle Eraser |
| `Alt+S` | Toggle Sticky Notes |
| `Alt+H` | Toggle Drawing Palette toolbar |
| `Alt+V` | Show / Hide all annotations |
| `Ctrl+Z` / `Cmd+Z` | Undo last action (any tool) |
| `Escape` | Deactivate active tool (universal — works from any tool, any state) / cancel text input |
| `Shift+Click` | (Eraser only) Domain-wide deletion |
| `Enter` | (Text tool) Commit text |
| `Shift+Enter` | (Text tool) Insert newline |
| `Delete` / `Backspace` | (Select tool) Delete selected annotation |
| `Double-click` | (Select/Text tool) Re-edit existing text annotation |
| `Scroll Wheel` | (Eraser & Resizer) Walk up/down DOM tree to target parent or child elements |

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
Requires cloud sync first. Share your annotated version of a page with a link — collaborator opens it, Vellum re-applies all annotations on their end. Powerful for editorial review, research handoff, redaction sign-off.

**7. Presentation / Focus Mode**
`Alt+V` already hides everything. A dedicated presentation mode could selectively show only highlights (no sticky notes) or only notes (no erasures) depending on context.
