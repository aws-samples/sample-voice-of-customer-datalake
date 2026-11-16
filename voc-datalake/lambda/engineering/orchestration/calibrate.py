"""``npm run orchestration:calibrate -- --run <id> --manifest <file>``: caps and budgets from what runs used.

A run's manifest (``voc-run-manifest/1``, which the runtime writes at ``ws/default/runs/<run>/_manifest/v0001.json``)
lists its sessions with the turns, the largest call's input tokens and the minutes each took, and the run's tokens
and cost. From one or more of them this proposes, per role, ``max_turns`` and ``max_input_tokens`` (the cards'
``caps``) and, per flow, ``run_token_cap`` and ``max_tasks`` (the flow's ``budget``): the observed 95th percentile
times 1.5, rounded up, never above the harness's own ceilings. It proposes and changes nothing: the output is the
lines to change, for a person to put in a pull request.

The manifests come from the runtime (7.50.00's runtime work writes them to the workspace bucket); this command reads
them from files (``--manifest``, one or more), so it needs no AWS access.
"""
from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

MANIFEST_SCHEMA: Final = 'voc-run-manifest/1'
MARGIN: Final = 1.5
#: The harness's ceilings (runtime/harness/converse_loop.py MAX_TURNS, MAX_INPUT_TOKENS; the card schema's maxima).
MAX_TURNS: Final = 150
MAX_INPUT_TOKENS: Final = 120_000
MAX_TASKS: Final = 100


class CalibrationError(ValueError):
    """A manifest this command cannot read."""


@dataclass(frozen=True)
class Proposal:
    where: str
    setting: str
    observed: float
    proposed: int

    def __str__(self) -> str:
        return f'{self.where}: {self.setting} = {self.proposed}   (p95 observed {self.observed:g} x {MARGIN})'


def p95(values: Sequence[float]) -> float:
    """The 95th percentile, nearest rank."""
    ordered = sorted(values)
    return ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)]


def _scaled(values: Sequence[float], ceiling: int) -> tuple[float, int]:
    observed = p95(values)
    return observed, min(ceiling, max(1, math.ceil(observed * MARGIN)))


def read_manifest(path: Path) -> Mapping[str, Any]:
    try:
        manifest = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        raise CalibrationError(f'{path}: not a readable manifest ({error})') from error
    if not isinstance(manifest, Mapping) or manifest.get('schema') != MANIFEST_SCHEMA \
            or not isinstance(manifest.get('sessions'), list) or not isinstance(manifest.get('flow'), Mapping):
        raise CalibrationError(f'{path}: not a {MANIFEST_SCHEMA} manifest with its flow and sessions')
    return manifest


def propose(manifests: Sequence[Mapping[str, Any]]) -> list[Proposal]:
    """The caps of each role and the budget of each flow the manifests' runs call for."""
    by_role: dict[str, list[Mapping[str, Any]]] = {}
    by_flow: dict[str, list[Mapping[str, Any]]] = {}
    for manifest in manifests:
        by_flow.setdefault(str(manifest['flow']['id']), []).append(manifest)
        for session in manifest['sessions']:
            by_role.setdefault(str(session['role']), []).append(session)
    found = []
    for role, sessions in sorted(by_role.items()):
        for setting, key, ceiling in (('caps.max_turns', 'turns', MAX_TURNS),
                                      ('caps.max_input_tokens', 'input_tokens_max', MAX_INPUT_TOKENS)):
            observed, proposed = _scaled([float(session[key]) for session in sessions], ceiling)
            found.append(Proposal(f'agents/{role}/agent.yaml', setting, observed, proposed))
    for flow_id, runs in sorted(by_flow.items()):
        observed, proposed = _scaled([float(run['tokens']) for run in runs], 10**9)
        found.append(Proposal(f'flows/{flow_id}.yaml', 'budget.run_token_cap', observed, proposed))
        observed, proposed = _scaled([float(len(run['sessions'])) for run in runs], MAX_TASKS)
        found.append(Proposal(f'flows/{flow_id}.yaml', 'budget.max_tasks', observed, proposed))
    return found


def calibrate(run_id: str, paths: Sequence[Path]) -> list[Proposal]:
    """The proposals of the manifests at ``paths``, ``run_id``'s among them."""
    manifests = [read_manifest(path) for path in paths]
    if not any(manifest.get('run_id') == run_id for manifest in manifests):
        raise CalibrationError(f'no manifest of run {run_id} among {", ".join(str(path) for path in paths)}')
    return propose(manifests)
