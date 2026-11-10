"""Lexical "similar feedback" ranking for ``GET /feedback/{id}/similar``.

No model call and no embeddings: candidates (one bounded read of the item's
category partition) are ranked by the industry-default lexical signals:

- **token overlap** (Ochiai / set-cosine) between the two items' text — title,
  problem summary and the review text (the English ``normalized_text`` when the
  processor translated it), lower-cased, stop words and short tokens dropped;
- **problem-summary overlap**, weighted on its own because the summary names the
  problem in a normalised vocabulary;
- boosts for the **same sentiment polarity**, the **same subcategory** and the
  **same source**.

**Same language first.** The text tokens compare the English translation, so a
Spanish review and an English one about the same thing overlap — but a reader of a
Spanish review wants Spanish neighbours first (a review in Latin American Spanish should not list other
brands' reviews in other languages first). So the ranking is tiered by the
processor's ``original_language`` (primary subtag, ``es-419`` = ``es``): the same
language, then an unknown one, then a different one; the score orders each tier.
Ranking only — the candidates are the same single bounded read.

A candidate with no meaningful lexical overlap is NOT padded in: an empty list is
the honest answer when nothing in the category talks about the same thing.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Final

__all__ = ['rank_similar']

#: Below this lexical score a candidate is not "similar", whatever its boosts.
MIN_LEXICAL_SCORE: Final = 0.1

TEXT_WEIGHT: Final = 0.6
SUMMARY_WEIGHT: Final = 0.4
SAME_POLARITY_BOOST: Final = 0.15
OPPOSITE_POLARITY_PENALTY: Final = 0.1
SAME_SUBCATEGORY_BOOST: Final = 0.1
SAME_SOURCE_BOOST: Final = 0.15

#: Language tiers (higher ranks first): the same language, unknown on either side, a different one.
SAME_LANGUAGE: Final = 2
UNKNOWN_LANGUAGE: Final = 1
OTHER_LANGUAGE: Final = 0

#: Characters of review text tokenised per item (bounds the CPU per candidate).
MAX_TEXT_CHARS: Final = 2000
MIN_TOKEN_CHARS: Final = 3

_WORD: Final = re.compile(r"[^\W_]+(?:'[^\W_]+)?", re.UNICODE)

# A compact English stop list: function words, plus review boilerplate that every
# item in a feedback corpus shares and that therefore says nothing about the topic.
_STOP_TEXT: Final = """
a about above after again against all also am an and any are as at be because been before being below between
both but by can could did do does doing down during each few for from further had has have having he her here
hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other
our ours out over own same she should so some such than that the their them then there these they this those
through to too under until up very was we were what when where which while who whom why will with would you
your yours yourself yet get got really still even much many one two lot thing things way please thanks thank
app apps product service customer review reviews star stars use used using
"""
_STOP_WORDS: Final = frozenset(_STOP_TEXT.split())

_POLARITY: Final = {'positive': 1, 'negative': -1}


def tokens(*texts: object) -> frozenset[str]:
    """The meaningful lower-cased word tokens of ``texts`` (non-strings ignored)."""
    words: set[str] = set()
    for text in texts:
        if isinstance(text, str) and text:
            words.update(_WORD.findall(text[:MAX_TEXT_CHARS].casefold()))
    return frozenset(w for w in words if len(w) >= MIN_TOKEN_CHARS and w not in _STOP_WORDS and not w.isdigit())


def _overlap(left: frozenset[str], right: frozenset[str]) -> float:
    """Ochiai coefficient: |A & B| / sqrt(|A| |B|), 0 when either side is empty."""
    if not left or not right:
        return 0.0
    return len(left & right) / math.sqrt(len(left) * len(right))


def _language(item: Mapping[str, Any]) -> str:
    """The item's primary language subtag (``es-419`` → ``es``), '' when unknown."""
    raw = item.get('original_language') or item.get('language')
    return raw.strip().lower().replace('_', '-').split('-', 1)[0] if isinstance(raw, str) else ''


def language_tier(source: Mapping[str, Any], candidate: Mapping[str, Any]) -> int:
    """``SAME_LANGUAGE`` / ``UNKNOWN_LANGUAGE`` / ``OTHER_LANGUAGE`` for ``candidate`` beside ``source``."""
    left, right = _language(source), _language(candidate)
    if not left or not right:
        return UNKNOWN_LANGUAGE
    return SAME_LANGUAGE if left == right else OTHER_LANGUAGE


def _same(field: str, left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    value = left.get(field)
    return bool(value) and value == right.get(field)


@dataclass(frozen=True)
class _Profile:
    """One item's tokens and attributes, computed once per item."""

    item: Mapping[str, Any]
    text: frozenset[str]
    summary: frozenset[str]
    polarity: int

    @classmethod
    def of(cls, item: Mapping[str, Any]) -> _Profile:
        body = item.get('normalized_text') or item.get('original_text')
        label = str(item.get('sentiment_label') or '').casefold()
        return cls(
            item=item,
            text=tokens(item.get('title'), item.get('problem_summary'), body),
            summary=tokens(item.get('problem_summary')),
            polarity=_POLARITY.get(label, 0),
        )


def _boosts(source: _Profile, candidate: _Profile) -> float:
    """Same sentiment label boosts, opposite polarity (positive vs negative) penalises."""
    boost = 0.0
    if _same('sentiment_label', source.item, candidate.item):
        boost += SAME_POLARITY_BOOST
    elif source.polarity * candidate.polarity < 0:
        boost -= OPPOSITE_POLARITY_PENALTY
    if _same('subcategory', source.item, candidate.item):
        boost += SAME_SUBCATEGORY_BOOST
    if _same('source_platform', source.item, candidate.item):
        boost += SAME_SOURCE_BOOST
    return boost


def _score(source: _Profile, candidate: _Profile) -> float | None:
    lexical = TEXT_WEIGHT * _overlap(source.text, candidate.text) + SUMMARY_WEIGHT * _overlap(source.summary, candidate.summary)
    if lexical < MIN_LEXICAL_SCORE:
        return None
    return lexical + _boosts(source, candidate)


def rank_similar(source: Mapping[str, Any], candidates: Iterable[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    """The ``limit`` best candidates: same language first, then by score, newer first on a tie. Never the source."""
    profile = _Profile.of(source)
    source_id = source.get('feedback_id')
    scored = []
    for candidate in candidates:
        if candidate.get('feedback_id') == source_id:
            continue
        score = _score(profile, _Profile.of(candidate))
        if score is not None:
            tier = language_tier(source, candidate)
            scored.append(((tier, score, str(candidate.get('processed_at') or '')), candidate))
    scored.sort(key=lambda entry: entry[0], reverse=True)
    return [candidate for _, candidate in scored[:limit]]
