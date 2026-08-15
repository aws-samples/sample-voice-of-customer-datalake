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
import time
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
    table.query.return_value = {'Items': []}
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
    result attached to the wrong persona is visible."""
    def make(persona_data):
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

        def make(persona_data):
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

        def make(persona_data):
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
        with the order persona_synthesis produced."""
        from api.projects import generate_personas

        delays = {'A One': 0.30, 'B Two': 0.15, 'C Three': 0.0}

        def make(persona_data):
            time.sleep(delays[persona_data['name']])
            return {
                'avatar_url': f"s3://bucket/avatars/{persona_data['persona_id']}.jpeg",
                'avatar_prompt': persona_data['name'],
            }

        with patch('api.projects.converse_chain', self._three_persona_chain()), \
             patch('api.projects.generate_persona_avatar', MagicMock(side_effect=make)):
            result = generate_personas('proj-1', {'persona_count': 3})

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

        def make(persona_data):
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
