"""Thin Flask app for reviewing visual-regression results.

Two views:
  /         — dashboard. Default tab: open diffs (the things needing attention).
              Secondary tab: all baselines (with history counts).
  /history  — per-(page,persona) baseline history (image/tree timeline).

The whole UI is a single-page vanilla-JS app under static/. Flask just serves
JSON + raw PNG/JSON bytes from SQLite.
"""

import sys
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory

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


# --- diffs (current open proposals) -----------------------------------------

@app.route('/api/diffs')
def api_diffs():
    """All open diffs, sorted by page+persona. Default dashboard."""
    conn = get_conn()
    try:
        return jsonify({
            'visual': store.list_visual_diffs(conn),
            'a11y':   store.list_a11y_diffs(conn),
        })
    finally:
        conn.close()


@app.route('/api/diffs/<kind>/<page_id>/<persona>')
def api_diff_one(kind, page_id, persona):
    conn = get_conn()
    try:
        if kind == 'visual':
            row = store.get_visual_diff(conn, page_id, persona)
        elif kind == 'a11y':
            row = store.get_a11y_diff(conn, page_id, persona)
        else:
            abort(404)
        if row is None:
            abort(404)
        return jsonify(row)
    finally:
        conn.close()


@app.route('/api/diffs/<kind>/<page_id>/<persona>/accept', methods=['POST'])
def api_accept(kind, page_id, persona):
    """Promote the open diff to a new baseline. Drops the diff row."""
    conn = get_conn()
    try:
        if kind == 'visual':
            ok = store.accept_visual(conn, page_id, persona)
        elif kind == 'a11y':
            ok = store.accept_a11y(conn, page_id, persona)
        else:
            abort(404)
        if not ok:
            abort(404)
        return jsonify({'status': 'accepted'})
    finally:
        conn.close()


@app.route('/api/diffs/accept-all', methods=['POST'])
def api_accept_all():
    kind = request.args.get('kind')
    if kind not in (None, 'visual', 'a11y'):
        abort(400, 'kind must be visual or a11y')
    conn = get_conn()
    try:
        return jsonify(store.accept_all(conn, kind=kind))
    finally:
        conn.close()


# --- baselines (history) ----------------------------------------------------

@app.route('/api/baselines')
def api_baselines():
    """Current baselines (one per page+persona) plus history_size."""
    conn = get_conn()
    try:
        return jsonify({
            'visual': store.list_visual_baselines(conn),
            'a11y':   store.list_a11y_baselines(conn),
        })
    finally:
        conn.close()


@app.route('/api/baselines/<kind>/<page_id>/<persona>')
def api_baseline_history(kind, page_id, persona):
    table = {'visual': 'visual_baselines', 'a11y': 'a11y_baselines'}.get(kind)
    if table is None:
        abort(404)
    conn = get_conn()
    try:
        return jsonify(store.baseline_history(conn, table, page_id, persona))
    finally:
        conn.close()


@app.route('/api/baselines/<kind>/<page_id>/<persona>/reset', methods=['POST'])
def api_reset_baseline(kind, page_id, persona):
    """Drop the entire baseline history for this page+persona."""
    conn = get_conn()
    try:
        if kind == 'visual':
            ok = store.reset_visual_baseline(conn, page_id, persona)
        elif kind == 'a11y':
            ok = store.reset_a11y_baseline(conn, page_id, persona)
        else:
            abort(404)
        if not ok:
            abort(404, 'no baseline existed')
        return jsonify({'status': 'reset'})
    finally:
        conn.close()


# --- image / tree byte streams ---------------------------------------------

@app.route('/img/diff/<page_id>/<persona>.png')
def img_diff_overlay(page_id, persona):
    conn = get_conn()
    try:
        row = conn.execute(
            'SELECT diff_image FROM visual_diffs WHERE page_id = ? AND persona = ?',
            (page_id, persona),
        ).fetchone()
        if row is None or row['diff_image'] is None:
            abort(404)
        return row['diff_image'], 200, {'Content-Type': 'image/png'}
    finally:
        conn.close()


@app.route('/img/proposal/<page_id>/<persona>.png')
def img_proposal(page_id, persona):
    conn = get_conn()
    try:
        row = conn.execute(
            'SELECT image FROM visual_diffs WHERE page_id = ? AND persona = ?',
            (page_id, persona),
        ).fetchone()
        if row is None:
            abort(404)
        return row['image'], 200, {'Content-Type': 'image/png'}
    finally:
        conn.close()


@app.route('/img/baseline/<page_id>/<persona>.png')
def img_current_baseline(page_id, persona):
    conn = get_conn()
    try:
        blob = store.get_current_baseline_image(conn, page_id, persona)
        if blob is None:
            abort(404)
        return blob, 200, {'Content-Type': 'image/png'}
    finally:
        conn.close()


@app.route('/img/baseline/by-id/<int:baseline_id>.png')
def img_baseline_by_id(baseline_id):
    conn = get_conn()
    try:
        blob = store.get_baseline_image_by_id(conn, baseline_id)
        if blob is None:
            abort(404)
        return blob, 200, {'Content-Type': 'image/png'}
    finally:
        conn.close()


@app.route('/img/baseline-diff/by-id/<int:baseline_id>.png')
def img_baseline_diff_by_id(baseline_id):
    """The diff overlay that was current when this baseline was accepted."""
    conn = get_conn()
    try:
        blob = store.get_baseline_diff_image(conn, baseline_id)
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


@app.route('/tree/baseline/by-id/<int:baseline_id>')
def tree_baseline_by_id(baseline_id):
    conn = get_conn()
    try:
        text = store.get_baseline_tree_by_id(conn, baseline_id)
        if text is None:
            abort(404)
        return text, 200, {'Content-Type': 'application/json'}
    finally:
        conn.close()


@app.route('/outline/baseline/by-id/<int:baseline_id>')
def outline_baseline_by_id(baseline_id):
    conn = get_conn()
    try:
        text = store.get_baseline_outline_by_id(conn, baseline_id)
        if text is None:
            abort(404)
        return text, 200, {'Content-Type': 'text/plain; charset=utf-8'}
    finally:
        conn.close()


@app.route('/api/baseline-step/<kind>/<int:baseline_id>')
def api_baseline_step(kind, baseline_id):
    """Metadata + the stored diff for a single accepted baseline step."""
    conn = get_conn()
    try:
        if kind == 'visual':
            meta = store.get_visual_baseline_meta(conn, baseline_id)
        elif kind == 'a11y':
            meta = store.get_a11y_baseline_meta(conn, baseline_id)
        else:
            abort(404)
        if meta is None:
            abort(404)
        return jsonify(meta)
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
    app.run(host='127.0.0.1', port=8002, debug=False)
