"""voc-retention: the bounds of the paged walk, whatever the clock says.

A phase reads at most ``MAX_PAGES`` pages in one invocation, then hands over from where it is, exactly as when the
time runs low (``handler._walk`` for the table scans, ``handler._sweep_prefix`` for the raw sweep), and says so in
the log. A chain of such hand-overs still erases every item once.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from jobs.retention import handler
from jobs.retention.test.walk_store import chain, expired, handed_over, key, left, pages, tombstoned


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
