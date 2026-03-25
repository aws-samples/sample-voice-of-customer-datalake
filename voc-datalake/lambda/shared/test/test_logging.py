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
