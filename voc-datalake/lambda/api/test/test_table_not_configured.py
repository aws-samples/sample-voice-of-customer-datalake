"""
Consolidated test: all handlers return 500 when DynamoDB tables are not configured.

Instead of testing this pattern per-handler per-endpoint (50+ duplicate tests),
we verify it once per handler module. The pattern is always the same:
if not table: raise ConfigurationError("...not configured").
"""
import importlib
import json
import pytest


def _make_event(method: str, path: str, body: dict = None) -> dict:
    return {
        'httpMethod': method,
        'path': path,
        'resource': path,
        'queryStringParameters': {},
        'pathParameters': {},
        'body': json.dumps(body) if body else None,
        'headers': {'Content-Type': 'application/json'},
        'requestContext': {'requestId': 'test', 'stage': 'test'},
        'isBase64Encoded': False,
    }


@pytest.mark.parametrize("module_name,table_attr,method,path,body", [
    ("settings_handler", "aggregates_table", "GET", "/settings/brand", None),
    ("settings_handler", "aggregates_table", "PUT", "/settings/brand", {"brand_name": "X"}),
    ("settings_handler", "aggregates_table", "GET", "/settings/review", None),
    ("settings_handler", "aggregates_table", "PUT", "/settings/categories", {"categories": []}),
    ("logs_handler", "aggregates_table", "GET", "/logs/processing", None),
    ("logs_handler", "aggregates_table", "GET", "/logs/summary", None),
])
def test_handler_returns_500_when_table_not_configured(
    module_name, table_attr, method, path, body, lambda_context
):
    """Each handler returns 500 when its required DynamoDB table is None."""
    mod = importlib.import_module(module_name)
    original = getattr(mod, table_attr)
    try:
        setattr(mod, table_attr, None)
        event = _make_event(method, path, body)
        response = mod.lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500
    finally:
        setattr(mod, table_attr, original)
