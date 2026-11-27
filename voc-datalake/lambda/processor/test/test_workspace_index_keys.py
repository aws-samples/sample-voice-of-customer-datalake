"""Every review the processor puts in a workspace carries the index keys a workspace's erasure walks (7.96.00).

The positive half of lambda/shared/test/test_feedback_day_index_writers.py (which proves no other writer stamps or
rewrites ``gsi1pk`` / ``gsi1sk`` or ``gsi4pk``): a workspace's erasure by author, CSV row or email Queries
``gsi1-by-date`` one ``WS#{ws}#DATE#{day}`` partition at a time, and one by source id Queries ``gsi4-by-feedback-id`` at
``WS#{ws}#FEEDBACK#{feedback_item_id(source, source_id)}`` (lambda/jobs/retention/item_walk.py). So, on every path of
the processor's first put (``build_feedback_item``, then ``apply_storage_policy``), the stored review has its day keys
(``gsi1pk`` its processing day, ``gsi1sk`` that time and its id) and its id key, and a review whose message has an
``id`` is keyed by exactly ``feedback_item_id(source_platform, id)``. A review with a day key missing would be on no
day partition, one without ``gsi4pk`` on no id partition: the walk could not see it (TENETS.md D5's gaps).
"""
from __future__ import annotations

import pytest

from processor import handler
from processor.test import test_source_updates as issues
from processor.test.test_workspace_path import ALLOW_PROFILES, OTHER_WS, WS, _items, review
from shared.feedback_keys import feedback_item_id

#: The message shapes the processor's first put takes: plain, a brand name (another ``pk``), no id (a content id),
#: a CSV row, an email in each metadata field, a rating and a title, and each PII policy it stores under.
MESSAGES = {
    'plain': {},
    'brand name': {'brand_name': 'Example Shop'},
    'csv row': {'source_platform': 'csv_upload', 'csv_row_id': 'row-7', 'id': 'csv-1'},
    'email': {'author': 'Jane Doe', 'metadata': {'email': 'jane@example.com'}},
    'submitter email': {'metadata': {'submitter_email': 'Jane@Example.com'}},
    'rating and title': {'rating': 4, 'title': 'Late again'},
    'redacted': {'pii_policy_applied': 'redact'},
    'summary only': {'pii_policy_applied': 'summary_only'},
    'no channel': {'source_channel': None},
}


@pytest.fixture(autouse=True)
def _csv_profile():
    for ws in (WS, OTHER_WS):
        handler._settings_cache[('sources', ws)] = (
            float('inf'), [*ALLOW_PROFILES, {'id': 'csv_upload', 'label': 'CSV', 'pii': 'allow'}])


@pytest.mark.parametrize('extra', MESSAGES.values(), ids=list(MESSAGES))
def test_a_workspace_review_carries_its_day_and_id_keys(extra):
    message = review(workspace_id=WS, **extra)
    with issues.world() as (feedback, _):
        assert issues.deliver(message)['status'] == 'success'
        (item,) = _items(feedback)

    prefix = f'WS#{WS}#'
    feedback_id = item['feedback_id']
    assert item['gsi1pk'] == f"{prefix}DATE#{item['date']}"
    assert item['gsi1sk'] == f"{item['processed_at']}#{feedback_id}"
    assert item['processed_at'].startswith(item['date'])
    assert item['gsi4pk'] == f'{prefix}FEEDBACK#{feedback_id}'
    assert item['sk'] == f'FEEDBACK#{feedback_id}'
    assert item['source_id'] == message['id']
    assert feedback_id == feedback_item_id(item['source_platform'], item['source_id'])


def test_a_message_without_an_id_is_never_stored():
    """So no stored review is keyed by a content id (``generate_deterministic_id``'s fallback): an erasure by source id
    always finds its review at ``feedback_item_id(source, source_id)``."""
    with issues.world() as (feedback, _):
        with pytest.raises(handler.MessageRejectedError, match='id'):
            issues.deliver(review(workspace_id=WS, id=''))
        assert _items(feedback) == []
