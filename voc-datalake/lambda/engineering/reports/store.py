"""Publishing a report: a new version each time, never an overwrite (D1).

``WS#<ws>#RUN#<run>`` / ``REPORT#<level>#<subject>`` counts the versions (an atomic ``ADD``, so two builds racing get
two versions); each version is written once to ``ws/<ws>/reports/<run>/<level>/<subject>/v<nnnn>.json`` (``v0001``,
four digits) and ``.md``; the row's ``latest_version`` then names the highest version written (a conditional
``SET``, so two builds racing end on the later one), which is the one a reader is given.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from botocore.exceptions import ClientError

from engineering.rows import run_pk, run_rows
from engineering.workspace.layout import report_key
from engineering.workspace.store import WorkspaceStore
from shared.aws import is_conditional_check_failure


class ReportError(RuntimeError):
    """A version that cannot be published as itself."""


@dataclass(frozen=True)
class ReportEntry:
    level: str
    subject: str
    latest_version: int


@dataclass(frozen=True)
class Published:
    version: int
    key: str
    markdown_key: str


class ReportStore:
    def __init__(self, client: Any, table: str, workspace: WorkspaceStore) -> None:
        """``client`` is a low-level DynamoDB client."""
        self.client = client
        self.table = table
        self.workspace = workspace

    def publish(self, ws: str, run_id: str, level: str, subject: str, *,
                document: Callable[[int], tuple[Mapping[str, Any], str]]) -> Published:
        """``document(version)`` is the report and its Markdown for that version."""
        row = {'pk': {'S': f'WS#{ws}#RUN#{run_id}'}, 'sk': {'S': f'REPORT#{level}#{subject}'}}
        counted = self.client.update_item(
            TableName=self.table, Key=row, UpdateExpression='ADD versions :one', ReturnValues='UPDATED_NEW',
            ExpressionAttributeValues={':one': {'N': '1'}})
        version = int(counted['Attributes']['versions']['N'])
        report, markdown = document(version)
        json_key = report_key(ws, run_id, level, subject, version)
        markdown_key = report_key(ws, run_id, level, subject, version, 'md')
        for key, body, kind in ((json_key, json.dumps(report, sort_keys=True, indent=1), 'application/json'),
                                (markdown_key, markdown, 'text/markdown')):
            if not self.workspace.put_once(key, body, kind):
                # The counter and the bucket disagree (the row was lost): never hand on an older document as this one.
                raise ReportError(f'{key} already exists: the version counter is behind the bucket')
        try:
            self.client.update_item(
                TableName=self.table, Key=row, UpdateExpression='SET latest_version = :v',
                ConditionExpression='attribute_not_exists(latest_version) OR latest_version < :v',
                ExpressionAttributeValues={':v': {'N': str(version)}})
        except ClientError as exc:
            if not is_conditional_check_failure(exc):   # a later version was already written: it stays the latest
                raise
        return Published(version, json_key, markdown_key)

    def latest(self, ws: str, run_id: str, level: str, subject: str) -> int:
        """The report's latest written version, 0 when none was."""
        row = self.client.get_item(TableName=self.table, ConsistentRead=True, Key={
            'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': f'REPORT#{level}#{subject}'}}).get('Item', {})
        return int(row.get('latest_version', {}).get('N', '0'))

    def index(self, ws: str, run_id: str) -> list[ReportEntry]:
        """The run's reports, each with its latest written version (a counted version not yet written is not one)."""
        entries = []
        for row in run_rows(self.client, self.table, ws, run_id, 'REPORT#'):
            _, level, subject = row['sk']['S'].split('#', 2)
            latest = int(row.get('latest_version', {}).get('N', '0'))
            if latest:
                entries.append(ReportEntry(level, subject, latest))
        return entries
