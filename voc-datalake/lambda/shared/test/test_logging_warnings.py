"""`shared.logging` silences ONLY Powertools' "no application metrics" warning.

Every read API emitted it on each invocation, drowning real warnings in the logs.
"""
import warnings
from collections.abc import Callable

from aws_lambda_powertools import Metrics

from shared.logging import metrics as shared_metrics
from shared.logging import silence_empty_metrics_warning


def _empty_metrics() -> Metrics:
    """A Metrics with nothing to publish.

    Powertools shares the metric store across every Metrics instance in the process, so metrics
    another test added on this worker would otherwise be flushed here and suppress the warning.
    """
    metrics = Metrics(namespace='VoC-Test', service='t')
    metrics.clear_metrics()
    return metrics


def _warnings_of(action: Callable[[], object]) -> list[str]:
    """Messages *action* warns, with the module's filter installed over a clean filter list."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('default')
        silence_empty_metrics_warning()
        action()
    return [str(w.message) for w in caught]


def test_an_invocation_with_no_metrics_does_not_warn():
    assert _warnings_of(_empty_metrics().flush_metrics) == []


def test_any_other_user_warning_stays_visible():
    assert _warnings_of(lambda: warnings.warn('something else', UserWarning, stacklevel=1)) == ['something else']


def test_without_the_filter_powertools_does_warn():
    """The control: the message the filter matches is the one Powertools emits."""
    metrics = _empty_metrics()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('default')
        metrics.flush_metrics()
    assert [str(w.message).startswith('No application metrics to publish') for w in caught] == [True]


def _invoke(add_metric: bool) -> list[str]:
    """One invocation of a `@metrics.log_metrics` handler on the shared instance, warnings recorded.

    Only the filter `shared.logging` installs at import is in force: no explicit
    `silence_empty_metrics_warning()` call, the way a deployed handler runs.
    """
    shared_metrics.clear_metrics()

    @shared_metrics.log_metrics(capture_cold_start_metric=False)
    def handler(_event: dict, _context: object) -> str:
        if add_metric:
            shared_metrics.add_metric(name='Probe', unit='Count', value=1)
        return 'ok'

    with warnings.catch_warnings(record=True) as caught:
        handler({}, None)
    return [str(w.message) for w in caught]


def test_a_handler_invocation_with_no_metric_emits_no_user_warning():
    assert _invoke(add_metric=False) == []


def test_a_real_metric_is_still_published(capsys):
    """The control: the filter hides only the empty-flush notice, never an emitted metric."""
    assert _invoke(add_metric=True) == []
    assert '"Probe"' in capsys.readouterr().out
