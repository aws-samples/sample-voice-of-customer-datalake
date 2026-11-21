"""A trial's one-time schedule (7.71.00; shared/trials.py, docs/multi-workspace.md "Trial workspaces"): ONE EventBridge
Scheduler schedule per trial and per expiry, in the deployment's trials group, that invokes voc-trial-expiry once at
``expires_at`` and then deletes itself (``ActionAfterCompletion`` ``DELETE``), the pattern of the engineering run
reactions (lambda/engineering/learning/reactions_read.py).

``TrialSchedule.create(ws, expires_at)`` names it ``SCHEDULE_PREFIX<ws>-<expiry>`` (``voc-trial-ws_…-20261221T090000``,
under Scheduler's 64 characters), ``at(<expiry>)`` in UTC with no flexible window, invoking the job's unqualified ARN
through the scheduler's own role (which may invoke that job and nothing else) with ``{"action": "trial_expiry",
"workspace_id", "expires_at"}``, up to 3 retries within a day. A second create for the same trial and expiry finds it
(``ConflictException``) and changes nothing.

The workspaces API creates, and never updates or deletes, a schedule: an extension creates the new expiry's schedule
and leaves the old one, which still runs once at its time, finds the stored ``expires_at`` later than now (or the trial
converted) and does nothing (lambda/jobs/trial_expiry/handler.py). So its role holds ``scheduler:CreateSchedule`` on
this group's ``voc-trial-*`` names only, and ``iam:PassRole`` of the scheduler's role only. A schedule costs nothing
until it runs (tenet 7).

Env (the workspaces API): ``TRIAL_SCHEDULE_GROUP``, ``TRIAL_SCHEDULER_ROLE_ARN``, ``TRIAL_EXPIRY_FUNCTION_ARN``.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.exceptions import ConfigurationError

#: Every trial schedule's name starts so (the workspaces API's grant is on this prefix in the group). Held equal to
#: lib/stacks/trial-expiry.ts TRIAL_SCHEDULE_PREFIX by lambda/shared/test/test_trial_schedule.py.
SCHEDULE_PREFIX: Final = 'voc-trial-'
#: The job's action word (lambda/jobs/trial_expiry/handler.py reads it).
EXPIRY_ACTION: Final = 'trial_expiry'
#: Scheduler's retries of a failed invoke, within a day: the job is idempotent, so a retry only finishes a pause.
RETRY_ATTEMPTS: Final = 3
MAX_EVENT_AGE_SECONDS: Final = 86_400


def schedule_name(ws: str, expires_at: datetime) -> str:
    """``voc-trial-<ws>-<YYYYMMDDTHHMMSS>`` (UTC): one per trial and expiry."""
    return f'{SCHEDULE_PREFIX}{ws}-{expires_at.astimezone(UTC).strftime("%Y%m%dT%H%M%S")}'


def unqualified(function_arn: str) -> str:
    """A Lambda function's ARN without an alias or version (``arn:aws:lambda:<region>:<account>:function:<name>``)."""
    return ':'.join(function_arn.split(':')[:7])


@dataclass(frozen=True)
class TrialSchedule:
    #: A low-level EventBridge Scheduler client.
    client: Any
    #: The deployment's trials group, the role the scheduler invokes the job as, and the job.
    group: str
    role_arn: str
    target_arn: str

    def create(self, ws: str, expires_at: datetime) -> bool:
        """The trial's schedule at ``expires_at``; False when it exists already. Other AWS errors propagate."""
        at = expires_at.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%S')
        payload = {'action': EXPIRY_ACTION, 'workspace_id': ws, 'expires_at': expires_at.astimezone(UTC).isoformat()}
        try:
            self.client.create_schedule(
                Name=schedule_name(ws, expires_at), GroupName=self.group, ScheduleExpression=f'at({at})',
                ScheduleExpressionTimezone='UTC', FlexibleTimeWindow={'Mode': 'OFF'}, State='ENABLED',
                ActionAfterCompletion='DELETE', Description='Pauses the trial workspace once it ends; deletes nothing.',
                Target={'Arn': unqualified(self.target_arn), 'RoleArn': self.role_arn, 'Input': json.dumps(payload),
                        'RetryPolicy': {'MaximumRetryAttempts': RETRY_ATTEMPTS,
                                        'MaximumEventAgeInSeconds': MAX_EVENT_AGE_SECONDS}})
        except ClientError as exc:
            if exc.response.get('Error', {}).get('Code') == 'ConflictException':
                return False
            raise
        return True


def configured_schedule(client_factory: Any) -> TrialSchedule:
    """The deployment's trial schedules (the env above), or a 500 ``ConfigurationError`` before anything is written
    when one is missing. ``client_factory`` builds the Scheduler client only once the env is complete."""
    group = os.environ.get('TRIAL_SCHEDULE_GROUP', '')
    role_arn = os.environ.get('TRIAL_SCHEDULER_ROLE_ARN', '')
    target_arn = os.environ.get('TRIAL_EXPIRY_FUNCTION_ARN', '')
    if not (group and role_arn and target_arn):
        raise ConfigurationError('Trial schedules not configured')
    return TrialSchedule(client_factory(), group, role_arn, target_arn)
