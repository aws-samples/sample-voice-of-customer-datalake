"""The upstream pull requests' records (7.57.00; docs/autonomous-engineering.md, "Any public repository"): the broker's
``UpstreamLedger``, in voc-engineering's runs' writes' partitions (``WS#<ws>#WRITES#…``) with a write claim's
attributes alone (``pk``, ``sk``, ``state``, ``op``, ``at``, ``result``, ``closed_at``), so the broker's write grant is
unchanged (engineering-broker.ts ``BROKER_CLAIM_ATTRIBUTES``).

The run's: ``WS#<ws>#WRITES#<run>`` / ``UPSTREAM_PULL_REQUEST`` (``run_links.UPSTREAM_SK``), ``op``
``upstream_pull_request``, ``state`` ``opened`` (found open from the run's branch: the person opened it), ``link`` or
``refused``, ``result`` the record as JSON (``run_links.upstream_of`` reads it for the run's overview): the upstream, the
number and address once open, the one-click link (its compare page, the title, and the whole description when the link
carries a short one), and why there is none. An opened record is never replaced (a later refusal of a repeat leaves it).
7.57.00's daily caps on the pull requests the app opened itself are gone with that open (7.58.00).
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

_UNREADABLE: Final = 'The upstream pull requests\' records could not be read; retry.'


class UpstreamRecords:
    """The ``UpstreamLedger`` over voc-engineering (a low-level DynamoDB client) and ``clock``."""

    def __init__(self, client: Any, table: str, clock: Callable[[], float] = time.time) -> None:
        self._client = client
        self._table = table
        self._clock = clock

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
