import {Browser, BrowserType, chromium, expect, firefox, Page} from '@playwright/test';
import {execSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

import {buildStorageStates, loadPersonas, newPersonaContext, Personas} from './auth.js';
import {canonicalize, compareTrees, countNodes, outline} from './a11y_diff.js';
import {installClipboardStub, installStabilizers, waitForStable} from './stabilize.js';
import {
  clearAllDiffs,
  clearScopedDiffs,
  finishRunLog,
  getCurrentA11yBaseline,
  getCurrentVisualBaseline,
  hasA11yBaseline,
  hasVisualBaseline,
  openDb,
  setA11yBaseline,
  setVisualBaseline,
  startRunLog,
  upsertA11yDiff,
  upsertVisualDiff,
} from './storage.js';
import {compareImages} from './visual_diff.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PAGES_PATH = resolve(ROOT, 'config', 'pages.json');
const MANIFEST_PATH = resolve(ROOT, 'output', 'manifest.json');

interface PageAction {
  hover?: string;
  click?: string;
  press?: string;
  fill?: {selector: string; text: string};
  // Press `key` until `selector` matches (e.g. a "...:focus" selector), up to
  // `max` times. Robust to tab-order changes: it targets a specific element
  // instead of a fixed count. Checked scenarios fail if the target is not reached;
  // older unchecked scenarios retain the fallback capture behavior. Use explicit
  // baselineActions/baselineChecks for controls that were not focusable before.
  pressUntil?: {key: string; selector: string; max?: number};
  waitFor?: string;
}

interface PageEntry {
  id: string;
  module: string;
  path: string;
  personas: string[];
  viewport?: {width: number; height: number};
  fullPage?: boolean;
  waitFor?: string;
  mask?: string[];
  actions?: PageAction[];
  baselineActions?: PageAction[];
  baselineChecks?: PageEntry['candidateChecks'];
  // Hover state to capture. Unlike `actions` (applied before stabilisation),
  // the hover is (re)applied inside capture() after waitForStable parks the
  // cursor off-screen — otherwise the parked cursor would clear it. Lets a
  // hover-revealed UI (e.g. a tooltip) be a page in its own right.
  hover?: string;
  hoverWaitFor?: string;
  // Candidate-only assertions: master may intentionally lack the fixed state.
  candidateChecks?: {
    visible?: string[];
    hidden?: string[];
    absent?: string[];
    clickable?: string[];
    settleMs?: number;
  };
  candidateAfterActions?: PageAction[];
}

async function runActions(
  page: Page,
  actions: PageAction[] | undefined,
  failOnMiss = false,
): Promise<void> {
  if (!actions) return;
  // Actions run before waitForStable, i.e. potentially before web/icon fonts have
  // loaded. A click that opens JS-positioned UI (e.g. the jQuery i-dropdown, whose
  // menu is placed relative to a font-sized toggle) would then anchor to a
  // pre-font layout and land in a different spot each run — a flaky diff. Wait for
  // fonts to settle first so the open position is deterministic.
  await page.evaluate('document.fonts && document.fonts.ready');
  for (const action of actions) {
    // A hover before a click reveals hover-gated controls (e.g. a regform field's
    // "Configure field" button, which is visibility:hidden until its row is
    // hovered). The cursor stays parked on the hovered element, so a following
    // click on the now-visible control keeps the reveal active.
    if (action.hover) await page.hover(action.hover, {timeout: 15_000});
    if (action.click) await page.click(action.click, {timeout: 15_000});
    if (action.fill) await page.fill(action.fill.selector, action.fill.text);
    // A real keyboard press (e.g. "Tab") — the only way to reach a keyboard-only
    // state such as :focus-visible, which a mouse click or programmatic .focus()
    // won't trigger.
    if (action.press) await page.keyboard.press(action.press);
    if (action.pressUntil) {
      const {key, selector, max = 12} = action.pressUntil;
      let matched = false;
      for (let i = 0; i <= max; i++) {
        if (await page.$(selector)) {
          matched = true;
          break;
        }
        if (i < max) {
          await page.keyboard.press(key);
        }
      }
      if (!matched) {
        if (failOnMiss) {
          throw new Error(`Focus target ${selector} not reached after ${max} ${key} presses`);
        }
        console.warn(
          `  pressUntil: ${selector} not matched after ${max} ${key} presses ` +
            '(capturing current state)'
        );
      }
    }
    // The waitFor often gates on async content (e.g. an export URL fetched after
    // a popup opens), so give it more room than a plain click.
    if (action.waitFor) await page.waitForSelector(action.waitFor, {timeout: 15_000});
  }
}

function loadPages(): PageEntry[] {
  return JSON.parse(readFileSync(PAGES_PATH, 'utf8'));
}

function loadManifest(): Record<string, string | number> {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

function resolvePath(template: string, manifest: Record<string, string | number>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    if (!(key in manifest)) {
      throw new Error(`No manifest entry for placeholder {${key}} in page path`);
    }
    return String(manifest[key]);
  });
}

function gitInfo(): {head: string | null; dirty: boolean} {
  try {
    const head = execSync('git rev-parse HEAD', {cwd: ROOT, encoding: 'utf8'}).trim();
    const status = execSync('git status --porcelain', {cwd: ROOT, encoding: 'utf8'});
    return {head, dirty: status.trim().length > 0};
  } catch {
    return {head: null, dirty: false};
  }
}

function parseCli() {
  const {values} = parseArgs({
    options: {
      'base-url': {type: 'string', default: 'http://indico.local:8001'},
      'frozen': {type: 'string', default: '2026-06-15T12:00:00+00:00'},
      'filter': {type: 'string'},
      'persona': {type: 'string'},
      'page': {type: 'string'},
      'only-visual': {type: 'boolean', default: false},
      'only-a11y': {type: 'boolean', default: false},
      // Capture only (page, persona, browser, modality) combos that have no
      // baseline yet, and write the result straight to *_baselines (no diff
      // row, no review step). Handles both the empty-DB first-run case and
      // incremental backfill after adding new pages/personas/scenarios.
      'only-missing': {type: 'boolean', default: false},
      // Update baseline snapshots directly from the current render (run on master).
      // Overwrites existing baselines.
      'update-baselines': {type: 'boolean', default: false},
      // Comma-separated browser list. A11y is captured in chromium only,
      // regardless of this flag — firefox has no CDP-equivalent AT-tree.
      'browser': {type: 'string', default: 'chromium,firefox'},
    },
    strict: false,
  });
  return values;
}

const BROWSER_ENGINES: Record<string, BrowserType> = {chromium, firefox};

function parseBrowsers(raw: string): string[] {
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (const name of list) {
    if (!(name in BROWSER_ENGINES)) {
      throw new Error(`Unknown browser '${name}'. Supported: ${Object.keys(BROWSER_ENGINES).join(', ')}`);
    }
  }
  if (list.length === 0) throw new Error('--browser cannot be empty');
  return list;
}

function launchArgs(browserName: string): string[] {
  // Chromium-specific knobs only. Firefox renders fonts via its own pipeline,
  // and --disable-blink-features is meaningless to non-Blink engines.
  if (browserName === 'chromium') {
    return ['--font-render-hinting=none', '--disable-blink-features=AutomationControlled'];
  }
  return [];
}

// --- a11y tree capture via CDP (Playwright 1.59 removed page.accessibility) ---

interface CDPAxNode {
  nodeId: string;
  ignored?: boolean;
  role?: {value?: string};
  name?: {value?: string};
  value?: {value?: unknown};
  description?: {value?: string};
  properties?: {name: string; value?: {value?: unknown}}[];
  childIds?: string[];
}

function buildA11yTree(nodes: CDPAxNode[]): any {
  if (!nodes.length) return null;
  const byId = new Map<string, CDPAxNode>();
  for (const n of nodes) byId.set(n.nodeId, n);

  // An ignored node has no AT-relevant identity of its own (think semantic-less
  // <div>), but its descendants may. We splice the ignored node's expansion in
  // place of itself so meaningful grandchildren aren't lost.
  const expand = (node: CDPAxNode | undefined): any[] => {
    if (!node) return [];
    const children = (node.childIds ?? []).flatMap(id => expand(byId.get(id)));
    if (node.ignored) return children;

    const out: Record<string, unknown> = {};
    if (node.role?.value) out.role = node.role.value;
    if (node.name?.value) out.name = node.name.value;
    if (node.value && node.value.value !== undefined) out.value = node.value.value;
    if (node.description?.value) out.description = node.description.value;
    if (Array.isArray(node.properties)) {
      for (const prop of node.properties) {
        if (prop.value && prop.value.value !== undefined) {
          out[prop.name] = prop.value.value;
        }
      }
    }
    if (children.length) out.children = children;
    return [out];
  };

  // First node in the CDP response is the document root; it's never ignored.
  return expand(nodes[0])[0] ?? null;
}

async function captureA11yTree(page: Page): Promise<any> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Accessibility.enable');
    const result = await cdp.send('Accessibility.getFullAXTree');
    return buildA11yTree(result.nodes as unknown as CDPAxNode[]);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function capture(
  page: Page,
  pageEntry: PageEntry,
  withA11y: boolean,
  checkCandidate: boolean,
): Promise<{image: Buffer; width: number; height: number; tree: any | undefined}> {
  await waitForStable(page);
  // Apply any hover *after* stabilisation: waitForStable parks the cursor
  // off-screen to clear stray :hover, so a hover set earlier would be gone.
  // `>> nth=0` keeps the selector single-element (no strict-mode ambiguity).
  if (pageEntry.hover) {
    // Non-fatal: a hover that fails to reveal its target shouldn't abort the
    // whole run. We still screenshot whatever state resulted, so the diff
    // surfaces the problem instead of crashing.
    try {
      await page.hover(pageEntry.hover, {timeout: 5_000});
      if (pageEntry.hoverWaitFor) {
        await page.waitForSelector(pageEntry.hoverWaitFor, {timeout: 5_000});
      }
    } catch (err) {
      console.warn(`  hover step failed for ${pageEntry.id}: ${String(err)}`);
    }
  }
  const checks = checkCandidate ? pageEntry.candidateChecks : pageEntry.baselineChecks;
  if (checks) {
    if (checks.settleMs) {
      await page.waitForTimeout(checks.settleMs);
    }
    for (const selector of checks.visible ?? []) {
      await expect(page.locator(selector)).toBeVisible();
    }
    for (const selector of checks.hidden ?? []) {
      await expect(page.locator(selector)).toBeHidden();
    }
    for (const selector of checks.absent ?? []) {
      await expect(page.locator(selector)).toHaveCount(0);
    }
    for (const selector of checks.clickable ?? []) {
      await page.locator(selector).click({trial: true});
    }
  }
  const mask = (pageEntry.mask ?? []).map(sel => page.locator(sel));
  const image = await page.screenshot({
    fullPage: pageEntry.fullPage ?? true,
    mask,
    maskColor: '#ff00ff',
  });
  const {width, height} = parsePngDimensions(image);
  // captureA11yTree uses CDP, which is chromium-only. Callers gate withA11y
  // accordingly — firefox / webkit should always pass false.
  const tree = withA11y ? await captureA11yTree(page) : undefined;
  if (checkCandidate) {
    await runActions(page, pageEntry.candidateAfterActions);
  }
  return {image, width, height, tree};
}

function parsePngDimensions(png: Buffer): {width: number; height: number} {
  if (png.length < 24) return {width: 0, height: 0};
  return {width: png.readUInt32BE(16), height: png.readUInt32BE(20)};
}

async function main() {
  const args = parseCli();
  const baseUrl = String(args['base-url']);
  const frozen = String(args.frozen);
  const filterModule = args.filter ? String(args.filter) : null;
  const filterPersona = args.persona ? String(args.persona) : null;
  const filterPage = args.page ? String(args.page) : null;
  const onlyVisual = Boolean(args['only-visual']);
  const onlyA11y = Boolean(args['only-a11y']);
  const onlyMissing = Boolean(args['only-missing']);
  const updateBaselines = Boolean(args['update-baselines']);
  const browsers = parseBrowsers(String(args.browser));

  const personas: Personas = loadPersonas();
  const pages = loadPages();
  const manifest = loadManifest();

  const db = openDb();
  const filterRepr = JSON.stringify({
    filter: filterModule, persona: filterPersona, page: filterPage,
    onlyVisual, onlyA11y, browsers, updateBaselines, onlyMissing,
  });
  const git = gitInfo();
  const runLog = startRunLog(db, {filter: filterRepr, gitHead: git.head, gitDirty: git.dirty});
  console.log(`[runner] starting (base=${baseUrl}, browsers=${browsers.join(',')})`);

  // Clear older transient diffs for the targeted scope so this run only surfaces
  // its own diffs.
  const matchingPageIds = pages
    .filter(p => (!filterModule || p.module === filterModule) && (!filterPage || p.id === filterPage))
    .map(p => p.id);
  clearScopedDiffs(db, {
    pageIds: matchingPageIds,
    persona: filterPersona ?? undefined,
    browser: browsers.length === 1 ? browsers[0] : undefined,
  });

  console.log('[runner] logging in personas...');
  const storageStates = await buildStorageStates(baseUrl, personas);

  const counts = {
    newVisual: 0, changedVisual: 0,
    newA11y:   0, changedA11y:   0,
  };
  let failedChecks = 0;

  for (const browserName of browsers) {
    // A11y is captured in chromium only — firefox has no CDP-equivalent for
    // Accessibility.getFullAXTree, so trying to run a11y-only against firefox
    // would do nothing. Visual works in both.
    const doA11yForBrowser = browserName === 'chromium' && !onlyVisual;
    const doVisualForBrowser = !onlyA11y;
    if (!doA11yForBrowser && !doVisualForBrowser) {
      console.log(`[runner] skipping ${browserName}: nothing to capture (--only-a11y on a non-chromium engine)`);
      continue;
    }

    console.log(`[runner] === ${browserName} ===`);
    const browser: Browser = await BROWSER_ENGINES[browserName].launch({
      args: launchArgs(browserName),
    });

    try {
      for (const personaName of Object.keys(personas)) {
        if (filterPersona && filterPersona !== personaName) continue;
        const personaPages = pages.filter(p => p.personas.includes(personaName));
        if (personaPages.length === 0) continue;
        const ctx = await newPersonaContext(browser, baseUrl, storageStates[personaName]);
        const page = await ctx.newPage();
        await installStabilizers(page, frozen);
        await installClipboardStub(page);

        for (const entry of personaPages) {
          if (filterModule && filterModule !== entry.module) continue;
          if (filterPage && filterPage !== entry.id) continue;
          const url = baseUrl + resolvePath(entry.path, manifest);
          // Every page captures both modalities; the only gates are the
          // engine (a11y is chromium-only) and the run-level --only-* flags.
          let doVisual = doVisualForBrowser;
          let doA11y = doA11yForBrowser;
          if (!doVisual && !doA11y) continue;

          // In --only-missing mode we skip combos that already have a baseline
          // and write the captured result straight to *_baselines. This is
          // both the first-run flow (empty DB → everything is "missing") and
          // the incremental backfill flow after adding pages/personas/scenarios.
          if (onlyMissing) {
            if (doVisual && hasVisualBaseline(db, entry.id, personaName, browserName)) doVisual = false;
            if (doA11y && hasA11yBaseline(db, entry.id, personaName)) doA11y = false;
            if (!doVisual && !doA11y) {
              console.log(`[runner] [${browserName}] ${personaName} ${entry.id} — already baselined, skipping`);
              continue;
            }
          }

          console.log(`[runner] [${browserName}] ${personaName} ${entry.id} -> ${url}`);
          try {
            await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30_000});
          } catch (err) {
            console.error(`  navigate failed: ${String(err)}`);
            if (entry.candidateChecks) failedChecks++;
            continue;
          }

          // Non-fatal: if the page's setup actions (e.g. opening a popup) fail,
          // skip just this page rather than letting the throw abort the whole
          // browser run — which would silently skip baselines for every page
          // after it.
          try {
            const actions = updateBaselines || onlyMissing
              ? entry.baselineActions ?? entry.actions
              : entry.actions;
            await runActions(page, actions, Boolean(entry.candidateChecks || entry.baselineChecks));
          } catch (err) {
            if (entry.candidateChecks) failedChecks++;
            console.warn(`  actions failed for ${entry.id}: ${String(err)} — skipping page`);
            continue;
          }

          let captured;
          try {
            captured = await capture(page, entry, doA11y, !updateBaselines && !onlyMissing);
          } catch (err) {
            failedChecks++;
            console.error(`  capture failed for ${entry.id}: ${String(err)}`);
            continue;
          }

          if (doVisual) {
            if (updateBaselines || onlyMissing) {
              setVisualBaseline(db, {
                pageId: entry.id, persona: personaName, browser: browserName,
                image: captured.image, width: captured.width, height: captured.height,
              });
              counts.newVisual += 1;
            } else {
              const baseline = getCurrentVisualBaseline(db, entry.id, personaName, browserName);
              if (!baseline) {
                upsertVisualDiff(db, {
                  pageId: entry.id, persona: personaName, browser: browserName,
                  hasBaseline: false,
                  image: captured.image, width: captured.width, height: captured.height,
                  diffImage: null, pixelCount: 0, pixelPct: 0,
                });
                counts.newVisual += 1;
              } else {
                const cmp = compareImages(baseline.image, captured.image);
                if (!cmp.unchanged) {
                  upsertVisualDiff(db, {
                    pageId: entry.id, persona: personaName, browser: browserName,
                    hasBaseline: true,
                    image: captured.image, width: captured.width, height: captured.height,
                    diffImage: cmp.diffImage, pixelCount: cmp.pixelCount, pixelPct: cmp.pixelPct,
                  });
                  counts.changedVisual += 1;
                }
              }
            }
          }

          if (doA11y && captured.tree !== undefined) {
            const treeJson = canonicalize(captured.tree);
            const treeOutline = outline(captured.tree);
            const nodeCount = countNodes(captured.tree);
            if (updateBaselines || onlyMissing) {
              setA11yBaseline(db, {
                pageId: entry.id, persona: personaName,
                treeJson, outline: treeOutline, nodeCount,
              });
              counts.newA11y += 1;
            } else {
              const baseline = getCurrentA11yBaseline(db, entry.id, personaName);
              if (!baseline) {
                upsertA11yDiff(db, {
                  pageId: entry.id, persona: personaName,
                  hasBaseline: false,
                  treeJson, outline: treeOutline, nodeCount,
                  diffText: null, addedCount: 0, removedCount: 0,
                });
                counts.newA11y += 1;
              } else {
                const cmp = compareTrees(baseline.tree_json, treeJson);
                if (!cmp.unchanged) {
                  upsertA11yDiff(db, {
                    pageId: entry.id, persona: personaName,
                    hasBaseline: true,
                    treeJson, outline: treeOutline, nodeCount,
                    diffText: cmp.diffText, addedCount: cmp.added, removedCount: cmp.removed,
                  });
                  counts.changedA11y += 1;
                }
              }
            }
          }
        }

        await ctx.close();
      }
    } finally {
      await browser.close();
    }
  }

  finishRunLog(db, runLog.id, counts);
  db.close();

  console.log('[runner] summary:');
  if (updateBaselines) {
    console.log(`  visual: ${counts.newVisual} baseline(s) updated`);
    console.log(`  a11y  : ${counts.newA11y} baseline(s) updated`);
  } else if (onlyMissing) {
    console.log(`  visual: ${counts.newVisual} new baseline(s)`);
    console.log(`  a11y  : ${counts.newA11y} new baseline(s)`);
  } else {
    console.log(`  visual: ${counts.changedVisual} changed, ${counts.newVisual} new`);
    console.log(`  a11y  : ${counts.changedA11y} changed, ${counts.newA11y} new`);
  }

  if (failedChecks) {
    console.error(`  failed checks: ${failedChecks}`);
    process.exit(2);
  }
  if (updateBaselines || onlyMissing) process.exit(0);
  const openDiffs = counts.changedVisual + counts.newVisual + counts.changedA11y + counts.newA11y;
  process.exit(openDiffs > 0 ? 3 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
