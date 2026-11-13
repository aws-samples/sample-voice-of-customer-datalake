"""The supervisor's timings: no fixed task cap, activity decides (docs/autonomous-engineering.md → Runtime).

An agent runs as long as its task needs and it makes progress. These are the only clocks:

- ``stall_after``: no progress event for this long (10 minutes by default, 2 to 60 configurable) and the
  supervisor asks the agent for its state; no answer within ``answer_window`` and it is stopped and its
  task re-posted from its checkpoint.
- ``lease_ttl``: a task's lease is renewed by the agent's heartbeat; one not renewed for this long is a
  crash (the MicroVM is ended and the agent continued from its last checkpoint).
- ``pause_after``: a MicroVM's 8-hour life is handled by continuation: at 7 h 30 by default (or earlier,
  when the agent announces a step longer than what is left) the agent is asked to pause; one that has
  not acknowledged by ``hard_stop`` (7 h 50) is treated as a crash, so no MicroVM reaches its limit.
- ``max_crash_continuations``: a crash (a running agent's new MicroVM that will not start among them) is continued
  this many times in a row; then the task goes back to the board (or, for the conductor, the run to a person).
- ``wake_grace``: a MicroVM woken for a message (``delivery.py``) is not suspended again for an open wait for
  this long, so its harness reads its inbox and closes the wait first.

Model tokens and cost stay hard caps set by a person, per run; they are read from the run, never here.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Final

from engineering.runtime.interface import RuntimeRefused

MINUTE: Final = 60
MICROVM_LIFE_SECONDS: Final = 8 * 60 * MINUTE
DEFAULT_STALL_SECONDS: Final = 10 * MINUTE
#: The latest a pause may be asked for: room to finish a step and checkpoint before ``hard_stop``.
MAX_PAUSE_AFTER_SECONDS: Final = 7 * 60 * MINUTE + 40 * MINUTE
HARD_STOP_SECONDS: Final = MICROVM_LIFE_SECONDS - 10 * MINUTE


@dataclass(frozen=True)
class Timings:
    stall_after: int = DEFAULT_STALL_SECONDS
    answer_window: int = 3 * MINUTE
    lease_ttl: int = 3 * MINUTE
    pause_after: int = 7 * 60 * MINUTE + 30 * MINUTE
    hard_stop: int = HARD_STOP_SECONDS
    max_crash_continuations: int = 2
    #: A MicroVM suspended for an open wait longer than this is checkpointed and held without a MicroVM
    #: (the idle policy would end a suspended MicroVM at 60 minutes).
    wait_suspend_limit: int = 45 * MINUTE
    #: A checkout and harness start that take longer than this are a crash.
    boot_deadline: int = 30 * MINUTE
    #: MicroVM calls failing this many ticks in a row are a crash (the MicroVM is gone or never came up).
    max_runtime_failures: int = 3
    #: A MicroVM woken for a message stays awake this long on an open wait (its harness reads the message).
    wake_grace: int = 10 * MINUTE


#: The clocks a deployment may set (``ENGINEERING_TIMINGS``), each with its bounds in seconds.
SETTABLE: Final[dict[str, tuple[int, int]]] = {
    'stall_after': (2 * MINUTE, 60 * MINUTE),
    'pause_after': (60 * MINUTE, MAX_PAUSE_AFTER_SECONDS),
}


#: The highest price a deployment may set for a MicroVM second (a typo of a few orders of magnitude fails).
MAX_USD_PER_SECOND: Final = Decimal('0.01')
#: At most this many digits after the point (synth checks the same), so the product with a second count is exact.
PRICE_DIGITS: Final = 12


def microvm_price(raw: str | None) -> Decimal:
    """``ENGINEERING_MICROVM_USD_PER_SECOND``: the price of a MicroVM second, priced into each agent's ``cost_usd``
    (and so into the run's cost cap); unset or ``0``: MicroVM time is not priced."""
    if raw is None or raw.strip() == '':
        return Decimal(0)
    try:
        price = Decimal(raw.strip())
    except InvalidOperation as error:
        raise RuntimeRefused('ENGINEERING_MICROVM_USD_PER_SECOND is a decimal amount') from error
    exponent = price.as_tuple().exponent
    if (not price.is_finite() or not isinstance(exponent, int) or exponent < -PRICE_DIGITS
            or not Decimal(0) <= price <= MAX_USD_PER_SECOND):
        raise RuntimeRefused(f'ENGINEERING_MICROVM_USD_PER_SECOND is 0-{MAX_USD_PER_SECOND}, '
                             f'at most {PRICE_DIGITS} digits after the point')
    return price


def timings(raw: Mapping[str, Any] | None = None) -> Timings:
    """The defaults, with the settable clocks ``raw`` names, each within its bounds (never clamped)."""
    chosen = dict(raw or {})
    unknown = sorted(set(chosen) - SETTABLE.keys())
    if unknown:
        raise RuntimeRefused(f'unknown timing {unknown[0]!r}: only {", ".join(SETTABLE)} can be set')
    for key, (low, high) in SETTABLE.items():
        value = chosen.get(key, low)
        if type(value) is not int or not low <= value <= high:
            raise RuntimeRefused(f'{key} must be a whole number of seconds from {low} to {high}')
    return Timings(**chosen)
