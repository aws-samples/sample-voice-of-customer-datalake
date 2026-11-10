"""Workspace delete records (shared/delete_audit.py)."""
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.delete_audit import actor_from_event, record_delete
from shared.test.moto_tables import create_pk_sk_table


def _event(**claims: object) -> dict:
    return {'requestContext': {'authorizer': {'claims': claims}}}


class TestActorFromEvent:
    @pytest.mark.parametrize(('claims', 'expected'), [
        ({'sub': 'u-1', 'email': 'a@example.com'}, {'sub': 'u-1', 'kind': 'user'}),
        ({'sub': 'u-2', 'cognito:groups': '[admins, users]'}, {'sub': 'u-2', 'kind': 'admin'}),
        ({'sub': 'agent:ag_1', 'cognito:groups': 'admins'}, {'sub': 'agent:ag_1', 'kind': 'agent'}),
        ({'sub': 'mcp:tok_1', 'voc:acting_subject': 'u-1'}, {'sub': 'mcp:tok_1', 'kind': 'mcp'}),
        ({'sub': 'u-3', 'voc:principal': 'plan:pl_1', 'cognito:groups': 'admins'}, {'sub': 'u-3', 'kind': 'plan'}),
        ({}, {'sub': 'system', 'kind': 'system'}),
        ({'sub': '  '}, {'sub': 'system', 'kind': 'system'}),
    ])
    def test_the_actor_kind_follows_the_subject(self, claims, expected):
        assert actor_from_event(_event(**claims)) == expected

    def test_a_malformed_event_is_the_system(self):
        assert actor_from_event({'requestContext': 'x'}) == {'sub': 'system', 'kind': 'system'}

    def test_never_an_email(self):
        assert 'a@example.com' not in str(actor_from_event(_event(sub='u-1', email='a@example.com')))

    def test_the_route_can_decide_admin_itself(self):
        board_token = _event(sub='b-1', **{'cognito:groups': 'admins'})
        assert actor_from_event(board_token, admin=False) == {'sub': 'b-1', 'kind': 'user'}
        assert actor_from_event(_event(sub='u-1'), admin=True) == {'sub': 'u-1', 'kind': 'admin'}
        assert actor_from_event(_event(sub='agent:a'), admin=True)['kind'] == 'agent'


class TestRecordDelete:
    def test_writes_one_audit_row_without_ttl_and_never_overwrites(self):
        table = MagicMock()
        record_delete(table, kind='persona', target={'project_id': 'p1', 'persona_id': 'x', 'empty': ''},
                      actor={'sub': 'u-1', 'kind': 'user'}, reason='owner deleted it')
        kwargs = table.put_item.call_args.kwargs
        item = kwargs['Item']
        assert kwargs['ConditionExpression'] == 'attribute_not_exists(pk)'
        assert item['pk'] == 'AUDIT#delete'
        assert item['sk'].startswith(item['deleted_at'] + '#')
        assert item['kind'] == 'persona'
        assert item['target'] == {'project_id': 'p1', 'persona_id': 'x'}
        assert item['actor'] == {'sub': 'u-1', 'kind': 'user'}
        assert item['reason'] == 'owner deleted it'
        assert 'ttl' not in item

    def test_no_actor_is_the_system_and_no_reason_is_absent(self):
        table = MagicMock()
        record_delete(table, kind='project', target={'project_id': 'p1'}, actor=None)
        item = table.put_item.call_args.kwargs['Item']
        assert item['actor'] == {'sub': 'system', 'kind': 'system'}
        assert 'reason' not in item

    def test_long_values_are_cut(self):
        table = MagicMock()
        record_delete(table, kind='k', target={'id': 'x' * 900}, actor=None, reason='r' * 900)
        item = table.put_item.call_args.kwargs['Item']
        assert len(item['target']['id']) == 300
        assert len(item['reason']) == 300

    def test_two_deletes_get_two_rows(self):
        table = MagicMock()
        for _ in range(2):
            record_delete(table, kind='k', target={'id': 'x'}, actor=None)
        sks = {c.kwargs['Item']['sk'] for c in table.put_item.call_args_list}
        assert len(sks) == 2

    def test_a_failed_write_never_raises_and_logs_the_kind_only(self):
        table = MagicMock()
        table.put_item.side_effect = ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'no'}}, 'PutItem')
        with patch('shared.delete_audit.logger') as log, patch('shared.delete_audit.metrics') as metrics:
            assert record_delete(table, kind='persona', target={'id': 'x'}, actor=None) is None
        log.warning.assert_called_once_with(
            'Could not record a delete', extra={'kind': 'persona', 'error_type': 'ClientError'})
        # A delete without its record is counted, so it can be found and backfilled.
        metrics.add_metric.assert_called_once_with(name='DeleteRecordFailures', unit='Count', value=1)

    def test_a_missing_table_never_raises(self):
        assert record_delete(None, kind='persona', target={'id': 'x'}, actor=None) is None

    @mock_aws
    def test_writes_to_a_real_table(self):
        table = create_pk_sk_table('t')
        record_delete(table, kind='board', target={'board_id': 'b1'}, actor={'sub': 'u', 'kind': 'admin'})
        rows = table.query(KeyConditionExpression='pk = :p', ExpressionAttributeValues={':p': 'AUDIT#delete'})['Items']
        assert [r['target'] for r in rows] == [{'board_id': 'b1'}]
