"""Mutation hardening for `custom_resources/model_pin.py`.

`test_model_pin.py` pins the create-once write, the raise-on-failure contract
and the Delete no-op, but a mutation run found what it cannot see:

* the LITERALS that other code reads: the `voc-model-pin` PhysicalResourceId
  (a changed id makes CloudFormation replace the resource on the next deploy),
  the `dynamodb` boto3 resource name and the exact `SET model_id = :m`
  UpdateExpression that `shared/model_config.py` reads back as the legacy
  global override;
* that a property that is ABSENT — not just empty — is refused, and the
  wording of that refusal, which is what a failed stack shows the operator;
* the two INFO lines, which are the only record of whether a deploy pinned the
  model or found an admin's own choice and left it alone.
"""
import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from custom_resources.test.model_pin_fakes import ConditionalCheckFailed as _ConditionalCheckFailed
from custom_resources.test.model_pin_fakes import FakeTable as _FakeTable
from custom_resources.test.model_pin_fakes import load_model_pin as _load

MODEL = 'global.anthropic.claude-sonnet-4-6'


def _event(request_type='Create', props=None):
    """A custom-resource event; `props` replaces (not merges) the default properties."""
    if props is None:
        props = {'TableName': 'voc-aggregates', 'ModelId': MODEL}
    return {'RequestType': request_type, 'ResourceProperties': props}


class TestTheLiteralsOtherCodeReads:
    def test_physical_id_is_exactly_voc_model_pin(self):
        module, _ = _load(_FakeTable())

        assert module.PHYSICAL_ID == 'voc-model-pin'
        assert module.handler(_event(), None)['PhysicalResourceId'] == 'voc-model-pin'
        assert module.handler(_event('Delete'), None)['PhysicalResourceId'] == 'voc-model-pin'

    def test_table_comes_from_the_dynamodb_resource_named_in_the_event(self):
        module, boto3_stub = _load(_FakeTable())

        module.handler(_event(), None)

        assert boto3_stub.resource_calls == [(('dynamodb',), {})]
        assert boto3_stub.table_calls == ['voc-aggregates']

    def test_update_item_is_called_once_with_the_exact_arguments(self):
        table = _FakeTable()
        module, _ = _load(table)

        module.handler(_event(), None)

        assert table.calls == [{
            'Key': {'pk': 'SETTINGS#model', 'sk': 'config'},
            'UpdateExpression': 'SET model_id = :m',
            'ConditionExpression': 'attribute_not_exists(model_id)',
            'ExpressionAttributeValues': {':m': MODEL},
        }]

    def test_delete_returns_only_the_skipped_outcome(self):
        module, boto3_stub = _load(_FakeTable())

        result = module.handler(_event('Delete'), None)

        assert result == {'PhysicalResourceId': 'voc-model-pin', 'Data': {'outcome': 'skipped'}}
        assert boto3_stub.resource_calls == []

    @pytest.mark.parametrize(('raises', 'outcome'), [
        (None, 'pinned'),
        (_ConditionalCheckFailed('already set'), 'kept'),
    ])
    def test_create_and_update_return_outcome_and_model_id(self, raises, outcome):
        module, _ = _load(_FakeTable(raises=raises))

        for request_type in ('Create', 'Update'):
            result = module.handler(_event(request_type), None)
            assert result == {
                'PhysicalResourceId': 'voc-model-pin',
                'Data': {'outcome': outcome, 'modelId': MODEL},
            }


class TestAnAbsentPropertyIsRefusedByName:
    @pytest.mark.parametrize(('props', 'message'), [
        ({'TableName': 'voc-aggregates'},
         "ModelId and TableName are required (got '', 'voc-aggregates')"),
        ({'ModelId': MODEL},
         f"ModelId and TableName are required (got '{MODEL}', '')"),
        ({}, "ModelId and TableName are required (got '', '')"),
        ({'TableName': '', 'ModelId': ''}, "ModelId and TableName are required (got '', '')"),
    ])
    def test_missing_or_empty_property_message(self, props, message):
        module, boto3_stub = _load(_FakeTable())

        with pytest.raises(ValueError, match='are required') as excinfo:
            module.handler(_event(props=props), None)

        assert str(excinfo.value) == message
        assert boto3_stub.resource_calls == []

    def test_no_resource_properties_at_all_is_refused(self):
        module, _ = _load(_FakeTable())

        with pytest.raises(ValueError, match='are required') as excinfo:
            module.handler({'RequestType': 'Create'}, None)

        assert str(excinfo.value) == "ModelId and TableName are required (got '', '')"


def _info_lines(caplog, table) -> list[tuple[int, str]]:
    """Run a Create against ``table`` and return the (level, message) it logged."""
    module, _ = _load(table)

    with caplog.at_level(logging.INFO):
        module.handler(_event(), None)

    return [(r.levelno, r.getMessage()) for r in caplog.records]


class TestTheInfoLinesRecordWhatHappened:
    def test_pinning_logs_the_model(self, caplog):
        assert _info_lines(caplog, _FakeTable()) == [
            (logging.INFO, f'Pinned every AI surface to {MODEL}'),
        ]

    def test_keeping_an_existing_value_logs_the_wanted_model(self, caplog):
        assert _info_lines(caplog, _FakeTable(raises=_ConditionalCheckFailed('already set'))) == [
            (logging.INFO, f'model_id already set; leaving it untouched (wanted {MODEL})'),
        ]

    def test_an_unexpected_error_logs_nothing_and_propagates(self, caplog):
        module, _ = _load(_FakeTable(raises=RuntimeError('table on fire')))

        with caplog.at_level(logging.INFO), pytest.raises(RuntimeError, match='table on fire'):
            module.handler(_event(), None)

        assert caplog.records == []
