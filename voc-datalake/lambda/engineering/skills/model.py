"""The ``voc-skill/1`` record: what an agent role is told, shown and allowed, as data, and why a version of it exists.

A skill is a record (the shape the runtime's harness reads with its ``Skill.from_record``): its name (the agent role
it is for), a version number, its instructions (the system prompt), worked examples, its tool policy (the only
tools the harness offers it), the model it was written and measured for, and the harness adapter that runs it.
Every record this module accepts is one the harness accepts too; this module is the stricter of the two (the model
must be in the deployment's allowlist, the texts are bounded, a record holds only its own fields).

Two kinds of field:

- ``instructions`` and ``examples``: the coach (an agent) may propose a change to them.
- ``PERSON_ONLY_FIELDS`` (the tool policy, the model, the harness): a version that changes one is authored by a
  person, never by an agent (the store refuses it).

What is never in a skill at all, so no version of one, by anybody, can change it: the safety and prompt-injection
instructions (the harness adds the platform's own around the skill), the budgets and caps, permissions and
credential scopes, the dial, the stop-at-the-pull-request rule and the gate's bar. A record naming any of them, or
any other field, is refused.
"""
from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from engineering.bus.schema import ULID, WS
from engineering.connectors.identity import AGENT_ROLES
from engineering.runtime.harness.skills import (
    HARNESSES,
    MAX_INSTRUCTIONS,
    RECORD_SCHEMA,
    skill_label,
    skill_record,
)
from shared.model_config import ALLOWED_MODEL_IDS

# The record's shape version (``RECORD_SCHEMA``), the harness adapters (``HARNESSES``, runtime/harness/main.py's
# ``--adapter``), the instructions' length (``MAX_INSTRUCTIONS``) and the record's stored shape (``skill_record``)
# are the harness's own (runtime/harness/skills.py), which ships alone in the agents' images; this module adds the
# store's stricter rules.

#: Lines, so a diff's per-line framing stays small beside the text (the version row's size cap, store.py).
MAX_INSTRUCTION_LINES: Final = 500
MAX_EXAMPLES: Final = 20
MAX_EXAMPLE_TEXT: Final = 2_000
MAX_TOOLS: Final = 32
#: The whole record as stored (UTF-8 JSON): a version row holds it and its diff, far under DynamoDB's 400 KB.
MAX_RECORD_BYTES: Final = 64 * 1024
TOOL_NAME: Final = re.compile(r'[a-z][a-z0-9_]{0,63}\Z')
RECORD_FIELDS: Final = frozenset({'schema', 'name', 'version', 'instructions', 'examples', 'tool_policy', 'model',
                                  'harness'})
#: Changed only in a version a person authored.
PERSON_ONLY_FIELDS: Final = ('tool_policy', 'model', 'harness')
#: Never in a skill: the platform's, a person's or the run's, set where they live, never by a skill version.
NEVER_IN_A_SKILL: Final = frozenset({
    'safety', 'safety_instructions', 'prompt_injection', 'budget', 'budgets', 'caps', 'max_tokens', 'max_cost',
    'permissions', 'credentials', 'credential_scopes', 'dial', 'ai_mode', 'stop_at_pull_request', 'gate_bar'})

#: Why a version was made after a failure (docs/autonomous-engineering.md, "The coach").
FAILURE_KINDS: Final = frozenset({'error', 'timeout', 'no_go', 'repeated_finding', 'pr_rejected', 'heavy_edit'})
MAX_COMMENT: Final = 2_000


class SkillError(ValueError):
    """A skill operation refused: ``kind`` is invalid here, and not_found, forbidden or conflict in the store's
    subclasses (what a REST route answers 400, 404, 403 or 409)."""

    kind = 'invalid'


def _bounded(text: object, what: str, limit: int) -> str:
    if not isinstance(text, str) or not text.strip() or len(text) > limit or '\x00' in text:
        raise SkillError(f'{what} is text of 1-{limit} characters')
    return text


@dataclass(frozen=True)
class Example:
    """One worked example: a situation the agent meets, and what it does."""

    situation: str
    action: str

    def __post_init__(self) -> None:
        _bounded(self.situation, "an example's situation", MAX_EXAMPLE_TEXT)
        _bounded(self.action, "an example's action", MAX_EXAMPLE_TEXT)


@dataclass(frozen=True)
class SkillContent:
    """A skill's content, without its name and version (what a proposal writes; the store numbers it)."""

    instructions: str
    examples: tuple[Example, ...]
    tool_policy: tuple[str, ...]
    model: str
    harness: str

    def __post_init__(self) -> None:
        _bounded(self.instructions, 'the instructions', MAX_INSTRUCTIONS)
        if len(self.instructions.splitlines()) > MAX_INSTRUCTION_LINES:
            raise SkillError(f'the instructions are at most {MAX_INSTRUCTION_LINES} lines')
        if len(self.examples) > MAX_EXAMPLES:
            raise SkillError(f'a skill has at most {MAX_EXAMPLES} examples')
        tools = self.tool_policy
        if not 0 < len(tools) <= MAX_TOOLS or len(set(tools)) != len(tools):
            raise SkillError(f'the tool policy names 1-{MAX_TOOLS} tools, each once')
        if not all(TOOL_NAME.match(name) for name in tools):
            raise SkillError('a tool name is lower case letters, digits and underscores')
        if self.model not in ALLOWED_MODEL_IDS:
            raise SkillError("the model is one of the deployment's allowed models")
        if self.harness not in HARNESSES:
            raise SkillError(f'the harness is one of {sorted(HARNESSES)}')

    def person_fields_changed(self, base: SkillContent | None) -> tuple[str, ...]:
        """The person-only fields this content changes from ``base`` (all of them when there is no base)."""
        if base is None:
            return PERSON_ONLY_FIELDS
        return tuple(name for name in PERSON_ONLY_FIELDS if getattr(self, name) != getattr(base, name))


@dataclass(frozen=True)
class Skill:
    """One version of a role's skill, as the harness runs it."""

    name: str
    version: int
    content: SkillContent

    def __post_init__(self) -> None:
        if self.name not in AGENT_ROLES:
            raise SkillError('a skill is named for an agent role')
        if self.version < 1:
            raise SkillError('a skill has a version number from 1')
        if len(json.dumps(self.to_record()).encode('utf-8')) > MAX_RECORD_BYTES:
            raise SkillError(f'a skill record is at most {MAX_RECORD_BYTES} bytes')

    @property
    def label(self) -> str:
        """``<name>@<version>``: what a session row's ``skill_version`` says (the store's ``SkillVersion.label``
        adds the connection for a connection's own version)."""
        return skill_label(self.name, self.version)

    def to_record(self) -> dict[str, Any]:
        return skill_record(self.name, self.version, self.content)

    @classmethod
    def from_record(cls, record: Mapping[str, Any]) -> Skill:
        if record.get('schema') != RECORD_SCHEMA:
            raise SkillError(f'not a {RECORD_SCHEMA} record')
        never = sorted(NEVER_IN_A_SKILL & set(record))
        if never:
            raise SkillError(f'{", ".join(never)} is never in a skill: a person sets it where it lives')
        unknown, missing = sorted(set(record) - RECORD_FIELDS), sorted(RECORD_FIELDS - set(record))
        if unknown or missing:
            raise SkillError(f'a {RECORD_SCHEMA} record has exactly its fields (unknown: {unknown}, '
                             f'missing: {missing})')
        examples, policy = record['examples'], record['tool_policy']
        if not isinstance(examples, list) or not isinstance(policy, list):
            raise SkillError('examples and tool_policy are lists')
        if not all(isinstance(e, Mapping) and set(e) == {'situation', 'action'} for e in examples):
            raise SkillError('an example is {situation, action}')
        texts = [record['name'], record['instructions'], record['model'], record['harness'], *policy]
        texts += [part for e in examples for part in (e['situation'], e['action'])]
        if not all(isinstance(text, str) for text in texts):
            raise SkillError("a skill record's fields are text as written, never another type")
        if isinstance(record['version'], bool) or not isinstance(record['version'], int):
            raise SkillError('a skill has a version number from 1')
        return cls(record['name'], record['version'], SkillContent(
            instructions=record['instructions'],
            examples=tuple(Example(e['situation'], e['action']) for e in examples),
            tool_policy=tuple(policy), model=record['model'], harness=record['harness']))


@dataclass(frozen=True)
class Reason:
    """Why a version was made: the run and the failure it came from (the coach's), and a person's comment."""

    run_id: str = ''
    failure: str = ''
    comment: str = ''

    def __post_init__(self) -> None:
        if self.run_id and not ULID.match(self.run_id):
            raise SkillError('a run id is a ULID')
        if self.failure and self.failure not in FAILURE_KINDS:
            raise SkillError(f'a failure is one of {sorted(FAILURE_KINDS)}')
        if self.comment:
            _bounded(self.comment, 'a comment', MAX_COMMENT)
        if not (self.run_id or self.failure or self.comment):
            raise SkillError('a version says why it was made: the run and failure, or a comment')

    @property
    def from_a_run(self) -> bool:
        return bool(self.run_id or self.failure)


def _rate(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value) or not 0 <= value <= 1:
        raise SkillError("a benchmark result is a pass rate from 0 to 1")
    return float(value)


@dataclass(frozen=True)
class Benchmark:
    """The agent's benchmark pass rate before and after the version, when it was measured (either may be absent)."""

    before: float | None = None
    after: float | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, 'before', _rate(self.before))
        object.__setattr__(self, 'after', _rate(self.after))


#: A benchmark case's id (``voc-bench/1``, engineering/benchmark/cases.py): lower case letters, digits and hyphens,
#: at most 63, the same shape as a workspace id.
CASE_ID: Final = WS
#: The cases one recorded benchmark names at most, and its reasons (one per case, and the gate's own lines).
MAX_BENCHMARK_CASES: Final = 100
MAX_BENCHMARK_REASONS: Final = MAX_BENCHMARK_CASES + 2
MAX_REASON: Final = 400
#: A recorded benchmark as stored (UTF-8 JSON), so the worst version row with one stays under the store's cap.
MAX_BENCHMARK_BYTES: Final = 40 * 1024


@dataclass(frozen=True)
class BenchmarkRun:
    """A version's benchmark gate, as recorded on it: the pass rates of its base (``before``) and of the version
    (``after``) on the same cases, the gate's verdict and its reasons, and the failure's case it had to gain on
    (``''``: none was named)."""

    before: float
    after: float
    cases: tuple[str, ...]
    passed: bool
    reasons: tuple[str, ...]
    failure_case: str = ''

    def __post_init__(self) -> None:
        before, after = _rate(self.before), _rate(self.after)
        if before is None or after is None:
            raise SkillError('a recorded benchmark has both pass rates')
        object.__setattr__(self, 'before', before)
        object.__setattr__(self, 'after', after)
        cases = self.cases
        if not 0 < len(cases) <= MAX_BENCHMARK_CASES or len(set(cases)) != len(cases):
            raise SkillError(f'a recorded benchmark names 1-{MAX_BENCHMARK_CASES} cases, each once')
        if not all(CASE_ID.match(case) for case in cases):
            raise SkillError('a case id is lower case letters, digits and hyphens')
        if self.failure_case and self.failure_case not in cases:
            raise SkillError("the failure's case is one of the benchmark's cases")
        if not 0 < len(self.reasons) <= MAX_BENCHMARK_REASONS:
            raise SkillError(f'a recorded benchmark says why in 1-{MAX_BENCHMARK_REASONS} reasons')
        for reason in self.reasons:
            _bounded(reason, "a benchmark's reason", MAX_REASON)
        if len(self.stored_json().encode('utf-8')) > MAX_BENCHMARK_BYTES:
            raise SkillError(f'a recorded benchmark is at most {MAX_BENCHMARK_BYTES} bytes')

    @property
    def gained(self) -> bool:
        """The gate passed with a gain on a named failure's case: what accepting a coach's version needs."""
        return self.passed and bool(self.failure_case)

    def stored_json(self, **extra: str) -> str:
        """The record as the store writes it, with ``extra`` fields (when and who): sorted keys, non-ASCII text as
        itself (UTF-8 in the row, which is what DynamoDB counts), so the bound is measured as the row is stored."""
        return json.dumps({**self.to_json(), **extra}, sort_keys=True, ensure_ascii=False)

    def to_json(self) -> dict[str, Any]:
        return {'before': self.before, 'after': self.after, 'cases': list(self.cases), 'passed': self.passed,
                'reasons': list(self.reasons), 'failure_case': self.failure_case}

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> BenchmarkRun:
        if set(data) != {'before', 'after', 'cases', 'passed', 'reasons', 'failure_case'}:
            raise SkillError('a recorded benchmark has exactly its fields')
        cases, reasons, passed = data['cases'], data['reasons'], data['passed']
        texts = [*cases, *reasons, data['failure_case']] if isinstance(cases, list) and isinstance(reasons, list) else [0]
        if not all(isinstance(text, str) for text in texts) or not isinstance(passed, bool):
            raise SkillError("a recorded benchmark's cases and reasons are lists of text, its verdict true or false")
        return cls(before=data['before'], after=data['after'], cases=tuple(cases), passed=passed,
                   reasons=tuple(reasons), failure_case=data['failure_case'])
