"""voc-adoption-rollup (jobs/adoption_rollup/handler.py) on moto tables: what it reads (projected Queries only, never a
Scan, never a feedback item), what it writes (one ADOPTION item per scope and day, nothing else) and a rebuild's
idempotence."""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from jobs.adoption_rollup import handler
from jobs.adoption_rollup.handler import Rollup, RollupIncomplete, handle_event
from shared.indexes import AGENTS_LISTING_INDEX, CONVERSATIONS_BY_KIND_INDEX
from shared.test.moto_tables import create_pk_sk_table, create_table_with_gsi1

ACME = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
BIRCH = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
GONE = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DA'
NOW = datetime(2026, 11, 21, 3, 5, tzinfo=UTC)
PROJECT_IDS = {'deployment': 'proj_000000000000000000000001', ACME: 'proj_000000000000000000000002',
               'deleted': 'proj_000000000000000000000003'}


def _conversations_table(resource: Any) -> Any:
    return resource.create_table(
        TableName='conversations', BillingMode='PAY_PER_REQUEST',
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': name, 'AttributeType': 'S'}
                              for name in ('pk', 'sk', 'kind', 'updated_at')],
        GlobalSecondaryIndexes=[{'IndexName': CONVERSATIONS_BY_KIND_INDEX,
                                 'KeySchema': [{'AttributeName': 'kind', 'KeyType': 'HASH'},
                                               {'AttributeName': 'updated_at', 'KeyType': 'RANGE'}],
                                 'Projection': {'ProjectionType': 'INCLUDE', 'NonKeyAttributes': ['message_count']}}])


def _seed(tables: dict[str, Any]) -> None:
    workspaces, projects = tables['workspaces'], tables['projects']
    for ws, status in ((ACME, 'active'), (BIRCH, 'active'), (GONE, 'deleting')):
        workspaces.put_item(Item={'pk': 'WORKSPACES', 'sk': f'{ws}#{ws}', 'workspace_id': ws, 'status': status,
                                  'name': f'Example {ws[-2:]}'})
    deployment, acme, deleted = PROJECT_IDS['deployment'], PROJECT_IDS[ACME], PROJECT_IDS['deleted']
    projects.put_item(Item={'pk': 'PROJECT_IDS', 'sk': deployment, 'created_at': '2026-10-01T00:00:00+00:00'})
    projects.put_item(Item={'pk': 'PROJECT_IDS', 'sk': deleted, 'deleted_at': '2026-11-01T00:00:00+00:00'})
    projects.put_item(Item={'pk': f'WS#{ACME}#PROJECT_IDS', 'sk': acme})
    rows = {
        f'PROJECT#{deployment}': [
            {'sk': 'META', 'created_at': '2026-10-01T00:00:00+00:00', 'name': 'Secret plan', 'owner_email': 'a@x.io'},
            {'sk': f'PRD#{deployment}a', 'document_type': 'prd', 'created_at': '2026-10-08T00:00:00+00:00',
             'job_id': 'j1', 'content': 'Long customer text'},
            {'sk': 'DOC#dec1', 'document_type': 'decision', 'created_at': '2026-11-02T00:00:00+00:00',
             'decision': {'verdict': 'pursue', 'decided_at': '2026-11-02T00:00:00+00:00', 'rationale': 'Because',
                          'evidence': {'document_ids': [], 'feedback_ids': ['fb1']}}},
        ],
        f'WS#{ACME}#PROJECT#{acme}': [
            {'sk': 'META', 'created_at': '2026-11-03T00:00:00+00:00'},
            {'sk': 'PERSONA#p1', 'created_at': '2026-11-04T00:00:00+00:00', 'name': 'Ana'},
        ],
        f'PROJECT#{deleted}': [{'sk': 'META', 'created_at': '2026-11-01T00:00:00+00:00'}],
    }
    for pk, items in rows.items():
        for item in items:
            projects.put_item(Item={'pk': pk, **item})
    conversations = tables['conversations']
    for pk, updated in (('USER#sub-ada', '2026-11-02T10:00:00+00:00'), ('USER#sub-bob', '2026-10-02T10:00:00+00:00'),
                        (f'WS#{ACME}#USER#sub-ada', '2026-11-05T10:00:00+00:00'),
                        (f'WS#{BIRCH}#USER#sub-bea', '2026-11-05T10:00:00+00:00')):
        conversations.put_item(Item={'pk': pk, 'sk': f'CONV#{updated}', 'kind': 'assistant', 'updated_at': updated,
                                     'title': 'private', 'message_count': 3})
    agents = tables['agents']
    agents.put_item(Item={'pk': 'AGENT#ag1', 'sk': 'META', 'gsi1pk': 'AGENTS', 'gsi1sk': 'Scout', 'instructions': 'x'})
    for run, started in (('r1', '2026-11-01T00:00:00+00:00'), ('r2', '2026-10-01T00:00:00+00:00')):
        agents.put_item(Item={'pk': 'AGENT#ag1', 'sk': f'RUN#{run}', 'started_at': started, 'status': 'succeeded'})


@pytest.fixture
def tables() -> Iterator[dict[str, Any]]:
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        made = {'aggregates': create_pk_sk_table('aggregates', resource),
                'projects': create_pk_sk_table('projects', resource),
                'workspaces': create_pk_sk_table('workspaces', resource),
                'conversations': _conversations_table(resource),
                'agents': create_table_with_gsi1(resource, 'agents', AGENTS_LISTING_INDEX)}
        _seed(made)
        yield made


def _rollup(tables: dict[str, Any], **overrides: Any) -> Rollup:
    return Rollup(aggregates=tables['aggregates'], projects=tables['projects'], workspaces=tables['workspaces'],
                  conversations=tables['conversations'], agents=tables['agents'], now=lambda: NOW, **overrides)


def _written(tables: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item['pk']: item for item in tables['aggregates'].scan()['Items']}


def test_one_item_per_active_scope_for_the_day(tables):
    assert handle_event({'mode': 'scheduled'}, _rollup(tables)) == {'scopes': 3, 'written': 3, 'partial': 0}
    written = _written(tables)
    assert set(written) == {'ADOPTION#ROLLUP', f'WS#{ACME}#ADOPTION#ROLLUP', f'WS#{BIRCH}#ADOPTION#ROLLUP'}
    assert {item['sk'] for item in written.values()} == {'2026-11-21'}


def test_the_deployment_counts_its_live_projects_conversations_and_agent_runs(tables):
    handle_event({}, _rollup(tables))
    item = _written(tables)['ADOPTION#ROLLUP']
    months = item['months']
    assert (item['first_month'], item['last_month'], item['projects'], item['complete']) == (
        '2024-12', '2026-11', 1, True)
    assert months['2026-10']['projects_started'] == 1
    assert months['2026-10']['artifacts'] == {'prd': {'ai': 1}}
    assert months['2026-11']['decisions'] == {'pursue': 1}
    assert (months['2026-11']['assistant_conversations'], months['2026-10']['assistant_conversations']) == (1, 1)
    assert (months['2026-11']['agent_runs'], item['agent_runs_counted']) == (1, True)


def test_a_workspace_counts_only_its_own_and_no_agent_runs(tables):
    handle_event({}, _rollup(tables))
    item = _written(tables)[f'WS#{ACME}#ADOPTION#ROLLUP']
    assert item['months']['2026-11'] == {'projects_started': 1, 'with': {'personas': 1},
                                         'artifacts': {'personas': {'ai': 1}}, 'assistant_conversations': 1}
    assert item['agent_runs_counted'] is False


def test_the_items_hold_no_name_text_or_person(tables):
    handle_event({}, _rollup(tables))
    text = repr(_written(tables))
    for value in ('Secret plan', 'a@x.io', 'Long customer text', 'Because', 'fb1', 'Ana', 'sub-ada', 'private'):
        assert value not in text


def test_a_rebuild_the_same_day_writes_the_same_items(tables):
    handle_event({}, _rollup(tables))
    first = _written(tables)
    handle_event({}, _rollup(tables))
    second = _written(tables)
    for item in (*first.values(), *second.values()):
        item.pop('rolled_up_at')
    assert first == second


def test_it_only_queries_the_four_tables_and_only_puts_to_the_aggregates(tables):
    """Each table the rollup is handed exposes the one call it may make: a Scan, a GetItem or any write to a read
    table, or a read of voc-aggregates, would raise AttributeError. No feedback table is handed to it at all."""
    queried: list[str] = []

    def only_queries(table: Any) -> SimpleNamespace:
        def query(**kwargs: Any) -> Any:
            queried.append(table.name)
            return table.query(**kwargs)

        return SimpleNamespace(query=query, name=table.name)

    rollup = Rollup(aggregates=SimpleNamespace(put_item=tables['aggregates'].put_item, name='aggregates'),
                    projects=only_queries(tables['projects']), workspaces=only_queries(tables['workspaces']),
                    conversations=only_queries(tables['conversations']), agents=only_queries(tables['agents']),
                    now=lambda: NOW)
    assert handle_event({}, rollup)['written'] == 3
    assert set(queried) == {'projects', 'workspaces', 'conversations', 'agents'}


def test_every_project_query_is_projected(tables):
    calls: list[dict[str, Any]] = []
    real = tables['projects'].query

    def query(**kwargs: Any) -> Any:
        calls.append(kwargs)
        return real(**kwargs)

    with patch.object(tables['projects'], 'query', query):
        handle_event({}, _rollup(tables))
    assert calls
    assert all(call.get('Select') == 'SPECIFIC_ATTRIBUTES' and call.get('ProjectionExpression') for call in calls)


def test_a_scope_aws_refuses_is_not_written_and_the_run_raises_after_the_others(tables):
    real = tables['projects'].query

    def query(**kwargs: Any) -> Any:
        if str(kwargs.get('ExpressionAttributeValues', {}).get(':p', '')).startswith(f'WS#{ACME}#'):
            raise ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'Query')
        return real(**kwargs)

    with patch.object(tables['projects'], 'query', query), pytest.raises(RollupIncomplete) as raised:
        handle_event({}, _rollup(tables))
    assert raised.value.scopes == {ACME: 'AccessDeniedException'}
    assert f'WS#{ACME}#ADOPTION#ROLLUP' not in _written(tables)
    assert 'ADOPTION#ROLLUP' in _written(tables)


def test_out_of_time_a_scope_is_written_partial(tables):
    with patch.object(handler, 'RESERVE_SECONDS', 0.0):
        handle_event({}, _rollup(tables, remaining=lambda: 0.0))
    complete = {item['pk']: item['complete'] for item in _written(tables).values()}
    assert complete == {'ADOPTION#ROLLUP': False, f'WS#{ACME}#ADOPTION#ROLLUP': False,
                        f'WS#{BIRCH}#ADOPTION#ROLLUP': True}


def test_the_handler_needs_every_table(monkeypatch):
    for name in ('AGGREGATES_TABLE', 'PROJECTS_TABLE', 'WORKSPACES_TABLE', 'CONVERSATIONS_TABLE', 'AGENTS_TABLE'):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(Exception, match='Missing table configuration'):
        handler._tables()
