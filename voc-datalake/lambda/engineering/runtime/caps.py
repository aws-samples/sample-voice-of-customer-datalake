"""The supervisor's timings: no fixed task cap, activity decides (docs/autonomous-engineering.md → Runtime).

An agent runs as long as its task needs and it makes progress. These are the only clocks:

- ``stall_after``: no progress event for this long (10 minutes by default, 2 to 60 configurable) and the
  supervisor asks the agent for its state; no answer within ``answer_window`` and it is stopped and its
  task re-posted from its checkpoint.
- ``lease_ttl``: a task's lease is renewed by the agent's heartbeat; one not renewed for this long is a
  crash (the session is ended and the agent continued from its last checkpoint).
- ``pause_after``: a session's 8-hour life (its AgentCore runtime's ``maxLifetime``) is handled by continuation: at
  7 h 30 by default (or earlier, when the agent announces a step longer than what is left) the agent is asked to
  pause; one that has not acknowledged by ``hard_stop`` (7 h 50) is treated as a crash, so no session reaches its
  limit.
- ``max_crash_continuations``: a crash (a running agent's new session that will not start among them) is continued
  this many times in a row; then the task goes back to the board (or, for the conductor, the run to a person).
- ``wake_grace``: a session woken for a message (``delivery.py``) is not held again for an open wait for
  this long, so its harness reads its inbox and closes the wait first.

Model tokens and cost stay hard caps set by a person, per run; they are read from the run, never here. What a
session costs is counted here (``SessionPricing``): each session's vCPU and memory at the deployment's AgentCore
rates.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from typing import Any, Final

from engineering.runtime.interface import SESSION_LIFE_SECONDS, RuntimeRefused

MINUTE: Final = 60
#: The idle timeout of every agent runtime (``idleRuntimeSessionTimeout``, lib/stacks/engineering-agentcore.ts): a
#: session with no invocation and a runner that says it is not busy for this long is ended by the service. An agent
#: waiting on the model is busy (its harness runs), so only a held one (an open wait) is ever idle, and the supervisor
#: holds such a wait without a session before then (``wait_suspend_limit``).
IDLE_TIMEOUT_SECONDS: Final = 60 * MINUTE
DEFAULT_STALL_SECONDS: Final = 10 * MINUTE
#: The latest a pause may be asked for: room to finish a step and checkpoint before ``hard_stop``.
MAX_PAUSE_AFTER_SECONDS: Final = 7 * 60 * MINUTE + 40 * MINUTE
HARD_STOP_SECONDS: Final = SESSION_LIFE_SECONDS - 10 * MINUTE


@dataclass(frozen=True)
class Timings:
    stall_after: int = DEFAULT_STALL_SECONDS
    answer_window: int = 3 * MINUTE
    lease_ttl: int = 3 * MINUTE
    pause_after: int = 7 * 60 * MINUTE + 30 * MINUTE
    hard_stop: int = HARD_STOP_SECONDS
    max_crash_continuations: int = 2
    #: A session held for an open wait longer than this is checkpointed and held without a session
    #: (the runtime's idle timeout, ``IDLE_TIMEOUT_SECONDS``, would end a held one at 60 minutes).
    wait_suspend_limit: int = 45 * MINUTE
    #: A checkout and harness start that take longer than this are a crash.
    boot_deadline: int = 30 * MINUTE
    #: Session calls failing this many ticks in a row are a crash (the session is gone or never came up).
    max_runtime_failures: int = 3
    #: A session woken for a message stays awake this long on an open wait (its harness reads the message).
    wake_grace: int = 10 * MINUTE
    #: Continuations in a row the service has no room for before the agent goes to a person (one per tick).
    max_no_room: int = 30

    def __post_init__(self) -> None:
        # No agent outlives its session without a continuation: the pause and the hard stop come before its 8 hours,
        # and a held wait is checkpointed before the idle timeout ends it.
        if not self.pause_after < self.hard_stop < SESSION_LIFE_SECONDS:
            raise RuntimeRefused(f'an agent pauses before its hard stop, and stops before its session\'s '
                                 f'{SESSION_LIFE_SECONDS // 3600} hours: continuation needs both')
        if self.wait_suspend_limit >= IDLE_TIMEOUT_SECONDS:
            raise RuntimeRefused('a held wait is checkpointed before the runtime\'s idle timeout ends its session')


#: The clocks a deployment may set (``ENGINEERING_TIMINGS``), each with its bounds in seconds.
SETTABLE: Final[dict[str, tuple[int, int]]] = {
    'stall_after': (2 * MINUTE, 60 * MINUTE),
    'pause_after': (60 * MINUTE, MAX_PAUSE_AFTER_SECONDS),
}


#: The highest rate a deployment may set, in USD per vCPU-hour or GB-hour (a typo of a few orders of magnitude fails).
MAX_USD_PER_HOUR: Final = Decimal('10')
#: At most this many digits after the point (synth checks the same), so every sum stays exact.
PRICE_DIGITS: Final = 12
USD_STEP: Final = Decimal(1).scaleb(-PRICE_DIGITS)
HOUR: Final = 60 * MINUTE
#: AgentCore Runtime's rates, platform version V2 (checked 2026-11-13 in us-east-1 and us-west-2, USD): consumption
#: per vCPU-hour and GB-hour (billed per second for the CPU actually used and the memory), and the committed baseline
#: a resource configuration reserves (billed while its session lives). The defaults of ``-c engineeringSessionRates``.
DEFAULT_RATES: Final = {'vcpuHour': '0.1276', 'gbHour': '0.0169', 'baselineVcpuHour': '0.0997',
                        'baselineGbHour': '0.0132'}


@dataclass(frozen=True)
class SessionRates:
    """The deployment's AgentCore rates (``ENGINEERING_SESSION_RATES``), in USD per hour."""

    vcpu_hour: Decimal = Decimal(DEFAULT_RATES['vcpuHour'])
    gb_hour: Decimal = Decimal(DEFAULT_RATES['gbHour'])
    baseline_vcpu_hour: Decimal = Decimal(DEFAULT_RATES['baselineVcpuHour'])
    baseline_gb_hour: Decimal = Decimal(DEFAULT_RATES['baselineGbHour'])


#: No rate at all: session time is counted and never priced (the tests' default; a deployment sets every rate to 0).
UNPRICED: Final = SessionRates(Decimal(0), Decimal(0), Decimal(0), Decimal(0))


@dataclass(frozen=True)
class SessionSize:
    """What one session is counted as using while it lives: an upper bound of what AgentCore bills for it.

    ``vcpus`` and ``gb`` at the consumption rates (every vCPU counted as busy while the agent runs, none while it is
    held; the memory while the session lives), and a resource configuration's committed ``baseline_*`` at the
    baseline rates for the session's whole life. The bill is lower: it counts only the CPU actually used.
    """

    vcpus: int
    gb: int
    baseline_vcpus: int = 0
    baseline_gb: int = 0

    @property
    def total_gb(self) -> int:
        return self.gb + self.baseline_gb


#: Every agent's session by default: AgentCore's default consumption size, 2 vCPU and 8 GB (the owner's floor).
STANDARD_SIZE: Final = SessionSize(vcpus=2, gb=8)
#: The resource configurations a deployment may give the agents that build and test the repository
#: (``-c engineeringBuildMemoryMiB``): 8192 MiB commits a baseline of 2 vCPU and 8 GB and bursts to 8 vCPU and 32 GB
#: (with a 32 GB disk), the burst above the baseline counted at the consumption rates. 4096 (a 1 vCPU and 4 GB
#: baseline) is below the 2 vCPU and 8 GB floor, so it is not offered.
BUILD_SIZES: Final = {8192: SessionSize(vcpus=6, gb=24, baseline_vcpus=2, baseline_gb=8)}


@dataclass(frozen=True)
class SessionCost:
    """What a stretch of a session's life is counted as: its dollars and its vCPU- and GB-seconds."""

    usd: Decimal = Decimal(0)
    vcpu_seconds: int = 0
    gb_seconds: int = 0


@dataclass(frozen=True)
class SessionPricing:
    """Each session's vCPU and memory at the deployment's rates: the size of its role (``build_roles`` get the
    ``build_size`` when the deployment gives them one, every other role ``STANDARD_SIZE``)."""

    rates: SessionRates = field(default_factory=SessionRates)
    build_roles: frozenset[str] = frozenset()
    build_size: SessionSize | None = None

    def size(self, role: str) -> SessionSize:
        return self.build_size if self.build_size is not None and role in self.build_roles else STANDARD_SIZE

    def cost(self, role: str, *, running: int, held: int) -> SessionCost:
        """``running`` seconds of the agent running and ``held`` seconds of it held (an open wait) in one session.

        Running: every vCPU and the memory; held: the memory and the committed baseline only (a held agent uses no
        CPU). Dollars only when the deployment prices sessions (all rates 0: time is still counted, unpriced)."""
        size = self.size(role)
        lived = running + held
        rates = self.rates
        usd = (Decimal(running * size.vcpus) * rates.vcpu_hour + Decimal(lived * size.gb) * rates.gb_hour
               + Decimal(lived * size.baseline_vcpus) * rates.baseline_vcpu_hour
               + Decimal(lived * size.baseline_gb) * rates.baseline_gb_hour) / HOUR
        # Rounded up to the 12th digit: a sum DynamoDB stores exactly, never below what was used (and a plain 0, never
        # 0E-12, which DynamoDB's number format refuses).
        rounded = usd.quantize(USD_STEP, rounding=ROUND_CEILING)
        return SessionCost(usd=rounded or Decimal(0), vcpu_seconds=running * size.vcpus + lived * size.baseline_vcpus,
                           gb_seconds=lived * size.total_gb)


def _rate(name: str, raw: object) -> Decimal:
    if isinstance(raw, bool) or not isinstance(raw, str | int | float):
        raise RuntimeRefused(f'ENGINEERING_SESSION_RATES.{name} is a decimal amount of USD per hour')
    try:
        rate = Decimal(str(raw).strip())
    except InvalidOperation as error:
        raise RuntimeRefused(f'ENGINEERING_SESSION_RATES.{name} is a decimal amount of USD per hour') from error
    exponent = rate.as_tuple().exponent
    if (not rate.is_finite() or not isinstance(exponent, int) or exponent < -PRICE_DIGITS
            or not Decimal(0) <= rate <= MAX_USD_PER_HOUR):
        raise RuntimeRefused(f'ENGINEERING_SESSION_RATES.{name} is 0-{MAX_USD_PER_HOUR} USD per hour, '
                             f'at most {PRICE_DIGITS} digits after the point')
    return rate


def session_rates(raw: str | None) -> SessionRates:
    """``ENGINEERING_SESSION_RATES``: a JSON object of the four rates (``DEFAULT_RATES``' names, USD per hour); unset:
    AgentCore's published rates. A rate of 0 leaves that part unpriced; an unknown or missing name is refused."""
    if raw is None or raw.strip() == '':
        return SessionRates()
    try:
        given = json.loads(raw)
    except ValueError as error:
        raise RuntimeRefused('ENGINEERING_SESSION_RATES is a JSON object of rates') from error
    if not isinstance(given, dict) or set(given) != set(DEFAULT_RATES):
        raise RuntimeRefused(f'ENGINEERING_SESSION_RATES names exactly {", ".join(sorted(DEFAULT_RATES))}')
    return SessionRates(vcpu_hour=_rate('vcpuHour', given['vcpuHour']), gb_hour=_rate('gbHour', given['gbHour']),
                        baseline_vcpu_hour=_rate('baselineVcpuHour', given['baselineVcpuHour']),
                        baseline_gb_hour=_rate('baselineGbHour', given['baselineGbHour']))


def build_size(raw: str | None) -> SessionSize | None:
    """``ENGINEERING_BUILD_MEMORY_MIB``: the resource configuration of the agents that build and test (``0`` or unset:
    none, they run at the standard size), one of ``BUILD_SIZES``."""
    text = (raw or '0').strip()
    if text == '0':
        return None
    if not text.isdigit() or int(text) not in BUILD_SIZES:
        raise RuntimeRefused(f'ENGINEERING_BUILD_MEMORY_MIB is 0 or one of {sorted(BUILD_SIZES)}')
    return BUILD_SIZES[int(text)]


#: The account's active AgentCore sessions in a region (the service's quota, us-east-1 and us-west-2): the default of
#: ``-c engineeringMaxSessions``, which a deployment lowers to keep room for other work in its account.
DEFAULT_MAX_SESSIONS: Final = 5000
#: The lowest it may be: one run the Agents API starts (its task cap, 100: api/agents_handler.py RUN_TASK_CAP, and
#: its coordinator) must fit, else every start would be refused.
MIN_MAX_SESSIONS: Final = 101


def max_sessions(raw: str | None) -> int:
    """``ENGINEERING_MAX_SESSIONS``: how many agent sessions this deployment runs at once, at most (101 to 5,000)."""
    text = (raw or str(DEFAULT_MAX_SESSIONS)).strip()
    if not text.isdigit() or not MIN_MAX_SESSIONS <= int(text) <= DEFAULT_MAX_SESSIONS:
        raise RuntimeRefused(f'ENGINEERING_MAX_SESSIONS is a whole number from {MIN_MAX_SESSIONS} to '
                             f'{DEFAULT_MAX_SESSIONS}')
    return int(text)


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
