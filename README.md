# Vellum

The Persistent Canvas browser extension. Erase distracting elements from the web permanently.

## Local Installation Request

To install the Vellum MVP on your local machine for testing, follow these steps:

1. **Open Extension Settings:** Go to `chrome://extensions` in your Chrome (or Chromium-based) browser.
2. **Enable Developer Mode:** Toggle the **Developer mode** switch in the top-right corner of the extensions page.
3. **Load Unpacked Extension:** Click the **Load unpacked** button that appears in the top-left toolbar.
4. **Select Project Folder:** Navigate to the project root folder (`$HOME/webrevise`), select it, and click **Select**.
5. **Verify Installation:** You should now see the Vellum extension loaded into your installed extension list. You can pin it to your browser toolbar using the puzzle-piece menu for quick access!

## Basic Usage

- **Toggle Eraser:** Click the Vellum extension icon and click "Toggle Eraser Mode", or simply press `Alt+E` anywhere on a webpage.
- **Erase an Element:** When Eraser Mode is active (the cursor turns into a crosshair and hovered elements get a solid red outline), click on any element to permanently remove it.
- **Domain-wide Erase:** Hold `Shift` while clicking to hide that element across the entire website domain rather than just the exact URL.
- **Resize an Element:** Click the Vellum extension icon and click "Resizer" to enter resize mode. Hover over elements to highlight them (scroll wheel walks up/down the DOM tree to target parents or children). Click to select — drag the blue handles to resize. Click the red ✕ to reset all resizes on that element.
- **Session Undo:** Press `Ctrl+Z` while in Eraser Mode to retrieve your last deletion (must be on the same page load context).
- **Clear Page Edits:** Click the Vellum extension icon and click the "Clear Edits for this Page" button to reset the current URL entirely.























# Vellum — The Persistent Canvas

> Treat any website like your personal canvas. Erase what you don't need. Annotate what matters. Highlight, redact, and draw — all persistent across sessions, all stored privately on your machine.

Vellum is a Manifest V3 Chrome Extension built around a single core idea: **your annotations live with the page, not in a silo.** Every change you make to a website persists automatically, restores on the next visit, and is instantly accessible from a dedicated history view. No accounts, no cloud, no data leaving the browser.

---

## Shipped: Current Architecture

### Extension Shell

#### `manifest.json`
MV3 manifest. Permissions: `storage`, `activeTab`, `scripting`, `tabs`. Host permissions: `*://*/*`. Declares keyboard commands for all four tools (Alt+E, Alt+S, Alt+H, Alt+V). Declares `web_accessible_resources` for the `pages/` directory (Sites history page).

#### `background.js`
Minimal service worker. Routes keyboard command events from the browser to the active tab's content scripts via `chrome.tabs.sendMessage`.

---

### Shared Libraries (injected into every page)

#### `lib/storage.js` — `window.VellumStorage`
Wrapper around `chrome.storage.local`. All data is keyed by `hostname`, and each entry lives in a `items[]` array. Every item carries:
- `action`: `'ERASE'` | `'NOTE'` | `'HIGHLIGHT'` | `'MARKER'`
- `version`: schema version field (currently `2`) — future-proofs migrations
- `anchor`: nested object containing all FuzzyAnchor signals (cssSelector, tagName, textFingerprint, attributes, structure, geometry) — only present on items that need DOM resolution (ERASE, HIGHLIGHT, MARKER)
- `timestamp` / `createdAt` / `updatedAt` as appropriate per action type
- FuzzyAnchor fields for restoration

Methods: `saveItem`, `saveNote`, `deleteItem`, `getAnchorsForUrl`, `clearPage`.

#### `lib/annotationState.js` — `window.VellumState`, `window.VellumUndo`
**`VellumState`**: Single source of truth for active tool mode (`null` | `'eraser'` | `'sticky'` | `'highlight'` | `'pen'`) and active highlight color. Persists `vellumActiveMode` and `vellumHighlightColor` to storage for cross-component sync (popup reads these live). Subscriber pattern — all tools react to state changes without polling.

**`VellumUndo`**: Central undo stack shared by all tools. Pressing `Ctrl+Z` / `Cmd+Z` anywhere on the page pops and executes the most recent `{ undo: async fn }` entry, regardless of which tool created it.

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
- **HUD strip**: fixed bottom-center bar (draggable) that provides live contextual guidance while hovering:
  - **Confidence score** with contextual label — "likely ad" (red, when ad signals detected), "strong anchor" (green, ≥70), "moderate" (amber, ≥40), "weak anchor" (red, <40)
  - **Ad signal badges** — colored pills (e.g., `ad-keyword`, `iframe`, `ad-network`) shown when detected
  - **Scroll nudge** — "▲ Scroll up N× for better target" shown when `findBetterTarget()` identifies a higher parent with a stronger anchor score
  - **Rotating help tips** — cycles every 4s with crossfade: click scope (page vs domain), scroll traversal, Escape to exit
  - **Draggable** — grab handle + pointer capture drag; position resets on mode exit
- **Scroll-wheel DOM traversal**: while hovering, scroll up to walk to the parent element, scroll down to walk back toward children — no minimum size filter (unlike resizer), so small elements like links and icons can be erased too
- Click to erase: fires a 3-stage animation sequence (ripples → bounding-box flash → dissolve) then hard-hides the element with `display: none !important`
- `Shift+Click` for domain-wide erasure (stored with `path: '*'`)
- Undo: shared `VellumUndo` stack + 5s toast button, both cancel mid-flight animations
- Show/Hide (`Alt+V`): tracks erased elements in a shared `VellumErasedElements` Set (populated by both eraser clicks and restorer) to toggle visibility
- Storage write is non-blocking (does not delay animation)

#### `content/sticky.js` — `window.StickyEngine`
- Activated via popup or `Alt+S`
- Click anywhere on the page to drop a free-floating sticky note
- **Coordinate model**: position is stored as `{ xPct, yScrollPct }` — percentages of total page scroll width/height — not a DOM anchor. This means notes survive any page restructure; the worst case is a note floats ~100px from its original spot if content above it shifts significantly.
- **Drag and Drop**: pointer-event drag on the header repositions notes freely. On drop, new coordinates are converted back to percentages and persisted.
- Autosaves content on a 1.5s debounce
- Create undo: `Ctrl+Z` / `Cmd+Z` immediately after placing a note removes it from DOM and storage
- Delete: instant visual hide + 5s undo window before storage commit
- `Alt+V` toggles all note visibility. Visibility state (`vellumHidden`) is persisted to storage and queried live by the popup via `get-view` message
- Smart Z-index elevation on focus
- Colors: yellow only for MVP

#### `content/highlighter.js` — `window.VellumHighlighter`
- Activated via popup or `Alt+H`
- Inline toolbar (fixed, bottom-center) exposes two sub-modes and five colors
- **Highlight mode**: text selection applies color via the **CSS Custom Highlights API** (`CSS.highlights`, Chrome 105+) — zero DOM mutation, React/Vue safe
- **Fallback**: for Shadow DOM / cross-boundary ranges, falls back to absolutely-positioned overlay divs with `mix-blend-mode: multiply`
- **Five colors**: yellow, green, blue, pink, and **black (redaction)**
  - Pastel colors are semi-transparent (`rgba(..., 0.4)`) via `::highlight` CSS rules
  - **Black uses `color: #000; background-color: #000`** — fully opaque, text invisible underneath. Fallback path uses normal blend mode (not multiply) so the cover is solid
- Persists last-chosen color to storage across sessions
- Undo: removes range from CSS Highlights registry and deletes from storage
- Schema stores: `text`, `occurrenceIndex`, `color`, `isFallback`, `fallbackRects`, `attachedNoteId` (reserved for future note cross-linking)
- Swatch selection state: white inner ring + dark outer ring for all five swatches; black swatch has a hover tooltip describing its redaction purpose

#### `content/resizer.js` — Element Resizer
- Activated via popup tool card (no keyboard shortcut — Chrome limits extensions to 4)
- **Smart element targeting**: hover highlights large layout-significant elements only (≥120×60px), automatically bubbling up past inline tags (`<span>`, `<a>`, etc.) to the nearest block-level container
- **Scroll-wheel DOM traversal**: while hovering, scroll up to walk to the parent element, scroll down to walk back toward children — solves the problem of targeting a specific nesting level on complex pages
- Click to select: dashed blue outline with **5 interactive controls** appears:
  - **Left handle** — drag to resize width from the left edge (right edge stays pinned via margin compensation)
  - **Right handle** — drag to resize width from the right edge
  - **Bottom handle** — drag to resize height
  - **Corner handle** — drag to resize both width and height simultaneously
  - **Red ✕ button** (top-right) — resets ALL resize overrides for this element, removing injected CSS from both the `<style>` tag and storage
- All resizes persist as CSS rules injected into a `<style id="vellum-style-overrides">` tag — survives React/Vue re-renders
- CSS selector generation uses the shared `FuzzyAnchor.generateCSSSelector()` utility
- CSS rule format: `width: Xpx !important; max-width: none !important` (and `margin-left` for left-handle resizes)
- Handles are viewport-clamped so they remain visible even on elements taller/wider than the screen
- Handles reposition on scroll
- Undo via shared `VellumUndo` stack + 5s toast button
- Storage action type: `RESIZE`

#### `content/marker.js` — `window.VellumMarker`
- Pen mode within the same toolbar as the highlighter
- Transparent SVG canvas overlay captures pointer events across the full page while active
- Toolbar-area clicks are explicitly guarded (both by DOM check and bounding box) to prevent strokes firing through the toolbar
- **Ramer-Douglas-Peucker** path simplification (ε = 2.0) reduces point density before storage
- **Arrow detection**: if stroke straightness ratio is 0.65–0.98, snaps to a clean bezier arrow with an SVG `<marker>` arrowhead
- Rendered markers re-anchor to their block element via `ResizeObserver` + scroll listener — no drift on long pages
- **Five colors**: same palette as highlighter (yellow, green, blue, pink, black)
- A tap with fewer than 3 points cancels the stroke and deactivates the tool

#### `content/restorer.js`
- Runs at `document_idle` and on `DOMContentLoaded`
- **MutationObserver** with 1s debounce watches for SPA/lazy-loaded content and re-runs restoration — handles React, Vue, and infinite-scroll sites
- Dispatches to the correct engine by `action` type:
  - `RESIZE` → injects stored CSS rule into `<style id="vellum-style-overrides">` — **bypasses FuzzyAnchor entirely** since the CSS selector is self-contained
  - `ERASE` → `element.style.setProperty('display', 'none', 'important')` + adds element to `VellumErasedElements` for show/hide toggling
  - `NOTE` → `StickyEngine.renderNote()` directly from stored `placement` — **bypasses FuzzyAnchor entirely** since position is self-contained percentage coordinates
  - `HIGHLIGHT` → `VellumHighlighter.applyStoredHighlight()`
  - `MARKER` → `VellumMarker.renderMarker()`
- Deduplicates with a `processedItems` Set so MutationObserver re-runs don't re-render already-applied annotations

---

### UI

#### `popup/index.html` + `popup/popup.js` + `popup/style.css`
Premium dark-header popup (360px wide). Features:
- **Tool cards** for Eraser, Sticky Note, Highlight & Pen, and Resizer — each with icon chip, shortcut badge (where available), and active-state indicator (colored border + pulsing dot) that syncs in real time via `storage.onChanged` (catches keyboard shortcuts fired while popup is open)
- **Per-page stats** (Erased / Notes / Highlights / Resized / Strokes) — each stat card cross-fades to a trash icon on hover; clicking clears that category from the current page
- **Show/Hide Changes button** (`Alt+V`) in the header — eye icon with a diagonal slash overlay when annotations are hidden. Reads live state via `get-view` message to the content script on open; optimistically toggles on click for instant UI response
- **My Edited Sites** button in footer (purple outline) — opens the Sites history page
- **Clear All Page Edits** button in footer (red outline)

#### `pages/sites.html` + `pages/sites.js` + `pages/sites.css`
Dedicated extension page (opened as a new tab via `chrome.runtime.getURL`). Aggregates all `chrome.storage.local` data and renders a browseable history of every site Vellum has touched:
- **Per-domain cards**: favicon, hostname, page count, last-edited timestamp
- **Annotation type pills**: Erased / Notes / Highlights / Resized / Strokes with color-coded badges
- **Expandable page drawer**: chevron reveals every individual path within a domain, each with its own pills and an "Open" button
- **Visit button**: opens the most recently edited page for that domain
- **Search + Sort**: real-time filter by hostname; sort by Most Recent / A→Z / Most Edits
- **Live updates**: `storage.onChanged` listener refreshes the view automatically
- **Summary bar**: total sites, total edits, total pages at a glance

---

## Known Constraints & Deliberate Cuts

| Item | Decision |
|---|---|
| Cloud sync | Deferred — all data is `chrome.storage.local` only (5 MB cap) |
| Amber "broken anchor" UI | Toast notification shown on initial page load when anchors can't be resolved |
| Cross-origin iframe contents | Out of scope — users can erase the top-level `<iframe>` element |
| Ripple animation on erase | Commented out in code — kept for future re-enablement |
| Multi-color sticky notes | Yellow-only for MVP; schema is theme-ready |
| `<40 point` confidence restoration | Silent skip on MutationObserver retries; toast notification on initial page load |

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Alt+E` | Toggle Eraser |
| `Alt+S` | Toggle Sticky Notes |
| `Alt+H` | Toggle Highlight & Pen toolbar |
| `Alt+V` | Show / Hide all annotations |
| `Ctrl+Z` / `Cmd+Z` | Undo last action (any tool) |
| `Escape` | Deactivate active tool / deselect resizer element |
| `Shift+Click` | (Eraser only) Domain-wide deletion |
| `Scroll Wheel` | (Eraser & Resizer) Walk up/down DOM tree to target parent or child elements |

---

## What's Next — Possible Directions

The core engine is solid. Here are the most natural next directions, ranked by alignment to the core vision:

### High Alignment

**1. Cloud Sync (v2 backend)**
The schema was designed for this from day one. Every item has a `version` field and structured timestamps. The migration path from local-only to synced is: add a user identity layer (OAuth), swap the storage adapter, and merge on conflict by `updatedAt`. This is the biggest unlock for cross-device use and is the clearest monetization path.

**2. Broken Anchor Recovery UI**
Anchors with confidence < 40 points now show a dismissible toast on page load ("N saved edits couldn't be reapplied"). The next step is surfacing these in the popup with a way to manually re-pin or dismiss individual broken anchors.

**3. Export / Share**
Users annotate pages for a reason — research, review, redaction for screenshots. A one-click "Export annotations as JSON" or "Copy redacted screenshot" feature directly serves this. The redaction/black highlight makes this especially compelling.

### Medium Alignment

**4. Multi-color Sticky Notes**
The schema already has `theme` support. Yellow-only was an MVP simplicity call. Adding the same 5-color palette as the highlighter would make the tool feel more personal.

**5. Highlighter ↔ Note Cross-Linking**
`attachedNoteId` is already reserved in the highlight schema. Clicking a highlight could summon a linked sticky note ("Note on this highlight"), connecting the two tools natively.

**6. Annotation Search**
From the Sites page, allow searching by annotation *content* (not just hostname) — find every page where you highlighted the word "privacy" or left a note mentioning "follow up."

### Lower Priority / Later

**7. Team Sharing**
Requires cloud sync first. Share your annotated version of a page with a link — collaborator opens it, Vellum re-applies all annotations on their end. Powerful for editorial review, research handoff, redaction sign-off.

**8. Presentation / Focus Mode**
`Alt+V` already hides everything. A dedicated presentation mode could selectively show only highlights (no sticky notes) or only notes (no erasures) depending on context.
