"""
Time-budgeted app-review runs: a run that would not fit another app before the
Lambda timeout continues in a fresh invocation of its own function (a "part").

Why: one iOS app walks ~40 storefronts (90-110 s), so "Run all" over ten apps
passed the 15-minute timeout and the run row stayed ``running`` for good. Now,
before each app, the run compares the time it has left with a reserve (at least
``MIN_APP_RESERVE_SECONDS``, or 1.5x the slowest app of this part). When the
reserve no longer fits, it stops, sends what it collected, and invokes its own
function asynchronously with the apps still to do and the run's totals so far.
Every part processes at least one app, so a chain of N apps has at most N parts.

Sequential parts, not one invocation per app: the store APIs see the same request
rate as before, and only one part writes the ``SOURCE_RUN#`` row at a time, so
the row needs no cross-invocation aggregation. Each part writes the running total
(``items_found``), only the last writes ``completed`` (or ``error``) and the
run's warnings as ``errors``; the row's contract for the UI and the assistant is
unchanged. A manual run keeps its ``execution_id`` in every part (frequency and
watermark checks stay skipped); a scheduled run's parts carry none, so each app
still gets its due check. A single-app run never needs a second part.

The continuation event is produced only by this code and accepted only from the
function's own role (``lambda:InvokeFunction`` on its own ARN,
``lib/stacks/ingestion-stack.ts``); it is still validated (``Continuation``).
"""

import os
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from shared.aws import invoke_lambda_async
from shared.timestamps import now_iso

# The event key a continuation part carries its state under.
CONTINUATION_KEY = "continuation"
# Time kept free before starting another app: a slow iOS app takes ~110 s, and
# the part still has to flush its last SQS batch and write the run row.
MIN_APP_RESERVE_SECONDS = 240.0
# The reserve grows with the slowest app this part has seen.
SLOWEST_APP_FACTOR = 1.5
# Bounds of a continuation event (well above any real connector list).
MAX_CONTINUATION_APPS = 500
MAX_WARNING_CHARS = 300


class InvalidContinuationError(ValueError):
    """A ``continuation`` event that is not the shape this module writes."""


class _NamedApp(Protocol):
    name: str


class _AppRef(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    app_id: str = Field(min_length=1, max_length=200)
    name: str = Field(max_length=200)


class Continuation(BaseModel):
    """What a part hands to the next one."""

    model_config = ConfigDict(extra="forbid", strict=True)
    apps: list[_AppRef] = Field(min_length=1, max_length=MAX_CONTINUATION_APPS)
    items_found: int = Field(ge=0)
    warnings: list[str] = Field(default_factory=list, max_length=100)
    part: int = Field(ge=2)


@dataclass(frozen=True)
class Carried:
    """The totals of a run's earlier parts (empty for a run's first part)."""

    items_found: int = 0
    warnings: tuple[str, ...] = ()
    part: int = 1
    # (app_id, name) of each app still to do, in order.
    apps: tuple[tuple[str, str], ...] = ()

    @property
    def is_continuation(self) -> bool:
        return self.part > 1


def parse_continuation(event: object) -> Carried:
    """The carried totals of *event* (``Carried()`` when it starts a run).

    Raises ``InvalidContinuationError`` for a malformed ``continuation``: running
    every app instead would silently repeat the parts already done.
    """
    if not isinstance(event, dict) or CONTINUATION_KEY not in event:
        return Carried()
    try:
        state = Continuation.model_validate(event[CONTINUATION_KEY])
    except ValidationError as error:
        raise InvalidContinuationError(f"{error.error_count()} invalid field(s)") from error
    return Carried(
        items_found=state.items_found,
        warnings=tuple(text[:MAX_WARNING_CHARS] for text in state.warnings),
        part=state.part,
        apps=tuple((ref.app_id, ref.name) for ref in state.apps),
    )


def configs_for_event[AppT: _NamedApp](
    event: object, carried: Carried, configs: Sequence[AppT], identifier_of: Callable[[AppT], str]
) -> list[AppT]:
    """The configs this invocation runs: a continuation part's carried apps (in
    order; a connector removed or renamed since the run started is dropped), else
    the one app ``event['app_id']`` names, else every config."""
    if carried.is_continuation:
        by_key = {(identifier_of(config), config.name): config for config in configs}
        return [by_key[key] for key in carried.apps if key in by_key]
    app_id = event.get("app_id") if isinstance(event, dict) else None
    if app_id:
        return [config for config in configs if identifier_of(config) == app_id]
    return list(configs)


def hand_off_failure_updates(
    items_found: int, warnings: Sequence[str], apps_left: int, error: Exception
) -> dict:
    """The run row of a run whose next part could not be started."""
    return {
        "status": "error",
        "items_found": items_found,
        "completed_at": now_iso(),
        "errors": [
            *warnings,
            f"{apps_left} apps not run: the next part could not start ({type(error).__name__})",
        ],
    }


def continuation_event(
    *, execution_id: str | None, apps: Sequence[tuple[str, str]], items_found: int,
    warnings: Sequence[str], part: int,
) -> dict:
    """The async event that starts *part* of a run with *apps* still to do."""
    event: dict = {
        CONTINUATION_KEY: {
            "apps": [{"app_id": app_id, "name": name} for app_id, name in apps],
            "items_found": items_found,
            "warnings": [text[:MAX_WARNING_CHARS] for text in warnings],
            "part": part,
        }
    }
    if execution_id:
        event["execution_id"] = execution_id
    return event


def start_next_part(event: dict) -> None:
    """Invoke this function (``AWS_LAMBDA_FUNCTION_NAME``) asynchronously with *event*."""
    function_name = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "")
    if not function_name:
        raise RuntimeError("AWS_LAMBDA_FUNCTION_NAME is not set")
    response = invoke_lambda_async(function_name, event)
    status = response.get("StatusCode")
    if status != 202:
        raise RuntimeError(f"async invoke answered {status}")


class RunBudget:
    """Decides, before each app, whether this part still has time for one more."""

    def __init__(
        self,
        remaining_ms: Callable[[], int] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._remaining_ms = remaining_ms
        self._clock = clock
        self.apps_started = 0
        self.slowest_app_seconds = 0.0

    @classmethod
    def for_context(cls, context: object) -> "RunBudget":
        """A budget on the Lambda context's remaining time (none without a context)."""
        remaining = getattr(context, "get_remaining_time_in_millis", None)
        if not callable(remaining):
            return cls(None)

        def remaining_ms() -> int:
            value = remaining()
            # A non-number reads as "out of time": hand off rather than risk the timeout.
            return value if isinstance(value, int) else 0

        return cls(remaining_ms)

    def reserve_seconds(self) -> float:
        return max(MIN_APP_RESERVE_SECONDS, self.slowest_app_seconds * SLOWEST_APP_FACTOR)

    def must_hand_off(self) -> bool:
        """True when another app would not fit; never before this part's first app."""
        if self._remaining_ms is None or self.apps_started == 0:
            return False
        return self._remaining_ms() / 1000 < self.reserve_seconds()

    @contextmanager
    def timing_app(self) -> Iterator[None]:
        """Time one app (its collection plus the run's handling of what it yields)."""
        self.apps_started += 1
        started = self._clock()
        try:
            yield
        finally:
            self.slowest_app_seconds = max(self.slowest_app_seconds, self._clock() - started)


def run_row_updates(updates: dict, carried: Carried, warnings: Sequence[str], cap: int) -> dict:
    """*updates* of this part as the run row needs them: totals include the
    earlier parts, a later part keeps the first part's ``started_at``, a
    completed run carries every part's warnings as ``errors`` and an error keeps
    the earlier parts' warnings in front of its own."""
    out = dict(updates)
    status = out.get("status")
    if "items_found" in out:
        out["items_found"] = carried.items_found + int(out["items_found"])
    if carried.is_continuation:
        out.pop("started_at", None)
    if status == "completed" and warnings and "errors" not in out:
        out["errors"] = list(warnings)[:cap]
    elif status == "error" and carried.warnings:
        # Newest last: when over the cap, this part's own error type is what is kept.
        out["errors"] = [*carried.warnings, *out.get("errors", [])][-cap:]
    return out
