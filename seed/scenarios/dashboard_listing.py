"""Dashboard listing fixtures.

Populates the *participant* persona's dashboard with the two listing blocks
that no other scenario exercises, so the event-date tooltip is captured in
every block on the user dashboard:

- "Your unlisted events": one unlisted event (no category) created by the
  participant — ``get_unlisted_events`` returns the user's own category-less
  created events.
- "Happening in your categories": the participant favorites the existing
  "Dashboard Role Fixtures" category (created by ``dashboard_roles``), so its
  upcoming events surface here via ``get_related_categories``.

The "Your events at hand" block is already exercised on the *manager* dashboard
by ``dashboard_roles``, so we leave it empty here.

This moves the participant's existing user-dashboard baseline (the two blocks
start rendering) — that change is captured by the pre-change flush, not
backfilled. Nothing else is perturbed: the unlisted event has no category so it
never appears in a category listing, and favourites are per-user.

Run after dashboard_roles (needs its fixtures category).
"""

from datetime import UTC, datetime, timedelta


def seed(ctx):
    from flask import session

    from indico.core.db import db
    from indico.modules.categories.models.categories import Category
    from indico.modules.events.models.events import EventType
    from indico.modules.events.operations import create_event

    participant = ctx.get('participant')
    fixtures_category = Category.get(ctx.get('dashboardFixturesCategoryId'))

    with ctx.app.test_request_context():
        session.set_session_user(participant)

        now = datetime.now(UTC).replace(microsecond=0)
        start = now + timedelta(days=6)
        create_event(None, EventType.lecture, {
            'title': 'Participant Unlisted Event',
            'start_dt': start,
            'end_dt': start + timedelta(hours=2),
            'timezone': 'UTC',
            'creator': participant,
        })

        participant.favorite_categories.add(fixtures_category)
        db.session.flush()
