"""Shared pytest fixtures for aggregator tests."""
import pytest
from unittest.mock import MagicMock
from decimal import Decimal


@pytest.fixture
def mock_aggregates_table():
    """Create a mock DynamoDB aggregates table."""
    table = MagicMock()
    table.update_item.return_value = {}
    table.get_item.return_value = {}
    return table


@pytest.fixture
def sample_feedback_item():
    """Sample feedback item from DynamoDB stream."""
    return {
        'pk': 'SOURCE#webscraper',
        'sk': 'FEEDBACK#abc123',
        'feedback_id': 'abc123',
        'date': '2025-01-15',
        'source_platform': 'webscraper',
        'category': 'product_quality',
        'sentiment_label': 'positive',
        'sentiment_score': Decimal('0.85'),
        'urgency': 'low',
        # Both persona fields, because the processor writes both — and the metrics
        # axis buckets by the ARCHETYPE (`persona_type`), so a fixture carrying
        # only a name would agree with the aggregator about a field production
        # rarely produces. See test_persona_field_lockstep.py.
        'persona_name': 'Happy Customer',
        'persona_type': 'advocate',
    }


@pytest.fixture
def sample_urgent_feedback_item():
    """Sample urgent feedback item."""
    return {
        'pk': 'SOURCE#webscraper',
        'sk': 'FEEDBACK#urgent123',
        'feedback_id': 'urgent123',
        'date': '2025-01-15',
        'source_platform': 'webscraper',
        'category': 'customer_support',
        'sentiment_label': 'negative',
        'sentiment_score': Decimal('-0.75'),
        'urgency': 'high',
        'persona_name': 'Frustrated Customer',
        'persona_type': 'churn_risk',
    }


@pytest.fixture
def sample_anonymous_feedback_item():
    """The shape of nearly every item this platform really ingests.

    An archetype and NO name: the enrichment contract declares `persona.name` as
    "string or null", the corpus is scraped reviews and mostly anonymous form
    submissions, and the processor strips None before writing — so an anonymous item
    arrives with no `persona_name` key at all. Bucketing the persona axis by that
    field put 99.97% of a 6,239-item corpus in one `Unknown` bucket, which is why
    the axis buckets by `persona_type`. A fixture, because the two fixtures above
    both carry a name and so cannot tell the two fields apart.
    """
    return {
        'pk': 'SOURCE#webscraper',
        'sk': 'FEEDBACK#anon1',
        'feedback_id': 'anon1',
        'date': '2025-01-15',
        'source_platform': 'webscraper',
        'category': 'delivery',
        'sentiment_label': 'negative',
        'sentiment_score': Decimal('-0.4'),
        'urgency': 'low',
        'persona_type': 'churn_risk',
    }


@pytest.fixture
def sample_pre_deploy_feedback_item():
    """An item as it was written BEFORE the persona axis moved to the archetype.

    A `persona_name` and NO `persona_type`, so that the two derivations name
    DIFFERENT rows and a test can tell which one a write went to: that item's insert
    counted it under `METRIC#persona#<the name>`, a row today's derivation never
    names. The subject of
    TestAPreDeployImageIsReversedOnTheRowItsInsertCreated in test_handler.py — the
    only case in which the reversal reads the old field, and the reason it may.

    ⚠️ THIS SHAPE IS NOT WHAT MAKES AN IMAGE PRE-DEPLOY, and the fixture's name says
    when its insert ran, not how it is recognised. `processor/handler.py` has written
    both persona fields since the initial commit, so the axis move changed only the
    reader and a real pre-deploy item usually carries a `persona_type` too — the
    dominant one being `sample_anonymous_feedback_item`'s shape exactly. What tells
    the two apart in production is whether the ARCHETYPE ROW EXISTS, which is why the
    trigger is `CounterWrite.ROW_ABSENT` and not a test on these keys; see
    test_an_anonymous_pre_deploy_image_is_still_reversed_though_its_shape_looks_current.

    Distinct from `sample_anonymous_feedback_item` (an archetype and no name) because
    an item carrying both fields, as the other fixtures do, cannot tell the two
    derivations apart, which is how the original defect stayed green.
    """
    return {
        'pk': 'SOURCE#webscraper',
        'sk': 'FEEDBACK#legacy1',
        'feedback_id': 'legacy1',
        'date': '2025-01-15',
        'source_platform': 'webscraper',
        'category': 'delivery',
        'sentiment_label': 'neutral',
        # No `sentiment_score`. `apply_feedback` writes the running average only for
        # a scored item, so leaving it off keeps this fixture's writes to the
        # counters — which is all its tests are about — without an average write
        # needing to be filtered out of every assertion.
        'urgency': 'low',
        'persona_name': 'Veronica Chen',
    }


@pytest.fixture
def sample_dynamodb_stream_record(sample_feedback_item):
    """Create a sample DynamoDB stream record."""
    # Convert to DynamoDB format
    def to_dynamodb_format(item):
        result = {}
        for key, value in item.items():
            if isinstance(value, str):
                result[key] = {'S': value}
            elif isinstance(value, Decimal):
                result[key] = {'N': str(value)}
            elif isinstance(value, dict):
                result[key] = {'M': value}
            elif isinstance(value, list):
                result[key] = {'L': value}
            elif isinstance(value, bool):
                result[key] = {'BOOL': value}
        return result
    
    return {
        'eventName': 'INSERT',
        'dynamodb': {
            'NewImage': to_dynamodb_format(sample_feedback_item)
        }
    }


@pytest.fixture
def lambda_context():
    """Create a mock Lambda context."""
    context = MagicMock()
    context.function_name = 'test-aggregator'
    context.memory_limit_in_mb = 256
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789:function:test-aggregator'
    context.aws_request_id = 'test-request-id-67890'
    return context
