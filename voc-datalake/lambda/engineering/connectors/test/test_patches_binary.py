"""Edges of a patch's binary files and of the reader around it (connectors/patches.py): git's base85 lines and their
length letters, the binary delta's varints and copy ops, the bounds a delta, a literal and the whole push are held to,
what counts as text sent as binary, how the caller's patch is read, and each refusal's own sentence, word for word."""
from __future__ import annotations

import base64
import zlib
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pytest
from botocore.exceptions import BotoCoreError

from engineering.connectors import patches
from engineering.connectors.hosts import Unavailable
from engineering.connectors.patches import (
    PatchRefused,
    WorkspacePatches,
    _binary,
    _byte,
    _copy_op,
    _inflate,
    _require_binary,
    _utf16_text,
    _varint,
    apply_delta,
)
from engineering.connectors.test.fakes import FakeHost
from engineering.connectors.test.test_patches import BASES, CREATE, DELETE, KEY, MODIFY, PNG, submission, varint
from engineering.workspace.store import ObjectTooLarge

ENCODED = 'A binary file of the patch is not encoded the way git encodes it.'
BAD_DELTA = 'A binary file of the patch is not a delta git would write.'
TEXT = 'The patch sends a text file as binary; make it as a text diff, which the write rules read.'
MB = 1024 * 1024
IMG = BASES['img.bin']


def reason_of(call: Callable[[], object]) -> str:
    with pytest.raises(PatchRefused) as caught:
        call()
    return caught.value.reason


def b85_line(chunk: bytes, lead: bytes | None = None) -> bytes:
    """One line of a binary patch: the chunk's length letter (or ``lead``), then the chunk in base85."""
    size = len(chunk)
    letter = chr(ord('A') + size - 1) if size <= 26 else chr(ord('a') + size - 27)
    return (lead or letter.encode()) + base64.b85encode(chunk, pad=True)


@dataclass
class Workspace:
    """The workspace store's one read the reader makes: the patch, or what the store raised."""

    patch: bytes | None = None
    error: Exception | None = None
    reads: list[tuple[str, int]] = field(default_factory=list)

    def read_bytes(self, key: str, limit: int) -> bytes | None:
        self.reads.append((key, limit))
        if self.error is not None:
            raise self.error
        return self.patch


def reader(workspace: Any) -> WorkspacePatches:
    return WorkspacePatches(workspace, FakeHost(files=dict(BASES)).file_at)


def contents(patch: bytes, **overrides: Any) -> Any:
    return reader(Workspace(patch)).contents(submission(**overrides))


def changes(patch: bytes) -> list[tuple[str, str, bytes | None]]:
    return [(c.path, c.mode, c.content) for c in contents(patch).commits[0].changes]


@pytest.mark.parametrize('size', [1, 4, 26, 27, 52])
def test_a_binary_line_s_letter_is_its_length_from_a_to_z_then_a_to_z(size: int) -> None:
    chunk = bytes(range(100, 100 + size))
    assert _binary([b'literal 7', b85_line(chunk), b''], 0) == ((b'literal', 7, chunk), 3)


def test_a_binary_patch_joins_its_lines_and_skips_its_reverse_part() -> None:
    lines = [b'x', b'delta 53', b85_line(b'a' * 52), b85_line(b'b'), b'', b'literal 0', b'HcmV?d00001', b'',
             b'diff --git a/y b/y']
    assert _binary(lines, 1) == ((b'delta', 53, b'a' * 52 + b'b'), 8)


@pytest.mark.parametrize(('lines', 'at'), [([b'literal'], 0), ([b'GIT binary patch'], 1), ([b'literal 1 x'], 0)])
def test_a_binary_file_without_its_literal_line_is_refused(lines: list[bytes], at: int) -> None:
    assert reason_of(lambda: _binary(lines, at)) == 'A binary file of the patch has no literal or delta.'


@pytest.mark.parametrize('line', [
    b85_line(bytes(26), b'`'), b85_line(bytes(27), b'['), b85_line(bytes(53), b'{'), b85_line(b'x', b'0'),
    b85_line(b'x', b'@'), b'B' + b'0' * 10, b'A,,,,,', b'A~~~~~', b'A'])
def test_a_binary_line_git_would_not_write_is_refused(line: bytes) -> None:
    assert reason_of(lambda: _binary([b'literal 1', line, b''], 0)) == ENCODED


def test_a_byte_past_the_delta_s_end_is_refused() -> None:
    assert _byte(b'ab', 1) == ord('b')
    assert reason_of(lambda: _byte(b'ab', 2)) == BAD_DELTA


@pytest.mark.parametrize('value', [0, 1, 127, 128, 300, 2 ** 21 + 5])
def test_a_varint_is_seven_bits_a_byte_low_first(value: int) -> None:
    encoded = varint(value)
    assert _varint(b'x' + encoded + b'y', 1) == (value, 1 + len(encoded))


def test_a_varint_cut_short_is_refused() -> None:
    assert reason_of(lambda: _varint(b'\x80', 0)) == BAD_DELTA


@pytest.mark.parametrize(('op', 'data', 'at', 'expected'), [
    (0xFF, bytes([1, 2, 3, 4, 5, 6, 7]), 0, (0x04030201, 0x070605, 7)),
    (0x80, b'', 0, (0, 0x10000, 0)),
    (0x91, b'\x07\x04', 0, (7, 4, 2)),
    (0xA0, b'\x02', 0, (0, 0x200, 1)),
    (0x82, b'\x05', 0, (0x500, 0x10000, 1)),
    (0x81, b'zz\x09', 2, (9, 0x10000, 3)),
])
def test_a_copy_op_reads_the_bytes_its_bits_say(op: int, data: bytes, at: int, expected: tuple[int, int, int]) -> None:
    assert _copy_op(op, data, at) == expected


def test_a_copy_op_cut_short_is_refused() -> None:
    assert reason_of(lambda: _copy_op(0x81, b'', 0)) == BAD_DELTA


def test_a_delta_copies_up_to_the_base_s_last_byte_and_mixes_copies_and_inserts() -> None:
    assert apply_delta(IMG, varint(64) + varint(64) + bytes([0x90, 64])) == IMG
    mixed = varint(64) + varint(6) + bytes([0x91, 60, 2]) + bytes([2]) + b'xy' + bytes([0x91, 1, 2])
    assert apply_delta(IMG, mixed) == IMG[60:62] + b'xy' + IMG[1:3]


@pytest.mark.parametrize('patch_delta', [
    varint(64) + varint(64) + bytes([0x91, 1, 64]),
    varint(64) + varint(2) + bytes([2]) + b'ab' + bytes([1]) + b'c',
    varint(64) + varint(3) + bytes([2]) + b'ab',
    varint(64) + varint(1),
    varint(64),
])
def test_a_delta_past_its_base_or_its_target_is_refused(patch_delta: bytes) -> None:
    assert reason_of(lambda: apply_delta(IMG, patch_delta)) == BAD_DELTA


@pytest.mark.parametrize('patch_delta', [
    # A copy that runs past the base's end, then an insert that would make up the target's size.
    varint(64) + varint(4) + bytes([0x91, 62, 4]) + bytes([2]) + b'zz',
    # A copy past the base's end that alone is the target's size.
    varint(64) + varint(4) + bytes([0x91, 62, 4]),
    # An insert longer than what is left of the delta: its cut-short bytes, or any other, are never taken.
    varint(64) + varint(2) + bytes([4]) + b'ab',
    varint(64) + varint(4) + bytes([5]) + b'ab',
])
def test_a_copy_or_an_insert_past_its_data_is_refused_even_when_the_size_would_add_up(patch_delta: bytes) -> None:
    assert reason_of(lambda: apply_delta(IMG, patch_delta)) == BAD_DELTA


def test_a_binary_patch_may_end_with_the_patch_s_last_line() -> None:
    assert _binary([b'literal 1', b85_line(b'x')], 0) == ((b'literal', 1, b'x'), 2)


class InflateRecorder:
    """zlib as the module uses it, recording how many bytes each inflate may make."""

    error = zlib.error

    def __init__(self) -> None:
        self.limits: list[int] = []

    def decompressobj(self) -> InflateRecorder:
        return self

    def decompress(self, data: bytes, max_length: int = 0) -> bytes:
        self.limits.append(max_length)
        return zlib.decompressobj().decompress(data, max_length)


def test_a_literal_is_never_inflated_past_one_byte_more_than_its_size(monkeypatch: pytest.MonkeyPatch) -> None:
    """The bound is what stops a small patch from inflating into gigabytes: one byte past the size is enough to see
    that the data is longer than it says."""
    recorder = InflateRecorder()
    monkeypatch.setattr(patches, 'zlib', recorder)
    assert _inflate(zlib.compress(b'abc'), 3) == b'abc'
    assert recorder.limits == [4]


def test_a_delta_for_another_base_is_refused_in_its_own_words() -> None:
    assert reason_of(lambda: apply_delta(IMG, varint(63) + varint(1) + b'\x01x')) == (
        "A binary file of the patch is not a change of the run's commit's file.")


def test_a_delta_s_target_bound_takes_exactly_its_size(monkeypatch: pytest.MonkeyPatch) -> None:
    assert reason_of(lambda: apply_delta(IMG, varint(64) + varint(32 * MB + 1))) == 'A file of the patch is over 32 MB.'
    monkeypatch.setattr(patches, 'MAX_CONTENT_BYTES', 4)
    assert apply_delta(IMG, varint(64) + varint(4) + b'\x04abcd') == b'abcd'


@pytest.mark.parametrize('probe', [
    'éé'.encode('utf-16-le'), 'éé'.encode('utf-16-be'), b'\xff\xfe' + 'éé'.encode('utf-16-le'),
    b'\xfe\xff' + 'éé'.encode('utf-16-be'), 'éé'.encode('utf-16-le') + b'\x00', b'\x00\xd8',
    *(('é' + space).encode('utf-16-le') for space in '\t\n\r\f\v'),
])
def test_content_that_reads_as_utf16_text_in_either_order_is_text(probe: bytes) -> None:
    assert _utf16_text(probe) is True


@pytest.mark.parametrize('probe', [b'', b'\xff\xfe', b'\xff\xff', b'\x00\x00', PNG])
def test_content_that_does_not_read_as_utf16_text_is_not(probe: bytes) -> None:
    assert _utf16_text(probe) is False


def test_only_a_nul_in_the_first_8000_bytes_makes_content_binary() -> None:
    assert _require_binary(PNG) is None
    assert _require_binary(b'\xff' * 7999 + b'\x00') is None
    assert reason_of(lambda: _require_binary(b'\xff' * 8000 + b'\x00')) == TEXT
    assert reason_of(lambda: _require_binary('text'.encode('utf-16-le'))) == TEXT


def test_a_literal_inflates_to_exactly_its_size(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _inflate(zlib.compress(b'abc'), 3) == b'abc'
    assert _inflate(zlib.compress(b''), 0) == b''
    assert reason_of(lambda: _inflate(zlib.compress(b'abcd'), 3)) == 'A binary file of the patch is not the size it says.'
    assert reason_of(lambda: _inflate(zlib.compress(b'ab'), 3)) == 'A binary file of the patch is not the size it says.'
    assert reason_of(lambda: _inflate(b'not zlib', 3)) == ENCODED
    assert reason_of(lambda: _inflate(b'', 32 * MB + 1)) == 'A file of the patch is over 32 MB.'
    monkeypatch.setattr(patches, 'MAX_CONTENT_BYTES', 3)
    assert _inflate(zlib.compress(b'abc'), 3) == b'abc'


def test_the_reader_reads_the_caller_s_key_up_to_the_patch_bound() -> None:
    workspace = Workspace(MODIFY)
    assert reader(workspace).contents(submission()).changed_paths == ('src/refund.py',)
    assert workspace.reads == [(KEY, 6 * MB)]


def test_a_patch_over_its_bound_is_refused_naming_the_bound() -> None:
    patches_ = reader(Workspace(error=ObjectTooLarge('big')))
    assert reason_of(lambda: patches_.contents(submission())) == 'The patch is over 6 MB.'


def test_a_lost_connection_to_the_workspace_is_unavailable_saying_retry() -> None:
    patches_ = reader(Workspace(error=BotoCoreError()))
    with pytest.raises(Unavailable) as caught:
        patches_.contents(submission())
    assert caught.value.reason == 'The workspace could not be read; retry.'


@pytest.mark.parametrize(('caller', 'key'), [
    ('committer-2', KEY), ('committers-1', KEY.replace('committer-1', 'fixer-3')),
    ('fixer-3', KEY.replace('committer-1', 'fixer-4')),
    # The caller's own key, but a checkpoint's snapshot: never a patch to push.
    ('committer-1', KEY.replace('task-1-0a1b2c3d.diff', 'checkpoint-1.diff'))])
def test_a_patch_not_the_caller_s_is_refused_naming_the_keys_it_may_push(caller: str, key: str) -> None:
    assert reason_of(lambda: contents(MODIFY, key=key, agent_id=caller)) == (
        "An agent pushes only a patch it submitted itself, or the committer a fixer's or builder's, on the run's "
        'commit (ws/default/runs/<run>/<agent>/commits/<commit>/_patches/...).')


def test_a_file_with_no_mode_line_is_a_regular_file() -> None:
    patch = b'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n'
    assert changes(patch) == [('x.txt', '100644', b'b\n')]


@pytest.mark.parametrize('modes', [b'old mode 160000\nnew mode 100644\n', b'old mode 100644\nnew mode 160000\n',
                                   b'index 1111111..2222222 120001\n'])
def test_a_submodule_on_either_side_is_refused(modes: bytes) -> None:
    assert reason_of(lambda: contents(b'diff --git a/run.sh b/run.sh\n' + modes)) == (
        'The patch changes a submodule or a mode git does not push as a file.')


def test_a_deletion_keeps_the_mode_the_file_had() -> None:
    patch = b'diff --git a/old.txt b/old.txt\ndeleted file mode 100644\nnew mode 100755\n'
    assert changes(patch) == [('old.txt', '100644', None)]


def test_a_rename_that_changes_the_mode_deletes_the_old_path_with_its_old_mode() -> None:
    patch = (b'diff --git a/docs/a.md b/docs/b.md\nold mode 100644\nnew mode 100755\nsimilarity index 100%\n'
             b'rename from docs/a.md\nrename to docs/b.md\n')
    assert changes(patch) == [('docs/a.md', '100644', None), ('docs/b.md', '100755', BASES['docs/a.md'])]


def test_a_new_file_under_another_name_is_never_a_rename() -> None:
    patch = b'diff --git "a/x" "b/y"\nnew file mode 100644\n--- /dev/null\n+++ "b/y"\n@@ -0,0 +1 @@\n+z\n'
    assert changes(patch) == [('y', '100644', b'z\n')]


def test_a_path_deleted_and_made_again_is_named_once() -> None:
    again = CREATE.replace(b'src/new.py', b'old.txt')
    assert contents(DELETE + again).changed_paths == ('old.txt',)


def test_an_added_line_that_is_not_utf8_is_read_with_its_bytes_replaced() -> None:
    patch = CREATE.replace(b'+B = 2', b'+caf\xff')
    assert contents(patch).added_lines == ('A = 1', 'caf\ufffd')


def test_the_content_bound_takes_exactly_its_bytes_and_says_it_in_mb(monkeypatch: pytest.MonkeyPatch) -> None:
    fixed = b'def total(items):\n    return round(sum(items), 2)\n\n'
    monkeypatch.setattr(patches, 'MAX_CONTENT_BYTES', len(fixed))
    assert contents(MODIFY).changed_paths == ('src/refund.py',)
    monkeypatch.setattr(patches, 'MAX_CONTENT_BYTES', 2 * MB)
    big = b'diff --git a/big.txt b/big.txt\nnew file mode 100644\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1 @@\n+'
    assert reason_of(lambda: contents(big + b'x' * (2 * MB) + b'\n')) == (
        'The patch carries more than 2 MB of content.')
