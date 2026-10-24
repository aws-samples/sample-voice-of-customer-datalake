"""Mutation hardening for `agents/conductor/planning.py`.

`test_runtime_units.py` pinned that a reuse of an editable project is kept, that
any other reuse (not editable, someone else's public project, hallucinated)
becomes a create, that a bad answer falls back to the first line of the
aggregate, and that the brief falls back to text containing ``BLOCKING``. A
mutation run found unobserved:

* ``reusable`` — a non-dict or an absent ``access`` is refused, each of the three
  grounds (created by this agent, owned by its owner, private share) admits on
  its own, and an empty owner ``sub`` never matches an empty ``owner_sub``;
* ``decide_project`` — the 30-candidate cap, each candidate line (its fields, the
  120 / 300 / 500 clips, absent fields printed empty), the ``(no projects)``
  placeholder, the prompt's block order, tags and clips, the system prompt, the
  800-token budget and step name, the WHOLE fallback (``Agent research`` for an
  empty first line, the 120 / 500 / 1,000 clips, ``default: new project``), a
  ``create`` that never carries a project id, and the 120 / 1,000 / 2,000 / 300
  clips and fallbacks of a well-formed answer;
* ``objections_text`` — the exact line format (``BLOCKING`` tag, name or persona
  id, score), the 400-character objection clip, skipped non-dict verdicts and
  non-string / blank objections, and the 6,000-character total clip;
* ``revision_brief`` — the exact prompt, system prompt, 900-token budget and step
  name, and the 4,000-character clip of a stripped brief (``None`` or blank
  falls back to the objections).

Every expectation here is the literal string, number or dict the module emits.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from agents import context_blocks
from agents.conductor import planning

AGENT = {'agent_id': 'ag_1', 'owner_sub': 'owner-1'}
OWN = {'project_id': 'p1', 'name': 'Checkout', 'description': 'Slow pay', 'purpose': 'checkout friction',
       'access': {'can_edit': True}, 'created_by_agent': 'ag_1', 'visibility': 'public'}
PROJECT_SYSTEM = (
    'You are the conductor of an autonomous product-research crew. Decide whether the problems '
    'belong to one of the existing projects (reuse) or need a new project (create). Reuse only when '
    "the project's purpose clearly covers these problems. Answer with ONE JSON object: "
    '{"action": "reuse"|"create", "project_id": str|null, "name": str, "description": str, '
    '"purpose": str, "reason": str}. "purpose" states what the project is about and which '
    'categories/problems it covers (for a reused project: its updated purpose). '
    + context_blocks.DATA_NOTICE
)
BRIEF_SYSTEM = (
    'You are the conductor of a product crew. Synthesise the persona panel objections into a short, '
    'actionable revision brief for the writer: what must change, what must stay, ranked by how many '
    'personas raised it and whether it was blocking. Plain text, at most 12 bullet points. '
    + context_blocks.DATA_NOTICE
)
LONG_FIRST_LINE = 'L' * 130
LONG_AGGREGATE = LONG_FIRST_LINE + '\n' + 'a' * 1200


def _wrap(tag: str, text: str, limit: int) -> str:
    """A visible stand-in for ``context_blocks.wrap``: the tag, the clip and the raw text."""
    return f'<{tag}:{limit}>{text}</{tag}>'


@pytest.fixture
def ask() -> Iterator[MagicMock]:
    with (
        patch.object(planning.context_blocks, 'wrap', side_effect=_wrap),
        patch.object(planning.llm, 'ask', return_value='') as mock,
    ):
        yield mock


def _decide(ask: MagicMock, answer: Any, candidates: list[dict], aggregate: str = 'Slow checkout\nmore') -> dict:
    ask.return_value = answer
    return planning.decide_project(AGENT, 'ar_1', aggregate, candidates, 'do it')


def _fallback(aggregate: str, name: str) -> dict[str, Any]:
    return {'action': 'create', 'project_id': None, 'name': name, 'description': aggregate[:500],
            'purpose': aggregate[:1000], 'reason': 'default: new project'}


class TestOnlyTheAgentsOwnBusinessIsReusable:
    @pytest.mark.parametrize('project', [
        'p1', None, {'access': None, 'created_by_agent': 'ag_1'},
        {'access': {'can_edit': False}, 'created_by_agent': 'ag_1'},
        {'access': {}, 'created_by_agent': 'ag_1'},
    ])
    def test_a_non_dict_or_a_non_editable_project_is_refused(self, project: object):
        assert planning.reusable(project, AGENT) is False

    @pytest.mark.parametrize('extra', [
        {'created_by_agent': 'ag_1'},
        {'owner': {'sub': 'owner-1'}},
        {'visibility': 'private'},
    ])
    def test_each_ground_admits_on_its_own(self, extra: dict):
        project = {'access': {'can_edit': True}, 'visibility': 'public', **extra}
        assert planning.reusable(project, AGENT) is True

    @pytest.mark.parametrize('extra', [
        {'created_by_agent': 'ag_2'},
        {'owner': {'sub': 'owner-2'}},
        {'owner': 'owner-1'},
        {},
    ])
    def test_another_agent_or_owner_on_a_public_project_is_refused(self, extra: dict):
        project = {'access': {'can_edit': True}, 'visibility': 'public', **extra}
        assert planning.reusable(project, AGENT) is False

    def test_an_empty_owner_sub_never_matches_an_agent_without_one(self):
        project = {'access': {'can_edit': True}, 'visibility': 'public', 'owner': {'sub': ''},
                   'created_by_agent': 'ag_1'}
        agent = {'agent_id': 'ag_other', 'owner_sub': ''}
        assert planning.reusable(project, agent) is False


class TestTheProjectDecisionPrompt:
    def test_the_prompt_lists_each_editable_candidate_line_with_its_clips(self, ask: MagicMock):
        bare = {'project_id': 'p2', 'access': {'can_edit': True}, 'visibility': 'private'}
        long = {'project_id': 'p3', 'name': 'n' * 130, 'description': 'd' * 310, 'purpose': 'u' * 510,
                'access': {'can_edit': True}, 'visibility': 'private'}
        hidden = {'project_id': 'p4', 'name': 'Hidden', 'access': {'can_edit': False}}
        _decide(ask, '', [OWN, hidden, bare, long])
        lines = ('- id=p1 | name=Checkout | description=Slow pay | purpose=checkout friction\n'
                 '- id=p2 | name= | description= | purpose=\n'
                 f"- id=p3 | name={'n' * 120} | description={'d' * 300} | purpose={'u' * 500}")
        ask.assert_called_once_with(
            AGENT, 'ar_1', 'orchestrator',
            '<conductor_message:4000>do it</conductor_message>\n\n'
            '<reviews:6000>Slow checkout\nmore</reviews>\n\n'
            f'<artifact:20000>{lines}</artifact>\n\n'
            'Return the JSON object now.',
            system_prompt=PROJECT_SYSTEM, max_tokens=800, step_name='agent_decide_project')

    def test_no_editable_candidate_reads_no_projects(self, ask: MagicMock):
        _decide(ask, '', [])
        assert ask.call_args.args[3] == (
            '<conductor_message:4000>do it</conductor_message>\n\n'
            '<reviews:6000>Slow checkout\nmore</reviews>\n\n'
            '<artifact:20000>(no projects)</artifact>\n\n'
            'Return the JSON object now.')

    def test_at_most_thirty_candidates_are_offered_and_reusable(self, ask: MagicMock):
        candidates = [{**OWN, 'project_id': f'p{n}'} for n in range(31)]
        _decide(ask, '{"action": "reuse", "project_id": "p30"}', candidates)
        artifact = ask.call_args.args[3].split('<artifact:20000>')[1].split('</artifact>')[0]
        assert [line.split(' | ')[0] for line in artifact.split('\n')] == [f'- id=p{n}' for n in range(30)]
        assert _decide(ask, '{"action": "reuse", "project_id": "p30"}', candidates)['action'] == 'create'
        assert _decide(ask, '{"action": "reuse", "project_id": "p29"}', candidates)['project_id'] == 'p29'


class TestABadAnswerFallsBackToTheWholeDefault:
    @pytest.mark.parametrize('answer', ['', 'garbage', '{}', '{"action": "merge", "name": "M", "reason": "r"}'])
    def test_the_fallback_is_a_new_project_from_the_aggregate(self, ask: MagicMock, answer: str):
        assert _decide(ask, answer, [OWN], LONG_AGGREGATE) == _fallback(LONG_AGGREGATE, 'L' * 120)

    @pytest.mark.parametrize('aggregate', ['', '\nsecond line'])
    def test_an_empty_first_line_is_named_agent_research(self, ask: MagicMock, aggregate: str):
        assert _decide(ask, 'garbage', [], aggregate) == _fallback(aggregate, 'Agent research')


class TestAWellFormedAnswerIsBounded:
    def test_a_reuse_keeps_the_id_and_clips_every_field(self, ask: MagicMock):
        answer = json.dumps({'action': 'reuse', 'project_id': 'p1', 'name': 'n' * 130, 'description': 'd' * 1100,
                             'purpose': 'u' * 2100, 'reason': 'r' * 310})
        assert _decide(ask, answer, [OWN]) == {
            'action': 'reuse', 'project_id': 'p1', 'name': 'n' * 120, 'description': 'd' * 1000,
            'purpose': 'u' * 2000, 'reason': 'r' * 300}

    def test_a_create_drops_the_id_and_falls_back_field_by_field(self, ask: MagicMock):
        answer = '{"action": "create", "project_id": "p1", "name": "", "description": null}'
        assert _decide(ask, answer, [OWN], LONG_AGGREGATE) == {
            'action': 'create', 'project_id': None, 'name': 'L' * 120, 'description': LONG_AGGREGATE[:500],
            'purpose': LONG_AGGREGATE[:1000], 'reason': ''}

    def test_a_reuse_of_an_unoffered_id_becomes_a_create_with_the_answers_fields(self, ask: MagicMock):
        answer = '{"action": "reuse", "project_id": "p9", "name": "N", "description": "D", "purpose": "P", "reason": "R"}'
        assert _decide(ask, answer, [OWN]) == {
            'action': 'create', 'project_id': None, 'name': 'N', 'description': 'D', 'purpose': 'P', 'reason': 'R'}


VERDICTS: list[Any] = [
    {'name': 'Ana', 'persona_id': 'pa', 'score': 2, 'blocking': True, 'objections': ['  Too long  ', 7, '   ']},
    'not a verdict',
    {'persona_id': 'pb', 'score': 4, 'blocking': False, 'objections': ['Fine', 'x' * 410]},
    {'name': 'Cy', 'objections': None},
    {'name': '', 'persona_id': 'pd', 'objections': ['No score']},
]
OBJECTIONS = ('- BLOCKING [Ana, score 2] Too long\n'
              '- [pb, score 4] Fine\n'
              f"- [pb, score 4] {'x' * 400}\n"
              '- [pd, score None] No score')


class TestTheObjectionList:
    def test_each_objection_is_one_tagged_line(self):
        assert planning.objections_text(VERDICTS) == OBJECTIONS

    def test_the_list_is_clipped_to_six_thousand_characters(self):
        text = planning.objections_text([{'name': 'A', 'score': 1, 'objections': ['y' * 400] * 20}])
        assert text == '\n'.join([f"- [A, score 1] {'y' * 400}"] * 20)[:6000]
        assert len(text) == 6000


class TestTheRevisionBrief:
    def test_the_brief_prompt_budget_and_step_are_the_literals(self, ask: MagicMock):
        ask.return_value = '  - Shorten it  '
        assert planning.revision_brief(AGENT, 'ar_1', 'prfaq', VERDICTS) == '- Shorten it'
        ask.assert_called_once_with(
            AGENT, 'ar_1', 'orchestrator',
            'The persona panel reviewed the prfaq. Their objections:\n\n'
            f'<artifact:6000>{OBJECTIONS}</artifact>\n\n'
            'Write the revision brief now.',
            system_prompt=BRIEF_SYSTEM, max_tokens=900, step_name='agent_revision_brief')

    def test_the_brief_is_clipped_to_four_thousand_characters(self, ask: MagicMock):
        ask.return_value = ' ' + 'b' * 4100
        assert planning.revision_brief(AGENT, 'ar_1', 'prfaq', VERDICTS) == 'b' * 4000

    @pytest.mark.parametrize('brief', [None, '   '])
    def test_no_brief_falls_back_to_the_objections(self, ask: MagicMock, brief: str | None):
        ask.return_value = brief
        assert planning.revision_brief(AGENT, 'ar_1', 'prfaq', VERDICTS) == OBJECTIONS

    def test_no_objection_costs_no_call(self, ask: MagicMock):
        assert planning.revision_brief(AGENT, 'ar_1', 'prfaq', [{'objections': ['  ', 7]}]) == ''
        ask.assert_not_called()
