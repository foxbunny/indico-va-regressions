"""Thin Flask app for reviewing visual-regression results (read-only).

Shows:
  /          — dashboard: diffs from the latest run.
  /baselines — current baseline snapshots.
  /runs      — run log.

The whole UI is a single-page vanilla-JS app under static/. Flask just serves
JSON + raw PNG/JSON/text bytes from SQLite.
"""

import sys
from pathlib import Path

from flask import Flask, abort, jsonify, send_from_directory

THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR.parent))

from storage import db as store  # noqa: E402

STATIC_DIR = THIS_DIR / 'static'

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path='')


def get_conn():
    conn = store.connect()
    store.apply_schema(conn)
    return conn


@app.route('/')
@app.route('/<path:_path>')
def spa(_path=''):
    if _path and (STATIC_DIR / _path).is_file():
        return send_from_directory(STATIC_DIR, _path)
    return send_from_directory(STATIC_DIR, 'index.html')


# --- diffs (transient from latest run) --------------------------------------

@app.route('/api/diffs')
def api_diffs():
    """All diffs from the latest run, sorted by page+persona."""
    conn = get_conn()
    try:
        return jsonify({
            'visual': store.list_visual_diffs(conn),
            'a11y':   store.list_a11y_diffs(conn),
        })
    finally:
        conn.close()


@app.route('/api/diffs/visual/<browser>/<page_id>/<persona>')
def api_visual_diff_one(browser, page_id, persona):
    conn = get_conn()
    try:
        row = store.get_visual_diff(conn, page_id, persona, browser)
        if row is None:
            abort(404)
        return jsonify(row)
    finally:
        conn.close()


@app.route('/api/diffs/a11y/<page_id>/<persona>')
def api_a11y_diff_one(page_id, persona):
    conn = get_conn()
    try:
        row = store.get_a11y_diff(conn, page_id, persona)
        if row is None:
            abort(404)
        return jsonify(row)
    finally:
        conn.close()


# --- baselines (current canonical master snapshot) -------------------------

@app.route('/api/baselines')
def api_baselines():
    conn = get_conn()
    try:
        return jsonify({
            'visual': store.list_visual_baselines(conn),
            'a11y':   store.list_a11y_baselines(conn),
        })
    finally:
        conn.close()


# --- image / tree byte streams ---------------------------------------------

@app.route('/img/diff/<browser>/<page_id>/<persona>.png')
def img_diff_overlay(browser, page_id, persona):
    conn = get_conn()
    try:
        row = conn.execute(
            '''SELECT diff_image FROM visual_diffs
               WHERE page_id = ? AND persona = ? AND browser = ?''',
            (page_id, persona, browser),
        ).fetchone()
        if row is None or row['diff_image'] is None:
            abort(404)
        return row['diff_image'], 200, {'Content-Type': 'image/png'}
    finally:
        conn.close()


@app.route('/img/proposal/<browser>/<page_id>/<persona>.png')
def img_proposal(browser, page_id, persona):
    conn = get_conn()
    try:
        row = conn.execute(
            '''SELECT image FROM visual_diffs
               WHERE page_id = ? AND persona = ? AND browser = ?''',
            (page_id, persona, browser),
        ).fetchone()
        if row is None:
            abort(404)
        return row['image'], 200, {'Content-Type': 'image/png'}
    finally:
        conn.close()


@app.route('/img/baseline/<browser>/<page_id>/<persona>.png')
def img_current_baseline(browser, page_id, persona):
    conn = get_conn()
    try:
        blob = store.get_current_baseline_image(conn, page_id, persona, browser)
        if blob is None:
            abort(404)
        return blob, 200, {'Content-Type': 'image/png'}
    finally:
        conn.close()


@app.route('/tree/proposal/<page_id>/<persona>')
def tree_proposal(page_id, persona):
    conn = get_conn()
    try:
        row = conn.execute(
            'SELECT tree_json FROM a11y_diffs WHERE page_id = ? AND persona = ?',
            (page_id, persona),
        ).fetchone()
        if row is None:
            abort(404)
        return row['tree_json'], 200, {'Content-Type': 'application/json'}
    finally:
        conn.close()


@app.route('/tree/baseline/<page_id>/<persona>')
def tree_current_baseline(page_id, persona):
    conn = get_conn()
    try:
        text = store.get_current_baseline_tree(conn, page_id, persona)
        if text is None:
            abort(404)
        return text, 200, {'Content-Type': 'application/json'}
    finally:
        conn.close()


@app.route('/outline/baseline/<page_id>/<persona>')
def outline_current_baseline(page_id, persona):
    conn = get_conn()
    try:
        text = store.get_current_baseline_outline(conn, page_id, persona)
        if text is None:
            abort(404)
        return text, 200, {'Content-Type': 'text/plain; charset=utf-8'}
    finally:
        conn.close()


@app.route('/outline/proposal/<page_id>/<persona>')
def outline_proposal(page_id, persona):
    conn = get_conn()
    try:
        text = store.get_proposal_outline(conn, page_id, persona)
        if text is None:
            abort(404)
        return text, 200, {'Content-Type': 'text/plain; charset=utf-8'}
    finally:
        conn.close()


# --- runs (diagnostic) ------------------------------------------------------

@app.route('/api/runs')
def api_runs():
    conn = get_conn()
    try:
        return jsonify(store.last_runs(conn))
    finally:
        conn.close()


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8002, debug=False)
