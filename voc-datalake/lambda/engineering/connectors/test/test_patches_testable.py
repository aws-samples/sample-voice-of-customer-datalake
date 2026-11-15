"""The patch reader pinned on real git output before its loops were bounded (patches.py): every corpus patch parses
to what it parsed to before, and applies to exactly what git's own working tree held after the change; and the
edges the bounded loops, the key bound and the codecs decide."""
from __future__ import annotations

import hashlib
import re
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from moto import mock_aws

from engineering.connectors import patches
from engineering.connectors.patches import PatchRefused, _FilePatch, parse
from engineering.connectors.test.fakes import FakeHost, record
from engineering.connectors.test.patch_corpus import AFTER, CORPUS, PARSED, base_files
from engineering.connectors.test.test_patches import AGENT, BUCKET, reader, submission

NOT_GIT = 'The patch names a path git would not write.'
COUNTS = 'A hunk of the patch does not have the lines its header counts.'
OWN_ONLY = ("An agent pushes only a patch it submitted itself, or the committer a fixer's or builder's, on the run's "
            'commit (ws/default/runs/<run>/<agent>/commits/<commit>/_patches/...).')


@pytest.fixture
def s3() -> Iterator[Any]:
    """The workspace bucket, as test_patches.py's."""
    with mock_aws():
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket=BUCKET)
        yield client


def _digest(file: _FilePatch) -> tuple[Any, ...]:
    binary = None
    if file.binary is not None:
        kind, size, data = file.binary
        binary = (kind, size, hashlib.sha256(data).hexdigest()[:16])
    return (file.old_path, file.new_path, file.old_mode, file.new_mode, file.created, file.deleted,
            [(start, count, body) for start, count, body in file.hunks], binary)


def _parsed(patch: bytes) -> Any:
    try:
        return [_digest(file) for file in parse(patch)]
    except PatchRefused as refused:
        return ('refused', str(refused))


@pytest.mark.parametrize('label', sorted(CORPUS))
def test_each_real_patch_parses_as_it_did_before_the_loops_were_bounded(label: str) -> None:
    assert _parsed(CORPUS[label]) == PARSED[label]


@pytest.mark.parametrize('label', sorted(set(CORPUS) - {'tab_path'}))
def test_each_real_patch_applies_to_exactly_what_git_s_working_tree_held(s3: Any, label: str) -> None:
    # (the commit's changes, path by path: a deleted path as None, every other as its mode and content's hash)
    read, _ = reader(s3, CORPUS[label], FakeHost(files=base_files()))
    commit, = read.contents(submission()).commits
    got = {change.path: None if change.content is None else
           (change.mode, hashlib.sha256(change.content).hexdigest()[:16]) for change in commit.changes}
    assert got == AFTER[label]


def test_the_added_lines_of_a_real_patch_are_every_plus_line_in_order(s3: Any) -> None:
    read, _ = reader(s3, CORPUS['two_hunks'] + CORPUS['created'],
                     FakeHost(files=base_files()))
    assert read.contents(submission()).added_lines == ('LINE 3', 'LINE 30', 'fresh', 'lines')


# ---- the quoted paths' loops ----

@pytest.mark.parametrize(('token', 'expected'), [
    (b'"' + b'\\303\\251' * 200 + b'"', 'é'.encode() * 200),   # (a long run of escapes: each read once, in order)
    (b'"a\\\\b\\"c\\td"', b'a\\b"c\td'),
    (b'"' + b'x' * 500 + b'"', b'x' * 500),
    (b'""', b''),
])
def test_a_quoted_path_is_read_byte_for_byte_whatever_its_length(token: bytes, expected: bytes) -> None:
    assert patches._unquote(token) == expected


@pytest.mark.parametrize('token', [b'"ab\\"', b'"\\x"', b'"\\40"', b'"\\"'])
def test_an_escape_cut_short_or_unknown_is_refused(token: bytes) -> None:
    with pytest.raises(PatchRefused, match=f'^{NOT_GIT}$'):
        patches._unquote(token)


@pytest.mark.parametrize(('rest', 'expected'), [
    (b'"a/x" "b/x"', 5),
    (b'"a/\\"x\\"" "b/y"', 9),
    (b'"' + b'\\\\' * 100 + b'" "b/y"', 202),
    (b'"a/x\\', 0),
    (b'"a/x', 0),
    (b'"', 0),
])
def test_a_quoted_name_ends_just_after_its_closing_quote_and_never_past_the_line(rest: bytes, expected: int) -> None:
    assert patches._quoted_end(rest) == expected


# ---- the hunk, header and binary loops ----

def test_a_hunk_reads_only_its_counted_lines_and_stops_at_the_next_hunk() -> None:
    lines = [b' a', b'-b', b'+c', b'@@ -9 +9 @@', b'-z', b'+y']
    assert patches._hunk_lines(lines, 0, 2, 2) == ([(b' ', b'a\n'), (b'-', b'b\n'), (b'+', b'c\n')], 3)


def test_a_hunk_at_the_end_of_the_patch_ends_there() -> None:
    assert patches._hunk_lines([b'x', b'+a'], 1, 0, 1) == ([(b'+', b'a\n')], 2)


def test_a_hunk_short_of_its_lines_at_the_end_of_the_patch_after_a_mark_is_refused() -> None:
    with pytest.raises(PatchRefused, match=f'^{re.escape(COUNTS)}$'):
        patches._hunk_lines([b'-a', b'\\ No newline at end of file'], 0, 2, 0)


def test_a_mark_as_a_hunks_first_line_is_not_the_hunks() -> None:
    with pytest.raises(PatchRefused, match=f'^{re.escape(COUNTS)}$'):
        patches._hunk_lines([b'\\ No newline at end of file', b'+a'], 0, 0, 1)


def test_a_second_mark_is_left_after_the_hunk() -> None:
    lines = [b'+a', b'\\ No newline at end of file', b'\\ No newline at end of file']
    assert patches._hunk_lines(lines, 0, 0, 1) == ([(b'+', b'a')], 2)


def test_each_body_line_s_mark_strips_only_its_own_newline() -> None:
    lines = [b'-a', b'\\ No newline at end of file', b'+b', b'\\ No newline at end of file', b'@@ -1 +1 @@']
    assert patches._hunk_lines(lines, 0, 1, 1) == ([(b'-', b'a'), (b'+', b'b')], 4)


def test_a_binary_part_with_no_data_line_is_empty_and_ends_at_the_next_file() -> None:
    lines = [b'literal 0', b'', b'literal 0', b'HcmV?d00001', b'', b'diff --git a/x b/x']
    assert patches._binary(lines, 0) == ((b'literal', 0, b''), 5)


def test_a_binary_patch_reads_every_data_line_then_skips_its_reverse_part_to_the_next_file() -> None:
    patch = CORPUS['mixed']
    lines = patch.split(b'\n')
    start = lines.index(b'GIT binary patch') + 1
    (kind, size, data), after = patches._binary(lines, start)
    assert (kind, size, hashlib.sha256(data).hexdigest()[:16]) == PARSED['mixed'][1][7]
    assert lines[after].startswith(b'diff --git a/old.txt')


def test_a_binary_patch_at_the_end_of_the_patch_ends_there() -> None:
    lines = CORPUS['binary_literal'].split(b'\n')
    _, after = patches._binary(lines, lines.index(b'GIT binary patch') + 1)
    assert after == len(lines)


def test_a_file_part_reads_its_extended_header_lines_up_to_its_hunks() -> None:
    lines = CORPUS['renamed_changed_quoted'].split(b'\n')[:-1]
    file, after = patches._file(lines, 0)
    assert (file.old_path, file.new_path, file.old_mode, after) == ('from.txt', 'to é.txt', '100644', len(lines))


def test_several_files_are_read_one_after_the_other_each_once() -> None:
    patch = CORPUS['two_hunks'] + CORPUS['mode'] + CORPUS['deleted']
    assert [(f.old_path, f.deleted) for f in parse(patch)] == [('a.txt', False), ('run.sh', False), ('old.txt', True)]


# ---- the delta's varints ----

@pytest.mark.parametrize(('data', 'at', 'expected'), [
    (b'\x05', 0, (5, 1)),
    (b'\x00\x80\x01', 1, (128, 3)),
    (b'\xff\xff\x03', 0, (0xFFFF, 3)),
])
def test_a_varint_is_read_little_end_first_to_its_last_byte(data: bytes, at: int, expected: tuple[int, int]) -> None:
    assert patches._varint(data, at) == expected


@pytest.mark.parametrize('data', [b'', b'\x80', b'\xff\xff'])
def test_a_varint_cut_short_is_refused(data: bytes) -> None:
    with pytest.raises(PatchRefused, match=f'^{re.escape(patches._BAD_DELTA)}$'):
        patches._varint(data, 0)


# ---- the key bound and the codecs ----

#: The longest own patch key the layout takes: a run and an agent id of 128 characters, a SHA-256 commit, attempt
#: 9999 and a name of 128 (497 characters; the workspace is always ``default``).
LONG_RUN, LONG_AGENT, LONG_COMMIT = 'R' * 128, AGENT + 'x' * (128 - len(AGENT)), 'c' * 64
LONGEST = (f'ws/default/runs/{LONG_RUN}/{LONG_AGENT}/commits/{LONG_COMMIT}/_patches/attempt-9999/'
           f'{"t" * 123}.diff')


def _long(key: str) -> Any:
    return submission(key, run_id=LONG_RUN, agent_id=LONG_AGENT, run=record(commit=LONG_COMMIT))


def test_the_longest_own_patch_key_the_layout_takes_is_read(s3: Any) -> None:
    assert len(LONGEST) == 497
    s3.put_object(Bucket=BUCKET, Key=LONGEST, Body=CORPUS['mode'])
    patches_reader, _ = reader(s3, None, FakeHost(files=base_files()))
    assert patches_reader.contents(_long(LONGEST)).changed_paths == ('run.sh',)


@pytest.mark.parametrize('key', [
    LONGEST.replace('/_patches/', '/x_patches/'),                       # (a kind the layout has not)
    LONGEST.replace(LONG_AGENT, LONG_AGENT + 'x'),                      # (any part one longer: off the layout)
    LONGEST.replace('.diff', 'x.diff'),
    LONGEST.replace('attempt-9999', 'attempt-10000'),
    LONGEST + 'x' * 10_000,
])
def test_a_key_longer_than_the_layout_takes_is_refused_before_any_read(s3: Any, key: str) -> None:
    patches_reader, _ = reader(s3, None, FakeHost(files=base_files()))
    with pytest.raises(PatchRefused, match=f'^{re.escape(OWN_ONLY)}$'):
        patches_reader.contents(_long(key))


def test_an_added_line_that_is_not_utf8_is_kept_with_its_bad_bytes_replaced(s3: Any) -> None:
    patch = (b'diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n'
             b'+++ b/n.txt\n@@ -0,0 +1 @@\n+caf\xe9 \xc3\xa9\n')
    read, _ = reader(s3, patch, FakeHost(files=base_files()))
    assert read.contents(submission()).added_lines == ('caf� é',)


def test_a_path_that_is_not_utf8_is_refused() -> None:
    with pytest.raises(PatchRefused, match=r'^The patch names a path that is not UTF-8\.$'):
        patches._path(b'b/caf\xe9', b'b/')


@pytest.mark.parametrize(('probe', 'text'), [
    # (each led and ended by U+00D8, whose two bytes read the other way round are a lone surrogate: one order only)
    ('\xd8\t\n\r\x0c\x0b\xd8'.encode('utf-16-le'), True),
    ('\xd8\t\n\r\x0c\x0b\xd8'.encode('utf-16-be'), True),
    ('﻿hello'.encode('utf-16-be'), True),
    ('\xd8\x00\xd8'.encode('utf-16-le'), False),   # (a NUL character is neither printable nor allowed whitespace)
    ('\xd8\x1c\xd8'.encode('utf-16-le'), False),   # (a separator Python calls whitespace, git's text never has)
    ('\xd8\x85\xd8'.encode('utf-16-le'), False),
    (b'', False),
])
def test_utf16_text_is_printable_or_one_of_the_five_whitespace_characters(probe: bytes, text: bool) -> None:
    assert patches._utf16_text(probe) is text
