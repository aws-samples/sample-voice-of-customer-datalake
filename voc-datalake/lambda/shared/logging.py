"""
Shared logging, tracing, and metrics configuration for VoC Lambda functions.
Uses AWS Lambda Powertools for structured logging and observability.
"""

import warnings

from aws_lambda_powertools import Logger, Metrics, Tracer

from shared.tracing import deferred_xray_provider

# Most API calls (every read) add no custom metric, so `log_metrics` warns on each
# invocation that there was nothing to publish. Expected here, never actionable, and it
# drowned real warnings in the logs: silenced by its exact message, the way Powertools
# documents (only this warning — any other stays visible).
EMPTY_METRICS_WARNING = 'No application metrics to publish'


def silence_empty_metrics_warning() -> None:
    warnings.filterwarnings('ignore', message=EMPTY_METRICS_WARNING, category=UserWarning)


silence_empty_metrics_warning()

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



