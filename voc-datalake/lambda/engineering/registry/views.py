"""What the Registry answers (7.52.00, ``shared/agents_engineering_registry_routes.py``): the roles' cards composed on
the server, the cards made from a skill, the gate packs with their briefs, and the assertions' vocabulary.

Read only, every read bounded: per role a few GetItems and one Query of its skill's newest versions (its scorecard
one more, for a connection), one Query of the month's spend, one of the cards' listing. Nothing here writes.

- **A role's card** (``role_card``): the role's bundled template (``voc-agent-card/1``: purpose, harness, inputs and
  outputs, caps, trust, evals; its version, label and digest) with what the scope runs today: its skill (the scope's
  current version, the connection's own else the shared one, or the template: label, version, provenance, template
  version, and ``template_newer``, Skills' "Template updated"), its model and tools (the running skill's), the gate
  packs (for the gate runner and the final go: the packs they run), the scorecard of the running label on a
  connection's runs, and the month's spend by role (the ledger's agents, ``<role>-<n>``, summed per role).
- **A card made from a skill**: ``cards.card_view`` (its record and its node).
- **The quality gates** (``gates_view``): each pack's steps (with the words the gate record uses when one does not
  pass, ``quality_gate/checks.py``), tools, image pins, registries and briefs, from the bundle's ``gates``.
- **The assertions** (``assertions_view``): the closed vocabulary (``orchestration/assertions.py``), each with what it
  asks and its arguments, and the ``on_fail`` choices.
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Final

from engineering.connectors.identity import WORKSPACE
from engineering.learning.scorecard import ScorecardStore
from engineering.registry.cards import AgentCardStore, CardError, card_view
from engineering.skills.store import SHARED, SkillStore, SkillVersion
from engineering.skills.views import PAGE, template_view
from shared.agent_run_decisions import REASON_LOOP_EXHAUSTED, RUN_NEEDS_HUMAN, allowed_actions
from shared.workflow_engineering import (
    ASSERTION_ON_FAIL,
    ENGINEERING_ROLES,
    FAIL_ARROW_STEPS,
    GATE_AGENT_DEFAULTS,
    GATE_AGENTS,
    MAX_ASSERTIONS,
    assertion_places,
)

#: The roles that run a quality gate's packs: a card of theirs names them.
GATE_ROLES: Final = frozenset(GATE_AGENTS.values())
#: An agent of a run, as the board numbers them (``<role>-<n>``: board/store.py).
_AGENT: Final = re.compile(r'(?P<role>[a-z][a-z-]*?)-[0-9]+\Z')
#: What each argument of an assertion takes (templates/orchestration/schemas/assertion.schema.json).
ARGUMENTS: Final[Mapping[str, Mapping[str, Any]]] = {
    'by': {'type': 'role'}, 'role': {'type': 'role'},
    'min': {'type': 'integer', 'minimum': 1, 'maximum': 100}, 'max': {'type': 'integer', 'minimum': 1},
}
ON_FAIL: Final[Mapping[str, str]] = {
    'block': 'the step does not pass, and the run goes to a person',
    'fail_arrow': "a quality gate takes its fail arrow (a quality gate's assertions only)",
    'warn': 'recorded only',
}


def role_of(agent_id: str) -> str | None:
    """The role of a run's agent (``fixer-2`` → ``fixer``), None for anything that is not one."""
    match = _AGENT.fullmatch(agent_id)
    return match['role'] if match is not None and match['role'] in ENGINEERING_ROLES else None


def spend_by_role(groups: Iterable[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    """The month's spend by role, from the ledger's groups by agent (``<run>/<agent>``, engineering/spend.py)."""
    totals: dict[str, dict[str, Any]] = {}
    for group in groups:
        role = role_of(str(group.get('key', '')).rpartition('/')[2])
        if role is None:
            continue
        total = totals.setdefault(role, {'usd': 0.0, 'tokens_in': 0, 'tokens_out': 0, 'microvm_seconds': 0.0})
        for name in total:
            total[name] += group.get(name) or 0
    return {role: {**total, 'usd': round(total['usd'], 6)} for role, total in totals.items()}


def _head(running: SkillVersion | None, template: Mapping[str, Any]) -> dict[str, Any]:
    """The skill a scope runs of the role: the store's version it resolves to, else the bundled template."""
    if running is None:
        return {'source': 'template', 'label': template['label'], 'connection': None, 'version': None,
                'status': None, 'provenance': 'template', 'template_version': template['version']}
    return {'source': 'store', 'label': running.label, 'connection': running.connection or SHARED,
            'version': running.version, 'status': running.status, 'provenance': running.provenance,
            'template_version': running.template_version}


def _scorecard(store: ScorecardStore, connection: str, role: str, label: str) -> dict[str, Any] | None:
    """The running label's card over its latest runs on the connection (None for the shared scope: a scorecard is
    a connection's)."""
    if not connection:
        return None
    card = store.version_card(WORKSPACE, connection, role, label)
    return {'label': label, 'runs': card.runs, 'pass_rate': card.pass_rate, 'tasks_done': card.tasks_done,
            'tasks_failed': card.tasks_failed, 'needs_human': card.needs_human, 'cost_usd': float(card.cost_usd),
            'since': card.since, 'until': card.until}


@dataclass(frozen=True)
class RegistryViews:
    #: A low-level DynamoDB client on ``voc-engineering``.
    client: Any
    table: str

    def role_card(self, template: Mapping[str, Any], *, connection: str, gate_packs: list[str],
                  spend: Mapping[str, Mapping[str, Any]], month: str,
                  connections: Iterable[str] = ()) -> dict[str, Any]:
        """A role's card for ``connection``'s scope (``''``: the shared skills), as the module says. For the shared
        scope, ``heads_by_connection``: what each of ``connections`` runs of the role (its own current version, else
        the shared skill's, else the template)."""
        role = str(template['id'])
        skills = SkillStore(self.client, self.table)
        running = skills.current(WORKSPACE, connection, role)
        lines = skills.lines(WORKSPACE, connection, role, limit=PAGE).lines
        newer = template_view(role, lines)
        skill = _head(running, template)
        model, tools = ((template['model'], list(template['tools'])) if running is None
                        else (running.skill.content.model, list(running.skill.content.tool_policy)))
        heads: dict[str, dict[str, Any]] | None = None
        if not connection:
            heads = {}
            for name in connections:
                own = skills.head(WORKSPACE, name, role)
                heads[name] = ({'source': 'store', 'own': True, 'label': f'{role}@{name}/{own.current_version}',
                                'connection': name, 'version': own.current_version}
                               if own is not None and own.current_version
                               else {**{key: skill[key] for key in ('source', 'label', 'connection', 'version')},
                                     'own': False})
        launchable = template.get('skill') is not None
        return {
            'kind': 'role', 'id': role, 'base_role': role, 'title': role, 'purpose': template['purpose'],
            'launchable': launchable,
            'template': {'version': template['version'], 'label': template['label'], 'digest': template['digest']},
            'skill': {**skill, 'template_newer': bool(newer and newer['newer'])},
            **({'heads_by_connection': heads} if heads is not None else {}),
            'model': model, 'tools': tools, 'harness': template['harness'],
            'broker_ops': list(template['broker_ops']), 'pending_tools': list(template['pending_tools']),
            'gates': {'packs': gate_packs} if role in GATE_ROLES else None,
            'inputs': list(template['inputs']), 'outputs': list(template['outputs']), 'caps': dict(template['caps']),
            'trust': dict(template['trust']), 'evals': list(template['evals']),
            'scorecard': _scorecard(ScorecardStore(self.client, self.table), connection, role, skill['label']),
            'spend': {'month': month, **spend.get(role, {'usd': 0.0, 'tokens_in': 0, 'tokens_out': 0,
                                                         'microvm_seconds': 0.0})},
            'node': {'type': 'agent', 'data': {'title': role, 'params': {'role': role, 'skill_version': 'latest'}}}
            if launchable else None,
        }

    def cards(self) -> list[dict[str, Any]]:
        """The cards made from a skill, each at its current version."""
        return [card_view(record) for record in AgentCardStore(self.client, self.table).listing()]

    def card(self, card: str) -> dict[str, Any]:
        """A card made from a skill: its current version, every version (newest first) and who made each."""
        store = AgentCardStore(self.client, self.table)
        current = store.current_version(card)
        if not current:
            raise CardError(f'the Registry has no card {card}', 'not_found')
        return {'card': card_view(store.version(card, current)),
                'versions': [card_view(record) for record in store.versions(card)], 'events': store.events(card)}


#: Why a gate stops at a person (``quality_gate/gate.py``: each with the decision payload it sends), with its code and
#: the web app's text key (``agents:gates.stops.<code>``): the words beside it are the English (``{own_gate}``: the
#: repository's own gate's file, the bundle's).
GATE_STOPS: Final = (
    {'code': 'check_failed', 'decision': 'loop_exhausted', 'text': 'A check failed, and the fixes did not make it pass'},
    {'code': 'looked_at_nothing', 'decision': 'verification',
     'text': 'The gate looked at nothing: no check covers the repository, or a check found nothing to check'},
    {'code': 'own_gate_changed', 'decision': 'verification',
     'text': "The change touches the repository's own gate ({own_gate})"},
    {'code': 'review_blocked', 'decision': 'no_fail_path', 'text': 'A review blocked it: the final go said NO-GO'},
    {'code': 'rounds_used_up', 'decision': 'loop_exhausted',
     'text': 'Blocking findings were left after the last round'},
)


def looked_at_nothing(step: Mapping[str, Any]) -> str | None:
    """The step's vacuous-pass rule in words: how it fails when it checked nothing (None: an exit 0 passes)."""
    rules = []
    if step['empty_exit_codes']:
        codes = ', '.join(str(code) for code in step['empty_exit_codes'])
        rules.append(f'an exit {codes} says it found nothing to check, and fails')
    if step['expect_output']:
        rules.append(f'its output must show that it checked something (it matches {step["expect_output"]}), '
                     'else it fails')
    return '; '.join(rules) or None


def step_messages(step: Mapping[str, Any], words: Mapping[str, str]) -> list[dict[str, str]]:
    """What the gate record says of the step when it does not pass (``words``: the gate's own, the bundle's
    ``gates.messages``, which ``quality_gate/checks.py`` judge fills in)."""
    commands = [step['argv'], *(alternative['argv'] for alternative in step['prefer'])]
    tools = dict.fromkeys(command[0] for command in commands if command)
    messages = [{'status': 'missing_tool', 'reason': words['missing_tool'].format(tool=tool)} for tool in tools]
    messages.append({'status': 'timeout', 'reason': words['timeout'].format(timeout_s=step['timeout_s'])})
    messages += [{'status': 'empty', 'reason': words['empty_exit'].format(code=code)}
                 for code in step['empty_exit_codes']]
    if step['expect_output']:
        messages.append({'status': 'empty', 'reason': words['empty_output']})
    messages.append({'status': 'fail', 'reason': words['fail'].format(code='<code>')})
    if step['kind'] == 'setup':
        messages.append({'status': 'fail', 'reason': words['setup_failed'].format(setup=step['name']),
                         'of': 'later_steps'})
    return messages


def gates_view(gates: Mapping[str, Any]) -> dict[str, Any]:
    """The bundle's ``gates`` as the Quality gates view reads them: each pack's steps with their messages and their
    vacuous-pass rule, the gate's stop reasons, and who runs a gate that names nobody (``defaults``)."""
    words = gates['messages']
    packs = [{**pack, 'steps': [{**step, 'messages': step_messages(step, words),
                                 'looked_at_nothing': looked_at_nothing(step)} for step in pack['steps']]}
             for pack in gates['packs']]
    own_gate = str(gates['own_gate']['file'])
    return {'packs': packs, 'aliases': dict(gates['aliases']), 'own_gate': dict(gates['own_gate']),
            'briefs': [dict(brief) for brief in gates['briefs']], 'runners': sorted(GATE_ROLES),
            'defaults': dict(GATE_AGENT_DEFAULTS),
            'stops': [{**stop, 'text': stop['text'].format(own_gate=own_gate), 'text_key': f'gates.stops.{stop["code"]}',
                       'actions': _actions(stop['decision'])} for stop in GATE_STOPS]}


def _actions(reason: str) -> list[str]:
    """What a person may decide at a gate's stop (``agent_run_decisions.allowed_actions`` for the payload the gate
    sends: its rounds are a loop, so a ``loop_exhausted`` names one)."""
    payload = {'reason': reason, **({'loop_index': 0} if reason == REASON_LOOP_EXHAUSTED else {})}
    return allowed_actions({'status': RUN_NEEDS_HUMAN, 'needs_human': payload})


def _key(check: str) -> str:
    """A check's catalogue key: its id with each dot an underscore."""
    return check.replace('.', '_')


def args_schema(args: Iterable[str]) -> dict[str, Any]:
    """An assertion's arguments as a JSON Schema (each required; ``ARGUMENTS`` says what each takes)."""
    properties = {}
    for name in args:
        spec = dict(ARGUMENTS.get(name, {'type': 'text'}))
        kind = spec.pop('type')
        properties[name] = ({'type': 'string', 'enum': list(ENGINEERING_ROLES)} if kind == 'role'
                            else {'type': kind, **spec} if kind == 'integer' else {'type': 'string'})
    return {'type': 'object', 'additionalProperties': False, 'required': list(properties), 'properties': properties}


def assertions_view() -> dict[str, Any]:
    """The closed vocabulary of step assertions (``orchestration/assertions.py``): for each check what it asks, its
    catalogue keys, its arguments (and their JSON Schema), where it is checked and the ``on_fail`` each place takes
    (``shared/workflow_engineering.py``, the rules a save holds it to and the editor mirrors)."""
    from engineering.orchestration.assertions import DEFAULT_ON_FAIL, VOCABULARY

    checks = []
    for check, entry in VOCABULARY.items():
        places = list(assertion_places(check))
        on_fail = [choice for choice in ASSERTION_ON_FAIL
                   if choice != 'fail_arrow' or any(place in FAIL_ARROW_STEPS for place in places)]
        checks.append({'check': check, 'asks': entry.asks, 'label_key': f'assertions.checks.{_key(check)}.label',
                       'description_key': f'assertions.checks.{_key(check)}.description',
                       'args': [{'name': name, **ARGUMENTS.get(name, {'type': 'text'})} for name in entry.args],
                       'args_schema': args_schema(entry.args), 'kinds': places, 'on_fail': on_fail})
    return {'checks': checks,
            'on_fail': [{'id': choice, 'means': ON_FAIL[choice], 'kinds': list(FAIL_ARROW_STEPS)
                         if choice == 'fail_arrow' else None} for choice in ASSERTION_ON_FAIL],
            'default_on_fail': DEFAULT_ON_FAIL, 'max': MAX_ASSERTIONS, 'roles': list(ENGINEERING_ROLES)}
