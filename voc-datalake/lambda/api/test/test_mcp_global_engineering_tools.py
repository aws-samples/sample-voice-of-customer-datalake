"""MCP for runs (7.53.00, tenet 4): the global MCP server's five engineering tools (shared/mcp_global_tools_engineering.py)
and how ``api/mcp_global_handler.py`` gates them (docs/mcp.md → Engineering runs).

* the tool list: exactly five ``engineering_`` tools, each one route of the Agents API and one operation; offered only
  to a WRITE token minted by an administrator, never a read token, a non-admin's or a project-pinned one;
* every call re-checks the minter in Cognito: a demoted administrator's token is refused before any route is called;
* the delegated claims carry ``voc:mcp_op`` = the tool's one operation (7.71.01: the one claim, ``agents_run``'s too,
  set to its own name), never a group;
* no tool reaches a signal, a go, a restart, a Stop, an answer, an approval, the registry, the connections, the dial or
  a request's confirm or decline: each tool builds only its own route;
* the steering and the run requests are held to ``ENGINEERING_ACTS_PER_HOUR`` per token, a store fault refusing;
* each call writes its audit row (tool, outcome; never the arguments);
* the answers are cut field by field: a run's overview without transcript text, diffs, the flow definition or people's
  comments; the analysis labelled as model text; a request saying nothing has started;
* the local agents' skill (templates/orchestration/mcp-skills/voc-runs/SKILL.md) names exactly these tools.
"""
from __future__ import annotations

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

import mcp_global_handler as h
from shared import mcp_global_tokens as gt
from shared.mcp_delegate import DomainResult
from shared.mcp_global_tools import TOOLS, TOOLS_BY_NAME, InvalidToolArgument
from shared.mcp_global_tools_engineering import ENGINEERING_TOOLS, MODEL_TEXT_LABEL, REQUEST_NEXT
from shared.mcp_tokens import mint_token
from shared.project_access import MCP_DELEGATED_OPS

T0 = datetime(2026, 11, 17, 12, 0, tzinfo=UTC)
POOL = 'us-east-1_pool'
MINTED = mint_token()
BEARER = f'Bearer {MINTED.raw}'
RUN = '01JDA7K3M9Q2R5T8V0W4X6Y1Z3'
SKILL = Path(__file__).resolve().parents[3] / 'templates' / 'orchestration' / 'mcp-skills' / 'voc-runs' / 'SKILL.md'
NAMES = ('engineering_runs_list', 'engineering_run_get', 'engineering_run_analysis', 'engineering_run_steer',
         'engineering_run_request')
LIST_RUNS, GET_RUN, ANALYSIS, STEER, REQUEST = (TOOLS_BY_NAME[name] for name in NAMES)
#: Every route the five tools may build, by operation: nothing else of /agents/engineering.
ROUTES = {'runs_list': ('GET', '/agents/engineering/runs'), 'run_get': ('GET', f'/agents/engineering/{RUN}'),
          'run_analysis': ('GET', f'/agents/engineering/{RUN}/retrospective'),
          'run_steer': ('POST', f'/agents/engineering/{RUN}/steer'),
          'run_request': ('POST', '/agents/engineering/requests')}
ARGS = {'runs_list': {}, 'run_get': {'run_id': RUN}, 'run_analysis': {'run_id': RUN},
        'run_steer': {'run_id': RUN, 'text': 'Try ops.py first'}, 'run_request': {'agent_id': 'ag_1', 'issue': 7}}


def _row(**extra: Any) -> dict:
    """An active WRITE token of root's, an administrator when it was minted."""
    return {'pk': 'MCPGTOKEN', 'sk': f'TOKEN#{MINTED.token_id}', 'token_id': MINTED.token_id,
            'secret_hash': MINTED.secret_hash, 'scope': 'write', 'created_by': 'root-sub', 'created_by_username': 'root',
            'minted_by_admin': True, 'expires_at': (T0 + timedelta(days=1)).isoformat(), **extra}


@dataclass
class Rig:
    projects: MagicMock
    jobs: MagicMock
    cognito: MagicMock
    call_domain: MagicMock


@pytest.fixture
def rig(monkeypatch: pytest.MonkeyPatch) -> Iterator[Rig]:
    """The token store holding `_row()`, the audit table, a directory where root is current and an admin, and an
    Agents API that answers 200."""
    monkeypatch.setenv('USER_POOL_ID', POOL)
    monkeypatch.setenv('AGENTS_FUNCTION', 'agents-fn')
    projects, jobs, cognito = MagicMock(), MagicMock(), MagicMock()
    projects.get_item.return_value = {'Item': _row()}
    cognito.admin_get_user.return_value = {'Username': 'root', 'Enabled': True,
                                           'UserAttributes': [{'Name': 'sub', 'Value': 'root-sub'}]}
    cognito.admin_list_groups_for_user.return_value = {'Groups': [{'GroupName': 'admins'}]}
    call_domain = MagicMock(return_value=DomainResult(200, {'runs': [], 'next': None}))
    with patch.object(h, 'get_projects_table', return_value=projects), \
            patch.object(h, 'get_jobs_table', return_value=jobs), \
            patch.object(h, '_cognito_client', return_value=cognito), \
            patch.object(h, 'call_domain', call_domain), patch.object(h, '_now', return_value=T0):
        yield Rig(projects, jobs, cognito, call_domain)


def _call(lambda_context: Any, name: str, arguments: dict) -> dict:
    message = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': arguments}}
    event = {'httpMethod': 'POST', 'path': '/mcp/global', 'headers': {'Authorization': BEARER},
             'body': json.dumps(message)}
    return json.loads(h.lambda_handler(event, lambda_context)['body'])['result']


def _listed(lambda_context: Any) -> list[str]:
    message = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}
    event = {'httpMethod': 'POST', 'path': '/mcp/global', 'headers': {'Authorization': BEARER},
             'body': json.dumps(message)}
    return [tool['name'] for tool in json.loads(h.lambda_handler(event, lambda_context)['body'])['result']['tools']]


def _audited(rig: Rig) -> list[tuple[str, str]]:
    return [(kwargs['Item']['tool'], kwargs['Item']['outcome']) for _, kwargs in rig.jobs.put_item.call_args_list]


class TestTheToolList:
    def test_five_engineering_tools_each_one_operation_admin_only_and_needing_a_write_token(self):
        engineering = [tool for tool in TOOLS if tool.name.startswith('engineering_')]
        assert tuple(tool.name for tool in engineering) == NAMES == tuple(tool.name for tool in ENGINEERING_TOOLS)
        assert {tool.engineering_op for tool in engineering} == set(ROUTES) < MCP_DELEGATED_OPS
        assert all(tool.admin_only and tool.needs_write_token for tool in engineering)
        assert [tool.name for tool in engineering if tool.write] == ['engineering_run_steer', 'engineering_run_request']
        assert all(not tool.project_scoped and not tool.board_route for tool in engineering)
        # (no other tool carries an engineering operation, and the read ones say they only read)
        assert [tool.name for tool in TOOLS if tool.engineering_op] == list(NAMES)
        assert [tool.declaration()['annotations']['readOnlyHint'] for tool in engineering] == [True, True, True,
                                                                                               False, False]

    @pytest.mark.parametrize(('row', 'offered'), [
        (_row(), True),
        (_row(scope='read'), False),                    # an administrator's READ token: not even the reads
        (_row(minted_by_admin=False), False),           # a non-admin's write token
        (_row(project_id='proj_a'), False),             # a project-pinned token
    ])
    def test_offered_only_to_a_write_token_minted_by_an_administrator(self, row: dict, offered: bool):
        assert [h._may_offer(tool, row) for tool in ENGINEERING_TOOLS] == [offered] * 5

    def test_tools_list_shows_them_to_an_admins_write_token_and_hides_them_from_a_read_token(self, rig: Rig,
                                                                                            lambda_context: Any):
        assert [name for name in _listed(lambda_context) if name.startswith('engineering_')] == list(NAMES)
        rig.projects.get_item.return_value = {'Item': _row(scope='read')}
        assert [name for name in _listed(lambda_context) if name.startswith('engineering_')] == []


class TestEveryCallIsGated:
    @pytest.mark.parametrize('op', sorted(ROUTES))
    def test_an_admins_write_token_reaches_the_one_route_with_its_one_operation(self, rig: Rig, lambda_context: Any,
                                                                               op: str):
        tool = next(tool for tool in ENGINEERING_TOOLS if tool.engineering_op == op)
        result = _call(lambda_context, tool.name, ARGS[op])
        assert result['isError'] is False, result
        (call,) = rig.call_domain.call_args_list
        sent, claims = call.args[0], call.kwargs['claims']
        assert (sent.function_name, sent.method, sent.path) == ('agents-fn', *ROUTES[op])
        assert claims['voc:mcp_op'] == op
        assert not {'voc:mcp_engineering', 'voc:mcp_agent_run'} & set(claims)
        assert (claims['sub'], claims['cognito:groups'], claims['voc:acting_subject']) == (
            f'mcp:{MINTED.token_id}', '', 'root-sub')
        assert _audited(rig) == [(tool.name, gt.OUTCOME_OK)]
        # The audit row names the tool and its outcome, never its arguments.
        (_, kwargs), = rig.jobs.put_item.call_args_list
        assert 'Try ops.py' not in json.dumps(kwargs['Item'], default=str)

    @pytest.mark.parametrize('name', NAMES)
    def test_a_demoted_administrators_token_is_refused_before_any_route(self, rig: Rig, lambda_context: Any,
                                                                       name: str):
        rig.cognito.admin_list_groups_for_user.return_value = {'Groups': []}
        result = _call(lambda_context, name, ARGS[TOOLS_BY_NAME[name].engineering_op])
        assert result['isError'] is True
        assert result['content'][0]['text'] == (
            f'{name} needs a token minted by an administrator who is still an administrator')
        rig.call_domain.assert_not_called()
        assert _audited(rig) == [(name, gt.OUTCOME_DENIED)]

    @pytest.mark.parametrize(('row', 'refusal'), [
        (_row(minted_by_admin=False), 'needs a token minted by an administrator who is still an administrator'),
        (_row(scope='read'), 'needs a read-write token; this token is read-only'),
        (_row(project_id='proj_a'), 'is not available to a project-scoped token'),
    ])
    def test_a_non_admins_a_read_or_a_pinned_token_is_refused(self, rig: Rig, lambda_context: Any, row: dict,
                                                              refusal: str):
        rig.projects.get_item.return_value = {'Item': row}
        for name in NAMES:
            result = _call(lambda_context, name, ARGS[TOOLS_BY_NAME[name].engineering_op])
            assert (result['isError'], result['content'][0]['text']) == (True, f'{name} {refusal}')
        rig.call_domain.assert_not_called()

    def test_each_admin_only_tool_carries_its_one_operation_in_the_one_claim(self):
        """F7 (7.71.01): ``agents_run`` names itself, an engineering tool its operation, in the same claim."""
        claims = h._claims_for(h.ToolCall(TOOLS_BY_NAME['agents_run'], {}, None), _row())
        assert claims['voc:mcp_op'] == 'agents_run'
        for tool in ENGINEERING_TOOLS:
            claims = h._claims_for(h.ToolCall(tool, {}, None), _row())
            assert claims['voc:mcp_op'] == tool.engineering_op
            assert not {'voc:mcp_engineering', 'voc:mcp_agent_run'} & set(claims)


class TestNoOtherEngineeringRouteIsReachable:
    """Each tool builds only its own route: whatever its arguments, never a signal, a go, a restart, a Stop, an answer,
    an approval, the registry, the connections, the dial or a request's decision."""

    FORBIDDEN = re.compile(r'/(signals|go|restart|stop|messages|board|reactions|decision|confirm|decline|connections|'
                           r'skills|settings|github-apps|setup|spend|run)(/|$)')

    @pytest.mark.parametrize('op', sorted(ROUTES))
    def test_the_route_of_each_operation(self, op: str):
        tool = next(tool for tool in ENGINEERING_TOOLS if tool.engineering_op == op)
        request = tool.build(ARGS[op], None)
        assert (request.domain, request.method, request.path) == ('agents', *ROUTES[op])
        assert not self.FORBIDDEN.search(request.path)

    @pytest.mark.parametrize('run_id', ['01J/../signals', 'x/stop', '../../agents/a/run', 'runs?x=1', ''])
    def test_a_run_id_can_never_become_another_path(self, run_id: str):
        for tool in (GET_RUN, ANALYSIS, STEER):
            with pytest.raises(InvalidToolArgument, match=r'^run_id is required and must be an id'):
                tool.build({'run_id': run_id, 'text': 'x'}, None)

    def test_without_an_agent_the_request_tool_lists_the_automations_and_nothing_else(self):
        request = REQUEST.build({}, None)
        assert (request.method, request.path, request.body) == ('GET', '/agents/engineering/requests/automations',
                                                                None)
        with pytest.raises(InvalidToolArgument, match='give agent_id with issue, prd or note'):
            REQUEST.build({'issue': 7}, None)


class TestTheArguments:
    def test_the_runs_list_query(self):
        request = LIST_RUNS.build({'month': '2026-11', 'status': 'failed', 'flow': 'wf_1', 'cursor': 'abc',
                                   'limit': 5}, None)
        assert request.query == {'month': '2026-11', 'flow': 'wf_1', 'status': 'failed', 'cursor': 'abc', 'limit': 5}
        assert LIST_RUNS.build({}, None).query == {'month': None, 'flow': None, 'status': None, 'cursor': None,
                                                   'limit': 20}

    @pytest.mark.parametrize(('args', 'message'), [
        ({'month': '2026-13'}, 'month is yyyy-mm'), ({'status': 'lost'}, 'status must be one of'),
        ({'limit': 51}, 'limit must be an integer between 1 and 50'), ({'flow': 'a#b'}, 'flow is required and must'),
    ])
    def test_the_runs_list_refuses_what_its_route_would(self, args: dict, message: str):
        with pytest.raises(InvalidToolArgument, match=message):
            LIST_RUNS.build(args, None)

    def test_steering_is_text_to_the_orchestrator_optionally_about_an_agent(self):
        request = STEER.build({'run_id': RUN, 'text': '  Look at ops.py  ', 'about': 'fixer-3'}, None)
        assert request.body == {'text': 'Look at ops.py', 'about': 'fixer-3'}
        assert STEER.build({'run_id': RUN, 'text': 'x'}, None).body == {'text': 'x'}
        with pytest.raises(InvalidToolArgument, match='text is required'):
            STEER.build({'run_id': RUN, 'text': ' '}, None)
        with pytest.raises(InvalidToolArgument, match='text must be at most 900 characters'):
            STEER.build({'run_id': RUN, 'text': 'x' * 901}, None)

    @pytest.mark.parametrize(('args', 'body'), [
        ({'agent_id': 'ag_1'}, {'agent_id': 'ag_1'}),
        ({'agent_id': 'ag_1', 'issue': 7, 'note': ' please '}, {'agent_id': 'ag_1', 'issue': 7, 'note': 'please'}),
        ({'agent_id': 'ag_1', 'prd': {'project_id': 'p1', 'document_id': 'd1'}},
         {'agent_id': 'ag_1', 'prd': {'project_id': 'p1', 'document_id': 'd1'}}),
    ])
    def test_a_request_names_an_automation_and_its_run_now(self, args: dict, body: dict):
        request = REQUEST.build(args, None)
        assert (request.method, request.path, request.body) == ('POST', '/agents/engineering/requests', body)

    @pytest.mark.parametrize(('args', 'message'), [
        ({'agent_id': 'ag_1', 'issue': 7, 'prd': {'project_id': 'p', 'document_id': 'd'}}, 'not both'),
        ({'agent_id': 'ag_1', 'issue': 0}, 'issue must be an integer between 1'),
        ({'agent_id': 'ag_1', 'issue': True}, 'issue must be an integer'),
        ({'agent_id': 'ag_1', 'prd': {'project_id': 'p'}}, 'prd is {project_id, document_id}'),
        ({'agent_id': 'ag_1', 'note': 'x' * 501}, 'note must be at most 500 characters'),
    ])
    def test_a_request_off_its_shape_is_refused(self, args: dict, message: str):
        with pytest.raises(InvalidToolArgument, match=re.escape(message)):
            REQUEST.build(args, None)


class TestTheActBudget:
    def test_steering_and_requests_count_in_the_tokens_hour_and_stop_past_it(self, rig: Rig, lambda_context: Any):
        refused = ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, 'UpdateItem')
        admitted: list[str] = []

        def update(**kwargs: Any) -> dict:
            expression = kwargs['UpdateExpression']
            if 'eng_' in expression:
                admitted.append(expression)
                if len(admitted) > 1:  # (the hour is full after the first: every condition fails)
                    raise refused
            return {}

        rig.projects.update_item.side_effect = update
        assert _call(lambda_context, 'engineering_run_steer', ARGS['run_steer'])['isError'] is False
        result = _call(lambda_context, 'engineering_run_steer', ARGS['run_steer'])
        assert result['isError'] is True
        assert result['content'][0]['text'] == ('engineering_run_steer: at most 20 steering messages and run requests '
                                                'an hour per token; try again later')
        assert rig.call_domain.call_count == 1
        assert _audited(rig) == [('engineering_run_steer', gt.OUTCOME_OK), ('engineering_run_steer', gt.OUTCOME_DENIED)]
        counted = [call.kwargs for call in rig.projects.update_item.call_args_list
                   if 'eng_' in call.kwargs['UpdateExpression']]
        assert counted[0]['ConditionExpression'] == 'attribute_exists(sk) AND eng_window = :w AND eng_count < :max'
        assert counted[0]['ExpressionAttributeValues'] == {':w': '2026-11-17T12', ':one': 1, ':max': 20}

    def test_the_reads_are_not_counted(self, rig: Rig, lambda_context: Any):
        for op in ('runs_list', 'run_get', 'run_analysis'):
            tool = next(tool for tool in ENGINEERING_TOOLS if tool.engineering_op == op)
            _call(lambda_context, tool.name, ARGS[op])
        assert [call for call in rig.projects.update_item.call_args_list
                if 'eng_' in call.kwargs['UpdateExpression']] == []

    def test_a_store_fault_refuses_the_act(self, rig: Rig, lambda_context: Any):
        def update(**kwargs: Any) -> dict:
            if 'eng_' in kwargs['UpdateExpression']:
                raise ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'UpdateItem')
            return {}

        rig.projects.update_item.side_effect = update
        assert _call(lambda_context, 'engineering_run_request', ARGS['run_request'])['isError'] is True
        rig.call_domain.assert_not_called()

    def test_no_token_store_refuses_the_act_where_the_minute_budget_admits(self):
        with patch.object(h, 'get_projects_table', return_value=None), patch.object(h, '_now', return_value=T0):
            assert (h._admit_engineering_act(_row()), h._admit(_row())) == (False, True)


OVERVIEW = {
    'run': {'run_id': RUN, 'goal': 'Fix paging', 'repo': 'example-org/storefront', 'flow': 'wf_1', 'status': 'active',
            'started_at': '2026-11-17T09:00:00Z', 'ended_at': None, 'waiting_at': '', 'stop': None,
            'budget': {'monthly_usd': 100.0, 'alert_percent': None, 'alert_month': None}, 'flow_revision': 3,
            'flow_definition': {'nodes': [{'id': 'fix', 'params': {'prompt': 'secret prompt'}}]},
            'flow_steps': {'fix': 'running'}, 'flow_outcome': {'outcome': None, 'at': None, 'reason': ''},
            'issue': {'host': 'github', 'number': 7, 'url': 'https://github.com/example-org/storefront/issues/7',
                      'verified': True},
            'pull_request': None, 'cost_usd': 1.5, 'learn_cost_usd': 0.0, 'cost_cap_usd': 50.0,
            'parent': None, 'manifest': None},
    'agents': [{'agent': 'fixer-3', 'role': 'fixer', 'task_id': 't1', 'status': 'working', 'step': 'fix',
                'attempt': 2, 'recent_tools': ['read_file src/secret.py'], 'tokens': [{'model': 'm'}],
                'transcript_cursor': 'tail', 'commit': 'abc', 'cost_usd': 1.2, 'model': 'claude'}],
    'lanes': {'fix': [{'agent': 'fixer-3', 'role': 'fixer', 'status': 'working', 'state': 'in_progress',
                       'task_id': 't1', 'attempt': 2, 'shard': None}]},
    'gates': {'gate': 'GO'}, 'children': [], 'actions_available': True,
    'totals': {'messages': 9, 'microvm_seconds': 60, 'by_model': [{'model': 'm', 'input_tokens': 1,
                                                                  'output_tokens': 2}]},
    'reactions': {'comments': [{'body': 'a person wrote this'}]},
}


class TestTheAnswers:
    def test_a_runs_overview_keeps_status_steps_agents_cost_and_links_and_never_words_or_code(self):
        shaped = GET_RUN.shape(OVERVIEW, {'run_id': RUN})
        text = json.dumps(shaped)
        for withheld in ('secret prompt', 'read_file', 'a person wrote this', 'transcript_cursor', 'recent_tools',
                         'flow_definition', 'reactions', 'actions_available', '"commit"'):
            assert withheld not in text, withheld
        assert shaped['run']['status'] == 'active'
        assert shaped['run']['flow_steps'] == {'fix': 'running'}
        assert shaped['agents'] == [{'agent': 'fixer-3', 'role': 'fixer', 'task_id': 't1', 'status': 'working',
                                     'step': 'fix', 'attempt': 2, 'model': 'claude', 'cost_usd': 1.2}]
        assert shaped['lanes']['fix'][0]['state'] == 'in_progress'
        assert shaped['links'] == {'issue': {'host': 'github', 'number': 7,
                                             'url': 'https://github.com/example-org/storefront/issues/7'},
                                   'pull_request': None, 'app': f'/agents/engineering/{RUN}'}
        assert shaped['totals'] == {'messages': 9, 'microvm_seconds': 60,
                                    'by_model': [{'model': 'm', 'input_tokens': 1, 'output_tokens': 2}]}

    def test_the_analysis_is_labelled_model_text_and_cut_field_by_field(self):
        answer = {'run_id': RUN, 'status': 'done', 'ended': True, 'failure_count': 1, 'extra': 'dropped',
                  'failures': [{'key': 't1#1#failed', 'task_id': 't1', 'attempt': 1, 'role': 'fixer', 'agent': 'f',
                                'version': 'fixer@1', 'how': 'failed', 'reason': 'tests broke', 'moves': ['x']}],
                  'scorecards': [{'role': 'fixer', 'version': 'fixer@1', 'tasks_done': 0, 'cost_usd': 1.0}],
                  'coached': ['t1#1#failed'], 'learned': [{'key': 't1#1#failed', 'coach': 'model words'}],
                  'cross_run': {'available': False, 'reason': 'not yet'}}
        shaped = ANALYSIS.shape(answer, {'run_id': RUN})
        assert shaped['label'] == MODEL_TEXT_LABEL
        assert 'extra' not in shaped
        assert 'moves' not in shaped['failures'][0]
        assert (shaped['failures'][0]['reason'], shaped['learned'][0]['coach']) == ('tests broke', 'model words')
        assert shaped['cross_run'] == {'available': False, 'reason': 'not yet'}

    def test_a_request_says_nothing_started_and_the_list_names_the_automations(self):
        made = REQUEST.shape({'request': {'request_id': 'r1', 'status': 'pending', 'via': 'mcp:tok',
                                          'requested_for': 'root-sub'}}, {'agent_id': 'ag_1'})
        assert made == {'request': {'request_id': 'r1', 'status': 'pending'}, 'next': REQUEST_NEXT}
        listed = REQUEST.shape({'automations': [{'agent_id': 'ag_1', 'name': 'Bug fixer', 'owner_sub': 'x'}]}, {})
        assert listed == {'automations': [{'agent_id': 'ag_1', 'name': 'Bug fixer'}]}


def test_the_local_agents_skill_names_exactly_the_engineering_tools():
    """templates/orchestration/mcp-skills/voc-runs/SKILL.md teaches a local Kiro or Claude agent these five tools."""
    text = SKILL.read_text(encoding='utf-8')
    named = set(re.findall(r'`(engineering_[a-z_]+)`', text))
    assert named == set(NAMES)
    assert text.startswith('---\nname: voc-runs\n')
