"""The engineering flows' steps (``voc-workflow/2``, plan v3 4.9): their settings and their graph rules.

An engineering flow is a ``voc-workflow/2`` definition: ``start``, ``end`` (with ``status: needs_human`` it is the human
decision point, the step the sample already has), and the steps below. The agents' interpreter runs only
``voc-workflow/1``, so it never takes one; the engineering runtime is to run them. Pure (no AWS), used by
``shared.workflow_schema``; the editor mirrors every message (frontend ``WorkflowEditor/engineeringRules.ts``), held
to the same answers by the shared fixture ``frontend/src/test/engineeringFlows.json``
(``shared/test/test_engineering_flow_fixture.py``):

- ``agent``: ``role`` one of ``ENGINEERING_ROLES``; ``skill_version`` ``latest`` or ``v<n>``; ``model`` optional
  text; ``budget_share`` above 0 and at most 1, and a flow's shares add up to at most 1 (the run's budget);
- ``map``: ``shard_by`` packages | history | pr_pages, ``shard_cap`` 1 to 200; every map reaches exactly one reduce,
  and every reduce has a map before it;
- ``board``: ``posters`` (roles the board lets post: ``BOARD_POSTERS``) and ``claimers`` (roles that claim posted
  tasks: ``BOARD_CLAIMERS``), each a non-empty list; ``until`` drained | caps;
- ``quality_gate``: the gate's own settings only (``engineering.quality_gate.gate``): ``max_rounds`` 1 to 5 (3 if left
  out), ``packs`` ``auto`` or a list of gate packs, ``final_go_model`` optional text, ``reviewers`` as the gate takes
  them; its arrows are labelled ``pass`` (GO) and ``fail`` (NO-GO), the ``fail`` one to a human decision point;
- ``learning_loop``: terminal (its arrows reach only ends) or right after a board (every arrow into it leaves one);
- ``self_improvement``: alone in its flow (no other agent, map, board, gate or learning loop step) or terminal;
- ``memory``: ``mode`` read | write, ``scope`` repo | role | person, ``limit`` 1 to 50 for a read;
- ``stop_at_pr``: the flow's end on a pull request (no arrow leaves it, never a merge: there is no merge step). A flow
  with a committer or a PR author (an agent, or a board's claimers) must end there: every way their work can end is
  a stop at PR or a human decision point, and at least one is a stop at PR;
- ``call_flow`` (7.52.00): another saved engineering flow run in this step's place, ``flow`` its id at a pinned
  revision (``wf_<id>@<revision>``), with optional ``inputs`` (names to short text, recorded with the run) and
  ``budget_share`` (the called flow's part of the run's budget, which its agents' shares are scaled to). The call is
  expanded before the run starts (``shared/flow_expand.py``): the runtime only ever sees a flat flow. That the called
  flow exists, its depth, its size, a cycle and its stop at PR are the expansion's to check (they need the stored
  flows); the rules here are the step's own shape.

An agent may come from a Registry card (7.52.00): ``params.card`` ``<card>@v<n>`` names the card's version it was made
from, and the step then pins its skill version (the card's: ``v<n>``, never ``latest``). That the card exists and the
step carries its role, skill version and model is the save's to check (the cards are stored). A quality gate may say
who runs it the same way (7.52.00): ``runner`` and ``final_go``, each its role at ``latest`` or a version
(``gate-runner@v3``) or a card of that role at a version (``gate-runner-strict@v2``); left out, ``<role>@latest``.

Three more 7.52.00 rules, all additive: an assertion is checked only where it can be (``ASSERTION_PLACES``: a gate's
on a quality gate, Learn's on the flow's Learn, every other one on an agent or a board) and ``on_fail: fail_arrow``
only on a quality gate; and a flow may declare its ``inputs`` (``{<name>: {type, max?, required?, description?}}``,
``inputs_of``), what a run of it takes and what a call of it may name.

Two settings are 7.50.00's, both optional and kept in ``params``, so a flow saved before them stays valid and every
editor keeps them as they are (D1; the editor and the assistant leave ``params`` as written):

- ``params.assert`` on any engineering step: ``[{check, args?, on_fail?}]``, checks of the closed vocabulary
  (``ASSERTION_ARGS``) that platform code evaluates on what the step recorded (engineering/orchestration/assertions.py);
- the start step's ``params``: the flow's own ``memory`` (``{recall, scopes?, limit?}``: built in, never a step),
  ``learn`` (the built-in Learn step: ``{enabled, model?, budget_share?, roles?, after_needs_human_hours?, assert?}``)
  and ``pr`` (``ready``, the default, or ``draft``: how its pull request opens; merging is a person's). ``flow_settings``
  reads them with their defaults. The templates (voc-datalake/templates/orchestration/flows/) set all three.

Only a quality gate's arrows carry a label; an engineering flow repeats through its board, so it declares no loops.

A flow may carry ``budget: {monthly_usd}``: what its runs may spend in a calendar month (UTC), from 0.01 to
``MAX_MONTHLY_BUDGET_USD`` dollars, in dollars and cents (an amount with more decimals is refused, never rounded:
the amount a person approves is the amount kept). It is recorded with the flow and stops nothing. Only an
engineering flow has one.
"""
from __future__ import annotations

import math
import re
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

SCHEMA_V2: Final = 'voc-workflow/2'
NODE_STOP_AT_PR: Final = 'stop_at_pr'
#: Another saved flow, run in a step's place (7.52.00): expanded before the run starts (shared/flow_expand.py).
NODE_CALL_FLOW: Final = 'call_flow'
ENGINEERING_NODE_TYPES: Final = ('agent', 'map', 'reduce', 'board', 'quality_gate', 'learning_loop',
                                 'self_improvement', 'memory', NODE_CALL_FLOW, NODE_STOP_AT_PR)
#: The agent catalog's roles (engineering.connectors.identity AGENT_ROLES; a lockstep test holds the two together).
ENGINEERING_ROLES: Final = ('mapper', 'understander', 'hunter', 'fixer', 'builder', 'committer', 'commit-reviewer',
                            'gate-runner', 'pr-author', 'pr-reviewer', 'final-go', 'coordinator', 'coach')
#: A board's roles: who may post its tasks (engineering.board.api POSTERS) and who claims them (the roles with a task
#: queue, engineering.bus.schema ROLES, but the gate runner, which claims only a quality gate's); lockstep tests hold
#: both.
BOARD_POSTERS: Final = ('builder', 'coordinator', 'hunter')
BOARD_CLAIMERS: Final = ('builder', 'commit-reviewer', 'committer', 'final-go', 'fixer', 'hunter', 'mapper',
                         'pr-author', 'pr-reviewer', 'understander')
#: The roles whose work leaves the platform as code: a flow with one of them ends at a stop at PR.
PUSHING_ROLES: Final = frozenset({'committer', 'pr-author'})
#: The gate packs, one per language (voc-datalake/templates/orchestration/gates/; a lockstep test holds the two
#: together), and the two-language packs before 7.50.00, which a stored flow may still name: each stands for its two.
GATE_PACKS: Final = ('java', 'python', 'rust', 'typescript')
GATE_PACK_ALIASES: Final[Mapping[str, tuple[str, ...]]] = {'python-ts': ('python', 'typescript'),
                                                           'rust-ts': ('rust', 'typescript')}
SHARD_BY: Final = ('packages', 'history', 'pr_pages')
BOARD_UNTIL: Final = ('drained', 'caps')
MEMORY_MODES: Final = ('read', 'write')
MEMORY_SCOPES: Final = ('repo', 'role', 'person')
GATE_LABELS: Final = frozenset({'pass', 'fail'})
MAX_SHARD_CAP: Final = 200
MAX_GATE_ROUNDS: Final = 5
#: What a quality gate step may set (engineering.quality_gate.gate PARAMS but the ids the runtime fills in), and each
#: reviewer's settings and the default reviewers (its REVIEWER_KEYS and DEFAULT_REVIEWERS; a lockstep test holds them).
#: ``max_parallel`` (7.51.00, optional): the most agents of the step at work at once, which the board's ``launch`` holds
#: (board/flow_guard.py); on the steps that take several tasks at once. ``runner`` and ``final_go`` (7.52.00): who runs
#: the gate, the role or a Registry card of it at a version (``GATE_AGENTS``; left out, the defaults).
GATE_SETTINGS: Final = frozenset({'max_rounds', 'reviewers', 'packs', 'final_go_model', 'assert', 'max_parallel',
                                  'runner', 'final_go'})
MAX_PARALLEL: Final = 50
PARALLEL_TYPES: Final = frozenset({'agent', 'board', 'quality_gate'})
#: A gate's agents: each setting's role, and its default (the role at its latest skill).
GATE_AGENTS: Final[Mapping[str, str]] = {'runner': 'gate-runner', 'final_go': 'final-go'}
GATE_AGENT_DEFAULTS: Final[Mapping[str, str]] = {key: f'{role}@latest' for key, role in GATE_AGENTS.items()}
#: A role or a Registry card at a version: ``<role>@latest``, ``<role>@v<n>``, ``<role>-<slug>@v<n>``.
AGENT_REF: Final = re.compile(r'(?P<id>[a-z][a-z0-9-]{0,63})@(?P<version>latest|v[1-9][0-9]{0,5})\Z')
REVIEWER_SETTINGS: Final = frozenset({'name', 'focus', 'model_id', 'advisory'})
#: The default reviewers, each with whether it is advisory (a reviewer that leaves ``advisory`` out takes its own).
DEFAULT_REVIEWERS: Final = {'security': False, 'quality': False, 'first-principles': True}
_REVIEWER_NAME = re.compile(r'[a-z][a-z0-9-]{0,39}\Z')
MAX_MEMORY_LIMIT: Final = 50
MAX_MODEL_CHARS: Final = 128
#: A step's assertions (``params.assert``, 7.50.00): checks of the closed vocabulary, each with the arguments it takes
#: (engineering/orchestration/assertions.py VOCABULARY, which evaluates them; a lockstep test holds the two equal).
ASSERTION_ARGS: Final[Mapping[str, tuple[str, ...]]] = {
    'findings.cite_evidence': (), 'gate.pack_checks_ran': (), 'gate.passed': (), 'learn.proposals_name_case': (),
    'notes.cite_sources': (), 'patch.max_lines': ('max',), 'patch.no_ci_changes': (), 'patch.submitted': (),
    'patch.touches_tests': (), 'pr.links_issue': (), 'pr.opened': (), 'pr.state_as_flow': (),
    'push.tree_is_judged_tree': (), 'review.commented': (), 'review.no_blocking': ('by',),
    'tasks.posted': ('role', 'min'), 'tenets.recorded': (), 'triage.commented': (), 'triage.labelled': (),
    'triage.recorded': (),
}
ASSERTION_ON_FAIL: Final = ('block', 'fail_arrow', 'warn')
MAX_ASSERTIONS: Final = 10
#: Where each assertion is checked (7.52.00): a gate's on a quality gate, Learn's on the flow's Learn (its start step's
#: ``learn.assert``), every other one on an agent or a board (what records findings, notes, tasks, patches and host
#: writes). ``fail_arrow`` is a quality gate's alone (its fail arrow).
ASSERTION_PLACES: Final[Mapping[str, tuple[str, ...]]] = {'gate.': ('quality_gate',), 'learn.': ('learn',)}
ASSERTION_STEPS: Final = ('agent', 'board')
FAIL_ARROW_STEPS: Final = ('quality_gate',)
#: How a place reads in a message.
PLACE_WORDS: Final[Mapping[str, str]] = {'quality_gate': 'a quality gate', 'learn': "the flow's Learn",
                                         'agent': 'an agent', 'board': 'a board'}
#: A flow's declared inputs (7.52.00, ``definition.inputs``): what a run of it takes, and what a call of it may name.
MAX_FLOW_INPUTS: Final = 10
INPUT_SPEC_KEYS: Final = frozenset({'type', 'max', 'required', 'description'})
MAX_INPUT_TYPE_CHARS: Final = 40
MAX_INPUT_ITEMS: Final = 1000
MAX_INPUT_DESCRIPTION_CHARS: Final = 200
INPUTS_RULE: Final = (f"a flow's inputs map at most {MAX_FLOW_INPUTS} names (lowercase letters, digits and '_') to "
                      f"{{type, max?, required?, description?}}: a type of at most {MAX_INPUT_TYPE_CHARS} characters, "
                      f"max a whole number from 1 to {MAX_INPUT_ITEMS}, required true or false, a description of at "
                      f'most {MAX_INPUT_DESCRIPTION_CHARS} characters')
#: The flow's own settings, on its start step's params (7.50.00): its memory recall, its built-in Learn step and how
#: its pull request opens (ready for review by default; a person merges, always).
LEARN_SETTINGS: Final = frozenset({'enabled', 'model', 'budget_share', 'roles', 'after_needs_human_hours', 'assert'})
MAX_NEEDS_HUMAN_HOURS: Final = 720
PR_STATES: Final = ('ready', 'draft')
DEFAULT_PR: Final = 'ready'
#: The largest monthly budget a flow takes, in dollars (the editor's and the assistant's schemas take the same).
MAX_MONTHLY_BUDGET_USD: Final = 100_000
BUDGET_KEYS: Final = frozenset({'monthly_usd'})
BUDGET_RULE: Final = ('budget is {monthly_usd}: what its runs may spend in a month, in dollars and cents from 0.01 '
                      f'to {MAX_MONTHLY_BUDGET_USD:,}')
GATE_NEEDS_BOTH_ARROWS: Final = ("a quality gate needs a 'pass' arrow (GO) and a 'fail' arrow (NO-GO), "
                                 'every arrow labelled')
GATE_FAIL_TO_A_PERSON: Final = ("a quality gate's 'fail' arrow goes to a human decision point "
                                '(an end step that needs a human)')
ENDS_AT_A_STOP_AT_PR: Final = ('a committer or PR author ends the flow at a stop at PR: every way its work can end '
                               'is a stop at PR or a human decision point, and at least one is a stop at PR')
#: A call's settings (``call_flow``) and how many named inputs it takes.
CALL_SETTINGS: Final = frozenset({'flow', 'inputs', 'budget_share'})
MAX_CALL_INPUTS: Final = 10
MAX_CALL_INPUT_CHARS: Final = 200
#: A saved flow at a revision (``shared.agents_store`` ids: ``wf_`` and 12 hex digits; its revisions 1 to 999,999).
FLOW_REF: Final = re.compile(r'(?P<flow>wf_[0-9a-f]{12})@(?P<revision>[1-9][0-9]{0,5})\Z')
#: A Registry card at a version (``<role>-<slug>@v<n>``: engineering/registry/cards.py).
CARD_REF: Final = re.compile(r'(?P<card>[a-z][a-z0-9-]{0,63})@v(?P<version>[1-9][0-9]{0,5})\Z')
CALL_NEEDS_A_FLOW: Final = ("a call needs params.flow: a saved engineering flow at its revision, like "
                            "'wf_0123456789ab@3'")
CALL_SETTINGS_RULE: Final = f"a call's settings are {', '.join(sorted(CALL_SETTINGS))}"
CALL_INPUTS_RULE: Final = (f"a call's params.inputs maps at most {MAX_CALL_INPUTS} names (lowercase letters, digits "
                           f"and '_') to text of at most {MAX_CALL_INPUT_CHARS} characters")
SHARE_RULE: Final = 'is a fraction of the run\'s budget, above 0 and at most 1'
CARD_RULE: Final = "an agent's params.card is a Registry card at its version, like 'fixer-python@v2'"
CARD_PINS: Final = "an agent from a Registry card pins its skill version (the card's), never 'latest'"
_SKILL_VERSION = re.compile(r'(?:latest|v[1-9][0-9]{0,4})\Z')
_INPUT_NAME = re.compile(r'[a-z][a-z0-9_]{0,39}\Z')
_INPUT_TYPE = re.compile(r'[a-z][a-z0-9_./-]{0,39}\Z')
_WORK = frozenset({'agent', 'map', 'board', 'quality_gate', 'learning_loop', NODE_CALL_FLOW})
#: The steps whose ``budget_share`` is a part of the run's budget (an agent's; a call's, for the flow it runs).
_SHARED_BUDGET = frozenset({'agent', NODE_CALL_FLOW})
_TERMINAL = frozenset({'end', NODE_STOP_AT_PR})

Issues = list[tuple[str, str | None]]
Reach = Callable[[str], set[str]]


def _whole(params: Mapping[str, Any], key: str, low: int, high: int, default: int | None = None) -> bool:
    value = params.get(key, default)
    return type(value) is int and low <= value <= high


def _roles(value: object, allowed: Sequence[str]) -> bool:
    return isinstance(value, list) and bool(value) and all(role in allowed for role in value) \
        and len(set(value)) == len(value)


def _model(params: Mapping[str, Any], key: str) -> bool:
    """Left out, or a model id (a key set to null is not left out: the gate refuses it)."""
    value = params.get(key)
    return key not in params or (isinstance(value, str) and 0 < len(value.strip()) <= MAX_MODEL_CHARS)


def _agent_issues(params: Mapping[str, Any]) -> list[str]:
    issues = []
    if params.get('role') not in ENGINEERING_ROLES:
        issues.append(f"an agent needs params.role: one of {', '.join(ENGINEERING_ROLES)}")
    if not _SKILL_VERSION.fullmatch(str(params.get('skill_version', 'latest'))):
        issues.append("an agent's params.skill_version is 'latest' or a version like 'v3'")
    if not _model(params, 'model'):
        issues.append(f"an agent's params.model is a model id of at most {MAX_MODEL_CHARS} characters")
    if not _share_ok(params.get('budget_share')):
        issues.append(f"an agent's params.budget_share {SHARE_RULE}")
    card = params.get('card')
    if card is not None and not (isinstance(card, str) and CARD_REF.fullmatch(card)):
        issues.append(CARD_RULE)
    elif card is not None and params.get('skill_version', 'latest') == 'latest':
        issues.append(CARD_PINS)
    return issues


def _share_ok(share: object) -> bool:
    """Left out (a null is read as none set), or a fraction of the run's budget above 0 and at most 1."""
    return share is None or (not isinstance(share, bool) and isinstance(share, (int, float)) and 0 < share <= 1)


def _call_issues(params: Mapping[str, Any]) -> list[str]:
    """A ``call_flow`` step's own settings: the flow at its revision, its inputs, its share."""
    issues = []
    if set(params) - CALL_SETTINGS:
        issues.append(CALL_SETTINGS_RULE)
    flow = params.get('flow')
    if not (isinstance(flow, str) and FLOW_REF.fullmatch(flow)):
        issues.append(CALL_NEEDS_A_FLOW)
    inputs = params.get('inputs', {})
    if not (isinstance(inputs, Mapping) and len(inputs) <= MAX_CALL_INPUTS
            and all(isinstance(name, str) and _INPUT_NAME.fullmatch(name) for name in inputs)
            and all(isinstance(text, str) and len(text) <= MAX_CALL_INPUT_CHARS for text in inputs.values())):
        issues.append(CALL_INPUTS_RULE)
    if not _share_ok(params.get('budget_share')):
        issues.append(f"a call's params.budget_share {SHARE_RULE}")
    return issues


def _reviewer_ok(item: object) -> bool:
    """A reviewer as the gate takes it (engineering.quality_gate.gate._reviewer): a default one, or one with a focus."""
    if not isinstance(item, Mapping) or not isinstance(item.get('name'), str) or set(item) - REVIEWER_SETTINGS:
        return False
    texts = [item.get(key) for key in ('focus', 'model_id') if key in item]
    return (bool(_REVIEWER_NAME.fullmatch(item['name'])) and all(isinstance(t, str) and t.strip() for t in texts)
            and isinstance(item.get('advisory', False), bool)
            and (item['name'] in DEFAULT_REVIEWERS or 'focus' in item))


def _gate_issues(params: Mapping[str, Any]) -> list[str]:
    issues = []
    if set(params) - GATE_SETTINGS:
        issues.append(f"a quality gate's settings are {', '.join(sorted(GATE_SETTINGS))}")
    reviewers = params.get('reviewers')
    if reviewers is not None and not (isinstance(reviewers, list) and reviewers and all(map(_reviewer_ok, reviewers))):
        issues.append("a quality gate's params.reviewers is a list of reviewers: each a name (lowercase letters, digits "
                      f"and dashes; {', '.join(DEFAULT_REVIEWERS)} or a new one with a focus), and optionally a "
                      'focus, a model_id and advisory (true or false)')
    elif reviewers is not None:
        names = [reviewer['name'] for reviewer in reviewers]
        advisory = [reviewer.get('advisory', DEFAULT_REVIEWERS.get(reviewer['name'], False)) for reviewer in reviewers]
        if len(set(names)) != len(names) or all(advisory):
            issues.append("a quality gate's reviewers have different names, and at least one can block (not advisory)")
    if not _whole(params, 'max_rounds', 1, MAX_GATE_ROUNDS, default=3):
        issues.append(f"a quality gate's params.max_rounds is a whole number from 1 to {MAX_GATE_ROUNDS}")
    packs = params.get('packs', 'auto')
    # Each entry a string before any set is built (an unhashable entry is refused, never a crash).
    if packs != 'auto' and not (isinstance(packs, list) and packs and all(isinstance(p, str) for p in packs)
                                and set(packs) <= {*GATE_PACKS, *GATE_PACK_ALIASES} and len(set(packs)) == len(packs)):
        issues.append(f"a quality gate's params.packs is 'auto' or a list of gate packs: {', '.join(GATE_PACKS)}")
    if not _model(params, 'final_go_model'):
        issues.append(f"a quality gate's params.final_go_model is a model id of at most {MAX_MODEL_CHARS} characters")
    issues += [gate_agent_rule(key) for key in GATE_AGENTS if key in params and not gate_agent_ok(key, params[key])]
    return issues


def gate_agent_ok(key: str, value: object) -> bool:
    """A gate's ``runner`` or ``final_go``: its role at ``latest`` or a version, or a card of that role
    (``<role>-<slug>``) at a version."""
    match = AGENT_REF.fullmatch(value) if isinstance(value, str) else None
    role = GATE_AGENTS[key]
    return match is not None and (match['id'] == role
                                  or (match['id'].startswith(f'{role}-') and match['version'] != 'latest'))


def gate_agent_rule(key: str) -> str:
    role = GATE_AGENTS[key]
    return (f"a quality gate's params.{key} is the {role} or a Registry card of it, at a version: '{role}@latest', "
            f"'{role}@v3' or '{role}-strict@v2'")


def _board_issues(params: Mapping[str, Any]) -> list[str]:
    issues = [f'a board needs params.{key}: a list of roles, each once ({", ".join(allowed)})'
              for key, allowed in (('posters', BOARD_POSTERS), ('claimers', BOARD_CLAIMERS))
              if not _roles(params.get(key), allowed)]
    if params.get('until', 'drained') not in BOARD_UNTIL:
        issues.append(f"a board's params.until is one of {', '.join(BOARD_UNTIL)}")
    return issues


def _map_issues(params: Mapping[str, Any]) -> list[str]:
    issues = []
    if params.get('shard_by') not in SHARD_BY:
        issues.append(f"a map needs params.shard_by: one of {', '.join(SHARD_BY)}")
    if not _whole(params, 'shard_cap', 1, MAX_SHARD_CAP, default=MAX_SHARD_CAP):
        issues.append(f"a map's params.shard_cap is a whole number from 1 to {MAX_SHARD_CAP}")
    return issues


def _memory_issues(params: Mapping[str, Any]) -> list[str]:
    issues = []
    mode = params.get('mode')
    if mode not in MEMORY_MODES:
        issues.append(f"a memory step needs params.mode: one of {', '.join(MEMORY_MODES)}")
    if params.get('scope') not in MEMORY_SCOPES:
        issues.append(f"a memory step needs params.scope: one of {', '.join(MEMORY_SCOPES)}")
    if mode == 'read' and not _whole(params, 'limit', 1, MAX_MEMORY_LIMIT, default=10):
        issues.append(f"a memory read's params.limit is a whole number from 1 to {MAX_MEMORY_LIMIT}")
    return issues


def assertion_places(check: str) -> tuple[str, ...]:
    """Where ``check`` is checked (``ASSERTION_PLACES`` by its prefix, else ``ASSERTION_STEPS``)."""
    return next((places for prefix, places in ASSERTION_PLACES.items() if check.startswith(prefix)), ASSERTION_STEPS)


def _assertion_issues(raw: object, place: str) -> list[str]:
    """A step's ``params.assert`` (``place``: the step's type, or ``learn`` for the flow's Learn): checks of the
    vocabulary, each with exactly the arguments it takes, each checked where it can be (``assertion_places``), and
    ``fail_arrow`` only on a quality gate."""
    if not isinstance(raw, list) or len(raw) > MAX_ASSERTIONS:
        return [f"a step's params.assert is a list of at most {MAX_ASSERTIONS} assertions"]
    issues = []
    for item in raw:
        check = item.get('check') if isinstance(item, Mapping) else None
        args = item.get('args', {}) if isinstance(item, Mapping) else None
        on_fail = item.get('on_fail', 'block') if isinstance(item, Mapping) else None
        if not isinstance(item, Mapping) or set(item) - {'check', 'args', 'on_fail'} or check not in ASSERTION_ARGS:
            issues.append(f"an assertion is {{check, args?, on_fail?}}, its check one of {', '.join(ASSERTION_ARGS)}")
        elif not isinstance(args, Mapping) or set(args) != set(ASSERTION_ARGS[check]):
            issues.append(f"the assertion {check} takes {', '.join(ASSERTION_ARGS[check]) or 'no arguments'}")
        elif on_fail not in ASSERTION_ON_FAIL:
            issues.append(f"an assertion's on_fail is one of {', '.join(ASSERTION_ON_FAIL)}")
        elif place not in assertion_places(check):
            where = ' or '.join(PLACE_WORDS[step] for step in assertion_places(check))
            issues.append(f'the assertion {check} is checked on {where}')
        elif on_fail == 'fail_arrow' and place not in FAIL_ARROW_STEPS:
            issues.append("an assertion's on_fail fail_arrow is a quality gate's (its fail arrow): block or warn here")
    return issues


def _input_ok(name: object, spec: object) -> bool:
    if not (isinstance(name, str) and _INPUT_NAME.fullmatch(name)) or not isinstance(spec, Mapping) \
            or set(spec) - INPUT_SPEC_KEYS:
        return False
    kind, most, description = spec.get('type'), spec.get('max', 1), spec.get('description', '')
    return (isinstance(kind, str) and _INPUT_TYPE.fullmatch(kind) is not None
            and type(most) is int and 1 <= most <= MAX_INPUT_ITEMS
            and isinstance(spec.get('required', False), bool)
            and isinstance(description, str) and len(description) <= MAX_INPUT_DESCRIPTION_CHARS)


def inputs_of(raw: object) -> tuple[dict[str, Any] | None, str | None]:
    """A flow's declared ``inputs`` (7.52.00), or the rule they break; ``(None, None)`` when it declares none."""
    if raw is None:
        return None, None
    if not isinstance(raw, Mapping) or len(raw) > MAX_FLOW_INPUTS or not all(map(_input_ok, raw, raw.values())):
        return None, INPUTS_RULE
    return {str(name): dict(spec) for name, spec in raw.items()}, None


def _recall_issues(raw: object) -> list[str]:
    scopes = raw.get('scopes', ['repo']) if isinstance(raw, Mapping) else None
    if (not isinstance(raw, Mapping) or set(raw) - {'recall', 'scopes', 'limit'} or not isinstance(raw.get('recall'), bool)
            or not _roles(scopes, MEMORY_SCOPES) or not _whole(raw, 'limit', 1, MAX_MEMORY_LIMIT, default=10)):
        return [(f"a flow's memory is {{recall: true or false, scopes?: [{', '.join(MEMORY_SCOPES)}], "
                f'limit?: 1 to {MAX_MEMORY_LIMIT}}}')]
    return []


def _learn_issues(raw: object) -> list[str]:
    if not isinstance(raw, Mapping) or set(raw) - LEARN_SETTINGS or not isinstance(raw.get('enabled'), bool):
        return [f"a flow's learn is {{enabled: true or false}} and optionally {', '.join(sorted(LEARN_SETTINGS - {'enabled'}))}"]
    issues = []
    share = raw.get('budget_share', 1)
    if not _model(raw, 'model') or isinstance(share, bool) or not isinstance(share, (int, float)) or not 0 < share <= 1:
        issues.append("a flow's learn.model is a model id, and its budget_share above 0 and at most 1")
    if 'roles' in raw and not _roles(raw['roles'], ENGINEERING_ROLES):
        issues.append(f"a flow's learn.roles is a list of roles, each once ({', '.join(ENGINEERING_ROLES)})")
    if not _whole(raw, 'after_needs_human_hours', 1, MAX_NEEDS_HUMAN_HOURS, default=72):
        issues.append(f"a flow's learn.after_needs_human_hours is a whole number from 1 to {MAX_NEEDS_HUMAN_HOURS}")
    return issues + (_assertion_issues(raw['assert'], 'learn') if 'assert' in raw else [])


def _start_issues(params: Mapping[str, Any]) -> list[str]:
    """The flow's own settings on its start step (7.50.00), each optional: ``memory``, ``learn``, ``pr``."""
    issues = _recall_issues(params['memory']) if 'memory' in params else []
    issues += _learn_issues(params['learn']) if 'learn' in params else []
    if params.get('pr', DEFAULT_PR) not in PR_STATES:
        issues.append(f"a flow's pr is one of {', '.join(PR_STATES)}")
    return issues


_PARAMS = {'agent': _agent_issues, 'quality_gate': _gate_issues, 'board': _board_issues, 'map': _map_issues,
           'memory': _memory_issues, NODE_CALL_FLOW: _call_issues, 'start': _start_issues}


def flow_settings(definition: object) -> dict[str, Any]:
    """An engineering flow's ``memory``, ``learn`` and ``pr`` (its start step's params), each with its default when the
    flow leaves it out (a flow saved before 7.50.00 has none) or is off its shape (a run's readers never stop for a
    setting they cannot read; the rules above refuse such a flow at its save): no recall, Learn on, the pull request
    ready. ``pr`` is as written: a reader takes ``draft`` only for a draft."""
    nodes = definition.get('nodes') if isinstance(definition, Mapping) else None
    start = next((node for node in nodes if isinstance(node, Mapping) and node.get('type') == 'start'), {}) \
        if isinstance(nodes, list) else {}
    data = start.get('data')
    params = data.get('params') if isinstance(data, Mapping) else None
    params = params if isinstance(params, Mapping) else {}
    memory, learn = params.get('memory'), params.get('learn')
    return {'memory': dict(memory) if isinstance(memory, Mapping) else {'recall': False},
            'learn': dict(learn) if isinstance(learn, Mapping) else {'enabled': True},
            'pr': params.get('pr', DEFAULT_PR)}


def step_assertions(node: Mapping[str, Any]) -> list[dict[str, Any]]:
    """A step's assertions (``params.assert``), none when it has none."""
    return [dict(item) for item in node.get('data', {}).get('params', {}).get('assert', [])]


def budget_of(raw: object) -> tuple[dict[str, float] | None, str | None]:
    """A flow's ``budget``, or the rule it breaks; ``(None, None)`` when it has none."""
    if raw is None:
        return None, None
    if not isinstance(raw, Mapping) or frozenset(raw) != BUDGET_KEYS:
        return None, BUDGET_RULE
    amount = raw['monthly_usd']
    # (a whole number of any size is fine to compare; only a float can be inf or nan, and isfinite on a huge int
    # raises OverflowError, which would be a 500)
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) \
            or (isinstance(amount, float) and not math.isfinite(amount)):
        return None, BUDGET_RULE
    if round(amount, 2) != amount or not 0.01 <= amount <= MAX_MONTHLY_BUDGET_USD:
        return None, BUDGET_RULE
    return {'monthly_usd': amount}, None


def params_issues(node_type: str, params: Mapping[str, Any]) -> list[str]:
    """What is wrong with an engineering step's settings (empty when nothing is): its own, and its assertions."""
    check = _PARAMS.get(node_type)
    # (a call's steps carry their own assertions: the call itself takes none, CALL_SETTINGS)
    asserts = 'assert' in params and node_type in ENGINEERING_NODE_TYPES and node_type != NODE_CALL_FLOW
    asserted = _assertion_issues(params['assert'], node_type) if asserts else []
    wrong = 'max_parallel' in params and (node_type not in PARALLEL_TYPES
                                          or not _whole(params, 'max_parallel', 1, MAX_PARALLEL))
    parallel = [(f"a step's params.max_parallel is a whole number from 1 to {MAX_PARALLEL}, on an agent, a board or "
                 'a quality gate')] if wrong else []
    return (check(params) if check else []) + asserted + parallel


# ── graph rules ──────────────────────────────────────────────────────────────

def _first_reduces(start: str, types: Mapping[str, str],
                   forward: Mapping[str, Sequence[str]]) -> tuple[set[str], bool]:
    """The reduces a map's shards meet first (a path stops at the first reduce it meets), and whether some path
    reaches the flow's end without meeting one (its shards would never be reduced)."""
    found: set[str] = set()
    seen: set[str] = set()
    escapes = False
    queue = deque(forward.get(start, ()))
    while queue:
        node = queue.popleft()
        if node in seen:
            continue
        seen.add(node)
        if types[node] == 'reduce':
            found.add(node)
        elif types[node] in _TERMINAL:
            escapes = True
        else:
            queue.extend(forward.get(node, ()))
    return found, escapes


def _map_reduce_issues(types: Mapping[str, str], forward: Mapping[str, Sequence[str]]) -> Issues:
    issues: Issues = []
    met: set[str] = set()
    for node_id in (n for n, kind in types.items() if kind == 'map'):
        reduces, escapes = _first_reduces(node_id, types, forward)
        met |= reduces
        if len(reduces) != 1 or escapes:
            issues.append(('a map needs exactly one reduce after it, on every way out, where its shards meet', node_id))
    issues += [('a reduce needs a map before it', node_id)
               for node_id, kind in types.items() if kind == 'reduce' and node_id not in met]
    return issues


def _gate_arrow_issues(nodes: Mapping[str, Mapping[str, Any]], edges: Sequence[Mapping[str, Any]]) -> Issues:
    issues: Issues = []
    for edge in edges:
        source, label = edge['source'], edge.get('label')
        if label and nodes[source]['type'] != 'quality_gate':
            issues.append(('only a quality gate\'s arrows carry a label (pass or fail)', source))
    for node_id in (n for n, node in nodes.items() if node['type'] == 'quality_gate'):
        out = [edge for edge in edges if edge['source'] == node_id]
        labels = {edge.get('label') for edge in out}
        if not out or labels - GATE_LABELS or not labels >= GATE_LABELS:
            issues.append((GATE_NEEDS_BOTH_ARROWS, node_id))
        failing = [nodes[edge['target']] for edge in out if edge.get('label') == 'fail']
        if any(target['type'] != 'end' or target['data']['params'].get('status') != 'needs_human' for target in failing):
            issues.append((GATE_FAIL_TO_A_PERSON, node_id))
    return issues


def _placement_issues(types: Mapping[str, str], forward: Mapping[str, Sequence[str]],
                      backward: Mapping[str, Sequence[str]]) -> Issues:
    issues: Issues = []

    def terminal(node_id: str) -> bool:
        return bool(forward[node_id]) and all(types[after] in _TERMINAL for after in forward[node_id])

    for node_id, kind in types.items():
        after_board = bool(backward[node_id]) and all(types[before] == 'board' for before in backward[node_id])
        if kind == 'learning_loop' and not (terminal(node_id) or after_board):
            issues.append(('a learning loop is the last step before an end, or comes right after a board', node_id))
        alone = not any(other != node_id and types[other] in _WORK for other in types)
        if kind == 'self_improvement' and not (alone or terminal(node_id)):
            issues.append(('self-improvement runs in its own flow, or as the last step before an end', node_id))
    return issues


def _pushes(node: Mapping[str, Any]) -> bool:
    params = node['data']['params']
    if node['type'] == 'agent':
        return params.get('role') in PUSHING_ROLES
    return node['type'] == 'board' and bool(PUSHING_ROLES & set(params.get('claimers') or ()))


def _stop_at_pr_issues(nodes: Mapping[str, Mapping[str, Any]], reach: Reach) -> Issues:
    issues: Issues = []
    for node_id in (n for n, node in nodes.items() if _pushes(node)):
        ends = {n for n in reach(node_id) if nodes[n]['type'] in _TERMINAL}
        human = {n for n in ends if nodes[n]['data']['params'].get('status') == 'needs_human'}
        stops = {n for n in ends if nodes[n]['type'] == NODE_STOP_AT_PR}
        if ends - human - stops or not stops:
            issues.append((ENDS_AT_A_STOP_AT_PR, node_id))
    return issues


def graph_issues(nodes: Sequence[Mapping[str, Any]], edges: Sequence[Mapping[str, Any]],
                 forward: Mapping[str, Sequence[str]], backward: Mapping[str, Sequence[str]], reach: Reach) -> Issues:
    """The engineering rules over a flow whose shape and arrows are sound: ``(message, node_id)`` pairs.

    ``reach(node_id)`` is the set of steps reachable from a step (``shared.workflow_schema.reach_from``).
    """
    by_id = {node['id']: node for node in nodes}
    types = {node_id: node['type'] for node_id, node in by_id.items()}
    # (a call's share is the flow it runs: its agents' shares are scaled into it, shared/flow_expand.py)
    shares = [node['data']['params'].get('budget_share') for node in nodes if node['type'] in _SHARED_BUDGET]
    issues: Issues = []
    # fsum: 0.1 + 0.2 + 0.7 is the whole budget, not a hair over it.
    if math.fsum(share for share in shares if isinstance(share, (int, float))) > 1:
        issues.append(("the agents' budget shares add up to more than the run's budget (at most 1 in all)", None))
    return (issues + _map_reduce_issues(types, forward) + _gate_arrow_issues(by_id, edges)
            + _placement_issues(types, forward, backward) + _stop_at_pr_issues(by_id, reach))
