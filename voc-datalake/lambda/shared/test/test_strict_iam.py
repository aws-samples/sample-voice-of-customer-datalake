"""The IAM guard (shared/test/strict_iam.py): attribution, action expansion, the manifest."""
from __future__ import annotations

import pytest
from botocore.exceptions import ClientError

from shared.test import strict_iam


def test_the_manifest_names_existing_entry_modules_and_known_tables() -> None:
    manifest = strict_iam.manifest()
    for role, spec in manifest['roles'].items():
        assert (strict_iam.LAMBDA_ROOT / spec['entry']).is_file(), role
        assert set(spec['grants']) <= set(manifest['tables']), role
        assert 'dynamodb:DeleteItem' not in {a for actions in spec['grants'].values() for a in actions}, role


@pytest.mark.parametrize(('operation', 'params', 'expected'), [
    ('Query', {'TableName': 'm'}, [('m', 'dynamodb:Query')]),
    ('BatchGetItem', {'RequestItems': {'m': {}, 'a': {}}}, [('m', 'dynamodb:BatchGetItem'), ('a', 'dynamodb:BatchGetItem')]),
    ('TransactWriteItems', {'TransactItems': [
        {'Put': {'TableName': 'g'}}, {'Update': {'TableName': 'g'}}, {'ConditionCheck': {'TableName': 'g'}},
    ]}, [('g', 'dynamodb:PutItem'), ('g', 'dynamodb:UpdateItem'), ('g', 'dynamodb:ConditionCheckItem')]),
])
def test_required_actions(operation: str, params: dict, expected: list) -> None:
    assert list(strict_iam.required_actions(operation, params)) == expected


def test_a_missing_action_answers_access_denied(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('MEMORY_TABLE', 'test-memory')
    with pytest.raises(ClientError) as raised:
        strict_iam.check_call('MemoryWorkersMemoryScannerRole', 'Query', {'TableName': 'test-memory'})
    error = raised.value.response.get('Error', {})
    assert error.get('Code') == 'AccessDeniedException'
    assert 'dynamodb:Query' in error.get('Message', '')
    strict_iam.check_call('MemoryWorkersMemoryScannerRole', 'BatchGetItem', {'RequestItems': {'test-memory': {}}})


def test_tables_the_manifest_does_not_name_are_not_judged(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('MEMORY_TABLE', raising=False)
    assert strict_iam.logical_table('unrelated') is None
    # Not judged: even an action no role holds passes through to moto untouched.
    strict_iam.check_call('MemoryWorkersMemoryScannerRole', 'DeleteItem', {'TableName': 'unrelated'})
    monkeypatch.setenv('MEMORY_TABLE', 'unrelated')
    assert strict_iam.logical_table('unrelated') == 'Memory'



def test_a_frame_outside_every_entry_module_is_not_judged() -> None:
    import sys

    assert strict_iam.entry_role(sys._getframe()) is None
