"""Every plugin transport applies the source policy before archive and queue."""
from unittest.mock import MagicMock, patch

import pytest

from _shared import base_ingestor, base_webhook
from _shared.normalized_item import normalized_item_fields
from _shared.raw_archive import archive_raw_item
from _shared.source_policy_gate import policy_messages, raw_archive_permitted
from shared.source_profiles import SourceProfilesUnavailable
from shared.test.source_profile_fixtures import seeded_source_profiles, unreadable_source_profiles

_REDACTED = [{'id': 'tickets', 'pii': 'redact'}]


def _message(source='tickets'):
    return {'id': 'x', 'source_platform': source, 'text': 'mail jane@example.com', 'author': 'Jane'}


def test_policy_messages_redacts_by_source_and_drops_textless_redact_messages():
    with seeded_source_profiles(_REDACTED):
        out = policy_messages([_message(), _message('other'), {**_message(), 'text': ''}])
    assert out == [
        {'id': 'x', 'source_platform': 'tickets', 'text': 'mail [EMAIL]', 'pii_policy_applied': 'redact'},
        {**_message('other'), 'pii_policy_applied': 'allow'},
    ]


def test_raw_archive_permitted_follows_the_profile():
    with seeded_source_profiles(_REDACTED):
        assert (raw_archive_permitted('tickets'), raw_archive_permitted('other')) == (False, True)


def test_archive_raw_item_writes_nothing_for_a_redact_source():
    s3 = MagicMock()
    with seeded_source_profiles(_REDACTED):
        assert archive_raw_item(s3, 'bucket', 'tickets', {'id': 'x', 'text': 't'}) is None
    s3.put_object.assert_not_called()


def test_archive_raw_item_still_writes_for_an_allow_source():
    s3 = MagicMock()
    assert archive_raw_item(s3, 'bucket', 'other', {'id': 'x', 'created_at': '2026-01-15T00:00:00Z'}) == \
        's3://bucket/raw/other/2026/01/15/x.json'


def test_an_unreadable_policy_fails_closed_before_archive_or_queue():
    s3 = MagicMock()
    with unreadable_source_profiles():
        with pytest.raises(SourceProfilesUnavailable):
            policy_messages([_message()])
        with pytest.raises(SourceProfilesUnavailable):
            archive_raw_item(s3, 'bucket', 'tickets', {'id': 'x', 'text': 't'})
    s3.put_object.assert_not_called()


def test_a_webhook_answers_503_and_queues_nothing_when_the_policy_is_unreadable():
    hook = MagicMock(source_platform='tickets')
    hook.parse_webhook_payload.return_value = [{'id': 'x'}]
    hook.normalize_item.return_value = _message()
    hook.send_to_queue.side_effect = lambda items: base_webhook.BaseWebhook.send_to_queue(hook, items)
    with unreadable_source_profiles(), \
            patch.object(base_webhook, 'send_messages_to_queue') as send, \
            patch.object(base_webhook, 'emit_audit_event'):
        response = base_webhook.BaseWebhook.handle(hook, {'body': '{}'}, MagicMock())
    assert response['statusCode'] == 503
    assert 'retry' in response['body']
    send.assert_not_called()


def test_ingestor_and_webhook_queue_the_policy_applied_messages():
    with seeded_source_profiles(_REDACTED), \
            patch.object(base_ingestor, 'send_messages_to_queue', return_value=1) as ingest_send, \
            patch.object(base_webhook, 'send_messages_to_queue', return_value=1) as webhook_send:
        base_ingestor.BaseIngestor.send_to_queue(MagicMock(), [_message()])
        base_webhook.BaseWebhook.send_to_queue(MagicMock(), [_message()])
    expected = [{'id': 'x', 'source_platform': 'tickets', 'text': 'mail [EMAIL]', 'pii_policy_applied': 'redact'}]
    assert ingest_send.call_args.args[2] == expected
    assert webhook_send.call_args.args[2] == expected


def test_normalized_fields_carry_author_title_dimensions_and_tags_when_present():
    item = {'id': 'x', 'text': 't', 'author': ' Jane ', 'title': 'T' * 600,
            'dimensions': {'product': 'app', 'bad key': 'x'}, 'tags': 'vip;beta'}
    fields = normalized_item_fields(item, source_platform='s', default_channel='c', brand_name='b')
    assert (fields['author'], len(fields['title'])) == ('Jane', 500)
    assert (fields['dimensions'], fields['tags']) == ({'product': 'app'}, ['vip', 'beta'])


def test_normalized_fields_keep_the_old_shape_without_them():
    fields = normalized_item_fields({'id': 'x', 'text': 't', 'author': '  '}, source_platform='s',
                                    default_channel='c', brand_name='b')
    assert not {'author', 'title', 'dimensions', 'tags'} & set(fields)
