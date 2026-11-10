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
from contextlib import ExitStack, contextmanager
from unittest.mock import MagicMock, patch

import pytest

from _shared.test.ingestor_fixtures import offline_ingestor_construction

_PLUGINS_DIR = os.path.dirname(os.path.abspath(__file__))
ANDROID_DIR = os.path.join(_PLUGINS_DIR, "app_reviews_android", "ingestor")
IOS_DIR = os.path.join(_PLUGINS_DIR, "app_reviews_ios", "ingestor")

_FLAT_MODULES = ["models", "countries", "play_client", "itunes_client"]

# Both handlers delegate the enabled-filter loop to this shared generator,
# which is where the per-app pipeline must be intercepted.
PROCESS_APP_REVIEWS = "_shared.app_reviews_utils.process_app_reviews"


@contextmanager
def _patched_aws():
    """Mock the AWS client factories used by BaseIngestor.__init__."""
    with offline_ingestor_construction():
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


@contextmanager
def _android_ingestor():
    """An AndroidAppReviewsIngestor plus a builder for its app configs."""
    with _patched_aws():
        android_handler = _import_android_handler()
        # The handler's own `from models import AndroidAppConfig` binding.
        android_app_config = android_handler.AndroidAppConfig

        def make_config(name, identifier, enabled):
            return android_app_config(name=name, package_name=identifier, enabled=enabled)

        yield android_handler.AndroidAppReviewsIngestor(), make_config


@contextmanager
def _ios_ingestor():
    """An IOSAppReviewsIngestor plus a builder for its app configs."""
    ios_handler = _import_ios_handler()
    with _patched_aws(), patch.object(ios_handler, "create_session", return_value=MagicMock()):
        # The handler's own `from models import IOSAppConfig` binding.
        ios_app_config = ios_handler.IOSAppConfig

        def make_config(name, identifier, enabled):
            return ios_app_config(name=name, app_id=identifier, enabled=enabled)

        yield ios_handler.IOSAppReviewsIngestor(), make_config


@pytest.fixture(params=[_android_ingestor, _ios_ingestor], ids=["android", "ios"])
def ingestor_and_config(request):
    """(ingestor, make_config(name, identifier, enabled)) for each platform."""
    with ExitStack() as stack:
        yield stack.enter_context(request.param())


class TestEnabledFilter:
    """fetch_new_items honors the per-app enabled flag on both platforms."""

    def test_skips_disabled_app(self, ingestor_and_config):
        ingestor, make_config = ingestor_and_config
        ingestor.app_configs = [make_config("Disabled", "com.disabled", False)]

        with patch(PROCESS_APP_REVIEWS) as mock_process:
            items = list(ingestor.fetch_new_items())

        assert items == []
        assert mock_process.call_count == 0

    def test_processes_enabled_app(self, ingestor_and_config):
        ingestor, make_config = ingestor_and_config
        ingestor.app_configs = [make_config("Enabled", "com.enabled", True)]

        with patch(PROCESS_APP_REVIEWS, return_value=iter([{"id": "r1"}])) as mock_process:
            items = list(ingestor.fetch_new_items())

        assert items == [{"id": "r1"}]
        assert mock_process.call_count == 1

    def test_skips_only_disabled_in_mixed_list(self, ingestor_and_config):
        """Disabled apps are filtered out without affecting enabled neighbors."""
        ingestor, make_config = ingestor_and_config
        ingestor.app_configs = [
            make_config("A", "1", True),
            make_config("B", "2", False),
            make_config("C", "3", True),
        ]

        with patch(
            PROCESS_APP_REVIEWS,
            side_effect=lambda **kw: iter([{"app": kw["app_name"]}]),
        ) as mock_process:
            items = list(ingestor.fetch_new_items())

        processed_names = [c.kwargs["app_name"] for c in mock_process.call_args_list]
        assert processed_names == ["A", "C"]
        assert items == [{"app": "A"}, {"app": "C"}]
