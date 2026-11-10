"""py_stored_attrs finds planted written-never-read attributes and stays quiet on read ones."""
from __future__ import annotations

import pytest
from audit_common import CDK_DIR
from py_stored_attrs import expression_reads, findings, main

from conftest import TreeMaker

STORE = '''
import json
from boto3.dynamodb.conditions import Attr

def save(table, run, logger):
    table.put_item(Item={'pk': 'RUN', 'sk': run.id, 'status': run.status, 'orphan_field': 1,
                         'served_field': 2, 'search_blob': run.text.lower()})
    logger.info('saved', extra={'log_only_field': 1})
    table.put_item(Item=_row(run))
    _write(table, Change({'approved_at_x': 'now'}))
    table.update_item(Key={'pk': 'RUN'}, UpdateExpression='SET finished_mark = :t, counter = counter + :one',
                      ConditionExpression='attribute_exists(pk) AND window_key = :w')
    lambda_client.invoke(Payload=json.dumps({'payload_field': 1}))
    return {'response_field': True}

def _row(run):
    return {'pk': 'X', 'built_field': 1}

def _write(table, change):
    table.update_item(**change.kwargs())

def view(item):
    return {'status': item.get('status'), 'counter': item['counter']}

def search(table, q):
    return table.scan(FilterExpression=Attr('search_blob').contains(q))
'''
SPA = "export const Schema = z.object({ served_field: z.number() })\n"


@pytest.fixture
def result(make_tree: TreeMaker) -> dict[str, str]:
    root = make_tree({'lambda/shared/runs_store.py': STORE, 'frontend/src/api/runsApi.ts': SPA,
                      'lambda/shared/test/test_runs_store.py': "assert item['orphan_field'] == 1\n"})
    found, _, _ = findings(root)
    return {f.key: f.kind for f in found}


def test_planted_unread_attributes_are_found(result: dict[str, str]) -> None:
    assert sorted(result) == [f'lambda/shared/runs_store.py::{name}' for name in (
        'approved_at_x', 'built_field', 'finished_mark', 'orphan_field')]   # a TEST reading orphan_field does not count


def test_read_attributes_and_non_item_dicts_stay_quiet(result: dict[str, str]) -> None:
    for quiet in ('status', 'served_field', 'search_blob', 'counter', 'window_key', 'log_only_field',
                  'payload_field', 'response_field'):
        assert not [k for k in result if k.endswith(f'::{quiet}')], quiet


def test_expression_reads_skip_the_attribute_being_set() -> None:
    assert expression_reads('SET a = if_not_exists(a, :z) + :one, b = c') == {'c'}
    assert expression_reads('attribute_exists(pk) AND #s = :s') == {'pk', 's'}
    assert expression_reads('plain text with no operator') == set()


def test_vacuity_guard_on_the_real_tree() -> None:
    assert main(['--cdk-dir', str(CDK_DIR)]) == 0
