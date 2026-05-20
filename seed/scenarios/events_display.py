"""Three event-display scenarios: lecture (past), meeting (today), conference (future).

Each event is seeded with a few contributions so contribution/timetable pages have content.
"""

from datetime import UTC, datetime, timedelta


def _event_data(*, title, description, start_dt, end_dt, timezone_name='UTC'):
    return {
        'title': title,
        'description': description,
        'start_dt': start_dt,
        'end_dt': end_dt,
        'timezone': timezone_name,
    }


def _add_contribution(event, *, title, description, start_dt, duration_minutes=30):
    from indico.core.db import db
    from indico.modules.events.contributions.models.contributions import Contribution
    from indico.modules.events.timetable.models.entries import TimetableEntry, TimetableEntryType

    contrib = Contribution(
        event=event,
        event_id=event.id,
        friendly_id=event._last_friendly_contribution_id + 1,
        title=title,
        description=description,
        duration=timedelta(minutes=duration_minutes),
    )
    event._last_friendly_contribution_id = contrib.friendly_id
    db.session.add(contrib)
    db.session.flush()

    entry = TimetableEntry(event=event, type=TimetableEntryType.CONTRIBUTION, contribution=contrib, start_dt=start_dt)
    db.session.add(entry)
    db.session.flush()
    return contrib


def _create_event(*, category, event_type, data, creator):
    from indico.modules.events.operations import create_event

    data = dict(data)
    data['creator'] = creator
    return create_event(category, event_type, data)


def seed(ctx):
    from flask import session

    from indico.modules.categories.operations import create_category
    from indico.modules.events.models.events import EventType

    admin = ctx.get('admin')
    manager = ctx.get('manager')
    root = ctx.get('rootCategory')

    with ctx.app.test_request_context():
        session.set_session_user(admin)

        child = create_category(root, {
            'title': 'Visual Regression — Child Category',
            'description': 'Nested category populated by the visual regression suite.',
        })
        ctx.remember('childCategoryId', child.id)

        now = datetime.now(UTC).replace(microsecond=0)

        lecture = _create_event(
            category=child,
            event_type=EventType.lecture,
            data=_event_data(
                title='Visual Regression Lecture',
                description='A short lecture seeded for visual regression coverage.',
                start_dt=now - timedelta(days=30),
                end_dt=now - timedelta(days=30) + timedelta(hours=1),
            ),
            creator=manager,
        )
        ctx.remember('lectureEventId', lecture.id)

        meeting = _create_event(
            category=child,
            event_type=EventType.meeting,
            data=_event_data(
                title='Visual Regression Meeting',
                description='A small meeting happening "today" in frozen time.',
                start_dt=now + timedelta(hours=1),
                end_dt=now + timedelta(hours=3),
            ),
            creator=manager,
        )
        ctx.remember('meetingEventId', meeting.id)
        _add_contribution(
            meeting,
            title='Welcome',
            description='Welcome and overview.',
            start_dt=now + timedelta(hours=1),
            duration_minutes=15,
        )
        _add_contribution(
            meeting,
            title='Status update',
            description='Project status round-table.',
            start_dt=now + timedelta(hours=1, minutes=15),
            duration_minutes=45,
        )

        conference = _create_event(
            category=child,
            event_type=EventType.conference,
            data=_event_data(
                title='Visual Regression Conference',
                description='A multi-day conference seeded for visual regression coverage.',
                start_dt=now + timedelta(days=30),
                end_dt=now + timedelta(days=32),
            ),
            creator=manager,
        )
        ctx.remember('conferenceEventId', conference.id)
        conference_start = now + timedelta(days=30)
        _add_contribution(
            conference,
            title='Opening keynote',
            description='Welcome to the visual regression conference.',
            start_dt=conference_start + timedelta(hours=9),
            duration_minutes=45,
        )
        _add_contribution(
            conference,
            title='Workshop A',
            description='Hands-on workshop A.',
            start_dt=conference_start + timedelta(hours=10),
            duration_minutes=90,
        )
        _add_contribution(
            conference,
            title='Closing remarks',
            description='Wrap-up and thanks.',
            start_dt=conference_start + timedelta(days=1, hours=16),
            duration_minutes=30,
        )

        conference.update_principal(manager, full_access=True)
