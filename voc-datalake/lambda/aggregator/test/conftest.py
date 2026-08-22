"""Shared pytest fixtures for aggregator tests."""
import pytest
from unittest.mock import MagicMock
from datetime import datetime, timedelta
from decimal import Decimal

from aggregator.handler import LEGACY_PERSONA_CUTOVER

# `processed_at` values on either side of the persona axis's deploy boundary
# (`aggregator/handler.py::LEGACY_PERSONA_CUTOVER`). Derived from that constant rather
# than written out, so moving the boundary moves the fixtures with it and a fixture
# cannot end up on the side its name denies.
#
# The stamp is what tells a reversal which derivation counted the item, so an item
# WITHOUT one is treated as pre-deploy — which means omitting it is not neutral. Every
# fixture below therefore says which side of the boundary it is on.
_CUTOVER = datetime.fromisoformat(LEGACY_PERSONA_CUTOVER)
PROCESSED_AFTER_THE_AXIS_MOVED = (_CUTOVER + timedelta(days=1)).isoformat()
PROCESSED_BEFORE_THE_AXIS_MOVED = (_CUTOVER - timedelta(days=1)).isoformat()


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
        # Processed AFTER the axis moved, so this ordinary item's reversal is the
        # plain one — no pre-deploy compatibility. Omitting the stamp would make
        # every fixture here a pre-deploy item, which is the opposite of ordinary.
        'processed_at': PROCESSED_AFTER_THE_AXIS_MOVED,
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
        'processed_at': PROCESSED_AFTER_THE_AXIS_MOVED,
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

    Processed AFTER the axis moved: this is the ordinary anonymous item, whose
    reversal needs no compatibility. `sample_pre_deploy_feedback_item` is the same
    shape on the other side of the boundary, which is the pair that shows the stamp
    rather than the shape is what decides.
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
        'processed_at': PROCESSED_AFTER_THE_AXIS_MOVED,
    }


@pytest.fixture
def sample_pre_deploy_feedback_item():
    """An item PROCESSED before the persona axis moved to the archetype.

    🔑 WHAT MAKES IT PRE-DEPLOY IS `processed_at`, not its persona fields. The stamp
    is the item's own record of which deploy wrote it, so it is the only thing a
    reversal can read to know which derivation counted it — see
    `LEGACY_PERSONA_STAMP_FIELD`. The fields below are arranged so a test can also
    tell WHICH row a write went to: a `persona_name` and no `persona_type` makes the
    two derivations name different rows, which an item carrying both cannot do.

    ⚠️ THAT ARRANGEMENT IS NOT THE PRE-DEPLOY SHAPE, and reading it as one is a
    mistake this fixture has already invited once. `processor/handler.py` has written
    both persona fields since the initial commit, so the axis move changed only the
    READER: a real pre-deploy item usually carries a `persona_type` too, the dominant
    one being `sample_anonymous_feedback_item`'s shape exactly, and a trigger that
    tested for "a name but no archetype" would be silently inert for 99.97% of the
    corpus. `sample_pre_deploy_anonymous_feedback_item` is that case, and
    test_an_anonymous_pre_deploy_image_is_still_reversed_though_its_shape_looks_current
    is where it is pinned.

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
        'processed_at': PROCESSED_BEFORE_THE_AXIS_MOVED,
    }


@pytest.fixture
def sample_pre_deploy_anonymous_feedback_item(sample_anonymous_feedback_item):
    """The 99.97% pre-deploy item: an archetype, no name, and an OLD stamp.

    Byte-identical to `sample_anonymous_feedback_item` but for `processed_at`, which
    is the whole point — these two are the pair that shows the compatibility's trigger
    has to be the stamp. A shape-based trigger cannot tell them apart at all, and the
    absence of the archetype ROW only tells them apart on a day no post-deploy item
    has written that bucket, which is not the day the corpus is busiest.

    Its insert counted it under the OLD default (`METRIC#persona#Unknown`, the row
    holding most of the pre-deploy corpus), because it had no name to be counted
    under.
    """
    return {**sample_anonymous_feedback_item,
            'processed_at': PROCESSED_BEFORE_THE_AXIS_MOVED}


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
