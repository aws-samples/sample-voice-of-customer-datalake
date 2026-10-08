"""Read Powertools EMF output back in Lambda handler tests (lambda/ and plugins/ alike)."""
from __future__ import annotations

import json
from collections.abc import Callable

import pytest
from aws_lambda_powertools import Metrics
from aws_lambda_powertools.metrics.provider.cold_start import reset_cold_start_flag


def emf_metric_names(stdout: str) -> set[str]:
    """Every metric name declared by the EMF documents printed to *stdout*.

    Lines that are not JSON objects (ordinary log output) are skipped.
    """
    names: set[str] = set()
    for line in stdout.splitlines():
        if not line.startswith('{'):
            continue
        doc = json.loads(line)
        for family in doc.get('_aws', {}).get('CloudWatchMetrics', []):
            names.update(m['Name'] for m in family.get('Metrics', []))
    return names


def cold_start_metric_names(metrics: Metrics, invoke: Callable[[], object], capsys: pytest.CaptureFixture[str]) -> set[str]:
    """The metric names *invoke* flushes as EMF when it is the FIRST call after a cold start.

    *metrics* is the handler's `Metrics` instance: it is emptied before the call, so
    nothing an earlier test added is counted, and emptied again after it (even when
    the call raises), so nothing this call added leaks into the tests that follow.
    """
    metrics.clear_metrics()
    reset_cold_start_flag()
    try:
        invoke()
    finally:
        out = capsys.readouterr().out
        metrics.clear_metrics()
    return emf_metric_names(out)
