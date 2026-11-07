"""The catalogue, Prioritization and board-write tools on ``/mcp/global`` (shared/mcp_global_tools_work.py).

Each is ONE existing route called as the minter: the route, its arguments and refusals, the
scope (write tools only for a write token; ``score_prioritization`` never for a project-pinned
token), the project narrowing of the Prioritization read, and the board-route claims of the
board write (an app-pool viewer, never admin).
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

import mcp_global_handler as h
from shared.mcp_delegate import DomainResult
from shared.mcp_global_tools import TOOLS_BY_NAME, InvalidToolArgument, MinterIdentity

CATALOGUE = TOOLS_BY_NAME['get_feedback_catalogue']
PRIORITIZATION = TOOLS_BY_NAME['get_prioritization']
SCORE = TOOLS_BY_NAME['score_prioritization']
BOARD_WRITE = TOOLS_BY_NAME['write_feature_request']
APP_POOL = 'eu-west-1_AppPool1'
READ_ROW = {'token_id': 'gmt_tok1', 'scope': 'read', 'created_by': 'alice-sub'}
WRITE_ROW = {**READ_ROW, 'scope': 'write'}
PINNED_WRITE_ROW = {**WRITE_ROW, 'project_id': 'proj_a'}
BOARD = {
    'rows': {'r1': {'row_id': 'r1', 'project_id': 'proj_a'}, 'r2': {'row_id': 'r2', 'project_id': 'proj_b'}},
    'scores': {'r1': {'impact': 4}, 'r2': {'impact': 2}},
    'aggregates': {'r1': {'reviewer_count': 2}, 'r2': {'reviewer_count': 1}},
    'axes': [{'id': 'impact'}], 'config_version': 3,
}


def _run(tool, arguments: dict, answer: DomainResult, row=WRITE_ROW, project: str | None = None):
    call_domain = MagicMock(return_value=answer)
    minter = MinterIdentity(email='alice@example.com', name='Alice Example')
    with patch.object(h, 'call_domain', call_domain), patch.object(h, '_minter_identity', return_value=minter), \
            patch.dict('os.environ', {'USER_POOL_ID': APP_POOL}):
        content, outcome = h._run_tool(h.ToolCall(tool, arguments, project), row)
    return content, outcome, call_domain


class TestTheCatalogue:
    def test_is_the_metrics_route(self):
        request = CATALOGUE.build({}, None)
        assert (request.domain, request.method, request.path) == ('metrics', 'GET', '/feedback/catalogue')

    def test_sources_read_the_source_status_on_the_integrations_function(self):
        request = CATALOGUE.build({'sources': True}, None)
        assert (request.domain, request.method, request.path) == ('integrations', 'GET', '/sources/status')

    def test_a_non_boolean_is_refused(self):
        with pytest.raises(InvalidToolArgument):
            CATALOGUE.build({'sources': 'yes'}, None)

    def test_is_a_read_tool_for_every_token(self):
        assert (CATALOGUE.write, CATALOGUE.admin_only, CATALOGUE.workspace_wide) == (False, False, False)
        assert h._may_offer(CATALOGUE, READ_ROW)

    def test_the_answer_loses_storage_keys(self):
        content, outcome, _ = _run(CATALOGUE, {}, DomainResult(200, {'version': 1, 'fields': [{'name': 'pk'}],
                                                                     'pk': 'x'}), row=READ_ROW)
        assert outcome == 'ok'
        assert content['structuredContent'] == {'version': 1, 'fields': [{'name': 'pk'}]}


class TestThePrioritizationRead:
    def test_is_the_board_read(self):
        request = PRIORITIZATION.build({}, None)
        assert (request.domain, request.method, request.path) == ('projects', 'GET', '/projects/prioritization')

    def test_without_a_project_every_row_the_minter_can_view(self):
        content, _, _ = _run(PRIORITIZATION, {}, DomainResult(200, BOARD), row=READ_ROW)
        assert set(content['structuredContent']['rows']) == {'r1', 'r2'}

    @pytest.mark.parametrize(('arguments', 'project'), [({'project_id': 'proj_a'}, 'proj_a'), ({}, 'proj_a')])
    def test_a_project_or_the_pin_narrows_rows_scores_and_aggregates(self, arguments, project):
        content, _, _ = _run(PRIORITIZATION, arguments, DomainResult(200, BOARD), row=READ_ROW, project=project)
        shaped = content['structuredContent']
        assert (set(shaped['rows']), set(shaped['scores']), set(shaped['aggregates'])) == ({'r1'}, {'r1'}, {'r1'})
        assert shaped['axes'] == [{'id': 'impact'}]

    def test_the_pin_applies(self):
        assert PRIORITIZATION.project_scoped is True
        assert h._resolved_project(PRIORITIZATION, {}, 'proj_a') == 'proj_a'
        with pytest.raises(h.ToolDenied):
            h._resolved_project(PRIORITIZATION, {'project_id': 'proj_b'}, 'proj_a')


class TestScoring:
    def test_is_the_minter_s_own_ballot_on_one_row(self):
        request = SCORE.build({'row_id': 'r1', 'scores': {'impact': 5, 'effort': 1}}, None)
        assert (request.domain, request.method, request.path, request.body) == (
            'projects', 'PATCH', '/projects/prioritization', {'scores': {'r1': {'impact': 5, 'effort': 1}}})

    @pytest.mark.parametrize('args', [
        {'scores': {'impact': 3}},
        {'row_id': 'r1'},
        {'row_id': 'r1', 'scores': {}},
        {'row_id': 'r1', 'scores': {'impact': 0}},
        {'row_id': 'r1', 'scores': {'impact': 6}},
        {'row_id': 'r1', 'scores': {'impact': True}},
        {'row_id': 'r1', 'scores': {'impact': 2.5}},
        {'row_id': 'r 1', 'scores': {'impact': 3}},
        {'row_id': 'r1', 'scores': {f'a{i}': 1 for i in range(13)}},
    ])
    def test_out_of_contract_arguments_are_refused(self, args):
        with pytest.raises(InvalidToolArgument):
            SCORE.build(args, None)

    def test_needs_a_write_token(self):
        assert not h._may_offer(SCORE, READ_ROW)
        with pytest.raises(h.ToolDenied, match='read-write token'):
            h._check_allowed(h.ToolCall(SCORE, {}, None), READ_ROW)

    def test_a_project_pinned_token_is_neither_offered_it_nor_allowed_it(self):
        assert h._may_offer(SCORE, WRITE_ROW)
        assert not h._may_offer(SCORE, PINNED_WRITE_ROW)
        with pytest.raises(h.ToolDenied, match='scoped to one project'):
            h._check_allowed(h.ToolCall(SCORE, {}, None), PINNED_WRITE_ROW)

    def test_a_route_refusal_is_a_tool_error(self):
        content, outcome, _ = _run(SCORE, {'row_id': 'r1', 'scores': {'impact': 3}},
                                   DomainResult(404, {'success': False, 'error': 'scores name a row that does not exist'}))
        assert (content['isError'], outcome) == (True, 'error')


class TestTheBoardWrite:
    def test_a_new_request(self):
        request = BOARD_WRITE.build({'board': 'ideas', 'title': ' Seat map ', 'description': 'Pick early',
                                     'fields': {'customer': 'Example Air'}}, None)
        assert (request.domain, request.method, request.path) == ('engagement', 'POST', '/feature-requests')
        assert request.body == {'title': 'Seat map', 'description': 'Pick early', 'board': 'ideas',
                                'fields': {'customer': 'Example Air'}}

    def test_a_plus_one(self):
        request = BOARD_WRITE.build({'request_id': 'fr_1', 'fields': {'impact': 'high'}}, None)
        assert (request.method, request.path, request.body) == (
            'POST', '/feature-requests/fr_1/supports', {'fields': {'impact': 'high'}})

    @pytest.mark.parametrize('args', [
        {},
        {'title': 't' * 161},
        {'title': 'T', 'description': 'd' * 4001},
        {'request_id': 'fr_1', 'title': 'T'},
        {'request_id': 'fr 1'},
        {'title': 'T', 'fields': ['x']},
        {'title': 'T', 'fields': {f'f{i}': 1 for i in range(21)}},
    ])
    def test_out_of_contract_arguments_are_refused(self, args):
        with pytest.raises(InvalidToolArgument):
            BOARD_WRITE.build(args, None)

    def test_is_a_write_on_a_board_route_for_any_write_token(self):
        assert (BOARD_WRITE.write, BOARD_WRITE.board_route, BOARD_WRITE.workspace_wide) == (True, True, False)
        assert not h._may_offer(BOARD_WRITE, READ_ROW)
        assert h._may_offer(BOARD_WRITE, PINNED_WRITE_ROW)

    def test_the_claims_are_the_non_admin_app_pool_minter(self):
        _, outcome, call_domain = _run(BOARD_WRITE, {'title': 'Seat map'},
                                       DomainResult(201, {'request': {'request_id': 'fr_9'}}))
        claims = call_domain.call_args.kwargs['claims']
        assert outcome == 'ok'
        assert claims['iss'] == f'https://cognito-idp.eu-west-1.amazonaws.com/{APP_POOL}'
        assert (claims['email'], claims['name']) == ('alice@example.com', 'Alice Example')
        assert claims.get('cognito:groups', '') == ''

    def test_a_paused_board_s_refusal_reaches_the_client(self):
        content, outcome, _ = _run(BOARD_WRITE, {'request_id': 'fr_1'},
                                   DomainResult(409, {'success': False, 'error': 'This board is paused'}))
        assert content['isError'] is True
        assert 'paused' in content['content'][0]['text']
        assert outcome == 'error'


def test_status_changes_imports_and_source_switches_have_no_tool():
    paths = {(tool.name, request.path) for tool in TOOLS_BY_NAME.values()
             for request in [_safe_build(tool)] if request is not None}
    assert not any('/status' in path and 'feature-requests' in path for _, path in paths)
    assert not any(path.startswith(('/scrapers/manual', '/s3-import', '/sources/')) and path != '/sources/status'
                   for _, path in paths)


def _safe_build(tool):
    try:
        return tool.build({'sources': True} if tool is CATALOGUE else {}, 'proj_a')
    except InvalidToolArgument:
        return None
