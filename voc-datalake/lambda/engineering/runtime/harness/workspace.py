"""The agent's file tools, confined to its checkout: never through a link, never into ``.git``.

Repository code (user ``code``) can change the working tree at any moment, links included, so a path is
never resolved by the kernel from the checkout's root: it is walked one directory at a time from a
descriptor of the root, each step opened with ``O_NOFOLLOW | O_DIRECTORY``, and the file itself with
``O_NOFOLLOW`` (and ``O_NONBLOCK`` on reads, so a FIFO planted in its place cannot hang the agent). A link
anywhere on the way is refused, not followed. Reads and listings are bounded; what they return is the
repository's text, which the adapters hand to the model as data, never as instructions.
"""
from __future__ import annotations

import contextlib
import os
import stat
from collections.abc import Generator
from typing import Final

MAX_READ_BYTES: Final = 200 * 1024
MAX_WRITE_BYTES: Final = 1024 * 1024
MAX_LISTED: Final = 500
#: Working-tree files the agent writes stay writable by the group, so later repository steps (a formatter,
#: a code generator) can rewrite them; the working tree is the one place both users share.
WRITTEN_MODE: Final = 0o664
WRITTEN_DIRECTORY_MODE: Final = 0o775
MAX_NAME_BYTES: Final = 255


class OutsideCheckout(ValueError):
    """A path that leaves the checkout, names its git directory, goes through a link or is not a plain path."""


def parts_of(path: str) -> list[str]:
    """``path``'s components, when it is a path inside the checkout; else ``OutsideCheckout``.

    Any name a repository may hold is fine (``[slug]``, ``(group)``, non-ASCII): only an absolute path, ``..``,
    ``.git`` and NUL are refused, since every component is then opened without following a link.
    """
    if not path or path.startswith('/') or '\x00' in path:
        raise OutsideCheckout(f'{path!r} is not a path inside the checkout')
    parts = [part for part in path.split('/') if part not in ('', '.')]
    for part in parts:
        if part == '..' or part.lower() == '.git' or len(part.encode('utf-8', 'surrogateescape')) > MAX_NAME_BYTES:
            raise OutsideCheckout(f'{path!r} is not a path inside the checkout (no "..", no .git)')
    return parts


class Workspace:
    """Read, list and write files of the checkout at ``root`` (``/work/repo`` in the image)."""

    def __init__(self, root: str) -> None:
        self.root = root

    @contextlib.contextmanager
    def _directory(self, parts: list[str], *, create: bool = False) -> Generator[int]:
        """A descriptor of the directory ``parts`` under the root, walked without following any link."""
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in parts:
                made = False
                if create:
                    with contextlib.suppress(FileExistsError):
                        os.mkdir(part, 0o700, dir_fd=fd)
                        made = True
                try:
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                except FileNotFoundError:
                    raise
                except OSError as error:
                    raise OutsideCheckout(f'{part!r} is not a directory of the checkout (or is a link)') from error
                if made:
                    # Opened to the group as the checkout's own directories are (the agent's umask takes g+w).
                    os.fchmod(child, WRITTEN_DIRECTORY_MODE)
                os.close(fd)
                fd = child
            yield fd
        finally:
            os.close(fd)

    def read(self, path: str) -> str:
        """The file's text (at most 200 KB, the rest cut and said so)."""
        *folders, name = parts_of(path) or ['']
        if not name:
            raise OutsideCheckout('a file path is needed')
        with self._directory(folders) as parent:
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            except OSError as error:
                raise OutsideCheckout(f'{path!r} is not a file of the checkout (or is a link)') from error
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise OutsideCheckout(f'{path!r} is not a regular file')
                if info.st_nlink > 1:
                    # A hard link may name a file outside the checkout (the agent's session): never read one.
                    raise OutsideCheckout(f'{path!r} has more than one link')
                data = stream.read(MAX_READ_BYTES + 1)
        text = data[:MAX_READ_BYTES].decode('utf-8', errors='replace')
        return text + ('\n[cut at 200 KB]' if len(data) > MAX_READ_BYTES else '')

    def list(self, path: str = '') -> list[str]:
        """The directory's entries, sorted, directories with a trailing ``/`` (at most 500; ``.git`` never)."""
        with self._directory(parts_of(path) if path else []) as fd:
            names = []
            with os.scandir(fd) as entries:
                for entry in entries:
                    if entry.name.lower() == '.git':
                        continue
                    kind = '/' if entry.is_dir(follow_symlinks=False) else ('@' if entry.is_symlink() else '')
                    names.append(entry.name + kind)
        return sorted(names)[:MAX_LISTED]

    def write(self, path: str, text: str) -> int:
        """Write the file (a new one, or replace a regular file), making its directories; the bytes written."""
        data = text.encode('utf-8')
        if len(data) > MAX_WRITE_BYTES:
            raise OutsideCheckout('a file of at most 1 MB')
        *folders, name = parts_of(path) or ['']
        if not name:
            raise OutsideCheckout('a file path is needed')
        with self._directory(folders, create=True) as parent:
            staged = f'.{name}.voc-{os.getpid()}'
            fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(data)
                    os.fchmod(stream.fileno(), WRITTEN_MODE)
                # The rename replaces whatever is there by name (a link included) and never writes through it.
                os.replace(staged, name, src_dir_fd=parent, dst_dir_fd=parent)
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(staged, dir_fd=parent)
                raise
        return len(data)

    def hard_linked(self, paths: list[str]) -> list[str]:
        """Those of ``paths`` (the files a patch holds) that are regular files with more than one link, each looked
        up one directory at a time without following a link: a patch never holds one, since a hard link may name a
        file outside the checkout. A path that is gone (a deletion) is not linked; one that cannot be looked up
        safely (``..``, ``.git``, or through a link) counts as linked: refused, never assumed fine.

        Advisory: repository code could swap a file between git's read and this check. What stops a hard link to
        the agent's session is the image's guard (the session on a file system of its own, or protected hard links),
        without which the runner runs no repository code (``unit_runner.Runner``, ``--hardlink-guard``)."""
        found = []
        for path in paths:
            try:
                *folders, name = parts_of(path)
                with self._directory(folders) as parent:
                    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                continue
            except (OutsideCheckout, OSError):
                found.append(path)
                continue
            if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                found.append(path)
        return found
