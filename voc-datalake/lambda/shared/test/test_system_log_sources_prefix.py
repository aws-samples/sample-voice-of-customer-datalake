"""`_common_prefix` (shared/system_log_sources.py) replaced `os.path.commonprefix` in 5.57.03 (ruff RUF071).

Log group prefixes are compared as TEXT, character by character, as commonprefix did: the shared prefix may end
mid-segment, and the order of the values does not matter.
"""
from __future__ import annotations

import pytest

from shared.system_log_sources import _common_prefix


@pytest.mark.parametrize(('values', 'expected'), [
    pytest.param([], '', id='no values'),
    pytest.param([''], '', id='one empty value'),
    pytest.param(['/aws/lambda/voc-'], '/aws/lambda/voc-', id='one value is its own prefix'),
    pytest.param(['/aws/lambda/voc-metrics-api', '/aws/lambda/voc-metrics-api'], '/aws/lambda/voc-metrics-api', id='equal values'),
    pytest.param(['/aws/lambda/voc-metrics-api', '/aws/lambda/voc-memory-api'], '/aws/lambda/voc-me', id='ends mid-segment'),
    pytest.param(['/aws/lambda/voc-abc', '/aws/lambda/voc-a', '/aws/lambda/voc-ab'], '/aws/lambda/voc-a', id='one value prefixes the others'),
    pytest.param(['/aws/lambda/x', '/aws/stepfunctions/x'], '/aws/', id='diverges after a slash'),
    pytest.param(['b-prefix', 'a-prefix', 'c-prefix'], '', id='unordered, nothing shared'),
])
def test_it_answers_the_longest_shared_text_prefix(values: list[str], expected: str) -> None:
    assert _common_prefix(values) == expected
