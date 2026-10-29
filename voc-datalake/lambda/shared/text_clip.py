"""Shorten text for people to read: on a word boundary, with an ellipsis.

A plain ``text[:n]`` cuts mid-word ("…and unpaid refun — 2026-10-25"); a title or
a quoted review is clipped here instead.
"""
from __future__ import annotations

ELLIPSIS = '…'
#: Stripped before the ellipsis so a clip never reads "refunds,…" or "refunds —…".
_TRAILING_PUNCTUATION = ' ,;:.-\u2014\u2013'  # space, comma, …, em dash, en dash


def clip_words(text: str, limit: int) -> str:
    """``text`` (whitespace collapsed) within ``limit`` characters, ending on a whole word.

    Text that fits is returned unchanged; otherwise the last whole word that fits
    is kept and ``…`` appended (the ellipsis counts towards ``limit``). A single word
    longer than the limit is cut hard, ellipsis included.
    """
    if limit <= 0:
        return ''
    collapsed = ' '.join(text.split())
    if len(collapsed) <= limit:
        return collapsed
    room = collapsed[:max(limit - len(ELLIPSIS), 0)]
    # The cut already ends a word when the next character is the space after it.
    ends_on_word = collapsed[len(room)] == ' '
    head = room if ends_on_word or ' ' not in room else room.rsplit(' ', 1)[0]
    return head.rstrip(_TRAILING_PUNCTUATION) + ELLIPSIS
