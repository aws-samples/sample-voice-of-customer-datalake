"""The upstream pull requests' records (7.57.00; docs/autonomous-engineering.md, "Any public repository"): the broker's
``UpstreamLedger``, in voc-engineering's runs' writes' partitions (``WS#<ws>#WRITES#…``) with a write claim's
attributes alone (``pk``, ``sk``, ``state``, ``op``, ``at``, ``result``, ``closed_at``), so the broker's write grant is
unchanged (engineering-broker.ts ``BROKER_CLAIM_ATTRIBUTES``).

* **The run's**: ``WS#<ws>#WRITES#<run>`` / ``UPSTREAM_PULL_REQUEST`` (``run_links.UPSTREAM_SK``), ``op``
  ``upstream_pull_request``, ``state`` ``opened``, ``link``, ``refused`` or ``unknown``, ``result`` the record as JSON
  (``run_links.upstream_of`` reads it for the run's overview): the upstream, the number and address once opened, the
  GitHub login it was opened as, the one-click link (its compare page, the title, and the whole description when the
  link carries a short one), and why the app did not open it. An opened record is never replaced (a later refusal of a
  repeat leaves it).
* **The day's caps** (UTC days) on the pull requests the app opens itself (a person's click on the link counts
  nothing): ``WS#<ws>#WRITES#_upstream#<day>`` (the deployment's, ``DAILY_CAP``) and
  ``WS#<ws>#WRITES#_upstream#<day>#<owner/name>`` (each upstream's, ``REPO_DAILY_CAP``), one create-only slot row each,
  ``CAP#<n>``, ``op`` ``upstream_slot``, taken before the pull request is asked for (an automatic attempt counts,
  whatever GitHub answers) and closed with what came of it: its ``result`` holds the run, the connection, the upstream
  and, once closed, the outcome, the number and the login. These rows are the audit of every automatic open: who (the
  login), when, which run and repository, and what. A run is counted once a day: a repeat finds its slot. The
  partitions' names start with ``_``, never a run id (a ULID), so they never meet a run's writes.
"""
from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from engineering.connectors.hosts import UPSTREAM_OPENED, Unavailable, UpstreamRecord
from engineering.connectors.identity import WORKSPACE
from engineering.rows import string_attr
from engineering.run_links import UPSTREAM_OP, UPSTREAM_SK, upstream_view, writes_pk
from shared.aws import is_conditional_check_failure

#: The most upstream pull requests a deployment opens a UTC day, and on one upstream repository.
DAILY_CAP: Final = 10
REPO_DAILY_CAP: Final = 2
CAP_PREFIX: Final = 'CAP#'
SLOT_OP: Final = 'upstream_slot'
#: The caps' partitions, after a run's writes' prefix (never a ULID).
CAPS_PREFIX: Final = '_upstream#'
_UNREADABLE: Final = 'The upstream pull requests\' records could not be read; retry.'


def caps_partition(day: str, upstream: str = '') -> str:
    """A day's caps partition: the deployment's, or one upstream's (``owner/name``, in lower case)."""
    return writes_pk(WORKSPACE, f'{CAPS_PREFIX}{day}' + (f'#{upstream.lower()}' if upstream else ''))


class UpstreamRecords:
    """The ``UpstreamLedger`` over voc-engineering (a low-level DynamoDB client) and ``clock``."""

    def __init__(self, client: Any, table: str, clock: Callable[[], float] = time.time,
                 daily_cap: int = DAILY_CAP, repo_cap: int = REPO_DAILY_CAP) -> None:
        self._client = client
        self._table = table
        self._clock = clock
        self._caps = (repo_cap, daily_cap)

    # --- the run's ----------------------------------------------------------------------------------------------

    def _run_key(self, run_id: str) -> dict[str, Any]:
        return {'pk': {'S': writes_pk(WORKSPACE, run_id)}, 'sk': {'S': UPSTREAM_SK}}

    def recorded(self, run_id: str) -> UpstreamRecord | None:
        try:
            item = self._client.get_item(TableName=self._table, Key=self._run_key(run_id),
                                         ConsistentRead=True).get('Item')
        except (ClientError, BotoCoreError) as exc:
            raise Unavailable(_UNREADABLE) from exc
        found = None if item is None else upstream_view(string_attr(item, 'state'), string_attr(item, 'result'))
        if found is None:
            return None
        number, url = found['number'], found['url']
        return UpstreamRecord(state=found['state'], upstream=found['upstream'],
                              number=number if isinstance(number, int) else None,
                              url=url if isinstance(url, str) else None, login=found['as'], reason=found['reason'],
                              compare_url=found['compare_url'], title=found['title'],
                              description=found['description'])

    def record(self, run_id: str, record: UpstreamRecord) -> None:
        now = str(int(self._clock()))
        try:
            self._client.update_item(
                TableName=self._table, Key=self._run_key(run_id),
                UpdateExpression='SET #state = :state, #op = :op, #result = :result, #at = if_not_exists(#at, :now), '
                                 'closed_at = :now',
                ConditionExpression='attribute_not_exists(pk) OR #state <> :opened',
                ExpressionAttributeNames={'#state': 'state', '#op': 'op', '#result': 'result', '#at': 'at'},
                ExpressionAttributeValues={':state': {'S': record.state}, ':op': {'S': UPSTREAM_OP},
                                           ':result': {'S': json.dumps(record.view(), sort_keys=True)},
                                           ':now': {'N': now}, ':opened': {'S': UPSTREAM_OPENED}})
        except ClientError as exc:
            if is_conditional_check_failure(exc):
                return   # (opened already: it stands)
            raise Unavailable("The run's upstream pull request could not be recorded.") from exc
        except BotoCoreError as exc:
            raise Unavailable("The run's upstream pull request could not be recorded.") from exc

    # --- the day's caps -------------------------------------------------------------------------------------------

    def _slots(self, partition: str) -> list[dict[str, Any]]:
        try:
            answer = self._client.query(TableName=self._table, ConsistentRead=True,
                                        KeyConditionExpression='pk = :pk AND begins_with(sk, :slot)',
                                        ExpressionAttributeValues={':pk': {'S': partition},
                                                                   ':slot': {'S': CAP_PREFIX}})
        except (ClientError, BotoCoreError) as exc:
            raise Unavailable(_UNREADABLE) from exc
        items: list[dict[str, Any]] = answer.get('Items', [])
        return items

    @staticmethod
    def _run_of(item: dict[str, Any]) -> str:
        try:
            result = json.loads(string_attr(item, 'result') or '{}')
        except ValueError:
            return ''
        return str(result.get('run_id', '')) if isinstance(result, dict) else ''

    def _held(self, partition: str, run_id: str) -> tuple[str | None, int]:
        """The run's slot in ``partition`` (None: none) and how many are taken."""
        slots = self._slots(partition)
        mine = next((string_attr(item, 'sk') for item in slots if self._run_of(item) == run_id), None)
        return mine, len(slots)

    def _claim(self, partition: str, cap: int, facts: dict[str, object]) -> bool:
        now = str(int(self._clock()))
        for n in range(1, cap + 1):
            try:
                self._client.put_item(
                    TableName=self._table, ConditionExpression='attribute_not_exists(pk)',
                    Item={'pk': {'S': partition}, 'sk': {'S': f'{CAP_PREFIX}{n:03d}'}, 'state': {'S': 'claimed'},
                          'op': {'S': SLOT_OP}, 'at': {'N': now}, 'result': {'S': json.dumps(facts, sort_keys=True)}})
            except ClientError as exc:
                if is_conditional_check_failure(exc):
                    continue
                raise Unavailable(_UNREADABLE) from exc
            except BotoCoreError as exc:
                raise Unavailable(_UNREADABLE) from exc
            return True
        return False

    def take_slot(self, day: str, upstream: str, run_id: str, connection_id: str) -> str | None:
        partitions = ((caps_partition(day, upstream), self._caps[0], f'{upstream} takes'),
                      (caps_partition(day), self._caps[1], 'this deployment opens'))
        due: list[tuple[str, int, str]] = []
        for partition, cap, what in partitions:
            mine, taken = self._held(partition, run_id)
            if mine is not None:
                continue
            if taken >= cap:
                return _full(what, cap)
            due.append((partition, cap, what))
        facts: dict[str, object] = {'run_id': run_id, 'connection_id': connection_id, 'upstream': upstream, 'day': day}
        for partition, cap, what in due:
            if not self._claim(partition, cap, facts):
                return _full(what, cap)
        return None

    def close_slot(self, day: str, upstream: str, run_id: str, outcome: dict[str, object]) -> None:
        for partition in (caps_partition(day, upstream), caps_partition(day)):
            mine, _ = self._held(partition, run_id)
            if mine is None:
                continue
            facts = {'run_id': run_id, 'upstream': upstream, 'day': day, **outcome}
            try:
                self._client.update_item(
                    TableName=self._table, Key={'pk': {'S': partition}, 'sk': {'S': mine}},
                    UpdateExpression='SET #state = :state, #result = :result, closed_at = :now',
                    ExpressionAttributeNames={'#state': 'state', '#result': 'result'},
                    ExpressionAttributeValues={':state': {'S': str(outcome.get('state', 'done'))},
                                               ':result': {'S': json.dumps(facts, sort_keys=True)},
                                               ':now': {'N': str(int(self._clock()))}})
            except (ClientError, BotoCoreError) as exc:
                raise Unavailable('The upstream pull request\'s audit could not be recorded.') from exc


def _full(what: str, cap: int) -> str:
    return (f'The daily cap on upstream pull requests the app opens is reached ({what} at most {cap} a UTC day), so '
            'it did not open this one.')
