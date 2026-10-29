"""Per-user ways of working with AI (docs/ways-of-working.md), in the aggregates table.

    USERFLAGS#{sub} / ai_mode  {mode, ai_writing_prfaq: bool, ai_writing_prd: bool, updated_at, updated_by}

``mode`` is one of, from least to most AI (each one up adds to the one below):

- ``human_driven`` — the AI answers questions, explains the method and reviews; it
  never writes a PR/FAQ or PRD for the person. ``ai_writing_prfaq`` / ``ai_writing_prd``
  are the admin's per-type unlocks once the person has learned ("PR/FAQ with AI").
- ``ai_assisted`` — the AI drafts, suggests and rewrites with the person (editor, chat).
- ``ai_driven`` — plus autonomous agents and approved plans may write documents for them.

No row (or an unreadable mode) is ``ai_driven``: today's behaviour, for everyone,
admins included. The row has its own sort key next to the flags row
(shared/user_flags.py) so neither writer can overwrite the other's attributes.
Only the users Lambda writes it (admin, ``PUT /users/{username}/flags``); readers are
the gate (shared/ai_writing.py), ``GET /users/me/ai-mode`` and the stream Lambda.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final

from shared.timestamps import now_iso
from shared.user_flags import USERFLAGS_PREFIX, batch_rows_by_sub

AI_MODE_SK: Final = 'ai_mode'
MODE_HUMAN_DRIVEN: Final = 'human_driven'
MODE_AI_ASSISTED: Final = 'ai_assisted'
MODE_AI_DRIVEN: Final = 'ai_driven'
MODES: Final = (MODE_HUMAN_DRIVEN, MODE_AI_ASSISTED, MODE_AI_DRIVEN)
DEFAULT_MODE: Final = MODE_AI_DRIVEN
#: The admin's per-type unlocks inside Human-driven, keyed by document type.
UNLOCK_FIELDS: Final = {'prfaq': 'ai_writing_prfaq', 'prd': 'ai_writing_prd'}
#: Every field ``PUT /users/{username}/flags`` accepts for this row.
FIELD_NAMES: Final = ('ai_mode', *UNLOCK_FIELDS.values())


@dataclass(frozen=True)
class AiMode:
    """One user's way of working; ``unlocked`` = doc types AI may write in Human-driven."""

    mode: str = DEFAULT_MODE
    unlocked: frozenset[str] = frozenset()

    def to_dict(self) -> dict[str, Any]:
        return {
            'mode': self.mode,
            **{field: doc_type in self.unlocked for doc_type, field in UNLOCK_FIELDS.items()},
        }


DEFAULT_AI_MODE: Final = AiMode()


def ai_mode_key(sub: str) -> dict[str, str]:
    return {'pk': f'{USERFLAGS_PREFIX}{sub}', 'sk': AI_MODE_SK}


def ai_mode_of(item: dict | None) -> AiMode:
    """The stored row as an AiMode; anything unreadable falls back to the default."""
    item = item or {}
    mode = item.get('mode')
    return AiMode(
        mode=mode if mode in MODES else DEFAULT_MODE,
        unlocked=frozenset(t for t, field in UNLOCK_FIELDS.items() if item.get(field) is True),
    )


def get_ai_mode(table: Any, sub: str) -> AiMode:
    """One user's mode (strongly consistent: the gate must see an admin's change at once)."""
    return ai_mode_of(table.get_item(Key=ai_mode_key(sub), ConsistentRead=True).get('Item'))


def ai_modes_for_subs(dynamodb: Any, table_name: str, subs: list[str]) -> dict[str, AiMode]:
    """Modes for many users (the Users list); an unread or unset user gets the default."""
    unique = [s for s in dict.fromkeys(subs) if s]
    found = batch_rows_by_sub(dynamodb, table_name, [ai_mode_key(s) for s in unique])
    return {sub: ai_mode_of(found.get(sub)) for sub in unique}


def set_ai_mode(table: Any, *, sub: str, changes: dict[str, Any], actor_sub: str) -> AiMode:
    """Apply validated ``changes`` (``ai_mode`` and/or the unlock booleans); returns the result.

    The unlocks are kept when the mode moves up and back down, so an admin who
    tries AI-assisted for a week does not lose what they unlocked before.
    """
    current = get_ai_mode(table, sub)
    mode = changes.get('ai_mode', current.mode)
    unlocks = {
        field: changes.get(field, doc_type in current.unlocked)
        for doc_type, field in UNLOCK_FIELDS.items()
    }
    row = {'mode': mode, **unlocks}
    table.put_item(Item={**ai_mode_key(sub), **row, 'updated_at': now_iso(), 'updated_by': actor_sub})
    return ai_mode_of(row)
