"""voc-retention reaches voc-participants (7.72.00, projects 3g2; TENETS.md D5; docs/multi-workspace.md, 3g2).

End to end in moto: one address is a participant in the deployment and in two workspaces, a third workspace holds
another person; the participants are written by their own stores (``create_person``, ``create_list``, ``add_member``,
``link``). An erasure by email looks the address up in each guard, one GetItem a scope, saves the ids it resolves
before erasing any, and erases each with the participant erasure in its scope; a workspace's own erasure reaches its
own guard only; a job that failed after a guard was deleted leaves its ids saved and the next erasure finishes them by
id; one cut after a person's ``META`` went has its tail finished by the next; a walk handed over after every step ends
as one that never was; a board supporter erased is not made a participant again by a later promote; the address is
normalised as the guard is; a carried state of the wrong shape fails the job; every call the job sends on
voc-participants is one IAM allows (lib/stacks/retention-worker.ts).
"""
from __future__ import annotations

import itertools
import json
import re
from collections.abc import Callable, Generator, Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final
from unittest.mock import patch

import boto3
import pytest
from boto3.dynamodb.conditions import Attr, ConditionBase, Key
from botocore.exceptions import ClientError

from jobs.retention import boards, exports, handler, participants, runs, workspaces
from jobs.retention.test.conftest import erasure_job, erasure_rows, put_feedback
from jobs.retention.test.test_export_erasure import DONE, RUNNING, _seed_exports, _uploads
from jobs.retention.test.test_export_erasure import _statuses as _export_statuses
from jobs.retention.test.test_named_workspace_erasure import _job as _named_job
from jobs.retention.test.test_named_workspace_erasure import _job_row as _named_job_row
from jobs.retention.test.test_project_erasure import _list_workspace
from jobs.retention.test.test_workspace_erasure import BASIS, JOB_ID, WS, WS_TWO, _versions, put_workspace_feedback
from shared import participants_erasure
from shared.digests import sha256_hex
from shared.exceptions import (
    ConfigurationError,
    NotFoundError,
    ServiceError,
    ServiceUnavailableError,
    TooManyRequestsError,
)
from shared.feature_requests_promote import promote
from shared.feature_requests_store import get_request, request_key, support_id_for, support_key
from shared.indexes import PARTICIPANTS_LISTING_INDEX
from shared.ingest_tables import DeploymentTable
from shared.participants_keys import email_guard_key, participants_index_key, person_key
from shared.participants_lists import add_member, create_list, get_list, link, list_ids_of_person, member_ids
from shared.participants_store import create_person, find_person_id, get_person
from shared.project_keys import NotPerWorkspaceError
from shared.retention import (
    ERASURE_JOB_PK,
    GUARD_MALFORMED_COUNTER,
    INDEX_KEPT_COUNTER,
    MALFORMED_ID_COUNTER,
    NOT_ERASED_COUNTER,
    PARTICIPANT_COUNTER,
)
from shared.test.moto_tables import create_table_with_gsi1
from shared.ws_repo import WorkspaceScope

PARTICIPANTS_TABLE: Final = 'test-participants'
WS_THREE: Final = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DA'
A, B, C = WorkspaceScope(WS), WorkspaceScope(WS_TWO), WorkspaceScope(WS_THREE)
#: The erased address as a guard holds it, and as an admin may type it (mixed case, spaces around).
ADDRESS: Final = 'partner.contact@example.com'
TYPED: Final = '  Partner.Contact@Example.COM '
OTHER: Final = 'other.contact@example.com'
SECOND_JOB: Final = 'er_00000000c0df'
RETENTION_WORKER: Final = Path(__file__).resolve().parents[4] / 'lib' / 'stacks' / 'retention-worker.ts'
NOW: Final = datetime(2026, 11, 16, 9, 0, tzinfo=UTC)


@pytest.fixture
def people(aws) -> Iterator[Any]:
    """voc-participants with its ``gsi1``, the handler pointed at it (the conftest's ``aws`` mock is active)."""
    region = aws['aggregates'].meta.client.meta.region_name
    table = create_table_with_gsi1(boto3.resource('dynamodb', region_name=region), PARTICIPANTS_TABLE,
                                   PARTICIPANTS_LISTING_INDEX)
    with patch.object(handler, 'PARTICIPANTS_TABLE', PARTICIPANTS_TABLE):
        yield table


def _person(table: Any, email: str, scope: WorkspaceScope | None, name: str = 'Partner contact') -> str:
    """A participant on a list, linked to a project, in ``scope``; its id."""
    person = create_person(table, email=email.strip(), email_lc=email.strip().lower(), fields={'name': name},
                           origin='manual', created_by='sub-admin', workspace=scope)
    listed = create_list(table, {'name': 'Beta', 'gsi1sk': 'beta', 'description': '', 'kind': 'beta'}, 'sub-admin',
                         workspace=scope)
    add_member(table, listed['list_id'], person['person_id'], 'sub-admin', workspace=scope)
    link(table, 'proj_shared_000001', 'PERSON', person['person_id'], 'sub-admin', workspace=scope)
    return str(person['person_id'])


def _seed(aws, table: Any) -> dict[str, str]:
    """The address in the deployment, in A and in B; another person in C; every workspace listed. The ids by scope."""
    for ws, name in ((WS, 'Alpha'), (WS_TWO, 'Beta'), (WS_THREE, 'Gamma')):
        _list_workspace(aws, ws, name)
    return {'deployment': _person(table, ADDRESS, None), WS: _person(table, ADDRESS, A),
            WS_TWO: _person(table, ADDRESS, B), WS_THREE: _person(table, OTHER, C)}


def _gone(table: Any, scope: WorkspaceScope | None, person_id: str, email: str = ADDRESS) -> bool:
    """The person and its guard are both gone in ``scope``."""
    return get_person(table, person_id, workspace=scope) is None and find_person_id(
        table, email, workspace=scope) is None


def _saved(aws, scope: WorkspaceScope | None = None, email: str = ADDRESS) -> dict[str, Any] | None:
    partition = ERASURE_JOB_PK if scope is None else f'WS#{scope.ws}#JOB#erasure'
    return aws['aggregates'].get_item(Key={'pk': partition, 'sk': f'PARTICIPANTS#{sha256_hex(email)}'},
                                      ConsistentRead=True).get('Item')


def _tombstones(table: Any) -> list[dict[str, Any]]:
    return table.query(KeyConditionExpression=Key('pk').eq(participants_erasure.TOMBSTONE_PK))['Items']


def _erase(aws, context, value: str = ADDRESS, job_id: str = JOB_ID) -> dict[str, Any]:
    return handler.handle_event(erasure_job(aws, job_id, 'email', value, legal_basis=BASIS,
                                            started_by_sub='sub-admin'), context)


def _run(**extra: Any) -> dict[str, Any]:
    return {**runs.new_run({}, 'erase'), 'field': 'email', 'job_id': JOB_ID, 'legal_basis': BASIS, **extra}


def _cut(run: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    """``run`` with a workspace person's erasure cut after its guard went (its batch delete throttled)."""
    throttled = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow'}},
                            'BatchWriteItem')
    with patch.object(participants_erasure, 'delete_many', side_effect=throttled):
        return run()


def _no_filter(_store: str) -> ConditionBase:
    """A walk's scan filter that no test here reads."""
    return Attr('pk').exists()


def _tables(aws, table: Any) -> dict[str, Any]:
    return {'participants': table, 'aggregates': aws['aggregates'], 'workspace_members': aws['workspaces']}


class TestAnErasureByEmailReachesTheParticipants:
    def test_the_deployments_erasure_erases_the_address_in_the_deployment_and_each_workspace_and_no_one_else(
            self, aws, people, worker_context):
        ids = _seed(aws, people)

        result = _erase(aws, worker_context)

        assert result['status'] == 'completed'
        for scope, person_id in ((None, ids['deployment']), (A, ids[WS]), (B, ids[WS_TWO])):
            assert _gone(people, scope, person_id)
            assert get_person(people, person_id, workspace=scope) is None
        # The third workspace's other person is left whole, guard, list and link.
        assert find_person_id(people, OTHER, workspace=C) == ids[WS_THREE]
        other = get_person(people, ids[WS_THREE], workspace=C)
        assert other is not None
        assert other['project_ids'] == {'proj_shared_000001'}
        job, audit = erasure_rows(aws, JOB_ID)
        assert (job[PARTICIPANT_COUNTER], audit[PARTICIPANT_COUNTER]) == (3, 3)
        assert (job[runs.PARTICIPANTS_WALKED], audit[runs.PARTICIPANTS_WALKED]) == (True, True)

    def test_each_person_is_erased_under_the_jobs_legal_basis_by_the_job(self, aws, people, worker_context):
        ids = _seed(aws, people)

        _erase(aws, worker_context)

        stones = {row['sk']: row for row in _tombstones(people)}
        assert set(stones) == {sha256_hex(ids['deployment']), f'{WS}#{sha256_hex(ids[WS])}',
                               f'{WS_TWO}#{sha256_hex(ids[WS_TWO])}'}
        for stone in stones.values():
            assert stone['legal_basis'] == BASIS
            assert stone['actor'] == {'sub': 'sub-admin', 'kind': 'erasure', 'job_id': JOB_ID}
            assert ADDRESS not in json.dumps(stone, default=str)

    def test_the_saved_row_is_emptied_and_expires_once_every_person_is_erased(self, aws, people, worker_context):
        _seed(aws, people)

        _erase(aws, worker_context)

        saved = _saved(aws)
        assert saved is not None
        assert participants.SAVED_PEOPLE not in saved
        now = int(datetime.now(UTC).timestamp())
        assert now < int(saved['ttl']) <= now + int(participants.EMPTIED_FOR.total_seconds()) + 60
        assert ADDRESS not in json.dumps(saved, default=str)

    def test_an_address_nobody_holds_reads_each_guard_and_writes_nothing(self, aws, people, worker_context):
        _seed(aws, people)

        _erase(aws, worker_context, 'nobody@example.com')

        job, _audit = erasure_rows(aws, JOB_ID)
        assert PARTICIPANT_COUNTER not in job
        assert job[runs.PARTICIPANTS_WALKED] is True
        assert _saved(aws, email='nobody@example.com') is None

    def test_a_workspaces_own_erasure_reaches_its_own_guard_only(self, aws, people, worker_context):
        ids = _seed(aws, people)

        with recorded_calls(aws) as calls:
            handler.handle_event(_named_job(aws, 'email', ADDRESS), worker_context)

        assert _gone(people, A, ids[WS])
        assert find_person_id(people, ADDRESS) == ids['deployment']
        assert find_person_id(people, ADDRESS, workspace=B) == ids[WS_TWO]
        job = _named_job_row(aws)
        assert (job['status'], job[PARTICIPANT_COUNTER], job[runs.PARTICIPANTS_WALKED]) == ('completed', 1, True)
        # Its saved row is in its own job partition, and every guard it read is its own.
        assert _saved(aws, A) is not None
        assert _saved(aws) is None
        guards = [keys for operation, table, keys in calls if table == PARTICIPANTS_TABLE and operation == 'GetItem'
                  and 'EMAIL#' in keys[0]]
        assert guards == [[email_guard_key(ADDRESS, workspace=A)['pk']]] * len(guards)
        assert guards

    def test_the_address_is_normalised_as_the_guard_is(self, aws, people, worker_context):
        ids = _seed(aws, people)

        _erase(aws, worker_context, TYPED)

        assert _gone(people, None, ids['deployment'])
        assert _gone(people, A, ids[WS])
        assert participants.guard_address(TYPED) == ADDRESS
        assert email_guard_key(participants.guard_address(TYPED) or '')['pk'] == f'EMAIL#{sha256_hex(ADDRESS)}'

    def test_an_address_the_guards_rule_refuses_reads_nothing(self, aws, people):
        with recorded_calls(aws) as calls:
            following = participants.ParticipantEraser(_run(), _tables(aws, people), 'not an address').step(None)

        assert following is None
        assert calls == []

    def test_the_ids_are_saved_before_any_person_is_erased(self, aws, people):
        ids = _seed(aws, people)
        seen: list[str] = []
        real = participants.erase_person

        def erase(table: Any, person_id: str, **kwargs: Any) -> dict[str, int]:
            entry = participants.saved_entry(kwargs.get('workspace'), person_id)
            seen.append(entry)
            # Its own entry is saved before this very call deletes anything of it.
            assert entry in ((_saved(aws) or {}).get(participants.SAVED_PEOPLE) or set())
            return real(table, person_id, **kwargs)

        with patch.object(participants, 'erase_person', erase):
            _walk(aws, people, _run())

        assert sorted(seen) == sorted([f"deployment#{ids['deployment']}", f'{WS}#{ids[WS]}', f'{WS_TWO}#{ids[WS_TWO]}'])

    def test_other_erasures_never_reach_the_participants(self, aws, people, worker_context):
        ids = _seed(aws, people)

        handler.handle_event(erasure_job(aws, JOB_ID, 'email', ADDRESS, legal_basis=BASIS, source='web'),
                             worker_context)

        assert find_person_id(people, ADDRESS) == ids['deployment']
        job, _audit = erasure_rows(aws, JOB_ID)
        assert runs.PARTICIPANTS_WALKED not in job

    def test_without_the_table_the_phase_is_skipped_and_the_job_says_so(self, aws, worker_context):
        _erase(aws, worker_context)

        job, _audit = erasure_rows(aws, JOB_ID)
        assert job[runs.PARTICIPANTS_WALKED] is False


class TestARetryFinishesBySavedIds:
    def test_a_job_that_failed_after_the_guard_went_is_finished_by_the_next_erasure(self, aws, people, worker_context):
        ids = _seed(aws, people)

        first = _cut(lambda: _erase(aws, worker_context))

        assert first['status'] == 'failed'
        # A's guard is gone, its person is not: the address no longer finds them, the saved row does.
        assert find_person_id(people, ADDRESS, workspace=A) is None
        assert get_person(people, ids[WS], workspace=A) is not None
        assert f'{WS}#{ids[WS]}' in (_saved(aws) or {})[participants.SAVED_PEOPLE]

        second = handler.handle_event(erasure_job(aws, SECOND_JOB, 'email', ADDRESS, legal_basis=BASIS),
                                      worker_context)

        assert second['status'] == 'completed'
        for scope, person_id in ((None, ids['deployment']), (A, ids[WS]), (B, ids[WS_TWO])):
            assert _gone(people, scope, person_id)
        assert participants.SAVED_PEOPLE not in (_saved(aws) or {})
        job = aws['aggregates'].get_item(Key={'pk': ERASURE_JOB_PK, 'sk': SECOND_JOB})['Item']
        assert job[PARTICIPANT_COUNTER] == 2  # A by its saved id, B by its guard (the deployment's went first)

    def test_a_person_already_gone_is_taken_off_the_saved_row(self, aws, people):
        ids = _seed(aws, people)
        eraser = participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS)
        entry = f'{WS}#{ids[WS]}'
        eraser._save(None, [entry])  # the saved row as an earlier job left it
        participants_erasure.erase_person(people, ids[WS], legal_basis=BASIS, actor={'sub': 'sub-admin'}, workspace=A)

        following = eraser.step({**workspaces.listing_start(NOW), workspaces.DEPLOYMENT_DONE: True,
                                 'to_erase': [entry]})

        assert following is not None
        assert following['to_erase'] == []
        assert participants.SAVED_PEOPLE not in (_saved(aws) or {})


def _walk(aws, table: Any, run: dict[str, Any], *, hand_over_each_step: bool = False) -> tuple[dict[str, Any], int]:
    """The participants phase from its start to its end: in one invocation, or each step in a fresh one, the run and
    the cursor as a hand-over carries them (JSON)."""
    cursor: dict[str, Any] | None = None
    for steps in range(1, 500):
        if hand_over_each_step:
            # A fresh invocation: the run as its hand-over payload carries it, the job's own fields read again.
            run = _run(**runs.new_run({'run': json.loads(json.dumps(runs.carried_state(run), default=str))}, 'erase'))
        cursor = participants.ParticipantEraser(run, _tables(aws, table), ADDRESS, clock=lambda: NOW).step(
            json.loads(json.dumps(cursor)) if cursor else None)
        if cursor is None:
            return run, steps
    raise AssertionError('the walk did not end')


def _participants_rows(table: Any) -> list[dict[str, Any]]:
    """Every row of voc-participants, the erasure's times left out (each run stamps its own)."""
    rows = [{name: value for name, value in row.items() if name not in ('deleted_at', 'updated_at')}
            for row in table.scan(ConsistentRead=True)['Items']]
    return sorted(rows, key=lambda row: (str(row['pk']), str(row['sk'])))


class TestTheWalkHandsOver:
    def test_a_walk_resumed_after_every_step_ends_as_one_that_never_was(self, aws, people):
        """Each step in a fresh invocation, and every listing page one workspace, so every carried part is resumed
        from: the same people erased, the same rows left, the same count."""
        _seed(aws, people)
        before = people.scan(ConsistentRead=True)['Items']
        one_run, one_steps = _walk(aws, people, _run())
        expected = _participants_rows(people)
        for row in people.scan(ConsistentRead=True)['Items']:
            people.delete_item(Key={'pk': row['pk'], 'sk': row['sk']})
        for row in before:
            people.put_item(Item=row)
        aws['aggregates'].delete_item(Key={'pk': ERASURE_JOB_PK, 'sk': f'PARTICIPANTS#{sha256_hex(ADDRESS)}'})

        with patch.object(workspaces, 'ID_PAGE', 1):
            run, steps = _walk(aws, people, _run(), hand_over_each_step=True)

        assert steps > one_steps
        assert _participants_rows(people) == expected
        assert run[PARTICIPANT_COUNTER] == one_run[PARTICIPANT_COUNTER] == 3
        assert run[runs.PARTICIPANTS_WALKED] is True

    def test_the_handler_hands_the_phase_over_and_resumes_it(self, aws, people, worker_context, invoke_mock):
        ids = _seed(aws, people)

        def clock(_context: Any) -> Callable[[], bool]:
            """Each invocation has room for a few more steps, then hands over (enough for the exports phase's two
            sweeps of a workspace, which it begins again in each invocation)."""
            return itertools.cycle([True, True, True, False]).__next__

        with patch.object(handler, '_lambda_clock', clock):
            result = _erase(aws, worker_context)
            for _invocation in range(400):
                if result['status'] != 'continued':
                    break
                payload = invoke_mock.call_args.args[1]
                result = handler.handle_event(json.loads(json.dumps(payload, default=str)), worker_context)

        assert result['status'] == 'completed'
        assert {call.args[1]['phase'] for call in invoke_mock.call_args_list} >= {'participants'}
        for scope, person_id in ((None, ids['deployment']), (A, ids[WS]), (B, ids[WS_TWO])):
            assert _gone(people, scope, person_id)
        job, _audit = erasure_rows(aws, JOB_ID)
        assert job[PARTICIPANT_COUNTER] == 3

    @pytest.mark.usefixtures('people')
    def test_the_phase_comes_after_the_boards_and_the_projects(self):
        walk = handler.Walk(handler._tables(), None, {}, _run(), _no_filter, None, lambda: True)
        phases = handler._phases(walk)
        assert phases.index('participants') > phases.index('boards')
        assert phases.index('participants') == phases.index('workspace_projects') + 1
        named = handler.Walk(handler._tables(), None, {}, _run(workspace_id=WS), _no_filter, None, lambda: True)
        assert handler._phases(named) == ['items', 'form_tests', 'workspace_projects', 'participants', 'exports',
                                          'workspace_lineage']


class TestTheBoards:
    REQUEST: Final = 'fr_0000000000000001'

    def _board(self, aws) -> None:
        """A request with two +1s: the erased supporter's and another's (role names only)."""
        aws['feature_requests'].put_item(Item={
            **request_key(self.REQUEST), 'request_id': self.REQUEST, 'title': 'Split invoices', 'version': 0,
            'created_at': '2026-03-04T10:00:00+00:00', 'totals': {'supporters': 2}, 'status': 'open'})
        for email, name in ((ADDRESS, 'Partner contact'), (OTHER, 'Other contact')):
            support_id = support_id_for(self.REQUEST, email)
            aws['feature_requests'].put_item(Item={
                **support_key(self.REQUEST, support_id), 'support_id': support_id, 'request_id': self.REQUEST,
                'email': email, 'name': name, 'is_reporter': False, 'created_at': '2026-03-04T10:00:00+00:00'})

    def _promote(self, aws, table: Any) -> dict[str, Any]:
        request = get_request(aws['feature_requests'], self.REQUEST)
        assert request is not None
        return promote(aws['feature_requests'], table, request, {}, 'proj_board_000001',
                       {'allow_external_people': True, 'company_domains': []}, 'sub-admin')

    def test_an_erased_supporter_is_not_made_a_participant_again_by_a_later_promote(self, aws, people, worker_context):
        self._board(aws)
        first = self._promote(aws, people)
        supporter = find_person_id(people, ADDRESS)
        assert supporter is not None
        assert first['added'] == 2

        _erase(aws, worker_context, TYPED)

        assert _gone(people, None, supporter)
        assert ADDRESS not in json.dumps(aws['feature_requests'].scan()['Items'], default=str)
        again = self._promote(aws, people)
        assert find_person_id(people, ADDRESS) is None
        assert (again['added'], again['skipped']) == (0, [])
        other = find_person_id(people, OTHER)
        assert member_ids(people, str(again['list']['list_id']), limit=None) == [other]

    def test_an_erased_contact_is_not_made_a_participant_again_by_a_later_promote(self, aws, people, worker_context):
        """A +1 naming the address as its customer contact (the supporter is someone else): the contact goes, the +1
        keeps its id and its supporter; the request's own contact goes too."""
        aws['feature_requests'].put_item(Item={
            **request_key(self.REQUEST), 'request_id': self.REQUEST, 'title': 'Split invoices', 'version': 0,
            'created_at': '2026-03-04T10:00:00+00:00', 'totals': {'supporters': 1}, 'status': 'open',
            'fields': {'contact_email': ADDRESS, 'customer': 'Example customer'}})
        support_id = support_id_for(self.REQUEST, OTHER)
        aws['feature_requests'].put_item(Item={
            **support_key(self.REQUEST, support_id), 'support_id': support_id, 'request_id': self.REQUEST,
            'email': OTHER, 'name': 'Other contact', 'contact_email': ADDRESS, 'is_reporter': False,
            'created_at': '2026-03-04T10:00:00+00:00'})
        self._promote(aws, people)
        assert find_person_id(people, ADDRESS) is not None

        _erase(aws, worker_context, TYPED)

        support = aws['feature_requests'].get_item(Key=support_key(self.REQUEST, support_id))['Item']
        assert (support['email'], 'contact_email' in support) == (OTHER, False)
        meta = aws['feature_requests'].get_item(Key=request_key(self.REQUEST))['Item']
        assert meta['fields'] == {'customer': 'Example customer'}
        stones = aws['aggregates'].query(
            KeyConditionExpression=Key('pk').eq('AUDIT#tombstone#feature_requests'))['Items']
        # The request's under its id, and one per job for each contact-only row under its request and a random token
        # (the request's and the +1's): no audit row names the +1's id, which derives from its supporter's address.
        assert sorted(str(row['sk']).split('#contact#')[0] for row in stones) == [self.REQUEST] * 3
        assert sum('#contact#' in str(row['sk']) for row in stones) == 2
        assert support_id not in json.dumps(stones, default=str)
        self._promote(aws, people)
        assert find_person_id(people, ADDRESS) is None
        assert find_person_id(people, OTHER) is not None

    def _support(self, aws, email: str, **extra: Any) -> str:
        support_id = support_id_for(self.REQUEST, email)
        aws['feature_requests'].put_item(Item={
            **support_key(self.REQUEST, support_id), 'support_id': support_id, 'request_id': self.REQUEST,
            'email': email, 'name': 'A supporter', 'is_reporter': False, 'created_at': '2026-03-04T10:00:00+00:00',
            **extra})
        return support_id

    def _request(self, aws, **extra: Any) -> None:
        aws['feature_requests'].put_item(Item={
            **request_key(self.REQUEST), 'request_id': self.REQUEST, 'title': 'Split invoices', 'version': 0,
            'created_at': '2026-03-04T10:00:00+00:00', 'totals': {'supporters': 1}, 'status': 'open', **extra})

    def _supports(self, aws) -> list[dict[str, Any]]:
        return aws['feature_requests'].query(KeyConditionExpression=Key('pk').eq(f'FR#{self.REQUEST}')
                                             & Key('sk').begins_with('SUP#'))['Items']

    @pytest.mark.usefixtures('people')
    def test_a_plus_one_whose_own_address_and_contact_are_both_erased_is_rekeyed_without_either(
            self, aws, worker_context):
        self._request(aws)
        old = self._support(aws, ADDRESS, contact_email=ADDRESS)

        _erase(aws, worker_context)

        [support] = self._supports(aws)
        assert support['support_id'] != old
        assert not {'email', 'name', 'contact_email'} & set(support)

    @pytest.mark.usefixtures('people')
    def test_a_plus_one_whose_own_address_matches_keeps_another_persons_contact(self, aws, worker_context):
        self._request(aws)
        self._support(aws, ADDRESS, contact_email=OTHER)

        _erase(aws, worker_context)

        [support] = self._supports(aws)
        assert ('email' in support, support['contact_email']) == (False, OTHER)

    @pytest.mark.usefixtures('people')
    def test_a_request_whose_reporter_and_contact_both_match_loses_both(self, aws, worker_context):
        self._request(aws, reporter_email=ADDRESS, reporter_name='A reporter',
                      fields={'contact_email': ADDRESS, 'customer': 'Example customer'})

        _erase(aws, worker_context)

        meta = aws['feature_requests'].get_item(Key=request_key(self.REQUEST))['Item']
        assert not {'reporter_email', 'reporter_name'} & set(meta)
        assert meta['fields'] == {'customer': 'Example customer'}

    def test_the_eraser_tells_which_address_matched_the_typed_spelling(self, aws):
        eraser = boards.BoardEraser(_run(), {'feature_requests': aws['feature_requests'],
                                             'aggregates': aws['aggregates']}, None, '', TYPED)
        assert eraser.matched({'sk': 'SUP#sup_1', 'email': ADDRESS, 'contact_email': OTHER}) == (True, False)
        assert eraser.matched({'sk': 'SUP#sup_1', 'email': OTHER, 'contact_email': ADDRESS}) == (False, True)
        assert eraser.matched({'sk': 'META', 'reporter_email': OTHER, 'fields': {'contact_email': ADDRESS}}) == (
            False, True)

    def test_a_contact_changed_since_the_scan_is_left_as_it_now_is(self, aws):
        self._request(aws)
        support_id = self._support(aws, OTHER, contact_email='someone.else@example.com')
        eraser = boards.BoardEraser(_run(), {'feature_requests': aws['feature_requests'],
                                             'aggregates': aws['aggregates']}, None, '', ADDRESS)

        changed = eraser._erase_contact(aws['feature_requests'].get_item(
            Key=support_key(self.REQUEST, support_id))['Item'])

        assert changed is False
        support = aws['feature_requests'].get_item(Key=support_key(self.REQUEST, support_id))['Item']
        assert support['contact_email'] == 'someone.else@example.com'

    @pytest.mark.usefixtures('people')
    def test_a_reporter_erased_after_the_contact_leaves_a_record_of_its_own_job(self, aws, worker_context):
        """The request-id tombstone is the contact's job's (put only if new); the reporter's job still leaves its
        own record, with its legal basis."""
        self._request(aws, reporter_email=OTHER, reporter_name='A reporter', fields={'contact_email': ADDRESS})
        _erase(aws, worker_context)
        handler.handle_event(erasure_job(aws, SECOND_JOB, 'email', OTHER, legal_basis=BASIS), worker_context)

        stones = aws['aggregates'].query(
            KeyConditionExpression=Key('pk').eq('AUDIT#tombstone#feature_requests'))['Items']
        assert {row['job_id'] for row in stones} == {JOB_ID, SECOND_JOB}
        assert [row['field'] for row in stones if row['job_id'] == SECOND_JOB and row['sk'] != self.REQUEST] == [
            'reporter_email']

    def test_a_second_erasures_request_tombstone_never_overwrites_the_first(self, aws):
        row = {'pk': f'FR#{self.REQUEST}', 'sk': 'META', 'request_id': self.REQUEST, 'reporter_email': ADDRESS}
        tables = {'feature_requests': aws['feature_requests'], 'aggregates': aws['aggregates']}
        boards.BoardEraser(_run(), tables, None, '', ADDRESS).tombstones([row])
        boards.BoardEraser(_run(job_id=SECOND_JOB), tables, None, '', ADDRESS).tombstones([row])

        stone = aws['aggregates'].get_item(Key={'pk': 'AUDIT#tombstone#feature_requests', 'sk': self.REQUEST})['Item']
        assert stone['job_id'] == JOB_ID


@pytest.mark.parametrize('cursor', [
    {'to_erase': 'deployment#per_0123456789abcdef'},
    {'to_erase': ['nope']},
    {'to_erase': ['deployment#per_nothex']},
    {'to_erase': ['ws_bad#per_0123456789abcdef']},
    {'to_erase': ['deployment#per_0123456789abcdef#x']},
    {'to_erase': ['deployment#per_0123456789abcdef'] * (participants.MAX_SAVED + 1)},
])
def test_a_malformed_carried_person_fails_the_step(aws, people, cursor):
    with pytest.raises(ValueError, match='participant'):
        participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS).step(
            {**workspaces.listing_start(NOW), workspaces.DEPLOYMENT_DONE: True, **cursor})


@pytest.mark.parametrize('to_erase', [['deployment#per_0123456789abcdef'], [f'{WS_TWO}#per_0123456789abcdef']])
def test_a_one_workspace_job_refuses_a_carried_person_of_another_scope(aws, people, to_erase):
    run = _run(workspace_id=WS)
    with pytest.raises(ValueError, match='participant'):
        participants.ParticipantEraser(run, _tables(aws, people), ADDRESS).step(
            {**workspaces.one_start(WS), 'to_erase': to_erase})


def test_a_malformed_saved_row_fails_the_step(aws, people):
    aws['aggregates'].put_item(Item={'pk': ERASURE_JOB_PK, 'sk': f'PARTICIPANTS#{sha256_hex(ADDRESS)}',
                                     participants.SAVED_PEOPLE: {'deployment#not-an-id'}})
    with pytest.raises(ValueError, match='participant'):
        participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS).step(
            {'ws': [], 'listing_done': True, 'at': {}, workspaces.DEPLOYMENT_DONE: True, 'to_erase': []})


@pytest.mark.usefixtures('people')
def test_a_malformed_carried_state_fails_the_job(aws, worker_context):
    event = erasure_job(aws, JOB_ID, 'email', ADDRESS, legal_basis=BASIS, status='running')
    aws['aggregates'].update_item(Key={'pk': ERASURE_JOB_PK, 'sk': JOB_ID}, UpdateExpression='SET #s = :r',
                                  ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':r': 'running'})

    result = handler.handle_event({**event, 'phase': 'participants', 'cursor': {'to_erase': ['nope']},
                                   'run': {'run_id': 'r1', 'started_at': '2026-11-16T09:00:00+00:00'}},
                                  worker_context)

    assert result['status'] == 'failed'
    job = aws['aggregates'].get_item(Key={'pk': ERASURE_JOB_PK, 'sk': JOB_ID})['Item']
    assert (job['status'], job['error']) == ('failed', 'Run failed (ValueError)')


class TestRefusals:
    def test_a_refused_person_stays_saved_is_counted_and_the_walk_goes_on(self, aws, people, worker_context):
        """A workspace person holding an ask (erase_person refuses: NotPerWorkspaceError) does not stop the job."""
        ids = _seed(aws, people)
        people.put_item(Item={'pk': f'WS#{WS}#PERSON#{ids[WS]}', 'sk': 'ASK#ask_0123456789abcdef',
                              'ask_id': 'ask_0123456789abcdef'})

        result = _erase(aws, worker_context)

        assert result['status'] == 'completed'
        assert _gone(people, None, ids['deployment'])
        assert _gone(people, B, ids[WS_TWO])
        assert get_person(people, ids[WS], workspace=A) is not None
        job, audit = erasure_rows(aws, JOB_ID)
        assert (job[PARTICIPANT_COUNTER], job[NOT_ERASED_COUNTER], job[runs.PARTICIPANTS_WALKED]) == (2, 1, True)
        # Walked, but not complete: a person remains, and the row says so (the rerun rule reads it).
        assert (job[runs.PARTICIPANTS_COMPLETE], audit[runs.PARTICIPANTS_COMPLETE]) == (False, False)
        saved = _saved(aws) or {}
        assert saved[participants.SAVED_PEOPLE] == {f'{WS}#{ids[WS]}'}
        # Saved again when refused: its ttl pushed forward, so it never expires while it is still refused.
        assert int(saved['ttl']) > int(datetime.now(UTC).timestamp()) + 29 * 86_400

    def test_a_complete_erasure_says_so(self, aws, people, worker_context):
        _seed(aws, people)

        _erase(aws, worker_context)

        job, audit = erasure_rows(aws, JOB_ID)
        assert (job[runs.PARTICIPANTS_COMPLETE], audit[runs.PARTICIPANTS_COMPLETE]) == (True, True)

    @pytest.mark.parametrize('error', [ServiceError('Could not read the people'), ServiceUnavailableError('busy'),
                                       TooManyRequestsError('slow down'), ConfigurationError('not set')])
    def test_any_other_api_error_fails_the_job(self, aws, people, worker_context, error):
        """Only a refusal that does not clear within the run is kept and counted; a transient or configuration error
        fails the job (the next erasure of the address finishes it by the saved ids), never reads as done."""
        ids = _seed(aws, people)

        with patch.object(participants, 'erase_person', side_effect=error):
            result = _erase(aws, worker_context)

        assert result['status'] == 'failed'
        job = aws['aggregates'].get_item(Key={'pk': ERASURE_JOB_PK, 'sk': JOB_ID})['Item']
        assert job['error'] == 'Run failed (ParticipantNotErased)'
        assert runs.PARTICIPANTS_COMPLETE not in job or job[runs.PARTICIPANTS_COMPLETE] is False
        assert f"deployment#{ids['deployment']}" in (_saved(aws) or {})[participants.SAVED_PEOPLE]

    def test_a_refused_carried_entry_is_saved_again_on_the_jobs_own_row(self, aws, people):
        """A person carried from a workspace's row (or any cursor) and refused lands on the job's own row, its ttl
        30 days ahead."""
        ids = _seed(aws, people)
        entry = f'{WS}#{ids[WS]}'
        eraser = participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS)

        with patch.object(participants, 'erase_person', side_effect=NotPerWorkspaceError('asks')):
            eraser.step({**workspaces.listing_start(NOW), workspaces.DEPLOYMENT_DONE: True, 'to_erase': [entry]})

        assert (_saved(aws) or {})[participants.SAVED_PEOPLE] == {entry}

    def test_a_refused_entry_is_not_tried_again_in_the_same_run(self, aws, people):
        """The end loop reads the saved row again but skips what this run refused, so it ends."""
        ids = _seed(aws, people)
        entry = f"deployment#{ids['deployment']}"
        eraser = participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS)
        eraser._save(None, [entry])

        following = eraser.step({'ws': [], 'listing_done': True, 'at': {}, workspaces.DEPLOYMENT_DONE: True,
                                 'to_erase': [], 'refused': [entry]})

        assert following is None


class TestConsistency:
    def test_a_not_found_while_the_person_is_there_is_tried_again(self, aws, people):
        """erase_person's own read is eventually consistent: a "not found" is checked by a consistent read first."""
        ids = _seed(aws, people)
        real, answers = participants.erase_person, iter([NotFoundError('Person not found')])
        run = _run()

        def flaky(*args: Any, **kwargs: Any) -> dict[str, int]:
            error = next(answers, None)
            if error is not None:
                raise error
            return real(*args, **kwargs)

        with patch.object(participants, 'erase_person', flaky):
            participants.ParticipantEraser(run, _tables(aws, people), ADDRESS).step(
                {**workspaces.listing_start(NOW), workspaces.DEPLOYMENT_DONE: True,
                 'to_erase': [f"deployment#{ids['deployment']}"]})

        assert _gone(people, None, ids['deployment'])
        assert run[PARTICIPANT_COUNTER] == 1

    def test_a_person_still_there_after_every_not_found_is_refused_and_kept(self, aws, people):
        ids = _seed(aws, people)
        entry = f"deployment#{ids['deployment']}"
        run = _run()
        eraser = participants.ParticipantEraser(run, _tables(aws, people), ADDRESS)
        eraser._save(None, [entry])

        with patch.object(participants, 'erase_person', side_effect=NotFoundError('Person not found')):
            following = eraser.step({**workspaces.listing_start(NOW), workspaces.DEPLOYMENT_DONE: True,
                                     'to_erase': [entry]})

        assert following is not None
        assert following['refused'] == [entry]
        assert run[NOT_ERASED_COUNTER] == 1
        assert (_saved(aws) or {})[participants.SAVED_PEOPLE] == {entry}


class TestExports:
    def test_a_workspace_whose_participant_is_erased_has_its_exports_erased(self, aws, people, worker_context):
        """The person is only a participant in A (no item, no membership, no project): A's export still goes."""
        _seed(aws, people)
        _seed_exports(aws, WS)
        _seed_exports(aws, WS_THREE)  # only another person there: kept

        assert _erase(aws, worker_context)['status'] == 'completed'

        assert _export_statuses(aws, WS) == {DONE: 'erased', RUNNING: 'erased'}
        assert _versions(aws, f'ws/{WS}/exports/') == []
        assert _uploads(aws, f'ws/{WS}/exports/') == []
        assert _export_statuses(aws, WS_THREE) == {DONE: 'completed', RUNNING: 'running'}
        assert _versions(aws, f'ws/{WS_THREE}/exports/') != []

    def test_an_entry_read_from_a_saved_row_closes_its_workspaces_exports_before_it_is_erased(self, aws, people):
        ids = _seed(aws, people)
        _seed_exports(aws, WS)
        run = _run()
        order: list[str] = []
        real_note, real_erase = exports.note_workspace, participants.erase_person
        with patch.object(exports, 'note_workspace',
                          lambda *a, **k: (order.append('exports'), real_note(*a, **k))[1]), \
                patch.object(participants, 'erase_person',
                             lambda *a, **k: (order.append('erase'), real_erase(*a, **k))[1]):
            participants.ParticipantEraser(run, _tables(aws, people), ADDRESS).step(
                {'ws': [], 'listing_done': True, 'at': {}, workspaces.DEPLOYMENT_DONE: True,
                 'to_erase': [f'{WS}#{ids[WS]}']})

        assert order[:2] == ['exports', 'erase']
        assert WS in run[exports.ERASED_WORKSPACES]


class TestAcrossScopes:
    def test_a_failed_workspace_job_is_finished_by_the_deployments_erasure(self, aws, people, worker_context):
        ids = _seed(aws, people)
        _cut(lambda: handler.handle_event(_named_job(aws, 'email', ADDRESS), worker_context))
        assert f'{WS}#{ids[WS]}' in (_saved(aws, A) or {})[participants.SAVED_PEOPLE]

        assert handler.handle_event(erasure_job(aws, SECOND_JOB, 'email', ADDRESS, legal_basis=BASIS),
                                    worker_context)['status'] == 'completed'

        assert _gone(people, A, ids[WS])
        # Taken off the workspace's own row too: its next erasure has nothing left to finish.
        assert participants.SAVED_PEOPLE not in (_saved(aws, A) or {})

    def test_a_person_whose_guard_went_without_a_saved_row_is_found_by_the_people_index(self, aws, people,
                                                                                        worker_context):
        ids = _seed(aws, people)
        people.delete_item(Key=email_guard_key(ADDRESS, workspace=B))  # a cut erasure: guard gone, person left

        _erase(aws, worker_context)

        assert get_person(people, ids[WS_TWO], workspace=B) is None
        job, _audit = erasure_rows(aws, JOB_ID)
        assert job[PARTICIPANT_COUNTER] == 3

    @pytest.mark.parametrize('bad', [
        # An index row naming no person id (the real person's guard gone: the index still names them).
        {'pk': f'WS#{WS_TWO}#PERSON#not-an-id', 'sk': 'META', 'gsi1pk': f'WS#{WS_TWO}#PEOPLE', 'gsi1sk': ADDRESS},
        # A guard whose person_id is not a string.
        {**email_guard_key(ADDRESS, workspace=B), 'person_id': 5},
    ])
    def test_a_guard_or_index_row_naming_no_person_is_counted_apart(self, aws, people, bad):
        _seed(aws, people)
        people.delete_item(Key=email_guard_key(ADDRESS, workspace=B))
        people.put_item(Item=bad)
        run = _run()

        found = participants.ParticipantEraser(run, _tables(aws, people), ADDRESS)._people(B)

        assert len(found) == 1  # the index still names the real person
        assert run[GUARD_MALFORMED_COUNTER] == 1
        assert MALFORMED_ID_COUNTER not in run

    def test_a_kept_index_row_with_no_guard_back_keeps_the_entry_and_the_job_incomplete(self, aws, people,
                                                                                         worker_context):
        """Every try conflicted (unlist_if_empty answers False) and no guard of the address is back: the row still
        holds the address's hash, so the entry stays saved for the next erasure and the job does not read complete."""
        ids = _seed(aws, people)
        with patch.object(participants_erasure, 'unlist_if_empty', return_value=False):
            assert _erase(aws, worker_context)['status'] == 'completed'
        job, audit = erasure_rows(aws, JOB_ID)
        assert job[INDEX_KEPT_COUNTER] == 2  # A's and B's guards' rows in their workspaces' indexes
        assert job[PARTICIPANT_COUNTER] == 3
        assert (job[runs.PARTICIPANTS_COMPLETE], audit[runs.PARTICIPANTS_COMPLETE]) == (False, False)
        assert (_saved(aws) or {})[participants.SAVED_PEOPLE] == {f'{WS}#{ids[WS]}', f'{WS_TWO}#{ids[WS_TWO]}'}

    def test_a_kept_index_row_whose_guard_is_back_is_legitimate(self, aws, people, worker_context):
        """A newer person of the address re-added meanwhile: their guard is back, the row lists it; nothing is left
        to finish, nothing is counted."""
        _seed(aws, people)

        def guard_back(_table: Any, _workspace: WorkspaceScope, _index_key: Any, row_key: Mapping[str, Any]) -> bool:
            people.put_item(Item={**row_key, 'person_id': 'per_cccccccccccccccc'})
            return False

        with patch.object(participants_erasure, 'unlist_if_empty', guard_back):
            _erase(aws, worker_context)

        job, _audit = erasure_rows(aws, JOB_ID)
        assert INDEX_KEPT_COUNTER not in job
        assert job[runs.PARTICIPANTS_COMPLETE] is True
        assert participants.SAVED_PEOPLE not in (_saved(aws) or {})

    def test_a_half_erased_person_beside_a_newer_persons_guard_is_found_too(self, aws, people, worker_context):
        """The index is read even when a guard is there: a person whose erasure was cut after its guard went, and a
        newer person of the same address whose guard now stands, are both erased."""
        ids = _seed(aws, people)
        people.delete_item(Key=email_guard_key(ADDRESS, workspace=B))
        newer = _person(people, ADDRESS, B)

        _erase(aws, worker_context)

        assert get_person(people, ids[WS_TWO], workspace=B) is None
        assert get_person(people, newer, workspace=B) is None

    def test_the_index_query_names_what_it_reads(self, aws, people):
        """Its IAM statement holds it to SPECIFIC_ATTRIBUTES of its projection: the request says so."""
        seen: list[dict[str, Any]] = []

        def record(model: Any, params: dict[str, Any], **_kwargs: Any) -> None:
            body = json.loads(params.get('body') or b'{}')
            if model.name == 'Query' and body.get('IndexName'):
                seen.append(body)

        events = people.meta.client.meta.events
        events.register('before-call.dynamodb', record)
        try:
            participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS)._people(B)
        finally:
            events.unregister('before-call.dynamodb', record)

        [body] = seen
        assert body['Select'] == 'SPECIFIC_ATTRIBUTES'
        names = body['ExpressionAttributeNames']
        assert {names[name] for name in body['ProjectionExpression'].split(', ')} == {'pk'}
        granted = re.search(r'const PARTICIPANT_PEOPLE_INDEX_ATTRIBUTES = \[([^\]]*)\]',
                            RETENTION_WORKER.read_text(encoding='utf-8'))
        assert granted is not None
        assert set(names.values()) <= set(re.findall(r"'([^']+)'", granted.group(1))) == {'pk', 'gsi1pk', 'gsi1sk'}

    def test_a_malformed_workspace_saved_row_is_counted_and_skipped(self, aws, people, worker_context):
        ids = _seed(aws, people)
        aws['aggregates'].put_item(Item={'pk': f'WS#{WS}#JOB#erasure', 'sk': f'PARTICIPANTS#{sha256_hex(ADDRESS)}',
                                         participants.SAVED_PEOPLE: {'nope'}})

        assert _erase(aws, worker_context)['status'] == 'completed'

        assert _gone(people, A, ids[WS])
        job, _audit = erasure_rows(aws, JOB_ID)
        assert job[GUARD_MALFORMED_COUNTER] == 1

    def test_a_page_finding_more_than_max_saved_carries_max_saved_and_the_rest_waits_saved(self, aws, people):
        ids = _seed(aws, people)
        eraser = participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS, clock=lambda: NOW)
        cursor: dict[str, Any] | None = None
        with patch.object(participants, 'MAX_SAVED', 1):
            for _step in range(40):
                cursor = eraser.step(cursor)
                if cursor is None:
                    break
                assert len(cursor['to_erase']) <= 1

        assert cursor is None
        for scope, person_id in ((None, ids['deployment']), (A, ids[WS]), (B, ids[WS_TWO])):
            assert _gone(people, scope, person_id)

    def test_workspace_rows_past_the_cap_are_finished_by_the_end_of_the_walk(self, aws, people):
        """What workspaces' saved rows name past MAX_SAVED is saved on the job's own row, so the end of the walk takes
        it: no workspace row is left naming anyone."""
        _seed(aws, people)
        for ws, person_id in ((WS, 'per_aaaaaaaaaaaaaaaa'), (WS_TWO, 'per_bbbbbbbbbbbbbbbb')):
            aws['aggregates'].put_item(Item={'pk': f'WS#{ws}#JOB#erasure', 'sk': f'PARTICIPANTS#{sha256_hex(ADDRESS)}',
                                             participants.SAVED_PEOPLE: {f'{ws}#{person_id}'}})
        eraser = participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS, clock=lambda: NOW)
        cursor: dict[str, Any] | None = None
        with patch.object(participants, 'MAX_SAVED', 1):
            for _step in range(60):
                cursor = eraser.step(cursor)
                if cursor is None:
                    break

        assert cursor is None
        for scope in (A, B, None):
            assert participants.SAVED_PEOPLE not in (_saved(aws, scope) or {})

    def test_the_deployments_forget_lets_an_emptied_workspace_row_expire(self, aws, people, worker_context):
        _seed(aws, people)
        _cut(lambda: handler.handle_event(_named_job(aws, 'email', ADDRESS), worker_context))

        handler.handle_event(erasure_job(aws, SECOND_JOB, 'email', ADDRESS, legal_basis=BASIS), worker_context)

        row = _saved(aws, A) or {}
        assert participants.SAVED_PEOPLE not in row
        assert int(row['ttl']) <= int(datetime.now(UTC).timestamp()) + int(participants.EMPTIED_FOR.total_seconds()) + 60


class TestACutErasureIsFinished:
    """An erasure cut after the person's ``META`` went leaves its tail (the late memberships, a workspace guard's
    index row); the next erasure, finding the person gone, finishes it before it forgets the entry."""

    def test_a_crash_after_meta_before_the_late_memberships_is_finished_by_the_rerun(self, aws, people,
                                                                                     worker_context):
        ids = _seed(aws, people)
        [list_id] = list_ids_of_person(people, ids[WS], workspace=A)
        calls = iter([None, ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'cut'}}, 'UpdateItem')])
        real = participants_erasure.remove_member

        def late_then_cut(table: Any, listed: str, person_id: str, *, workspace: WorkspaceScope | None = None) -> bool:
            if workspace is None or workspace.ws != WS:
                return real(table, listed, person_id, workspace=workspace)
            answer = next(calls)
            # The first read did not see the membership (an add that committed meanwhile); the late pass is cut.
            if answer is not None:
                raise answer
            return False

        with patch.object(participants_erasure, 'remove_member', late_then_cut):
            assert _erase(aws, worker_context)['status'] == 'failed'
        assert get_person(people, ids[WS], workspace=A) is None
        assert member_ids(people, list_id, workspace=A) == [ids[WS]]

        second = handler.handle_event(erasure_job(aws, SECOND_JOB, 'email', ADDRESS, legal_basis=BASIS),
                                      worker_context)

        assert second['status'] == 'completed'
        assert member_ids(people, list_id, workspace=A) == []
        assert list_ids_of_person(people, ids[WS], workspace=A) == []
        assert (get_list(people, list_id, workspace=A) or {})['member_count'] == 0
        assert participants.SAVED_PEOPLE not in (_saved(aws) or {})
        job = aws['aggregates'].get_item(Key={'pk': ERASURE_JOB_PK, 'sk': SECOND_JOB})['Item']
        assert job[runs.PARTICIPANTS_COMPLETE] is True

    def test_a_deployment_person_gone_has_its_late_memberships_removed(self, aws, people):
        ids = _seed(aws, people)
        [list_id] = list_ids_of_person(people, ids['deployment'])
        entry = f"deployment#{ids['deployment']}"
        eraser = participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS)
        eraser._save(None, [entry])
        people.delete_item(Key=person_key(ids['deployment']))  # cut after META, its membership left

        eraser.step({**workspaces.listing_start(NOW), workspaces.DEPLOYMENT_DONE: True, 'to_erase': [entry]})

        assert member_ids(people, list_id) == []
        assert (get_list(people, list_id) or {})['member_count'] == 0
        assert participants.SAVED_PEOPLE not in (_saved(aws) or {})

    def test_a_kept_index_row_is_removed_by_the_rerun(self, aws, people, worker_context):
        ids = _seed(aws, people)
        index_row = participants_index_key(email_guard_key(ADDRESS, workspace=A)['pk'], workspace=A)
        assert people.get_item(Key=index_row).get('Item') is not None
        with patch.object(participants_erasure, 'unlist_if_empty', return_value=False):
            _erase(aws, worker_context)
        assert people.get_item(Key=index_row).get('Item') is not None

        second = handler.handle_event(erasure_job(aws, SECOND_JOB, 'email', ADDRESS, legal_basis=BASIS),
                                      worker_context)

        assert second['status'] == 'completed'
        assert people.get_item(Key=index_row, ConsistentRead=True).get('Item') is None
        assert get_person(people, ids[WS], workspace=A) is None
        assert participants.SAVED_PEOPLE not in (_saved(aws) or {})
        job = aws['aggregates'].get_item(Key={'pk': ERASURE_JOB_PK, 'sk': SECOND_JOB})['Item']
        assert (INDEX_KEPT_COUNTER in job, job[runs.PARTICIPANTS_COMPLETE]) == (False, True)


class TestTheIndexAndTheListing:
    def test_the_people_index_query_pages_through(self, aws, people):
        """A page that ends with a LastEvaluatedKey is followed: every page's people are found."""
        ids = _seed(aws, people)
        sent: list[dict[str, Any]] = []
        real = DeploymentTable.query

        def two_pages(self: DeploymentTable, partition_attribute: str, partition: str, **kwargs: Any) -> dict:
            sent.append(kwargs)
            if 'ExclusiveStartKey' not in kwargs:
                return {'Items': [{'pk': 'PERSON#per_dddddddddddddddd'}], 'LastEvaluatedKey': {'pk': 'next'}}
            # The second page: the real index's answer (the made-up cursor is not one the table could read).
            return real(self, partition_attribute, partition,
                        **{name: value for name, value in kwargs.items() if name != 'ExclusiveStartKey'})

        with patch.object(DeploymentTable, 'query', two_pages):
            found = participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS)._people(None)

        assert found == sorted({'per_dddddddddddddddd', ids['deployment']})
        assert [each.get('ExclusiveStartKey') for each in sent] == [None, {'pk': 'next'}]

    def test_the_people_index_query_is_bounded(self, aws, people):
        def endless(_self: DeploymentTable, _attribute: str, _partition: str, **_kwargs: Any) -> dict:
            return {'Items': [], 'LastEvaluatedKey': {'pk': 'next'}}

        with patch.object(DeploymentTable, 'query', endless), pytest.raises(RuntimeError, match='people index'):
            participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS)._people(None)

    def test_without_the_workspaces_table_the_deployments_job_is_not_walked(self, aws, people):
        """Its workspaces' people could not be listed: the job says so, never complete."""
        ids = _seed(aws, people)
        run = _run()
        tables = {'participants': people, 'aggregates': aws['aggregates']}
        cursor: dict[str, Any] | None = None
        for _step in range(20):
            cursor = participants.ParticipantEraser(run, tables, ADDRESS, clock=lambda: NOW).step(cursor)
            if cursor is None:
                break

        assert cursor is None
        assert _gone(people, None, ids['deployment'])
        assert run[runs.PARTICIPANTS_WALKED] is False
        assert runs.participant_fields({**run, 'field': 'email'})[runs.PARTICIPANTS_COMPLETE] is False


class TestTheSavedRow:
    def test_a_failed_jobs_row_lives_its_bounded_ttl(self, aws, people, worker_context):
        _seed(aws, people)
        _cut(lambda: _erase(aws, worker_context))

        now = int(datetime.now(UTC).timestamp())
        ttl = int((_saved(aws) or {})['ttl'])
        assert now + 29 * 86_400 < ttl <= now + int(participants.SAVED_FOR.total_seconds()) + 60

    def test_two_jobs_on_one_address_never_drop_each_others_ids(self, aws, people):
        first = participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS)
        second = participants.ParticipantEraser(_run(job_id=SECOND_JOB), _tables(aws, people), ADDRESS)
        one, two = 'deployment#per_0123456789abcdef', 'deployment#per_fedcba9876543210'

        first._save(None, [one])
        second._save(None, [two])
        first._forget(one)

        assert (_saved(aws) or {})[participants.SAVED_PEOPLE] == {two}

    def test_an_emptied_row_that_is_saved_to_again_keeps_its_long_ttl(self, aws, people):
        """_expire's race: an entry saved meanwhile keeps the row (and its 30-day ttl)."""
        eraser = participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS)
        eraser._save(None, ['deployment#per_0123456789abcdef'])

        eraser._expire(None)

        assert int((_saved(aws) or {})['ttl']) > int(datetime.now(UTC).timestamp()) + 29 * 86_400

    def test_forgetting_on_a_row_that_is_gone_creates_nothing(self, aws, people):
        participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS)._forget(
            f'{WS}#per_0123456789abcdef')

        assert _saved(aws) is None
        assert _saved(aws, A) is None

    def test_the_end_loop_takes_more_than_max_saved_in_turns(self, aws, people):
        ids = [_person(people, f'role{n}@example.com', None) for n in range(3)]
        entries = [f'deployment#{person_id}' for person_id in ids]
        eraser = participants.ParticipantEraser(_run(), _tables(aws, people), ADDRESS)
        eraser._save(None, entries)
        cursor: dict[str, Any] | None = {'ws': [], 'listing_done': True, 'at': {}, workspaces.DEPLOYMENT_DONE: True,
                                         'to_erase': [], 'refused': []}

        with patch.object(participants, 'MAX_SAVED', 2):
            for _step in range(20):
                assert cursor is not None
                assert len(cursor['to_erase']) <= 2
                cursor = eraser.step(cursor)
                if cursor is None:
                    break

        assert cursor is None
        assert all(get_person(people, person_id) is None for person_id in ids)


def test_a_casefold_spelling_is_never_the_guards():
    """'ß' is no letter of the guard's address rule, so no participant holds the address: its casefold spelling
    ('strasse@…'), another person's address, is never erased in its place."""
    assert participants.guard_address('Straße@example.com') is None
    assert 'Straße@example.com'.casefold() == 'strasse@example.com'


def test_a_casefold_neighbour_is_left_alone(aws, people, worker_context):
    neighbour = _person(people, 'strasse@example.com', None)

    _erase(aws, worker_context, 'Straße@example.com')

    assert get_person(people, neighbour) is not None


# ── IAM: every call on voc-participants is one lib/stacks/retention-worker.ts grants ──────────────────────────────

def _value(typed: Mapping[str, Any]) -> str:
    return str(next(iter(typed.values())))


@contextmanager
def recorded_calls(aws) -> Generator[list[tuple[str, str, list[str]]]]:
    """Every call the job sends, as ``(IAM action, table, partition keys)``, from the wire request (the handler's
    resource shares this client): a transaction's and a batch's entries each as their own action."""
    seen: list[tuple[str, str, list[str]]] = []

    def record(model: Any, params: dict[str, Any], **_kwargs: Any) -> None:
        body = json.loads(params.get('body') or b'{}')
        operation = model.name
        if operation == 'TransactWriteItems':
            for entry in body['TransactItems']:
                (kind, request), = entry.items()
                action = {'ConditionCheck': 'ConditionCheckItem', 'Put': 'PutItem', 'Delete': 'DeleteItem',
                          'Update': 'UpdateItem'}[kind]
                keys = request.get('Key') or request.get('Item') or {}
                seen.append((action, request['TableName'], [_value(keys['pk'])]))
        elif operation == 'BatchWriteItem':
            for table, requests in body['RequestItems'].items():
                for request in requests:
                    # A batch's put is its own action here: the job must send none (IAM would allow it).
                    deleted = request.get('DeleteRequest', {}).get('Key')
                    action = operation if deleted is not None else f'{operation}:put'
                    keys = deleted if deleted is not None else request['PutRequest']['Item']
                    seen.append((action, table, [_value(keys['pk'])]))
        elif operation == 'Query':
            # A Query of an index is its own action here (its grant names the index, not the table).
            action = f"Query:{body['IndexName']}" if body.get('IndexName') else operation
            seen.append((action, body['TableName'], [_query_partition(body)]))
        elif operation in ('GetItem', 'PutItem', 'UpdateItem', 'DeleteItem'):
            keys = body.get('Key') or body.get('Item')
            seen.append((operation, body['TableName'], [_value(keys['pk'])]))
            if operation == 'UpdateItem' and body['TableName'] == PARTICIPANTS_TABLE:
                seen.append(('UpdateAttributes', body['TableName'], _update_names(body)))
        else:
            seen.append((operation, str(body.get('TableName')), []))

    events = aws['aggregates'].meta.client.meta.events
    events.register('before-call.dynamodb', record)
    try:
        yield seen
    finally:
        events.unregister('before-call.dynamodb', record)


def _query_partition(body: Mapping[str, Any]) -> str:
    """The partition a Query names (its key condition's ``pk = :value``, through an alias or not)."""
    names = body.get('ExpressionAttributeNames') or {}
    for left, placeholder in re.findall(r'([#\w]+)\s*=\s*(:\w+)', body['KeyConditionExpression']):
        if names.get(left, left) in ('pk', 'gsi1pk'):
            return _value(body['ExpressionAttributeValues'][placeholder])
    raise AssertionError('a Query without a partition')


_FUNCTIONS: Final = re.compile(r'\b(attribute_exists|attribute_not_exists|if_not_exists|begins_with|size)\b')


def _update_names(body: Mapping[str, Any]) -> list[str]:
    """Every attribute an UpdateItem names: its key, its aliases' names and the bare names in its expressions."""
    expressions = ' '.join(str(body.get(name) or '') for name in ('UpdateExpression', 'ConditionExpression'))
    bare = re.findall(r'(?<![#:\w])([a-z_][a-z0-9_]*)\b', _FUNCTIONS.sub(' ', expressions))
    return sorted({*body['Key'], *(body.get('ExpressionAttributeNames') or {}).values(), *bare})


def _granted() -> tuple[dict[str, list[str]], list[str]]:
    """``PARTICIPANT_ACCESS`` as LeadingKeys patterns per action, and ``PARTICIPANT_UPDATE_ATTRIBUTES``, read from
    retention-worker.ts."""
    source = RETENTION_WORKER.read_text(encoding='utf-8')
    one = 'WS#ws_' + '?' * 26 + '#'
    access: dict[str, list[str]] = {}
    found = re.findall(r"\{ actions: \[([^\]]*)\], deployment: \[([^\]]*)\], workspace: \[([^\]]*)\] \}", source)
    assert found
    for actions, deployment, workspace in found:
        for action in re.findall(r"'(\w+)'", actions):
            access.setdefault(action, []).extend([*re.findall(r"'([^']+)'", deployment), *(
                one + part for part in re.findall(r"'([^']+)'", workspace))])
    attributes = re.search(r'const PARTICIPANT_UPDATE_ATTRIBUTES = \[([^\]]*)\]', source)
    assert attributes is not None
    # The people index's Query (its partitions: the deployment's and one workspace id's PEOPLE).
    index = re.search(r"const PARTICIPANT_PEOPLE_INDEX = '([^']+)'", source)
    assert index is not None
    assert "const PARTICIPANT_PEOPLE_INDEX_PARTITIONS = ['PEOPLE', `WS#${WORKSPACE_ID_PATTERN}#PEOPLE`]" in source
    access[f'Query:{index.group(1)}'] = ['PEOPLE', f'{one}PEOPLE']
    return access, re.findall(r"'([^']+)'", attributes.group(1))


def _matches(pattern: str, key: str) -> bool:
    return re.fullmatch(''.join('.*' if c == '*' else '.' if c == '?' else re.escape(c) for c in pattern), key) is not None


def _all_granted(calls: list[tuple[str, str, list[str]]]) -> set[str]:
    """Every recorded call on voc-participants is one the grants allow (and no batch put); the actions seen."""
    access, attributes = _granted()
    on_people = [(action, keys) for action, table, keys in calls if table == PARTICIPANTS_TABLE]
    for action, keys in on_people:
        if action == 'UpdateAttributes':
            assert set(keys) <= set(attributes), keys
            continue
        assert action in access, action
        for key in keys:
            assert any(_matches(pattern, key) for pattern in access[action]), (action, key)
    return {action for action, _keys in on_people}


def test_every_call_on_voc_participants_is_one_iam_grants(aws, people, worker_context):
    """The deployment's person also holds a token and an ask (their deletes and the recipient's update), and the
    workspaces' are unlisted from their index; then every call is checked against the grants, action by action."""
    ids = _seed(aws, people)
    people.update_item(Key=person_key(ids['deployment']), UpdateExpression='ADD token_hashes :t',
                       ExpressionAttributeValues={':t': {'a' * 64}})
    people.put_item(Item={'pk': f"PERSON#{ids['deployment']}", 'sk': 'ASK#ask_0123456789abcdef',
                          'ask_id': 'ask_0123456789abcdef'})
    people.put_item(Item={'pk': 'ASK#ask_0123456789abcdef', 'sk': f"RCPT#{ids['deployment']}",
                          'person_id': ids['deployment'], 'status': 'sent', 'response_token_hash': 'b' * 64})

    with recorded_calls(aws) as calls:
        assert _erase(aws, worker_context)['status'] == 'completed'

    actions = _all_granted(calls)
    # BatchWriteItem's grant would also let a batch put in its partitions (IAM cannot tell a batch's deletes from its
    # puts): the job sends deletes only (a batch's put would be recorded as ``BatchWriteItem:put``, granted by nothing).
    assert actions >= {'GetItem', 'Query', 'Query:gsi1', 'PutItem', 'UpdateItem', 'DeleteItem', 'BatchWriteItem',
                       'ConditionCheckItem', 'UpdateAttributes'}
    recipient = people.get_item(Key={'pk': 'ASK#ask_0123456789abcdef', 'sk': f"RCPT#{ids['deployment']}"})['Item']
    assert 'response_token_hash' not in recipient


def test_finishing_a_cut_erasure_makes_only_granted_calls(aws, people, worker_context):
    """The rerun that finds the people gone reads their partitions and unlists the kept index rows: all granted."""
    _seed(aws, people)
    with patch.object(participants_erasure, 'unlist_if_empty', return_value=False):
        _erase(aws, worker_context)

    with recorded_calls(aws) as calls:
        assert handler.handle_event(erasure_job(aws, SECOND_JOB, 'email', ADDRESS, legal_basis=BASIS),
                                    worker_context)['status'] == 'completed'

    assert _all_granted(calls) >= {'Query', 'ConditionCheckItem', 'DeleteItem'}


@pytest.mark.parametrize(('field', 'value', 'source'), [('email', ADDRESS, None), ('author', 'Partner contact', 'web'),
                                                        ('source', 'web', 'web')])
@pytest.mark.usefixtures('people')
def test_every_call_on_voc_feedback_names_the_table_never_an_index(aws, worker_context, field, value, source):
    """7.72.00 narrowed the worker's feedback grant to the table (no index): each erasure kind's calls on voc-feedback
    are GetItem, Query, Scan or DeleteItem of the table itself."""
    put_feedback(aws, 'f1', metadata={'email': ADDRESS}, author='Partner contact')
    put_workspace_feedback(aws, WS, 'f2', metadata={'email': ADDRESS})
    extra = {'confirm': value} if field == 'source' else {}
    event = erasure_job(aws, JOB_ID, field, value, legal_basis=BASIS, source=source, **extra)
    seen: list[tuple[str, str | None]] = []

    def record(model: Any, params: dict[str, Any], **_kwargs: Any) -> None:
        body = json.loads(params.get('body') or b'{}')
        tables = [body.get('TableName'), *(body.get('RequestItems') or {})]
        if handler.FEEDBACK_TABLE in tables:
            seen.append((model.name, body.get('IndexName')))

    events = aws['feedback'].meta.client.meta.events
    events.register('before-call.dynamodb', record)
    try:
        assert handler.handle_event(event, worker_context)['status'] == 'completed'
    finally:
        events.unregister('before-call.dynamodb', record)

    assert seen
    assert {operation for operation, _index in seen} <= {'GetItem', 'Query', 'Scan', 'DeleteItem'}
    assert [index for _operation, index in seen if index] == []
