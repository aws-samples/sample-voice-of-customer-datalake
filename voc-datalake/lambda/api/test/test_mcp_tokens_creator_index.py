"""``GET /connect/tokens`` reads a user's tokens through the creator index (moto).

The pointer rows (``CREATOR#{sub}#TOKEN#{id}``, shared/mcp_global_tokens.py) turn
"my tokens" into a key-condition Query on the caller's prefix plus a consistent
BatchGetItem — no Scan and no read of the whole ``MCPGTOKEN`` partition once the
backfill marker exists. Before it exists the old layout is merged in, so tokens
minted before the index never vanish. The backfill script
(scripts/mcp_tokens/backfill_creator_index.py) is exercised against the same table.
"""
from __future__ import annotations

import sys
from collections.abc import Iterator
from contextlib import nullcontext
from typing import Any
from unittest.mock import patch

import pytest
from global_mcp_world import World, global_mcp_world

from shared import mcp_global_tokens as gt
from shared.test.repo_paths import load_module_from_path, repo_root

_SCRIPT = repo_root() / 'scripts' / 'mcp_tokens' / 'backfill_creator_index.py'


@pytest.fixture
def world(lambda_context) -> Iterator[World]:
    with global_mcp_world(lambda_context) as built:
        yield built


@pytest.fixture(scope='module')
def backfill():
    module = load_module_from_path('backfill_creator_index', _SCRIPT)
    try:
        yield module
    finally:
        sys.modules.pop(module.__name__, None)


class _QuerySpy:
    """Records every Query on the projects table; optionally forces 1-item pages."""

    def __init__(self, table: Any, page_size: int | None = None):
        self.page_size = page_size
        self.calls: list[dict] = []
        self._query = table.query

    def __call__(self, **kwargs: Any) -> dict:
        self.calls.append(kwargs)
        if self.page_size:
            kwargs = {**kwargs, 'Limit': self.page_size}
        return self._query(**kwargs)

    def sort_key_prefixes(self) -> list[str]:
        prefixes = []
        for call in self.calls:
            _, sk_condition = call['KeyConditionExpression']._values
            assert sk_condition.expression_operator == 'begins_with'
            prefixes.append(sk_condition._values[1])
        return prefixes


def _list(world: World, username: str, spy: _QuerySpy | None = None) -> list[dict]:
    with patch.object(world.projects, 'query', spy) if spy else nullcontext(), \
            patch.object(world.projects, 'scan', side_effect=AssertionError('no Scan')):
        status, body = world.tokens_api(username, 'GET', '/connect/tokens')
    assert status == 200, body
    return body['tokens']


def _legacy_token(world: World, username: str, token_id: str) -> None:
    """A row as minted BEFORE the index: the token row with no pointer."""
    world.projects.put_item(Item={
        'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.token_sk(token_id), 'token_id': token_id, 'name': 'old',
        'secret_hash': 'x', 'scope': 'read', 'created_by': world.subs[username],
        'created_at': '2026-01-01T00:00:00+00:00', 'expires_at': '2099-01-01T00:00:00+00:00',
    })


def _mark_backfilled(world: World) -> None:
    world.projects.put_item(Item={'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.CREATOR_INDEX_MARKER_SK})


class TestTheIndexedList:
    def test_a_mint_writes_the_pointer_beside_the_token(self, world):
        minted = world.mint('alice', scope='read')
        pointer = world.projects.get_item(
            Key={'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.creator_index_sk(world.subs['alice'], minted['token_id'])},
        )['Item']
        assert pointer['token_id'] == minted['token_id']
        assert 'secret_hash' not in pointer

    def test_once_backfilled_only_the_callers_prefix_is_queried(self, world):
        mine = {world.mint('alice', scope='read')['token_id'] for _ in range(3)}
        for _ in range(4):
            world.mint('bob', scope='read')
        _mark_backfilled(world)
        spy = _QuerySpy(world.projects)

        listed = _list(world, 'alice', spy)

        assert {t['token_id'] for t in listed} == mine
        assert set(spy.sort_key_prefixes()) == {gt.creator_index_prefix(world.subs['alice'])}
        assert all('FilterExpression' not in call for call in spy.calls)

    def test_pointer_pages_are_followed_to_the_end(self, world):
        mine = {world.mint('alice', scope='read')['token_id'] for _ in range(5)}
        _mark_backfilled(world)
        spy = _QuerySpy(world.projects, page_size=1)

        assert {t['token_id'] for t in _list(world, 'alice', spy)} == mine
        assert len(spy.calls) >= 5  # one item per page: pagination, not one big read

    def test_other_users_tokens_are_never_returned(self, world):
        bobs = world.mint('bob', scope='write')
        # A stray pointer under alice's prefix naming bob's token must not leak it.
        world.projects.put_item(Item=gt.creator_index_item(world.subs['alice'], bobs['token_id'], 'x'))
        _mark_backfilled(world)

        assert _list(world, 'alice') == []
        assert [t['token_id'] for t in _list(world, 'bob')] == [bobs['token_id']]

    def test_revoke_and_the_cap_work_through_the_index(self, world):
        with patch.object(gt, 'MAX_ACTIVE_TOKENS_PER_USER', 1):
            first = world.mint('alice', scope='read')
            assert world.tokens_api('alice', 'POST', '/connect/tokens', {'name': 'x', 'scope': 'read'})[0] == 409
            world.tokens_api('alice', 'DELETE', f"/connect/tokens/{first['token_id']}")
            assert world.tokens_api('alice', 'POST', '/connect/tokens', {'name': 'x', 'scope': 'read'})[0] == 200


class TestTheOldLayoutUntilBackfilled:
    def test_a_pre_index_token_is_still_listed_without_the_marker(self, world):
        _legacy_token(world, 'alice', 'tok_legacy0000000001')
        _legacy_token(world, 'bob', 'tok_legacy0000000002')
        new = world.mint('alice', scope='read')

        listed = {t['token_id'] for t in _list(world, 'alice')}

        assert listed == {'tok_legacy0000000001', new['token_id']}

    def test_the_marker_stops_the_partition_read(self, world):
        _legacy_token(world, 'alice', 'tok_legacy0000000001')
        _mark_backfilled(world)
        spy = _QuerySpy(world.projects)

        assert _list(world, 'alice', spy) == []  # not backfilled, so invisible: the script must run first
        assert gt.token_sk('') not in spy.sort_key_prefixes()


class TestTheBackfillScript:
    def test_the_dry_run_writes_nothing(self, world, backfill):
        _legacy_token(world, 'alice', 'tok_legacy0000000001')
        before = world.projects.scan()['Items']

        report = backfill.run(world.projects, apply=False)

        assert (report.token_rows, report.pointers_missing, report.pointers_written) == (1, 1, 0)
        assert report.marker_written is False
        assert world.projects.scan()['Items'] == before

    def test_dry_run_is_the_default_cli_mode(self, backfill):
        assert backfill.parse_args([]).apply is False
        assert backfill.parse_args(['--dry-run']).apply is False
        assert backfill.parse_args(['--apply']).apply is True

    def test_apply_indexes_old_rows_writes_the_marker_and_is_idempotent(self, world, backfill):
        _legacy_token(world, 'alice', 'tok_legacy0000000001')
        minted = world.mint('alice', scope='read')

        first = backfill.run(world.projects, apply=True)
        second = backfill.run(world.projects, apply=True)

        assert (first.token_rows, first.already_indexed, first.pointers_written, first.marker_written) == (
            2, 1, 1, True)
        assert (second.already_indexed, second.pointers_written, second.marker_present, second.marker_written) == (
            2, 0, True, False)
        assert {t['token_id'] for t in _list(world, 'alice')} == {'tok_legacy0000000001', minted['token_id']}

    def test_a_malformed_row_withholds_the_marker(self, world, backfill):
        world.projects.put_item(Item={'pk': gt.GLOBAL_TOKEN_PK, 'sk': 'TOKEN#tok_x', 'token_id': 'tok_x'})

        report = backfill.run(world.projects, apply=True)

        assert (report.skipped_malformed, report.marker_written) == (1, False)

    def test_a_pointer_written_meanwhile_is_not_overwritten(self, world, backfill):
        _legacy_token(world, 'alice', 'tok_legacy0000000001')
        pointer = gt.creator_index_item(world.subs['alice'], 'tok_legacy0000000001', 'concurrent')
        real_get = world.projects.get_item

        def get_then_race(**kwargs: Any) -> dict:
            response = real_get(**kwargs)
            if kwargs['Key']['sk'] == pointer['sk']:
                world.projects.put_item(Item=pointer)  # a concurrent writer wins the race
            return response

        with patch.object(world.projects, 'get_item', side_effect=get_then_race):
            report = backfill.run(world.projects, apply=True)

        assert (report.pointers_written, report.pointers_raced, report.marker_written) == (0, 1, True)
        assert real_get(Key={'pk': pointer['pk'], 'sk': pointer['sk']})['Item']['created_at'] == 'concurrent'
