"""
One `invocation_cost` log line per Lambda invocation: the CPU the invocation used.

WHY. The sizing policy (docs/lambda-sizing.md) caps every function at 70 % of its
CPU share, and Lambda's REPORT line carries memory and duration but no CPU. X-Ray
is off and Lambda Insights is not installed, so this line is the only CPU signal.
Every Python Lambda in the app emits it (API handlers through `shared.api.api_handler`,
batch consumers through `shared.batch.batch_lambda_handler`, agent steps through
`agents.runtime.step_lambda_handler`, everything else through
`@measure_invocation_cost`), and the TypeScript `voc-chat-stream` emits the same
fields (`lambda/stream/src/lib/invocation-cost.ts`), so one Logs Insights query
covers the whole app (`voc-datalake/scripts/capacity/capacity-query.sh`).

FIELDS (numbers only — never the event, a payload, or anything a user typed):
    cpu_ms                  CPU time of the whole process during the invocation
    wall_ms                 wall time of the invocation
    cpu_pct_of_allocation   cpu_ms / (wall_ms x vCPU share) x 100; absent when the
                            memory size is unknown
    function_memory_size    the configured MB the share was computed from, so a query
                            can separate the lines before and after a resize

`process_time` covers every thread of the process, so work fanned out on a thread
pool (the SQS processor's concurrent records, a request's parallel reads) counts.
A Lambda execution environment runs one invocation at a time, so nothing else's CPU
is in the figure.
"""

from __future__ import annotations

import functools
import time
from collections.abc import Callable
from typing import Any

from shared.logging import logger, metrics, tracer

#: The message of the line; Logs Insights filters on `message = "invocation_cost"`.
COST_LINE = 'invocation_cost'

#: Lambda allocates CPU in proportion to memory: one full vCPU at 1,769 MB.
MB_PER_VCPU = 1769

#: Set on every wrapper so a static or runtime check can prove a handler is measured.
MEASURED_ATTR = '__measures_invocation_cost__'


def memory_mb(context: Any) -> int | None:
    """The function's configured memory in MB (the context reports it as a string), or None."""
    raw = str(getattr(context, 'memory_limit_in_mb', 0))
    value = int(raw) if raw.isdigit() else 0
    return value or None


def invocation_cost_fields(memory: int | None, cpu_ms: float, wall_ms: float) -> dict[str, float]:
    """The line's fields for one invocation (pure, so the stdlib mirror can be pinned to it)."""
    fields = {'cpu_ms': round(cpu_ms, 1), 'wall_ms': round(wall_ms, 1)}
    if memory is not None:
        fields['function_memory_size'] = memory
        if wall_ms > 0:
            fields['cpu_pct_of_allocation'] = round(cpu_ms / (wall_ms * memory / MB_PER_VCPU) * 100, 1)
    return fields


def log_invocation_cost(context: Any, cpu_start: float, wall_start: float) -> None:
    """Emit the line for an invocation that started at (`cpu_start`, `wall_start`)."""
    cpu_ms = (time.process_time() - cpu_start) * 1000
    wall_ms = (time.perf_counter() - wall_start) * 1000
    logger.info(COST_LINE, extra=invocation_cost_fields(memory_mb(context), cpu_ms, wall_ms))


def measure_invocation_cost[H: Callable[..., Any]](func: H) -> H:
    """Decorate a `(event, context)` Lambda handler so every invocation logs its CPU use.

    Put it innermost — directly above the `def` — so the line is written inside
    the Powertools context (`inject_lambda_context` adds the request id and
    function name). The line is written even when the handler raises.
    """
    @functools.wraps(func)
    def wrapper(event: Any, context: Any) -> Any:
        cpu_start = time.process_time()
        wall_start = time.perf_counter()
        try:
            return func(event, context)
        finally:
            log_invocation_cost(context, cpu_start, wall_start)

    setattr(wrapper, MEASURED_ATTR, True)
    return wrapper  # type: ignore[return-value]


def instrumented_handler(func: Callable[[Any, Any], Any]) -> Callable[[Any, Any], Any]:
    """The whole entry-point stack for a handler on the shared Powertools instances.

    In order: `logger.inject_lambda_context` (request context on every line),
    `tracer.capture_lambda_handler`, `metrics.log_metrics` with the cold-start metric,
    then `measure_invocation_cost` innermost — the same stack as `shared.api.api_handler`
    (which composes it on its own module globals, so its tests can patch them). Worker
    and job handlers that log through `shared.logging` use this instead of repeating
    the four decorators.
    """
    return logger.inject_lambda_context(
        tracer.capture_lambda_handler(
            metrics.log_metrics(capture_cold_start_metric=True)(measure_invocation_cost(func))))
