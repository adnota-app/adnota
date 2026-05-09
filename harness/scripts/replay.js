// Replay fixture ops against the current code and diff against pinned
// outcomes.json. Exit 0 if all sites pass, 1 on drift, 2 on setup error.
//
// Usage:
//   node scripts/replay.js                  # run every site in sites.json
//   node scripts/replay.js --site=<id>      # run one site
//   node scripts/replay.js --site=all       # same as no flag

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchWithExtension, teardown, getWorker } from './lib/loadExtension.js';
import { runOps } from './lib/runOps.js';
import { captureState } from './lib/captureState.js';
import { diffState, formatDiffs } from './lib/diff.js';
import { resolveOpsUrl } from './lib/resolveUrl.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const sites = JSON.parse(await fs.readFile(path.join(HARNESS_DIR, 'sites.json'), 'utf8'));

if (!sites.sites.length) {
  console.error('No sites in sites.json. Record one with: node scripts/record.js --site=<id> --url=<url>');
  process.exit(2);
}

let toRun;
if (!args.site || args.site === 'all') {
  toRun = sites.sites;
} else {
  const site = sites.sites.find(s => s.id === args.site);
  if (!site) {
    console.error(`Unknown site "${args.site}". Known: ${sites.sites.map(s => s.id).join(', ')}`);
    process.exit(2);
  }
  toRun = [site];
}

const results = [];
for (const site of toRun) {
  results.push(await replayOne(site));
}

// Summary when running more than one
if (toRun.length > 1) {
  console.log('');
  console.log('─── summary ───');
  for (const r of results) {
    const tag = r.status === 'pass' ? 'PASS'
              : r.status === 'fail' ? 'FAIL'
              : r.status === 'missing' ? 'SKIP'
              : 'ERROR';
    console.log(`  ${tag.padEnd(5)} ${r.siteId}${r.status === 'missing' ? ' (no outcomes.json — run capture first)' : ''}`);
  }
  const failed = results.filter(r => r.status === 'fail' || r.status === 'error').length;
  const passed = results.filter(r => r.status === 'pass').length;
  const skipped = results.filter(r => r.status === 'missing').length;
  console.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped`);
}

const anyFailed = results.some(r => r.status === 'fail' || r.status === 'error');
process.exit(anyFailed ? 1 : 0);


async function replayOne(site) {
  const siteId = site.id;
  const fixtureDir = path.join(HARNESS_DIR, site.fixture);
  const opsPath = path.join(fixtureDir, 'ops.json');
  const outcomesPath = path.join(fixtureDir, 'outcomes.json');

  // Friendly preflight checks — the raw ENOENT crash these used to throw was
  // hostile to users who recorded but never ran capture.
  let ops, expected;
  try {
    ops = JSON.parse(await fs.readFile(opsPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`[replay:${siteId}] no ops.json at ${path.relative(HARNESS_DIR, opsPath)}`);
      console.error(`    record one with: node scripts/record.js --site=${siteId} --url='<url>'`);
      return { siteId, status: 'error' };
    }
    throw err;
  }
  try {
    expected = JSON.parse(await fs.readFile(outcomesPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`[replay:${siteId}] no outcomes.json yet — pin a baseline first:`);
      console.error(`    node scripts/capture.js --site=${siteId}`);
      return { siteId, status: 'missing' };
    }
    throw err;
  }

  const resolved = await resolveOpsUrl(ops.url, HARNESS_DIR);

  console.log(`[replay:${siteId}] launching browser with extension`);
  const session = await launchWithExtension({ viewport: ops.viewport });

  try {
    const page = await session.context.newPage();
    console.log(`[replay:${siteId}] navigating to ${ops.url}${resolved.url !== ops.url ? ` (served from ${resolved.url})` : ''}`);
    await page.goto(resolved.url, { waitUntil: 'domcontentloaded' });

    if (ops.settleMs) await page.waitForTimeout(ops.settleMs);

    // Same anti-autofocus blur as capture.js — keeps hovers reaching their
    // targets on pages with autofocused search boxes (Bing) etc.
    await page.evaluate(() => document.activeElement?.blur?.()).catch(() => {});

    console.log(`[replay:${siteId}] running ${ops.ops.length} ops`);
    await runOps(page, ops.ops);

    if (ops.postSettleMs) await page.waitForTimeout(ops.postSettleMs);

    const worker = await getWorker(session.context, page);
    const actual = await captureState({
      page,
      worker,
      domInvariants: ops.domInvariants ?? [],
    });

    const expectedShape = {
      storage: expected.storage,
      styleOverrides: expected.styleOverrides,
      eraseOverrides: expected.eraseOverrides,
      domInvariants: expected.domInvariants,
    };

    const diffs = diffState(expectedShape, actual);
    const invariantFails = actual.domInvariants.filter(i => i.result === false || (i.result && typeof i.result === 'object' && i.result.error));

    if (diffs.length === 0 && invariantFails.length === 0) {
      console.log(`[replay:${siteId}] PASS`);
      console.log(`  invariants: ${actual.domInvariants.map(i => `${i.name}=${JSON.stringify(i.result)}`).join(', ') || '(none)'}`);
      return { siteId, status: 'pass' };
    }

    console.error(`[replay:${siteId}] FAIL`);
    if (invariantFails.length) {
      console.error('\nFailed invariants:');
      for (const inv of invariantFails) {
        console.error(`  ${inv.name}: result=${JSON.stringify(inv.result)}`);
        console.error(`    expr: ${inv.expr}`);
      }
    }
    if (diffs.length) {
      console.error(`\nState drift (${diffs.length} difference${diffs.length === 1 ? '' : 's'}):`);
      console.error(formatDiffs(diffs));
    }
    return { siteId, status: 'fail' };
  } catch (err) {
    console.error(`[replay:${siteId}] ERROR:`, err);
    try {
      const pages = session.context.pages();
      if (pages.length) {
        const debugPath = path.join(fixtureDir, 'replay-debug.png');
        await pages[0].screenshot({ path: debugPath, fullPage: true });
        console.error(`[replay:${siteId}] debug screenshot: ${path.relative(HARNESS_DIR, debugPath)}`);
      }
    } catch {}
    return { siteId, status: 'error' };
  } finally {
    await teardown(session);
    await resolved.stop();
  }
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}
