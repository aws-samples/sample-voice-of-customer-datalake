"""What a person reads of an engineering run, behind the Agents API's ``/agents/engineering/<run_id>/…`` routes.

The board (its tasks, each with its history), the conversation (the run's messages in order, as data) and the
reports (an index of each report's latest written version, and a version's document and Markdown). Everything here
reads the run's record (the ``voc-engineering`` table and the workspace bucket); who may read is the route's to
decide (``api/agents_handler.py``), and an unknown run reads as None, which the route answers 404.

Since 7.51.00, the run workspace's two run-wide reads (an agent's thread and tabs: views_thread.py,
views_inspector.py):

- ``runs``: the deployment's runs by the month they started (``WS#<ws>#RUNLIST#<yyyy-mm>`` / ``RUN#<started_at>#<run>``,
  written by the run's start and updated at its end), newest first, by flow and status, a page at a time;
- ``assertions``: each step's assertions as the run's copy of its flow declares them (``params.assert``,
  shared/workflow_engineering.py), with what the board recorded of each (``ASSERT#<step>#<attempt>``: pass, fail or
  unread, and why), the step's latest attempt; ``pending`` while the step has recorded none.
"""
from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Final

from boto3.dynamodb.types import TypeDeserializer

from engineering.board.store import BoardStore
from engineering.bus.publish import new_event_id
from engineering.connectors.identity import WORKSPACE
from engineering.conversation.store import ConversationStore
from engineering.flow.record import FLOW_SK, copied_definition
from engineering.reports.store import ReportStore
from engineering.rows import TAIL_WINDOW, get_row, next_after, run_pk, run_rows, string_attr, window_page, window_start
from engineering.workspace.layout import REPORT_LEVELS, report_key
from engineering.workspace.store import WorkspaceStore
from shared.workflow_engineering import step_assertions

#: The runs one page of the list holds at most.
MAX_RUNS_PAGE: Final = 100
#: What a record says of a check (``unread``: what it checks was not recorded); ``pending``: no record yet.
ASSERTION_STATUSES: Final = ('pass', 'fail', 'unread', 'pending')
_DESERIALIZE: Final = TypeDeserializer()


class ListCursorError(ValueError):
    """A runs list cursor that is not one this list gave (the route answers 400)."""


def runlist_pk(month: str) -> str:
    return f'WS#{WORKSPACE}#RUNLIST#{month}'


def _plain(item: Mapping[str, Any]) -> dict[str, Any]:
    """A low-level item's values (a value that does not read is left out)."""
    plain: dict[str, Any] = {}
    for name, value in item.items():
        try:
            plain[name] = _DESERIALIZE.deserialize(value)
        except (TypeError, ValueError, InvalidOperation):
            continue
    return plain


def _short(value: object, limit: int = 500) -> str | None:
    return value[:limit] if isinstance(value, str) and value else None


def _amount(value: object) -> float | None:
    try:
        amount = Decimal(str(value)) if isinstance(value, int | float | Decimal | str) else None
    except InvalidOperation:
        return None
    return float(round(amount, 6)) if amount is not None and amount.is_finite() and amount >= 0 else None


def _parent_id(value: object) -> dict[str, str | None] | None:
    if isinstance(value, Mapping) and _short(value.get('run_id'), 128):
        return {'run_id': _short(value.get('run_id'), 128), 'mode': _short(value.get('mode'), 40)}
    return {'run_id': value[:128], 'mode': None} if isinstance(value, str) and value else None


def run_listed(item: Mapping[str, Any]) -> dict[str, Any]:
    """A ``RUNLIST`` row as the runs list shows it."""
    row = _plain(item)
    return {'run_id': _short(row.get('run_id'), 128) or string_attr(item, 'sk').rpartition('#')[2],
            'flow': _short(row.get('flow'), 128), 'goal': _short(row.get('goal')), 'status': _short(row.get('status'), 40),
            'started_at': _short(row.get('started_at'), 40), 'ended_at': _short(row.get('ended_at'), 40),
            'cost_usd': _amount(row.get('cost_usd')), 'parent': _parent_id(row.get('parent'))}


def encode_list_cursor(key: Mapping[str, Any]) -> str:
    raw = json.dumps({'pk': string_attr(key, 'pk'), 'sk': string_attr(key, 'sk')}, separators=(',', ':'))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip('=')


def decode_list_cursor(text: str, month: str) -> dict[str, Any]:
    """The key a page of ``month``'s list starts after (``ListCursorError`` for one this list did not give)."""
    try:
        raw = json.loads(base64.urlsafe_b64decode(text + '=' * (-len(text) % 4)))
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise ListCursorError('cursor is the next a page of this list gave') from exc
    if not (isinstance(raw, dict) and raw.get('pk') == runlist_pk(month) and isinstance(raw.get('sk'), str)
            and raw['sk'].startswith('RUN#') and len(raw['sk']) <= 300):
        raise ListCursorError('cursor is the next a page of this list gave (for the same month)')
    return {'pk': {'S': raw['pk']}, 'sk': {'S': raw['sk']}}


def _records(rows: list[dict[str, Any]]) -> dict[str, tuple[int, str, list[Mapping[str, Any]]]]:
    """Each step's latest ``ASSERT#`` record: its attempt, when, and its results."""
    latest: dict[str, tuple[int, str, list[Mapping[str, Any]]]] = {}
    for item in rows:
        row = _plain(item)
        step, attempt = row.get('step'), row.get('attempt')
        results = row.get('results')
        if isinstance(results, str):
            try:
                results = json.loads(results)
            except ValueError:
                results = None
        if not isinstance(step, str) or not isinstance(attempt, int | Decimal) or not isinstance(results, list):
            continue
        if step not in latest or int(attempt) >= latest[step][0]:
            latest[step] = (int(attempt), str(row.get('at', '')),
                            [result for result in results if isinstance(result, Mapping)])
    return latest


def _assertion(step: str, declared: Mapping[str, Any], found: Mapping[str, Any] | None, attempt: int | None,
               at: str | None) -> dict[str, Any]:
    status = found.get('status') if found is not None else 'pending'
    return {'step': step, 'check': str(declared.get('check', ''))[:80],
            'args': dict(declared['args']) if isinstance(declared.get('args'), Mapping) else {},
            'on_fail': str((found or {}).get('on_fail') or declared.get('on_fail') or 'block')[:20],
            'status': status if status in ASSERTION_STATUSES else 'unread',
            'detail': _short((found or {}).get('detail'), 500), 'attempt': attempt, 'at': at or None}


@dataclass(frozen=True)
class Report:
    document: dict[str, Any]
    markdown: str


class EngineeringViews:
    def __init__(self, client: Any, table: str, workspace: WorkspaceStore) -> None:
        """``client`` is a low-level DynamoDB client; the three stores share it."""
        self.client, self.table = client, table
        self.board_store = BoardStore(client, table, new_id=new_event_id)
        self.conversation_store = ConversationStore(client, table)
        self.report_store = ReportStore(client, table, workspace)

    def run_exists(self, run_id: str) -> bool:
        return self.board_store.run_exists(WORKSPACE, run_id)

    def board(self, run_id: str) -> dict[str, Any] | None:
        if not self.run_exists(run_id):
            return None
        history = self.board_store.history(WORKSPACE, run_id)
        return {'tasks': [{**task.view(), 'history': [move.view() for move in history.get(task.task_id, ())]}
                          for task in self.board_store.tasks(WORKSPACE, run_id)]}

    def conversation(self, run_id: str, *, after: int, limit: int) -> dict[str, Any] | None:
        """A page of the conversation after ``after`` (a seq); ``next_after`` is where the next page starts.

        Two writers may commit their numbers out of order (engineering/conversation/store.py), so a message just
        below the newest can land after a reader passed it. Every page re-reads the ``TAIL_WINDOW`` messages below
        ``after`` (``rows.window_start``), a full page as much as the tail, and moves on to its last seq: at most
        ``limit`` messages above ``after`` and the window's again, which the reader keeps once, by its ``seq``.
        """
        if not self.run_exists(run_id):
            return None
        read = self.conversation_store.page(WORKSPACE, run_id, after=window_start(after), limit=limit + TAIL_WINDOW)
        items = window_page(after, read, limit, lambda item: item['seq'])
        return {'items': items, 'next_after': next_after(after, [item['seq'] for item in items])}

    def runs(self, month: str, *, flow: str | None, status: str | None, cursor: str | None,
             limit: int = MAX_RUNS_PAGE) -> dict[str, Any]:
        """A page of the runs started in ``month`` (``yyyy-mm``), newest first, of one flow and in one status when
        named (``{runs, next}``: ``next`` None after the last page; ``ListCursorError`` for a cursor off this list)."""
        names: dict[str, str] = {}
        values: dict[str, Any] = {':pk': {'S': runlist_pk(month)}, ':run': {'S': 'RUN#'}}
        filters = []
        for name, wanted in (('flow', flow), ('status', status)):
            if wanted:
                names[f'#{name}'], values[f':{name}'] = name, {'S': wanted}
                filters.append(f'#{name} = :{name}')
        request: dict[str, Any] = {'TableName': self.table, 'ConsistentRead': True, 'ScanIndexForward': False,
                                   'Limit': limit, 'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :run)',
                                   'ExpressionAttributeValues': values}
        if filters:
            request.update(FilterExpression=' AND '.join(filters), ExpressionAttributeNames=names)
        if cursor:
            request['ExclusiveStartKey'] = decode_list_cursor(cursor, month)
        page = self.client.query(**request)
        last = page.get('LastEvaluatedKey')
        return {'runs': [run_listed(item) for item in page.get('Items', [])],
                'next': encode_list_cursor(last) if isinstance(last, Mapping) and last else None}

    def assertions(self, run_id: str) -> list[dict[str, Any]] | None:
        """Every step's assertions with what was recorded of each (``[{step, check, args, on_fail, status, detail,
        attempt, at}]``, in the flow's order), none for a run without a flow; None for an unknown run."""
        if not self.run_exists(run_id):
            return None
        copy = get_row(self.client, self.table, {'pk': {'S': run_pk(WORKSPACE, run_id)}, 'sk': {'S': FLOW_SK}})
        if copy is None:
            return []
        try:
            nodes = copied_definition(copy).get('nodes')
        except ValueError:
            return []
        records = _records(run_rows(self.client, self.table, WORKSPACE, run_id, 'ASSERT#'))
        found: list[dict[str, Any]] = []
        for node in nodes if isinstance(nodes, list) else ():
            step = node.get('id') if isinstance(node, Mapping) else None
            if not isinstance(step, str):
                continue
            attempt, at, results = records.get(step, (None, None, []))
            unmatched = list(results)
            for declared in step_assertions(node):
                result = next((each for each in unmatched if each.get('check') == declared.get('check')), None)
                if result is not None:
                    unmatched.remove(result)
                found.append(_assertion(step, declared, result, attempt, at))
            # (a check the record holds that the copy does not declare: the step's built-in ones)
            found += [_assertion(step, extra, extra, attempt, at) for extra in unmatched]
        return found

    def reports(self, run_id: str) -> dict[str, Any] | None:
        if not self.run_exists(run_id):
            return None
        return {'items': [{'level': entry.level, 'subject': entry.subject, 'latest_version': entry.latest_version}
                          for entry in self.report_store.index(WORKSPACE, run_id)]}

    def report(self, run_id: str, level: str, subject: str, version: int | None) -> Report | None:
        """A version of a report (``None``: the latest written), or None when there is no such report or version."""
        if level not in REPORT_LEVELS:
            return None
        latest = self.report_store.latest(WORKSPACE, run_id, level, subject)
        wanted = latest if version is None else version
        if not 1 <= wanted <= latest:
            return None   # (so a report was published under this subject, which makes it a valid key)
        keys = (report_key(WORKSPACE, run_id, level, subject, wanted),
                report_key(WORKSPACE, run_id, level, subject, wanted, 'md'))
        # A version below the latest can have been counted and never written (its build failed between the counter and
        # the put): it reads as missing (the Agents API builds its store with denied_is_missing, having no ListBucket).
        document, markdown = (self.report_store.workspace.read_text(key) for key in keys)
        if document is None or markdown is None:
            return None
        return Report(json.loads(document), markdown)
