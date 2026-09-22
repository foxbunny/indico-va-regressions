"""SQLite storage helpers — single-snapshot baseline model.

Model:
  *_baselines : canonical current snapshot of master (one row per key)
  *_diffs     : transient read-only diffs produced by the latest test run

Visual uses (page_id, persona, browser).
A11y uses (page_id, persona).
"""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / 'baselines.db'
SCHEMA_PATH = Path(__file__).resolve().parent / 'schema.sql'


def now_iso():
    return datetime.now(UTC).isoformat(timespec='seconds')


def connect(db_path=None):
    conn = sqlite3.connect(str(db_path or DB_PATH))
    conn.execute('PRAGMA foreign_keys = ON')
    conn.row_factory = sqlite3.Row
    return conn


def apply_schema(conn):
    _migrate(conn)
    conn.executescript(SCHEMA_PATH.read_text())
    conn.commit()


def _migrate(conn):
    def tables():
        return {r['name'] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    def cols(table):
        if table not in tables():
            return set()
        return {r['name'] for r in conn.execute(f'PRAGMA table_info({table})')}

    # If the old visual_baselines table with an auto-incrementing 'id' exists,
    # migrate only the latest row for each key to the new single-row schema.
    if 'id' in cols('visual_baselines'):
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS visual_baselines_new (
                page_id      TEXT NOT NULL,
                persona      TEXT NOT NULL,
                browser      TEXT NOT NULL DEFAULT 'chromium',
                image        BLOB NOT NULL,
                width        INTEGER NOT NULL,
                height       INTEGER NOT NULL,
                captured_at  TEXT NOT NULL,
                PRIMARY KEY (page_id, persona, browser)
            );

            INSERT OR REPLACE INTO visual_baselines_new (page_id, persona, browser, image, width, height, captured_at)
            SELECT page_id, persona, browser, image, width, height, captured_at
            FROM visual_baselines b
            WHERE b.id = (
                SELECT MAX(id) FROM visual_baselines
                WHERE page_id = b.page_id AND persona = b.persona AND browser = b.browser
            );

            DROP TABLE visual_baselines;
            ALTER TABLE visual_baselines_new RENAME TO visual_baselines;
        ''')

    if 'id' in cols('a11y_baselines'):
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS a11y_baselines_new (
                page_id      TEXT NOT NULL,
                persona      TEXT NOT NULL,
                tree_json    TEXT NOT NULL,
                outline      TEXT NOT NULL,
                node_count   INTEGER NOT NULL,
                captured_at  TEXT NOT NULL,
                PRIMARY KEY (page_id, persona)
            );

            INSERT OR REPLACE INTO a11y_baselines_new (page_id, persona, tree_json, outline, node_count, captured_at)
            SELECT page_id, persona, tree_json, outline, node_count, captured_at
            FROM a11y_baselines b
            WHERE b.id = (
                SELECT MAX(id) FROM a11y_baselines
                WHERE page_id = b.page_id AND persona = b.persona
            );

            DROP TABLE a11y_baselines;
            ALTER TABLE a11y_baselines_new RENAME TO a11y_baselines;
        ''')

    # Ensure diffs match the new schema (has_baseline column replacing baseline_id)
    if 'baseline_id' in cols('visual_diffs'):
        conn.executescript('''
            DROP TABLE IF EXISTS visual_diffs;
            CREATE TABLE visual_diffs (
                page_id      TEXT NOT NULL,
                persona      TEXT NOT NULL,
                browser      TEXT NOT NULL DEFAULT 'chromium',
                has_baseline INTEGER NOT NULL DEFAULT 1,
                image        BLOB NOT NULL,
                width        INTEGER NOT NULL,
                height       INTEGER NOT NULL,
                diff_image   BLOB,
                pixel_count  INTEGER NOT NULL DEFAULT 0,
                pixel_pct    REAL NOT NULL DEFAULT 0.0,
                captured_at  TEXT NOT NULL,
                PRIMARY KEY (page_id, persona, browser)
            );
        ''')

    if 'baseline_id' in cols('a11y_diffs'):
        conn.executescript('''
            DROP TABLE IF EXISTS a11y_diffs;
            CREATE TABLE a11y_diffs (
                page_id       TEXT NOT NULL,
                persona       TEXT NOT NULL,
                has_baseline  INTEGER NOT NULL DEFAULT 1,
                tree_json     TEXT NOT NULL,
                outline       TEXT NOT NULL,
                node_count    INTEGER NOT NULL,
                diff_text     TEXT,
                added_count   INTEGER NOT NULL DEFAULT 0,
                removed_count INTEGER NOT NULL DEFAULT 0,
                captured_at   TEXT NOT NULL,
                PRIMARY KEY (page_id, persona)
            );
        ''')

    # Drop any obsolete indexes from the old append-only model
    conn.execute('DROP INDEX IF EXISTS idx_visual_baselines_ppb')
    conn.execute('DROP INDEX IF EXISTS idx_visual_baselines_pp')
    conn.execute('DROP INDEX IF EXISTS idx_a11y_baselines_pp')
    conn.commit()


# --- diffs (transient proposals from latest run) ----------------------------

def list_visual_diffs(conn):
    out = []
    for r in conn.execute(
        '''SELECT page_id, persona, browser, has_baseline, width, height,
                  pixel_count, pixel_pct, captured_at,
                  diff_image IS NOT NULL AS has_diff_image
           FROM visual_diffs ORDER BY page_id, persona, browser'''
    ):
        row = dict(r)
        row['status'] = 'new' if not row['has_baseline'] else 'changed'
        row['kind'] = 'visual'
        out.append(row)
    return out


def list_a11y_diffs(conn):
    out = []
    for r in conn.execute(
        '''SELECT page_id, persona, has_baseline, node_count,
                  added_count, removed_count, captured_at,
                  diff_text IS NOT NULL AS has_diff_text
           FROM a11y_diffs ORDER BY page_id, persona'''
    ):
        row = dict(r)
        row['status'] = 'new' if not row['has_baseline'] else 'changed'
        row['kind'] = 'a11y'
        out.append(row)
    return out


def get_visual_diff(conn, page_id, persona, browser):
    row = conn.execute(
        '''SELECT page_id, persona, browser, has_baseline, width, height,
                  pixel_count, pixel_pct, captured_at,
                  diff_image IS NOT NULL AS has_diff_image
           FROM visual_diffs WHERE page_id = ? AND persona = ? AND browser = ?''',
        (page_id, persona, browser),
    ).fetchone()
    if row is None:
        return None
    out = dict(row)
    out['status'] = 'new' if not out['has_baseline'] else 'changed'
    out['kind'] = 'visual'
    return out


def get_a11y_diff(conn, page_id, persona):
    row = conn.execute(
        '''SELECT page_id, persona, has_baseline, node_count,
                  added_count, removed_count, captured_at, diff_text
           FROM a11y_diffs WHERE page_id = ? AND persona = ?''',
        (page_id, persona),
    ).fetchone()
    if row is None:
        return None
    out = dict(row)
    out['status'] = 'new' if not out['has_baseline'] else 'changed'
    out['kind'] = 'a11y'
    return out


def clear_all_diffs(conn, *, kind=None, browser=None):
    """Delete transient diffs."""
    if kind in (None, 'visual'):
        if browser is not None:
            conn.execute('DELETE FROM visual_diffs WHERE browser = ?', (browser,))
        else:
            conn.execute('DELETE FROM visual_diffs')
    if kind in (None, 'a11y') and browser is None:
        conn.execute('DELETE FROM a11y_diffs')
    conn.commit()


# --- baselines (current canonical master snapshot) -------------------------

def list_visual_baselines(conn):
    return [dict(r) for r in conn.execute('''
        SELECT page_id, persona, browser, width, height, captured_at
        FROM visual_baselines
        ORDER BY page_id, persona, browser
    ''')]


def list_a11y_baselines(conn):
    return [dict(r) for r in conn.execute('''
        SELECT page_id, persona, node_count, captured_at
        FROM a11y_baselines
        ORDER BY page_id, persona
    ''')]


def get_current_baseline_image(conn, page_id, persona, browser):
    row = conn.execute(
        'SELECT image FROM visual_baselines WHERE page_id = ? AND persona = ? AND browser = ?',
        (page_id, persona, browser),
    ).fetchone()
    return row['image'] if row else None


def get_current_baseline_tree(conn, page_id, persona):
    row = conn.execute(
        'SELECT tree_json FROM a11y_baselines WHERE page_id = ? AND persona = ?',
        (page_id, persona),
    ).fetchone()
    return row['tree_json'] if row else None


def get_current_baseline_outline(conn, page_id, persona):
    row = conn.execute(
        'SELECT outline FROM a11y_baselines WHERE page_id = ? AND persona = ?',
        (page_id, persona),
    ).fetchone()
    return row['outline'] if row else None


def get_proposal_outline(conn, page_id, persona):
    row = conn.execute(
        'SELECT outline FROM a11y_diffs WHERE page_id = ? AND persona = ?',
        (page_id, persona),
    ).fetchone()
    return row['outline'] if row else None


def last_runs(conn, limit=20):
    return [dict(r) for r in conn.execute(
        'SELECT * FROM run_log ORDER BY id DESC LIMIT ?', (limit,)
    )]


def set_visual_baseline(conn, page_id, persona, browser, image, width, height, captured_at=None):
    conn.execute('''
        INSERT OR REPLACE INTO visual_baselines (page_id, persona, browser, image, width, height, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (page_id, persona, browser, image, width, height, captured_at or now_iso()))
    conn.commit()


def set_a11y_baseline(conn, page_id, persona, tree_json, outline, node_count, captured_at=None):
    conn.execute('''
        INSERT OR REPLACE INTO a11y_baselines (page_id, persona, tree_json, outline, node_count, captured_at)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (page_id, persona, tree_json, outline, node_count, captured_at or now_iso()))
    conn.commit()


def wipe_baselines(conn):
    conn.execute('DELETE FROM visual_baselines')
    conn.execute('DELETE FROM a11y_baselines')
    conn.execute('DELETE FROM visual_diffs')
    conn.execute('DELETE FROM a11y_diffs')
    conn.commit()


if __name__ == '__main__':
    c = connect()
    apply_schema(c)
    c.close()
    print('baselines.db schema verified and up-to-date.')
