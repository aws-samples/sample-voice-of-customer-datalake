"""shared.tracing: the X-Ray SDK stays out of cold starts unless a request is sampled.

Most cases run in a SUBPROCESS: Powertools caches the tracing provider on the
Tracer class and the X-Ray SDK patches botocore process-wide, so in-process
checks would see whatever an earlier test left behind (see `imports_cryptography`
in lambda/conftest.py for the same reasoning).

`LAMBDA_TASK_ROOT` is set in the child so the Tracer runs ENABLED, as in Lambda —
outside Lambda Powertools disables itself, which is not the case being guarded.
"""

from __future__ import annotations

import asyncio
from typing import ClassVar

import pytest

from shared.test.fresh_interpreter import run_json
from shared.tracing import DeferredXRayProvider, NoOpSubsegment, is_sampled_trace_header

SAMPLED = 'Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1'
UNSAMPLED = 'Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=0'

# The API handlers whose cold start this guards (plus the global MCP handler, which
# builds its own Tracer, and the shared module every other Lambda imports).
GUARDED_MODULES = [
    'shared.logging',
    'integrations_handler',
    'mcp_tokens_handler',
    'feedback_form_handler',
    'memory_handler',
    'metrics_handler',
    'settings_handler',
    'mcp_global_handler',
]

# Lambda-like: the Tracer runs ENABLED (outside Lambda Powertools disables itself).
LAMBDA_MODE = {
    'LAMBDA_TASK_ROOT': '/var/task',
    'AWS_LAMBDA_FUNCTION_NAME': 'voc-test',
    'POWERTOOLS_SERVICE_NAME': 'voc-test',
    # The daemon address the SDK would emit to; nothing listens, UDP never blocks.
    'AWS_XRAY_DAEMON_ADDRESS': '127.0.0.1:2000',
}


def run_child(code: str, **env: str) -> dict:
    """`run_json` in Lambda mode."""
    return run_json(code, **LAMBDA_MODE, **env)


class TestImportingAHandlerDoesNotLoadTheXRaySdk:
    """Regression guard: `Tracer()` imported `aws_xray_sdk.core` (~350 ms, two botocore
    clients) on every cold start, and patched botocore/requests/httplib, although no
    API Lambda request is ever sampled. Revert shared/logging.py to `Tracer()` and
    every case here fails."""

    @pytest.mark.parametrize('module_name', GUARDED_MODULES)
    def test_import_keeps_the_sdk_core_and_its_patches_out(self, module_name):
        found = run_child(f"""
            import json, sys
            import {module_name}
            print(json.dumps({{
                'core': 'aws_xray_sdk.core' in sys.modules,
                'ext': sorted(m for m in sys.modules if m.startswith('aws_xray_sdk.ext')),
            }}))
        """)
        assert found == {'core': False, 'ext': []}, (
            f'importing {module_name} loaded the X-Ray SDK; construct Tracers with '
            'provider=deferred_xray_provider (shared/tracing.py)'
        )


class TestUnsampledInvocations:
    def test_run_through_the_tracer_without_loading_the_sdk(self):
        found = run_child(f"""
            import json, os, sys
            from shared.logging import tracer

            @tracer.capture_method
            def work(x):
                tracer.put_annotation('k', 'v')
                tracer.put_metadata('k', {{'a': 1}})
                return x * 2

            @tracer.capture_lambda_handler
            def handler(event, context):
                return work(event)

            results = []
            for header in [None, {UNSAMPLED!r}, 'Root=1-5759e988-bd862e3fe1be46a994272793;Sampled=1']:
                if header is None:
                    os.environ.pop('_X_AMZN_TRACE_ID', None)
                else:
                    os.environ['_X_AMZN_TRACE_ID'] = header
                results.append(handler(21, None))
            print(json.dumps({{'results': results, 'core': 'aws_xray_sdk.core' in sys.modules,
                               'disabled': tracer.disabled}}))
        """)
        assert found == {'results': [42, 42, 42], 'core': False, 'disabled': False}


class TestSampledInvocations:
    def test_load_the_sdk_once_apply_the_requested_patches_and_record(self):
        found = run_child(f"""
            import json, os, sys
            os.environ['_X_AMZN_TRACE_ID'] = {SAMPLED!r}
            from shared.logging import tracer
            from shared.tracing import deferred_xray_provider

            seen = {{}}

            @tracer.capture_method
            def work():
                from aws_xray_sdk.core import xray_recorder
                entity = xray_recorder.get_trace_entity()
                seen['entity'] = type(entity).__name__
                seen['sampled'] = bool(entity.sampled)
                return 'ok'

            before = 'aws_xray_sdk.core' in sys.modules
            out = work()
            from aws_xray_sdk.core import patcher, xray_recorder
            print(json.dumps({{
                'before': before,
                'out': out,
                'loaded': deferred_xray_provider.loaded,
                'seen': seen,
                'botocore_patched': 'botocore' in patcher._PATCHED_MODULES,
                'streaming_threshold': xray_recorder.streaming_threshold,
            }}))
        """)
        assert found == {
            'before': False,
            'out': 'ok',
            'loaded': True,
            'seen': {'entity': 'Subsegment', 'sampled': True},
            'botocore_patched': True,
            'streaming_threshold': 0,
        }

    def test_a_disabled_tracer_never_loads_the_sdk_even_when_sampled(self):
        found = run_child(f"""
            import json, os, sys
            os.environ['_X_AMZN_TRACE_ID'] = {SAMPLED!r}
            from shared.logging import tracer

            @tracer.capture_method
            def work():
                return 'ok'

            print(json.dumps({{'out': work(), 'core': 'aws_xray_sdk.core' in sys.modules,
                               'disabled': bool(tracer.disabled)}}))
        """, POWERTOOLS_TRACE_DISABLED='true')
        assert found == {'out': 'ok', 'core': False, 'disabled': True}


class TestIsSampledTraceHeaderMirrorsTheSdk:
    """The decision must be the SDK's own: compare with aws_xray_sdk's parser +
    LambdaContext rule (root and parent present, Sampled == 1)."""

    HEADERS: ClassVar[list[str | None]] = [
        None, '', SAMPLED, UNSAMPLED,
        'Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=?',
        'Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8',
        'Root=1-5759e988-bd862e3fe1be46a994272793;Sampled=1',
        'Parent=53995c3f42cd8ad8;Sampled=1',
        f' {SAMPLED} ',
        f'{SAMPLED};Lineage=a87bd80c:1|68fd508a:5',
        'Self=1-67891234-12456789abcdef012345678;' + SAMPLED,
        'garbage', ';;;', 'Root=;Parent=;Sampled=1',
    ]

    @pytest.mark.parametrize('header', HEADERS)
    def test_agrees_with_the_sdk(self, header):
        from aws_xray_sdk.core.models.trace_header import TraceHeader

        parsed = TraceHeader.from_header_str(header)
        sdk_sampled = bool(parsed.root) and bool(parsed.parent) and parsed.sampled == 1
        assert is_sampled_trace_header(header) is sdk_sampled


class TestProviderInProcess:
    """Unit case that needs no SDK: the unsampled async path."""

    def test_unsampled_async_subsegment_yields_the_noop(self, monkeypatch):
        monkeypatch.setenv('_X_AMZN_TRACE_ID', UNSAMPLED)
        provider = DeferredXRayProvider()

        async def enter() -> object:
            async with provider.in_subsegment_async(name='## x') as subsegment:
                return subsegment

        assert isinstance(asyncio.run(enter()), NoOpSubsegment)
        assert provider.loaded is False
