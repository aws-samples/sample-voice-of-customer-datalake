"""Regression tests for the per-app `enabled` flag in app_reviews ingestors.

Both Android and iOS handlers store an `enabled` boolean per app config but
historically iterated all configs in `fetch_new_items` without honoring the
flag, so disabled apps were still scraped. These tests pin down the fix:
disabled apps must be skipped before any review collection happens.
"""
import sys
import os
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

# Add plugin roots so handlers can import their sibling modules
# (countries, play_client / itunes_client, models).
ANDROID_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "app_reviews_android", "ingestor",
)
IOS_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "app_reviews_ios", "ingestor",
)


@contextmanager
def _patched_aws():
    """Mock AWS client factories used by BaseIngestor.__init__."""
    with patch("_shared.base_ingestor.get_dynamodb_resource") as mock_dynamo, \
            patch("_shared.base_ingestor.get_s3_client"), \
            patch("_shared.base_ingestor.get_sqs_client"), \
            patch("_shared.base_ingestor.get_secret", return_value={}):
        mock_dynamo.return_value.Table.return_value = MagicMock()
        yield


@pytest.fixture(autouse=True)
def _reset_handler_imports():
    """Drop cached handler modules between tests so monkeypatched paths apply."""
    yield
    for mod in [
        "synthetic_reviews.ingestor.handler",  # not used here, but cheap to clear
        "handler",
    ]:
        sys.modules.pop(mod, None)


def _import_android_handler():
    if ANDROID_DIR not in sys.path:
        sys.path.insert(0, ANDROID_DIR)
    sys.modules.pop("handler", None)
    sys.modules.pop("models", None)
    sys.modules.pop("countries", None)
    sys.modules.pop("play_client", None)
    from app_reviews_android.ingestor import handler as android_handler  # noqa: WPS433
    return android_handler


def _import_ios_handler():
    if IOS_DIR not in sys.path:
        sys.path.insert(0, IOS_DIR)
    sys.modules.pop("handler", None)
    sys.modules.pop("models", None)
    sys.modules.pop("countries", None)
    sys.modules.pop("itunes_client", None)
    from app_reviews_ios.ingestor import handler as ios_handler  # noqa: WPS433
    return ios_handler


class TestAndroidEnabledFilter:
    """app_reviews_android.handler.fetch_new_items must skip disabled apps."""

    def test_skips_disabled_app(self):
        with _patched_aws():
            android_handler = _import_android_handler()
            from app_reviews_android.ingestor.models import AndroidAppConfig

            ingestor = android_handler.AndroidAppReviewsIngestor()
            ingestor.app_configs = [
                AndroidAppConfig(name="Disabled", package_name="com.disabled", enabled=False),
            ]

            with patch(
                "app_reviews_android.ingestor.handler.process_app_reviews",
            ) as mock_process:
                items = list(ingestor.fetch_new_items())

            assert items == []
            assert mock_process.call_count == 0

    def test_processes_enabled_app(self):
        with _patched_aws():
            android_handler = _import_android_handler()
            from app_reviews_android.ingestor.models import AndroidAppConfig

            ingestor = android_handler.AndroidAppReviewsIngestor()
            ingestor.app_configs = [
                AndroidAppConfig(name="Enabled", package_name="com.enabled", enabled=True),
            ]

            with patch(
                "app_reviews_android.ingestor.handler.process_app_reviews",
                return_value=iter([{"id": "r1"}]),
            ) as mock_process:
                items = list(ingestor.fetch_new_items())

            assert items == [{"id": "r1"}]
            assert mock_process.call_count == 1

    def test_skips_only_disabled_in_mixed_list(self):
        """Disabled apps are filtered out without affecting enabled neighbors."""
        with _patched_aws():
            android_handler = _import_android_handler()
            from app_reviews_android.ingestor.models import AndroidAppConfig

            ingestor = android_handler.AndroidAppReviewsIngestor()
            ingestor.app_configs = [
                AndroidAppConfig(name="A", package_name="com.a", enabled=True),
                AndroidAppConfig(name="B", package_name="com.b", enabled=False),
                AndroidAppConfig(name="C", package_name="com.c", enabled=True),
            ]

            with patch(
                "app_reviews_android.ingestor.handler.process_app_reviews",
                side_effect=lambda **kw: iter([{"app": kw["app_name"]}]),
            ) as mock_process:
                items = list(ingestor.fetch_new_items())

            processed_names = [c.kwargs["app_name"] for c in mock_process.call_args_list]
            assert processed_names == ["A", "C"]
            assert items == [{"app": "A"}, {"app": "C"}]


class TestIOSEnabledFilter:
    """app_reviews_ios.handler.fetch_new_items must skip disabled apps."""

    def test_skips_disabled_app(self):
        ios_handler = _import_ios_handler()
        with _patched_aws(), patch.object(ios_handler, "create_session", return_value=MagicMock()):
            from app_reviews_ios.ingestor.models import IOSAppConfig

            ingestor = ios_handler.IOSAppReviewsIngestor()
            ingestor.app_configs = [
                IOSAppConfig(name="Disabled", app_id="111", enabled=False),
            ]

            with patch(
                "app_reviews_ios.ingestor.handler.process_app_reviews",
            ) as mock_process:
                items = list(ingestor.fetch_new_items())

            assert items == []
            assert mock_process.call_count == 0

    def test_processes_enabled_app(self):
        ios_handler = _import_ios_handler()
        with _patched_aws(), patch.object(ios_handler, "create_session", return_value=MagicMock()):
            from app_reviews_ios.ingestor.models import IOSAppConfig

            ingestor = ios_handler.IOSAppReviewsIngestor()
            ingestor.app_configs = [
                IOSAppConfig(name="Enabled", app_id="222", enabled=True),
            ]

            with patch(
                "app_reviews_ios.ingestor.handler.process_app_reviews",
                return_value=iter([{"id": "r1"}]),
            ) as mock_process:
                items = list(ingestor.fetch_new_items())

            assert items == [{"id": "r1"}]
            assert mock_process.call_count == 1

    def test_skips_only_disabled_in_mixed_list(self):
        ios_handler = _import_ios_handler()
        with _patched_aws(), patch.object(ios_handler, "create_session", return_value=MagicMock()):
            from app_reviews_ios.ingestor.models import IOSAppConfig

            ingestor = ios_handler.IOSAppReviewsIngestor()
            ingestor.app_configs = [
                IOSAppConfig(name="A", app_id="1", enabled=True),
                IOSAppConfig(name="B", app_id="2", enabled=False),
                IOSAppConfig(name="C", app_id="3", enabled=True),
            ]

            with patch(
                "app_reviews_ios.ingestor.handler.process_app_reviews",
                side_effect=lambda **kw: iter([{"app": kw["app_name"]}]),
            ) as mock_process:
                items = list(ingestor.fetch_new_items())

            processed_names = [c.kwargs["app_name"] for c in mock_process.call_args_list]
            assert processed_names == ["A", "C"]
            assert items == [{"app": "A"}, {"app": "C"}]
