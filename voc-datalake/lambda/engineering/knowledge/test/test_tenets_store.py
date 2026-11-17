"""The repository's tenets, versioned (7.52.00, knowledge/tenets.py) on moto: a draft per run, an administrator's
acceptance or rejection, each leaving its rows (D1) and who and when (D4)."""
from __future__ import annotations

import json
import re
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from engineering.board.test.table import TABLE
from engineering.knowledge.render_docs import render_tenets
from engineering.knowledge.store import Actor, PackConflict, PackError, PackForbidden, PackUnavailable
from engineering.knowledge.tenets import ACCEPTED, DRAFT, DRAFT_ATTRIBUTES, REJECTED, TenetsStore
from engineering.knowledge.test.fixtures import pack_tables

CONN = 'conn-harbor'
RUN, OTHER_RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0AB', '01JD3R4NZXQ7Y2W8K4M6P9T0AC'
AGENT = Actor('understander-1', 'agent', connection=CONN)
ADMIN = Actor('admin-sub-1', 'person', admin=True)
MEMBER = Actor('member-sub-2', 'person')
AT = datetime(2026, 11, 17, 9, 0, tzinfo=UTC)
RECORD = {'tenets': [{'id': 'T1', 'title': 'Fail closed', 'statement': 'An unknown state refuses.'},
                     {'id': 'T2', 'title': 'Tests first', 'statement': 'Every public function has a test.'}]}


@pytest.fixture
def world() -> Iterator[tuple[Any, TenetsStore]]:
    with pack_tables() as (client, _s3, _workspace):
        yield client, TenetsStore(client, TABLE, now=lambda: AT)


def _rows(client: Any) -> dict[str, dict[str, Any]]:
    items = client.query(TableName=TABLE, KeyConditionExpression='pk = :pk',
                         ExpressionAttributeValues={':pk': {'S': f'WS#default#REPO#{CONN}'}})['Items']
    return {item['sk']['S']: item for item in items}


def test_a_run_drafts_once_and_each_draft_is_a_new_version(world: tuple[Any, TenetsStore]) -> None:
    client, store = world
    first = store.draft('default', CONN, RECORD, author=AGENT, run_id=RUN)
    assert first is not None
    assert (first.version, first.status, first.ids, first.author, first.run_id) == (1, DRAFT, ('T1', 'T2'),
                                                                                    'understander-1', RUN)
    assert store.draft('default', CONN, RECORD, author=AGENT, run_id=RUN) is None   # (the run's row: once)
    second = store.draft('default', CONN, {'tenets': RECORD['tenets'][:1]}, author=AGENT, run_id=OTHER_RUN)
    assert second is not None
    assert second.version == 2
    rows = _rows(client)
    assert set(rows) == {'TENETS', 'TENETS#000001', 'TENETS#000002', 'TENETSLOG#000001#drafted',
                         'TENETSLOG#000002#drafted', f'TENETSRUN#{RUN}', f'TENETSRUN#{OTHER_RUN}'}
    assert rows['TENETS']['versions']['N'] == '2'
    assert json.loads(rows['TENETS#000001']['record']['S'])['schema'] == 'voc-tenets/1'


def test_a_draft_writes_only_the_attributes_the_runtime_may_write(world: tuple[Any, TenetsStore]) -> None:
    """The runtime's IAM grant pins these attributes (engineering-runtime-grants.ts): never an acceptance's."""
    client, store = world
    store.draft('default', CONN, RECORD, author=AGENT, run_id=RUN)
    written = {name for item in _rows(client).values() for name in item}
    assert written <= set(DRAFT_ATTRIBUTES)
    assert not written & {'accepted_version', 'accepted_digest', 'accepted_ids', 'decided_by', 'rendering_digest'}


def test_a_record_off_its_shape_is_refused(world: tuple[Any, TenetsStore]) -> None:
    _client, store = world
    with pytest.raises(PackError):
        store.draft('default', CONN, {'tenets': [{'id': 'T 1', 'title': 'x', 'statement': 'y'}]}, author=AGENT)
    with pytest.raises(PackError):
        store.draft('default', CONN, {'tenets': RECORD['tenets'] + RECORD['tenets'][:1]}, author=AGENT)


def test_an_acceptance_leaves_its_rows_and_records_the_digest_and_ids(world: tuple[Any, TenetsStore]) -> None:
    client, store = world
    store.draft('default', CONN, RECORD, author=AGENT, run_id=RUN)
    assert store.accepted_ids('default', CONN) == frozenset()
    accepted = store.accept('default', CONN, 1, ADMIN, 'Reads true.')
    assert (accepted.status, accepted.decided_by, accepted.decided_at, accepted.reason) == (
        ACCEPTED, 'admin-sub-1', AT.isoformat(), 'Reads true.')
    digest = render_tenets(accepted.record, 1).digest
    assert accepted.rendering_digest == digest
    head = store.head('default', CONN)
    assert (head.accepted_version, head.accepted_digest, head.accepted_ids) == (1, digest, frozenset({'T1', 'T2'}))
    assert store.log('default', CONN, 1) == [
        {'event': 'accepted', 'by': 'admin-sub-1', 'at': AT.isoformat(), 'reason': 'Reads true.'},
        {'event': 'drafted', 'by': 'understander-1', 'at': AT.isoformat(), 'reason': None}]
    found = store.accepted('default', CONN)
    assert found is not None
    assert (found.version.version, found.digest) == (1, digest)
    assert store.accept('default', CONN, 1, ADMIN) == accepted   # (again: as it is)
    assert 'TENETSLOG#000001#accepted' in _rows(client)


def test_a_rejection_stays_and_only_a_draft_is_decided(world: tuple[Any, TenetsStore]) -> None:
    client, store = world
    store.draft('default', CONN, RECORD, author=AGENT, run_id=RUN)
    rejected = store.reject('default', CONN, 1, ADMIN, 'Too vague.')
    assert (rejected.status, rejected.reason) == (REJECTED, 'Too vague.')
    assert 'TENETSLOG#000001#rejected' in _rows(client)
    with pytest.raises(PackConflict):
        store.accept('default', CONN, 1, ADMIN)
    with pytest.raises(PackConflict):
        store.reject('default', CONN, 1, ADMIN)
    assert store.head('default', CONN).accepted_version == 0


def test_only_an_administrator_decides(world: tuple[Any, TenetsStore]) -> None:
    _client, store = world
    store.draft('default', CONN, RECORD, author=AGENT, run_id=RUN)
    for who in (AGENT, MEMBER):
        with pytest.raises(PackForbidden):
            store.accept('default', CONN, 1, who)
        with pytest.raises(PackForbidden):
            store.reject('default', CONN, 1, who)


def test_the_accepted_version_moves_up_only(world: tuple[Any, TenetsStore]) -> None:
    _client, store = world
    store.draft('default', CONN, RECORD, author=AGENT, run_id=RUN)
    store.draft('default', CONN, {'tenets': RECORD['tenets'][:1]}, author=AGENT, run_id=OTHER_RUN)
    store.accept('default', CONN, 2, ADMIN)
    with pytest.raises(PackConflict, match='a later version is accepted'):
        store.accept('default', CONN, 1, ADMIN)
    assert store.accepted_ids('default', CONN) == frozenset({'T1'})


def test_an_accepted_row_changed_since_is_never_rendered_as_accepted(world: tuple[Any, TenetsStore]) -> None:
    client, store = world
    store.draft('default', CONN, RECORD, author=AGENT, run_id=RUN)
    store.accept('default', CONN, 1, ADMIN)
    changed = {**RECORD, 'tenets': [{**RECORD['tenets'][0], 'statement': 'Anything goes.'}]}
    client.update_item(TableName=TABLE, Key={'pk': {'S': f'WS#default#REPO#{CONN}'}, 'sk': {'S': 'TENETS#000001'}},
                       UpdateExpression='SET #r = :r', ExpressionAttributeNames={'#r': 'record'},
                       ExpressionAttributeValues={':r': {'S': json.dumps({'schema': 'voc-tenets/1', 'summary': '',
                                                                          **changed})}})
    with pytest.raises(PackUnavailable):
        store.accepted('default', CONN)


def test_the_draft_attributes_are_the_runtimes_grant() -> None:
    """lib/stacks/engineering-runtime-grants.ts TENETS_DRAFT_ATTRIBUTES: what the runtime's role may write there."""
    stack = (Path(__file__).parents[4] / 'lib/stacks/engineering-runtime-grants.ts').read_text(encoding='utf-8')
    found = re.search(r"TENETS_DRAFT_ATTRIBUTES = \[([^\]]*)\]", stack)
    assert found is not None
    assert tuple(re.findall(r"'([a-z_]+)'", found.group(1))) == DRAFT_ATTRIBUTES
