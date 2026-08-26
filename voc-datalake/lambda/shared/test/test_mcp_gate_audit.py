"""Tests for the MCP CI gate's own enforcement logic (`scripts/mcp_gate.py`).

The gate protects the MCP test surface; this module protects the gate. Without
it, the mechanism that took three commits to build could be disabled by one
token in a file no check reads:

    return 1 if problems else 0    ->    return 0

That edit, plus `pytestmark = pytest.mark.skip(...)` on `test_mcp_tokens.py`,
was verified to produce `858 passed, 46 skipped` with the audit exiting 0 — the
gate reporting success while 46 authorization tests asserted nothing, and nothing
in the repository noticing the edit. `pytest.ini` sets `testpaths = lambda
plugins`, so `scripts/` is never collected by a plain `pytest` run, and
`lint:python` named only `lambda plugins`, so the file was not linted either. The
same change that added this module extended that script to `scripts`.

The convention this repo applies to every other check — that it earns its place
by failing when the behaviour regresses — has to apply to the code that decides
whether checks pass. So this module lives under `lambda/shared/test/` (inside
`testpaths`, and inside the gate's own scope via the `test_mcp_*` glob) rather
than beside the script it tests, and the gate therefore audits its own enforcement
on every pull request.

Two layers, because two things can be neutered
----------------------------------------------
`TestTheGateAcceptsAHealthyRun` / `TestTheGateRejectsAShrunkenRun` cover the
audit's LOGIC. `TestTheGateScopeIsSelfConsistent` covers its DATA — the floors
themselves — which was the second hole: nothing asserted that a module the gate
runs has a floor, only the converse, so deleting one line from `MODULE_FLOORS`
was silent. Verified: dropping `'test_mcp_protocol_envelope': 285` left `926
passed` and the audit at exit 0, and adding a module-level skip on top gave `641
passed, 285 skipped`, still exit 0 — 285 tests asserting nothing with both CI
steps green, via a two-line diff that never touches the pass/fail logic.

The synthetic reports below are built by hand rather than by invoking pytest:
the point is to exercise `audit()`'s decisions, including report shapes a healthy
run never produces (a module absent entirely, a `<skipped>` child, a malformed
file), which a real run cannot be made to emit on demand.
"""
import importlib.util
import sys
from pathlib import Path
from xml.etree import ElementTree

import pytest


def _load_gate():
    """Import `scripts/mcp_gate.py`, which is not on `sys.path` and not a package.

    Loaded by file location rather than by name because `scripts/` deliberately
    has no `__init__.py` — it is a directory of standalone entry points, not an
    importable package, and adding one to make this test simpler would change how
    the workflow has to invoke it.
    """
    # lambda/shared/test/ -> voc-datalake/
    script = Path(__file__).resolve().parents[3] / 'scripts' / 'mcp_gate.py'
    assert script.exists(), (
        f'the MCP gate script moved: {script}. '
        '.github/workflows/mcp-backend-tests.yml invokes it by this path twice, so a '
        'move breaks CI — update both the workflow and this test.'
    )
    spec = importlib.util.spec_from_file_location('_mcp_gate_under_test', script)
    module = importlib.util.module_from_spec(spec)
    # Registered before exec so the module is importable from within itself if it
    # ever grows a dataclass or an enum that needs its own module by name.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


mcp_gate = _load_gate()


def _report(tmp_path: Path, cases: list[tuple[str, int, int]]) -> Path:
    """A JUnit report where each `(module, ran, skipped)` contributes testcases.

    Mirrors the element shape pytest emits: `classname` is the dotted module path
    plus a `Test`-prefixed class, and a non-executed test is a `<testcase>`
    carrying a `<skipped>` child.
    """
    lines = ['<?xml version="1.0" encoding="utf-8"?>', '<testsuites><testsuite name="pytest">']
    for module, ran, skipped in cases:
        classname = f'lambda.shared.test.{module}.TestThing'
        for index in range(ran):
            lines.append(f'<testcase classname="{classname}" name="test_ran_{index}" />')
        for index in range(skipped):
            lines.append(
                f'<testcase classname="{classname}" name="test_skipped_{index}">'
                '<skipped type="pytest.skip" message="disabled" /></testcase>'
            )
    lines.append('</testsuite></testsuites>')
    report = tmp_path / 'report.xml'
    report.write_text('\n'.join(lines))
    return report


def _report_meeting_every_floor(tmp_path: Path, **overrides: tuple[int, int]) -> Path:
    """A report that satisfies every floor, except where an override says otherwise.

    Built from `MODULE_FLOORS` itself rather than from a hardcoded list, so adding
    a module to the gate does not silently stop these tests from covering it —
    a fixture that enumerated modules by hand would be the same "forgot table six"
    defect the gate exists to catch.
    """
    cases = [
        (module, *overrides.get(module, (floor, 0)))
        for module, floor in mcp_gate.MODULE_FLOORS.items()
    ]
    return _report(tmp_path, cases)


class TestTheGateAcceptsAHealthyRun:
    """The floor must not be reddened by a run that met it, or it gets ignored."""

    def test_a_report_meeting_every_floor_passes(self, tmp_path):
        assert mcp_gate.audit(_report_meeting_every_floor(tmp_path)) == 0

    def test_growth_above_a_floor_passes(self, tmp_path):
        """Adding tests must never require editing the floor.

        Floors are minimums on purpose: if growth reddened the gate, every new
        test would be a two-file change and the floors would be lowered out of
        annoyance rather than argued with.
        """
        report = _report_meeting_every_floor(tmp_path, test_mcp_tokens=(999, 0))
        assert mcp_gate.audit(report) == 0

    def test_an_unfloored_module_that_runs_does_not_redden_the_gate(self, tmp_path):
        """A new `test_mcp_*.py` still runs on the PR that introduces it.

        Requiring a floor before a module could be added would mean the glob could
        not discover anything, which is the whole point of the glob — so `audit()`
        tolerates an unfloored module as long as it RUNS. What is not tolerated is an
        unfloored module that skips (below), because there the missing floor is what
        allowed the skip to pass unremarked.

        Note this tolerance is `audit()`'s alone: `test_every_module_the_gate_runs_has_a_floor`
        separately requires every module in the checked-out tree to be floored or
        declared, so the untolerated case is reached only by a report describing a
        module that is not in the tree this test suite sees.
        """
        cases = [(module, floor, 0) for module, floor in mcp_gate.MODULE_FLOORS.items()]
        cases.append(('test_mcp_brand_new', 2, 0))
        assert mcp_gate.audit(_report(tmp_path, cases)) == 0


class TestTheGateRejectsAShrunkenRun:
    """Each case here is a way the surface shrinks while pytest still exits 0."""

    def test_a_module_below_its_floor_fails(self, tmp_path):
        report = _report_meeting_every_floor(tmp_path, test_mcp_security=(152, 0))
        assert mcp_gate.audit(report) == 1

    def test_a_module_absent_entirely_fails(self, tmp_path):
        """The renamed-off-the-prefix case.

        A module that no longer matches the glob contributes no testcases at all,
        so it is absent from the report rather than present with a low count.
        """
        cases = [
            (module, floor, 0)
            for module, floor in mcp_gate.MODULE_FLOORS.items()
            if module != 'test_mcp_delegation'
        ]
        assert mcp_gate.audit(_report(tmp_path, cases)) == 1

    def test_a_skipped_test_does_not_count_towards_its_floor(self, tmp_path):
        """The hole a collected-count floor could not see.

        `pytestmark = pytest.mark.skip(...)` at module scope leaves every test
        collected and none of them asserting. pytest emits `<skipped>` for
        `skip`, `skipif` and non-strict `xfail` alike, so this one case covers
        all three — including the worst of them, where a test that starts failing
        is marked `xfail` and reports success indefinitely.
        """
        report = _report_meeting_every_floor(tmp_path, test_mcp_tokens=(0, 46))
        assert mcp_gate.audit(report) == 1

    def test_a_partial_skip_that_drops_below_the_floor_fails(self, tmp_path):
        """Skipping *some* of a module is caught too, not just all of it."""
        floor = mcp_gate.MODULE_FLOORS['test_mcp_tokens']
        report = _report_meeting_every_floor(tmp_path, test_mcp_tokens=(floor - 1, 1))
        assert mcp_gate.audit(report) == 1

    def test_an_unfloored_module_may_not_skip(self, tmp_path):
        """The composite regression: floor deleted, then the module disabled.

        With no floor there is nothing for a ran-count to fall below, so the floor
        loop has no opinion and a skip would otherwise be reported as a warning and
        nothing more. Verified before this check existed: deleting the
        `test_mcp_protocol_envelope` floor and skipping the module gave `641 passed,
        285 skipped` with the audit exiting 0.

        This is what makes the two-line diff fail rather than merely be visible: the
        self-consistency test catches the deleted floor, and this catches the skip
        even if the floor's absence were somehow legitimate.
        """
        cases = [(module, floor, 0) for module, floor in mcp_gate.MODULE_FLOORS.items()]
        cases.append(('test_mcp_not_floored', 0, 40))
        assert mcp_gate.audit(_report(tmp_path, cases)) == 1

    def test_an_unfloored_module_may_not_skip_even_partially(self, tmp_path):
        """One skip is enough: with no floor, there is no threshold to be under."""
        cases = [(module, floor, 0) for module, floor in mcp_gate.MODULE_FLOORS.items()]
        cases.append(('test_mcp_not_floored', 39, 1))
        assert mcp_gate.audit(_report(tmp_path, cases)) == 1

    def test_one_module_cannot_cover_for_another(self, tmp_path):
        """Why the floors are per-module rather than one total.

        A refactor that deletes one module while another grows by more tests than
        the deleted one had satisfies any aggregate count. This is the case most
        likely to happen by accident.
        """
        cases = [
            (module, floor, 0)
            for module, floor in mcp_gate.MODULE_FLOORS.items()
            if module != 'test_mcp_date_basis'
        ]
        cases.append(('test_mcp_security', 10_000, 0))
        assert mcp_gate.audit(_report(tmp_path, cases)) == 1


class TestTheGateRejectsAnUnreadableRun:
    """A gate that cannot measure must fail, not pass.

    These are the cases where the temptation is to treat "no evidence of a
    problem" as "no problem" — which would make the gate silently inert exactly
    when the run it audits went wrong.
    """

    def test_a_missing_report_fails(self, tmp_path):
        """A pytest crash writes no XML.

        If this returned 0, a usage error or an import-time crash would read as a
        satisfied gate — the failure mode is a green check on a suite that never
        ran.
        """
        assert mcp_gate.audit(tmp_path / 'nonexistent.xml') == 1

    def test_a_malformed_report_fails_loudly(self, tmp_path):
        """Truncated XML (a killed run, a full disk) must not be read as empty.

        `ElementTree` raises rather than returning an empty tree, and the
        exception is deliberately not swallowed: a non-zero exit with a parse
        traceback is a better signal than a floor verdict computed from nothing.
        """
        report = tmp_path / 'truncated.xml'
        report.write_text('<testsuites><testsuite name="pytest"><testcase clas')
        with pytest.raises(ElementTree.ParseError):
            mcp_gate.audit(report)

    def test_an_empty_report_fails(self, tmp_path):
        """Well-formed XML with no testcases: collection matched nothing."""
        report = tmp_path / 'empty.xml'
        report.write_text('<testsuites><testsuite name="pytest" /></testsuites>')
        assert mcp_gate.audit(report) == 1


class TestModuleAttribution:
    """`_module_of` decides which floor a testcase counts towards.

    A bug here would not fail loudly — it would silently move tests between
    buckets, which is how a floor starts measuring something other than what it
    names.
    """

    @pytest.mark.parametrize(
        ('classname', 'expected'),
        [
            # The ordinary shape: dotted module path plus a Test-prefixed class.
            ('lambda.api.test.test_mcp_security.TestCatalog', 'test_mcp_security'),
            # A module-level test function produces no class segment.
            ('lambda.api.test.test_mcp_date_basis', 'test_mcp_date_basis'),
            # Nested classes: every Test* segment is dropped, not just the last.
            ('lambda.shared.test.test_mcp_tokens.TestOuter.TestInner', 'test_mcp_tokens'),
            # A module whose own name starts with `Test` would be indistinguishable
            # from a class, so the fallback returns the whole string rather than
            # guessing — it will simply not match a floor, which is visible.
            ('TestOnly', 'TestOnly'),
            # Degenerate input (no classname attribute at all) must not raise.
            ('', ''),
        ],
    )
    def test_the_module_is_read_out_of_the_junit_classname(self, classname, expected):
        assert mcp_gate._module_of(classname) == expected


class TestTheGateScopeIsSelfConsistent:
    """The declaration in `mcp_gate.py` must describe a surface that exists.

    Every entry here is a fact that can go stale — a path that no longer exists,
    a floor for a module nothing runs — and each one degrades the gate quietly
    rather than loudly.
    """

    def test_every_explicitly_named_path_exists(self):
        """A typo in `EXPLICIT_TEST_PATHS` makes pytest exit 4 in CI.

        Catching it here names the offending entry instead of leaving a reader to
        infer it from a "file or directory not found" and three floor errors.
        """
        root = Path(__file__).resolve().parents[3]
        missing = [path for path in mcp_gate.EXPLICIT_TEST_PATHS if not (root / path).exists()]
        assert not missing, (
            f'EXPLICIT_TEST_PATHS names paths that do not exist: {missing}. pytest exits 4 '
            'on an unknown path, so CI fails without saying which entry is wrong.'
        )

    def test_every_glob_matches_at_least_one_module(self):
        """An empty glob means a whole directory quietly left the gate."""
        root = Path(__file__).resolve().parents[3]
        empty = [glob for glob in mcp_gate.TEST_PATH_GLOBS if not list(root.glob(glob))]
        assert not empty, (
            f'these globs match nothing: {empty}. Either the modules were renamed off the '
            'test_mcp_ prefix or the directory moved; a glob matching nothing contributes '
            'no coverage.'
        )

    def test_every_module_the_gate_runs_has_a_floor(self):
        """The converse of the test below, and the one that closes a real hole.

        `MODULE_FLOORS` is the gate's only defence against a shrinking surface, and
        removing a line from it was silent: nothing asserted that a module the gate
        RUNS has a floor, only that a floor names a module the gate runs. Verified
        on this tree — deleting `'test_mcp_protocol_envelope': 285` (the largest
        module, 285 tests) left `926 passed` with the audit exiting 0, printing only
        a `(not floored)` note that reads like housekeeping; adding
        `pytestmark = pytest.mark.skip(...)` on top gave `641 passed, 285 skipped`,
        still exit 0. Two lines, each locally plausible — a floor "cleanup" and a
        temporary skip — and 31% of the gate asserting nothing.

        That is a strictly easier edit than the `return 0` mutation this module was
        written for, since it never touches the pass/fail logic. It is the same
        defect class one level out: that finding was "the audit's logic is
        unprotected", this is "the audit's DATA is unprotected".

        A module may be exempted, but only by saying so in `UNFLOORED_ON_PURPOSE` —
        an exemption a reviewer sees in a diff, rather than one expressed by
        omission and indistinguishable from a deletion.
        """
        root = Path(__file__).resolve().parents[3]
        collected = {
            path.stem
            for glob in mcp_gate.TEST_PATH_GLOBS
            for path in root.glob(glob)
        } | {Path(path).stem for path in mcp_gate.EXPLICIT_TEST_PATHS}
        unfloored = sorted(collected - set(mcp_gate.MODULE_FLOORS) - mcp_gate.UNFLOORED_ON_PURPOSE)
        assert not unfloored, (
            f'the gate runs these modules with no floor: {unfloored}. An unfloored module '
            'can be skipped in its entirety without the audit objecting, because there is '
            'no floor for its ran-count to fall below. Add a MODULE_FLOORS entry (its '
            'current test count), or declare it in UNFLOORED_ON_PURPOSE.'
        )

    def test_no_exemption_is_stale(self):
        """`UNFLOORED_ON_PURPOSE` must not outlive the module it exempts.

        An entry naming a module the gate no longer runs is an exemption sitting
        ready for the next module that happens to take that name — the exemption
        would apply without anyone deciding it should.
        """
        root = Path(__file__).resolve().parents[3]
        collected = {
            path.stem
            for glob in mcp_gate.TEST_PATH_GLOBS
            for path in root.glob(glob)
        } | {Path(path).stem for path in mcp_gate.EXPLICIT_TEST_PATHS}
        stale = sorted(mcp_gate.UNFLOORED_ON_PURPOSE - collected)
        assert not stale, (
            f'UNFLOORED_ON_PURPOSE exempts modules the gate does not run: {stale}. Drop '
            'them, so the exemption cannot silently apply to a future module of the same '
            'name.'
        )

        floored = sorted(mcp_gate.UNFLOORED_ON_PURPOSE & set(mcp_gate.MODULE_FLOORS))
        assert not floored, (
            f'these modules are both floored and exempted from being floored: {floored}. '
            'The exemption is dead — the floor applies — so remove it to keep the '
            'declaration honest.'
        )

    def test_every_floored_module_is_actually_reachable_by_the_gate(self):
        """A floor for a module the gate does not run can never be met.

        Such an entry fails the audit permanently with "no tests at all", and the
        diagnosis (a floor naming an unreachable module) is not what that message
        suggests. Failing here says so directly.
        """
        root = Path(__file__).resolve().parents[3]
        collected = {
            path.stem
            for glob in mcp_gate.TEST_PATH_GLOBS
            for path in root.glob(glob)
        } | {Path(path).stem for path in mcp_gate.EXPLICIT_TEST_PATHS}
        unreachable = sorted(set(mcp_gate.MODULE_FLOORS) - collected)
        assert not unreachable, (
            f'MODULE_FLOORS floors modules the gate never runs: {unreachable}. Either add '
            'them to a glob or EXPLICIT_TEST_PATHS, or drop the floor.'
        )

    def test_this_module_is_inside_the_gate_it_audits(self):
        """The gate must run its own tests, or this file protects nothing.

        `test_mcp_gate_audit` matches `lambda/shared/test/test_mcp_*.py`, so the
        glob picks it up — but that is a property of the name, and a rename would
        remove this module from CI while leaving it passing locally.
        """
        assert 'test_mcp_gate_audit' in mcp_gate.MODULE_FLOORS, (
            'this module is not floored in mcp_gate.py, so a rename that drops it out of '
            'the glob would go unnoticed — which is precisely the regression it exists to '
            'prevent, aimed at itself'
        )
