"""Persona generation with board requests (opt-in): the analysis and every persona call read the
fenced section, and each saved persona records ``input_feature_request_ids``."""
from unittest.mock import MagicMock, patch

import pytest

from api.test.handler_events_fixtures import transacting_projects_table
from api.test.persona_fakes import ANALYSIS_STEP, PERSONA_STEP, PLAN_STEP, FakePersonaModel
from shared.feature_request_evidence import FeatureRequestEvidence

FEEDBACK = [{'feedback_id': f'fb-{i}', 'source_platform': 'app_store', 'original_text': f'Review {i}',
             'sentiment_label': 'negative', 'category': 'usability'} for i in range(4)]
REQUEST = {'request_id': 'fr_00000000000000aa', 'board_id': 'brd_sales', 'title': 'Offline boarding pass',
           'description': 'Show it without a signal', 'status': 'new', 'supporters': 5, 'category': None,
           'sentiment': None, 'problem_summary': None, 'created_at': '2026-01-01'}


@pytest.fixture
def world():
    table = transacting_projects_table()
    table.get_item.return_value = {'Item': {'pk': 'PROJECT#proj-1', 'sk': 'META'}}
    model = FakePersonaModel(['Ada Moreno'])
    load = MagicMock(return_value=FeatureRequestEvidence([REQUEST], 1, False))
    with patch('api.projects.projects_table', table), \
            patch('api.projects.get_feedback_context', return_value=FEEDBACK), \
            patch('api.projects.converse_detailed', model), \
            patch('shared.feature_request_context.load_feature_request_evidence', load):
        yield table, model, load


def test_requests_reach_the_analysis_and_persona_calls_and_are_recorded(world):
    from api.projects import generate_personas
    table, model, load = world
    result = generate_personas('proj-1', {'persona_count': 1, 'generate_avatars': False, 'days': 30,
                                          'include_feature_requests': True, 'feature_request_board_ids': ['brd_sales']})
    assert load.call_args.kwargs['board_ids'] == ['brd_sales']
    assert '[FR:fr_00000000000000aa]' in model.prompts(ANALYSIS_STEP)[0]
    assert '[FR:fr_00000000000000aa]' in model.prompts(PERSONA_STEP)[0]
    assert '[FR:' not in model.prompts(PLAN_STEP)[0]
    saved = table.put_item.call_args.kwargs['Item']
    assert saved['input_feature_request_ids'] == ['fr_00000000000000aa']
    assert result['metadata']['feature_requests_used'] == 1


def test_without_the_flag_nothing_is_read_or_recorded(world):
    from api.projects import generate_personas
    table, model, load = world
    result = generate_personas('proj-1', {'persona_count': 1, 'generate_avatars': False})
    load.assert_not_called()
    assert '[FR:' not in model.prompts(ANALYSIS_STEP)[0]
    assert 'input_feature_request_ids' not in table.put_item.call_args.kwargs['Item']
    assert result['metadata']['feature_requests_used'] == 0
