"""Tests for shared.logging module - logging, tracing, and metrics utilities."""

from aws_lambda_powertools import Logger, Tracer, Metrics


class TestModuleLevelInstances:
    """Tests for module-level logger, tracer, and metrics instances."""

    def test_logger_is_logger_instance(self):
        """Module-level logger is a Powertools Logger."""
        from shared.logging import logger
        assert isinstance(logger, Logger)

    def test_tracer_is_tracer_instance(self):
        """Module-level tracer is a Powertools Tracer."""
        from shared.logging import tracer
        assert isinstance(tracer, Tracer)

    def test_metrics_is_metrics_instance(self):
        """Module-level metrics is a Powertools Metrics."""
        from shared.logging import metrics
        assert isinstance(metrics, Metrics)


class TestGetLogger:
    """Tests for get_logger function."""

    def test_returns_default_logger(self):
        """Returns module-level logger when no service specified."""
        from shared.logging import get_logger, logger
        result = get_logger()
        assert result is logger

    def test_returns_custom_logger(self):
        """Returns new Logger with custom service name."""
        from shared.logging import get_logger
        result = get_logger(service='custom-service')
        assert isinstance(result, Logger)

    def test_custom_logger_is_different_instance(self):
        """Custom logger is a different instance from default."""
        from shared.logging import get_logger, logger
        custom = get_logger(service='other')
        assert custom is not logger


class TestGetTracer:
    """Tests for get_tracer function."""

    def test_returns_default_tracer(self):
        """Returns module-level tracer when no service specified."""
        from shared.logging import get_tracer, tracer
        result = get_tracer()
        assert result is tracer

    def test_returns_custom_tracer(self):
        """Returns new Tracer with custom service name."""
        from shared.logging import get_tracer
        result = get_tracer(service='custom-tracer')
        assert isinstance(result, Tracer)

    def test_custom_tracer_is_different_instance(self):
        """Custom tracer is a different instance from default."""
        from shared.logging import get_tracer, tracer
        custom = get_tracer(service='other')
        assert custom is not tracer


class TestGetMetrics:
    """Tests for get_metrics function."""

    def test_returns_default_metrics(self):
        """Returns module-level metrics when no namespace specified."""
        from shared.logging import get_metrics, metrics
        result = get_metrics()
        assert result is metrics

    def test_returns_custom_metrics(self):
        """Returns new Metrics with custom namespace."""
        from shared.logging import get_metrics
        result = get_metrics(namespace='CustomNamespace')
        assert isinstance(result, Metrics)

    def test_custom_metrics_is_different_instance(self):
        """Custom metrics is a different instance from default."""
        from shared.logging import get_metrics, metrics
        custom = get_metrics(namespace='Other')
        assert custom is not metrics
