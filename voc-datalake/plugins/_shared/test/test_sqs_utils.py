"""
Tests for plugins/_shared/sqs_utils.py

Each test is designed so that it FAILS when the specific behaviour it covers
is reverted.  The test name documents which revert it catches.

Coverage matrix
---------------
Behaviour                                           Test(s) that catch a revert
-----------------------------------------------------------------
SenderFault=true items are never retried            test_sender_fault_not_retried
SenderFault=false items are retried                 test_transient_failure_retried
Retries are bounded (max_retries limit)             test_transient_exhausted_raises_after_max_retries
RuntimeError raised on any permanent failure        test_raises_on_permanent_failure
                                                    test_raises_on_sender_fault_failure
Metric = actual enqueued count, not attempted       test_metric_reflects_only_successful_items
No metric / no call for empty list                  test_empty_items_is_no_op
Happy path: all succeed, metric = len(items)        test_all_successful_metric_equals_item_count
Batch size: ≤10 entries per send_message_batch call test_batches_are_at_most_ten_entries
Mixed success+failure in one response               test_partial_batch_failure_raises_and_counts_correctly
Failed entry missing Id field raises RuntimeError   test_missing_id_field_raises_without_index_error
Non-numeric Id raises RuntimeError (no ValueError) test_non_numeric_id_raises_without_value_error
Out-of-range Id raises RuntimeError (no IndexError) test_out_of_range_id_raises_without_index_error
Negative Id raises RuntimeError (no wrong item)    test_negative_id_raises_without_wrong_item_blamed
Non-string Id raises RuntimeError (no TypeError)    test_non_string_id_type_raises_runtime_error_not_type_error
Unaccounted entries raise instead of vanishing      test_unaccounted_entries_raise_rather_than_silently_vanish
Unaccounted entry named in the RuntimeError         test_unaccounted_entry_is_named_in_the_error
Full message body not logged (only id field)        test_personal_data_not_logged
Return value = successfully enqueued count          test_return_value_is_enqueued_count
"""

from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_sqs(responses: list[dict]) -> MagicMock:
    """Return a mock SQS client whose send_message_batch returns *responses*
    in order.  Each element must be a full SQS response dict."""
    client = MagicMock()
    client.send_message_batch.side_effect = responses
    return client


def _success_response(count: int, start_id: int = 0) -> dict:
    """Build a send_message_batch response with *count* successful entries."""
    return {
        "Successful": [{"Id": str(start_id + i)} for i in range(count)],
        "Failed": [],
    }


def _failure_response(
    failed_ids: list[int],
    sender_fault: bool,
    code: str = "ThrottlingException",
) -> dict:
    """Build a response where *failed_ids* all failed."""
    return {
        "Successful": [],
        "Failed": [
            {
                "Id": str(fid),
                "SenderFault": sender_fault,
                "Code": code,
                "Message": "test error",
            }
            for fid in failed_ids
        ],
    }


def _mixed_response(
    success_ids: list[int],
    failed_ids: list[int],
    sender_fault: bool = False,
) -> dict:
    return {
        "Successful": [{"Id": str(sid)} for sid in success_ids],
        "Failed": [
            {
                "Id": str(fid),
                "SenderFault": sender_fault,
                "Code": "ThrottlingException",
                "Message": "throttled",
            }
            for fid in failed_ids
        ],
    }


# ---------------------------------------------------------------------------
# Import helper
# ---------------------------------------------------------------------------

def _import_fn():
    from _shared.sqs_utils import send_messages_to_queue
    return send_messages_to_queue


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestSendMessagesToQueueHappyPath:
    """No failures from SQS — everything succeeds."""

    def test_all_successful_metric_equals_item_count(self):
        """Metric equals len(items) when all entries are enqueued.

        Reverts-to-catch: emitting len(items) regardless of the response —
        that was the original bug; this test would pass against the broken
        code because it only happened to return all-successful.  The metric
        assertion is validated against the Successful count in the response,
        so a revert that emits len(attempted) instead of len(Successful) is
        caught by test_metric_reflects_only_successful_items below.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": str(i), "text": f"t{i}"} for i in range(5)]
        sqs = _make_sqs([_success_response(5)])

        with patch("_shared.sqs_utils.metrics") as mock_metrics:
            result = send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                initial_delay=0,
            )

        assert result == 5
        mock_metrics.add_metric.assert_called_once_with(
            name="ItemsIngested", unit="Count", value=5
        )

    def test_empty_items_is_no_op(self):
        """send_message_batch is never called and metric is never emitted for
        an empty list.

        Reverts-to-catch: removing the early-return guard causes a metric of 0
        to be emitted and a no-op batch call.
        """
        send_messages_to_queue = _import_fn()
        sqs = MagicMock()

        with patch("_shared.sqs_utils.metrics") as mock_metrics:
            result = send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                [],
                metric_name="ItemsIngested",
                log_label="test",
                initial_delay=0,
            )

        assert result == 0
        sqs.send_message_batch.assert_not_called()
        mock_metrics.add_metric.assert_not_called()

    def test_return_value_is_enqueued_count(self):
        """Return value equals the number actually confirmed by SQS."""
        send_messages_to_queue = _import_fn()
        items = [{"id": str(i), "text": "x"} for i in range(3)]
        sqs = _make_sqs([_success_response(3)])

        with patch("_shared.sqs_utils.metrics"):
            result = send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                initial_delay=0,
            )
        assert result == 3

    def test_batches_are_at_most_ten_entries(self):
        """25 items must result in exactly 3 send_message_batch calls, each
        with ≤10 entries.

        Reverts-to-catch: removing the batching loop would send all 25 in one
        call (which SQS rejects) or never send at all.

        The callable side_effect derives Successful from the actual Entries
        passed, so the mock is correct for any batch size and any number of
        calls — an unexpected extra call produces an informative failure rather
        than a confusing StopIteration.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": str(i), "text": "x"} for i in range(25)]

        def _batch_success(**kwargs):
            return {
                "Successful": [{"Id": e["Id"]} for e in kwargs["Entries"]],
                "Failed": [],
            }

        sqs = MagicMock()
        sqs.send_message_batch.side_effect = _batch_success

        with patch("_shared.sqs_utils.metrics"):
            send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                initial_delay=0,
            )

        assert sqs.send_message_batch.call_count == 3
        for c in sqs.send_message_batch.call_args_list:
            entries = c.kwargs.get("Entries", c.args[0] if c.args else [])
            assert len(entries) <= 10


class TestSendMessagesToQueueFailureHandling:
    """Tests that ensure failures are not silently discarded."""

    def test_raises_on_permanent_failure(self):
        """RuntimeError is raised when any item permanently fails.

        Reverts-to-catch: discarding the Failed list (the original defect)
        means no exception is raised — this test then fails.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": "item-0", "text": "x"}]
        # SenderFault=false but max_retries=0 → permanent after 1 attempt
        sqs = _make_sqs([_failure_response([0], sender_fault=False)])

        with patch("_shared.sqs_utils.metrics"), pytest.raises(RuntimeError, match="item-0"):
            send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                max_retries=0,
                initial_delay=0,
            )

    def test_raises_on_sender_fault_failure(self):
        """RuntimeError is raised for SenderFault=true failures, even on the
        first attempt (no retries).

        Reverts-to-catch: treating SenderFault=true as transient → infinite
        retry loop; not raising at all → silent loss.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": "bad-item", "text": "x" * 300_000}]
        sqs = _make_sqs([_failure_response([0], sender_fault=True, code="MessageTooLarge")])

        with patch("_shared.sqs_utils.metrics"), pytest.raises(RuntimeError, match="bad-item"):
            send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                initial_delay=0,
            )

    def test_metric_reflects_only_successful_items(self):
        """When some items fail, the metric must equal the *successful* count,
        not the attempted count.

        Reverts-to-catch: emitting len(items) (the original bug) instead of
        counting Successful entries.
        """
        send_messages_to_queue = _import_fn()
        # 5 items; 3 succeed, 2 fail with SenderFault=true (permanent)
        items = [{"id": str(i), "text": "x"} for i in range(5)]
        sqs = _make_sqs([_mixed_response([0, 1, 2], [3, 4], sender_fault=True)])

        emitted_value = None

        def capture_metric(name, unit, value):
            nonlocal emitted_value
            emitted_value = value

        with patch("_shared.sqs_utils.metrics") as mock_metrics, pytest.raises(RuntimeError):
            mock_metrics.add_metric.side_effect = capture_metric
            send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                initial_delay=0,
            )

        # Metric must be 3 (successful), not 5 (attempted)
        assert emitted_value == 3, (
            f"Metric emitted {emitted_value} but expected 3 (the number SQS confirmed)"
        )

    def test_missing_id_field_raises_without_index_error(self):
        """A Failed entry with no Id field must raise RuntimeError without
        causing an IndexError or silently attributing the failure to batch[0].

        Reverts-to-catch: the old ``int(failed.get('Id', 0))`` default maps a
        missing Id to index 0, silently blaming the wrong item and potentially
        leaving the actual failed entry untracked.  The guard introduced by
        this fix catches the missing Id, logs an error, and appends
        ('unknown', code) to permanent_failures so RuntimeError is still raised.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": "item-0", "text": "x"}, {"id": "item-1", "text": "y"}]
        # Simulate an SQS response that omits the Id field entirely.
        response_with_missing_id = {
            "Successful": [],
            "Failed": [
                {
                    # No 'Id' key at all
                    "SenderFault": True,
                    "Code": "MessageTooLarge",
                    "Message": "test error",
                }
            ],
        }
        sqs = _make_sqs([response_with_missing_id])

        with patch("_shared.sqs_utils.metrics"), patch("_shared.sqs_utils.logger") as mock_logger, pytest.raises(RuntimeError):
            send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                initial_delay=0,
            )

        # The error path must have logged the missing-Id case
        error_calls = [str(call) for call in mock_logger.error.call_args_list]
        assert any("missing Id" in c for c in error_calls), (
            "Expected an error log about the missing Id field"
        )

    def test_non_numeric_id_raises_without_value_error(self):
        """A Failed entry with a non-numeric Id (e.g. 'abc') must raise
        RuntimeError without propagating a ValueError from int(raw_id).

        Reverts-to-catch: the bare ``int(raw_id)`` call raises ValueError on
        non-numeric strings, masking the real SQS error code.  The guard wraps
        the conversion and routes the entry to permanent_failures so RuntimeError
        is still raised with a useful message.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": "item-0", "text": "x"}]
        response_with_bad_id = {
            "Successful": [],
            "Failed": [
                {
                    "Id": "abc",  # non-numeric — int("abc") raises ValueError
                    "SenderFault": False,
                    "Code": "InternalError",
                    "Message": "test error",
                }
            ],
        }
        sqs = _make_sqs([response_with_bad_id])

        with (
            patch("_shared.sqs_utils.metrics"),
            patch("_shared.sqs_utils.logger") as mock_logger,
            pytest.raises(RuntimeError),
        ):
            send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                max_retries=0,
                initial_delay=0,
            )

        # The invalid-Id error path must have been logged
        error_calls = [str(call) for call in mock_logger.error.call_args_list]
        assert any("invalid Id" in c for c in error_calls), (
            "Expected an error log about the invalid Id field"
        )

    def test_out_of_range_id_raises_without_index_error(self):
        """A Failed entry whose Id is numerically valid but >= len(batch) must
        raise RuntimeError without propagating an IndexError from batch[idx].

        Reverts-to-catch: the bare ``batch[idx]`` lookup raises IndexError for
        an out-of-range index, masking the real SQS error code.  The guard
        routes the entry to permanent_failures so RuntimeError is raised with a
        useful message.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": "item-0", "text": "x"}]  # batch size = 1, valid idx = 0
        response_with_out_of_range_id = {
            "Successful": [],
            "Failed": [
                {
                    "Id": "99",  # batch has only 1 item, so idx 99 is out of range
                    "SenderFault": False,
                    "Code": "InternalError",
                    "Message": "test error",
                }
            ],
        }
        sqs = _make_sqs([response_with_out_of_range_id])

        with (
            patch("_shared.sqs_utils.metrics"),
            patch("_shared.sqs_utils.logger") as mock_logger,
            pytest.raises(RuntimeError),
        ):
            send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                max_retries=0,
                initial_delay=0,
            )

        # The invalid-Id error path must have been logged
        error_calls = [str(call) for call in mock_logger.error.call_args_list]
        assert any("invalid Id" in c for c in error_calls), (
            "Expected an error log about the invalid/out-of-range Id field"
        )

    def test_negative_id_raises_without_wrong_item_blamed(self):
        """A Failed entry with a negative numeric Id (e.g. '-1') must raise
        RuntimeError without silently using Python's negative-index semantics
        (which would blame the last item in the batch).

        Reverts-to-catch: before the ``if idx < 0`` guard, ``"-1"`` passed
        ``int()`` cleanly and ``batch[-1]`` returned the *last* item, meaning
        the actual failed item was untracked and a different item was
        incorrectly recorded in permanent_failures.  With the guard in place
        the negative index is caught by the same ``IndexError`` handler,
        logged as an invalid Id, and escalated to RuntimeError.
        """
        send_messages_to_queue = _import_fn()
        # Two items so that batch[-1] would resolve to items[1] (wrong item)
        items = [{"id": "item-A", "text": "x"}, {"id": "item-B", "text": "y"}]
        response_with_negative_id = {
            "Successful": [],
            "Failed": [
                {
                    "Id": "-1",  # negative — Python batch[-1] → last item
                    "SenderFault": False,
                    "Code": "InternalError",
                    "Message": "test error",
                }
            ],
        }
        sqs = _make_sqs([response_with_negative_id])

        with (
            patch("_shared.sqs_utils.metrics"),
            patch("_shared.sqs_utils.logger") as mock_logger,
            pytest.raises(RuntimeError),
        ):
            send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                max_retries=0,
                initial_delay=0,
            )

        # The invalid-Id error path must have been logged (not a silent wrong-item attribution)
        error_calls = [str(call) for call in mock_logger.error.call_args_list]
        assert any("invalid Id" in c for c in error_calls), (
            "Expected an error log about the invalid (negative) Id field"
        )

    def test_non_string_id_type_raises_runtime_error_not_type_error(self):
        """A Failed entry whose Id is a non-string, non-numeric object (e.g. a
        dict) must raise RuntimeError, not an unhandled TypeError.

        Reverts-to-catch: with ``except (ValueError, IndexError)`` only,
        ``int({})`` raises TypeError which propagates out of
        send_messages_to_queue, masking the original SQS error code and breaking
        the documented RuntimeError contract.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": "item-0", "text": "x"}]
        response_with_dict_id = {
            "Successful": [],
            "Failed": [
                {
                    "Id": {},  # int({}) raises TypeError
                    "SenderFault": True,
                    "Code": "InternalError",
                    "Message": "test error",
                }
            ],
        }
        sqs = _make_sqs([response_with_dict_id])

        with (
            patch("_shared.sqs_utils.metrics"),
            patch("_shared.sqs_utils.logger") as mock_logger,
            pytest.raises(RuntimeError),
        ):
            send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                max_retries=0,
                initial_delay=0,
            )

        error_calls = [str(call) for call in mock_logger.error.call_args_list]
        assert any("invalid Id" in c for c in error_calls), (
            "Expected an error log about the invalid (non-string) Id field"
        )

    def test_unaccounted_entries_raise_rather_than_silently_vanish(self):
        """An entry that appears in neither Successful nor Failed must be
        recorded as a permanent failure so RuntimeError is raised.

        Reverts-to-catch: without the Successful+Failed reconciliation, a
        response that accounts for fewer entries than were submitted leaves the
        missing entry uncounted and unreported — no RuntimeError, no error log,
        and the caller (BaseIngestor.run) reports success and advances the
        watermark past an item that never reached SQS.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": f"i{i}", "text": "x"} for i in range(3)]
        # 3 entries submitted; only 2 accounted for (2 Successful, 0 Failed).
        sqs = _make_sqs([{"Successful": [{"Id": "0"}, {"Id": "1"}], "Failed": []}])

        with (
            patch("_shared.sqs_utils.metrics"),
            patch("_shared.sqs_utils.logger") as mock_logger,
            pytest.raises(RuntimeError, match="i2"),
        ):
            send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                initial_delay=0,
            )

        error_calls = [str(call) for call in mock_logger.error.call_args_list]
        assert any("unaccounted" in c for c in error_calls), (
            "Expected an error log about entries the response did not account for"
        )

    def test_unaccounted_entry_is_named_in_the_error(self):
        """The unaccounted item's own id (not its batch index) is what appears in
        the RuntimeError, so operators can identify the lost feedback.

        Reverts-to-catch: recording the batch index instead of the item id makes
        the error message useless for recovery.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": "keep-me", "text": "x"}, {"id": "lost-item", "text": "y"}]
        sqs = _make_sqs([{"Successful": [{"Id": "0"}], "Failed": []}])

        with patch("_shared.sqs_utils.metrics"), pytest.raises(RuntimeError) as exc_info:
            send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                initial_delay=0,
            )

        assert "lost-item" in str(exc_info.value)
        # The confirmed item must not be reported as failed
        assert "keep-me" not in str(exc_info.value)

    def test_fully_accounted_response_does_not_trigger_reconciliation(self):
        """A response that accounts for every entry (Successful + Failed) must
        not add spurious UnaccountedBySQS failures.

        Reverts-to-catch: a reconciliation that compares against the wrong list
        (e.g. Successful only) would wrongly flag legitimately-failed entries
        twice, or reject a fully-successful batch.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": f"i{i}", "text": "x"} for i in range(3)]
        sqs = _make_sqs([_success_response(3)])

        with patch("_shared.sqs_utils.metrics"):
            result = send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                initial_delay=0,
            )
        assert result == 3

    def test_partial_batch_failure_raises_and_counts_correctly(self):
        """A batch where only some entries fail still raises and the return /
        metric values reflect only the confirmed entries.

        Reverts-to-catch: discarding the Failed list silently loses items and
        counts them as success.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": str(i), "text": "x"} for i in range(10)]
        # 7 succeed, 3 fail permanently (SenderFault=true)
        sqs = _make_sqs(
            [_mixed_response([0, 1, 2, 3, 4, 5, 6], [7, 8, 9], sender_fault=True)]
        )

        with patch("_shared.sqs_utils.metrics") as mock_metrics, pytest.raises(RuntimeError):
            send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                initial_delay=0,
            )
        mock_metrics.add_metric.assert_called_once_with(
            name="ItemsIngested", unit="Count", value=7
        )


class TestSendMessagesToQueueRetryBehaviour:
    """Tests around the retry logic for transient (SenderFault=false) errors."""

    def test_transient_failure_retried(self):
        """Items with SenderFault=false are retried on subsequent attempts.

        Reverts-to-catch: treating every failure as permanent (no retry) means
        the item never reaches the queue even when SQS is temporarily throttling.
        The test would raise RuntimeError instead of returning normally.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": "item-retry", "text": "x"}]
        # First attempt: transient failure; second attempt: success
        sqs = _make_sqs([
            _failure_response([0], sender_fault=False),
            _success_response(1),
        ])

        with patch("_shared.sqs_utils.metrics") as mock_metrics:
            result = send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                max_retries=1,
                initial_delay=0,
            )

        # Must have been retried (2 calls) and succeeded
        assert sqs.send_message_batch.call_count == 2
        assert result == 1
        mock_metrics.add_metric.assert_called_once_with(
            name="ItemsIngested", unit="Count", value=1
        )

    def test_sender_fault_not_retried(self):
        """Items with SenderFault=true must NOT be retried — only one batch
        call is made.

        Reverts-to-catch: treating SenderFault=true as transient causes an
        infinite-like loop (or at least max_retries extra calls).  The call
        count assertion catches this.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": "bad", "text": "x"}]
        sqs = _make_sqs([
            _failure_response([0], sender_fault=True, code="MessageTooLarge"),
            # This second response should never be consumed
            _success_response(1),
        ])

        with patch("_shared.sqs_utils.metrics"), pytest.raises(RuntimeError):
            send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                max_retries=3,
                initial_delay=0,
            )

        # Only 1 call — SenderFault means no retry
        assert sqs.send_message_batch.call_count == 1

    def test_transient_exhausted_raises_after_max_retries(self):
        """Transient failures that persist beyond max_retries must raise.

        Reverts-to-catch: removing the retry-exhaustion path makes the item
        disappear silently after the last retry.
        """
        send_messages_to_queue = _import_fn()
        items = [{"id": "item-0", "text": "x"}]
        max_retries = 2
        # Fail on every attempt (max_retries + 1 = 3 calls total)
        sqs = _make_sqs([
            _failure_response([0], sender_fault=False),
            _failure_response([0], sender_fault=False),
            _failure_response([0], sender_fault=False),
        ])

        with patch("_shared.sqs_utils.metrics"), pytest.raises(RuntimeError, match="item-0"):
            send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                max_retries=max_retries,
                initial_delay=0,
            )

        # One call per attempt (initial + max_retries retries)
        assert sqs.send_message_batch.call_count == max_retries + 1

    def test_only_failed_items_are_retried_not_successful_ones(self):
        """When a batch is partially successful, only the failed items are
        resent on the retry — not the whole batch.

        Reverts-to-catch: re-sending successful items would cause duplicate
        delivery, which is a correctness regression the task explicitly
        prohibits.
        """
        send_messages_to_queue = _import_fn()
        # 3 items in one batch; items 0+1 succeed, item 2 fails transiently
        items = [{"id": str(i), "text": "x"} for i in range(3)]
        sqs = _make_sqs([
            _mixed_response([0, 1], [2], sender_fault=False),
            _success_response(1),  # retry of item 2 succeeds
        ])

        with patch("_shared.sqs_utils.metrics") as mock_metrics:
            result = send_messages_to_queue(
                sqs,
                "https://sqs/test-queue",
                items,
                metric_name="ItemsIngested",
                log_label="test",
                max_retries=1,
                initial_delay=0,
            )

        assert result == 3
        # Second call must only contain 1 entry (the failed item, not 3)
        second_call_entries = sqs.send_message_batch.call_args_list[1].kwargs.get(
            "Entries",
            sqs.send_message_batch.call_args_list[1].args[0]
            if sqs.send_message_batch.call_args_list[1].args
            else [],
        )
        assert len(second_call_entries) == 1
        mock_metrics.add_metric.assert_called_once_with(
            name="ItemsIngested", unit="Count", value=3
        )


class TestSendMessagesToQueuePersonalData:
    """Ensure personal data (full message body) is not logged."""

    def test_personal_data_not_logged(self):
        """Log messages must not contain full message body text.

        The item id is logged (for debuggability), but the feedback text
        (personal data) must stay out of logs.

        Reverts-to-catch: logging the full MessageBody reveals personal data
        in CloudWatch.
        """
        send_messages_to_queue = _import_fn()
        secret_text = "PERSONAL_DATA_SHOULD_NOT_APPEAR_IN_LOGS"
        items = [{"id": "item-0", "text": secret_text}]
        sqs = _make_sqs([_failure_response([0], sender_fault=True)])

        log_calls = []

        with patch("_shared.sqs_utils.logger") as mock_logger:
            mock_logger.warning.side_effect = lambda *a, **kw: log_calls.append(("warning", a, kw))
            mock_logger.error.side_effect = lambda *a, **kw: log_calls.append(("error", a, kw))
            mock_logger.info.side_effect = lambda *a, **kw: log_calls.append(("info", a, kw))
            with patch("_shared.sqs_utils.metrics"), pytest.raises(RuntimeError):
                send_messages_to_queue(
                    sqs,
                    "https://sqs/test-queue",
                    items,
                    metric_name="ItemsIngested",
                    log_label="test",
                )

        all_log_text = str(log_calls)
        assert secret_text not in all_log_text, (
            "Full feedback text must not appear in log output"
        )
        # The item id SHOULD appear (needed for investigation)
        assert "item-0" in all_log_text
