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
MODULE_FLOORS: dict[str, int] = {
    'test_mcp_security': 153,
    'test_mcp_delegation': 185,
    'test_mcp_protocol_envelope': 285,
    'test_mcp_output_schema_conformance': 118,
    'test_mcp_date_basis': 5,
    'test_mcp_tokens': 46,
    'test_mcp_reach_lockstep': 3,
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


def _module_of(classname: str) -> str:
    """`lambda.api.test.test_mcp_security.TestFoo` -> `test_mcp_security`.

    JUnit `classname` is the dotted module path plus the test's class. Test
    classes are `Test*`-prefixed by `pytest.ini`'s `python_classes`, and a
    module-level test function produces no class segment at all, so the module is
    the last segment that does not start with `Test`.
    """
    segments = [segment for segment in classname.split('.') if not segment.startswith('Test')]
    return segments[-1] if segments else classname


def _executed_per_module(report: Path) -> tuple[dict[str, int], dict[str, int]]:
    """(tests that ran, tests that were skipped or xfailed) keyed by module.

    A `<testcase>` carrying a `<skipped>` child did not run: pytest emits that
    element for `skip`, `skipif` and non-strict `xfail` alike, which is why one
    check covers all three.
    """
    root = ElementTree.parse(report).getroot()
    executed: dict[str, int] = {}
    inert: dict[str, int] = {}
    for case in root.iter('testcase'):
        module = _module_of(case.get('classname', ''))
        bucket = inert if case.find('skipped') is not None else executed
        bucket[module] = bucket.get(module, 0) + 1
    return executed, inert


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

    executed, inert = _executed_per_module(report)
    problems: list[str] = []

    for module, floor in sorted(MODULE_FLOORS.items()):
        ran = executed.get(module, 0)
        skipped = inert.get(module, 0)
        if ran == 0 and skipped == 0:
            problems.append(
                f'{module}: no tests at all (floor {floor}). The module was renamed off '
                'the test_mcp_ prefix, moved out of a globbed directory, deleted, or '
                'failed to import.'
            )
        elif ran < floor:
            detail = f' and {skipped} skipped or xfailed' if skipped else ''
            problems.append(
                f'{module}: {ran} tests ran{detail}, below its floor of {floor}. '
                'A skipped test asserts nothing, so it does not count towards the floor.'
            )

    # Reported separately from the floors: a skip inside a module that is still
    # above its floor is not yet a shrinkage, but it is how one starts, and the
    # two lockstep modules skip BY DESIGN when their other-language tree is
    # absent — which never happens on a full checkout, so it is worth surfacing
    # rather than tolerating silently.
    if inert:
        summary = ', '.join(f'{module} ({count})' for module, count in sorted(inert.items()))
        print(f'::warning::Tests were skipped or xfailed and did not assert anything: {summary}')

    for module, ran in sorted(executed.items()):
        marker = '' if module in MODULE_FLOORS else '  (not floored — add it to MODULE_FLOORS)'
        print(f'{module}: {ran} ran (floor {MODULE_FLOORS.get(module, 0)}){marker}')
    print(f'total ran: {sum(executed.values())}')

    for problem in problems:
        _fail(
            f'MCP gate shrank — {problem} Restore it, or change the floor in '
            'voc-datalake/scripts/mcp_gate.py and say why.'
        )
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
