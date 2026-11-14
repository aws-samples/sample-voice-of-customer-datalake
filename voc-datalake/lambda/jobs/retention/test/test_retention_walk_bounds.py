"""voc-retention: the bounds of the paged walk, whatever the clock says.

A phase reads at most ``MAX_PAGES`` pages in one invocation, then hands over from where it is, exactly as when the
time runs low (``handler._walk`` for the table scans, ``handler._sweep_prefix`` for the raw sweep), and says so in
the log. A chain of such hand-overs still erases every item once. A scan that answers with the cursor it was read
from (a store, or a caller, that does not follow the cursor) stops the run: it fails and is audited, its erasure job
reads failed, and the page is not read again.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from jobs.retention import handler
from jobs.retention.test.conftest import erasure_job, erasure_rows
from jobs.retention.test.walk_store import audits, chain, expired, handed_over, key, left, pages, put, tombstoned

JOB_ID = 'er_0123456789ab'


def _walk(context: MagicMock, run: dict | None = None) -> handler.Walk:
    return handler.Walk({'aggregates': MagicMock()}, context, {}, run or {'mode': 'retention', 'run_id': 'r1'},
                        lambda _store: MagicMock(), MagicMock(), lambda: True)


@pytest.fixture
def two_pages_a_phase():
    with patch.object(handler, 'MAX_PAGES', 2):
        yield


class TestThePageCap:
    def test_it_is_ten_thousand_pages(self) -> None:
        assert handler.MAX_PAGES == 10_000

    @pytest.mark.usefixtures('two_pages_a_phase')
    def test_past_it_the_walk_hands_over_at_the_next_page_and_says_so(self, worker_context) -> None:
        walk = _walk(worker_context)
        scan = pages({'LastEvaluatedKey': {'k': 1}}, {'LastEvaluatedKey': {'k': 2}}, {'LastEvaluatedKey': {'k': 3}})
        with patch.object(handler, 'record_progress') as progress, patch.object(handler, 'logger') as logger, \
                patch.object(handler, '_hand_over', return_value={'status': 'continued'}) as hand_over:
            result = handler._walk(walk, 'lineage', None, scan, lambda _page, _cursor: None)
        assert result == {'status': 'continued'}
        hand_over.assert_called_once_with(walk, 'lineage', {'k': 2})
        assert progress.call_count == 2
        logger.warning.assert_called_once_with('Retention phase read its page cap in one invocation; handing over',
                                               extra={'phase': 'lineage', 'pages': 2})

    @pytest.mark.usefixtures('two_pages_a_phase')
    def test_a_walk_that_ends_on_its_last_allowed_page_is_done(self, worker_context) -> None:
        with patch.object(handler, 'record_progress'), patch.object(handler, '_hand_over') as hand_over:
            result = handler._walk(_walk(worker_context), 'lineage', None,
                                   pages({'LastEvaluatedKey': {'k': 1}}, {}), lambda _page, _cursor: None)
        assert result is None
        hand_over.assert_not_called()

    @pytest.mark.usefixtures('two_pages_a_phase', 'three_a_page')
    def test_a_capped_chain_erases_every_item_once(self, aws, worker_context, invoke_mock) -> None:
        names = expired(aws, 8)
        payload = handed_over(worker_context, invoke_mock)
        # Two pages of three, then the hand-over at the third page's start, the time never low.
        assert (payload['phase'], payload['cursor']) == ('items', key('a5'))
        assert left(aws) == ['a6', 'a7']
        results = chain(payload, worker_context, invoke_mock)
        assert [result['status'] for result in results] == ['completed']
        assert (left(aws), tombstoned(aws)) == ([], names)


@pytest.mark.usefixtures('two_pages_a_phase')
class TestTheRawSweepsCap:
    def _sweep(self, context: MagicMock, answers: list[tuple[int, bool]]) -> tuple[dict | None, MagicMock, list, int]:
        """A whole-source sweep of ``web`` whose listing pages answer ``(objects deleted, more left)`` in turn: its
        result, the hand-over, the prefix each page listed, and the objects counted. ``self.progress`` and
        ``self.logger`` keep the progress writes and the log."""
        run = {'mode': 'erase', 'run_id': 'r1', 'deleted_objects': 0, 'source': 'web'}
        listed = iter(answers)
        with patch.object(handler, 'RAW_DATA_BUCKET', 'bucket'), \
                patch.object(handler, 'record_progress') as self.progress, \
                patch.object(handler, 'logger') as self.logger, \
                patch.object(handler.retention, 'delete_raw_prefix_page', side_effect=lambda *_: next(listed)) as page, \
                patch.object(handler, '_hand_over', return_value={'status': 'continued'}) as hand_over:
            result = handler._sweep_raw(_walk(context, run), None)
        return result, hand_over, [call.args[2] for call in page.call_args_list], run['deleted_objects']

    def test_a_prefix_that_still_has_more_after_the_cap_hands_over_with_no_cursor(self, worker_context) -> None:
        result, hand_over, prefixes, objects = self._sweep(worker_context, [(4, True), (5, True)])
        assert result == {'status': 'continued'}
        assert hand_over.call_args.args[1:] == ('raw', None)
        assert (prefixes, objects) == (['raw/web/', 'raw/web/'], 9)
        assert [call.args[2] for call in self.progress.call_args_list] == ['raw', 'raw']
        self.logger.warning.assert_called_once_with('Retention phase read its page cap in one invocation; handing over',
                                                    extra={'phase': 'raw', 'pages': 2})

    def test_each_prefix_has_its_own_pages(self, worker_context) -> None:
        result, hand_over, prefixes, objects = self._sweep(worker_context, [(1, True), (1, False), (1, True), (1, False)])
        assert result is None
        hand_over.assert_not_called()
        assert (prefixes, objects) == (['raw/web/', 'raw/web/', 'silver/web/', 'silver/web/'], 4)


class TestAStuckCursor:
    def _walk_until_stuck(self, context: MagicMock, start: dict | None, *answers: dict) -> tuple[list, MagicMock]:
        """The walk over a scripted store from ``start``: each step (a scan from its cursor, a page handled from
        its cursor, a progress write), and the log."""
        steps: list = []
        with patch.object(handler, 'record_progress', side_effect=lambda *_args: steps.append(('progress', None))), \
                patch.object(handler, 'logger') as logger, patch.object(handler, '_hand_over') as hand_over, \
                pytest.raises(handler.CursorStuck, match=r'^lineage$'):
            handler._walk(_walk(context), 'lineage', start, pages(*answers, steps=steps),
                          lambda _page, cursor: steps.append(('handle', cursor)))
        hand_over.assert_not_called()
        return steps, logger

    def test_the_same_key_twice_stops_the_walk_and_says_which_phase(self, worker_context) -> None:
        read, logger = self._walk_until_stuck(worker_context, None, {'LastEvaluatedKey': {'k': 1}},
                                              {'LastEvaluatedKey': {'k': 1}}, {'LastEvaluatedKey': {'k': 2}})
        # The stuck page is neither handled nor counted: only the first one was.
        assert read == [('scan', None), ('handle', None), ('progress', None), ('scan', {'k': 1})]
        # The phase only: a cursor is a row key and may name a person.
        logger.error.assert_called_once_with('Retention scan returned the cursor it started from; stopping the run',
                                             extra={'phase': 'lineage'})

    def test_a_first_page_that_answers_with_the_cursor_it_resumed_from_stops_too(self, worker_context) -> None:
        read, _logger = self._walk_until_stuck(worker_context, {'k': 5}, {'LastEvaluatedKey': {'k': 5}})
        assert read == [('scan', {'k': 5})]

    def test_a_key_that_moves_on_is_followed(self, worker_context) -> None:
        with patch.object(handler, 'record_progress'):
            result = handler._walk(_walk(worker_context), 'lineage', {'k': 1},
                                   pages({'LastEvaluatedKey': {'k': 2}}, {'LastEvaluatedKey': {'k': 1}}, {}),
                                   lambda _page, _cursor: None)
        # Only a page that answers with its own start is stuck; an earlier key coming back is the page cap's to bound.
        assert result is None


@pytest.fixture
def scans_ignore_the_cursor():
    """Every scan of the item phases reads from the table's start, whatever cursor it is given."""
    scan_page = handler._scan_page
    with patch.object(handler, '_scan_page', side_effect=lambda table, condition, _cursor: scan_page(table, condition,
                                                                                                    None)) as scans:
        yield scans


@pytest.mark.usefixtures('three_a_page')
class TestAStoreThatDoesNotFollowTheCursor:
    """The item phases on moto tables (``_scan_page``); the boards, members and lineage passes share ``_walk`` and
    page through their own scans in the suites that test them."""

    def test_a_retention_run_fails_and_is_audited_instead_of_reading_the_first_page_forever(
            self, aws, worker_context, invoke_mock, scans_ignore_the_cursor) -> None:
        expired(aws, 0)
        for n in range(4):
            put(aws, f'a{n}', 1)  # inside the window: no page deletes anything, so the first page stays first
        result = handler.handle_event({}, worker_context)
        assert (result['status'], scans_ignore_the_cursor.call_count) == ('failed', 2)
        [audit] = audits(aws)
        assert (audit['status'], audit['error']) == ('failed', 'Run failed (CursorStuck)')
        assert audit['scanned'] == 3  # the first page only: the repeated one was not counted again
        invoke_mock.assert_not_called()

    def test_an_erasure_job_reads_failed(self, aws, worker_context, invoke_mock, scans_ignore_the_cursor) -> None:
        for n in range(4):
            put(aws, f'a{n}', 1)  # none by Jane: the pages match nothing
        result = handler.handle_event(erasure_job(aws, JOB_ID, 'author', 'Jane'), worker_context)
        assert result['status'] == 'failed'
        job, audit = erasure_rows(aws, JOB_ID)
        assert (job['status'], job['error'], audit['error']) == ('failed', 'Run failed (CursorStuck)',
                                                                 'Run failed (CursorStuck)')
        assert scans_ignore_the_cursor.call_count == 2
        invoke_mock.assert_not_called()
