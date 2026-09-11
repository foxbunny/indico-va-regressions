"""Seed orchestrator.

Invoked inside the indico container by docker/entrypoint-indico.sh as
`python -m seed` with PYTHONPATH=/regressions and INDICO_CONFIG +
INDICO_VISUAL_FROZEN_TIME set.

Applies freezegun at the top so that any Python-side `now_utc()` calls in
Indico's operations resolve to the frozen reference time.
"""

import os
import sys

from freezegun import freeze_time

DEFAULT_FROZEN = '2026-06-15T12:00:00+00:00'
frozen = os.environ.get('INDICO_VISUAL_FROZEN_TIME', DEFAULT_FROZEN)
_freezer = freeze_time(frozen)
_freezer.start()
sys.stderr.write(f'[seed] clock frozen at {frozen}\n')

from indico.core.db import db  # noqa: E402
from indico.web.flask.app import make_app  # noqa: E402

from seed.context import SeedContext  # noqa: E402
from seed.scenarios import (  # noqa: E402
    _common,
    abstract_list,
    dashboard_listing,
    dashboard_roles,
    events_display,
    ics_export,
    person_links,
)
from storage.db import apply_schema, connect  # noqa: E402


def main():
    storage_conn = connect()
    apply_schema(storage_conn)
    storage_conn.close()
    sys.stderr.write('[seed] SQLite schema applied\n')

    app = make_app()
    with app.app_context():
        ctx = SeedContext(app)
        sys.stderr.write('[seed] running _common\n')
        _common.seed(ctx)
        db.session.commit()
        sys.stderr.write('[seed] running events_display\n')
        events_display.seed(ctx)
        db.session.commit()
        sys.stderr.write('[seed] running dashboard_roles\n')
        dashboard_roles.seed(ctx)
        db.session.commit()
        sys.stderr.write('[seed] running dashboard_listing\n')
        dashboard_listing.seed(ctx)
        db.session.commit()
        sys.stderr.write('[seed] running person_links\n')
        person_links.seed(ctx)
        db.session.commit()
        sys.stderr.write('[seed] running ics_export\n')
        ics_export.seed(ctx)
        db.session.commit()
        sys.stderr.write('[seed] running abstract_list\n')
        abstract_list.seed(ctx)
        db.session.commit()
        ctx.write_manifest()
    sys.stderr.write('[seed] complete\n')


if __name__ == '__main__':
    main()
