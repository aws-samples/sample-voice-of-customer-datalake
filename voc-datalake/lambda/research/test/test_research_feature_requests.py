"""Research with board requests (opt-in): the fenced section rides the feedback block's scratch
object, the ids ride the derivation, and the saved report states how many reached the model."""
from unittest.mock import MagicMock, patch

import pytest

from shared.feature_request_evidence import FeatureRequestEvidence

REQUEST = {'request_id': 'fr_00000000000000bb', 'board_id': 'brd_sales', 'title': 'Family seating',
           'description': 'Seat families together', 'status': 'planned', 'supporters': 3, 'category': 'Booking',
           'sentiment': 'negative', 'problem_summary': 'Families are split up', 'created_at': '2026-01-01'}


@patch('research_step_handler.get_feedback_context')
@patch('research_step_handler.get_feedback_statistics', MagicMock(return_value='stats'))
def _initialize(config: dict, mock_get_fb: MagicMock, load: MagicMock) -> dict:
    from research_step_handler import step_initialize
    mock_get_fb.return_value = [{'original_text': f'review {i}', 'feedback_id': f'fb{i}'} for i in range(3)]
    with patch('shared.feature_request_context.load_feature_request_evidence', load):
        return step_initialize({'project_id': 'p1', 'job_id': 'job_1', 'research_config': config})


@pytest.mark.usefixtures('mock_tables', 'mock_job_status')
def test_requests_reach_the_stashed_block_and_the_derivation(scratch_s3):
    load = MagicMock(return_value=FeatureRequestEvidence([REQUEST], 1, False))
    result = _initialize({'question': 'Q', 'days': 30, 'include_feature_requests': True,
                          'feature_request_board_ids': ['brd_sales']}, load=load)
    stashed = scratch_s3.objects[('test-raw', 'scratch/research_jobs/job_1/feedback_context.txt')].decode()
    assert '[FR:fr_00000000000000bb] Family seating' in stashed
    assert stashed.index('### Review ') < stashed.index('<feature_requests>')
    assert result['derivation']['input_feature_request_ids'] == ['fr_00000000000000bb']
    assert load.call_args.kwargs == {'board_ids': ['brd_sales'], 'days': 30, 'limit': 200}


@pytest.mark.usefixtures('mock_tables', 'mock_job_status')
def test_without_the_flag_nothing_is_read_or_recorded(scratch_s3):
    load = MagicMock()
    result = _initialize({'question': 'Q', 'days': 30}, load=load)
    load.assert_not_called()
    stashed = scratch_s3.objects[('test-raw', 'scratch/research_jobs/job_1/feedback_context.txt')].decode()
    assert '<feature_requests>' not in stashed
    assert 'input_feature_request_ids' not in result['derivation']


def test_the_report_header_counts_the_requests():
    from research_step_handler import _feature_requests_line
    event = {'derivation': {'input_feature_request_ids': ['fr_1', 'fr_2']}}
    assert _feature_requests_line(event) == '\n**Feature Requests Analyzed:** 2 from the feedback boards'
    assert _feature_requests_line({'derivation': {}}) == ''
    assert _feature_requests_line({'derivation': {'input_feature_request_ids': 'fr_1'}}) == ''
    assert _feature_requests_line({}) == ''
