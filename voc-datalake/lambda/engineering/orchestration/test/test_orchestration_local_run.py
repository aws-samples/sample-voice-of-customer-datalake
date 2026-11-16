"""``npm run orchestration:run -- --flow bug-hunt-and-fix --repo <divide-floor-bug> --models fake --issue 1``: the
compiled Bug hunt and fix flow, end to end on the local fake runtime, on the sandbox's seeded bug. The scripted models
act out its known fix; the hunter's check and the gate's pytest run for real; every step's assertions are evaluated on
what it recorded."""
from __future__ import annotations

from engineering.orchestration import __main__ as cli
from engineering.orchestration.schema import ROOT
from engineering.orchestration.test import local_fake

DIVIDE = ROOT / 'evals' / 'bug-hunt-and-fix' / 'cases' / 'divide-floor-bug' / 'repo'


def test_the_case_and_its_known_fix_give_the_scripts_their_file_line_and_fixed_text() -> None:
    case = local_fake.load_case(DIVIDE)
    assert (case.source, case.line) == ('calculator/ops.py', 20)
    assert '    return a / b\n' in case.fixed['calculator/ops.py']
    assert 'def test_divide_returns_a_float' in case.fixed['tests/test_ops.py']
    assert case.check[1:4] == ['-I', '-P', '-c']
    assert set(case.files) >= {'calculator/ops.py', 'tests/test_ops.py', 'pyproject.toml', 'requirements-dev.txt'}


def test_divide_floor_bug_runs_from_the_hunt_to_its_pull_request_with_every_steps_assertions() -> None:
    lines: list[str] = []
    code = cli.main(['run', '--flow', 'bug-hunt-and-fix', '--repo', str(DIVIDE), '--models', 'fake', '--issue', '1'],
                    lines.append)
    text = '\n'.join(lines)
    for step in ('hunt', 'board', 'gate', 'commit', 'pr_author'):
        assert f'step {step}: done' in lines, text
    for check in ('findings.cite_evidence', 'tasks.posted', 'patch.submitted', 'patch.touches_tests',
                  'patch.no_ci_changes', 'review.no_blocking', 'gate.pack_checks_ran', 'gate.passed',
                  'push.tree_is_judged_tree', 'pr.opened', 'pr.links_issue'):
        assert f'    assert {check}: pass' in text, text
    # The gate runner's run_gate ran the python pack's pytest for real on the judged tree (the fix and its test), and
    # it passed.
    assert '    gate check py.test@.: pytest: pass' in lines, text
    assert 'flow: start done, hunt done, board done, gate done, commit done, human skipped, pr_author done, pr done' in text
    # The flow asks for a pull request ready for review, and the broker opened it so.
    assert '    assert pr.state_as_flow: pass (1 of 1 pull requests opened ready for review)' in lines, text
    assert code == 0, text
    assert lines[-1] == 'result: reached its pull request; every blocking assertion passed'
