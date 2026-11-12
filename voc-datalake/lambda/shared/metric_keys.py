"""The daily metric partitions of voc-aggregates: the aggregator writes them, the readers query them.

Declared once because the writer (``aggregator/handler.py``) and its readers (``api/metrics_handler.py``,
``agents/heartbeat``, ``briefing``) are separate Lambda bundles; each used to spell the prefixes itself. A row
is ``pk = <PREFIX><value>``, ``sk = <YYYY-MM-DD>``; the ``metric_type`` index carries ``<type>#<key>`` for the
breakdowns ``/metrics/*`` read by type (``dim_sentiment#<key>``, tags, channels).

These are the deployment-wide spellings. A workspace's counters (docs/multi-workspace.md) are the same rows under
``WS#{ws}#METRIC#…`` with ``metric_type`` ``WS#{ws}#<type>``: ``metric_partition`` and ``metric_type_partition``
turn one into the other through shared/ws_repo.py (``metric_pk``, ``metric_type``), so the writer and the readers
build both from one name.
"""
from collections.abc import Iterator, Mapping
from typing import Final

from shared.ws_repo import WorkspaceScope, metric_pk, metric_type

#: How every deployment-wide counter partition starts (the workspace's starts ``WS#{ws}#`` before it).
METRIC_PARTITION_PREFIX: Final = 'METRIC#'
DAILY_TOTAL_PK: Final = 'METRIC#daily_total'
#: The high-urgency daily count (alerts, ``/metrics/summary``'s ``urgent_count``).
URGENT_PK: Final = 'METRIC#urgent'
SENTIMENT_AVG_PK: Final = 'METRIC#daily_sentiment_avg'
SOURCE_PREFIX: Final = 'METRIC#daily_source#'
CATEGORY_PREFIX: Final = 'METRIC#daily_category#'
SUBCATEGORY_PREFIX: Final = 'METRIC#daily_subcategory#'
SENTIMENT_PREFIX: Final = 'METRIC#daily_sentiment#'
DIMENSION_PREFIX: Final = 'METRIC#daily_dim#'
DIMENSION_SENTIMENT_PREFIX: Final = 'METRIC#daily_dim_sentiment#'
DIMENSION_SENTIMENT_METRIC_TYPE: Final = 'dim_sentiment#'
TAG_PREFIX: Final = 'METRIC#daily_tag#'
CHANNEL_PREFIX: Final = 'METRIC#daily_channel#'
# ``METRIC#daily_usefulness#<source_platform>#<band>`` (``shared.usefulness`` bands; unrated items
# have no row: a reader takes them as the source's ``SOURCE_PREFIX`` total minus its banded rows).
USEFULNESS_PREFIX: Final = 'METRIC#daily_usefulness#'
USEFULNESS_METRIC_TYPE: Final = 'usefulness'
# The per-source profile (``shared.source_profile``): ``<PREFIX><source_platform>#<value>`` per facet, one
# metric type each so a window's read stays one small index query per facet. Days before the counters
# existed have no row: a reader takes the source total minus the rating rows as "not profiled".
PROFILE_RATING_PREFIX: Final = 'METRIC#daily_profile_rating#'
PROFILE_SENTIMENT_PREFIX: Final = 'METRIC#daily_profile_sentiment#'
PROFILE_LENGTH_PREFIX: Final = 'METRIC#daily_profile_length#'
PROFILE_METRIC_TYPES: Final = {
    PROFILE_RATING_PREFIX: 'profile_rating',
    PROFILE_SENTIMENT_PREFIX: 'profile_sentiment',
    PROFILE_LENGTH_PREFIX: 'profile_length',
}


def metric_partition(scope: WorkspaceScope | None, pk: str) -> str:
    """The counter partition ``pk`` (a deployment-wide ``METRIC#…``) names: itself deployment-wide (``scope``
    None, unchanged), ``WS#{ws}#METRIC#…`` in a workspace (ValueError there for a ``pk`` that is not a counter
    partition: nothing outside ``METRIC#`` is moved under a workspace by accident)."""
    if scope is None:
        return pk
    name = pk.removeprefix(METRIC_PARTITION_PREFIX)
    if name == pk or not name:
        raise ValueError('not a counter partition')
    return metric_pk(scope, name)


def metric_type_partition(scope: WorkspaceScope | None, kind: str) -> str:
    """The ``metric_type`` index partition of ``kind``: itself deployment-wide, ``WS#{ws}#{kind}`` in a workspace."""
    return kind if scope is None else metric_type(scope, kind)


def source_keyed_counts(counts: Mapping[str, int]) -> Iterator[tuple[str, str, int]]:
    """``(source, value, count)`` for every ``<source>#<value>`` counter key.

    The value is the LAST ``#`` segment, so a source name containing ``#`` still parses; a key
    with no source part is skipped. The caller decides which values it knows.
    """
    for key, count in counts.items():
        source, _, value = key.rpartition('#')
        if source:
            yield source, value, int(count)
