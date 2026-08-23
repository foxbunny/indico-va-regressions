"""Person-link field fixture.

One unlisted meeting created by the *admin* persona, carrying a single
chairperson, so the event "Chairpersons" management form renders the
PersonLinkField's icon controls: the role toggle (paperclip), the two row
actions (edit / delete) and the auto-sort toggle. This is the only place the
suite exercises those controls, so the accessible-name fix for them can be
proven.

Why the admin owns it: a server admin who is *not* an explicit manager is
bounced to the login page when opening an unlisted event's management area in
this config (the bare admin override does not reach unlisted events). Since the
admin persona is the one that opens these pages, it must own the event so it can
manage it directly.

Isolation: an unlisted event has no category, so it never appears in a category
listing or in any subcategory's deep_events_count. The only captured page it
touches is the admin's own dashboard (an unlisted-events block plus an
events-at-hand entry), which is re-flushed to absorb it before the fix. The five
new person-link pages are backfilled pre-change.

Run after _common (needs the admin persona).
"""

from datetime import UTC, datetime, timedelta


def seed(ctx):
    from flask import session

    from indico.core.db import db
    from indico.modules.events.models.events import EventType
    from indico.modules.events.models.persons import EventPerson, EventPersonLink
    from indico.modules.events.operations import create_event

    admin = ctx.get('admin')

    with ctx.app.test_request_context():
        session.set_session_user(admin)

        now = datetime.now(UTC).replace(microsecond=0)
        start = now + timedelta(days=6)
        event = create_event(None, EventType.meeting, {
            'title': 'Person Link Field Fixture',
            'description': 'Seeded to exercise the person-link field icon controls.',
            'start_dt': start,
            'end_dt': start + timedelta(hours=2),
            'timezone': 'UTC',
            'creator': admin,
        })

        person = EventPerson(event=event, first_name='Ada', last_name='Lovelace',
                             email='ada.lovelace@example.test')
        event.person_links.append(EventPersonLink(person=person))
        db.session.flush()

        ctx.remember('personLinkEventId', event.id)
