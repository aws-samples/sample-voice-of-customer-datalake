"""shared.response_cache: the warm-container read memo (docs/caching.md)."""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from shared import category_access
from shared.api import create_api_resolver
from shared.category_access import CategoryScope
from shared.data_version import VersionRead, Versions
from shared.response_cache import (
    MAX_AGE_SECONDS,
    ResponseCache,
    is_cacheable,
    memoized_route,
    normalized_query,
    scope_fingerprint,
    serialized_size,
)

ORIGIN = 'http://localhost:5173'


def _event(path: str = '/thing', query: dict | None = None, groups: str = 'users', sub: str = 'sub-1') -> dict:
    return {
        'httpMethod': 'GET', 'path': path, 'resource': path,
        'headers': {'Origin': ORIGIN},
        'queryStringParameters': query,
        'requestContext': {'authorizer': {'claims': {'sub': sub, 'cognito:groups': groups}}},
    }


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class TestLru:
    def test_miss_then_hit(self):
        cache = ResponseCache()
        assert cache.get('k') is None
        cache.put('k', {'a': 1}, 10)
        assert cache.get('k') == {'a': 1}

    def test_a_hit_is_a_copy_the_caller_cannot_corrupt(self):
        cache = ResponseCache()
        cache.put('k', {'items': [1]}, 10)
        hit = cache.get('k')
        assert hit is not None
        hit['items'].append(2)
        assert cache.get('k') == {'items': [1]}

    def test_the_least_recently_used_entry_is_evicted_by_count(self):
        cache = ResponseCache(max_entries=2)
        cache.put('a', {}, 1)
        cache.put('b', {}, 1)
        cache.get('a')
        cache.put('c', {}, 1)
        assert [cache.get(k) is not None for k in ('a', 'b', 'c')] == [True, False, True]

    def test_entries_are_evicted_by_total_bytes(self):
        cache = ResponseCache(max_bytes=100)
        for key in range(6):
            cache.put(key, {}, 20)
        assert len(cache) == 5
        assert cache.get(0) is None

    def test_one_answer_too_large_is_not_kept(self):
        cache = ResponseCache(max_bytes=100)
        assert cache.put('huge', {}, 21) is False
        assert len(cache) == 0

    def test_an_entry_expires_after_the_max_age(self):
        clock = _Clock()
        cache = ResponseCache(clock=clock, max_bytes=100)
        cache.put('k', {'a': 1}, 20)
        clock.now += MAX_AGE_SECONDS + 1
        assert cache.get('k') is None
        # Its bytes were released: five fresh 20-byte answers fit again.
        for key in range(5):
            cache.put(key, {}, 20)
        assert len(cache) == 5

    def test_the_default_max_age_is_ten_minutes(self):
        assert MAX_AGE_SECONDS == 600


class TestWhatIsCacheable:
    @pytest.mark.parametrize('body', [
        {'is_partial': True},
        {'is_partial_window': True},
        {'partial_reason': 'time_budget'},
        {'summary': {'is_partial': True}},
        {'success': False, 'error': 'x'},
        ['a list'],
        'text',
    ])
    def test_partial_errors_and_non_objects_are_never_stored(self, body):
        assert is_cacheable(body) is False

    def test_a_complete_answer_is_stored(self):
        assert is_cacheable({'is_partial': False, 'items': [{'is_partial': True}]}) is True

    def test_the_size_is_the_json_body(self):
        assert serialized_size({'a': 1}) == len('{"a":1}')


class TestKeyParts:
    def test_the_query_is_order_insensitive(self):
        assert normalized_query(_event(query={'b': '2', 'a': '1'})) == normalized_query(_event(query={'a': '1', 'b': '2'}))

    def test_multi_values_are_kept(self):
        event = {**_event(query={'tag': 'b'}), 'multiValueQueryStringParameters': {'tag': ['a', 'b']}}
        assert normalized_query(event) == (('tag', ('a', 'b')),)

    def test_two_scopes_never_share_a_fingerprint(self):
        restricted = CategoryScope(all=False, categories=frozenset({'billing'}))
        other = CategoryScope(all=False, categories=frozenset({'delivery'}))
        assert scope_fingerprint(restricted, _event()) != scope_fingerprint(other, _event())

    def test_the_admin_flag_is_part_of_the_fingerprint(self):
        scope = category_access.UNRESTRICTED
        assert scope_fingerprint(scope, _event(groups='admins')) != scope_fingerprint(scope, _event())

    def test_the_source_rule_is_part_of_the_fingerprint(self):
        denied = CategoryScope(all=True, source_deny=frozenset({'secret_source'}))
        assert scope_fingerprint(denied, _event()) != scope_fingerprint(category_access.UNRESTRICTED, _event())


class _World:
    """A resolver with one memoized route whose scope and versions the test controls."""

    def __init__(self) -> None:
        self.cache = ResponseCache()
        self.calls = 0
        self.scope_calls = 0
        self.scope: CategoryScope = category_access.UNRESTRICTED
        self.read = VersionRead(Versions(1, 1), '2025-01-01')
        self.answer: dict[str, Any] = {'total': 1}
        self.app = create_api_resolver(ORIGIN)

        def scope() -> CategoryScope:
            self.scope_calls += 1
            return self.scope

        memo = memoized_route(self.app, scope=scope, versions=lambda: self.read, cache=self.cache)
        self.app.get('/thing')(memo(self._answer))

    def _answer(self) -> dict[str, Any]:
        self.calls += 1
        return dict(self.answer)

    def get(self, **kwargs: Any) -> dict:
        return self.app.resolve(_event(**kwargs), MagicMock())


class TestMemoizedRoute:
    def test_the_second_identical_request_is_served_from_the_memo(self):
        world = _World()
        first, second = world.get(), world.get()
        assert world.calls == 1
        assert first['body'] == second['body']

    def test_the_scope_is_resolved_on_every_request_even_on_a_hit(self):
        world = _World()
        world.get()
        world.get()
        assert world.scope_calls == 2

    def test_two_scopes_never_share_an_entry(self):
        world = _World()
        world.get()
        world.scope = CategoryScope(all=False, categories=frozenset({'billing'}))
        world.get()
        assert world.calls == 2

    def test_a_version_bump_is_a_miss(self):
        world = _World()
        world.get()
        world.read = VersionRead(Versions(2, 1), '2025-01-01')
        world.get()
        assert world.calls == 2

    def test_a_config_bump_is_a_miss(self):
        world = _World()
        world.get()
        world.read = VersionRead(Versions(1, 2), '2025-01-01')
        world.get()
        assert world.calls == 2

    def test_a_different_query_is_a_miss(self):
        world = _World()
        world.get(query={'days': '7'})
        world.get(query={'days': '30'})
        assert world.calls == 2

    def test_unknown_versions_mean_a_live_read_every_time(self):
        world = _World()
        world.read = VersionRead(None, None)
        world.get()
        world.get()
        assert world.calls == 2
        assert len(world.cache) == 0

    def test_a_partial_answer_is_recomputed(self):
        world = _World()
        world.answer = {'total': 1, 'is_partial': True, 'partial_reason': 'time_budget'}
        world.get()
        world.get()
        assert world.calls == 2
