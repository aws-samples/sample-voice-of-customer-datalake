"""Which skill an agent runs (7.50.00): resolved once, at its launch, and fetched by its session through the board.

A launch (runtime/handler.py ``launch``) resolves the agent's role's skill in this order, and records the label on
the agent's session row (``skill_version``), whose model and harness its argv takes:

1. the flow step's pin (an agent step's ``params.skill_version`` ``v<n>``): version ``n`` of the run's connection's
   own skill, else of the shared skill; only an accepted version (a person accepted it), else the launch is refused;
2. the store's current version for the run's connection (``SkillStore.current``: the connection's own, else the
   shared one);
3. the role's bundled template (``templates.py``), ``<role>@template-<version>``.

A store that cannot be read refuses the launch (raised): a template never stands in for a version a person accepted.

The session then asks the board for its skill (board/api.py ``skill``): the board reads the label its session row
records and answers that one record (``record_for_label``), so an agent never picks a skill, and a label the board
cannot serve (a template version this deployment no longer ships, a version not accepted) is refused, which the
harness takes as a crash, never a fallback.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final, Protocol

from engineering.connectors.identity import WORKSPACE
from engineering.runtime.harness.skills import Skill as HarnessSkill
from engineering.skills.model import SkillError
from engineering.skills.store import ACCEPTED, SHARED, SkillConflict, SkillForbidden, SkillNotFound, SkillVersion
from engineering.skills.templates import Templates, parse_template_label
from shared.workflow_engineering import AGENT_REF, CARD_REF, GATE_AGENTS

#: An agent step's pin (shared/workflow_engineering.py ``skill_version``): ``latest`` or ``v<n>``.
LATEST: Final = 'latest'
PINNED: Final = re.compile(r'v([1-9][0-9]{0,5})\Z')
#: A store version's label (``SkillVersion.label``): ``<role>@<version>`` (shared), ``<role>@<connection>/<version>``.
STORE_LABEL: Final = re.compile(r'(?P<role>[a-z][a-z-]{0,39})@(?:(?P<connection>[A-Za-z0-9][A-Za-z0-9_-]{0,127})/)?'
                                r'(?P<version>[1-9][0-9]{0,5})\Z')


class SkillVersions(Protocol):
    """The skills store's read of one version (``SkillStore.version``): all a label's lookup makes."""

    def version(self, ws: str, connection: str, role: str, version: int) -> SkillVersion: ...


class SkillRows(SkillVersions, Protocol):
    """The skills store's reads a launch's resolution makes (``SkillStore``)."""

    def current(self, ws: str, connection: str, role: str) -> SkillVersion | None: ...


@dataclass(frozen=True)
class Resolved:
    """The skill an agent runs, and the label its session row records."""

    label: str
    skill: HarnessSkill

    def answer(self) -> dict[str, Any]:
        """The board's ``skill`` answer."""
        return {'label': self.label, 'record': self.skill.to_record()}


def _run_as(found: SkillVersion) -> Resolved:
    if found.status != ACCEPTED:
        raise SkillConflict(f'{found.label} is {found.status}, not accepted: an agent runs only an accepted version')
    return Resolved(found.label, HarnessSkill.from_record(found.skill.to_record()))


def pinned_version(pin: object) -> int | None:
    """The version a step pins (``v<n>``), None for ``latest`` or no pin; ``SkillError`` for anything else."""
    if pin in (None, '', LATEST):
        return None
    match = PINNED.fullmatch(str(pin))
    if match is None:
        raise SkillError(f"a step's skill_version is '{LATEST}' or 'v<n>', not {str(pin)[:40]!r}")
    return int(match.group(1))


def resolve_launch(role: str, *, connection: str, pin: object, rows: SkillRows,
                   templates: Templates) -> Resolved | None:
    """The skill a launch of ``role`` runs (the module's order), None for a role with no skill anywhere."""
    version = pinned_version(pin)
    if version is not None:
        for scope in dict.fromkeys((connection, SHARED)):
            try:
                found = rows.version(WORKSPACE, scope, role, version)
            except SkillNotFound:
                continue
            return _run_as(found)
        raise SkillNotFound(f'the step pins {role} v{version}, which is no version of the role\'s skill')
    current = rows.current(WORKSPACE, connection, role)
    if current is not None:
        return _run_as(current)
    template = templates.skill(role)
    return None if template is None else Resolved(template.label, template.skill)


def record_for_label(label: str, *, role: str, connection: str, rows: SkillVersions,
                     templates: Templates) -> Resolved:
    """The skill a session row's ``label`` names, for an agent of ``role`` on the run's ``connection``: the bundled
    template of that version, or the store's accepted version (a connection's only for the run's own connection).
    ``SkillError`` (its ``kind``: not_found, forbidden, conflict) for anything else."""
    template = parse_template_label(label)
    if template is not None:
        if template[0] != role:
            raise SkillForbidden(f'{label} is not a skill of the {role} role')
        found = templates.skill(role)
        if found is None or found.version != template[1]:
            raise SkillConflict(f'{label} is no longer one of this deployment\'s templates: the agent stops, and a '
                                'new launch runs the current one')
        return Resolved(found.label, found.skill)
    match = STORE_LABEL.fullmatch(label)
    if match is None:
        raise SkillNotFound('the session records no skill the board can serve')
    if match.group('role') != role:
        raise SkillForbidden(f'{label} is not a skill of the {role} role')
    scope = match.group('connection') or SHARED
    if scope and scope != connection:
        raise SkillForbidden(f'{label} is another connection\'s skill')
    return _run_as(rows.version(WORKSPACE, scope, role, int(match.group('version'))))


def kind_of(error: SkillError) -> str:
    """A skill error's kind for an answer's status (``not_found``, ``forbidden``, ``conflict``, else ``invalid``)."""
    kind = getattr(error, 'kind', 'invalid')
    return kind if isinstance(kind, str) else 'invalid'


def _step_params(definition: Mapping[str, Any] | None, step: str, kinds: tuple[str, ...]) -> Mapping[str, Any]:
    """The params of the step ``step`` when it is one of ``kinds`` (``{}`` otherwise, or with no flow)."""
    if not definition or not step:
        return {}
    for node in definition.get('nodes') or ():
        if not isinstance(node, Mapping) or node.get('id') != step or node.get('type') not in kinds:
            continue
        data = node.get('data')
        params = data.get('params') if isinstance(data, Mapping) else None
        return params if isinstance(params, Mapping) else {}
    return {}


def step_pin(definition: Mapping[str, Any] | None, step: str, role: str) -> object:
    """The ``skill_version`` an agent step of ``role`` pins in a run's flow definition (``voc-workflow/2``), None for
    another step, a board's claimer or a run without a flow. A quality gate's gate runner and final go (7.52.00): the
    version its ``runner`` / ``final_go`` names of the role itself (``gate-runner@v3``); a card of it
    (``gate-runner-strict@v2``) or ``latest`` pins none here (the role's current skill runs)."""
    params = _step_params(definition, step, ('agent', 'quality_gate'))
    if params.get('role') == role:
        return params.get('skill_version')
    key = next((key for key, of in GATE_AGENTS.items() if of == role), None)
    match = AGENT_REF.fullmatch(str(params.get(key, ''))) if key is not None and 'role' not in params else None
    return match['version'] if match is not None and match['id'] == role and match['version'] != LATEST else None


def step_card(definition: Mapping[str, Any] | None, step: str, role: str) -> dict[str, str]:
    """The Registry card an agent step of ``role`` was made from (7.52.00, ``params.card`` ``<card>@v<n>``), as its
    session row records it: ``{card, card_version}``; empty for any other step."""
    params = _step_params(definition, step, ('agent',))
    match = CARD_REF.fullmatch(str(params.get('card', ''))) if params.get('role') == role else None
    return {} if match is None else {'card': match['card'], 'card_version': match['version']}
