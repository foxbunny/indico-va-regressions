# Indico Visual & Accessibility Regression Suite

A standalone, local-only regression suite that captures full-page **screenshots** and **accessibility-tree snapshots** for the four user personas (anonymous, registered participant, event manager, server admin) across a curated list of Indico pages, diffs them against a previous baseline, and surfaces the diffs in a review UI where each change can be accepted or rejected.

The suite is **separate from the Indico repository** — it lives at `~/indico-regressions` and expects the Indico source to be at `~/indico` (override via `INDICO_SRC`). Indico, Postgres, and the Playwright runner all run in docker; only the SQLite baselines DB and the review UI run on the host.

Room booking is out of scope.

## Prerequisites

- Docker and Docker Compose v2
- The Indico source checkout (anywhere; default lookup is `../indico`)
- An `indico-python` wrapper on PATH (used by the review UI and host helpers). The repo's `feedback_indico_python_wrapper.md` memory describes the pattern.

No host-level Postgres, Redis, npm, or Playwright install required — those all live in containers built on first `setup`.

## First-time setup

```sh
./visual-regression.sh setup
```

This builds two images:
- `indico` — Indico's own Dockerfile, used to run the test server. Built from `${INDICO_SRC}/Dockerfile`.
- `runner` — `mcr.microsoft.com/playwright:v1.49.0-jammy` + the runner's npm dependencies, baked into `/opt/runner/node_modules` so the runtime bind-mount doesn't shadow them.

It also initialises the empty `baselines.db` SQLite file with the schema.

You can also skip `setup` — the default subcommand will `--build` on demand.

## Day-to-day usage

```sh
# Capture a run and diff against baselines.
./visual-regression.sh

# Launch the review UI.
./visual-regression.sh review
# → http://127.0.0.1:8002

# Bulk-accept everything in a run from the CLI.
./visual-regression.sh accept-all 3

# Wipe baselines (with confirm) — next run is treated as the new initial baseline.
./visual-regression.sh wipe-baselines

# Tear down the docker stack (normally done automatically at the end of a run).
./visual-regression.sh down

# Tail the Indico server log inside the container.
./visual-regression.sh logs

# Open a shell in the runner container for debugging.
./visual-regression.sh shell
```

### First run produces baselines

On the very first run, no baselines exist so every entry is recorded as `new`. The suite exits non-zero. Open the review UI, sanity-check that pages render correctly (no error pages, no missing data, layout intact; a11y trees have an `h1`, landmarks present), then "Accept everything". The accepted rows become the canonical baselines, and subsequent runs diff against them.

### Filters

```sh
./visual-regression.sh --filter events --persona admin
./visual-regression.sh --page user-dashboard
./visual-regression.sh --only-visual    # skip a11y capture
./visual-regression.sh --only-a11y      # skip screenshots
```

### Pointing at a different Indico checkout

```sh
INDICO_SRC=/path/to/indico ./visual-regression.sh
```

## Output

All gitignored:
- `baselines.db` — SQLite file with baselines, snapshots, diffs, and run history. Persistent across runs.
- `output/runtime/` — the test Indico instance's log, cache, temp, and storage (bind-mounted into the indico container).
- `output/manifest.json` — seed-time logical-name → DB-id mapping (e.g. `conferenceEventId → 3`).

Postgres data lives in a container tmpfs — gone the moment the stack comes down, which is what we want (every run starts from a clean DB).

## How it works

1. **Database**: the indico container drops and recreates the `indico_visual` database on every boot, then runs `indico db prepare` and our seed scenarios. Because Postgres uses tmpfs, this is fast.
2. **Server clock**: `hooks/run_indico.py` wraps the Indico CLI with `freezegun`, so Python-side `now_utc()` calls resolve to `2026-06-15T12:00:00+00:00`. Indico timestamps default to `now_utc` (see Indico's `modules/events/models/events.py`), so server-rendered relative dates ("in 3 days") are deterministic. Postgres-side `NOW()` is not patched, but Indico doesn't use it for any rendered column.
3. **Seed scenarios**: `seed/scenarios/*.py` create personas, categories, and events. They call Indico's `operations` modules with `session.set_session_user(admin)` inside a `test_request_context` so logging and signals run normally.
4. **Page catalogue**: `config/pages.json` is a flat list of `{id, module, path, personas, capture, …}`. Path templates use placeholders resolved from `output/manifest.json`.
5. **Runner**: `runner/runner.ts` (Playwright + tsx) logs each non-anonymous persona in once via the form POST, stores a `storageState`, then iterates pages × personas. For each it captures both a full-page screenshot and `page.accessibility.snapshot({interestingOnly: true})`. Pixel diffs use `pixelmatch`; a11y diffs are unified text diffs over canonical JSON (sorted keys, default-pruning).
6. **Storage**: parallel `visual_*` and `a11y_*` tables in `baselines.db`; the `runs` table is shared. Status flow per `(page, persona, kind)`: `new` → `unchanged` / `changed` / `accepted` / `rejected`. A page can be `unchanged` in one modality and `changed` in the other.
7. **Review UI**: `review/app.py` is a thin Flask JSON API + static file server (runs on the host, not in docker). Frontend is a single vanilla-JS SPA at `review/static/`. Visual diffs show baseline / actual / diff side-by-side; a11y diffs show the unified text diff with `+`/`-` line highlighting. Accept and reject act independently per modality.

## Determinism

- Server clock frozen (freezegun).
- Browser clock frozen via an `addInitScript` shim that overrides `Date` and `Date.now`.
- Animations, transitions, scrollbars hidden via injected CSS.
- `page.mouse.move(0, 0)` before each capture to dismiss hover state.
- Wait for `domcontentloaded`, then `networkidle` (10s timeout, ignored), then absence of `.loading / .spinner / .ui.loader / [aria-busy=true]`, then `document.fonts.ready`.
- Chromium launched with `--font-render-hinting=none`.
- Locale pinned to `en-GB`, timezone to `UTC`.
- Chromium runs in a docker container, so its font and graphics stack stay identical across host machines — visual baselines should be reproducible across collaborators on the same image tag.

## Caveats

- **Postgres `NOW()` columns**: freezegun can't reach server-side defaults. If you ever discover a model that renders such a column, the fix is to mask the affected region in `config/pages.json` rather than reach into Indico.
- **Plugin set**: pinned to `()` in the visual config. If a page you want to cover needs a plugin to render, add it to that tuple in `docker/indico-visual.conf`.
- **Indico source mounted live**: the indico container bind-mounts `${INDICO_SRC}` as `/home/indico/src` and the regression repo as `/regressions`. If you change Indico source files mid-run, the next run picks them up — useful for "did my fix change anything?" but means stale `.pyc`/asset bundles can mislead. If in doubt, `./visual-regression.sh down && rm -rf "$INDICO_SRC"/indico/web/static/dist` and rerun.

## Layout

```
indico-regressions/
  visual-regression.sh        entry point (host)
  config/                     pages.json, personas.json
  hooks/run_indico.py         freezegun wrapper around indico CLI
  seed/                       scenario builders that call Indico operations
  storage/                    SQLite schema + Python helpers
  runner/                     TypeScript Playwright runner
  review/                     host-side Flask review UI (API + static SPA)
  docker/                     docker-compose + Dockerfile.runner + entrypoints
  baselines.db                (gitignored) canonical state + run history
  output/                     (gitignored) manifest, runtime, auth, server log
```
