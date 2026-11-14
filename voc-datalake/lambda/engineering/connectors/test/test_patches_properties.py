"""Properties of the patch line splitting and hunk application (connectors/patches.py).

A patch the broker pushes is applied to the file as it is on the run's base, hunk by hunk: each hunk lands only where
its old lines are exactly there, hunks never overlap, and the result is the file with the changes and nothing else.
The line split must keep every byte (a final line with or without its newline, a file with no newline at all).
Hunk lines carry their newline, as the parser hands them over.
"""
from __future__ import annotations

from typing import Any

import pytest
from hypothesis import assume, given
from hypothesis import strategies as st

from engineering.connectors.patches import PatchRefused, _split_lines, apply_hunks
from shared.test.properties import PROPERTY

# Lines of a source file: short, with no newline, sometimes empty (a blank line) and sometimes repeated (a real file
# repeats its braces and blank lines, so a hunk must match where it is, not merely somewhere).
LINE_TEXT = st.one_of(
    st.sampled_from([b'', b'}', b'    return None', b'  pass']),
    st.from_regex(rb'[ a-z0-9_=(){}.,;:-]{0,30}', fullmatch=True),
)
FILES = st.lists(LINE_TEXT, min_size=1, max_size=25)


def with_newlines(lines: list[bytes]) -> bytes:
    return b''.join(line + b'\n' for line in lines)


@st.composite
def edited_file(draw: st.DrawFn) -> tuple[list[bytes], list[tuple[int, int, list[tuple[bytes, bytes]]]], list[bytes]]:
    """A base file (lines without newlines), some non-overlapping edits of it (each replacing ``count`` old lines at
    ``start``, insertions included, sometimes with an unchanged context line before or after, as git writes them),
    and the file the edits make: the model the broker's apply must agree with."""
    base = draw(FILES)
    spans = draw(st.lists(st.tuples(st.integers(0, len(base)), st.integers(0, len(base))), max_size=4))
    hunks: list[tuple[int, int, list[tuple[bytes, bytes]]]] = []
    expected: list[bytes] = []
    cursor = 0
    for left, right in sorted((min(a, b), max(a, b)) for a, b in spans):
        if left < cursor:
            continue
        old = base[left:right]
        new = draw(st.lists(LINE_TEXT, min_size=0, max_size=3))
        if not old and not new:
            continue
        # A context line is old and new at once: it must match the file and stays in the result.
        lead = left > cursor and draw(st.booleans())
        trail = right < len(base) and draw(st.booleans())
        before = [(b' ', base[left - 1] + b'\n')] if lead else []
        after = [(b' ', base[right] + b'\n')] if trail else []
        expected += base[cursor:left] + new + base[right:right + trail]
        body = [*before, *[(b'-', line + b'\n') for line in old], *[(b'+', line + b'\n') for line in new], *after]
        first, count = left - lead, len(old) + lead + trail
        start = first + 1 if count else first   # git numbers from 1; an insertion names the line it follows
        hunks.append((start, count, body))
        cursor = right + trail
    expected += base[cursor:]
    return base, hunks, expected


@PROPERTY
@given(data=st.binary(max_size=300))
def test_splitting_keeps_every_byte_and_ends_each_line_with_its_newline(data: bytes) -> None:
    """Joining the lines gives the file back exactly; every line but a last one without a newline ends in one, and the
    last ends in one exactly when the file does."""
    lines = _split_lines(data)
    assert b''.join(lines) == data
    assert all(line.endswith(b'\n') for line in lines[:-1])
    assert all(lines)                                   # no empty line: an empty last line is no line at all
    if lines:
        assert lines[-1].endswith(b'\n') == data.endswith(b'\n')


@PROPERTY
@given(lines=FILES)
def test_a_file_with_newlines_splits_into_its_lines(lines: list[bytes]) -> None:
    """A file written with a newline after each line splits back into those lines (a blank one included); a file whose
    last line has no newline splits the same way, but for that line (an empty one with no newline is no line)."""
    data = with_newlines(lines)
    assert _split_lines(data) == [line + b'\n' for line in lines]
    if lines[-1]:
        assert _split_lines(data[:-1]) == [line + b'\n' for line in lines[:-1]] + [lines[-1]]


@PROPERTY
@given(case=edited_file())
def test_applying_a_patch_makes_exactly_the_edited_file(case: tuple[Any, ...]) -> None:
    """Applying non-overlapping hunks gives the file the hunks describe: their added lines in place of their old ones,
    every other line as it was, insertions included."""
    base, hunks, expected = case
    assert apply_hunks(with_newlines(base), hunks) == with_newlines(expected)


@PROPERTY
@given(case=edited_file(), wrong=LINE_TEXT)
def test_a_hunk_whose_old_lines_are_not_there_is_refused_not_applied(case: tuple[Any, ...], wrong: bytes) -> None:
    """A hunk whose context or removed line does not match the file is refused: the broker never guesses where a change
    belongs."""
    base, hunks, _ = case
    assume(hunks)
    start, count, body = hunks[0]
    old_positions = [i for i, (kind, _) in enumerate(body) if kind != b'+']
    assume(old_positions)
    i = old_positions[0]
    kind, line = body[i]
    assume(line != wrong + b'\n')
    broken = [(start, count, [*body[:i], (kind, wrong + b'\n'), *body[i + 1:]]), *hunks[1:]]
    with pytest.raises(PatchRefused):
        apply_hunks(with_newlines(base), broken)


@PROPERTY
@given(lines=FILES, start=st.integers(min_value=1, max_value=25))
def test_overlapping_hunks_are_refused(lines: list[bytes], start: int) -> None:
    """Two hunks that touch the same line are refused, in either order: the second would edit a line the first took."""
    assume(start <= len(lines))
    old = lines[start - 1] + b'\n'
    one = (start, 1, [(b'-', old), (b'+', b'x\n')])
    two = (start, 1, [(b'-', old), (b'+', b'y\n')])
    with pytest.raises(PatchRefused):
        apply_hunks(with_newlines(lines), [one, two])
