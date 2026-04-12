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
- `version`: schema version field (currently `1`) — future-proofs migrations
- `timestamp` / `createdAt` / `updatedAt` as appropriate per action type
- FuzzyAnchor fields for restoration

Methods: `saveAnchor`, `saveNote`, `deleteItem`, `getAnchorsForUrl`, `clearPage`.

#### `lib/annotationState.js` — `window.VellumState`, `window.VellumUndo`
**`VellumState`**: Single source of truth for active tool mode (`null` | `'eraser'` | `'sticky'` | `'highlight'` | `'pen'`) and active highlight color. Persists `vellumActiveMode` and `vellumHighlightColor` to storage for cross-component sync (popup reads these live). Subscriber pattern — all tools react to state changes without polling.

**`VellumUndo`**: Central undo stack shared by all tools. Pressing `Ctrl+Z` / `Cmd+Z` anywhere on the page pops and executes the most recent `{ undo: async fn }` entry, regardless of which tool created it.

---

### Content Scripts

#### `content/fuzzyAnchor.js` — `window.FuzzyAnchor`
Layered element-identification system that generates and resolves anchors across page reloads:

1. **Direct Selector** (95% confidence) — stable `#id` when available
2. **Structural XPath** (+40%) — DOM path from root
3. **Semantic Anchor** (+50%) — first/last 20 chars of element text content
4. **Visual Geometry fallback** (65%) — bounding box relative to nearest landmark (`<header>`, `<main>`, `<article>`, etc.)

Confidence threshold: **≥ 70%** to auto-apply a restoration. Below that, the item is silently skipped (we chose not to draw amber highlights on eroded anchors to preserve page aesthetics).

#### `content/eraser.js`
- Activated via popup or `Alt+E` keyboard shortcut
- Red outline hover preview tracks the cursor; Vellum's own UI elements are guarded and invisible to the eraser
- Click to erase: fires a 3-stage animation sequence (ripples → bounding-box flash → dissolve) then hard-hides the element with `display: none !important`
- `Shift+Click` for domain-wide erasure (stored with `path: '*'`)
- Undo: shared `VellumUndo` stack + 5s toast button, both cancel mid-flight animations
- Storage write is non-blocking (does not delay animation)

#### `content/sticky.js` — `window.StickyEngine`
- Activated via popup or `Alt+S`
- Click anywhere on the page to drop a free-floating sticky note
- **Coordinate model**: position is stored as `{ xPct, yScrollPct }` — percentages of total page scroll width/height — not a DOM anchor. This means notes survive any page restructure; the worst case is a note floats ~100px from its original spot if content above it shifts significantly.
- **Drag and Drop**: pointer-event drag on the header repositions notes freely. On drop, new coordinates are converted back to percentages and persisted.
- Autosaves content on a 1.5s debounce
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
  - `ERASE` → `element.style.setProperty('display', 'none', 'important')`
  - `NOTE` → `StickyEngine.renderNote()` directly from stored `placement` — **bypasses FuzzyAnchor entirely** since position is self-contained percentage coordinates
  - `HIGHLIGHT` → `VellumHighlighter.applyStoredHighlight()`
  - `MARKER` → `VellumMarker.renderMarker()`
- Deduplicates with a `processedItems` Set so MutationObserver re-runs don't re-render already-applied annotations

---

### UI

#### `popup/index.html` + `popup/popup.js` + `popup/style.css`
Premium dark-header popup (360px wide). Features:
- **Tool cards** for Eraser, Sticky Note, and Highlight & Pen — each with icon chip, shortcut badge, and active-state indicator (colored border + pulsing dot) that syncs in real time via `storage.onChanged` (catches keyboard shortcuts fired while popup is open)
- **Per-page stats** (Erased / Notes / Highlights / Strokes) — each stat card cross-fades to a trash icon on hover; clicking clears that category from the current page
- **Show/Hide Changes button** (`Alt+V`) in the header — eye icon with a diagonal slash overlay when annotations are hidden. Reads live state via `get-view` message to the content script on open; optimistically toggles on click for instant UI response
- **My Edited Sites** button in footer (purple outline) — opens the Sites history page
- **Clear All Page Edits** button in footer (red outline)

#### `pages/sites.html` + `pages/sites.js` + `pages/sites.css`
Dedicated extension page (opened as a new tab via `chrome.runtime.getURL`). Aggregates all `chrome.storage.local` data and renders a browseable history of every site Vellum has touched:
- **Per-domain cards**: favicon, hostname, page count, last-edited timestamp
- **Annotation type pills**: Erased / Notes / Highlights / Strokes with color-coded badges
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
| Amber "broken anchor" UI | Cut — silently skip eroded anchors to preserve page aesthetics |
| Cross-origin iframe contents | Out of scope — users can erase the top-level `<iframe>` element |
| Ripple animation on erase | Commented out in code — kept for future re-enablement |
| Multi-color sticky notes | Yellow-only for MVP; schema is theme-ready |
| `<70%` confidence restoration | Silent skip, no user-facing warning in current build |

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Alt+E` | Toggle Eraser |
| `Alt+S` | Toggle Sticky Notes |
| `Alt+H` | Toggle Highlight & Pen toolbar |
| `Alt+V` | Show / Hide all annotations |
| `Ctrl+Z` / `Cmd+Z` | Undo last action (any tool) |
| `Escape` | Deactivate active tool |
| `Shift+Click` | (Eraser only) Domain-wide deletion |

---

## What's Next — Possible Directions

The core engine is solid. Here are the most natural next directions, ranked by alignment to the core vision:

### High Alignment

**1. Cloud Sync (v2 backend)**
The schema was designed for this from day one. Every item has a `version` field and structured timestamps. The migration path from local-only to synced is: add a user identity layer (OAuth), swap the storage adapter, and merge on conflict by `updatedAt`. This is the biggest unlock for cross-device use and is the clearest monetization path.

**2. Broken Anchor Recovery UI**
Currently, anchors with confidence < 70% fail silently. Surfacing these in the popup ("1 edit couldn't be applied — review") and giving users a way to manually re-pin or dismiss them would significantly improve reliability perception on sites that update frequently.

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
