"""Calendar-export trigger fixture.

One conference in the dashboard-fixtures category, carrying a scheduled session
(so the session has a ``start_dt`` and its display page shows the export button)
and a contribution. This is the only place the suite exercises the
category/session/contribution ``ICSCalendarLink`` export *triggers*, so the
accessible-tooltip fix for them can be proven on the session and contribution
display pages.

Isolation: the conference lives in the dashboard-fixtures category (the same
bucket dashboard_roles uses), which no captured page renders as a display page,
so it doesn't perturb any captured category listing. It inherits its protection
from that public category, so the display pages render for the anonymous and
manager capture personas without setting an explicit protection mode (unlisted
events can't be made public — they must inherit). The new session and
contribution display pages (base + export-tooltip hover) are backfilled
pre-change.

Run after dashboard_roles (needs the fixtures category) and _common (admin).
"""

from datetime import UTC, datetime, timedelta


def seed(ctx):
    from flask import session

    from indico.core.db import db
    from indico.modules.categories.models.categories import Category
    from indico.modules.events.contributions import contribution_settings
    from indico.modules.events.contributions.models.contributions import Contribution
    from indico.modules.events.models.events import EventType
    from indico.modules.events.operations import create_event
    from indico.modules.events.sessions.models.blocks import SessionBlock
    from indico.modules.events.sessions.models.sessions import Session
    from indico.modules.events.timetable.models.entries import TimetableEntry, TimetableEntryType

    admin = ctx.get('admin')
    fixtures = Category.get(ctx.get('dashboardFixturesCategoryId'))

    with ctx.app.test_request_context():
        session.set_session_user(admin)

        now = datetime.now(UTC).replace(microsecond=0)
        start = now + timedelta(days=14)

        conference = create_event(fixtures, EventType.conference, {
            'title': 'Calendar Export Fixture',
            'description': 'Seeded to exercise the calendar export trigger controls.',
            'start_dt': start,
            'end_dt': start + timedelta(days=1),
            'timezone': 'UTC',
            'creator': admin,
        })
        ctx.remember('icsExportEventId', conference.id)

        sess = Session(
            event=conference,
            friendly_id=conference._last_friendly_session_id + 1,
            title='Morning session',
        )
        conference._last_friendly_session_id = sess.friendly_id
        db.session.add(sess)
        db.session.flush()
        block = SessionBlock(session=sess, title='Morning block', duration=timedelta(hours=2))
        db.session.add(block)
        db.session.flush()
        db.session.add(TimetableEntry(
            event=conference,
            type=TimetableEntryType.SESSION_BLOCK,
            session_block=block,
            start_dt=start + timedelta(hours=9),
        ))
        db.session.flush()
        ctx.remember('icsExportSessionId', sess.id)

        contrib = Contribution(
            event=conference,
            event_id=conference.id,
            friendly_id=conference._last_friendly_contribution_id + 1,
            title='Keynote',
            description='Keynote talk.',
            duration=timedelta(minutes=45),
        )
        conference._last_friendly_contribution_id = contrib.friendly_id
        db.session.add(contrib)
        db.session.flush()
        db.session.add(TimetableEntry(
            event=conference,
            type=TimetableEntryType.CONTRIBUTION,
            contribution=contrib,
            start_dt=start + timedelta(hours=11),
        ))
        db.session.flush()
        contribution_settings.set(conference, 'published', True)
        ctx.remember('icsExportContribId', contrib.id)
