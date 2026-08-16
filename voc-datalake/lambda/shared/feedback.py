"""
Shared feedback utilities for LLM context building and API queries.
Used by metrics API, projects API, research step handler, MCP handler,
and job Lambdas (document generator, document merger).
"""

import logging
import re
from datetime import datetime, timezone, timedelta

from boto3.dynamodb.conditions import Key

from shared.indexes import FEEDBACK_BY_CATEGORY_INDEX, FEEDBACK_BY_DATE_INDEX

logger = logging.getLogger(__name__)

# Date-basis values for time filtering. Defined here (the data layer) so job
# Lambdas and Step Functions handlers don't pull API-resolver machinery just
# for the constants; shared.api re-exports them for API handlers.
# 'imported': filter by when the item entered the data lake (processing date,
#             the `date` attribute backing gsi1-by-date) — historical default.
# 'review':   filter by when the customer originally wrote the feedback
#             (`source_created_at`), e.g. to exclude years-old reviews that
#             were only imported recently.
DATE_BASIS_IMPORTED = 'imported'
DATE_BASIS_REVIEW = 'review'
VALID_DATE_BASES = (DATE_BASIS_IMPORTED, DATE_BASIS_REVIEW)


def validate_date_basis(value: str | None) -> str:
    """Validate a ``date_basis`` value from any boundary (query param, job
    payload, Step Functions input).

    Returns 'imported' (default) or 'review'. Unknown or missing values fall
    back to 'imported' so older clients keep the existing behavior.
    """
    if isinstance(value, str) and value.strip().lower() in VALID_DATE_BASES:
        return value.strip().lower()
    return DATE_BASIS_IMPORTED

# Maximum number of days to look back when querying by date
MAX_LOOKBACK_DAYS = 90

# Hard ceiling on how many items a single partition (one date / one category)
# query will page through, so a huge backfill can't make one query run forever.
# DynamoDB returns up to 1MB per page; without LastEvaluatedKey paging we'd only
# ever see the first ~500 items of a partition (the "500개 중" truncation bug).
MAX_ITEMS_PER_PARTITION = 10000

# Shape guard for basis dates: a malformed source_created_at (e.g.
# "unavailable") would otherwise compare lexicographically above any
# YYYY-MM-DD cutoff.
_ISO_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

# --- LLM context budgeting (issue #231) --------------------------------------
# Lives here, next to format_feedback_for_llm, because the producer of the
# context string and every consumer that has to bound it must agree on one set
# of numbers. Before this, the persona path applied three independent caps
# (fetch limit, a 30 000-char slice in projects.py, and a 15 000-char slice in
# prompts.py) and reported none of them, so the narrowest one silently decided
# how much of the corpus the model actually saw.

# Each formatted record starts with this marker (see format_feedback_for_llm).
# Truncation cuts on it so the model never receives half a review, and the
# surviving records can be counted rather than estimated.
REVIEW_BLOCK_MARKER = '### Review '

# Rough Bedrock/Claude tokenisation for English prose. Only used to convert a
# model's advertised context window (quoted in tokens) into a character budget.
CHARS_PER_TOKEN = 4

# Tokens a persona/document generation chain spends on things that are NOT
# feedback content: the system prompts, the templated instructions wrapped
# around the feedback block, the {previous} text chained between steps, and
# each step's max_tokens output allowance. persona-generation.json needs ~3 K
# for templates and 16 K of combined output budget, so 40 K is better than 2x
# headroom.
CONTEXT_OVERHEAD_TOKENS = 40_000

# Fraction of the remaining window we are willing to fill with feedback. Kept
# well below 1.0 deliberately: prefill latency and input-token cost both scale
# linearly with the context, and CHARS_PER_TOKEN is an estimate that
# under-counts non-English text (where one character can exceed one token).
CONTEXT_UTILISATION = 0.5

# Per-field caps inside one formatted record. Every free-text field is clipped
# so FEEDBACK_CHARS_PER_ITEM_MAX below is a real upper bound and not an average:
# the enrichment fields are LLM-generated and unbounded upstream, so without
# these one verbose record could consume the budget of several and the item
# limit derived from the character budget would not hold.
MAX_ORIGINAL_TEXT_CHARS = 600
MAX_ENRICHMENT_FIELD_CHARS = 400
MAX_LABEL_CHARS = 60

# Upper bound on the characters format_feedback_for_llm emits per item, given
# the per-field caps above. Measured:
#   plain item (600-char original_text):                   ~820 chars
#   every optional field present and at its cap:         ~2 100 chars
# Pinned by TestFeedbackBudgetDerivation in shared/test/test_feedback.py — if
# the formatter grows a field, that test fails rather than letting the derived
# item limits quietly stop fitting the budget.
FEEDBACK_CHARS_PER_ITEM_MAX = 2_200

# Context window of every model in the allowlist (shared/model_config.py).
# Used as the fallback when the resolved model is unknown; callers that can
# resolve a surface should pass that model's real window instead.
DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000


def feedback_char_budget(
    window_tokens: int = DEFAULT_CONTEXT_WINDOW_TOKENS,
    overhead_tokens: int = CONTEXT_OVERHEAD_TOKENS,
    utilisation: float = CONTEXT_UTILISATION,
) -> int:
    """Characters of formatted feedback that fit in a model's context window.

    Derived rather than hardcoded so the budget follows the model instead of
    assuming one: ``shared.model_config`` resolves the model per surface at
    runtime, so a literal tuned for a 200 K-token window would silently
    overflow a smaller one (a hard Bedrock ValidationException, which is worse
    than the truncation it replaced).

    Args:
        window_tokens: The resolved model's context window, in tokens.
        overhead_tokens: Tokens reserved for prompts, chaining, and output.
        utilisation: Fraction of the remainder to fill with feedback.

    Returns:
        A character budget, never negative.
    """
    usable_tokens = max(window_tokens - overhead_tokens, 0)
    return int(usable_tokens * utilisation) * CHARS_PER_TOKEN


def feedback_item_limit(char_budget: int) -> int:
    """How many items to fetch so a full corpus fits inside ``char_budget``.

    Derived from the measured worst case per item so the character budget acts
    as a backstop for unusually long records, not as the operative limit. When
    the two are set independently they drift: a 500-item limit against a
    200 000-char budget truncated away more than half of every full corpus, on
    the default path, while reporting nothing.
    """
    return max(char_budget // FEEDBACK_CHARS_PER_ITEM_MAX, 1)


def _clip(value, max_chars: int = MAX_ENRICHMENT_FIELD_CHARS) -> str:
    """Coerce to str and clip to ``max_chars``, marking a clip with an ellipsis.

    Guards the per-item size bound the derived item limits rest on. Tolerates
    None and non-string values because these fields come from DynamoDB items
    whose enrichment may be absent or, after a partial write, the wrong type.
    """
    if value is None:
        return ''
    text = value if isinstance(value, str) else str(value)
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + '…'


def count_feedback_records(context: str) -> int:
    """Number of complete formatted feedback records in ``context``."""
    return context.count(REVIEW_BLOCK_MARKER)


def truncate_feedback_context(context: str, max_chars: int) -> tuple[str, int, bool]:
    """Trim a formatted feedback block to ``max_chars`` on a record boundary.

    Cutting at an arbitrary character offset hands the model a partial
    record — an unterminated ``- Full Text: "…``, or a ``- Sentiment:`` label
    with no value — which it may reason from as if it were real data. So walk
    back to the last complete record instead, and report how many survived so
    callers can say what the model actually saw rather than what was fetched.

    Args:
        context: Output of :func:`format_feedback_for_llm`.
        max_chars: Character budget. Non-positive means "no limit".

    Returns:
        ``(context, records_used, truncated)``.
    """
    if max_chars <= 0 or len(context) <= max_chars:
        return context, count_feedback_records(context), False

    head = context[:max_chars]
    # Drop the trailing partial record. rfind on the newline-prefixed marker so
    # a marker at offset 0 (the whole budget is one record) is not mistaken for
    # a boundary and truncated to nothing.
    cut = head.rfind('\n' + REVIEW_BLOCK_MARKER)
    if cut > 0:
        head = head[:cut]
    records_used = count_feedback_records(head)
    return (
        head + '\n\n[... additional feedback truncated ...]',
        records_used,
        True,
    )


def basis_date(item: dict, date_basis: str) -> str:
    """Return the YYYY-MM-DD date used to filter/bucket an item.

    'imported' uses the processing date (`date`, mirrors gsi1-by-date).
    'review' uses the date the customer wrote the feedback
    (`source_created_at`), falling back to the import date for items whose
    source date is missing or malformed.

    Note: source_created_at is the source-local date while cutoffs are UTC,
    so items written just before/after local midnight can shift by one day
    at window edges. Accepted at date granularity.
    """
    if date_basis == DATE_BASIS_REVIEW:
        source_created = (item.get('source_created_at') or '')[:10]
        if _ISO_DATE_RE.match(source_created):
            return source_created
    return item.get('date', '')


def window_cutoff(days: int) -> str:
    """Oldest YYYY-MM-DD covered by an N-day window ending today (UTC)."""
    now = datetime.now(timezone.utc)
    return (now - timedelta(days=days - 1)).strftime('%Y-%m-%d')


def _query_all_pages(feedback_table, *, index_name, key_expr, max_items):
    """Query a GSI partition, following LastEvaluatedKey until exhausted or
    `max_items` collected. DynamoDB caps each page at 1MB, so a single query()
    only returns a slice of a large partition — this pages through the rest."""
    collected: list[dict] = []
    last_key = None
    while True:
        kwargs = {
            'IndexName': index_name,
            'KeyConditionExpression': key_expr,
            'ScanIndexForward': False,
        }
        if last_key:
            kwargs['ExclusiveStartKey'] = last_key
        response = feedback_table.query(**kwargs)
        collected.extend(response.get('Items', []))
        last_key = response.get('LastEvaluatedKey')
        if not last_key or len(collected) >= max_items:
            break
    return collected[:max_items]


def _fetch_and_filter(
    feedback_table,
    days: int,
    sources: list[str],
    categories: list[str],
    sentiments: list[str],
    fetch_ceiling: int,
    per_day_limit: int,  # deprecated: superseded by LastEvaluatedKey paging
    date_basis: str = DATE_BASIS_IMPORTED,
) -> list[dict]:
    """Internal: fetch items from DynamoDB and apply in-memory filters.

    Args:
        fetch_ceiling: When no post-filters are active, stop querying
            once we have this many raw items (early-break optimisation).
            Pass 0 to disable early break (scan all dates).
        date_basis: Which date the `days` window applies to. 'imported'
            (default) keeps the raw import window; 'review' post-filters it
            down to items actually written within the window — a review can
            never be imported before it was written, so the import window
            always contains the review window (no extra GSI needed).
    """
    has_post_filters = bool(sources or sentiments) or date_basis == DATE_BASIS_REVIEW
    items: list[dict] = []
    current_date = datetime.now(timezone.utc)

    # Per-partition page cap: honour fetch_ceiling when set (early-break path),
    # otherwise page through the whole partition up to a safety ceiling so we
    # don't truncate days/categories that hold more than one DynamoDB page.
    page_cap = fetch_ceiling if fetch_ceiling else MAX_ITEMS_PER_PARTITION

    if categories and not sources:
        for category in categories:
            items.extend(_query_all_pages(
                feedback_table,
                index_name=FEEDBACK_BY_CATEGORY_INDEX,
                key_expr=Key('gsi2pk').eq(f'CATEGORY#{category}'),
                max_items=page_cap,
            ))
        cutoff_date = window_cutoff(days)
        items = [i for i in items if basis_date(i, date_basis) >= cutoff_date]
    else:
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            items.extend(_query_all_pages(
                feedback_table,
                index_name=FEEDBACK_BY_DATE_INDEX,
                key_expr=Key('gsi1pk').eq(f'DATE#{date}'),
                max_items=page_cap,
            ))
            if not has_post_filters and fetch_ceiling and len(items) >= fetch_ceiling:
                break
        if date_basis == DATE_BASIS_REVIEW:
            cutoff_date = window_cutoff(days)
            items = [i for i in items if basis_date(i, date_basis) >= cutoff_date]

    if sources:
        items = [i for i in items if i.get('source_platform') in sources]
    if sentiments:
        items = [i for i in items if i.get('sentiment_label') in sentiments]
    if categories and sources:
        items = [i for i in items if i.get('category') in categories]

    return items


def query_feedback_by_date(
    feedback_table,
    days: int = 30,
    sources: list[str] | None = None,
    categories: list[str] | None = None,
    sentiments: list[str] | None = None,
    limit: int = 500,
    offset: int = 0,
    per_day_limit: int = 500,
    date_basis: str = DATE_BASIS_IMPORTED,
) -> list[dict]:
    """Query feedback items by date range with optional filters.

    This is the single source of truth for date-based feedback queries.
    All handlers should use this instead of reimplementing the date loop.

    Args:
        feedback_table: DynamoDB Table resource for feedback.
        days: Number of days to look back from today.
        sources: Optional list of source_platform values to keep.
        categories: Optional list of category values to keep.
            When set *without* sources, queries GSI2 by category instead.
        sentiments: Optional list of sentiment_label values to keep.
        limit: Maximum number of items to return after filtering.
        offset: Number of items to skip (for pagination).
        per_day_limit: Deprecated — retained for call-site compatibility.
            Partition reads now page through LastEvaluatedKey and are bounded
            by fetch_ceiling / MAX_ITEMS_PER_PARTITION instead.
        date_basis: 'imported' (default) windows by ingestion date;
            'review' windows by the date the customer wrote the feedback
            (source_created_at, import-date fallback).

    Returns:
        Filtered list of feedback items, sliced by offset/limit.
    """
    if not feedback_table:
        logger.warning("No feedback table provided, returning empty list")
        return []

    target = offset + limit
    items = _fetch_and_filter(
        feedback_table,
        days=min(days, MAX_LOOKBACK_DAYS),
        sources=sources or [],
        categories=categories or [],
        sentiments=sentiments or [],
        fetch_ceiling=target * 3,
        per_day_limit=per_day_limit,
        date_basis=date_basis or DATE_BASIS_IMPORTED,
    )
    return items[offset:offset + limit]


def query_feedback_page(
    feedback_table,
    days: int = 30,
    sources: list[str] | None = None,
    categories: list[str] | None = None,
    sentiments: list[str] | None = None,
    limit: int = 100,
    offset: int = 0,
    per_day_limit: int = 500,
    date_basis: str = DATE_BASIS_IMPORTED,
) -> tuple[list[dict], int]:
    """Query a page of feedback items and return the total count.

    Same as :func:`query_feedback_by_date` but scans all matching dates
    to return an accurate total count for pagination.

    Returns:
        Tuple of (page_items, total_count).
    """
    if not feedback_table:
        return [], 0

    # fetch_ceiling=0 disables early break so we get the true total
    items = _fetch_and_filter(
        feedback_table,
        days=min(days, MAX_LOOKBACK_DAYS),
        sources=sources or [],
        categories=categories or [],
        sentiments=sentiments or [],
        fetch_ceiling=0,
        per_day_limit=per_day_limit,
        date_basis=date_basis or DATE_BASIS_IMPORTED,
    )
    total = len(items)
    page = items[offset:offset + limit]
    return page, total


def get_feedback_context(feedback_table, filters: dict, limit: int = 50) -> list[dict]:
    """Get feedback items based on filters for LLM context.

    Thin wrapper around :func:`query_feedback_by_date` that unpacks a
    filters dict.  Kept for backward compatibility with callers that pass
    a dict (research handler, projects API, persona generator).

    Args:
        feedback_table: DynamoDB Table resource for feedback
        filters: Dict with keys: days, categories, sentiments, sources,
            date_basis ('imported' default | 'review')
        limit: Maximum number of items to return

    Returns:
        List of feedback items matching filters
    """
    return query_feedback_by_date(
        feedback_table,
        days=filters.get('days', 30),
        sources=filters.get('sources'),
        categories=filters.get('categories'),
        sentiments=filters.get('sentiments'),
        limit=limit,
        date_basis=filters.get('date_basis') or DATE_BASIS_IMPORTED,
    )
def format_feedback_for_llm(items: list[dict]) -> str:
    """Format feedback items for LLM context with rich details.
    
    Args:
        items: List of feedback items from DynamoDB
        
    Returns:
        Formatted string for LLM context
    """
    lines = []
    for i, item in enumerate(items, 1):
        # Build optional fields. These are LLM-generated (see the enrichment
        # prompt in lambda/processor/handler.py), so their length is not bounded
        # by anything upstream — one verbose record could otherwise consume the
        # budget of several. Capped here so FEEDBACK_CHARS_PER_ITEM_MAX is a
        # real bound rather than an average, which is what lets the item limit
        # be derived from the character budget instead of guessed alongside it.
        quote = _clip(item.get('direct_customer_quote', ''))
        root_cause = _clip(item.get('problem_root_cause_hypothesis', ''))
        problem_summary = _clip(item.get('problem_summary', ''))
        persona_type = _clip(item.get('persona_type', ''), MAX_LABEL_CHARS)
        journey_stage = _clip(item.get('journey_stage', ''), MAX_LABEL_CHARS)

        lines.append(f"""
### Review {i}
- Source: {_clip(item.get('source_platform', 'unknown'), MAX_LABEL_CHARS)}
- Date: {item.get('source_created_at', '')[:10] if item.get('source_created_at') else 'N/A'}
- Sentiment: {_clip(item.get('sentiment_label', 'unknown'), MAX_LABEL_CHARS)} (score: {float(item.get('sentiment_score', 0)):.2f})
- Category: {_clip(item.get('category', 'other'), MAX_LABEL_CHARS)}
- Rating: {item.get('rating', 'N/A')}/5
- Urgency: {_clip(item.get('urgency', 'low'), MAX_LABEL_CHARS)}
- Customer Type: {persona_type if persona_type else 'unknown'}
- Journey Stage: {journey_stage if journey_stage else 'unknown'}
- Full Text: "{item.get('original_text', '')[:MAX_ORIGINAL_TEXT_CHARS]}"
{f'- Key Quote: "{quote}"' if quote else ''}
{f'- Problem Summary: {problem_summary}' if problem_summary else ''}
{f'- Root Cause Hypothesis: {root_cause}' if root_cause else ''}
""")
    return '\n'.join(lines)
def get_feedback_statistics(items: list[dict]) -> str:
    """Generate summary statistics from feedback items.
    
    Args:
        items: List of feedback items from DynamoDB
        
    Returns:
        Formatted statistics string for LLM context
    """
    if not items:
        return "No feedback data available."
    
    # Count by sentiment
    sentiments = {}
    categories = {}
    sources = {}
    urgency_counts = {'high': 0, 'medium': 0, 'low': 0}
    ratings = []
    
    for item in items:
        sent = item.get('sentiment_label', 'unknown')
        sentiments[sent] = sentiments.get(sent, 0) + 1
        
        cat = item.get('category', 'other')
        categories[cat] = categories.get(cat, 0) + 1
        
        src = item.get('source_platform', 'unknown')
        sources[src] = sources.get(src, 0) + 1
        
        urg = item.get('urgency', 'low')
        if urg in urgency_counts:
            urgency_counts[urg] += 1
        
        if item.get('rating'):
            ratings.append(float(item['rating']))
    
    avg_rating = sum(ratings) / len(ratings) if ratings else 0
    
    stats = f"""## Feedback Statistics (n={len(items)})

**Sentiment Distribution:**
{chr(10).join([f"- {k}: {v} ({v/len(items)*100:.1f}%)" for k, v in sorted(sentiments.items(), key=lambda x: x[1], reverse=True)])}

**Top Categories:**
{chr(10).join([f"- {k}: {v}" for k, v in sorted(categories.items(), key=lambda x: x[1], reverse=True)[:5]])}

**Sources:**
{chr(10).join([f"- {k}: {v}" for k, v in sorted(sources.items(), key=lambda x: x[1], reverse=True)])}

**Urgency Levels:**
- High: {urgency_counts['high']} | Medium: {urgency_counts['medium']} | Low: {urgency_counts['low']}

**Average Rating:** {avg_rating:.1f}/5 (from {len(ratings)} rated reviews)
"""
    return stats
