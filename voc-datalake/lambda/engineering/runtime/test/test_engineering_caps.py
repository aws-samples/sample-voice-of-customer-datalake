"""No fixed task cap: the supervisor's clocks, and the liveness verdicts they give."""
from dataclasses import replace
from decimal import Decimal

import pytest

from engineering.runtime import caps
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.liveness import PAUSED_EXIT_CODE, ended, judge
from engineering.runtime.ports import Lease
from engineering.runtime.sessions import AgentSession
from shared.model_config import ALLOWED_MODEL_IDS

T = caps.Timings()
SESSION = AgentSession(run_id='01JD3R4NZXQ7Y2W8K4M6P9T0AB', agent_id='fixer-1', role='fixer', task_id='task-1', language='python',
                       egress=(), connection='repo-1', commit='a' * 40, paths=(), harness=('true',), vm_id='vm',
                       endpoint='https://vm.example.org', started_at=0, status='working', exec_id='e1')


def _lease(renewed: int, progress: int) -> Lease:
    return Lease(task_id='task-1', agent_id='fixer-1', renewed_at=renewed, last_progress_at=progress)


def test_the_defaults_are_ten_minutes_of_quiet_and_a_pause_at_seven_and_a_half_hours():
    timings = caps.timings()
    assert (timings.stall_after, timings.pause_after) == (600, 27000)
    assert timings.hard_stop == 8 * 3600 - 600


def test_a_run_may_set_its_own_clocks_within_their_bounds():
    assert caps.timings({'stall_after': 300, 'pause_after': 4 * 3600}) == replace(T, stall_after=300,
                                                                                   pause_after=4 * 3600)


@pytest.mark.parametrize('raw', [{'stall_after': 60}, {'stall_after': 7200}, {'pause_after': 7 * 3600 + 41 * 60},
                                 {'pause_after': 1800}, {'stall_after': '600'}, {'stall_after': True}],
                         ids=['stall-short', 'stall-long', 'pause-late', 'pause-early', 'string', 'bool'])
def test_clocks_outside_their_bounds_are_refused_never_clamped(raw):
    with pytest.raises(RuntimeRefused):
        caps.timings(raw)


def test_a_clock_that_cannot_be_set_is_refused():
    with pytest.raises(RuntimeRefused, match="unknown timing 'hard_stop'"):
        caps.timings({'hard_stop': 9 * 3600})


@pytest.mark.parametrize(('exit_code', 'timed_out', 'outcome'), [
    (0, False, 'done'), (PAUSED_EXIT_CODE, False, 'paused'), (1, False, 'crashed'), (0, True, 'crashed'),
], ids=['done', 'paused', 'failed', 'timed-out'])
def test_how_a_harness_ended_comes_from_its_exit_code(exit_code, timed_out, outcome):
    assert ended(exit_code, timed_out) == outcome


@pytest.mark.parametrize(('session', 'lease', 'now', 'verdict'), [
    (SESSION, _lease(100, 100), 120, 'ok'),
    (SESSION, None, 120, 'crashed'),
    (SESSION, _lease(100, 100), 100 + T.lease_ttl + 1, 'crashed'),
    (SESSION, _lease(T.hard_stop, T.hard_stop), T.hard_stop, 'crashed'),
    (SESSION, _lease(T.pause_after, T.pause_after), T.pause_after, 'pause'),
    (replace(SESSION, status='pause_requested'), _lease(T.pause_after, T.pause_after), T.pause_after, 'ok'),
    (SESSION, _lease(T.stall_after, 0), T.stall_after, 'ask_state'),
    (replace(SESSION, asked_at=700), _lease(800, 750), 800, 'clear_ask'),
    (replace(SESSION, asked_at=700), _lease(800, 0), 700 + T.answer_window - 1, 'ok'),
    (replace(SESSION, asked_at=700), _lease(880, 0), 700 + T.answer_window, 'stalled'),
    (SESSION, replace(_lease(0, 0), waiting=True), 5000, 'ok'),
    (SESSION, replace(_lease(0, 0), waiting=True), T.stall_after + T.lease_ttl + T.answer_window, 'ok'),
    (SESSION, replace(_lease(0, 0), waiting=True), T.hard_stop, 'crashed'),
], ids=['quiet-but-fine', 'no-lease', 'lease-lapsed', 'hard-stop', 'pause', 'already-pausing', 'ask', 'answered',
        'waiting-for-answer', 'no-answer', 'open-wait', 'open-wait-past-the-activity-clocks',
        'open-wait-at-the-hard-stop'])
def test_judge(session, lease, now, verdict):
    assert judge(session, lease, now, T) == verdict


# ── model tokens, priced per model (7.50.00) ─────────────────────────────────────────────────────────────────────
SONNET, HAIKU, OPUS = ('global.anthropic.claude-sonnet-5-5', 'global.anthropic.claude-haiku-5-5',
                       'global.anthropic.claude-opus-5-5')


def test_each_allowlisted_model_has_its_list_price():
    prices = caps.model_prices(None)
    assert {SONNET, HAIKU, OPUS} <= set(ALLOWED_MODEL_IDS)
    assert prices.of(SONNET) == caps.TokenPrice(Decimal('2.00'), Decimal('10.00'), Decimal('0.10'), Decimal('2.50'))
    assert prices.of(HAIKU).output == Decimal('0.50')
    assert prices.of(OPUS).input == Decimal('4.00')
    assert caps.model_prices('') == caps.model_prices('{}') == prices == caps.TokenPrices()


def test_tokens_cost_their_models_price_per_million_rounded_up_never_below_what_was_used():
    prices = caps.TokenPrices()
    assert caps.token_usd(prices, SONNET, 1_000_000, 100_000) == Decimal('3.000000000000')
    assert caps.token_usd(prices, HAIKU, 1, 0) == Decimal('0.000000100000')
    # One token of a model priced at a fraction of a cent rounds up at the 12th digit, never to 0.
    tiny = caps.TokenPrices({'m': caps.TokenPrice(Decimal('0.000001'), Decimal(0))})
    assert caps.token_usd(tiny, 'm', 1, 0) == Decimal('1E-12')
    assert str(caps.token_usd(prices, SONNET, 0, 0)) == '0'
    with pytest.raises(ValueError, match='below zero'):
        caps.token_usd(prices, SONNET, -1, 0)


def test_a_model_without_a_price_is_priced_at_the_dearest_listed_an_upper_bound():
    prices = caps.TokenPrices()
    # (a harness's model by another name, a new id): Opus's input and output, the dearest parts listed.
    assert prices.of('anthropic.claude-new') == prices.of(OPUS) == prices.dearest()
    assert caps.token_usd(prices, 'microvm-reported', 1_000_000, 1_000_000) == Decimal('24.000000000000')
    mixed = caps.TokenPrices({'a': caps.TokenPrice(Decimal(5), Decimal(1)),
                              'b': caps.TokenPrice(Decimal(1), Decimal(9))})
    assert mixed.dearest() == caps.TokenPrice(Decimal(5), Decimal(9))
    # With no price at all, tokens are counted and never priced.
    assert caps.token_usd(caps.NO_TOKEN_PRICES, SONNET, 10**9, 10**9) == 0


def test_a_deployment_overrides_a_models_price_and_adds_one():
    prices = caps.model_prices('{"global.anthropic.claude-sonnet-5-5": {"input": "3", "output": 15}, '
                               '"us.example.model-1": {"input": "0.5", "output": "1.25", "cacheRead": "0.05"}}')
    assert prices.of(SONNET) == caps.TokenPrice(Decimal(3), Decimal(15))
    assert prices.of('us.example.model-1') == caps.TokenPrice(Decimal('0.5'), Decimal('1.25'), Decimal('0.05'))
    assert prices.of(HAIKU) == caps.DEFAULT_TOKEN_PRICES[HAIKU]   # (the others keep their defaults)


@pytest.mark.parametrize('raw', [
    'not json', '[]', '{"": {"input": 1, "output": 1}}', '{"m": 1}', '{"m": {"input": 1}}',
    '{"m": {"input": 1, "output": 1, "batch": 1}}', '{"m": {"input": -1, "output": 1}}',
    '{"m": {"input": "NaN", "output": 1}}', '{"m": {"input": 1001, "output": 1}}',
    '{"m": {"input": true, "output": 1}}', '{"m": {"input": "0.0000000000001", "output": 1}}',
    '{"m b": {"input": 1, "output": 1}}',
])
def test_a_price_list_off_its_shape_is_refused_never_half_read(raw):
    with pytest.raises(RuntimeRefused, match='ENGINEERING_MODEL_PRICES'):
        caps.model_prices(raw)
