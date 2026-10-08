"""Validation of client-supplied ids that become half of a DynamoDB sort key.

Shared by the projects and ballots handlers — separate Lambda bundles that
cannot import each other — because both compose `BALLOT#{row_id}#{kind}:{subject}`
keys and both must hold every segment to the same three rules:

* '#' is REFUSED rather than escaped: it is the sort-key delimiter, server-minted
  ids never contain it, and an id carrying one would make the key ambiguous to
  the read that splits it back apart.
* An absurd length is a 400 naming the field rather than a DynamoDB
  ValidationException surfacing as a 500 (a sort key is capped at 1024 bytes).
* Each branch names the RULE it failed and never echoes the value: three causes
  behind one message leaves a caller unable to tell a delimiter collision from an
  over-long id, while the value itself is unbounded caller input that a response
  gains nothing by repeating.

What this checks is the SHAPE, not the existence: the route checks existence
against its table, once, where a malformed id is a 400 about the request and a
well-formed id naming no row is a 404 about the world.
"""

from __future__ import annotations

import math
from typing import Any

from shared.exceptions import ValidationError

# A DynamoDB sort key is capped at 1024 bytes. Bounding an id that reaches one
# well under that makes an absurd value a 400 naming the field rather than a
# DynamoDB ValidationException surfacing as a 500. Named for the KEY SEGMENT
# rather than for any one kind of id, because it bounds every caller-supplied id
# that becomes half of a sort key: a document id, a project id (which a default
# row id is composed from), and a row id itself.
MAX_KEY_SEGMENT_ID_LEN = 256


def validated_row_id(raw: Any, *, field: str = 'row_id', missing_message: str | None = None) -> str:
    """``raw`` as a sort-key segment, or a ValidationError naming ``field``.

    ``missing_message`` overrides the wording for an absent or blank value where a
    route's field is not literally named (the keys of a `scores` map, say).
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValidationError(missing_message or f'{field} is required')
    value = raw.strip()
    if '#' in value:
        raise ValidationError(f"{field} must not contain '#', the sort-key delimiter")
    if len(value) > MAX_KEY_SEGMENT_ID_LEN:
        raise ValidationError(f'{field} must be at most {MAX_KEY_SEGMENT_ID_LEN} characters')
    return value


def is_clampable_number(value: Any) -> bool:
    """Whether an axis value is a number a route may clamp into its range.

    CLAMP A NUMBER, REFUSE A NON-NUMBER. The clamp is justified because the value
    is bounded either way — `99`, `-4`, `'3'` and `2.7` all plainly mean a number
    the slider range can hold. `'high'` does not: there is no value to bound, so a
    fallback 0 would be INVENTED, and once stored it is indistinguishable from a
    deliberate lowest score.

    Three traps, each of which lets a non-number through a numeric check written
    the obvious way:

    * `bool` is a subclass of `int`, so `isinstance(True, int)` is true and
      `int(True)` is `1`. A flag is not a slider position. Refused explicitly,
      ahead of any coercion.
    * `int(float('inf'))` raises `OverflowError`, which is in NEITHER of the
      exception types `validate_int` catches, so left alone it propagates as a
      bare 500. `Infinity` is reachable over the wire because Powertools parses
      the body with non-strict `json.loads`.
    * `int(float('nan'))` raises `ValueError`, which IS swallowed, so a `NaN`
      would silently store the invented 0.

    So the coercion attempt catches `OverflowError` beside `ValueError` and
    `TypeError`, and a non-finite float is refused outright.
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, float) and not math.isfinite(value):
        return False
    try:
        int(value)
    except (ValueError, TypeError, OverflowError):
        return False
    return True
