"""Feedback-selection filters never reach the logs with their values.

A filter dict can carry user-written text (``custom_instructions``) and the
selection lists themselves. Each test plants a sentinel in the payload and
fails when that sentinel appears anywhere in a logger call.
Sentinel idea ported from PR #330 (shin4141).
"""
from unittest.mock import MagicMock, patch

import pytest

import projects
from shared.exceptions import ConfigurationError, ValidationError

SENTINEL = 'QW_PRIVATE_FILTER_SENTINEL'


def _logged(logger_mock: MagicMock) -> str:
    return str(logger_mock.mock_calls)


def test_persona_generation_logs_no_custom_instructions_or_selection_values():
    filters = {
        'custom_instructions': SENTINEL,
        'sources': [SENTINEL],
        'categories': [SENTINEL],
        'days': 30,
        'persona_count': 2,
    }
    with patch.object(projects, 'projects_table', None), \
            patch.object(projects, 'logger') as logger, \
            pytest.raises(ConfigurationError):
        projects.generate_personas('project-1', filters)
    assert SENTINEL not in _logged(logger)
    logger.info.assert_any_call('[PERSONA] Filters', extra={'filters': {
        'days': 30, 'persona_count': 2, 'sources_count': 1, 'categories_count': 1,
        'other_field_count': 1,
    }})


def test_research_fallback_logs_no_project_filter_text_or_selection_values():
    project_filters = {'sources': [SENTINEL], 'categories': [], 'sentiments': [],
                       'days': 7, 'custom_instructions': SENTINEL}
    with patch.object(projects, 'projects_table', MagicMock()), \
            patch.object(projects, 'get_project',
                         return_value={'project': {'filters': project_filters}}), \
            patch.object(projects, 'get_scoped_feedback_context', return_value=[]), \
            patch.object(projects, 'logger') as logger, \
            pytest.raises(ValidationError):
        projects.run_research('project-1', {'question': 'q'}, category_scope=None)
    assert SENTINEL not in _logged(logger)


@pytest.mark.parametrize('filters', [None, 'text', ['a']])
def test_summary_of_a_non_dict_filter_is_empty(filters):
    assert projects.filters_log_summary(filters) == {}


def test_summary_drops_a_long_scalar_and_counts_unknown_fields():
    summary = projects.filters_log_summary({'date_basis': SENTINEL * 2, 'brief': SENTINEL})
    assert summary == {'other_field_count': 1}
