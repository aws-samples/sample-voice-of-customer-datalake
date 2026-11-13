"""The committer's submitted patch, read for a push (docs/autonomous-engineering.md, "Repository connectors").

The harness's ``submit_work`` writes the agent's working tree as a patch (``git diff --cached --binary`` against the
checkout's commit, the run's) under the agent's own keys,
``ws/<ws>/runs/<run>/<agent>/commits/<commit>/_patches/attempt-<n>/<name>.diff``. The broker's push names it, and
this reader:

* takes only a key of the caller's own: the workspace's layout, the caller's run and agent, the run's commit and the
  ``patches`` kind; anything else is refused before any read;
* reads at most ``MAX_PATCH_BYTES``, refusing a larger patch rather than cutting it;
* applies it file by file to the run's commit as the host has it (``RepositoryHost.file_at``): every hunk must
  match its base exactly (no fuzz, no offset), and a binary file is a literal or a delta on its base. A copy, a
  submodule, a patch without a binary file's content, more than ``MAX_FILES`` files or more than
  ``MAX_CONTENT_BYTES`` of new content are refused;
* answers one commit on the run's commit, with the committer's message, every path it changes (a rename's two) and
  every line it adds, and the tree the board's GO names. The host's client holds the push to that tree: it moves
  the branch only when the tree it rebuilt from these changes is that one, so a patch that is not the GO'd tree
  never lands.

A refusal says what is wrong in a plain sentence and never quotes the patch.
"""
from __future__ import annotations

import base64
import re
import zlib
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Final

from botocore.exceptions import BotoCoreError, ClientError

from engineering.connectors.hosts import FILE_MODES, BundleContents, Commit, FileChange, Submission, Unavailable
from engineering.connectors.identity import WORKSPACE
from engineering.connectors.write_policy import WriteRefused
from engineering.workspace.layout import parse_agent_key
from engineering.workspace.store import ObjectTooLarge, WorkspaceStore

#: The largest patch the broker reads (what it took in a request before: a function URL's 6 MB).
MAX_PATCH_BYTES: Final = 6 * 1024 * 1024
#: The most files one push changes, and the most bytes of new content it carries.
MAX_FILES: Final = 1000
MAX_CONTENT_BYTES: Final = 32 * 1024 * 1024
#: The address the broker records as the pushed commit's author and committer: the host writes its own bot
#: identity in its place (a GitHub App's), so no address an agent chose ever reaches it.
AUTHOR: Final = 'voc-agents@example.invalid'
_HUNK: Final = re.compile(rb'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')
_MODE: Final = re.compile(rb'(?:old|new|deleted file|new file) mode ([0-7]{6})')
_INDEX: Final = re.compile(rb'index [0-9a-f]+\.\.[0-9a-f]+(?: ([0-7]{6}))?')
_LITERAL: Final = re.compile(rb'(literal|delta) (\d{1,10})')
_ESCAPES: Final = {ord('a'): 7, ord('b'): 8, ord('t'): 9, ord('n'): 10, ord('v'): 11, ord('f'): 12, ord('r'): 13,
                   ord('"'): 34, ord('\\'): 92}
_NO_NEWLINE: Final = b'\\ No newline at end of file'
_OCTAL: Final = re.compile(rb'[0-3][0-7]{2}')
#: A path's control characters (C0 and DEL): never in a path the broker pushes.
_CONTROL: Final = re.compile(rb'[\x00-\x1f\x7f]')
_DIFF: Final = b'diff --git '


class PatchRefused(WriteRefused):
    """The submitted patch is not one the broker pushes."""


@dataclass
class _FilePatch:
    """One file's part of the patch, as parsed."""

    old_path: str = ''
    new_path: str = ''
    old_mode: str = ''
    new_mode: str = ''
    created: bool = False
    deleted: bool = False
    hunks: list[tuple[int, int, list[tuple[bytes, bytes]]]] = field(default_factory=list)
    #: A binary file's forward part: ``literal`` or ``delta``, its size, and its zlib data.
    binary: tuple[bytes, int, bytes] | None = None


def _unquote(token: bytes) -> bytes:
    """A path as git wrote it: plain, or in double quotes with C escapes (``core.quotePath``)."""
    if not token.startswith(b'"'):
        return token
    if len(token) < 2 or not token.endswith(b'"'):
        raise PatchRefused('The patch names a path git would not write.')
    out, body, i = bytearray(), token[1:-1], 0
    while i < len(body):
        char = body[i]
        if char != ord('\\'):
            out.append(char)
            i += 1
            continue
        escaped = body[i + 1:i + 2]
        if _OCTAL.fullmatch(body[i + 1:i + 4]):
            out.append(int(body[i + 1:i + 4], 8) & 0xFF)
            i += 4
        elif escaped and escaped[0] in _ESCAPES:
            out.append(_ESCAPES[escaped[0]])
            i += 2
        else:
            raise PatchRefused('The patch names a path git would not write.')
    return bytes(out)


def _path(raw: bytes, prefix: bytes = b'') -> str:
    """A repository path from a patch line (after git's ``a/`` or ``b/`` ``prefix``, when the line has one), never
    one that climbs out of the repository or into its ``.git``."""
    name = _unquote(raw.removesuffix(b'\t'))
    if not name.startswith(prefix):
        raise PatchRefused("The patch's paths carry git's a/ and b/ prefixes, and only those.")
    if _CONTROL.search(name):
        raise PatchRefused('The patch names a path with a control character.')
    try:
        path = name[len(prefix):].decode('utf-8')
    except UnicodeDecodeError:
        raise PatchRefused('The patch names a path that is not UTF-8.') from None
    if any(part in {'', '.', '..', '.git'} for part in path.split('/')):
        raise PatchRefused('The patch names a path outside the repository.')
    return path


def _quoted_end(rest: bytes) -> int:
    """The index just after the double-quoted name ``rest`` starts with (0: it has no closing quote)."""
    i = 1
    while i < len(rest):
        if rest[i] == ord('\\'):
            i += 2
        elif rest[i] == ord('"'):
            return i + 1
        else:
            i += 1
    return 0


def _header_paths(rest: bytes) -> tuple[str, str]:
    """The two paths of ``diff --git a/X b/Y`` when they can be told apart: both quoted, or plain and the same (a mode
    change, a binary file); ``('', '')`` otherwise (a rename's ``rename from``/``to`` lines, or the ``---``/``+++``
    lines, name them)."""
    if rest.startswith(b'"'):
        end = _quoted_end(rest)
        if end and rest[end:end + 1] == b' ':
            return _path(rest[:end], b'a/'), _path(rest[end + 1:], b'b/')
        return '', ''
    half = (len(rest) - 1) // 2
    if len(rest) % 2 == 0 or rest[half:half + 1] != b' ' or rest[2:half] != rest[half + 3:]:
        return '', ''
    return _path(rest[:half], b'a/'), _path(rest[half + 1:], b'b/')


def _hunk_lines(lines: list[bytes], i: int, old: int, new: int) -> tuple[list[tuple[bytes, bytes]], int]:
    """A hunk's lines (kind, line with its newline), from ``lines[i]``; the index after it."""
    body: list[tuple[bytes, bytes]] = []
    seen_old = seen_new = 0
    while i < len(lines) and (seen_old < old or seen_new < new):
        line = lines[i]
        kind = line[:1]
        if kind not in {b' ', b'-', b'+'}:
            break
        body.append((kind, line[1:] + b'\n'))
        seen_old += kind != b'+'
        seen_new += kind != b'-'
        i += 1
        if i < len(lines) and lines[i] == _NO_NEWLINE:
            body[-1] = (kind, body[-1][1][:-1])
            i += 1
    if (seen_old, seen_new) != (old, new):
        raise PatchRefused("A hunk of the patch does not have the lines its header counts.")
    return body, i


def _binary(lines: list[bytes], i: int) -> tuple[tuple[bytes, int, bytes], int]:
    """The forward part of a ``GIT binary patch`` (``lines[i]`` is its ``literal``/``delta`` line); the index after
    the whole patch (its reverse part too)."""
    head = _LITERAL.fullmatch(lines[i]) if i < len(lines) else None
    if head is None:
        raise PatchRefused('A binary file of the patch has no literal or delta.')
    data, i = bytearray(), i + 1
    while i < len(lines) and lines[i]:
        line = lines[i]
        size = line[0] - ord('A') + 1 if 65 <= line[0] <= 90 else line[0] - ord('a') + 27 if 97 <= line[0] <= 122 \
            else 0
        if not size or len(line) - 1 != (size + 3) // 4 * 5:
            raise PatchRefused('A binary file of the patch is not encoded the way git encodes it.')
        try:
            data += base64.b85decode(line[1:])[:size]
        except ValueError:
            raise PatchRefused('A binary file of the patch is not encoded the way git encodes it.') from None
        i += 1
    while i < len(lines) and not lines[i].startswith(_DIFF):   # the reverse part, which a push does not need
        i += 1
    return (head.group(1), int(head.group(2)), bytes(data)), i


def _header_line(file: _FilePatch, line: bytes) -> None:
    """One extended header line of a file's part."""
    mode = _MODE.fullmatch(line)
    if mode is not None:
        value = mode.group(1).decode()
        if line.startswith((b'old', b'deleted')):
            file.old_mode = value
            file.deleted = line.startswith(b'deleted')
        else:
            file.new_mode = value
            file.created = line.startswith(b'new file')
    elif line.startswith(b'rename from '):
        file.old_path = _path(line[len(b'rename from '):])
    elif line.startswith(b'rename to '):
        file.new_path = _path(line[len(b'rename to '):])
    elif line.startswith((b'copy from ', b'copy to ')):
        raise PatchRefused('The patch copies a file; the broker pushes changes, renames and deletions only.')
    elif line.startswith(b'Binary files '):
        raise PatchRefused("The patch has a binary file without its content; make it with git's --binary.")
    elif (index := _INDEX.fullmatch(line)) is not None:
        if index.group(1) and not (file.old_mode or file.new_mode):   # (the mode of a file whose mode is unchanged)
            file.old_mode = file.new_mode = index.group(1).decode()
    elif not line.startswith((b'similarity index ', b'dissimilarity index ')):
        raise PatchRefused('The patch has a line the broker cannot read.')


def _file(lines: list[bytes], i: int) -> tuple[_FilePatch, int]:
    """One file's part, from its ``diff --git`` line at ``lines[i]``; the index of the next part."""
    file = _FilePatch()
    file.old_path, file.new_path = _header_paths(lines[i][len(_DIFF):])
    i += 1
    while i < len(lines) and not lines[i].startswith((_DIFF, b'--- ', b'GIT binary patch')) and lines[i]:
        _header_line(file, lines[i])
        i += 1
    if i < len(lines) and lines[i] == b'GIT binary patch':
        file.binary, i = _binary(lines, i + 1)
    elif i + 1 < len(lines) and lines[i].startswith(b'--- ') and lines[i + 1].startswith(b'+++ '):
        if lines[i] != b'--- /dev/null':
            file.old_path = _path(lines[i][4:], b'a/')
        if lines[i + 1] != b'+++ /dev/null':
            file.new_path = _path(lines[i + 1][4:], b'b/')
        i += 2
        while i < len(lines) and (hunk := _HUNK.match(lines[i])) is not None:
            old, new = (int(hunk.group(n)) if hunk.group(n) is not None else 1 for n in (2, 4))
            body, i = _hunk_lines(lines, i + 1, old, new)
            file.hunks.append((int(hunk.group(1)), old, body))
    while i < len(lines) and not lines[i]:
        i += 1
    if i < len(lines) and not lines[i].startswith(_DIFF):
        raise PatchRefused('The patch has a line the broker cannot read.')
    if not (file.old_path and file.new_path):
        raise PatchRefused('The patch has a file header the broker cannot read.')
    return file, i


def parse(patch: bytes) -> list[_FilePatch]:
    """The patch's files, in order; ``PatchRefused`` for anything ``git diff --binary`` would not write."""
    lines = patch.split(b'\n')
    if lines and not lines[-1]:
        lines.pop()
    if not lines or not lines[0].startswith(_DIFF):
        raise PatchRefused('The submitted patch changes nothing the broker can read.')
    files: list[_FilePatch] = []
    i = 0
    while i < len(lines):
        file, i = _file(lines, i)
        files.append(file)
        if len(files) > MAX_FILES:
            raise PatchRefused(f'The patch changes more than {MAX_FILES} files.')
    return files


def _split_lines(data: bytes) -> list[bytes]:
    """``data``'s lines, each with its ``\\n`` (the last without one when the file has no final newline)."""
    lines = [line + b'\n' for line in data.split(b'\n')]
    lines[-1] = lines[-1][:-1]
    return lines if lines[-1] else lines[:-1]


def apply_hunks(base: bytes, hunks: list[tuple[int, int, list[tuple[bytes, bytes]]]]) -> bytes:
    """``base`` with ``hunks`` applied, each where its header says and only when its old lines are exactly there."""
    old, out, cursor = _split_lines(base), [], 0
    for start, count, body in hunks:
        at = start - 1 if count else start
        expected = [line for kind, line in body if kind != b'+']
        if at < cursor or old[at:at + len(expected)] != expected:
            raise PatchRefused("A hunk of the patch does not match the run's commit; make the patch on it again.")
        out += old[cursor:at]
        out += [line for kind, line in body if kind != b'-']
        cursor = at + len(expected)
    return b''.join(out + old[cursor:])


_BAD_DELTA: Final = 'A binary file of the patch is not a delta git would write.'


def _byte(data: bytes, at: int) -> int:
    if at >= len(data):
        raise PatchRefused(_BAD_DELTA)
    return data[at]


def _varint(data: bytes, at: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        byte = _byte(data, at)
        value |= (byte & 0x7F) << shift
        shift, at = shift + 7, at + 1
        if not byte & 0x80:
            return value, at


def _copy_op(op: int, delta: bytes, at: int) -> tuple[int, int, int]:
    """A copy op's offset and size (the bytes its low seven bits say follow, little-endian; a size of 0 is
    0x10000), and the index after it."""
    offset = size = 0
    for bit in range(7):
        if op & (1 << bit):
            value, at = _byte(delta, at), at + 1
            if bit < 4:
                offset |= value << (8 * bit)
            else:
                size |= value << (8 * (bit - 4))
    return offset, size or 0x10000, at


def apply_delta(base: bytes, delta: bytes) -> bytes:
    """git's binary delta (copies from ``base`` and inserts) applied to ``base``; ``PatchRefused`` for one that is
    not for this base or not well formed."""
    source, at = _varint(delta, 0)
    target, at = _varint(delta, at)
    if source != len(base):
        raise PatchRefused("A binary file of the patch is not a change of the run's commit's file.")
    if target > MAX_CONTENT_BYTES:   # (before anything is built: a delta can grow a file far past its own size)
        raise PatchRefused(f'A file of the patch is over {MAX_CONTENT_BYTES // (1024 * 1024)} MB.')
    out = bytearray()
    while at < len(delta) and len(out) <= target:
        op, at = delta[at], at + 1
        if op & 0x80:
            offset, size, at = _copy_op(op, delta, at)
            piece = base[offset:offset + size] if offset + size <= len(base) else b''
        else:
            piece = delta[at:at + op] if at + op <= len(delta) else b''
            at += op
        if not piece:   # (op 0, or a copy or an insert past its data)
            raise PatchRefused(_BAD_DELTA)
        out += piece
    if len(out) != target:
        raise PatchRefused(_BAD_DELTA)
    return bytes(out)


#: git's own test for binary content: a NUL byte in the first 8000 bytes.
BINARY_PROBE_BYTES: Final = 8000
_BOM: Final = chr(0xFEFF)


def _require_binary(content: bytes) -> None:
    """A binary hunk only for content git itself calls binary (a NUL byte in its first ``BINARY_PROBE_BYTES``): the
    write rules read the lines a text hunk adds, so text sent as a ``GIT binary patch`` (in UTF-8, another encoding,
    or with one invalid byte) would pass them unread. UTF-16 text has NUL bytes, so content that reads as printable
    UTF-16 (either byte order, a byte-order mark or none) is text too."""
    probe = content[:BINARY_PROBE_BYTES]
    if b'\x00' not in probe or _utf16_text(probe):
        raise PatchRefused('The patch sends a text file as binary; make it as a text diff, which the write rules '
                           'read.')


def _utf16_text(probe: bytes) -> bool:
    """``probe`` reads as UTF-16 text: every character printable or whitespace, in one byte order or the other."""
    usable = probe[:len(probe) - len(probe) % 2]
    for encoding in ('utf-16-le', 'utf-16-be'):
        try:
            text = usable.decode(encoding).removeprefix(_BOM)
        except UnicodeDecodeError:
            continue
        if text and all(char.isprintable() or char in '\t\n\r\f\v' for char in text):
            return True
    return False


def _inflate(data: bytes, size: int) -> bytes:
    if size > MAX_CONTENT_BYTES:
        raise PatchRefused(f'A file of the patch is over {MAX_CONTENT_BYTES // (1024 * 1024)} MB.')
    try:
        inflated = zlib.decompressobj().decompress(data, size + 1)
    except zlib.error:
        raise PatchRefused('A binary file of the patch is not encoded the way git encodes it.') from None
    if len(inflated) != size:
        raise PatchRefused('A binary file of the patch is not the size it says.')
    return inflated


class WorkspacePatches:
    """The ``BundleReader`` over the workspace bucket (the caller's own patch keys) and the host's base files."""

    def __init__(self, workspace: WorkspaceStore, base: Callable[[str, str, str], bytes | None]) -> None:
        """``base``: ``RepositoryHost.file_at`` (connection, commit, path)."""
        self._workspace = workspace
        self._base = base

    def _patch(self, submission: Submission) -> bytes:
        key = parse_agent_key(submission.key) if len(submission.key) <= 512 else None
        own = key is not None and (key.ws, key.run_id, key.agent, key.kind, key.sha) == (
            WORKSPACE, submission.run_id, submission.agent_id, 'patches', submission.run.commit)
        if key is None or not own or not key.name.endswith('.diff'):
            raise PatchRefused("An agent pushes only a patch it submitted itself, on the run's commit "
                               f'(ws/{WORKSPACE}/runs/<run>/<agent>/commits/<commit>/_patches/...).')
        try:
            patch = self._workspace.read_bytes(submission.key, MAX_PATCH_BYTES)
        except ObjectTooLarge:
            raise PatchRefused(f'The patch is over {MAX_PATCH_BYTES // (1024 * 1024)} MB.') from None
        except (ClientError, BotoCoreError) as exc:   # a throttle or a lost connection; the reason names no key
            raise Unavailable('The workspace could not be read; retry.') from exc
        if patch is None:
            raise PatchRefused('The patch is not in the workspace; submit the work again.')
        return patch

    def _base_file(self, submission: Submission, path: str) -> bytes:
        found = self._base(submission.run.connection_id, submission.run.commit, path)
        if found is None:
            raise PatchRefused(f"The patch changes {path}, which the run's commit does not have.")
        return found

    def _changes(self, submission: Submission, file: _FilePatch) -> list[FileChange]:
        mode = file.new_mode or file.old_mode or '100644'
        if mode not in FILE_MODES or (file.old_mode and file.old_mode not in FILE_MODES):
            raise PatchRefused('The patch changes a submodule or a mode git does not push as a file.')
        if file.deleted:
            return [FileChange(path=file.old_path, mode=file.old_mode or mode, content=None)]
        if file.binary is not None:
            kind, size, data = file.binary
            inflated = _inflate(data, size)
            content = inflated if kind == b'literal' else apply_delta(self._base_file(submission, file.old_path),
                                                                      inflated)
            _require_binary(content)
        elif file.created:
            content = apply_hunks(b'', file.hunks)
        else:
            content = apply_hunks(self._base_file(submission, file.old_path), file.hunks)
        renamed = not file.created and file.old_path != file.new_path
        gone = [FileChange(path=file.old_path, mode=file.old_mode or mode, content=None)] if renamed else []
        return [*gone, FileChange(path=file.new_path, mode=mode, content=content)]

    def contents(self, submission: Submission) -> BundleContents:
        files = parse(self._patch(submission))
        changes: list[FileChange] = []
        total = 0
        for file in files:   # (the running total: refused at the first file past the bound, before the next is built)
            for change in self._changes(submission, file):
                total += len(change.content or b'')
                if total > MAX_CONTENT_BYTES:
                    raise PatchRefused(
                        f'The patch carries more than {MAX_CONTENT_BYTES // (1024 * 1024)} MB of content.')
                changes.append(change)
        added = [line.decode('utf-8', errors='replace').removesuffix('\n') for file in files
                 for _, _, body in file.hunks for kind, line in body if kind == b'+']
        commit = Commit(message=submission.message, author=AUTHOR, committer=AUTHOR, changes=tuple(changes))
        return BundleContents(heads=(f'refs/heads/{submission.branch}',), tree_hash=submission.tree_hash,
                              changed_paths=tuple(dict.fromkeys(change.path for change in changes)),
                              commits=(commit,), added_lines=tuple(added), base=submission.run.commit)
