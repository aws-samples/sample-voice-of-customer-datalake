"""Synchronous project assists validate `date_basis` before reading feedback (#258).

PR-FAQ autofill, the document brief and research-question suggestions take
feedback filters from the request body (or the project) and read through
`projects.get_scoped_feedback_context`. That boundary passed `date_basis`
through unvalidated, so `'REVIEW'` silently windowed by import date and a
non-string reached the query as-is.
"""
from unittest.mock import MagicMock, patch

import pytest


class _StopAfterRead(Exception):
    """Raised by the patched feedback read so an assist stops before any model call."""


def _filters_read_by(function_name: str, body: dict) -> dict:
    """The filters ``function_name`` hands to the feedback read for ``body``."""
    import projects
    project = {'project': {'filters': {}}, 'personas': []}
    with patch('projects.projects_table', MagicMock()), \
            patch('projects.get_project', return_value=project), \
            patch('projects.get_feedback_context', side_effect=_StopAfterRead) as fetch, \
            pytest.raises(_StopAfterRead):
        getattr(projects, function_name)('p1', body, category_scope=None)
    return fetch.call_args.args[0]


@pytest.mark.parametrize('function_name', ['suggest_document_brief', 'suggest_research_questions'])
def test_a_body_basis_is_normalised_before_the_read(function_name):
    filters = _filters_read_by(function_name, {'filters': {'days': 7, 'date_basis': ' REVIEW '}})

    assert filters == {'days': 7, 'date_basis': 'review'}


@pytest.mark.parametrize('function_name', ['suggest_document_brief', 'suggest_research_questions'])
def test_an_unknown_basis_reads_by_import_date(function_name):
    filters = _filters_read_by(function_name, {'filters': {'date_basis': ['review']}})

    assert filters['date_basis'] == 'imported'


def test_prfaq_autofill_reads_with_a_validated_basis():
    filters = _filters_read_by('autofill_prfaq_questions', {})

    assert filters['date_basis'] == 'imported'
