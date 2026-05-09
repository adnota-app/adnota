# Adnota regression harness

Snapshot-style regression testing for the Adnota Chrome extension. Each fixture
scripts a sequence of user-level operations against a real site, captures the
resulting world state, and pins it. Subsequent runs replay the same ops against
the current extension code and diff against the pinned outcome.

## Quick start

Three interactive wrappers cover almost everything:

```
# CREATE a test (snapshot + record + auto-capture)
./record-test.sh

# WATCH or RUN tests (single fixture or full suite)
./replay-test.sh

# DELETE a test (removes the fixture dir AND the sites.json entry)
./delete-test.sh
```

`record-test.sh` prompts for a test name and (first time only) a URL with
`https://www.bing.com/` as the default. It snapshots the page so the test
runs against a bit-stable copy, then opens the browser for you to perform
the workflow. Stop with Alt+Shift+S in the browser. ops.json and
outcomes.json are pinned in one go.

`replay-test.sh` lists what's available, prompts for a name, and runs.
Hitting Enter at the prompt runs the full suite.

If you want the underlying scripts directly:

```
node scripts/snapshot.js --site=<id> --url='<live-url>'
node scripts/record.js   --site=<id> --url='fixture://<id>'   # against snapshot
node scripts/record.js   --site=<id> --url='<live-url>'       # against live site
node scripts/capture.js  --site=<id>                          # re-pin baseline
node scripts/replay.js   --site=<id>                          # one fixture
node scripts/replay.js                                        # full suite
```

Quote URLs — zsh treats `?` and `&` as special.

The `fixture://<id>` URL scheme tells the harness to spawn a localhost
HTTP server serving the saved `fixtures/<id>/page.html` and use that for
navigation. Live URLs (`http(s)://...`) work as before.

## Layout

```
harness/
  package.json
  sites.json                  index of fixtures
  scripts/
    capture.js                one-time: run ops, write outcomes.json
    replay.js                 CI/dev: run ops, diff vs outcomes.json
    lib/
      loadExtension.js        boots Chromium with the unpacked extension loaded
      runOps.js               op vocabulary -> Playwright actions
      captureState.js         storage + style overrides + DOM invariants
      diff.js                 structural diff for captured state
  fixtures/
    bing/
      ops.json                the script
      outcomes.json           pinned baseline (written by capture.js)
      notes.md                why this is pinned, links to commits/PRs
```

## Setup

```
cd harness
npm install
npx playwright install chromium
```

Headed browser is required because MV3 extensions don't load reliably in
headless mode.

## Running

`record.js` opens a real browser and watches your interactions. A red `● REC`
pill in the top-left of the page confirms the recorder is live and pulses on
each meaningful event. When you're done, press **Alt+Shift+S** inside the
browser (preferred — doesn't go through OS signal handling), or **Ctrl+C** in
the terminal as a backup. The pill flips to green `● saved` on Alt+Shift+S.

The recorder writes `ops.json` from your interactions and then automatically
runs capture so `outcomes.json` is pinned in the same step. Add `--no-capture`
to review `ops.json` before pinning.

Re-pin the baseline for an existing fixture:

```
node scripts/capture.js --site=<id>
```

Replay one fixture (diffs against pinned `outcomes.json`, exit 1 on drift):

```
node scripts/replay.js --site=<id>
```

Replay every fixture (the full suite — same as `--site=all`):

```
node scripts/replay.js
```

## Op vocabulary

| op             | fields                          | what it does                                                |
|----------------|---------------------------------|-------------------------------------------------------------|
| `wait`         | `ms`                            | Sleep                                                       |
| `waitForDock`  | optional `timeout`              | Block until `#adnota-dock` is visible                       |
| `activateTool` | `tool` (`resizer`/`eraser`/...) | Hover dock, click the matching tool button                  |
| `hoverElement` | `selector`, optional `timeout`  | Move pointer over the first match                           |
| `clickToSelect`|                                 | Mouse down + up at the current pointer position             |
| `dragHandle`   | `handle`, `dx`, `dy`, `steps`   | Drag a resizer handle (left/right/top/bottom/corner)        |

Pointer events are dispatched through Playwright's native `page.mouse` /
`locator.hover` so the extension's content scripts see the same event pipeline
they would in a user session (capture-phase listeners, modifier-key state,
focus transfers).

## Fixture schema

`ops.json`:

```jsonc
{
  "url": "https://www.example.com/",
  "viewport": { "width": 1280, "height": 900 },
  "settleMs": 2500,                    // wait after navigation before ops
  "postSettleMs": 400,                 // wait after ops before capture
  "ops": [ ... ],                      // see op vocabulary
  "domInvariants": [
    { "name": "page-scrollable", "expr": "document.scrollingElement.scrollHeight > window.innerHeight" }
  ]
}
```

`outcomes.json` (generated by `capture.js`):

```jsonc
{
  "$schema": "1",
  "site": "bing",
  "pinnedAt": "2026-05-08",
  "storage": { /* chrome.storage.local with _id and timestamps redacted */ },
  "styleOverrides": "...",             // <style id="adnota-style-overrides"> contents
  "eraseOverrides": "...",             // <style id="adnota-erase-overrides"> contents
  "domInvariants": [ { "name": "...", "expr": "...", "result": true } ]
}
```

`_id`, `timestamp`, `createdAt`, and `updatedAt` are normalized to placeholder
strings before write so per-run nondeterminism doesn't show up as drift.

## Adding a site

The recorded path (preferred):

```
node scripts/record.js --site=<id> --url='<url>'
```

This adds the entry to `sites.json`, writes `ops.json` from your live
interactions, and runs capture to produce `outcomes.json`. Hand-author a
`notes.md` linking the commit/PR this pinning protects.

The hand-authored path:

1. Create `fixtures/<id>/ops.json` with the op script and invariants.
2. Add `{ "id": "<id>", "fixture": "fixtures/<id>" }` to `sites.json`.
3. Run `node scripts/capture.js --site=<id>` to write `outcomes.json`.
4. Sanity-check the captured state, then write a `notes.md` linking to the
   commit/PR this pinning protects.
5. Commit all three artifacts together.

## How recording works

`record.js` injects a small shim into every page via Playwright's
`addInitScript`. The shim listens to `pointermove` / `pointerdown` /
`pointerup` / `keydown` in capture phase and streams each event to stdout via
`console.log` with an `[ADNOTA_RECORD]` prefix. The Node side captures the
stream via `context.on('console')` so events survive in-page navigations.

The reducer (`lib/reduceRecording.js`) walks the raw stream and emits the
typed op vocabulary:

- A click on a `[data-tool-id="X"]` dock button → `activateTool`
- A pointerdown on `.adnota-resizer-handle-<axis>` with travel → `dragHandle`
- A short click on a non-Adnota element → `hoverElement` + `clickToSelect`,
  with the selector taken from the most recent pre-click hover (matches the
  resizer's own `hoveredEl` semantics)

Anything outside those patterns is dropped with a warning so you can
hand-edit `ops.json` for the long tail. `domInvariants[]` is always written
as an empty array — invariants are still authored by hand because they're
the part that says *why* the captured state means "bug fixed".
