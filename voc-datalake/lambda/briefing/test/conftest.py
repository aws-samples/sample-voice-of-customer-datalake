"""moto tables for the brief worker: feedback (date + urgency indexes), aggregates,
agents, memory and projects, plus a category config of two categories."""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import boto3
import pytest
from moto import mock_aws

from briefing.build import Tables
from shared.api import clear_categories_cache
from shared.indexes import (
    AGENTS_LISTING_INDEX,
    FEEDBACK_BY_DATE_INDEX,
    FEEDBACK_BY_URGENCY_INDEX,
    MEMORY_BY_STATUS_INDEX,
    PROJECTS_BY_TYPE_INDEX,
)

NOW = datetime(2026, 10, 17, 9, 0, tzinfo=UTC)
CATEGORIES = [{'name': 'shipping', 'subcategories': []}, {'name': 'billing', 'subcategories': []}]


def _create(resource: Any, name: str, indexes: dict[str, str]) -> Any:
    """A pk/sk table with one ALL-projected index per ``{index name: key prefix}``."""
    keys = ['pk', 'sk'] + [f'{prefix}{part}' for prefix in indexes.values() for part in ('pk', 'sk')]
    spec: dict[str, Any] = {
        'TableName': name, 'BillingMode': 'PAY_PER_REQUEST',
        'KeySchema': [{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        'AttributeDefinitions': [{'AttributeName': key, 'AttributeType': 'S'} for key in keys],
    }
    if indexes:
        spec['GlobalSecondaryIndexes'] = [{
            'IndexName': index, 'Projection': {'ProjectionType': 'ALL'},
            'KeySchema': [{'AttributeName': f'{prefix}pk', 'KeyType': 'HASH'},
                          {'AttributeName': f'{prefix}sk', 'KeyType': 'RANGE'}],
        } for index, prefix in indexes.items()]
    return resource.create_table(**spec)


@dataclass
class World:
    tables: Tables
    sqs: Any
    queue_url: str

    def review(self, feedback_id: str, *, category: str, day: str, source: str = 'webscraper',
               urgency: str = 'low', sentiment: str = 'neutral', text: str = 'It was fine') -> None:
        stamp = f'{day}T08:00:00+00:00'
        self.tables.feedback.put_item(Item={
            'pk': f'SOURCE#{source}', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
            'gsi1pk': f'DATE#{day}', 'gsi1sk': f'{stamp}#{feedback_id}', 'gsi3pk': f'URGENCY#{urgency}',
            'gsi3sk': stamp, 'category': category, 'source_platform': source, 'sentiment_label': sentiment,
            'urgency': urgency, 'date': day, 'original_text': text,
        })

    def counter(self, pk: str, day: str, count: int) -> None:
        self.tables.aggregates.put_item(Item={'pk': pk, 'sk': day, 'count': count})


@pytest.fixture
def world(monkeypatch) -> Iterator[World]:
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        tables = Tables(
            feedback=_create(resource, 'test-feedback', {FEEDBACK_BY_DATE_INDEX: 'gsi1', FEEDBACK_BY_URGENCY_INDEX: 'gsi3'}),
            aggregates=_create(resource, 'test-aggregates', {}),
            memory=_create(resource, 'test-memory', {MEMORY_BY_STATUS_INDEX: 'gsi1'}),
            agents=_create(resource, 'test-agents', {AGENTS_LISTING_INDEX: 'gsi1'}),
            projects=_create(resource, 'test-projects', {PROJECTS_BY_TYPE_INDEX: 'gsi1'}),
        )
        tables.aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': CATEGORIES})
        sqs = boto3.client('sqs', region_name='us-east-1')
        queue_url = sqs.create_queue(QueueName='voc-briefing-test')['QueueUrl']
        monkeypatch.setenv('BRIEFING_QUEUE_URL', queue_url)
        clear_categories_cache()
        yield World(tables, sqs, queue_url)
        clear_categories_cache()
