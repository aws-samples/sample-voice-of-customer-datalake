"""The leadership view's answer (``GET /metrics/adoption``; 7.70.00, docs/leadership-view.md): a scope's newest rollup
item (shared/adoption.py) read for a range of months, by month or by quarter, with the time-saved estimate worked out
from the scope's baselines at read time (so a baseline an admin changes applies at once, without a rebuild).

``from`` / ``to`` are months (``YYYY-MM``; a day ``YYYY-MM-DD`` is read as its month); the default is the last six
months to the current one (UTC), at most ``MAX_RANGE_MONTHS``; ``grain`` is ``month`` (default) or ``quarter`` (the
range widened to whole quarters). Each period, and the range's ``totals``, carries counts only: no person, no name, no
per-person figure anywhere (owner decision 11). A median merges the months' day histograms, so a quarter's or the
range's median is exact. ``time_saved_hours`` is an estimate and the answer says so beside it, with the baselines and
the assumptions it rests on (``time_saved``).
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping
from datetime import date
from typing import Any, Final

from shared.adoption import ARTIFACT_TYPES, baselines_of
from shared.adoption_rollup import COHORT_STEPS, CYCLES, month_of, months_between
from shared.decision_records import VERDICTS
from shared.dynamo_values import as_count
from shared.exceptions import ValidationError

__all__ = ['ASSUMPTIONS', 'ESTIMATE_LABEL', 'GRAINS', 'MAX_RANGE_MONTHS', 'AdoptionRange', 'adoption_view',
           'parse_range']

GRAINS: Final = ('month', 'quarter')
DEFAULT_MONTHS: Final = 6
#: The widest range one request reads (the rollup keeps two years: lambda/jobs/adoption_rollup/handler.py).
MAX_RANGE_MONTHS: Final = 24
ESTIMATE_LABEL: Final = 'Estimate, not a measurement: AI-made artifacts times the hours each would take by hand'
#: What the estimate assumes, each with its code (the web app words it) and its English text (MCP, the CSV).
ASSUMPTIONS: Final = (
    ('ai_made_only', ('Only artifacts the AI made count: generated, revised by the AI, or built by the prototype '
                     'builder. Hand-written artifacts, edits and restores save nothing.')),
    ('baseline_hours', ('Each AI-made artifact saves its baseline: the hours a person takes to make one by hand, as '
                       'an admin set them, else the default shown.')),
    ('review_not_subtracted', 'The time people spend reviewing and editing an AI draft is not subtracted.'),
    ('no_hours_for_the_rest', 'Decisions, validations, assistant conversations and agent runs add no hours.'),
    ('live_projects', 'Deleted projects are not counted. Figures are as of the last daily rollup.'),
)


class AdoptionRange:
    """The months a request reads (oldest first) and how they are grouped."""

    def __init__(self, months: list[str], grain: str) -> None:
        self.months = months
        self.grain = grain

    def periods(self) -> list[tuple[str, list[str]]]:
        """``(label, months)`` per period: each month, or each quarter (``YYYY-Qn``) of the range."""
        if self.grain == 'month':
            return [(month, [month]) for month in self.months]
        grouped: dict[str, list[str]] = {}
        for month in self.months:
            year, number = month.split('-')
            grouped.setdefault(f'{year}-Q{(int(number) - 1) // 3 + 1}', []).append(month)
        return list(grouped.items())


def _month(params: Mapping[str, Any], name: str) -> str | None:
    raw = params.get(name)
    if raw in (None, ''):
        return None
    text = str(raw)
    month = month_of(f'{text}-01') if len(text) == 7 else month_of(text) if len(text) == 10 else None
    if month is None:
        raise ValidationError(f'{name} must be a month (YYYY-MM) or a day (YYYY-MM-DD)')
    return month


def _shift(month: str, by: int) -> str:
    year, number = (int(part) for part in month.split('-'))
    index = year * 12 + number - 1 + by
    return f'{index // 12:04d}-{index % 12 + 1:02d}'


def _quarter_start(month: str) -> str:
    year, number = month.split('-')
    return f'{year}-{(int(number) - 1) // 3 * 3 + 1:02d}'


def parse_range(params: Mapping[str, Any], today: date) -> AdoptionRange:
    """``?from=&to=&grain=`` (see the module docstring); ValidationError (400) for a malformed or reversed range, one
    after the current month, or one wider than ``MAX_RANGE_MONTHS``."""
    grain = str(params.get('grain') or 'month')
    if grain not in GRAINS:
        raise ValidationError(f"grain must be one of: {', '.join(GRAINS)}")
    current = today.strftime('%Y-%m')
    last = _month(params, 'to') or current
    first = _month(params, 'from') or _shift(last, 1 - DEFAULT_MONTHS)
    if last > current:
        raise ValidationError('to must not be after the current month (UTC)')
    if first > last:
        raise ValidationError('from must not be after to')
    if grain == 'quarter':
        first = _quarter_start(first)
        last = min(_shift(_quarter_start(last), 2), current)
    months = months_between(first, last)
    if len(months) > MAX_RANGE_MONTHS:
        raise ValidationError(f'A range covers at most {MAX_RANGE_MONTHS} months')
    return AdoptionRange(months, grain)


def _counts(value: object) -> Counter[str]:
    """A stored map of counts as a Counter (anything else: empty)."""
    if not isinstance(value, Mapping):
        return Counter()
    return Counter({str(name): as_count(count) for name, count in value.items()})


def _map(value: object) -> Mapping[str, Any]:
    """A stored map, or an empty one for anything else."""
    return value if isinstance(value, Mapping) else {}


def _median(histogram: Counter[str]) -> float | None:
    """The median of a ``{days: count}`` histogram (the mean of the two middle values for an even count)."""
    values = sorted((int(days), count) for days, count in histogram.items() if days.isdigit() and count > 0)
    total = sum(count for _, count in values)
    if total == 0:
        return None
    wanted = sorted({(total - 1) // 2, total // 2})
    found: list[int] = []
    seen = 0
    for days, count in values:
        found.extend(days for index in wanted if seen <= index < seen + count)
        seen += count
    return round(sum(found) / len(found), 1)


def _merged(buckets: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Months' stored buckets summed into one (histograms merged)."""
    out: dict[str, Any] = {'projects_started': 0, 'with': Counter(), 'decisions': Counter(), 'validated_decisions': 0,
                           'validation_reports': 0, 'validation_runs': Counter(), 'assistant_conversations': 0,
                           'agent_runs': 0, 'artifacts': {kind: Counter() for kind in ARTIFACT_TYPES},
                           'cycle_days': {cycle: Counter() for cycle in CYCLES}}
    for bucket in buckets:
        for name in ('projects_started', 'validated_decisions', 'validation_reports', 'assistant_conversations',
                     'agent_runs'):
            out[name] += as_count(bucket.get(name))
        for name in ('with', 'decisions', 'validation_runs'):
            out[name].update(_counts(bucket.get(name)))
        artifacts = _map(bucket.get('artifacts'))
        cycles = _map(bucket.get('cycle_days'))
        for kind in ARTIFACT_TYPES:
            out['artifacts'][kind].update(_counts(artifacts.get(kind)))
        for cycle in CYCLES:
            out['cycle_days'][cycle].update(_counts(cycles.get(cycle)))
    return out


def _period_view(label: str, months: list[str], merged: Mapping[str, Any], hours: Mapping[str, float]) -> dict[str, Any]:
    started = merged['projects_started']
    with_steps = {step: merged['with'][step] for step in COHORT_STEPS}
    artifacts = {kind: {'ai': merged['artifacts'][kind]['ai'], 'human': merged['artifacts'][kind]['human']}
                 for kind in ARTIFACT_TYPES}
    decisions = {verdict: merged['decisions'][verdict] for verdict in VERDICTS}
    return {
        'period': label, 'months': months,
        'projects_started': started, 'with': with_steps,
        'prototype_rate': round(with_steps['prototype'] / started, 3) if started else None,
        'artifacts': artifacts,
        'decisions': {**decisions, 'total': sum(decisions.values())},
        'validated_decisions': merged['validated_decisions'],
        'validation_reports': merged['validation_reports'],
        'validation_runs': {'real': merged['validation_runs']['real'],
                            'synthetic': merged['validation_runs']['synthetic']},
        'cycle_days': {cycle: {'median': _median(merged['cycle_days'][cycle]),
                               'n': sum(merged['cycle_days'][cycle].values())} for cycle in CYCLES},
        'assistant_conversations': merged['assistant_conversations'],
        'agent_runs': merged['agent_runs'],
        'time_saved_hours': round(sum(artifacts[kind]['ai'] * hours[kind] for kind in ARTIFACT_TYPES), 1),
    }


def adoption_view(item: Mapping[str, Any] | None, settings_row: Mapping[str, Any], chosen: AdoptionRange, *,
                  scope: str) -> dict[str, Any]:
    """The answer for ``chosen`` from the scope's newest rollup ``item`` (None before the first rollup: every count 0,
    ``as_of`` null) and its baselines row."""
    item = item or {}
    stored = _map(item.get('months'))
    baselines = baselines_of(settings_row)
    hours = {kind: float(baselines[kind]['hours']) for kind in ARTIFACT_TYPES}

    def bucket(month: str) -> Mapping[str, Any]:
        return _map(stored.get(month))

    periods = [_period_view(label, months, _merged(bucket(m) for m in months), hours)
               for label, months in chosen.periods()]
    note = settings_row.get('note')
    updated_at = settings_row.get('updated_at')
    rolled_up_at = item.get('rolled_up_at')
    return {
        'scope': scope, 'grain': chosen.grain, 'from': chosen.months[0], 'to': chosen.months[-1],
        'as_of': rolled_up_at if isinstance(rolled_up_at, str) else None,
        'complete': item.get('complete') is not False,
        'covered_from': item.get('first_month') if isinstance(item.get('first_month'), str) else None,
        'agent_runs_counted': item.get('agent_runs_counted') is True,
        'periods': periods,
        'totals': _period_view('total', chosen.months, _merged(bucket(m) for m in chosen.months), hours),
        'time_saved': {
            'estimate': True, 'label': ESTIMATE_LABEL, 'unit': 'hours', 'baselines': baselines,
            'note': note if isinstance(note, str) and note else None,
            'updated_at': updated_at if isinstance(updated_at, str) else None,
            'assumptions': [{'code': code, 'text': text} for code, text in ASSUMPTIONS],
        },
    }
