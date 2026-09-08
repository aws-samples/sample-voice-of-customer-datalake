"""Tests for the persona generation chain and its avatar fan-out.

These exercise `api.projects.generate_personas` — the function this job's
handler delegates to — rather than the handler wrapper, because the properties
under test (which chain steps run, which step's output is saved, how avatars
are produced) all live there.

Two shapes are pinned here:

1. The chain is `research_analysis` → `persona_synthesis` and nothing follows
   the step whose output is saved. A third `validation` step used to run after
   it: ~49% of the job's wall clock, its output never read for persona data,
   and because `converse_chain` re-raises with a local results list, a failure
   in it discarded personas that had already been produced and paid for.

2. Avatars are produced concurrently, one unit of work per persona, while
   keeping the parsed order and per-persona failure isolation.
"""

import threading
from unittest.mock import MagicMock, patch

import pytest


# One persona per entry, in the shape persona_synthesis emits. Kept minimal but
# with every top-level key generate_personas reads, so the saved item can be
# asserted field by field.
def _persona(name: str) -> dict:
    return {
        'name': name,
        'tagline': f'The {name}',
        'confidence': 'high',
        'feedback_count': 7,
        'identity': {'occupation': 'Engineer', 'bio': 'Bio', 'age_range': '30-40'},
        'goals_motivations': {'primary_goal': 'Ship'},
        'pain_points': {'current_challenges': ['Slow']},
        'behaviors': {'tech_savviness': 'high'},
        'context_environment': {'usage_context': 'Desk'},
        'quotes': [{'text': 'Real quote', 'context': 'Review 1'}],
        'scenario': {'title': 'A day', 'narrative': 'Story'},
        'supporting_evidence': ['Review #1'],
    }


def _synthesis_output(names: list[str]) -> str:
    """persona_synthesis's real-world output shape: a JSON array, sometimes
    with prose around it (the parser digs the array out with a regex)."""
    import json
    return 'Here are the personas:\n' + json.dumps([_persona(n) for n in names])


FEEDBACK_ITEMS = [
    {
        'feedback_id': f'fb-{i}',
        'source_platform': 'app_store',
        'original_text': f'Review text {i}',
        'sentiment_label': 'negative',
        'sentiment_score': -0.4,
        'category': 'usability',
        'rating': 2,
        'urgency': 'high',
    }
    for i in range(6)
]


@pytest.fixture
def projects_table():
    table = MagicMock()
    table.name = 'test-projects'
    table.query.return_value = {'Items': []}

    def transact_write_items(*, TransactItems):
        for action in TransactItems:
            if 'Put' in action:
                table.put_item(Item=action['Put']['Item'])
        return {}

    table.meta.client.transact_write_items.side_effect = transact_write_items
    with patch('api.projects.projects_table', table):
        yield table


@pytest.fixture
def feedback():
    with patch('api.projects.get_feedback_context', return_value=FEEDBACK_ITEMS):
        yield FEEDBACK_ITEMS


@pytest.fixture
def chain():
    """Mock `converse_chain`, returning one output per step it is GIVEN.

    Derived from the steps argument rather than a fixed-length list on purpose:
    an implementation that asks for a third step still gets a well-formed
    response for it and runs to completion, so a test that pins the step count
    fails on the count, never on a fixture that ran out of answers.
    """
    def respond(steps, *args, **kwargs):
        outputs = []
        for step in steps:
            if step['step_name'] == 'persona_synthesis':
                outputs.append(_synthesis_output(['Ada Lovelace', 'Grace Hopper']))
            else:
                outputs.append(f"{step['step_name']} prose output")
        return outputs

    mock = MagicMock(side_effect=respond)
    with patch('api.projects.converse_chain', mock):
        yield mock


@pytest.fixture
def avatars():
    """Mock the avatar call, echoing the persona id back in the URL so a
    result attached to the wrong persona is visible.

    `project_id` is NAMED rather than swallowed by a `**kwargs`, and asserted: it is
    what the writer stamps on the object so a project delete can tell its own avatars
    from a neighbour's in a key space that carries no project. An avatar written
    without it is one the delete declines to remove, so a catch-all would keep this
    double green while the ownership stamp silently stopped being written.
    """
    def make(persona_data, project_id=None):
        assert project_id, (
            'the avatar writer needs the owning project, or the object carries no '
            'owner and a project delete cannot claim it'
        )
        persona_id = persona_data['persona_id']
        return {
            'avatar_url': f's3://bucket/avatars/{persona_id}.jpeg',
            'avatar_prompt': f'prompt for {persona_id}',
        }

    mock = MagicMock(side_effect=make)
    with patch('api.projects.generate_persona_avatar', mock):
        yield mock


def _saved_items(projects_table):
    return [c.kwargs['Item'] for c in projects_table.put_item.call_args_list]


class TestChainShape:
    """The chain runs two steps and the last one's output is what gets saved."""

    def test_chain_runs_research_then_synthesis_and_no_third_step(
        self, projects_table, feedback, chain, avatars
    ):
        from api.projects import generate_personas

        generate_personas('proj-1', {'persona_count': 2})

        steps = chain.call_args.args[0]
        assert [s['step_name'] for s in steps] == [
            'research_analysis', 'persona_synthesis',
        ]

    def test_saved_personas_come_from_the_synthesis_step(
        self, projects_table, feedback, chain, avatars
    ):
        from api.projects import generate_personas

        result = generate_personas('proj-1', {'persona_count': 2})

        assert [p['name'] for p in result['personas']] == ['Ada Lovelace', 'Grace Hopper']
        assert [i['name'] for i in _saved_items(projects_table)] == [
            'Ada Lovelace', 'Grace Hopper',
        ]

    def test_no_step_runs_after_the_personas_exist(
        self, projects_table, feedback, chain, avatars
    ):
        """The synthesis step is LAST, so nothing billed can fail once the
        personas have been produced. Asserted as a property of the step list
        rather than by simulating a failure, because the failure mode being
        removed is precisely 'a later step raised and threw them away'."""
        from api.projects import generate_personas

        generate_personas('proj-1', {'persona_count': 2})

        steps = chain.call_args.args[0]
        assert steps[-1]['step_name'] == 'persona_synthesis'

    def test_a_synthesis_step_returning_no_json_fails_the_generation(
        self, projects_table, feedback, avatars
    ):
        """Positive control for the parse: no other step's output may be used
        as a fallback source of personas. The research step here DOES carry a
        valid persona array, so an implementation that scanned earlier results
        would run to completion instead of raising."""
        from api.projects import generate_personas
        from shared.exceptions import ServiceError

        def respond(steps, *args, **kwargs):
            return [
                _synthesis_output(['Should Not Be Used']) if s['step_name'] != 'persona_synthesis'
                else 'I was unable to produce the profiles.'
                for s in steps
            ]

        with patch('api.projects.converse_chain', MagicMock(side_effect=respond)), \
                pytest.raises(ServiceError):
            generate_personas('proj-1', {'persona_count': 2})

        assert projects_table.put_item.call_count == 0


class TestAnalysisPayload:
    def test_analysis_carries_research_only(
        self, projects_table, feedback, chain, avatars
    ):
        """`validation` is gone from the chain, so it cannot appear here. The
        key had no consumer: the route is asynchronous and returns a job id,
        and the jobs panel reads persona_id/document_id/title."""
        from api.projects import generate_personas

        result = generate_personas('proj-1', {'persona_count': 2})

        assert result['analysis'] == {'research': 'research_analysis prose output'}
        assert 'validation' not in result['analysis']


class TestReplaceSemantics:
    def test_existing_personas_are_cleared_and_the_count_is_replaced(
        self, projects_table, feedback, chain, avatars
    ):
        from api.projects import generate_personas

        projects_table.query.return_value = {
            'Items': [
                {'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#old-1'},
                {'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#old-2'},
                {'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#old-3'},
            ]
        }

        result = generate_personas('proj-1', {'persona_count': 2})

        batch = projects_table.batch_writer.return_value.__enter__.return_value
        deleted = {c.kwargs['Key']['sk'] for c in batch.delete_item.call_args_list}
        assert deleted == {'PERSONA#old-1', 'PERSONA#old-2', 'PERSONA#old-3'}

        # Replace, not increment: two personas saved, so the META count is 2
        # even though three rows existed before.
        values = projects_table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert values[':count'] == 2
        assert len(result['personas']) == 2

    def test_saved_persona_keeps_the_full_documented_shape(
        self, projects_table, feedback, chain, avatars
    ):
        from api.projects import generate_personas

        generate_personas('proj-1', {'persona_count': 2})

        item = _saved_items(projects_table)[0]
        for section in (
            'identity', 'goals_motivations', 'pain_points', 'behaviors',
            'context_environment', 'quotes', 'scenario', 'research_notes',
        ):
            assert section in item
        assert item['source_breakdown'] == {'app_store': len(FEEDBACK_ITEMS)}
        assert item['source_feedback_ids'] == [f['feedback_id'] for f in FEEDBACK_ITEMS]
        assert set(item['llm_metadata']) == {'model', 'prompt_version', 'generation_time_ms'}


class TestAvatarConcurrency:
    """Avatars are one unit of work per persona, run concurrently.

    The concurrency probe is a barrier the avatar call must pass through: with
    three personas and a three-party barrier, only a concurrent implementation
    ever releases it. A serialised loop blocks on the first call until the
    barrier's timeout, which breaks it — and because per-persona avatar failure
    is non-fatal, the generation still completes, with no avatar URLs. So the
    assertion is on the URLs, not on an exception.
    """

    BARRIER_TIMEOUT = 3.0

    @staticmethod
    def _three_persona_chain():
        def respond(steps, *args, **kwargs):
            return [
                _synthesis_output(['A One', 'B Two', 'C Three'])
                if s['step_name'] == 'persona_synthesis' else 'prose'
                for s in steps
            ]
        return MagicMock(side_effect=respond)

    def test_avatars_for_three_personas_overlap_in_time(
        self, projects_table, feedback
    ):
        from api.projects import generate_personas

        barrier = threading.Barrier(3)

        def make(persona_data, project_id=None):
            barrier.wait(timeout=self.BARRIER_TIMEOUT)
            return {
                'avatar_url': f"s3://bucket/avatars/{persona_data['persona_id']}.jpeg",
                'avatar_prompt': 'p',
            }

        with patch('api.projects.converse_chain', self._three_persona_chain()), \
             patch('api.projects.generate_persona_avatar', MagicMock(side_effect=make)):
            result = generate_personas('proj-1', {'persona_count': 3})

        assert len(result['personas']) == 3
        assert all(p['avatar_url'] for p in result['personas']), (
            'at least one avatar call never met the others at the barrier — '
            'the avatar work is not running concurrently'
        )

    def test_the_barrier_probe_fails_when_the_work_is_serialised(
        self, projects_table, feedback
    ):
        """Control for the test above: the same barrier, sized for one more
        party than there are personas, is never released — proving the probe
        genuinely depends on overlap rather than passing regardless."""
        from api.projects import generate_personas

        barrier = threading.Barrier(4)

        def make(persona_data, project_id=None):
            barrier.wait(timeout=0.4)
            return {'avatar_url': 's3://bucket/x.jpeg', 'avatar_prompt': 'p'}

        with patch('api.projects.converse_chain', self._three_persona_chain()), \
             patch('api.projects.generate_persona_avatar', MagicMock(side_effect=make)):
            result = generate_personas('proj-1', {'persona_count': 3})

        assert len(result['personas']) == 3
        assert all(p['avatar_url'] is None for p in result['personas'])

    def test_order_follows_the_parsed_order_not_the_finishing_order(
        self, projects_table, feedback
    ):
        """The first persona's avatar finishes last. Saved order, response
        order and the avatar attached to each persona must all still line up
        with the order persona_synthesis produced.

        The completion order is FORCED with events rather than nudged with sleeps, and
        then asserted. Sleeps made the inversion only likely: on a loaded runner the
        scheduling could come out in parsed order and the test would pass without having
        exercised the reordering hazard at all — and it would also flake the other way.
        Each worker waits for the one after it to finish, so C→B→A is guaranteed.
        """
        from api.projects import generate_personas

        order = ['A One', 'B Two', 'C Three']
        done = {name: threading.Event() for name in order}
        completed: list[str] = []
        completed_lock = threading.Lock()

        def make(persona_data, project_id=None):
            name = persona_data['name']
            position = order.index(name)
            # Wait for the NEXT persona to finish first; the last one runs immediately.
            if position + 1 < len(order):
                assert done[order[position + 1]].wait(timeout=10), (
                    f'{order[position + 1]} never finished — the fan-out is serialised, '
                    'so this handshake cannot complete'
                )
            with completed_lock:
                completed.append(name)
            done[name].set()
            return {
                'avatar_url': f"s3://bucket/avatars/{persona_data['persona_id']}.jpeg",
                'avatar_prompt': name,
            }

        with patch('api.projects.converse_chain', self._three_persona_chain()), \
             patch('api.projects.generate_persona_avatar', MagicMock(side_effect=make)):
            result = generate_personas('proj-1', {'persona_count': 3})

        # The hazard was actually exercised: completion order is the reverse of parsed
        # order. Without this the test could pass having never inverted anything.
        assert completed == list(reversed(order)), (
            f'completion order was {completed}, so the reordering hazard was not exercised'
        )
        assert [p['name'] for p in result['personas']] == ['A One', 'B Two', 'C Three']
        assert [i['name'] for i in _saved_items(projects_table)] == [
            'A One', 'B Two', 'C Three',
        ]
        # Each avatar landed on its OWN persona: the URL embeds the persona id
        # the avatar call was made with, so a mis-zipped result is visible.
        for item in _saved_items(projects_table):
            assert item['avatar_url'] == f"s3://bucket/avatars/{item['persona_id']}.jpeg"
            assert item['avatar_prompt'] == item['name']

    def test_one_failing_avatar_does_not_lose_its_persona_or_the_others(
        self, projects_table, feedback
    ):
        from api.projects import generate_personas

        def make(persona_data, project_id=None):
            if persona_data['name'] == 'B Two':
                raise RuntimeError('image model refused')
            return {
                'avatar_url': f"s3://bucket/avatars/{persona_data['persona_id']}.jpeg",
                'avatar_prompt': 'p',
            }

        with patch('api.projects.converse_chain', self._three_persona_chain()), \
             patch('api.projects.generate_persona_avatar', MagicMock(side_effect=make)):
            result = generate_personas('proj-1', {'persona_count': 3})

        by_name = {p['name']: p for p in result['personas']}
        assert set(by_name) == {'A One', 'B Two', 'C Three'}
        assert by_name['B Two']['avatar_url'] is None
        assert by_name['A One']['avatar_url'] and by_name['C Three']['avatar_url']
        # And it is still SAVED, not skipped.
        assert len(_saved_items(projects_table)) == 3

    def test_avatar_calls_are_keyed_to_the_persona_ids_that_get_saved(
        self, projects_table, feedback, chain, avatars
    ):
        """The avatar seed is derived from the persona id (shared/avatar.py's
        _stable_seed), so regeneration only reproduces an image if the id the
        avatar call receives is the id stored on the persona."""
        from api.projects import generate_personas

        generate_personas('proj-1', {'persona_count': 2})

        requested = {c.args[0]['persona_id'] for c in avatars.call_args_list}
        assert requested == {i['persona_id'] for i in _saved_items(projects_table)}


class TestGenerateAvatarsFlag:
    def test_false_performs_no_avatar_call(
        self, projects_table, feedback, chain, avatars
    ):
        from api.projects import generate_personas

        result = generate_personas('proj-1', {'persona_count': 2, 'generate_avatars': False})

        # The avatar mock would have answered any number of calls, so this
        # fails on the guard rather than on an exhausted fixture.
        avatars.assert_not_called()
        assert len(result['personas']) == 2
        assert all(p['avatar_url'] is None for p in result['personas'])

    def test_omitting_the_flag_still_produces_avatars(
        self, projects_table, feedback, chain, avatars
    ):
        from api.projects import generate_personas

        result = generate_personas('proj-1', {'persona_count': 2})

        assert avatars.call_count == 2
        assert all(p['avatar_url'] for p in result['personas'])


class TestSynthesisIsFoundByNameNotByPosition:
    """The parse must locate persona_synthesis by NAME.

    It used to read `results[-1]`, which was correct only while
    get_persona_generation_steps happened to end on synthesis — an invariant living in
    another file. Appending any trailing step there (a re-added validation pass, a
    translation step) would have made this parse a prose output and fail the whole job
    with the generic "failed to parse" error.
    """

    @staticmethod
    def _steps_with_a_trailing_step():
        """The real builder's steps plus one more AFTER synthesis."""
        from shared.prompts import get_persona_generation_steps

        steps = get_persona_generation_steps(2, 'stats', 'feedback')
        return [*steps, {'step_name': 'a_later_step', 'system': '', 'user': '', 'max_tokens': 100}]

    def test_a_trailing_step_does_not_redirect_the_parse(
        self, projects_table, feedback, chain, avatars
    ):
        """The discriminating fixture: synthesis is no longer last, and the `chain`
        fixture answers the trailing step with prose. Positional indexing therefore
        parses prose and raises; by-name still finds the JSON.
        """
        from api.projects import generate_personas

        with patch(
            'api.projects.get_persona_generation_steps',
            return_value=self._steps_with_a_trailing_step(),
        ):
            result = generate_personas('proj-1', {'persona_count': 2})

        assert [p['name'] for p in result['personas']] == ['Ada Lovelace', 'Grace Hopper']

    def test_a_chain_without_the_synthesis_step_fails_naming_the_step(
        self, projects_table, feedback, chain, avatars
    ):
        """Positive control for the lookup: when the step genuinely is not there the
        error names it, rather than surfacing as a generic parse failure. Without this,
        an implementation that silently fell back to results[-1] would still pass the
        test above."""
        from api.projects import generate_personas
        from shared.exceptions import ServiceError

        renamed = [
            {'step_name': 'research_analysis', 'system': '', 'user': '', 'max_tokens': 100},
            {'step_name': 'synthesis_renamed', 'system': '', 'user': '', 'max_tokens': 100},
        ]
        with patch('api.projects.get_persona_generation_steps', return_value=renamed), \
                pytest.raises(ServiceError):
            generate_personas('proj-1', {'persona_count': 2})

        assert projects_table.put_item.call_count == 0


class TestAvatarFailuresAreObservable:
    """A batch of throttled avatars must not look identical to a healthy job.

    Every failure ends as a warning and the job still succeeds, so without a metric
    "all ten personas saved with no avatar" and "all ten avatars fine" are the same
    green run. The counter has to key off the EFFECTIVE outcome: generate_persona_avatar
    catches throttling, AccessDenied, ValidationException and the empty-images case
    itself and RETURNS avatar_url=None, so a counter placed only in the except branch
    reads zero during exactly the outage it exists to catch.
    """

    @staticmethod
    def _counts(mock_metrics):
        counts = {}
        for call in mock_metrics.add_metric.call_args_list:
            counts[call.kwargs['name']] = counts.get(call.kwargs['name'], 0) + call.kwargs['value']
        return counts

    def test_a_returned_none_url_counts_as_a_failure_and_still_saves(
        self, projects_table, feedback, chain
    ):
        """The realistic failure path: no exception, just no URL."""
        from api.projects import generate_personas

        with patch('api.projects.generate_persona_avatar',
                   return_value={'avatar_url': None, 'avatar_prompt': 'p'}), \
                patch('api.projects.metrics') as mock_metrics:
            result = generate_personas('proj-1', {'persona_count': 2})

        assert self._counts(mock_metrics).get('AvatarGenerationFailed') == 2
        # The personas are still saved — only the avatar is missing.
        assert len(result['personas']) == 2
        assert [p['avatar_url'] for p in result['personas']] == [None, None]

    def test_a_successful_avatar_counts_as_a_success(
        self, projects_table, feedback, chain, avatars
    ):
        """Positive control: the counter distinguishes outcomes rather than counting
        every persona as a failure."""
        from api.projects import generate_personas

        with patch('api.projects.metrics') as mock_metrics:
            generate_personas('proj-1', {'persona_count': 2})

        counts = self._counts(mock_metrics)
        assert counts.get('AvatarGenerationSucceeded') == 2
        assert 'AvatarGenerationFailed' not in counts

    def test_a_raising_avatar_call_also_counts(self, projects_table, feedback, chain):
        from api.projects import generate_personas

        with patch('api.projects.generate_persona_avatar',
                   side_effect=RuntimeError('ThrottlingException')), \
                patch('api.projects.metrics') as mock_metrics:
            result = generate_personas('proj-1', {'persona_count': 2})

        assert self._counts(mock_metrics).get('AvatarGenerationFailed') == 2
        assert len(result['personas']) == 2


class TestAWorkerThatCannotStartIsNotFatal:
    """pool.submit() used to sit in a dict comprehension, i.e. outside the per-future
    try, so a RuntimeError("can't start new thread") propagated and discarded EVERY
    persona — the same "finished, billed work thrown away" shape this change set out to
    remove, relocated from the chain to the executor.
    """

    def test_a_submit_failure_still_saves_every_persona(
        self, projects_table, feedback, chain, avatars
    ):
        from api.projects import generate_personas

        class _RefusingPool:
            """Accepts the context-manager protocol, refuses to start work."""

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def submit(self, *args, **kwargs):
                raise RuntimeError("can't start new thread")

        with patch('api.projects.ThreadPoolExecutor', return_value=_RefusingPool()), \
                patch('api.projects.metrics') as mock_metrics:
            result = generate_personas('proj-1', {'persona_count': 2})

        # Both personas survive, without avatars.
        assert len(result['personas']) == 2
        assert [p['avatar_url'] for p in result['personas']] == [None, None]
        assert projects_table.put_item.call_count == 2
        failed = [
            c for c in mock_metrics.add_metric.call_args_list
            if c.kwargs['name'] == 'AvatarGenerationFailed'
        ]
        assert len(failed) == 2


class TestPersonaIdAndTimestampShareOneClock:
    def test_the_id_stamp_matches_created_at_even_in_a_non_utc_timezone(
        self, projects_table, feedback, chain, avatars
    ):
        """The id stamp used to come from a naive datetime.now() (container-local) while
        created_at was UTC, so the two could disagree about the day — and the id names
        the S3 avatar key and sorts.

        The timezone is forced rather than trusted: on a UTC runner both clocks agree
        whatever the implementation does, so without this the test could not fail.
        """
        import os
        import time as time_mod
        from datetime import datetime

        from api.projects import generate_personas

        original_tz = os.environ.get('TZ')
        os.environ['TZ'] = 'Asia/Tokyo'      # UTC+9, no DST — a stable offset
        time_mod.tzset()
        try:
            result = generate_personas('proj-1', {'persona_count': 2})
        finally:
            if original_tz is None:
                del os.environ['TZ']
            else:
                os.environ['TZ'] = original_tz
            time_mod.tzset()

        for persona in result['personas']:
            stamp = persona['persona_id'].split('_')[1]
            expected = datetime.fromisoformat(persona['created_at']).strftime('%Y%m%d%H%M%S')
            assert stamp == expected, (
                f"id stamp {stamp} disagrees with created_at {persona['created_at']} "
                '— they came from different clock readings'
            )
