"""
Per-release and per-label breakdown of GitHub Issues feedback (``GET /metrics/github``).

Pure functions over feedback items the metrics handler has already windowed and
filtered by the caller's category access, so this module never decides who sees
what. Every GitHub field is read from the item's ``issue_attributes`` map, which
the github_issues plugin computes deterministically (``plugins/_shared/github_text.py``):
``software_version``, ``labels``, ``error_signature``, ``component``, ``plus_one``.

"New since last version" compares the LATEST release in the window with every
earlier one: an error signature, category or component that appears in the latest
release and in no earlier release in the window is new. With a single release in
the window there is nothing to compare against, so nothing is reported as new.
"""

from collections import Counter, defaultdict
from collections.abc import Iterable
from typing import Any

GITHUB_SOURCE = 'github_issues'
MAX_VERSIONS = 15
MAX_LABELS = 20
TOP_N = 3
NEW_N = 10


def issue_attributes(item: dict) -> dict:
    """The item's ``issue_attributes`` map, or ``{}`` (any other source, or a legacy row)."""
    value = item.get('issue_attributes')
    return value if isinstance(value, dict) else {}


def item_version(item: dict) -> str | None:
    version = issue_attributes(item).get('software_version')
    return version if isinstance(version, str) and version else None


def item_labels(item: dict) -> list[str]:
    labels = issue_attributes(item).get('labels')
    return [label for label in labels if isinstance(label, str)] if isinstance(labels, list) else []


def version_sort_key(version: str) -> tuple:
    """Numeric release order, a pre-release before its release (``1.0.0-rc.1 < 1.0.0``)."""
    core, _, pre = version.partition('-')
    parts = [int(p) if p.isdigit() else 0 for p in core.split('.')][:3]
    parts += [0] * (3 - len(parts))
    return (*parts, 0 if pre else 1, pre)


def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _weight(item: dict) -> int:
    """One report plus its 👍 reactions — how many people this item speaks for."""
    return 1 + int(_number(issue_attributes(item).get('plus_one'), 0))


def _ranked(counter: Counter, limit: int) -> list[dict]:
    return [{'name': name, 'count': count} for name, count in counter.most_common(limit)]


def _stats(items: list[dict]) -> dict:
    scores = [_number(i['sentiment_score']) for i in items if i.get('sentiment_score') is not None]
    return {
        'count': len(items),
        'weight': sum(_weight(i) for i in items),
        'avg_sentiment': round(sum(scores) / len(scores), 3) if scores else None,
        'negative': sum(1 for i in items if i.get('sentiment_label') == 'negative'),
    }


def _field_counter(items: Iterable[dict], field: str) -> Counter:
    return Counter(
        value for value in (issue_attributes(i).get(field) for i in items)
        if isinstance(value, str) and value
    )


def _version_row(version: str, items: list[dict]) -> dict:
    complaints = Counter(i.get('category') or 'other' for i in items if i.get('sentiment_label') == 'negative')
    return {
        'version': version,
        **_stats(items),
        'issues': sum(1 for i in items if issue_attributes(i).get('kind') == 'issue'),
        'comments': sum(1 for i in items if issue_attributes(i).get('kind') == 'comment'),
        'top_complaints': _ranked(complaints, TOP_N),
        'top_errors': _ranked(_field_counter(items, 'error_signature'), TOP_N),
    }


def _label_rows(items: list[dict]) -> list[dict]:
    by_label: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        for label in item_labels(item):
            by_label[label].append(item)
    rows = [
        {'label': label, **_stats(members),
         'open': sum(1 for i in members if issue_attributes(i).get('state') == 'open')}
        for label, members in by_label.items()
    ]
    rows.sort(key=lambda row: (-row['count'], row['label']))
    return rows[:MAX_LABELS]


def _new_in_latest(by_version: dict[str, list[dict]], ordered: list[str]) -> dict:
    empty = {'errors': [], 'categories': [], 'components': []}
    if len(ordered) < 2:
        return empty
    latest_items = by_version[ordered[-1]]
    earlier = [i for v in ordered[:-1] for i in by_version[v]]

    def new(counter_of) -> list[dict]:
        seen_before = set(counter_of(earlier))
        latest = counter_of(latest_items)
        fresh = Counter({name: n for name, n in latest.items() if name not in seen_before})
        return _ranked(fresh, NEW_N)

    return {
        'errors': new(lambda items: _field_counter(items, 'error_signature')),
        'categories': new(lambda items: Counter(i.get('category') or 'other' for i in items)),
        'components': new(lambda items: _field_counter(items, 'component')),
    }


def github_breakdown(items: list[dict]) -> dict:
    """The ``/metrics/github`` body (minus the window/partial fields the route adds)."""
    by_version: dict[str, list[dict]] = defaultdict(list)
    unversioned: list[dict] = []
    for item in items:
        version = item_version(item)
        if version:
            by_version[version].append(item)
        else:
            unversioned.append(item)
    ordered = sorted(by_version, key=version_sort_key)[-MAX_VERSIONS:]
    return {
        'total': len(items),
        'repos': sorted({r for r in (issue_attributes(i).get('repo') for i in items) if isinstance(r, str)}),
        'versions': [_version_row(v, by_version[v]) for v in ordered],
        'unversioned': _stats(unversioned),
        'labels': _label_rows(items),
        'latest_version': ordered[-1] if ordered else None,
        'previous_version': ordered[-2] if len(ordered) > 1 else None,
        'new_in_latest': _new_in_latest(by_version, ordered),
    }


def matches_issue_filters(item: dict, version: str | None, label: str | None) -> bool:
    """The ``version`` / ``label`` query filters of ``/feedback`` (case-insensitive label)."""
    if version and item_version(item) != version.removeprefix('v'):
        return False
    return not (label and label.lower() not in (lab.lower() for lab in item_labels(item)))
