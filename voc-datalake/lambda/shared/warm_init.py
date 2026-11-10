"""Build a Lambda's AWS clients and DynamoDB tables during INIT, not on its first request.

WHY. Clients are created lazily (``shared.aws`` getters, ``shared.tables``) so tests and
local tools can import any module without AWS. In a Lambda that moved the most expensive
CPU of an execution environment's life onto its FIRST request: ``boto3.resource('dynamodb')``
walks botocore's whole data directory (``Loader.list_available_services``, thousands of
``stat`` calls) and parses the service and endpoint-rule models. Production measured it
(docs/lambda-sizing.md, "Cold starts"): the agents API's first request used 133 ms of CPU
against 8 ms warm; the heartbeat, memory scanner and briefing workers, which start cold on
every schedule tick, spent ~85 % of each run there. Sized by that CPU, functions were raised
to sizes a single-threaded Python process cannot use.

``warm_at_init(*factories)``, called at module level by a handler, runs the factories while
Lambda initialises the environment, so the request does only its own work.

WHEN IT RUNS. Only during a Lambda on-demand or provisioned-concurrency init
(``AWS_LAMBDA_INITIALIZATION_TYPE``). Never:

* in tests and local tools (the variable is unset), so imports stay AWS-free;
* under SnapStart (``snap-start``): a client built before the snapshot would carry the
  publish-time credentials into every restored environment. SnapStart handlers use
  ``shared.snapstart.register_snapshot_hooks`` with ``botocore_model_warmer`` instead,
  which parses the same models without building a client.

A factory must make NO network call (it builds clients and ``Table`` objects only). A
failing factory is logged and skipped: its work then happens on first use, as before.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Final

from shared.logging import logger

#: Set by Lambda for the init phase (docs: "Defined runtime environment variables").
INIT_TYPE_ENV: Final = 'AWS_LAMBDA_INITIALIZATION_TYPE'
#: The init types whose environment keeps what init built (SnapStart's does not; see the module docstring).
WARM_INIT_TYPES: Final = frozenset({'on-demand', 'provisioned-concurrency'})


def warming_enabled() -> bool:
    """True during a Lambda on-demand / provisioned-concurrency init (never in tests or under SnapStart)."""
    return os.environ.get(INIT_TYPE_ENV) in WARM_INIT_TYPES


def warm_at_init(*factories: Callable[[], object]) -> int:
    """Run each factory now when this is a Lambda init; the number that ran without error."""
    if not warming_enabled():
        return 0
    warmed = 0
    for factory in factories:
        try:
            factory()
        except Exception:
            logger.exception('Init warm-up step failed; it runs on first use instead',
                             extra={'warmer': getattr(factory, '__name__', repr(factory))})
        else:
            warmed += 1
    return warmed
