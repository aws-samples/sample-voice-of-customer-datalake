"""A global MCP token scores AS its minter (docs/mcp.md → prioritization_score).

The ballot of a delegated ``mcp:<token>`` caller is keyed on the minter (``voc:acting_subject``, set
only by the MCP Lambda's IAM invoke), so it is the minter's own ballot: the minter reads it back in the
app, and a person never counts twice. A credential that acts for nobody is refused (403).
"""
from __future__ import annotations

from unittest.mock import patch

from test_projects_prioritization_ballots import AXES, FakeAggregatesTable, _call, _event, _get_scores


def _delegated_save(api_gateway_event, lambda_context, table, acting: str | None):
    table.seed_rows('row-1')
    event = _event(api_gateway_event, method='PATCH', body={'scores': {'row-1': AXES}}, subject='mcp:gmt_tok1')
    if acting is not None:
        event['requestContext']['authorizer']['claims']['voc:acting_subject'] = acting
    # The row's project is visible to the minter (project access is pinned by the ballot suite): this
    # suite is about WHOSE ballot it is, and must never reach a real projects table.
    with patch('projects_handler._rows_hidden_from_caller', return_value=set()):
        return _call(table, event, lambda_context)


def test_the_ballot_is_the_minter_s_own(api_gateway_event, lambda_context):
    table = FakeAggregatesTable()
    status, body = _delegated_save(api_gateway_event, lambda_context, table, 'alice')
    assert (status, body['updated_count']) == (200, 1)

    _, read = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
    assert 'row-1' in read['scores']
    assert read['aggregates']['row-1']['reviewer_count'] == 1


def test_a_second_save_through_the_token_replaces_the_minter_s_ballot(api_gateway_event, lambda_context):
    table = FakeAggregatesTable()
    _delegated_save(api_gateway_event, lambda_context, table, 'alice')
    _delegated_save(api_gateway_event, lambda_context, table, 'alice')
    _, read = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
    assert read['aggregates']['row-1']['reviewer_count'] == 1


def test_a_credential_acting_for_nobody_is_refused(api_gateway_event, lambda_context):
    status, body = _delegated_save(api_gateway_event, lambda_context, FakeAggregatesTable(), None)
    assert (status, body['error']) == (403, 'This credential does not act for a person, so it cannot score')


def test_a_credential_cannot_act_as_another_credential(api_gateway_event, lambda_context):
    status, _ = _delegated_save(api_gateway_event, lambda_context, FakeAggregatesTable(), 'mcp:gmt_other')
    assert status == 403
