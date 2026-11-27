"""voc-retention reaches the engineering agents' rows (7.84.00, projects 3g3-b; TENETS.md D5 and D8).

End to end in moto, with the engineering tables configured as ``-c engineeringAgents=true`` configures them:

- the lineage pass: an erased review's id leaves an engineering run's ``META`` (``feedback.ids``) and an issue's
  ``ISSUE_RUN#`` claim (``feedback_id``), each marked ``erased_evidence``; a run or a claim citing only kept reviews is
  left as it was; the runs are found through the runs list's month partitions and the claims through their one
  partition, never a Scan; a workspace's erasure never reads them (they cite the deployment's feedback only);
- the agents' memory: an erasure by email resolves the address to its account's ``sub`` in the user directory (a
  verified address only), saves it before anything is erased, and erases that person's memories with the store's own
  erasure (its tombstone and delete record first, under the job's legal basis); a hand-over or a failed job is
  finished from the cursor or the saved row, even once the account is gone;
- without the engineering tables neither phase reads anything;
- every call on voc-engineering, voc-agents and the user directory is one lib/stacks/retention-worker.ts grants.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from collections.abc import Iterator, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final
from unittest.mock import patch

import boto3
import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from engineering.agent_memory import erasure as memory_erasure
from engineering.agent_memory.model import MemoryInput, Provenance, RunContext, Scope
from engineering.agent_memory.store import AgentMemoryStore
from engineering.connectors.identity import WORKSPACE as ENGINEERING_WORKSPACE
from engineering.knowledge.store import Actor
from engineering.runtime import runs as engineering_runs
from jobs.retention import agent_memory, engineering_lineage, handler, runs
from jobs.retention.test.conftest import erasure_job, erasure_rows, put_feedback
from jobs.retention.test.test_participant_erasure import _erase as erase_by_email
from jobs.retention.test.test_participant_erasure import _matches, _no_filter, recorded_calls
from jobs.retention.test.test_workspace_erasure import BASIS, JOB_ID, WS, put_workspace_feedback
from shared import agents_store
from shared.delete_audit import AUDIT_PK
from shared.digests import sha256_hex
from shared.retention import (
    AGENT_MEMORY_COUNTER,
    AGENT_MEMORY_NOT_ERASED_COUNTER,
    AGENT_MEMORY_REFUSED_COUNTER,
    ENGINEERING_MARK_COUNTER,
    ERASURE_JOB_PK,
)
from shared.test.moto_tables import create_pk_sk_table

ENGINEERING_TABLE: Final = 'test-engineering'
AGENTS_TABLE: Final = 'test-agents'
RETENTION_WORKER: Final = Path(__file__).resolve().parents[4] / 'lib' / 'stacks' / 'retention-worker.ts'
ADDRESS: Final = 'dana.reviewer@example.com'
OTHER_ADDRESS: Final = 'oscar.reviewer@example.com'
RUN_ERASED, RUN_KEPT, RUN_DECEMBER = ('01JD0000000000000000000001', '01JD0000000000000000000002',
                                      '01JD0000000000000000000003')
NOVEMBER: Final = int(datetime(2026, 11, 20, 9, 0, tzinfo=UTC).timestamp())
DECEMBER: Final = int(datetime(2026, 12, 2, 9, 0, tzinfo=UTC).timestamp())
REPO: Final = 'owner/harbor'
CONN: Final = 'conn-harbor'
SECOND_JOB: Final = 'er_00000000c0df'


# ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────

class _UserPool:
    """The user directory's calls the job and these tests make, as Cognito answers them. ``AdminGetUser`` takes a
    username or an alias: the pool signs in by email (core-auth.ts ``signInAliases: email``), and an email is an alias
    once it is verified; with ``signInCaseSensitive: false`` (every pool since #105) both are matched whatever their
    case, a pool made before it (``omitUserPoolUsernameConfiguration``) matches the exact spelling only."""

    POOL: Final = 'us-east-1_TestPool1'

    def __init__(self, *, case_sensitive: bool = False) -> None:
        self.users: dict[str, dict[str, str]] = {}
        self.case_sensitive = case_sensitive

    def _same(self, stored: str, asked: str) -> bool:
        return stored == asked if self.case_sensitive else stored.lower() == asked.lower()

    def admin_get_user(self, *, UserPoolId: str, Username: str) -> dict[str, Any]:
        assert UserPoolId == self.POOL
        for name, attributes in sorted(self.users.items()):
            alias = attributes.get('email', '') if attributes.get('email_verified') == 'true' else None
            if self._same(name, Username) or (alias is not None and self._same(alias, Username)):
                return {'Username': name, 'Enabled': True,
                        'UserAttributes': [{'Name': key, 'Value': value} for key, value in attributes.items()]}
        raise ClientError({'Error': {'Code': 'UserNotFoundException', 'Message': 'User does not exist.'}},
                          'AdminGetUser')

    def admin_create_user(self, *, UserPoolId: str, Username: str, UserAttributes: list[dict[str, str]],
                          **_options: Any) -> dict[str, Any]:
        assert UserPoolId == self.POOL
        attributes = {'sub': str(uuid.uuid4()), **{a['Name']: a['Value'] for a in UserAttributes}}
        self.users[Username] = attributes
        return {'User': {'Username': Username,
                         'Attributes': [{'Name': name, 'Value': value} for name, value in attributes.items()]}}

    def admin_delete_user(self, *, UserPoolId: str, Username: str) -> None:
        assert UserPoolId == self.POOL
        del self.users[Username]


@pytest.fixture
def engineering(aws) -> Iterator[dict[str, Any]]:
    """voc-engineering, voc-agents and a user pool, the handler pointed at them (the conftest's ``aws`` mock is
    active): the deployment built with ``-c engineeringAgents=true``."""
    resource = aws['aggregates'].meta.client.meta  # the conftest's resource shares this region and endpoint
    dynamodb = boto3.resource('dynamodb', region_name=resource.region_name)
    tables = {'engineering': create_pk_sk_table(ENGINEERING_TABLE, dynamodb),
              'agents': create_pk_sk_table(AGENTS_TABLE, dynamodb)}
    cognito, pool = _UserPool(), _UserPool.POOL
    # The memory's erasure writes typed values, through a low-level client of its own (the handler's).
    client = boto3.client('dynamodb', region_name=resource.region_name)
    with patch.object(handler, 'ENGINEERING_TABLE', ENGINEERING_TABLE), \
            patch.object(handler, 'AGENTS_TABLE', AGENTS_TABLE), patch.object(handler, 'USER_POOL_ID', pool), \
            patch.object(handler, 'get_cognito_idp_client', return_value=cognito), \
            patch.object(handler, 'get_dynamodb_client', return_value=client):
        yield {**tables, 'cognito': cognito, 'pool': pool, 'client': client}


def _account(engineering: Mapping[str, Any], email: str, *, verified: bool = True, username: str | None = None) -> str:
    """A signed-in user of the deployment with ``email`` stored as given (the users API stores it as typed); their
    ``sub``."""
    attributes = [{'Name': 'email', 'Value': email}, {'Name': 'email_verified', 'Value': str(verified).lower()}]
    user = engineering['cognito'].admin_create_user(UserPoolId=engineering['pool'],
                                                    Username=username or email.split('@', 1)[0].lower(),
                                                    UserAttributes=attributes, MessageAction='SUPPRESS')['User']
    return next(a['Value'] for a in user['Attributes'] if a['Name'] == 'sub')


def _erase(aws, context, value: str = ADDRESS, job_id: str = JOB_ID) -> dict[str, Any]:
    """The participants' erasure by email (its job row and invoke), of this module's address by default."""
    return erase_by_email(aws, context, value, job_id)


# ── The lineage pass ──────────────────────────────────────────────────────────────────────────────────────────────

def _run_row(engineering: Mapping[str, Any], run_id: str, started: int, ids: list[str] | None) -> None:
    """An engineering run's ``META`` and its runs-list row, keyed as runtime/runs.py keys them."""
    table = engineering['engineering']
    meta: dict[str, Any] = {**engineering_runs.meta_key(run_id), 'run_id': run_id, 'status': 'done', 'goal': 'Fix it',
                            'msg_seq': 7}
    if ids is not None:
        meta['feedback'] = {'ids': ids, 'count': len(ids) + 3, 'category': 'billing'}
    table.put_item(Item=meta)
    table.put_item(Item={**engineering_runs.runlist_key(run_id, started), 'kind': 'run_list', 'run_id': run_id,
                         'status': 'done'})


def _claim(engineering: Mapping[str, Any], number: int, feedback_id: str, stage: str = 'act') -> dict[str, str]:
    item = agents_store.issue_claim_item(REPO, number, agent_id='agent_bugfixer', run_id='run_x',
                                         engineering_run_id=RUN_ERASED, feedback_id=feedback_id,
                                         now=datetime(2026, 11, 20, tzinfo=UTC), stage=stage)
    engineering['agents'].put_item(Item=item)
    return {'pk': item['pk'], 'sk': item['sk']}


def _seed_runs(aws, engineering: Mapping[str, Any]) -> None:
    """Two reviews of the address (one cited by a run, one by an issue's claims), one review kept."""
    put_feedback(aws, 'fb_erased', metadata={'email': ADDRESS})
    put_feedback(aws, 'fb_issue', metadata={'email': ADDRESS})
    put_feedback(aws, 'fb_kept', metadata={'email': OTHER_ADDRESS})
    _run_row(engineering, RUN_ERASED, NOVEMBER, ['fb_erased', 'fb_kept'])
    _run_row(engineering, RUN_KEPT, NOVEMBER, ['fb_kept'])
    _run_row(engineering, RUN_DECEMBER, DECEMBER, None)


def _meta(engineering: Mapping[str, Any], run_id: str) -> dict[str, Any]:
    return engineering['engineering'].get_item(Key=engineering_runs.meta_key(run_id))['Item']


def _walker(aws, engineering: Mapping[str, Any], now: datetime = datetime(2026, 11, 26, tzinfo=UTC),
            ) -> tuple[dict[str, Any], engineering_lineage.EngineeringLineage]:
    """A deployment erasure's run that deleted from ``web``, and its walk of the engineering rows."""
    run = {**runs.new_run({}, 'erase'), 'job_id': JOB_ID, 'erased_sources': ['web']}
    tables = {'aggregates': aws['aggregates'], 'engineering': engineering['engineering'],
              'agents': engineering['agents']}
    return run, engineering_lineage.EngineeringLineage(run, tables, lambda: now)


RUN_OLD: Final = '01JD0000000000000000000004'


def _erased_before(aws, source: str, feedback_id: str) -> None:
    """An erasure before 7.84.00 deleted ``feedback_id`` of ``source``: its tombstone, and its run's audit row naming the
    source, stay (both kept for good)."""
    aws['aggregates'].put_item(Item={'pk': f'AUDIT#tombstone#{source}', 'sk': feedback_id, 'source': source})
    aws['aggregates'].put_item(Item={'pk': runs.AUDIT_PK, 'sk': '2026-11-20T09:00:00+00:00#0123456789ab',
                                     'mode': 'erase', 'status': 'completed', 'erased_sources': [source]})


class TestTheLineagePassReachesTheEngineeringRuns:
    def test_an_erased_id_leaves_a_run_meta_and_is_marked(self, aws, engineering, worker_context):
        _seed_runs(aws, engineering)

        assert _erase(aws, worker_context)['status'] == 'completed'

        meta = _meta(engineering, RUN_ERASED)
        assert meta['feedback'] == {'ids': ['fb_kept'], 'count': 5, 'category': 'billing'}
        assert meta['erased_evidence']['count'] == 1
        assert (meta['erased_evidence']['job_id'], meta['erased_evidence']['mode']) == (JOB_ID, 'erase')
        # The board's and the router's counters on META are left as they were.
        assert (meta['msg_seq'], meta['status']) == (7, 'done')

    def test_an_erased_id_leaves_each_issue_claim_that_names_it(self, aws, engineering, worker_context):
        _seed_runs(aws, engineering)
        act, triage = _claim(engineering, 12, 'fb_issue'), _claim(engineering, 12, 'fb_issue', 'triage')
        kept = _claim(engineering, 13, 'fb_kept')

        _erase(aws, worker_context)

        for key in (act, triage):
            claim = engineering['agents'].get_item(Key=key)['Item']
            assert 'feedback_id' not in claim
            assert claim['erased_evidence']['count'] == 1
            # The claim still says the issue started its run: it starts none again.
            assert (claim['agent_run_id'], claim['engineering_run_id']) == ('run_x', RUN_ERASED)
        assert agents_store.issue_claimed(engineering['agents'], REPO, 12)
        assert engineering['agents'].get_item(Key=kept)['Item']['feedback_id'] == 'fb_kept'
        assert 'erased_evidence' not in engineering['agents'].get_item(Key=kept)['Item']
        job, audit = erasure_rows(aws, JOB_ID)
        assert (job[ENGINEERING_MARK_COUNTER], audit[ENGINEERING_MARK_COUNTER]) == (3, 3)

    def test_other_runs_are_left_untouched(self, aws, engineering, worker_context):
        _seed_runs(aws, engineering)
        before = {run_id: _meta(engineering, run_id) for run_id in (RUN_KEPT, RUN_DECEMBER)}

        _erase(aws, worker_context)

        assert {run_id: _meta(engineering, run_id) for run_id in (RUN_KEPT, RUN_DECEMBER)} == before

    def test_a_rerun_of_an_erasure_made_before_7_84_reaches_the_ids_it_left(self, aws, engineering, worker_context):
        """The rerun deletes nothing (the review went with the first run), and still removes its id: a deployment
        erasure checks the cited ids against every source a run ever deleted from (its audit rows)."""
        _run_row(engineering, RUN_OLD, NOVEMBER, ['fb_old', 'fb_kept'])
        claim = _claim(engineering, 14, 'fb_old')
        _erased_before(aws, 'app_reviews', 'fb_old')

        result = _erase(aws, worker_context, 'nobody@example.com')

        assert (result['status'], result['deleted_items']) == ('completed', 0)
        assert _meta(engineering, RUN_OLD)['feedback']['ids'] == ['fb_kept']
        assert 'feedback_id' not in engineering['agents'].get_item(Key=claim)['Item']

    def test_a_retention_window_that_deletes_nothing_does_not_walk_them(self, aws, engineering, worker_context):
        from jobs.retention.test.test_handler import _profiles
        _profiles(aws, {'id': 'web', 'retention_days': 30})
        _run_row(engineering, RUN_OLD, NOVEMBER, ['fb_old'])
        _erased_before(aws, 'web', 'fb_old')

        with recorded_calls(aws, engineering['client']) as calls:
            assert handler.handle_event({'mode': 'retention'}, worker_context)['status'] == 'completed'

        assert [call for call in calls if call[1] in (ENGINEERING_TABLE, AGENTS_TABLE)] == []
        assert _meta(engineering, RUN_OLD)['feedback']['ids'] == ['fb_old']

    def test_the_runs_are_found_by_their_list_and_the_claims_by_their_partition_never_a_scan(
            self, aws, engineering, worker_context):
        _seed_runs(aws, engineering)
        _claim(engineering, 12, 'fb_issue')

        with recorded_calls(aws, engineering['client']) as calls:
            _erase(aws, worker_context)

        on_engineering = [(action, keys[0] if keys else '') for action, table, keys in calls
                          if table in (ENGINEERING_TABLE, AGENTS_TABLE)]
        assert not any(action == 'Scan' for action, _key in on_engineering)
        queried = {key for action, key in on_engineering if action == 'Query'}
        assert {'ISSUE_RUN#default', 'WS#default#RUNLIST#2026-11', f'WS#default#RUN#{RUN_ERASED}',
                f'WS#default#RUN#{RUN_KEPT}'} <= queried

    def test_a_run_changed_since_it_was_read_is_read_again_and_marked(self, aws, engineering):
        _seed_runs(aws, engineering)
        aws['aggregates'].put_item(Item={'pk': 'AUDIT#tombstone#web', 'sk': 'fb_erased'})
        run, walker = _walker(aws, engineering)
        cursor = walker.step(None)                       # the claims (none)
        real_query = engineering['engineering'].query

        def raced(**request: Any) -> dict[str, Any]:
            page = real_query(**request)
            if request['ExpressionAttributeValues'].get(':pk') == f'WS#default#RUN#{RUN_ERASED}':
                # Another writer of feedback lands between the read and the mark.
                engineering['engineering'].update_item(Key=engineering_runs.meta_key(RUN_ERASED),
                                                       UpdateExpression='SET feedback.#c = :c',
                                                       ExpressionAttributeNames={'#c': 'category'},
                                                       ExpressionAttributeValues={':c': 'refunds'})
            return page

        with patch.object(engineering['engineering'], 'query', side_effect=raced):
            walker.step(cursor)

        assert _meta(engineering, RUN_ERASED)['feedback'] == {'ids': ['fb_kept'], 'count': 5, 'category': 'refunds'}
        assert run[ENGINEERING_MARK_COUNTER] == 1

    @pytest.mark.parametrize('which', ['run', 'claim'])
    def test_a_row_that_keeps_changing_fails_the_job_naming_its_run(self, aws, engineering, which):
        _seed_runs(aws, engineering)
        _claim(engineering, 12, 'fb_issue')
        aws['aggregates'].put_item(Item={'pk': 'AUDIT#tombstone#web', 'sk': 'fb_erased'})
        aws['aggregates'].put_item(Item={'pk': 'AUDIT#tombstone#web', 'sk': 'fb_issue'})
        _run, walker = _walker(aws, engineering)
        table = engineering['engineering' if which == 'run' else 'agents']
        changed = ClientError({'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'changed'}},
                              'UpdateItem')
        cursor = None if which == 'claim' else walker.step(None)
        with patch.object(table, 'update_item', side_effect=changed) as updates, \
                pytest.raises(engineering_lineage.EngineeringRowKeptChanging, match=RUN_ERASED):
            walker.step(cursor)
        assert updates.call_count == engineering_lineage.MAX_TRIES

    def test_the_walk_reads_each_month_from_the_first_to_the_clock_s(self, aws, engineering):
        _seed_runs(aws, engineering)
        aws['aggregates'].put_item(Item={'pk': 'AUDIT#tombstone#web', 'sk': 'fb_kept'})
        run, walker = _walker(aws, engineering, datetime(2027, 1, 3, tzinfo=UTC))
        months, cursor = [], walker.step(None)
        for _step in range(20):
            if cursor is None:
                break
            months.append(cursor.get('month'))
            cursor = walker.step(cursor)
        assert cursor is None
        assert [m for m in dict.fromkeys(months) if m] == ['2026-11', '2026-12', '2027-01']
        assert _meta(engineering, RUN_KEPT)['feedback']['ids'] == []
        assert run[ENGINEERING_MARK_COUNTER] == 2

    @pytest.mark.parametrize('cursor', [{'part': 'runs', 'month': '2026-13', 'start': None},
                                        {'part': 'runs', 'month': '2026-10', 'start': None},
                                        {'part': 'nowhere'}, {'part': 'claims', 'start': 'not a key'}])
    def test_a_carried_cursor_of_the_wrong_shape_fails_the_job(self, aws, engineering, cursor):
        tables = {'aggregates': aws['aggregates'], 'engineering': engineering['engineering'],
                  'agents': engineering['agents']}
        walker = engineering_lineage.EngineeringLineage({**runs.new_run({}, 'erase'), 'erased_sources': ['web']},
                                                        tables, lambda: datetime(2026, 11, 26, tzinfo=UTC))
        with pytest.raises(ValueError, match='a carried'):
            walker.step(cursor)

    def test_a_workspace_s_own_erasure_never_reads_the_engineering_rows(self, aws, engineering, worker_context):
        """The engineering agents cite the deployment's feedback only (D8): a workspace's item is never theirs."""
        from jobs.retention.test.test_named_workspace_erasure import _job
        _seed_runs(aws, engineering)
        put_workspace_feedback(aws, WS, 'fb_erased', metadata={'email': ADDRESS})

        with recorded_calls(aws, engineering['client']) as calls:
            result = handler.handle_event(_job(aws, 'email', ADDRESS), worker_context)

        assert result['status'] == 'completed'
        assert [call for call in calls if call[1] in (ENGINEERING_TABLE, AGENTS_TABLE)] == []

    def test_a_workspace_s_tombstone_never_removes_a_deployment_run_s_id(self, aws, engineering, worker_context):
        """The same id erased in a workspace (its tombstone ``{ws}#{id}``) is another review: the run keeps it (D8)."""
        _seed_runs(aws, engineering)
        aws['feedback'].delete_item(Key={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#fb_erased'})
        aws['feedback'].delete_item(Key={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#fb_issue'})
        put_workspace_feedback(aws, WS, 'fb_erased', metadata={'email': ADDRESS})

        _erase(aws, worker_context)

        assert aws['aggregates'].get_item(Key={'pk': 'AUDIT#tombstone#web', 'sk': f'{WS}#fb_erased'}).get('Item')
        assert _meta(engineering, RUN_ERASED)['feedback']['ids'] == ['fb_erased', 'fb_kept']


class TestWithoutTheEngineeringTables:
    def test_neither_phase_runs_and_nothing_engineering_is_read(self, aws, worker_context):
        put_feedback(aws, 'fb_erased', metadata={'email': ADDRESS})
        walk = handler.Walk(handler._tables(), worker_context, {}, {**runs.new_run({}, 'erase'), 'field': 'email'},
                            _no_filter, None, lambda: True)

        assert handler.PHASE_ENGINEERING_LINEAGE not in handler._phases(walk)
        assert handler.PHASE_AGENT_MEMORY not in handler._phases(walk)
        with recorded_calls(aws) as calls:
            assert _erase(aws, worker_context)['status'] == 'completed'
        assert [call for call in calls if 'engineering' in call[1] or 'agents' in call[1]] == []

    @pytest.mark.usefixtures('engineering')
    def test_the_phases_are_walked_with_the_tables(self, worker_context):
        walk = handler.Walk(handler._tables(), worker_context, {}, {**runs.new_run({}, 'erase'), 'field': 'email'},
                            _no_filter, None, lambda: True)
        phases = handler._phases(walk)
        # The memory after the memberships and the projects (the deployment's people phases), before the raw sweep
        # and the lineage marks; the engineering marks right after the deployment's own.
        assert phases.index(handler.PHASE_MEMBERS) < phases.index(handler.PHASE_AGENT_MEMORY) \
            < phases.index(handler.PHASE_LINEAGE)
        assert phases.index(handler.PHASE_ENGINEERING_LINEAGE) == phases.index(handler.PHASE_LINEAGE) + 1

    @pytest.mark.usefixtures('engineering')
    def test_a_workspace_job_walks_neither(self, worker_context):
        run = {**runs.new_run({}, 'erase'), 'field': 'email', 'workspace_id': WS}
        walk = handler.Walk(handler._tables(), worker_context, {}, run, _no_filter, None, lambda: True)
        phases = handler._phases(walk)
        assert handler.PHASE_ENGINEERING_LINEAGE not in phases
        assert handler.PHASE_AGENT_MEMORY not in phases


# ── The agents' memory ────────────────────────────────────────────────────────────────────────────────────────────

AGENT: Final = Actor('fixer-0', 'agent', connection=CONN)
RUN_MEMO: Final = '01JD0000000000000000000009'


def _memory_store(engineering: Mapping[str, Any], people: set[str]) -> AgentMemoryStore:
    return AgentMemoryStore(engineering['client'], ENGINEERING_TABLE, is_user=people.__contains__)


def _seed_memories(engineering: Mapping[str, Any]) -> tuple[str, str]:
    """Dana (the address's account) and Oscar, each with a memory of their own; Dana also confirmed a repository
    memory (a row naming her in another scope). Their subs."""
    dana, oscar = _account(engineering, ADDRESS), _account(engineering, OTHER_ADDRESS)
    store = _memory_store(engineering, {dana, oscar})
    for person in (dana, oscar):
        store.write_agent_memory(ENGINEERING_WORKSPACE, Scope('person', person=person),
                                 MemoryInput('pull request size', 'preference', 'Keep my pull requests small.',
                                             Provenance(person=person)),
                                 by=Actor(person, 'person'), review_texts=())
    learned = store.learn_agent_memory(
        ENGINEERING_WORKSPACE, Scope('repository', CONN),
        MemoryInput('merge style', 'convention', 'Squash merges only.', Provenance(run_id=RUN_MEMO), 0.9),
        run=RunContext(AGENT, RUN_MEMO, 'fixer'), review_texts=())
    repository = Scope('repository', CONN)
    store.confirm_agent_memory(ENGINEERING_WORKSPACE, repository, learned.memory.memory_id, by=Actor(dana, 'person'))
    store.edit_agent_memory(ENGINEERING_WORKSPACE, repository, learned.memory.memory_id, base_version=1,
                            by=Actor(dana, 'person'), review_texts=(), statement='Squash merges, release branches too.')
    return dana, oscar


def _rows(engineering: Mapping[str, Any], pk: str) -> list[dict[str, Any]]:
    return engineering['engineering'].query(KeyConditionExpression=Key('pk').eq(pk))['Items']


def _saved(aws) -> dict[str, Any] | None:
    return aws['aggregates'].get_item(Key={'pk': ERASURE_JOB_PK, 'sk': f'AGENT_MEMORY#{sha256_hex(ADDRESS)}'},
                                      ConsistentRead=True).get('Item')


class TestAnErasureByEmailReachesTheAgentsMemory:
    def test_the_address_s_person_is_erased_and_no_one_else(self, aws, engineering, worker_context):
        dana, oscar = _seed_memories(engineering)

        assert _erase(aws, worker_context)['status'] == 'completed'

        assert _rows(engineering, memory_erasure.person_partition(ENGINEERING_WORKSPACE, dana)) == []
        assert _rows(engineering, memory_erasure.person_partition(ENGINEERING_WORKSPACE, oscar)) != []
        assert dana not in json.dumps(engineering['engineering'].scan()['Items'], default=str)
        job, audit = erasure_rows(aws, JOB_ID)
        assert (job[AGENT_MEMORY_COUNTER], audit[AGENT_MEMORY_COUNTER]) == (1, 1)

    def test_its_tombstone_and_delete_record_say_the_job_s_legal_basis(self, aws, engineering, worker_context):
        dana, _oscar = _seed_memories(engineering)

        _erase(aws, worker_context)

        [stone] = _rows(engineering, memory_erasure.TOMBSTONE_PK)
        assert stone['sk'] == sha256_hex(dana)
        assert stone['legal_basis'] == BASIS
        assert stone['actor'] == {'sub': 'sub-admin', 'kind': 'erasure', 'job_id': JOB_ID}
        [record] = _rows(engineering, AUDIT_PK)
        assert (record['kind'], record['reason'], record['target']['person_hash']) == (
            memory_erasure.ERASED_KIND, BASIS, sha256_hex(dana))
        for row in (stone, record):
            assert ADDRESS not in json.dumps(row, default=str)
            assert dana not in json.dumps(row, default=str)

    def test_the_erased_person_is_never_remembered_again(self, aws, engineering, worker_context):
        dana, _oscar = _seed_memories(engineering)

        _erase(aws, worker_context)

        store = _memory_store(engineering, {dana})
        with pytest.raises(Exception, match='signed-in user'):
            store.write_agent_memory(ENGINEERING_WORKSPACE, Scope('person', person=dana),
                                     MemoryInput('size', 'preference', 'Small pull requests.', Provenance(person=dana)),
                                     by=Actor(dana, 'person'), review_texts=())

    def test_the_saved_row_is_emptied_and_expires_once_done(self, aws, engineering, worker_context):
        _seed_memories(engineering)

        _erase(aws, worker_context)

        saved = _saved(aws)
        assert saved is not None
        assert agent_memory.SAVED_PEOPLE not in saved
        now = int(datetime.now(UTC).timestamp())
        assert now < int(saved['ttl']) <= now + int(agent_memory.EMPTIED_FOR.total_seconds()) + 60
        assert ADDRESS not in json.dumps(saved, default=str)

    def test_a_hand_over_after_the_lookup_erases_the_carried_person_even_once_the_account_is_gone(
            self, aws, engineering):
        dana, _oscar = _seed_memories(engineering)
        run = {**runs.new_run({}, 'erase'), 'field': 'email', 'job_id': JOB_ID, 'legal_basis': BASIS,
               'started_by_sub': 'sub-admin'}
        tables = {'aggregates': aws['aggregates'], 'engineering': engineering['engineering']}
        directory = agent_memory.cognito_directory(engineering['cognito'], engineering['pool'])
        cursor = agent_memory.AgentMemoryEraser(run, tables, ADDRESS, directory,
                                                client=engineering['client']).step(None)
        assert cursor is not None
        assert cursor['pending'] == [dana]
        engineering['cognito'].admin_delete_user(UserPoolId=engineering['pool'], Username='dana.reviewer')

        # The next invocation (a hand-over) carries only the cursor and the run.
        carried = runs.new_run({'run': runs.carried_state(run)}, 'erase')
        carried.update(field='email', job_id=JOB_ID, legal_basis=BASIS, started_by_sub='sub-admin')
        eraser = agent_memory.AgentMemoryEraser(carried, tables, ADDRESS, directory, client=engineering['client'])
        for _step in range(5):
            cursor = eraser.step(json.loads(json.dumps(cursor)))
            if cursor is None:
                break
        assert cursor is None
        assert _rows(engineering, memory_erasure.person_partition(ENGINEERING_WORKSPACE, dana)) == []
        assert len(_rows(engineering, memory_erasure.TOMBSTONE_PK)) == 1

    def test_a_failed_job_s_saved_person_is_erased_by_the_next_erasure_of_the_address(
            self, aws, engineering, worker_context):
        dana, _oscar = _seed_memories(engineering)
        throttled = RuntimeError('cut')
        with patch.object(memory_erasure, 'whole_partition', side_effect=throttled):
            assert _erase(aws, worker_context)['status'] == 'failed'
        saved = _saved(aws)
        assert saved is not None
        assert saved[agent_memory.SAVED_PEOPLE] == {dana}
        engineering['cognito'].admin_delete_user(UserPoolId=engineering['pool'], Username='dana.reviewer')

        assert _erase(aws, worker_context, job_id=SECOND_JOB)['status'] == 'completed'

        assert _rows(engineering, memory_erasure.person_partition(ENGINEERING_WORKSPACE, dana)) == []
        emptied = _saved(aws)
        assert emptied is not None
        assert agent_memory.SAVED_PEOPLE not in emptied

    def test_a_rerun_after_a_completed_erasure_keeps_the_first_tombstone(self, aws, engineering, worker_context):
        _seed_memories(engineering)
        _erase(aws, worker_context)
        [first] = _rows(engineering, memory_erasure.TOMBSTONE_PK)

        _erase(aws, worker_context, job_id=SECOND_JOB)

        assert _rows(engineering, memory_erasure.TOMBSTONE_PK) == [first]

    def test_an_unverified_address_is_not_taken_for_its_account(self, aws, engineering, worker_context):
        """Only a verified address is the account's sign-in alias (unique in the pool): an account found by its
        username that holds the address unverified could be anyone's typing, so nothing of it is erased, and the job
        says so (``agent_memory_complete: false``)."""
        sub = _account(engineering, ADDRESS, verified=False, username=ADDRESS)

        _erase(aws, worker_context)

        assert _rows(engineering, memory_erasure.TOMBSTONE_PK) == []
        job, audit = erasure_rows(aws, JOB_ID)
        assert job[AGENT_MEMORY_NOT_ERASED_COUNTER] == 1
        assert AGENT_MEMORY_COUNTER not in job
        assert (job[runs.AGENT_MEMORY_COMPLETE], audit[runs.AGENT_MEMORY_COMPLETE]) == (False, False)
        assert sub not in json.dumps(job, default=str)

    @pytest.mark.parametrize('typed', ['  Dana.Reviewer@Example.COM ', 'dana.reviewer@example.com',
                                       'DANA.REVIEWER@EXAMPLE.COM'])
    def test_an_address_stored_in_another_spelling_is_found(self, aws, engineering, worker_context, typed):
        """The users API stores an address as it was typed: the pool resolves its alias whatever the case."""
        dana = _account(engineering, 'Dana.Reviewer@Example.com')
        _memory_store(engineering, {dana}).write_agent_memory(
            ENGINEERING_WORKSPACE, Scope('person', person=dana),
            MemoryInput('size', 'preference', 'Small pull requests.', Provenance(person=dana)),
            by=Actor(dana, 'person'), review_texts=())

        _erase(aws, worker_context, typed)

        assert _rows(engineering, memory_erasure.person_partition(ENGINEERING_WORKSPACE, dana)) == []
        job, _audit = erasure_rows(aws, JOB_ID)
        assert (job[AGENT_MEMORY_COUNTER], job[runs.AGENT_MEMORY_COMPLETE]) == (1, True)

    def test_a_pool_made_before_case_insensitive_sign_in_matches_the_typed_or_lower_cased_spelling_only(
            self, engineering):
        """A pool deployed before #105 (``omitUserPoolUsernameConfiguration``) matches aliases exactly: the job asks
        for the address as typed and lower-cased, and a third spelling stored is not found (the documented gap: erase
        again with the stored spelling)."""
        pool = _UserPool(case_sensitive=True)
        engineering_with_old_pool = {**engineering, 'cognito': pool}
        _account(engineering_with_old_pool, 'Dana.Reviewer@Example.com')
        directory = agent_memory.cognito_directory(pool, _UserPool.POOL)

        assert directory('Dana.Reviewer@Example.com') != []
        assert directory('dana.reviewer@example.com') == []

    def test_an_account_the_memory_never_held_is_refused_and_no_delete_record_is_written(
            self, aws, engineering, worker_context):
        """The tombstone stays a lasting refusal (the memory never learns the person later); with no row of theirs
        there is nothing to record as deleted."""
        sub = _account(engineering, ADDRESS)

        _erase(aws, worker_context)

        [stone] = _rows(engineering, memory_erasure.TOMBSTONE_PK)
        assert stone['sk'] == sha256_hex(sub)
        assert _rows(engineering, AUDIT_PK) == []
        job, audit = erasure_rows(aws, JOB_ID)
        assert (job[AGENT_MEMORY_REFUSED_COUNTER], audit[AGENT_MEMORY_REFUSED_COUNTER]) == (1, 1)
        assert AGENT_MEMORY_COUNTER not in job
        assert (job[runs.AGENT_MEMORY_WALKED], job[runs.AGENT_MEMORY_COMPLETE]) == (True, True)

    def test_the_job_and_audit_rows_say_the_memory_was_walked_and_complete(self, aws, engineering, worker_context):
        _seed_memories(engineering)

        _erase(aws, worker_context)

        job, audit = erasure_rows(aws, JOB_ID)
        for row in (job, audit):
            assert (row[runs.AGENT_MEMORY_WALKED], row[runs.AGENT_MEMORY_COMPLETE]) == (True, True)

    def test_a_failed_job_s_rows_say_the_memory_was_not_walked(self, aws, engineering, worker_context):
        _seed_memories(engineering)
        with patch.object(memory_erasure, 'whole_partition', side_effect=RuntimeError('cut')):
            _erase(aws, worker_context)

        job, _audit = erasure_rows(aws, JOB_ID)
        assert (job[runs.AGENT_MEMORY_WALKED], job[runs.AGENT_MEMORY_COMPLETE]) == (False, False)

    def test_an_erasure_without_the_memory_phase_says_nothing_of_it(self, aws, worker_context):
        put_feedback(aws, 'fb_one', metadata={'email': ADDRESS})

        _erase(aws, worker_context)

        job, audit = erasure_rows(aws, JOB_ID)
        assert runs.AGENT_MEMORY_WALKED not in job
        assert runs.AGENT_MEMORY_COMPLETE not in audit

    def test_the_erasure_job_view_shows_whether_the_memory_was_walked_and_complete(self):
        from api import settings_handler
        assert {runs.AGENT_MEMORY_WALKED, runs.AGENT_MEMORY_COMPLETE} <= set(settings_handler.ERASURE_VIEW_FIELDS)

    def test_a_directory_failure_other_than_no_such_user_fails_the_job(self, engineering):
        class Down:
            def admin_get_user(self, **_request: Any) -> dict[str, Any]:
                raise ClientError({'Error': {'Code': 'TooManyRequestsException', 'Message': 'slow'}}, 'AdminGetUser')

        with pytest.raises(ClientError):
            agent_memory.cognito_directory(Down(), engineering['pool'])(ADDRESS)

    @pytest.mark.parametrize('value', ['not an address', '', '   '])
    def test_an_address_no_account_can_hold_reads_nothing(self, aws, engineering, value):
        calls: list[Any] = []
        directory = agent_memory.cognito_directory(_Spy(engineering['cognito'], calls), engineering['pool'])
        run = {**runs.new_run({}, 'erase'), 'field': 'email', 'job_id': JOB_ID, 'legal_basis': BASIS}
        eraser = agent_memory.AgentMemoryEraser(run, {'aggregates': aws['aggregates'],
                                                      'engineering': engineering['engineering']}, value, directory,
                                                client=engineering['client'])
        assert eraser.step(None) is None
        assert calls == []

    def test_a_carried_person_of_the_wrong_shape_fails_the_job(self, aws, engineering):
        run = {**runs.new_run({}, 'erase'), 'field': 'email', 'job_id': JOB_ID, 'legal_basis': BASIS}
        eraser = agent_memory.AgentMemoryEraser(run, {'aggregates': aws['aggregates'],
                                                      'engineering': engineering['engineering']}, ADDRESS,
                                                lambda _address: [], client=engineering['client'])
        for pending in (['WS#default#AMEM#PERSON#x'], 'not a list', ['sub'] * (agent_memory.MAX_SAVED + 1)):
            with pytest.raises(ValueError, match='a carried agent memory person'):
                eraser.step({'pending': pending, 'resolved': True})

    def test_a_workspace_s_own_erasure_never_reaches_the_agents_memory(self, aws, engineering, worker_context):
        from jobs.retention.test.test_named_workspace_erasure import _job
        dana, _oscar = _seed_memories(engineering)

        handler.handle_event(_job(aws, 'email', ADDRESS), worker_context)

        assert _rows(engineering, memory_erasure.person_partition(ENGINEERING_WORKSPACE, dana)) != []

    def test_an_erasure_by_another_field_or_of_one_source_never_reaches_it(self, aws, engineering, worker_context):
        dana, _oscar = _seed_memories(engineering)
        put_feedback(aws, 'fb_one', metadata={'email': ADDRESS}, author='Dana')

        handler.handle_event(erasure_job(aws, JOB_ID, 'author', 'Dana', source='web', legal_basis=BASIS),
                             worker_context)
        handler.handle_event(erasure_job(aws, SECOND_JOB, 'email', ADDRESS, source='web', legal_basis=BASIS),
                             worker_context)

        assert _rows(engineering, memory_erasure.person_partition(ENGINEERING_WORKSPACE, dana)) != []


class _Spy:
    """A Cognito client that records each call."""

    def __init__(self, client: Any, calls: list[Any]) -> None:
        self._client, self._calls = client, calls

    def admin_get_user(self, **request: Any) -> dict[str, Any]:
        self._calls.append(request)
        return self._client.admin_get_user(**request)


class TestTheDirectoryLookup:
    def test_one_admin_get_user_by_the_address_finds_its_account(self, engineering):
        dana = _account(engineering, 'Dana.Reviewer@Example.com')
        _account(engineering, OTHER_ADDRESS)
        calls: list[Any] = []
        directory = agent_memory.cognito_directory(_Spy(engineering['cognito'], calls), engineering['pool'])

        found = directory('dana.reviewer@EXAMPLE.com')

        assert [(account.sub, account.email, account.verified) for account in found] == [
            (dana, 'Dana.Reviewer@Example.com', True)]
        assert calls == [{'UserPoolId': engineering['pool'], 'Username': 'dana.reviewer@EXAMPLE.com'}]

    def test_an_address_no_account_holds_asks_twice_at_most_and_finds_none(self, engineering):
        calls: list[Any] = []
        directory = agent_memory.cognito_directory(_Spy(engineering['cognito'], calls), engineering['pool'])

        assert directory('Nobody@example.com') == []
        assert [call['Username'] for call in calls] == ['Nobody@example.com', 'nobody@example.com']


def test_the_memory_s_person_key_is_the_cognito_sub_a_request_signs_in_with():
    """The engineering stores' person (an ``Actor`` of kind ``person``) is built from the caller's ``subject``, the
    token's ``sub`` claim, so a memory's person partition is ``WS#default#AMEM#PERSON#<sub>``: the key the erasure
    resolves the address to."""
    from shared.agents_engineering_knowledge_routes import _person
    from shared.project_access import caller_from_claims
    sub = '3f2a6c1e-0b7d-4c55-9a51-2d3e4f5a6b7c'

    actor = _person(caller_from_claims({'sub': sub, 'cognito:username': 'dana'}, ['admins']))

    assert (actor.id, actor.kind) == (sub, 'person')
    assert memory_erasure.person_partition(ENGINEERING_WORKSPACE, actor.id) == f'WS#default#AMEM#PERSON#{sub}'
    source = (Path(__file__).resolve().parents[3] / 'api' / 'agents_handler.py').read_text(encoding='utf-8')
    assert "Actor(caller.subject, 'person'" in source


# ── Bounds ────────────────────────────────────────────────────────────────────────────────────────────────────────

class TestTheBounds:
    def _audit_rows(self, aws, n: int) -> None:
        for i in range(n):
            aws['aggregates'].put_item(Item={'pk': runs.AUDIT_PK, 'sk': f'2026-11-20T00:00:{i:02d}#run{i}',
                                             'erased_sources': [f'source{i}']})

    def test_the_audit_rows_are_read_up_to_their_cap_and_one_more_fails_the_job(self, aws):
        self._audit_rows(aws, 3)
        with patch.object(engineering_lineage, 'MAX_AUDIT_ROWS', 3):
            assert engineering_lineage.audited_sources(aws['aggregates']) == ['source0', 'source1', 'source2']
        self._audit_rows(aws, 4)
        with patch.object(engineering_lineage, 'MAX_AUDIT_ROWS', 3), pytest.raises(RuntimeError, match='more runs'):
            engineering_lineage.audited_sources(aws['aggregates'])

    def test_the_claims_are_paged_past_a_page_from_the_key_the_last_page_ended_at(self, aws, engineering):
        keys = [_claim(engineering, number, 'fb_issue') for number in range(1, 6)]
        aws['aggregates'].put_item(Item={'pk': 'AUDIT#tombstone#web', 'sk': 'fb_issue'})
        _run, walker = _walker(aws, engineering)
        with patch.object(engineering_lineage, 'PAGE_SIZE', 2):
            cursor = walker.step(None)
            assert cursor is not None
            assert (cursor['part'], set(cursor['start'])) == ('claims', {'pk', 'sk'})
            for _step in range(5):
                if cursor is None or cursor['part'] != 'claims':
                    break
                cursor = walker.step(json.loads(json.dumps(cursor)))
        assert cursor == {'part': 'runs', 'month': engineering_lineage.FIRST_MONTH, 'start': None, 'sources': ['web']}
        assert ['feedback_id' in engineering['agents'].get_item(Key=key)['Item'] for key in keys] == [False] * 5

    def test_the_audited_sources_are_read_once_and_carried_across_a_hand_over(self, aws, engineering):
        _claim(engineering, 1, 'fb_old')
        _erased_before(aws, 'app_reviews', 'fb_old')
        december = datetime(2026, 12, 5, tzinfo=UTC)
        _run, walker = _walker(aws, engineering, december)
        with patch.object(engineering_lineage, 'audited_sources', wraps=engineering_lineage.audited_sources) as read:
            cursor = walker.step(None)
            assert cursor is not None
            assert cursor['sources'] == ['app_reviews', 'web']
            # The next invocation: a new walk, the cursor carried through the hand-over's JSON.
            _run2, again = _walker(aws, engineering, december)
            nxt = again.step(json.loads(json.dumps(cursor)))
        assert read.call_count == 1
        assert nxt is not None
        assert nxt['sources'] == ['app_reviews', 'web']

    @pytest.mark.parametrize('sources', ['web', [1], ['bad\nsource'], ['s'] * (engineering_lineage.MAX_CARRIED_SOURCES + 1)])
    def test_carried_sources_of_the_wrong_shape_fail_the_job(self, aws, engineering, sources):
        _run, walker = _walker(aws, engineering)
        with pytest.raises(ValueError, match='a carried'):
            walker.step({'part': 'claims', 'start': None, 'sources': sources})

    def test_a_page_that_answers_with_its_own_start_key_fails_the_job(self, aws, engineering):
        _run, walker = _walker(aws, engineering)
        start = {'pk': 'ISSUE_RUN#default', 'sk': f'{REPO}#1'}
        with patch.object(engineering['agents'], 'query', return_value={'Items': [], 'LastEvaluatedKey': start}), \
                pytest.raises(engineering_lineage.StuckQuery):
            walker.step({'part': 'claims', 'start': start})

    def test_more_people_saved_for_an_address_than_an_erasure_carries_fails_the_job(self, aws, engineering):
        saved = {str(uuid.uuid4()) for _n in range(2)}
        aws['aggregates'].put_item(Item={'pk': ERASURE_JOB_PK, 'sk': f'AGENT_MEMORY#{sha256_hex(ADDRESS)}',
                                         agent_memory.SAVED_PEOPLE: saved})
        _account(engineering, ADDRESS)
        run = {**runs.new_run({}, 'erase'), 'field': 'email', 'job_id': JOB_ID, 'legal_basis': BASIS}
        eraser = agent_memory.AgentMemoryEraser(
            run, {'aggregates': aws['aggregates'], 'engineering': engineering['engineering']}, ADDRESS,
            agent_memory.cognito_directory(engineering['cognito'], engineering['pool']), client=engineering['client'])
        with patch.object(agent_memory, 'MAX_SAVED', 2), pytest.raises(RuntimeError, match='More people were saved'):
            eraser.step(None)
        with patch.object(agent_memory, 'MAX_SAVED', 3):
            cursor = eraser.step(None)
        assert cursor is not None
        assert len(cursor['pending']) == 3


# ── IAM: every call is one lib/stacks/retention-worker.ts grants ──────────────────────────────────────────────────

def _ts_list(source: str, name: str) -> list[str]:
    found = re.search(rf'const {name} = \[([^\]]*)\]', source)
    assert found is not None, name
    return re.findall(r"'([^']+)'", found.group(1))


def _engineering_grants() -> dict[tuple[str, str], list[str]]:
    """``(table, action)`` → the LeadingKeys patterns retention-worker.ts grants (with engineeringAgents)."""
    source = RETENTION_WORKER.read_text(encoding='utf-8')
    claims, runs_read = _ts_list(source, 'ISSUE_CLAIM_PARTITIONS'), _ts_list(source, 'ENGINEERING_RUN_READS')
    run_updates, memory = _ts_list(source, 'ENGINEERING_RUN_UPDATES'), _ts_list(source, 'AGENT_MEMORY_PARTITIONS')
    audit = _ts_list(source, 'AGENT_MEMORY_AUDIT_PARTITIONS')
    return {(AGENTS_TABLE, 'Query'): claims, (AGENTS_TABLE, 'UpdateItem'): claims,
            (ENGINEERING_TABLE, 'Query'): [*runs_read, *memory], (ENGINEERING_TABLE, 'UpdateItem'): [*run_updates,
                                                                                                    *memory],
            (ENGINEERING_TABLE, 'PutItem'): [*audit, *memory], (ENGINEERING_TABLE, 'DeleteItem'): memory}


def test_the_python_keys_and_attributes_are_the_grants():
    source = RETENTION_WORKER.read_text(encoding='utf-8')
    assert _ts_list(source, 'ISSUE_CLAIM_PARTITIONS') == [engineering_lineage.CLAIMS_PARTITION]
    assert _ts_list(source, 'ISSUE_CLAIM_ATTRIBUTES') == list(engineering_lineage.CLAIM_ATTRIBUTES)
    assert _ts_list(source, 'ENGINEERING_RUN_READS') == [f'{engineering_lineage.RUNLIST_PREFIX}*',
                                                         f'{engineering_lineage.RUN_PREFIX}*']
    assert _ts_list(source, 'ENGINEERING_RUN_UPDATES') == [f'{engineering_lineage.RUN_PREFIX}*']
    assert _ts_list(source, 'ENGINEERING_RUN_ATTRIBUTES') == list(engineering_lineage.RUN_ATTRIBUTES)
    assert _ts_list(source, 'AGENT_MEMORY_PARTITIONS') == [f'WS#{ENGINEERING_WORKSPACE}#AMEM#*']
    assert _ts_list(source, 'AGENT_MEMORY_AUDIT_PARTITIONS') == [memory_erasure.TOMBSTONE_PK, AUDIT_PK]
    assert _ts_list(source, 'AGENT_MEMORY_UPDATE_ATTRIBUTES') == ['pk', 'sk', *memory_erasure.PERSON_ATTRS]
    # A re-keyed confirmation row (erasure.py ``_deidentify``): the only item the memory's PutItem writes there.
    assert _ts_list(source, 'AGENT_MEMORY_CONFIRMATION_ATTRIBUTES') == list(memory_erasure.CONFIRMATION_ATTRIBUTES)


def test_the_engineering_keys_are_the_engineering_stores_own():
    """The retention bundle holds no runtime module: its keys are spelled again, and held to the runtime's here."""
    assert engineering_lineage.ENGINEERING_SCOPE == ENGINEERING_WORKSPACE
    assert engineering_lineage.CLAIMS_PARTITION == agents_store.ISSUE_RUN_PK
    assert engineering_lineage.RUNLIST_PREFIX == engineering_runs.RUNLIST_PREFIX
    assert f'{engineering_lineage.RUN_PREFIX}{RUN_ERASED}' == engineering_runs.run_pk(RUN_ERASED)
    assert memory_erasure.person_partition(ENGINEERING_WORKSPACE, 'p-1') == Scope('person', person='p-1').partition(
        ENGINEERING_WORKSPACE)


def test_the_handler_imports_from_its_bundle_alone(tmp_path):
    """The retention bundle holds ``jobs/retention``, ``shared/`` and, of the engineering tree,
    ``RETENTION_ENGINEERING_FILES`` only (retention-worker.ts): the handler imports from exactly that."""
    lambda_root = Path(__file__).resolve().parents[3]
    files = _ts_list(RETENTION_WORKER.read_text(encoding='utf-8'), 'RETENTION_ENGINEERING_FILES')
    assert 'engineering/agent_memory/erasure.py' in files
    ignore = shutil.ignore_patterns('test', '__pycache__')
    shutil.copytree(lambda_root / 'shared', tmp_path / 'shared', ignore=ignore)
    shutil.copytree(lambda_root / 'jobs' / 'retention', tmp_path / 'jobs' / 'retention', ignore=ignore)
    shutil.copy(lambda_root / 'jobs' / '__init__.py', tmp_path / 'jobs' / '__init__.py')
    for file in files:
        (tmp_path / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(lambda_root / file, tmp_path / file)
    probe = ('import sys; sys.path.insert(0, sys.argv[1]); import jobs.retention.handler as h; '
             'assert h.__file__.startswith(sys.argv[1]); '
             'assert all(m.__file__.startswith(sys.argv[1]) for n, m in sys.modules.items() '
             "if n.split('.')[0] in ('engineering', 'jobs', 'shared') and getattr(m, '__file__', None))")
    done = subprocess.run(  # noqa: S603 (this interpreter, a fixed program)
        [sys.executable, '-I', '-c', probe, str(tmp_path)], capture_output=True, text=True,
                          check=False, timeout=120, env={**os.environ, 'AWS_DEFAULT_REGION': 'us-east-1'})
    assert done.returncode == 0, done.stderr[-2000:]


def test_every_call_on_the_engineering_tables_is_one_iam_grants(aws, engineering, worker_context):
    _seed_runs(aws, engineering)
    _claim(engineering, 12, 'fb_issue')
    _seed_memories(engineering)
    grants = _engineering_grants()
    source = RETENTION_WORKER.read_text(encoding='utf-8')
    claim_attributes = set(_ts_list(source, 'ISSUE_CLAIM_ATTRIBUTES'))
    run_attributes = set(_ts_list(source, 'ENGINEERING_RUN_ATTRIBUTES'))
    memory_attributes = set(_ts_list(source, 'AGENT_MEMORY_UPDATE_ATTRIBUTES'))
    confirmation_attributes = set(_ts_list(source, 'AGENT_MEMORY_CONFIRMATION_ATTRIBUTES'))
    requests: list[dict[str, Any]] = []

    def record(model: Any, params: dict[str, Any], **_kwargs: Any) -> None:
        requests.append({'operation': model.name, **json.loads(params.get('body') or b'{}')})

    all_events = [aws['aggregates'].meta.client.meta.events, engineering['client'].meta.events]
    for events in all_events:
        events.register('before-call.dynamodb', record)
    try:
        with recorded_calls(aws, engineering['client']) as calls:
            assert _erase(aws, worker_context)['status'] == 'completed'
    finally:
        for events in all_events:
            events.unregister('before-call.dynamodb', record)

    seen = set()
    for action, table, keys in calls:
        if table not in (ENGINEERING_TABLE, AGENTS_TABLE):
            continue
        assert (table, action) in grants, (table, action)
        for key in keys:
            assert any(_matches(pattern, key) for pattern in grants[(table, action)]), (table, action, key)
        seen.add((table, action))
    assert seen == set(grants)
    # The Queries of the runs and the claims name their attributes (their statements' Select and Attributes), and
    # the updates name only the attributes they write and ask for nothing back.
    checked = set()
    for request in requests:
        table, operation = request.get('TableName'), request['operation']
        if operation == 'PutItem' and table == ENGINEERING_TABLE and 'AMEM#' in json.dumps(request['Item']['pk']):
            # The memory partitions' put (its statement's dynamodb:Attributes): a re-keyed confirmation row only.
            assert set(request['Item']) <= confirmation_attributes, set(request['Item'])
            checked.add((table, operation, True))
        if table not in (ENGINEERING_TABLE, AGENTS_TABLE) or operation not in ('Query', 'UpdateItem'):
            continue
        memory = 'AMEM#' in json.dumps(request.get('Key') or request.get('ExpressionAttributeValues'))
        allowed = claim_attributes if table == AGENTS_TABLE else memory_attributes if memory else run_attributes
        if operation == 'Query' and not memory:
            assert request['Select'] == 'SPECIFIC_ATTRIBUTES'
            assert set(request['ExpressionAttributeNames'].values()) <= allowed
        if operation == 'UpdateItem':
            names = {*request['Key'], *(request.get('ExpressionAttributeNames') or {}).values()}
            assert names <= allowed, names
            assert request.get('ReturnValues', 'NONE') == 'NONE'
        checked.add((table, operation, memory))
    assert checked == {(AGENTS_TABLE, 'Query', False), (AGENTS_TABLE, 'UpdateItem', False),
                       (ENGINEERING_TABLE, 'Query', False), (ENGINEERING_TABLE, 'UpdateItem', False),
                       (ENGINEERING_TABLE, 'Query', True), (ENGINEERING_TABLE, 'UpdateItem', True),
                       (ENGINEERING_TABLE, 'PutItem', True)}
