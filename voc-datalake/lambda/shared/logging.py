"""
Shared logging, tracing, and metrics configuration for VoC Lambda functions.
Uses AWS Lambda Powertools for structured logging and observability.
"""

from aws_lambda_powertools import Logger, Metrics, Tracer

from shared.tracing import deferred_xray_provider

# Shared logger instance - service name set via POWERTOOLS_SERVICE_NAME env var
logger = Logger()

# Shared tracer instance - service name set via POWERTOOLS_SERVICE_NAME env var.
# The deferred provider keeps the X-Ray SDK (~350 ms of import, two botocore
# clients) out of every cold start until an invocation is actually sampled —
# see shared/tracing.py.
tracer = Tracer(provider=deferred_xray_provider)

# Shared metrics instance - namespace set via POWERTOOLS_METRICS_NAMESPACE env var
# Default namespace for backwards compatibility
metrics = Metrics(namespace="VoC")



