"""Lambda SnapStart runtime hooks (docs/lambda-sizing.md, "Cold starts").

Four API Lambdas run with SnapStart (lib/utils/snapstart.ts): Lambda runs their
init once when a version is published, snapshots the memory, and restores new
execution environments from that snapshot. Two consequences for the code:

* **Priming.** Only work done BEFORE the snapshot is saved. A handler whose
  boto3 client or DynamoDB ``Table`` is created lazily on the first request
  pays that cost (~150-300 ms: botocore scans its whole data directory per
  model type) after every restore. ``register_snapshot_hooks(warm, ...)`` runs
  those factories in a before-snapshot hook instead. They must make NO network
  call: a connection or a credential fetched at publish time would be stale in
  every restored environment.
* **Uniqueness.** Every environment restored from one snapshot starts with the
  same memory, so state seeded at init is shared. The audit for these handlers
  (docs/lambda-sizing.md) found no init-time ids, secrets, tokens or timestamps;
  ``uuid4``/``secrets``/``SystemRandom`` read the kernel CSPRNG, which Lambda
  reseeds on restore. The one shared-state library is the stdlib ``random``
  module's Mersenne Twister, seeded once at import — botocore's retry jitter
  draws from it, so restored environments would back off in lock-step. The
  after-restore hook reseeds it from ``os.urandom``.

The hooks come from ``snapshot_restore_py``, which the Python managed runtimes
ship. Where it is absent (local runs, tests) registration is a no-op, and in a
non-SnapStart environment the runtime never calls the hooks — so a handler can
call this unconditionally.
"""

from __future__ import annotations

import importlib
import random
from collections.abc import Callable
from typing import Any

from shared.logging import logger

SNAPSHOT_RESTORE_MODULE = 'snapshot_restore_py'

# The model files a client (service-2, endpoint-rule-set-1) and a boto3 resource
# (resources-1) parse when they are built.
BOTOCORE_MODEL_FILES = ('service-2', 'endpoint-rule-set-1', 'resources-1')


def _hooks_module() -> Any:
    """The runtime's ``snapshot_restore_py`` module, or None outside a Python managed runtime."""
    try:
        return importlib.import_module(SNAPSHOT_RESTORE_MODULE)
    except ImportError:
        return None


def prime(warmers: tuple[Callable[[], object], ...]) -> None:
    """Run each warmer; a failing one is logged and skipped, never fatal.

    A raise here would fail the version publish (and so the deploy) over an
    optimisation; the warmer's work then simply happens on the first request,
    exactly as without SnapStart.
    """
    for warm in warmers:
        try:
            warm()
        except Exception:
            logger.exception('SnapStart priming step failed; it will run on first use instead',
                             extra={'warmer': getattr(warm, '__name__', repr(warm))})


def reseed_after_restore() -> None:
    """Give this restored environment its own ``random`` stream (see the module docstring)."""
    random.seed()


def botocore_model_warmer(*services: str) -> Callable[[], None]:
    """A warmer that parses the botocore model files of ``services`` before the snapshot.

    Building a client or a DynamoDB ``Table`` lazily costs ~250 ms of CPU locally,
    nearly all of it reading and parsing the service's JSON models (``service-2``,
    ``endpoint-rule-set-1``, ``resources-1``). This loads them into the default
    session's loader cache WITHOUT creating a client: no credential lookup, no
    endpoint, nothing that could go stale in a restored environment. The client is
    still built (and resolves its credentials) on first use after the restore,
    which then costs ~20 ms.
    """
    def prime_botocore_models() -> None:
        import boto3
        from botocore.exceptions import DataNotFoundError

        # Private, but the cache every client and resource of this session reads; a
        # change surfaces as a logged priming failure (see `prime`), never a crash.
        loader = boto3._get_default_session()._loader
        for service in services:
            for model in BOTOCORE_MODEL_FILES:
                try:
                    loader.load_service_model(service, model)
                except DataNotFoundError:  # e.g. `lambda` has no resources-1
                    continue

    return prime_botocore_models


def api_route_warmer(app: Any) -> Callable[[], None]:
    """A warmer that builds every route's request model before the snapshot (3.00.00 capacity).

    Powertools' resolver (``enable_validation=True``) builds a route's OpenAPI
    ``dependant`` — the pydantic models that validate its parameters and body — the
    first time that route is resolved, and caches it on the route. Without SnapStart
    that cost is paid once per execution environment; with it, it was paid again on
    the first call after EVERY restore, because the snapshot was taken before any
    request. Building them here is pure computation over the route signatures: no
    I/O, no credentials, nothing per-request, so the snapshot may hold it.
    """
    def prime_api_routes() -> None:
        # Private lists of the resolver (Powertools 3.x); a rename degrades to "no priming".
        for route in [*getattr(app, '_static_routes', []), *getattr(app, '_dynamic_routes', [])]:
            _ = route.dependant  # computed and cached on first access

    return prime_api_routes


def register_snapshot_hooks(*warmers: Callable[[], object]) -> bool:
    """Register before-snapshot priming of ``warmers`` and the after-restore reseed.

    Returns whether the hooks were registered (False outside a managed runtime).
    """
    hooks = _hooks_module()
    if hooks is None:
        return False
    hooks.register_before_snapshot(prime, warmers)
    hooks.register_after_restore(reseed_after_restore)
    return True
