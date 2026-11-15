"""Test support: an engineering run with a board, a conversation and a published report, on moto (already active).

Used by the views' tests and by the Agents API's engineering routes' tests, so both read the same run.
"""
from __future__ import annotations

import io
import json
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
from engineering.runtime.sessions import AgentSession
from engineering.workspace.store import WorkspaceStore

BUCKET = 'voc-engineering-workspace'
__all__ = ['BUCKET', 'FIXER', 'RUN', 'TABLE', 'EngineeringRun', 'LambdaClient', 'engineering_run']


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


#: The fixer on the run's task, as the supervisor's session row holds it.
FIXER = AgentSession(
    run_id=RUN, agent_id='fixer-1', role='fixer', task_id='task-1', language='python', egress=('pypi.org',),
    connection='repo-1', commit='a' * 40, paths=('src',), harness=('python3', '-m', 'harness'), vm_id='vm-1',
    endpoint='https://vm-1.example.org', started_at=1000, status='working', microvm_seconds=300,
    tokens={'model-a': {'in': 1000, 'out': 200}},
    inspect={'step': 'fix', 'recent_tools': ['read_file', 'run_tests'], 'last_progress_at': 1500, 'heartbeat_age': 30,
             'microvm_state': 'running', 'microvm_age': 600, 'stuck_why': ''})


class LambdaClient:
    """``invoke`` as boto3 answers it: a payload stream, and ``FunctionError`` when the function raised."""

    def __init__(self, payload: Any, function_error: str = '') -> None:
        self.payload = payload
        self.function_error = function_error
        self.requests: list[dict[str, Any]] = []

    def invoke(self, **request: Any) -> dict[str, Any]:
        self.requests.append(request)
        answer: dict[str, Any] = {'StatusCode': 200, 'Payload': io.BytesIO(json.dumps(self.payload).encode())}
        if self.function_error:
            answer['FunctionError'] = self.function_error
        return answer
