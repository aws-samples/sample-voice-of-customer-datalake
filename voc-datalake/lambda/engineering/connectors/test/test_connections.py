"""The repository connections as administrators store them (connections.py): the row, its audit rows and the GitHub
App credential in SSM under the name the broker reads, never answered, logged or stored anywhere else."""
from __future__ import annotations

import json
import logging
import secrets
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from moto import mock_aws

from engineering.connectors.connections import (
    LOG_PREFIX,
    MAX_CONNECTIONS,
    MAX_PARAMETER_BYTES,
    PARTITION,
    Actor,
    ConnectionRefused,
    ConnectionStore,
    is_branch_name,
    live_runs_of,
    parse_request,
    stored_connection,
)
from engineering.connectors.credentials import parse_credential
from engineering.connectors.test.app_keys import (
    APP_ID,
    INSTALLATION_ID,
    OWNER,
    REPOSITORY,
    connection_body,
    pem,
    private_key,
)

PREFIX = '/voc/engineering/'
TABLE = 'voc-agents-test'
ADMIN = Actor(subject='admin-sub', name='alice')
WHEN = datetime(2026, 11, 14, 9, 30, tzinfo=UTC)


body = connection_body


@dataclass
class Env:
    table: Any
    ssm: Any
    key_id: str
    live: dict[str, list[str]] = field(default_factory=dict)

    def store(self, *, prefix: str = PREFIX, key_id: str | None = None, ssm: Any = None) -> ConnectionStore:
        return ConnectionStore(self.table, lambda: ssm or self.ssm, prefix, self.key_id if key_id is None else key_id,
                               lambda connection: self.live.get(connection, []), clock=lambda: WHEN)

    def rows(self) -> list[dict[str, Any]]:
        return self.table.scan()['Items']

    def audits(self) -> list[dict[str, Any]]:
        return sorted((row for row in self.rows() if row['sk'].startswith(LOG_PREFIX)), key=lambda row: row['version'])

    def parameter(self, connection_id: str) -> dict[str, Any]:
        return self.ssm.get_parameter(Name=f'{PREFIX}{connection_id}', WithDecryption=True)['Parameter']


@pytest.fixture
def env() -> Iterator[Env]:
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        table = dynamodb.create_table(
            TableName=TABLE, BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                                  {'AttributeName': 'sk', 'AttributeType': 'S'}])
        key_id = boto3.client('kms', region_name='us-east-1').create_key()['KeyMetadata']['Arn']
        yield Env(table, boto3.client('ssm', region_name='us-east-1'), key_id)


def save(env: Env, connection_id: str = 'refunds', **change: Any) -> tuple[dict[str, Any], bool]:
    return env.store().save(connection_id, parse_request(body(**change)), ADMIN)


def test_a_new_connection_stores_its_credential_where_the_broker_reads_it(env: Env) -> None:
    connection, created = save(env)
    assert created is True
    parameter = env.parameter('refunds')
    assert parameter['Type'] == 'SecureString'
    # The broker's own reader parses what was stored: the App, its installation and the one repository.
    credential = parse_credential(parameter['Value'])
    assert (credential.app_id, credential.installation_id, credential.owner, credential.repository) == (
        APP_ID, INSTALLATION_ID, OWNER, REPOSITORY)
    assert credential.private_key.private_numbers() == private_key().private_numbers()
    assert env.ssm.describe_parameters()['Parameters'][0]['KeyId'] == env.key_id   # (the stack's own key)
    assert connection == {
        'connection_id': 'refunds', 'host': 'github', 'repository': f'{OWNER}/{REPOSITORY}', 'default_branch': 'main',
        'credential': {'kind': 'app', 'set': True, 'app_id': APP_ID, 'installation_id': str(INSTALLATION_ID)},
        'created_at': WHEN.isoformat(), 'created_by': 'alice', 'updated_at': WHEN.isoformat(), 'updated_by': 'alice'}
    assert env.store().list() == [connection]


def test_the_private_key_is_stored_only_in_ssm_never_in_a_row_an_answer_or_a_log(
        env: Env, caplog: pytest.LogCaptureFixture) -> None:
    secret = pem().split('\n')[1]   # (one line of the key's body)
    with caplog.at_level(logging.INFO):   # (the functions' LOG_LEVEL)
        connection, _ = save(env)
        env.store().remove('refunds', ADMIN)
    assert secret not in json.dumps(env.rows(), default=str)
    assert secret not in json.dumps(connection)
    assert secret not in caplog.text
    assert 'private_key' not in repr(parse_request(body()))


def test_every_change_writes_a_create_only_audit_row_with_who_when_and_what(env: Env) -> None:
    save(env)
    env.store().save('refunds', parse_request(body(default_branch='trunk', credential=None)), ADMIN)
    env.store().remove('refunds', Actor(subject='admin-2', name='dana'))
    created, updated, removed = env.audits()
    assert {key: created[key] for key in ('pk', 'connection_id', 'action', 'by', 'by_name', 'at', 'version')} == {
        'pk': PARTITION, 'connection_id': 'refunds', 'action': 'created', 'by': 'admin-sub', 'by_name': 'alice',
        'at': WHEN.isoformat(), 'version': 1}
    assert created['changes'] == {
        'repository': {'from': None, 'to': f'{OWNER}/{REPOSITORY}'}, 'default_branch': {'from': None, 'to': 'main'},
        'app_id': {'from': None, 'to': APP_ID}, 'installation_id': {'from': None, 'to': str(INSTALLATION_ID)},
        'credential': 'replaced'}
    # Only what changed, and the credential kept (a save of the branch alone needs no credential).
    assert (updated['action'], updated['changes']) == (
        'updated', {'default_branch': {'from': 'main', 'to': 'trunk'}, 'credential': 'kept'})
    assert (removed['action'], removed['by'], removed['changes']) == (
        'removed', 'admin-2', {'repository': {'from': f'{OWNER}/{REPOSITORY}', 'to': None}, 'credential': 'removed'})
    with pytest.raises(ClientError, match='ConditionalCheckFailed'):   # (create-only: an audit row is never rewritten)
        env.table.put_item(Item=created, ConditionExpression='attribute_not_exists(sk)')


def test_a_save_without_the_credential_keeps_the_stored_one(env: Env) -> None:
    save(env)
    stored = env.parameter('refunds')
    connection, created = env.store().save('refunds', parse_request(body(default_branch='release/2026', credential=None)),
                                           ADMIN)
    assert (created, connection['default_branch'], connection['credential']['set']) == (False, 'release/2026', True)
    assert env.parameter('refunds')['Version'] == stored['Version']


def test_a_new_credential_replaces_the_stored_one(env: Env) -> None:
    save(env)
    connection, _ = save(env, credential={'app_id': '654321', 'installation_id': 42, 'private_key': pem()})
    assert parse_credential(env.parameter('refunds')['Value']).app_id == '654321'
    assert (connection['credential']['app_id'], connection['credential']['installation_id']) == ('654321', '42')
    assert connection['created_at'] == WHEN.isoformat()


@pytest.mark.parametrize('change', [{'credential': None}, {'repository': 'example-org/other', 'credential': None}])
def test_the_credential_is_needed_to_add_a_connection_or_change_its_repository(env: Env, change: dict) -> None:
    if 'repository' in change:
        save(env)
    with pytest.raises(ConnectionRefused, match='credential is needed') as refused:
        save(env, **change)
    assert refused.value.kind == 'invalid'


def test_a_repository_change_is_refused_while_a_run_of_the_connection_is_live(env: Env) -> None:
    save(env)
    env.live['refunds'] = ['01JD0000000000000000000001']
    before = env.parameter('refunds')
    with pytest.raises(ConnectionRefused, match='1 run\\(s\\) of this connection are live') as refused:
        save(env, repository='example-org/other')
    assert refused.value.kind == 'conflict'
    # Nothing was written: the credential, the row and the audit stay as they were.
    assert env.parameter('refunds')['Version'] == before['Version']
    assert [row['repository'] for row in env.store().list()] == [f'{OWNER}/{REPOSITORY}']
    assert len(env.audits()) == 1
    # Its branch and its credential still change (a rotation never waits for the runs).
    assert save(env, default_branch='trunk')[0]['default_branch'] == 'trunk'
    env.live.clear()
    assert save(env, repository='example-org/other')[0]['repository'] == 'example-org/other'


def test_a_removed_connection_loses_its_credential_and_is_listed_no_more(env: Env) -> None:
    save(env)
    env.store().remove('refunds', ADMIN)
    with pytest.raises(ClientError, match='ParameterNotFound'):
        env.parameter('refunds')
    assert env.store().list() == []
    assert stored_connection(env.table, 'refunds') is None
    with pytest.raises(ConnectionRefused, match='not found') as refused:
        env.store().remove('refunds', ADMIN)
    assert refused.value.kind == 'not_found'
    # Added again later: a new connection, its credential needed again.
    with pytest.raises(ConnectionRefused, match='credential is needed'):
        save(env, credential=None)
    assert save(env)[1] is True
    assert parse_credential(env.parameter('refunds')['Value']).repository == REPOSITORY


def test_a_removal_with_live_runs_goes_ahead_and_cuts_their_access(env: Env) -> None:
    save(env)
    env.live['refunds'] = ['01JD0000000000000000000001']
    env.store().remove('refunds', ADMIN)
    assert env.ssm.describe_parameters()['Parameters'] == []


def test_a_re_added_connection_with_another_repository_waits_for_its_live_runs(env: Env) -> None:
    save(env)
    env.store().remove('refunds', ADMIN)
    env.live['refunds'] = ['01JD0000000000000000000001']
    with pytest.raises(ConnectionRefused, match='live'):
        save(env, repository='example-org/other')


def test_at_most_the_limit_of_connections(env: Env) -> None:
    for n in range(MAX_CONNECTIONS):
        save(env, f'conn-{n}')
    with pytest.raises(ConnectionRefused, match=f'at most {MAX_CONNECTIONS}') as refused:
        save(env, 'one-more')
    assert refused.value.kind == 'conflict'
    assert save(env, 'conn-0')[1] is False   # (a change of a stored one is no new connection)
    env.store().remove('conn-1', ADMIN)
    assert save(env, 'one-more')[1] is True


def test_a_change_made_meanwhile_is_a_conflict_and_a_new_connections_credential_goes_again(env: Env) -> None:
    store = env.store()
    original = env.table
    racing = MagicMock(wraps=original)
    racing.name = original.name
    racing.meta.client.transact_write_items.side_effect = ClientError(
        {'Error': {'Code': 'TransactionCanceledException', 'Message': 'canceled'}}, 'TransactWriteItems')
    store._table = racing
    with pytest.raises(ConnectionRefused, match='changed meanwhile') as refused:
        store.save('refunds', parse_request(body()), ADMIN)
    assert refused.value.kind == 'conflict'
    assert env.ssm.describe_parameters()['Parameters'] == []
    assert env.rows() == []


def _first_transaction_fails(env: Env, store: ConnectionStore) -> None:
    """The store's first transaction is canceled (a change made meanwhile); the next ones go through."""
    original = env.table
    racing = MagicMock(wraps=original)
    racing.name = original.name
    calls = iter(range(100))

    def transact(**request: Any) -> Any:
        if next(calls) == 0:
            raise ClientError({'Error': {'Code': 'TransactionCanceledException', 'Message': 'canceled'}},
                              'TransactWriteItems')
        return original.meta.client.transact_write_items(**request)

    racing.meta.client.transact_write_items.side_effect = transact
    store._table = racing


@pytest.mark.parametrize('change', ['replace', 'remove'])
def test_a_stored_connection_whose_row_is_not_written_after_its_credential_changed_says_not_set(
        env: Env, change: str) -> None:
    save(env)
    store = env.store()
    _first_transaction_fails(env, store)
    changes = {'replace': lambda: store.save('refunds', parse_request(body(repository='example-org/other')), ADMIN),
               'remove': lambda: store.remove('refunds', ADMIN)}
    with pytest.raises(ConnectionRefused, match='changed meanwhile'):
        changes[change]()
    # The parameter changed (replaced, or deleted), so the row no longer says it is set: the next save needs it again.
    (listed,) = env.store().list()
    assert (listed['repository'], listed['credential']['set']) == (f'{OWNER}/{REPOSITORY}', False)
    assert [row['action'] for row in env.audits()] == ['created', 'credential_unset']
    with pytest.raises(ConnectionRefused, match='credential is needed'):
        env.store().save('refunds', parse_request(body(credential=None)), ADMIN)


def test_two_saves_from_the_same_version_never_overwrite_each_other(env: Env) -> None:
    save(env)
    first, second = env.store(), env.store()
    read = env.table.get_item(Key={'pk': PARTITION, 'sk': 'CONNECTION#refunds'})['Item']
    first.save('refunds', parse_request(body(default_branch='one', credential=None)), ADMIN)
    with pytest.raises(ConnectionRefused, match='changed meanwhile'):
        second._write({**read, 'default_branch': 'two'}, read, {'pk': PARTITION, 'sk': 'LOG#x', 'version': 2})
    assert env.store().list()[0]['default_branch'] == 'one'


def test_a_credential_ssm_refuses_is_503_and_nothing_is_recorded(env: Env) -> None:
    failing = MagicMock()
    failing.put_parameter.side_effect = ClientError({'Error': {'Code': 'AccessDeniedException'}}, 'PutParameter')
    with pytest.raises(ConnectionRefused, match='could not be stored') as refused:
        env.store(ssm=failing).save('refunds', parse_request(body()), ADMIN)
    assert refused.value.kind == 'unavailable'
    assert env.rows() == []


def test_a_removal_ssm_refuses_keeps_the_connection(env: Env) -> None:
    save(env)
    failing = MagicMock()
    failing.exceptions = env.ssm.exceptions
    failing.delete_parameter.side_effect = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'DeleteParameter')
    with pytest.raises(ConnectionRefused, match='could not be removed'):
        env.store(ssm=failing).remove('refunds', ADMIN)
    assert len(env.store().list()) == 1


@pytest.mark.parametrize('settings', [{'prefix': ''}, {'key_id': ''}])
def test_without_the_parameter_path_or_key_nothing_is_stored(env: Env, settings: dict[str, str]) -> None:
    with pytest.raises(ConnectionRefused, match='names no parameter path or key') as refused:
        env.store(**settings).save('refunds', parse_request(body()), ADMIN)
    assert refused.value.kind == 'unavailable'


def _pkcs1() -> str:
    return private_key().private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                       serialization.NoEncryption()).decode()


def test_the_key_github_hands_out_with_windows_line_ends_is_taken(env: Env) -> None:
    save(env, credential={'app_id': APP_ID, 'installation_id': INSTALLATION_ID,
                          'private_key': _pkcs1().replace('\n', '\r\n')})
    assert parse_credential(env.parameter('refunds')['Value']).private_key.private_numbers() \
        == private_key().private_numbers()


def _encrypted() -> str:
    return private_key().private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                       serialization.BestAvailableEncryption(secrets.token_bytes(16))).decode()


def _too_large() -> str:
    lines = pem().split('\n')
    return '\n'.join([lines[0], *(['A' * 64] * (MAX_PARAMETER_BYTES // 64)), lines[-2]])


@pytest.mark.parametrize(('change', 'reason'), [
    ({'host': 'gitlab'}, 'host is github'),
    ({'repository': 'example-org'}, 'owner/name'),
    ({'repository': 'example-org/..'}, 'owner/name'),
    ({'repository': 'example-org/a/b'}, 'owner/name'),
    ({'repository': '-org/name'}, 'owner/name'),
    ({'repository': 7}, 'owner/name'),
    ({'default_branch': ''}, 'default_branch'),
    ({'default_branch': 'feature..x'}, 'default_branch'),
    ({'default_branch': 'a b'}, 'default_branch'),
    ({'default_branch': 'x.lock'}, 'default_branch'),
    ({'default_branch': 'voc-agent/run/x'}, 'default_branch'),
    ({'default_branch': 'b' * 256}, 'default_branch'),
    ({'extra': 1}, 'the body is'),
    ({'credential': 'secret'}, 'credential is'),
    ({'credential': {'app_id': APP_ID, 'installation_id': '1'}}, 'credential is'),
    ({'credential': {'app_id': 'app', 'installation_id': '1', 'private_key': 'k'}}, 'app_id'),
    ({'credential': {'app_id': True, 'installation_id': '1', 'private_key': 'k'}}, 'app_id'),
    ({'credential': {'app_id': APP_ID, 'installation_id': '0', 'private_key': 'k'}}, 'installation_id'),
    ({'credential': {'app_id': APP_ID, 'installation_id': '1', 'private_key': ''}}, 'private_key'),
    ({'credential': {'app_id': APP_ID, 'installation_id': '1', 'private_key': 'not a key'}}, 'private_key'),
], ids=lambda value: json.dumps(value)[:40] if isinstance(value, dict) else value)
def test_every_field_is_checked_and_the_reason_names_it(change: dict[str, Any], reason: str) -> None:
    with pytest.raises(ConnectionRefused, match=reason) as refused:
        parse_request(body(**change))
    assert refused.value.kind == 'invalid'


@pytest.mark.parametrize('key', [_encrypted, _too_large, lambda: pem(ec.generate_private_key(ec.SECP256R1()))],
                         ids=['encrypted', 'too large', 'not RSA'])
def test_a_key_the_broker_could_not_use_is_refused_without_quoting_it(env: Env, key: Any) -> None:
    text = key()
    with pytest.raises(ConnectionRefused, match='private_key') as refused:
        save(env, credential={'app_id': APP_ID, 'installation_id': '1', 'private_key': text})
    assert text.split('\n')[1] not in str(refused.value)
    assert env.ssm.describe_parameters()['Parameters'] == []


@pytest.mark.parametrize(('branch', 'ok'), [
    ('main', True), ('release/2026.11', True), ('trunk_v2', True), ('.hidden', False), ('a//b', False),
    ('a/', False), ('a.', False), ('a@{b', False), ('a/.b', False), ('ünï', False)])
def test_a_default_branch_is_one_git_takes(branch: str, ok: bool) -> None:
    assert is_branch_name(branch) is ok


def test_the_live_runs_are_the_registrys_runs_of_the_connection_that_have_not_ended() -> None:
    runs = MagicMock()
    runs.listed.return_value = ['r1', 'r2', 'r3', 'r4']
    status = {'r1': ('refunds', 'active'), 'r2': ('refunds', 'needs_human'), 'r3': ('refunds', 'done'),
              'r4': ('other', 'active')}
    runs.get.side_effect = lambda run_id: MagicMock(connection=status[run_id][0], status=status[run_id][1])
    assert live_runs_of(runs)('refunds') == ['r1', 'r2']
