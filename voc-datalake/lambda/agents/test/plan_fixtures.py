"""The arrange block of the plan-conductor suites: moto tables, a fake Cognito, a scripted
``voc-plan-step``, and a driver that plays the state machine's plan branch in Python
(``PlanDecide`` → Map(prepare → plan-step → record) | Wait → ``PlanDecide`` …).
"""
from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from unittest.mock import patch

import boto3
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import agents_store
from shared import plans_store as ps
from shared.plan_schema import THINK_DEFAULT_OUTPUT

APPROVER = ps.Approver(sub='user-sub', username='bob')



def write_step(step_id: str, tool: str, args: dict, *, pack: str = 'core', after: list[str] | None = None,
               produces: list[str] | None = None) -> dict:
    step: dict[str, Any] = {'id': step_id, 'pack': pack, 'kind': 'write', 'title': f'Run {tool}',
                            'write': {'tool': tool, 'args': args}}
    if after:
        step['after'] = after
    if produces:
        step['produces'] = produces
    return step


def think_step(step_id: str, *, pack: str = 'insights', produces: list[str] | None = None) -> dict:
    step: dict[str, Any] = {'id': step_id, 'pack': pack, 'kind': 'think', 'title': f'Analyse {step_id}',
                            'think': {'brief': 'Read-only. Summarise the main problems.'}}
    if produces:
        step['produces'] = produces
    return step


def plan_of(*steps: dict) -> dict:
    return {'schema': 'voc-plan/1', 'goal': 'Test plan', 'steps': list(steps)}


@dataclass
class FakeCognito:
    enabled: bool = True
    sub: str = APPROVER.sub
    groups: list[str] = field(default_factory=lambda: ['users'])
    exists: bool = True
    broken: bool = False
    calls: list[str] = field(default_factory=list)

    def _check(self, operation: str) -> None:
        self.calls.append(operation)
        if self.broken:
            raise ClientError({'Error': {'Code': 'InternalErrorException'}}, operation)
        if not self.exists:
            raise ClientError({'Error': {'Code': 'UserNotFoundException'}}, operation)

    def admin_get_user(self, **_kwargs: Any) -> dict:
        self._check('AdminGetUser')
        return {'Enabled': self.enabled, 'UserAttributes': [{'Name': 'sub', 'Value': self.sub}]}

    def admin_list_groups_for_user(self, **_kwargs: Any) -> dict:
        self._check('AdminListGroupsForUser')
        return {'Groups': [{'GroupName': name} for name in self.groups]}


@dataclass
class PlanStep:
    """The scripted voc-plan-step: per step id, the answer to give (else done with its declared outputs and,
    like the real runner, the fingerprint of the approved write it executed)."""

    results: dict[str, dict] = field(default_factory=dict)
    events: list[dict] = field(default_factory=list)

    def __call__(self, event: dict) -> dict:
        self.events.append(event)
        step = event['step']
        scripted = self.results.get(step['id'])
        if scripted is not None:
            return scripted
        # Like voc-plan-step (think.ts): a think step without `produces` answers under THINK_DEFAULT_OUTPUT.
        names = step.get('produces') or ([THINK_DEFAULT_OUTPUT] if step.get('kind') == 'think' else [])
        done: dict[str, Any] = {'status': 'done', 'outputs': {name: f"{step['id']}-{name}" for name in names}}
        approved = event.get('approved_pending')
        if isinstance(approved, dict):
            done['fingerprint'] = approved.get('fingerprint')
        return done

    def event_for(self, step_id: str) -> dict:
        return next(event for event in reversed(self.events) if event['step']['id'] == step_id)


@dataclass
class PlanEnv:
    agents: Any
    aggregates: Any
    jobs: Any
    cognito: FakeCognito
    plan_step: PlanStep

    def create(self, plan: dict, *, now: datetime | None = None) -> str:
        return ps.create_plan(self.agents, plan, approver=APPROVER, conversation_id=None,
                              now=now or agents_store.utc_now())['plan_id']

    def steps(self, plan_id: str) -> dict[str, dict]:
        return {row['step_id']: row for row in ps.get_steps(self.agents, plan_id)}

    def statuses(self, plan_id: str) -> dict[str, str]:
        return {step_id: row['status'] for step_id, row in self.steps(plan_id).items()}

    def meta(self, plan_id: str) -> dict:
        return ps.get_meta(self.agents, plan_id) or {}


def _table(resource: Any, name: str, *, index: bool) -> Any:
    attributes = ['pk', 'sk', 'gsi1pk', 'gsi1sk'] if index else ['pk', 'sk']
    kwargs: dict[str, Any] = {
        'TableName': name, 'BillingMode': 'PAY_PER_REQUEST',
        'KeySchema': [{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        'AttributeDefinitions': [{'AttributeName': a, 'AttributeType': 'S'} for a in attributes],
    }
    if index:
        kwargs['GlobalSecondaryIndexes'] = [{
            'IndexName': agents_store.AGENTS_INDEX, 'Projection': {'ProjectionType': 'ALL'},
            'KeySchema': [{'AttributeName': 'gsi1pk', 'KeyType': 'HASH'},
                          {'AttributeName': 'gsi1sk', 'KeyType': 'RANGE'}],
        }]
    return resource.create_table(**kwargs)


@contextmanager
def plan_env() -> Iterator[PlanEnv]:
    import shared.aws
    # The table env vars the conductor reads, so lambda/shared/test/strict_iam.py judges every call
    # against the conductor role's grants (memory-agents-dynamodb-grants.json).
    tables = {'AGENTS_TABLE': 'test-plan-agents', 'AGGREGATES_TABLE': 'test-plan-aggs', 'JOBS_TABLE': 'test-plan-jobs'}
    with mock_aws(), patch.dict('os.environ', {**tables, 'USER_POOL_ID': 'pool-1'}):
        shared.aws._dynamodb_resource = None
        agents_store._table_cache.clear()
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        env = PlanEnv(_table(resource, tables['AGENTS_TABLE'], index=True),
                      _table(resource, tables['AGGREGATES_TABLE'], index=False),
                      _table(resource, tables['JOBS_TABLE'], index=False), FakeCognito(), PlanStep())
        with patch('agents.plan_identity._cognito', return_value=env.cognito), \
                patch('agents.plan_waits.get_aggregates_table', return_value=env.aggregates), \
                patch('agents.plan_waits.get_jobs_table', return_value=env.jobs):
            yield env
        agents_store._table_cache.clear()
    shared.aws._dynamodb_resource = None


def conduct(event: dict) -> dict:
    from agents.conductor import handler
    result = handler.handle(event)
    json.dumps(result)  # Step Functions must be able to carry it
    return result


def run_steps(env: PlanEnv, plan_id: str, step_ids: list[str]) -> None:
    """One Map: prepare → plan-step → record per step (sequentially; the order does not matter)."""
    for step_id in step_ids:
        ids = {'plan_id': plan_id, 'step_id': step_id}
        prepared = conduct({'action': 'plan_prepare', **ids})
        if prepared.get('run'):
            conduct({'action': 'plan_record', **ids, 'result': env.plan_step(prepared['event'])})


def drive(env: PlanEnv, plan_id: str, *, on_wait: Callable[[int], None] | None = None,
          max_loops: int = 60) -> dict:
    """Play the plan branch until it finishes; ``on_wait(n)`` runs at the n-th Wait state."""
    waits = 0
    for _ in range(max_loops):
        directive = conduct({'action': 'plan_decide', 'plan_id': plan_id})
        if directive['kind'] == 'finish':
            return directive
        if directive['kind'] == 'execute':
            run_steps(env, plan_id, directive['steps'])
            continue
        if directive['kind'] != 'wait':
            raise AssertionError(directive)
        waits += 1
        if on_wait is None:
            return directive
        on_wait(waits)
    raise AssertionError('the plan did not finish')
