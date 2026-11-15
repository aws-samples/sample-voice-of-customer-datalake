"""The administrators' opt-in hard cap on engineering runs (``hard_cap``, off by default).

One row in voc-agents, ``SETTINGS#engineering`` / ``HARD_CAP``, beside the workflows whose budgets it caps: the Agents
API writes it (an administrator's PUT /agents/engineering/settings) and the runtime reads it (start_run's GetItem of
this one key). Each change also writes a create-only history row in the same partition, ``LOG#<at>#<n>`` (D1, D4: who,
when, what), in the same transaction, so the setting and its history never drift.

With the hard cap on, a run's first start with its flow's monthly budget gets a cost cap of what is left of the flow's
month (``runtime/runs.py hard_capped``: the budget less the flow's month total), the smaller of that and any cap it was
given, and is refused before anything is written when nothing is left. The cap is set once, per run, at its start:
runs of one flow at once may together pass its budget. It counts session time only until the model broker prices
tokens. Off (the default), nothing changes.
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

#: The hard cap's one row (voc-agents).
SETTINGS_KEY: Final = {'pk': 'SETTINGS#engineering', 'sk': 'HARD_CAP'}
#: Who an unnamed change is recorded as (never a blank in the history).
UNNAMED: Final = 'unknown'
_MAX_NAME: Final = 128


@dataclass(frozen=True)
class HardCap:
    on: bool = False
    updated_at: str | None = None
    updated_by: str | None = None

    def view(self) -> dict[str, Any]:
        return {'hard_cap': self.on, 'updated_at': self.updated_at, 'updated_by': self.updated_by}


def read_hard_cap(table: Any) -> HardCap:
    """The hard cap as last saved (consistent: a change applies to the next start at once); off when never saved."""
    item = table.get_item(Key=SETTINGS_KEY, ConsistentRead=True).get('Item') or {}
    return HardCap(on=item.get('hard_cap') is True, updated_at=_text(item.get('updated_at')),
                   updated_by=_text(item.get('updated_by')))


def save_hard_cap(table: Any, *, on: bool, by: str, at: datetime) -> HardCap:
    """Save the hard cap's state, with its history row, in one transaction; the hard cap as saved."""
    when = at.astimezone(UTC).isoformat()
    name = ''.join(char for char in by if char.isprintable())[:_MAX_NAME] or UNNAMED
    table.meta.client.transact_write_items(TransactItems=[
        {'Update': {'TableName': table.name, 'Key': SETTINGS_KEY,
                    'UpdateExpression': 'SET hard_cap = :on, updated_at = :at, updated_by = :by',
                    'ExpressionAttributeValues': {':on': on, ':at': when, ':by': name}}},
        {'Put': {'TableName': table.name,
                 'Item': {'pk': SETTINGS_KEY['pk'], 'sk': f'LOG#{when}#{secrets.token_hex(4)}',
                          'hard_cap': on, 'by': name, 'at': when},
                 'ConditionExpression': 'attribute_not_exists(sk)'}},   # (D1: create-only)
    ])
    return HardCap(on=on, updated_at=when, updated_by=name)


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
