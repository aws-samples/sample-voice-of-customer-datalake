"""The model's answer, read strictly: new instructions and examples, a short why, the expected case. Never run.

The answer is one JSON object (a code fence around it allowed), decoded with ``json.loads`` and nothing else: never
``eval``, nested at most ``MAX_DEPTH`` brackets deep (checked before decoding, so a deeply nested answer is refused,
never a crash), and a key given twice is refused rather than one of its values silently kept. It holds exactly
``instructions``, ``examples``, ``why`` and ``expected_case``. Anything else is refused with a plain reason, before
anything is written:

- a key named for a field of the skill only a person changes (``tool_policy``, ``model``, ``harness``), or for one
  that is never in a skill (budgets and caps, the dial, permissions and credentials, the safety instructions:
  ``NEVER_IN_A_SKILL``);
- text about one of tenet 3's never-by-an-agent topics (``FORBIDDEN_TOPICS``: a budget or a cap, the dial,
  permissions or credentials, safety or prompt-injection instructions, merging or marking a pull request ready, the
  gate's bar, the harness or the tool policy, a model) that the answer adds or removes: an instruction line or
  example text it adds or drops (case and spacing aside), a mention gained or lost in the whole skill read as one
  text with its spacing collapsed (so a topic split across lines counts), or a mention in the why. The reason names
  the topic and where, never the text;
- a malformed field, an expected case that is not one of the benchmark's, or an answer that changes nothing.

The topic check is a filter, not the gate: it catches the plain cases cheaply, and a reworded one can pass it. What
holds a version back is an administrator's review and its benchmark (``SkillStore.accept_version``).

What it keeps has every credential-shaped string replaced (``quality_gate.text.redact``), as the evidence had.

The skills store refuses the person-only fields and the never-in-a-skill ones too (the coach keeps the current
skill's tool policy, model and harness as they are); the coach refuses them first, and alone refuses the topics.
"""
from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Any, Final, NoReturn

from engineering.coach.failure import CoachError
from engineering.quality_gate.text import redact
from engineering.skills.model import (
    MAX_EXAMPLE_TEXT,
    MAX_EXAMPLES,
    NEVER_IN_A_SKILL,
    PERSON_ONLY_FIELDS,
    Example,
    SkillContent,
    SkillError,
    normalised,
)
from shared.model_config import ALLOWED_MODEL_IDS

ANSWER_FIELDS: Final = frozenset({'instructions', 'examples', 'why', 'expected_case'})
MAX_WHY: Final = 400
#: The answer as text: the largest skill's instructions and examples, JSON-escaped, with room to spare.
MAX_ANSWER_CHARS: Final = 256 * 1024
#: Bracket nesting an answer may have: it needs three (the object, its examples, an example).
MAX_DEPTH: Final = 8

_WORD = r'(?<![a-z0-9_])'
_END = r'(?![a-z0-9_])'


def _words(*patterns: str) -> re.Pattern[str]:
    return re.compile('|'.join(f'{_WORD}(?:{pattern}){_END}' for pattern in patterns), re.IGNORECASE)


#: What an agent never changes (TENETS.md, tenet 3; docs/autonomous-engineering.md, "The coach"), by topic: text the
#: coach's answer adds or removes about one of them is refused. Matched on whole words, case aside, and broadly on purpose: a
#: false refusal costs one proposal (a person can write that version), a missed one would reach an administrator.
FORBIDDEN_TOPICS: Final[Sequence[tuple[str, re.Pattern[str]]]] = (
    ('a budget or a cap', _words(r'budgets?', r'caps?', r'capped', r'max_tokens', r'max_cost', r'spend(?:ing)? limits?',
                                 r'(?:token|cost|turn) limits?', r'quotas?')),
    ('the dial', _words(r'the dial', r'ai[ _-]?mode', r'human-driven', r'ai-assisted', r'ai-driven')),
    ('permissions or credentials', _words(r'permissions?', r'credentials?', r'credential scopes?', r'iam',
                                          r'access keys?', r'secrets?', r'sudo', r'privileges?')),
    ('the safety instructions', _words(r'safety (?:instructions?|rules?|text|polic(?:y|ies))', r'the safety',
                                       r'prompt[ -]?injections?', r'guardrails?', r'jailbreak\w*',
                                       r'system prompt', r'ignore (?:all |any |the )?(?:previous|prior|earlier|above) '
                                       r'(?:instructions|rules)')),
    ('the stop-at-the-pull-request rule', _words(r'merg(?:e|es|ed|ing) (?:the |a |this |its |your )?'
                                                 r'(?:pull request|pr|change|branch)', r'auto-?merg\w*',
                                                 r'ready for review', r'mark\w* (?:it|the pull request|the pr) ready',
                                                 r'force[ -]push\w*')),
    ("the gate's bar", _words(r"(?:the )?gate'?s? bar", r'(?:skip|bypass|disable|lower|weaken)\w* (?:the )?'
                              r'(?:quality )?(?:gate|checks?|reviews?|review rounds?)', r'no-verify')),
    # "The test harness" is a repository's own: only the agents' harness is the platform's.
    ('the harness or the tool policy', _words(r"(?:the|your|its|an agent's|the agents') harness(?:es)?",
                                              r'harness adapters?', r'tool[ _]polic(?:y|ies)')),
    ('the model', _words(*(re.escape(model) for model in sorted(ALLOWED_MODEL_IDS)),
                         r'(?:another|a different|a bigger|a smaller|a cheaper) model')),
)


@dataclass(frozen=True)
class CoachAnswer:
    """What the model proposed, checked: the role's new instructions and examples, why, and the case it expects
    to gain on."""

    instructions: str
    examples: tuple[Example, ...]
    why: str
    expected_case: str

    def content(self, current: SkillContent) -> SkillContent:
        """The proposed skill: ``current`` with these instructions and examples, its tool policy, model and harness
        kept as they are."""
        return replace(current, instructions=self.instructions, examples=self.examples)


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    keys = [key for key, _ in pairs]
    if len(set(keys)) != len(keys):
        raise CoachError('the answer names a key twice')
    return dict(pairs)


def _depth(body: str) -> int:
    """How deep ``body``'s brackets nest, strings aside: an answer is at most three deep (the object, its examples,
    an example), so anything far deeper is refused before the decoder recurses into it."""
    depth = deepest = 0
    in_string = escaped = False
    for char in body:
        if in_string:
            escaped, in_string = (False, True) if escaped else (char == '\\', char != '"')
        elif char == '"':
            in_string = True
        elif char in '[{':
            depth += 1
            deepest = max(deepest, depth)
        elif char in ']}':
            depth -= 1
    return deepest


def _decoded(text: object) -> dict[str, Any]:
    if not isinstance(text, str) or len(text) > MAX_ANSWER_CHARS:
        raise CoachError(f'the answer is text of at most {MAX_ANSWER_CHARS} characters')
    body = text.strip()
    if body.startswith('```'):
        body = body.split('\n', 1)[1] if '\n' in body else ''
        body = body.removesuffix('```').strip()
    if _depth(body) > MAX_DEPTH:
        raise CoachError(f'the answer nests deeper than {MAX_DEPTH} levels: it is one object of four fields')
    try:
        data = json.loads(body, object_pairs_hook=_no_duplicates)
    except ValueError as exc:   # json.JSONDecodeError, and CoachError from the hook
        raise CoachError(f'the answer is not one JSON object: {exc}') from exc
    except RecursionError as exc:   # the depth check's backstop: no answer escapes as a crash
        raise CoachError('the answer nests too deep to read') from exc
    if not isinstance(data, dict):
        raise CoachError('the answer is a JSON object')
    return data


def _check_fields(data: dict[str, Any]) -> None:
    person = sorted(set(PERSON_ONLY_FIELDS) & set(data))
    if person:
        raise CoachError(f'the answer would change {", ".join(person)}: only a person changes it, and the coach '
                         'proposes instructions and examples only')
    never = sorted(NEVER_IN_A_SKILL & set(data))
    if never:
        raise CoachError(f'the answer names {", ".join(never)}, which is never in a skill: a person sets it where it '
                         'lives')
    unknown, missing = sorted(set(data) - ANSWER_FIELDS), sorted(ANSWER_FIELDS - set(data))
    if unknown or missing:
        raise CoachError(f'the answer has exactly {sorted(ANSWER_FIELDS)} (unknown: {unknown}, missing: {missing})')


def _examples(raw: object) -> tuple[Example, ...]:
    if not isinstance(raw, list) or len(raw) > MAX_EXAMPLES:
        raise CoachError(f'the examples are a list of at most {MAX_EXAMPLES}')
    examples: list[Example] = []
    for n, item in enumerate(raw, 1):
        if not isinstance(item, dict) or set(item) != {'situation', 'action'}:
            raise CoachError(f'example {n} is {{situation, action}}')
        situation, action = item['situation'], item['action']
        if not isinstance(situation, str) or not isinstance(action, str):
            raise CoachError(f"example {n}'s situation and action are text")
        if max(len(situation), len(action)) > MAX_EXAMPLE_TEXT:
            raise CoachError(f"example {n}'s situation and action are at most {MAX_EXAMPLE_TEXT} characters each")
        examples.append(_example(n, redact(situation), redact(action)))
    return tuple(examples)


def _example(n: int, situation: str, action: str) -> Example:
    try:
        return Example(situation, action)
    except SkillError as exc:
        raise CoachError(f'example {n} is refused: {exc}') from exc


def _texts(instructions: str, examples: Sequence[Example]) -> list[tuple[str, str]]:
    """Each instruction line and example text of a skill, with where it is."""
    found = [(f'instruction line {n}', line) for n, line in enumerate(instructions.splitlines(), 1)]
    found += [(f"example {n}'s {part}", text) for n, example in enumerate(examples, 1)
              for part, text in (('situation', example.situation), ('action', example.action))]
    return found


def _only_in(texts: list[tuple[str, str]], others: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """The texts that ``others`` do not hold, case and spacing aside."""
    held = {normalised(text) for _, text in others}
    return [(where, text) for where, text in texts if normalised(text) not in held]


def _topic(text: str) -> str:
    return next((topic for topic, pattern in FORBIDDEN_TOPICS if pattern.search(text)), '')


def _mentions(texts: list[tuple[str, str]]) -> dict[str, int]:
    """How often each topic is written about in all of ``texts`` read as one, spacing collapsed: a topic split over
    two lines (or an instruction and an example) counts."""
    whole = ' '.join(' '.join(text.split()) for _, text in texts)
    return {topic: sum(1 for _ in pattern.finditer(whole)) for topic, pattern in FORBIDDEN_TOPICS}


def _refuse_topic(what: str, topic: str, where: str) -> NoReturn:
    raise CoachError(f'the answer {what} text about {topic} ({where}): an agent never changes it, only a person '
                     'does, where it lives')


def _check_topics(answer: CoachAnswer, current: SkillContent) -> None:
    """Text about a never-by-an-agent topic is neither added nor removed: each line and example text the answer
    adds or drops, then the whole of each skill (so a topic split across lines is caught), then the why."""
    new, old = _texts(answer.instructions, answer.examples), _texts(current.instructions, current.examples)
    for what, texts in (('adds', _only_in(new, old)), ('removes', _only_in(old, new))):
        for where, text in texts:
            topic = _topic(text)
            if topic:
                _refuse_topic(what, topic, where if what == 'adds' else f'the current skill\'s {where}')
    now, before = _mentions(new), _mentions(old)
    for topic, count in now.items():
        if count != before[topic]:
            _refuse_topic('adds' if count > before[topic] else 'removes', topic, 'across lines')
    topic = _topic(answer.why)
    if topic:
        _refuse_topic('gives a why with', topic, 'the why')


def read_answer(text: object, current: SkillContent, cases: Sequence[str]) -> CoachAnswer:
    """The model's ``text`` as a checked answer for a role whose skill is ``current``, its expected case one of the
    benchmark's ``cases``; CoachError with the reason it is refused."""
    data = _decoded(text)
    _check_fields(data)
    instructions, why, case = data['instructions'], data['why'], data['expected_case']
    if not isinstance(instructions, str) or not instructions.strip():
        raise CoachError('the instructions are text')
    if not isinstance(why, str) or not why.strip() or len(why) > MAX_WHY or '\n' in why.strip():
        raise CoachError(f'the why is one paragraph of 1-{MAX_WHY} characters')
    if not isinstance(case, str) or case not in cases:
        raise CoachError("the expected case is one of the benchmark's case ids")
    # The model read redacted evidence; whatever credential-shaped text it writes anyway is replaced too.
    answer = CoachAnswer(redact(instructions), _examples(data['examples']), redact(why.strip()), case)
    _check_topics(answer, current)
    proposed = _content(answer, current)
    if proposed == current:
        raise CoachError('the answer changes nothing in the skill')
    return answer


def _content(answer: CoachAnswer, current: SkillContent) -> SkillContent:
    try:
        return answer.content(current)
    except SkillError as exc:   # the record's own bounds: the instructions' length and lines
        raise CoachError(f'the proposed skill is refused: {exc}') from exc
