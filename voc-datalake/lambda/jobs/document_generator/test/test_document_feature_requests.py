"""PRD / PR-FAQ generation with board requests (``data_sources.feature_requests``): the fenced
section follows the reviews in the feedback block, and the derivation records the ids."""
from unittest.mock import MagicMock, patch

from jobs.document_generator import handler
from shared.feature_request_evidence import FeatureRequestEvidence
from shared.grounding import Grounding

REQUEST = {'request_id': 'fr_00000000000000cc', 'board_id': 'brd_sales', 'title': 'Meal preorder',
           'description': 'Choose a meal before the flight', 'status': 'new', 'supporters': 2, 'category': None,
           'sentiment': None, 'problem_summary': None, 'created_at': '2026-01-01'}


def _gather(doc_config: dict, load: MagicMock) -> handler.GatheredContext:
    with patch('shared.feature_request_context.load_feature_request_evidence', load), \
            patch.object(handler, '_feedback_context', return_value=handler.FeedbackSample('REVIEWS', 1, False)):
        return handler._gather_context(MagicMock(), MagicMock(), MagicMock(), 'p1', doc_config)


def test_requests_follow_the_reviews_and_reach_the_derivation():
    load = MagicMock(return_value=FeatureRequestEvidence([REQUEST], 1, False))
    gathered = _gather({'days': 14, 'data_sources': {'feedback': True, 'feature_requests': True},
                        'feature_request_board_ids': ['brd_sales']}, load)
    assert gathered.feedback_context.startswith('REVIEWS')
    assert '[FR:fr_00000000000000cc] Meal preorder' in gathered.feedback_context
    assert gathered.feature_request_ids == ('fr_00000000000000cc',)
    assert load.call_args.kwargs == {'board_ids': ['brd_sales'], 'days': 14, 'limit': 200}
    derivation = handler._derivation(gathered, False, Grounding())
    assert derivation['input_feature_request_ids'] == ['fr_00000000000000cc']
    assert derivation['feedback_count'] == 1


def test_not_asked_reads_nothing_and_records_nothing():
    load = MagicMock()
    gathered = _gather({'data_sources': {'feedback': True}}, load)
    load.assert_not_called()
    assert gathered.feedback_context == 'REVIEWS'
    assert 'input_feature_request_ids' not in handler._derivation(gathered, False, Grounding())
