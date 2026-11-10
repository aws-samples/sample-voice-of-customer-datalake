"""Follow-up reads of the global MCP handler (``_with_follow_ups``): ``get_feedback include_similar``.

The main read decides the call: its refusal is the tool error and no follow-up runs. A follow-up is
best effort: a refused or failed one is reported as ``similar_error`` beside the main result, never
as a tool error, and it runs with the SAME delegated claims as the main read (so the similar route
applies the minter's category and source access).
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

import mcp_global_handler as h
from shared.mcp_delegate import DelegationUnavailable, DomainResult
from shared.mcp_global_tools import TOOLS_BY_NAME

GET_FEEDBACK = TOOLS_BY_NAME['get_feedback']
ROW = {'token_id': 'tok_1', 'scope': 'read', 'created_by': 'alice-sub', 'created_by_username': 'alice'}
ITEM = {'feedback_id': 'f_1', 'pk': 'SOURCE#web', 'original_text': 'Bag lost'}
SIMILAR = {'items': [{'feedback_id': 'f_2', 'original_text': 'Bag late', 'sk': 'FEEDBACK#f_2'}]}


def _run(arguments: dict, *answers: object) -> tuple[dict, str, MagicMock]:
    call_domain = MagicMock(side_effect=list(answers))
    with patch.object(h, 'call_domain', call_domain):
        content, outcome = h._run_tool(h.ToolCall(GET_FEEDBACK, arguments, None), ROW)
    return content, outcome, call_domain


def _text(content: dict) -> dict:
    return json.loads(content['content'][0]['text'])


def test_without_include_similar_one_read():
    content, outcome, call_domain = _run({'feedback_id': 'f_1'}, DomainResult(200, ITEM))
    assert (outcome, call_domain.call_count) == ('ok', 1)
    assert _text(content) == {'feedback_id': 'f_1', 'original_text': 'Bag lost'}


def test_similar_items_join_the_result_with_the_same_claims():
    content, outcome, call_domain = _run({'feedback_id': 'f_1', 'include_similar': True},
                                         DomainResult(200, ITEM), DomainResult(200, SIMILAR))
    assert outcome == 'ok'
    assert content['structuredContent'] == {'feedback_id': 'f_1', 'original_text': 'Bag lost',
                                            'similar': [{'feedback_id': 'f_2', 'text': 'Bag late'}]}
    main, follow = call_domain.call_args_list
    assert (follow.args[0].path, follow.args[0].query) == ('/feedback/f_1/similar', {'limit': 5})
    assert follow.kwargs['claims'] == main.kwargs['claims']


@pytest.mark.parametrize(('answer', 'error'), [
    (DomainResult(404, {'message': 'Not found'}), 'Not found (HTTP 404)'),
    (DelegationUnavailable('boom'), 'unavailable'),
])
def test_a_failed_follow_up_is_reported_beside_the_main_result(answer, error):
    content, outcome, _ = _run({'feedback_id': 'f_1', 'include_similar': True}, DomainResult(200, ITEM), answer)
    assert (outcome, content['isError']) == ('ok', False)
    assert _text(content) == {'feedback_id': 'f_1', 'original_text': 'Bag lost', 'similar_error': error}


def test_a_refused_main_read_runs_no_follow_up():
    content, outcome, call_domain = _run({'feedback_id': 'f_1', 'include_similar': True},
                                         DomainResult(404, {'message': 'Not found'}))
    assert (outcome, content['isError'], call_domain.call_count) == ('error', True, 1)


def test_a_non_object_main_result_is_left_alone():
    content, _, call_domain = _run({'feedback_id': 'f_1', 'include_similar': True}, DomainResult(200, ['odd']))
    assert (_text(content), call_domain.call_count) == (['odd'], 1)
