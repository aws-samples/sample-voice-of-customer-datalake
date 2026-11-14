"""voc-retention: the paged walk every scanning phase shares (``handler._walk``), on real tables.

Pinned before the walk got its page cap, its stuck-cursor guard and its injected clock, so the rewrite keeps what a
well-behaved store sees: every page read from the cursor the last one ended at, an empty page (a filter that
matched nothing) followed like any other, the walk ending when a page carries no ``LastEvaluatedKey``, and a run
that runs low on time handing over (mid-page after its last erased item, between pages at the next page) to an
invocation that finishes the job, each item erased once. Moto tables, the daily retention mode end to end.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key

from jobs.retention import handler, runs
from jobs.retention.copies import TOMBSTONE_PK_PREFIX
from jobs.retention.test.conftest import days_ago

SOURCE = 'tickets'
PLENTY = 900_000
LOW = 0
# The longest hand-over chain any test here needs; a chain past it fails the test instead of running on.
CHAIN_LIMIT = 12


def _key(name: str) -> dict[str, str]:
    return {'pk': f'SOURCE#{SOURCE}', 'sk': f'FEEDBACK#{name}'}


def _put(aws: dict[str, Any], name: str, age_days: int) -> None:
    aws['feedback'].put_item(Item={**_key(name), 'feedback_id': name, 'source_id': name, 'source_platform': SOURCE,
                                   'date': days_ago(age_days)})


def _expired(aws: dict[str, Any], count: int) -> list[str]:
    """``tickets`` keeps its feedback 30 days, and holds ``count`` items 60 days old (``a0``, ``a1``, ...)."""
    aws['aggregates'].put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config',
                                     'sources': [{'id': SOURCE, 'retention_days': 30}]})
    names = [f'a{n}' for n in range(count)]
    for name in names:
        _put(aws, name, 60)
    return names


def _left(aws: dict[str, Any]) -> list[str]:
    """The feedback ids still stored, in key order."""
    items = aws['feedback'].query(KeyConditionExpression=Key('pk').eq(f'SOURCE#{SOURCE}'))['Items']
    return [str(item['feedback_id']) for item in items]


def _tombstoned(aws: dict[str, Any]) -> list[str]:
    rows = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(f'{TOMBSTONE_PK_PREFIX}{SOURCE}'))['Items']
    return sorted(str(row['sk']) for row in rows)


def _audits(aws: dict[str, Any]) -> list[dict[str, Any]]:
    return aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(runs.AUDIT_PK))['Items']


def _clock(context: MagicMock, *budgets: int) -> None:
    """The Lambda's remaining time, one value per check, then plenty."""
    remaining = iter(budgets)
    context.get_remaining_time_in_millis.side_effect = lambda: next(remaining, PLENTY)


def _scanned(context: MagicMock) -> tuple[dict[str, Any], list[Any]]:
    """One daily run's result, and the cursor each of its scans started from."""
    with patch.object(handler, '_scan_page', wraps=handler._scan_page) as scans:
        result = handler.handle_event({}, context)
    return result, [call.args[2] for call in scans.call_args_list]


def _handed_over(context: MagicMock, invoke: MagicMock, event: dict[str, Any] | None = None) -> dict[str, Any]:
    """The payload of the hand-over one invocation ended with."""
    assert handler.handle_event(event or {}, context)['status'] == 'continued'
    return invoke.call_args.args[1]


def _chain(event: dict[str, Any], context: MagicMock, invoke: MagicMock) -> list[dict[str, Any]]:
    """Run the invocation and every hand-over it starts, in turn; each invocation's result."""
    results = []
    for _ in range(CHAIN_LIMIT):
        result = handler.handle_event(event, context)
        results.append(result)
        if result['status'] != 'continued':
            return results
        event = invoke.call_args.args[1]
    raise AssertionError(f'no end after {CHAIN_LIMIT} invocations')


@pytest.fixture
def three_a_page():
    with patch.object(handler, 'PAGE_SIZE', 3):
        yield


@pytest.mark.usefixtures('three_a_page')
class TestAWellBehavedStore:
    def test_several_pages_are_read_from_each_cursor_until_one_has_none(self, aws, worker_context,
                                                                        invoke_mock) -> None:
        _expired(aws, 7)
        result, cursors = _scanned(worker_context)
        assert (result['status'], result['deleted_items']) == ('completed', 7)
        assert _left(aws) == []
        invoke_mock.assert_not_called()
        # Pages of 3, 3 and 1 from the store's own cursors (the third page is short: no LastEvaluatedKey), then
        # the empty Radar table's one page.
        assert cursors == [None, _key('a2'), _key('a5'), None]

    def test_an_empty_page_is_followed_like_any_other(self, aws, worker_context, invoke_mock) -> None:
        _expired(aws, 3)
        for name in ('b0', 'b1', 'b2'):
            _put(aws, name, 1)
        for name in ('c0', 'c1'):
            _put(aws, name, 60)
        result, cursors = _scanned(worker_context)
        # b0..b2 are inside the window: their page matched nothing, and carried the cursor on to c0 and c1 (a
        # short page: no LastEvaluatedKey); then the empty Radar table's one page.
        assert (result['status'], result['deleted_items']) == ('completed', 5)
        assert _left(aws) == ['b0', 'b1', 'b2']
        assert cursors == [None, _key('a2'), _key('b2'), None]
        invoke_mock.assert_not_called()

    def test_a_store_with_nothing_to_delete_reads_one_page_and_completes(self, aws, worker_context,
                                                                         invoke_mock) -> None:
        _expired(aws, 0)
        result, cursors = _scanned(worker_context)
        assert (result['status'], result['deleted_items']) == ('completed', 0)
        assert cursors == [None, None]  # the feedback table's one page, the Radar table's one page
        invoke_mock.assert_not_called()


@pytest.mark.usefixtures('three_a_page')
class TestTimeRunningOut:
    def test_between_pages_it_hands_over_at_the_next_page(self, aws, worker_context, invoke_mock) -> None:
        _expired(aws, 7)
        # Three checks before the first page's deletes, then the check before the second page is low.
        _clock(worker_context, PLENTY, PLENTY, PLENTY, LOW)
        payload = _handed_over(worker_context, invoke_mock)
        assert (payload['phase'], payload['cursor']) == ('items', _key('a2'))
        assert (payload['run']['generation'], payload['run']['deleted_items']) == (1, 3)
        assert _left(aws) == ['a3', 'a4', 'a5', 'a6']
        assert _audits(aws) == []

    def test_mid_page_it_hands_over_after_the_last_erased_item(self, aws, worker_context, invoke_mock) -> None:
        _expired(aws, 7)
        _clock(worker_context, PLENTY, LOW)
        payload = _handed_over(worker_context, invoke_mock)
        assert (payload['phase'], payload['cursor']) == ('items', _key('a0'))
        assert _left(aws) == ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']
        # The whole page was tombstoned first (tombstone-first per page), the erased item included.
        assert _tombstoned(aws) == ['a0', 'a1', 'a2']

    def test_before_the_first_delete_it_hands_over_from_where_it_started(self, aws, worker_context,
                                                                         invoke_mock) -> None:
        _expired(aws, 4)
        _clock(worker_context, LOW)
        event = {'phase': 'items', 'cursor': _key('a0'), 'run': {'generation': 3}}
        payload = _handed_over(worker_context, invoke_mock, event)
        assert (payload['cursor'], payload['run']['generation']) == (_key('a0'), 4)
        assert _left(aws) == ['a0', 'a1', 'a2', 'a3']


@pytest.mark.usefixtures('three_a_page')
class TestTheHandOver:
    @pytest.mark.parametrize(('budgets', 'invocations'), [
        ((PLENTY, PLENTY, PLENTY, LOW), 2),            # low between the first and second page
        ((PLENTY, LOW), 2),                            # low mid-page
        ((PLENTY, PLENTY, PLENTY, LOW, PLENTY, LOW, PLENTY, PLENTY, LOW), 4),  # low three times
    ], ids=['between-pages', 'mid-page', 'three-times'])
    def test_the_chain_erases_every_item_once_and_audits_once(self, aws, worker_context, invoke_mock,
                                                              budgets: tuple[int, ...], invocations: int) -> None:
        names = _expired(aws, 8)
        _put(aws, 'kept', 1)
        _clock(worker_context, *budgets)
        results = _chain({}, worker_context, invoke_mock)
        assert [result['status'] for result in results] == ['continued'] * (invocations - 1) + ['completed']
        # The last invocation's result carries the whole chain's counts.
        assert results[-1]['deleted_items'] == 8
        assert (_left(aws), _tombstoned(aws)) == (['kept'], names)
        [audit] = _audits(aws)
        assert audit['deleted_items'] == 8

    def test_each_hand_over_names_its_phase_and_the_same_run(self, aws, worker_context, invoke_mock) -> None:
        _expired(aws, 8)
        # Low before the second page, then again before the third.
        _clock(worker_context, PLENTY, PLENTY, PLENTY, LOW, PLENTY, PLENTY, PLENTY, LOW)
        results = _chain({}, worker_context, invoke_mock)
        assert len(results) == 3
        payloads = [call.args[1] for call in invoke_mock.call_args_list]
        assert [(payload['mode'], payload['phase'], payload['cursor']) for payload in payloads] == [
            ('retention', 'items', _key('a2')), ('retention', 'items', _key('a5'))]
        assert [payload['run']['generation'] for payload in payloads] == [1, 2]
        assert {result['run_id'] for result in results} == {payloads[0]['run']['run_id']}


def _pages(*pages: dict[str, Any], steps: list[tuple[str, Any]] | None = None) -> Any:
    """A scan that serves ``pages`` in turn (noting each cursor in ``steps``), and fails past the last one, so a
    walk that never stops fails the test instead of running on."""
    served = iter(pages)

    def scan(cursor: dict | None) -> dict[str, Any]:
        if steps is not None:
            steps.append(('scan', cursor))
        page = next(served, None)
        if page is None:
            raise AssertionError('scanned past the last page')
        return page

    return scan


class TestTheWalkItself:
    """``_walk`` with a scripted store: the order of its steps, and what it returns."""

    def _walk(self, context: MagicMock) -> handler.Walk:
        run = {'mode': 'retention', 'run_id': 'r1'}
        return handler.Walk({'aggregates': MagicMock()}, context, {}, run, lambda _store: MagicMock(), MagicMock(),
                            handler._lambda_clock(context))

    def test_each_page_is_handled_then_recorded_then_followed(self, worker_context) -> None:
        steps: list[tuple[str, Any]] = []
        scan = _pages({'LastEvaluatedKey': {'k': 1}}, {'LastEvaluatedKey': {'k': 2}}, {'LastEvaluatedKey': {}},
                      steps=steps)

        def handle(_page: dict, cursor: dict | None) -> None:
            steps.append(('handle', cursor))

        with patch.object(handler, 'record_progress',
                          side_effect=lambda *_args, **_kwargs: steps.append(('progress', None))):
            result = handler._walk(self._walk(worker_context), 'lineage', {'k': 0}, scan, handle)
        assert result is None
        # An empty LastEvaluatedKey ends the walk like a missing one.
        assert steps == [('scan', {'k': 0}), ('handle', {'k': 0}), ('progress', None),
                         ('scan', {'k': 1}), ('handle', {'k': 1}), ('progress', None),
                         ('scan', {'k': 2}), ('handle', {'k': 2}), ('progress', None)]

    def test_a_resume_hands_over_at_its_cursor_without_recording(self, worker_context) -> None:
        walk = self._walk(worker_context)
        with patch.object(handler, 'record_progress') as progress, \
                patch.object(handler, '_hand_over', return_value={'status': 'continued'}) as hand_over:
            result = handler._walk(walk, 'boards', None, _pages({'LastEvaluatedKey': {'k': 1}}),
                                   lambda _page, _cursor: handler._Resume({'k': 'mid'}))
        assert result == {'status': 'continued'}
        hand_over.assert_called_once_with(walk, 'boards', {'k': 'mid'})
        progress.assert_not_called()

    def test_the_time_is_checked_only_when_another_page_follows(self, worker_context) -> None:
        _clock(worker_context, LOW)
        with patch.object(handler, 'record_progress'):
            assert handler._walk(self._walk(worker_context), 'lineage', None, _pages({}),
                                 lambda _page, _cursor: None) is None
        worker_context.get_remaining_time_in_millis.assert_not_called()

    def test_low_time_between_pages_hands_over_at_the_next_cursor(self, worker_context) -> None:
        walk = self._walk(worker_context)
        _clock(worker_context, PLENTY, LOW)
        with patch.object(handler, 'record_progress'), \
                patch.object(handler, '_hand_over', return_value={'status': 'continued'}) as hand_over:
            result = handler._walk(walk, 'lineage', None,
                                   _pages({'LastEvaluatedKey': {'k': 1}}, {'LastEvaluatedKey': {'k': 2}}),
                                   lambda _page, _cursor: None)
        assert result == {'status': 'continued'}
        hand_over.assert_called_once_with(walk, 'lineage', {'k': 2})
        assert worker_context.get_remaining_time_in_millis.call_count == 2


class TestTheClock:
    """The walk reads the time only through the clock it is given; the Lambda's keeps a minute in reserve."""

    @pytest.mark.parametrize(('remaining', 'left'), [(60_000, False), (60_001, True)])
    def test_the_lambda_clock_keeps_sixty_seconds_in_reserve(self, worker_context, remaining: int,
                                                             left: bool) -> None:
        worker_context.get_remaining_time_in_millis.return_value = remaining
        assert handler._lambda_clock(worker_context)() is left

    def test_every_check_reads_the_injected_clock_not_the_context(self, worker_context) -> None:
        checks = iter([True, False])
        walk = handler.Walk({'aggregates': MagicMock()}, worker_context, {}, {'mode': 'retention', 'scanned': 0},
                            lambda _store: MagicMock(), MagicMock(), lambda: next(checks))
        erased: list[str] = []
        with patch.object(handler, 'record_progress'), \
                patch.object(handler, '_hand_over', side_effect=lambda _walk, _phase, cursor: cursor):
            resumed = handler._erase_pages(walk, 'items', None,
                                           _pages({'Items': [_key('a0'), _key('a1')], 'ScannedCount': 2}),
                                           lambda _items: None, lambda item: erased.append(str(item['sk'])))
        # Plenty of Lambda time, but the clock said no before the second item: the hand-over is after the first.
        assert (erased, resumed) == (['FEEDBACK#a0'], _key('a0'))
        worker_context.get_remaining_time_in_millis.assert_not_called()
