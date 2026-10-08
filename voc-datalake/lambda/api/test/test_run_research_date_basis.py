"""The synchronous research fallback honours and records `date_basis` (#258).

`run_research` serves POST /projects/{id}/research when no state machine is
configured. It used to build its filters without `date_basis`, so the feedback
query fell back to the import date while the Step Functions path used the
requested basis — two paths, two corpora, nothing on the report to say which.
"""
from unittest.mock import MagicMock, patch

import pytest

FEEDBACK = [{'feedback_id': 'f1', 'source_platform': 'web', 'original_text': 'slow'}]


@pytest.fixture
def research():
    """Run run_research for p1 with ``body``: (feedback-query mock, saved item)."""
    def run(body: dict, project_filters: dict | None = None):
        project = {'project': {'filters': project_filters or {}}}
        save = MagicMock()
        with patch('projects.projects_table', MagicMock()), \
                patch('projects.get_project', return_value=project), \
                patch('projects.get_scoped_feedback_context', return_value=FEEDBACK) as query, \
                patch('projects.converse_chain', return_value=['analysis', 'summary', 'validation']), \
                patch('shared.project_writes.put_project_item_and_increment', save):
            from projects import run_research

            run_research('p1', body, category_scope=None)
        return query.call_args.args[0], save.call_args.args[2]
    return run


def test_the_requested_basis_reaches_the_feedback_query(research):
    filters, _ = research({'question': 'Why?', 'sources': ['web'], 'date_basis': 'review'})

    assert filters['date_basis'] == 'review'


def test_the_basis_survives_falling_back_to_the_project_filters(research):
    filters, _ = research({'date_basis': 'review'}, project_filters={'sources': ['app'], 'days': 7})

    assert (filters['sources'], filters['date_basis']) == (['app'], 'review')


def test_an_unknown_basis_is_validated_to_the_default(research):
    filters, _ = research({'sources': ['web'], 'date_basis': 'bogus'})

    assert filters['date_basis'] == 'imported'


def test_the_report_header_and_the_item_record_the_basis(research):
    _, item = research({'sources': ['web'], 'date_basis': 'review'})

    assert item['date_basis'] == 'review'
    assert '| Date basis: review' in item['content']
