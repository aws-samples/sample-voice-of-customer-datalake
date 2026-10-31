"""The daily metric partitions of voc-aggregates: the aggregator writes them, the readers query them.

Declared once because the writer (``aggregator/handler.py``) and its readers (``api/metrics_handler.py``,
``agents/heartbeat``, ``briefing``) are separate Lambda bundles; each used to spell the prefixes itself. A row
is ``pk = <PREFIX><value>``, ``sk = <YYYY-MM-DD>``; the ``metric_type`` index carries ``<type>#<key>`` for the
breakdowns ``/metrics/*`` read by type (``dim_sentiment#<key>``, tags, channels).
"""
from typing import Final

DAILY_TOTAL_PK: Final = 'METRIC#daily_total'
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
