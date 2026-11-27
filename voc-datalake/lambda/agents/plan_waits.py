"""Plan ``wait`` steps: poll a background job's status row until it ends (docs/assistant-plan-mode.md).

| ``wait.for``  | Row (read directly, status only)                                  | Done when                               |
|---------------|-------------------------------------------------------------------|-----------------------------------------|
| `source_run`  | aggregates ``SOURCE_RUN#{source}`` / ``{execution_id}``           | ``completed``                           |
| `scraper_run` | aggregates ``SCRAPER_RUN#{scraper_id}`` / ``{execution_id}``      | ``completed`` / ``completed_with_errors`` |
| `project_job` | jobs ``PROJECT#{project_id}`` / ``JOB#{job_id}``                  | ``completed``                           |

Rows are written by ``POST /sources/{source}/run`` + the ingestor, ``POST /scrapers/{id}/run`` + the web
scraper, and ``shared/jobs.py``. A wait only ever learns a status and a count — never row content — so a
reference to a job the approver cannot see leaks nothing but "it ended". An id may be a literal or a
``{{sN.output}}`` reference to an earlier step's recorded output.

In a workspace (``poll``'s keyword-only ``workspace``, since 7.29.00) a source run's and a scraper run's row are that
workspace's, ``WS#{ws}#SOURCE_RUN#{source}`` and ``WS#{ws}#SCRAPER_RUN#{scraper_id}`` (shared/run_rows.py), read
through shared/workspace_config.py ``get_scoped_item``: the conductor passes a plan's own workspace (its META's) for
these two kinds, where a workspace's run writes them, after it has re-checked that the plan's approver is still a
member there (agents/plan_identity.py; the approval required it too, api/agents_handler.py). A project job's wait
refuses a workspace: a workspace plan's project jobs are still the deployment's until the switch (3h), so the
conductor passes none for it. Without a workspace the request is the one sent before.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.logging import logger
from shared.plan_schema import CONTRACT
from shared.project_keys import project_pk, require_deployment
from shared.run_rows import scraper_run_partition, source_run_partition
from shared.tables import get_aggregates_table, get_jobs_table
from shared.workspace_config import get_scoped_item
from shared.ws_repo import WorkspaceScope

WAIT_PENDING: Final = 'pending'
WAIT_DONE: Final = 'done'
WAIT_FAILED: Final = 'failed'
DEFAULT_TIMEOUT_MINUTES: Final = 60

_REFERENCE_RE: Final = re.compile(CONTRACT['patterns']['reference'], re.ASCII)


#: What a project job's wait refuses in a workspace (shared/project_keys.py ``require_deployment``).
_PROJECT_JOB_WAIT_STORE: Final = 'A project job wait'


def _project_job_partition(workspace: WorkspaceScope | None, project_id: str) -> str:
    """A project job's partition, the deployment's only: a workspace plan's project jobs are still the deployment's
    (the project routes move at the switch, 3h), so a workspace is refused (``NotPerWorkspaceError``)."""
    require_deployment(workspace, _PROJECT_JOB_WAIT_STORE)
    return project_pk(project_id, workspace=workspace)


@dataclass(frozen=True)
class _Target:
    """Where one ``wait.for`` kind's status row lives and which statuses end it. Every partition builder takes
    ``(workspace, id)``."""

    table: str
    pk: tuple[Callable[[WorkspaceScope | None, str], str], str]    # (partition builder, wait field)
    sk: tuple[str, str]
    done: frozenset[str]
    failed: frozenset[str]
    failure: str


_TARGETS: Final[dict[str, _Target]] = {
    'source_run': _Target('aggregates', (source_run_partition, 'source'), ('', 'execution_id'),
                          frozenset({'completed'}), frozenset({'error'}), 'The import failed.'),
    'scraper_run': _Target('aggregates', (scraper_run_partition, 'scraper_id'), ('', 'execution_id'),
                           frozenset({'completed', 'completed_with_errors'}), frozenset({'error'}),
                           'The scraper run failed.'),
    'project_job': _Target('jobs', (_project_job_partition, 'project_id'), ('JOB#', 'job_id'),
                           frozenset({'completed'}), frozenset({'failed'}), 'The project job failed.'),
}
#: The kinds whose rows a workspace's run writes in that workspace (``WS#{ws}#SOURCE_RUN#…``, ``…#SCRAPER_RUN#…``): a
#: plan approved in a workspace waits on them there (agents/conductor/plan_decide.py).
WORKSPACE_KINDS: Final = frozenset({'source_run', 'scraper_run'})


@dataclass(frozen=True)
class WaitResult:
    status: str
    outputs: dict[str, str] = field(default_factory=dict)
    error: str | None = None


class UnresolvedReference(Exception):
    """A ``{{sN.output}}`` names an output no earlier step recorded."""


def resolve_value(value: object, resolved: Mapping[str, str]) -> object:
    """A literal unchanged; a whole-string ``{{sN.output}}`` → the recorded output."""
    if not isinstance(value, str):
        return value
    match = _REFERENCE_RE.fullmatch(value)
    if match is None:
        return value
    key = f'{match.group(1)}.{match.group(2)}'
    if key not in resolved:
        raise UnresolvedReference(key)
    return resolved[key]


def _key(target: _Target, wait: Mapping[str, Any], resolved: Mapping[str, str], *,
         workspace: WorkspaceScope | None) -> dict[str, str]:
    (partition, pk_field), (sk_prefix, sk_field) = target.pk, target.sk
    ident = f'{resolve_value(wait.get(pk_field), resolved)}'
    return {'pk': partition(workspace, ident),
            'sk': f'{sk_prefix}{resolve_value(wait.get(sk_field), resolved)}'}


def _read(target: _Target, key: dict[str, str], *, workspace: WorkspaceScope | None) -> Mapping[str, Any]:
    table = get_aggregates_table() if target.table == 'aggregates' else get_jobs_table()
    if table is None:
        raise RuntimeError(f'{target.table} table is not configured')
    return get_scoped_item(table, key, workspace, ConsistentRead=True)


def poll(wait: Mapping[str, Any], resolved: Mapping[str, str], *,
         workspace: WorkspaceScope | None = None) -> WaitResult:
    """One look at the job's status row (the workspace's when given: only for ``WORKSPACE_KINDS``; a project job's
    wait refuses one, ``NotPerWorkspaceError``). A missing row is still pending (the timeout ends it)."""
    target = _TARGETS.get(str(wait.get('for')))
    if target is None:
        return WaitResult(WAIT_FAILED, error='The step waits for an unknown kind of job.')
    try:
        key = _key(target, wait, resolved, workspace=workspace)
    except UnresolvedReference as exc:
        return WaitResult(WAIT_FAILED, error=f'The output {exc} was not recorded.')
    except ValueError:
        # Only in a workspace: an empty id makes no key there (shared/ws_repo.py WorkspaceScope.key).
        return WaitResult(WAIT_FAILED, error='The step waits for a job it does not name.')
    try:
        row = _read(target, key, workspace=workspace)
    except (ClientError, BotoCoreError):
        logger.warning('Plan wait poll failed; trying again next time', extra={'wait_for': wait.get('for')})
        return WaitResult(WAIT_PENDING)
    status = str(row.get('status'))
    if status in target.done:
        outputs = {'status': status}
        if row.get('items_found') is not None:
            outputs['items_found'] = str(row['items_found'])
        return WaitResult(WAIT_DONE, outputs)
    if status in target.failed:
        return WaitResult(WAIT_FAILED, error=target.failure)
    return WaitResult(WAIT_PENDING)


def timeout_minutes(wait: Mapping[str, Any]) -> int:
    value = wait.get('timeout_minutes')
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else DEFAULT_TIMEOUT_MINUTES
