import {chromium, Page} from '@playwright/test';
import {execSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

import {buildStorageStates, loadPersonas, newPersonaContext, Personas} from './auth.js';
import {canonicalize, compareTrees, countNodes, outline} from './a11y_diff.js';
import {installStabilizers, waitForStable} from './stabilize.js';
import {
  clearA11yDiff,
  clearVisualDiff,
  finishRunLog,
  getCurrentA11yBaseline,
  getCurrentVisualBaseline,
  openDb,
  startRunLog,
  upsertA11yDiff,
  upsertVisualDiff,
} from './storage.js';
import {compareImages} from './visual_diff.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PAGES_PATH = resolve(ROOT, 'config', 'pages.json');
const MANIFEST_PATH = resolve(ROOT, 'output', 'manifest.json');

interface PageEntry {
  id: string;
  module: string;
  path: string;
  personas: string[];
  capture?: ('visual' | 'a11y')[];
  viewport?: {width: number; height: number};
  fullPage?: boolean;
  waitFor?: string;
  mask?: string[];
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
    },
    strict: false,
  });
  return values;
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
  pageEntry: PageEntry
): Promise<{image: Buffer; width: number; height: number; tree: any}> {
  await waitForStable(page);
  const mask = (pageEntry.mask ?? []).map(sel => page.locator(sel));
  const image = await page.screenshot({
    fullPage: pageEntry.fullPage ?? true,
    mask,
    maskColor: '#ff00ff',
  });
  const {width, height} = parsePngDimensions(image);
  const tree = await captureA11yTree(page);
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

  const personas: Personas = loadPersonas();
  const pages = loadPages();
  const manifest = loadManifest();

  const db = openDb();
  const filterRepr = JSON.stringify({
    filter: filterModule, persona: filterPersona, page: filterPage, onlyVisual, onlyA11y,
  });
  const git = gitInfo();
  const runLog = startRunLog(db, {filter: filterRepr, gitHead: git.head, gitDirty: git.dirty});
  console.log(`[runner] starting (base=${baseUrl})`);

  console.log('[runner] logging in personas...');
  const storageStates = await buildStorageStates(baseUrl, personas);

  const browser = await chromium.launch({
    args: ['--font-render-hinting=none', '--disable-blink-features=AutomationControlled'],
  });

  const counts = {
    newVisual: 0, changedVisual: 0, clearedVisual: 0,
    newA11y:   0, changedA11y:   0, clearedA11y:   0,
  };

  try {
    for (const personaName of Object.keys(personas)) {
      if (filterPersona && filterPersona !== personaName) continue;
      const personaPages = pages.filter(p => p.personas.includes(personaName));
      if (personaPages.length === 0) continue;
      const ctx = await newPersonaContext(browser, baseUrl, storageStates[personaName]);
      const page = await ctx.newPage();
      await installStabilizers(page, frozen);

      for (const entry of personaPages) {
        if (filterModule && filterModule !== entry.module) continue;
        if (filterPage && filterPage !== entry.id) continue;
        const url = baseUrl + resolvePath(entry.path, manifest);
        const captureKinds = entry.capture ?? ['visual', 'a11y'];
        const doVisual = captureKinds.includes('visual') && !onlyA11y;
        const doA11y = captureKinds.includes('a11y') && !onlyVisual;

        console.log(`[runner] ${personaName} ${entry.id} -> ${url}`);
        try {
          await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30_000});
        } catch (err) {
          console.error(`  navigate failed: ${String(err)}`);
          continue;
        }

        const captured = await capture(page, entry);

        if (doVisual) {
          const baseline = getCurrentVisualBaseline(db, entry.id, personaName);
          if (!baseline) {
            upsertVisualDiff(db, {
              pageId: entry.id, persona: personaName,
              baselineId: null,
              image: captured.image, width: captured.width, height: captured.height,
              diffImage: null, pixelCount: 0, pixelPct: 0,
            });
            counts.newVisual += 1;
          } else {
            const cmp = compareImages(baseline.image, captured.image);
            if (cmp.unchanged) {
              if (clearVisualDiff(db, entry.id, personaName)) counts.clearedVisual += 1;
            } else {
              upsertVisualDiff(db, {
                pageId: entry.id, persona: personaName,
                baselineId: baseline.id,
                image: captured.image, width: captured.width, height: captured.height,
                diffImage: cmp.diffImage, pixelCount: cmp.pixelCount, pixelPct: cmp.pixelPct,
              });
              counts.changedVisual += 1;
            }
          }
        }

        if (doA11y) {
          const treeJson = canonicalize(captured.tree);
          const treeOutline = outline(captured.tree);
          const nodeCount = countNodes(captured.tree);
          const baseline = getCurrentA11yBaseline(db, entry.id, personaName);
          if (!baseline) {
            upsertA11yDiff(db, {
              pageId: entry.id, persona: personaName,
              baselineId: null,
              treeJson, outline: treeOutline, nodeCount,
              diffText: null, addedCount: 0, removedCount: 0,
            });
            counts.newA11y += 1;
          } else {
            const cmp = compareTrees(baseline.tree_json, treeJson);
            if (cmp.unchanged) {
              if (clearA11yDiff(db, entry.id, personaName)) counts.clearedA11y += 1;
            } else {
              upsertA11yDiff(db, {
                pageId: entry.id, persona: personaName,
                baselineId: baseline.id,
                treeJson, outline: treeOutline, nodeCount,
                diffText: cmp.diffText, addedCount: cmp.added, removedCount: cmp.removed,
              });
              counts.changedA11y += 1;
            }
          }
        }
      }

      await ctx.close();
    }
  } finally {
    await browser.close();
    finishRunLog(db, runLog.id, counts);
    db.close();
  }

  console.log('[runner] summary:');
  console.log(`  visual: ${counts.changedVisual} changed, ${counts.newVisual} new, ${counts.clearedVisual} cleared`);
  console.log(`  a11y  : ${counts.changedA11y} changed, ${counts.newA11y} new, ${counts.clearedA11y} cleared`);

  // Exit non-zero if there are any unresolved diffs (i.e. anything that the
  // reviewer would need to look at).
  const openDiffs = counts.changedVisual + counts.newVisual + counts.changedA11y + counts.newA11y;
  process.exit(openDiffs > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
