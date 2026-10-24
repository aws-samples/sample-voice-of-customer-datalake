"""Mutation hardening for `shared/tracing.py`.

`test_tracing.py` proves the end-to-end contract in subprocesses (no SDK on an
unsampled cold start, a recorded subsegment on a sampled one) and checks the
header rule against the SDK's own parser. A mutation run found what those
cases cannot see, because the subprocesses always run with the SDK enabled and
the in-process cases never take the sampled path:

* the SAMPLED path's delegation: the exact arguments handed to
  ``xray_recorder`` (``name``, ``namespace='default'``, ``streaming_threshold=0``),
  that the SDK is loaded only once, and that patches requested before the load
  are replayed and patches requested after it are applied at once;
* the SDK switch (``global_sdk_config`` when the package root is imported,
  else ``AWS_XRAY_SDK_ENABLED``) — a sampled header with the SDK disabled must
  not load anything;
* the header rule's literals (``Root``/``Parent``/``Sampled=1``, ``;`` and ``=``)
  stated as plain expectations rather than as agreement with the SDK.

A fake ``aws_xray_sdk`` package stands in for the SDK, so every case runs
in-process and leaves ``sys.modules`` as it found it.
"""

from __future__ import annotations

import asyncio
import inspect
import sys
import types
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from typing import Any
from unittest.mock import MagicMock, call

import pytest
from aws_lambda_powertools.tracing.base import BaseSegment

from shared.tracing import (
    TRACE_HEADER_ENV,
    DeferredXRayProvider,
    NoOpSubsegment,
    is_sampled_trace_header,
)

ROOT = 'Root=1-5759e988-bd862e3fe1be46a994272793'
PARENT = 'Parent=53995c3f42cd8ad8'
SAMPLED = f'{ROOT};{PARENT};Sampled=1'


class FakeRecorder:
    """Stands in for ``aws_xray_sdk.core.xray_recorder``; records every call."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.subsegment = object()

    def configure(self, **kwargs: Any) -> None:
        self.calls.append(('configure', kwargs))

    def put_annotation(self, **kwargs: Any) -> None:
        self.calls.append(('put_annotation', kwargs))

    def put_metadata(self, **kwargs: Any) -> None:
        self.calls.append(('put_metadata', kwargs))

    @contextmanager
    def in_subsegment(self, **kwargs: Any) -> Iterator[object]:
        self.calls.append(('in_subsegment', kwargs))
        yield self.subsegment

    @asynccontextmanager
    async def in_subsegment_async(self, **kwargs: Any) -> AsyncIterator[object]:
        self.calls.append(('in_subsegment_async', kwargs))
        yield self.subsegment


class FakeSdk:
    """The fake package root + ``core`` module, installed in ``sys.modules``."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, sdk_enabled: bool | None = None) -> None:
        self.recorder = FakeRecorder()
        self.patch: MagicMock = MagicMock()
        self.patch_all: MagicMock = MagicMock()
        core = types.ModuleType('aws_xray_sdk.core')
        core.__dict__.update(xray_recorder=self.recorder, patch=self.patch, patch_all=self.patch_all)
        root = types.ModuleType('aws_xray_sdk')
        root.__dict__['core'] = core
        if sdk_enabled is not None:
            root.__dict__['global_sdk_config'] = types.SimpleNamespace(sdk_enabled=lambda: sdk_enabled)
        monkeypatch.setitem(sys.modules, 'aws_xray_sdk', root)
        monkeypatch.setitem(sys.modules, 'aws_xray_sdk.core', core)


@pytest.fixture
def sampled(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    monkeypatch.setenv('_X_AMZN_TRACE_ID', SAMPLED)
    monkeypatch.delenv('AWS_XRAY_SDK_ENABLED', raising=False)
    return monkeypatch


class TestTheHeaderRule:
    def test_reads_the_lambda_trace_env_var(self):
        assert TRACE_HEADER_ENV == '_X_AMZN_TRACE_ID'

    @pytest.mark.parametrize(('header', 'expected'), [
        (SAMPLED, True),
        (f'{PARENT};Sampled=1;{ROOT}', True),
        (f'{ROOT};{PARENT};Sampled=0', False),
        (f'{ROOT};{PARENT};Sampled=?', False),
        (f'{ROOT};{PARENT};Sampled=11', False),
        (f'{ROOT};{PARENT}', False),
        (f'{ROOT};Sampled=1', False),
        (f'{PARENT};Sampled=1', False),
        (f'{ROOT};{PARENT};Sampled', False),
        ('Root=r;Parent=p;Sampled=1', True),
        ('Root=r,Parent=p,Sampled=1', False),
        ('Root:r;Parent:p;Sampled:1', False),
        ('', False),
        (None, False),
    ])
    def test_needs_root_parent_and_sampled_one(self, header, expected):
        assert is_sampled_trace_header(header) is expected


class TestTheSdkSwitch:
    @pytest.mark.parametrize(('enabled', 'loads'), [(True, True), (False, False)])
    def test_global_sdk_config_decides_when_the_package_root_is_loaded(self, sampled, enabled, loads):
        sampled.setenv('AWS_XRAY_SDK_ENABLED', 'false' if enabled else 'true')
        sdk = FakeSdk(sampled, sdk_enabled=enabled)
        provider = DeferredXRayProvider()
        provider.put_annotation('k', 'v')
        assert provider.loaded is loads
        assert sdk.recorder.calls == ([('configure', {'streaming_threshold': 0}),
                                       ('put_annotation', {'key': 'k', 'value': 'v'})] if loads else [])

    @pytest.mark.parametrize(('value', 'loads'), [
        (None, True), ('true', True), ('anything', True), ('false', False), (' FALSE ', False),
    ])
    def test_without_the_package_root_the_env_var_decides(self, sampled, value, loads):
        sdk = FakeSdk(sampled)
        if value is not None:
            sampled.setenv('AWS_XRAY_SDK_ENABLED', value)
        assert DeferredXRayProvider._sdk_enabled() is loads
        provider = DeferredXRayProvider()
        provider.put_metadata('k', 'v')
        assert provider.loaded is loads
        assert len(sdk.recorder.calls) == (2 if loads else 0)

    def test_without_any_sdk_module_the_env_var_decides(self, sampled):
        sampled.delitem(sys.modules, 'aws_xray_sdk', raising=False)
        assert DeferredXRayProvider._sdk_enabled() is True
        sampled.setenv('AWS_XRAY_SDK_ENABLED', 'false')
        assert DeferredXRayProvider._sdk_enabled() is False


class TestTheSampledPathDelegatesToTheRecorder:
    def test_in_subsegment_passes_name_and_kwargs_and_yields_the_sdk_subsegment(self, sampled):
        sdk = FakeSdk(sampled)
        provider = DeferredXRayProvider()
        with provider.in_subsegment(name='## work', extra=1) as subsegment:
            assert subsegment is sdk.recorder.subsegment
        assert sdk.recorder.calls == [
            ('configure', {'streaming_threshold': 0}),
            ('in_subsegment', {'name': '## work', 'extra': 1}),
        ]

    def test_in_subsegment_async_passes_name_and_kwargs_and_yields_the_sdk_subsegment(self, sampled):
        sdk = FakeSdk(sampled)
        provider = DeferredXRayProvider()

        async def enter() -> object:
            async with provider.in_subsegment_async(name='## work', extra=1) as subsegment:
                return subsegment

        assert asyncio.run(enter()) is sdk.recorder.subsegment
        assert sdk.recorder.calls == [
            ('configure', {'streaming_threshold': 0}),
            ('in_subsegment_async', {'name': '## work', 'extra': 1}),
        ]

    def test_annotations_and_metadata_keep_their_arguments_and_the_default_namespace(self, sampled):
        sdk = FakeSdk(sampled)
        provider = DeferredXRayProvider()
        provider.put_annotation('a', 1)
        provider.put_metadata('m', {'x': 2})
        provider.put_metadata('n', 3, namespace='ns')
        assert sdk.recorder.calls == [
            ('configure', {'streaming_threshold': 0}),
            ('put_annotation', {'key': 'a', 'value': 1}),
            ('put_metadata', {'key': 'm', 'value': {'x': 2}, 'namespace': 'default'}),
            ('put_metadata', {'key': 'n', 'value': 3, 'namespace': 'ns'}),
        ]

    def test_the_sdk_is_loaded_and_configured_once(self, sampled):
        sdk = FakeSdk(sampled)
        provider = DeferredXRayProvider()
        assert provider.loaded is False
        provider.put_annotation('a', 1)
        assert provider.loaded is True
        provider.put_annotation('b', 2)
        assert [name for name, _ in sdk.recorder.calls] == ['configure', 'put_annotation', 'put_annotation']


class TestPatchRequests:
    def test_requests_before_the_load_are_replayed_in_order_at_the_load(self, sampled):
        sdk = FakeSdk(sampled)
        parent = MagicMock()
        parent.attach_mock(sdk.patch, 'patch')
        parent.attach_mock(sdk.patch_all, 'patch_all')
        provider = DeferredXRayProvider()
        provider.patch(['boto3', 'requests'])
        provider.patch_all()
        assert parent.mock_calls == []
        provider.put_annotation('k', 'v')
        assert parent.mock_calls == [call.patch(('boto3', 'requests')), call.patch_all()]

    def test_requests_after_the_load_are_applied_at_once_and_not_queued(self, sampled):
        sdk = FakeSdk(sampled)
        provider = DeferredXRayProvider()
        provider.put_annotation('k', 'v')
        provider.patch(['httplib'])
        sdk.patch.assert_called_once_with(('httplib',))
        provider.patch_all()
        sdk.patch_all.assert_called_once_with()
        assert provider._patch_requests == []

    def test_unsampled_requests_are_only_queued(self, monkeypatch):
        monkeypatch.delenv('_X_AMZN_TRACE_ID', raising=False)
        sdk = FakeSdk(monkeypatch)
        provider = DeferredXRayProvider()
        provider.patch(['boto3'])
        provider.patch_all()
        provider.put_annotation('k', 'v')
        assert provider._patch_requests == [('boto3',), None]
        sdk.patch.assert_not_called()
        sdk.patch_all.assert_not_called()
        assert sdk.recorder.calls == []


class TestTheUnsampledPath:
    def test_every_unsampled_subsegment_is_the_one_shared_noop(self, monkeypatch):
        monkeypatch.delenv('_X_AMZN_TRACE_ID', raising=False)
        first, second = DeferredXRayProvider(), DeferredXRayProvider()
        with first.in_subsegment(name='a') as one, second.in_subsegment(name='b') as two:
            assert isinstance(one, NoOpSubsegment)
            assert one is two


def _parameter_shape(cls: type, method: str) -> list[tuple[str, object]]:
    return [(p.name, p.default) for p in inspect.signature(getattr(cls, method)).parameters.values()]


class TestTheNoOpKeepsTheBaseSegmentSignatures:
    """Powertools calls the segment through BaseSegment's signatures, so the no-op keeps
    every parameter name and default (``namespace='default'``, ``remote=False``, ...)."""

    @pytest.mark.parametrize('method', sorted(BaseSegment.__abstractmethods__))
    def test_parameter_names_and_defaults_match(self, method):
        assert _parameter_shape(NoOpSubsegment, method) == _parameter_shape(BaseSegment, method)

    def test_the_defaults_are_the_base_segment_ones(self):
        assert inspect.signature(NoOpSubsegment.put_metadata).parameters['namespace'].default == 'default'
        assert inspect.signature(NoOpSubsegment.add_exception).parameters['remote'].default is False
        assert inspect.signature(NoOpSubsegment.close).parameters['end_time'].default is None
