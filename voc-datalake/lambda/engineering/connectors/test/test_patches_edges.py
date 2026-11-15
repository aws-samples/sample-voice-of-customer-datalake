"""Edges of reading a submitted patch's text (connectors/patches.py): git's quoting of paths, the diff header's two
paths, a hunk's counted lines, every extended header line, where one file's part ends, hunks that meet, and each
refusal's own sentence, word for word (an agent reads them and acts on them)."""
from __future__ import annotations

from collections.abc import Callable

import pytest

from engineering.connectors import patches
from engineering.connectors.patches import (
    PatchRefused,
    _file,
    _FilePatch,
    _header_line,
    _header_paths,
    _hunk_lines,
    _path,
    _quoted_end,
    _unquote,
    apply_hunks,
    parse,
)
from engineering.connectors.test.test_patches import CREATE, MODE, MODIFY

NOT_GIT = 'The patch names a path git would not write.'
PREFIXES = "The patch's paths carry git's a/ and b/ prefixes, and only those."
CONTROL = 'The patch names a path with a control character.'
NOT_UTF8 = 'The patch names a path that is not UTF-8.'
OUTSIDE = 'The patch names a path outside the repository.'
COUNTS = 'A hunk of the patch does not have the lines its header counts.'
UNREADABLE = 'The patch has a line the broker cannot read.'
NO_HEADER = 'The patch has a file header the broker cannot read.'
NO_MATCH = "A hunk of the patch does not match the run's commit; make the patch on it again."
NO_NEWLINE = b'\\ No newline at end of file'


def reason_of(call: Callable[[], object]) -> str:
    with pytest.raises(PatchRefused) as caught:
        call()
    return caught.value.reason


@pytest.mark.parametrize(('token', 'expected'), [
    (b'plain/x', b'plain/x'),
    (b'""', b''),
    (b'"abcd"', b'abcd'),
    (b'"\\303\\251"', 'é'.encode()),
    (b'"\\101b"', b'Ab'),
    (b'"\\377"', b'\xff'),
    (b'"a\\"b"', b'a"b'),
    (b'"\\\\x"', b'\\x'),
    (b'"\\a\\b\\t\\n\\v\\f\\r"', bytes([7, 8, 9, 10, 11, 12, 13])),
    (b'"\\nx"', b'\nx'),
])
def test_a_quoted_path_is_read_with_git_s_c_escapes(token: bytes, expected: bytes) -> None:
    assert _unquote(token) == expected


@pytest.mark.parametrize('token', [b'"', b'"abc', b'"a\\"', b'"\\q"', b'"\\9"', b'"x\\'])
def test_a_quoted_path_git_would_not_write_is_refused_in_its_own_words(token: bytes) -> None:
    assert reason_of(lambda: _unquote(token)) == NOT_GIT


@pytest.mark.parametrize(('raw', 'prefix', 'expected'), [
    (b'a/x', b'a/', 'x'),
    (b'b/x\t', b'b/', 'x'),
    (b'docs/a.md', b'', 'docs/a.md'),
    (b'"a/caf\\303\\251"', b'a/', 'café'),
    (b'a/.gitignore', b'a/', '.gitignore'),
    (b'a/x/..y', b'a/', 'x/..y'),
    (b'a/x y', b'a/', 'x y'),
])
def test_a_path_is_the_repository_path_after_its_prefix(raw: bytes, prefix: bytes, expected: str) -> None:
    assert _path(raw, prefix) == expected


@pytest.mark.parametrize(('raw', 'prefix', 'expected'), [
    (b'c/x', b'a/', PREFIXES),
    (b'a/x\x7fy', b'a/', CONTROL),
    (b'a/x\x1fy', b'a/', CONTROL),
    (b'a/x\x00', b'a/', CONTROL),
    (b'a/\xff', b'a/', NOT_UTF8),
    (b'a/', b'a/', OUTSIDE),
    (b'a/x//y', b'a/', OUTSIDE),
    (b'a/./x', b'a/', OUTSIDE),
    (b'a/../x', b'a/', OUTSIDE),
    (b'a/.git/config', b'a/', OUTSIDE),
    (b'a/x/', b'a/', OUTSIDE),
    (b'a/x/.git', b'a/', OUTSIDE),
])
def test_a_path_the_broker_never_pushes_is_refused_saying_why(raw: bytes, prefix: bytes, expected: str) -> None:
    assert reason_of(lambda: _path(raw, prefix)) == expected


@pytest.mark.parametrize(('rest', 'expected'), [
    (b'"" x', 2), (b'"abc" x', 5), (b'"\\"" x', 4), (b'"abc', 0), (b'"a\\', 0), (b'"', 0)])
def test_a_quoted_name_ends_after_its_closing_quote_an_escaped_one_not_counted(rest: bytes, expected: int) -> None:
    assert _quoted_end(rest) == expected


@pytest.mark.parametrize(('rest', 'expected'), [
    (b'a/x b/x', ('x', 'x')),
    (b'a/xy b/xy', ('xy', 'xy')),
    (b'a/a b c b/a b c', ('a b c', 'a b c')),
    (b'"a/x y" "b/z w"', ('x y', 'z w')),
    (b'"a/x" b/x', ('x', 'x')),
])
def test_the_diff_line_names_both_paths_when_they_can_be_told_apart(rest: bytes, expected: tuple[str, str]) -> None:
    assert _header_paths(rest) == expected


@pytest.mark.parametrize('rest', [
    b'a/x c/y', b'a/xy b/x', b'a/x  b/x', b'a/xyzb/xy', b'"a/x', b'"a/x"y "b/x"', b'a/x y b/z w', b'a/xy b/zy',
    # Too short to hold two paths: an even length never splits into two halves around one space.
    b'a bc', b' x'])
def test_a_diff_line_whose_paths_cannot_be_told_apart_names_none(rest: bytes) -> None:
    assert _header_paths(rest) == ('', '')


def test_a_hunk_takes_the_lines_its_header_counts_and_no_more() -> None:
    lines = [b'@@', b' a', b'-b', b'+c', b'+d', b'@@ -9 +9 @@']
    assert _hunk_lines(lines, 1, 2, 3) == ([(b' ', b'a\n'), (b'-', b'b\n'), (b'+', b'c\n'), (b'+', b'd\n')], 5)
    assert _hunk_lines([b'+a', b'+b'], 0, 0, 1) == ([(b'+', b'a\n')], 1)
    assert _hunk_lines([b'-a', b'-b'], 0, 2, 0) == ([(b'-', b'a\n'), (b'-', b'b\n')], 2)


def test_a_line_without_its_final_newline_says_so_after_it() -> None:
    lines = [b'-a', NO_NEWLINE, b'+b', NO_NEWLINE]
    assert _hunk_lines(lines, 0, 1, 1) == ([(b'-', b'a'), (b'+', b'b')], 4)
    assert _hunk_lines([b'+a', NO_NEWLINE], 0, 0, 1) == ([(b'+', b'a')], 2)
    assert _hunk_lines([b' a', NO_NEWLINE, b'x'], 0, 1, 1) == ([(b' ', b'a')], 2)
    # Only the newline goes: the rest of a longer line stays as it was.
    assert _hunk_lines([b'+return None', NO_NEWLINE], 0, 0, 1) == ([(b'+', b'return None')], 2)


@pytest.mark.parametrize(('lines', 'old', 'new'), [
    ([b'-a'], 2, 0), ([b'-a', b'diff --git a/x b/x'], 2, 0), ([b'-a', b'-b'], 1, 1), ([b'x'], 1, 0), ([], 0, 1),
    ([b'+a', b'+b'], 0, 3)])
def test_a_hunk_short_of_its_counted_lines_is_refused(lines: list[bytes], old: int, new: int) -> None:
    assert reason_of(lambda: _hunk_lines(lines, 0, old, new)) == COUNTS


@pytest.mark.parametrize(('line', 'expected'), [
    (b'old mode 100644', _FilePatch(old_mode='100644')),
    (b'new mode 100755', _FilePatch(new_mode='100755')),
    (b'deleted file mode 100644', _FilePatch(old_mode='100644', deleted=True)),
    (b'new file mode 100755', _FilePatch(new_mode='100755', created=True)),
    (b'rename from a b/c', _FilePatch(old_path='a b/c')),
    (b'rename to d/e', _FilePatch(new_path='d/e')),
    (b'index 1111111..2222222 100755', _FilePatch(old_mode='100755', new_mode='100755')),
    (b'index 1111111..2222222', _FilePatch()),
    (b'similarity index 90%', _FilePatch()),
    (b'dissimilarity index 10%', _FilePatch()),
])
def test_each_extended_header_line_sets_what_it_says(line: bytes, expected: _FilePatch) -> None:
    file = _FilePatch()
    _header_line(file, line)
    assert file == expected


@pytest.mark.parametrize('first', [_FilePatch(new_mode='100755'), _FilePatch(old_mode='100755')])
def test_the_index_line_s_mode_is_only_the_mode_of_a_file_whose_mode_is_unchanged(first: _FilePatch) -> None:
    file = _FilePatch(old_mode=first.old_mode, new_mode=first.new_mode)
    _header_line(file, b'index 1111111..2222222 100644')
    assert file == first


@pytest.mark.parametrize(('line', 'expected'), [
    (b'copy from x', 'The patch copies a file; the broker pushes changes, renames and deletions only.'),
    (b'copy to x', 'The patch copies a file; the broker pushes changes, renames and deletions only.'),
    (b'Binary files a/x and b/x differ', "The patch has a binary file without its content; make it with git's --binary."),
    (b'unknown header', UNREADABLE),
    (b'mode 100644', UNREADABLE),
    (b'old mode 10064', UNREADABLE),
    (b'rename from ../x', OUTSIDE),
])
def test_a_header_line_the_broker_does_not_push_is_refused_saying_why(line: bytes, expected: str) -> None:
    assert reason_of(lambda: _header_line(_FilePatch(), line)) == expected


def test_a_file_s_hunks_are_read_with_their_starts_and_counts() -> None:
    lines = [b'diff --git a/x b/x', b'--- a/x', b'+++ b/x', b'@@ -5,2 +7,3 @@', b' a', b'-b', b'+c', b'+d',
             b'@@ -9 +10 @@', b'-e', b'+f', b'diff --git a/y b/y']
    file, at = _file(lines, 0)
    assert at == 11
    assert file.hunks == [(5, 2, [(b' ', b'a\n'), (b'-', b'b\n'), (b'+', b'c\n'), (b'+', b'd\n')]),
                          (9, 1, [(b'-', b'e\n'), (b'+', b'f\n')])]


def test_a_file_part_may_end_after_its_names_with_no_hunk() -> None:
    file, at = _file([b'diff --git a/x b/x', b'--- a/x', b'+++ b/y'], 0)
    assert (file.old_path, file.new_path, file.hunks, at) == ('x', 'y', [], 3)


def test_blank_lines_between_files_are_skipped() -> None:
    files = parse(MODE + b'\n\n' + CREATE)
    assert [(f.old_path, f.new_mode) for f in files] == [('run.sh', '100755'), ('src/new.py', '100644')]


@pytest.mark.parametrize('patch', [
    b'diff --git a/x b/x\n--- a/x', MODIFY + b'\ntrailing\n', b'diff --git a/x b/x\nold mode 100644\n\nstray\n',
    b'diff --git a/x b/x\n--- a/x\n@@ -1 +1 @@\n'])
def test_a_line_after_a_file_s_part_that_is_not_the_next_file_is_refused(patch: bytes) -> None:
    assert reason_of(lambda: parse(patch)) == UNREADABLE


@pytest.mark.parametrize('patch', [
    b'diff --git a/x y b/z w\nnew file mode 100644\n--- /dev/null\n+++ b/z w\n@@ -0,0 +1 @@\n+a\n',
    b'diff --git a/x y b/z w\ndeleted file mode 100644\n--- a/x y\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n',
    b'diff --git a/x y b/z w\nold mode 100644\nnew mode 100755\n'])
def test_a_file_whose_two_paths_are_not_both_named_is_refused(patch: bytes) -> None:
    assert reason_of(lambda: parse(patch)) == NO_HEADER


def test_a_binary_header_with_nothing_after_it_has_no_literal() -> None:
    patch = b'diff --git a/x b/x\nindex 1111111..2222222 100644\nGIT binary patch'
    assert reason_of(lambda: parse(patch)) == 'A binary file of the patch has no literal or delta.'


def test_a_patch_without_its_final_newline_reads_the_same() -> None:
    assert parse(MODE.rstrip(b'\n')) == parse(MODE)
    assert parse(MODIFY.removesuffix(b'\n')) == parse(MODIFY)


@pytest.mark.parametrize('patch', [b'', b'\n', b'index 1111111..2222222\n', b' diff --git a/x b/x\n'])
def test_a_patch_that_does_not_start_with_a_file_changes_nothing(patch: bytes) -> None:
    assert reason_of(lambda: parse(patch)) == 'The submitted patch changes nothing the broker can read.'


def test_the_file_bound_takes_exactly_its_count(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(patches, 'MAX_FILES', 2)
    assert len(parse(MODIFY + MODE)) == 2
    assert reason_of(lambda: parse(MODIFY + MODE + CREATE)) == 'The patch changes more than 2 files.'


def test_hunks_that_meet_apply_one_after_the_other() -> None:
    base = b'a\nb\nc\n'
    hunks = [(1, 1, [(b'-', b'a\n'), (b'+', b'A\n')]), (2, 1, [(b'-', b'b\n'), (b'+', b'B\n')])]
    assert apply_hunks(base, hunks) == b'A\nB\nc\n'


def test_an_insertion_lands_after_the_line_it_names() -> None:
    base = b'a\nb\n'
    assert apply_hunks(base, [(0, 0, [(b'+', b'top\n')])]) == b'top\na\nb\n'
    assert apply_hunks(base, [(1, 0, [(b'+', b'mid\n')])]) == b'a\nmid\nb\n'
    assert apply_hunks(base, [(2, 0, [(b'+', b'end\n')])]) == b'a\nb\nend\n'


def test_a_hunk_keeps_the_lines_after_it_and_takes_out_only_its_own() -> None:
    base = b'a\nb\nc\nd\n'
    assert apply_hunks(base, [(2, 2, [(b'-', b'b\n'), (b' ', b'c\n'), (b'+', b'C\n')])]) == b'a\nc\nC\nd\n'


@pytest.mark.parametrize('hunks', [
    [(1, 1, [(b'-', b'x\n')])],
    [(3, 1, [(b'-', b'c\n')])],
    [(2, 1, [(b'-', b'b\n')]), (2, 1, [(b'-', b'b\n')])],
    [(1, 2, [(b'-', b'a\n'), (b'-', b'b\n'), (b'-', b'c\n')])],
])
def test_a_hunk_not_exactly_on_the_base_is_refused_in_its_own_words(hunks: list[tuple[int, int, list[tuple[bytes, bytes]]]]) -> None:
    assert reason_of(lambda: apply_hunks(b'a\nb\n', hunks)) == NO_MATCH
