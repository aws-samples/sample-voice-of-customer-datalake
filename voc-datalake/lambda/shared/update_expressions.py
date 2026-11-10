"""DynamoDB ``SET`` clauses built from a field mapping, with placeholders for every name and value.

Placeholders (``#f0`` / ``:v0`` …) keep reserved words and odd attribute names safe; the caller
adds its own fixed parts (``updated_at = :now``, a condition, an ``ADD``) around the clause.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def set_clause(
    fields: Mapping[str, Any], *, path: str = '', name: str = '#f', value: str = ':v',
) -> tuple[str, dict[str, str], dict[str, Any]]:
    """``('#f0 = :v0, #f1 = :v1', names, values)`` for ``fields``, in their order.

    ``path`` prefixes every target (``'card_state.'`` sets entries of a map attribute);
    ``name`` / ``value`` choose the placeholder prefixes when a caller needs others.
    """
    names = {f'{name}{i}': field for i, field in enumerate(fields)}
    values = {f'{value}{i}': item for i, item in enumerate(fields.values())}
    clause = ', '.join(f'{path}{name}{i} = {value}{i}' for i in range(len(fields)))
    return clause, names, values
