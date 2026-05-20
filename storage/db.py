"""SQLite helpers — two-table model.

Model:
  *_baselines : append-only history (largest id per page+persona = current)
  *_diffs     : one row per page+persona when the proposal differs from the
                current baseline. No row means "no diff; baseline still holds".

Used by the seed orchestrator, the runner (via parallel TS code), and the
host-side review UI.
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
    conn.executescript(SCHEMA_PATH.read_text())
    _migrate(conn)
    conn.commit()


def _migrate(conn):
    # Idempotent ALTER TABLE ADD COLUMN; SQLite has no ADD COLUMN IF NOT EXISTS.
    def add_col(table, name, definition):
        existing = {r['name'] for r in conn.execute(f'PRAGMA table_info({table})')}
        if name not in existing:
            conn.execute(f'ALTER TABLE {table} ADD COLUMN {name} {definition}')

    add_col('visual_baselines', 'prev_baseline_id', 'INTEGER REFERENCES visual_baselines(id) ON DELETE SET NULL')
    add_col('visual_baselines', 'diff_image', 'BLOB')
    add_col('visual_baselines', 'pixel_count', 'INTEGER NOT NULL DEFAULT 0')
    add_col('visual_baselines', 'pixel_pct', 'REAL NOT NULL DEFAULT 0.0')
    add_col('a11y_baselines', 'prev_baseline_id', 'INTEGER REFERENCES a11y_baselines(id) ON DELETE SET NULL')
    add_col('a11y_baselines', 'diff_text', 'TEXT')
    add_col('a11y_baselines', 'added_count', 'INTEGER NOT NULL DEFAULT 0')
    add_col('a11y_baselines', 'removed_count', 'INTEGER NOT NULL DEFAULT 0')

    # Backfill prev_baseline_id for baselines accepted before this column
    # existed: within a (page_id, persona) chain, ordering by id is equivalent
    # to chronological order. We can't recover the actual pixel/line deltas
    # for these, but at least each step can still be viewed as side-by-side.
    for table in ('visual_baselines', 'a11y_baselines'):
        conn.execute(f'''
            UPDATE {table} AS t SET prev_baseline_id = (
                SELECT MAX(p.id) FROM {table} p
                WHERE p.page_id = t.page_id AND p.persona = t.persona
                  AND p.id < t.id
            )
            WHERE prev_baseline_id IS NULL
        ''')  # noqa: S608


# --- diffs (current proposals only) -----------------------------------------

def _list_diffs(conn, table):
    return [dict(r) for r in conn.execute(
        f'''SELECT page_id, persona, baseline_id, pixel_count, pixel_pct,
                   added_count, removed_count, captured_at
            FROM {table}
            ORDER BY page_id, persona'''  # noqa: S608
    ) if False] + [dict(r) for r in conn.execute(
        # Two-pass because the columns differ between tables; the executemany
        # template can't elide unknown columns. Easier to fall back to dict().
        f'SELECT * FROM {table} ORDER BY page_id, persona'  # noqa: S608
    )]


def list_visual_diffs(conn):
    out = []
    for r in conn.execute(
        '''SELECT page_id, persona, baseline_id, width, height,
                  pixel_count, pixel_pct, captured_at,
                  diff_image IS NOT NULL AS has_diff_image
           FROM visual_diffs ORDER BY page_id, persona'''
    ):
        row = dict(r)
        row['status'] = 'new' if row['baseline_id'] is None else 'changed'
        row['kind'] = 'visual'
        out.append(row)
    return out


def list_a11y_diffs(conn):
    out = []
    for r in conn.execute(
        '''SELECT page_id, persona, baseline_id, node_count,
                  added_count, removed_count, captured_at,
                  diff_text IS NOT NULL AS has_diff_text
           FROM a11y_diffs ORDER BY page_id, persona'''
    ):
        row = dict(r)
        row['status'] = 'new' if row['baseline_id'] is None else 'changed'
        row['kind'] = 'a11y'
        out.append(row)
    return out


def get_visual_diff(conn, page_id, persona):
    row = conn.execute(
        '''SELECT page_id, persona, baseline_id, width, height,
                  pixel_count, pixel_pct, captured_at,
                  diff_image IS NOT NULL AS has_diff_image
           FROM visual_diffs WHERE page_id = ? AND persona = ?''',
        (page_id, persona),
    ).fetchone()
    if row is None:
        return None
    out = dict(row)
    out['status'] = 'new' if out['baseline_id'] is None else 'changed'
    out['kind'] = 'visual'
    return out


def get_a11y_diff(conn, page_id, persona):
    row = conn.execute(
        '''SELECT page_id, persona, baseline_id, node_count,
                  added_count, removed_count, captured_at, diff_text
           FROM a11y_diffs WHERE page_id = ? AND persona = ?''',
        (page_id, persona),
    ).fetchone()
    if row is None:
        return None
    out = dict(row)
    out['status'] = 'new' if out['baseline_id'] is None else 'changed'
    out['kind'] = 'a11y'
    return out


# --- baselines (history) ----------------------------------------------------

def list_visual_baselines(conn):
    return [dict(r) for r in conn.execute('''
        SELECT b.page_id, b.persona, b.id, b.width, b.height, b.captured_at,
               (SELECT COUNT(*) FROM visual_baselines x
                 WHERE x.page_id = b.page_id AND x.persona = b.persona) AS history_size
        FROM visual_baselines b
        WHERE b.id = (
            SELECT MAX(id) FROM visual_baselines
            WHERE page_id = b.page_id AND persona = b.persona
        )
        ORDER BY b.page_id, b.persona
    ''')]


def list_a11y_baselines(conn):
    return [dict(r) for r in conn.execute('''
        SELECT b.page_id, b.persona, b.id, b.node_count, b.captured_at,
               (SELECT COUNT(*) FROM a11y_baselines x
                 WHERE x.page_id = b.page_id AND x.persona = b.persona) AS history_size
        FROM a11y_baselines b
        WHERE b.id = (
            SELECT MAX(id) FROM a11y_baselines
            WHERE page_id = b.page_id AND persona = b.persona
        )
        ORDER BY b.page_id, b.persona
    ''')]


def baseline_history(conn, table, page_id, persona):
    if table == 'visual_baselines':
        sql = '''
            SELECT id, width, height, captured_at, prev_baseline_id,
                   pixel_count, pixel_pct,
                   diff_image IS NOT NULL AS has_diff_image
            FROM visual_baselines
            WHERE page_id = ? AND persona = ?
            ORDER BY id DESC
        '''
    elif table == 'a11y_baselines':
        sql = '''
            SELECT id, node_count, captured_at, prev_baseline_id,
                   added_count, removed_count,
                   diff_text IS NOT NULL AS has_diff_text
            FROM a11y_baselines
            WHERE page_id = ? AND persona = ?
            ORDER BY id DESC
        '''
    else:
        raise ValueError(f'unknown history table {table}')
    return [dict(r) for r in conn.execute(sql, (page_id, persona))]


def get_current_baseline_image(conn, page_id, persona):
    row = conn.execute('''
        SELECT image FROM visual_baselines
        WHERE id = (SELECT MAX(id) FROM visual_baselines
                    WHERE page_id = ? AND persona = ?)
    ''', (page_id, persona)).fetchone()
    return row['image'] if row else None


def get_current_baseline_tree(conn, page_id, persona):
    row = conn.execute('''
        SELECT tree_json FROM a11y_baselines
        WHERE id = (SELECT MAX(id) FROM a11y_baselines
                    WHERE page_id = ? AND persona = ?)
    ''', (page_id, persona)).fetchone()
    return row['tree_json'] if row else None


def get_current_baseline_outline(conn, page_id, persona):
    row = conn.execute('''
        SELECT outline FROM a11y_baselines
        WHERE id = (SELECT MAX(id) FROM a11y_baselines
                    WHERE page_id = ? AND persona = ?)
    ''', (page_id, persona)).fetchone()
    return row['outline'] if row else None


def get_proposal_outline(conn, page_id, persona):
    row = conn.execute(
        'SELECT outline FROM a11y_diffs WHERE page_id = ? AND persona = ?',
        (page_id, persona),
    ).fetchone()
    return row['outline'] if row else None


def get_baseline_image_by_id(conn, baseline_id):
    row = conn.execute(
        'SELECT image FROM visual_baselines WHERE id = ?', (baseline_id,)
    ).fetchone()
    return row['image'] if row else None


def get_baseline_tree_by_id(conn, baseline_id):
    row = conn.execute(
        'SELECT tree_json FROM a11y_baselines WHERE id = ?', (baseline_id,)
    ).fetchone()
    return row['tree_json'] if row else None


def get_baseline_outline_by_id(conn, baseline_id):
    row = conn.execute(
        'SELECT outline FROM a11y_baselines WHERE id = ?', (baseline_id,)
    ).fetchone()
    return row['outline'] if row else None


def get_baseline_diff_image(conn, baseline_id):
    row = conn.execute(
        'SELECT diff_image FROM visual_baselines WHERE id = ?', (baseline_id,)
    ).fetchone()
    return row['diff_image'] if row else None


def get_visual_baseline_meta(conn, baseline_id):
    row = conn.execute(
        '''SELECT id, page_id, persona, width, height, captured_at,
                  prev_baseline_id, pixel_count, pixel_pct,
                  diff_image IS NOT NULL AS has_diff_image
           FROM visual_baselines WHERE id = ?''',
        (baseline_id,),
    ).fetchone()
    return dict(row) if row else None


def get_a11y_baseline_meta(conn, baseline_id):
    row = conn.execute(
        '''SELECT id, page_id, persona, node_count, captured_at,
                  prev_baseline_id, added_count, removed_count, diff_text
           FROM a11y_baselines WHERE id = ?''',
        (baseline_id,),
    ).fetchone()
    return dict(row) if row else None


# --- accept / reset ---------------------------------------------------------

def accept_visual(conn, page_id, persona):
    """Promote the current visual diff to a new baseline.

    Captures the diff blob + pixel counts onto the new baseline row, plus a
    pointer to the baseline this one replaced, so the per-page history view
    can render each accepted step as its own viewable diff.
    """
    diff = conn.execute(
        '''SELECT image, width, height, baseline_id,
                  diff_image, pixel_count, pixel_pct
           FROM visual_diffs WHERE page_id = ? AND persona = ?''',
        (page_id, persona),
    ).fetchone()
    if diff is None:
        return False
    conn.execute(
        '''INSERT INTO visual_baselines
               (page_id, persona, image, width, height, captured_at,
                prev_baseline_id, diff_image, pixel_count, pixel_pct)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (page_id, persona, diff['image'], diff['width'], diff['height'], now_iso(),
         diff['baseline_id'], diff['diff_image'], diff['pixel_count'], diff['pixel_pct']),
    )
    conn.execute(
        'DELETE FROM visual_diffs WHERE page_id = ? AND persona = ?',
        (page_id, persona),
    )
    conn.commit()
    return True


def accept_a11y(conn, page_id, persona):
    """Promote the current a11y diff to a new baseline. See accept_visual."""
    diff = conn.execute(
        '''SELECT tree_json, outline, node_count, baseline_id,
                  diff_text, added_count, removed_count
           FROM a11y_diffs WHERE page_id = ? AND persona = ?''',
        (page_id, persona),
    ).fetchone()
    if diff is None:
        return False
    conn.execute(
        '''INSERT INTO a11y_baselines
               (page_id, persona, tree_json, outline, node_count, captured_at,
                prev_baseline_id, diff_text, added_count, removed_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (page_id, persona, diff['tree_json'], diff['outline'], diff['node_count'], now_iso(),
         diff['baseline_id'], diff['diff_text'], diff['added_count'], diff['removed_count']),
    )
    conn.execute(
        'DELETE FROM a11y_diffs WHERE page_id = ? AND persona = ?',
        (page_id, persona),
    )
    conn.commit()
    return True


def accept_all(conn, *, kind=None):
    """Accept every current diff. Returns counts per modality."""
    counts = {'visual': 0, 'a11y': 0}
    if kind in (None, 'visual'):
        for r in conn.execute('SELECT page_id, persona FROM visual_diffs').fetchall():
            if accept_visual(conn, r['page_id'], r['persona']):
                counts['visual'] += 1
    if kind in (None, 'a11y'):
        for r in conn.execute('SELECT page_id, persona FROM a11y_diffs').fetchall():
            if accept_a11y(conn, r['page_id'], r['persona']):
                counts['a11y'] += 1
    return counts


def reset_visual_baseline(conn, page_id, persona):
    """Drop the entire baseline history for this page+persona."""
    cur = conn.execute(
        'DELETE FROM visual_baselines WHERE page_id = ? AND persona = ?',
        (page_id, persona),
    )
    conn.commit()
    return cur.rowcount > 0


def reset_a11y_baseline(conn, page_id, persona):
    cur = conn.execute(
        'DELETE FROM a11y_baselines WHERE page_id = ? AND persona = ?',
        (page_id, persona),
    )
    conn.commit()
    return cur.rowcount > 0


def wipe_baselines(conn):
    # Diffs are computed relative to a baseline; without one their image blob
    # and pixel/line counts are meaningless. The FK uses ON DELETE SET NULL so
    # the rows would survive with a NULL baseline_id and then masquerade as
    # 'new' on the dashboard. Drop them explicitly.
    conn.execute('DELETE FROM visual_diffs')
    conn.execute('DELETE FROM a11y_diffs')
    conn.execute('DELETE FROM visual_baselines')
    conn.execute('DELETE FROM a11y_baselines')
    conn.commit()


# --- run log (diagnostic) ---------------------------------------------------

def last_runs(conn, limit=10):
    return [dict(r) for r in conn.execute(
        'SELECT * FROM run_log ORDER BY id DESC LIMIT ?', (limit,)
    )]


if __name__ == '__main__':
    conn = connect()
    apply_schema(conn)
    print(f'Schema applied to {DB_PATH}')
    conn.close()
