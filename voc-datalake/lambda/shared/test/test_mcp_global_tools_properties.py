"""Property tests of the global MCP server's tool names and their routing (shared/mcp_global_tools.py).

A client calls a tool by the name it saw in tools/list, and an old client calls it by a name from before
6.10.00. These check the routing over many names and argument shapes, in words a person would use:

- Every name a client can see is one tool, and it runs with the arguments it was sent, untouched.
- A name from before 6.10.00 runs the tool it was renamed to, with the same arguments; the one old call
  that was two things (``generate`` with ``step: revise``) runs the tool it became, minus its old keys.
- A name nobody has ever listed runs nothing.

The fixed catalogue (names unique, renamed names listed, each declaration exact) is pinned by
test_mcp_global_tools_mutation.py; these are the generated-input rules only.
"""
from __future__ import annotations

from hypothesis import assume, given
from hypothesis import strategies as st

from shared import mcp_global_tools as tools
from shared.mcp_global_tools_steps import LEGACY_REVISE_STEP, TOOL_MARK_ADDRESSED, TOOL_REVISE
from shared.test.property_settings import PROPERTY

LISTED_NAMES = sorted(tools.TOOLS_BY_NAME)
ARGUMENT_KEYS = ['step', 'mark_addressed', 'title', 'project_id', 'content', 'document_id', 'limit']
ARGUMENT_VALUES = st.one_of(
    st.none(), st.booleans(), st.integers(min_value=-3, max_value=3), st.text(max_size=8),
    st.lists(st.integers(), max_size=2), st.sampled_from([LEGACY_REVISE_STEP, 'outline', 'draft']),
)
ARGUMENTS = st.dictionaries(st.sampled_from(ARGUMENT_KEYS), ARGUMENT_VALUES, max_size=6)


class TestEveryListedNameRunsItsOwnToolWithItsOwnArguments:
    """Invariant: each name in tools/list is one tool, unique, and a call to it runs that tool with the
    arguments it sent, the same object, never rewritten."""

    @PROPERTY
    @given(name=st.sampled_from(LISTED_NAMES), arguments=st.one_of(ARGUMENTS, st.text(max_size=5), st.none()))
    def test_a_listed_name_runs_that_tool_with_the_same_arguments(self, name: str, arguments: object) -> None:
        resolved = tools.resolve_tool(name, arguments)
        assert resolved is not None
        tool, passed = resolved
        assert tool.name == name
        assert passed is arguments


class TestARenamedNameRunsItsNewTool:
    """Invariant: every name from before 6.10.00 resolves to a tool that is listed now, with the same
    arguments; the only exception is ``generate`` with ``step: revise``, which is split by its
    ``mark_addressed`` key (the legacy_revise rule)."""

    @PROPERTY
    @given(old=st.sampled_from(sorted(tools.RENAMED)), arguments=ARGUMENTS)
    def test_a_renamed_call_runs_the_new_tool_with_the_same_arguments(self, old: str, arguments: dict) -> None:
        resolved = tools.resolve_tool(old, arguments)
        assert resolved is not None
        tool, passed = resolved
        if old == 'generate' and arguments.get('step') == LEGACY_REVISE_STEP:
            expected_name = TOOL_MARK_ADDRESSED if arguments.get('mark_addressed') is not None else TOOL_REVISE
            kept = {key: value for key, value in arguments.items() if key not in ('step', 'mark_addressed')}
            expected_args = (
                {**kept, 'addressed': arguments['mark_addressed']}
                if arguments.get('mark_addressed') is not None else kept
            )
            assert tool.name == expected_name
            assert passed == expected_args
        else:
            assert tool.name == tools.RENAMED[old]
            assert passed is arguments

    @PROPERTY
    @given(arguments=ARGUMENTS)
    def test_the_old_generate_keeps_its_other_steps_on_generate(self, arguments: dict) -> None:
        assume(arguments.get('step') != LEGACY_REVISE_STEP)
        resolved = tools.resolve_tool('generate', arguments)
        assert resolved is not None
        tool, passed = resolved
        assert tool.name == 'projects_generate'
        assert passed is arguments


class TestANameNobodyListedRunsNothing:
    """Invariant: a name that is neither listed nor an old name resolves to no tool, and so does a
    name that is not text at all."""

    @PROPERTY
    @given(name=st.text(max_size=24).filter(lambda s: s not in tools.TOOLS_BY_NAME and s not in tools.RENAMED),
           arguments=ARGUMENTS)
    def test_an_unknown_text_name_resolves_to_nothing(self, name: str, arguments: dict) -> None:
        assert tools.resolve_tool(name, arguments) is None

    @PROPERTY
    @given(name=st.one_of(st.none(), st.integers(), st.lists(st.text(max_size=3), max_size=2),
                          st.dictionaries(st.text(max_size=3), st.integers(), max_size=1)))
    def test_a_name_that_is_not_text_resolves_to_nothing(self, name: object) -> None:
        assert tools.resolve_tool(name, {}) is None
