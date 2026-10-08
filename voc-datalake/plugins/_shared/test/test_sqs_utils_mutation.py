"""Mutation hardening for `_shared/sqs_utils.py`.

`test_sqs_utils.py` pins WHICH items are reported lost, retried and counted,
but a mutation run found 70 of 148 mutants it could not see:

* the BACKOFF itself: no test ever let a retry sleep, so the schedule
  (``initial_delay * 2 ** (attempt - 1)``, jitter drawn from ``uniform(0.5,
  1.5)``, nothing before the first attempt, nothing when ``initial_delay`` is
  0) and the ``max_retries=3`` / ``initial_delay=0.5`` defaults were never
  asserted;
* the WORDING of every log line and of the ``RuntimeError`` — the earlier
  tests matched substrings (``"invalid Id"``, ``"unaccounted"``) or only the
  item id, so a format string could drift or lose its label without failing;
* the ENTRIES sent to SQS — ``Id`` is the batch index as a string and
  ``MessageBody`` is ``json.dumps(item, default=str)``;
* the fallbacks nothing had exercised: an item with no ``id`` field is named
  ``idx-<n>``, a ``Failed`` entry with no ``Code`` logs ``Unknown``, with no
  ``SenderFault`` it is transient, with no ``Id`` it is escalated as
  ``'<missing>'``;
* the reconciliation count (Successful PLUS Failed entries) — every earlier
  case had an empty ``Failed`` list, where ``+`` and ``-`` agree;
* that a repeated ``Failed`` Id skips only ITSELF (``continue``, not
  ``break``), so the entries after it are still classified.

The run also showed the loop bound ``range(max_retries + 1)`` and the
exhausted-retries ``return False`` were redundant with each other (every mutant
of either was equivalent); the module now loops ``while pending`` and the
retry cap is pinned here by call count alone.
"""
import dataclasses
import json
from unittest.mock import MagicMock, call, patch

import pytest

from _shared import sqs_utils
from _shared.sqs_utils import send_messages_to_queue

_QUEUE_URL = "https://sqs/test-queue"
_LABEL = "test"


def _sqs(responses: list[dict]) -> MagicMock:
    """A client whose ``send_message_batch`` returns *responses* in order and
    raises ``StopIteration`` on any extra call, so an over-retrying mutant
    fails fast instead of looping."""
    client = MagicMock()
    client.send_message_batch.side_effect = responses
    return client


def _ok(*ids: int) -> dict:
    return {"Successful": [{"Id": str(i)} for i in ids], "Failed": []}


def _failed(
    *ids: object, sender_fault: bool | None = False, code: str | None = "Throttled"
) -> list[dict]:
    entries = []
    for raw in ids:
        entry: dict = {"Id": raw}
        if sender_fault is not None:
            entry["SenderFault"] = sender_fault
        if code is not None:
            entry["Code"] = code
        entries.append(entry)
    return entries


def _send(sqs: MagicMock, items: list[dict], **overrides) -> int:
    """Send with the suite's standard arguments and no backoff delay;
    *overrides* are passed through (``initial_delay=None`` keeps the default)."""
    kwargs: dict = {"metric_name": "ItemsIngested", "log_label": _LABEL, "initial_delay": 0}
    kwargs.update(overrides)
    if kwargs["initial_delay"] is None:
        del kwargs["initial_delay"]
    with patch("_shared.sqs_utils.metrics"):
        return send_messages_to_queue(sqs, _QUEUE_URL, items, **kwargs)


def _send_logged(sqs: MagicMock, items: list[dict], **overrides) -> tuple[MagicMock, str]:
    """Send expecting ``RuntimeError``; return the patched logger and the
    exact exception text."""
    with (
        patch("_shared.sqs_utils.logger") as logger,
        pytest.raises(RuntimeError) as exc_info,
    ):
        _send(sqs, items, **overrides)
    return logger, str(exc_info.value)


_ITEM = {"id": "i0", "text": "x"}
_ITEMS2 = [{"id": "i0", "text": "x"}, {"id": "i1", "text": "y"}]
_ITEMS3 = [{"id": "i0", "text": "x"}, {"id": "i1", "text": "y"}, {"id": "i2", "text": "z"}]


class TestBackoffSchedule:
    """Each retry round sleeps initial_delay * 2**(attempt-1) * jitter."""

    def _run_with_backoff(self, **overrides) -> tuple[MagicMock, MagicMock, MagicMock]:
        sqs = _sqs([{"Successful": [], "Failed": _failed("0")}] * 4)
        with (
            patch("_shared.sqs_utils.time.sleep") as sleep,
            patch.object(sqs_utils._jitter, "uniform", return_value=1.25) as uniform,
            patch("_shared.sqs_utils.logger") as logger,
            pytest.raises(RuntimeError),
        ):
            _send(sqs, [_ITEM], **overrides)
        return sleep, uniform, logger

    def test_defaults_sleep_before_each_of_three_retries_only(self):
        sleep, uniform, logger = self._run_with_backoff(initial_delay=0.5)
        assert sleep.call_args_list == [call(0.625), call(1.25), call(2.5)]
        assert uniform.call_args_list == [call(0.5, 1.5)] * 3
        assert logger.debug.call_args_list == [
            call(
                "SQS retry attempt %d/%d for %d %s item(s); sleeping %.2fs",
                attempt, 3, 1, _LABEL, delay,
            )
            for attempt, delay in ((1, 0.625), (2, 1.25), (3, 2.5))
        ]

    def test_default_initial_delay_is_half_a_second(self):
        sleep, _uniform, _logger = self._run_with_backoff(initial_delay=None)
        assert sleep.call_args_list == [call(0.625), call(1.25), call(2.5)]

    @pytest.mark.parametrize("initial_delay", [0, -1])
    def test_non_positive_initial_delay_never_sleeps_nor_logs(self, initial_delay):
        sleep, uniform, logger = self._run_with_backoff(initial_delay=initial_delay)
        sleep.assert_not_called()
        uniform.assert_not_called()
        logger.debug.assert_not_called()

    def test_default_max_retries_is_three(self):
        sqs = _sqs([{"Successful": [], "Failed": _failed("0")}] * 4)
        with pytest.raises(RuntimeError):
            _send(sqs, [_ITEM])
        assert sqs.send_message_batch.call_count == 4

    @pytest.mark.parametrize(("max_retries", "calls"), [(0, 1), (1, 2), (2, 3)])
    def test_rounds_equal_max_retries_plus_one(self, max_retries, calls):
        sqs = _sqs([{"Successful": [], "Failed": _failed("0")}] * (calls + 1))
        with pytest.raises(RuntimeError):
            _send(sqs, [_ITEM], max_retries=max_retries)
        assert sqs.send_message_batch.call_count == calls

    def test_round_context_is_immutable(self):
        ctx = sqs_utils._RoundContext(attempt=0, max_retries=3, log_label=_LABEL)
        field_name = "attempt"  # via setattr: a literal assignment is a type error on a frozen dataclass
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(ctx, field_name, 1)


class TestWireShape:
    def test_entries_carry_index_ids_and_json_bodies(self):
        items = [{"id": "i0", "when": {1, 2}}, {"id": "i1"}]
        sqs = _sqs([_ok(0, 1)])
        with patch("_shared.sqs_utils.logger") as logger:
            assert _send(sqs, items) == 2
        sqs.send_message_batch.assert_called_once_with(
            QueueUrl=_QUEUE_URL,
            Entries=[
                {"Id": "0", "MessageBody": json.dumps(items[0], default=str)},
                {"Id": "1", "MessageBody": json.dumps(items[1], default=str)},
            ],
        )
        logger.info.assert_called_once_with(
            "Enqueued %d of %d %s items to processing queue", 2, 2, _LABEL
        )
        logger.error.assert_not_called()

    def test_metric_uses_the_given_name(self):
        sqs = _sqs([_ok(0)])
        with patch("_shared.sqs_utils.metrics") as metrics:
            send_messages_to_queue(
                sqs, _QUEUE_URL, [_ITEM], metric_name="Custom", log_label=_LABEL, initial_delay=0
            )
        metrics.add_metric.assert_called_once_with(name="Custom", unit="Count", value=1)


class TestSuccessfulListIsCountedByDistinctSubmittedId:
    def test_duplicate_successful_id_is_logged_with_both_counts(self):
        sqs = _sqs([{"Successful": [{"Id": "0"}, {"Id": "0"}], "Failed": []}])
        logger, message = _send_logged(sqs, _ITEMS2)
        assert logger.error.call_args_list[0] == call(
            "SQS reported %d Successful entry(ies) but only %d map to "
            "a distinct submitted entry; ignoring the remainder for "
            "counting. label=%s",
            2, 1, _LABEL,
        )
        assert message == "1 test item(s) could not be enqueued after retries; ids=['i1']"

    def test_fully_matching_successful_list_logs_nothing(self):
        sqs = _sqs([_ok(0, 1)])
        with patch("_shared.sqs_utils.logger") as logger:
            _send(sqs, _ITEMS2)
        logger.error.assert_not_called()
        logger.warning.assert_not_called()


class TestBatchItemAt:
    def test_maps_a_numeric_string_to_its_item(self):
        assert sqs_utils._batch_item_at("1", _ITEMS2) == (1, _ITEMS2[1])

    @pytest.mark.parametrize(("raw_id", "exc", "text"), [
        ("-1", IndexError, "negative batch index: -1"),
        ("2", IndexError, "list index out of range"),
        ("abc", ValueError, "invalid literal for int() with base 10: 'abc'"),
        ({}, TypeError, "int() argument must be a string, a bytes-like object or a real number, not 'dict'"),
    ])
    def test_refuses_an_unmappable_id(self, raw_id, exc, text):
        with pytest.raises(exc) as exc_info:
            sqs_utils._batch_item_at(raw_id, _ITEMS2)
        assert str(exc_info.value) == text


class TestEveryFailureLogNamesItsCause:
    def test_sender_fault_warning(self):
        entry = _failed("0", sender_fault=True, code="MessageTooLarge")[0]
        sqs = _sqs([{"Successful": [], "Failed": [entry]}])
        logger, message = _send_logged(sqs, [_ITEM])
        logger.warning.assert_called_once_with(
            "SQS entry permanently rejected (SenderFault=true); "
            "item_id=%s code=%s label=%s",
            "i0", "MessageTooLarge", _LABEL,
        )
        logger.error.assert_called_once_with(
            "Failed to enqueue %d %s item(s); ids=%s", 1, _LABEL, ["i0"]
        )
        assert message == "1 test item(s) could not be enqueued after retries; ids=['i0']"

    def test_retries_exhausted_warning_names_the_cap(self):
        sqs = _sqs([{"Successful": [], "Failed": _failed("0", code="T")}] * 3)
        logger, _message = _send_logged(sqs, [_ITEM], max_retries=2)
        logger.warning.assert_called_once_with(
            "SQS entry failed after %d retries; item_id=%s code=%s label=%s",
            2, "i0", "T", _LABEL,
        )

    def test_missing_code_is_reported_as_unknown(self):
        sqs = _sqs([{"Successful": [], "Failed": _failed("0", sender_fault=True, code=None)}])
        logger, _message = _send_logged(sqs, [_ITEM])
        assert logger.warning.call_args.args[2] == "Unknown"

    def test_missing_sender_fault_means_transient(self):
        sqs = _sqs([
            {"Successful": [], "Failed": _failed("0", sender_fault=None)},
            _ok(0),
        ])
        assert _send(sqs, [_ITEM], max_retries=1) == 1
        assert sqs.send_message_batch.call_count == 2

    def test_item_without_id_is_named_by_its_batch_index(self):
        items = [{"text": "x"}, {"text": "y"}, {"text": "z"}]
        # Entry 1 fails outright, entry 2 is left unaccounted, entry 0 is fine.
        sqs = _sqs([{"Successful": [{"Id": "0"}], "Failed": _failed("1", sender_fault=True)}])
        logger, message = _send_logged(sqs, items)
        assert logger.warning.call_args.args[1] == "idx-1"
        assert message == (
            "2 test item(s) could not be enqueued after retries; ids=['idx-1', 'idx-2']"
        )

    def test_missing_id_entry(self):
        entry = {"SenderFault": True, "Code": "X"}
        sqs = _sqs([{"Successful": [{"Id": "0"}], "Failed": [entry]}])
        logger, message = _send_logged(sqs, [_ITEM])
        assert logger.error.call_args_list[0] == call(
            "SQS Failed entry missing Id field; entry=%s label=%s", entry, _LABEL
        )
        assert message == (
            "1 test failure(s) could not be attributed to a submitted entry; "
            "unusable Id(s)=['<missing>']"
        )

    def test_invalid_id_entry(self):
        entry = _failed("99", sender_fault=True, code="X")[0]
        sqs = _sqs([{"Successful": [{"Id": "0"}], "Failed": [entry]}])
        logger, message = _send_logged(sqs, [_ITEM])
        assert logger.error.call_args_list[0] == call(
            "SQS Failed entry has invalid Id %r (batch size %d); entry=%s label=%s",
            "99", 1, entry, _LABEL,
        )
        assert logger.error.call_args_list[1] == call(
            "SQS reported a Failed entry with unusable Id %s that no "
            "unaccounted submitted entry can explain; escalating it as "
            "an unattributable failure. label=%s",
            "'99'", _LABEL,
        )
        assert logger.error.call_args_list[2] == call(
            "SQS reported %d %s failure(s) that no submitted entry can "
            "account for; unusable Id(s)=%s",
            1, _LABEL, ["'99'"],
        )
        assert message == (
            "1 test failure(s) could not be attributed to a submitted entry; "
            "unusable Id(s)=[\"'99'\"]"
        )

    def test_both_kinds_are_joined_in_one_error(self):
        sqs = _sqs([{
            "Successful": [{"Id": "1"}],
            "Failed": _failed("0", "abc", sender_fault=True, code="X"),
        }])
        _logger, message = _send_logged(sqs, _ITEMS2)
        assert message == (
            "1 test item(s) could not be enqueued after retries; ids=['i0']; "
            "1 test failure(s) could not be attributed to a submitted entry; "
            "unusable Id(s)=[\"'abc'\"]"
        )


class TestReconciliation:
    def test_counts_successful_plus_failed_entries(self):
        sqs = _sqs([{"Successful": [{"Id": "0"}], "Failed": _failed("1", sender_fault=True)}])
        logger, message = _send_logged(sqs, _ITEMS3)
        assert logger.error.call_args_list[0] == call(
            "SQS response returned %d entry(ies) covering %d of %d "
            "submitted entries; treating %d unaccounted entry(ies) "
            "as failed. label=%s",
            2, 2, 3, 1, _LABEL,
        )
        assert message == "2 test item(s) could not be enqueued after retries; ids=['i1', 'i2']"

    @pytest.mark.parametrize(("second_item", "named_as"), [
        ({"id": "i1", "text": "y"}, "i1"),
        ({"text": "y"}, "idx-1"),
    ])
    def test_unmappable_failure_is_attributed_to_the_unaccounted_entry(self, second_item, named_as):
        items = [{"id": "i0", "text": "x"}, second_item]
        sqs = _sqs([{"Successful": [{"Id": "0"}], "Failed": _failed("zz", sender_fault=True)}])
        logger, message = _send_logged(sqs, items)
        assert logger.error.call_args_list[2] == call(
            "SQS reported %d Failed entry(ies) with unusable Id(s) %s; "
            "attributing them to unaccounted submitted entry(ies) %s, "
            "already recorded as failed. label=%s",
            1, ["'zz'"], [named_as], _LABEL,
        )
        assert message == (
            f"1 test item(s) could not be enqueued after retries; ids=['{named_as}']"
        )


class TestRepeatedAndContradictoryIds:
    def test_repeated_failed_id_is_logged_and_the_rest_still_classified(self):
        # Id 0 twice (permanent), then Id 1 transient: 1 must still be retried.
        sqs = _sqs([
            {
                "Successful": [],
                "Failed": _failed("0", "0", sender_fault=True, code="X") + _failed("1", code="T"),
            },
            _ok(0),
        ])
        logger, message = _send_logged(sqs, _ITEMS2, max_retries=1)
        logger.error.assert_any_call(
            "SQS repeated Failed Id %r in one response; ignoring the duplicate. label=%s",
            "0", _LABEL,
        )
        assert sqs.send_message_batch.call_count == 2
        assert sqs.send_message_batch.call_args_list[1].kwargs["Entries"] == [
            {"Id": "0", "MessageBody": json.dumps(_ITEMS2[1])}
        ]
        assert message == "1 test item(s) could not be enqueued after retries; ids=['i0']"

    def test_both_lists_id_is_logged_with_its_raw_id(self):
        sqs = _sqs([{"Successful": [{"Id": "0"}], "Failed": _failed("0", sender_fault=True)}])
        logger, _message = _send_logged(sqs, [_ITEM])
        logger.error.assert_any_call(
            "SQS reported Id %r as both Successful and Failed; "
            "trusting the Failed entry and withdrawing the "
            "counted success. label=%s",
            "0", _LABEL,
        )
