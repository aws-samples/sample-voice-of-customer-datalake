"""The autonomous-agent workflow definition: model, validation, template and diff.

Pure (no AWS clients): the agents API validates and stores definitions with it,
the heartbeat and the run interpreter read the same model, and the assistant's
``update_workflow`` preview is built from :func:`diff_definitions`.

A definition (``schema: 'voc-workflow/1'``) is a directed graph::

    {schema, name, description,
     nodes: [{id, type, position: {x, y}, data: {title, instructions?, role?, params}}],
     edges: [{id, source, target, label?: 'pass'|'fail'|'agreed'|'not_agreed'}],
     loops: [{node_ids, until: 'persona_agreement'|'review_pass', max_rounds}]}

Rules (each failure is reported, none is silently repaired):

- exactly one ``start``, at least one ``end``; ``start`` has no incoming edge and
  ``end`` no outgoing one;
- every node is reachable from ``start`` and has a path to an ``end`` (no orphan
  and no dead end — a run that reaches a dead end could never finish);
- a cycle is allowed only inside ONE declared loop, every declared loop contains a
  cycle, loops do not share nodes and never contain ``start``/``end``;
- ``max_rounds`` is 1 to 5; a ``persona_agreement`` loop contains a
  ``persona_review``; a ``review_pass`` loop contains a reviewing node;
- ``agreed``/``not_agreed`` labels only leave a ``persona_review``; ``pass``/``fail``
  labels never leave a ``custom_llm`` step (it reports no verdict);
- at most 60 nodes; bounded text everywhere; the stored JSON is bounded so a
  revision always fits one DynamoDB item.

Unknown top-level keys (``exported_from`` on an imported file, say) are dropped by
normalisation; unknown keys inside nodes and edges are dropped too.

A stored definition from before 3.00.00 may still carry ``pass``/``fail`` arrows
out of a custom step. They are normalised ON READ (:func:`decode_definition`,
:func:`normalise_custom_step_arrows`) to what the runtime always did with them,
so such a workflow keeps running and can be re-saved; only a NEW labelled arrow
out of a custom step is refused.
"""

from __future__ import annotations

import json
import math
import re
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final

SCHEMA: Final = 'voc-workflow/1'
DEFAULT_WORKFLOW_ID: Final = 'wf_default'
DEFAULT_WORKFLOW_SLUG: Final = 'reviews-to-prototype'

NODE_START: Final = 'start'
NODE_END: Final = 'end'
NODE_PERSONA_REVIEW: Final = 'persona_review'
NODE_FINAL_REVIEW: Final = 'final_review'
NODE_CUSTOM_LLM: Final = 'custom_llm'
NODE_TYPES: Final = (
    NODE_START, 'aggregate_reviews', 'select_or_create_project', 'select_personas', 'generate_personas',
    'deep_research', 'write_prfaq', 'write_prd', NODE_PERSONA_REVIEW, 'revise_document', 'build_prototype',
    'collect_prototype_feedback', 'revise_prototype', NODE_FINAL_REVIEW, 'duplicate_document', 'handoff', NODE_CUSTOM_LLM, NODE_END,
)
ROLES: Final = ('orchestrator', 'worker', 'reviewer', 'persona')
EDGE_LABELS: Final = ('pass', 'fail', 'agreed', 'not_agreed')
PERSONA_LABELS: Final = frozenset({'agreed', 'not_agreed'})
LOOP_UNTIL: Final = ('persona_agreement', 'review_pass')
REVIEW_TARGETS: Final = ('prfaq', 'prd', 'prototype')
END_STATUSES: Final = ('completed', 'needs_human')
# Nodes that emit a pass/fail verdict a `review_pass` loop can stop on. Not
# `custom_llm`: a custom step never reports an outcome (agents/nodes/custom_llm.py).
_VERDICT_NODES: Final = frozenset({NODE_PERSONA_REVIEW, NODE_FINAL_REVIEW})
# Verdict labels a custom step's arrows used to be offered and can no longer carry.
_CUSTOM_STEP_VERDICT_LABELS: Final = frozenset({'pass', 'fail'})

MAX_NODES: Final = 60
MAX_EDGES: Final = 240
MAX_LOOPS: Final = 10
MIN_ROUNDS: Final = 1
MAX_ROUNDS: Final = 5
MAX_NAME_CHARS: Final = 120
MAX_DESCRIPTION_CHARS: Final = 2000
MAX_TITLE_CHARS: Final = 120
MAX_NODE_INSTRUCTIONS_CHARS: Final = 4000
MAX_PARAMS_BYTES: Final = 4096
MAX_COORDINATE: Final = 1_000_000
# A revision is stored as one JSON string on one item (≤ 400 KB); this leaves room
# for the item's other attributes.
MAX_DEFINITION_BYTES: Final = 300_000
_ID_RE: Final = re.compile(r'[A-Za-z0-9_-]{1,64}')


@dataclass(frozen=True)
class Issue:
    """One validation finding, optionally pinned to a node."""

    message: str
    node_id: str | None = None

    def to_dict(self) -> dict[str, str]:
        return {'message': self.message, **({'node_id': self.node_id} if self.node_id else {})}


@dataclass(frozen=True)
class ValidationResult:
    """``definition`` is the normalised definition when ``valid``, else None."""

    errors: tuple[Issue, ...]
    definition: dict[str, Any] | None = None

    @property
    def valid(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict[str, Any]:
        """The ``POST /workflows/validate`` body."""
        return {'valid': self.valid, 'errors': [issue.to_dict() for issue in self.errors]}


@dataclass
class _Collector:
    errors: list[Issue] = field(default_factory=list)

    def add(self, message: str, node_id: str | None = None) -> None:
        self.errors.append(Issue(message, node_id))


# --------------------------------------------------------------------------
# Shape: one parser per element, each normalising what it accepts.
# --------------------------------------------------------------------------

def _text(value: object, label: str, max_chars: int, out: _Collector, *, required: bool,
          node_id: str | None = None) -> str:
    text = value.strip() if isinstance(value, str) else ''
    if value is not None and not isinstance(value, str):
        out.add(f'{label} must be a string', node_id)
        return text
    if required and not text:
        out.add(f'{label} is required', node_id)
    if len(text) > max_chars:
        out.add(f'{label} must be at most {max_chars} characters', node_id)
    return text


def _identifier(value: object, label: str, out: _Collector, node_id: str | None = None) -> str | None:
    if isinstance(value, str) and _ID_RE.fullmatch(value):
        return value
    out.add(f'{label} must be 1-64 letters, digits, "_" or "-"', node_id)
    return None


def _coordinate(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and abs(number) <= MAX_COORDINATE else None


def _position(value: object, out: _Collector, node_id: str) -> dict[str, float]:
    if not isinstance(value, Mapping):
        out.add('position must be an object {x, y}', node_id)
        return {}
    x, y = _coordinate(value.get('x')), _coordinate(value.get('y'))
    if x is None or y is None:
        out.add(f'position x and y must be finite numbers within ±{MAX_COORDINATE}', node_id)
    return {'x': x or 0.0, 'y': y or 0.0}


def _params(node_type: str, value: object, out: _Collector, node_id: str) -> dict[str, Any]:
    if value is None:
        value = {}
    if not isinstance(value, Mapping):
        out.add('params must be an object', node_id)
        return {}
    params = dict(value)
    try:
        encoded = json.dumps(params, allow_nan=False)
    except (TypeError, ValueError):
        out.add('params must be plain JSON (no NaN or Infinity)', node_id)
        return {}
    if len(encoded.encode('utf-8')) > MAX_PARAMS_BYTES:
        out.add(f'params must be at most {MAX_PARAMS_BYTES} bytes of JSON', node_id)
    if node_type == NODE_PERSONA_REVIEW and params.get('target') not in REVIEW_TARGETS:
        out.add(f"persona_review needs params.target: one of {', '.join(REVIEW_TARGETS)}", node_id)
    if node_type == NODE_END and params.get('status', 'completed') not in END_STATUSES:
        out.add(f"end params.status must be one of {', '.join(END_STATUSES)}", node_id)
    return params


def _node_data(node_type: str, value: object, out: _Collector, node_id: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        out.add('data must be an object', node_id)
        return {}
    data: dict[str, Any] = {
        'title': _text(value.get('title'), 'title', MAX_TITLE_CHARS, out, required=True, node_id=node_id),
    }
    instructions = _text(value.get('instructions'), 'instructions', MAX_NODE_INSTRUCTIONS_CHARS, out,
                         required=node_type == NODE_CUSTOM_LLM, node_id=node_id)
    if instructions:
        data['instructions'] = instructions
    role = value.get('role')
    if role is not None:
        if role in ROLES:
            data['role'] = role
        else:
            out.add(f"role must be one of {', '.join(ROLES)}", node_id)
    data['params'] = _params(node_type, value.get('params'), out, node_id)
    return data


def _node(value: object, index: int, out: _Collector) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        out.add(f'node {index + 1} must be an object')
        return None
    node_id = _identifier(value.get('id'), f'node {index + 1} id', out)
    if node_id is None:
        return None
    node_type = value.get('type')
    if node_type not in NODE_TYPES:
        out.add('unknown node type', node_id)
        return None
    return {
        'id': node_id,
        'type': node_type,
        'position': _position(value.get('position'), out, node_id),
        'data': _node_data(node_type, value.get('data'), out, node_id),
    }


def _edge(value: object, index: int, out: _Collector) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        out.add(f'edge {index + 1} must be an object')
        return None
    edge_id = _identifier(value.get('id'), f'edge {index + 1} id', out)
    source = _identifier(value.get('source'), f'edge {index + 1} source', out)
    target = _identifier(value.get('target'), f'edge {index + 1} target', out)
    label = value.get('label')
    if label is not None and label not in EDGE_LABELS:
        out.add(f"edge {index + 1} label must be one of {', '.join(EDGE_LABELS)}")
        return None
    if edge_id is None or source is None or target is None:
        return None
    return {'id': edge_id, 'source': source, 'target': target, **({'label': label} if label else {})}


def _loop(value: object, index: int, out: _Collector) -> dict[str, Any] | None:
    label = f'loop {index + 1}'
    if not isinstance(value, Mapping):
        out.add(f'{label} must be an object')
        return None
    raw_ids = value.get('node_ids')
    if not isinstance(raw_ids, list) or not raw_ids:
        out.add(f'{label} needs a non-empty node_ids list')
        return None
    node_ids = [node_id for node_id in raw_ids if _identifier(node_id, f'{label} node id', out)]
    if len(node_ids) != len(raw_ids):
        return None
    if len(set(node_ids)) != len(node_ids):
        out.add(f'{label} lists a node twice')
    until = value.get('until')
    if until not in LOOP_UNTIL:
        out.add(f"{label} until must be one of {', '.join(LOOP_UNTIL)}")
    rounds = value.get('max_rounds')
    if isinstance(rounds, bool) or not isinstance(rounds, int) or not MIN_ROUNDS <= rounds <= MAX_ROUNDS:
        out.add(f'{label} max_rounds must be a whole number from {MIN_ROUNDS} to {MAX_ROUNDS}')
    return {'node_ids': list(dict.fromkeys(node_ids)), 'until': until, 'max_rounds': rounds}


def _elements(raw: Mapping[str, Any], key: str, limit: int, out: _Collector) -> list | None:
    value = raw.get(key, [] if key == 'loops' else None)
    if not isinstance(value, list):
        out.add(f'{key} must be a list')
        return None
    if len(value) > limit:
        out.add(f'at most {limit} {key} are allowed')
        return None
    return value


def _unique(items: list[dict[str, Any]], kind: str, out: _Collector) -> None:
    seen: set[str] = set()
    for item in items:
        if item['id'] in seen:
            out.add(f'{kind} id is used more than once', item['id'] if kind == 'node' else None)
        seen.add(item['id'])


def _parse(raw: object, out: _Collector) -> dict[str, Any] | None:
    """The normalised definition, or None when its shape is broken."""
    if not isinstance(raw, Mapping):
        out.add('definition must be a JSON object')
        return None
    if raw.get('schema') != SCHEMA:
        out.add(f"schema must be '{SCHEMA}'")
    name = _text(raw.get('name'), 'name', MAX_NAME_CHARS, out, required=True)
    description = _text(raw.get('description'), 'description', MAX_DESCRIPTION_CHARS, out, required=False)
    raw_nodes = _elements(raw, 'nodes', MAX_NODES, out)
    raw_edges = _elements(raw, 'edges', MAX_EDGES, out)
    raw_loops = _elements(raw, 'loops', MAX_LOOPS, out)
    if raw_nodes is None or raw_edges is None or raw_loops is None:
        return None
    nodes = [node for i, value in enumerate(raw_nodes) if (node := _node(value, i, out))]
    edges = [edge for i, value in enumerate(raw_edges) if (edge := _edge(value, i, out))]
    loops = [loop for i, value in enumerate(raw_loops) if (loop := _loop(value, i, out))]
    _unique(nodes, 'node', out)
    _unique(edges, 'edge', out)
    return {'schema': SCHEMA, 'name': name, 'description': description,
            'nodes': nodes, 'edges': edges, 'loops': loops}


# --------------------------------------------------------------------------
# Graph rules, run only on a definition whose shape is sound.
# --------------------------------------------------------------------------

def _reach(start: str, adjacency: Mapping[str, list[str]]) -> set[str]:
    """Nodes reachable from ``start`` by one or more edges."""
    seen: set[str] = set()
    queue = deque(adjacency.get(start, ()))
    while queue:
        node = queue.popleft()
        if node not in seen:
            seen.add(node)
            queue.extend(adjacency.get(node, ()))
    return seen


def _check_edges(definition: dict[str, Any], types: Mapping[str, str], out: _Collector) -> None:
    seen_links = set[tuple[str, str, str | None]]()
    for edge in definition['edges']:
        source, target, label = edge['source'], edge['target'], edge.get('label')
        if source not in types or target not in types:
            out.add('edge connects a node that does not exist', source if source in types else None)
            continue
        if types[source] == NODE_END:
            out.add('an end step cannot have outgoing arrows', source)
        if types[target] == NODE_START:
            out.add('the start step cannot have incoming arrows', target)
        if label in PERSONA_LABELS and types[source] != NODE_PERSONA_REVIEW:
            out.add(f"'{label}' arrows can only leave a persona review", source)
        if label in _CUSTOM_STEP_VERDICT_LABELS and types[source] == NODE_CUSTOM_LLM:
            out.add(f"a custom step reports no pass/fail verdict, so its arrows cannot be '{label}'"
                    ' — use a plain arrow', source)
        if (source, target, label) in seen_links:
            out.add('two arrows connect the same steps with the same label', source)
        seen_links.add((source, target, label))


def _check_reachability(definition: dict[str, Any], types: Mapping[str, str],
                        forward: Mapping[str, list[str]], backward: Mapping[str, list[str]],
                        out: _Collector) -> None:
    starts = [node_id for node_id, kind in types.items() if kind == NODE_START]
    ends = [node_id for node_id, kind in types.items() if kind == NODE_END]
    if len(starts) != 1:
        out.add('a workflow needs exactly one start step')
    if not ends:
        out.add('a workflow needs at least one end step')
    if len(starts) != 1 or not ends:
        return
    reachable = _reach(starts[0], forward) | {starts[0]}
    reaches_end: set[str] = set(ends)
    for end in ends:
        reaches_end |= _reach(end, backward)
    for node in definition['nodes']:
        if node['id'] not in reachable:
            out.add('this step is not connected to the start', node['id'])
        elif node['id'] not in reaches_end:
            out.add('this step has no path to an end step', node['id'])


def _loop_owners(definition: dict[str, Any], types: Mapping[str, str], out: _Collector) -> dict[str, int]:
    """Which declared loop each step belongs to, checking each loop's membership."""
    owner: dict[str, int] = {}
    for index, loop in enumerate(definition['loops']):
        members = loop['node_ids']
        for node_id in members:
            if node_id not in types:
                out.add(f'loop {index + 1} lists a step that does not exist')
                continue
            if types[node_id] in (NODE_START, NODE_END):
                out.add('start and end steps cannot be inside a loop', node_id)
            if node_id in owner:  # _loop de-duplicates node_ids, so an owner is always another loop
                out.add('a step can belong to only one loop', node_id)
            owner.setdefault(node_id, index)
        member_types = {types.get(node_id) for node_id in members}
        if loop['until'] == 'persona_agreement' and NODE_PERSONA_REVIEW not in member_types:
            out.add(f'loop {index + 1} repeats until persona agreement but contains no persona review')
        if loop['until'] == 'review_pass' and not member_types & _VERDICT_NODES:
            out.add(f'loop {index + 1} repeats until a review passes but contains no reviewing step')
    return owner


def _check_loops(definition: dict[str, Any], types: Mapping[str, str],
                 forward: Mapping[str, list[str]], out: _Collector) -> None:
    owner = _loop_owners(definition, types, out)

    reach = {node_id: _reach(node_id, forward) for node_id in types}
    cyclic_loops: set[int] = set()
    for node_id in types:
        if node_id not in reach[node_id]:
            continue  # not on any cycle
        component = {other for other in reach[node_id] if node_id in reach[other]}
        loop_index = owner.get(node_id)
        if loop_index is None or any(owner.get(other) != loop_index for other in component):
            out.add('this step is in a cycle that is not inside one declared loop', node_id)
        else:
            cyclic_loops.add(loop_index)
    for index in range(len(definition['loops'])):
        if index not in cyclic_loops:
            out.add(f'loop {index + 1} has no arrow back to an earlier step in the loop')


def _check_graph(definition: dict[str, Any], out: _Collector) -> None:
    types = {node['id']: node['type'] for node in definition['nodes']}
    forward: dict[str, list[str]] = {node_id: [] for node_id in types}
    backward: dict[str, list[str]] = {node_id: [] for node_id in types}
    for edge in definition['edges']:
        if edge['source'] in types and edge['target'] in types:
            forward[edge['source']].append(edge['target'])
            backward[edge['target']].append(edge['source'])
    _check_edges(definition, types, out)
    _check_reachability(definition, types, forward, backward, out)
    _check_loops(definition, types, forward, out)


def validate_definition(raw: object) -> ValidationResult:
    """Validate (and normalise) a workflow definition. Never raises."""
    out = _Collector()
    definition = _parse(raw, out)
    if definition is None or out.errors:
        # Graph rules on a half-parsed graph only produce noise about the parts
        # that failed to parse; report the shape first.
        return ValidationResult(errors=tuple(out.errors))
    _check_graph(definition, out)
    if not out.errors and len(encode_definition(definition).encode('utf-8')) > MAX_DEFINITION_BYTES:
        out.add(f'the workflow is too large to save (at most {MAX_DEFINITION_BYTES} bytes of JSON)')
    if out.errors:
        return ValidationResult(errors=tuple(out.errors))
    return ValidationResult(errors=(), definition=definition)


def encode_definition(definition: Mapping[str, Any]) -> str:
    """The stored form: compact, key-sorted JSON (floats survive; DynamoDB numbers would not)."""
    return json.dumps(definition, sort_keys=True, separators=(',', ':'), allow_nan=False)


def decode_definition(stored: object) -> dict[str, Any] | None:
    """A stored definition back as a dict (custom-step arrows normalised), or None for anything malformed."""
    if not isinstance(stored, str):
        return None
    try:
        value = json.loads(stored)
    except ValueError:
        return None
    return normalise_custom_step_arrows(value) if isinstance(value, dict) else None


def _custom_step_ids(nodes: object) -> set[str]:
    if not isinstance(nodes, list):
        return set()
    return {node['id'] for node in nodes
            if isinstance(node, Mapping) and node.get('type') == NODE_CUSTOM_LLM and isinstance(node.get('id'), str)}


def normalise_custom_step_arrows(definition: dict[str, Any]) -> dict[str, Any]:
    """``definition`` with every pass/fail arrow out of a custom step read as the runtime ran it.

    Pre-3.00.00 workflows could label a custom step's arrows pass/fail although the
    step reports no verdict. ``agents.graph.WorkflowGraph.next_nodes`` with no
    outcome takes a step's unlabelled arrows, else its ``pass`` arrows. So a
    ``pass`` arrow becomes a plain arrow, while a ``fail`` arrow — and a ``pass``
    arrow beside an unlabelled one — was never taken and is dropped rather than
    turned into a new live path. The workflow therefore runs exactly as before and
    saves cleanly. Order is kept; a duplicate the relabel would create (same
    source and target, both plain) is dropped. Anything malformed is left for the
    validator / walker to report. Never mutates its input.
    """
    edges = definition.get('edges')
    custom = _custom_step_ids(definition.get('nodes'))
    if not isinstance(edges, list) or not custom:
        return definition
    links = [edge for edge in edges if isinstance(edge, Mapping)]
    affected = {edge.get('source') for edge in links
                if edge.get('source') in custom and edge.get('label') in _CUSTOM_STEP_VERDICT_LABELS}
    if not affected:
        return definition
    shadowed = {edge.get('source') for edge in links if edge.get('source') in affected and edge.get('label') is None}
    result: list[Any] = []
    seen_plain: set[tuple[object, object]] = set()
    for edge in edges:
        if not isinstance(edge, Mapping) or edge.get('source') not in affected:
            result.append(edge)
            continue
        label = edge.get('label')
        if label == 'fail' or (label == 'pass' and edge.get('source') in shadowed):
            continue  # never taken: dropped, not revived
        if label is not None and label not in _CUSTOM_STEP_VERDICT_LABELS:
            result.append(edge)  # another label: the validator reports it
            continue
        link = (edge.get('source'), edge.get('target'))
        if link in seen_plain:
            continue
        seen_plain.add(link)
        result.append({key: value for key, value in edge.items() if key != 'label'})
    return {**definition, 'edges': result}


# --------------------------------------------------------------------------
# Library helpers: export envelope, import lineage.
# --------------------------------------------------------------------------

def export_document(definition: Mapping[str, Any], *, workflow_id: str, revision: int, slug: str) -> dict:
    """``GET /workflows/{id}/export``: the definition plus where it came from."""
    return {**definition, 'exported_from': {'workflow_id': workflow_id, 'revision': revision, 'slug': slug}}


def imported_lineage(raw: object) -> str | None:
    """The ``exported_from.workflow_id`` an imported file names, if well formed."""
    origin = raw.get('exported_from') if isinstance(raw, Mapping) else None
    workflow_id = origin.get('workflow_id') if isinstance(origin, Mapping) else None
    return workflow_id if isinstance(workflow_id, str) and _ID_RE.fullmatch(workflow_id) else None


def slugify(name: str) -> str:
    """A URL-safe slug for a workflow name (``'workflow'`` when nothing survives)."""
    slug = '-'.join(re.findall(r'[a-z0-9]+', name.lower()))
    # Words are joined by single hyphens, so a cut leaves at most one trailing hyphen.
    return re.sub('-$', '', slug[:60]) or 'workflow'


# --------------------------------------------------------------------------
# Diff (assistant preview of update_workflow).
# --------------------------------------------------------------------------

_NODE_FIELDS: Final = (
    ('type', lambda n: n.get('type')),
    ('position', lambda n: n.get('position')),
    ('title', lambda n: (n.get('data') or {}).get('title')),
    ('instructions', lambda n: (n.get('data') or {}).get('instructions')),
    ('role', lambda n: (n.get('data') or {}).get('role')),
    ('params', lambda n: (n.get('data') or {}).get('params') or {}),
)
_EDGE_FIELDS: Final = ('source', 'target', 'label')


def _by_id(items: object) -> dict[str, Mapping[str, Any]]:
    if not isinstance(items, list):
        return {}
    return {item['id']: item for item in items
            if isinstance(item, Mapping) and isinstance(item.get('id'), str)}


def _diff_items(before: dict[str, Mapping[str, Any]], after: dict[str, Mapping[str, Any]],
                fields: tuple[tuple[str, Any], ...]) -> dict[str, list]:
    changed = []
    for item_id in sorted(before.keys() & after.keys()):
        names = [name for name, read in fields if read(before[item_id]) != read(after[item_id])]
        if names:
            changed.append({'id': item_id, 'fields': names})
    return {
        'added': sorted(after.keys() - before.keys()),
        'removed': sorted(before.keys() - after.keys()),
        'changed': changed,
    }


def _loop_key(loop: object) -> tuple:
    if not isinstance(loop, Mapping):
        return ()
    ids = loop.get('node_ids')
    return (tuple(sorted(i for i in ids if isinstance(i, str))) if isinstance(ids, list) else (),
            loop.get('until'), loop.get('max_rounds'))


def diff_definitions(before: Mapping[str, Any] | None, after: Mapping[str, Any]) -> dict[str, Any]:
    """What ``after`` adds, removes and changes relative to ``before`` (None = new).

    ``{nodes: {added, removed, changed: [{id, fields}]}, edges: {...}, loops_changed,
    meta_changed: ['name'|'description'], unchanged}``. A moved node lists
    ``position`` among its changed fields so a preview can show or hide moves.
    """
    before = before or {}
    edge_fields = tuple((name, lambda e, name=name: e.get(name)) for name in _EDGE_FIELDS)
    nodes = _diff_items(_by_id(before.get('nodes')), _by_id(after.get('nodes')), _NODE_FIELDS)
    edges = _diff_items(_by_id(before.get('edges')), _by_id(after.get('edges')), edge_fields)
    loops_before = sorted(_loop_key(loop) for loop in before.get('loops') or [])
    loops_after = sorted(_loop_key(loop) for loop in after.get('loops') or [])
    meta = [name for name in ('name', 'description') if before.get(name) != after.get(name)]
    loops_changed = loops_before != loops_after
    unchanged = not (meta or loops_changed or any(nodes.values()) or any(edges.values()))
    return {'nodes': nodes, 'edges': edges, 'loops_changed': loops_changed,
            'meta_changed': meta, 'unchanged': unchanged}


# --------------------------------------------------------------------------
# The built-in template `wf_default` — "Reviews → Prototype" (todofeatures §1.4).
# --------------------------------------------------------------------------

# Each node row holds: id, type, title, role, column, row, params, instructions.
_TEMPLATE_NODES: Final = (
    ('start', NODE_START, 'Start', None, 1, 0, {}, ''),
    ('aggregate', 'aggregate_reviews', 'Aggregate reviews in scope', 'worker', 1, 1, {},
     'Group the reviews in scope since the last run into the top problems by category and '
     'subcategory. Cite review ids for every problem.'),
    ('project', 'select_or_create_project', 'Choose or create the project', 'orchestrator', 1, 2, {},
     "Reuse the project whose purpose covers these problems, or create a new one and record its purpose. "
     'Never merge, move or delete projects.'),
    ('personas_fixed', 'select_personas', 'Fixed personas', 'orchestrator', 0, 3, {}, ''),
    ('personas_new', 'generate_personas', 'Generate personas from the reviews', 'worker', 1, 3,
     {'max_new': 3}, ''),
    ('research', 'deep_research', 'Deep research (with web)', 'worker', 2, 3, {'use_web_search': True}, ''),
    ('prfaq', 'write_prfaq', 'Write the PR/FAQ', 'worker', 1, 4, {},
     'Use the research, the personas and the company context.'),
    ('prfaq_review', NODE_PERSONA_REVIEW, 'Persona review of the PR/FAQ', 'persona', 1, 5,
     {'target': 'prfaq'}, ''),
    ('prfaq_revise', 'revise_document', 'Revise the PR/FAQ', 'worker', 2, 5, {'target': 'prfaq'}, ''),
    ('prototype', 'build_prototype', 'Build the prototype', 'worker', 1, 6, {},
     "Follow the company design system's tokens and guidelines."),
    ('prototype_review', NODE_PERSONA_REVIEW, 'Persona review of the prototype', 'persona', 1, 7,
     {'target': 'prototype'}, ''),
    ('prfaq_rework', 'revise_document', 'Rework the PR/FAQ', 'worker', 2, 7, {'target': 'prfaq'}, ''),
    ('prototype_feedback', 'collect_prototype_feedback', 'Collect tester pins', 'worker', 3, 7, {}, ''),
    ('prototype_revise', 'revise_prototype', 'Rebuild the prototype', 'worker', 2, 8, {}, ''),
    ('final_review', NODE_FINAL_REVIEW, 'Final review', 'reviewer', 1, 9, {},
     'Check the PR/FAQ and prototype against the acceptance checklist.'),
    ('handoff', 'handoff', 'Hand off to the owner', 'orchestrator', 1, 10, {}, ''),
    ('end', NODE_END, 'Done', None, 1, 11, {'status': 'completed'}, ''),
    ('needs_human', NODE_END, 'Needs a human', None, 2, 10, {'status': 'needs_human'}, ''),
)
# Each edge row holds: source, target, label.
_TEMPLATE_EDGES: Final = (
    ('start', 'aggregate', None),
    ('aggregate', 'project', None),
    ('project', 'personas_fixed', None),
    ('project', 'personas_new', None),
    ('project', 'research', None),
    ('personas_fixed', 'prfaq', None),
    ('personas_new', 'prfaq', None),
    ('research', 'prfaq', None),
    ('prfaq', 'prfaq_review', None),
    ('prfaq_review', 'prfaq_revise', 'not_agreed'),
    ('prfaq_revise', 'prfaq_review', None),
    ('prfaq_review', 'prototype', 'agreed'),
    ('prototype', 'prototype_review', None),
    ('prototype_review', 'prfaq_rework', 'not_agreed'),
    ('prfaq_rework', 'prototype_feedback', None),
    ('prototype_feedback', 'prototype_revise', None),
    ('prototype_revise', 'prototype_review', None),
    ('prototype_review', 'final_review', 'agreed'),
    ('final_review', 'handoff', 'pass'),
    ('final_review', 'needs_human', 'fail'),
    ('handoff', 'end', None),
)
_COLUMN_WIDTH: Final = 280
_ROW_HEIGHT: Final = 140


def _template_node(spec: tuple) -> dict[str, Any]:
    node_id, node_type, title, role, column, row, params, instructions = spec
    data: dict[str, Any] = {'title': title, 'params': dict(params)}
    if role:
        data['role'] = role
    if instructions:
        data['instructions'] = instructions
    return {'id': node_id, 'type': node_type,
            'position': {'x': float(column * _COLUMN_WIDTH), 'y': float(row * _ROW_HEIGHT)}, 'data': data}


def default_template() -> dict[str, Any]:
    """A fresh copy of the built-in ``wf_default`` "Reviews → Prototype" definition."""
    return {
        'schema': SCHEMA,
        'name': 'Reviews → Prototype',
        'description': (
            'Aggregate the reviews in scope, choose or create the project, gather personas and research, '
            'write a PR/FAQ until the personas agree, build a prototype with the company design system, '
            'review it with the personas, then a final review and hand-off.'
        ),
        'nodes': [_template_node(spec) for spec in _TEMPLATE_NODES],
        'edges': [
            {'id': f'e_{source}__{target}', 'source': source, 'target': target, **({'label': label} if label else {})}
            for source, target, label in _TEMPLATE_EDGES
        ],
        'loops': [
            {'node_ids': ['prfaq_review', 'prfaq_revise'], 'until': 'persona_agreement', 'max_rounds': 3},
            {'node_ids': ['prototype_review', 'prfaq_rework', 'prototype_feedback', 'prototype_revise'],
             'until': 'persona_agreement', 'max_rounds': 2},
        ],
    }
