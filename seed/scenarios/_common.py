"""Personas + root category.

Run first, before any scenario that creates events.
"""

import bcrypt
from pathlib import Path

PERSONAS_PATH = Path(__file__).resolve().parent.parent.parent / 'config' / 'personas.json'


def _bcrypt(password):
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def _create_user(*, email, first_name, last_name, password, is_admin=False, affiliation='', phone=''):
    from indico.core.db import db
    from indico.modules.auth.models.identities import Identity
    from indico.modules.users.models.users import User

    user = User(
        first_name=first_name,
        last_name=last_name,
        title=0,
        affiliation=affiliation,
        phone=phone,
        address='',
        is_system=False,
        is_admin=is_admin,
        is_blocked=False,
        is_pending=False,
        is_deleted=False,
    )
    user.email = email
    db.session.add(user)
    db.session.flush()

    identity = Identity(
        user_id=user.id,
        provider='indico',
        identifier=email,
        multipass_data={},
        _data={},
        password_hash=_bcrypt(password),
    )
    db.session.add(identity)
    db.session.flush()
    return user


def seed(ctx):
    import json

    from indico.modules.categories.models.categories import Category

    personas = json.loads(PERSONAS_PATH.read_text())

    admin = _create_user(
        email=personas['admin']['login']['email'],
        first_name='Visual',
        last_name='Admin',
        password=personas['admin']['login']['password'],
        is_admin=True,
    )
    manager = _create_user(
        email=personas['manager']['login']['email'],
        first_name='Visual',
        last_name='Manager',
        password=personas['manager']['login']['password'],
    )
    participant = _create_user(
        email=personas['participant']['login']['email'],
        first_name='Visual',
        last_name='Participant',
        password=personas['participant']['login']['password'],
        affiliation='Visual Regression Institute',
        phone='+1 202 555 0142',
    )

    ctx.remember('adminUserId', admin.id)
    ctx.remember('managerUserId', manager.id)
    ctx.remember('participantUserId', participant.id)

    root = Category.get_root()
    root.title = 'Indico Visual Regression Root'
    root.description = 'Top-level category used by the visual regression suite.'

    ctx.remember('rootCategoryId', root.id)
    ctx.stash('admin', admin)
    ctx.stash('manager', manager)
    ctx.stash('participant', participant)
    ctx.stash('rootCategory', root)
