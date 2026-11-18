"""Run requests (7.53.00, "MCP for runs", D53-3): a local assistant asks for a Run now of an enabled engineering
automation, and the request waits until an administrator confirms it in the app (a run pushes code).

One partition of voc-engineering for the deployment, one row per request, by its id (a ULID, so newest last):

    WS#default#RUNREQ#queue / REQ#<request id>
    {request_id, agent_id, agent_name, issue?, prd?, note?, status, requested_at, expires_at, via, requested_for,
     decided_by?, decided_at?, outcome?, run_id?, engineering_run_id?}

- **Asked** (``create``, create-only) by the Agents API for the global MCP server's ``engineering_run_request`` tool:
  ``via`` is its subject (``mcp:<token>``) and ``requested_for`` its minter. At most ``MAX_PENDING_PER_TOKEN`` of a
  token's and ``MAX_PENDING`` in all wait at once, and the same Run now (agent, issue or PRD) is asked once while it
  waits. A pending request expires ``EXPIRES_HOURS`` after it was asked (read as ``expired``; nothing deletes it).
- **Decided once** (``decide``), by an administrator signed in: a conditional update from ``pending`` while it has not
  expired, to ``declined``, or to ``confirmed`` before the Run now starts. A second decision, a late one or a lost race
  is a conflict naming the status it has.
- **What came of a confirm** (``record``): ``started`` with the agent's run and its engineering run, ``uncertain``
  naming the engineering run that may have started, or the refusal's words. A request is never a run: confirming it
  runs the Agents API's own Run now, as the confirming administrator.

The Agents API's role writes these rows with PutItem and UpdateItem held to ``WS#*#RUNREQ#*`` by
``dynamodb:LeadingKeys`` (lib/stacks/api-assistant-lambdas.ts), and reads them with its Query of the table.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.connectors.identity import WORKSPACE
from engineering.rows import string_attr

PK: Final = f'WS#{WORKSPACE}#RUNREQ#queue'
SK_PREFIX: Final = 'REQ#'
PENDING: Final = 'pending'
CONFIRMED: Final = 'confirmed'
DECLINED: Final = 'declined'
EXPIRED: Final = 'expired'
#: What a person decides, and how the row then reads.
DECISIONS: Final = {'confirm': CONFIRMED, 'decline': DECLINED}
EXPIRES_HOURS: Final = 24
MAX_PENDING: Final = 20
MAX_PENDING_PER_TOKEN: Final = 3
#: The newest requests a list reads (and the caps count among).
MAX_LISTED: Final = 100
MAX_NOTE: Final = 500
MAX_OUTCOME: Final = 300


class RequestError(Exception):
    """A request refused: ``kind`` is ``invalid``, ``not_found``, ``conflict`` or ``cap``; the message says why."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class NewRequest:
    request_id: str
    agent_id: str
    agent_name: str
    via: str
    requested_for: str
    issue: int | None = None
    prd: Mapping[str, str] | None = None
    note: str = ''


def _key(request_id: str) -> dict[str, Any]:
    return {'pk': {'S': PK}, 'sk': {'S': f'{SK_PREFIX}{request_id}'}}


def _stamp(at: datetime) -> str:
    return at.strftime('%Y-%m-%dT%H:%M:%SZ')


def _conditional_failure(exc: ClientError) -> bool:
    return exc.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException'


def _same_run_now(row: Mapping[str, Any], wanted: NewRequest) -> bool:
    return (row['agent_id'], row['issue'], row['prd']) == (wanted.agent_id, wanted.issue, dict(wanted.prd or {}) or None)


@dataclass(frozen=True)
class RunRequests:
    """The run requests of the deployment, on a low-level DynamoDB client of voc-engineering."""

    client: Any
    table: str
    now: Callable[[], datetime]

    def view(self, item: Mapping[str, Any]) -> dict[str, Any]:
        """A stored row as the API answers it (``expired`` for a pending one past its time)."""
        status = string_attr(item, 'status')
        expires = string_attr(item, 'expires_at')
        if status == PENDING and expires and expires <= _stamp(self.now()):
            status = EXPIRED
        issue = item.get('issue', {}).get('N') if isinstance(item.get('issue'), Mapping) else None
        prd = string_attr(item, 'prd')
        return {'request_id': string_attr(item, 'request_id'), 'status': status,
                'agent_id': string_attr(item, 'agent_id'), 'agent_name': string_attr(item, 'agent_name'),
                'issue': int(issue) if isinstance(issue, str) and issue.isdigit() else None,
                'prd': json.loads(prd) if prd else None, 'note': string_attr(item, 'note') or None,
                'requested_at': string_attr(item, 'requested_at'), 'expires_at': expires,
                'via': string_attr(item, 'via'), 'requested_for': string_attr(item, 'requested_for'),
                **{name: string_attr(item, name) or None
                   for name in ('decided_by', 'decided_at', 'outcome', 'run_id', 'engineering_run_id')}}

    def listed(self) -> list[dict[str, Any]]:
        """The newest requests first (at most ``MAX_LISTED``)."""
        page = self.client.query(TableName=self.table, ConsistentRead=True, ScanIndexForward=False, Limit=MAX_LISTED,
                                 KeyConditionExpression='pk = :pk AND begins_with(sk, :req)',
                                 ExpressionAttributeValues={':pk': {'S': PK}, ':req': {'S': SK_PREFIX}})
        return [self.view(item) for item in page.get('Items', [])]

    def get(self, request_id: str) -> dict[str, Any] | None:
        item = self.client.get_item(TableName=self.table, Key=_key(request_id), ConsistentRead=True).get('Item')
        return None if item is None else self.view(item)

    def create(self, wanted: NewRequest) -> dict[str, Any]:
        """Ask for a Run now (``RequestError`` ``cap`` past a cap, ``conflict`` for the same one still waiting)."""
        if len(wanted.note) > MAX_NOTE:
            raise RequestError('invalid', f'note is at most {MAX_NOTE} characters')
        waiting = [row for row in self.listed() if row['status'] == PENDING]
        same = next((row for row in waiting if _same_run_now(row, wanted)), None)
        if same is not None:
            raise RequestError('conflict', f"this Run now is already asked: request {same['request_id']} waits for an "
                                           'administrator')
        if len(waiting) >= MAX_PENDING:
            raise RequestError('cap', f'{MAX_PENDING} run requests already wait for an administrator: ask later')
        if sum(row['via'] == wanted.via for row in waiting) >= MAX_PENDING_PER_TOKEN:
            raise RequestError('cap', f'this token already has {MAX_PENDING_PER_TOKEN} run requests waiting: ask '
                                      'an administrator to decide them first')
        now = self.now()
        item: dict[str, Any] = {
            **_key(wanted.request_id), 'request_id': {'S': wanted.request_id}, 'agent_id': {'S': wanted.agent_id},
            'agent_name': {'S': wanted.agent_name[:200]}, 'status': {'S': PENDING},
            'requested_at': {'S': _stamp(now)}, 'expires_at': {'S': _stamp(now + timedelta(hours=EXPIRES_HOURS))},
            'via': {'S': wanted.via}, 'requested_for': {'S': wanted.requested_for}}
        if wanted.issue is not None:
            item['issue'] = {'N': str(wanted.issue)}
        if wanted.prd is not None:
            item['prd'] = {'S': json.dumps(dict(wanted.prd), sort_keys=True)}
        if wanted.note:
            item['note'] = {'S': wanted.note}
        try:
            self.client.put_item(TableName=self.table, Item=item, ConditionExpression='attribute_not_exists(pk)')
        except ClientError as exc:
            if _conditional_failure(exc):
                raise RequestError('conflict', 'a request with this id exists: ask again') from exc
            raise
        return self.view(item)

    def decide(self, request_id: str, decision: str, by: str) -> dict[str, Any]:
        """``confirm`` or ``decline`` a waiting request, once (``RequestError`` ``not_found``, or ``conflict`` naming the
        status a decided or expired one has)."""
        status = DECISIONS.get(decision)
        if status is None:
            raise RequestError('invalid', 'a request is confirmed or declined')
        now = _stamp(self.now())
        try:
            self.client.update_item(
                TableName=self.table, Key=_key(request_id),
                UpdateExpression='SET #status = :status, decided_by = :by, decided_at = :now',
                ConditionExpression='attribute_exists(pk) AND #status = :pending AND expires_at > :now',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={':status': {'S': status}, ':by': {'S': by}, ':now': {'S': now},
                                           ':pending': {'S': PENDING}})
        except ClientError as exc:
            if not _conditional_failure(exc):
                raise
            found = self.get(request_id)
            if found is None:
                raise RequestError('not_found', 'Run request not found') from exc
            raise RequestError('conflict', f"this request is {found['status']}: it can no longer be decided") from exc
        decided = self.get(request_id)
        if decided is None:   # (written a moment ago; never deleted)
            raise RequestError('not_found', 'Run request not found')
        return decided

    def record(self, request_id: str, outcome: str, *, run_id: str = '', engineering_run_id: str = '') -> None:
        """What came of a confirmed request's Run now (``started``, ``uncertain`` or the refusal's words)."""
        values: dict[str, Any] = {':outcome': {'S': outcome[:MAX_OUTCOME]}}
        update = 'SET outcome = :outcome'
        for name, value in (('run_id', run_id), ('engineering_run_id', engineering_run_id)):
            if value:
                update += f', {name} = :{name}'
                values[f':{name}'] = {'S': value}
        self.client.update_item(TableName=self.table, Key=_key(request_id), UpdateExpression=update,
                                ConditionExpression='attribute_exists(pk)', ExpressionAttributeValues=values)
