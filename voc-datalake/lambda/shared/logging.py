"""
Shared logging, tracing, and metrics configuration for VoC Lambda functions.
Uses AWS Lambda Powertools for structured logging and observability.
"""

from aws_lambda_powertools import Logger, Tracer, Metrics

# Shared logger instance - service name set via POWERTOOLS_SERVICE_NAME env var
logger = Logger()

# Shared tracer instance - service name set via POWERTOOLS_SERVICE_NAME env var
tracer = Tracer()

# Shared metrics instance - namespace set via POWERTOOLS_METRICS_NAMESPACE env var
# Default namespace for backwards compatibility
metrics = Metrics(namespace="VoC")


def get_logger(service: str = None) -> Logger:
    """Get a logger instance with optional service name override."""
    if service:
        return Logger(service=service)
    return logger


def get_tracer(service: str = None) -> Tracer:
    """Get a tracer instance with optional service name override."""
    if service:
        return Tracer(service=service)
    return tracer


def get_metrics(namespace: str = None) -> Metrics:
    """Get a metrics instance with optional namespace override."""
    if namespace:
        return Metrics(namespace=namespace)
    return metrics
