"""A one-slider save keeps the reviewer's other three scores — against a REAL table.

Wave-4 live finding (verify3/v1/priosave): moving ONE slider on a row whose own
ballot read 5/5/5/5 and saving left the three untouched axes reading "Not scored".
`PATCH /projects/prioritization` is a merge: an axis the entry does not carry, or
carries as `null`, or carries as `0` — the API's own "unscored" value, which no
slider can produce (they run 1 … 5) — must leave the stored value alone. Exercised
through moto rather than the fast suite's fake, because the fake cannot tell whether
the transaction's `SET` really leaves the other attributes of an existing item alone.
"""
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

FULL = {'impact': 5, 'time_to_market': 5, 'confidence': 5, 'strategic_fit': 5}


@pytest.fixture
def lambda_context():
    return MagicMock()


def _call(aggregates, projects, lambda_context, method, path, body=None):
    import projects_handler

    event = rest_event(method, path, claims={'sub': 'alice', 'cognito:groups': 'admins'}, body=body)
    return invoke(projects_handler, event, lambda_context, aggregates=aggregates, projects=projects)


def _scored_row(lambda_context):
    """Fresh tables with one composed row that alice has scored 5/5/5/5."""
    aggregates, projects = pk_sk_table('aggr'), pk_sk_table('projects')
    projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'P'})
    projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PRD#d1', 'document_id': 'd1',
                            'created_at': '2026-01-01'})
    _, created = _call(aggregates, projects, lambda_context, 'POST',
                       '/projects/prioritization/rows/compose',
                       {'project_id': 'p1', 'document_ids': ['d1']})
    row_id = created['row']['row_id']
    status, _ = _call(aggregates, projects, lambda_context, 'PATCH',
                      '/projects/prioritization', {'scores': {row_id: dict(FULL)}})
    assert status == 200
    return aggregates, projects, row_id


def _own_scores(aggregates, projects, lambda_context, row_id) -> dict:
    status, body = _call(aggregates, projects, lambda_context, 'GET', '/projects/prioritization')
    assert status == 200
    entry = body['scores'][row_id]
    return {axis: entry[axis] for axis in FULL}


class TestAOneSliderSaveMerges:

    @mock_aws
    def test_an_absent_axis_keeps_its_stored_score(self, lambda_context):
        aggregates, projects, row_id = _scored_row(lambda_context)
        _call(aggregates, projects, lambda_context, 'PATCH', '/projects/prioritization',
              {'scores': {row_id: {'row_id': row_id, 'impact': 4}}})
        assert _own_scores(aggregates, projects, lambda_context, row_id) == {
            **FULL, 'impact': 4}

    @mock_aws
    def test_a_null_axis_keeps_its_stored_score(self, lambda_context):
        aggregates, projects, row_id = _scored_row(lambda_context)
        _call(aggregates, projects, lambda_context, 'PATCH', '/projects/prioritization',
              {'scores': {row_id: {'impact': 4, 'time_to_market': None}}})
        assert _own_scores(aggregates, projects, lambda_context, row_id) == {
            **FULL, 'impact': 4}

    @mock_aws
    def test_a_zero_axis_is_unchanged_rather_than_written_as_zero(self, lambda_context):
        """A client sending the whole ballot with untouched axes at the unscored 0
        (a stale page, another client) must not wipe three real scores."""
        aggregates, projects, row_id = _scored_row(lambda_context)
        _call(aggregates, projects, lambda_context, 'PATCH', '/projects/prioritization',
              {'scores': {row_id: {'impact': 4, 'time_to_market': 0,
                                   'confidence': 0, 'strategic_fit': 0}}})
        stored = aggregates.get_item(
            Key={'pk': 'PRIORITIZATION', 'sk': f'BALLOT#{row_id}#user:alice'}).get('Item')
        assert stored is not None
        assert {axis: stored[axis] for axis in FULL} == {
            'impact': Decimal(4), 'time_to_market': Decimal(5),
            'confidence': Decimal(5), 'strategic_fit': Decimal(5)}
