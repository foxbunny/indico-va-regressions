-- Single-snapshot baseline model:
--   *_baselines  — current canonical snapshot of master (one row per key).
--   *_diffs      — transient read-only diffs produced by the latest test run.
--
-- Visual uses key (page_id, persona, browser).
-- A11y uses key (page_id, persona).

CREATE TABLE IF NOT EXISTS visual_baselines (
    page_id      TEXT NOT NULL,
    persona      TEXT NOT NULL,
    browser      TEXT NOT NULL DEFAULT 'chromium',
    image        BLOB NOT NULL,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    captured_at  TEXT NOT NULL,
    PRIMARY KEY (page_id, persona, browser)
);

CREATE TABLE IF NOT EXISTS a11y_baselines (
    page_id      TEXT NOT NULL,
    persona      TEXT NOT NULL,
    tree_json    TEXT NOT NULL,
    outline      TEXT NOT NULL,
    node_count   INTEGER NOT NULL,
    captured_at  TEXT NOT NULL,
    PRIMARY KEY (page_id, persona)
);

CREATE TABLE IF NOT EXISTS visual_diffs (
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

CREATE TABLE IF NOT EXISTS a11y_diffs (
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

-- Diagnostic run log
CREATE TABLE IF NOT EXISTS run_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    filter          TEXT,
    git_head        TEXT,
    git_dirty       INTEGER NOT NULL DEFAULT 0,
    new_visual      INTEGER NOT NULL DEFAULT 0,
    changed_visual  INTEGER NOT NULL DEFAULT 0,
    new_a11y        INTEGER NOT NULL DEFAULT 0,
    changed_a11y    INTEGER NOT NULL DEFAULT 0
);
