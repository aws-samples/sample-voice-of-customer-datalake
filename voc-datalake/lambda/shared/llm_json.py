"""Decoding the JSON object a model answer carries.

A model asked for "ONLY valid JSON" still answers, now and then, with the object
wrapped in prose or a code fence, followed by a second object or a closing remark,
or with a raw newline / tab inside a string value. Python's ``json.loads`` rejects
all of those ("Extra data", "Invalid control character"), which on the feedback
processor turned a well-formed enrichment into the fallback defaults.

``first_json_object`` decodes the value that starts at the first ``{`` and stops
where that value ends (``JSONDecoder.raw_decode``), with ``strict=False`` so control
characters inside strings are accepted — the standard library's documented switch for
exactly that. What it cannot repair is an answer that was cut off (an unterminated
string): that is a budget problem, solved by sizing ``max_tokens`` so the answer fits
in one call (shared/converse.py, "STRICT-JSON DOCTRINE").
"""
from __future__ import annotations

import json
from typing import Any

_LENIENT_DECODER = json.JSONDecoder(strict=False)


def first_json_object(text: str) -> Any:
    """The JSON value starting at the first ``{`` of *text* (at its start when there is none).

    Trailing text after that value is ignored; raw control characters inside its strings
    are kept. Raises ``json.JSONDecodeError`` when no value decodes there.
    """
    start = text.find('{')
    value, _end = _LENIENT_DECODER.raw_decode(text, max(start, 0))
    return value
