"""Fakes shared by the model_pin suites (test_model_pin.py and its mutation suite).

`model_pin` builds its DynamoDB resource at import, so each test re-imports it
with `boto3` swapped in sys.modules for a recording stub that hands back one
fake table.
"""
import sys
import types


class ConditionalCheckFailed(Exception):
    """What the fake table raises for a failed conditional write."""


class FakeTable:
    """A table whose `update_item` records its kwargs and optionally raises."""

    def __init__(self, *, raises=None):
        self.raises = raises
        self.calls = []

        class _Exceptions:
            ConditionalCheckFailedException = ConditionalCheckFailed

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


class RecordingBoto3(types.ModuleType):
    """A stand-in `boto3` module: records the resource and table names asked for."""

    def __init__(self, table):
        super().__init__('boto3')
        self.table = table
        self.resource_calls = []
        self.table_calls = []

    def resource(self, *args, **kwargs):
        self.resource_calls.append((args, kwargs))
        return types.SimpleNamespace(Table=self._table)

    def _table(self, name):
        self.table_calls.append(name)
        return self.table


def load_model_pin(table):
    """Import model_pin afresh under a boto3 stub; returns (module, stub)."""
    fake_boto3 = RecordingBoto3(table)
    saved_boto3 = sys.modules.get('boto3')
    saved_module = sys.modules.pop('model_pin', None)
    sys.modules['boto3'] = fake_boto3
    try:
        import model_pin  # deliberate re-import under the stub
        return model_pin, fake_boto3
    finally:
        if saved_boto3 is None:
            sys.modules.pop('boto3', None)
        else:
            sys.modules['boto3'] = saved_boto3
        if saved_module is not None:
            sys.modules['model_pin'] = saved_module
        else:
            sys.modules.pop('model_pin', None)
