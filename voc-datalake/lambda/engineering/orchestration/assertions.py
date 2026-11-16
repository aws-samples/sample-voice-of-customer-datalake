"""Step assertions: a closed vocabulary of checks on what a step RECORDED, evaluated by platform code, never by a model.

A flow template's step carries ``assert: [{check, args?, on_fail?}]`` (``templates/orchestration/flows/*.yaml``,
compiled onto the voc-workflow/2 step's ``params.assert``). Each check reads the step's recorded outputs (a
``Recorded``: its tasks, the findings and notes written under the agents' keys, the submitted patches, the gate
records, the broker's host writes, the triage record) and answers pass or fail with one line of detail. No check
reads a model's prose, a summary or a finish: an agent saying it did something is not the record of it.

``on_fail`` says what a failure means: ``block`` (the default: the step does not pass and the run goes to a person),
``fail_arrow`` (a quality gate takes its ``fail`` arrow) or ``warn`` (recorded only). The board and the local runner
(``orchestration/runner.py``) share this module, so a template's assertions mean the same in both.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from engineering.connectors.write_policy import path_refusals
from shared.workflow_engineering import ASSERTION_ON_FAIL as ON_FAIL

DEFAULT_ON_FAIL: Final = 'block'
#: A test file in the layouts the gate packs know (pytest, unittest, node --test, vitest/jest, cargo, JUnit).
_TEST_PATH: Final = re.compile(r'(?:^|/)(?:tests?/|__tests__/|src/test/)|(?:^|/)test_[^/]*\.py\Z|_test\.(?:py|go|rs)\Z'
                               r'|\.(?:test|spec)\.[cm]?[jt]sx?\Z|Tests?\.java\Z')
_DIFF_PATH: Final = re.compile(r'^diff --git a/(?P<a>\S+) b/(?P<b>\S+)$', re.MULTILINE)
#: A triage's kinds and severities (voc-triage/1).
TRIAGE_KINDS: Final = frozenset({'bug', 'feature', 'investigation'})
SEVERITY: Final = re.compile(r'S[1-4]\Z')


@dataclass(frozen=True)
class Recorded:
    """What one step recorded, as the board and the workspace hold it (every field read back, never typed by a model).

    ``findings`` and ``gate_records`` carry the writer's role as ``by``; ``posted`` is ``(for_role, by_role)`` per task
    posted during the step; ``patches`` the submitted patches' text; ``pushes`` ``{branch, tree}`` and
    ``pull_requests`` ``{branch, tree, draft, body}`` the broker's host writes; ``comments`` ``{on, number, body}``;
    ``proposals`` the Learn step's coach proposals, each with its ``expected_case``.
    """

    findings: tuple[Mapping[str, Any], ...] = ()
    notes: tuple[Mapping[str, Any], ...] = ()
    posted: tuple[tuple[str, str], ...] = ()
    patches: tuple[str, ...] = ()
    gate_records: tuple[Mapping[str, Any], ...] = ()
    pushes: tuple[Mapping[str, Any], ...] = ()
    pull_requests: tuple[Mapping[str, Any], ...] = ()
    comments: tuple[Mapping[str, Any], ...] = ()
    labels: tuple[str, ...] = ()
    triage: Mapping[str, Any] | None = None
    proposals: tuple[Mapping[str, Any], ...] = ()
    #: The run's issue number (None: the run has none) and the flow's ``pr`` setting.
    issue: int | None = None
    pr_setting: str = 'ready'
    #: The eval case ids a proposal may name (``<flow>/<case>``).
    case_ids: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class Result:
    check: str
    passed: bool
    detail: str
    on_fail: str = DEFAULT_ON_FAIL

    @property
    def blocks(self) -> bool:
        """A failure that stops the step (``warn`` only records)."""
        return not self.passed and self.on_fail != 'warn'


Verdict = tuple[bool, str]


def patch_paths(patch: str) -> list[str]:
    """The paths a unified git diff touches (both sides of a rename)."""
    return list(dict.fromkeys(path for match in _DIFF_PATH.finditer(patch) for path in (match['a'], match['b'])))


def is_test_path(path: str) -> bool:
    """A test file in the layouts the gate packs know (pytest, unittest, node --test, vitest and jest, cargo, JUnit)."""
    return bool(_TEST_PATH.search(path))


def changed_lines(patch: str) -> int:
    """Added and removed lines of a unified diff (its file headers aside)."""
    return sum(1 for line in patch.splitlines()
               if line[:1] in '+-' and not line.startswith(('+++ ', '--- ')))


def _all(items: Sequence[Any], ok: Callable[[Any], bool], what: str, empty: str) -> Verdict:
    """Every item is ``ok``: ``<n> of <all> <what>`` (``what`` a plural phrase); ``empty`` (a failure) for none."""
    if not items:
        return False, empty
    good = sum(1 for item in items if ok(item))
    return good == len(items), f'{good} of {len(items)} {what}'


def _cites(finding: Mapping[str, Any]) -> bool:
    line = finding.get('line')
    return bool(str(finding.get('file', '')).strip()) and type(line) is int and line >= 1 \
        and bool(str(finding.get('evidence', '')).strip())


def _findings_cite(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    return _all(recorded.findings, _cites, 'findings cite a file, a line and their evidence', 'no finding was written')


def _notes_cite(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    return _all(recorded.notes, lambda note: bool(note.get('citations')), 'notes cite a source', 'no note was written')


def _tasks_posted(recorded: Recorded, args: Mapping[str, Any]) -> Verdict:
    role, least = str(args['role']), int(args['min'])
    count = sum(1 for for_role, _by in recorded.posted if for_role == role)
    return count >= least, f'{count} {role} task(s) posted (at least {least})'


def _submitted(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    count = sum(1 for patch in recorded.patches if patch.strip())
    return count > 0, f'{count} submitted patch(es)'


def _touches_tests(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    return _all(recorded.patches, lambda patch: any(map(is_test_path, patch_paths(patch))),
                'patches change a test', 'no patch was submitted')


def _no_ci(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    refused = [refusal.message for patch in recorded.patches for refusal in path_refusals(patch_paths(patch))]
    return not refused, refused[0] if refused else 'no patch changes a CI definition'


def _max_lines(recorded: Recorded, args: Mapping[str, Any]) -> Verdict:
    most = max((changed_lines(patch) for patch in recorded.patches), default=0)
    return most <= int(args['max']), f'the largest patch changes {most} lines (at most {args["max"]})'


def _no_blocking(recorded: Recorded, args: Mapping[str, Any]) -> Verdict:
    by = str(args['by'])
    blocking = [f for f in recorded.findings if f.get('by') == by and f.get('severity') == 'blocking']
    return not blocking, f'{len(blocking)} blocking finding(s) by the {by}'


def _record(recorded: Recorded, role: str) -> Mapping[str, Any] | None:
    records = [record for record in recorded.gate_records if record.get('by') == role]
    return records[-1] if records else None


def _checks_ran(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    record = _record(recorded, 'gate-runner')
    checks = [check for rounds in (record or {}).get('rounds', []) for check in rounds.get('checks', [])]
    return bool(checks), f'the gate runner recorded {len(checks)} check(s)'


def _gate_passed(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    runner, final = _record(recorded, 'gate-runner'), _record(recorded, 'final-go')
    verdicts = (runner or {}).get('verdict'), (final or {}).get('verdict')
    same_tree = bool(runner and final and runner.get('tree_hash') and runner['tree_hash'] == final.get('tree_hash'))
    return verdicts == ('GO', 'GO') and same_tree, f'gate runner {verdicts[0]}, final go {verdicts[1]}' + (
        '' if same_tree else ', not on one tree')


def _judged_tree(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    final = _record(recorded, 'final-go')
    tree = (final or {}).get('tree_hash') if (final or {}).get('verdict') == 'GO' else None
    if not recorded.pushes:
        return False, 'nothing was pushed'
    off = [push for push in recorded.pushes if push.get('tree') != tree]
    return not off, 'every push is the judged tree' if not off else f'{len(off)} push(es) are not the GO\'s tree'


def _pr_opened(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    return bool(recorded.pull_requests), f'{len(recorded.pull_requests)} pull request(s) opened'


def _pr_state(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    want = recorded.pr_setting == 'draft'
    return _all(recorded.pull_requests, lambda pr: bool(pr.get('draft')) is want,
                f'pull requests opened {"as a draft" if want else "ready for review"}', 'no pull request was opened')


def _links_issue(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    if recorded.issue is None:
        return True, 'the run has no issue'
    pattern = re.compile(rf'\b(?:Fixes|Closes|Resolves) #{recorded.issue}\b', re.IGNORECASE)
    return _all(recorded.pull_requests, lambda pr: bool(pattern.search(str(pr.get('body', '')))),
                f'pull requests say Fixes #{recorded.issue}', 'no pull request was opened')


def _triage_recorded(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    triage = recorded.triage or {}
    ok = triage.get('kind') in TRIAGE_KINDS and bool(SEVERITY.match(str(triage.get('severity', ''))))
    return ok, (f'triage {triage.get("kind")} {triage.get("severity")}' if triage else 'no triage was recorded')


def _triage_labelled(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    triage = recorded.triage or {}
    want = {f'voc-triage/{triage.get("kind")}', f'voc-severity/{str(triage.get("severity", "")).lower()}'}
    return bool(triage) and want <= set(recorded.labels), f'labels {sorted(recorded.labels)}'


def _triage_commented(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    on_issue = [c for c in recorded.comments if c.get('on') == 'issue' and c.get('number') == recorded.issue]
    return bool(on_issue), f'{len(on_issue)} comment(s) on the run\'s issue'


def _review_commented(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    on_pr = [c for c in recorded.comments if c.get('on') == 'pull_request']
    return bool(on_pr), f'{len(on_pr)} review comment(s) on the pull request'


def _proposals_name_case(recorded: Recorded, _args: Mapping[str, Any]) -> Verdict:
    if not recorded.proposals:
        return True, 'no proposal was made'
    return _all(recorded.proposals, lambda p: p.get('expected_case') in recorded.case_ids,
                'proposals name an eval case', 'no proposal was made')


@dataclass(frozen=True)
class Check:
    """One vocabulary entry: what it asks, the arguments it takes (each required), and its evaluator."""

    asks: str
    args: tuple[str, ...]
    judge: Callable[[Recorded, Mapping[str, Any]], Verdict]


#: The closed vocabulary (``schemas/assertion.schema.json`` lists the same ids; the validator holds the two equal).
VOCABULARY: Final[Mapping[str, Check]] = {
    'findings.cite_evidence': Check('every finding cites a file, a line and its evidence', (), _findings_cite),
    'gate.pack_checks_ran': Check('the gate runner recorded at least one check', (), _checks_ran),
    'gate.passed': Check('the gate runner and the final go both said GO, on one tree', (), _gate_passed),
    'learn.proposals_name_case': Check('every coach proposal names an existing eval case', (), _proposals_name_case),
    'notes.cite_sources': Check('every note cites a source', (), _notes_cite),
    'patch.max_lines': Check('no submitted patch changes more than max lines', ('max',), _max_lines),
    'patch.no_ci_changes': Check('no submitted patch changes a CI definition (the broker\'s rule)', (), _no_ci),
    'patch.submitted': Check('a patch was submitted', (), _submitted),
    'patch.touches_tests': Check('every submitted patch changes a test', (), _touches_tests),
    'pr.links_issue': Check('every pull request says Fixes #<the run\'s issue>', (), _links_issue),
    'pr.opened': Check('a pull request was opened', (), _pr_opened),
    'pr.state_as_flow': Check('every pull request opened ready or as a draft, as the flow\'s pr says', (), _pr_state),
    'push.tree_is_judged_tree': Check('every push is the tree the final go\'s GO names', (), _judged_tree),
    'review.commented': Check('a review comment was posted on the pull request', (), _review_commented),
    'review.no_blocking': Check('the role named by "by" wrote no blocking finding', ('by',), _no_blocking),
    'tasks.posted': Check('at least min tasks were posted for role', ('role', 'min'), _tasks_posted),
    'triage.commented': Check('the triage was commented on the run\'s issue', (), _triage_commented),
    'triage.labelled': Check('the issue carries the triage\'s kind and severity labels', (), _triage_labelled),
    'triage.recorded': Check('a voc-triage/1 record with a kind and a severity S1-S4', (), _triage_recorded),
}


def problems(assertion: object) -> list[str]:
    """What is wrong with one raw assertion (empty when nothing is): its check, its arguments, its on_fail."""
    if not isinstance(assertion, Mapping) or set(assertion) - {'check', 'args', 'on_fail'}:
        return ['an assertion is {check, args?, on_fail?}']
    entry = VOCABULARY.get(str(assertion.get('check')))
    if entry is None:
        return [f'{assertion.get("check")!r} is not an assertion of the vocabulary']
    args = assertion.get('args', {})
    found = []
    if not isinstance(args, Mapping) or set(args) != set(entry.args):
        found.append(f'{assertion["check"]} takes {", ".join(entry.args) or "no arguments"}')
    if assertion.get('on_fail', DEFAULT_ON_FAIL) not in ON_FAIL:
        found.append(f'on_fail is one of {", ".join(ON_FAIL)}')
    return found


def evaluate(assertion: Mapping[str, Any], recorded: Recorded) -> Result:
    """One assertion on ``recorded`` (a valid one: ``problems`` is empty for it)."""
    entry = VOCABULARY[str(assertion['check'])]
    passed, detail = entry.judge(recorded, assertion.get('args', {}))
    return Result(str(assertion['check']), passed, detail, str(assertion.get('on_fail', DEFAULT_ON_FAIL)))


def evaluate_all(assertions: Sequence[Mapping[str, Any]], recorded: Recorded) -> tuple[Result, ...]:
    return tuple(evaluate(assertion, recorded) for assertion in assertions)
