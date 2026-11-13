"""`shared.batch_get.batch_get_all`: chunks of 100, UnprocessedKeys retried, fails closed."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from shared import batch_get


def _table(*responses: dict) -> MagicMock:
    table = MagicMock()
    table.name = 't'
    table.meta.client.batch_get_item.side_effect = list(responses)
    return table


def _keys(count: int) -> list[dict]:
    return [{'pk': f'P#{i:03d}', 'sk': 'META'} for i in range(count)]


class Boom(Exception):
    pass


def test_250_keys_are_three_consistent_requests_of_at_most_100():
    table = _table(*({'Responses': {'t': [{'pk': 'x'}]}} for _ in range(3)))

    rows = batch_get.batch_get_all(table, _keys(250), failure=Boom(),
                                   read_options={'ProjectionExpression': 'pk'})

    assert rows == [{'pk': 'x'}] * 3
    requests = [c.kwargs['RequestItems']['t'] for c in table.meta.client.batch_get_item.call_args_list]
    assert [len(r['Keys']) for r in requests] == [100, 100, 50]
    assert all(r['ConsistentRead'] is True and r['ProjectionExpression'] == 'pk' for r in requests)
    assert requests[2]['Keys'][0] == {'pk': 'P#200', 'sk': 'META'}


def test_unprocessed_keys_are_re_asked_after_a_backoff():
    leftover = {'t': {'Keys': [{'pk': 'P#001', 'sk': 'META'}], 'ConsistentRead': True}}
    table = _table({'Responses': {'t': [{'pk': 'P#000'}]}, 'UnprocessedKeys': leftover},
                   {'Responses': {'t': [{'pk': 'P#001'}, 'not-a-row']}})

    with patch.object(batch_get.time, 'sleep') as sleep, patch.object(batch_get.random, 'uniform') as jitter:
        jitter.side_effect = lambda _low, high: high
        rows = batch_get.batch_get_all(table, _keys(2), failure=Boom())

    assert rows == [{'pk': 'P#000'}, {'pk': 'P#001'}]
    assert table.meta.client.batch_get_item.call_args_list[1].kwargs['RequestItems'] == leftover
    jitter.assert_called_once_with(0, batch_get.BATCH_GET_BACKOFF_SECONDS * 2)
    sleep.assert_called_once_with(batch_get.BATCH_GET_BACKOFF_SECONDS * 2)


def test_keys_still_unprocessed_after_every_attempt_raise_the_callers_failure():
    stuck = {'Responses': {}, 'UnprocessedKeys': {'t': {'Keys': [{'pk': 'P#000', 'sk': 'META'}]}}}
    table = _table(*([stuck] * batch_get.BATCH_GET_ATTEMPTS))

    with patch.object(batch_get.time, 'sleep'), pytest.raises(Boom):
        batch_get.batch_get_all(table, _keys(1), failure=Boom())
    assert table.meta.client.batch_get_item.call_count == batch_get.BATCH_GET_ATTEMPTS


def test_every_call_counts_even_one_that_made_progress():
    """Each round processes one key and leaves the rest: after BATCH_GET_ATTEMPTS calls the read still fails, so a
    chunk is never more than 5 calls (and about 1.5 s of backoff) on a request path."""
    keys = _keys(10)
    rounds = [{'Responses': {'t': [keys[index]]}, 'UnprocessedKeys': {'t': {'Keys': keys[index + 1:]}}}
              for index in range(batch_get.BATCH_GET_ATTEMPTS)]
    table = _table(*rounds)

    with patch.object(batch_get.time, 'sleep'), pytest.raises(Boom):
        batch_get.batch_get_all(table, keys, failure=Boom())

    assert table.meta.client.batch_get_item.call_count == batch_get.BATCH_GET_ATTEMPTS


def test_the_backoff_is_full_jitter_below_the_exponential_bound():
    stuck = {'Responses': {}, 'UnprocessedKeys': {'t': {'Keys': [{'pk': 'P#000', 'sk': 'META'}]}}}
    table = _table(*([stuck] * batch_get.BATCH_GET_ATTEMPTS))

    with patch.object(batch_get.time, 'sleep'), patch.object(batch_get.random, 'uniform', return_value=0.0) as jitter, \
            pytest.raises(Boom):
        batch_get.batch_get_all(table, _keys(1), failure=Boom())

    assert [c.args for c in jitter.call_args_list] == [(0, 0.1), (0, 0.2), (0, 0.4), (0, 0.8)]


def test_the_caller_may_ask_for_an_eventually_consistent_read():
    table = _table({'Responses': {'t': []}})

    batch_get.batch_get_all(table, _keys(1), failure=Boom(), read_options={'ConsistentRead': False})

    assert table.meta.client.batch_get_item.call_args.kwargs['RequestItems']['t']['ConsistentRead'] is False


def test_no_keys_is_no_request():
    table = _table()
    assert batch_get.batch_get_all(table, [], failure=Boom()) == []
    table.meta.client.batch_get_item.assert_not_called()
