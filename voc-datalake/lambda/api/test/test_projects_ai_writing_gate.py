"""The way-of-working gate on the Projects API (docs/ways-of-working.md → Enforcement).

Every route is driven through ``projects_handler.lambda_handler`` against moto projects
and aggregates tables; the person's mode is a real ``USERFLAGS#{sub}/ai_mode`` row. Only
the job starts are doubled (``create_job`` / the generator invoke, or the assist twin's
invoke), so a refusal can show that nothing was started.

conftest's autouse ``_ai_driven_by_default`` patches ``shared.ai_mode.get_ai_mode``; these
tests are about that read, so they put the real one back.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from assist_worker_fixtures import inline_assist_worker
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import pk_sk_table

import projects
import projects_handler
from shared import ai_mode
from shared.ai_writing import AUTONOMOUS_REFUSAL_PREFIX
from shared.human_documents import create_human_document
from shared.indexes import PROJECTS_BY_TYPE_INDEX
from shared.test.moto_tables import create_pk_sk_table

REAL_GET_AI_MODE = ai_mode.get_ai_mode
PROJECT = 'proj-gate'
OWNER_SUB = 'owner-sub'
ADA = {'sub': 'sub-ada', 'cognito:groups': 'users', 'email': 'ada@example.com', 'cognito:username': 'ada'}
OWNER = {'sub': OWNER_SUB, 'cognito:groups': 'users', 'email': 'olivia@example.com', 'cognito:username': 'olivia'}
AGENT_FOR_ADA = {'sub': 'agent:ag_1', 'cognito:groups': '', 'email': 'agent:ag_1', 'voc:acting_subject': 'sub-ada'}
MCP_FOR_ADA = {'sub': 'mcp:tok_1', 'voc:acting_subject': 'sub-ada'}
PLAN_FOR_ADA = {**ADA, 'voc:principal': 'plan:pl_1'}
HD_PRD_COACHING = ('You work Human-driven on PRDs: you write, the AI coaches. Use "Coach me" or '
                   '"Review my draft", or ask an administrator to unlock "PRD with AI".')
HD_PRFAQ_COACHING = HD_PRD_COACHING.replace('PRD', 'PR/FAQ')


@dataclass
class World:
    projects_table: Any
    aggregates_table: Any
    create_job: MagicMock
    invoke: MagicMock

    def set_mode(self, sub: str, mode: str, **unlocks: bool) -> None:
        self.aggregates_table.put_item(Item={**ai_mode.ai_mode_key(sub), 'mode': mode, **unlocks})

    def documents(self) -> list[dict]:
        items = self.projects_table.scan()['Items']
        return [i for i in items if i.get('document_id') and str(i['sk']).startswith(('PRD#', 'PRFAQ#', 'DOC#'))]


@pytest.fixture
def world() -> Iterator[World]:
    with mock_aws():
        projects_table = pk_sk_table('test-projects', gsi1_index=PROJECTS_BY_TYPE_INDEX)
        aggregates_table = create_pk_sk_table('test-aggregates')
        projects_table.put_item(Item={
            'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT, 'name': 'Checkout',
            'owner_sub': OWNER_SUB, 'visibility': 'public', 'document_count': 0,
        })
        with (
            patch('shared.ai_mode.get_ai_mode', REAL_GET_AI_MODE),
            patch.object(projects_handler, 'get_projects_table', return_value=projects_table),
            patch.object(projects, 'projects_table', projects_table),
            patch.object(projects_handler, 'get_aggregates_table', return_value=aggregates_table),
            patch('shared.tables.get_aggregates_table', return_value=aggregates_table),
            patch.object(projects_handler, 'create_job', return_value=('job-1', {})) as create_job,
            patch.object(projects_handler, 'invoke_lambda_async') as invoke,
            patch.dict('os.environ', {'DOCUMENT_STATE_MACHINE_ARN': ''}),
        ):
            yield World(projects_table, aggregates_table, create_job, invoke)


@pytest.fixture
def call(api_gateway_event, lambda_context) -> Callable[..., tuple[int, dict]]:
    def _call(claims: dict, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        response = projects_handler.lambda_handler(
            api_gateway_event(method=method, path=path, body=body, claims=claims), lambda_context)
        return response['statusCode'], json.loads(response['body'])
    return _call


def _generate(call, claims: dict, doc_type: str = 'prd') -> tuple[int, dict]:
    return call(claims, 'POST', f'/projects/{PROJECT}/document', {'doc_type': doc_type, 'title': 'Checkout'})


def _a_prd(world: World) -> dict:
    return create_human_document(world.projects_table, PROJECT, 'prd', {'title': 'Checkout', 'create_id': 'seed'},
                                 creator_sub='sub-ada')


def _assert_nothing_started(world: World) -> None:
    world.create_job.assert_not_called()
    world.invoke.assert_not_called()


class TestGeneratingAsAPerson:
    def test_a_human_driven_person_cannot_have_the_ai_write_a_prd_and_nothing_is_started(self, world, call):
        world.set_mode('sub-ada', 'human_driven')

        status, body = _generate(call, ADA)

        assert (status, body['error']) == (403, HD_PRD_COACHING)
        _assert_nothing_started(world)

    def test_a_human_driven_person_cannot_have_the_ai_write_a_prfaq(self, world, call):
        world.set_mode('sub-ada', 'human_driven', ai_writing_prd=True)

        status, body = _generate(call, ADA, 'prfaq')

        assert (status, body['error']) == (403, HD_PRFAQ_COACHING)
        _assert_nothing_started(world)

    def test_an_unlocked_prd_is_generated_for_a_human_driven_person(self, world, call):
        world.set_mode('sub-ada', 'human_driven', ai_writing_prd=True)

        status, body = _generate(call, ADA)

        assert status == 200
        assert body['job_id'] == 'job-1'
        assert world.create_job.call_args.args[1] == 'generate_prd'
        world.invoke.assert_called_once()

    @pytest.mark.parametrize('mode', ['ai_assisted', 'ai_driven'])
    def test_an_assisted_or_driven_person_generates_in_the_editor(self, world, call, mode):
        world.set_mode('sub-ada', mode)

        status, _ = _generate(call, ADA, 'prfaq')

        assert status == 200
        world.create_job.assert_called_once()

    def test_a_person_without_a_row_works_ai_driven(self, world, call):
        status, _ = _generate(call, ADA)

        assert status == 200
        world.create_job.assert_called_once()

    def test_a_person_is_not_held_back_by_a_human_driven_project_owner(self, world, call):
        world.set_mode(OWNER_SUB, 'human_driven')
        world.set_mode('sub-ada', 'ai_assisted')

        status, _ = _generate(call, ADA)

        assert status == 200

    def test_an_unreadable_mode_row_refuses_and_starts_nothing(self, world, call):
        failing = MagicMock(side_effect=ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'x'}},
                                                    'GetItem'))
        with patch('shared.ai_mode.get_ai_mode', failing):
            status, body = _generate(call, ADA)

        assert (status, body['error']) == (403, 'Could not check your way of working with AI. Please retry.')
        _assert_nothing_started(world)


class TestGeneratingAutonomously:
    @pytest.mark.parametrize('claims', [AGENT_FOR_ADA, MCP_FOR_ADA, PLAN_FOR_ADA], ids=['agent', 'mcp', 'plan'])
    def test_an_ai_assisted_person_gets_no_agent_or_plan_writing(self, world, call, claims):
        world.set_mode('sub-ada', 'ai_assisted')

        status, body = _generate(call, claims)

        assert status == 403
        assert body['error'].startswith(f'{AUTONOMOUS_REFUSAL_PREFIX} PRD ')
        _assert_nothing_started(world)

    def test_an_unlocked_type_is_still_not_written_by_an_agent(self, world, call):
        world.set_mode('sub-ada', 'human_driven', ai_writing_prd=True)

        status, body = _generate(call, AGENT_FOR_ADA)

        assert status == 403
        assert body['error'].startswith(AUTONOMOUS_REFUSAL_PREFIX)
        _assert_nothing_started(world)

    def test_an_ai_driven_person_is_refused_when_the_project_owner_is_human_driven(self, world, call):
        world.set_mode('sub-ada', 'ai_driven')
        world.set_mode(OWNER_SUB, 'human_driven')

        status, body = _generate(call, AGENT_FOR_ADA)

        assert status == 403
        assert body['error'].startswith(AUTONOMOUS_REFUSAL_PREFIX)
        _assert_nothing_started(world)

    def test_an_agent_writes_when_its_person_and_the_owner_are_both_ai_driven(self, world, call):
        world.set_mode('sub-ada', 'ai_driven')
        world.set_mode(OWNER_SUB, 'ai_driven')

        status, body = _generate(call, AGENT_FOR_ADA)

        assert status == 200
        assert body['job_id'] == 'job-1'

    def test_an_agent_acting_for_the_owner_checks_the_owner_once(self, world, call):
        world.set_mode(OWNER_SUB, 'ai_driven')
        agent_for_owner = {**AGENT_FOR_ADA, 'voc:acting_subject': OWNER_SUB}

        status, _ = _generate(call, agent_for_owner)

        assert status == 200

    def test_an_agent_with_no_person_is_refused(self, world, call):
        status, body = _generate(call, {**AGENT_FOR_ADA, 'voc:acting_subject': ''})

        assert status == 403
        assert body['error'].startswith(f'{AUTONOMOUS_REFUSAL_PREFIX} PRD ')
        _assert_nothing_started(world)


class TestOtherGatedRoutes:
    def test_merging_into_a_prd_is_refused_for_a_human_driven_person(self, world, call):
        world.set_mode('sub-ada', 'human_driven')

        status, body = call(ADA, 'POST', f'/projects/{PROJECT}/documents/merge',
                            {'output_type': 'prd', 'document_ids': ['d1', 'd2'], 'title': 'Merged'})

        assert (status, body['error']) == (403, HD_PRD_COACHING)
        _assert_nothing_started(world)

    def test_merging_into_a_custom_document_is_not_gated(self, world, call):
        world.set_mode('sub-ada', 'human_driven')

        status, _ = call(ADA, 'POST', f'/projects/{PROJECT}/documents/merge',
                         {'output_type': 'custom', 'document_ids': ['d1', 'd2'], 'title': 'Merged'})

        assert status == 200
        world.create_job.assert_called_once()

    def test_pursuing_a_decision_is_refused_before_the_decision_is_read(self, world, call):
        world.set_mode('sub-ada', 'human_driven', ai_writing_prd=True)

        with patch.object(projects_handler.decision_records, 'stored_decision') as stored:
            status, body = call(ADA, 'POST', f'/projects/{PROJECT}/decisions/doc_1/pursue', {})

        assert (status, body['error']) == (403, HD_PRFAQ_COACHING)
        stored.assert_not_called()
        _assert_nothing_started(world)

    @pytest.mark.parametrize(('path', 'body', 'message'), [
        ('prfaq-autofill', {'title': 'T'}, HD_PRFAQ_COACHING),
        ('documents/suggest-brief', {'doc_type': 'prfaq'}, HD_PRFAQ_COACHING),
        ('documents/suggest-brief', {'doc_type': 'prd'}, HD_PRD_COACHING),
        ('documents/suggest-brief', {}, HD_PRD_COACHING),
    ])
    def test_the_drafting_assists_are_refused_for_a_human_driven_person(
            self, world, call, lambda_context, path, body, message):
        world.set_mode('sub-ada', 'human_driven')

        with inline_assist_worker(projects_handler, lambda_context, run_worker=False) as assist:
            status, decoded = call(ADA, 'POST', f'/projects/{PROJECT}/{path}', body)
            jobs = assist.table.scan()['Items']

        assert (status, decoded['error']) == (403, message)
        assist.invoke.assert_not_called()
        assert jobs == []

    def test_an_unlocked_brief_is_drafted_for_a_human_driven_person(self, world, call, lambda_context):
        world.set_mode('sub-ada', 'human_driven', ai_writing_prd=True)

        with inline_assist_worker(projects_handler, lambda_context, run_worker=False) as assist:
            status, decoded = call(ADA, 'POST', f'/projects/{PROJECT}/documents/suggest-brief', {'doc_type': 'prd'})

        assert status == 202
        assert decoded['status'] == 'pending'
        assist.invoke.assert_called_once()

    def test_research_questions_are_not_gated(self, world, call, lambda_context):
        world.set_mode('sub-ada', 'human_driven')

        with inline_assist_worker(projects_handler, lambda_context, run_worker=False) as assist:
            status, _ = call(ADA, 'POST', f'/projects/{PROJECT}/research/suggest-questions', {})

        assert status == 202
        assist.invoke.assert_called_once()


class TestWritingByHand:
    @pytest.mark.parametrize('doc_type', ['prd', 'prfaq'])
    def test_a_human_driven_person_writes_a_prd_or_prfaq_by_hand(self, world, call, doc_type):
        world.set_mode('sub-ada', 'human_driven')

        status, body = call(ADA, 'POST', f'/projects/{PROJECT}/documents',
                            {'document_type': doc_type, 'title': 'My own'})

        assert status == 200
        assert body['document']['origin'] == 'human'
        assert body['document']['created_by_sub'] == 'sub-ada'
        assert len(world.documents()) == 1

    def test_an_agent_filing_a_prd_for_an_ai_assisted_person_is_refused(self, world, call):
        world.set_mode('sub-ada', 'ai_assisted')

        status, body = call(AGENT_FOR_ADA, 'POST', f'/projects/{PROJECT}/documents',
                            {'document_type': 'prd', 'title': 'Agent text'})

        assert status == 403
        assert body['error'].startswith(AUTONOMOUS_REFUSAL_PREFIX)
        assert world.documents() == []

    def test_an_agent_filing_a_custom_document_is_not_gated(self, world, call):
        world.set_mode('sub-ada', 'human_driven')

        status, _ = call(AGENT_FOR_ADA, 'POST', f'/projects/{PROJECT}/documents',
                         {'document_type': 'custom', 'title': 'Notes', 'content': 'Agent notes'})

        assert status == 200
        assert len(world.documents()) == 1


class TestEditingADocument:
    @pytest.mark.parametrize('mode', ['human_driven', 'ai_assisted', 'ai_driven'])
    def test_a_persons_own_edit_of_a_prd_is_allowed_in_every_mode(self, world, call, mode):
        document = _a_prd(world)
        world.set_mode('sub-ada', mode)

        status, _ = call(ADA, 'PUT', f'/projects/{PROJECT}/documents/{document["document_id"]}',
                         {'content': 'My edit'})

        assert status == 200
        assert any(d.get('content') == 'My edit' for d in world.documents())

    def test_an_agent_editing_a_prd_for_an_ai_assisted_person_is_refused(self, world, call):
        document = _a_prd(world)
        world.set_mode('sub-ada', 'ai_assisted')

        status, body = call(AGENT_FOR_ADA, 'PUT', f'/projects/{PROJECT}/documents/{document["document_id"]}',
                            {'content': 'Agent edit'})

        assert status == 403
        assert body['error'].startswith(f'{AUTONOMOUS_REFUSAL_PREFIX} PRD ')
        assert all(d.get('content') != 'Agent edit' for d in world.documents())

    def test_a_plan_step_editing_a_prd_when_the_owner_is_human_driven_is_refused(self, world, call):
        document = _a_prd(world)
        world.set_mode(OWNER_SUB, 'human_driven')

        status, body = call(PLAN_FOR_ADA, 'PUT', f'/projects/{PROJECT}/documents/{document["document_id"]}',
                            {'content': 'Plan edit'})

        assert status == 403
        assert body['error'].startswith(AUTONOMOUS_REFUSAL_PREFIX)

    def test_an_agent_editing_a_prd_for_ai_driven_people_is_allowed(self, world, call):
        document = _a_prd(world)

        status, _ = call(AGENT_FOR_ADA, 'PUT', f'/projects/{PROJECT}/documents/{document["document_id"]}',
                         {'content': 'Agent edit'})

        assert status == 200
        assert any(d.get('content') == 'Agent edit' for d in world.documents())

    def test_an_agent_editing_a_custom_document_is_not_gated(self, world, call):
        _, created = call(ADA, 'POST', f'/projects/{PROJECT}/documents',
                          {'document_type': 'custom', 'title': 'Notes', 'content': 'v1'})
        world.set_mode('sub-ada', 'human_driven')

        status, _ = call(AGENT_FOR_ADA, 'PUT',
                         f'/projects/{PROJECT}/documents/{created["document"]["document_id"]}', {'content': 'v2'})

        assert status == 200
