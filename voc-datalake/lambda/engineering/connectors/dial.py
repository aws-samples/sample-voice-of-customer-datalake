"""The dial the broker reads before it pushes anything (TENETS.md tenet 3, docs/autonomous-engineering.md).

The way of working is a person's (``shared/ai_mode.py``: ``USERFLAGS#<sub>`` / ``ai_mode`` in the aggregates table,
written only by the users API for an administrator); an engineering run follows the way of working of the person who
started it (its META's ``started_by``), read again, strongly consistent, at every push and pull request, so an
administrator's change applies at once.

It fails closed, on purpose stricter than ``shared/ai_mode.py``'s reading (where no row is AI-driven, everyone's
default for documents): for a write to a repository only an explicitly stored ``ai_assisted`` or ``ai_driven``
allows anything. No row, a mode outside ``MODES``, a run that names no person or names something that is not a
person's subject (an agent, a token, a plan) all work Human-driven: a person with no saved way of working pushes
nothing. A read that fails is ``Unavailable`` (retry), never a pass. The read asks for the ``mode`` attribute alone
(a projection, which the broker's IAM grant requires: engineering-broker.ts).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from engineering.connectors.hosts import Unavailable
from shared.ai_mode import MODE_AI_ASSISTED, MODE_AI_DRIVEN, MODE_HUMAN_DRIVEN, ai_mode_key

#: A person's subject (a Cognito ``sub``): letters, digits and ``-``; never ``agent:``, ``mcp:`` or ``plan:``.
_PERSON: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{0,127}')
#: The only stored modes that let a run push or open a pull request.
PUSHING_MODES: Final = frozenset({MODE_AI_ASSISTED, MODE_AI_DRIVEN})
#: The one attribute of the way-of-working row the broker reads.
MODE_ATTRIBUTE: Final = 'mode'


@dataclass(frozen=True)
class WaysOfWorking:
    """The ``Dial`` over the aggregates table (a boto3 ``Table``)."""

    table: Any

    def mode(self, person: str) -> str:
        if not _PERSON.fullmatch(person):
            return MODE_HUMAN_DRIVEN
        try:
            item = self.table.get_item(Key=ai_mode_key(person), ConsistentRead=True, ProjectionExpression='#mode',
                                       ExpressionAttributeNames={'#mode': MODE_ATTRIBUTE}).get('Item') or {}
        except (ClientError, BotoCoreError) as exc:
            raise Unavailable('The way of working of the person who started the run could not be read; retry.') \
                from exc
        mode = item.get(MODE_ATTRIBUTE)
        return mode if mode in PUSHING_MODES else MODE_HUMAN_DRIVEN
