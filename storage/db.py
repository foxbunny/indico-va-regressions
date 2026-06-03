"""SQLite helpers — two-table model.

Model:
  *_baselines : append-only history (largest id per key = current)
  *_diffs     : one row per key when the proposal differs from the current
                baseline. No row means "no diff; baseline still holds".

Visual uses (page_id, persona, browser) — each browser has its own chain.
A11y uses (page_id, persona) — captured in chromium only.

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
    def cols(table):
        return {r['name'] for r in conn.execute(f'PRAGMA table_info({table})')}

    def add_col(table, name, definition):
        if name not in cols(table):
            conn.execute(f'ALTER TABLE {table} ADD COLUMN {name} {definition}')

    add_col('visual_baselines', 'prev_baseline_id', 'INTEGER REFERENCES visual_baselines(id) ON DELETE SET NULL')
    add_col('visual_baselines', 'diff_image', 'BLOB')
    add_col('visual_baselines', 'pixel_count', 'INTEGER NOT NULL DEFAULT 0')
    add_col('visual_baselines', 'pixel_pct', 'REAL NOT NULL DEFAULT 0.0')
    add_col('visual_baselines', 'browser', "TEXT NOT NULL DEFAULT 'chromium'")
    # The browser column now exists, so the new index is safe to create. The
    # old (page_id, persona, id DESC) index is no longer the natural lookup
    # path — every chain query now includes browser too.
    conn.execute('DROP INDEX IF EXISTS idx_visual_baselines_pp')
    conn.execute('''CREATE INDEX IF NOT EXISTS idx_visual_baselines_ppb
                    ON visual_baselines(page_id, persona, browser, id DESC)''')
    add_col('a11y_baselines', 'prev_baseline_id', 'INTEGER REFERENCES a11y_baselines(id) ON DELETE SET NULL')
    add_col('a11y_baselines', 'diff_text', 'TEXT')
    add_col('a11y_baselines', 'added_count', 'INTEGER NOT NULL DEFAULT 0')
    add_col('a11y_baselines', 'removed_count', 'INTEGER NOT NULL DEFAULT 0')

    # run_log_id ties each row to the capture run that produced it -- the batch
    # key for revert. New rows get it from the runner; existing rows stay NULL
    # (the capture run can't be reconstructed from counts alone) and a NULL is
    # simply not groupable, so revert skips it. See revert_all.
    add_col('visual_baselines', 'run_log_id', 'INTEGER')
    add_col('visual_diffs', 'run_log_id', 'INTEGER')
    add_col('a11y_baselines', 'run_log_id', 'INTEGER')
    add_col('a11y_diffs', 'run_log_id', 'INTEGER')

    # visual_diffs needs (page_id, persona, browser) as its PK so chromium and
    # firefox can coexist. SQLite can't ALTER a PRIMARY KEY, so when we detect
    # the pre-browser schema, rebuild the table. Existing rows are backfilled
    # as 'chromium' (the only browser previously supported).
    if 'browser' not in cols('visual_diffs'):
        conn.executescript('''
            ALTER TABLE visual_diffs RENAME TO visual_diffs_old;
            CREATE TABLE visual_diffs (
                page_id      TEXT NOT NULL,
                persona      TEXT NOT NULL,
                browser      TEXT NOT NULL DEFAULT 'chromium',
                baseline_id  INTEGER REFERENCES visual_baselines(id) ON DELETE SET NULL,
                image        BLOB NOT NULL,
                width        INTEGER NOT NULL,
                height       INTEGER NOT NULL,
                diff_image   BLOB,
                pixel_count  INTEGER NOT NULL DEFAULT 0,
                pixel_pct    REAL NOT NULL DEFAULT 0.0,
                captured_at  TEXT NOT NULL,
                PRIMARY KEY (page_id, persona, browser)
            );
            INSERT INTO visual_diffs
                (page_id, persona, browser, baseline_id, image, width, height,
                 diff_image, pixel_count, pixel_pct, captured_at)
            SELECT page_id, persona, 'chromium', baseline_id, image, width, height,
                   diff_image, pixel_count, pixel_pct, captured_at
            FROM visual_diffs_old;
            DROP TABLE visual_diffs_old;
        ''')

    # Backfill prev_baseline_id for baselines accepted before this column
    # existed: within a baseline chain, ordering by id is equivalent to
    # chronological order. We can't recover the actual pixel/line deltas
    # for these, but at least each step can still be viewed as side-by-side.
    # For visual, the chain is per-browser too; pre-migration rows all share
    # browser='chromium' so the chaining is unaffected.
    chain_keys = {
        'visual_baselines': ('page_id', 'persona', 'browser'),
        'a11y_baselines':   ('page_id', 'persona'),
    }
    for table, keys in chain_keys.items():
        match = ' AND '.join(f'p.{k} = t.{k}' for k in keys)
        conn.execute(f'''
            UPDATE {table} AS t SET prev_baseline_id = (
                SELECT MAX(p.id) FROM {table} p
                WHERE {match} AND p.id < t.id
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
        '''SELECT page_id, persona, browser, baseline_id, width, height,
                  pixel_count, pixel_pct, captured_at,
                  diff_image IS NOT NULL AS has_diff_image
           FROM visual_diffs ORDER BY page_id, persona, browser'''
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


def get_visual_diff(conn, page_id, persona, browser):
    row = conn.execute(
        '''SELECT page_id, persona, browser, baseline_id, width, height,
                  pixel_count, pixel_pct, captured_at,
                  diff_image IS NOT NULL AS has_diff_image
           FROM visual_diffs WHERE page_id = ? AND persona = ? AND browser = ?''',
        (page_id, persona, browser),
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
        SELECT b.page_id, b.persona, b.browser, b.id, b.width, b.height,
               b.captured_at,
               (SELECT COUNT(*) FROM visual_baselines x
                 WHERE x.page_id = b.page_id AND x.persona = b.persona
                   AND x.browser = b.browser) AS history_size
        FROM visual_baselines b
        WHERE b.id = (
            SELECT MAX(id) FROM visual_baselines
            WHERE page_id = b.page_id AND persona = b.persona
              AND browser = b.browser
        )
        ORDER BY b.page_id, b.persona, b.browser
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


def baseline_history(conn, table, page_id, persona, browser=None):
    if table == 'visual_baselines':
        if browser is None:
            raise ValueError('browser is required for visual_baselines')
        sql = '''
            SELECT id, width, height, captured_at, prev_baseline_id,
                   pixel_count, pixel_pct,
                   diff_image IS NOT NULL AS has_diff_image
            FROM visual_baselines
            WHERE page_id = ? AND persona = ? AND browser = ?
            ORDER BY id DESC
        '''
        return [dict(r) for r in conn.execute(sql, (page_id, persona, browser))]
    elif table == 'a11y_baselines':
        sql = '''
            SELECT id, node_count, captured_at, prev_baseline_id,
                   added_count, removed_count,
                   diff_text IS NOT NULL AS has_diff_text
            FROM a11y_baselines
            WHERE page_id = ? AND persona = ?
            ORDER BY id DESC
        '''
        return [dict(r) for r in conn.execute(sql, (page_id, persona))]
    else:
        raise ValueError(f'unknown history table {table}')


def get_current_baseline_image(conn, page_id, persona, browser):
    row = conn.execute('''
        SELECT image FROM visual_baselines
        WHERE id = (SELECT MAX(id) FROM visual_baselines
                    WHERE page_id = ? AND persona = ? AND browser = ?)
    ''', (page_id, persona, browser)).fetchone()
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
        '''SELECT id, page_id, persona, browser, width, height, captured_at,
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

def accept_visual(conn, page_id, persona, browser, *, commit=True):
    """Promote the current visual diff to a new baseline.

    Captures the diff blob + pixel counts onto the new baseline row, plus a
    pointer to the baseline this one replaced, so the per-page history view
    can render each accepted step as its own viewable diff.

    The new baseline inherits the diff's ``captured_at`` and ``run_log_id`` --
    i.e. it records when/which run *captured* this content, NOT when it was
    accepted. That keeps ``captured_at`` honest and lets ``revert_all`` group by
    the capture run. Pass ``commit=False`` to run inside a larger transaction
    (e.g. a bulk accept) -- the caller is then responsible for committing.
    """
    diff = conn.execute(
        '''SELECT image, width, height, baseline_id, captured_at, run_log_id,
                  diff_image, pixel_count, pixel_pct
           FROM visual_diffs WHERE page_id = ? AND persona = ? AND browser = ?''',
        (page_id, persona, browser),
    ).fetchone()
    if diff is None:
        return False
    conn.execute(
        '''INSERT INTO visual_baselines
               (page_id, persona, browser, image, width, height, captured_at,
                prev_baseline_id, diff_image, pixel_count, pixel_pct, run_log_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (page_id, persona, browser, diff['image'], diff['width'], diff['height'],
         diff['captured_at'], diff['baseline_id'], diff['diff_image'],
         diff['pixel_count'], diff['pixel_pct'], diff['run_log_id']),
    )
    conn.execute(
        'DELETE FROM visual_diffs WHERE page_id = ? AND persona = ? AND browser = ?',
        (page_id, persona, browser),
    )
    if commit:
        conn.commit()
    return True


def accept_a11y(conn, page_id, persona, *, commit=True):
    """Promote the current a11y diff to a new baseline. See accept_visual."""
    diff = conn.execute(
        '''SELECT tree_json, outline, node_count, baseline_id, captured_at, run_log_id,
                  diff_text, added_count, removed_count
           FROM a11y_diffs WHERE page_id = ? AND persona = ?''',
        (page_id, persona),
    ).fetchone()
    if diff is None:
        return False
    conn.execute(
        '''INSERT INTO a11y_baselines
               (page_id, persona, tree_json, outline, node_count, captured_at,
                prev_baseline_id, diff_text, added_count, removed_count, run_log_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (page_id, persona, diff['tree_json'], diff['outline'], diff['node_count'],
         diff['captured_at'], diff['baseline_id'], diff['diff_text'],
         diff['added_count'], diff['removed_count'], diff['run_log_id']),
    )
    conn.execute(
        'DELETE FROM a11y_diffs WHERE page_id = ? AND persona = ?',
        (page_id, persona),
    )
    if commit:
        conn.commit()
    return True


def accept_all(conn, *, kind=None, browser=None):
    """Accept every current diff. Returns counts per modality.

    The optional `browser` filter only applies to visual diffs (a11y is
    captured in chromium only and isn't keyed by browser).
    """
    counts = {'visual': 0, 'a11y': 0}
    if kind in (None, 'visual'):
        if browser is None:
            rows = conn.execute('SELECT page_id, persona, browser FROM visual_diffs').fetchall()
        else:
            rows = conn.execute(
                'SELECT page_id, persona, browser FROM visual_diffs WHERE browser = ?',
                (browser,),
            ).fetchall()
        for r in rows:
            if accept_visual(conn, r['page_id'], r['persona'], r['browser'], commit=False):
                counts['visual'] += 1
    if kind in (None, 'a11y') and browser is None:
        for r in conn.execute('SELECT page_id, persona FROM a11y_diffs').fetchall():
            if accept_a11y(conn, r['page_id'], r['persona'], commit=False):
                counts['a11y'] += 1
    conn.commit()
    return counts


def accept_selected(conn, items):
    """Accept a caller-supplied set of diffs in a single transaction.

    ``items`` is a list of ``{page_id, persona, browsers, a11y}`` dicts (as the
    review UI builds them per selected row): ``browsers`` is the list of visual
    browsers to accept for that key, and ``a11y`` is whether to accept the a11y
    diff. Missing diffs are silently skipped, so the returned counts reflect
    only the rows that actually existed.
    """
    counts = {'visual': 0, 'a11y': 0}
    for item in items:
        page_id = item['page_id']
        persona = item['persona']
        for browser in item.get('browsers') or []:
            if accept_visual(conn, page_id, persona, browser, commit=False):
                counts['visual'] += 1
        if item.get('a11y') and accept_a11y(conn, page_id, persona, commit=False):
            counts['a11y'] += 1
    conn.commit()
    return counts


def reset_visual_baseline(conn, page_id, persona, browser):
    """Drop the entire baseline history for this page+persona+browser."""
    cur = conn.execute(
        'DELETE FROM visual_baselines WHERE page_id = ? AND persona = ? AND browser = ?',
        (page_id, persona, browser),
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


def revert_visual(conn, page_id, persona, browser):
    """Undo the most recent accept for this visual key.

    The inverse of ``accept_visual``: moves the current baseline back into
    ``visual_diffs`` as a pending diff (reconstructed from the blob + prev
    pointer the accept stored) and deletes that baseline row, so the baseline
    it replaced becomes current again. Returns False when there is nothing to
    revert -- the current baseline is an original capture (``prev_baseline_id``
    is NULL, so no diff to restore) or a pending diff already exists for the key
    (a later run superseded the accept; we won't clobber it).
    """
    base = conn.execute(
        '''SELECT id, image, width, height, captured_at, prev_baseline_id, run_log_id,
                  diff_image, pixel_count, pixel_pct
           FROM visual_baselines
           WHERE page_id = ? AND persona = ? AND browser = ?
           ORDER BY id DESC LIMIT 1''',
        (page_id, persona, browser),
    ).fetchone()
    if base is None or base['prev_baseline_id'] is None:
        return False
    if conn.execute(
        'SELECT 1 FROM visual_diffs WHERE page_id = ? AND persona = ? AND browser = ?',
        (page_id, persona, browser),
    ).fetchone() is not None:
        return False
    conn.execute(
        '''INSERT INTO visual_diffs
               (page_id, persona, browser, baseline_id, image, width, height,
                diff_image, pixel_count, pixel_pct, captured_at, run_log_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (page_id, persona, browser, base['prev_baseline_id'], base['image'],
         base['width'], base['height'], base['diff_image'], base['pixel_count'],
         base['pixel_pct'], base['captured_at'], base['run_log_id']),
    )
    conn.execute('DELETE FROM visual_baselines WHERE id = ?', (base['id'],))
    conn.commit()
    return True


def revert_a11y(conn, page_id, persona):
    """Undo the most recent accept for this a11y key. See revert_visual."""
    base = conn.execute(
        '''SELECT id, tree_json, outline, node_count, captured_at, prev_baseline_id, run_log_id,
                  diff_text, added_count, removed_count
           FROM a11y_baselines
           WHERE page_id = ? AND persona = ?
           ORDER BY id DESC LIMIT 1''',
        (page_id, persona),
    ).fetchone()
    if base is None or base['prev_baseline_id'] is None:
        return False
    if conn.execute(
        'SELECT 1 FROM a11y_diffs WHERE page_id = ? AND persona = ?',
        (page_id, persona),
    ).fetchone() is not None:
        return False
    conn.execute(
        '''INSERT INTO a11y_diffs
               (page_id, persona, baseline_id, tree_json, outline, node_count,
                diff_text, added_count, removed_count, captured_at, run_log_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (page_id, persona, base['prev_baseline_id'], base['tree_json'],
         base['outline'], base['node_count'], base['diff_text'],
         base['added_count'], base['removed_count'], base['captured_at'], base['run_log_id']),
    )
    conn.execute('DELETE FROM a11y_baselines WHERE id = ?', (base['id'],))
    conn.commit()
    return True


def _revertable_visual(conn, browser=None):
    """Top-of-chain visual baselines that came from an accept and aren't already
    superseded by a pending diff -- the keys a revert may touch, each tagged with
    its capture ``run_log_id``. Optional browser filter."""
    q = '''
        SELECT b.page_id, b.persona, b.browser, b.run_log_id
        FROM visual_baselines b
        WHERE b.id = (SELECT MAX(id) FROM visual_baselines
                      WHERE page_id = b.page_id AND persona = b.persona AND browser = b.browser)
          AND b.prev_baseline_id IS NOT NULL
          AND b.run_log_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM visual_diffs d
                          WHERE d.page_id = b.page_id AND d.persona = b.persona
                            AND d.browser = b.browser)
    '''
    params = ()
    if browser is not None:
        q += ' AND b.browser = ?'
        params = (browser,)
    return conn.execute(q, params).fetchall()


def _revertable_a11y(conn):
    """Top-of-chain a11y baselines eligible for revert. See _revertable_visual."""
    return conn.execute('''
        SELECT b.page_id, b.persona, b.run_log_id
        FROM a11y_baselines b
        WHERE b.id = (SELECT MAX(id) FROM a11y_baselines
                      WHERE page_id = b.page_id AND persona = b.persona)
          AND b.prev_baseline_id IS NOT NULL
          AND b.run_log_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM a11y_diffs d
                          WHERE d.page_id = b.page_id AND d.persona = b.persona)
    ''').fetchall()


def revert_all(conn, *, kind=None, browser=None):
    """Undo the most recently captured run's accepts, restoring its pending diffs.

    The inverse of ``accept_all`` scoped to a single capture run. Every row
    carries the ``run_log_id`` of the run that captured it (stamped by the
    runner, preserved through accept), so the records of one capture run share
    it -- regardless of how many accept clicks promoted them. Among the
    revertable baselines (came from an accept, not already superseded by a
    pending diff, and with a known run), this finds the largest ``run_log_id``
    (run_log.id is autoincrement, so that's the most recently captured run) and
    reverts exactly the keys carrying it, across both modalities. This is what
    keeps a revert from popping the top accept off every chain at once.

    Baselines with a NULL ``run_log_id`` (written before the column existed and
    not backfilled) aren't groupable and are skipped.

    Filters: `kind` limits to one modality; `browser` limits to one visual
    engine (and skips a11y, which isn't keyed by browser). The target run is
    chosen within the filtered candidate set. Returns counts per modality.
    """
    counts = {'visual': 0, 'a11y': 0}
    visual = _revertable_visual(conn, browser) if kind in (None, 'visual') else []
    a11y = _revertable_a11y(conn) if (kind in (None, 'a11y') and browser is None) else []

    run_ids = [r['run_log_id'] for r in visual] + [r['run_log_id'] for r in a11y]
    if not run_ids:
        return counts
    target = max(run_ids)

    for r in visual:
        if r['run_log_id'] == target and revert_visual(conn, r['page_id'], r['persona'], r['browser']):
            counts['visual'] += 1
    for r in a11y:
        if r['run_log_id'] == target and revert_a11y(conn, r['page_id'], r['persona']):
            counts['a11y'] += 1
    return counts


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
