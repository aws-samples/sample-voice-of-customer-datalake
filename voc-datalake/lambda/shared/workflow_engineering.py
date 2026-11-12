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
  a stop at PR or a human decision point, and at least one is a stop at PR.

Only a quality gate's arrows carry a label; an engineering flow repeats through its board, so it declares no loops.
"""
from __future__ import annotations

import math
import re
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

SCHEMA_V2: Final = 'voc-workflow/2'
NODE_STOP_AT_PR: Final = 'stop_at_pr'
ENGINEERING_NODE_TYPES: Final = ('agent', 'map', 'reduce', 'board', 'quality_gate', 'learning_loop',
                                 'self_improvement', 'memory', NODE_STOP_AT_PR)
#: The agent catalog's roles (engineering.connectors.identity AGENT_ROLES; a lockstep test holds the two together).
ENGINEERING_ROLES: Final = ('mapper', 'understander', 'hunter', 'fixer', 'builder', 'committer', 'commit-reviewer',
                            'gate-runner', 'pr-author', 'pr-reviewer', 'final-go', 'coordinator', 'coach')
#: A board's roles: who may post its tasks (engineering.board.api POSTERS) and who claims them (the roles with a task
#: queue, engineering.bus.schema ROLES); lockstep tests hold both.
BOARD_POSTERS: Final = ('builder', 'coordinator', 'hunter')
BOARD_CLAIMERS: Final = ('builder', 'commit-reviewer', 'committer', 'final-go', 'fixer', 'hunter', 'mapper',
                         'pr-author', 'pr-reviewer', 'understander')
#: The roles whose work leaves the platform as code: a flow with one of them ends at a stop at PR.
PUSHING_ROLES: Final = frozenset({'committer', 'pr-author'})
#: The gate packs (voc-datalake/engineering-gates/; a lockstep test holds the two together).
GATE_PACKS: Final = ('java', 'python-ts', 'rust-ts')
SHARD_BY: Final = ('packages', 'history', 'pr_pages')
BOARD_UNTIL: Final = ('drained', 'caps')
MEMORY_MODES: Final = ('read', 'write')
MEMORY_SCOPES: Final = ('repo', 'role', 'person')
GATE_LABELS: Final = frozenset({'pass', 'fail'})
MAX_SHARD_CAP: Final = 200
MAX_GATE_ROUNDS: Final = 5
#: What a quality gate step may set (engineering.quality_gate.gate PARAMS but the ids the runtime fills in), and each
#: reviewer's settings and the default reviewers (its REVIEWER_KEYS and DEFAULT_REVIEWERS; a lockstep test holds them).
GATE_SETTINGS: Final = frozenset({'max_rounds', 'reviewers', 'packs', 'final_go_model'})
REVIEWER_SETTINGS: Final = frozenset({'name', 'focus', 'model_id', 'advisory'})
#: The default reviewers, each with whether it is advisory (a reviewer that leaves ``advisory`` out takes its own).
DEFAULT_REVIEWERS: Final = {'security': False, 'quality': False, 'first-principles': True}
_REVIEWER_NAME = re.compile(r'[a-z][a-z0-9-]{0,39}\Z')
MAX_MEMORY_LIMIT: Final = 50
MAX_MODEL_CHARS: Final = 128
GATE_NEEDS_BOTH_ARROWS: Final = ("a quality gate needs a 'pass' arrow (GO) and a 'fail' arrow (NO-GO), "
                                 'every arrow labelled')
GATE_FAIL_TO_A_PERSON: Final = ("a quality gate's 'fail' arrow goes to a human decision point "
                                '(an end step that needs a human)')
ENDS_AT_A_STOP_AT_PR: Final = ('a committer or PR author ends the flow at a stop at PR: every way its work can end '
                               'is a stop at PR or a human decision point, and at least one is a stop at PR')
_SKILL_VERSION = re.compile(r'(?:latest|v[1-9][0-9]{0,4})\Z')
_WORK = frozenset({'agent', 'map', 'board', 'quality_gate', 'learning_loop'})
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
    share = params.get('budget_share')
    if share is not None and (isinstance(share, bool) or not isinstance(share, (int, float)) or not 0 < share <= 1):
        issues.append("an agent's params.budget_share is a fraction of the run's budget, above 0 and at most 1")
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
                                and set(packs) <= set(GATE_PACKS) and len(set(packs)) == len(packs)):
        issues.append(f"a quality gate's params.packs is 'auto' or a list of gate packs: {', '.join(GATE_PACKS)}")
    if not _model(params, 'final_go_model'):
        issues.append(f"a quality gate's params.final_go_model is a model id of at most {MAX_MODEL_CHARS} characters")
    return issues


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


_PARAMS = {'agent': _agent_issues, 'quality_gate': _gate_issues, 'board': _board_issues, 'map': _map_issues,
           'memory': _memory_issues}


def params_issues(node_type: str, params: Mapping[str, Any]) -> list[str]:
    """What is wrong with an engineering step's settings (empty when nothing is)."""
    check = _PARAMS.get(node_type)
    return check(params) if check else []


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
    shares = [node['data']['params'].get('budget_share') for node in nodes if node['type'] == 'agent']
    issues: Issues = []
    # fsum: 0.1 + 0.2 + 0.7 is the whole budget, not a hair over it.
    if math.fsum(share for share in shares if isinstance(share, (int, float))) > 1:
        issues.append(("the agents' budget shares add up to more than the run's budget (at most 1 in all)", None))
    return (issues + _map_reduce_issues(types, forward) + _gate_arrow_issues(by_id, edges)
            + _placement_issues(types, forward, backward) + _stop_at_pr_issues(by_id, reach))
