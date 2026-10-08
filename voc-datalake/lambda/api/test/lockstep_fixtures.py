"""Source-text readers shared by the `test_*_lockstep.py` files beside this one.

A lockstep test pins a constant that two separately packaged sources (two Lambda
bundles, or a Lambda and the frontend) must spell identically. Every value is read
as SOURCE TEXT rather than imported: the assertion must not be satisfiable by
whatever either module happens to resolve at import time, and reading text needs
neither the AWS-shaped Python import graph nor a bundler.

These helpers only READ and EXTRACT; every expected value stays literal in the test
that asserts it.
"""
import re
from pathlib import Path

# lambda/api/test/ -> voc-datalake/
_REPO_ROOT = Path(__file__).resolve().parents[3]


def read_source(relative: str) -> str:
    """The text of `relative` (from voc-datalake/), asserting the file exists.

    ASSERTED, not skipped: an absent source means the file MOVED, which is a real
    drift the test should report rather than step around. A lockstep that reaches
    into a tree which can legitimately be absent (the frontend, when packaging a
    Lambda bundle) keeps its own skipping reader instead of using this one.
    """
    path = _REPO_ROOT / relative
    # Raised explicitly rather than with `assert`: this is a support module, not a
    # test module, so pytest does not rewrite its asserts and `-O` would strip them.
    if not path.is_file():
        raise AssertionError(
            f'{relative} not found — did the file move? '
            f'If so, update the path constant in this test file.'
        )
    return path.read_text(encoding='utf-8')


def single_match(source: str, pattern: str, where: str, what: str) -> str | tuple[str, ...]:
    """The one `re.findall` match for `pattern`, or a failure naming what drifted.

    Exactly one is required deliberately: a second assignment of the same constant
    is itself the drift a lockstep exists to prevent, and taking the first match
    would hide it.
    """
    matches = re.findall(pattern, source, re.MULTILINE)
    if len(matches) != 1:
        raise AssertionError(
            f'Expected exactly one {what} in {where}; found {len(matches)}. '
            f'A second copy is the drift this test exists to prevent — if the '
            f'declaration was restructured, update the pattern in this test file.'
        )
    return matches[0]


def _single_group(source: str, pattern: str, where: str, what: str) -> str:
    """`single_match` for a pattern with exactly one capturing group."""
    match = single_match(source, pattern, where, what)
    if not isinstance(match, str):
        raise TypeError(f'{pattern!r} must capture exactly one group')
    return match


def single_int(source: str, pattern: str, where: str, what: str) -> int:
    """`single_match` for a pattern whose one group captures a bare integer."""
    return int(_single_group(source, pattern, where, what))


def py_str_const(source: str, name: str, where: str) -> str:
    """A module-level `NAME = '...'` in a Python source."""
    return _single_group(source, rf"^{name}\s*=\s*'([^']*)'", where, f'{name} assignment')


def py_int_const(source: str, name: str, where: str) -> int:
    """A module-level `NAME = 123` in a Python source."""
    return single_int(source, rf'^{name}\s*=\s*(\d+)', where, f'{name} assignment')


def ts_int_const(source: str, name: str, where: str) -> int:
    """A top-level `export const NAME = 123` in a TypeScript source."""
    return single_int(source, rf'^export const {name}\s*=\s*(\d+)', where, f'{name} assignment')
