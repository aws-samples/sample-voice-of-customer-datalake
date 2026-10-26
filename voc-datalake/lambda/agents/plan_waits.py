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
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.logging import logger
from shared.plan_schema import CONTRACT
from shared.tables import get_aggregates_table, get_jobs_table

WAIT_PENDING: Final = 'pending'
WAIT_DONE: Final = 'done'
WAIT_FAILED: Final = 'failed'
DEFAULT_TIMEOUT_MINUTES: Final = 60

_REFERENCE_RE: Final = re.compile(CONTRACT['patterns']['reference'], re.ASCII)


@dataclass(frozen=True)
class _Target:
    """Where one ``wait.for`` kind's status row lives and which statuses end it."""

    table: str
    pk: tuple[str, str]    # (prefix, wait field)
    sk: tuple[str, str]
    done: frozenset[str]
    failed: frozenset[str]
    failure: str


_TARGETS: Final[dict[str, _Target]] = {
    'source_run': _Target('aggregates', ('SOURCE_RUN#', 'source'), ('', 'execution_id'),
                          frozenset({'completed'}), frozenset({'error'}), 'The import failed.'),
    'scraper_run': _Target('aggregates', ('SCRAPER_RUN#', 'scraper_id'), ('', 'execution_id'),
                           frozenset({'completed', 'completed_with_errors'}), frozenset({'error'}),
                           'The scraper run failed.'),
    'project_job': _Target('jobs', ('PROJECT#', 'project_id'), ('JOB#', 'job_id'),
                           frozenset({'completed'}), frozenset({'failed'}), 'The project job failed.'),
}


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


def _key(target: _Target, wait: Mapping[str, Any], resolved: Mapping[str, str]) -> dict[str, str]:
    (pk_prefix, pk_field), (sk_prefix, sk_field) = target.pk, target.sk
    return {'pk': f'{pk_prefix}{resolve_value(wait.get(pk_field), resolved)}',
            'sk': f'{sk_prefix}{resolve_value(wait.get(sk_field), resolved)}'}


def _read(target: _Target, key: dict[str, str]) -> Mapping[str, Any]:
    table = get_aggregates_table() if target.table == 'aggregates' else get_jobs_table()
    if table is None:
        raise RuntimeError(f'{target.table} table is not configured')
    item = table.get_item(Key=key, ConsistentRead=True).get('Item')
    return item if isinstance(item, dict) else {}


def poll(wait: Mapping[str, Any], resolved: Mapping[str, str]) -> WaitResult:
    """One look at the job's status row. A missing row is still pending (the timeout ends it)."""
    target = _TARGETS.get(str(wait.get('for')))
    if target is None:
        return WaitResult(WAIT_FAILED, error='The step waits for an unknown kind of job.')
    try:
        row = _read(target, _key(target, wait, resolved))
    except UnresolvedReference as exc:
        return WaitResult(WAIT_FAILED, error=f'The output {exc} was not recorded.')
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
