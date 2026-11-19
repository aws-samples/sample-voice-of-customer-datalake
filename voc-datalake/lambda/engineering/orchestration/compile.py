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
  one column, a step only a ``fail`` arrow reaches beside its gate. Since 7.52.00 the flow's ``inputs`` are the
  definition's own (``definition.inputs``), and a quality gate keeps who runs it on its params (``runner``,
  ``final_go``).
- ``automations/<id>.yaml``: the agent body ``shared/agent_seed.py`` creates (what ``store.normalize_agent`` takes),
  with its seed marker, its flow and the flow's monthly budget.
- ``gates/<pack>/manifest.toml`` and ``evals/<flow>/cases/<case>/``: listed (packs with their images, the aliases,
  each case with its kind), so a reader needs no walk of the folder. Since 7.52.00 each pack also carries its pinned
  tools and its steps (every field of the manifest's), and ``gates.briefs`` the owner's briefs
  (``gates/briefs/<id>.md``: the packs each is the source of truth for, its text and its digest), with the
  repository's own gate (``own_gate``): what the Registry's Quality gates view shows, from the Lambdas' copy.
- ``skills/<name>/`` (7.56.00, the skills library): ``library``, by name, each skill's front matter, its SKILL.md's
  text, its ``references/<file>.md`` and the roles whose cards name it (``library_entry``); each agent's ``skills``
  (its card's, in the digest only when it names any). A Kiro config's prompt lists the role's skills when its tools
  have ``read_skill``, as the harness's system prompt does (``library_tools.with_library``).
- ``sources`` (7.52.00): each template's source text, a role's ``SKILL.md`` and ``agent.yaml`` and each flow's YAML,
  with its path, digest and template version (``template_sources``): the app's read-only source view.

Beside the bundle, one Kiro CLI agent config per launchable role, ``kiro-agents/<role>.json`` (Kiro's v3 universal
agent JSON), the base the Kiro harness writes a session's agent from (7.53.00, ``runtime/harness/kiro.py``
``session_agent``; the images ship the folder). Its prompt is the platform rules and then the role's skill, as the
harness's system prompt puts them (``converse_loop.system_prompt``, less the session's fence line: a template has no
session). Its tools are the card's, every one the platform's own, from the harness's tool server, ``@voc``, started as
the CLI adapter starts it (``cli.TOOL_SERVER``): no Kiro builtin (``read``, ``write``, ``shell``, ...) is offered, so a
read stays the checkout's, a write the walled workspace's, and a command the sandbox runner's, as on every harness.
Each of the card's tools is allowed without asking; anything else asks the harness, which refuses it.

The output is deterministic (sources in a fixed order, JSON with one-space indents, a Kiro config with two), so
``validate`` can hold the committed ``bundle.json``, its Lambda copy (``lambda/shared/orchestration_bundle.json``) and
``kiro-agents/`` to a fresh compile.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

from engineering.orchestration.bundle import SCHEMA as BUNDLE_SCHEMA
from engineering.orchestration.schema import (
    LIBRARY,
    ROOT,
    LibrarySkill,
    SkillText,
    read_library_skill,
    read_skill,
    read_yaml,
    relative,
)
from engineering.quality_gate.packs import (
    ALIASES,
    EMPTY_EXIT,
    EMPTY_OUTPUT,
    FAILED,
    MISSING_TOOL,
    OWN_GATE_ARGV,
    OWN_GATE_FILE,
    OWN_GATE_TIMEOUT_S,
    SETUP_FAILED,
    STOPS,
    TIMED_OUT,
    Condition,
    Step,
    load_packs,
)
from engineering.runtime.harness.cli import TOOL_SERVER
from engineering.runtime.harness.kiro_pin import kiro_model
from engineering.runtime.harness.library_tools import with_library
from engineering.runtime.harness.skills import Example, Skill, skill_record
from engineering.runtime.harness.tool_server import SERVER_NAME
from engineering.runtime.harness.tools import role_specs
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
                       'evals/*/cases/*/case.json', 'flows/*.yaml', 'gates/*/manifest.toml', 'gates/briefs/*.md',
                       'schemas/*.schema.json', f'{LIBRARY}/*/SKILL.md', f'{LIBRARY}/*/references/*.md')
#: The briefs' folder also holds the notes that reconcile each pack with its brief: not a brief.
BRIEF_NOTES: Final = 'RECONCILIATION'


@dataclass(frozen=True)
class Sources:
    """Every source, read: the cards and skills by role, the flows and automations by id, the platform rules and
    (7.56.00) the skills library by name."""

    root: Path
    cards: Mapping[str, Mapping[str, Any]]
    skills: Mapping[str, SkillText]
    flows: Mapping[str, Mapping[str, Any]]
    automations: Mapping[str, Mapping[str, Any]]
    platform_rules: str
    library: Mapping[str, LibrarySkill] = field(default_factory=dict)


def _by_id(paths: Iterable[Path], root: Path) -> dict[str, Mapping[str, Any]]:
    return {path.stem: read_yaml(path, root) for path in sorted(paths)}


def load(root: Path = ROOT) -> Sources:
    roles = sorted(path.name for path in (root / 'agents').iterdir() if path.is_dir())
    skills = {role: read_skill(root / 'agents' / role / 'SKILL.md', root)
              for role in roles if (root / 'agents' / role / 'SKILL.md').is_file()}
    folders = sorted(path for path in (root / LIBRARY).glob('*') if path.is_dir()) if (root / LIBRARY).is_dir() else []
    return Sources(root=root, cards={role: read_yaml(root / 'agents' / role / 'agent.yaml', root) for role in roles},
                   skills=skills, flows=_by_id((root / 'flows').glob('*.yaml'), root),
                   automations=_by_id((root / 'automations').glob('*.yaml'), root),
                   platform_rules=(root / '_shared' / 'PLATFORM_RULES.md').read_text(encoding='utf-8'),
                   library={folder.name: read_library_skill(folder, root) for folder in folders})


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
    # (7.56.00: the library skills the card names; in the digest only when it names any, so a card without skills keeps
    # the digest its template version always had)
    skills = list(card.get('skills', []))
    # (7.58.00: the card's model choice, beside its model; likewise only when it names one)
    choice = {'model_choice': card_choice(card)} if card_choice(card) else {}
    fields.update(choice)
    digested = {**fields, **({'skills': skills} if skills else {})}
    # (7.52.00: every tool the role may have, for a Registry card's check; outside the digest, which is the template's)
    allowed = sorted(spec.name for spec in role_specs(str(card['id'])))
    return {'id': card['id'], 'version': card['version'], 'label': f'{card["id"]}@template-{card["version"]}',
            'digest': digest({'card': digested, 'skill': record}), **fields, 'skills': skills,
            'allowed_tools': allowed, 'skill': record}


def library_entry(skill: LibrarySkill, cards: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """A library skill as the bundle carries it (7.56.00): its front matter, its SKILL.md's text (front matter
    included), its reference files, and the roles whose cards name it, in the catalog's order."""
    def text_of(text: str) -> dict[str, Any]:
        raw = text.encode()
        return {'digest': digest(raw), 'bytes': len(raw), 'text': text}

    head = skill.front_matter
    return {'name': skill.name, **{key: str(head[key]) for key in ('description', 'source', 'license', 'adapted')},
            'path': f'{LIBRARY}/{skill.name}/SKILL.md', **text_of(skill.text),
            'roles': [role for role in role_order(cards) if skill.name in cards[role].get('skills', [])],
            'references': [{'path': path, **text_of(text)} for path, text in skill.references]}


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
        # (7.52.00: who runs it stays on the step, ``runner`` and ``final_go``, as the stored flow names it)
        params = dict(step['quality_gate'])
    else:
        params = dict(step[kind])
    # (7.51.00: the most agents of the step at once, which the board's launch holds)
    params.update({'max_parallel': step['max_parallel']} if 'max_parallel' in step else {})
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
            'edges': _edges(steps), 'loops': [], 'budget': {'monthly_usd': template['budget']['monthly_usd']},
            # (7.52.00: what a run of it takes, and what a call of it may name)
            **({'inputs': {name: dict(spec) for name, spec in template['inputs'].items()}}
               if template.get('inputs') else {})}


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


def _condition(condition: Condition) -> dict[str, str]:
    return {key: value for key, value in (('file', condition.file), ('glob', condition.glob),
                                          ('absent', condition.absent), ('contains', condition.contains),
                                          ('npm_script', condition.npm_script)) if value}


def _step(step: Step) -> dict[str, Any]:
    """A pack step as the Registry's Quality gates view reads it (the manifest's, every field)."""
    return {'id': step.id, 'language': step.language, 'name': step.name, 'kind': step.kind, 'argv': list(step.argv),
            'timeout_s': step.timeout_s, 'when_any': [_condition(condition) for condition in step.when_any],
            'prefer': [{'when': [_condition(condition) for condition in alternative.when],
                        'argv': list(alternative.argv)} for alternative in step.prefer],
            'empty_exit_codes': sorted(step.empty_exit_codes), 'expect_output': step.expect_output}


def brief_packs(brief_id: str) -> tuple[str, ...]:
    """The packs a brief is the source of truth for: an alias's two (``python-ts``), else the pack of its name."""
    return ALIASES.get(brief_id, (brief_id,))


def gate_briefs(root: Path = ROOT) -> list[dict[str, Any]]:
    """The owner's quality-gate briefs (``gates/briefs/<id>.md``, the RECONCILIATION notes aside), each with the packs
    it is the source of truth for, its digest and its text (7.52.00: the Registry's Quality gates view)."""
    briefs = []
    for path in sorted((root / 'gates' / 'briefs').glob('*.md')):
        if path.stem == BRIEF_NOTES:
            continue
        text = path.read_text(encoding='utf-8')
        briefs.append({'id': path.stem, 'path': relative(path, root), 'packs': list(brief_packs(path.stem)),
                       'digest': digest(text.encode()), 'bytes': len(text.encode()), 'text': text})
    return briefs


def _gates(root: Path) -> dict[str, Any]:
    packs = load_packs(root / 'gates')
    briefs = gate_briefs(root)
    return {'packs': [{'id': pack.id, 'name': pack.name, 'languages': [language.id for language in pack.languages],
                       'image': dict(pack.needs.image), 'network': list(pack.needs.network),
                       'tools': [{'name': tool.name, 'version_argv': list(tool.version_argv)}
                                 for tool in pack.needs.tools],
                       'steps': [_step(step) for step in pack.steps],
                       'briefs': [brief['id'] for brief in briefs if pack.id in brief['packs']]} for pack in packs],
            'aliases': {alias: list(packs_of) for alias, packs_of in ALIASES.items()},
            'own_gate': {'file': OWN_GATE_FILE, 'argv': list(OWN_GATE_ARGV), 'timeout_s': OWN_GATE_TIMEOUT_S},
            'messages': dict(GATE_MESSAGES), 'stops': dict(STOPS), 'briefs': briefs}


#: What the gate record says of a check that did not pass, by what happened (the gate's own words, packs.py, which
#: ``checks.judge`` fills in): the Registry's Quality gates view reads them from the bundle.
GATE_MESSAGES: Final = {'missing_tool': MISSING_TOOL, 'timeout': TIMED_OUT, 'empty_exit': EMPTY_EXIT,
                        'empty_output': EMPTY_OUTPUT, 'fail': FAILED, 'setup_failed': SETUP_FAILED}


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
        'gates': _gates(sources.root), 'evals': cases, 'sources': template_sources(sources),
        # (7.56.00: the skills library, by name)
        'library': [library_entry(sources.library[name], sources.cards) for name in sorted(sources.library)],
    }


def template_sources(sources: Sources) -> list[dict[str, Any]]:
    """Each template's source text, as the repository holds it (7.52.00: the app's read-only source view): every
    role's SKILL.md (``skill``) and agent.yaml (``card``), with its card's version, and every flow's YAML, with its
    template version, in the bundle's order. A gate brief's text is ``gates.briefs``'."""
    def entry(kind: str, ident: str, path: Path, version: object) -> dict[str, Any]:
        raw = path.read_bytes()
        return {'kind': kind, 'id': ident, 'path': relative(path, sources.root), 'text': raw.decode('utf-8'),
                'digest': digest(raw), 'template_version': int(str(version))}

    found = []
    for role in role_order(sources.cards):
        folder = sources.root / 'agents' / role
        version = sources.cards[role]['version']
        if (folder / 'SKILL.md').is_file():
            found.append(entry('skill', role, folder / 'SKILL.md', version))
        found.append(entry('card', role, folder / 'agent.yaml', version))
    order = [*(flow for flow in FLOW_ORDER if flow in sources.flows), *(f for f in sources.flows if f not in FLOW_ORDER)]
    found += [entry('flow', flow, sources.root / 'flows' / f'{flow}.yaml', sources.flows[flow]['version'])
              for flow in order]
    return found


#: The flows in the docs' order (docs/autonomous-engineering.md "Default flows"): the order the library lists them in.
FLOW_ORDER: Final = ('understand-repository', 'tenets', 'issue-triage', 'bug-hunt-and-fix', 'feature', 'pr-review')
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


#: The Kiro CLI agent configs' folder, beside the bundle: ``<role>.json`` per launchable role.
KIRO_DIR: Final = 'kiro-agents'
#: What a Kiro agent config offers: the harness's tool server only (``@<SERVER_NAME>``), never a Kiro builtin (``read``,
#: ``write``, ``shell``, ``grep``, ``glob``, ``web_*``, ``subagent``, ``@builtin``): kiro-cli's V3 engine reads and writes
#: outside its workspace without asking (scripts/ai-review/lib.mjs), and a builtin command would run as the agent, not
#: as the sandbox's ``code``. 7.53.00 closed the prep's three gaps so: no builtin read, no checkout as the working
#: directory, the skills' own tool names.
KIRO_TOOLS: Final = (f'@{SERVER_NAME}',)


def kiro_tools(card: Mapping[str, Any]) -> list[str]:
    """The card's tools as Kiro reaches them: every one the platform's, from its tool server (``@voc/<tool>``)."""
    return [str(tool) for tool in card['tools']]


def kiro_prompt(platform_rules: str, skill: Skill, library: Sequence[Mapping[str, Any]] = ()) -> str:
    """The platform rules, then the skill's instructions and examples, then (7.56.00) the role's library skills by
    name and description when its tools have ``read_skill``: the harness's system prompt
    (``converse_loop.system_prompt``) without the session's fence line, which only a session has."""
    return with_library(f'{platform_rules.strip()}\n\n{skill.system_prompt()}', skill.tool_policy, library)


def role_library(card: Mapping[str, Any], library: Mapping[str, LibrarySkill]) -> list[dict[str, str]]:
    """The library skills ``card`` names, in its order, each its name and description (what the prompt lists)."""
    return [{'name': name, 'description': str(library[name].front_matter.get('description', ''))}
            for name in card.get('skills', []) if name in library]


def kiro_agent(card: Mapping[str, Any], skill: SkillText, platform_rules: str,
               library: Sequence[Mapping[str, Any]] = ()) -> dict[str, Any]:
    """The role's Kiro agent config (v3 universal: ``tools`` and ``allowedTools`` for one engine, ``permissions`` for
    the other): the harness's tool server alone, each of the card's tools allowed without asking (an ``mcp`` allow
    rule, its match sorted, as ``kiro-cli agent upgrade`` derives it from ``allowedTools``), and nothing else allowed.
    No ``kiroUpgrade`` marker: it is machine-specific (scripts/ai-review/agent-guard.mjs).
    Its ``model`` (7.58.00) is the Kiro model of the card's (``card_kiro_model``), so the agent pins it before the
    session sets it."""
    platform = kiro_tools(card)
    model = card_kiro_model(card)
    return {'name': card['id'], 'description': card['purpose'], **({'model': model} if model else {}),
            'prompt': kiro_prompt(platform_rules, skill_of(card, skill), library),
            'tools': list(KIRO_TOOLS),
            'allowedTools': [f'@{SERVER_NAME}/{tool}' for tool in platform],
            'mcpServers': {SERVER_NAME: {'command': TOOL_SERVER[0], 'args': list(TOOL_SERVER[1:])}},
            'resources': [],
            'permissions': {'rules': [{'capability': 'mcp', 'match': sorted(f'{SERVER_NAME}/{tool}' for tool in platform),
                                       'effect': 'allow'}]}}


def card_kiro_model(card: Mapping[str, Any]) -> str | None:
    """The model a card's role runs on Kiro (``kiro_pin.kiro_model``): its model choice's, else Kiro's name for its
    ``model.id``; None when Kiro has no name for it."""
    choice = card_choice(card)
    return kiro_model(choice, chosen=True) if choice else kiro_model(str(card['model']['id']))


def card_choice(card: Mapping[str, Any]) -> str:
    """A card's model choice (7.58.00): its ``model.choice`` or ``model.other`` (the schema allows one at most), ''
    for none."""
    model = card.get('model')
    found = (model.get('choice') or model.get('other')) if isinstance(model, Mapping) else None
    return str(found) if isinstance(found, str) else ''


def kiro_files(sources: Sources) -> dict[str, str]:
    """Every launchable role's Kiro agent config, rendered, by file name (the coach is never launched: none)."""
    return {f'{role}.json': json.dumps(kiro_agent(sources.cards[role], sources.skills[role], sources.platform_rules,
                                                  role_library(sources.cards[role], sources.library)),
                                       indent=2, ensure_ascii=False) + '\n'
            for role in role_order(sources.cards)
            if sources.cards[role]['harness'] != 'learn' and role in sources.skills}


def write_kiro_agents(files: Mapping[str, str], root: Path = ROOT) -> tuple[Path, ...]:
    """Write each config whose content differs and remove any other ``*.json`` there; the files written or removed."""
    folder = root / KIRO_DIR
    folder.mkdir(exist_ok=True)
    changed = []
    for name, text in files.items():
        path = folder / name
        if not path.is_file() or path.read_text(encoding='utf-8') != text:
            path.write_text(text, encoding='utf-8')
            changed.append(path)
    for path in sorted(folder.glob('*.json')):
        if path.name not in files:
            path.unlink()
            changed.append(path)
    return tuple(changed)
