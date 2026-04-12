# Vellum MVP: The Persistent Canvas (Eraser & Local Sync)

Vellum is a Manifest V3 Chrome Extension that allows users to TREAT ANY WEBSITE LIKE THEIR CANVAS. They can permanently delete distracting elements from any webpage ("The Eraser"). They can add sicky notes anywhere on the page for their own research. They can highlight or markup any page as desired. The extension tracks edits to any site so it's always easy to navigate any past changes to all your edited websites. For the MVP, these changes will be persisted entirely locally (`chrome.storage.local`), ensuring privacy and a fast iteration cycle before introducing cloud sync.

## Proposed Architecture

---
### Extension Shell & Manifest
The core Chrome extension setup.
#### manifest.json
Configuration file for MV3. Needs `storage`, `scripting`, and `activeTab` permissions. Will also declare commands for keyboard shortcuts (e.g., `Alt+E`).
#### background.js
Service worker to handle state (toggling "Eraser Mode" via extension icon or keyboard shortcut) and coordinate messages between popup and content scripts.

---
### Content Scripts
The logic executed on the webpage to handle DOM manipulation and fuzzy matching.
#### content/eraser.js
Listens for "Eraser Mode" toggle (via popup or `Alt+E` shortcut).
- **UX**: When active, adds a hover effect (solid red outline) to hovered DOM elements.
- **Actions**: On click, removes the element from the DOM and sends the target's "Fuzzy Anchor" to storage. Default deletion scope is exact URL. Holding `Shift + Click` deletes domain-wide.
- **Undo Stack**: Maintains a session-level undo stack. Pressing `Ctrl+Z` while in Eraser Mode undeletes the last removed element (in-session only, not persisted over page refresh).
#### content/fuzzyAnchor.js
Implements the "Layered Confidence System":
1. **Direct Selector**: Uses stable IDs or specific classes when available.
2. **Structural Path**: Calculates the DOM XPath from root.
3. **Semantic Anchor**: Captures a hash or snippet of the element's text content (first/last 20 chars) to handle selector drift.
4. **Visual Geometry (Fallback)**: Records the bounding box position relative to the nearest landmark element (`<header>`, `<main>`, `<article>`) for elements lacking text or IDs (like images or iframes).
#### content/restorer.js
Runs on page load. Checks local storage for any saved anchors for the current URL/domain. Attempts to find the elements using the fuzzy anchor logic.
- **Confidence Threshold**: If the match confidence is >= 70%, it automatically removes the element.
- **Amber Highlight**: If the match confidence is < 70%, instead of silent failure or wrong deletion, it highlights the candidate element in amber and asks the user to confirm via a small tooltip checkmark.

---
### Storage & UI
Local storage utilities and the extension's user interface.
#### lib/storage.js
Wrapper around `chrome.storage.local` to save, fetch, and clear changes. **Critically, every entry will include a schema `version` field from day one** to prevent future migration headaches as the anchor format evolves.
#### popup/index.html
Minimal UI when clicking the extension icon. Displays:
- Toggle for Eraser Mode.
- Number of successful edits applied strictly.
- **Broken Anchor State**: Surface entries where `restorer.js` failed entirely to find a match (e.g. "1 edit couldn't be applied").
#### popup/popup.js
Logic to clear current page edits, toggle Eraser Mode, and render stats (Success vs Broken) correctly.
#### popup/style.css
Basic sleek styling for the popup, matching the premium "Vellum" aesthetic.

## Out of Scope for MVP
- **Cloud Sync**: Deferred to v2.
- **Cross-origin iFrame contents**: We will not be injecting scripts to remove sub-elements *inside* third-party iframes (like ads within an iframe). However, the user *can* delete the top-level `<iframe>` element.

## Verification Plan

### Automated Tests
- For the MVP, we will rely primarily on manual browser testing and simple unit tests for logic hashes if time permits.

### Manual Verification
- Install the unpacked extension in Chrome.
- **Interaction Check**: Activate "Eraser Mode" via `Alt+E`. Hover to see highlighted targets, click to delete. Press `Ctrl+Z` to verify session-level undo.
- **Advanced Deletion**: `Shift+Click` an element to test domain-wide deletion.
- **Persistence Check**: Refresh the page and verify deleted elements (>=70% confidence) vanish.
- **Threshold Check**: Break an anchor drastically in DevTools to trigger the <70% match condition and ensure the amber confirmation highlight appears. Check popup for "Broken Anchor" state.

---

## Features Roadmap (V1.1 & Beyond)

### The Redactor (Privacy Blackout Tool)
- **Concept:** Select text to black it out permanently.
- **Architecture:** Uses a standard `TreeWalker` to traverse text nodes rather than `.innerHTML` regexes to prevent breaking virtual DOMs natively (React/Vue).
- **Occurrence Indexing:** Saves the *Nth occurrence* of a string within the parent container to ensure only the selected text is redacted, not every identical word.
- **CSS Hardening:** Adds `user-select: none`, `background-color: black`, and `color: black` to successfully prevent copying the hidden text.
- **UX Context:** Floats a brief "Redacted ✓" confirmation pip. Safeguards visually reject cross-block boundaries to protect Restoration integrity.
- **Dynamic Content Handling:** Equips `restorer.js` with a `MutationObserver` to watch for lazy-loaded single-page content.

### The Sticky Note (Contextual Annotations)
- **Concept:** Drop persistent text notes anchored to specific elements on the page.
- **Placement & Layout:** Notes spawn intelligently in the left or right margins connected via an SVG leader line. Positions are stored as responsive percentages linked to named regions, ensuring stability across viewports.
- **Future-Proof Schema:** Note content uses a structured `comments: []` Array + `createdAt` / `updatedAt` timestamps for upcoming team threading and popup sorting workflows.
- **UI Design:** Force all notes to classic yellow for MVP to ensure immediate recognizability, scaling to customized logic later.
- **UX Protections:** Autosaves aggressively via a 1.5s debounce. The "Trash" icon utilizes an instant visual wipe paired with a 5s delayed storage removal to allow immediate "Oops, Undo" safety. Active notes are auto-elevated via a smart Z-Index state manager.
- **Presentation Mode:** `Alt+V` globally toggles the visibility of notes on the current page.

### The Highlighter (Text Annotation) 
- **Concept:** Select range of text to organically highlight it, without mutating the host DOM.
- **Architecture:** Uses the CSS Custom Highlights API (`CSS.highlights`) to inject rendering layers natively via the browser engine instead of wrapping text in `<mark>` elements (which instantly crashes React/Vue SPAs).
- **Graceful Fallbacks:** CSS.highlights is Chrome 105+. Include code comments noting this constraint.
- **Schema & Serialization:** Store the `FuzzyAnchor` of the closest block-level parent HTML element. Inside the schema, save the text node's raw string, the `occurrenceIndex`, AND the `startOffset` & `endOffset` character constraints to precisely rebuild W3C-standard text ranges internally.
- **Relationship Schema:** Prepare the schema to accept an `attachedNoteId` flag natively to support upcoming "Note on this highlight" cross-pollination.
- **UX Options:** 4-5 Pastel themes (matching sticky aesthetics). Yellow is the default, but we persist the user's last-chosen color locally to honor mental models across sessions.

### The Marking Engine (Freehand Canvas)
- **Concept:** Draw robust, scroll-safe shapes or arrows over the webpage safely.
- **Architecture:** Binds an absolute-positioned responsive transparent `<svg>` canvas mapped directly onto the `FuzzyAnchor` of the nearest underlying block element at mouse capture. By locking the SVG viewport strictly to the HTML node's boundary or percentage, panning/scrolling is decoupled from breaking the drawing alignment.
- **Compression:** Massive raw strokes collected via pointer events are ruthlessly smoothed and truncated using the Ramer-Douglas-Peucker algorithm before storage, protecting the 5MB `chrome.storage.local` cap. 
- **Smart Formatting:** The engine defaults to raw red freehand paths, but will perform elementary path geometry detection. If the 1D path calculates to a nearly straight line with a hook or arrow terminal curve, automatically snap it into a clean bezier arrow shape.
