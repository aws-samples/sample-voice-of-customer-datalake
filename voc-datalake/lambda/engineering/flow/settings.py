"""A flow's built-in steps' settings (7.50.00, plan §2): ``memory`` (the recall every agent's brief takes) and
``learn`` (the run's last step, which no flow can remove), read from the run's own copy of its flow.

The templates' compiler puts them in the flow's start step (``data.params``: ``{memory, learn, pr}``), which
``shared/workflow_engineering.flow_settings`` reads, here too; both are optional, so a flow without them (every flow
before 7.50.00, and a run with no flow) gets the defaults: no recall, Learn on at 5% of the run's cost cap, after 72
hours at a person. A value off its shape is the default (the templates' validator refuses it before it is ever saved):
a run never stops for a setting it cannot read.

    memory: {recall: true, scopes: [repo, role], limit: 10}
    learn: {enabled: true, model: <an allowed model id>, budget_share: 0.05, roles: [...], after_needs_human_hours: 72}
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from shared.workflow_engineering import flow_settings

#: The memory scopes a recall reads (agent_memory/model.py ``Scope.kind``), as a flow names them.
MEMORY_SCOPES: Final = {'repo': 'repository', 'repository': 'repository', 'role': 'role'}
DEFAULT_MEMORY_LIMIT: Final = 10
MAX_MEMORY_LIMIT: Final = 30
DEFAULT_BUDGET_SHARE: Final = 0.05
DEFAULT_AFTER_NEEDS_HUMAN_HOURS: Final = 72
MAX_AFTER_NEEDS_HUMAN_HOURS: Final = 24 * 90


@dataclass(frozen=True)
class MemorySettings:
    recall: bool = False
    scopes: tuple[str, ...] = ('repository', 'role')
    limit: int = DEFAULT_MEMORY_LIMIT


@dataclass(frozen=True)
class LearnSettings:
    enabled: bool = True
    #: The model Learn's coach is asked with ('' for the coach's own).
    model: str = ''
    #: Learn's part of the run's cost cap (its spend counts in the run's spend).
    budget_share: float = DEFAULT_BUDGET_SHARE
    #: The roles whose failures Learn takes to the coach (none named: every role).
    roles: tuple[str, ...] = ()
    after_needs_human_hours: int = DEFAULT_AFTER_NEEDS_HUMAN_HOURS


def _whole(value: object, low: int, high: int, default: int) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and low <= value <= high else default


def memory_settings(definition: Mapping[str, Any] | None) -> MemorySettings:
    section = flow_settings(definition)['memory']
    scopes = section.get('scopes')
    named = tuple(dict.fromkeys(MEMORY_SCOPES[str(scope)] for scope in scopes if str(scope) in MEMORY_SCOPES)) \
        if isinstance(scopes, list) else MemorySettings.scopes
    return MemorySettings(recall=section.get('recall') is True, scopes=named or MemorySettings.scopes,
                          limit=_whole(section.get('limit'), 1, MAX_MEMORY_LIMIT, DEFAULT_MEMORY_LIMIT))


def learn_settings(definition: Mapping[str, Any] | None) -> LearnSettings:
    section = flow_settings(definition)['learn']
    share = section.get('budget_share', DEFAULT_BUDGET_SHARE)
    share = float(share) if isinstance(share, int | float) and not isinstance(share, bool) and 0 < share <= 1 \
        else DEFAULT_BUDGET_SHARE
    roles = section.get('roles')
    model = section.get('model')
    return LearnSettings(
        enabled=section.get('enabled', True) is not False,
        model=model if isinstance(model, str) and len(model) <= 200 else '',
        budget_share=share,
        roles=tuple(dict.fromkeys(str(role) for role in roles if isinstance(role, str))) if isinstance(roles, list)
        else (),
        after_needs_human_hours=_whole(section.get('after_needs_human_hours'), 1, MAX_AFTER_NEEDS_HUMAN_HOURS,
                                       DEFAULT_AFTER_NEEDS_HUMAN_HOURS))
