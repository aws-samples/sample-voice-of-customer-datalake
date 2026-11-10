"""Review text as plain text: the markdown escapes and bold markers a page or the model leaves in, removed.

Web Reviews stored ``situation\\.On`` and ``**Great crew**`` verbatim (5.34.00), and every
surface (feed, Data Explorer, assistant, PDF, CSV) showed the backslashes and asterisks. New
reviews are cleaned here, at extraction; stored ones are cleaned for display by the SPA
(``frontend/src/utils/cleanReviewText.ts``) and the assistant (``lambda/stream/src/tools/review-text.ts``).
All three follow ``schemas/review-text-cleanup-cases.json``.

- ``\\.`` / ``\\!`` directly before a capital letter gets its space back (the escape had glued
  two sentences together), then every backslash escape of markdown punctuation loses its backslash
  (``5\\.99`` → ``5.99``; ``C:\\Users`` stays, ``U`` is not markdown punctuation).
  Any ASCII punctuation can be escaped in markdown, so every one is unescaped.
- ``**`` bold markers, paired or stray, are dropped. A single ``*`` stays (``5*`` ratings).
"""

import re
from typing import Final

_GLUED_SENTENCE: Final = re.compile(r'\\([.!])')
_ESCAPED_PUNCTUATION: Final = re.compile(r'\\([!-/:-@\[-`{-~])')
_BOLD_MARKER: Final = '**'


def _sentence_break(match: re.Match[str]) -> str:
    """``\\.`` before a capital letter → ``. ``; any other escape is left for ``_ESCAPED_PUNCTUATION``."""
    following = match.string[match.end():match.end() + 1]
    return f'{match.group(1)} ' if following.isupper() else match.group(0)


def plain_review_text(text: str) -> str:
    """*text* without markdown escapes or ``**`` markers; plain text comes back unchanged."""
    unglued = _GLUED_SENTENCE.sub(_sentence_break, text.replace(_BOLD_MARKER, ''))
    return _ESCAPED_PUNCTUATION.sub(r'\1', unglued)
