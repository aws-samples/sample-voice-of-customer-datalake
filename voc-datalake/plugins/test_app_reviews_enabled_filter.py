"""Regression tests for the per-app `enabled` flag in app_reviews ingestors.

Both Android and iOS handlers parse an `enabled` boolean per app config
(`models.py` defaults it to True) but historically iterated all configs in
`fetch_new_items` without honoring the flag, so disabled apps were still
scraped. These tests pin down the fix: disabled apps must be skipped before
any review collection happens.

Import mechanics: the handlers use flat sibling imports (`from models import
...`, `from countries import ...`) that mirror the Lambda bundle layout, and
BOTH plugins ship same-named flat modules. Each import helper therefore puts
the right ingestor dir at the front of sys.path and drops any cached flat
modules first, so the second plugin's handler doesn't pick up the first
plugin's `models`/`countries`.

Ported from GitHub PR #108 (cluster 2, `.pr108-reconcile` P2).
"""
import os
import sys
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

_PLUGINS_DIR = os.path.dirname(os.path.abspath(__file__))
ANDROID_DIR = os.path.join(_PLUGINS_DIR, "app_reviews_android", "ingestor")
IOS_DIR = os.path.join(_PLUGINS_DIR, "app_reviews_ios", "ingestor")

_FLAT_MODULES = ["models", "countries", "play_client", "itunes_client"]


@contextmanager
def _patched_aws():
    """Mock the AWS client factories used by BaseIngestor.__init__."""
    with patch("_shared.base_ingestor.get_dynamodb_resource") as mock_dynamo, \
            patch("_shared.base_ingestor.get_s3_client"), \
            patch("_shared.base_ingestor.get_sqs_client"), \
            patch("_shared.base_ingestor.get_secret", return_value={}):
        mock_dynamo.return_value.Table.return_value = MagicMock()
        yield


def _prepare_flat_imports(ingestor_dir: str) -> None:
    """Point the flat sibling imports at the given plugin's ingestor dir."""
    for mod in _FLAT_MODULES:
        sys.modules.pop(mod, None)
    if ingestor_dir in sys.path:
        sys.path.remove(ingestor_dir)
    sys.path.insert(0, ingestor_dir)


def _import_android_handler():
    _prepare_flat_imports(ANDROID_DIR)
    sys.modules.pop("app_reviews_android.ingestor.handler", None)
    from app_reviews_android.ingestor import handler as android_handler
    return android_handler


def _import_ios_handler():
    _prepare_flat_imports(IOS_DIR)
    sys.modules.pop("app_reviews_ios.ingestor.handler", None)
    from app_reviews_ios.ingestor import handler as ios_handler
    return ios_handler


class TestAndroidEnabledFilter:
    """app_reviews_android fetch_new_items honors the per-app enabled flag."""

    def test_skips_disabled_app(self):
        with _patched_aws():
            android_handler = _import_android_handler()
            from models import AndroidAppConfig

            ingestor = android_handler.AndroidAppReviewsIngestor()
            ingestor.app_configs = [
                AndroidAppConfig(name="Disabled", package_name="com.disabled", enabled=False),
            ]

            with patch.object(android_handler, "process_app_reviews") as mock_process:
                items = list(ingestor.fetch_new_items())

            assert items == []
            assert mock_process.call_count == 0

    def test_processes_enabled_app(self):
        with _patched_aws():
            android_handler = _import_android_handler()
            from models import AndroidAppConfig

            ingestor = android_handler.AndroidAppReviewsIngestor()
            ingestor.app_configs = [
                AndroidAppConfig(name="Enabled", package_name="com.enabled", enabled=True),
            ]

            with patch.object(
                android_handler, "process_app_reviews",
                return_value=iter([{"id": "r1"}]),
            ) as mock_process:
                items = list(ingestor.fetch_new_items())

            assert items == [{"id": "r1"}]
            assert mock_process.call_count == 1

    def test_skips_only_disabled_in_mixed_list(self):
        """Disabled apps are filtered out without affecting enabled neighbors."""
        with _patched_aws():
            android_handler = _import_android_handler()
            from models import AndroidAppConfig

            ingestor = android_handler.AndroidAppReviewsIngestor()
            ingestor.app_configs = [
                AndroidAppConfig(name="A", package_name="com.a", enabled=True),
                AndroidAppConfig(name="B", package_name="com.b", enabled=False),
                AndroidAppConfig(name="C", package_name="com.c", enabled=True),
            ]

            with patch.object(
                android_handler, "process_app_reviews",
                side_effect=lambda **kw: iter([{"app": kw["app_name"]}]),
            ) as mock_process:
                items = list(ingestor.fetch_new_items())

            processed_names = [c.kwargs["app_name"] for c in mock_process.call_args_list]
            assert processed_names == ["A", "C"]
            assert items == [{"app": "A"}, {"app": "C"}]


class TestIOSEnabledFilter:
    """app_reviews_ios fetch_new_items honors the per-app enabled flag."""

    def test_skips_disabled_app(self):
        ios_handler = _import_ios_handler()
        with _patched_aws(), patch.object(ios_handler, "create_session", return_value=MagicMock()):
            from models import IOSAppConfig

            ingestor = ios_handler.IOSAppReviewsIngestor()
            ingestor.app_configs = [
                IOSAppConfig(name="Disabled", app_id="111", enabled=False),
            ]

            with patch.object(ios_handler, "process_app_reviews") as mock_process:
                items = list(ingestor.fetch_new_items())

            assert items == []
            assert mock_process.call_count == 0

    def test_processes_enabled_app(self):
        ios_handler = _import_ios_handler()
        with _patched_aws(), patch.object(ios_handler, "create_session", return_value=MagicMock()):
            from models import IOSAppConfig

            ingestor = ios_handler.IOSAppReviewsIngestor()
            ingestor.app_configs = [
                IOSAppConfig(name="Enabled", app_id="222", enabled=True),
            ]

            with patch.object(
                ios_handler, "process_app_reviews",
                return_value=iter([{"id": "r1"}]),
            ) as mock_process:
                items = list(ingestor.fetch_new_items())

            assert items == [{"id": "r1"}]
            assert mock_process.call_count == 1

    def test_skips_only_disabled_in_mixed_list(self):
        ios_handler = _import_ios_handler()
        with _patched_aws(), patch.object(ios_handler, "create_session", return_value=MagicMock()):
            from models import IOSAppConfig

            ingestor = ios_handler.IOSAppReviewsIngestor()
            ingestor.app_configs = [
                IOSAppConfig(name="A", app_id="1", enabled=True),
                IOSAppConfig(name="B", app_id="2", enabled=False),
                IOSAppConfig(name="C", app_id="3", enabled=True),
            ]

            with patch.object(
                ios_handler, "process_app_reviews",
                side_effect=lambda **kw: iter([{"app": kw["app_name"]}]),
            ) as mock_process:
                items = list(ingestor.fetch_new_items())

            processed_names = [c.kwargs["app_name"] for c in mock_process.call_args_list]
            assert processed_names == ["A", "C"]
            assert items == [{"app": "A"}, {"app": "C"}]
