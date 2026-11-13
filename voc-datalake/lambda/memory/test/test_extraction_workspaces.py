"""Memory's extraction inside a workspace: the scanner, the extractor and page imports keep to the workspace a
conversation or an import belongs to (docs/memory.md, docs/multi-workspace.md)."""
import json
from datetime import UTC, datetime, timedelta

import pytest

from api.test.moto_helpers import pk_sk_table
from memory.extractor import handler as extractor
from memory.scanner import handler as scanner
from shared import memory_store as store
from shared.test.memory_fixtures import RAW_BUCKET, model_reply
from shared.ws_repo import WorkspaceScope

NOW = datetime(2026, 11, 13, 12, 0, tzinfo=UTC)
OWNER = 'sub-owner'
A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
MESSAGES = [
    {'role': 'user', 'content': 'Our customer demonstrated they abandon checkout when shipping is shown late'},
    {'role': 'assistant', 'content': 'Noted.'},
]
REPLY = model_reply([{'statement': 'Customers abandon checkout when shipping cost is shown late', 'kind': 'customer',
                      'scope': 'company', 'confidence': 0.9, 'retention': 'decay'}])


@pytest.fixture
def workspaces(world, monkeypatch):
    """voc-workspaces with workspace A active and its owner an editor there (inside the memory world's moto)."""
    assert world.memory is not None
    table = pk_sk_table('workspaces')
    table.put_item(Item={'pk': f'WS#{A.ws}', 'sk': 'META', 'status': 'active', 'name': 'Alpha'})
    table.put_item(Item={'pk': f'WS#{A.ws}', 'sk': f'MEMBER#{OWNER}', 'role': 'editor'})
    monkeypatch.setattr(extractor, 'get_workspaces_table', lambda: table)
    return table


def _pks(world) -> set[str]:
    return {str(row['pk']) for row in world.memory.scan(ConsistentRead=True)['Items']}


def _session(world, pk: str, session_id: str = 'conv1') -> None:
    world.conversations.put_item(Item={
        'pk': pk, 'sk': f'CONV#{session_id}', 'conversation_id': session_id, 'kind': 'assistant',
        'messages_json': json.dumps(MESSAGES), 'message_count': len(MESSAGES), 'updated_at': '2026-11-13T10:00:00',
    })


def _sqs_event(body: dict) -> dict:
    return {'Records': [{
        'messageId': 'm0', 'receiptHandle': 'r', 'body': json.dumps(body), 'attributes': {}, 'messageAttributes': {},
        'md5OfBody': '', 'eventSource': 'aws:sqs', 'eventSourceARN': 'arn:aws:sqs:us-east-1:123456789012:q',
        'awsRegion': 'us-east-1',
    }]}


# ── Scanner ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(('pk', 'expected'), [
    (f'USER#{OWNER}', (None, OWNER)),
    (f'WS#{A.ws}#USER#{OWNER}', (A.ws, OWNER)),
    # Not a person's conversation, or not a workspace: never mined, and never as the deployment's.
    (f'WS#{A.ws}#PROJECT#p1', None),
    ('WS#not-a-workspace#USER#sub-owner', None),
    (f'WS#{A.ws}#USER#', None),
    ('PROJECT#p1', None),
])
def test_the_scanner_reads_whose_conversation_and_where(pk, expected):
    session = scanner._session_from_row({'pk': pk, 'sk': 'CONV#conv1', 'message_count': 2, 'updated_at': 'x'})
    found = None if session is None else (getattr(session.get('workspace'), 'ws', None), session['owner_sub'])
    assert found == expected


def test_the_scanner_queues_a_workspace_session_with_its_workspace_and_keeps_its_cursor_there(world, workspaces,
                                                                                                monkeypatch):
    """The same session id in the deployment and in A: two sessions, two cursors, two messages."""
    sessions = [scanner._session_from_row({'pk': pk, 'sk': 'CONV#conv1', 'message_count': 2, 'updated_at': 'x'})
                for pk in (f'USER#{OWNER}', f'WS#{A.ws}#USER#{OWNER}')]
    monkeypatch.setattr(scanner, 'idle_sessions', lambda *_args: sessions)
    monkeypatch.setattr(scanner, 'get_workspaces_table', lambda: workspaces)
    # A's cursor says its two messages are done; the deployment's session has none.
    store.save_cursor(world.memory, 'conv1', {'owner_sub': OWNER, 'extracted_count': 2}, now=NOW, workspace=A)
    assert scanner.scan_and_enqueue(NOW, lambda: 600_000) == {'scanned': 2, 'enqueued': 1}
    assert world.queued() == [{'kind': 'session', 'session_id': 'conv1', 'owner_sub': OWNER}]
    # Now A's grows: it is queued, naming A, and its cursor in A is the one stamped.
    grown = sessions[1]
    assert grown is not None
    grown['message_count'] = 4
    assert scanner.scan_and_enqueue(NOW + timedelta(hours=3), lambda: 600_000)['enqueued'] == 2
    assert {json.dumps(message, sort_keys=True) for message in world.queued()} >= {json.dumps(
        {'kind': 'session', 'session_id': 'conv1', 'owner_sub': OWNER, 'workspace_id': A.ws}, sort_keys=True)}
    assert store.get_cursors(world.memory, ['conv1'], workspace=A)['conv1']['enqueued_at']
    assert store.get_cursors(world.memory, ['conv1'], workspace=A)['conv1']['extracted_count'] == 2


def _scan_with_a_skipped(world, monkeypatch, workspaces_table) -> None:
    """One scan of the deployment's conv1 and A's, with voc-workspaces as given: A's is left alone (no cursor, no
    message), the deployment's is queued as before."""
    monkeypatch.setattr(scanner, 'get_workspaces_table', lambda: workspaces_table)
    sessions = [scanner._session_from_row({'pk': pk, 'sk': 'CONV#conv1', 'message_count': 2, 'updated_at': 'x'})
                for pk in (f'USER#{OWNER}', f'WS#{A.ws}#USER#{OWNER}')]
    monkeypatch.setattr(scanner, 'idle_sessions', lambda *_args: sessions)
    assert scanner.scan_and_enqueue(NOW, lambda: 600_000) == {'scanned': 1, 'enqueued': 1}
    assert world.queued() == [{'kind': 'session', 'session_id': 'conv1', 'owner_sub': OWNER}]
    assert store.get_cursors(world.memory, ['conv1'], workspace=A) == {}


def test_the_scanner_leaves_a_workspace_being_deleted_alone(world, workspaces, monkeypatch):
    workspaces.put_item(Item={'pk': f'WS#{A.ws}', 'sk': 'META', 'status': 'deleting'})
    _scan_with_a_skipped(world, monkeypatch, workspaces)


class _Faulty:
    def get_item(self, **_kwargs):
        raise RuntimeError('throttled')


@pytest.mark.parametrize('table', [_Faulty(), None], ids=['read-fault', 'unconfigured'])
def test_a_workspace_the_scanner_cannot_read_waits_and_the_deployments_sessions_go_on(world, monkeypatch, table):
    _scan_with_a_skipped(world, monkeypatch, table)


# ── Extractor ───────────────────────────────────────────────────────────────

def _run_a_session(world, worker_context, pk: str = f'WS#{A.ws}#USER#{OWNER}') -> int:
    """Extract session conv1 (kept at ``pk``) by a message naming A; how many times the model was asked."""
    _session(world, pk)
    world.converse.return_value = REPLY
    message = {'kind': 'session', 'session_id': 'conv1', 'owner_sub': OWNER, 'workspace_id': A.ws}
    assert extractor.lambda_handler(_sqs_event(message), worker_context) == {'batchItemFailures': []}
    return world.converse.call_count


@pytest.mark.usefixtures('workspaces')
def test_a_workspace_session_is_learned_in_its_workspace(world, worker_context):
    assert _run_a_session(world, worker_context) == 1
    assert f'{A.prefix}{store.COMPANY_PK}' in _pks(world)
    assert world.memories() == []
    assert store.get_cursors(world.memory, ['conv1'], workspace=A)['conv1']['extracted_count'] == 2
    assert store.get_cursors(world.memory, ['conv1']) == {}


@pytest.mark.usefixtures('workspaces')
def test_a_workspace_message_never_reads_the_deployments_conversation(world, worker_context):
    assert _run_a_session(world, worker_context, pk=f'USER#{OWNER}') == 0
    assert store.get_cursors(world.memory, ['conv1'], workspace=A)['conv1']['missing'] is True
    assert world.memories() == []


def test_nothing_is_written_in_a_workspace_being_deleted_not_even_a_cursor(world, workspaces, worker_context):
    workspaces.put_item(Item={'pk': f'WS#{A.ws}', 'sk': 'META', 'status': 'deleting'})
    assert _run_a_session(world, worker_context) == 0
    assert _pks(world) == set()


@pytest.mark.parametrize('change', ['viewer', 'removed'])
def test_nothing_is_learned_for_an_owner_who_no_longer_writes_there(world, workspaces, worker_context, change):
    member = {'pk': f'WS#{A.ws}', 'sk': f'MEMBER#{OWNER}'}
    if change == 'viewer':
        workspaces.put_item(Item={**member, 'role': 'viewer'})
    else:
        workspaces.delete_item(Key=member)
    assert _run_a_session(world, worker_context) == 0
    cursor = store.get_cursors(world.memory, ['conv1'], workspace=A)['conv1']
    assert cursor['extracted_count'] == 2  # not queued again for these messages
    assert 'last_outcome' not in cursor
    assert not any(pk.endswith(store.COMPANY_PK) for pk in _pks(world))


@pytest.mark.parametrize('named', ['', 'ws_short', 42, 'WS#ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'])
@pytest.mark.usefixtures('workspaces')
def test_a_message_naming_no_valid_workspace_is_dropped(world, worker_context, named):
    _session(world, f'USER#{OWNER}')
    world.converse.return_value = REPLY
    message = {'kind': 'session', 'session_id': 'conv1', 'owner_sub': OWNER, 'workspace_id': named}
    assert extractor.lambda_handler(_sqs_event(message), worker_context) == {'batchItemFailures': []}
    assert world.converse.call_count == 0
    assert _pks(world) == set()


def test_an_agent_run_naming_a_workspace_is_dropped_until_agents_run_there(world, worker_context):
    world.converse.return_value = REPLY
    message = {'kind': 'agent_run', 'ref': 'ar_1', 'text': 'Customers abandon checkout', 'owner_sub': OWNER,
               'workspace_id': A.ws}
    extractor.lambda_handler(_sqs_event(message), worker_context)
    assert world.converse.call_count == 0
    assert _pks(world) == set()


def _workspace_import(world, import_id: str, content: str) -> None:
    world.s3.put_object(Bucket=RAW_BUCKET, Key=f'ws/{A.ws}/memory-imports/{import_id}.json',
                        Body=json.dumps({'content': content}).encode())
    store.put_new(world.memory, {**store.import_key(import_id, A), 'import_id': import_id, 'status': 'queued',
                                    'chunks_done': 0, 'created': 0, 'created_by_hash': 'h-rev'})


def test_a_workspace_import_stops_once_its_workspace_is_being_deleted(world, workspaces, worker_context):
    workspaces.put_item(Item={'pk': f'WS#{A.ws}', 'sk': 'META', 'status': 'deleting'})
    _workspace_import(world, 'imp_ws2', '\n\n'.join(['Customers love the loyalty program. ' * 300] * 2))
    world.converse.return_value = REPLY
    extractor.lambda_handler(_sqs_event(store.import_message('imp_ws2', 0, 'sub-rev', A)), worker_context)
    assert world.converse.call_count == 0
    assert world.queued() == []
    record = store.get_import(world.memory, 'imp_ws2', workspace=A) or {}
    assert (record.get('status'), record.get('chunks_done')) == ('queued', 0)


@pytest.mark.usefixtures('workspaces')
def test_a_workspace_import_reads_its_page_there_and_carries_the_workspace_chunk_to_chunk(world, worker_context):
    import_id = 'imp_ws1'
    content = '\n\n'.join(['Customers love the loyalty program. ' * 300] * 2)
    _workspace_import(world, import_id, content)
    # The deployment's key holds another page: never read for A's import.
    world.s3.put_object(Bucket=RAW_BUCKET, Key=f'memory-imports/{import_id}.json',
                        Body=json.dumps({'content': 'The deployment page'}).encode())
    world.converse.return_value = model_reply([{'statement': 'Customers love the loyalty program',
                                                'kind': 'customer', 'scope': 'company', 'confidence': 0.9}])
    extractor.lambda_handler(_sqs_event(store.import_message(import_id, 0, 'sub-rev', A)), worker_context)
    [follow_up] = world.queued()
    assert follow_up == {'kind': 'import', 'import_id': import_id, 'chunk': 1, 'notify': 'sub-rev',
                         'workspace_id': A.ws}
    assert 'The deployment page' not in world.converse.call_args.kwargs['prompt']
    extractor.lambda_handler(_sqs_event(follow_up), worker_context)
    record = store.get_import(world.memory, import_id, workspace=A)
    assert record is not None
    assert record['status'] == 'completed'
    assert store.get_import(world.memory, import_id) is None
    assert f'{A.prefix}{store.COMPANY_PK}' in _pks(world)
    assert world.memories() == []


def test_the_import_object_key_is_the_workspaces_own():
    assert store.import_object_key('imp_1') == 'memory-imports/imp_1.json'
    assert store.import_object_key('imp_1', A) == f'ws/{A.ws}/memory-imports/imp_1.json'
