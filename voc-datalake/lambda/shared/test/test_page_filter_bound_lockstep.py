"""The assistant's filter-value bound holds the longest facet list the read routes accept.

`shared/item_facets.py` lets one facet carry ``MAX_FACET_VALUES`` values of up to
``MAX_FACET_VALUE_CHARS`` each (the Categories page and the /chat panel send them as one
comma list). The assistant contract (`MAX_PAGE_FILTER_CHARS`, in the stream Lambda and its
SPA mirror) bounds each `page.filters` / `scope.filters` value. A bound below the longest list
made an on-screen filter fail the contract, and a scope the contract refuses must never reach
a run as no floor at all (PR #505 review). Same pattern as `test_lookback_window_lockstep.py`:
parse the TypeScript source and assert the property.
"""
import re

import pytest

from shared.item_facets import MAX_FACET_VALUE_CHARS, MAX_FACET_VALUES
from shared.test.repo_paths import repo_root

CONTRACTS = (
    'lambda/stream/src/assistant/contract.ts',
    'frontend/src/assistant/contract.ts',
)
_BOUND = re.compile(r'^export const MAX_PAGE_FILTER_CHARS = (\d[\d_]*);?$', re.MULTILINE)


def _bound(path: str) -> int:
    match = _BOUND.search((repo_root() / path).read_text(encoding='utf-8'))
    assert match is not None, f'MAX_PAGE_FILTER_CHARS not found in {path}: renamed or no longer a literal'
    return int(match.group(1).replace('_', ''))


@pytest.mark.parametrize('path', CONTRACTS)
def test_the_contract_bound_holds_the_longest_facet_list(path):
    longest_list = MAX_FACET_VALUES * MAX_FACET_VALUE_CHARS + (MAX_FACET_VALUES - 1)
    assert _bound(path) >= longest_list


def test_the_stream_and_the_spa_agree_on_the_bound():
    assert _bound(CONTRACTS[0]) == _bound(CONTRACTS[1])
