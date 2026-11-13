"""The committer's submitted patch, read for a push (patches.py): only the caller's own keys, bounded, applied exactly
to the run's commit, and every refusal plain."""
from __future__ import annotations

import base64
import zlib
from collections.abc import Iterator
from dataclasses import replace
from typing import Any

import boto3
import pytest
from moto import mock_aws

from engineering.connectors import patches
from engineering.connectors.hosts import FileChange, Submission, Unavailable
from engineering.connectors.patches import AUTHOR, PatchRefused, WorkspacePatches, apply_delta, apply_hunks, parse
from engineering.connectors.test.fakes import BASE, BRANCH, RUN, TREE, FakeHost, record
from engineering.workspace.store import WorkspaceStore

BUCKET = 'voc-eng-workspace'
AGENT = 'committer-1'
KEY = f'ws/default/runs/{RUN}/{AGENT}/commits/{BASE}/_patches/attempt-1/task-1-0a1b2c3d.diff'
MESSAGE = 'Fix the refund total (fb_0123abcd)'
REFUND = b'def total(items):\n    return sum(items)\n\n'
MODIFY = b'''diff --git a/src/refund.py b/src/refund.py
index 3b18e51..8c7e5a6 100644
--- a/src/refund.py
+++ b/src/refund.py
@@ -1,3 +1,3 @@
 def total(items):
-    return sum(items)
+    return round(sum(items), 2)
''' + b' \n'   # (the empty line's context: git writes it as one space)
CREATE = b'''diff --git a/src/new.py b/src/new.py
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/src/new.py
@@ -0,0 +1,2 @@
+A = 1
+B = 2
'''
DELETE = b'''diff --git a/old.txt b/old.txt
deleted file mode 100644
index 3b18e51..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
'''
RENAME = b'''diff --git a/docs/a.md b/docs/b.md
similarity index 80%
rename from docs/a.md
rename to docs/b.md
index 1111111..2222222 100644
--- a/docs/a.md
+++ b/docs/b.md
@@ -1,2 +1,2 @@
 Title
-old line
+new line
'''
MODE = b'''diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
'''
NO_NEWLINE = b'''diff --git a/x.txt b/x.txt
index 1111111..2222222 100644
--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-a
\\ No newline at end of file
+b
\\ No newline at end of file
'''
QUOTED = b'''diff --git "a/caf\\303\\251 menu.txt" "b/caf\\303\\251 menu.txt"
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ "b/caf\\303\\251 menu.txt"\t
@@ -0,0 +1 @@
+soup
'''
#: An image's first bytes: binary as git judges it (a NUL in its first 8000 bytes).
PNG = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR'
BASES = {'src/refund.py': REFUND, 'docs/a.md': b'Title\nold line\n', 'run.sh': b'#!/bin/sh\n', 'x.txt': b'a',
         'img.bin': bytes(range(64))}


def git_binary(data: bytes) -> bytes:
    """``data`` as git writes it in a binary patch: zlib, then base85 in lines of at most 52 bytes, each led by its
    length (``A``-``Z`` 1-26, ``a``-``z`` 27-52)."""
    packed = zlib.compress(data)
    lines = []
    for at in range(0, len(packed), 52):
        chunk = packed[at:at + 52]
        size = len(chunk)
        lead = chr(ord('A') + size - 1) if size <= 26 else chr(ord('a') + size - 27)
        lines.append(lead.encode() + base64.b85encode(chunk, pad=True))
    return b'\n'.join(lines)


def varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte, value = value & 0x7F, value >> 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def delta(base: bytes, copy: int, insert: bytes) -> bytes:
    """git's delta: the first ``copy`` bytes of ``base`` (one copy op, offset 0), then ``insert``."""
    return varint(len(base)) + varint(copy + len(insert)) + bytes([0x90, copy]) + bytes([len(insert)]) + insert


def binary_section(kind: str, payload: bytes, size: int, header: bytes = b'index 1111111..2222222 100644') -> bytes:
    return (b'diff --git a/img.bin b/img.bin\n' + header + b'\nGIT binary patch\n'
            + f'{kind} {size}\n'.encode() + git_binary(payload) + b'\n\nliteral 0\nHcmV?d00001\n\n')


def submission(key: str = KEY, **overrides: Any) -> Submission:
    return replace(Submission(run_id=RUN, agent_id=AGENT, run=record(), key=key, branch=BRANCH, tree_hash=TREE,
                              message=MESSAGE), **overrides)


@pytest.fixture
def s3() -> Iterator[Any]:
    with mock_aws():
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket=BUCKET)
        yield client


def reader(s3: Any, patch: bytes | None, host: FakeHost | None = None) -> tuple[WorkspacePatches, FakeHost]:
    if patch is not None:
        s3.put_object(Bucket=BUCKET, Key=KEY, Body=patch)
    host = host or FakeHost(files=dict(BASES))
    return WorkspacePatches(WorkspaceStore(s3, BUCKET, denied_is_missing=True), host.file_at), host


def by_path(changes: tuple[FileChange, ...]) -> dict[str, tuple[str, bytes | None]]:
    return {change.path: (change.mode, change.content) for change in changes}


def test_a_patch_becomes_one_commit_on_the_runs_commit_for_the_govd_tree(s3: Any) -> None:
    patches_, host = reader(s3, MODIFY + CREATE + DELETE + RENAME + MODE + NO_NEWLINE)
    contents = patches_.contents(submission())
    (commit,) = contents.commits
    assert (contents.heads, contents.tree_hash, contents.base) == ((f'refs/heads/{BRANCH}',), TREE, BASE)
    assert (commit.message, commit.author, commit.committer) == (MESSAGE, AUTHOR, AUTHOR)
    assert by_path(commit.changes) == {
        'src/refund.py': ('100644', b'def total(items):\n    return round(sum(items), 2)\n\n'),
        'src/new.py': ('100644', b'A = 1\nB = 2\n'),
        'old.txt': ('100644', None),
        'docs/a.md': ('100644', None),
        'docs/b.md': ('100644', b'Title\nnew line\n'),
        'run.sh': ('100755', b'#!/bin/sh\n'),
        'x.txt': ('100644', b'b'),
    }
    # Every path it changes (a rename's two), and every line it adds: what the write rules read.
    assert contents.changed_paths == ('src/refund.py', 'src/new.py', 'old.txt', 'docs/a.md', 'docs/b.md', 'run.sh',
                                      'x.txt')
    assert contents.added_lines == ('    return round(sum(items), 2)', 'A = 1', 'B = 2', 'new line', 'b')
    # Each base read at the run's commit; a new or a deleted file needs none.
    assert [c for c in host.calls if c[0] == 'file_at'] == [
        ('file_at', 'conn-1', BASE, path) for path in ('src/refund.py', 'docs/a.md', 'run.sh', 'x.txt')]


def test_a_quoted_path_is_read_as_git_wrote_it(s3: Any) -> None:
    patches_, _ = reader(s3, QUOTED)
    assert by_path(patches_.contents(submission()).commits[0].changes) == {'café menu.txt': ('100644', b'soup\n')}


def test_a_binary_file_is_a_literal_or_a_delta_on_its_base(s3: Any) -> None:
    base = BASES['img.bin']
    changed = delta(base, 10, b'\xff\xfe')
    literal = binary_section('literal', PNG, len(PNG), b'new file mode 100644\nindex 0000000..2222222')
    patches_, _ = reader(s3, literal.replace(b'img.bin', b'logo.png') + binary_section('delta', changed, len(changed)))
    contents = patches_.contents(submission())
    assert by_path(contents.commits[0].changes) == {'logo.png': ('100644', PNG),
                                                    'img.bin': ('100644', base[:10] + b'\xff\xfe')}
    assert contents.added_lines == ()


@pytest.mark.parametrize(('key', 'why'), [
    (KEY.replace(AGENT, 'committer-2'), "another agent's patch"),
    (KEY.replace(RUN, '01JC8Z3K4M5N6P7Q8R9S0T1V2X'), "another run's patch"),
    (KEY.replace(BASE, 'b' * 40), 'a patch on another commit'),
    (KEY.replace('_patches', '_checkpoints'), 'a checkpoint'),
    (KEY.replace('.diff', '.json'), 'not a patch'),
    (KEY.replace('ws/default', 'ws/other'), 'another workspace'),
    ('raw/feedback/x.json', 'not the workspace layout'),
    (KEY + 'x' * 600, 'too long a key'),
])
def test_only_the_callers_own_patch_on_the_runs_commit_is_read(s3: Any, key: str, why: str) -> None:
    patches_, host = reader(s3, MODIFY)
    with pytest.raises(PatchRefused) as caught:
        patches_.contents(submission(key))
    assert caught.value.reason.startswith('An agent pushes only a patch it submitted itself'), why
    assert host.calls == []


def test_a_patch_over_its_bound_is_refused_not_cut(s3: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(patches, 'MAX_PATCH_BYTES', len(MODIFY) - 1)
    patches_, _ = reader(s3, MODIFY)
    with pytest.raises(PatchRefused) as caught:
        patches_.contents(submission())
    assert caught.value.reason == 'The patch is over 0 MB.'


@pytest.mark.parametrize(('patch', 'expected'), [
    (None, 'The patch is not in the workspace; submit the work again.'),
    (b'', 'The submitted patch changes nothing the broker can read.'),
    (b'not a patch\n', 'The submitted patch changes nothing the broker can read.'),
])
def test_a_missing_or_empty_patch_is_refused(s3: Any, patch: bytes | None, expected: str) -> None:
    patches_, _ = reader(s3, patch)
    with pytest.raises(PatchRefused) as caught:
        patches_.contents(submission())
    assert caught.value.reason == expected


def test_a_workspace_that_cannot_be_read_is_unavailable_never_a_refusal() -> None:
    class Down:
        def get_object(self, **_: Any) -> Any:
            from botocore.exceptions import ClientError
            raise ClientError({'Error': {'Code': 'SlowDown', 'Message': 'later'}}, 'GetObject')

    patches_ = WorkspacePatches(WorkspaceStore(Down(), BUCKET), FakeHost().file_at)
    with pytest.raises(Unavailable):
        patches_.contents(submission())


@pytest.mark.parametrize(('patch', 'expected'), [
    (MODIFY.replace(b' def total', b' def totals'), 'does not match the run\'s commit'),
    (MODIFY.replace(b'@@ -1,3 +1,3 @@', b'@@ -2,3 +2,3 @@'), 'does not match the run\'s commit'),
    (MODIFY.replace(b'@@ -1,3 +1,3 @@', b'@@ -1,4 +1,3 @@'), 'does not have the lines its header counts'),
    (MODIFY + b'trailing garbage\n', 'a line the broker cannot read'),
    (MODIFY.replace(b'a/src', b'c/src'), "git's a/ and b/ prefixes"),
    (MODIFY.replace(b'src/refund.py', b'../refund.py'), 'outside the repository'),
    (MODIFY.replace(b'src/refund.py', b'.git/config'), 'outside the repository'),
    (CREATE.replace(b'src/new.py', b'src/sub').replace(b'new file mode 100644', b'new file mode 160000'),
     'a submodule'),
    (RENAME.replace(b'rename from', b'copy from').replace(b'rename to', b'copy to'), 'copies a file'),
    (b'diff --git a/i.png b/i.png\nindex 1111111..2222222 100644\nBinary files a/i.png and b/i.png differ\n',
     'without its content'),
    (b'diff --git a/i.png b/i.png\nindex 1111111..2222222 100644\nGIT binary patch\nliteral x\n', 'no literal or delta'),
    (b'diff --git a/i.png b/i.png\nindex 1111111..2222222 100644\nGIT binary patch\nliteral 3\nB!!\n',
     'not encoded the way git encodes it'),
    (b'diff --git a/x y b/z w\nindex 1111111..2222222 100644\n', 'a file header the broker cannot read'),
    (b'diff --git "a/x\\q" "b/x"\nnew file mode 100644\n', 'a path git would not write'),
    (b'diff --git a/\xff b/\xff\nold mode 100644\nnew mode 100755\n', 'not UTF-8'),
    (MODIFY.replace(b'index 3b18e51..8c7e5a6 100644', b'unknown header'), 'a line the broker cannot read'),
])
def test_a_patch_git_would_not_write_or_that_does_not_apply_is_refused(s3: Any, patch: bytes, expected: str) -> None:
    patches_, _ = reader(s3, patch)
    with pytest.raises(PatchRefused) as caught:
        patches_.contents(submission())
    assert expected in caught.value.reason
    assert b'refund' not in caught.value.reason.encode()   # (never the patch's own text)


def test_a_file_the_runs_commit_does_not_have_is_refused(s3: Any) -> None:
    patches_, _ = reader(s3, MODIFY, FakeHost())
    with pytest.raises(PatchRefused) as caught:
        patches_.contents(submission())
    assert caught.value.reason == "The patch changes src/refund.py, which the run's commit does not have."


def test_too_many_files_or_too_much_content_is_refused(s3: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(patches, 'MAX_FILES', 1)
    patches_, _ = reader(s3, MODIFY + CREATE)
    with pytest.raises(PatchRefused, match='more than 1 files'):
        patches_.contents(submission())
    monkeypatch.setattr(patches, 'MAX_FILES', 10)
    monkeypatch.setattr(patches, 'MAX_CONTENT_BYTES', 10)
    with pytest.raises(PatchRefused, match='more than 0 MB of content'):
        patches_.contents(submission())
    with pytest.raises(PatchRefused, match='over 0 MB'):
        reader(s3, binary_section('literal', b'x' * 11, 11))[0].contents(submission())


@pytest.mark.parametrize(('patch_delta', 'expected'), [
    (delta(b'short', 2, b'x'), 'not a change of the run'),
    (varint(64) + varint(1) + b'\x00', 'not a delta git would write'),
    (varint(64) + varint(1) + bytes([0x90, 99]), 'not a delta git would write'),
    (varint(64) + varint(9) + bytes([5]) + b'ab', 'not a delta git would write'),
    (varint(64) + varint(1) + bytes([2]) + b'ab', 'not a delta git would write'),
    (varint(64) + varint(9) + bytes([1]) + b'a', 'not a delta git would write'),
])
def test_a_delta_that_is_not_for_its_base_is_refused(patch_delta: bytes, expected: str) -> None:
    with pytest.raises(PatchRefused) as caught:
        apply_delta(BASES['img.bin'], patch_delta)
    assert expected in caught.value.reason


def test_a_delta_copies_with_offsets_and_the_large_copy_size() -> None:
    base = bytes(range(256)) * 300
    assert apply_delta(base, varint(len(base)) + varint(4) + bytes([0x91, 7, 4])) == base[7:11]
    assert apply_delta(base, varint(len(base)) + varint(0x10000) + bytes([0x80])) == base[:0x10000]


SENTENCE = 'QUOTE = "a sentence the write rules must read, café"\n'


@pytest.mark.parametrize('text', [SENTENCE.encode(), SENTENCE.encode('latin-1'), SENTENCE.encode('utf-16-le'),
                                  SENTENCE.encode('utf-16'), SENTENCE.encode('utf-16-be'),
                                  SENTENCE.encode().replace(b'a sentence', b'a \xff sentence')],
                         ids=['UTF-8', 'Latin-1', 'UTF-16', 'UTF-16 with its mark', 'UTF-16 big-endian',
                              'one invalid byte'])
@pytest.mark.parametrize('kind', ['literal', 'delta'])
def test_text_sent_as_a_binary_patch_is_refused_so_the_write_rules_read_every_added_line(s3: Any, kind: str,
                                                                                         text: bytes) -> None:
    base = BASES['img.bin']   # (the delta inserts the text alone: nothing of its binary base is copied)
    payload = text if kind == 'literal' else varint(len(base)) + varint(len(text)) + bytes([len(text)]) + text
    patches_, _ = reader(s3, binary_section(kind, payload, len(payload)))
    with pytest.raises(PatchRefused) as caught:
        patches_.contents(submission())
    assert caught.value.reason == ('The patch sends a text file as binary; make it as a text diff, which the write '
                                   'rules read.')


def test_a_delta_whose_target_is_over_the_bound_is_refused_before_it_is_built(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(patches, 'MAX_CONTENT_BYTES', 1024)
    huge = varint(len(BASES['img.bin'])) + varint(1025) + bytes([0x80]) * 2   # (two 64 KB copies, never made)
    with pytest.raises(PatchRefused, match='over 0 MB'):
        apply_delta(BASES['img.bin'], huge)


def test_the_content_bound_is_a_running_total_refused_at_the_file_past_it(s3: Any,
                                                                         monkeypatch: pytest.MonkeyPatch) -> None:
    fixed = b'def total(items):\n    return round(sum(items), 2)\n\n'
    monkeypatch.setattr(patches, 'MAX_CONTENT_BYTES', len(fixed) + 5)   # (the first file fits, the second does not)
    patches_, host = reader(s3, MODIFY + CREATE + RENAME)
    with pytest.raises(PatchRefused, match='of content'):
        patches_.contents(submission())
    # The third file was never built: its base was not read.
    assert ('file_at', 'conn-1', BASE, 'docs/a.md') not in host.calls


@pytest.mark.parametrize(('header', 'expected'), [
    (b'diff --git "a/x\\9q" "b/x\\9q"\nnew file mode 100644\n', 'a path git would not write'),
    (b'diff --git "a/x\\477" "b/x\\477"\nnew file mode 100644\n', 'a path git would not write'),
    (b'diff --git "a/x\\001y" "b/x\\001y"\nnew file mode 100644\n', 'a control character'),
    (b'diff --git "a/x\\ty" "b/x\\ty"\nnew file mode 100644\n', 'a control character'),
])
def test_a_bad_escape_or_a_control_character_in_a_path_is_refused_plainly(header: bytes, expected: str) -> None:
    with pytest.raises(PatchRefused, match=expected):
        parse(header)


def test_a_binary_literal_whose_size_is_wrong_is_refused(s3: Any) -> None:
    patches_, _ = reader(s3, binary_section('literal', b'abc', 4))
    with pytest.raises(PatchRefused, match='not the size it says'):
        patches_.contents(submission())


def test_hunks_apply_in_order_at_their_lines() -> None:
    base = b''.join(f'line {n}\n'.encode() for n in range(1, 11))
    hunks = [(2, 1, [(b'-', b'line 2\n'), (b'+', b'LINE 2\n')]), (9, 1, [(b'-', b'line 9\n')]),
             (10, 0, [(b'+', b'line 11\n')])]
    assert apply_hunks(base, hunks) == base.replace(b'line 2\n', b'LINE 2\n').replace(b'line 9\n', b'') + b'line 11\n'
    with pytest.raises(PatchRefused):   # (out of order: one hunk before the last one's end)
        apply_hunks(base, [hunks[1], hunks[0]])


def test_parse_reads_each_file_once() -> None:
    files = parse(MODIFY + MODE)
    assert [(f.old_path, f.new_path, f.old_mode, f.new_mode) for f in files] == [
        ('src/refund.py', 'src/refund.py', '100644', '100644'), ('run.sh', 'run.sh', '100644', '100755')]
