"""The compiler: the orchestration templates in, one ``voc-orchestration-bundle/1`` out (``bundle.json``).

What it makes of each source (``schema.py`` reads them):

- ``agents/<role>/``: the card and its SKILL.md become one ``voc-skill/1`` record, exactly the shape the harness's
  ``Skill.to_record`` writes (``runtime/harness/skills.py``): everything above SKILL.md's ``## Examples`` is the
  ``instructions``, each example one ``{situation, action}``, and the card's ``tools``, ``model.id`` and ``harness``
  the ``tool_policy``, ``model`` and ``harness``. Its version is the card's template version, its label
  ``<role>@template-<version>``, its digest a sha256 of the card and the record (a skill version's
  ``template_digest``). Learn's card (``coach/``) has no record: the coach is never launched.
- ``flows/<id>.yaml``: a ``voc-workflow/2`` definition. A start step first, then the steps in order, each chaining to
  the next unless it ends the flow (``end``, ``stop_at_pr``) or says where its arrows go (a quality gate's
  ``on: {pass, fail}``); the flow's ``memory``, ``learn`` and ``pr`` go on the start step's params, each step's
  ``assert`` on its own params (``shared/workflow_engineering.py``). Positions are laid out at 120 px: the steps down
  one column, a step only a ``fail`` arrow reaches beside its gate.
- ``automations/<id>.yaml``: the agent body ``shared/agent_seed.py`` creates (what ``store.normalize_agent`` takes),
  with its seed marker, its flow and the flow's monthly budget.
- ``gates/<pack>/manifest.toml`` and ``evals/<flow>/cases/<case>/``: listed (packs with their images, the aliases,
  each case with its kind), so a reader needs no walk of the folder.

The output is deterministic (sources in a fixed order, JSON with one-space indents), so ``validate`` can hold the
committed ``bundle.json`` and its Lambda copy (``lambda/shared/orchestration_bundle.json``) to a fresh compile.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from engineering.orchestration.bundle import SCHEMA as BUNDLE_SCHEMA
from engineering.orchestration.schema import ROOT, SkillText, read_skill, read_yaml, relative
from engineering.quality_gate.packs import ALIASES, load_packs
from engineering.runtime.harness.skills import Example, Skill, skill_record
from shared.workflow_engineering import ENGINEERING_ROLES
from shared.workflow_schema import DEFAULT_WORKFLOW_ID, SCHEMA_V2

BUNDLE_FILE: Final = 'bundle.json'
#: The copy every Lambda that stages lambda/ ships (shared/engineering_templates.py, shared/agent_seed.py read it).
LAMBDA_COPY: Final = Path(__file__).resolve().parents[2] / 'shared' / 'orchestration_bundle.json'
NOTE: Final = ('GENERATED from voc-datalake/templates/orchestration by `npm run orchestration:compile`; do not edit. '
               '`npm run orchestration:validate` holds it, and its copy lambda/shared/orchestration_bundle.json, to a '
               'fresh compile.')
LEARN_CARD: Final = 'coach'
ROW: Final = 120
SIDE: Final = 280
STEP_KINDS: Final = ('agent', 'board', 'quality_gate', 'map', 'reduce', 'stop_at_pr', 'end')
TERMINAL: Final = frozenset({'stop_at_pr', 'end'})
#: The files a bundle is compiled from (its source digest covers them).
SOURCE_GLOBS: Final = ('_shared/*.md', 'agents/*/agent.yaml', 'agents/*/SKILL.md', 'automations/*.yaml',
                       'evals/*/cases/*/case.json', 'flows/*.yaml', 'gates/*/manifest.toml', 'schemas/*.schema.json')


@dataclass(frozen=True)
class Sources:
    """Every source, read: the cards and skills by role, the flows and automations by id, the platform rules."""

    root: Path
    cards: Mapping[str, Mapping[str, Any]]
    skills: Mapping[str, SkillText]
    flows: Mapping[str, Mapping[str, Any]]
    automations: Mapping[str, Mapping[str, Any]]
    platform_rules: str


def _by_id(paths: Iterable[Path], root: Path) -> dict[str, Mapping[str, Any]]:
    return {path.stem: read_yaml(path, root) for path in sorted(paths)}


def load(root: Path = ROOT) -> Sources:
    roles = sorted(path.name for path in (root / 'agents').iterdir() if path.is_dir())
    skills = {role: read_skill(root / 'agents' / role / 'SKILL.md', root)
              for role in roles if (root / 'agents' / role / 'SKILL.md').is_file()}
    return Sources(root=root, cards={role: read_yaml(root / 'agents' / role / 'agent.yaml', root) for role in roles},
                   skills=skills, flows=_by_id((root / 'flows').glob('*.yaml'), root),
                   automations=_by_id((root / 'automations').glob('*.yaml'), root),
                   platform_rules=(root / '_shared' / 'PLATFORM_RULES.md').read_text(encoding='utf-8'))


def digest(value: object) -> str:
    text = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    return f'sha256:{hashlib.sha256(text).hexdigest()}'


def source_digest(root: Path = ROOT) -> str:
    """A sha256 of every source file's path and bytes, in path order."""
    hashed = hashlib.sha256()
    for path in sorted({path for pattern in SOURCE_GLOBS for path in root.glob(pattern)}):
        hashed.update(relative(path, root).encode() + b'\0' + path.read_bytes() + b'\0')
    return f'sha256:{hashed.hexdigest()}'


def skill_of(card: Mapping[str, Any], skill: SkillText) -> Skill:
    """The role's ``voc-skill/1`` record as the harness's own class holds it (its checks run on construction)."""
    return Skill(name=str(card['id']), version=int(card['version']), instructions=skill.instructions,
                 examples=tuple(Example(situation, action) for _name, situation, action in skill.examples),
                 tool_policy=tuple(card['tools']), model=str(card['model']['id']), harness=str(card['harness']))


def _agent(card: Mapping[str, Any], skill: SkillText | None) -> dict[str, Any]:
    record = None if skill is None or card['harness'] == 'learn' else skill_record(
        str(card['id']), int(card['version']), skill_of(card, skill))
    fields = {'purpose': card['purpose'], 'harness': card['harness'], 'model': card['model']['id'],
              'tools': list(card['tools']), 'pending_tools': list(card.get('pending_tools', [])),
              'broker_ops': list(card['broker_ops']), 'pending_broker_ops': list(card.get('pending_broker_ops', [])),
              'caps': dict(card['caps']), 'trust': dict(card['trust']), 'inputs': list(card['inputs']),
              'outputs': list(card['outputs']), 'evals': list(card['evals'])}
    return {'id': card['id'], 'version': card['version'], 'label': f'{card["id"]}@template-{card["version"]}',
            'digest': digest({'card': fields, 'skill': record}), **fields, 'skill': record}


def role_order(roles: Iterable[str]) -> list[str]:
    """Roles in the agent catalog's order (shared/workflow_engineering.py ENGINEERING_ROLES: the coach, Learn's card,
    last)."""
    return sorted(roles, key=lambda role: (ENGINEERING_ROLES.index(role) if role in ENGINEERING_ROLES else 99, role))


def kind_of(step: Mapping[str, Any]) -> str:
    return next(kind for kind in STEP_KINDS if kind in step)


def skill_ref(reference: str) -> tuple[str, str]:
    """``hunter@latest`` → ``('hunter', 'latest')``."""
    role, _, version = reference.partition('@')
    return role, version


def _params(step: Mapping[str, Any]) -> dict[str, Any]:
    kind = kind_of(step)
    if kind == 'agent':
        role, version = skill_ref(str(step['agent']))
        params: dict[str, Any] = {'role': role, **({'skill_version': version} if version != 'latest' else {})}
        params.update({key: step[key] for key in ('model', 'budget_share') if key in step})
    elif kind == 'quality_gate':
        params = {key: value for key, value in step['quality_gate'].items() if key not in ('runner', 'final_go')}
    else:
        params = dict(step[kind])
    return {**params, **({'assert': [dict(item) for item in step['assert']]} if step.get('assert') else {})}


def _positions(steps: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, int]]:
    """Each step's place: down one column, a step only a gate's ``fail`` arrow reaches beside that gate."""
    beside = {str(step['on']['fail']): str(step['id']) for step in steps if 'on' in step}
    places: dict[str, dict[str, int]] = {'start': {'x': 0, 'y': 0}}
    row = 0
    for step in steps:
        if step['id'] in beside:
            continue
        row += 1
        places[str(step['id'])] = {'x': 0, 'y': ROW * row}
    for step_id, gate in beside.items():
        places[step_id] = {'x': SIDE, 'y': places[gate]['y'] + ROW}
    return places


def _edge(source: str, target: str, label: str = '') -> dict[str, str]:
    return {'id': f'{source}-{target}', 'source': source, 'target': target, **({'label': label} if label else {})}


def _edges(steps: Sequence[Mapping[str, Any]]) -> list[dict[str, str]]:
    edges = [_edge('start', str(steps[0]['id']))]
    for index, step in enumerate(steps):
        if 'on' in step:
            edges += [_edge(str(step['id']), str(step['on'][label]), label) for label in ('pass', 'fail')]
        elif kind_of(step) not in TERMINAL and index + 1 < len(steps):
            edges.append(_edge(str(step['id']), str(steps[index + 1]['id'])))
    return edges


def flow_settings(template: Mapping[str, Any]) -> dict[str, Any]:
    """The flow's own settings, as its start step's params carry them."""
    return {'memory': dict(template['memory']), 'learn': dict(template['learn']),
            **({'pr': template['pr']} if 'pr' in template else {})}


def definition(template: Mapping[str, Any]) -> dict[str, Any]:
    """The template's ``voc-workflow/2`` definition."""
    steps, places = list(template['steps']), _positions(template['steps'])
    start = {'id': 'start', 'type': 'start', 'position': places['start'],
             'data': {'title': 'Start', 'params': flow_settings(template)}}
    nodes = [start] + [{'id': step['id'], 'type': kind_of(step), 'position': places[str(step['id'])],
                        'data': {'title': step['title'],
                                 **({'instructions': step['instructions']} if 'instructions' in step else {}),
                                 'params': _params(step)}} for step in steps]
    return {'schema': SCHEMA_V2, 'name': template['name'], 'description': template['description'], 'nodes': nodes,
            'edges': _edges(steps), 'loops': [], 'budget': {'monthly_usd': template['budget']['monthly_usd']}}


def step_skills(template: Mapping[str, Any]) -> dict[str, str]:
    """Each step's skill reference: an agent step's own, a board's claimers' (``<step>.<role>``, the latest), a gate's
    runner and final go (``<step>.runner``, ``<step>.final_go``)."""
    skills: dict[str, str] = {}
    for step in template['steps']:
        if 'agent' in step:
            skills[str(step['id'])] = str(step['agent'])
        for role in step.get('board', {}).get('claimers', []):
            skills[f'{step["id"]}.{role}'] = f'{role}@latest'
        if 'quality_gate' in step:
            gate = step['quality_gate']
            skills.update({f'{step["id"]}.runner': gate['runner'], f'{step["id"]}.final_go': gate['final_go']})
    return skills


def eval_cases(root: Path = ROOT) -> list[dict[str, str]]:
    """Every eval case: its flow, its id and its kind (a voc-bench/1 record's, or ``triage``)."""
    cases = []
    for path in sorted((root / 'evals').glob('*/cases/*/case.json')):
        record = json.loads(path.read_text(encoding='utf-8'))
        kind = 'triage' if record.get('schema') == 'voc-triage-case/1' else str(record.get('kind'))
        cases.append({'flow': path.parents[2].name, 'id': path.parent.name, 'kind': kind})
    return cases


def _flow(template: Mapping[str, Any], cases: Sequence[Mapping[str, str]]) -> dict[str, Any]:
    return {'template_id': template['id'], 'version': template['version'], 'name': template['name'],
            'description': template['description'], 'budget': dict(template['budget']),
            'memory': dict(template['memory']), 'learn': dict(template['learn']), 'pr': template.get('pr'),
            'requires': dict(template['requires']), 'inputs': dict(template.get('inputs', {})),
            'skills': step_skills(template),
            'evals': [f'{case["flow"]}/{case["id"]}' for case in cases if case['flow'] == template['id']],
            'definition': definition(template)}


#: The agent body's fields, in the order agent_seed's bodies have always had them.
BODY_FIELDS: Final = ('name', 'description', 'enabled', 'scope', 'instructions', 'personas', 'triggers', 'models',
                      'output', 'budget', 'engineering')


def agent_body(automation: Mapping[str, Any]) -> dict[str, Any]:
    """The agent body agent_seed creates: the automation's own fields, the flow's monthly budget left to the flow (an
    agent with nothing else in its budget has no ``budget`` field: the store's defaults apply)."""
    body = {name: automation[name] for name in BODY_FIELDS if name in automation}
    budget = {key: value for key, value in automation['budget'].items() if key != 'monthly_usd'}
    if budget:
        body['budget'] = budget
    else:
        body.pop('budget', None)
    return body


def requires_triage(automation: Mapping[str, Any]) -> str | None:
    """The triage kind an automation's issue trigger requires (``requires_triage`` on its ``github_issue`` trigger,
    where the heartbeat reads it); None when it requires none."""
    return next((str(trigger['requires_triage']) for trigger in automation['triggers']
                 if trigger.get('kind') == 'github_issue' and trigger.get('requires_triage')), None)


def _automation(automation: Mapping[str, Any]) -> dict[str, Any]:
    return {'id': automation['id'], 'version': automation['version'], 'name': automation['name'],
            'seed_marker': dict(automation['seed_marker']), 'flow': automation['flow'],
            'monthly_budget_usd': automation['budget'].get('monthly_usd'),
            'requires_triage': requires_triage(automation), 'learn': automation.get('learn'),
            'pr': automation.get('pr'), 'readiness': list(automation['readiness']), 'body': agent_body(automation)}


def _gates(root: Path) -> dict[str, Any]:
    packs = load_packs(root / 'gates')
    return {'packs': [{'id': pack.id, 'name': pack.name, 'languages': [language.id for language in pack.languages],
                       'image': dict(pack.needs.image), 'network': list(pack.needs.network)} for pack in packs],
            'aliases': {alias: list(packs_of) for alias, packs_of in ALIASES.items()}}


def compile_bundle(sources: Sources) -> dict[str, Any]:
    """The bundle of ``sources`` (valid ones: ``validate.py`` checks them first)."""
    cases = eval_cases(sources.root)
    return {
        'schema': BUNDLE_SCHEMA, 'note': NOTE, 'source_digest': source_digest(sources.root),
        'platform_rules': {'text': sources.platform_rules, 'digest': digest(sources.platform_rules.encode())},
        'agents': [_agent(sources.cards[role], sources.skills.get(role)) for role in role_order(sources.cards)],
        'flows': [_flow(sources.flows[flow_id], cases) for flow_id in FLOW_ORDER if flow_id in sources.flows]
        + [_flow(template, cases) for flow_id, template in sources.flows.items() if flow_id not in FLOW_ORDER],
        'automations': [_automation(sources.automations[name]) for name in sorted(sources.automations)],
        'gates': _gates(sources.root), 'evals': cases,
    }


#: The flows in the docs' order (docs/autonomous-engineering.md "Default flows"): the order the library lists them in.
FLOW_ORDER: Final = ('understand-repository', 'issue-triage', 'bug-hunt-and-fix', 'feature', 'pr-review')
#: The built-in agents workflow an automation may name instead of an engineering flow.
BUILTIN_FLOWS: Final = frozenset({DEFAULT_WORKFLOW_ID})


def render(bundle: Mapping[str, Any]) -> str:
    return json.dumps(bundle, indent=1, ensure_ascii=False) + '\n'


def outputs(root: Path = ROOT) -> tuple[Path, Path]:
    """Where the bundle goes: beside its sources, and the Lambdas' copy (for a copy of the folder elsewhere, a test's,
    both beside it)."""
    return root / BUNDLE_FILE, LAMBDA_COPY if root == ROOT else root / LAMBDA_COPY.name


def write(text: str, root: Path = ROOT) -> tuple[Path, ...]:
    """Write ``text`` to every output whose content differs; the ones written."""
    written = []
    for path in outputs(root):
        if not path.is_file() or path.read_text(encoding='utf-8') != text:
            path.write_text(text, encoding='utf-8')
            written.append(path)
    return tuple(written)
