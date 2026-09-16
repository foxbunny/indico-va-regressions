"""Registration-form required-dropdown fixture (field-configuration modal).

One unlisted conference created by the *admin* persona, with the registration
feature enabled and an open registration form that carries a single "single
choice" field (rendered as a dropdown). The captured page is the registration
form *builder* (management), where opening a field's configuration modal shows a
required Semantic ``FinalDropdown`` — the "Type of selection" selector — next to
the required "Title" text input.

Why this fixture exists: the required-field accessibility fix adds a programmatic
required state (``aria-required``) to non-native form widgets rendered through
the shared ``FormFieldAdapter``. Required text inputs already expose their state
via the native ``required`` attribute, so they are unaffected; the gap is on
non-native widgets such as a Semantic ``FinalDropdown``, which shows the visual
asterisk but has no programmatic required state. The registration display form
uses native ``<select>`` elements (already accessible), so it does not exercise
the fix — the field-configuration modal, which uses a genuine Semantic
``FinalDropdown``, is where the before/after can be shown for the report.

Why the admin owns and captures it: the builder is a management page, so the
admin (event owner) has access. An unlisted event keeps the fixture out of every
category listing.

Isolation: an unlisted event has no category, so it never appears in a category
listing or subcategory count. The only captured page it perturbs is the admin's
own dashboard (an unlisted-events block plus an events-at-hand entry), which is
re-flushed to absorb it before the fix. The builder-modal page is backfilled
pre-change (the "Type of selection" dropdown without a required state); the
branch run then shows that dropdown gaining the required state.

Run after _common (needs the admin persona).
"""

from datetime import UTC, datetime, timedelta


def _id(n):
    return f'{n:08d}-0000-0000-0000-000000000000'


def seed(ctx):
    from flask import session

    from indico.core.db import db
    from indico.modules.events.features.util import set_feature_enabled
    from indico.modules.events.models.events import EventType
    from indico.modules.events.operations import create_event
    from indico.modules.events.registration.models.form_fields import RegistrationFormField
    from indico.modules.events.registration.models.forms import RegistrationForm
    from indico.modules.events.registration.models.items import RegistrationFormSection
    from indico.modules.events.registration.util import create_personal_data_fields

    admin = ctx.get('admin')

    with ctx.app.test_request_context():
        session.set_session_user(admin)

        now = datetime.now(UTC).replace(microsecond=0)
        start = now + timedelta(days=20)

        conference = create_event(None, EventType.conference, {
            'title': 'Registration Form Fixture',
            'description': 'Seeded to exercise a required registration-form dropdown.',
            'start_dt': start,
            'end_dt': start + timedelta(days=2),
            'timezone': 'UTC',
            'creator': admin,
        })

        set_feature_enabled(conference, 'registration', True)

        regform = RegistrationForm(
            event=conference,
            title='Registration',
            currency='USD',
            start_dt=now - timedelta(days=1),
            end_dt=now + timedelta(days=30),
        )
        create_personal_data_fields(regform)
        for field in regform.sections[0].fields:
            field.is_enabled = True
        db.session.add(regform)
        db.session.flush()

        section = RegistrationFormSection(registration_form=regform, title='Preferences')
        db.session.add(section)
        db.session.flush()

        field = RegistrationFormField(
            input_type='single_choice',
            title='Preferred track',
            parent=section,
            registration_form=regform,
            is_required=True,
        )
        field.versioned_data = {
            'choices': [
                {'id': _id(1), 'places_limit': 0, 'price': 0},
                {'id': _id(2), 'places_limit': 0, 'price': 0},
            ]
        }
        field.data = {
            'item_type': 'dropdown',
            'captions': {
                _id(1): 'Theory',
                _id(2): 'Experiment',
            },
        }
        db.session.add(field)
        db.session.flush()

        ctx.remember('regformEventId', conference.id)
        ctx.remember('regformId', regform.id)
