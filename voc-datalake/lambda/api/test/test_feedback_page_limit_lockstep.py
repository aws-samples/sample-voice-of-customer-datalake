"""The frontend's /feedback page size must match the endpoint's own maximum.

`validate_limit` CLAMPS an over-sized `limit` instead of rejecting it, so a
client asking for more rows than the endpoint allows gets a short page and no
error — only the echoed `limit` hints at it. That is exactly how Problem
Analysis came to derive a whole problem hierarchy from 100 rows while asking for
500 (U5b, PR #292).

The frontend now spends one constant, `FEEDBACK_PAGE_LIMIT`, and pages the
window. That only stays correct while the constant equals the server's
`max_val`: lower it and paging does needless round trips, raise it and every
page is silently truncated again.

Nothing in either language can see the other, so this test reads the TypeScript
constant directly — the same lockstep approach as
`lambda/shared/test/test_avatar_image_model_lockstep.py`.
"""
import re
from pathlib import Path

import pytest


def _repo_root() -> Path:
    # lambda/api/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


FRONTEND_SOURCE = 'frontend/src/api/feedbackPagination.ts'


def _read(relative: str) -> str:
    path = _repo_root() / relative
    assert path.is_file(), f'{relative} not found - did the file move?'
    return path.read_text(encoding='utf-8')


def _frontend_page_limit() -> int:
    path = _repo_root() / FRONTEND_SOURCE
    if not path.is_file():
        # This is a backend test reaching across into the frontend tree. Where
        # only the lambda sources are present (packaging, a partial checkout)
        # there is nothing to compare, and skipping beats a failure that says
        # nothing about the code under test.
        pytest.skip(f'{FRONTEND_SOURCE} not present in this tree')
    match = re.search(r'export const FEEDBACK_PAGE_LIMIT = (\d+)', path.read_text(encoding='utf-8'))
    assert match, f'FEEDBACK_PAGE_LIMIT not found in {FRONTEND_SOURCE}'
    return int(match.group(1))


def _list_feedback_limit_bounds() -> tuple[int, int]:
    """`(default, max_val)` from the `validate_limit` call in list_feedback."""
    source = _read('lambda/api/metrics_handler.py')
    # Scope the search to the @app.get("/feedback") handler so another
    # endpoint's limit cannot satisfy this test. The handler body ends at the
    # next route decorator of ANY verb -- and at end-of-file if /feedback
    # happens to be the last route, which `str.index` would turn into a
    # ValueError rather than a readable failure.
    marker = '@app.get("/feedback")'
    start = source.find(marker)
    assert start != -1, f'{marker} not found in metrics_handler.py'
    next_route = re.search(
        r'^@app\.(get|post|put|patch|delete|route)\(',
        source[start + len(marker):],
        re.MULTILINE,
    )
    end = start + len(marker) + (next_route.start() if next_route else len(source))
    match = re.search(
        r'limit = validate_limit\(params\.get\(.limit.\),\s*default=(\d+),\s*max_val=(\d+)\)',
        source[start:end],
    )
    assert match, 'validate_limit(...) call not found in list_feedback'
    return int(match.group(1)), int(match.group(2))


class TestFeedbackPageLimitLockstep:
    def test_frontend_page_size_equals_the_endpoint_maximum(self):
        frontend = _frontend_page_limit()
        _, max_val = _list_feedback_limit_bounds()
        assert frontend == max_val, (
            f'FEEDBACK_PAGE_LIMIT is {frontend} but /feedback caps limit at {max_val}. '
            'Raising the client constant does not raise the cap - the server clamps '
            'and says nothing, so every paged read is silently truncated. Change both, '
            'or neither.'
        )

    def test_the_default_is_not_itself_above_the_cap(self):
        # A `default` above `max_val` would clamp the unparameterised call too,
        # which is the same trap with no caller to blame.
        default, max_val = _list_feedback_limit_bounds()
        assert default <= max_val
