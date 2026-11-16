"""``npm run orchestration:validate``: every check the templates must pass before they compile or ship.

Each check answers a list of problems (``<file>: <what is wrong>``); the command fails on any. In order:

- every source follows its schema (cards, SKILL.md front matter, flows, automations), and the schemas' assertion
  vocabulary is ``assertions.VOCABULARY``;
- every role of the agent catalog has its card; a launchable role's SKILL.md has its sections in order
  (``schema.REQUIRED_SECTIONS``), its front matter names its directory, its card's role and template version, and the
  tools it names are its card's (``tools`` or ``pending_tools``);
- a card's tools are among the harness's ``role_specs(role)``, and none it lists as pending is there yet (then it
  moves into ``tools``); its broker operations are ``read`` and what the broker lets its role write
  (``broker.permitted``), likewise; its model, and every model a flow names, is in ``ALLOWED_MODEL_IDS``;
- every flow's steps name roles with a card, its gate packs exist, its arrows go to steps it has, a flow with a pull
  request says how it opens (``pr``), Learn's roles are roles the flow runs; every eval case a card names exists, and
  every case loads (``benchmark.cases.load_case`` for voc-bench/1; a triage case's kind, severity, fixture and paths);
- every assertion is of the vocabulary with its arguments; every compiled flow is valid under
  ``shared.workflow_schema`` and kept as written;
- every automation names a flow there is, a budget above 0 for an engineering one, and every readiness check its
  flow and triggers need;
- no placeholder is left in a source (``TODO``, ``TBD``, ``FIXME``, ``XXX``, ``<LIKE_THIS>``);
- ``bundle.json`` and its Lambda copy are exactly the compile's output.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any, Final

from engineering.benchmark.cases import BenchmarkError, load_case
from engineering.connectors.broker import permitted
from engineering.connectors.identity import AGENT_ROLES
from engineering.orchestration import assertions
from engineering.orchestration.assertions import SEVERITY, TRIAGE_KINDS
from engineering.orchestration.compile import (
    BUILTIN_FLOWS,
    LAMBDA_COPY,
    LEARN_CARD,
    Sources,
    compile_bundle,
    eval_cases,
    kind_of,
    load,
    outputs,
    render,
    skill_ref,
)
from engineering.orchestration.schema import EXAMPLES, REQUIRED_SECTIONS, ROOT, TemplateError, errors, relative, schema
from engineering.quality_gate.packs import PackError, load_packs
from engineering.runtime.harness.skills import SkillError
from engineering.runtime.harness.tools import role_specs
from shared.model_config import ALLOWED_MODEL_IDS
from shared.workflow_schema import validate_definition

#: The readiness checks every engineering automation needs, and those its flow's ``requires`` and its triggers add.
BASE_READINESS: Final = frozenset({'connection', 'app_installation', 'image', 'bedrock_models', 'agentcore_quota',
                                   'network', 'session_storage', 'budget', 'hard_cap'})
PLACEHOLDER: Final = re.compile(r'\b(?:TODO|TBD|FIXME|XXX)\b|<[A-Z][A-Z0-9_]{2,}>')
#: The sources a placeholder is looked for in (the owner's gate briefs keep their own ``<LIKE_THIS>`` on purpose).
PLACEHOLDER_GLOBS: Final = ('README.md', '_shared/*.md', 'agents/*/*', 'flows/*.yaml', 'automations/*.yaml',
                            'gates/*/manifest.toml', 'gates/README.md', 'gates/briefs/RECONCILIATION.md',
                            'evals/README.md', 'evals/*/cases/*/case.json')
_TOOL_NAME: Final = re.compile(r'`([a-z][a-z_]+)`')

Problems = list[str]


def _schema_problems(sources: Sources) -> Problems:
    found = [f'agents/{role}/agent.yaml: {error}' for role, card in sources.cards.items()
             for error in errors('agent-card', card, sources.root)]
    found += [f'agents/{role}/SKILL.md front matter: {error}' for role, skill in sources.skills.items()
              for error in errors('skill-frontmatter', dict(skill.front_matter), sources.root)]
    found += [f'flows/{name}.yaml: {error}' for name, flow in sources.flows.items()
              for error in errors('flow', flow, sources.root)]
    found += [f'automations/{name}.yaml: {error}' for name, automation in sources.automations.items()
              for error in errors('automation', automation, sources.root)]
    listed = schema('assertion', sources.root)['properties']['check']['enum']
    if sorted(listed) != sorted(assertions.VOCABULARY):
        found.append('schemas/assertion.schema.json: its check enum is not assertions.VOCABULARY')
    return found


def _tool_vocabulary(sources: Sources) -> frozenset[str]:
    """Every tool name a skill might mean: any role's harness tools, and every card's pending ones."""
    return frozenset({spec.name for role in AGENT_ROLES for spec in role_specs(role)}
                     | {tool for card in sources.cards.values() for tool in card.get('pending_tools', [])})


def _skill_problems(sources: Sources) -> Problems:
    found = []
    vocabulary = _tool_vocabulary(sources)
    for role, card in sources.cards.items():
        where = f'agents/{role}/SKILL.md'
        skill = sources.skills.get(role)
        if card.get('harness') == 'learn':
            continue
        if skill is None:
            found.append(f'{where}: a launchable role has its SKILL.md')
            continue
        titles = [title for title, _ in skill.sections]
        if titles != list(REQUIRED_SECTIONS):
            found.append(f'{where}: its sections are {", ".join(REQUIRED_SECTIONS)}, in that order (has: '
                         f'{", ".join(titles)})')
        if not skill.examples:
            found.append(f'{where}: its {EXAMPLES} holds at least one "### <name>" with **When:** and **Do:**')
        head, meta = skill.front_matter, skill.front_matter.get('metadata', {})
        if (head.get('name'), meta.get('voc-role'), meta.get('voc-template-version')) != (role, role, card['version']):
            found.append(f'{where}: its name and metadata name the role {role} and its card\'s version {card["version"]}')
        named = {name for name in _TOOL_NAME.findall(skill.instructions + ' '.join(
            f'{s} {a}' for _n, s, a in skill.examples)) if name in vocabulary}
        stray = sorted(named - set(card['tools']) - set(card.get('pending_tools', [])))
        if stray:
            found.append(f'{where}: names tools its card does not list: {", ".join(stray)}')
    return found


def _card_problems(sources: Sources) -> Problems:
    found = [f'agents/{role}/: a role of the agent catalog has its card' for role in sorted(AGENT_ROLES - set(sources.cards))]
    found += [f'agents/{role}/: not a role of the agent catalog' for role in sorted(set(sources.cards) - AGENT_ROLES)]
    cases = {f'{case["flow"]}/{case["id"]}' for case in eval_cases(sources.root)}
    for role, card in sources.cards.items():
        where = f'agents/{role}/agent.yaml'
        if card.get('id') != role:
            found.append(f'{where}: its id is its directory\'s name')
        if role == LEARN_CARD:
            continue
        offered = {spec.name for spec in role_specs(role)}
        found += [f'{where}: the harness offers role {role} no tool {tool}' for tool in card['tools'] if tool not in offered]
        found += [f'{where}: the harness offers {tool} now: move it from pending_tools into tools'
                  for tool in card.get('pending_tools', []) if tool in offered]
        found += [f'{where}: the broker lets role {role} make no {op}' for op in card['broker_ops']
                  if op != 'read' and not permitted(role, op)]
        found += [f'{where}: the broker lets role {role} make {op} now: move it into broker_ops'
                  for op in card.get('pending_broker_ops', []) if permitted(role, op)]
        found += [f'{where}: no eval case {case}' for case in card['evals'] if case not in cases]
    found += [f'agents/{role}/agent.yaml: model {card["model"]["id"]} is not in ALLOWED_MODEL_IDS'
              for role, card in sources.cards.items() if card['model']['id'] not in ALLOWED_MODEL_IDS]
    return found


def _flow_roles(flow: Mapping[str, Any]) -> set[str]:
    roles = set()
    for step in flow['steps']:
        if 'agent' in step:
            roles.add(skill_ref(step['agent'])[0])
        roles |= set(step.get('board', {}).get('posters', [])) | set(step.get('board', {}).get('claimers', []))
        if 'quality_gate' in step:
            roles |= {skill_ref(step['quality_gate'][key])[0] for key in ('runner', 'final_go')}
    return roles


def _assertion_problems(where: str, raw: Iterable[Any]) -> Problems:
    return [f'{where}: {problem}' for item in raw for problem in assertions.problems(item)]


def _flow_problems(sources: Sources, packs: frozenset[str]) -> Problems:
    found = []
    for name, flow in sources.flows.items():
        where = f'flows/{name}.yaml'
        if flow['id'] != name:
            found.append(f'{where}: its id is its file\'s name')
        ids = [str(step['id']) for step in flow['steps']]
        found += [f'{where}: the step id {step_id} is used twice' for step_id in sorted({i for i in ids if ids.count(i) > 1})]
        roles = _flow_roles(flow)
        found += [f'{where}: no card for role {role}' for role in sorted(roles - set(sources.cards))]
        for step in flow['steps']:
            found += [f'{where}: step {step["id"]} sends its {label} arrow to {target}, which the flow has not'
                      for label, target in step.get('on', {}).items() if target not in ids]
            gate_packs = step.get('quality_gate', {}).get('packs', 'auto')
            found += [f'{where}: no gate pack {pack}' for pack in ([] if gate_packs == 'auto' else gate_packs)
                      if pack not in packs]
            found += _assertion_problems(f'{where} step {step["id"]}', step.get('assert', []))
        found += _assertion_problems(f'{where} learn', flow['learn'].get('assert', []))
        found += [f'{where}: learn names {role}, which the flow does not run'
                  for role in flow['learn'].get('roles', []) if role not in roles]
        if any(kind_of(step) == 'stop_at_pr' for step in flow['steps']) and 'pr' not in flow:
            found.append(f'{where}: a flow that stops at a pull request says how it opens (pr: ready or draft)')
        models = [flow['learn'].get('model')] + [step.get('model') for step in flow['steps']]
        found += [f'{where}: model {model} is not in ALLOWED_MODEL_IDS' for model in models
                  if model is not None and model not in ALLOWED_MODEL_IDS]
    return found


def _compiled_problems(bundle: Mapping[str, Any]) -> Problems:
    found = []
    for flow in bundle['flows']:
        result = validate_definition(flow['definition'])
        if not result.valid:
            found += [f'flows/{flow["template_id"]}.yaml compiled: {issue.message}' + (
                f' ({issue.node_id})' if issue.node_id else '') for issue in result.errors]
        elif result.definition != flow['definition']:
            found.append(f'flows/{flow["template_id"]}.yaml compiled: the server would not keep it as written')
    return found


def readiness_needed(automation: Mapping[str, Any], flow: Mapping[str, Any] | None) -> frozenset[str]:
    """The readiness checks an automation needs: none for the agents' own workflow; for an engineering one, the base
    set, and what its flow's ``requires`` and its triggers add."""
    if flow is None:
        return frozenset()
    requires, kinds = flow.get('requires', {}), {trigger.get('kind') for trigger in automation['triggers']}
    return BASE_READINESS | {name for name, on in (
        ('dial', bool(requires.get('dial'))), ('ci_attestation', bool(requires.get('ci_attestation'))),
        ('branch_rules', bool(requires.get('ci_attestation'))),
        ('issues_source', bool(requires.get('issues_source')) or 'github_issue' in kinds),
        ('issue_label', 'github_issue' in kinds), ('triage_enabled', 'requires_triage' in automation)) if on}


def _automation_problems(sources: Sources) -> Problems:
    found = []
    markers = [str(automation['seed_marker']['pk']) for automation in sources.automations.values()]
    found += [f'automations: the seed marker {pk} is used twice' for pk in sorted({m for m in markers if markers.count(m) > 1})]
    for name, automation in sources.automations.items():
        where = f'automations/{name}.yaml'
        flow_id = automation['flow']
        if automation['id'] != name:
            found.append(f'{where}: its id is its file\'s name')
        if flow_id not in sources.flows and flow_id not in BUILTIN_FLOWS:
            found.append(f'{where}: no flow {flow_id}')
            continue
        flow = sources.flows.get(flow_id)
        engineering = 'engineering' in automation
        if engineering != (flow is not None):
            found.append(f'{where}: an engineering flow is an engineering agent\'s (its engineering settings), and only its')
        if engineering and not automation['budget'].get('monthly_usd', 0) > 0:
            found.append(f'{where}: an engineering automation\'s flow has a monthly budget above 0 (budget.monthly_usd)')
        missing = sorted(readiness_needed(automation, flow) - set(automation['readiness']))
        if missing:
            found.append(f'{where}: its readiness misses {", ".join(missing)}')
    return found


def _triage_case(path: Path, root: Path, fixtures: Mapping[str, Path]) -> Problems:
    where = relative(path, root)
    record = json.loads(path.read_text(encoding='utf-8'))
    expected = record.get('expected', {}) if isinstance(record.get('expected'), Mapping) else {}
    found = []
    if record.get('id') != path.parent.name or not str(record.get('title', '')).strip():
        found.append(f'{where}: its id is its directory\'s name, and it has a title')
    if expected.get('kind') not in TRIAGE_KINDS or not SEVERITY.match(str(expected.get('severity', ''))):
        found.append(f'{where}: expected is a kind ({", ".join(sorted(TRIAGE_KINDS))}) and a severity S1-S4')
    if expected.get('tenets') != [] and not isinstance(expected.get('tenets'), list):
        found.append(f'{where}: expected.tenets lists the tenet ids the triage cites ([] for none)')
    issue = record.get('issue', {})
    if not isinstance(issue, Mapping) or not all(str(issue.get(key, '')).strip() for key in ('title', 'body')):
        found.append(f'{where}: the issue has a title and a body')
    fixture = fixtures.get(str(record.get('fixture')))
    if fixture is None:
        found.append(f'{where}: its fixture is an eval case with a repository (<flow>/<case>)')
    else:
        found += [f'{where}: the fixture has no {name}' for name in expected.get('paths', []) if not (fixture / name).is_file()]
    return found


def _eval_problems(root: Path) -> Problems:
    found: Problems = []
    fixtures = {f'{path.parents[2].name}/{path.parent.name}': path.parent / 'repo'
                for path in root.glob('evals/*/cases/*/case.json') if (path.parent / 'repo').is_dir()}
    for path in sorted(root.glob('evals/*/cases/*/case.json')):
        record = json.loads(path.read_text(encoding='utf-8'))
        if record.get('schema') == 'voc-triage-case/1':
            found += _triage_case(path, root, fixtures)
            continue
        try:
            load_case(path.parent)
        except BenchmarkError as error:
            found.append(f'{relative(path, root)}: {error}')
    return found


def _placeholder_problems(root: Path) -> Problems:
    found = []
    for path in sorted({path for pattern in PLACEHOLDER_GLOBS for path in root.glob(pattern) if path.is_file()}):
        for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
            if PLACEHOLDER.search(line):
                found.append(f'{relative(path, root)}:{number}: a placeholder is left: {line.strip()[:80]}')
    return found


def drift_problems(text: str, root: Path = ROOT) -> Problems:
    """``bundle.json`` and its Lambda copy are ``text``, the compile's output."""
    return [f'{"lambda/shared/" + path.name if path == LAMBDA_COPY else relative(path, root)}: it is not the '
            'compile\'s output (npm run orchestration:compile writes it)' for path in outputs(root)
            if not path.is_file() or path.read_text(encoding='utf-8') != text]


def _guarded(check: Callable[[], Problems], what: str) -> Problems:
    try:
        return check()
    except (TemplateError, PackError, SkillError, KeyError, TypeError, ValueError) as error:
        return [f'{what}: {error}']


def problems(root: Path = ROOT, *, drift: bool = True) -> Problems:
    """Every problem of the templates under ``root``; ``drift``: the committed bundles are checked too."""
    try:
        sources = load(root)
    except (TemplateError, OSError) as error:
        return [str(error)]
    found = _schema_problems(sources)
    if found:
        return found   # (the later checks read the sources as the schemas shape them)
    try:
        packs = frozenset(pack.id for pack in load_packs(root / 'gates'))
    except PackError as error:
        return [f'gates: {error}']
    found += _skill_problems(sources) + _card_problems(sources) + _flow_problems(sources, packs)
    found += _automation_problems(sources) + _eval_problems(root) + _placeholder_problems(root)
    if found:
        return found
    bundle: dict[str, Any] = {}

    def compiled() -> Problems:
        bundle.update(compile_bundle(sources))
        return _compiled_problems(bundle)

    found += _guarded(compiled, 'compile')
    if not found and drift:
        found += drift_problems(render(bundle), root)
    return found
