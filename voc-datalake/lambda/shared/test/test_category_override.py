"""`category_override.by_sub` never leaves the API (shared.category_override)."""
import json

from aws_lambda_powertools.utilities.typing import LambdaContext

from shared.api import create_api_resolver
from shared.category_override import public_override, redact_category_overrides

STORED = {
    'previous_category': 'delivery', 'previous_subcategory': 'late',
    'by_sub': 'sub-secret', 'by_username': 'ada', 'at': '2026-01-01T00:00:00Z', 'extra': 'x',
}
PUBLIC = {
    'previous_category': 'delivery', 'previous_subcategory': 'late',
    'by_username': 'ada', 'at': '2026-01-01T00:00:00Z',
}


def test_public_override_keeps_only_the_public_fields():
    assert public_override(STORED) == PUBLIC
    assert public_override('junk') is None


def test_redacts_every_nested_override():
    body = {'items': [{'feedback_id': 'a', 'category_override': STORED}], 'item': {'category_override': STORED}}
    assert redact_category_overrides(body) == {
        'items': [{'feedback_id': 'a', 'category_override': PUBLIC}], 'item': {'category_override': PUBLIC},
    }


def test_every_resolver_strips_by_sub_from_its_responses():
    """The shared resolver applies the sanitiser, so a route returning raw items cannot leak it."""
    app = create_api_resolver()

    @app.get('/raw')
    def raw():
        return {'items': [{'feedback_id': 'a', 'category_override': dict(STORED)}]}

    event = {'httpMethod': 'GET', 'path': '/raw', 'resource': '/raw', 'headers': {},
             'requestContext': {'httpMethod': 'GET', 'path': '/raw', 'stage': 'test'}}
    response = app.resolve(event, LambdaContext())
    assert response['statusCode'] == 200
    assert json.loads(response['body'])['items'][0]['category_override'] == PUBLIC
