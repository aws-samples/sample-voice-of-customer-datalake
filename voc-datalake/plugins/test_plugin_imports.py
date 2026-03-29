"""
Smoke tests for plugin imports.

Validates that plugin handlers and shared modules can be imported without errors.
This catches missing shared modules (like shared.http) that would cause
Lambda runtime import failures at runtime.
"""
import importlib
import pytest


class TestSharedModuleImports:
    """Validate shared modules required by plugins exist and are importable."""

    def test_shared_http_module_exists(self):
        """Regression: shared/http.py was deleted but plugins still need it.
        
        This would have caught the webscraper Lambda import failure.
        """
        from shared.http import fetch_with_retry
        assert callable(fetch_with_retry)

    def test_shared_http_fetch_json_exists(self):
        """fetch_json_with_retry must also be available."""
        from shared.http import fetch_json_with_retry
        assert callable(fetch_json_with_retry)

    def test_base_ingestor_imports_successfully(self):
        """base_ingestor must import without errors — all plugins depend on it."""
        from _shared.base_ingestor import BaseIngestor, fetch_with_retry
        assert callable(fetch_with_retry)
        assert BaseIngestor is not None

    def test_webscraper_handler_imports_successfully(self):
        """Webscraper plugin must import without errors (no Lambda layer deps)."""
        mod = importlib.import_module('webscraper.ingestor.handler')
        assert hasattr(mod, 'WebScraperIngestor')
