"""Canonical JSON and the write fingerprint of plan mode, byte-identical to TypeScript.

Mirrors ``lambda/stream/src/assistant/plan/canonical.ts`` + ``fingerprint.ts``; the shared
cases in ``test/fixtures/plan-fingerprints.json`` were computed by the TypeScript code and
pin this module. Rules: keys sorted by code point, no whitespace, strings escaped as
``JSON.stringify`` does, numbers as ECMAScript ``Number#toString``. Lone surrogates,
non-finite numbers and non-JSON types raise :class:`CanonicalJsonError` (TypeScript throws
for the same values).

Also the JavaScript string semantics the plan validator needs to agree with zod on
bounds: :func:`js_length` (UTF-16 code units) and :func:`js_trim` (``String#trim``).
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from decimal import Decimal
from typing import Final

# ECMAScript WhiteSpace + LineTerminator — what String.prototype.trim removes (Python's
# str.strip() also removes \x1c-\x1f and \x85, so it cannot be used).
_JS_TRIM_RE: Final = re.compile(
    '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'
    '|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+\\Z',
)
_SURROGATE_RE: Final = re.compile('[\ud800-\udfff]')
# JavaScript's Number to String conversion uses exponent notation below 1e-7 and from 1e21 up.
_JS_FIXED_MAX_EXPONENT: Final = 21
_JS_FIXED_MIN_EXPONENT: Final = -6


class CanonicalJsonError(ValueError):
    """A value with no canonical form."""


def js_length(value: str) -> int:
    """``value.length`` in JavaScript: UTF-16 code units."""
    return len(value.encode('utf-16-le', 'surrogatepass')) // 2


def js_trim(value: str) -> str:
    """``value.trim()`` in JavaScript."""
    return _JS_TRIM_RE.sub('', value)


def _shortest_digits(value: float) -> tuple[str, int]:
    """(digits, n) with ``abs(value) == 0.<digits> * 10**n`` — the shortest round-trip digits."""
    number = Decimal(repr(value)).normalize()
    return ''.join(str(digit) for digit in number.as_tuple().digits), number.adjusted() + 1


def _js_unsigned(value: float) -> str:
    """ECMAScript Number::toString of ``abs(value)`` for a finite ``value`` (-0.0 is '0')."""
    digits, n = _shortest_digits(value)
    k = len(digits)
    if _JS_FIXED_MIN_EXPONENT < n <= _JS_FIXED_MAX_EXPONENT:
        if n >= k:
            return digits + '0' * (n - k)
        if n > 0:
            return f'{digits[:n]}.{digits[n:]}'
        return f'0.{"0" * -n}{digits}'
    mantissa = digits if k == 1 else f'{digits[0]}.{digits[1:]}'
    return f'{mantissa}e{n - 1:+d}'


def _js_number(value: float) -> str:
    if not math.isfinite(value):
        raise CanonicalJsonError('non-finite number')
    if value < 0:
        return '-' + _js_unsigned(value)
    return _js_unsigned(value)


def _string(value: str) -> str:
    if _SURROGATE_RE.search(value):
        raise CanonicalJsonError('lone surrogate in a string')
    return json.dumps(value, ensure_ascii=False)


def _scalar(value: object) -> str | None:
    """The canonical text of a JSON scalar, or None when ``value`` is not one."""
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, (int, float)):
        # JavaScript holds every number as a double: beyond 2**53 an int prints as the rounded double.
        return _js_number(float(value))
    if isinstance(value, Decimal):
        return canonical_json(int(value)) if value == value.to_integral_value() else _js_number(float(value))
    return None


def canonical_json(value: object) -> str:
    """The canonical JSON text of a JSON-like value (DynamoDB ``Decimal`` included)."""
    scalar = _scalar(value)
    if scalar is not None:
        return scalar
    if isinstance(value, (list, tuple)):
        return '[' + ','.join(canonical_json(item) for item in value) + ']'
    if isinstance(value, dict):
        members = sorted(((key, member) for key, member in value.items() if isinstance(key, str)), key=lambda pair: pair[0])
        if len(members) != len(value):
            raise CanonicalJsonError('object keys must be strings')
        return '{' + ','.join(f'{_string(key)}:{canonical_json(member)}' for key, member in members) + '}'
    raise CanonicalJsonError(f'no canonical form for {type(value).__name__}')


def canonical_write_fingerprint(tool: str, args: dict) -> str:
    """sha256 hex of ``{"args": args, "tool": tool}`` in canonical form."""
    return hashlib.sha256(canonical_json({'tool': tool, 'args': args}).encode('utf-8')).hexdigest()
