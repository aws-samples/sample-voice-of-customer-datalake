"""voc-retention reaches the prototype pins' replies (7.98.00, projects 3g-pin; TENETS.md D5; docs/multi-workspace.md,
the project plan's 3g-pin).

Until 7.48.00 a pin reply named its writer by their username, else their address (api/projects_handler.py
``_pin_actor``); the replies written then (``PINS#{form}`` / ``PIN#{pin}`` in voc-aggregates) may still hold an address.
End to end in moto: an erasure by email replaces a reply's name that is the address with "Team member" in the
deployment's pins and every walked workspace's, found through keys only: each walked project's prototypes
(``PROTOTYPE#`` rows of its partition) and the scope's pin forms (``FORM#pf_…`` of its forms partition, which outlive a
deleted project), never a Scan. A workspace's own erasure reaches its own pins only (``WS#{ws}#PINS#…``, through the
workspace layer); every change is recorded before and after; a pin that keeps changing fails the job; a walk handed
over after every step ends as one that never was.
"""
from __future__ import annotations

import json
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any, Final
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from jobs.retention import deidentify, handler, pins, project_people, runs, workspaces
from jobs.retention.test.conftest import BUCKET, PROJECTS_TABLE, erasure_rows
from jobs.retention.test.test_named_workspace_erasure import _job as _named_job
from jobs.retention.test.test_named_workspace_erasure import _job_row
from jobs.retention.test.test_project_erasure import (
    STAMP,
    A,
    B,
    _erase_by_email,
    _list_workspace,
    _one_row_pages,
    _run,
    _tables,
    _walk_to_the_end,
    deployment_project,
)
from jobs.retention.test.test_workspace_erasure import JOB_ID, WS, WS_TWO, _tombstones
from shared import prototype_pins
from shared.document_comments import MAX_NAME_CHARS, TEAM_MEMBER_NAME
from shared.project_keys import project_pk
from shared.project_writes import create_workspace_project
from shared.retention import MALFORMED_ID_COUNTER, PIN_COUNTER
from shared.ws_repo import OutOfScopeError, WorkspaceScope

#: The erased address, written as a reply's name before 7.48.00, and another member's.
REVIEWER: Final = 'rae@partner.example'
OTHER: Final = 'sam@partner.example'
#: The deployment's projects: a live one with two prototypes (the second's pin form deleted from the forms page), and a
#: deleted one whose prototype rows its delete swept, leaving its pin form and pins.
DEP_LIVE, DEP_GONE = 'proj_pin_000001', 'proj_pin_gone_000002'
#: The workspaces' projects (A's and B's).
WS_LIVE, WS_GONE, ELSEWHERE = 'proj_wspin_000003', 'proj_wspin_gone_000004', 'proj_wspin_b_000005'
PIN_ONE: Final = 'pin_20251101090000000001a1b2c3'
PIN_TWO: Final = 'pin_20251101090000000002a1b2c4'


def _reply(name: str, text: str, by: str = 'sub-rae') -> dict[str, Any]:
    """A reply as the projects API wrote it before 7.48.00 (``name`` the username, else the address)."""
    return {'by': by, 'name': name, 'text': text, 'at': STAMP}


def _ai_reply() -> dict[str, Any]:
    return {'by': prototype_pins.REPLY_KIND_AI, 'name': 'AI', 'text': 'Not done: needs data.', 'at': STAMP,
            'kind': prototype_pins.REPLY_KIND_AI, 'approved_by': {'sub': 'sub-lead', 'kind': 'user'}, 'id': 'r1'}


def _pins_pk(document_id: str, scope: WorkspaceScope | None) -> str:
    return prototype_pins.pins_pk(prototype_pins.pin_form_id(document_id), workspace=scope)


def _put_pins(aws, document_id: str, scope: WorkspaceScope | None, address: str = REVIEWER) -> None:
    """Two pins of the prototype ``document_id``: one whose thread holds a reply named by ``address`` beside a member's
    reply by username and an AI's, one whose replies name nobody by address."""
    pk = _pins_pk(document_id, scope)
    form_id = prototype_pins.pin_form_id(document_id)
    for pin_id, replies in ((PIN_ONE, [_reply(address, 'Will fix it.'), _reply('lead', 'Thanks', 'sub-lead'),
                                      _ai_reply()]),
                            (PIN_TWO, [_reply('lead', 'Done', 'sub-lead')])):
        aws['aggregates'].put_item(Item={'pk': pk, 'sk': f'PIN#{pin_id}', 'pin_id': pin_id, 'form_id': form_id,
                                         'comment': 'The button is hidden', 'status': 'open', 'flagged': False,
                                         'created_at': STAMP, 'updated_at': STAMP, 'replies': replies})


def _pin_form(aws, project_id: str, document_id: str, scope: WorkspaceScope | None) -> None:
    """The prototype's pin form row, as the document generator writes it (``pin_form_item``), in the scope's forms
    partition."""
    item = prototype_pins.pin_form_item(project_id, document_id, 'Checkout', STAMP)
    aws['aggregates'].put_item(Item={**item, 'pk': prototype_pins.pin_forms_pk(workspace=scope)})


def _prototype(aws, project_id: str, document_id: str, scope: WorkspaceScope | None) -> None:
    aws['projects'].put_item(Item={'pk': project_pk(project_id, workspace=scope), 'sk': f'PROTOTYPE#{document_id}',
                                   'document_id': document_id, 'document_type': 'prototype', 'title': 'Checkout'})


def _workspace_project(aws, project_id: str, scope: WorkspaceScope) -> None:
    create_workspace_project(aws['projects'], {'pk': project_pk(project_id, workspace=scope), 'sk': 'META',
                                               'project_id': project_id, 'created_at': STAMP}, workspace=scope)


def _seed(aws) -> None:
    """The deployment's pins (three prototypes: one with its form, one whose form was deleted, one of a deleted project
    whose prototype rows are gone) and A's and B's (a live project's prototype; in A also a pin form whose project was
    deleted), both workspaces listed. A dashboard form beside the pin forms."""
    deployment_project(aws, DEP_LIVE)
    deployment_project(aws, DEP_GONE, status='deleted', deleted_at=STAMP)
    for document_id in ('doc_live', 'doc_formless'):
        _prototype(aws, DEP_LIVE, document_id, None)
        _put_pins(aws, document_id, None)
    _pin_form(aws, DEP_LIVE, 'doc_live', None)
    _pin_form(aws, DEP_GONE, 'doc_gone', None)
    _put_pins(aws, 'doc_gone', None)
    aws['aggregates'].put_item(Item={'pk': 'FEEDBACK_FORM', 'sk': 'FORM#fd_' + '0' * 32, 'form_id': 'fd_' + '0' * 32,
                                     'name': 'Website'})
    _list_workspace(aws, WS, 'Alpha')
    _list_workspace(aws, WS_TWO, 'Beta')
    for project_id, scope in ((WS_LIVE, A), (ELSEWHERE, B)):
        _workspace_project(aws, project_id, scope)
        _prototype(aws, project_id, f'doc_{project_id}', scope)
        _put_pins(aws, f'doc_{project_id}', scope)
    _pin_form(aws, WS_GONE, 'doc_ws_gone', A)
    _put_pins(aws, 'doc_ws_gone', A)


def _replies(aws, document_id: str, scope: WorkspaceScope | None, pin_id: str = PIN_ONE) -> list[dict[str, Any]]:
    item = aws['aggregates'].get_item(Key={'pk': _pins_pk(document_id, scope), 'sk': f'PIN#{pin_id}'})['Item']
    return item['replies']


def _erased(aws, document_id: str, scope: WorkspaceScope | None) -> bool:
    """Whether the prototype's first pin's first reply lost the address (its text and the other replies kept)."""
    first, member, ai = _replies(aws, document_id, scope)
    assert (first['text'], first['by'], member, ai) == ('Will fix it.', 'sub-rae', _reply('lead', 'Thanks', 'sub-lead'),
                                                       _ai_reply())
    return first['name'] == TEAM_MEMBER_NAME


#: Every prototype the seed gives pins, by scope.
DEPLOYMENT_DOCS: Final = ('doc_live', 'doc_formless', 'doc_gone')
A_DOCS: Final = (f'doc_{WS_LIVE}', 'doc_ws_gone')
B_DOCS: Final = (f'doc_{ELSEWHERE}',)


@contextmanager
def scans(aws) -> Generator[list[str]]:
    """Every Scan the job sends to voc-projects or voc-aggregates, by table name."""
    seen: list[str] = []
    names = {aws['projects'].name, aws['aggregates'].name}

    def record(params: dict[str, Any], **_kwargs: Any) -> None:
        if params.get('TableName') in names:
            seen.append(str(params['TableName']))

    events = aws['aggregates'].meta.client.meta.events
    events.register('provide-client-params.dynamodb.Scan', record)
    try:
        yield seen
    finally:
        events.unregister('provide-client-params.dynamodb.Scan', record)


@pytest.fixture
def projects_env(monkeypatch):
    monkeypatch.setenv('PROJECTS_TABLE', PROJECTS_TABLE)


@pytest.mark.usefixtures('projects_env')
class TestTheDeploymentsErasureReachesEveryPinReply:
    def test_a_reply_named_by_the_address_becomes_team_member_in_every_scope(self, aws, worker_context):
        _seed(aws)

        result = _erase_by_email(aws, worker_context, REVIEWER.upper(), job_id=JOB_ID)

        assert result['status'] == 'completed'
        # The deployment's prototypes, the one whose form is gone and the deleted project's (by its form), and every
        # listed workspace's.
        assert [_erased(aws, doc, None) for doc in DEPLOYMENT_DOCS] == [True] * 3
        assert [_erased(aws, doc, A) for doc in A_DOCS] == [True, True]
        assert [_erased(aws, doc, B) for doc in B_DOCS] == [True]
        # A pin whose replies name nobody by address is left as it was.
        assert _replies(aws, 'doc_live', None, PIN_TWO) == [_reply('lead', 'Done', 'sub-lead')]
        assert result[PIN_COUNTER] == 6
        job, audit = erasure_rows(aws, JOB_ID)
        assert job[PIN_COUNTER] == audit[PIN_COUNTER] == 6
        # A walk begun under 7.98.00 says it reached every pin (the rerun rule reads it, round 1, fp-3).
        assert job[runs.PINS_WALKED] is audit[runs.PINS_WALKED] is True

    def test_a_walk_carried_across_the_upgrade_never_says_it_walked_the_pins(self, aws):
        _seed(aws)
        run = _run()
        eraser = project_people.ProjectPeopleEraser(run, _tables(aws), REVIEWER, aws['s3'], BUCKET)
        # A 7.97.00 hand-over: its deployment walk under way, without the mark a walk begun under 7.98.00 carries.
        cursor = {**workspaces.start(run, eraser._clock), project_people.DEPLOYMENT: {}}
        for _step in range(2000):
            cursor = eraser.step(cursor)
            if cursor is None:
                break
        assert run[runs.DEPLOYMENT_WALKED] is True
        assert runs.PINS_WALKED not in run
        assert runs.deployment_fields({**run, 'field': 'email'})[runs.PINS_WALKED] is False

    def test_the_pins_are_found_by_keys_and_nothing_is_scanned(self, aws, worker_context):
        _seed(aws)
        with scans(aws) as scanned:
            _erase_by_email(aws, worker_context)
        assert scanned == []

    def test_a_long_address_cut_to_the_name_length_still_matches(self, aws, worker_context):
        address = 'r' * 130 + '@partner.example'
        deployment_project(aws, DEP_LIVE)
        _prototype(aws, DEP_LIVE, 'doc_live', None)
        _put_pins(aws, 'doc_live', None, address[:MAX_NAME_CHARS])

        _erase_by_email(aws, worker_context, address)

        assert _erased(aws, 'doc_live', None)

    def test_each_change_is_recorded_before_and_after_without_the_address(self, aws, worker_context):
        _seed(aws)

        _erase_by_email(aws, worker_context)

        deployment = {sk: row for sk, row in _tombstones(aws, project_people.STORE_DEPLOYMENT_PROJECTS).items()
                      if row['kind'] == pins.KIND}
        workspace = {sk: row for sk, row in _tombstones(aws, project_people.STORE_PROJECTS).items()
                     if row['kind'] == pins.KIND}
        form = prototype_pins.pin_form_id('doc_live')
        assert {row['action'] for row in deployment.values()} == {'deidentifying', 'deidentified'}
        assert f'pin#{form}#{PIN_ONE}#{JOB_ID}' in deployment
        assert f'pin#{form}#{PIN_ONE}#{JOB_ID}#done' in deployment
        # Three of the deployment's pins and three of the workspaces', each recorded twice; a workspace's names it.
        assert (len(deployment), len(workspace)) == (6, 6)
        assert {row['workspace_id'] for row in workspace.values()} == {WS, WS_TWO}
        # The workspaces share one record partition: a workspace's record key names it first (round 1, q-rec).
        assert {tuple(sk.split('#')[:2]) for sk in workspace} == {(WS, pins.KIND), (WS_TWO, pins.KIND)}
        assert all('workspace_id' not in row for row in deployment.values())
        assert REVIEWER not in json.dumps([*deployment.values(), *workspace.values()], default=str)

    def test_an_erasure_that_matches_nothing_changes_no_pin(self, aws, worker_context):
        _seed(aws)
        before = sorted(aws['aggregates'].scan()['Items'], key=lambda row: (row['pk'], row['sk']))
        pins_before = [row for row in before if 'PINS#' in str(row['pk'])]

        result = _erase_by_email(aws, worker_context, 'nobody@example.com')

        after = sorted(aws['aggregates'].scan()['Items'], key=lambda row: (row['pk'], row['sk']))
        assert [row for row in after if 'PINS#' in str(row['pk'])] == pins_before
        assert PIN_COUNTER not in result

    def test_a_pin_that_keeps_changing_fails_the_job(self, aws, worker_context):
        _seed(aws)
        with patch.object(pins.PinReplyEraser, '_write', return_value=False) as write:
            result = _erase_by_email(aws, worker_context)
        assert result['status'] == 'failed'
        assert write.call_count == deidentify.MAX_TRIES
        job, audit = erasure_rows(aws, JOB_ID)
        assert (job['error'], audit['error']) == ('Run failed (RowKeptChanging)',) * 2

    def test_a_reply_landing_between_the_read_and_the_write_is_caught_by_the_reread(self, aws, worker_context):
        deployment_project(aws, DEP_LIVE)
        _prototype(aws, DEP_LIVE, 'doc_live', None)
        _put_pins(aws, 'doc_live', None)
        form = prototype_pins.pin_form_id('doc_live')
        real, raced = pins.PinReplyEraser._write, []

        def racing(self, scope, row, replies):
            if not raced:
                raced.append(True)
                prototype_pins.append_reply(aws['aggregates'], form, PIN_ONE, _reply(REVIEWER, 'One more.'))
            return real(self, scope, row, replies)

        with patch.object(pins.PinReplyEraser, '_write', racing):
            _erase_by_email(aws, worker_context)

        assert raced == [True]
        assert [reply['name'] for reply in _replies(aws, 'doc_live', None)] == [
            TEAM_MEMBER_NAME, 'lead', 'AI', TEAM_MEMBER_NAME]


@pytest.mark.usefixtures('projects_env')
class TestTheWorkspaceBoundary:
    def test_a_workspaces_own_erasure_reaches_its_own_pins_only(self, aws, worker_context):
        _seed(aws)

        handler.handle_event(_named_job(aws, 'email', REVIEWER), worker_context)

        assert [_erased(aws, doc, A) for doc in A_DOCS] == [True, True]
        assert [_erased(aws, doc, B) for doc in B_DOCS] == [False]
        assert [_erased(aws, doc, None) for doc in DEPLOYMENT_DOCS] == [False] * 3
        assert _job_row(aws)[PIN_COUNTER] == 2

    def test_the_deployments_walk_never_writes_a_workspaces_pin(self, aws):
        eraser = pins.PinReplyEraser(_run(), aws['aggregates'], REVIEWER, record=MagicMock())
        row = {'pk': _pins_pk('doc_x', A), 'sk': f'PIN#{PIN_ONE}', 'replies': [_reply(REVIEWER, 'x')]}
        with pytest.raises(OutOfScopeError):
            eraser.erase(None, row, prototype_pins.pin_form_id('doc_x'))

    def test_a_workspaces_walk_never_reads_another_scopes_pins(self, aws):
        eraser = pins.PinReplyEraser(_run(), aws['aggregates'], REVIEWER, record=MagicMock())
        with pytest.raises(OutOfScopeError):
            eraser.erase(A, {'pk': _pins_pk('doc_x', B), 'sk': f'PIN#{PIN_ONE}',
                             'replies': [_reply(REVIEWER, 'x')]}, prototype_pins.pin_form_id('doc_x'))


@pytest.mark.usefixtures('projects_env')
class TestTheWrites:
    def test_a_page_cut_when_time_runs_low_resumes_after_the_pin_it_wrote(self, aws):
        """Round 1, q-resume: two pins a page, the time running out after the first."""
        _put_pins(aws, 'doc_live', None)
        aws['aggregates'].put_item(Item={**aws['aggregates'].get_item(
            Key={'pk': _pins_pk('doc_live', None), 'sk': f'PIN#{PIN_ONE}'})['Item'], 'sk': f'PIN#{PIN_TWO}'})
        form = prototype_pins.pin_form_id('doc_live')
        written: list[str] = []
        real = pins.PinReplyEraser._write

        def write(self, scope, row, replies):
            written.append(str(row['sk']))
            return real(self, scope, row, replies)

        left = iter([False])
        eraser = pins.PinReplyEraser(_run(), aws['aggregates'], REVIEWER, record=MagicMock(),
                                     time_left=lambda: next(left, True))
        with patch.object(pins, 'PIN_PAGE', 2), patch.object(pins.PinReplyEraser, '_write', write):
            start, done = eraser.pin_page(None, form, None)
            assert (start, done) == ({'pk': _pins_pk('doc_live', None), 'sk': f'PIN#{PIN_ONE}'}, False)
            assert written == [f'PIN#{PIN_ONE}']
            following, done = eraser.pin_page(None, form, start)
        assert (following, done, written) == (None, True, [f'PIN#{PIN_ONE}', f'PIN#{PIN_TWO}'])
        assert _erased(aws, 'doc_live', None)
        assert _replies(aws, 'doc_live', None, PIN_TWO)[0]['name'] == TEAM_MEMBER_NAME

    def test_a_pin_gone_before_its_write_is_left_alone(self, aws):
        record = MagicMock()
        eraser = pins.PinReplyEraser(_run(), aws['aggregates'], REVIEWER, record=record)
        row = {'pk': _pins_pk('doc_x', None), 'sk': f'PIN#{PIN_ONE}', 'replies': [_reply(REVIEWER, 'x')]}

        eraser.erase(None, row, prototype_pins.pin_form_id('doc_x'))

        assert 'Item' not in aws['aggregates'].get_item(Key={'pk': row['pk'], 'sk': row['sk']})
        assert PIN_COUNTER not in eraser.run
        assert [call.args[2] for call in record.call_args_list] == ['deidentifying']

    def test_any_other_failure_is_raised(self, aws):
        view = MagicMock()
        view.update_item.side_effect = ClientError({'Error': {'Code': 'ValidationException', 'Message': 'x'}},
                                                   'UpdateItem')
        eraser = pins.PinReplyEraser(_run(), aws['aggregates'], REVIEWER, record=MagicMock())
        row = {'pk': _pins_pk('doc_x', None), 'sk': f'PIN#{PIN_ONE}', 'replies': [_reply(REVIEWER, 'x')]}
        with patch.object(pins, 'table_view', return_value=view), pytest.raises(ClientError):
            eraser.erase(None, row, prototype_pins.pin_form_id('doc_x'))

    @pytest.mark.parametrize('replies', [None, 'text', [], [_reply('lead', 'x')], ['not a reply'],
                                         [{'name': 7}], [{'text': 'no name'}]])
    def test_replies_that_name_nobody_by_the_address_change_nothing(self, replies):
        assert pins.replies_without(replies, REVIEWER) is None

    def test_each_scope_has_its_own_pins_and_forms_partitions(self):
        form = prototype_pins.pin_form_id('doc_x')
        assert (prototype_pins.pins_pk(form, workspace=None), prototype_pins.pins_pk(form, workspace=A)) == (
            f'PINS#{form}', f'WS#{WS}#PINS#{form}')
        assert (prototype_pins.pin_forms_pk(workspace=None), prototype_pins.pin_forms_pk(workspace=B)) == (
            'FEEDBACK_FORM', f'WS#{WS_TWO}#FEEDBACK_FORM')
        assert prototype_pins.pin_key(form, PIN_ONE, workspace=None) == {'pk': f'PINS#{form}', 'sk': f'PIN#{PIN_ONE}'}

    def test_only_the_name_is_replaced_and_every_other_field_kept(self):
        reply = {**_reply(f' {REVIEWER.upper()} ', 'Text'), 'id': 'r2'}
        assert pins.replies_without([reply], REVIEWER) == [{**reply, 'name': TEAM_MEMBER_NAME}]

    def test_the_write_names_only_the_replies_and_conditions_on_them(self, aws):
        sent: list[dict[str, Any]] = []
        client = aws['aggregates'].meta.client

        def record(params: dict[str, Any], **_kwargs: Any) -> None:
            sent.append(params)

        client.meta.events.register('provide-client-params.dynamodb.UpdateItem', record)
        deployment_project(aws, DEP_LIVE)
        _prototype(aws, DEP_LIVE, 'doc_live', None)
        _put_pins(aws, 'doc_live', None)
        eraser = pins.PinReplyEraser(_run(), aws['aggregates'], REVIEWER, record=MagicMock())
        row = aws['aggregates'].get_item(Key={'pk': _pins_pk('doc_live', None), 'sk': f'PIN#{PIN_ONE}'})['Item']

        eraser.erase(None, row, prototype_pins.pin_form_id('doc_live'))

        [update] = sent
        assert set(update['ExpressionAttributeNames'].values()) == {'replies'}
        assert update['ConditionExpression'] == 'attribute_exists(pk) AND #r = :old'
        assert 'ReturnValues' not in update
        assert eraser.run[PIN_COUNTER] == 1


def _aggregates_rows(aws) -> list[dict[str, Any]]:
    """Every pin and every pin record, without a record's time and run."""
    rows = [{name: value for name, value in row.items() if name not in ('deleted_at', 'run_id')}
            for row in aws['aggregates'].scan()['Items']
            if 'PINS#' in str(row['pk']) or row.get('kind') == pins.KIND]
    return sorted(rows, key=lambda row: (str(row['pk']), str(row['sk'])))


@pytest.mark.usefixtures('projects_env')
class TestTheWalkHandsOver:
    def test_a_walk_resumed_after_every_step_ends_as_one_that_never_was(self, aws):
        _seed(aws)
        tables = ('projects', 'aggregates')
        before = {name: aws[name].scan()['Items'] for name in tables}
        one_run, _steps = _walk_to_the_end(aws, hand_over_each_step=False)
        expected = _aggregates_rows(aws)
        for name in tables:
            for row in aws[name].scan()['Items']:
                aws[name].delete_item(Key={'pk': row['pk'], 'sk': row['sk']})
            for row in before[name]:
                aws[name].put_item(Item=row)
        first, second, third = _one_row_pages()

        with first, second, third, patch.multiple(pins, PIN_PAGE=1, ID_PAGE=1), \
                patch.object(deidentify, 'ID_PAGE', 1):
            run, steps = _walk_to_the_end(aws, hand_over_each_step=True)

        assert steps > 40
        assert _aggregates_rows(aws) == expected
        assert run[PIN_COUNTER] == one_run[PIN_COUNTER] == 6

    @pytest.mark.parametrize(('at', 'state'), [
        ({'links_done': True, 'ids': [WS_LIVE], 'part': 'pins'}, 'prototypes'),
        ({'links_done': True, 'ids': [WS_LIVE], 'part': 'pins', 'prototypes': ['pf_' + 'a' * 16]}, 'prototype_pins'),
        ({'links_done': True, 'registry_done': True, 'library': True, 'documents_library_done': True},
         'pin_form_pages'),
        ({'links_done': True, 'registry_done': True, 'library': True, 'documents_library_done': True,
          'pin_forms': ['pf_' + 'a' * 16]}, 'pin_forms'),
        ({'links_done': True, 'registry_done': True, 'library': True, 'documents_library_done': True,
          'pin_forms_done': True}, 'done'),
    ])
    def test_each_hand_made_workspace_cursor_names_its_step(self, at, state):
        assert project_people.ProjectPeopleEraser.state(at) == state

    @pytest.mark.parametrize(('at', 'state'), [
        ({'links_done': True, 'pairs_done': True, 'ids': [DEP_LIVE], 'part': 'pins'}, 'prototypes'),
        ({'links_done': True, 'pairs_done': True, 'ids': [DEP_LIVE], 'part': 'pins',
          'prototypes': ['pf_' + 'a' * 16]}, 'prototype_pins'),
        ({'links_done': True, 'pairs_done': True, 'projects_done': True, 'library': True,
          'documents_library_done': True}, 'pin_form_pages'),
        ({'links_done': True, 'pairs_done': True, 'projects_done': True, 'library': True,
          'documents_library_done': True, 'pin_forms_done': True}, 'done'),
    ])
    def test_each_hand_made_deployment_cursor_names_its_step(self, at, state):
        assert project_people.ProjectPeopleEraser.deployment_state(at) == state

    @pytest.mark.parametrize('at', [
        {'links_done': True, 'ids': [WS_LIVE], 'part': 'pins', 'prototypes': ['not-a-form']},
        {'links_done': True, 'registry_done': True, 'library': True, 'documents_library_done': True,
         'pin_forms': ['pf_' + 'a' * 16] * 101},
    ])
    def test_a_carried_form_id_of_the_wrong_shape_fails_the_step(self, aws, at):
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER, aws['s3'], BUCKET)
        with pytest.raises(ValueError, match='not a page of ids'):
            eraser.step({'ws': [WS], 'listing_done': True, 'deployment_done': True, 'at': at})

    def test_a_prototype_id_not_shaped_like_one_is_counted_not_read(self, aws, worker_context):
        deployment_project(aws, DEP_LIVE)
        aws['projects'].put_item(Item={'pk': project_pk(DEP_LIVE, workspace=None), 'sk': 'PROTOTYPE#bad#id'})

        result = _erase_by_email(aws, worker_context)

        assert result[MALFORMED_ID_COUNTER] == 1
