"""A triage run's end (7.50.00): the issue's trusted triage row, copied from its understander's ``voc-triage/1``.

At an ended run's retrospective (``handler._retrospect``, once no agent of it is live), for a run whose META names its
issue (its own repository's: ``run_links.issue_of``): the newest done understander task's recorded triage
(``ws/<ws>/runs/<run>/understander-<n>/commits/<sha>/_triage/attempt-<k>/triage.json``, a key the board recorded on the
task, never a listing), read from the workspace bucket and checked again (``outputs.triage_record``: what an agent
wrote is data), is written to voc-agents as the issue's row, ``ISSUE_TRIAGE#default`` / ``<owner/name>#<n>``
(``shared/agents_store.py`` ``issue_triage_key``): its kind, severity and priority as attributes of their own, the whole
record, and who wrote it from which run, task and agent, when (D4). Create-only (D1): a later triage of the same issue
(a rerun) is logged and kept out, so the row an act trigger's ``requires_triage`` reads never changes under it.

Never raises: whatever fails is logged by ids only (never the record's text) and answered, so the retrospective goes
on.
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from engineering.board.model import Task
from engineering.connectors.identity import WORKSPACE
from engineering.rows import get_row, run_pk, run_rows, string_attr
from engineering.run_links import issue_of
from engineering.runtime.outputs import TRIAGE_FILE, TriageError, triage_record
from engineering.runtime.runs import ENDED
from engineering.workspace.layout import parse_agent_key
from shared.agents_store import issue_triage_key
from shared.logging import logger

#: Who writes the row (D4).
WRITER: Final = 'voc-engineering-runtime'
#: The largest triage record read (its bounded fields fit in a few kilobytes).
MAX_TRIAGE_BYTES: Final = 64 * 1024
UNDERSTANDER: Final = 'understander'
#: What ``copy_triage`` answers.
WRITTEN, KEPT, NO_ISSUE, NO_TRIAGE, NOT_ENDED, INVALID, FAILED = (
    'written', 'kept', 'no_issue', 'no_triage', 'not_ended', 'invalid', 'failed')


def triage_key(task: Task, run_id: str) -> str | None:
    """The triage record a done understander task recorded (its last such key), None when it recorded none."""
    if task.role != UNDERSTANDER or task.state != 'done':
        return None
    found = None
    for key in sorted(task.result_keys):
        parsed = parse_agent_key(key)
        if (parsed is not None and parsed.kind == 'triage' and parsed.name == TRIAGE_FILE and parsed.ws == WORKSPACE
                and parsed.run_id == run_id and parsed.agent.startswith(f'{UNDERSTANDER}-')):
            found = key
    return found


def newest_triage(tasks: Sequence[Task], run_id: str) -> tuple[Task, str] | None:
    """The newest done understander task's triage key (by its last change), None when no task recorded one."""
    recorded = [(task, key) for task in tasks if (key := triage_key(task, run_id)) is not None]
    return max(recorded, key=lambda found: (found[0].updated_at, found[0].task_id)) if recorded else None


def triage_item(repository: str, number: int, record: Mapping[str, Any], *, run_id: str, task: Task, agent: str,
                at: datetime) -> dict[str, Any]:
    """The issue's trusted row, as a low-level item."""
    key = issue_triage_key(repository, number)
    return {'pk': {'S': key['pk']}, 'sk': {'S': key['sk']}, 'repository': {'S': repository},
            'number': {'N': str(number)}, 'kind': {'S': str(record['kind'])},
            'severity': {'S': str(record['severity'])}, 'priority': {'S': str(record['priority'])},
            'triage': {'S': json.dumps(record, sort_keys=True)}, 'run_id': {'S': run_id},
            'task_id': {'S': task.task_id}, 'agent_id': {'S': agent},
            'written_at': {'S': at.astimezone(UTC).isoformat()}, 'written_by': {'S': WRITER}}


def copy_triage(run_id: str, *, client: Any, table: str, workspace: Any, agents_table: str,
                now: datetime) -> str:
    """The ended run's triage onto its issue's trusted row (the module's doc); what came of it. Never raises."""
    try:
        return _copy(run_id, client=client, table=table, workspace=workspace, agents_table=agents_table, now=now)
    except (ClientError, BotoCoreError, OSError, ValueError):
        logger.exception('engineering triage: the issue\'s triage was not copied', extra={'run_id': run_id})
        return FAILED


def _copy(run_id: str, *, client: Any, table: str, workspace: Any, agents_table: str, now: datetime) -> str:
    meta = get_row(client, table, {'pk': {'S': run_pk(WORKSPACE, run_id)}, 'sk': {'S': 'META'}})
    if meta is None or string_attr(meta, 'status') not in ENDED:
        return NOT_ENDED
    issue, repository = issue_of(meta), string_attr(meta, 'repo')
    if issue is None or not repository:
        return NO_ISSUE
    found = newest_triage([Task.from_item(item) for item in run_rows(client, table, WORKSPACE, run_id, 'TASK#')],
                          run_id)
    if found is None:
        return NO_TRIAGE
    task, key = found
    body = workspace.read_bytes(key, MAX_TRIAGE_BYTES)
    if body is None:
        logger.warning('engineering triage: the recorded triage is missing', extra={'run_id': run_id, 'key': key})
        return NO_TRIAGE
    try:
        record = triage_record(json.loads(body))
    except (TriageError, ValueError):
        logger.warning('engineering triage: the recorded triage is off its shape', extra={'run_id': run_id,
                                                                                         'key': key})
        return INVALID
    agent = key.split('/')[4]
    item = triage_item(repository, issue.number, record, run_id=run_id, task=task, agent=agent, at=now)
    try:
        client.put_item(TableName=agents_table, Item=item, ConditionExpression='attribute_not_exists(pk)')
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
            raise
        # (D1: the issue's first triage stands; a rerun's is in its own run's workspace)
        logger.info('engineering triage: the issue has its triage already; this one is kept out',
                    extra={'run_id': run_id, 'number': issue.number})
        return KEPT
    logger.info('engineering triage: the issue\'s triage recorded', extra={
        'run_id': run_id, 'number': issue.number, 'kind': record['kind'], 'severity': record['severity']})
    return WRITTEN


def copy_triage_at_end(run_id: str) -> str:
    """``copy_triage`` on this function's clients (voc-engineering-runtime: its table, its workspace bucket, and
    voc-agents as ``ENGINEERING_SETTINGS_TABLE``); ``failed`` where the deployment names none of them. Never raises."""
    try:
        from engineering.workspace.store import WorkspaceStore
        from shared.aws import get_dynamodb_client, get_s3_client
        table, bucket = os.environ['ENGINEERING_TABLE'], os.environ['ENGINEERING_WORKSPACE_BUCKET']
        agents_table = os.environ['ENGINEERING_SETTINGS_TABLE']
        # (no ListBucket: a key never written reads as denied, taken as missing)
        workspace = WorkspaceStore(get_s3_client(), bucket, denied_is_missing=True)
        return copy_triage(run_id, client=get_dynamodb_client(), table=table, workspace=workspace,
                           agents_table=agents_table, now=datetime.now(UTC))
    except Exception:
        logger.exception('engineering triage: the copy could not start', extra={'run_id': run_id})
        return FAILED
