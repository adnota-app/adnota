# Vellum MVP: The Persistent Canvas (Eraser & Local Sync)

Vellum is a Manifest V3 Chrome Extension that allows users to permanently delete distracting elements from any webpage ("The Eraser"). For the MVP, these changes will be persisted entirely locally (`chrome.storage.local`), ensuring privacy and a fast iteration cycle before introducing cloud sync.

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
- **Selector Drift Check**: Modify the DOM slightly in DevTools to ensure the Fuzzy Anchor successfully finds the element.
- **Threshold Check**: Break an anchor drastically in DevTools to trigger the <70% match condition and ensure the amber confirmation highlight appears. Check popup for "Broken Anchor" state.
