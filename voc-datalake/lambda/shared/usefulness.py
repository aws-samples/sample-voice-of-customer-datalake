"""The ``usefulness`` band of a review: how much a reader (or a model) can learn from it.

A deterministic HEURISTIC, computed by the processor from the text and the enrichment it
already has (no extra model call), and stored as the top-level ``usefulness`` attribute:
``low`` | ``medium`` | ``high``. An ordinal band on purpose, not a score: the inputs are
rough, and a number such as 0.73 would claim a precision the heuristic does not have.

What raises a review's band (each signal is one point):

* length: at least ``DETAILED_WORDS`` words, and one more point at ``LONG_WORDS``;
* a number (a date, a version, an amount, an order or flight number);
* a concrete product term (``SPECIFIC_TERMS``: crash, refund, login, checkout, ...);
* a concrete issue or request: the built-in ``feedback_type`` is a problem, request or
  question, or (no type yet) the enrichment wrote a ``problem_summary``.

A review is ``low`` whatever its points when it is near-empty (under ``MIN_WORDS`` words or
``MIN_CHARS`` characters) or boilerplate (``BOILERPLATE``: "Great!", "ok", "n/a", ...).
Otherwise ``HIGH_POINTS`` or more points is ``high``, ``MEDIUM_POINTS`` or more ``medium``.

The English cue words read ``normalized_text`` (the translation) when the review has one.
A review stored without the attribute (written before this existed) is ``unrated``
everywhere (``stored_band``); a category reprocess fills it in (docs/data-quality.md).

Imports only ``shared.feedback_types`` (which imports nothing): the processor, the aggregator,
the reprocess worker and the metrics Lambda all bundle it.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Final

from shared.feedback_types import FEEDBACK_TYPE_KEY

__all__ = [
    'BAND_RANK',
    'USEFULNESS_BANDS',
    'USEFULNESS_FIELD',
    'USEFULNESS_UNRATED',
    'item_usefulness',
    'stored_band',
    'usefulness_band',
]

USEFULNESS_FIELD: Final = 'usefulness'
LOW: Final = 'low'
MEDIUM: Final = 'medium'
HIGH: Final = 'high'
#: The stored values, lowest first.
USEFULNESS_BANDS: Final = (LOW, MEDIUM, HIGH)
#: What a review without a (valid) stored band counts as. Never stored.
USEFULNESS_UNRATED: Final = 'unrated'
#: Sort rank, best first (lower = better): the LLM-context tiebreaker's order.
BAND_RANK: Final = {HIGH: 0, MEDIUM: 1, LOW: 2, USEFULNESS_UNRATED: 3}

# Below either of these a review is near-empty: always low.
MIN_WORDS: Final = 3
MIN_CHARS: Final = 12
# Length points.
DETAILED_WORDS: Final = 15
LONG_WORDS: Final = 50
# Band thresholds on the points.
MEDIUM_POINTS: Final = 1
HIGH_POINTS: Final = 3

#: Whole texts (lower-cased, letters and spaces only) that say nothing to act on.
BOILERPLATE: Final = frozenset({
    'great', 'good', 'ok', 'okay', 'fine', 'nice', 'cool', 'bad', 'awful', 'terrible', 'excellent',
    'awesome', 'perfect', 'amazing', 'love it', 'i love it', 'love this app', 'thanks', 'thank you',
    'na', 'n a', 'none', 'nothing', 'no comment', 'no comments', 'test', 'testing', 'asdf', 'good app',
    'great app', 'nice app', 'bad app', 'very good', 'very bad', 'good service', 'great service',
    'all good', 'works fine', 'works great', 'five stars', 'one star',
})

#: Concrete product / service terms (prefixes: ``crash`` matches crashes, crashed, ...).
SPECIFIC_TERMS: Final = (
    'crash', 'error', 'bug', 'freez', 'button', 'screen', 'page', 'login', 'log in', 'sign in',
    'password', 'account', 'order', 'payment', 'charge', 'refund', 'invoice', 'receipt',
    'deliver', 'shipping', 'checkout', 'cart', 'subscription', 'notification', 'update', 'version',
    'setting', 'feature', 'search', 'upload', 'download', 'sync', 'booking', 'flight', 'seat',
    'baggage', 'luggage', 'ticket', 'support', 'agent', 'wait', 'delay', 'cancel',
)
_TERMS_RE: Final = re.compile(r'\b(?:' + '|'.join(re.escape(term) for term in SPECIFIC_TERMS) + ')')
_WORD_RE: Final = re.compile(r'\w+')
_NUMBER_RE: Final = re.compile(r'\d')
_NOT_LETTER_RE: Final = re.compile(r'[^a-z ]+')

#: Built-in ``feedback_type`` values that name a concrete issue, request or question.
CONCRETE_TYPES: Final = frozenset({
    'bug', 'service_failure', 'feature_request', 'usability', 'performance',
    'pricing_billing', 'support_experience', 'question',
})


def _boilerplate(text: str) -> bool:
    letters = ' '.join(_NOT_LETTER_RE.sub(' ', text.lower()).split())
    return letters in BOILERPLATE


def _concrete(problem_summary: object, feedback_type: object) -> bool:
    if isinstance(feedback_type, str) and feedback_type:
        return feedback_type in CONCRETE_TYPES
    return isinstance(problem_summary, str) and bool(problem_summary.strip())


def _points(text: str, words: int, concrete: bool) -> int:
    lowered = text.lower()
    signals = (
        words >= DETAILED_WORDS,
        words >= LONG_WORDS,
        _NUMBER_RE.search(text) is not None,
        _TERMS_RE.search(lowered) is not None,
        concrete,
    )
    return sum(1 for signal in signals if signal)


def usefulness_band(text: object, *, problem_summary: object = None, feedback_type: object = None) -> str:
    """``low`` | ``medium`` | ``high`` for one review's text and its enrichment (see the module)."""
    clean = ' '.join(text.split()) if isinstance(text, str) else ''
    words = len(_WORD_RE.findall(clean))
    if words < MIN_WORDS or len(clean) < MIN_CHARS or _boilerplate(clean):
        return LOW
    points = _points(clean, words, _concrete(problem_summary, feedback_type))
    if points >= HIGH_POINTS:
        return HIGH
    return MEDIUM if points >= MEDIUM_POINTS else LOW


def item_usefulness(item: Mapping[str, Any]) -> str:
    """The band of a feedback item as built or stored: its (translated) text, summary and type."""
    dimensions = item.get('dimensions')
    feedback_type = dimensions.get(FEEDBACK_TYPE_KEY) if isinstance(dimensions, Mapping) else None
    text = item.get('normalized_text') or item.get('original_text')
    return usefulness_band(text, problem_summary=item.get('problem_summary'), feedback_type=feedback_type)


def stored_band(item: Mapping[str, Any]) -> str:
    """The item's stored band, or ``unrated`` when it has none (or a value that is not a band)."""
    value = item.get(USEFULNESS_FIELD)
    return value if isinstance(value, str) and value in USEFULNESS_BANDS else USEFULNESS_UNRATED
