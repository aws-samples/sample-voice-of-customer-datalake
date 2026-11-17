"""A connection's newest gate record, for the Quality gates view's recorded tool versions (7.52.00).

A gate pack pins no tool versions: the repository's own pins decide them, and each gate runner records what it found
(``tool_versions`` in its ``voc-gate-record/1``: ``{tool: its version's first line}``). ``GET …/gates?connection=``
answers, per pack, the versions the connection's newest gate record holds and when (registry/views.py
``pack_tool_versions``). This finds that record:

- the runs, newest first, from the runs list (``WS#<ws>#RUNLIST#<yyyy-mm>``, this month and the ``MONTHS - 1`` before
  it), each of the connection's by its ``META`` (the list rows do not name the connection), at most ``MAX_RUNS`` of
  them and ``MAX_LISTED`` rows read;
- in each, its done tasks (``TASK#`` rows) and the gate record keys they recorded
  (``…/<agent>/commits/<sha>/_gate/attempt-<n>/record.json``: a gate runner's names the versions), newest first;
- the first record that reads and names a version.

The Agents API's role reads the table (GetItem, Query) and the gate records' objects (``…/_gate/*``, 7.51.00's run
workspace reads: lib/stacks/api-engineering-run-reads.ts); nothing here needs another grant.
"""
from __future__ import annotations

import json
import re
from collections.abc import Mapping
from datetime import datetime
from typing import Any, Final

from engineering.board.model import Task
from engineering.connectors.identity import WORKSPACE
from engineering.rows import get_row, run_pk, run_rows, string_attr
from engineering.run_objects import RunObjects
from engineering.runtime.outputs import GATE_SCHEMA

MONTHS: Final = 3
MAX_RUNS: Final = 10
#: (each a META read: GetItem one by one, as the role has no BatchGetItem; a page of the runs list at most)
MAX_LISTED: Final = 100
MAX_RECORD_BYTES: Final = 1024 * 1024
MAX_TOOLS: Final = 20
_RECORD_KEY: Final = re.compile(r'ws/default/runs/[A-Za-z0-9_-]{1,64}/[a-z][a-z-]{0,39}-[0-9]{1,3}/commits/'
                                r'(?:[0-9a-f]{40}|[0-9a-f]{64})/_gate/attempt-[1-9][0-9]{0,3}/record\.json\Z')


def months(now: datetime, count: int = MONTHS) -> list[str]:
    """``now``'s month and the ``count - 1`` before it, newest first (``yyyy-mm``)."""
    year, month = now.year, now.month
    found = []
    for _ in range(count):
        found.append(f'{year:04d}-{month:02d}')
        year, month = (year - 1, 12) if month == 1 else (year, month - 1)
    return found


class GateRecords:
    """``client`` and ``table``: the voc-engineering table's; ``objects``: the workspace bucket's."""

    def __init__(self, client: Any, table: str, objects: RunObjects) -> None:
        self.client, self.table, self.objects = client, table, objects

    def _listed(self, month: str, limit: int) -> list[str]:
        page = self.client.query(TableName=self.table, ConsistentRead=True, ScanIndexForward=False, Limit=limit,
                                 KeyConditionExpression='pk = :pk AND begins_with(sk, :run)',
                                 ExpressionAttributeValues={':pk': {'S': f'WS#{WORKSPACE}#RUNLIST#{month}'},
                                                            ':run': {'S': 'RUN#'}})
        return [string_attr(item, 'run_id') or string_attr(item, 'sk').rpartition('#')[2]
                for item in page.get('Items', [])]

    def newest(self, connection: str, now: datetime) -> dict[str, Any] | None:
        """The connection's newest gate record that names a tool version: ``{tool_versions, run_id, at, key}``
        (``at``: when its gate runner's task recorded it), None for none within the bounds."""
        runs = read = 0
        for month in months(now):
            listed = self._listed(month, MAX_LISTED - read)
            read += len(listed)
            for run_id in listed:
                meta = get_row(self.client, self.table, {'pk': {'S': run_pk(WORKSPACE, run_id)}, 'sk': {'S': 'META'}})
                if meta is None or string_attr(meta, 'connection') != connection:
                    continue
                runs += 1
                found = self._of_run(run_id)
                if found is not None or runs >= MAX_RUNS:
                    return found
            if read >= MAX_LISTED:
                return None
        return None

    def _of_run(self, run_id: str) -> dict[str, Any] | None:
        tasks = [Task.from_item(item) for item in run_rows(self.client, self.table, WORKSPACE, run_id, 'TASK#')]
        recorded = sorted(((task.updated_at, key) for task in tasks if task.state == 'done'
                           for key in task.result_keys if _RECORD_KEY.fullmatch(key)), reverse=True)
        for at, key in recorded:
            versions = self._versions(key)
            if versions:
                return {'tool_versions': versions, 'run_id': run_id, 'at': at or None, 'key': key}
        return None

    def _versions(self, key: str) -> dict[str, str]:
        read = self.objects.read(key, 0, MAX_RECORD_BYTES)
        try:
            record = json.loads(read.body) if read is not None else None
        except ValueError:
            return {}
        versions = record.get('tool_versions') if isinstance(record, Mapping) and record.get('schema') == GATE_SCHEMA \
            else None
        if not isinstance(versions, Mapping):
            return {}
        return {str(tool)[:64]: str(version)[:200] for tool, version in list(versions.items())[:MAX_TOOLS]
                if isinstance(version, str) and version}
