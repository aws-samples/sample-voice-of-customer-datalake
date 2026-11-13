"""Every plugin transport applies the source policy before archive and queue."""
from unittest.mock import MagicMock, patch

import pytest

from _shared import base_ingestor, base_webhook
from _shared.normalized_item import normalized_item_fields
from _shared.raw_archive import WEBHOOK, archive_raw_item
from _shared.source_policy_gate import policy_messages, raw_archive_permitted
from _shared.test.workspace_fixtures import OTHER_SCOPE, OTHER_WS, SCOPE, WS
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
    uri = archive_raw_item(s3, 'bucket', 'other', {'id': 'x', 'created_at': '2026-01-15T00:00:00Z'})
    assert uri is not None
    assert uri.startswith('s3://bucket/raw/other/2026/01/15/x/')


def test_an_ingestors_archive_is_the_workspaces_and_a_webhooks_stays_deployment_wide():
    item = {'id': 'x', 'created_at': '2026-01-15T00:00:00Z'}
    ingestor_s3, webhook_s3 = MagicMock(), MagicMock()
    ingestor_uri = archive_raw_item(ingestor_s3, 'bucket', 'other', item, scope=SCOPE)
    other_uri = archive_raw_item(MagicMock(), 'bucket', 'other', item, scope=OTHER_SCOPE)
    webhook_uri = archive_raw_item(webhook_s3, 'bucket', 'other', item, transport=WEBHOOK)

    assert ingestor_uri is not None
    assert ingestor_uri.startswith(f's3://bucket/ws/{WS}/raw/other/2026/01/15/x/')
    assert ingestor_s3.put_object.call_args.kwargs['Key'].startswith(f'ws/{WS}/raw/other/2026/01/15/x/')
    assert other_uri is not None
    assert other_uri.startswith(f's3://bucket/ws/{OTHER_WS}/raw/other/2026/01/15/x/')
    assert webhook_uri is not None
    assert webhook_uri.startswith('s3://bucket/raw/other/2026/01/15/x/')
    assert webhook_s3.put_object.call_args.kwargs['Key'].startswith('raw/other/2026/01/15/x/')
    # The same content: only the folder differs, so the version (sha16) is the same in all three.
    assert ingestor_uri.rsplit('/', 1)[1] == other_uri.rsplit('/', 1)[1] == webhook_uri.rsplit('/', 1)[1]


def test_an_unreadable_policy_fails_closed_before_archive_or_queue():
    s3 = MagicMock()
    with unreadable_source_profiles():
        with pytest.raises(SourceProfilesUnavailable):
            policy_messages([_message()])
        with pytest.raises(SourceProfilesUnavailable):
            archive_raw_item(s3, 'bucket', 'tickets', {'id': 'x', 'text': 't'})
    s3.put_object.assert_not_called()


def test_a_webhook_answers_503_and_queues_nothing_when_the_policy_is_unreadable():
    hook = MagicMock(source_platform='tickets', routed=None, refused=False)
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


def test_a_deployment_wide_ingestor_run_queues_the_policy_applied_message_unchanged():
    with seeded_source_profiles(_REDACTED), \
            patch.object(base_ingestor, 'send_messages_to_queue', return_value=1) as ingest_send:
        base_ingestor.BaseIngestor.send_to_queue(MagicMock(scope=None), [_message()])
    assert ingest_send.call_args.args[2] == [
        {'id': 'x', 'source_platform': 'tickets', 'text': 'mail [EMAIL]', 'pii_policy_applied': 'redact'}]


def test_ingestor_and_webhook_queue_the_policy_applied_messages():
    with seeded_source_profiles(_REDACTED), \
            patch.object(base_ingestor, 'send_messages_to_queue', return_value=1) as ingest_send, \
            patch.object(base_webhook, 'send_messages_to_queue', return_value=1) as webhook_send:
        base_ingestor.BaseIngestor.send_to_queue(MagicMock(scope=SCOPE), [_message()])
        base_webhook.BaseWebhook.send_to_queue(MagicMock(routed=None), [_message()])
    expected = [{'id': 'x', 'source_platform': 'tickets', 'text': 'mail [EMAIL]', 'pii_policy_applied': 'redact'}]
    # The ingestor's messages also name the run's workspace; a deployment-wide webhook's name none.
    assert ingest_send.call_args.args[2] == [{**expected[0], 'workspace_id': WS}]
    assert webhook_send.call_args.args[2] == expected


def test_a_routed_webhook_names_the_stored_rows_workspace_last_never_the_payloads():
    """A delivery on `/webhooks/{plugin}/{ws}` names the workspace its stored META row routed it to (workspace_payload),
    after every field; a `workspace_id` the provider's payload carried is dropped by the policy first."""
    from shared.workspace_routing import route_workspace_id

    table = MagicMock()
    table.get_item.return_value = {'Item': {'pk': f'WS#{WS}', 'sk': 'META', 'status': 'active',
                                            'secret_status': 'ready'}}
    routed = route_workspace_id(table, WS)
    spoofed = [{**_message('other'), 'workspace_id': OTHER_WS}]
    with patch.object(base_webhook, 'send_messages_to_queue', return_value=1) as webhook_send:
        base_webhook.BaseWebhook.send_to_queue(MagicMock(routed=routed), spoofed)
    [message] = webhook_send.call_args.args[2]
    assert message['workspace_id'] == WS
    assert list(message)[-1] == 'workspace_id'


def test_a_source_payload_cannot_choose_the_workspace_an_ingestors_message_lands_in():
    with patch.object(base_ingestor, 'send_messages_to_queue', return_value=1) as ingest_send:
        base_ingestor.BaseIngestor.send_to_queue(MagicMock(scope=SCOPE), [{**_message('other'), 'workspace_id': OTHER_WS}])
    assert [m['workspace_id'] for m in ingest_send.call_args.args[2]] == [WS]


def test_a_deployment_wide_run_or_a_webhook_never_queues_a_workspace_from_its_payload():
    """The source policy drops a payload's `workspace_id`; only a run in a workspace adds one, from its scope."""
    spoofed = [{**_message('other'), 'workspace_id': OTHER_WS}]
    with patch.object(base_ingestor, 'send_messages_to_queue', return_value=1) as ingest_send, \
            patch.object(base_webhook, 'send_messages_to_queue', return_value=1) as webhook_send:
        base_ingestor.BaseIngestor.send_to_queue(MagicMock(scope=None), spoofed)
        base_webhook.BaseWebhook.send_to_queue(MagicMock(routed=None), spoofed)
    assert ['workspace_id' in m for m in ingest_send.call_args.args[2]] == [False]
    assert ['workspace_id' in m for m in webhook_send.call_args.args[2]] == [False]


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
