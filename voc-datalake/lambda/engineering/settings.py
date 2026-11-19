"""The administrators' opt-in hard cap on engineering runs (``hard_cap``, off by default), and (7.58.00) each role's
model choice (``ROLE_MODELS_KEY``, below).

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

from shared.dynamo_values import text_or_none as _text

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


# -- the roles' models (7.58.00) ------------------------------------------------------------------------------------

#: Each role's model choice (``runtime/harness/model_choice.py``), one row beside the hard cap's: an attribute per role
#: that has one (``model:<role>``, with ``at:<role>`` and ``by:<role>``), so a change of one role is one atomic update
#: that never reads or rewrites another's. The Agents API writes it (an administrator's Registry ``PUT …/registry/<role>
#: /model``, with its history row), the runtime reads it at a run's first start (a GetItem in the hard cap's partition)
#: and records it on the run's META, which its launches apply.
ROLE_MODELS_KEY: Final = {'pk': 'SETTINGS#engineering', 'sk': 'ROLE_MODELS'}
_MODEL: Final = 'model:'


@dataclass(frozen=True)
class RoleModel:
    choice: str
    updated_at: str | None = None
    updated_by: str | None = None

    def view(self) -> dict[str, Any]:
        return {'model_choice': self.choice or None, 'updated_at': self.updated_at, 'updated_by': self.updated_by}


def read_role_models(table: Any) -> dict[str, RoleModel]:
    """Each role's model choice as last saved (consistent), only the roles that have one ({} when never saved)."""
    item = table.get_item(Key=ROLE_MODELS_KEY, ConsistentRead=True).get('Item') or {}
    found: dict[str, RoleModel] = {}
    for name, value in item.items():
        role = name.removeprefix(_MODEL)
        if name.startswith(_MODEL) and isinstance(value, str) and value:
            found[role] = RoleModel(value, _text(item.get(f'at:{role}')), _text(item.get(f'by:{role}')))
    return found


def save_role_model(table: Any, *, role: str, choice: str, by: str, at: datetime) -> RoleModel:
    """Save ``role``'s model choice ('' clears it: the role's default again), checked by the caller, with its history
    row, in one transaction; the choice as saved."""
    when = at.astimezone(UTC).isoformat()
    name = ''.join(char for char in by if char.isprintable())[:_MAX_NAME] or UNNAMED
    names = {'#m': f'{_MODEL}{role}', '#a': f'at:{role}', '#b': f'by:{role}'}
    update = ({'UpdateExpression': 'SET #m = :m, #a = :at, #b = :by',
               'ExpressionAttributeValues': {':m': choice, ':at': when, ':by': name}} if choice else
              {'UpdateExpression': 'SET #a = :at, #b = :by REMOVE #m',
               'ExpressionAttributeValues': {':at': when, ':by': name}})
    table.meta.client.transact_write_items(TransactItems=[
        {'Update': {'TableName': table.name, 'Key': ROLE_MODELS_KEY, 'ExpressionAttributeNames': names, **update}},
        {'Put': {'TableName': table.name,
                 'Item': {'pk': ROLE_MODELS_KEY['pk'], 'sk': f'LOG#{when}#{secrets.token_hex(4)}',
                          'role_model': {'role': role, 'model': choice}, 'by': name, 'at': when},
                 'ConditionExpression': 'attribute_not_exists(sk)'}},   # (D1: create-only)
    ])
    return RoleModel(choice, when, name)
