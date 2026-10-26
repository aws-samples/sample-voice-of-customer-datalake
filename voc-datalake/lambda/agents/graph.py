"""Read-only view of a ``voc-workflow/1`` definition, as the conductor walks it.

Validation of a definition on SAVE belongs to the agents API (``POST
/workflows/validate``); this module only refuses what it cannot walk, so a run
fails at init with a clear message instead of mid-way.

Branching: a node's outcome (``pass``/``fail``/``agreed``/``not_agreed``) picks
the outgoing edges with that label; unlabelled edges are the default. Several
chosen edges are a fan-out, run sequentially by the conductor, which holds a
join node until every forward predecessor has run. Loops are
declared, and a loop's round counter advances each time its gate node (the
``persona_review`` for ``persona_agreement``, any node for ``review_pass``)
reports a failing outcome.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agents.fields import dict_field
from shared.workflow_schema import normalise_custom_step_arrows

SCHEMA = 'voc-workflow/1'
NODE_TYPES = frozenset({
    'start', 'aggregate_reviews', 'select_or_create_project', 'select_personas',
    'generate_personas', 'deep_research', 'write_prfaq', 'write_prd', 'persona_review',
    'revise_document', 'build_prototype', 'collect_prototype_feedback', 'revise_prototype', 'final_review',
    'duplicate_document', 'handoff', 'custom_llm', 'end',
})
ROLES = frozenset({'orchestrator', 'worker', 'reviewer', 'persona'})
EDGE_LABELS = frozenset({'pass', 'fail', 'agreed', 'not_agreed'})
FAILING_OUTCOMES = frozenset({'fail', 'not_agreed'})
# The path a step with no verdict takes when it has no unlabelled arrow (see next_nodes).
NO_VERDICT_EDGE_LABEL = 'pass'
LOOP_UNTIL = frozenset({'persona_agreement', 'review_pass'})
MAX_NODES = 60
MAX_LOOP_ROUNDS = 5

DEFAULT_ROLES = {
    'aggregate_reviews': 'worker',
    'select_or_create_project': 'orchestrator',
    'select_personas': 'orchestrator',
    'generate_personas': 'worker',
    'deep_research': 'worker',
    'write_prfaq': 'worker',
    'write_prd': 'worker',
    'persona_review': 'persona',
    'revise_document': 'worker',
    'build_prototype': 'worker',
    'collect_prototype_feedback': 'worker',
    'revise_prototype': 'worker',
    'final_review': 'reviewer',
    'duplicate_document': 'orchestrator',
    'handoff': 'orchestrator',
    'custom_llm': 'worker',
    'start': 'orchestrator',
    'end': 'orchestrator',
}


class WorkflowError(ValueError):
    """The definition cannot be walked."""


@dataclass(frozen=True)
class Node:
    id: str
    type: str
    title: str
    instructions: str
    role: str
    params: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Edge:
    source: str
    target: str
    label: str | None


@dataclass(frozen=True)
class Loop:
    index: int
    node_ids: frozenset[str]
    until: str
    max_rounds: int


def _str(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ''


def _parse_node(raw: Any) -> Node:
    if not isinstance(raw, dict):
        raise WorkflowError('every node must be an object')
    node_id = _str(raw.get('id'), 64)
    node_type = raw.get('type')
    if not node_id or node_type not in NODE_TYPES:
        raise WorkflowError(f'node {node_id or "?"} has an unknown type')
    data = dict_field(raw, 'data')
    raw_role = data.get('role')
    role = raw_role if isinstance(raw_role, str) and raw_role in ROLES else DEFAULT_ROLES[node_type]
    params = dict_field(data, 'params')
    return Node(
        id=node_id, type=node_type, title=_str(data.get('title'), 200) or node_type,
        instructions=_str(data.get('instructions'), 8000), role=role, params=dict(params),
    )


def _parse_loop(index: int, raw: Any, node_ids: set[str]) -> Loop:
    if not isinstance(raw, dict):
        raise WorkflowError('every loop must be an object')
    members = raw.get('node_ids')
    rounds = raw.get('max_rounds')
    if (
        not isinstance(members, list) or not members
        or not all(isinstance(m, str) and m in node_ids for m in members)
        or raw.get('until') not in LOOP_UNTIL
        or not isinstance(rounds, int) or isinstance(rounds, bool)
        or not 1 <= rounds <= MAX_LOOP_ROUNDS
    ):
        raise WorkflowError(f'loop {index + 1} is malformed')
    return Loop(index=index, node_ids=frozenset(members), until=raw['until'], max_rounds=rounds)


class WorkflowGraph:
    def __init__(self, definition: Any):
        if not isinstance(definition, dict) or definition.get('schema') != SCHEMA:
            raise WorkflowError(f'definition is not {SCHEMA}')
        # A pre-3.00.00 pass/fail arrow out of a custom step is read as the plain
        # arrow it always behaved as (never a reason to fail a run).
        definition = normalise_custom_step_arrows(definition)
        raw_nodes = definition.get('nodes')
        if not isinstance(raw_nodes, list) or not 2 <= len(raw_nodes) <= MAX_NODES:
            raise WorkflowError(f'a workflow needs 2-{MAX_NODES} nodes')
        nodes = [_parse_node(raw) for raw in raw_nodes]
        self.nodes: dict[str, Node] = {}
        for node in nodes:
            if node.id in self.nodes:
                raise WorkflowError(f'duplicate node id {node.id}')
            self.nodes[node.id] = node
        starts = [n for n in nodes if n.type == 'start']
        if len(starts) != 1:
            raise WorkflowError('a workflow needs exactly one start node')
        self.start = starts[0]
        self.edges: list[Edge] = []
        for raw in definition.get('edges') or []:
            if not isinstance(raw, dict):
                raise WorkflowError('every edge must be an object')
            source, target = raw.get('source'), raw.get('target')
            label = raw.get('label') if raw.get('label') in EDGE_LABELS else None
            if source not in self.nodes or target not in self.nodes:
                raise WorkflowError('an edge points at a missing node')
            self.edges.append(Edge(source=source, target=target, label=label))
        self.loops = [
            _parse_loop(i, raw, set(self.nodes)) for i, raw in enumerate(definition.get('loops') or [])
        ]
        if not any(n.type == 'end' for n in nodes):
            raise WorkflowError('a workflow needs an end node')

    def node(self, node_id: str) -> Node:
        try:
            return self.nodes[node_id]
        except KeyError as exc:
            raise WorkflowError(f'unknown node {node_id}') from exc

    def next_nodes(self, node_id: str, outcome: str | None) -> list[Node]:
        """Every successor for ``outcome``: its labelled edges, else the default (unlabelled) ones.

        A step that reports NO outcome and has no unlabelled edge follows its ``pass`` edges:
        no verdict is not a failure (E2E s2 F4). ``custom_llm`` steps never report one and
        can no longer carry pass/fail arrows; older stored ones are normalised to plain
        arrows on read (``shared.workflow_schema.normalise_custom_step_arrows``).

        More than one is a fan-out (e.g. personas ‖ research after the project
        step); the conductor runs the branches one after another and holds a
        join until its forward predecessors have run (:meth:`forward_predecessors`).
        """
        outgoing = [e for e in self.edges if e.source == node_id]
        chosen = [e for e in outgoing if outcome and e.label == outcome]
        if not chosen:
            chosen = [e for e in outgoing if e.label is None]
        if not chosen and not outcome:
            chosen = [e for e in outgoing if e.label == NO_VERDICT_EDGE_LABEL]
        targets: list[Node] = []
        for edge in chosen:
            if self.nodes[edge.target] not in targets:
                targets.append(self.nodes[edge.target])
        return targets

    def forward_predecessors(self, node_id: str) -> set[str]:
        """Sources of the edges into ``node_id``, minus a loop's own back edges."""
        loop_mates = {m for loop in self.loops if node_id in loop.node_ids for m in loop.node_ids}
        return {e.source for e in self.edges if e.target == node_id and e.source not in loop_mates}

    def gating_loop(self, node: Node) -> Loop | None:
        """The loop whose round counter this node's failing outcome advances."""
        for loop in self.loops:
            if node.id not in loop.node_ids:
                continue
            if loop.until == 'persona_agreement' and node.type == 'persona_review':
                return loop
            if loop.until == 'review_pass' and node.type != 'persona_review':
                return loop
        return None
