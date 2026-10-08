"""X-Ray tracing provider that loads the X-Ray SDK only for a sampled invocation.

Why this exists (cold start): Powertools' ``Tracer()`` imports ``aws_xray_sdk.core``
the moment it is constructed — even when tracing is disabled — and that import
builds the SDK's default sampler, which creates two botocore ``xray`` clients
(service-model + endpoint-ruleset loads, and a directory scan of every botocore
service). Then, in Lambda, ``auto_patch`` wraps botocore, requests and httplib.
Measured with ``python -X importtime``, that was ~350 ms of every API Lambda's
~0.7-1.0 s import, on every cold start (docs/lambda-sizing.md, "Cold starts").

Yet no API Lambda request is ever sampled: the functions run with the default
``PassThrough`` tracing mode and the REST API stage has tracing off, so the trace
header Lambda hands the function says ``Sampled=0`` (or is absent). The X-Ray SDK
answers such an invocation with ``DummySegment``/``DummySubsegment`` objects that
record nothing. Only Lambdas started by a traced Step Functions state machine
(document workflow, research, agent runtime) can receive ``Sampled=1``.

``DeferredXRayProvider`` decides per call, from the same ``_X_AMZN_TRACE_ID``
header and with the same rule the SDK uses (``lambda_launcher.LambdaContext``):

* not sampled -> a no-op subsegment; the SDK is never imported;
* sampled -> the SDK is imported once (thread-safe), the patches the Tracer asked
  for (``patch_all``/``patch``) are applied then — they wrap classes, so clients
  built earlier are covered — ``streaming_threshold=0`` is set exactly as Powertools
  does for its own X-Ray provider, and every call is delegated to ``xray_recorder``.

So the traces X-Ray stores are unchanged. The one difference is on unsampled
requests: the patched SDK used to stamp ``X-Amzn-Trace-Id: ...;Sampled=0`` on
outgoing AWS/HTTP calls, which no longer happens (nothing was recorded for them).

This module imports only the standard library and ``aws_lambda_powertools.tracing.base``
(no X-Ray SDK, no botocore); ``test_tracing.py`` pins that.
"""

from __future__ import annotations

import os
import sys
import threading
from collections.abc import AsyncIterator, Iterator, Sequence
from contextlib import asynccontextmanager, contextmanager
from typing import Any

from aws_lambda_powertools.tracing.base import BaseProvider, BaseSegment

# The env var the Lambda runtime sets per invocation, read by aws_xray_sdk's
# LambdaContext (aws_xray_sdk.core.lambda_launcher.LAMBDA_TRACE_HEADER_KEY).
TRACE_HEADER_ENV = '_X_AMZN_TRACE_ID'


def is_sampled_trace_header(header: str | None) -> bool:
    """True when the X-Ray SDK would record this invocation.

    Mirrors ``TraceHeader.from_header_str`` + ``LambdaContext._initialize_context``:
    without ``Root`` and ``Parent`` the SDK uses a ``DummySegment``; otherwise only
    ``Sampled=1`` yields a sampled facade (``0``, ``?`` and a missing flag do not).
    """
    if not header:
        return False
    fields: dict[str, str] = {}
    for part in header.strip().split(';'):
        key, sep, value = part.partition('=')
        if sep:
            fields[key] = value
    return bool(fields.get('Root')) and bool(fields.get('Parent')) and fields.get('Sampled') == '1'


class NoOpSubsegment(BaseSegment):
    """What an unsampled invocation gets: accepts every call, records nothing.

    The BaseSegment signatures are kept, so every parameter is deliberately unused (``del``).
    """

    def close(self, end_time: int | None = None) -> None:
        del end_time

    def add_subsegment(self, subsegment: Any) -> None:
        del subsegment

    def remove_subsegment(self, subsegment: Any) -> None:
        del subsegment

    def put_annotation(self, key: str, value: Any) -> None:
        del key, value

    def put_metadata(self, key: str, value: Any, namespace: str = 'default') -> None:
        del key, value, namespace

    def add_exception(self, exception: BaseException, stack: Any, remote: bool = False) -> None:
        del exception, stack, remote


_NOOP_SUBSEGMENT = NoOpSubsegment()

class DeferredXRayProvider(BaseProvider):
    """Powertools tracing provider that defers the X-Ray SDK to the first sampled call."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._recorder: Any = None
        # A patch request: None = patch_all(), else the module names for patch().
        self._patch_requests = list[tuple[str, ...] | None]()

    @property
    def loaded(self) -> bool:
        """Whether the X-Ray SDK has been imported through this provider."""
        return self._recorder is not None

    # -- the decision -------------------------------------------------------

    @staticmethod
    def _sdk_enabled() -> bool:
        """Honour ``Tracer(disabled=True)``/``POWERTOOLS_TRACE_DISABLED`` and ``AWS_XRAY_SDK_ENABLED``.

        A disabled Tracer calls ``aws_xray_sdk.global_sdk_config.set_sdk_enabled(False)``,
        which imports only the light package root; read it from there when present.
        """
        sdk = sys.modules.get('aws_xray_sdk')
        config = getattr(sdk, 'global_sdk_config', None)
        if config is not None:
            return bool(config.sdk_enabled())
        flag = os.environ.get(
            'AWS_XRAY_SDK_ENABLED',
            'true',  # pragma: no mutate  any default other than 'false' means enabled
        )
        return flag.strip().lower() != 'false'

    def _active(self) -> bool:
        return is_sampled_trace_header(os.environ.get(TRACE_HEADER_ENV)) and self._sdk_enabled()

    # -- lazy load ----------------------------------------------------------

    def _load(self) -> Any:
        with self._lock:
            if self._recorder is None:
                from aws_xray_sdk.core import xray_recorder

                for request in self._patch_requests:
                    _apply_patch(request)
                # Powertools sets this for its own X-Ray provider (see Tracer._disable_xray_trace_batching).
                xray_recorder.configure(streaming_threshold=0)
                self._recorder = xray_recorder
            return self._recorder

    # -- BaseProvider -------------------------------------------------------

    @contextmanager
    def in_subsegment(self, name: str | None = None, **kwargs: Any) -> Iterator[Any]:
        if not self._active():
            yield _NOOP_SUBSEGMENT
            return
        with self._load().in_subsegment(name=name, **kwargs) as subsegment:
            yield subsegment

    @asynccontextmanager
    async def in_subsegment_async(self, name: str | None = None, **kwargs: Any) -> AsyncIterator[Any]:
        if not self._active():
            yield _NOOP_SUBSEGMENT
            return
        async with self._load().in_subsegment_async(name=name, **kwargs) as subsegment:
            yield subsegment

    def put_annotation(self, key: str, value: Any) -> None:
        if self._active():
            self._load().put_annotation(key=key, value=value)

    def put_metadata(self, key: str, value: Any, namespace: str = 'default') -> None:
        if self._active():
            self._load().put_metadata(key=key, value=value, namespace=namespace)

    def patch(self, modules: Sequence[str]) -> None:
        self._request_patch(tuple(modules))

    def patch_all(self) -> None:
        self._request_patch(None)

    def _request_patch(self, request: tuple[str, ...] | None) -> None:
        with self._lock:
            loaded = self._recorder is not None
            if not loaded:
                self._patch_requests.append(request)
        if loaded:
            _apply_patch(request)


def _apply_patch(request: tuple[str, ...] | None) -> None:
    """Apply one recorded patch request with the real SDK (imported by then)."""
    from aws_xray_sdk.core import patch, patch_all

    if request is None:
        patch_all()
    else:
        patch(request)


# One provider per process: Powertools caches the provider on the Tracer class, so
# every Tracer() built after the first shares it.
deferred_xray_provider = DeferredXRayProvider()
