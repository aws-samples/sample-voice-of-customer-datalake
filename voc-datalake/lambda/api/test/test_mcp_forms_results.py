"""``forms_get_results`` on ``/mcp/global`` (7.63.00, round 1 F1; shared/mcp_global_tools.py, docs/mcp.md) end to end:
the tool's route request, delegated as ``mcp_delegate`` sends it (the minter's synthetic claims, the token's
workspace as its header), run through the real forms Lambda (api/feedback_form_handler.py) on moto. The delegated
caller sees exactly what its minter sees on the same route: the category and source access, and a workspace's role
(a viewer's token is refused), never more."""
from __future__ import annotations

from typing import Any

import pytest
from test_feedback_form_v2 import EDITOR, USER, VIEWER, WS, _create, _item
from test_feedback_form_v2 import world as v2_world
from test_mcp_forms_tools import over_mcp

from shared.test.source_profile_fixtures import no_source_profiles

_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)
world = v2_world


def _over_mcp(lambda_context: Any, minter: dict, args: dict, *, ws: str | None = None) -> tuple[int, Any]:
    """The tool's call as the global MCP server makes it, for a token ``minter`` made (``ws``: minted there)."""
    return over_mcp(lambda_context, 'forms_get_results', minter, args, ws=ws)


@pytest.fixture
def form(world, lambda_context) -> str:
    form_id = _create(lambda_context)['form_id']
    for n, hidden in enumerate(({'app_version': '5.0'}, {'app_version': '5.1'}, {})):
        world['feedback'].put_item(Item=_item(form_id, f'f{n}', f'2026-11-0{n + 1}T10:00:00',
                                              {'q_reason': {'code': 'slow'}, 'q_rate': 4},
                                              ['q_reason', 'q_rate', 'q_contact'], form_hidden=hidden))
    return form_id


def test_the_tool_reads_the_results_route_as_its_minter(form, lambda_context):
    status, results = _over_mcp(lambda_context, USER, {'form_id': form})
    assert status == 200, results
    assert (results['form_id'], results['responses'], results['include_test']) == (form, 3, False)
    assert next(q for q in results['questions'] if q['id'] == 'q_rate')['average'] == 4
    narrowed = _over_mcp(lambda_context, USER, {'form_id': form, 'hidden': {'app_version': '5.1'},
                                                'from': '2026-11-01', 'to': '2026-11-03'})[1]
    assert (narrowed['responses'], narrowed['funnel']) == (1, None)


def test_the_minters_source_and_category_access_apply(world, form, lambda_context):
    world['aggregates'].put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config',
                                       'sources': [{'id': 'feedback_form', 'restricted': True}]})
    assert _over_mcp(lambda_context, USER, {'form_id': form})[1]['responses'] == 0
    world['aggregates'].put_item(Item={'pk': 'CATEGORY_ACCESS', 'sk': f"USER#{USER['sub']}",
                                       'sources': ['feedback_form'], 'categories': ['billing']})
    # (granted the source, but the responses are filed under `features`, outside the minter's categories)
    assert _over_mcp(lambda_context, USER, {'form_id': form})[1]['responses'] == 0


@pytest.mark.usefixtures('world')
def test_a_viewers_token_in_a_workspace_is_refused_as_the_viewer_is(lambda_context):
    status, body = _over_mcp(lambda_context, VIEWER, {'form_id': 'ff_anything'}, ws=WS)
    assert status == 403, body
    # (an editor's token passes the role check: the form is simply not in that workspace)
    assert _over_mcp(lambda_context, EDITOR, {'form_id': 'ff_anything'}, ws=WS)[0] == 404
