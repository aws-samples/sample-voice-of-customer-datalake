"""Methodology warnings for an agent workflow (tenet 2, M3; docs/autonomous-agents.md → Methodology warnings).

``shared/workflow_schema.py`` checks that a workflow is a valid graph; a valid graph
can still skip the methodology: ``start → write_prd → end`` writes a PRD with no
personas, no PR/FAQ and no customer evidence. This module lists those gaps as
WARNINGS, never errors (a workflow that works on a project which already holds the
upstream artifacts is legitimate), so ``POST /workflows/validate`` answers them and
the workflow editor shows them.

A step counts as upstream when a node of its kind can reach the writing node along
the workflow's arrows.
"""
from __future__ import annotations

from collections import deque
from collections.abc import Mapping
from typing import Any, Final

PERSONA_NODES: Final = frozenset({'select_personas', 'generate_personas'})
EVIDENCE_NODES: Final = frozenset({'aggregate_reviews', 'deep_research'})
PRFAQ_NODES: Final = frozenset({'write_prfaq'})
DOCUMENT_NODES: Final = frozenset({'write_prfaq', 'write_prd'})

#: Per writing node type: (warning code, the upstream node kinds of which one must reach it, message).
_RULES: Final[Mapping[str, tuple[tuple[str, frozenset[str], str], ...]]] = {
    'write_prfaq': (
        ('no_upstream_evidence', EVIDENCE_NODES,
         'This PR/FAQ step has no customer evidence before it (aggregate reviews or deep research).'),
        ('no_upstream_personas', PERSONA_NODES,
         'This PR/FAQ step has no personas step before it.'),
    ),
    'write_prd': (
        ('no_upstream_evidence', EVIDENCE_NODES,
         'This PRD step has no customer evidence before it (aggregate reviews or deep research).'),
        ('no_upstream_personas', PERSONA_NODES,
         'This PRD step has no personas step before it.'),
        ('no_upstream_prfaq', PRFAQ_NODES,
         'This PRD step has no PR/FAQ step before it: the methodology writes the PR/FAQ first.'),
    ),
    'build_prototype': (
        ('no_upstream_document', DOCUMENT_NODES,
         'This prototype step has no PR/FAQ or PRD step before it.'),
    ),
}


def _ancestors(node_id: str, backward: Mapping[str, list[str]]) -> set[str]:
    """Every node with a path of one or more arrows to ``node_id``."""
    seen: set[str] = set()
    queue = deque(backward.get(node_id, ()))
    while queue:
        current = queue.popleft()
        if current not in seen:
            seen.add(current)
            queue.extend(backward.get(current, ()))
    return seen


def methodology_warnings(definition: Mapping[str, Any]) -> list[dict[str, str]]:
    """The methodology gaps of a VALID (normalised) definition: ``[{code, message, node_id}]``."""
    nodes = definition.get('nodes') or []
    types = {str(n['id']): str(n['type']) for n in nodes if isinstance(n, Mapping) and 'id' in n and 'type' in n}
    backward: dict[str, list[str]] = {node_id: [] for node_id in types}
    for edge in definition.get('edges') or []:
        if isinstance(edge, Mapping) and edge.get('source') in types and edge.get('target') in types:
            backward[str(edge['target'])].append(str(edge['source']))
    warnings: list[dict[str, str]] = []
    for node_id, node_type in types.items():
        rules = _RULES.get(node_type, ())
        if not rules:
            continue
        upstream_types = {types[a] for a in _ancestors(node_id, backward)}
        warnings.extend(
            {'code': code, 'message': message, 'node_id': node_id}
            for code, kinds, message in rules if not upstream_types & kinds
        )
    return warnings
