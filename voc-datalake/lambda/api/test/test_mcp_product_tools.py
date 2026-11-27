"""The Product tab tools on ``/mcp/global`` (7.104.00, tenet 4; shared/mcp_global_tools_product.py, docs/mcp.md):
each action's one route, the few arguments the tool shapes itself, and ``product_get``, an ``accept`` and the routes'
own refusals end to end as ``mcp_delegate`` sends them (the minter's synthetic claims) through the real projects
handler on moto: a token reads what its minter may, never replaces a value a person typed, writes only for people
working AI-driven (tenet 3), and every limit is the route's, in its words (review F3, 7.104.00 round 1)."""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import pytest
from test_product_proposal_routes import EDITOR, PROJECT, VIEWER, _seed_proposal
from test_product_proposal_routes import project as routes_project
from test_product_proposal_routes import tables as routes_tables

from shared.mcp_delegate import DomainCall, build_proxy_event, synthetic_claims
from shared.mcp_global_kit import InvalidToolArgument, RouteRequest
from shared.mcp_global_tools import TOOLS_BY_NAME

GET, WRITE = TOOLS_BY_NAME['product_get'], TOOLS_BY_NAME['product_write']
tables, project = routes_tables, routes_project


class TestTheRoutes:
    def test_get_reads_the_latest_proposal(self):
        assert GET.build({}, 'p1') == RouteRequest('projects', 'GET', '/projects/p1/product-proposals/latest')

    def test_add_url_posts_the_link_as_given(self):
        assert WRITE.build({'action': 'add_url', 'url': ' https://example.com/pricing '}, 'p1') == RouteRequest(
            'projects', 'POST', '/projects/p1/product-docs/urls', body={'url': ' https://example.com/pricing '})

    def test_answer_posts_typed_answers(self):
        answers = [{'field': 'target_users', 'question': 'Who is it for?', 'answer': 'Remote teams'}]
        assert WRITE.build({'action': 'answer', 'answers': answers}, 'p1') == RouteRequest(
            'projects', 'POST', '/projects/p1/product-docs/answers', body={'mode': 'typed', 'answers': answers})

    def test_extract_starts_the_job(self):
        assert WRITE.build({'action': 'extract'}, 'p1') == RouteRequest(
            'projects', 'POST', '/projects/p1/product-extract', body={})

    def test_accept_sends_each_field_with_the_value_it_was_seen_at(self):
        request = WRITE.build({'action': 'accept', 'proposal_id': 'pp_1', 'fields': {'product_name': ''}}, 'p1')
        assert request == RouteRequest('projects', 'POST', '/projects/p1/product-proposals/pp_1/accept',
                                       body={'fields': {'product_name': {'seen': ''}}})

    def test_both_tools_take_the_project_and_only_the_write_is_a_write(self):
        assert (GET.project_scoped, WRITE.project_scoped, GET.write, WRITE.write) == (True, True, False, True)
        assert (GET.admin_only, WRITE.admin_only) == (False, False)


@pytest.mark.parametrize('tool', [GET, WRITE], ids=['product_get', 'product_write'])
def test_a_project_pinned_token_gets_both_confined_to_its_project_and_defaulted_to_it(tool):
    # Project tools, not workspace-wide: a pinned token is offered them, its pin is their project when the call names
    # none, and another project is refused before any route (mcp_global_handler._resolved_project).
    import mcp_global_handler as mcp
    pinned = {'token_id': 'tok_p', 'scope': 'write', 'created_by': EDITOR['sub'], 'project_id': PROJECT}
    args = {'action': 'extract'} if tool.write else {}
    assert (tool.workspace_wide, mcp._may_offer(tool, pinned)) == (False, True)
    assert mcp._resolved_project(tool, args, PROJECT) == PROJECT
    assert tool.build(args, mcp._resolved_project(tool, args, PROJECT)).path.startswith(f'/projects/{PROJECT}/')
    with pytest.raises(mcp.ToolDenied, match=f'scoped to project {PROJECT}'):
        mcp._resolved_project(tool, {**args, 'project_id': 'proj_other'}, PROJECT)


class TestRefusedArguments:
    @pytest.mark.parametrize(('args', 'message'), [
        ({'action': 'upload'}, 'action must be one of: add_url, answer, extract, accept'),
        ({'action': 'accept', 'proposal_id': '../x', 'fields': {'product_name': ''}}, 'proposal_id is required'),
        ({'action': 'accept', 'proposal_id': 'pp_1', 'fields': ['product_name']}, 'fields must map product fields'),
    ])
    def test_the_tool_refuses_only_what_it_shapes(self, args, message):
        with pytest.raises(InvalidToolArgument, match=message):
            WRITE.build(args, 'p1')

    @pytest.mark.parametrize('args', [
        {'action': 'add_url', 'url': 'http://example.com'},
        {'action': 'add_url', 'url': 'https://' + 'a' * 2048},
        {'action': 'answer', 'answers': []},
        {'action': 'answer', 'answers': [{'field': 'price', 'answer': 'x'}]},
        {'action': 'answer', 'answers': [{'field': 'non_goals', 'question': 'q' * 201, 'answer': 'x'}]},
        {'action': 'accept', 'proposal_id': 'pp_1', 'fields': {'price': ''}},
    ])
    def test_every_limit_is_the_routes_so_the_tool_passes_the_arguments_through(self, args):
        assert WRITE.build(args, 'p1').body is not None


def _over_mcp(lambda_context: Any, tables: Any, tool: Any, minter: dict, args: dict) -> tuple[int, Any]:
    import projects
    import projects_handler
    from shared import product_proposal_routes

    request = tool.build(args, PROJECT)
    call = DomainCall(function_name='projects-fn', method=request.method, path=request.path, query=request.query,
                      body=request.body)
    claims = synthetic_claims({'token_id': 'tok_product', 'created_by': minter['sub']})
    projects_table, jobs_table, aggregates_table = tables
    with patch.object(projects_handler, 'get_projects_table', return_value=projects_table), \
            patch.object(projects_handler, 'get_aggregates_table', return_value=aggregates_table), \
            patch.object(projects, 'projects_table', projects_table), \
            patch.object(projects_handler, 'get_jobs_table', return_value=jobs_table), \
            patch.object(product_proposal_routes, 'get_projects_table', return_value=projects_table), \
            patch.object(product_proposal_routes, 'get_aggregates_table', return_value=aggregates_table):
        response = projects_handler.lambda_handler(build_proxy_event(call, claims, None), lambda_context)
    body = json.loads(response['body'])
    return response['statusCode'], tool.shape(body, args) if response['statusCode'] == 200 else body


@pytest.mark.usefixtures('project')
class TestEndToEnd:
    def test_a_viewers_token_reads_the_proposal(self, lambda_context, tables):
        proposal_id = _seed_proposal(tables[0])
        status, answer = _over_mcp(lambda_context, tables, GET, VIEWER, {})
        assert (status, answer['proposal']['proposal_id']) == (200, proposal_id)

    def test_a_token_never_replaces_a_value_a_person_typed(self, lambda_context, tables):
        proposal_id = _seed_proposal(tables[0])
        tables[0].put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'PRODUCT_CONTEXT', 'product_name': 'Mine',
                                 'field_meta': {'product_name': {'by': 'person'}}})
        status, answer = _over_mcp(lambda_context, tables, WRITE, EDITOR, {
            'action': 'accept', 'proposal_id': proposal_id, 'fields': {'product_name': 'Mine'}})
        assert (status, answer['code'], answer['conflicts']) == (
            409, 'conflict', [{'field': 'product_name', 'reason': 'person_value'}])
        context = tables[0].get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'PRODUCT_CONTEXT'})['Item']
        assert context['product_name'] == 'Mine'

    def test_a_viewers_token_may_not_accept(self, lambda_context, tables):
        proposal_id = _seed_proposal(tables[0])
        status, _answer = _over_mcp(lambda_context, tables, WRITE, VIEWER, {
            'action': 'accept', 'proposal_id': proposal_id, 'fields': {'product_name': ''}})
        assert status == 403

    @pytest.mark.parametrize(('args', 'error'), [
        ({'action': 'add_url', 'url': 'http://example.com'}, 'https'),
        ({'action': 'add_url', 'url': 'https://' + 'a' * 2048}, 'url must be at most 2048 characters'),
        ({'action': 'answer', 'answers': [{'field': 'x', 'answer': 'y'}] * 13}, 'answers must be a list of 1 to 12'),
        ({'action': 'answer', 'answers': [{'field': 'non_goals', 'question': 'q' * 201, 'answer': 'x'}]},
         'question must be at most 200 characters'),
    ])
    def test_the_routes_refusal_reaches_the_client_in_its_words(self, lambda_context, tables, args, error):
        import mcp_global_handler as mcp
        from shared.mcp_delegate import DomainResult

        status, answer = _over_mcp(lambda_context, tables, WRITE, EDITOR, args)
        assert (status, error in answer['error']) == (400, True)
        assert error in mcp._route_message(DomainResult(status_code=status, payload=answer))

    def test_a_token_whose_minter_is_not_ai_driven_may_not_accept(self, lambda_context, tables):
        from shared import ai_mode
        proposal_id = _seed_proposal(tables[0])
        with patch('shared.ai_mode.get_ai_mode', return_value=ai_mode.AiMode(mode=ai_mode.MODE_AI_ASSISTED)):
            status, answer = _over_mcp(lambda_context, tables, WRITE, EDITOR, {
                'action': 'accept', 'proposal_id': proposal_id, 'fields': {'product_name': ''}})
        assert (status, answer['code']) == (403, 'ai_writing_refused')
        assert tables[0].get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'PRODUCT_CONTEXT'}).get('Item') is None
