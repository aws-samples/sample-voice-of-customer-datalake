"""The gate rules of a declared loop (``shared.workflow_schema`` runs them on save).

A loop repeats until its GATE passes: every ``persona_review`` member of a
``persona_agreement`` loop, every ``final_review`` member of a ``review_pass``
loop. The run interpreter (``agents.graph.WorkflowGraph.next_nodes``) follows the
arrows labelled with the gate's outcome, else its unlabelled ones, and counts a
round only on a gate's failing outcome. So a loop only behaves when:

- it contains at least one gate;
- each gate has a passing arrow (``agreed`` / ``pass``) that LEAVES the loop and a
  failing arrow (``not_agreed`` / ``fail``) that STAYS inside it;
- no passing arrow points back inside, no failing arrow points outside, and no
  arrow out of a gate is unlabelled (an unlabelled arrow is taken on every outcome
  without a matching label, which is how a loop went round forever);
- only a gate leaves the loop (an exit from any other member is a fan-out that
  runs beside the loop).

Pure: the caller passes the parsed node types, edges and loops and pins each
returned ``(message, node_id)`` to the definition's error list. The wording is
mirrored by the frontend's ``graphRules.ts`` — change both together.

These rules apply when a workflow is created, saved, imported or validated. A
stored workflow that predates them is NOT re-validated at run time
(``agents.graph`` only refuses what it cannot walk), so it keeps running.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Final

# until → (gate node type, passing label, failing label)
LOOP_GATES: Final[Mapping[str, tuple[str, str, str]]] = {
    'persona_agreement': ('persona_review', 'agreed', 'not_agreed'),
    'review_pass': ('final_review', 'pass', 'fail'),
}
_NO_GATE: Final[Mapping[str, str]] = {
    'persona_agreement': 'loop {n} repeats until persona agreement but contains no persona review',
    'review_pass': 'loop {n} repeats until a review passes but contains no final review',
}
ONLY_THE_REVIEW_LEAVES: Final = "only the loop's review can leave the loop"
_NEVER_MEMBERS: Final = ('start', 'end')

Issue = tuple[str, str | None]


def article(label: str) -> str:
    """'an' before a label starting with a vowel (``agreed``), else 'a'."""
    return 'an' if label[:1] in ('a', 'e', 'i', 'o', 'u') else 'a'


def _gate_issues(gate: str, outgoing: Sequence[Mapping[str, Any]], inside: set[str],
                 passing: str, failing: str) -> list[Issue]:
    """Every rule broken by one gate's arrows, each message once, in a fixed order."""
    exits = any(e.get('label') == passing and e['target'] not in inside for e in outgoing)
    stays = any(e.get('label') == failing and e['target'] in inside for e in outgoing)
    checks = (
        (not exits, f"this review needs {article(passing)} '{passing}' arrow that leaves the loop"),
        (not stays, f"this review needs {article(failing)} '{failing}' arrow that stays inside the loop"),
        (any(e.get('label') == passing and e['target'] in inside for e in outgoing),
         f"{article(passing)} '{passing}' arrow must leave the loop"),
        (any(e.get('label') == failing and e['target'] not in inside for e in outgoing),
         f"{article(failing)} '{failing}' arrow must stay inside the loop"),
        (any(e.get('label') is None for e in outgoing),
         f"label each arrow of this review '{passing}' or '{failing}'"),
    )
    return [(message, gate) for broken, message in checks if broken]


def loop_gate_issues(types: Mapping[str, str], edges: Sequence[Mapping[str, Any]],
                     loops: Sequence[Mapping[str, Any]]) -> list[Issue]:
    """``(message, node_id | None)`` for every gate rule a declared loop breaks."""
    outgoing: dict[str, list[Mapping[str, Any]]] = {node_id: [] for node_id in types}
    for edge in edges:
        if edge['source'] in types and edge['target'] in types:
            outgoing[edge['source']].append(edge)
    issues: list[Issue] = []
    for index, loop in enumerate(loops):
        spec = LOOP_GATES.get(loop['until'])
        if spec is None:
            continue  # an unknown `until` is reported by the shape check
        gate_type, passing, failing = spec
        # A start/end member is refused on its own; it must not also read as a gate's way out.
        members = [node_id for node_id in loop['node_ids'] if types.get(node_id) not in (None, *_NEVER_MEMBERS)]
        inside = set(members)
        if not any(types[node_id] == gate_type for node_id in members):
            issues.append((_NO_GATE[loop['until']].format(n=index + 1), None))
            continue
        # Members in `node_ids` order, each gate's checks in place (graphRules.ts walks the same way).
        for member in members:
            if types[member] == gate_type:
                issues += _gate_issues(member, outgoing[member], inside, passing, failing)
            elif any(e['target'] not in inside for e in outgoing[member]):
                issues.append((ONLY_THE_REVIEW_LEAVES, member))
    return issues
