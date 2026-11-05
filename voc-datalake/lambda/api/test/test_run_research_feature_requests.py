"""The synchronous research fallback never drops a ticked "Feature requests" box silently (tenet 2).

`run_research` runs in the projects Lambda, whose role holds no grant on voc-feature-requests, so it
cannot read the boards. When the body asks for them, the report says so and the saved item carries
`feature_requests_skipped: true`; it never claims or cites a board request.
"""
import pytest
from test_run_research_date_basis import _run_research

from shared.feature_request_context import FALLBACK_SKIPPED_FIELD, FALLBACK_SKIPPED_NOTE, SECTION_HEADING


def test_a_ticked_box_is_reported_on_the_report_and_the_item():
    _, item, prompts = _run_research({'sources': ['web'], 'include_feature_requests': True})

    assert FALLBACK_SKIPPED_NOTE in item['content']
    assert item[FALLBACK_SKIPPED_FIELD] is True
    assert 'input_feature_request_ids' not in item
    assert SECTION_HEADING.splitlines()[0] not in prompts


@pytest.mark.parametrize('body', [{'sources': ['web']}, {'sources': ['web'], 'include_feature_requests': False}])
def test_without_the_box_nothing_is_noted(body):
    _, item, _ = _run_research(body)

    assert FALLBACK_SKIPPED_NOTE not in item['content']
    assert FALLBACK_SKIPPED_FIELD not in item
