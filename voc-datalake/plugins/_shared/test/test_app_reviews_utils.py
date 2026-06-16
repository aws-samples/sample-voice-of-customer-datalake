"""
Tests for app_reviews_utils — frequency throttling, manual-only mode, and execution_id bypass.

Regression tests for the bug where:
1. frequency_minutes=0 (Manual only) was converted to 60 by parse_int
2. Manual triggers (with execution_id) were still throttled by frequency checks
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from _shared.app_reviews_utils import (
    is_due_for_run,
    parse_int,
    process_app_reviews,
)


# --- parse_int ---


class TestParseInt:
    def test_parses_valid_positive_int(self):
        assert parse_int("42", 10) == 42

    def test_returns_default_for_zero_by_default(self):
        assert parse_int("0", 10) == 10

    def test_returns_default_for_negative(self):
        assert parse_int("-5", 10) == 10

    def test_returns_default_for_non_numeric(self):
        assert parse_int("abc", 10) == 10

    def test_returns_default_for_empty_string(self):
        assert parse_int("", 10) == 10

    def test_allow_zero_returns_zero(self):
        assert parse_int("0", 60, allow_zero=True) == 0

    def test_allow_zero_still_rejects_negative(self):
        assert parse_int("-1", 60, allow_zero=True) == 60

    def test_allow_zero_still_parses_positive(self):
        assert parse_int("30", 60, allow_zero=True) == 30


# --- is_due_for_run ---


class TestIsDueForRun:
    def test_returns_true_when_no_watermark_exists(self):
        get_watermark = MagicMock(return_value=None)
        assert is_due_for_run(get_watermark, "TestApp", 60) is True

    def test_returns_true_when_watermark_is_old_enough(self):
        two_hours_ago = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        get_watermark = MagicMock(return_value=two_hours_ago)
        assert is_due_for_run(get_watermark, "TestApp", 60) is True

    def test_returns_false_when_watermark_is_recent(self):
        five_min_ago = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        get_watermark = MagicMock(return_value=five_min_ago)
        assert is_due_for_run(get_watermark, "TestApp", 60) is False

    def test_returns_true_when_watermark_is_unparseable(self):
        get_watermark = MagicMock(return_value="not-a-date")
        assert is_due_for_run(get_watermark, "TestApp", 60) is True

    def test_uses_correct_watermark_key(self):
        get_watermark = MagicMock(return_value=None)
        is_due_for_run(get_watermark, "MyApp", 60)
        get_watermark.assert_called_once_with("MyApp_last_run")


# --- process_app_reviews ---


class TestProcessAppReviews:
    """Regression tests for manual-only frequency and execution_id bypass."""

    def _make_mocks(self, last_run_time=None):
        watermarks = {}
        if last_run_time:
            watermarks["TestApp_last_run"] = last_run_time

        get_watermark = MagicMock(side_effect=lambda k, d=None: watermarks.get(k, d))
        set_watermark = MagicMock()
        app_config = MagicMock()
        app_config.name = "TestApp"

        def collect_fn(cfg):
            return [{"at": datetime.now(timezone.utc), "composite_id": "r1", "content": "Great app"}]

        def format_fn(review, cfg):
            return {"id": review["composite_id"], "text": review.get("content", "")}

        return get_watermark, set_watermark, app_config, collect_fn, format_fn

    def _run(self, *, frequency_minutes, execution_id=None, last_run_time=None):
        get_wm, set_wm, app_cfg, collect_fn, format_fn = self._make_mocks(last_run_time=last_run_time)
        results = list(process_app_reviews(
            app_config=app_cfg,
            app_name="TestApp",
            platform_label="Android",
            date_field="at",
            get_watermark_fn=get_wm,
            set_watermark_fn=set_wm,
            frequency_minutes=frequency_minutes,
            collect_fn=collect_fn,
            format_fn=format_fn,
            execution_id=execution_id,
        ))
        return results, set_wm

    # --- Manual-only (frequency=0) ---

    def test_scheduled_run_skips_when_frequency_is_zero(self):
        """frequency=0 means manual-only; scheduled runs (no execution_id) must skip."""
        results, _ = self._run(frequency_minutes=0, execution_id=None)
        assert len(results) == 0

    def test_manual_run_executes_when_frequency_is_zero(self):
        """Manual run (has execution_id) must work even with frequency=0."""
        results, _ = self._run(frequency_minutes=0, execution_id="run_123")
        assert len(results) == 1
        assert results[0]["id"] == "r1"

    # --- execution_id bypass ---

    def test_execution_id_bypasses_frequency_check(self):
        """Core regression: manual trigger must collect reviews even when not due."""
        just_now = datetime.now(timezone.utc).isoformat()
        results, _ = self._run(
            frequency_minutes=1440,
            execution_id="run_manual_123",
            last_run_time=just_now,
        )
        assert len(results) == 1

    def test_scheduled_run_skips_when_not_due(self):
        """Scheduled runs must still respect frequency throttling."""
        just_now = datetime.now(timezone.utc).isoformat()
        results, _ = self._run(
            frequency_minutes=1440,
            execution_id=None,
            last_run_time=just_now,
        )
        assert len(results) == 0

    def test_scheduled_run_executes_when_due(self):
        """Scheduled runs should execute when enough time has passed."""
        old_time = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
        results, _ = self._run(
            frequency_minutes=1440,
            execution_id=None,
            last_run_time=old_time,
        )
        assert len(results) == 1

    # --- Watermark updates ---

    def test_manual_run_still_updates_last_run_watermark(self):
        """Manual runs should still update the last_run watermark."""
        _, set_wm = self._run(frequency_minutes=0, execution_id="run_123")
        last_run_calls = [c for c in set_wm.call_args_list if c[0][0] == "TestApp_last_run"]
        assert len(last_run_calls) == 1

    # --- Error handling ---

    def test_collect_error_does_not_crash(self):
        """If collect_fn raises, should handle gracefully."""
        get_wm, set_wm, app_cfg, _, format_fn = self._make_mocks()

        def failing_collect(cfg):
            raise ConnectionError("API unavailable")

        results = list(process_app_reviews(
            app_config=app_cfg,
            app_name="TestApp",
            platform_label="Android",
            date_field="at",
            get_watermark_fn=get_wm,
            set_watermark_fn=set_wm,
            frequency_minutes=60,
            collect_fn=failing_collect,
            format_fn=format_fn,
            execution_id="run_123",
        ))
        assert len(results) == 0

    # --- Backward compatibility ---

    def test_execution_id_defaults_to_none(self):
        """Without execution_id, behaves as scheduled run (backward compatible)."""
        just_now = datetime.now(timezone.utc).isoformat()
        get_wm, set_wm, app_cfg, collect_fn, format_fn = self._make_mocks(last_run_time=just_now)

        results = list(process_app_reviews(
            app_config=app_cfg,
            app_name="TestApp",
            platform_label="Android",
            date_field="at",
            get_watermark_fn=get_wm,
            set_watermark_fn=set_wm,
            frequency_minutes=1440,
            collect_fn=collect_fn,
            format_fn=format_fn,
            # execution_id not passed — defaults to None
        ))
        assert len(results) == 0

    # --- Backfill on manual runs ---

    def test_manual_run_skips_watermark_filter_for_backfill(self):
        """Regression: manual runs must skip watermark date filter so older
        reviews can be backfilled when max_reviews_per_run increases.
        The processor deduplicates by ID, so re-sending is safe."""
        old_date = datetime(2024, 1, 1, tzinfo=timezone.utc)
        watermarks = {
            "TestApp_last_published_at": datetime(2026, 3, 28, tzinfo=timezone.utc).isoformat(),
        }
        get_wm = MagicMock(side_effect=lambda k, d=None: watermarks.get(k, d))
        set_wm = MagicMock()
        app_cfg = MagicMock()
        app_cfg.name = "TestApp"

        def collect_fn(cfg):
            # Return reviews older than the watermark — these should still be yielded
            return [
                {"at": old_date, "composite_id": "old_r1", "content": "Old review"},
                {"at": old_date, "composite_id": "old_r2", "content": "Another old one"},
            ]

        def format_fn(review, cfg):
            return {"id": review["composite_id"], "text": review.get("content", "")}

        results = list(process_app_reviews(
            app_config=app_cfg,
            app_name="TestApp",
            platform_label="Android",
            date_field="at",
            get_watermark_fn=get_wm,
            set_watermark_fn=set_wm,
            frequency_minutes=0,
            collect_fn=collect_fn,
            format_fn=format_fn,
            execution_id="run_backfill_123",
        ))

        assert len(results) == 2

    def test_scheduled_run_still_uses_watermark_filter(self):
        """Scheduled runs must still filter by watermark to avoid reprocessing."""
        old_date = datetime(2024, 1, 1, tzinfo=timezone.utc)
        watermarks = {
            "TestApp_last_published_at": datetime(2026, 3, 28, tzinfo=timezone.utc).isoformat(),
            "TestApp_last_run": (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat(),
        }
        get_wm = MagicMock(side_effect=lambda k, d=None: watermarks.get(k, d))
        set_wm = MagicMock()
        app_cfg = MagicMock()
        app_cfg.name = "TestApp"

        def collect_fn(cfg):
            return [{"at": old_date, "composite_id": "old_r1", "content": "Old review"}]

        def format_fn(review, cfg):
            return {"id": review["composite_id"], "text": review.get("content", "")}

        results = list(process_app_reviews(
            app_config=app_cfg,
            app_name="TestApp",
            platform_label="Android",
            date_field="at",
            get_watermark_fn=get_wm,
            set_watermark_fn=set_wm,
            frequency_minutes=1440,
            collect_fn=collect_fn,
            format_fn=format_fn,
            # No execution_id = scheduled run
        ))

        assert len(results) == 0
