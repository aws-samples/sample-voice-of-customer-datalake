"""How a review link's ``DOCSHARE#{id}`` row routes (shared/review_share_audience.py ``routing_of``,
``routed_share``; docs/multi-workspace.md, the project plan, 3e).

Pure functions: no table. The trigger's and the reviewer routes' use of them is covered in
auth/test/test_board_triggers_workspace.py and test_document_share_workspace.py; these pin the rules, and pin the
stdlib copy of the workspace id rule to shared/workspace_ids.py's.
"""
from __future__ import annotations

import pytest

from shared import workspace_ids
from shared.review_share_audience import WORKSPACE_ID_RE, routed_share, routing_of

SHARE = 'shr_' + 'a' * 32
WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'


def test_a_row_naming_no_workspace_is_the_deployments_link():
    row = {'pk': f'DOCSHARE#{SHARE}', 'sk': 'META', 'share_id': SHARE}
    assert routing_of(row) == (row, None)


def test_a_routing_row_names_its_workspace_and_is_never_a_link():
    assert routing_of({'pk': f'DOCSHARE#{SHARE}', 'sk': 'META', 'workspace_id': WS,
                       'audience': {'mode': 'anyone'}}) == (None, WS)


@pytest.mark.parametrize('row', [None, 'DOCSHARE#x', [], {'workspace_id': None}, {'workspace_id': 'ws_short'},
                                 {'workspace_id': WS.lower()}, {'workspace_id': f'{WS}#x'}, {'workspace_id': 7}])
def test_no_row_or_a_malformed_route_names_nothing(row):
    assert routing_of(row) == (None, None)


def test_the_routed_link_is_kept_only_when_it_is_that_ids():
    link = {'share_id': SHARE, 'audience': {'mode': 'anyone'}}
    assert routed_share(SHARE, link) is link
    assert routed_share(SHARE, {'share_id': 'shr_' + 'b' * 32}) is None
    assert routed_share(SHARE, {**link, 'workspace_id': WS}) is None
    assert routed_share(SHARE, None) is None


@pytest.mark.parametrize('value', [
    WS, 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ', 'ws_8JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DI',
    'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D', WS.lower(), f'{WS}0', '',
])
def test_the_stdlib_workspace_id_rule_is_the_layers(value):
    assert (WORKSPACE_ID_RE.fullmatch(value) is not None) == workspace_ids.is_workspace_id(value)
