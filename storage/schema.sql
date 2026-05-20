-- Two-table model per modality:
--   *_baselines  — append-only history; the row with the largest id for a
--                  given (page_id, persona) is "the current baseline".
--   *_diffs      — one row per (page_id, persona) when the latest proposal
--                  does NOT match the current baseline. The absence of a row
--                  means "the baseline still holds; nothing to act on".
--
-- Accept = INSERT a new baseline row + DELETE the diff row.
-- Reset  = DELETE every baseline row for that (page_id, persona). The next
--          run's diff row records status='new' (no baseline).
-- "Reject" isn't an action — not acting on a diff IS the reject.

CREATE TABLE IF NOT EXISTS visual_baselines (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id      TEXT NOT NULL,
    persona      TEXT NOT NULL,
    image        BLOB NOT NULL,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    captured_at  TEXT NOT NULL,
    -- Delta against the previous baseline in this (page, persona) history.
    -- Populated at accept time from the now-promoted visual_diffs row, so
    -- each baseline carries the change that produced it. NULL for the first
    -- baseline in a chain (and for rows accepted before this column existed).
    prev_baseline_id  INTEGER REFERENCES visual_baselines(id) ON DELETE SET NULL,
    diff_image   BLOB,
    pixel_count  INTEGER NOT NULL DEFAULT 0,
    pixel_pct    REAL NOT NULL DEFAULT 0.0
);

CREATE INDEX IF NOT EXISTS idx_visual_baselines_pp
    ON visual_baselines(page_id, persona, id DESC);

CREATE TABLE IF NOT EXISTS visual_diffs (
    page_id      TEXT NOT NULL,
    persona      TEXT NOT NULL,
    baseline_id  INTEGER REFERENCES visual_baselines(id) ON DELETE SET NULL,
    image        BLOB NOT NULL,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    diff_image   BLOB,
    pixel_count  INTEGER NOT NULL DEFAULT 0,
    pixel_pct    REAL NOT NULL DEFAULT 0.0,
    captured_at  TEXT NOT NULL,
    PRIMARY KEY (page_id, persona)
);

CREATE TABLE IF NOT EXISTS a11y_baselines (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id      TEXT NOT NULL,
    persona      TEXT NOT NULL,
    tree_json    TEXT NOT NULL,
    outline      TEXT NOT NULL,
    node_count   INTEGER NOT NULL,
    captured_at  TEXT NOT NULL,
    -- Delta against the previous baseline; see visual_baselines for rationale.
    prev_baseline_id  INTEGER REFERENCES a11y_baselines(id) ON DELETE SET NULL,
    diff_text     TEXT,
    added_count   INTEGER NOT NULL DEFAULT 0,
    removed_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_a11y_baselines_pp
    ON a11y_baselines(page_id, persona, id DESC);

CREATE TABLE IF NOT EXISTS a11y_diffs (
    page_id       TEXT NOT NULL,
    persona       TEXT NOT NULL,
    baseline_id   INTEGER REFERENCES a11y_baselines(id) ON DELETE SET NULL,
    tree_json     TEXT NOT NULL,
    outline       TEXT NOT NULL,
    node_count    INTEGER NOT NULL,
    diff_text     TEXT,
    added_count   INTEGER NOT NULL DEFAULT 0,
    removed_count INTEGER NOT NULL DEFAULT 0,
    captured_at   TEXT NOT NULL,
    PRIMARY KEY (page_id, persona)
);

-- Diagnostic only: when the suite last ran. No per-run history is kept
-- anywhere else, the diffs themselves are the only thing that matters.
CREATE TABLE IF NOT EXISTS run_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    filter          TEXT,
    git_head        TEXT,
    git_dirty       INTEGER NOT NULL DEFAULT 0,
    new_visual      INTEGER NOT NULL DEFAULT 0,
    changed_visual  INTEGER NOT NULL DEFAULT 0,
    cleared_visual  INTEGER NOT NULL DEFAULT 0,
    new_a11y        INTEGER NOT NULL DEFAULT 0,
    changed_a11y    INTEGER NOT NULL DEFAULT 0,
    cleared_a11y    INTEGER NOT NULL DEFAULT 0
);
