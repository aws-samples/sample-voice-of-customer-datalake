"""Test support: a fictional Fixer skill and its building blocks."""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime

from engineering.board.test.table import TABLE, engineering_table
from engineering.skills.model import Example, SkillContent
from engineering.skills.store import SkillStore

SONNET, HAIKU = 'global.anthropic.claude-sonnet-5-5', 'global.anthropic.claude-haiku-5-5'
RUN = '01JD0000000000000000000000'
TOOLS = ('read_file', 'list_files', 'write_file', 'run', 'report_progress', 'finish')
INSTRUCTIONS = ('You are the fixer of an autonomous engineering run.\n'
                'Plan the smallest fix that makes the failing test pass.\n'
                '\n'
                'Write the fix and its test in your checkout, then submit your work.')
FLAKY = Example('The failing test passes when run again.', 'Report it as flaky with both runs; do not change code.')
LINT = Example('The linter fails on a file you did not touch.', 'Leave it and say so in your summary.')


def content(instructions: str = INSTRUCTIONS, examples: tuple[Example, ...] = (FLAKY,),
            tools: tuple[str, ...] = TOOLS, model: str = SONNET, harness: str = 'converse') -> SkillContent:
    return SkillContent(instructions, examples, tools, model, harness)


def stricter(base: SkillContent | None = None) -> SkillContent:
    """``base`` with a stricter test rule and one more example: what the coach would write after a NO-GO."""
    base = base or content()
    return replace(base, instructions=base.instructions + '\nRun the package\'s whole test suite before you submit.',
                   examples=(*base.examples, LINT))


def skill_store() -> Iterator[SkillStore]:
    """The skills store on the engineering table under moto, its clock at 2026-11-16: a suite's ``store`` fixture
    (``store = pytest.fixture(skill_store, name='store')``)."""
    with engineering_table() as client:
        yield SkillStore(client, TABLE, now=lambda: datetime(2026, 11, 16, tzinfo=UTC))
