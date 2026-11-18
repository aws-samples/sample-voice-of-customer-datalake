"""The closed vocabulary of step assertions: each check on recorded outputs, pass and fail, and the three lists that
name it (the evaluator, the JSON Schema, the server's validator) held equal."""
from __future__ import annotations

from typing import Any

import pytest

from engineering.orchestration import assertions
from engineering.orchestration.assertions import Recorded, evaluate, evaluate_all, problems
from engineering.orchestration.schema import schema
from shared import workflow_engineering

FIX = ('diff --git a/calculator/ops.py b/calculator/ops.py\n--- a/calculator/ops.py\n+++ b/calculator/ops.py\n'
       '@@ -20 +20 @@\n-    return a // b\n+    return a / b\n'
       'diff --git a/tests/test_ops.py b/tests/test_ops.py\n--- a/tests/test_ops.py\n+++ b/tests/test_ops.py\n'
       '@@ -15,0 +16,2 @@\n+def test_divide_returns_a_float():\n+    assert divide(7, 2) == 3.5\n')
CI = 'diff --git a/.github/workflows/test.yml b/.github/workflows/test.yml\n+on: push\n'
TREE = 'a' * 40
FINDING = {'file': 'calculator/ops.py', 'line': 20, 'severity': 'blocking', 'evidence': 'divide(7, 2) == 3',
           'by': 'hunter'}
TENET = {'id': 'T1', 'title': 'Fail closed', 'statement': 'A check that cannot run refuses.', 'citations': ['a.py:1']}


def _review(verdict: str, by: str = 'commit-reviewer', reason: str = 'read the whole patch') -> dict[str, Any]:
    return {'schema': 'voc-review/1', 'verdict': verdict, 'reasons': [reason], 'by': by}


APPROVED = _review('approve')


def _record(by: str, verdict: str, tree: str = TREE, checks: int = 1) -> dict[str, Any]:
    return {'by': by, 'verdict': verdict, 'tree_hash': tree,
            'rounds': [{'checks': [{'name': 'pytest', 'status': 'pass'}] * checks}]}


def _check(check: str, recorded: Recorded, **args: Any) -> tuple[bool, str]:
    result = evaluate({'check': check, **({'args': args} if args else {})}, recorded)
    return result.passed, result.detail


def test_the_vocabulary_is_the_same_in_the_evaluator_the_schema_and_the_servers_validator() -> None:
    assert sorted(assertions.VOCABULARY) == sorted(schema('assertion')['properties']['check']['enum'])
    assert {check: entry.args for check, entry in assertions.VOCABULARY.items()} == dict(
        workflow_engineering.ASSERTION_ARGS)
    assert assertions.ON_FAIL == workflow_engineering.ASSERTION_ON_FAIL


@pytest.mark.parametrize(('check', 'good', 'bad', 'args'), [
    ('findings.cite_evidence', Recorded(findings=(FINDING,)),
     Recorded(findings=({**FINDING, 'evidence': ' '},)), {}),
    ('notes.cite_sources', Recorded(notes=({'citations': ['a.py:1']},)), Recorded(notes=({'citations': []},)), {}),
    ('tasks.posted', Recorded(posted=(('fixer', 'hunter'),)), Recorded(posted=(('builder', 'hunter'),)),
     {'role': 'fixer', 'min': 1}),
    ('patch.submitted', Recorded(patches=(FIX,)), Recorded(patches=(' ',)), {}),
    ('patch.touches_tests', Recorded(patches=(FIX,)), Recorded(patches=(FIX.split('diff --git a/tests', maxsplit=1)[0],)), {}),
    ('patch.no_ci_changes', Recorded(patches=(FIX,)), Recorded(patches=(FIX, CI)), {}),
    ('patch.max_lines', Recorded(patches=(FIX,)), Recorded(patches=(FIX,)), {'max': 3}),
    ('review.no_blocking', Recorded(findings=({**FINDING, 'by': 'commit-reviewer', 'severity': 'nit'},),
                                    reviews=(APPROVED,)),
     Recorded(findings=({**FINDING, 'by': 'commit-reviewer'},), reviews=(APPROVED,)), {'by': 'commit-reviewer'}),
    ('gate.pack_checks_ran', Recorded(gate_records=(_record('gate-runner', 'GO'),)),
     Recorded(gate_records=(_record('gate-runner', 'GO', checks=0),)), {}),
    ('gate.passed', Recorded(gate_records=(_record('gate-runner', 'GO'), _record('final-go', 'GO'))),
     Recorded(gate_records=(_record('gate-runner', 'GO'), _record('final-go', 'GO', 'b' * 40))), {}),
    ('push.tree_is_judged_tree', Recorded(gate_records=(_record('final-go', 'GO'),), pushes=({'tree': TREE},)),
     Recorded(gate_records=(_record('final-go', 'NO-GO'),), pushes=({'tree': TREE},)), {}),
    ('pr.opened', Recorded(pull_requests=({'draft': False},)), Recorded(), {}),
    ('pr.state_as_flow', Recorded(pull_requests=({'draft': False},)), Recorded(pull_requests=({'draft': True},)), {}),
    ('pr.links_issue', Recorded(issue=1, pull_requests=({'body': 'Fixes #1'},)),
     Recorded(issue=1, pull_requests=({'body': 'Fixes #12'},)), {}),
    ('triage.recorded', Recorded(triage={'kind': 'bug', 'severity': 'S2'}),
     Recorded(triage={'kind': 'bug', 'severity': 'S5'}), {}),
    ('tenets.recorded', Recorded(tenets={'schema': 'voc-tenets/1', 'tenets': [TENET]}),
     Recorded(tenets={'schema': 'voc-tenets/1', 'tenets': [TENET, TENET]}), {}),
    ('triage.labelled', Recorded(triage={'kind': 'bug', 'severity': 'S2'},
                                 labels=('voc-triage/bug', 'voc-severity/s2')),
     Recorded(triage={'kind': 'bug', 'severity': 'S2'}, labels=('voc-triage/bug',)), {}),
    ('triage.commented', Recorded(issue=1, comments=({'on': 'issue', 'number': 1},)),
     Recorded(issue=1, comments=({'on': 'pull_request', 'number': 1},)), {}),
    ('review.commented', Recorded(comments=({'on': 'pull_request', 'number': 7},)), Recorded(), {}),
    ('learn.proposals_name_case', Recorded(proposals=({'expected_case': 'a/b'},), case_ids=frozenset({'a/b'})),
     Recorded(proposals=({'expected_case': 'a/c'},), case_ids=frozenset({'a/b'})), {}),
])
def test_each_check_passes_on_what_it_asks_and_fails_on_anything_else(check: str, good: Recorded, bad: Recorded,
                                                                      args: dict[str, Any]) -> None:
    passed, detail = _check(check, good, **args) if check != 'patch.max_lines' else _check(check, good, max=10)
    assert passed, detail
    failed, why = _check(check, bad, **args)
    assert not failed
    assert why


@pytest.mark.parametrize(('reviews', 'detail'), [
    ((), ('the commit-reviewer recorded no review: a review that did not happen is no pass (0 blocking finding(s) by '
          'the commit-reviewer)')),
    ((_review('could_not_review', reason='the submitted patch could not be read'),),
     'the commit-reviewer could not review 1 of 1 change(s): the submitted patch could not be read'),
    ((APPROVED, _review('could_not_review', reason='the patch is empty')),
     'the commit-reviewer could not review 1 of 2 change(s): the patch is empty'),
    (({'schema': 'voc-review/1', 'verdict': 'lgtm', 'by': 'commit-reviewer'},),
     'the commit-reviewer could not review 1 of 1 change(s): its record is unreadable'),
    ((APPROVED, _review('request_changes')), '0 blocking finding(s) by the commit-reviewer; 1 of 2 review(s) approved'),
    ((_review('approve', by='pr-reviewer'),), ('the commit-reviewer recorded no review: a review that did not happen '
                                               'is no pass (0 blocking finding(s) by the commit-reviewer)')),
])
def test_a_reviewer_that_recorded_no_review_or_could_not_review_is_no_pass(reviews: tuple[dict[str, Any], ...],
                                                                            detail: str) -> None:
    # (7.54.00: the first live run's commit reviewer could not read the patch, wrote no finding, and its board step
    # passed on zero findings, 01M7QXJN02WSFMG92VWWZ00NKB)
    assert _check('review.no_blocking', Recorded(reviews=reviews), by='commit-reviewer') == (False, detail)
    assert _check('review.no_blocking', Recorded(reviews=(APPROVED,)), by='commit-reviewer') == (
        True, '0 blocking finding(s) by the commit-reviewer; 1 of 1 review(s) approved')


def test_a_role_that_writes_no_review_is_held_to_its_findings_alone() -> None:
    assert _check('review.no_blocking', Recorded(), by='hunter') == (True, '0 blocking finding(s) by the hunter')
    assert _check('review.no_blocking', Recorded(findings=(FINDING,)), by='hunter') == (
        False, '1 blocking finding(s) by the hunter')


def test_the_edge_cases_pass_or_fail_as_their_details_say() -> None:
    assert _check('findings.cite_evidence', Recorded()) == (False, 'no finding was written')
    assert _check('pr.links_issue', Recorded()) == (True, 'the run has no issue')
    assert _check('learn.proposals_name_case', Recorded()) == (True, 'no proposal was made')
    assert _check('push.tree_is_judged_tree', Recorded()) == (False, 'nothing was pushed')
    assert _check('pr.state_as_flow', Recorded(pr_setting='draft', pull_requests=({'draft': True},)))[0]
    assert _check('triage.recorded', Recorded()) == (False, 'no triage was recorded')
    # (7.52.00: the Tenets flow's draft, held to the record's own rules: unique ids, a voc-tenets/1 record)
    assert _check('tenets.recorded', Recorded()) == (False, 'no tenets were recorded')
    assert _check('tenets.recorded', Recorded(tenets={'schema': 'voc-triage/1', 'tenets': [TENET]})) == (
        False, 'the record is not voc-tenets/1')
    assert _check('tenets.recorded', Recorded(tenets={'schema': 'voc-tenets/1', 'tenets': [TENET]})) == (
        True, '1 tenet(s) drafted')
    assert assertions.changed_lines(FIX) == 4
    assert assertions.patch_paths(FIX) == ['calculator/ops.py', 'tests/test_ops.py']
    assert [assertions.is_test_path(path) for path in ('tests/test_ops.py', 'src/a.test.ts', 'src/a.py')] == [
        True, True, False]


def test_on_fail_decides_whether_a_failure_blocks() -> None:
    results = evaluate_all([{'check': 'pr.opened', 'on_fail': 'warn'}, {'check': 'pr.opened'},
                            {'check': 'pr.opened', 'on_fail': 'fail_arrow'}], Recorded())
    assert [(result.on_fail, result.blocks) for result in results] == [('warn', False), ('block', True),
                                                                        ('fail_arrow', True)]


@pytest.mark.parametrize(('raw', 'problem'), [
    ('pr.opened', 'an assertion is {check, args?, on_fail?}'),
    ({'check': 'pr.merged'}, "'pr.merged' is not an assertion of the vocabulary"),
    ({'check': 'tasks.posted', 'args': {'role': 'fixer'}}, 'tasks.posted takes role, min'),
    ({'check': 'pr.opened', 'args': {'x': 1}}, 'pr.opened takes no arguments'),
    ({'check': 'pr.opened', 'on_fail': 'ignore'}, 'on_fail is one of block, fail_arrow, warn'),
])
def test_a_raw_assertion_says_what_is_wrong_with_it(raw: object, problem: str) -> None:
    assert problems(raw) == [problem]
    assert problems({'check': 'tasks.posted', 'args': {'role': 'fixer', 'min': 1}}) == []
