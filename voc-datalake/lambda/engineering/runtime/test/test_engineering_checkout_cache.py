"""The runtime's side of the checkout cache (checkout_cache.py): the generation found, the fill, the launch refused."""
import contextlib
import io
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError

from engineering.connectors.cache_layout import FSCK_REJECTED, GENERATION_SECONDS, NO_COMMIT, claim_key, ready_key
from engineering.runtime import handler
from engineering.runtime.checkout_cache import BUSY_WAIT_SECONDS, FILLING, NOT_READY, CheckoutCache
from engineering.runtime.handler import (
    CACHE_FAILING_LIMIT_SECONDS,
    CACHE_FAILURE_RESET_SECONDS,
    CACHE_FAILURE_WINDOW_SECONDS,
    MAX_TRANSIENT_FILLS,
)
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.runs import meta_key
from engineering.runtime.supervisor import SessionBusy
from engineering.runtime.test.conftest import BUCKET, COMMIT, TABLE

#: voc-engineering-runtime's real cache, as its handler builds it (the wired fixture puts one in place that is
#: always ready).
WIRED_CACHE = handler._checkout_cache
OTHER_RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0CD'
CONNECTION = 'conn-1'
REPOSITORY = 'example-org/example'
DAY = 86_400
#: Three days into generation GEN.
GEN = 1488
NOW = GEN * GENERATION_SECONDS + 3 * DAY
#: The wired fixture's run (example/app); the launch is of one of its agents.
LAUNCH = {'action': 'launch', 'run_id': '01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'agent_id': 'fixer-1', 'role': 'fixer',
          'task_id': 'task-1', 'language': 'python', 'connection': CONNECTION, 'commit': COMMIT, 'paths': ['src']}
COORDINATED = {'action': 'start_run', 'run_id': OTHER_RUN, 'max_tasks': 5, 'goal': 'fix the parser',
               'connection': CONNECTION, 'commit': COMMIT, 'language': 'python', 'repo': REPOSITORY}
RESUME = {'action': 'signal', 'run_id': OTHER_RUN, 'signal': 'resume', 'actor': 'admin-1'}


def _ready(s3: Any, generation: int = GEN, repository: str = REPOSITORY, written: float = NOW) -> None:
    """READY of ``generation``, its manifest naming ``repository`` and written at ``written``."""
    stamp = datetime.fromtimestamp(written, UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
    s3.put_object(Bucket=BUCKET, Key=ready_key(CONNECTION, COMMIT, generation),
                  Body=json.dumps({'format': 2, 'repository': repository, 'written_at': stamp}).encode())


@dataclass
class FakeLambda:
    """The cache function as the runtime invokes it: each call recorded, its answer canned (an error type, or not)."""

    answer: dict[str, Any] = field(default_factory=lambda: {'status': 'filled'})
    error: bool = False
    #: The bucket the fill writes READY to (the real function's effect), when given.
    s3: Any = None
    calls: list[dict[str, Any]] = field(default_factory=list)

    def invoke(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append({**kwargs, 'Payload': json.loads(kwargs['Payload'])})
        if self.s3 is not None and not self.error:
            _ready(self.s3, self.calls[-1]['Payload']['generation'])
        reply: dict[str, Any] = {'Payload': io.BytesIO(json.dumps(self.answer).encode())}
        return {**reply, 'FunctionError': 'Unhandled'} if self.error else reply


def _cache(s3: Any, function: FakeLambda | None = None, name: str = 'voc-engineering-cache', now: float = NOW,
           slept: list[float] | None = None) -> CheckoutCache:
    return CheckoutCache(s3=s3, bucket=BUCKET, lambda_client=function or FakeLambda(), function_name=name,
                         dynamodb=boto3.client('dynamodb', region_name='us-east-1'), table=TABLE,
                         clock=lambda: now, sleep=(slept if slept is not None else []).append)


def _found(s3: Any, now: float = NOW) -> tuple[str, int]:
    found = _cache(s3, now=now).look(CONNECTION, COMMIT, REPOSITORY)
    return found.state, found.generation


def test_no_ready_in_either_generation_is_the_current_one_to_fill(aws: Any) -> None:
    s3, _ = aws
    assert _found(s3) == ('missing', GEN)
    s3.put_object(Bucket=BUCKET, Key=f'engineering/cache/{CONNECTION}/{COMMIT}/g{GEN}/repo.git/HEAD', Body=b'ref')
    assert _found(s3) == ('missing', GEN)   # (files without READY: an entry still being written)


def test_the_current_generations_ready_is_used(aws: Any) -> None:
    s3, _ = aws
    _ready(s3, GEN, written=NOW - DAY)
    assert _found(s3) == ('ready', GEN)
    assert _cache(s3).look(CONNECTION, COMMIT, REPOSITORY).current == GEN


@pytest.mark.parametrize(('age_days', 'found'), [
    (17, ('ready', GEN - 1)), (27.9, ('ready', GEN - 1)), (28, ('missing', GEN)), (28.1, ('missing', GEN))],
    ids=['young', 'just-under-28-days', 'at-28-days', 'past-28-days'])
def test_the_previous_generations_ready_is_used_only_under_28_days(aws: Any, age_days: float,
                                                                   found: tuple[str, int]) -> None:
    s3, _ = aws
    _ready(s3, GEN - 1, written=NOW - age_days * DAY)
    assert _found(s3) == found


def test_across_the_boundary_the_new_generation_reads_the_old_one_until_it_is_filled(aws: Any) -> None:
    s3, _ = aws
    boundary = (GEN + 1) * GENERATION_SECONDS
    _ready(s3, GEN, written=boundary - DAY)
    assert (_found(s3, boundary - 1), _found(s3, boundary)) == (('ready', GEN), ('ready', GEN))
    _ready(s3, GEN + 1, written=boundary + 60)
    assert _found(s3, boundary + 120) == ('ready', GEN + 1)


def test_two_generations_back_is_never_read(aws: Any) -> None:
    s3, _ = aws
    _ready(s3, GEN - 2, written=NOW - 20 * DAY)
    assert _found(s3) == ('missing', GEN)


def test_an_entry_of_another_repository_launches_nothing_in_its_generation(aws: Any) -> None:
    s3, _ = aws
    _ready(s3, GEN, repository='example-org/elsewhere')
    assert _found(s3) == ('refused', GEN)
    assert 'is of example-org/elsewhere, not of the run\'s repository example-org/example' in \
        _cache(s3).look(CONNECTION, COMMIT, REPOSITORY).refusal


def test_a_usable_previous_entry_serves_when_the_current_one_is_of_another_repository(aws: Any) -> None:
    s3, _ = aws
    _ready(s3, GEN, repository='example-org/elsewhere')
    _ready(s3, GEN - 1, written=NOW - DAY)
    assert _found(s3) == ('ready', GEN - 1)
    assert not _cache(s3).look(CONNECTION, COMMIT, REPOSITORY).fill_ahead   # (N's READY can never be replaced)


def test_a_previous_entry_of_another_repository_is_ignored_and_the_current_one_filled(aws: Any) -> None:
    s3, _ = aws
    _ready(s3, GEN - 1, repository='example-org/elsewhere', written=NOW - DAY)
    assert _found(s3) == ('missing', GEN)


def test_a_commit_with_no_usable_entry_says_so_in_words_the_coordinator_reads(aws: Any) -> None:
    s3, _ = aws
    assert 'no usable checkout in the cache' in _cache(s3).look(CONNECTION, COMMIT, REPOSITORY).refusal


@pytest.mark.parametrize(('connection', 'commit'), [('Conn/1', COMMIT), (CONNECTION, 'main')])
def test_a_bad_connection_or_commit_is_a_refusal_never_a_read(aws: Any, connection: str, commit: str) -> None:
    s3, _ = aws
    with pytest.raises(RuntimeRefused):
        _cache(s3).look(connection, commit, REPOSITORY)


def test_a_fill_is_the_cache_function_invoked_for_the_generation_and_waited_for(aws: Any) -> None:
    s3, _ = aws
    function = FakeLambda()
    _cache(s3, function).fill(CONNECTION, COMMIT, GEN)
    assert function.calls == [{'FunctionName': 'voc-engineering-cache', 'InvocationType': 'RequestResponse',
                               'Payload': {'connection': CONNECTION, 'commit': COMMIT, 'generation': GEN}}]


@pytest.mark.parametrize(('answer', 'said'), [
    ({'errorType': 'EntryRefused', 'errorMessage': 'the commit\'s repository is 2048 MB, over the cap'}, 'over the cap'),
    ({'errorType': 'CacheFailed', 'errorMessage': 'git fetch failed: <redacted>'}, 'git fetch failed'),
    ({'errorType': 'Runtime.ExitError', 'errorMessage': 'raw text of a crash'}, 'the cache writer failed'),
])
def test_a_fill_the_cache_refused_or_failed_is_a_refusal_in_its_words(aws: Any, answer: dict[str, Any],
                                                                     said: str) -> None:
    s3, _ = aws
    with pytest.raises(RuntimeRefused, match=f'could not be cached: .*{said}') as refused:
        _cache(s3, FakeLambda(answer, error=True)).fill(CONNECTION, COMMIT, GEN)
    assert 'raw text' not in str(refused.value)   # (only the cache's own refusals are passed on)


def test_an_idle_writer_being_woken_says_so(aws: Any) -> None:
    s3, _ = aws

    class Inactive(FakeLambda):
        def invoke(self, **_kwargs: Any) -> dict[str, Any]:
            raise ClientError({'Error': {'Code': 'ResourceNotReadyException', 'Message': 'Inactive'}}, 'Invoke')

    with pytest.raises(RuntimeRefused, match='had been idle and is being woken'):
        _cache(s3, Inactive()).fill(CONNECTION, COMMIT, GEN)


def test_a_fill_another_fill_holds_is_a_launch_under_way_not_a_refusal(aws: Any) -> None:
    s3, _ = aws
    busy = FakeLambda({'errorType': 'CacheBusy', 'errorMessage': 'another fill of this commit is under way'}, error=True)
    with pytest.raises(SessionBusy, match='being cached: another fill'):
        _cache(s3, busy).fill(CONNECTION, COMMIT, GEN)


def _claimed(until: float) -> None:
    """Another fill's claim of generation GEN, its lease ending at ``until``."""
    boto3.client('dynamodb', region_name='us-east-1').put_item(
        TableName=TABLE, Item={**claim_key(CONNECTION, COMMIT, GEN), 'holder': {'S': 'other'},
                               'expires_at': {'N': str(int(until))}})


def test_waiting_for_another_fill_is_bounded(aws: Any) -> None:
    s3, _ = aws
    _claimed(NOW + 100)
    slept: list[float] = []
    function = FakeLambda()
    assert _cache(s3, function, slept=slept).wait_for(CONNECTION, COMMIT, REPOSITORY, GEN) == 'held'
    assert (sum(slept), function.calls) == (BUSY_WAIT_SECONDS, [])   # (a live claim: never filled over)


def test_a_claim_that_lapses_with_no_ready_ends_the_wait_at_once(aws: Any) -> None:
    s3, _ = aws
    _claimed(NOW - 1)   # (that fill crashed: its lease ended, no READY)
    slept: list[float] = []
    assert _cache(s3, slept=slept).wait_for(CONNECTION, COMMIT, REPOSITORY, GEN) == 'lapsed'
    assert slept == []


def test_a_crashed_fill_is_taken_over_by_the_runs_next_ask(wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    s3 = boto3.client('s3', region_name='us-east-1')
    _claimed(NOW - 1)
    answers = iter([{'errorType': 'CacheBusy', 'errorMessage': 'under way'}])

    class CrashedThenFree(FakeLambda):
        def invoke(self, **kwargs: Any) -> dict[str, Any]:
            busy = next(answers, None)   # (the first ask meets the dead claim; the second takes it over)
            self.answer, self.error, self.s3 = (busy, True, None) if busy else ({'status': 'filled'}, False, s3)
            return super().invoke(**kwargs)

    function = CrashedThenFree()
    _real_cache(monkeypatch, function)
    handler.lambda_handler(COORDINATED, None)
    assert (len(function.calls), _coordinators_generation(), _status()) == (2, GEN, 'active')


def test_an_answer_that_is_not_a_status_and_a_deployment_without_a_writer_are_refusals(aws: Any) -> None:
    s3, _ = aws
    with pytest.raises(RuntimeRefused, match='answered otherwise'):
        _cache(s3, FakeLambda({'status': 'maybe'})).fill(CONNECTION, COMMIT, GEN)
    with pytest.raises(RuntimeRefused, match='no checkout cache writer'):
        _cache(s3, name='').fill(CONNECTION, COMMIT, GEN)


def test_the_runtimes_cache_is_wired_from_its_environment(wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    monkeypatch.setenv('ENGINEERING_CACHE_FUNCTION', 'voc-engineering-cache')
    built = WIRED_CACHE()
    assert (built.bucket, built.function_name) == (BUCKET, 'voc-engineering-cache')


def _real_cache(monkeypatch: pytest.MonkeyPatch, function: FakeLambda, slept: list[float] | None = None,
                now: float = NOW) -> None:
    from shared.aws import get_s3_client
    monkeypatch.setattr(handler, '_checkout_cache', lambda: _cache(get_s3_client(), function, slept=slept, now=now))


def _filling(monkeypatch: pytest.MonkeyPatch) -> FakeLambda:
    """The runtime's real cache over moto, its writer a fake whose fill writes READY."""
    function = FakeLambda(s3=boto3.client('s3', region_name='us-east-1'))
    _real_cache(monkeypatch, function)
    return function


def _coordinator() -> Any:
    return handler._supervisor().sessions.get(OTHER_RUN, 'coordinator-1')


def _coordinators_generation() -> int:
    session = _coordinator()
    assert session is not None
    return int(session.cache_generation)


def _status() -> str:
    run = handler._runs().get(OTHER_RUN)
    assert run is not None
    return run.status


def _decision_point() -> tuple[str, str]:
    run = handler._runs().get(OTHER_RUN)
    assert run is not None
    return run.status, run.waiting_at


#: What the runtime said as a run's health in the test that is running (``said``).
HEALTH: list[str] = []


@pytest.fixture(autouse=True)
def said(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every run health the runtime says, kept in ``HEALTH`` (and still said, on the wired bus)."""
    HEALTH.clear()
    original = handler._health
    monkeypatch.setattr(handler, '_health', lambda run_id, text: HEALTH.append(text) or original(run_id, text))


def _health_said() -> list[str]:
    return list(HEALTH)


def test_the_boards_launch_is_refused_without_a_usable_entry_and_starts_no_session(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _real_cache(monkeypatch, FakeLambda())
    with pytest.raises(RuntimeRefused, match=NOT_READY[:40]):
        handler.lambda_handler(LAUNCH, None)
    assert handler._supervisor().sessions.get(LAUNCH['run_id'], 'fixer-1') is None


def test_a_launch_records_the_generation_it_found_and_the_agent_clones_that_one(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _real_cache(monkeypatch, FakeLambda())
    _ready(boto3.client('s3', region_name='us-east-1'), GEN - 1, repository='example/app', written=NOW - 20 * DAY)
    assert handler.lambda_handler(LAUNCH, None)['agent_id'] == 'fixer-1'
    session = handler._supervisor().sessions.get(LAUNCH['run_id'], 'fixer-1')
    assert session is not None
    assert session.cache_generation == GEN - 1
    clone = handler.checkout_commands(session.commit, session.paths, session.cache_generation)[0]
    assert f'file:///mnt/voc-cache/{COMMIT}/g{GEN - 1}/repo.git' in clone.argv


def test_a_continuation_looks_the_cache_up_again_and_finds_none_once_the_old_generation_is_too_old(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    s3 = boto3.client('s3', region_name='us-east-1')
    _real_cache(monkeypatch, FakeLambda())
    _ready(s3, GEN - 1, repository='example/app', written=NOW - 20 * DAY)
    handler.lambda_handler(LAUNCH, None)
    session = handler._supervisor().sessions.get(LAUNCH['run_id'], 'fixer-1')
    assert session is not None
    assert handler._continuation_generation(session) == GEN - 1
    _real_cache(monkeypatch, FakeLambda(), now=NOW + 8 * DAY)   # (N-1's manifest is now 28 days old)
    assert handler._continuation_generation(session) is None
    _ready(s3, GEN, repository='example/app', written=NOW + 8 * DAY)
    assert handler._continuation_generation(session) == GEN


def test_a_runs_coordinator_is_launched_only_after_its_commit_is_filled(wired: Any,
                                                                       monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    function = _filling(monkeypatch)
    assert handler.lambda_handler(COORDINATED, None)['status'] == 'active'
    assert [call['Payload'] for call in function.calls] == [{'connection': CONNECTION, 'commit': COMMIT,
                                                             'generation': GEN}]
    assert _coordinators_generation() == GEN


def test_a_previous_generation_too_old_is_left_and_the_current_one_filled(wired: Any,
                                                                          monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    s3 = boto3.client('s3', region_name='us-east-1')
    _ready(s3, GEN - 1, written=NOW - 28 * DAY)
    function = _filling(monkeypatch)
    handler.lambda_handler(COORDINATED, None)
    assert [call['Payload']['generation'] for call in function.calls] == [GEN]
    assert _coordinators_generation() == GEN


def test_a_start_on_a_usable_previous_generation_fills_the_current_one_ahead(wired: Any,
                                                                            monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _ready(boto3.client('s3', region_name='us-east-1'), GEN - 1, written=NOW - 20 * DAY)
    function = _filling(monkeypatch)
    handler.lambda_handler(COORDINATED, None)
    assert ([call['Payload']['generation'] for call in function.calls], _coordinators_generation()) == ([GEN], GEN)


def test_a_failed_fill_ahead_still_launches_on_the_previous_generation(wired: Any,
                                                                       monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _ready(boto3.client('s3', region_name='us-east-1'), GEN - 1, written=NOW - 20 * DAY)
    _real_cache(monkeypatch, FakeLambda({'errorType': 'CacheFailed', 'errorMessage': 'git fetch failed'}, error=True))
    handler.lambda_handler(COORDINATED, None)
    assert (_status(), _coordinators_generation()) == ('active', GEN - 1)
    assert any('was not filled ahead' in text for text in _health_said())   # (said, and nobody sent for)


def test_a_resume_with_nothing_usable_refills_and_resumes_the_run_again_once_its_fill_has_landed(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    s3 = boto3.client('s3', region_name='us-east-1')
    function = _filling(monkeypatch)
    handler.lambda_handler(COORDINATED, None)
    s3.delete_object(Bucket=BUCKET, Key=ready_key(CONNECTION, COMMIT, GEN))   # (gone)
    resumed: list[dict[str, Any]] = []
    original = handler.signal_action
    monkeypatch.setattr(handler, 'signal_action', lambda event: resumed.append(dict(event)) or original(event))
    handler.lambda_handler(RESUME, None)
    assert len(function.calls) == 2
    assert [event.get('after_fill') for event in resumed] == [True]   # (once, after the fill: never a loop)
    assert handler._supervisor().sessions.get(OTHER_RUN, 'coordinator-2') is None   # (the live one is kept)


def _board_launch_on_the_previous_generation(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """The wired run's commit served by N-1 only, a board launch of one of its agents made, and the hand-ons it made."""
    _ready(boto3.client('s3', region_name='us-east-1'), GEN - 1, repository='example/app', written=NOW - 20 * DAY)
    _real_cache(monkeypatch, FakeLambda())
    handed: list[dict[str, Any]] = []
    monkeypatch.setattr(handler, '_function_name', 'voc-engineering-runtime')
    monkeypatch.setattr('shared.aws.invoke_lambda_async', lambda _name, event: handed.append(event))
    assert handler.launch(LAUNCH)['agent_id'] == 'fixer-1'   # (on N-1 meanwhile)
    return handed


def test_a_boards_launch_on_the_previous_generation_hands_the_current_ones_fill_on(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    handed = _board_launch_on_the_previous_generation(monkeypatch)
    assert [(event['action'], event['run_id']) for event in handed] == [('launch_coordinator', LAUNCH['run_id'])]


def test_a_continuation_on_the_previous_generation_fills_the_current_one_ahead_once_per_claim(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    handed = _board_launch_on_the_previous_generation(monkeypatch)
    handed.clear()
    session = handler._supervisor().sessions.get(LAUNCH['run_id'], 'fixer-1')
    assert session is not None
    assert handler._continuation_generation(session) == GEN - 1   # (N-1 serves it meanwhile)
    assert [(event['action'], event['background'], event['board']) for event in handed] == [
        ('launch_coordinator', True, True)]   # (in the background: its failure sends nobody to a person)
    _claimed(NOW + 100)   # (that fill now holds a live claim: the next continuation hands nothing on)
    assert handler._continuation_generation(session) == GEN - 1
    assert len(handed) == 1


def test_a_continuation_where_the_cache_has_no_writer_hands_nothing_on(wired: Any,
                                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    handed = _board_launch_on_the_previous_generation(monkeypatch)
    handed.clear()
    from shared.aws import get_s3_client
    # (the delivery function's cache: READY's reads only, no writer to invoke and no claim to read)
    monkeypatch.setattr(handler, '_checkout_cache', lambda: _cache(get_s3_client(), FakeLambda(), name=''))
    session = handler._supervisor().sessions.get(LAUNCH['run_id'], 'fixer-1')
    assert session is not None
    assert (handler._continuation_generation(session), handed) == (GEN - 1, [])


def test_the_fill_and_the_launch_are_invocations_of_their_own(wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    function = _filling(monkeypatch)
    handed: list[dict[str, Any]] = []
    monkeypatch.setattr(handler, '_function_name', 'voc-engineering-runtime')
    monkeypatch.setattr('shared.aws.invoke_lambda_async', lambda name, event: handed.append({'to': name, **event}))
    handler.start_run(COORDINATED)
    assert handed == [{'to': 'voc-engineering-runtime', 'action': 'launch_coordinator', 'run_id': OTHER_RUN,
                       'actor': '', 'filled': False, 'resume': False, 'background': False, 'board': False, 'asks': 0}]
    assert handler.launch_coordinator(handed[0]) == {'run_id': OTHER_RUN, 'status': 'filled'}
    assert (len(function.calls), handed[-1]['filled']) == (1, True)
    assert handler.launch_coordinator(handed[-1]) == {'run_id': OTHER_RUN, 'status': 'active'}


def test_a_writer_that_cannot_be_asked_sends_the_run_to_a_person_at_the_checkout_cache_point(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None

    class Throttled(FakeLambda):
        def invoke(self, **_kwargs: Any) -> dict[str, Any]:
            raise ClientError({'Error': {'Code': 'TooManyRequestsException', 'Message': 'Rate exceeded'}}, 'Invoke')

    _real_cache(monkeypatch, Throttled())
    handler.lambda_handler(COORDINATED, None)
    assert _decision_point() == ('needs_human', 'checkout_cache')
    assert any('could not be asked, or did not answer in time' in text for text in _health_said())


def test_fills_that_keep_ending_with_no_ready_are_taken_over_at_most_twice(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _claimed(NOW - 1)   # (each ask meets a claim that lapsed: a fill that crashed)
    busy = FakeLambda({'errorType': 'CacheBusy', 'errorMessage': 'under way'}, error=True)
    _real_cache(monkeypatch, busy)
    handler.lambda_handler(COORDINATED, None)
    assert (len(busy.calls), _decision_point()) == (3, ('needs_human', 'checkout_cache'))
    assert any('kept ending with no READY' in text for text in _health_said())


def test_a_fill_that_is_refused_launches_no_coordinator_and_sends_the_run_to_a_person(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _real_cache(monkeypatch, FakeLambda({'errorType': 'EntryRefused', 'errorMessage': 'over the cap'}, error=True))
    handler.lambda_handler(COORDINATED, None)
    assert (_coordinator(), _decision_point()) == (None, ('needs_human', 'checkout_cache'))
    # (the writer's own words, as the run's health)
    assert ('The run\'s checkout could not be cached: over the cap. Once that is put right, a Resume of the run fills '
            'the checkout.') in _health_said()   # (a refusal: never "tries again", which only a passing failure says)


def test_a_background_fill_that_fails_leaves_a_served_run_active_and_only_says_so(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _ready(boto3.client('s3', region_name='us-east-1'), GEN - 1, written=NOW - 20 * DAY)
    handler.lambda_handler(COORDINATED, None)   # (the coordinator on N-1: the writer below fails from here on)
    _real_cache(monkeypatch, FakeLambda({'errorType': 'CacheFailed', 'errorMessage': 'git fetch failed'}, error=True))
    answer = handler.launch_coordinator({'run_id': OTHER_RUN, 'actor': '', 'background': True})
    assert (answer['status'], _status()) == ('active', 'active')


@pytest.mark.parametrize(('refusal', 'ending'), [
    (NO_COMMIT, handler.NO_COMMIT_ENDING),      # (a Resume keeps the commit: it helps once the commit is pushed)
    (FSCK_REJECTED, handler.FSCK_ENDING),       # (a Resume would meet the same object: a new run on another commit)
    ('the repository host has no repository the connection\'s token can fetch', handler.FIXED_ENDING),
])
def test_a_refusals_ending_matches_its_cause(wired: Any, monkeypatch: pytest.MonkeyPatch, refusal: str,
                                             ending: str) -> None:
    assert wired is not None
    _real_cache(monkeypatch, FakeLambda({'errorType': 'EntryRefused', 'errorMessage': refusal}, error=True))
    handler.lambda_handler(COORDINATED, None)
    assert _decision_point() == ('needs_human', 'checkout_cache')
    assert f'The run\'s checkout could not be cached: {refusal}. {ending}' in _health_said()
    assert not any(handler.RETRY_ENDING in text for text in _health_said())


#: The writer's refusal of a connection whose App was uninstalled (cache.py, a 404 to the token request).
UNINSTALLED = {'errorType': 'EntryRefused', 'errorMessage': 'the repository host refused the connection\'s fetch token'}


def test_a_refused_background_fill_sends_the_run_to_a_person_now_in_the_writers_words(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _ready(boto3.client('s3', region_name='us-east-1'), GEN - 1, written=NOW - 20 * DAY)
    handler.lambda_handler(COORDINATED, None)   # (the coordinator on N-1)
    _real_cache(monkeypatch, FakeLambda(UNINSTALLED, error=True))
    answer = handler.launch_coordinator({'run_id': OTHER_RUN, 'actor': '', 'background': True})
    assert (answer['status'], _decision_point()) == ('needs_human', ('needs_human', 'checkout_cache'))
    assert ('The run\'s checkout could not be cached: the repository host refused the connection\'s fetch token. Once '
            'that is put right, a Resume of the run fills the checkout.') in _health_said()


def test_a_start_whose_fill_ahead_is_refused_goes_to_a_person_rather_than_wait_for_the_edge(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _ready(boto3.client('s3', region_name='us-east-1'), GEN - 1, written=NOW - 20 * DAY)
    _real_cache(monkeypatch, FakeLambda(UNINSTALLED, error=True))
    handler.lambda_handler(COORDINATED, None)
    assert (_coordinator(), _decision_point()) == (None, ('needs_human', 'checkout_cache'))
    assert any('refused the connection\'s fetch token' in text for text in _health_said())


def _board_launch_refusal(monkeypatch: pytest.MonkeyPatch, hand_on: Callable[[str, object], None]) -> str:
    """What a board launch of a working run whose entry is gone is refused with, its fill handed on by ``hand_on``."""
    _working_run_loses_its_entry(monkeypatch, {'errorType': 'CacheBusy', 'errorMessage': 'under way'})
    monkeypatch.setattr(handler, '_function_name', 'voc-engineering-runtime')
    monkeypatch.setattr('shared.aws.invoke_lambda_async', hand_on)
    with pytest.raises(RuntimeRefused) as refused:
        handler.launch(AGENT_LAUNCH)
    return str(refused.value)


def test_a_board_launch_that_hands_a_fill_on_says_to_try_again_shortly(wired: Any,
                                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    assert _board_launch_refusal(monkeypatch, lambda _name, _event: None) == FILLING
    _claimed(NOW + 100)   # (and while that fill holds its claim, the same words)
    with pytest.raises(RuntimeRefused, match='a fill of it is under way; try the launch again in a few minutes'):
        handler.launch(AGENT_LAUNCH)


def test_a_board_launch_whose_fill_could_not_be_handed_on_says_a_resume_fills_it(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None

    def unreachable(_name: str, _event: object) -> None:
        raise ClientError({'Error': {'Code': 'TooManyRequestsException', 'Message': 'Rate exceeded'}}, 'Invoke')

    assert _board_launch_refusal(monkeypatch, unreachable) == NOT_READY


def _working_run_loses_its_entry(monkeypatch: pytest.MonkeyPatch, answer: dict[str, Any]) -> None:
    """OTHER_RUN started and its coordinator working, then its commit's entry gone, and a writer answering ``answer``
    (an error) from then on."""
    s3 = boto3.client('s3', region_name='us-east-1')
    _filling(monkeypatch)
    handler.lambda_handler(COORDINATED, None)
    s3.delete_object(Bucket=BUCKET, Key=ready_key(CONNECTION, COMMIT, GEN))
    _real_cache(monkeypatch, FakeLambda(answer, error=True))


#: A board launch of one of OTHER_RUN's agents (its coordinator works).
AGENT_LAUNCH = {**LAUNCH, 'run_id': OTHER_RUN}


def _busy_host_on_a_clock(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """OTHER_RUN working, its entry gone, the writer answering a busy host, and the runtime's clock the one returned."""
    _working_run_loses_its_entry(monkeypatch, {'errorType': 'CacheFailed', 'errorMessage': 'the host is busy'})
    now = [handler.clock()]
    monkeypatch.setattr(handler, 'clock', lambda: now[0])
    return now


def test_a_transient_fill_failure_from_a_board_launch_leaves_a_working_run_active_until_it_repeats(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    now = _busy_host_on_a_clock(monkeypatch)
    for _ in range(MAX_TRANSIENT_FILLS - 1):
        with pytest.raises(RuntimeRefused, match='no usable checkout'):   # (the agent reads its refusal)
            handler.launch(AGENT_LAUNCH)
        assert _decision_point() == ('active', '')
        now[0] += CACHE_FAILURE_WINDOW_SECONDS + 1   # (the next spell)
    assert any('(1 of 3 failures in a row)' in text for text in _health_said())
    with pytest.raises(RuntimeRefused):
        handler.launch(AGENT_LAUNCH)
    assert _decision_point() == ('needs_human', 'checkout_cache')   # (the third in a row: a person)


def test_a_failure_long_after_the_last_starts_the_count_again(wired: Any) -> None:
    assert wired is not None
    handler.lambda_handler({**COORDINATED, 'language': ''}, None)   # (OTHER_RUN's META only: no fill needed)
    runs = handler._runs()
    assert runs.count_cache_failure(OTHER_RUN, now=1000, window=300, reset_after=3600) == (1, 1000)
    assert runs.count_cache_failure(OTHER_RUN, now=1100, window=300, reset_after=3600) == (1, 1000)   # (one spell)
    assert runs.count_cache_failure(OTHER_RUN, now=1400, window=300, reset_after=3600) == (2, 1000)
    # (an old spell: the count starts again, but the streak's start is kept until a fill lands)
    assert runs.count_cache_failure(OTHER_RUN, now=1400 + 3601, window=300, reset_after=3600) == (1, 1000)
    runs.clear_cache_failures(OTHER_RUN)
    assert runs.count_cache_failure(OTHER_RUN, now=9000, window=300, reset_after=3600) == (1, 9000)


def _later_launch_after_a_first_failure(monkeypatch: pytest.MonkeyPatch, after: float) -> None:
    """A busy host's first failure of a streak (a board launch, refused, the run still active), then another board
    launch ``after`` seconds later."""
    now = _busy_host_on_a_clock(monkeypatch)
    with pytest.raises(RuntimeRefused):
        handler.launch(AGENT_LAUNCH)
    assert _decision_point() == ('active', '')
    now[0] += after
    with pytest.raises(RuntimeRefused):
        handler.launch(AGENT_LAUNCH)


def test_a_streak_of_failures_far_apart_reaches_a_person_once_it_is_an_hour_old(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    # (the second, just under an hour on: "2 of 3", the streak not yet old)
    _later_launch_after_a_first_failure(monkeypatch, CACHE_FAILING_LIMIT_SECONDS - 1)
    now = [handler.clock()]
    monkeypatch.setattr(handler, 'clock', lambda: now[0])
    assert _decision_point() == ('active', '')
    assert any('(2 of 3 failures in a row)' in text for text in _health_said())
    now[0] += CACHE_FAILURE_RESET_SECONDS + 1   # (a coordinator asking less often than hourly)
    with pytest.raises(RuntimeRefused):
        handler.launch(AGENT_LAUNCH)   # (the count is back at 1, but the streak is over an hour old)
    assert _decision_point() == ('needs_human', 'checkout_cache')
    assert any('A Resume of the run tries again.' in text for text in _health_said())


def test_a_streak_exactly_an_hour_old_already_reaches_a_person(wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    # (exactly an hour on: the count restarts at 1, and the hour is up)
    _later_launch_after_a_first_failure(monkeypatch, CACHE_FAILING_LIMIT_SECONDS)
    assert _decision_point() == ('needs_human', 'checkout_cache')
    assert not any('2 of 3' in text for text in _health_said())


def _one_launch_met_a_busy_host(monkeypatch: pytest.MonkeyPatch) -> None:
    """OTHER_RUN working, its entry gone, and one board launch refused by a busy host (one failure counted)."""
    _working_run_loses_its_entry(monkeypatch, {'errorType': 'CacheFailed', 'errorMessage': 'the host is busy'})
    with pytest.raises(RuntimeRefused):
        handler.launch(AGENT_LAUNCH)
    assert 'cache_failures' in _meta()


def _meta() -> dict[str, Any]:
    """OTHER_RUN's META row."""
    table = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)
    return table.get_item(Key=meta_key(OTHER_RUN)).get('Item', {})


def test_a_launch_that_finds_the_entry_ready_clears_the_count(wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _one_launch_met_a_busy_host(monkeypatch)
    _ready(boto3.client('s3', region_name='us-east-1'), GEN, written=NOW)   # (another run's fill landed)
    handler.launch(AGENT_LAUNCH)
    assert 'cache_failures' not in _meta()


def test_failures_within_one_spell_count_once(wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _working_run_loses_its_entry(monkeypatch, {'errorType': 'CacheFailed', 'errorMessage': 'the host is busy'})
    for _ in range(MAX_TRANSIENT_FILLS + 1):   # (racing launches meeting one outage)
        with pytest.raises(RuntimeRefused):
            handler.launch(AGENT_LAUNCH)
    assert _decision_point() == ('active', '')
    assert not any('2 of 3' in text for text in _health_said())


def test_a_resume_carried_on_after_a_fill_never_passes_another_decision_point(wired: Any,
                                                                              monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _filling(monkeypatch)
    handler.lambda_handler(COORDINATED, None)
    handler._runs().needs_human(OTHER_RUN, 'flow:review', now=int(handler.clock()))   # (a step waits for a person)
    assert handler.signal_action({'run_id': OTHER_RUN, 'signal': 'resume', 'actor': 'admin-1',
                                  'after_fill': True}) == {'agents': {}, 'applied': {}}
    assert _decision_point() == ('needs_human', 'flow:review')


def test_a_refused_fill_from_a_board_launch_sends_the_run_to_a_person_at_once(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _working_run_loses_its_entry(monkeypatch, {'errorType': 'EntryRefused', 'errorMessage': 'over the cap'})
    with pytest.raises(RuntimeRefused, match='no usable checkout'):
        handler.launch(AGENT_LAUNCH)
    assert _decision_point() == ('needs_human', 'checkout_cache')


def test_a_fill_that_lands_clears_the_runs_count_of_transient_failures(wired: Any,
                                                                       monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _one_launch_met_a_busy_host(monkeypatch)
    _filling(monkeypatch)
    with contextlib.suppress(RuntimeRefused):   # (this launch is answered as it found the cache: the fill follows)
        handler.launch(AGENT_LAUNCH)
    assert 'cache_failures' not in _meta()


def test_a_coordinator_failure_after_a_background_fill_still_goes_to_a_person(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _ready(boto3.client('s3', region_name='us-east-1'), GEN, written=NOW)
    _real_cache(monkeypatch, FakeLambda())

    def down(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError('the session service is unavailable')

    handler.lambda_handler({**COORDINATED, 'language': ''}, None)   # (written, no coordinator yet)
    monkeypatch.setattr(handler, '_ensure_coordinator', down)
    answer = handler.launch_coordinator({'run_id': OTHER_RUN, 'actor': '', 'background': True})
    assert (answer['status'], _decision_point()) == ('needs_human', ('needs_human', 'coordinator'))


def test_a_burst_of_board_launches_hands_no_fill_on_while_one_holds_a_live_claim(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _claimed(NOW + 100)   # (a fill of N holds a live claim)
    assert _board_launch_on_the_previous_generation(monkeypatch) == []


def test_a_ready_the_role_cannot_read_after_a_fill_is_refused_saying_so(wired: Any,
                                                                        monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _real_cache(monkeypatch, FakeLambda())
    from shared.aws import get_s3_client
    real = get_s3_client()

    class Forbidden:
        def get_object(self, **_kwargs: Any) -> None:
            raise ClientError({'Error': {'Code': '403', 'Message': 'Forbidden'}}, 'GetObject')

    monkeypatch.setattr(handler, '_checkout_cache', lambda: _cache(Forbidden(), FakeLambda(s3=real)))
    handler.lambda_handler(COORDINATED, None)
    assert _decision_point() == ('needs_human', 'checkout_cache')
    assert any('the role cannot read the checkout cache (403)' in text.lower() for text in _health_said())


def test_a_run_whose_fill_meets_another_runs_waits_for_its_ready_and_launches(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    s3 = boto3.client('s3', region_name='us-east-1')
    slept: list[float] = []

    class OtherRunsFill(FakeLambda):
        def invoke(self, **kwargs: Any) -> dict[str, Any]:
            _ready(s3)   # (the other run's fill lands while this one waits)
            return super().invoke(**kwargs)

    busy = OtherRunsFill({'errorType': 'CacheBusy', 'errorMessage': 'under way'}, error=True)
    _real_cache(monkeypatch, busy, slept)
    handler.lambda_handler(COORDINATED, None)
    assert (_coordinator() is not None, _status(), len(busy.calls)) == (True, 'active', 1)


def test_a_fill_still_held_after_two_waits_goes_to_a_person_saying_so(
        wired: Any, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    assert wired is not None
    _claimed(NOW + 100)   # (another run's fill holds it throughout)
    slept: list[float] = []
    busy = FakeLambda({'errorType': 'CacheBusy', 'errorMessage': 'under way'}, error=True)
    _real_cache(monkeypatch, busy, slept)
    handler.lambda_handler(COORDINATED, None)
    # (asked once more after the first wait, then refused: bounded)
    assert (len(busy.calls), sum(slept), _coordinator()) == (2, 2 * BUSY_WAIT_SECONDS, None)
    assert 'outlasted the wait' in caplog.text
    assert _decision_point() == ('needs_human', 'checkout_cache')
    assert any('held its claim past two waits' in text for text in _health_said())


@pytest.mark.parametrize(('until', 'words'), [
    (NOW + 100, 'held its claim past two waits'),   # (another fill holds the claim throughout)
    (NOW - 1, 'kept ending with no READY'),         # (each ask meets a lapsed claim: fills that crash)
])
def test_a_board_fill_that_meets_other_fills_is_transient_and_reaches_a_person_on_the_third_spell(
        wired: Any, monkeypatch: pytest.MonkeyPatch, until: float, words: str) -> None:
    assert wired is not None
    _working_run_loses_its_entry(monkeypatch, {'errorType': 'CacheBusy', 'errorMessage': 'under way'})
    _claimed(until)
    now = [handler.clock()]
    monkeypatch.setattr(handler, 'clock', lambda: now[0])
    board = {'run_id': OTHER_RUN, 'actor': '', 'board': True}
    for spell in range(1, MAX_TRANSIENT_FILLS):
        handler.launch_coordinator(board)   # (asked again in-process after the first ending: the chain's last answers)
        assert _decision_point() == ('active', '')
        assert any(words in text and f'({spell} of 3 failures in a row)' in text for text in _health_said())
        now[0] += CACHE_FAILURE_WINDOW_SECONDS + 1   # (the next spell)
    handler.launch_coordinator(board)
    assert _decision_point() == ('needs_human', 'checkout_cache')
