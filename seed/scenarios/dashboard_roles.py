"""Dashboard role-icon fixtures.

Gives the *manager* persona four upcoming events, each granting exactly one of
the relationship roles shown by the "Your events at hand" legend on the user
dashboard (management / reviewing / attendance / favorited). This makes every
role icon appear in its active state (one per row) and in its disabled state
(on the other rows), so the dashboard role-icon tooltips are fully exercised by
the visual + a11y snapshots.

Fixtures live in a dedicated category that no page in pages.json captures, so
the only intended baseline change is on user-dashboard/manager (plus the single
extra sub-category line on the root category display).

Run after events_display.
"""

from datetime import UTC, datetime, timedelta


def _event_data(*, title, start_dt, end_dt):
    return {
        'title': title,
        'description': 'Seeded to exercise the dashboard role-icon legend.',
        'start_dt': start_dt,
        'end_dt': end_dt,
        'timezone': 'UTC',
    }


def seed(ctx):
    from flask import session

    from indico.core.db import db
    from indico.modules.categories.operations import create_category
    from indico.modules.events.models.events import EventType
    from indico.modules.events.operations import create_event
    from indico.modules.events.registration.models.forms import RegistrationForm
    from indico.modules.events.registration.models.registrations import Registration, RegistrationState
    from indico.modules.events.registration.util import create_personal_data_fields

    from seed.scenarios._common import _create_user

    admin = ctx.get('admin')
    manager = ctx.get('manager')
    root = ctx.get('rootCategory')

    # A non-persona owner so that creating these events does not give any captured
    # persona the "creator" role; the manager only gets the role we assign below.
    owner = _create_user(
        email='dashboard-fixtures-owner@example.test',
        first_name='Fixtures',
        last_name='Owner',
        password='unused-dashboard-fixtures-owner',
    )

    with ctx.app.test_request_context():
        session.set_session_user(admin)

        fixtures = create_category(root, {
            'title': 'Dashboard Role Fixtures',
            'description': 'Events that give the manager persona distinct dashboard roles.',
        })
        ctx.remember('dashboardFixturesCategoryId', fixtures.id)

        now = datetime.now(UTC).replace(microsecond=0)

        def _make(title, days_ahead):
            data = _event_data(
                title=title,
                start_dt=now + timedelta(days=days_ahead),
                end_dt=now + timedelta(days=days_ahead, hours=2),
            )
            data['creator'] = owner
            return create_event(fixtures, EventType.conference, data)

        management_event = _make('Dashboard Role — Management', 2)
        reviewing_event = _make('Dashboard Role — Reviewing', 3)
        attendance_event = _make('Dashboard Role — Attendance', 4)
        favorited_event = _make('Dashboard Role — Favorited', 5)

        # Persist the events first: the registration's friendly-id counter runs in
        # a separate transaction and would not see an uncommitted attendance event.
        db.session.commit()

        # management: full management access -> conference_manager role
        management_event.update_principal(manager, full_access=True)

        # reviewing: global abstract-review permission -> abstract_reviewer role
        reviewing_event.update_principal(manager, add_permissions={'review_all_abstracts'})

        # favorited: event in the user's favourites
        manager.favorite_events.add(favorited_event)

        # attendance: a completed registration -> registration_registrant role
        regform = RegistrationForm(event=attendance_event, title='Registration', currency='EUR')
        create_personal_data_fields(regform)
        db.session.add(regform)
        db.session.flush()
        registration = Registration(
            registration_form=regform,
            user=manager,
            first_name='Visual',
            last_name='Manager',
            email=manager.email,
            currency='EUR',
            state=RegistrationState.complete,
        )
        attendance_event.registrations.append(registration)
        db.session.flush()
        db.session.flush()
