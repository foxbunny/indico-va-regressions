"""Category selection fixtures for moves, restricted destinations and template cloning."""


def seed(ctx):
    from flask import session
    from indico.core.db import db
    from indico.core.db.sqlalchemy.protection import ProtectionMode
    from indico.modules.categories.operations import create_category
    from indico.modules.designer import TemplateType
    from indico.modules.designer.models.templates import DesignerTemplate

    with ctx.app.test_request_context():
        session.set_session_user(ctx.get('admin'))
        parent = create_category(ctx.get('rootCategory'), {'title': 'Navigator fixtures'})
        source = create_category(parent, {'title': 'Navigator source'})
        descendant = create_category(source, {'title': 'Navigator descendant'})
        destination = create_category(parent, {'title': 'Navigator destination'})
        private = create_category(parent, {'title': 'Navigator private'})
        private.protection_mode = ProtectionMode.protected
        for name, category in [('Parent', parent), ('Source', source), ('Descendant', descendant),
                               ('Destination', destination), ('Private', private)]:
            ctx.remember(f'navigator{name}Id', category.id)
        template = DesignerTemplate(category=parent, title='Navigator template', type=TemplateType.poster,
                                    data={'items': [], 'background_position': 'stretch'})
        db.session.add(template)
        db.session.flush()
        ctx.remember('navigatorTemplateId', template.id)
