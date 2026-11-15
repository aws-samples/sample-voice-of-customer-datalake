"""A reactions read of an ended run, and the one schedule that reads it again later (7.10.00; docs/autonomous-
engineering.md, "Getting better": people's reactions). voc-engineering-runtime's ``reactions`` action (the schedule's
and a person's hand trigger's) comes here, and the run's end creates the schedule (``runtime/handler.py``): the end
itself reads nothing, so the retrospective keeps its whole time.

``has_pull_request(client, table, ws, run_id)``: whether the ended run's record keeps a pull request
(``run_links.run_pull_request``, one GetItem and one bounded Query of its writes' partition): the schedule is made only
then.

``ReactionsRead.read(ws, run_id, asked_by)``:

1. the run's ``META`` (an ended run with a connection; anything else is answered, nothing read);
2. the broker's ``reactions`` operation for it (``broker``: a SigV4-signed call of its function URL as the runtime's
   own role; the broker reads the run's recorded pull request and the host, bounded, trust-filtered, redacted);
3. no recorded pull request: nothing recorded, and said so (``no_pull_request``);
4. else the read as a new create-only ``REACTIONS#<read_at>`` row of the run (``reactions.ReactionsStore``), and, when
   what it says of the human edits differs from the run's read before it, a create-only human edits row beside the
   scorecards of each skill version that took part in the run (``scorecard.ScorecardStore.write_human``): the pull
   request is the run's work as a whole, and nothing on the host says which agent's lines a reviewer meant.

``ReactionsSchedule.create(run_id, target_arn, now)``: ONE one-time EventBridge Scheduler schedule per run, named
``SCHEDULE_PREFIX<run>`` in the deployment's group, ``at(<end + delay days>)`` in UTC, invoking the runtime by its
unqualified ARN (``unqualified``: never an alias or version the end's invocation came in on; the target, through the
scheduler's own role, which may invoke nothing else) with ``{"action": "reactions", "run_id",
"asked_by": "schedule"}``, no retry, and deleting itself once it has run (``ActionAfterCompletion`` ``DELETE``). A
second create for the run finds it (``ConflictException``) and changes nothing. Pay per use: a schedule costs
nothing until it runs.
"""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.connectors.identity import AGENT_ROLES
from engineering.learning.reactions import ReactionsStore, checked, human_edits
from engineering.learning.retrospective import RunRecord, version_label
from engineering.learning.scorecard import ScorecardStore
from engineering.rows import LAUNCH_HOLD, get_row, run_pk, run_rows, string_attr
from engineering.run_links import run_pull_request
from engineering.runtime.runs import ENDED
from shared.logging import logger

#: Every schedule's name starts so (the runtime's grant is on this prefix in its group): ``<prefix><run id>``.
SCHEDULE_PREFIX: Final = 'voc-eng-reactions-'
#: The delay a deployment may set (``-c engineeringReactionsDelayDays``), and its default.
MIN_DELAY_DAYS: Final = 1
MAX_DELAY_DAYS: Final = 30
DEFAULT_DELAY_DAYS: Final = 3
#: The runtime's answer to a read, by its outcome.
RECORDED: Final = 'recorded'
NO_PULL_REQUEST: Final = 'no_pull_request'
NOT_ENDED: Final = 'not_ended'
NO_RUN: Final = 'no_run'
NO_CONNECTION: Final = 'no_connection'


def unqualified(function_arn: str) -> str:
    """A Lambda function's ARN without its alias or version (``arn:aws:lambda:<region>:<account>:function:<name>``)."""
    return ':'.join(function_arn.split(':')[:7])


def has_pull_request(client: Any, table: str, ws: str, run_id: str) -> bool:
    """The run's record keeps a pull request of its own repository (META's ``repo``)."""
    meta = get_row(client, table, {'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': 'META'}})
    return meta is not None and run_pull_request(client, table, ws, run_id, string_attr(meta, 'repo')) is not None


def delay_days(raw: str | None) -> int:
    """The schedule's delay in days (``ENGINEERING_REACTIONS_DELAY_DAYS``), ``DEFAULT_DELAY_DAYS`` when unset; one
    outside ``MIN_DELAY_DAYS``-``MAX_DELAY_DAYS`` is refused (the stack checks it at synth too)."""
    if raw is None or raw == '':
        return DEFAULT_DELAY_DAYS
    if not raw.isdigit() or not MIN_DELAY_DAYS <= int(raw) <= MAX_DELAY_DAYS:
        raise ValueError(f'the reactions delay is {MIN_DELAY_DAYS}-{MAX_DELAY_DAYS} whole days')
    return int(raw)


@dataclass(frozen=True)
class ReactionsRead:
    #: A low-level DynamoDB client on ``voc-engineering`` (the run's META and agents' rows).
    client: Any
    table: str
    #: The broker's ``reactions`` answer for a run (its ``reactions``: a ``voc-reactions/1`` or None); raises on a
    #: refusal.
    broker: Callable[[str], object]
    store: ReactionsStore
    scorecards: ScorecardStore

    def _versions(self, ws: str, run_id: str) -> list[tuple[str, str]]:
        """The (role, version label) of each agent of the run, each once, in order (the session rows; a launch's
        hold with no session is not an agent)."""
        found = {(string_attr(row, 'role'), version_label(string_attr(row, 'skill_version')))
                 for row in run_rows(self.client, self.table, ws, run_id, 'AGENT#')
                 if string_attr(row, 'role') in AGENT_ROLES and ('seq' in row or LAUNCH_HOLD not in row)}
        return sorted(found)

    def read(self, ws: str, run_id: str, asked_by: str) -> dict[str, Any]:
        """One read of the run's reactions, recorded (see the module's doc); its outcome."""
        meta = get_row(self.client, self.table, {'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': 'META'}})
        if meta is None:
            return {'run_id': run_id, 'status': NO_RUN}
        if string_attr(meta, 'status') not in ENDED:
            return {'run_id': run_id, 'status': NOT_ENDED}
        connection = string_attr(meta, 'connection')
        if not connection:
            return {'run_id': run_id, 'status': NO_CONNECTION}
        found = checked(self.broker(run_id))
        if found is None:
            logger.info('engineering reactions: the run has no recorded pull request; nothing recorded',
                        extra={'run_id': run_id, 'asked_by': asked_by})
            return {'run_id': run_id, 'status': NO_PULL_REQUEST}
        before = self.store.latest(ws, run_id)
        read_at = self.store.stamp()
        now, then = human_edits(found), human_edits(None if before is None else before.found)
        written = 0
        # The human edits first, the read's row last: a write that fails part-way leaves the run's latest read as it
        # was, so the next read compares with that one and writes them again (each row is create-only and keyed on its
        # read, so nothing is counted twice: version_card takes each run's newest).
        if now != then:
            run = RunRecord(ws=ws, run_id=run_id, connection=connection, status=string_attr(meta, 'status'),
                            started_at=string_attr(meta, 'started_at'), ended_at=string_attr(meta, 'ended_at'),
                            tasks=(), history={}, agents=())
            for role, version in self._versions(ws, run_id):
                written += self.scorecards.write_human(
                    run, role, version, read_at, changes_requested=now.changes_requested,
                    people_commits_after_merge=now.people_commits_after_merge, reverted=now.reverted)
        read_at = self.store.record(ws, run_id, found, asked_by, read_at)
        logger.info('engineering reactions recorded', extra={
            'run_id': run_id, 'asked_by': asked_by, 'state': found['state'], 'kept': len(found['items']),
            'reverted': found['reverted'], 'human_rows': written})
        return {'run_id': run_id, 'status': RECORDED, 'read_at': read_at, 'state': found['state'],
                'kept': len(found['items']), 'human_rows': written}


@dataclass(frozen=True)
class ReactionsSchedule:
    #: A low-level EventBridge Scheduler client.
    client: Any
    #: The deployment's schedule group, and the role the scheduler invokes the runtime as.
    group: str
    role_arn: str
    days: int = DEFAULT_DELAY_DAYS

    def create(self, run_id: str, target_arn: str, now: datetime) -> bool:
        """The run's one schedule, ``days`` after ``now`` (see the module's doc); False when it exists already."""
        at = (now + timedelta(days=self.days)).strftime('%Y-%m-%dT%H:%M:%S')
        try:
            self.client.create_schedule(
                Name=f'{SCHEDULE_PREFIX}{run_id}', GroupName=self.group, ScheduleExpression=f'at({at})',
                ScheduleExpressionTimezone='UTC', FlexibleTimeWindow={'Mode': 'OFF'}, State='ENABLED',
                ActionAfterCompletion='DELETE', Description='Reads the run\'s pull request reactions once.',
                Target={'Arn': unqualified(target_arn), 'RoleArn': self.role_arn, 'RetryPolicy': {'MaximumRetryAttempts': 0},
                        'Input': json.dumps({'action': 'reactions', 'run_id': run_id, 'asked_by': 'schedule'})})
        except ClientError as exc:
            if exc.response.get('Error', {}).get('Code') == 'ConflictException':
                return False
            raise
        return True
