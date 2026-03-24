"""
Additional coverage tests for shared.idempotency module.
Targets uncovered lines: 57-59 (get_persistence_layer creating layer), 88 (get_idempotency_config).
"""

import os
import pytest
from unittest.mock import patch, MagicMock


class TestGetPersistenceLayerNoTable:
    """Tests for get_persistence_layer when no table is configured."""

    def setup_method(self):
        """Reset the cached persistence layer before each test."""
        import shared.idempotency
        shared.idempotency._persistence_layer = None

    def test_raises_value_error_when_no_table_configured(self):
        """Raises ValueError when IDEMPOTENCY_TABLE env var is empty."""
        import shared.idempotency
        shared.idempotency._persistence_layer = None

        with patch.dict(os.environ, {'IDEMPOTENCY_TABLE': ''}, clear=False):
            from shared.idempotency import get_persistence_layer

            with pytest.raises(ValueError, match="Idempotency table not configured"):
                get_persistence_layer()

    def teardown_method(self):
        """Reset the cached persistence layer after each test."""
        import shared.idempotency
        shared.idempotency._persistence_layer = None


class TestGetPersistenceLayerCreatesLayer:
    """Tests for get_persistence_layer successfully creating a DynamoDBPersistenceLayer."""

    def setup_method(self):
        import shared.idempotency
        shared.idempotency._persistence_layer = None

    @patch('shared.idempotency.DynamoDBPersistenceLayer')
    def test_creates_persistence_layer_from_env(self, mock_layer_cls):
        """Creates DynamoDBPersistenceLayer from IDEMPOTENCY_TABLE env var."""
        import shared.idempotency
        shared.idempotency._persistence_layer = None

        mock_instance = MagicMock()
        mock_layer_cls.return_value = mock_instance

        with patch.dict(os.environ, {'IDEMPOTENCY_TABLE': 'my-idempotency-table'}, clear=False):
            from shared.idempotency import get_persistence_layer
            result = get_persistence_layer()

        assert result is mock_instance
        mock_layer_cls.assert_called_once_with(table_name='my-idempotency-table')

    @patch('shared.idempotency.DynamoDBPersistenceLayer')
    def test_creates_persistence_layer_from_arg(self, mock_layer_cls):
        """Creates DynamoDBPersistenceLayer from explicit table_name argument."""
        import shared.idempotency
        shared.idempotency._persistence_layer = None

        mock_instance = MagicMock()
        mock_layer_cls.return_value = mock_instance

        from shared.idempotency import get_persistence_layer
        result = get_persistence_layer(table_name='explicit-table')

        assert result is mock_instance
        mock_layer_cls.assert_called_once_with(table_name='explicit-table')

    @patch('shared.idempotency.DynamoDBPersistenceLayer')
    def test_caches_persistence_layer(self, mock_layer_cls):
        """Caches the persistence layer and returns same instance on subsequent calls."""
        import shared.idempotency
        shared.idempotency._persistence_layer = None

        mock_instance = MagicMock()
        mock_layer_cls.return_value = mock_instance

        with patch.dict(os.environ, {'IDEMPOTENCY_TABLE': 'cached-table'}, clear=False):
            from shared.idempotency import get_persistence_layer
            result1 = get_persistence_layer()
            result2 = get_persistence_layer()

        assert result1 is result2
        mock_layer_cls.assert_called_once()

    def teardown_method(self):
        import shared.idempotency
        shared.idempotency._persistence_layer = None


class TestGetIdempotencyConfig:
    """Tests for get_idempotency_config function."""

    def test_returns_config_with_defaults(self):
        """Returns IdempotencyConfig with default values."""
        from shared.idempotency import get_idempotency_config

        config = get_idempotency_config()
        assert config is not None
        assert config.expires_after_seconds == 3600
        assert config.use_local_cache is True

    def test_returns_config_with_custom_values(self):
        """Returns IdempotencyConfig with custom values."""
        from shared.idempotency import get_idempotency_config

        config = get_idempotency_config(
            expires_after_seconds=7200,
            event_key_jmespath="body.id",
            use_local_cache=False,
            local_cache_max_items=128,
            raise_on_no_idempotency_key=True,
        )
        assert config is not None
        assert config.expires_after_seconds == 7200
        assert config.use_local_cache is False
        assert config.raise_on_no_idempotency_key is True
