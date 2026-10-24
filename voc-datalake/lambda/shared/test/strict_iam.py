"""Teach the backend suite the IAM grants of the memory/agents Lambda roles.

moto authorizes every call, so ``voc-memory-scanner`` passed all its tests while
production answered ``AccessDeniedException ... dynamodb:BatchGetItem`` on every
run: the role (``lib/stacks/memory-workers.ts``) lacked the action its code used.

``install`` wraps ``botocore``'s ``BaseClient._make_api_call``. For a DynamoDB call
it finds the INNERMOST Lambda entry module on the Python stack (the handler file a
role in ``lib/stacks/memory-agents-dynamodb-grants.json`` names), maps the table
name back to its logical table through the environment variable the Lambda reads
it from, and expands the call into the IAM actions DynamoDB checks
(``TransactWriteItems`` is authorized per item: Put -> PutItem, Update ->
UpdateItem, ...; ``BatchGetItem`` per table). An action the role does not hold
answers the ``AccessDeniedException`` IAM would. The same manifest is pinned
against the synthesized roles by ``lib/stacks/memory-agents-stack.test.ts``, so the
code, the tests and the stack cannot drift apart.

Calls with no entry module on the stack (unit tests of shared helpers) or on a
table the manifest does not name are not judged.

Set ``VOC_IAM_OBSERVE=<file>`` to append every judged call as a JSON line
(``role table action``) — how the grants were audited down to what is used.
"""
from __future__ import annotations

import json
import os
import sys
from collections.abc import Iterator, Mapping
from functools import cache
from pathlib import Path
from types import FrameType
from typing import Any

from botocore.client import BaseClient
from botocore.exceptions import ClientError

MANIFEST_PATH = Path(__file__).resolve().parents[3] / 'lib' / 'stacks' / 'memory-agents-dynamodb-grants.json'
OBSERVE_ENV = 'VOC_IAM_OBSERVE'
LAMBDA_ROOT = Path(__file__).resolve().parents[2]
_TRANSACT_ACTIONS = {'Put': 'PutItem', 'Update': 'UpdateItem', 'Delete': 'DeleteItem',
                     'ConditionCheck': 'ConditionCheckItem', 'Get': 'GetItem'}


@cache
def manifest() -> dict[str, Any]:
    loaded = json.loads(MANIFEST_PATH.read_text())
    if not isinstance(loaded, dict):
        raise TypeError(f'{MANIFEST_PATH} is not a JSON object')
    return loaded


@cache
def _roles_by_entry() -> dict[str, str]:
    roles = manifest()['roles']
    return {str((LAMBDA_ROOT / spec['entry']).resolve()): role for role, spec in roles.items()}


@cache
def _resolved(filename: str) -> str:
    return str(Path(filename).resolve())


def entry_role(frame: FrameType | None) -> str | None:
    """The role of the innermost Lambda entry module on the stack, if any."""
    entries = _roles_by_entry()
    while frame is not None:
        role = entries.get(_resolved(frame.f_code.co_filename))
        if role is not None:
            return role
        frame = frame.f_back
    return None


def logical_table(table_name: object) -> str | None:
    if not isinstance(table_name, str):
        return None
    for logical, env_name in manifest()['tables'].items():
        if os.environ.get(env_name) == table_name:
            return str(logical)
    return None


def required_actions(operation: str, params: Mapping[str, Any]) -> Iterator[tuple[object, str]]:
    """``(table name, IAM action)`` pairs DynamoDB authorizes for one API call."""
    if operation in ('BatchGetItem', 'BatchWriteItem'):
        for table_name in params.get('RequestItems') or {}:
            yield table_name, f'dynamodb:{operation}'
    elif operation in ('TransactWriteItems', 'TransactGetItems'):
        for entry in params.get('TransactItems') or []:
            for kind, body in entry.items():
                yield body.get('TableName'), f'dynamodb:{_TRANSACT_ACTIONS.get(kind, kind)}'
    else:
        yield params.get('TableName'), f'dynamodb:{operation}'


def _access_denied(role: str, action: str, table_name: object, operation: str) -> ClientError:
    message = (f'User: arn:aws:sts::123456789012:assumed-role/{role}/test is not authorized to perform: '
               f'{action} on resource: table/{table_name} because no identity-based policy allows the '
               f'{action} action')
    return ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': message}}, operation)


def check_call(role: str, operation: str, params: Mapping[str, Any]) -> None:
    grants = manifest()['roles'][role]['grants']
    observe = os.environ.get(OBSERVE_ENV)
    for table_name, action in required_actions(operation, params):
        logical = logical_table(table_name)
        if logical is None:
            continue
        if observe:
            with open(observe, 'a', encoding='utf-8') as sink:
                sink.write(json.dumps({'role': role, 'table': logical, 'action': action}) + '\n')
        if action not in grants.get(logical, []):
            raise _access_denied(role, action, table_name, operation)


def install(monkeypatch) -> None:
    """Enforce the manifest's DynamoDB grants on every botocore call for one test."""
    # vars(): the private method is untyped in botocore's stubs.
    original = vars(BaseClient)['_make_api_call']

    def judged_call(self: BaseClient, operation_name: str, api_params: dict[str, Any]):
        if self.meta.service_model.service_name == 'dynamodb':
            role = entry_role(sys._getframe(1))
            if role is not None:
                check_call(role, operation_name, api_params)
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, '_make_api_call', judged_call)
