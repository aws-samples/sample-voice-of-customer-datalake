"""Publishing a report: a new version each time, never an overwrite (D1).

``WS#<ws>#RUN#<run>`` / ``REPORT#<level>#<subject>`` counts the versions (an atomic ``ADD``, so two builds racing get
two versions); each version is written once to ``ws/<ws>/reports/<run>/<level>/<subject>/v<nnnn>.json`` (``v0001``,
four digits) and ``.md``.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from engineering.workspace.layout import report_key
from engineering.workspace.store import WorkspaceStore


class ReportError(RuntimeError):
    """A version that cannot be published as itself."""


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
        counted = self.client.update_item(
            TableName=self.table, Key={'pk': {'S': f'WS#{ws}#RUN#{run_id}'}, 'sk': {'S': f'REPORT#{level}#{subject}'}},
            UpdateExpression='ADD versions :one', ReturnValues='UPDATED_NEW',
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
        return Published(version, json_key, markdown_key)
