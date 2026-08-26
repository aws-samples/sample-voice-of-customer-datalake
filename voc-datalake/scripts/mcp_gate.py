#!/usr/bin/env python3
"""Owns the definition of the MCP CI gate's scope, and audits that a run met it.

`.github/workflows/mcp-backend-tests.yml` calls this twice: once with
``--print-paths`` to get the pytest arguments, and once with ``--audit`` to check
the JUnit XML that run produced. Both halves therefore read the same definition
below, which is the point of the file — when the two lived as duplicated literals
in two workflow steps, widening the gate meant editing both, and editing one left
the floor measuring a different surface than the one being run.

Why the audit is not "did pytest exit 0"
----------------------------------------
A gate defined by globs can quietly match less than it did, and a gate that only
checks the exit code cannot tell "791 tests passed" from "746 passed and 45 were
skipped". Three distinct regressions all leave a plain ``pytest`` invocation
green:

1. A module renamed off the ``test_mcp_`` prefix leaves the glob matching fewer
   files. (Renaming *every* module does redden it — pytest exits 4 on an
   unmatched path — but renaming one of several does not.)
2. ``pytestmark = pytest.mark.skip(...)`` at module scope. The tests are still
   COLLECTED, so a collected-count floor passes, and the module asserts nothing.
   ``skipif`` on a condition that is false on the runner is the same hole, and
   ``xfail(strict=False)`` is the worst version: a test that starts failing gets
   marked and reports success forever.
3. A module deleted while another grows by more tests than it lost, which an
   aggregate count alone cannot see.

So the audit asserts on tests that actually RAN, per module, against a committed
floor. The count may grow freely; a drop has to be argued for in a diff.

Why JUnit XML rather than parsing pytest's own summary
-----------------------------------------------------
``requirements-dev.txt`` bounds pytest at ``>=8.0.0`` with no upper cap, and a
clean install currently resolves 9.x. Its ``-q`` summary line is presentation
output, not a contract: it already has a second shape when anything is
deselected (``704/791 tests collected (87 deselected)``), and a future major may
restyle it freely. The JUnit XML's ``<testcase>`` / ``<skipped>`` structure is a
de-facto interchange format that predates pytest, so reading it does not couple
this gate to pytest's console formatting.

What audits this file
---------------------
``lambda/shared/test/test_mcp_gate_audit.py``, which the gate runs on every pull
request via the ``lambda/shared/test/test_mcp_*.py`` glob. It exercises
``audit()`` against synthetic reports — floors met, a module below its floor, a
module absent, a skipped test, a missing report, a malformed report — and checks
that the declarations below describe a surface that actually exists. Without it
this file was the one place in the repo where an edit changed CI's verdict and no
check ran: ``return 1 if problems else 0`` -> ``return 0`` was verified to make
the gate pass a module-level skip on ``test_mcp_tokens.py``.

It covers the audit's DATA as well as its logic, which was a second hole: nothing
asserted that a module the gate runs HAS a floor, only that a floor names a module
the gate runs, so deleting one line from ``MODULE_FLOORS`` was silent and a skip on
the unfloored module then passed. See the comment on ``MODULE_FLOORS``.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from xml.etree import ElementTree

# The gate's scope, in one place.
#
# Globs rather than a listed set of files, so the next MCP-specific module is
# gated the day it lands instead of the day someone remembers this file. The
# globs DISCOVER; MODULE_FLOORS below is what stops the discovered set shrinking.
TEST_PATH_GLOBS: tuple[str, ...] = (
    'lambda/api/test/test_mcp_*.py',
    'lambda/shared/test/test_mcp_*.py',
)

# Modules that are gated but cannot match the `test_mcp_` prefix, so they are
# named. Each is here because it owns a boundary the globbed modules depend on:
#
# test_projects_handler.py — the credential MINT route. `_validate_scopes` and
#   `_validate_read_reach` decide which credentials can exist at all, and their
#   failure mode is fail-OPEN under a fail-CLOSED enforcement path: making
#   `_validate_read_reach` return `DEFAULT_READ_REACH` for an unknown reach
#   instead of raising is silent to every `test_mcp_*` module, and hands out the
#   widest reach by accident — which is exactly what that function's docstring
#   warns about. Accepting an unknown scope likewise recreates the retired
#   `read-write` phantom permission.
#
# test_python_runtime_lockstep.py — ties `.python-version`, which chooses THIS
#   job's interpreter, to the `Runtime.PYTHON_3_*` the stacks deploy. Without it
#   a bump to either side leaves CI green while testing an interpreter no Lambda
#   runs.
EXPLICIT_TEST_PATHS: tuple[str, ...] = (
    'lambda/api/test/test_projects_handler.py',
    'lambda/shared/test/test_python_runtime_lockstep.py',
)

# Modules the gate runs WITHOUT a floor, declared rather than merely omitted.
#
# Empty, and expected to stay that way. Every module in this gate arrived in the
# same commit as its floor, so the "lands unfloored, floored later" flow was
# hypothetical — and an absent floor was indistinguishable in the log from a
# DELETED one, which is the two-line regression this list exists to make
# unreachable by omission. `test_mcp_gate_audit.py` asserts that every module the
# globs and EXPLICIT_TEST_PATHS resolve to is either floored or named here, so
# exempting one is a visible declaration a reviewer sees in a diff.
#
# An entry here still does not buy silence: `audit()` fails outright if an
# unfloored module reports any skips, because with no floor to fall below a skip
# would otherwise draw a warning and nothing more.
UNFLOORED_ON_PURPOSE: frozenset[str] = frozenset()

# `test_mcp_gate_audit.py` covers THIS file and needs no entry above: it matches
# `lambda/shared/test/test_mcp_*.py`, so the glob gates it. That is deliberate
# rather than incidental. `pytest.ini` sets `testpaths = lambda plugins`, so
# nothing collects `scripts/` — this file is only ever *run* as the gate's own
# entry point, and only ever *tested* by that module. (`lint:python` was likewise
# `ruff check lambda plugins` until the same change added `scripts` — but that is a
# LOCAL gate: no workflow invokes it, so the lint half of this file's coverage runs
# only when someone runs it by hand, while the test half runs on every PR. See
# ruff.toml's header.) Neutering
# `audit()` below to `return 0` was verified to let a module-level skip on
# `test_mcp_tokens.py` produce `858 passed, 46 skipped` with the gate reporting
# success. The floors protect the test surface; that module protects the floors.

# Per-module floor of tests that must RUN — not be collected, not be skipped.
#
# Per-module rather than one total: an aggregate floor is satisfied by a module
# that grew covering for one that vanished, which is the case most likely to
# happen by accident during a refactor.
#
# Raising a number when tests are added is optional (growth is free, and pinning
# exact counts would make every new test a two-file change). LOWERING one, or
# removing an entry, is the deliberate act of shrinking the gate and should say
# why in the commit that does it.
#
# EVERY module the gate runs must appear here, or be declared in
# UNFLOORED_ON_PURPOSE above. That is not a convention but an assertion —
# `test_mcp_gate_audit.py`'s `test_every_module_the_gate_runs_has_a_floor` — because
# a floor is the gate's only defence and deleting one line was verified to remove
# it silently. Dropping `'test_mcp_protocol_envelope': 285` and then adding
# `pytestmark = pytest.mark.skip(...)` to that module gave `641 passed, 285
# skipped` with the audit exiting 0: 31% of the surface asserting nothing, both CI
# steps green, and the only trace a log line that read like housekeeping. Both
# halves of that two-line diff now fail independently — the missing floor fails
# that test, and `audit()` refuses to tolerate skips in a module it has no floor
# for — so neither edit alone is enough and neither is silent.
#
# Keyed by BARE MODULE NAME, not by path, so two modules of the same name in the
# two gated directories would share one bucket and their counts would add. Both
# directories are packages, so that is possible — and it let a whole module be
# skipped while its same-named twin held the count at the floor. Rather than
# prefix every key with a package that matters in no other case, the ambiguity is
# refused: `_collisions` fails the audit, and
# `test_no_two_gated_modules_share_a_stem` fails before the report even exists.
MODULE_FLOORS: dict[str, int] = {
    'test_mcp_security': 153,
    'test_mcp_delegation': 185,
    'test_mcp_protocol_envelope': 285,
    'test_mcp_output_schema_conformance': 118,
    'test_mcp_date_basis': 5,
    'test_mcp_tokens': 46,
    'test_mcp_vocabulary_lockstep': 13,
    'test_mcp_gate_audit': 27,
    'test_projects_handler': 105,
    'test_python_runtime_lockstep': 4,
}


def pytest_paths() -> tuple[str, ...]:
    """Every path argument the gate runs, globs unexpanded.

    Returned for the shell to expand rather than expanded here, so that a glob
    matching nothing reaches pytest and is reported as its own error (exit 4)
    instead of silently vanishing from the argument list.
    """
    return TEST_PATH_GLOBS + EXPLICIT_TEST_PATHS


def _module_path_of(classname: str) -> str:
    """`lambda.api.test.test_mcp_security.TestFoo` -> `lambda.api.test.test_mcp_security`.

    The dotted path with the test's class segments removed. Test classes are
    `Test*`-prefixed by `pytest.ini`'s `python_classes`, and a module-level test
    function produces no class segment at all, so the module path is every leading
    segment that does not start with `Test`.

    Kept distinct from `_module_of` because the package prefix is what
    distinguishes two same-named modules in the two gated directories — see
    `_collisions`.
    """
    segments = [segment for segment in classname.split('.') if not segment.startswith('Test')]
    return '.'.join(segments) if segments else classname


def _module_of(classname: str) -> str:
    """`lambda.api.test.test_mcp_security.TestFoo` -> `test_mcp_security`.

    The bare module name, which is what `MODULE_FLOORS` is keyed on. Two modules
    of the same name in `lambda/api/test/` and `lambda/shared/test/` therefore
    reduce to the same key; `_collisions` below refuses that rather than letting
    the two counts add.
    """
    return _module_path_of(classname).rsplit('.', 1)[-1]


def _executed_per_module(
    report: Path,
) -> tuple[dict[str, int], dict[str, int], dict[str, set[str]]]:
    """(ran, skipped-or-xfailed, contributing module paths) keyed by module name.

    A `<testcase>` carrying a `<skipped>` child did not run: pytest emits that
    element for `skip`, `skipif` and non-strict `xfail` alike, which is why one
    check covers all three.

    The third mapping records which dotted module paths contributed to each name,
    so a name reached from two different packages can be detected instead of
    silently summed.
    """
    root = ElementTree.parse(report).getroot()
    executed: dict[str, int] = {}
    inert: dict[str, int] = {}
    origins: dict[str, set[str]] = {}
    for case in root.iter('testcase'):
        classname = case.get('classname', '')
        path = _module_path_of(classname)
        module = path.rsplit('.', 1)[-1]
        bucket = inert if case.find('skipped') is not None else executed
        bucket[module] = bucket.get(module, 0) + 1
        origins.setdefault(module, set()).add(path)
    return executed, inert, origins


def _collisions(origins: dict[str, set[str]]) -> list[str]:
    """Module names reached from more than one package, which a floor cannot separate.

    `MODULE_FLOORS` is keyed by bare module name, and both gated directories are
    Python packages (`lambda/api/test/__init__.py` and
    `lambda/shared/test/__init__.py` both exist), so
    `lambda/api/test/test_mcp_delegation.py` and
    `lambda/shared/test/test_mcp_delegation.py` can coexist and land in ONE
    bucket whose count is their sum. That reopens, inside a single floor, exactly
    what per-module floors were introduced to close: one module covering for
    another.

    Verified before this check existed — a `lambda/shared/test/test_mcp_delegation.py`
    of 185 passing filler tests, plus `pytestmark = pytest.mark.skip(...)` on the
    real `lambda/api/test/test_mcp_delegation.py`:

        pytest -> 931 passed, 185 skipped     exit 0
        audit  -> test_mcp_delegation: 185 ran (floor 185)
                  total ran: 931              exit 0

    185 real delegation tests asserting nothing, both steps green, and `total ran`
    identical to a healthy run. No intent is required for this: the second file is
    an ordinary addition and the skip is the ordinary "temporarily disabled" line.

    So the ambiguity is REFUSED rather than measured through. Resolving it by
    keying floors on the full dotted path was the alternative, and is rejected
    because it would make every floor entry carry a package prefix that only
    matters in the case this check makes impossible.
    """
    return sorted(name for name, paths in origins.items() if len(paths) > 1)


def _fail(message: str) -> None:
    """A GitHub error annotation on stdout, where workflow commands are read."""
    print(f'::error::{message}')


def audit(report: Path) -> int:
    """Compare a run's JUnit XML against MODULE_FLOORS. 0 if the gate held."""
    if not report.exists():
        _fail(
            f'No JUnit report at {report}. The test step did not produce one, so the '
            'gate cannot be audited — treat this as a failure of the run, not of the '
            'floor.'
        )
        return 1

    executed, inert, origins = _executed_per_module(report)
    problems: list[str] = []

    # Checked BEFORE the floors, because a collision makes every count below it
    # untrustworthy: the floor loop would compare a sum against a floor written for
    # one of its two contributors, and could report a module comfortably above a
    # floor it never met. Reported as its own diagnosis rather than folded into a
    # floor failure, since the remedy is to rename one of the two files, not to
    # restore tests or move a number.
    for name in _collisions(origins):
        problems.append(
            f'{name}: two modules share this name ('
            + ', '.join(sorted(origins[name]))
            + '), and MODULE_FLOORS is keyed by module name, so ONE floor is being '
            'compared against the SUM of both. That lets one of them be skipped '
            'entirely while the other keeps the count at the floor. Rename one of the '
            'two files so each has its own floor.'
        )

    for module, floor in sorted(MODULE_FLOORS.items()):
        ran = executed.get(module, 0)
        skipped = inert.get(module, 0)
        if ran == 0 and skipped == 0:
            problems.append(
                f'{module}: no tests at all (floor {floor}). The module was renamed off '
                'the test_mcp_ prefix, moved out of a globbed directory, deleted, or '
                'failed to import. Restore it, or change the floor in '
                'voc-datalake/scripts/mcp_gate.py and say why.'
            )
        elif ran < floor:
            detail = f' and {skipped} skipped or xfailed' if skipped else ''
            problems.append(
                f'{module}: {ran} tests ran{detail}, below its floor of {floor}. '
                'A skipped test asserts nothing, so it does not count towards the floor. '
                'Restore the tests, or change the floor in '
                'voc-datalake/scripts/mcp_gate.py and say why.'
            )

    # A skip in a module with NO floor is a failure, not a warning.
    #
    # This is the second half of a regression the floor loop above cannot see.
    # Deleting a module's `MODULE_FLOORS` entry leaves nothing for a ran-count to
    # fall below, so that loop has no opinion and the warning further down would be
    # the entire response — verified: dropping the `test_mcp_protocol_envelope`
    # floor and skipping that module produced `641 passed, 285 skipped` with the
    # audit exiting 0.
    #
    # Kept distinct from the floor loop because the diagnosis differs. A floored
    # module below its floor means "restore the tests"; an unfloored module with
    # skips means "this module has no floor, which is why the skip went unremarked" —
    # and naming the missing floor is the actionable part.
    for module, skipped in sorted(inert.items()):
        if module in MODULE_FLOORS:
            continue
        if module in UNFLOORED_ON_PURPOSE:
            cause = (
                'It is declared in UNFLOORED_ON_PURPOSE, but that exempts it from '
                'having a floor, not from running: a module admitted unfloored still '
                'may not assert nothing. Remove the skip.'
            )
        else:
            cause = (
                'Either its MODULE_FLOORS entry was deleted — which is how the gate gets '
                'shrunk without any check complaining — or it arrived unfloored and was '
                'then disabled. Give it a floor, or declare it in UNFLOORED_ON_PURPOSE '
                'and remove the skip.'
            )
        problems.append(
            f'{module}: {skipped} tests skipped or xfailed and the module has no floor, '
            f'so no floor could object. {cause}'
        )

    # Reported separately from the floors: a skip inside a module that is still
    # above its floor is not yet a shrinkage, but it is how one starts, so it is
    # surfaced rather than tolerated silently.
    #
    # No module in this gate skips by design. The two lockstep modules once
    # carried `skipif` markers for a checkout missing the other language's tree,
    # but that tolerance could never take effect — their unskipped positive
    # controls failed on exactly such a checkout, and these floors would fail the
    # audit on any skip regardless. Both now require a full checkout explicitly
    # and say so in their docstrings, so ANY skip reaching this branch is
    # unexpected.
    if inert:
        summary = ', '.join(f'{module} ({count})' for module, count in sorted(inert.items()))
        print(f'::warning::Tests were skipped or xfailed and did not assert anything: {summary}')

    for module, ran in sorted(executed.items()):
        if module in MODULE_FLOORS:
            marker = ''
        elif module in UNFLOORED_ON_PURPOSE:
            marker = '  (unfloored by declaration)'
        else:
            # Distinguished from the line above deliberately. "No floor" used to
            # print identically whether a module had just arrived or had had its
            # floor deleted, so the one output that would reveal a deletion read as
            # routine housekeeping. An arrival is now something someone declared;
            # anything else is an undeclared gap, and this says so.
            marker = '  (UNFLOORED and undeclared — add it to MODULE_FLOORS)'
        print(f'{module}: {ran} ran (floor {MODULE_FLOORS.get(module, 0)}){marker}')
    print(f'total ran: {sum(executed.values())}')

    # Each problem carries its own remedy rather than sharing a generic suffix:
    # "change the floor and say why" is right for a module below its floor and
    # wrong for one that has no floor at all.
    for problem in problems:
        _fail(f'MCP gate shrank — {problem}')
    return 1 if problems else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        '--print-paths',
        action='store_true',
        help="the gate's pytest path arguments, space-separated, globs unexpanded",
    )
    group.add_argument(
        '--audit',
        metavar='JUNIT_XML',
        help='check a run\'s JUnit report against the per-module floors',
    )
    args = parser.parse_args()

    if args.print_paths:
        print(' '.join(pytest_paths()))
        return 0
    return audit(Path(args.audit))


if __name__ == '__main__':
    sys.exit(main())
