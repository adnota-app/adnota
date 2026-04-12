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
