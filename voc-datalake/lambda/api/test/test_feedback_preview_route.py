"""POST /projects/{id}/feedback-preview: the wizards' live count (ported from #429 by @aws-bryan).

The count itself is tested in shared/test/test_persona_feedback_preview.py; here, the route
builds the generation's filters (the caller's category scope, never the body's) and validates.
"""
import json
from typing import Any
from unittest.mock import patch

import pytest

from shared.category_access import CategoryScope

SCOPE = CategoryScope(all=False, categories=frozenset({'delivery'}))
ANSWER = {'matched': 42, 'matched_is_lower_bound': False, 'estimated': True}


def _post(api_gateway_event, lambda_context, body: dict[str, Any]) -> tuple[int, dict, Any]:
    from projects_handler import lambda_handler
    event = api_gateway_event(method='POST', path='/projects/p1/feedback-preview',
                              path_params={'project_id': 'p1'}, body=body)
    with patch('projects_handler.category_gate.scope_for_event', return_value=SCOPE), \
            patch('projects.persona_context_budget', return_value=(100_000, 145)), \
            patch('projects.persona_feedback_preview.preview_feedback', return_value=dict(ANSWER)) as count:
        response = lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body']), count


def test_persona_preview_reads_the_generations_filters_under_the_callers_scope(api_gateway_event, lambda_context):
    status, body, count = _post(api_gateway_event, lambda_context, {
        'mode': 'estimate', 'sources': ['web'], 'days': 7, 'date_basis': 'review',
        'category_scope': {'all': True, 'categories': []},  # forged: ignored
    })
    assert status == 200
    assert body == {**ANSWER, 'sample_limit': 145}
    _table, project_id, filters, mode = count.call_args.args
    assert (project_id, mode) == ('p1', 'estimate')
    assert filters == {'sources': ['web'], 'categories': [], 'sentiments': [], 'days': 7, 'date_basis': 'review',
                       'category_scope': {'all': False, 'categories': ['delivery']}}


def test_research_preview_has_no_sample_limit(api_gateway_event, lambda_context):
    status, body, _count = _post(api_gateway_event, lambda_context, {'mode': 'exact', 'purpose': 'research'})
    assert status == 200
    assert body['sample_limit'] is None


@pytest.mark.parametrize('body', [{}, {'mode': 'guess'}, {'mode': 'exact', 'purpose': 'documents'}])
def test_a_bad_mode_or_purpose_is_400(api_gateway_event, lambda_context, body):
    status, _body, count = _post(api_gateway_event, lambda_context, body)
    assert status == 400
    count.assert_not_called()
