import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DB_PATH = resolve(ROOT, 'baselines.db');
const SCHEMA_PATH = resolve(ROOT, 'storage', 'schema.sql');

export function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

export interface RunLogRow {
  id: number;
}

export function startRunLog(
  db: Database.Database,
  args: {filter: string | null; gitHead: string | null; gitDirty: boolean}
): RunLogRow {
  const r = db.prepare(
    'INSERT INTO run_log (started_at, filter, git_head, git_dirty) VALUES (?, ?, ?, ?)'
  ).run(nowIso(), args.filter, args.gitHead, args.gitDirty ? 1 : 0);
  return {id: Number(r.lastInsertRowid)};
}

export function finishRunLog(
  db: Database.Database,
  runId: number,
  counts: {newVisual: number; changedVisual: number; newA11y: number; changedA11y: number}
): void {
  db.prepare(
    `UPDATE run_log SET finished_at = ?,
       new_visual = ?, changed_visual = ?,
       new_a11y   = ?, changed_a11y   = ?
     WHERE id = ?`
  ).run(
    nowIso(),
    counts.newVisual, counts.changedVisual,
    counts.newA11y, counts.changedA11y,
    runId,
  );
}

// --- visual ----------------------------------------------------------------

export function getCurrentVisualBaseline(
  db: Database.Database,
  pageId: string,
  persona: string,
  browser: string,
): {image: Buffer; width: number; height: number} | null {
  const row = db.prepare(`
    SELECT image, width, height FROM visual_baselines
    WHERE page_id = ? AND persona = ? AND browser = ?
  `).get(pageId, persona, browser) as {image: Buffer; width: number; height: number} | undefined;
  return row ?? null;
}

export function hasVisualBaseline(
  db: Database.Database,
  pageId: string,
  persona: string,
  browser: string,
): boolean {
  const row = db.prepare(`
    SELECT 1 FROM visual_baselines
    WHERE page_id = ? AND persona = ? AND browser = ?
  `).get(pageId, persona, browser);
  return row !== undefined;
}

export function setVisualBaseline(
  db: Database.Database,
  args: {pageId: string; persona: string; browser: string; image: Buffer; width: number; height: number}
): void {
  db.prepare(`
    INSERT OR REPLACE INTO visual_baselines (page_id, persona, browser, image, width, height, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.pageId, args.persona, args.browser, args.image,
    args.width, args.height, nowIso(),
  );
}

export function upsertVisualDiff(
  db: Database.Database,
  args: {
    pageId: string;
    persona: string;
    browser: string;
    hasBaseline: boolean;
    image: Buffer;
    width: number;
    height: number;
    diffImage: Buffer | null;
    pixelCount: number;
    pixelPct: number;
  }
): void {
  db.prepare(`
    INSERT OR REPLACE INTO visual_diffs (page_id, persona, browser, has_baseline, image, width, height,
                                         diff_image, pixel_count, pixel_pct, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.pageId, args.persona, args.browser, args.hasBaseline ? 1 : 0,
    args.image, args.width, args.height,
    args.diffImage, args.pixelCount, args.pixelPct, nowIso(),
  );
}

// --- a11y ------------------------------------------------------------------

export function getCurrentA11yBaseline(
  db: Database.Database,
  pageId: string,
  persona: string
): {tree_json: string; outline: string} | null {
  const row = db.prepare(`
    SELECT tree_json, outline FROM a11y_baselines
    WHERE page_id = ? AND persona = ?
  `).get(pageId, persona) as {tree_json: string; outline: string} | undefined;
  return row ?? null;
}

export function hasA11yBaseline(
  db: Database.Database,
  pageId: string,
  persona: string,
): boolean {
  const row = db.prepare(`
    SELECT 1 FROM a11y_baselines
    WHERE page_id = ? AND persona = ?
  `).get(pageId, persona);
  return row !== undefined;
}

export function setA11yBaseline(
  db: Database.Database,
  args: {pageId: string; persona: string; treeJson: string; outline: string; nodeCount: number}
): void {
  db.prepare(`
    INSERT OR REPLACE INTO a11y_baselines (page_id, persona, tree_json, outline, node_count, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    args.pageId, args.persona, args.treeJson, args.outline,
    args.nodeCount, nowIso(),
  );
}

export function upsertA11yDiff(
  db: Database.Database,
  args: {
    pageId: string;
    persona: string;
    hasBaseline: boolean;
    treeJson: string;
    outline: string;
    nodeCount: number;
    diffText: string | null;
    addedCount: number;
    removedCount: number;
  }
): void {
  db.prepare(`
    INSERT OR REPLACE INTO a11y_diffs (page_id, persona, has_baseline, tree_json, outline,
                                       node_count, diff_text, added_count, removed_count, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.pageId, args.persona, args.hasBaseline ? 1 : 0,
    args.treeJson, args.outline, args.nodeCount,
    args.diffText, args.addedCount, args.removedCount, nowIso(),
  );
}

// --- diff clearing (at run start) ------------------------------------------

export function clearAllDiffs(db: Database.Database): void {
  db.exec('DELETE FROM visual_diffs; DELETE FROM a11y_diffs;');
}

export function clearScopedDiffs(
  db: Database.Database,
  args: {pageIds?: string[]; persona?: string; browser?: string}
): void {
  if (!args.pageIds?.length && !args.persona && !args.browser) {
    clearAllDiffs(db);
    return;
  }
  const conditions: string[] = [];
  const params: any[] = [];
  if (args.pageIds && args.pageIds.length > 0) {
    const placeholders = args.pageIds.map(() => '?').join(',');
    conditions.push(`page_id IN (${placeholders})`);
    params.push(...args.pageIds);
  }
  if (args.persona) {
    conditions.push('persona = ?');
    params.push(args.persona);
  }

  const vConditions = [...conditions];
  const vParams = [...params];
  if (args.browser) {
    vConditions.push('browser = ?');
    vParams.push(args.browser);
  }

  const vWhere = vConditions.length ? `WHERE ${vConditions.join(' AND ')}` : '';
  db.prepare(`DELETE FROM visual_diffs ${vWhere}`).run(...vParams);

  if (!args.browser || args.browser.includes('chromium')) {
    const aWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    db.prepare(`DELETE FROM a11y_diffs ${aWhere}`).run(...params);
  }
}
