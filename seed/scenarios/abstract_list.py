"""Abstract-management-list toolbar fixture.

One unlisted conference created by the *admin* persona, with the Call for
Abstracts feature enabled and two abstracts. This is the only place the suite
exercises the management list action toolbar (Remove / Judge / Authors list /
Send email / Export, plus the bulk-selection split button) in its default
no-selection state, so the disabled-state and bulk-button-name fixes can be
proven on the abstract list page.

Why the admin owns it: like the person-link fixture, a server admin who is not
an explicit manager is bounced from an unlisted event's management area, so the
admin persona (which opens this page) must own the event to manage it directly.
A conference is required because the abstracts feature is only allowed for
conferences.

Isolation: an unlisted event has no category, so it never appears in a category
listing or in any subcategory's event count. The only captured page it touches
is the admin's own dashboard (an unlisted-events block plus an events-at-hand
entry), which is re-flushed to absorb it before the fix. The new abstract list
page is backfilled pre-change.

Run after _common (needs the admin persona).
"""

from datetime import UTC, datetime, timedelta


def seed(ctx):
    from flask import session

    from indico.core.db import db
    from indico.modules.events.abstracts.models.abstracts import Abstract
    from indico.modules.events.features.util import set_feature_enabled
    from indico.modules.events.models.events import EventType
    from indico.modules.events.operations import create_event

    admin = ctx.get('admin')

    with ctx.app.test_request_context():
        session.set_session_user(admin)

        now = datetime.now(UTC).replace(microsecond=0)
        start = now + timedelta(days=20)

        conference = create_event(None, EventType.conference, {
            'title': 'Abstract List Fixture',
            'description': 'Seeded to exercise the management list action toolbar.',
            'start_dt': start,
            'end_dt': start + timedelta(days=2),
            'timezone': 'UTC',
            'creator': admin,
        })

        set_feature_enabled(conference, 'abstracts', True)
        conference.cfa.schedule(now - timedelta(days=1), now + timedelta(days=30), None)

        for title in ('Superconductivity at room temperature', 'A survey of gauge theories'):
            abstract = Abstract(
                event=conference,
                friendly_id=conference._last_friendly_contribution_id + 1,
                title=title,
                submitter=admin,
            )
            conference._last_friendly_contribution_id = abstract.friendly_id
            db.session.add(abstract)
            db.session.flush()

        ctx.remember('abstractListEventId', conference.id)
