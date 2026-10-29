"""
Shared pytest fixtures for Lambda API handler tests.
"""
import json
import os
import sys
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest

# Add lambda directory to path for shared module imports
# and lambda/api directory for handler imports
lambda_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
api_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, lambda_dir)
sys.path.insert(0, api_dir)
# This directory too, so helper modules beside the tests (plugin_manifests.py) are
# importable from conftest as well as from the test files — pytest adds it when it
# imports a TEST module, but conftest.py is imported before that happens.
#
# APPENDED, not inserted at 0: this directory holds files named for what they test,
# so putting it first would let a future `json.py` or `logging.py` beside these tests
# shadow the stdlib for the whole suite. Appending cannot shadow anything, and still
# resolves plugin_manifests, which nothing else provides.
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# Set environment variables BEFORE importing handlers
os.environ['FEEDBACK_TABLE'] = 'test-feedback'
os.environ['AGGREGATES_TABLE'] = 'test-aggregates'
os.environ['CONVERSATIONS_TABLE'] = 'test-conversations'
os.environ['PROJECTS_TABLE'] = 'test-projects'
os.environ['JOBS_TABLE'] = 'test-jobs'
os.environ['AWS_DEFAULT_REGION'] = 'us-east-1'
os.environ['POWERTOOLS_SERVICE_NAME'] = 'test-voc-api'
os.environ['POWERTOOLS_METRICS_NAMESPACE'] = 'TestVoC'
os.environ['ALLOWED_ORIGIN'] = 'http://localhost:5173'
os.environ['SECRETS_ARN'] = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secrets'
os.environ['RAW_DATA_BUCKET'] = 'test-raw-data-bucket'
os.environ['PROCESSING_QUEUE_URL'] = 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue'
os.environ['USER_POOL_ID'] = 'us-east-1_testpool'


@pytest.fixture(autouse=True)
def _fresh_response_cache():
    """Empty the warm-container read memo (shared/response_cache.py) around every test.

    The memo is process-wide by design, so without this one test's answer could be
    served to the next test that asks the same question with unchanged versions.
    """
    from shared.response_cache import DEFAULT_CACHE
    DEFAULT_CACHE.clear()
    yield
    DEFAULT_CACHE.clear()


@pytest.fixture(autouse=True)
def _no_circuit_store():
    """`GET /sources/status`, enable and reset read/clear plugin circuit rows
    (shared/plugin_circuit.py). Default them to "no table" — every circuit closed,
    a clear is a no-op — so the integrations suites that predate the circuit never
    reach DynamoDB. A test that needs rows patches
    `shared.plugin_circuit.get_aggregates_table` itself (a nested patch wins)."""
    with patch('shared.plugin_circuit.get_aggregates_table', return_value=None):
        yield


@pytest.fixture(autouse=True)
def import_run_rows():
    """The import-history rows (shared/import_runs.py) the routes write, captured instead of
    reaching DynamoDB. A test that asserts on the record a route wrote takes this fixture."""
    rows: list[dict] = []
    with patch('shared.import_runs._put_rows', side_effect=lambda _table, items: rows.extend(items)):
        yield rows


@pytest.fixture(autouse=True)
def _ai_driven_by_default():
    """The PR/FAQ / PRD AI-writing gate (shared/ai_writing.py) reads the caller's way of
    working from the aggregates table and FAILS CLOSED when it cannot. Default every caller
    to the no-row answer (AI-driven, today's behaviour) so the projects suites that predate
    the gate never reach DynamoDB. A test about the gate patches
    `shared.ai_mode.get_ai_mode` itself (a nested patch wins)."""
    from shared import ai_mode

    with patch('shared.ai_mode.get_ai_mode', return_value=ai_mode.DEFAULT_AI_MODE):
        yield


@pytest.fixture(autouse=True)
def _fresh_plugin_secret_defaults():
    """Drop `integrations_handler._plugin_secret_defaults`'s process-wide cache after each test.

    monkeypatch restores PLUGIN_SECRET_DEFAULTS when a test ends, but not the parse
    cached from it, so a test that parsed its own value left that plugin list for the
    next test on the worker (a later 400 "not a configured plugin" depended on test
    order). Only cleared when the handler is already imported: importing it here
    would run its module setup for every API test.
    """
    yield
    handler = sys.modules.get('integrations_handler')
    if handler is not None:
        handler._plugin_secret_defaults.cache_clear()


@pytest.fixture
def plugin_secret_defaults(monkeypatch):
    """Give the integrations handler the PLUGIN_SECRET_DEFAULTS that CDK sets.

    Any test exercising GET /integrations/status needs this: without it the
    handler knows of no sources and returns {}. The lru_cache is cleared on both
    sides so neither this value nor a previous one leaks between tests.
    """
    # Imported here, after the sys.path setup above has run, which is what
    # makes both resolvable.
    from plugin_manifests import PLUGIN_SECRET_DEFAULTS

    import integrations_handler as h

    monkeypatch.setenv(h.PLUGIN_DEFAULTS_ENV_VAR, json.dumps(PLUGIN_SECRET_DEFAULTS))
    h._plugin_secret_defaults.cache_clear()
    yield PLUGIN_SECRET_DEFAULTS
    h._plugin_secret_defaults.cache_clear()


@pytest.fixture
def feedback_form_handler():
    """The imported `feedback_form_handler` module.

    `sys.path` already carries `lambda/api` (set at the top of this file), so the
    import needs no per-test path juggling. A fixture rather than a module-level
    import so that a test importing it is still what triggers the import, and a
    handler that cannot be imported fails the tests that use it rather than
    collection of the whole file.
    """
    import feedback_form_handler
    return feedback_form_handler


@pytest.fixture
def api_gateway_event():
    """Factory fixture to create API Gateway events."""
    def _create_event(
        method: str = 'GET',
        path: str = '/feedback',
        query_params: dict | None = None,
        body: dict | None = None,
        path_params: dict | None = None,
        headers: dict | None = None,
        resource: str | None = None,
        claims: dict | None = None,
    ):
        # `claims` replaces the authorizer claims wholesale; omitted, the caller
        # is the admin below, so tests that predate per-project permissions are
        # unaffected by the access gate.
        # Auto-generate resource from path if not provided
        # For proxy routes, replace the proxy value with {proxy+}
        if resource is None:
            resource = path
            if path_params and 'proxy' in path_params:
                proxy_value = path_params['proxy']
                resource = path.replace(f'/{proxy_value}', '/{proxy+}')

        return {
            'httpMethod': method,
            'path': path,
            'resource': resource,
            'queryStringParameters': query_params or {},
            'pathParameters': path_params or {},
            'body': json.dumps(body) if body else None,
            'headers': {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer test-token',
                **(headers or {})
            },
            'requestContext': {
                'authorizer': {
                    'claims': claims if claims is not None else {
                        'sub': 'test-user-id',
                        'email': 'test@example.com',
                        'cognito:groups': 'admins'
                    }
                },
                'requestId': 'test-request-id',
                'stage': 'test'
            },
            'isBase64Encoded': False
        }
    return _create_event


@pytest.fixture
def existing_project():
    """`projects_handler` sees exactly one project, `proj-123`, as existing.

    The id every handler test addresses by convention. Tests about a MISSING
    project (404 before any job row) do not use this fixture.
    """
    from handler_events_fixtures import project_meta_table

    with patch('projects_handler.get_projects_table', return_value=project_meta_table('proj-123')):
        yield


@pytest.fixture
def lambda_context():
    """Create a mock Lambda context."""
    context = MagicMock()
    context.function_name = 'test-voc-api'
    context.memory_limit_in_mb = 256
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:test-voc-api'
    context.aws_request_id = 'test-request-id-12345'
    context.get_remaining_time_in_millis.return_value = 30000
    return context


@pytest.fixture
def sample_feedback_item():
    """Create a sample feedback item for testing."""
    return {
        'pk': 'SOURCE#webscraper',
        'sk': 'FEEDBACK#test-123',
        'feedback_id': 'test-123',
        'source_platform': 'webscraper',
        'source_id': 'review-456',
        'original_text': 'Great product, love the features!',
        'sentiment_label': 'positive',
        'sentiment_score': 0.85,
        'category': 'product_quality',
        'urgency': 'low',
        'date': datetime.now(UTC).strftime('%Y-%m-%d'),
        'source_created_at': datetime.now(UTC).isoformat(),
        'processed_at': datetime.now(UTC).isoformat(),
    }


@pytest.fixture
def sample_feedback_items(sample_feedback_item):
    """Create multiple sample feedback items."""
    items = [sample_feedback_item]
    items.append({
        **sample_feedback_item,
        'pk': 'SOURCE#manual_import',
        'sk': 'FEEDBACK#test-456',
        'feedback_id': 'test-456',
        'source_platform': 'manual_import',
        'original_text': 'Delivery was slow, disappointed.',
        'sentiment_label': 'negative',
        'sentiment_score': -0.65,
        'category': 'delivery',
        'urgency': 'high',
    })
    return items
