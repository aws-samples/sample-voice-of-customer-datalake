"""moto-backed tables for the autonomous-agents tests (store, API, heartbeat).

``agents_env()`` is a context manager: inside it the agents, aggregates and
feedback tables exist in moto, ``shared.agents_store`` resolves the agents table
from ``AGENTS_TABLE``, and Step Functions is a MagicMock (returned as ``sfn``).
"""
from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
from moto import mock_aws

from shared import agents_store
from shared.api import clear_categories_cache

AGENTS_TABLE_NAME = 'test-agents'
STATE_MACHINE_ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:voc-agent-run'
CATEGORIES = [
    {'name': 'shipping', 'description': 'Shipping', 'subcategories': [{'name': 'late'}, {'name': 'damaged'}],
     'owners': [{'sub': 'owner-sub', 'username': 'owner', 'email': ''}]},
    {'name': 'billing', 'description': 'Billing', 'subcategories': []},
]


@dataclass
class AgentsEnv:
    resource: Any
    agents: Any
    aggregates: Any
    feedback: Any
    sfn: MagicMock


def _key_schema(hash_key: str, range_key: str) -> list[dict[str, str]]:
    return [{'AttributeName': hash_key, 'KeyType': 'HASH'}, {'AttributeName': range_key, 'KeyType': 'RANGE'}]


def _table(resource: Any, name: str, index: str | None, prefix: str = 'gsi1') -> Any:
    attributes = ['pk', 'sk'] + ([f'{prefix}pk', f'{prefix}sk'] if index else [])
    kwargs: dict[str, Any] = {
        'TableName': name, 'KeySchema': _key_schema('pk', 'sk'), 'BillingMode': 'PAY_PER_REQUEST',
        'AttributeDefinitions': [{'AttributeName': a, 'AttributeType': 'S'} for a in attributes],
    }
    if index:
        kwargs['GlobalSecondaryIndexes'] = [{
            'IndexName': index, 'KeySchema': _key_schema(f'{prefix}pk', f'{prefix}sk'),
            'Projection': {'ProjectionType': 'ALL'},
        }]
    return resource.create_table(**kwargs)


@contextmanager
def agents_env(*, with_state_machine: bool = True) -> Iterator[AgentsEnv]:
    env = {agents_store.AGENTS_TABLE_ENV: AGENTS_TABLE_NAME}
    if with_state_machine:
        env[agents_store.STATE_MACHINE_ENV] = STATE_MACHINE_ARN
    with mock_aws(), patch.dict(os.environ, env):
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        agents = _table(resource, AGENTS_TABLE_NAME, agents_store.AGENTS_INDEX)
        aggregates = _table(resource, 'test-aggregates-agents', None)
        feedback = _table(resource, 'test-feedback-agents', 'gsi1-by-date')
        aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': CATEGORIES})
        sfn = MagicMock()
        sfn.start_execution.side_effect = lambda **kw: {'executionArn': f"{STATE_MACHINE_ARN}:{kw['name']}"}
        agents_store._table_cache.clear()
        clear_categories_cache()
        with patch.object(agents_store, 'get_dynamodb_resource', return_value=resource), \
                patch.object(agents_store, '_stepfunctions', return_value=sfn):
            yield AgentsEnv(resource, agents, aggregates, feedback, sfn)
        agents_store._table_cache.clear()
        clear_categories_cache()


def agent_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        'name': 'Shipping crew', 'description': 'Late parcels',
        'scope': {'all': False, 'categories': ['shipping']},
        'triggers': [{'kind': 'new_reviews', 'min_new': 2, 'cooldown_hours': 12}],
    }
    body.update(overrides)
    return body
