"""The legal basis every customer-data delete states (TENETS.md D5, docs/source-policies.md).

Customer data (raw items and the feedback derived from them) is deleted only for a
legal obligation: an erasure request (``POST /settings/erasure``, a participant's
erasure) or a declared retention limit (a source profile's ``retention_days``). Each
states WHY, as free text an admin types ("GDPR art. 17 request #123", "DPA with
vendor X, 12 months"), and that text travels with the job onto its audit rows and
tombstones.

A profile saved with ``retention_days`` before 6.00.00 has no basis. It keeps
running (a legal limit must not silently stop), and its rows read
``LEGACY_LEGAL_BASIS`` until an admin sets one.
"""

from __future__ import annotations

from typing import Final

__all__ = [
    'LEGACY_LEGAL_BASIS',
    'MAX_LEGAL_BASIS_CHARS',
    'legal_basis_or_legacy',
    'required_legal_basis',
]

MAX_LEGAL_BASIS_CHARS: Final = 300
LEGACY_LEGAL_BASIS: Final = 'not recorded (set before 6.00.00)'


def required_legal_basis(value: object, what: str = 'legal_basis') -> str:
    """``value`` trimmed: a non-empty string of at most ``MAX_LEGAL_BASIS_CHARS``; ValueError otherwise."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{what} is required: say why this data is deleted (for example "GDPR art. 17 request")')
    text = value.strip()
    if len(text) > MAX_LEGAL_BASIS_CHARS:
        raise ValueError(f'{what} must be at most {MAX_LEGAL_BASIS_CHARS} characters')
    return text


def legal_basis_or_legacy(value: object) -> str:
    """A stored basis as recorded on audit rows: the text, or ``LEGACY_LEGAL_BASIS`` when none was saved."""
    return value.strip() if isinstance(value, str) and value.strip() else LEGACY_LEGAL_BASIS
