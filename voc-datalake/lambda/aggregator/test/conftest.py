"""Shared pytest fixtures for aggregator tests."""
import pytest
from unittest.mock import MagicMock
from decimal import Decimal

# NO FIXTURE HERE SAYS WHICH DEPLOY WROTE IT, and that is the point. Whether an
# item's insert ran before the persona axis moved is not a property of the item at
# all — it is whether the archetype row its decrement names EXISTS, which
# `update_counter` reports back and a test arranges on the table. See
# `_reverse_a_pre_deploy_persona_row`.


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

    Also the shape that shows the pre-deploy fallback is not triggered by an item's
    PERSONA SHAPE: an anonymous item written before the axis moved looks exactly like
    this one, and its insert still counted it under the old default. What separates
    them is whether the archetype row exists, which is a fact about the table.
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
    """An old image arranged so the two persona derivations name DIFFERENT rows.

    A `persona_name` and no `persona_type`, which is what lets a test see WHICH row a
    write went to — an item carrying both cannot, because then only the value differs
    and not the derivation.

    ⚠️ THIS IS NOT "THE PRE-DEPLOY SHAPE", and reading it as one is a mistake this
    fixture has invited before. `processor/handler.py` has written both persona fields
    since the initial commit, so the axis move changed only the READER: a real
    pre-deploy item usually carries a `persona_type` too, the dominant one being
    `sample_anonymous_feedback_item`'s shape exactly. Nothing on an item says which
    deploy inserted it, which is why the fallback triggers on the archetype ROW being
    absent instead — a fact about the table, arranged per test.

    The subject of TestAPreDeployImageIsReversedOnTheRowItsInsertCreated in
    test_handler.py — the only case in which the reversal reads the old field, and
    the reason it may.
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
