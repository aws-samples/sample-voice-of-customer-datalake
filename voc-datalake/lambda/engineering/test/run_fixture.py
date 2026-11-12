"""Test support: an engineering run with a board, a conversation and a published report, on moto (already active).

Used by the views' tests and by the Agents API's engineering routes' tests, so both read the same run.
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import count
from typing import Any

import boto3

from engineering.board.store import BoardStore
from engineering.board.test.table import RUN, TABLE, create_table, start_run
from engineering.bus.schema import parse
from engineering.bus.test.messages import message
from engineering.conversation.store import ConversationStore
from engineering.reports.store import ReportStore
from engineering.workspace.store import WorkspaceStore

BUCKET = 'voc-engineering-workspace'
__all__ = ['BUCKET', 'RUN', 'TABLE', 'EngineeringRun', 'engineering_run']


@dataclass
class EngineeringRun:
    client: Any
    s3: Any
    workspace: WorkspaceStore
    task_id: str


def engineering_run(region: str = 'us-east-1') -> EngineeringRun:
    """Inside a moto context: the table and bucket, one run with one moved task, three messages, one report."""
    client = create_table(region)
    start_run(client)
    s3 = boto3.client('s3', region_name=region)
    s3.create_bucket(Bucket=BUCKET)
    workspace = WorkspaceStore(s3, BUCKET)
    ids = count(1)
    board = BoardStore(client, TABLE, new_id=lambda: f'task-{next(ids)}')
    task = board.post('default', RUN, role='fixer', title='Fix the page size', spec={'issue': 7}, parent_task='',
                      priority=1, actor='coordinator-0').task
    board.claim('default', RUN, task.task_id, role='fixer', agent='fixer-1')
    conversation = ConversationStore(client, TABLE)
    for seq in range(3):
        conversation.append_to_conversation(parse(message(run_id=RUN, summary=f'Message {seq}', refs={'s3': []})))
    ReportStore(client, TABLE, workspace).publish(
        'default', RUN, 'goal', RUN, document=lambda version: ({'schema': 'voc-report/1', 'version': version},
                                                                f'## Goal report (v{version})\n'))
    return EngineeringRun(client, s3, workspace, task.task_id)
