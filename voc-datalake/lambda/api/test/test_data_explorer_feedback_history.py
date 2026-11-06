"""PUT /data-explorer/feedback keeps the review as it was, says who changed it and applies the source's policy.

Closes audit finding S2: the route used to overwrite up to 12 fields (``original_text`` included)
with no actor, no previous value, no validation and no PII pass. Now (TENETS.md D1, D2, D4):
once the update landed the record as it was goes to ``silver/{source}/{feedback_id}/``, the update stamps
``updated_by`` / ``updated_at`` / ``change_reason``, and each changed field is validated and put
through the source's PII policy (``shared/feedback_field_edits.py``). Against moto (DynamoDB + S3).
"""

import boto3
import pytest
from category_access_fixtures import CATEGORIES_CONFIG
from moto import mock_aws
from moto_helpers import CATEGORY_EDIT_ADMIN_CLAIMS as ADMIN_CLAIMS
from moto_helpers import CATEGORY_EDIT_ITEM as ITEM
from moto_helpers import invoke, rest_event, seeded_category_edit_tables

import data_explorer_handler
from shared.test.silver_fixtures import kept_versions
from shared.test.source_profile_fixtures import seeded_source_profiles, unreadable_source_profiles

BUCKET = 'voc-raw-explorer-test'
KEY = {'pk': ITEM['pk'], 'sk': ITEM['sk']}
SOURCE = ITEM['pk'].removeprefix('SOURCE#')
EMAIL_TEXT = 'Write to ada@example.com about the late parcel'


@pytest.fixture
def tables(monkeypatch):
    monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)
    with mock_aws():
        feedback, aggregates = seeded_category_edit_tables(
            {**ITEM, 'source_platform': SOURCE, 'original_text': 'The parcel was late'}, CATEGORIES_CONFIG)
        boto3.client('s3', region_name='us-east-1').create_bucket(Bucket=BUCKET)
        monkeypatch.setattr(data_explorer_handler, 'dynamodb', boto3.resource('dynamodb', region_name='us-east-1'))
        monkeypatch.setattr(data_explorer_handler, 'FEEDBACK_TABLE', 'feedback')
        yield feedback, aggregates


def _save(tables, lambda_context, data):
    event = rest_event('PUT', '/data-explorer/feedback', claims=ADMIN_CLAIMS, body={'feedback_id': 'f1', 'data': data})
    return invoke(data_explorer_handler, event, lambda_context, aggregates=tables[1])


def _stored(tables) -> dict:
    return tables[0].get_item(Key=KEY)['Item']


def _kept() -> list[dict]:
    return kept_versions(BUCKET)


def _profile(pii: str) -> list[dict]:
    return [{'id': SOURCE, 'label': 'Web', 'pii': pii}]


def test_an_edit_keeps_the_record_as_it_was_and_stamps_the_admin(tables, lambda_context):
    with seeded_source_profiles():
        status, _ = _save(tables, lambda_context, {'original_text': 'The parcel was two days late', 'urgency': 'high'})
    item = _stored(tables)
    (kept,) = _kept()

    assert status == 200
    assert kept['item']['original_text'] == 'The parcel was late'
    assert kept['actor'] == {'sub': ADMIN_CLAIMS['sub'], 'kind': 'admin'}
    assert kept['reason'] == 'data_explorer_edit'
    assert {'original_text', 'urgency'} <= set(kept['changed_fields'])
    assert item['original_text'] == 'The parcel was two days late'
    assert item['updated_by'] == {'sub': ADMIN_CLAIMS['sub'], 'kind': 'admin'}
    assert item['change_reason'] == 'data_explorer_edit'
    assert 'enrichment_mode' not in item  # an edit never claims to be how the item was enriched


def test_an_allow_source_stores_the_text_as_typed(tables, lambda_context):
    with seeded_source_profiles(_profile('allow')):
        _save(tables, lambda_context, {'original_text': EMAIL_TEXT})
    assert _stored(tables)['original_text'] == EMAIL_TEXT


def test_a_redact_source_never_stores_the_typed_email(tables, lambda_context):
    with seeded_source_profiles(_profile('redact')):
        status, _ = _save(tables, lambda_context, {'original_text': EMAIL_TEXT, 'problem_summary': 'ada@example.com'})
    item = _stored(tables)

    assert status == 200
    assert 'ada@example.com' not in item['original_text']
    assert 'ada@example.com' not in item['problem_summary']
    assert '[EMAIL]' in item['original_text']


def test_the_stored_policy_wins_over_a_laxer_current_profile(tables, lambda_context):
    tables[0].update_item(Key=KEY, UpdateExpression='SET pii_policy = :p', ExpressionAttributeValues={':p': 'redact'})
    with seeded_source_profiles(_profile('allow')):
        _save(tables, lambda_context, {'original_text': EMAIL_TEXT})
    assert 'ada@example.com' not in _stored(tables)['original_text']


@pytest.mark.parametrize('field', ['original_text', 'normalized_text'])
def test_a_summary_only_source_refuses_customer_text(tables, lambda_context, field):
    with seeded_source_profiles(_profile('summary_only')):
        status, body = _save(tables, lambda_context, {field: 'typed words'})

    assert status == 400
    assert 'keeps no customer text' in body['error']
    assert _stored(tables)['original_text'] == 'The parcel was late'
    assert _kept() == []


def test_a_summary_only_source_may_remove_customer_text_it_should_not_hold(tables, lambda_context):
    """Clearing leaked text reduces what is stored, so it is allowed; the earlier version is kept, stripped."""
    # As the processor stores it: the item carries its source's policy.
    tables[0].update_item(Key=KEY, UpdateExpression='SET normalized_text = :t, pii_policy = :p',
                          ExpressionAttributeValues={':t': 'leaked words', ':p': 'summary_only'})
    with seeded_source_profiles(_profile('summary_only')):
        status, _ = _save(tables, lambda_context, {'normalized_text': None})

    assert status == 200
    assert 'normalized_text' not in _stored(tables)
    (kept,) = _kept()
    assert 'normalized_text' not in kept['item']


def test_unreadable_source_profiles_fail_closed(tables, lambda_context):
    with unreadable_source_profiles():
        status, _ = _save(tables, lambda_context, {'original_text': EMAIL_TEXT})

    assert status == 503
    assert _stored(tables)['original_text'] == 'The parcel was late'


def test_an_invalid_enum_is_a_400(tables, lambda_context):
    with seeded_source_profiles():
        status, body = _save(tables, lambda_context, {'urgency': 'critical'})
    assert status == 400
    assert body['error'] == 'urgency must be one of: high, low, medium'


def test_null_removes_an_optional_field(tables, lambda_context):
    tables[0].update_item(Key=KEY, UpdateExpression='SET persona_name = :p', ExpressionAttributeValues={':p': 'X'})
    with seeded_source_profiles():
        status, _ = _save(tables, lambda_context, {'persona_name': None})
    assert status == 200
    assert 'persona_name' not in _stored(tables)


def test_an_editor_opened_before_the_last_change_is_refused(tables, lambda_context):
    """The editor sends the whole record it opened: its stale fields must not overwrite a change made since."""
    with seeded_source_profiles():
        assert _save(tables, lambda_context, {'urgency': 'high'})[0] == 200  # someone else's edit stamps updated_at
        status, body = _save(tables, lambda_context, {'urgency': 'low', 'original_text': 'The parcel was late',
                                                      'updated_at': None})
    assert status == 409
    assert 'changed by someone else' in body['error']
    assert _stored(tables)['urgency'] == 'high'


def test_an_editor_with_the_current_stamp_saves(tables, lambda_context):
    with seeded_source_profiles():
        _save(tables, lambda_context, {'urgency': 'high'})
        stamp = _stored(tables)['updated_at']
        status, _ = _save(tables, lambda_context, {'urgency': 'low', 'updated_at': stamp})
    assert status == 200
    assert _stored(tables)['urgency'] == 'low'
