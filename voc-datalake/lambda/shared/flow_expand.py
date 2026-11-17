"""A flow's calls, expanded (7.52.00): each ``call_flow`` step replaced by the saved flow it calls, before a run starts.

Pure (no AWS: the caller hands in ``read``, a saved revision's reader), so the Agents API and the agents' heartbeat run
it the same way at both run starts (``shared/engineering_agent_runs.py`` ``stored_flow``), and the save of a flow runs
it too, as a simulation, so a flow whose calls cannot be expanded is never saved. The runtime only ever sees the flat
flow (D52-4): it has no ``call_flow`` step to run.

A call step's params are ``{flow: '<workflow_id>@<revision>', inputs?, budget_share?}``
(``shared/workflow_engineering.py``). Expanding it:

- **reads the called flow at that revision** (a pin: a later save of the called flow changes no caller), which must be
  an engineering flow the server's rules still pass;
- **names its steps** ``<call>.<step>`` (a call inside it ``<call>.<inner call>.<step>``), each at most 64 characters:
  the dot is the expansion's own, so a flow a person saves has none (``save_issues``);
- **splices the arrows**: what came into the call goes to the steps the called flow's start leads to, and what reached
  the called flow's plain end (a ``completed`` one) goes where the call led. Its human decision points stay, as its
  steps; its start and its plain ends go;
- **scales the shares**: each of its agents' ``budget_share`` is that share of the call's own (the called flow gets
  ``budget_share`` of the run's budget; a call without one leaves them as they are), floored to six places so the
  run's shares never add up past what the caller's did;
- **lays the steps out** where the call was, the caller's later steps moved down by the called flow's height.

The called flow's own settings (its start step's memory, Learn and pull request mode, its monthly budget) are not
taken: the caller's apply to the whole run.

Refused (``ExpansionError``, naming the call step):

- a call more than ``MAX_DEPTH`` (2) deep: a flow that calls a flow that calls a flow is the most;
- more than ``MAX_NODES`` (60) steps once every call is in;
- a cycle: a flow in its own chain of calls, directly or through another (by its id, whatever the revision);
- a called flow that ends at a pull request (a ``stop_at_pr``), unless the call is its caller's last step (every arrow
  out of it goes to an end), and one with no plain end unless the call is last too (nothing after it could run);
- a called flow, or a revision of it, that is not saved, or is an agents workflow;
- a call's ``inputs`` naming one the called flow does not declare (its ``definition.inputs``);
- the flat flow breaking any of the server's rules (``shared.workflow_schema.validate_definition``).

What the run records (D4): the flat definition as its own copy of the flow, and, on that copy's start step,
``params.expansion``: ``[{step, flow, revision, inputs?}]``, each call it expanded in the order it did, the outer
call before the ones inside it.
"""
from __future__ import annotations

import copy
import hashlib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from decimal import ROUND_FLOOR, Decimal
from typing import Any, Final

from shared import workflow_schema
from shared.workflow_engineering import FLOW_REF, NODE_CALL_FLOW, NODE_STOP_AT_PR, SCHEMA_V2

#: How deep calls nest: a flow, a flow it calls, a flow that one calls.
MAX_DEPTH: Final = 2
MAX_NODES: Final = workflow_schema.MAX_NODES
MAX_ID_CHARS: Final = 64
#: What joins a call's id to its called flow's steps (never in a saved flow's ids: ``save_issues``).
SEPARATOR: Final = '.'
#: The run's record of its calls, on the start step's params of its copy of the flow.
EXPANSION: Final = 'expansion'
#: The places a scaled share keeps (floored: the shares never add up past the caller's).
SHARE_PLACES: Final = Decimal('0.000001')
_TERMINAL: Final = frozenset({'end', NODE_STOP_AT_PR})
DOTTED: Final = f'a step\'s id holds no "{SEPARATOR}": it joins a called flow\'s steps to their call'
RECORDED: Final = f'{EXPANSION} is what a run records of its calls: a saved flow has none'

#: A saved flow's revision, decoded (its ``voc-workflow`` definition); None when the flow or the revision is not saved.
ReadRevision = Callable[[str, int], Mapping[str, Any] | None]


class ExpansionError(ValueError):
    """A call that cannot be expanded: what is wrong, and the call step (its full id) it is about."""

    def __init__(self, message: str, node_id: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.node_id = node_id


@dataclass(frozen=True)
class Expanded:
    """The flat flow (valid, ``voc-workflow/2``, no call left) and the calls expanded into it."""

    definition: dict[str, Any]
    expansion: tuple[dict[str, Any], ...] = ()


def calls(definition: Mapping[str, Any] | None) -> list[Mapping[str, Any]]:
    """The flow's call steps (none for anything that is not an engineering flow)."""
    if not isinstance(definition, Mapping) or definition.get('schema') != SCHEMA_V2:
        return []
    nodes = definition.get('nodes')
    return [node for node in nodes if isinstance(node, Mapping) and node.get('type') == NODE_CALL_FLOW] \
        if isinstance(nodes, list) else []


def flow_ref(value: object) -> tuple[str, int] | None:
    """``wf_<id>@<revision>`` as ``(workflow_id, revision)``; None for anything else."""
    match = FLOW_REF.fullmatch(value) if isinstance(value, str) else None
    return None if match is None else (match['flow'], int(match['revision']))


def _params(node: Mapping[str, Any]) -> dict[str, Any]:
    data = node.get('data')
    params = data.get('params') if isinstance(data, Mapping) else None
    return dict(params) if isinstance(params, Mapping) else {}


def scaled_share(share: float, of: float) -> float:
    """``share`` of ``of`` (both fractions of a budget), floored to ``SHARE_PLACES``, never 0 (the rules take none)."""
    product = (Decimal(repr(share)) * Decimal(repr(of))).quantize(SHARE_PLACES, rounding=ROUND_FLOOR)
    return float(max(product, SHARE_PLACES))


def _edge_id(source: str, target: str, label: str | None, taken: set[str]) -> str:
    """A fresh arrow id: ``<source>-<target>`` where it fits and is free, else a digest of it."""
    plain = f'{source}-{target}' + (f'-{label}' if label else '')
    candidate = plain
    counter = 0
    while len(candidate) > MAX_ID_CHARS or candidate in taken:
        counter += 1
        candidate = 'e' + hashlib.sha256(f'{plain}#{counter}'.encode()).hexdigest()[:20]
    taken.add(candidate)
    return candidate


def _checked(definition: Mapping[str, Any]) -> tuple[dict[str, Any] | None, workflow_schema.Issue | None]:
    """``definition`` as the server's rules normalise it, or the first rule it breaks."""
    checked = workflow_schema.validate_definition(definition)
    return checked.definition, checked.errors[0] if checked.errors else None


def _called(call: Mapping[str, Any], where: str, read: ReadRevision, chain: Sequence[str]) -> tuple[str, int, dict]:
    """The flow a call names, read at its revision and checked (``where``: the call's full id)."""
    ref = flow_ref(_params(call).get('flow'))
    if ref is None:
        raise ExpansionError(f'{where} names no saved flow at a revision (wf_<id>@<revision>)', where)
    flow, revision = ref
    if flow in chain:
        raise ExpansionError(f'{where} calls {flow}, which is already in its chain of calls: a flow never calls '
                             'itself, directly or through another', where)
    found = read(flow, revision)
    if found is None:
        raise ExpansionError(f'{where} calls {flow}@{revision}, which is not a saved revision of a flow', where)
    if found.get('schema') != SCHEMA_V2:
        raise ExpansionError(f'{where} calls {flow}, an agents workflow: a call runs an engineering flow', where)
    checked, broken = _checked(found)
    if checked is None:
        rule = broken.message if broken is not None else 'it cannot be read'
        raise ExpansionError(f'{where} calls {flow}@{revision}, which breaks a rule now ({rule}): save it again and '
                             'call its new revision', where)
    return flow, revision, checked


@dataclass
class _Graph:
    """A flow being expanded: its steps and its arrows."""

    nodes: list[dict[str, Any]]
    edges: list[dict[str, Any]]

    @property
    def types(self) -> dict[str, str]:
        return {node['id']: node['type'] for node in self.nodes}


def _child_steps(call: Mapping[str, Any], child: Mapping[str, Any], where: str,
                 dropped: set[str]) -> tuple[list[dict[str, Any]], float]:
    """The called flow's kept steps, renamed, placed where the call was and with their shares scaled; and the
    height they take."""
    share = _params(call).get('budget_share')
    kept = [node for node in child['nodes'] if node['id'] not in dropped]
    start = next(node for node in child['nodes'] if node['type'] == 'start')
    top = min((node['position']['y'] for node in kept), default=start['position']['y'])
    bottom = max((node['position']['y'] for node in kept), default=top)
    steps = []
    for node in kept:
        step_id = f'{call["id"]}{SEPARATOR}{node["id"]}'
        if len(step_id) > MAX_ID_CHARS:
            raise ExpansionError(f'{where}{SEPARATOR}{node["id"]} is longer than {MAX_ID_CHARS} characters once '
                                 'expanded: give the call step a shorter id', where)
        step = copy.deepcopy(node)
        step['id'] = step_id
        step['position'] = {'x': call['position']['x'] + node['position']['x'] - start['position']['x'],
                            'y': call['position']['y'] + node['position']['y'] - top}
        own = step['data']['params'].get('budget_share')
        if step['type'] == 'agent' and isinstance(share, (int, float)) and isinstance(own, (int, float)):
            step['data']['params']['budget_share'] = scaled_share(own, share)
        steps.append(step)
    return steps, bottom - top


def _plain_ends(child: Mapping[str, Any], *, last: bool, where: str) -> set[str]:
    """The called flow's plain ends (``completed``: where it returns to its caller), once its ends are checked against
    where the call is (``last``: every arrow out of the call goes to an end)."""
    plain = {node['id'] for node in child['nodes']
             if node['type'] == 'end' and node['data']['params'].get('status') != 'needs_human'}
    if not last and any(node['type'] == NODE_STOP_AT_PR for node in child['nodes']):
        raise ExpansionError(f'{where} calls a flow that ends at a pull request: a call to it is its flow\'s last step '
                             '(every arrow out of it goes to an end)', where)
    if not last and not plain:
        raise ExpansionError(f'{where} calls a flow with no plain end (it ends only at a person or a pull request): '
                             'nothing after the call could run', where)
    return plain


def _placed(nodes: Sequence[dict[str, Any]], call: Mapping[str, Any], steps: list[dict[str, Any]],
            height: float) -> list[dict[str, Any]]:
    """``nodes`` with the called flow's steps where the call was, in their order, and the steps below it moved down."""
    placed: list[dict[str, Any]] = []
    for node in nodes:
        if node['id'] == call['id']:
            placed += steps
        elif node['position']['y'] > call['position']['y']:
            placed.append({**node, 'position': {**node['position'], 'y': node['position']['y'] + height}})
        else:
            placed.append(node)
    return placed


@dataclass
class _Arrows:
    """The arrows of a flow being spliced: each once (by its ends and label), each id its own."""

    edges: list[dict[str, Any]]

    def __post_init__(self) -> None:
        self.taken = {edge['id'] for edge in self.edges}
        self.seen = {(edge['source'], edge['target'], edge.get('label')) for edge in self.edges}

    def add(self, source: str, target: str, label: str | None) -> None:
        if (source, target, label) in self.seen:
            return
        self.seen.add((source, target, label))
        self.edges.append({'id': _edge_id(source, target, label, self.taken), 'source': source, 'target': target,
                           **({'label': label} if label else {})})


def _splice(graph: _Graph, call: Mapping[str, Any], child: Mapping[str, Any], where: str) -> _Graph:
    """``graph`` with ``call`` replaced by ``child`` (flat already), as the module says."""
    call_id, types = call['id'], graph.types
    start = next(node['id'] for node in child['nodes'] if node['type'] == 'start')
    into = [edge for edge in graph.edges if edge['target'] == call_id]
    after = [edge['target'] for edge in graph.edges if edge['source'] == call_id]
    plain = _plain_ends(child, last=bool(after) and all(types[target] in _TERMINAL for target in after), where=where)
    steps, height = _child_steps(call, child, where, {start, *plain})
    arrows = _Arrows([edge for edge in graph.edges if call_id not in (edge['source'], edge['target'])])
    for edge in child['edges']:
        targets = list(after) if edge['target'] in plain else [f'{call_id}{SEPARATOR}{edge["target"]}']
        sources = [(arrow['source'], arrow.get('label')) for arrow in into] if edge['source'] == start \
            else [(f'{call_id}{SEPARATOR}{edge["source"]}', edge.get('label'))]
        for target in targets:
            for source, label in sources:
                arrows.add(source, target, label)
    # (the ends the call led to that nothing reaches now: a last call whose flow ends at a pull request or a person)
    reached = {edge['target'] for edge in arrows.edges}
    nodes = [node for node in _placed(graph.nodes, call, steps, height)
             if not (node['id'] in after and node['id'] not in reached)]
    return _Graph(nodes, arrows.edges)


def _expand(definition: Mapping[str, Any], read: ReadRevision, *, chain: tuple[str, ...], depth: int, prefix: str,
            expansion: list[dict[str, Any]]) -> dict[str, Any]:
    """``definition`` with its calls expanded, its own ids kept (a called flow's are its call's, below it)."""
    graph = _Graph(copy.deepcopy(list(definition['nodes'])), copy.deepcopy(list(definition['edges'])))
    for call in calls(definition):
        where = f'{prefix}{call["id"]}'
        ref = flow_ref(_params(call).get('flow'))
        if depth >= MAX_DEPTH and (ref is None or ref[0] not in chain):   # (a cycle says more than its depth)
            raise ExpansionError(f'{where} would call a flow {depth + 1} calls deep: calls nest at most {MAX_DEPTH} '
                                 'deep (a flow, a flow it calls, a flow that one calls)', where)
        flow, revision, called = _called(call, where, read, chain)
        inputs = _params(call).get('inputs')
        unknown = sorted(set(inputs or {}) - set(called.get('inputs') or {}))
        if unknown:
            raise ExpansionError(f'{where} names inputs {flow}@{revision} does not declare: {", ".join(unknown)}',
                                 where)
        expansion.append({'step': where, 'flow': flow, 'revision': revision,
                          **({'inputs': dict(inputs)} if inputs else {})})
        child = _expand(called, read, chain=(*chain, flow), depth=depth + 1, prefix=f'{where}{SEPARATOR}',
                        expansion=expansion)
        current = next(node for node in graph.nodes if node['id'] == call['id'])
        graph = _splice(graph, current, child, where)
        if len(graph.nodes) > MAX_NODES:
            raise ExpansionError(f'with the flow {where} calls, the flow has {len(graph.nodes)} steps: at most '
                                 f'{MAX_NODES}, every call expanded', where)
    return {**definition, 'nodes': graph.nodes, 'edges': graph.edges}


def expand(definition: Mapping[str, Any], read: ReadRevision, *, root: str | None = None) -> Expanded:
    """``definition`` (an engineering flow the rules pass) with every call expanded, checked again with the server's
    rules, and its calls recorded on its start step (``EXPANSION``); ``root``: its own workflow id (None for an unsaved
    flow), so a call back to it is a cycle. A flow with no call is answered as it is, with nothing recorded.
    ``ExpansionError`` for anything the module refuses."""
    if not calls(definition):
        return Expanded(copy.deepcopy(dict(definition)))
    expansion: list[dict[str, Any]] = []
    flat = _expand(definition, read, chain=(root,) if root else (), depth=0, prefix='', expansion=expansion)
    start = next(node for node in flat['nodes'] if node['type'] == 'start')
    start['data']['params'] = {**start['data']['params'], EXPANSION: copy.deepcopy(expansion)}
    checked, broken = _checked(flat)
    if checked is None:
        rule = broken.message if broken is not None else 'it cannot be read'
        raise ExpansionError(f'once the flows it calls are in, the flow breaks a rule: {rule}',
                             None if broken is None else broken.node_id)
    return Expanded(checked, tuple(expansion))


def recorded_expansion(definition: object) -> list[dict[str, Any]]:
    """The calls a run's copy of its flow records it expanded (its start step's ``EXPANSION``, 7.52.00), as the run
    workspace's overview answers them: ``[{step, flow, revision, inputs?}]`` in the order they were expanded; empty for
    a flow with no call, a run started without a flow, and any entry off that shape (the copy is the run's record,
    read back, never trusted to be one)."""
    nodes = definition.get('nodes') if isinstance(definition, Mapping) else None
    start = next((node for node in nodes or () if isinstance(node, Mapping) and node.get('type') == 'start'), None)
    listed = _params(start).get(EXPANSION) if isinstance(start, Mapping) else None
    found: list[dict[str, Any]] = []
    for entry in listed if isinstance(listed, list) else ():
        ref = flow_ref(f'{entry.get("flow")}@{entry.get("revision")}') if isinstance(entry, Mapping) else None
        if ref is None or not isinstance(entry.get('step'), str):
            continue
        inputs = entry.get('inputs')
        found.append({'step': entry['step'][:MAX_ID_CHARS], 'flow': ref[0], 'revision': ref[1],
                      **({'inputs': {str(name): str(value) for name, value in inputs.items()}}
                         if isinstance(inputs, Mapping) and inputs else {})})
    return found


def save_issues(definition: Mapping[str, Any], read: ReadRevision, *,
                root: str | None = None) -> list[tuple[str, str | None]]:
    """What a save of ``definition`` (an engineering flow the rules pass) is refused for, as ``(message, node_id)``:
    a dotted step id (the expansion's), a recorded ``expansion`` (a run's), or a call that cannot be expanded (the
    expansion simulated on the stored flows, as a run's start will make it). Empty for anything else."""
    if not isinstance(definition, Mapping) or definition.get('schema') != SCHEMA_V2:
        return []
    issues: list[tuple[str, str | None]] = [(DOTTED, node['id']) for node in definition['nodes']
                                            if SEPARATOR in node['id']]
    issues += [(RECORDED, node['id']) for node in definition['nodes']
               if node['type'] == 'start' and EXPANSION in _params(node)]
    if issues:
        return issues
    try:
        expand(definition, read, root=root)
    except ExpansionError as refused:
        return [(refused.message, refused.node_id)]
    return []
