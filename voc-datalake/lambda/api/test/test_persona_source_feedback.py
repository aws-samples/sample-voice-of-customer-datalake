"""
GET  /projects/<id>/personas/<persona_id>/feedback   — the feedback a persona came from
POST /projects/<id>/personas/preview-feedback         — how much feedback a request matches
"""
import json
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _empty_preview_cache():
    """The preview cache lives for the container, so one test's count would
    otherwise answer the next test's request."""
    import projects
    projects._preview_cache.clear()
    yield
    projects._preview_cache.clear()


PERSONA_ROW = {
    'persona_id': 'p1',
    'evidence_feedback_ids': ['fb2', 'fb5'],
    'input_feedback_ids': [f'fb{i}' for i in range(1, 11)],
    'feedback_provenance': {
        'items_used': 10, 'items_matched': 900,
        'matched_is_lower_bound': False, 'sample_limit': 145,
    },
}


def _get(api_gateway_event, lambda_context, *, row, query=None, found=None, missing=None):
    """Call the GET route with ``row`` as the stored persona (None = absent)."""
    from projects_handler import lambda_handler

    table = MagicMock()
    table.get_item.return_value = {'Item': row} if row is not None else {}
    lookup = MagicMock(side_effect=lambda _table, ids: (
        [{'feedback_id': i} for i in ids if i not in (missing or [])],
        [i for i in ids if i in (missing or [])],
    ))
    event = api_gateway_event(
        method='GET',
        path='/projects/proj-1/personas/p1/feedback',
        path_params={'project_id': 'proj-1', 'persona_id': 'p1'},
        query_params=query or {},
    )
    with patch('projects.projects_table', table), \
         patch('projects._get_feedback_by_ids', lookup):
        response = lambda_handler(event, lambda_context)
    return response, json.loads(response['body']), table, lookup


class TestPersonaSourceFeedbackRoute:
    def test_cited_scope_returns_the_reviews_this_persona_cites(self, api_gateway_event, lambda_context):
        response, body, table, _ = _get(api_gateway_event, lambda_context,
                                        row=PERSONA_ROW, query={'scope': 'cited'})

        assert response['statusCode'] == 200
        assert body['available'] is True
        assert [i['feedback_id'] for i in body['items']] == ['fb2', 'fb5']
        assert body['total'] == 2
        assert body['provenance']['items_matched'] == 900
        # Only the requested list is read off the row, not the whole persona.
        assert table.get_item.call_args.kwargs['ExpressionAttributeNames'] == {
            '#ids': 'evidence_feedback_ids',
        }

    def test_cited_is_the_default_scope(self, api_gateway_event, lambda_context):
        _, body, _, _ = _get(api_gateway_event, lambda_context, row=PERSONA_ROW)
        assert body['scope'] == 'cited'

    def test_used_scope_pages_through_the_whole_batch_input(self, api_gateway_event, lambda_context):
        _, body, _, lookup = _get(api_gateway_event, lambda_context, row=PERSONA_ROW,
                                  query={'scope': 'used', 'offset': '4', 'limit': '3'})

        assert [i['feedback_id'] for i in body['items']] == ['fb5', 'fb6', 'fb7']
        assert body['total'] == 10
        assert body['offset'] == 4
        lookup.assert_called_once()

    def test_reports_feedback_deleted_since_generation(self, api_gateway_event, lambda_context):
        _, body, _, _ = _get(api_gateway_event, lambda_context, row=PERSONA_ROW,
                             query={'scope': 'cited'}, missing=['fb5'])

        assert [i['feedback_id'] for i in body['items']] == ['fb2']
        assert body['missing'] == 1

    def test_a_persona_from_before_tracking_is_unavailable_not_empty(
        self, api_gateway_event, lambda_context,
    ):
        """Its "Review #N" citations point into a list nothing kept."""
        _, body, _, lookup = _get(api_gateway_event, lambda_context,
                                  row={'persona_id': 'p1'}, query={'scope': 'cited'})

        assert body['available'] is False
        assert body['items'] == []
        lookup.assert_not_called()

    def test_an_unknown_scope_is_a_400(self, api_gateway_event, lambda_context):
        response, body, _, _ = _get(api_gateway_event, lambda_context,
                                    row=PERSONA_ROW, query={'scope': 'everything'})
        assert response['statusCode'] == 400
        assert 'scope' in body['error']

    def test_a_missing_persona_is_a_404(self, api_gateway_event, lambda_context):
        response, _, _, _ = _get(api_gateway_event, lambda_context, row=None)
        assert response['statusCode'] == 404

    def test_the_page_size_is_capped(self, api_gateway_event, lambda_context):
        """Each id is one lookup, so a huge limit must not reach the table."""
        from projects_handler import PERSONA_FEEDBACK_PAGE_MAX

        row = {**PERSONA_ROW, 'input_feedback_ids': [f'fb{i}' for i in range(500)]}
        _, body, _, _ = _get(api_gateway_event, lambda_context, row=row,
                             query={'scope': 'used', 'limit': '10000'})
        assert len(body['items']) == PERSONA_FEEDBACK_PAGE_MAX


class TestPersonaFeedbackPreviewRoute:
    @staticmethod
    def _post(api_gateway_event, lambda_context, body, pool, estimate=None):
        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-1/personas/preview-feedback',
            path_params={'project_id': 'proj-1'},
            body=body,
        )
        with patch('projects._read_feedback_pool', return_value=pool) as read, \
             patch('projects._estimate_feedback_matches', return_value=estimate) as estimator:
            response = lambda_handler(event, lambda_context)
        return response, json.loads(response['body']), read, estimator

    def test_returns_the_match_count_and_the_sample_limit(self, api_gateway_event, lambda_context):
        import projects

        response, body, _, estimator = self._post(api_gateway_event, lambda_context,
                                                  {'days': 30}, ([{}] * 900, False))

        assert response['statusCode'] == 200
        assert body == {
            'matched': 900,
            'matched_is_lower_bound': False,
            'sample_limit': projects.persona_context_budget()[1],
            'estimated': False,
        }
        estimator.assert_not_called()

    def test_estimate_mode_answers_from_the_sample_without_the_full_read(
        self, api_gateway_event, lambda_context,
    ):
        response, body, read, estimator = self._post(
            api_gateway_event, lambda_context, {'days': 30, 'mode': 'estimate'},
            ([], False), estimate=28_000,
        )

        assert response['statusCode'] == 200
        assert body['matched'] == 28_000
        assert body['estimated'] is True
        read.assert_not_called()
        estimator.assert_called_once()

    def test_an_estimate_too_thin_to_show_is_null_not_zero(self, api_gateway_event, lambda_context):
        """Zero means "generation will fail"; a thin sample must not say that."""
        _, body, _, _ = self._post(api_gateway_event, lambda_context,
                                   {'mode': 'estimate'}, ([], False), estimate=None)
        assert body['matched'] is None

    def test_an_unknown_mode_is_a_400(self, api_gateway_event, lambda_context):
        response, body, read, _ = self._post(api_gateway_event, lambda_context,
                                             {'mode': 'guess'}, ([], False))
        assert response['statusCode'] == 400
        assert 'mode' in body['error']
        read.assert_not_called()

    def test_a_repeated_exact_count_is_answered_from_the_cache(self, api_gateway_event, lambda_context):
        """Toggling a filter off and on again must not re-read the window."""
        from projects_handler import lambda_handler

        def event(body):
            return api_gateway_event(
                method='POST', path='/projects/proj-1/personas/preview-feedback',
                path_params={'project_id': 'proj-1'}, body=body,
            )

        with patch('projects._read_feedback_pool', return_value=([{}] * 7, False)) as read:
            lambda_handler(event({'days': 30, 'sentiments': ['negative', 'mixed']}), lambda_context)
            # Same selection, different click order: still one read.
            second = lambda_handler(event({'days': 30, 'sentiments': ['mixed', 'negative']}), lambda_context)

        assert read.call_count == 1
        assert json.loads(second['body'])['matched'] == 7

    def test_a_cut_short_count_is_not_cached(self, api_gateway_event, lambda_context):
        """A read stopped by the deadline may finish next time."""
        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST', path='/projects/proj-1/personas/preview-feedback',
            path_params={'project_id': 'proj-1'}, body={'days': 30},
        )
        with patch('projects._read_feedback_pool', return_value=([{}] * 3, True)) as read:
            lambda_handler(event, lambda_context)
            lambda_handler(event, lambda_context)

        assert read.call_count == 2

    def test_an_estimate_request_gets_the_exact_count_once_it_is_cached(
        self, api_gateway_event, lambda_context,
    ):
        from projects_handler import lambda_handler

        def event(body):
            return api_gateway_event(
                method='POST', path='/projects/proj-1/personas/preview-feedback',
                path_params={'project_id': 'proj-1'}, body=body,
            )

        with patch('projects._read_feedback_pool', return_value=([{}] * 42, False)), \
             patch('projects._estimate_feedback_matches', return_value=40) as estimator:
            lambda_handler(event({'days': 30}), lambda_context)
            response = lambda_handler(event({'days': 30, 'mode': 'estimate'}), lambda_context)

        body = json.loads(response['body'])
        assert (body['matched'], body['estimated']) == (42, False)
        estimator.assert_not_called()

    def test_counts_with_the_same_scope_generation_uses(self, api_gateway_event, lambda_context):
        """The shared-model filters reach the count exactly as they reach a job."""
        _, _, read, _ = self._post(api_gateway_event, lambda_context, {
            'days': 14,
            'sentiments': ['negative'],
            'custom_fields': {'tier_status': ['Gold']},
            'urgent': True,
        }, ([], False))

        filters = read.call_args.args[1]
        assert filters['days'] == 14
        assert filters['sentiments'] == ['negative']
        assert filters['feedback_filters'] == {
            'urgent': True, 'custom_fields': {'tier_status': ['Gold']},
        }

    def test_reports_a_lower_bound_count(self, api_gateway_event, lambda_context):
        _, body, _, _ = self._post(api_gateway_event, lambda_context, {}, ([{}] * 3, True))
        assert body['matched_is_lower_bound'] is True

    def test_the_count_is_bounded_to_answer_inside_the_request_timeout(
        self, api_gateway_event, lambda_context,
    ):
        """The projects Lambda times out at 30s, so the read must stop well before."""
        import time

        import projects

        before = time.monotonic()
        _, _, read, _ = self._post(api_gateway_event, lambda_context, {}, ([], False))

        deadline = read.call_args.kwargs['deadline']
        assert before < deadline <= time.monotonic() + projects.PERSONA_PREVIEW_READ_SECONDS
        assert projects.PERSONA_PREVIEW_READ_SECONDS < 29
