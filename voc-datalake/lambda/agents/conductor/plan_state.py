"""What the plan conductor knows about a plan at one instant: META, step rows, step definitions.

Shared by ``plan_decide`` (walk the plan) and ``plan_execution`` (run one step) so both read outputs,
dependencies and caps the same way.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final

from shared import agents_store
from shared import plans_store as ps
from shared.plan_schema import ADMIN_ONLY_PACKS, ADMIN_ONLY_WRITE_TOOLS, ADMIN_READ_PACKS, FREE_PLACEHOLDER, PLAN_LIMITS

# Writes that start a background job (their output is a job or execution id): the per-plan jobs cap.
JOB_OUTPUTS: Final = ('job_id', 'execution_id')
JOB_TOOLS: Final = frozenset({
    'start_research', 'generate_document', 'generate_personas', 'build_prototype', 'run_source', 'run_scraper',
    'run_agent',
})


def table() -> Any:
    found = agents_store.get_agents_table()
    if found is None:
        raise RuntimeError('AGENTS_TABLE is not configured')
    return found


@dataclass(frozen=True)
class PlanState:
    meta: dict
    rows: dict[str, dict]           # step id → step row
    definitions: dict[str, dict]    # step id → voc-plan/1 step
    order: list[str]
    now: datetime

    @property
    def plan_id(self) -> str:
        return str(self.meta['plan_id'])

    def status(self, step_id: str) -> str:
        return str(self.rows.get(step_id, {}).get('status') or '')

    def after(self, step_id: str) -> list[str]:
        return list(self.definitions.get(step_id, {}).get('after') or [])

    def dependencies_done(self, step_id: str) -> bool:
        return all(self.status(dep) == ps.STEP_DONE for dep in self.after(step_id))

    def outputs(self, *, think: bool) -> dict[str, str]:
        """``{"sN.name": value}`` of every done step (think steps' text apart from ids)."""
        found: dict[str, str] = {}
        for step_id, row in self.rows.items():
            is_think = self.definitions.get(step_id, {}).get('kind') == 'think'
            if row.get('status') != ps.STEP_DONE or is_think != think:
                continue
            outputs = row.get('outputs')
            for name, value in (outputs.items() if isinstance(outputs, dict) else ()):
                found[f'{step_id}.{name}'] = str(value)
        return found

    def jobs_started(self) -> int:
        return sum(1 for row in self.rows.values()
                   if isinstance(row.get('outputs'), dict) and any(name in row['outputs'] for name in JOB_OUTPUTS))


def load(plan_id: str, now: datetime | None = None) -> PlanState | None:
    meta = ps.get_meta(table(), plan_id)
    if meta is None:
        return None
    rows = ps.get_steps(table(), plan_id)
    return PlanState(
        meta=meta, rows={str(row['step_id']): row for row in rows}, definitions=ps.plan_steps_by_id(meta),
        order=[str(row['step_id']) for row in rows], now=now or agents_store.utc_now(),
    )


def _has_free_field(value: object) -> bool:
    if isinstance(value, str):
        return value == FREE_PLACEHOLDER
    if isinstance(value, list):
        return any(_has_free_field(item) for item in value)
    if isinstance(value, dict):
        return any(_has_free_field(item) for item in value.values())
    return False


def write_tool(definition: Mapping[str, Any]) -> str | None:
    write = definition.get('write')
    tool = write.get('tool') if isinstance(write, dict) else None
    return tool if isinstance(tool, str) else None


def uses_model(definition: Mapping[str, Any]) -> bool:
    """A think step, or a write with a ``{{free}}`` field the step agent writes."""
    if definition.get('kind') == 'think':
        return True
    write = definition.get('write')
    return definition.get('kind') == 'write' and isinstance(write, dict) and _has_free_field(write.get('args'))


def needs_admin(definition: Mapping[str, Any]) -> bool:
    """An admin-only pack or write tool: the step may forward ``admins`` (after the re-check)."""
    tool = write_tool(definition)
    return definition.get('pack') in ADMIN_ONLY_PACKS or tool in ADMIN_ONLY_WRITE_TOOLS


def admin_reads(definition: Mapping[str, Any]) -> bool:
    """A think step whose pack has admin-only read tools (``get_source_run`` in ``scrapers``): it runs with
    ``admins`` when the approver still is one (re-checked), as an ordinary chat on that page would."""
    return definition.get('kind') == 'think' and definition.get('pack') in ADMIN_READ_PACKS


def cap_problem(state: PlanState, definition: Mapping[str, Any]) -> str | None:
    """Why the per-plan caps refuse this step now, or None."""
    if uses_model(definition) and int(state.meta.get('model_calls') or 0) >= PLAN_LIMITS['modelCalls']:
        return f"The plan has spent its {PLAN_LIMITS['modelCalls']} model calls."
    tool = write_tool(definition)
    if tool in JOB_TOOLS and state.jobs_started() >= PLAN_LIMITS['jobs']:
        return f"The plan has started its {PLAN_LIMITS['jobs']} background jobs."
    return None
