"""voc-adoption-rollup: the leadership view's daily rollup (7.70.00, idea 8; docs/leadership-view.md; the rows:
shared/adoption.py, what is counted: shared/adoption_rollup.py).

At 03:05 UTC (an EventBridge rule, ``{"mode": "scheduled"}``; an operator's async invoke does the same) it rebuilds, for
the deployment and for every active workspace, the last ``HISTORY_MONTHS`` months, and writes one whole item per scope
for the day (``ADOPTION#ROLLUP`` / ``WS#{ws}#ADOPTION#ROLLUP``, sort key the UTC day): a rerun the same day overwrites
it with the same content, so a rebuild is idempotent and the newest item is always a complete picture.

It never Scans, and every read is a projected Query (lib/stacks/adoption-rollup-worker.ts holds its IAM to them):

* voc-workspaces: the listing partition ``WORKSPACES`` (``workspace_id`` and ``status``), for the active workspaces;
* voc-projects: each scope's registry of its project ids (``PROJECT_IDS``, ``WS#{ws}#PROJECT_IDS``: shared/project_walk.py
  ``registry_page``, the live ones only), then each live project's partition, projected to
  shared/adoption_rollup.py's attributes (no text, no name, no person);
* voc-conversations: how many assistant conversations were last active in each month, one ``Select: COUNT`` Query of
  ``gsi1-by-kind-updated-at`` per scope and month, the scope told by the partition's start (``USER#`` for the
  deployment, ``WS#{ws}#USER#`` in a workspace) in the filter: DynamoDB answers a count, never a conversation or a
  person;
* voc-agents: the deployment's agents (``AGENTS`` on ``gsi1-by-agents-listing``, their keys) and each one's runs'
  ``started_at`` (``AGENT#{id}``, ``RUN#…``): the autonomous agents are the deployment's (a workspace's view counts none,
  ``agent_runs_counted``).

It reads no feedback and calls no model. A scope whose reads AWS refuses is not written (the others are), and the run
raises once every scope was tried; the next day's run rebuilds it (no async retry). A scope cut short by the invocation's
time is written with ``complete: false``, which the view shows.

Env: ``AGGREGATES_TABLE``, ``PROJECTS_TABLE``, ``WORKSPACES_TABLE``, ``CONVERSATIONS_TABLE``, ``AGENTS_TABLE``.
"""
from __future__ import annotations

import os
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import BotoCoreError, ClientError

from shared.adoption import ROLLUP_TTL_DAYS, rollup_partition
from shared.adoption_rollup import MonthBuckets, months_between, project_projection
from shared.agents_store import AGENTS_GSI_PK, AGENTS_INDEX
from shared.aws import get_dynamodb_resource
from shared.concurrency import ordered_map
from shared.conversations import ASSISTANT_KIND, USER_PARTITION_PREFIX
from shared.dynamo_paging import count_query, iter_query
from shared.exceptions import ConfigurationError
from shared.indexes import CONVERSATIONS_BY_KIND_INDEX
from shared.ingest_tables import table_view
from shared.invocation_cost import instrumented_handler
from shared.logging import logger
from shared.platform_workspaces import LISTING_PK
from shared.project_keys import project_pk
from shared.project_walk import StuckQuery, query_page, registry_page
from shared.timestamps import now_iso
from shared.workspace_ids import ACTIVE, is_workspace_id
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope, scope_from_message

#: The months each item covers, the current one included (the view reads at most as many: shared/adoption_view.py).
HISTORY_MONTHS: Final = 24
#: Seconds kept back at the end of the invocation for the writes and the outcome's log line.
RESERVE_SECONDS: Final = 60.0
#: Projects read at once, and how many between two looks at the clock.
PROJECT_READERS: Final = 8
PROJECT_CHUNK: Final = 40
SCHEMA: Final = 1
_AGENT_PREFIX: Final = 'AGENT#'
_RUN_PREFIX: Final = 'RUN#'
_TABLE_ENVS: Final = ('AGGREGATES_TABLE', 'PROJECTS_TABLE', 'WORKSPACES_TABLE', 'CONVERSATIONS_TABLE', 'AGENTS_TABLE')


class RollupIncomplete(RuntimeError):
    """At least one scope of the run was not written (``scopes``: each with the error's code)."""

    def __init__(self, scopes: dict[str, str]) -> None:
        super().__init__(f'{len(scopes)} scope(s) not rolled up')
        self.scopes = scopes


@dataclass(frozen=True)
class Rollup:
    """What a run reaches, injected: the five tables (boto3 Tables) and the clocks."""

    aggregates: Any
    projects: Any
    workspaces: Any
    conversations: Any
    agents: Any
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    #: Seconds left of the invocation (the Lambda context's).
    remaining: Callable[[], float] = field(default=lambda: float('inf'))
    monotonic: Callable[[], float] = time.monotonic


def _active_workspaces(table: Any) -> list[WorkspaceScope]:
    """Every active workspace, from the listing partition (keys, id and status only)."""
    rows = iter_query(table, {'KeyConditionExpression': Key('pk').eq(LISTING_PK),
                              'ProjectionExpression': '#ws, #status', 'Select': 'SPECIFIC_ATTRIBUTES',
                              'ExpressionAttributeNames': {'#ws': 'workspace_id', '#status': 'status'}})
    return [scope_from_message({WORKSPACE_FIELD: row['workspace_id']}) for row in rows
            if row.get('status') == ACTIVE and is_workspace_id(row.get('workspace_id'))]


def _live_projects(table: Any, scope: WorkspaceScope | None) -> list[str]:
    """The ids of the scope's live projects, from its registry (every page)."""
    view = table_view(scope, table)
    live: list[str] = []
    start: dict[str, Any] | None = None
    while True:
        page = registry_page(view, scope, start)
        live.extend(page.live)
        if page.following is None:
            return live
        start = page.following


def _project_rows(table: Any, scope: WorkspaceScope | None, project_id: str) -> list[dict[str, Any]]:
    """Every row of one project's partition, projected (shared/adoption_rollup.py ``project_projection``)."""
    view = table_view(scope, table)
    projection, names = project_projection()
    rows: list[dict[str, Any]] = []
    start: dict[str, Any] | None = None
    while True:
        page, start = query_page(view, project_pk(project_id, workspace=scope), start,
                                 ProjectionExpression=projection, ExpressionAttributeNames=names)
        rows.extend(page)
        if start is None:
            return rows


def _conversation_counts(table: Any, scope: WorkspaceScope | None, months: list[str]) -> Iterator[tuple[str, int]]:
    """How many of the scope's assistant conversations were last active in each month: a count, never a row."""
    start = USER_PARTITION_PREFIX if scope is None else f'{scope.prefix}{USER_PARTITION_PREFIX}'
    for month in months:
        yield month, count_query(table, {
            'IndexName': CONVERSATIONS_BY_KIND_INDEX,
            'KeyConditionExpression': Key('kind').eq(ASSISTANT_KIND) & Key('updated_at').begins_with(month),
            'FilterExpression': Attr('pk').begins_with(start)})


def _agent_run_starts(table: Any) -> list[str]:
    """When each of the deployment's agent runs started (``started_at``), every agent's runs."""
    agents = iter_query(table, {'IndexName': AGENTS_INDEX, 'KeyConditionExpression': Key('gsi1pk').eq(AGENTS_GSI_PK),
                                'ProjectionExpression': 'pk', 'Select': 'SPECIFIC_ATTRIBUTES'})
    partitions = sorted({str(row['pk']) for row in agents if str(row.get('pk', '')).startswith(_AGENT_PREFIX)})
    starts: list[str] = []
    for partition in partitions:
        runs = iter_query(table, {
            'KeyConditionExpression': Key('pk').eq(partition) & Key('sk').begins_with(_RUN_PREFIX),
            'ProjectionExpression': '#sk, #started', 'Select': 'SPECIFIC_ATTRIBUTES',
            'ExpressionAttributeNames': {'#sk': 'sk', '#started': 'started_at'}})
        starts.extend(str(run['started_at']) for run in runs if isinstance(run.get('started_at'), str))
    return starts


def _months(now: datetime) -> tuple[str, str]:
    last = now.strftime('%Y-%m')
    year, month = now.year, now.month - (HISTORY_MONTHS - 1)
    while month < 1:
        year, month = year - 1, month + 12
    return f'{year:04d}-{month:02d}', last


class _Clock:
    """Whether the invocation still has time for another chunk of projects."""

    def __init__(self, rollup: Rollup) -> None:
        self._monotonic = rollup.monotonic
        self._deadline = rollup.monotonic() + rollup.remaining() - RESERVE_SECONDS

    def has_time(self) -> bool:
        return self._monotonic() < self._deadline


def _scope_item(rollup: Rollup, scope: WorkspaceScope | None, clock: _Clock,
                agent_starts: list[str]) -> dict[str, Any]:
    """One scope's rollup item for today."""
    now = rollup.now()
    first, last = _months(now)
    buckets = MonthBuckets(first, last)
    project_ids = _live_projects(rollup.projects, scope)
    read = 0
    complete = True
    for index in range(0, len(project_ids), PROJECT_CHUNK):
        if not clock.has_time():
            complete = False
            break
        chunk = project_ids[index:index + PROJECT_CHUNK]
        for rows in ordered_map(lambda project_id: _project_rows(rollup.projects, scope, project_id), chunk,
                                max_workers=PROJECT_READERS):
            buckets.add_project(rows)
            read += 1
    for month, count in _conversation_counts(rollup.conversations, scope, months_between(first, last)):
        buckets.add_count(month, 'assistant_conversations', count)
    for started in agent_starts if scope is None else ():
        buckets.add_agent_run(started)
    return {
        'pk': rollup_partition(scope), 'sk': now.date().isoformat(), 'schema': SCHEMA, 'rolled_up_at': now_iso(),
        'first_month': first, 'last_month': last, 'months': buckets.stored(), 'projects': len(project_ids),
        'projects_read': read, 'complete': complete, 'agent_runs_counted': scope is None,
        'ttl': int((now + timedelta(days=ROLLUP_TTL_DAYS)).timestamp()),
    }


def _error_code(error: Exception) -> str:
    if isinstance(error, ClientError):
        return str(error.response.get('Error', {}).get('Code') or 'ClientError')
    return type(error).__name__


def handle_event(event: dict, rollup: Rollup) -> dict[str, Any]:
    """Roll up every scope (``event`` takes no option but ``mode``); raises ``RollupIncomplete`` at the end when a
    scope was not written."""
    logger.info('Adoption rollup started', extra={'mode': str(event.get('mode', 'manual'))[:20]})
    clock = _Clock(rollup)
    scopes: list[WorkspaceScope | None] = [None, *_active_workspaces(rollup.workspaces)]
    agent_starts = _agent_run_starts(rollup.agents)
    failed: dict[str, str] = {}
    written = partial = 0
    for scope in scopes:
        name = 'deployment' if scope is None else scope.ws
        try:
            item = _scope_item(rollup, scope, clock, agent_starts)
            table_view(scope, rollup.aggregates).put_item(item)
        except (ClientError, BotoCoreError, StuckQuery) as error:
            logger.exception('Adoption rollup of a scope failed', extra={'scope': name})
            failed[name] = _error_code(error)
            continue
        written += 1
        partial += int(not item['complete'])
    logger.info('Adoption rollup done', extra={'scopes': len(scopes), 'written': written, 'partial': partial,
                                               'failed': len(failed)})
    if failed:
        raise RollupIncomplete(failed)
    return {'scopes': len(scopes), 'written': written, 'partial': partial}


def _tables() -> dict[str, Any]:
    names = {env: os.environ.get(env, '') for env in _TABLE_ENVS}
    missing = [env for env, name in names.items() if not name]
    if missing:
        raise ConfigurationError(f"Missing table configuration: {', '.join(missing)}")
    resource = get_dynamodb_resource()
    return {env: resource.Table(name) for env, name in names.items()}


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    tables = _tables()
    return handle_event(event or {}, Rollup(
        aggregates=tables['AGGREGATES_TABLE'], projects=tables['PROJECTS_TABLE'],
        workspaces=tables['WORKSPACES_TABLE'], conversations=tables['CONVERSATIONS_TABLE'],
        agents=tables['AGENTS_TABLE'], remaining=lambda: context.get_remaining_time_in_millis() / 1000))
