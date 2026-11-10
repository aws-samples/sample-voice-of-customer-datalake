"""Tests for the deploy-time global model pin.

Fail-on-revert intent:
  - the write MUST be conditional, so a redeploy cannot clobber a model an
    admin later picked in Settings (create-once, like admin_bootstrap);
  - an unexpected failure MUST raise, because a silent no-op leaves the stack
    green while every AI surface resolves to a model the account cannot invoke.

The literal payloads, outcomes, refusal messages and PhysicalResourceId are
pinned in test_model_pin_mutation.py.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from custom_resources.test.model_pin_fakes import FakeTable as _FakeTable
from custom_resources.test.model_pin_fakes import load_model_pin


def _load(table):
    """Import model_pin with boto3 stubbed to hand back our fake table."""
    module, _ = load_model_pin(table)
    return module


def _event():
    return {
        'RequestType': 'Create',
        'ResourceProperties': {
            'TableName': 'voc-aggregates',
            'ModelId': 'global.anthropic.claude-sonnet-4-6',
        },
    }


def test_write_is_conditional_so_a_redeploy_cannot_clobber_an_admin_choice():
    table = _FakeTable()
    module = _load(table)

    module.handler(_event(), None)

    assert table.calls[0]['ConditionExpression'] == 'attribute_not_exists(model_id)'


def test_unexpected_errors_raise_rather_than_silently_no_op():
    table = _FakeTable(raises=RuntimeError('table on fire'))
    module = _load(table)

    with pytest.raises(RuntimeError):
        module.handler(_event(), None)
