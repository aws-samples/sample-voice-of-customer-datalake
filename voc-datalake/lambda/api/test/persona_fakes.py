"""A stand-in for ``converse_detailed`` that answers persona generation's calls.

Persona generation makes one analysis call, one plan call, then one call per
planned persona (run in parallel). The fake answers each by its ``step_name``
and reads the planned name a persona call was given back out of its prompt, so
a test can drive the real orchestration end to end without Bedrock.
"""
import json
import re
import threading
from collections.abc import Callable

import projects
from shared.converse import ConverseResult
from shared.test.converse_fixtures import CHAIN_MODEL_ID

ANALYSIS_STEP = 'research_analysis'
PLAN_STEP = 'persona_plan'
PERSONA_STEP = 'persona_synthesis'

_ASSIGNED = re.compile(
    r'## YOUR PERSONA \(from the plan\)\nWrite exactly this persona, under exactly this full name:\n(\{.*\})\n'
)


def persona(name: str) -> dict:
    """One persona in the shape a persona call emits, with every key generate_personas reads."""
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


def plan_output(names: list[str]) -> str:
    """A plan call's answer naming *names*, in order."""
    return json.dumps([
        {'name': name, 'archetype': f'The {name} type', 'segment': f'Segment {i}', 'evidence': f'Review #{i}'}
        for i, name in enumerate(names, 1)
    ])


def assigned_name(prompt: str) -> str:
    """The planned name a persona call's prompt assigns ('' when it assigns none)."""
    match = _ASSIGNED.search(prompt)
    return json.loads(match.group(1))['name'] if match else ''


# Answers one persona call: (assigned name, attempt number from 1) -> text, or raise.
PersonaAnswer = Callable[[str, int], str]


class FakePersonaModel:
    """Answers analysis / plan / persona calls; records every call (thread-safe)."""

    def __init__(
        self, names: list[str], *, analysis: str = 'research_analysis prose output',
        plan: str | list[str] | None = None, persona_answer: PersonaAnswer | None = None,
        model_id: str = CHAIN_MODEL_ID, persona_model_id: str | None = None,
    ):
        """``plan`` is one answer for every plan call, or a list answered in order."""
        self.analysis = analysis
        plan_answers = plan_output(names) if plan is None else plan
        self._plan_answers = [plan_answers] if isinstance(plan_answers, str) else list(plan_answers)
        self.persona_answer = persona_answer
        self.model_id = model_id
        self.persona_model_id = persona_model_id or model_id
        self.calls: list[dict] = []
        self._attempts: dict[str, int] = {}
        self._lock = threading.Lock()

    def __call__(self, **kwargs) -> ConverseResult:
        step = kwargs.get('step_name', '')
        with self._lock:
            self.calls.append(kwargs)
        if step == ANALYSIS_STEP:
            return ConverseResult(text=self.analysis, model_id=self.model_id)
        if step == PLAN_STEP:
            with self._lock:
                text = self._plan_answers.pop(0) if len(self._plan_answers) > 1 else self._plan_answers[0]
            return ConverseResult(text=text, model_id=self.model_id)
        name = assigned_name(kwargs.get('prompt', ''))
        with self._lock:
            attempt = self._attempts[name] = self._attempts.get(name, 0) + 1
        text = self.persona_answer(name, attempt) if self.persona_answer else json.dumps(persona(name))
        return ConverseResult(text=text, model_id=self.persona_model_id)

    def prompts(self, step: str) -> list[str]:
        """The user prompt of every call made for *step*, in call order."""
        return [call.get('prompt', '') for call in self.calls if call.get('step_name') == step]

    def attempts(self, name: str) -> int:
        """How many persona calls were made for the planned *name*."""
        return self._attempts.get(name, 0)


def one_item_corpus() -> projects._PersonaCorpus:
    """A one-review corpus, enough for generate_personas to run its real chain against the fake."""
    return projects._PersonaCorpus(
        items=[{'feedback_id': 'fb-1', 'source_platform': 'webscraper'}], context='CTX', stats='STATS',
        context_budget=5000, fetch_limit=40, fetch_limit_reached=False, corpus_chars=10, char_cap_applied=False,
    )
