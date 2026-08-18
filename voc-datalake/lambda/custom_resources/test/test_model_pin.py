"""Tests for the deploy-time global model pin.

Fail-on-revert intent:
  - the write MUST be conditional, so a redeploy cannot clobber a model an
    admin later picked in Settings (create-once, like admin_bootstrap);
  - an unexpected failure MUST raise, because a silent no-op leaves the stack
    green while every AI surface resolves to a model the account cannot invoke.
"""
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class _ConditionalCheckFailed(Exception):
    pass


class _FakeTable:
    def __init__(self, *, raises=None):
        self.raises = raises
        self.calls = []

        conditional = _ConditionalCheckFailed

        class _Exceptions:
            ConditionalCheckFailedException = conditional

        class _Client:
            exceptions = _Exceptions()

        class _Meta:
            client = _Client()

        self.meta = _Meta()

    def update_item(self, **kwargs):
        self.calls.append(kwargs)
        if self.raises is not None:
            raise self.raises
        return {}


def _load(table):
    """Import model_pin with boto3 stubbed to hand back our fake table."""
    fake_boto3 = types.ModuleType('boto3')
    fake_boto3.resource = lambda *_a, **_k: types.SimpleNamespace(Table=lambda _n: table)

    saved_boto3 = sys.modules.get('boto3')
    saved_module = sys.modules.pop('model_pin', None)
    sys.modules['boto3'] = fake_boto3
    try:
        import model_pin  # noqa: PLC0415 — deliberate re-import under the stub
        return model_pin
    finally:
        if saved_boto3 is None:
            sys.modules.pop('boto3', None)
        else:
            sys.modules['boto3'] = saved_boto3
        if saved_module is not None:
            sys.modules['model_pin'] = saved_module
        else:
            sys.modules.pop('model_pin', None)


def _event(request_type='Create', **props):
    base = {'TableName': 'voc-aggregates', 'ModelId': 'global.anthropic.claude-sonnet-4-6'}
    base.update(props)
    return {'RequestType': request_type, 'ResourceProperties': base}


def test_pins_the_model_when_unset():
    table = _FakeTable()
    module = _load(table)

    result = module.handler(_event(), None)

    assert result['Data']['outcome'] == 'pinned'
    assert result['Data']['modelId'] == 'global.anthropic.claude-sonnet-4-6'
    call = table.calls[0]
    assert call['Key'] == {'pk': 'SETTINGS#model', 'sk': 'config'}
    assert call['ExpressionAttributeValues'] == {':m': 'global.anthropic.claude-sonnet-4-6'}


def test_write_is_conditional_so_a_redeploy_cannot_clobber_an_admin_choice():
    table = _FakeTable()
    module = _load(table)

    module.handler(_event(), None)

    assert table.calls[0]['ConditionExpression'] == 'attribute_not_exists(model_id)'


def test_existing_value_is_kept_not_overwritten():
    table = _FakeTable(raises=_ConditionalCheckFailed('already set'))
    module = _load(table)

    result = module.handler(_event(), None)

    assert result['Data']['outcome'] == 'kept'


def test_unexpected_errors_raise_rather_than_silently_no_op():
    table = _FakeTable(raises=RuntimeError('table on fire'))
    module = _load(table)

    with pytest.raises(RuntimeError):
        module.handler(_event(), None)


def test_delete_is_a_no_op_and_leaves_the_setting_alone():
    table = _FakeTable()
    module = _load(table)

    result = module.handler(_event('Delete'), None)

    assert result['Data']['outcome'] == 'skipped'
    assert table.calls == []


@pytest.mark.parametrize('missing', ['TableName', 'ModelId'])
def test_missing_required_properties_raise(missing):
    table = _FakeTable()
    module = _load(table)

    with pytest.raises(ValueError):
        module.handler(_event(**{missing: ''}), None)


def test_physical_id_is_stable_across_request_types():
    """A changing PhysicalResourceId would make CloudFormation replace/delete the resource."""
    table = _FakeTable()
    module = _load(table)

    created = module.handler(_event(), None)['PhysicalResourceId']
    deleted = module.handler(_event('Delete'), None)['PhysicalResourceId']

    assert created == deleted
