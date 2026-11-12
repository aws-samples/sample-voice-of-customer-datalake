"""shared/platform_workspaces.py: creating and listing workspaces (docs/multi-workspace.md, Control plane)."""
import ast
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.exceptions import ConflictError, ValidationError
from shared.platform_workspaces import (
    CREDENTIALS_PENDING,
    CREDENTIALS_READY,
    LISTING_PK,
    RESERVED_SLUGS,
    SLUG_TAKEN,
    WORKSPACE_CREATED,
    CredentialsSecretError,
    NewWorkspace,
    create_workspace,
    ensure_credentials_secret,
    list_workspaces,
    mark_secret_ready,
    new_workspace_id,
    parse_new_workspace,
)
from shared.test.moto_tables import create_pk_sk_table
from shared.workspace import is_workspace_id

LAMBDA_DIR = Path(__file__).resolve().parents[2]
AT = '2026-11-12T09:00:00+00:00'
CREATOR = 'sub-pat'
ACME = NewWorkspace(name='Acme Outfitters', slug='acme')


@pytest.fixture
def table() -> Iterator:
    with mock_aws():
        yield create_pk_sk_table('workspaces')


def _partition(table, pk):
    return table.query(KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': pk})['Items']


def _create(table, new=ACME, creator=CREATOR):
    with patch('shared.platform_workspaces.now_iso', return_value=AT):
        return create_workspace(table, new, creator)


# ── Validation ───────────────────────────────────────────────────────────────

def test_a_valid_body_is_trimmed_and_kept():
    assert parse_new_workspace({'name': '  Acme Outfitters ', 'slug': 'acme-2'}) == NewWorkspace('Acme Outfitters',
                                                                                                    'acme-2')


@pytest.mark.parametrize(('body', 'message'), [
    ({'slug': 'acme'}, 'name is required'),
    ({'name': '   ', 'slug': 'acme'}, 'name is required'),
    ({'name': 'x' * 81, 'slug': 'acme'}, 'at most 80'),
    ({'name': 7, 'slug': 'acme'}, 'name must be a string'),
    ({'name': 'Acme\x07', 'slug': 'acme'}, 'control characters'),
    ({'name': 'Acme'}, 'slug must be'),
    ({'name': 'Acme', 'slug': 'ac'}, 'slug must be'),
    ({'name': 'Acme', 'slug': 'a' * 41}, 'slug must be'),
    ({'name': 'Acme', 'slug': 'Acme'}, 'slug must be'),
    ({'name': 'Acme', 'slug': 'acme_co'}, 'slug must be'),
    ({'name': 'Acme', 'slug': '-acme'}, 'slug must be'),
    ({'name': 'Acme', 'slug': 'acme-'}, 'slug must be'),
    ({'name': 'Acme', 'slug': ' acme'}, 'slug must be'),
    ({'name': 'Acme', 'slug': 'platform'}, 'reserved'),
    ({'name': 'Acme', 'slug': 'acme', 'status': 'deleting'}, 'Unknown field'),
], ids=['no-name', 'blank-name', 'long-name', 'name-type', 'control', 'no-slug', 'short-slug', 'long-slug',
        'upper-slug', 'underscore', 'leading-dash', 'trailing-dash', 'space', 'reserved', 'unknown-field'])
def test_a_bad_body_is_a_400_that_says_what_to_fix(body, message):
    with pytest.raises(ValidationError, match=message):
        parse_new_workspace(body)


@pytest.mark.parametrize('slug', sorted(RESERVED_SLUGS))
def test_every_reserved_slug_is_refused(slug):
    with pytest.raises(ValidationError, match='reserved'):
        parse_new_workspace({'name': 'Acme', 'slug': slug})


def test_the_slug_limits_are_3_and_40_characters():
    assert [parse_new_workspace({'name': 'A', 'slug': slug}).slug for slug in ('a1b', 'a' * 40)] == ['a1b', 'a' * 40]


# ── The id ───────────────────────────────────────────────────────────────────

def test_a_new_id_is_ws_and_a_ulid():
    ids = {new_workspace_id() for _ in range(200)}
    assert len(ids) == 200
    assert all(is_workspace_id(ws) for ws in ids)


def test_the_id_starts_with_the_time_so_ids_sort_by_creation():
    with patch('shared.platform_workspaces.secrets.randbits', return_value=0):
        assert new_workspace_id(0) == 'ws_' + '0' * 26
        assert new_workspace_id(1) == 'ws_' + '0' * 9 + '1' + '0' * 16
        assert new_workspace_id((1 << 48) - 1) == 'ws_7' + 'Z' * 9 + '0' * 16
        assert new_workspace_id(1) < new_workspace_id(2)


def test_the_random_part_uses_crockford_base32():
    with patch('shared.platform_workspaces.secrets.randbits', return_value=(1 << 80) - 1):
        assert new_workspace_id(0) == 'ws_' + '0' * 10 + 'Z' * 16


# ── Create: one transaction ──────────────────────────────────────────────────

def test_create_writes_every_row_in_one_transaction(table):
    with patch.object(table.meta.client, 'transact_write_items', wraps=table.meta.client.transact_write_items) as tx:
        ws = _create(table)
    [call] = tx.call_args_list
    items = call.kwargs['TransactItems']
    assert [item['Put']['Item']['pk'] for item in items] == [
        'SLUG#acme', f'WS#{ws}', f'WS#{ws}', f'USER#{CREATOR}', LISTING_PK, f'AUDIT#WS#{ws}']
    assert {item['Put']['ConditionExpression'] for item in items} == {'attribute_not_exists(pk)'}
    assert {item['Put']['TableName'] for item in items} == {'workspaces'}
    # A retried create whose first attempt landed is idempotent, not a false 409 on its own slug.
    assert call.kwargs['ClientRequestToken'] == ws


def test_create_stores_the_workspace_its_admin_and_its_audit_row(table):
    ws = _create(table)
    assert _partition(table, 'SLUG#acme') == [{'pk': 'SLUG#acme', 'sk': 'META', 'workspace_id': ws, 'created_at': AT}]
    assert sorted(_partition(table, f'WS#{ws}'), key=lambda row: row['sk']) == [
        {'pk': f'WS#{ws}', 'sk': f'MEMBER#{CREATOR}', 'role': 'admin', 'invited_by': CREATOR, 'joined_at': AT},
        {'pk': f'WS#{ws}', 'sk': 'META', 'name': 'Acme Outfitters', 'slug': 'acme', 'status': 'active',
         'created_by': CREATOR, 'created_at': AT, 'secret_status': CREDENTIALS_PENDING},
    ]
    assert _partition(table, f'USER#{CREATOR}') == [
        {'pk': f'USER#{CREATOR}', 'sk': f'WS#{ws}', 'name': 'Acme Outfitters', 'slug': 'acme', 'role': 'admin'}]
    [audit] = _partition(table, f'AUDIT#WS#{ws}')
    assert audit['sk'].startswith(f'{AT}#')
    assert {k: audit[k] for k in ('kind', 'actor', 'at', 'slug')} == {
        'kind': WORKSPACE_CREATED, 'actor': CREATOR, 'at': AT, 'slug': 'acme'}


def test_no_row_the_create_writes_carries_a_ttl(table):
    _create(table)
    rows = table.scan()['Items']
    assert len(rows) == 6
    assert [row['pk'] for row in rows if 'ttl' in row] == []


# voc-workspaces holds primary data (members, audit) beside invites, and its TTL attribute is `ttl`: only an
# `INVITE#` row may carry one (docs/multi-workspace.md, Open tenet questions). No writer of the table built so far
# writes invites, so none of their modules may name the attribute at all.
VOC_WORKSPACES_WRITERS = ('shared/workspace.py', 'shared/platform_workspaces.py', 'api/workspaces_handler.py')


@pytest.mark.parametrize('module', VOC_WORKSPACES_WRITERS)
def test_only_invite_rows_may_carry_a_ttl_and_no_writer_writes_one(module):
    tree = ast.parse((LAMBDA_DIR / module).read_text(encoding='utf-8'))
    named = [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and node.value == 'ttl']
    assert named == [], f'{module} names the TTL attribute; only an INVITE# row may carry it'


def test_a_slug_that_is_taken_is_a_409_and_writes_nothing(table):
    _create(table)
    before = table.scan()['Items']
    with pytest.raises(ConflictError, match=SLUG_TAKEN):
        _create(table, NewWorkspace(name='Another Acme', slug='acme'), creator='sub-other')
    assert table.scan()['Items'] == before


def test_a_transaction_that_fails_otherwise_propagates(table):
    fault = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'x'}},
                        'TransactWriteItems')
    with patch.object(table.meta.client, 'transact_write_items', side_effect=fault), \
            pytest.raises(ClientError, match='ProvisionedThroughput'):
        _create(table)


def test_a_collision_on_another_row_is_not_a_slug_conflict(table):
    reasons: list = [{'Code': 'None'}, {'Code': 'ConditionalCheckFailed'}]
    fault = ClientError({'Error': {'Code': 'TransactionCanceledException', 'Message': 'x'},
                         'CancellationReasons': reasons}, 'TransactWriteItems')
    with patch.object(table.meta.client, 'transact_write_items', side_effect=fault), \
            pytest.raises(ClientError, match='TransactionCanceled'):
        _create(table)


def test_mark_secret_ready_flips_the_meta_and_the_listing_row_of_a_pending_workspace_only(table):
    ws = _create(table)
    name = table.get_item(Key={'pk': f'WS#{ws}', 'sk': 'META'})['Item']['name']
    assert [w['secret_status'] for w in list_workspaces(table, limit=10, cursor=None)[0]] == [CREDENTIALS_PENDING]
    mark_secret_ready(table, ws, name)
    assert table.get_item(Key={'pk': f'WS#{ws}', 'sk': 'META'})['Item']['secret_status'] == CREDENTIALS_READY
    assert [w['secret_status'] for w in list_workspaces(table, limit=10, cursor=None)[0]] == [CREDENTIALS_READY]
    with pytest.raises(ClientError, match='TransactionCanceled'):
        mark_secret_ready(table, ws, name)
    with pytest.raises(ClientError, match='TransactionCanceled'):
        mark_secret_ready(table, 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ', name)


# ── The credentials secret ───────────────────────────────────────────────────

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'


@pytest.fixture
def secrets_and_key() -> Iterator:
    with mock_aws():
        key = boto3.client('kms', region_name='us-east-1').create_key()['KeyMetadata']['Arn']
        yield boto3.client('secretsmanager', region_name='us-east-1'), key


def test_the_secret_is_created_empty_with_the_key_and_the_tag(secrets_and_key):
    client, key = secrets_and_key
    ensure_credentials_secret(client, prefix='voc/ws', ws=WS, kms_key_arn=key)
    described = client.describe_secret(SecretId=f'voc/ws/{WS}/credentials')
    assert (described['KmsKeyId'], described['Tags']) == (key, [{'Key': 'workspace_id', 'Value': WS}])
    assert client.get_secret_value(SecretId=f'voc/ws/{WS}/credentials')['SecretString'] == '{}'


def test_the_secret_name_takes_the_deployment_prefix(secrets_and_key):
    client, key = secrets_and_key
    ensure_credentials_secret(client, prefix='stg-voc/ws', ws=WS, kms_key_arn=key)
    assert [s['Name'] for s in client.list_secrets()['SecretList']] == [f'stg-voc/ws/{WS}/credentials']


def test_a_secret_that_already_exists_for_the_workspace_is_kept(secrets_and_key):
    client, key = secrets_and_key
    ensure_credentials_secret(client, prefix='voc/ws', ws=WS, kms_key_arn=key)
    client.put_secret_value(SecretId=f'voc/ws/{WS}/credentials', SecretString='{"github": "kept"}')
    ensure_credentials_secret(client, prefix='voc/ws', ws=WS, kms_key_arn=key)
    assert client.get_secret_value(SecretId=f'voc/ws/{WS}/credentials')['SecretString'] == '{"github": "kept"}'


def test_a_secret_by_that_name_that_is_not_the_workspaces_is_an_error(secrets_and_key):
    client, key = secrets_and_key
    client.create_secret(Name=f'voc/ws/{WS}/credentials', SecretString='{}')
    with pytest.raises(CredentialsSecretError):
        ensure_credentials_secret(client, prefix='voc/ws', ws=WS, kms_key_arn=key)


def test_any_other_secrets_manager_error_propagates():
    client = MagicMock()
    client.create_secret.side_effect = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'x'}},
                                                   'CreateSecret')
    with pytest.raises(ClientError, match='AccessDenied'):
        ensure_credentials_secret(client, prefix='voc/ws', ws=WS, kms_key_arn='arn:key')
    client.describe_secret.assert_not_called()


@pytest.mark.parametrize('ws', ['ws_bogus', f'{WS}/../other', '../voc-datalake/api-credentials'],
                         ids=['malformed', 'path', 'other-secret'])
def test_the_secret_name_takes_only_a_well_formed_workspace_id(ws):
    client = MagicMock()
    with pytest.raises(ValueError, match='not a workspace id'):
        ensure_credentials_secret(client, prefix='voc/ws', ws=ws, kms_key_arn='arn:key')
    client.create_secret.assert_not_called()


# ── List ─────────────────────────────────────────────────────────────────────

def _seed(table, names):
    with patch('shared.platform_workspaces.now_iso', return_value=AT):
        return {name: create_workspace(table, NewWorkspace(name=name, slug=f'slug-{n}'), CREATOR)
                for n, name in enumerate(names)}


def test_the_list_is_every_workspace_by_name(table):
    ids = _seed(table, ['zephyr', 'Acme', 'birch'])
    workspaces, cursor = list_workspaces(table, limit=25, cursor=None)
    assert workspaces == [
        {'id': ids['Acme'], 'name': 'Acme', 'slug': 'slug-1', 'status': 'active', 'created_at': AT,
         'secret_status': CREDENTIALS_PENDING},
        {'id': ids['birch'], 'name': 'birch', 'slug': 'slug-2', 'status': 'active', 'created_at': AT,
         'secret_status': CREDENTIALS_PENDING},
        {'id': ids['zephyr'], 'name': 'zephyr', 'slug': 'slug-0', 'status': 'active', 'created_at': AT,
         'secret_status': CREDENTIALS_PENDING},
    ]
    assert cursor is None


def test_the_list_pages_with_an_opaque_cursor(table):
    _seed(table, ['a1', 'b2', 'c3', 'd4', 'e5'])
    pages, cursor = [], None
    while True:
        page, cursor = list_workspaces(table, limit=2, cursor=cursor)
        pages.append([w['name'] for w in page])
        if cursor is None:
            break
    assert [name for page in pages for name in page] == ['a1', 'b2', 'c3', 'd4', 'e5']
    assert all(len(page) <= 2 for page in pages)


def test_the_list_is_one_query_of_the_listing_partition_never_a_scan(table):
    _seed(table, ['Acme'])
    with patch.object(table, 'scan', side_effect=AssertionError('no scan')), \
            patch.object(table, 'query', wraps=table.query) as query:
        list_workspaces(table, limit=25, cursor=None)
    [call] = query.call_args_list
    assert call.kwargs['ExpressionAttributeValues'] == {':pk': LISTING_PK}
    assert (call.kwargs['Limit'], call.kwargs['ConsistentRead']) == (25, True)


@pytest.mark.parametrize('cursor', ['not-base64-json', 'eyJwayI6IlVTRVIjc3ViLXBhdCIsInNrIjoiV1MjeCJ9'],
                         ids=['garbage', 'other-partition'])
def test_a_cursor_from_elsewhere_is_refused(table, cursor):
    with pytest.raises(ValueError, match='not valid'):
        list_workspaces(table, limit=25, cursor=cursor)


def test_a_malformed_listing_row_is_left_out_and_counted(table):
    _seed(table, ['Acme'])
    table.put_item(Item={'pk': LISTING_PK, 'sk': 'broken#ws_bad', 'workspace_id': 'ws_bad', 'name': 'Broken'})
    with patch('shared.platform_workspaces.logger') as logger:
        workspaces, _ = list_workspaces(table, limit=25, cursor=None)
    assert [w['name'] for w in workspaces] == ['Acme']
    logger.warning.assert_called_once_with('Left out malformed workspace listing rows', extra={'count': 1})
