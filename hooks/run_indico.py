#!/usr/bin/env python
"""Wrapper around the Indico CLI that freezes the server clock first.

Forwards all argv to `indico.cli.core.cli`. The clock is frozen at the timestamp
in the INDICO_VISUAL_FROZEN_TIME env var (default: 2026-06-15T12:00:00+00:00).

freezegun patches the `datetime`/`time` modules globally; since
`indico.util.date_time.now_utc` is just `datetime.now(pytz.UTC)`, it picks up
the frozen clock automatically. No further monkeypatching is needed for
Python-side timestamps. Postgres-side `NOW()` defaults are NOT patched (Indico
uses Python-side `default=now_utc` for the columns that matter — see
indico/modules/events/models/events.py:189).
"""

import os
import sys

from freezegun import freeze_time

DEFAULT_FROZEN = '2026-06-15T12:00:00+00:00'


def main():
    frozen = os.environ.get('INDICO_VISUAL_FROZEN_TIME', DEFAULT_FROZEN)
    freezer = freeze_time(frozen)
    freezer.start()
    sys.stderr.write(f'[visual-regression] clock frozen at {frozen}\n')

    from indico.cli.core import cli
    cli()


if __name__ == '__main__':
    main()
