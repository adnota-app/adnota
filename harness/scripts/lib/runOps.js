// Translates the typed op vocabulary in fixtures/<site>/ops.json into Playwright
// actions. Every op that simulates user input goes through native page.mouse /
// locator primitives so the extension's content scripts see the same event
// pipeline they'd see in production (capture-phase listeners, focus transfers,
// modifier-key state).

const HANDLE_CLASSES = {
  left:   'adnota-resizer-handle-left',
  right:  'adnota-resizer-handle-right',
  top:    'adnota-resizer-handle-top',
  bottom: 'adnota-resizer-handle-bottom',
  corner: 'adnota-resizer-handle-corner',
};

export async function runOps(page, ops) {
  for (const op of ops) await runOne(page, op);
}

async function runOne(page, op) {
  switch (op.type) {
    case 'wait':
      await page.waitForTimeout(op.ms);
      return;

    case 'waitForDock':
      await page.locator('#adnota-dock').waitFor({ state: 'visible', timeout: op.timeout ?? 10000 });
      return;

    case 'activateTool': {
      const dock = page.locator('#adnota-dock');
      await dock.waitFor({ state: 'visible', timeout: 10000 });
      // Idle dock collapses to the logo; hover blooms the row open so tool
      // buttons become hittable. The max-width transition runs ~250ms.
      await dock.hover();
      await page.waitForTimeout(300);
      await page.locator(`#adnota-dock [data-tool-id="${op.tool}"]`).click();
      // Tool overlay / hover handler installs synchronously on mode change,
      // but allow a frame for paint so subsequent hovers find the overlay.
      await page.waitForTimeout(150);
      return;
    }

    case 'hoverElement': {
      const target = page.locator(op.selector).first();
      await target.waitFor({ state: 'visible', timeout: op.timeout ?? 5000 });
      await target.hover();
      // Resizer's hover handlers are rAF-throttled; one frame is enough.
      await page.waitForTimeout(50);
      return;
    }

    case 'clickToSelect': {
      // Resizer hover overlay is pointer-events:none, so a click at the current
      // mouse position passes through to the underlying element and the
      // resizer's mousedown listener picks it up.
      await page.mouse.down();
      await page.mouse.up();

      // expectedSelection === null  -> recorded as a deselect-only click.
      // expectedSelection === {...}  -> recorded with a selection identity to verify.
      // expectedSelection === undefined (legacy ops.json without snapshot) ->
      //   best-effort wait, no strict check.
      if (op.expectedSelection === null) {
        await page.waitForTimeout(120);
        return;
      }

      if (op.expectedSelection) {
        try {
          await page.locator('.adnota-resizer-selection').waitFor({ state: 'visible', timeout: 3000 });
        } catch {
          throw new Error(
            `clickToSelect: expected a selection (text="${op.expectedSelection.text?.slice(0, 40)}…" ` +
            `${op.expectedSelection.w}×${op.expectedSelection.h}) but no .adnota-resizer-selection appeared`
          );
        }

        const actual = await page.evaluate(() => {
          const box = document.querySelector('.adnota-resizer-selection');
          if (!box) return null;
          const r = box.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const stack = document.elementsFromPoint(cx, cy);
          const target = stack.find(el => !el.closest('[data-adnota-ui]'));
          return {
            text: target ? (target.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) : null,
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        });

        if (!actual) {
          throw new Error(`clickToSelect: selection box vanished before identity check`);
        }

        // Dimensions: ±20% or ±20px, whichever is larger. Permissive enough
        // for daily layout shifts on rotating content (bing carousel, news
        // feeds) but tight enough to catch a wrong element.
        const tolW = Math.max(20, op.expectedSelection.w * 0.2);
        const tolH = Math.max(20, op.expectedSelection.h * 0.2);
        const dimOk = Math.abs(actual.w - op.expectedSelection.w) <= tolW
                   && Math.abs(actual.h - op.expectedSelection.h) <= tolH;

        if (!dimOk) {
          throw new Error(
            `clickToSelect: selected the wrong element\n` +
            `    expected: ${op.expectedSelection.w}×${op.expectedSelection.h}  text="${op.expectedSelection.text?.slice(0, 60)}"\n` +
            `    actual:   ${actual.w}×${actual.h}  text="${actual.text?.slice(0, 60)}"`
          );
        }
        await page.waitForTimeout(120);
        return;
      }

      // Legacy path — best-effort wait, no verification.
      try {
        await page.locator('.adnota-resizer-selection').waitFor({ state: 'visible', timeout: 1500 });
      } catch {}
      await page.waitForTimeout(120);
      return;
    }

    case 'dragHandle': {
      const cls = HANDLE_CLASSES[op.handle];
      if (!cls) throw new Error(`Unknown handle: ${op.handle}`);
      const handle = page.locator(`.${cls}`);
      const box = await handle.boundingBox();
      if (!box) throw new Error(`Handle ${op.handle} not visible`);
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;
      const dx = op.dx ?? 0;
      const dy = op.dy ?? 0;
      // Stepwise so the resizer's onMove fires several times mid-drag, matching
      // a real pointer drag rather than a single jump.
      const steps = op.steps ?? 12;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(startX + (dx * i) / steps, startY + (dy * i) / steps);
      }
      await page.mouse.up();
      await page.waitForTimeout(200);
      // Drag should have written into the override style tag. Empty here means
      // the drag never committed (under-threshold delta, lost capture, etc.).
      const ov = await page.evaluate(() => document.getElementById('adnota-style-overrides')?.textContent || '');
      if (!ov.trim()) throw new Error('dragHandle: <style id="adnota-style-overrides"> is empty — drag did not commit a rule');
      return;
    }

    case 'screenshot': {
      await page.screenshot({ path: op.path, fullPage: !!op.fullPage });
      return;
    }

    case 'pressKey': {
      // Translate our recorder's pressKey shape into Playwright's keyboard.press
      // syntax (e.g., "Alt+a", "Control+z", "Escape").
      let combo = '';
      if (op.alt)   combo += 'Alt+';
      if (op.ctrl)  combo += 'Control+';
      if (op.meta)  combo += 'Meta+';
      if (op.shift) combo += 'Shift+';
      combo += op.key.length === 1 ? op.key : op.key;
      await page.keyboard.press(combo);
      // Tool activations and dock toggles trigger overlays/state changes;
      // give them a frame to settle before the next op.
      await page.waitForTimeout(150);
      return;
    }

    default:
      throw new Error(`Unknown op type: ${op.type}`);
  }
}
