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
  counts: {newVisual: number; changedVisual: number; clearedVisual: number; newA11y: number; changedA11y: number; clearedA11y: number}
): void {
  db.prepare(
    `UPDATE run_log SET finished_at = ?,
       new_visual = ?, changed_visual = ?, cleared_visual = ?,
       new_a11y   = ?, changed_a11y   = ?, cleared_a11y   = ?
     WHERE id = ?`
  ).run(
    nowIso(),
    counts.newVisual, counts.changedVisual, counts.clearedVisual,
    counts.newA11y, counts.changedA11y, counts.clearedA11y,
    runId,
  );
}

// --- visual ----------------------------------------------------------------

export function getCurrentVisualBaseline(
  db: Database.Database,
  pageId: string,
  persona: string,
  browser: string,
): {id: number; image: Buffer; width: number; height: number} | null {
  const row = db.prepare(`
    SELECT id, image, width, height FROM visual_baselines
    WHERE page_id = ? AND persona = ? AND browser = ?
    ORDER BY id DESC LIMIT 1
  `).get(pageId, persona, browser) as {id: number; image: Buffer; width: number; height: number} | undefined;
  return row ?? null;
}

// Lightweight existence check used by --only-missing mode -- skips fetching the
// image blob since we only need a yes/no.
export function hasVisualBaseline(
  db: Database.Database,
  pageId: string,
  persona: string,
  browser: string,
): boolean {
  const row = db.prepare(`
    SELECT 1 FROM visual_baselines
    WHERE page_id = ? AND persona = ? AND browser = ?
    LIMIT 1
  `).get(pageId, persona, browser);
  return row !== undefined;
}

export function insertVisualBaseline(
  db: Database.Database,
  args: {pageId: string; persona: string; browser: string; image: Buffer; width: number; height: number; runLogId: number}
): void {
  db.prepare(`
    INSERT INTO visual_baselines (page_id, persona, browser, image, width, height, captured_at, run_log_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.pageId, args.persona, args.browser, args.image,
    args.width, args.height, nowIso(), args.runLogId,
  );
}

export function upsertVisualDiff(
  db: Database.Database,
  args: {
    pageId: string;
    persona: string;
    browser: string;
    baselineId: number | null;
    image: Buffer;
    width: number;
    height: number;
    diffImage: Buffer | null;
    pixelCount: number;
    pixelPct: number;
    runLogId: number;
  }
): void {
  db.prepare(`
    INSERT INTO visual_diffs (page_id, persona, browser, baseline_id, image, width, height,
                              diff_image, pixel_count, pixel_pct, captured_at, run_log_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(page_id, persona, browser) DO UPDATE SET
      baseline_id = excluded.baseline_id,
      image       = excluded.image,
      width       = excluded.width,
      height      = excluded.height,
      diff_image  = excluded.diff_image,
      pixel_count = excluded.pixel_count,
      pixel_pct   = excluded.pixel_pct,
      captured_at = excluded.captured_at,
      run_log_id  = excluded.run_log_id
  `).run(
    args.pageId, args.persona, args.browser, args.baselineId,
    args.image, args.width, args.height,
    args.diffImage, args.pixelCount, args.pixelPct, nowIso(), args.runLogId,
  );
}

export function clearVisualDiff(
  db: Database.Database,
  pageId: string,
  persona: string,
  browser: string,
): boolean {
  const r = db.prepare(
    'DELETE FROM visual_diffs WHERE page_id = ? AND persona = ? AND browser = ?'
  ).run(pageId, persona, browser);
  return r.changes > 0;
}

// --- a11y ------------------------------------------------------------------

export function getCurrentA11yBaseline(
  db: Database.Database,
  pageId: string,
  persona: string
): {id: number; tree_json: string; outline: string} | null {
  const row = db.prepare(`
    SELECT id, tree_json, outline FROM a11y_baselines
    WHERE page_id = ? AND persona = ?
    ORDER BY id DESC LIMIT 1
  `).get(pageId, persona) as {id: number; tree_json: string; outline: string} | undefined;
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
    LIMIT 1
  `).get(pageId, persona);
  return row !== undefined;
}

export function insertA11yBaseline(
  db: Database.Database,
  args: {pageId: string; persona: string; treeJson: string; outline: string; nodeCount: number; runLogId: number}
): void {
  db.prepare(`
    INSERT INTO a11y_baselines (page_id, persona, tree_json, outline, node_count, captured_at, run_log_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.pageId, args.persona, args.treeJson, args.outline,
    args.nodeCount, nowIso(), args.runLogId,
  );
}

export function upsertA11yDiff(
  db: Database.Database,
  args: {
    pageId: string;
    persona: string;
    baselineId: number | null;
    treeJson: string;
    outline: string;
    nodeCount: number;
    diffText: string | null;
    addedCount: number;
    removedCount: number;
    runLogId: number;
  }
): void {
  db.prepare(`
    INSERT INTO a11y_diffs (page_id, persona, baseline_id, tree_json, outline,
                            node_count, diff_text, added_count, removed_count, captured_at, run_log_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(page_id, persona) DO UPDATE SET
      baseline_id   = excluded.baseline_id,
      tree_json     = excluded.tree_json,
      outline       = excluded.outline,
      node_count    = excluded.node_count,
      diff_text     = excluded.diff_text,
      added_count   = excluded.added_count,
      removed_count = excluded.removed_count,
      captured_at   = excluded.captured_at,
      run_log_id    = excluded.run_log_id
  `).run(
    args.pageId, args.persona, args.baselineId,
    args.treeJson, args.outline, args.nodeCount,
    args.diffText, args.addedCount, args.removedCount, nowIso(), args.runLogId,
  );
}

export function clearA11yDiff(db: Database.Database, pageId: string, persona: string): boolean {
  const r = db.prepare('DELETE FROM a11y_diffs WHERE page_id = ? AND persona = ?')
    .run(pageId, persona);
  return r.changes > 0;
}
