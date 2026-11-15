"""The gate record: what the gate judged, what it found, what was done about it, and its verdict.

It is stored with the run (``to_dict``) and goes into the pull request's description (``render_markdown``).
Every string a model or the repository wrote is made safe for Markdown first (``text.cell``).
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from engineering.quality_gate.review import SEVERITIES, Finding
from engineering.quality_gate.text import cell
from engineering.runtime.outputs import GATE_SCHEMA as SCHEMA
from engineering.runtime.outputs import GATE_VERDICTS as VERDICTS
from engineering.runtime.outputs import PLAIN_NAME, STOP_REASON

# The record's schema name and verdicts, its plain names and stop reasons are runtime/outputs.py's, shared with the
# harness, whose write_gate_record (the gate runner's and the final go's) writes them.
#: What a reviser may say it did about a finding (a finding nobody acted on is ``open``).
REVISION_OUTCOMES = frozenset({'fixed', 'disputed', 'deferred'})
# The values the record prints as they are (the gate makes them; ``cell`` renders everything else): read back from
# the workspace, each must have the gate's own shape (a pack's or reviewer's ``PLAIN_NAME``, a ``STOP_REASON``, the
# ones below), so no Markdown, link or mention gets through them.
_FINDING_ID = re.compile(r'R[0-9]{1,2}-[A-Za-z0-9_.-]{1,64}-[0-9]{1,4}\Z')
_TREE = re.compile(r'(?:[0-9a-f]{40}|[0-9a-f]{64})?\Z')


@dataclass(frozen=True)
class RoundRecord:
    number: int
    checks: tuple[Mapping[str, object], ...]
    reviewed: bool
    finding_ids: tuple[str, ...]
    #: False when the gate stopped inside the round (an answer off contract): its reviews are partial.
    complete: bool = True

    @property
    def checks_passed(self) -> bool:
        return all(check.get('status') == 'pass' for check in self.checks)


@dataclass(frozen=True)
class FinalGoRecord:
    agent: str
    model_id: str
    go: bool
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class GateRecord:
    verdict: str
    tree_hash: str
    packs: tuple[str, ...]
    max_rounds: int
    rounds: tuple[RoundRecord, ...]
    findings: tuple[Finding, ...]
    outcomes: Mapping[str, tuple[str, str]]
    reviewers: tuple[str, ...]
    model_calls: int
    own_gate: bool = False
    tool_versions: Mapping[str, str] = field(default_factory=dict)
    final_go: FinalGoRecord | None = None
    stop_reason: str = ''
    #: The person who accepted the change at a human decision point (set by the run's decision, D4).
    accepted_by: str = ''

    def outcome(self, finding: Finding) -> tuple[str, str]:
        """``(outcome, note)``: what the reviser did about it, ``open`` when nothing was."""
        return self.outcomes.get(finding.id, ('open', ''))

    def to_dict(self) -> dict[str, Any]:
        return {
            'schema': SCHEMA, 'verdict': self.verdict, 'stop_reason': self.stop_reason, 'tree_hash': self.tree_hash,
            'packs': list(self.packs), 'own_gate': self.own_gate, 'tool_versions': dict(self.tool_versions),
            'max_rounds': self.max_rounds, 'reviewers': list(self.reviewers), 'model_calls': self.model_calls,
            'accepted_by': self.accepted_by,
            'rounds': [{'number': r.number, 'checks': [dict(c) for c in r.checks], 'reviewed': r.reviewed,
                        'complete': r.complete, 'finding_ids': list(r.finding_ids)} for r in self.rounds],
            'findings': [{**finding.__dict__, 'outcome': self.outcome(finding)[0],
                          'outcome_note': self.outcome(finding)[1]} for finding in self.findings],
            'final_go': None if self.final_go is None else {
                'agent': self.final_go.agent, 'model_id': self.final_go.model_id,
                'verdict': 'GO' if self.final_go.go else 'NO-GO', 'reasons': list(self.final_go.reasons)},
        }

    @classmethod
    def from_dict(cls, data: object) -> GateRecord:
        """A stored record read back (a report re-renders it): anything off ``voc-gate-record/1`` raises ValueError.

        The record comes back from the workspace, which the gate's agent wrote, so it is checked, not trusted: the
        values ``render_markdown`` prints as they are must have the gate's own shapes (verdicts, stop reasons, finding
        ids, severities, outcomes, pack and reviewer names, the tree hash); everything else it renders through
        ``cell``.
        """
        if not isinstance(data, Mapping) or data.get('schema') != SCHEMA:
            raise ValueError('not a voc-gate-record/1')
        final = data.get('final_go')
        findings = tuple(_finding(item) for item in _list(data, 'findings'))
        verdict = _str(data, 'verdict')
        if verdict not in VERDICTS:
            raise ValueError('"verdict" is GO, NO-GO or STOPPED')
        outcomes = {f.id: (_str(item, 'outcome') or 'open', _str(item, 'outcome_note'))
                    for f, item in zip(findings, map(_check, _list(data, 'findings')), strict=True)}
        if any(outcome != 'open' and outcome not in REVISION_OUTCOMES for outcome, _ in outcomes.values()):
            raise ValueError(f'an "outcome" is open or one of {sorted(REVISION_OUTCOMES)}')
        return cls(
            verdict=verdict, tree_hash=_shaped(data, 'tree_hash', _TREE),
            packs=tuple(_plain(name, 'packs') for name in _strs(data, 'packs')),
            max_rounds=_int(data, 'max_rounds'),
            reviewers=tuple(_plain(name, 'reviewers') for name in _strs(data, 'reviewers')),
            model_calls=_int(data, 'model_calls'), own_gate=data.get('own_gate') is True,
            stop_reason=_shaped(data, 'stop_reason', STOP_REASON), accepted_by=_str(data, 'accepted_by'),
            tool_versions={str(k): str(v) for k, v in _map(data, 'tool_versions').items()},
            rounds=tuple(RoundRecord(number=_int(r, 'number'), reviewed=r.get('reviewed') is True,
                                     complete=r.get('complete') is not False, finding_ids=_strs(r, 'finding_ids'),
                                     checks=tuple(dict(_check(c)) for c in _list(r, 'checks')))
                         for r in map(_check, _list(data, 'rounds'))),
            findings=findings, outcomes=outcomes,
            final_go=None if final is None else FinalGoRecord(
                agent=_str(_check(final), 'agent'), model_id=_str(_check(final), 'model_id'),
                go=_check(final).get('verdict') == 'GO', reasons=_strs(_check(final), 'reasons')))

    def render_markdown(self) -> str:
        """The record as the "Quality gate" section of a pull request description."""
        lines = [*self._summary_lines(), *self._round_lines(), *self._finding_lines(), *self._closing_lines()]
        return '\n'.join(lines) + '\n'

    def _summary_lines(self) -> list[str]:
        own = " (the repository's own gate)" if self.own_gate else ''
        accepted = [f'- Accepted by: {cell(self.accepted_by, 80)}'] if self.accepted_by else []
        return [
            '## Quality gate', '',
            f'**Verdict: {self.verdict}**' + (f' ({self.stop_reason})' if self.stop_reason else ''),
            *accepted,
            f'- Tree: `{self.tree_hash}`' if self.tree_hash else '- Tree: not hashed',
            (f'- Rounds: {len(self.rounds)} of at most {self.max_rounds}; '
             f'reviewers: {", ".join(self.reviewers) or "none"}'),
            f'- Gate packs: {", ".join(self.packs) or "none"}{own}',
            f'- Model calls: {self.model_calls}', '',
        ]

    def _round_lines(self) -> list[str]:
        lines = ['| Round | Checks | Reviewed | Blocking | Other |', '|---|---|---|---|---|']
        by_id = {finding.id: finding for finding in self.findings}
        for record in self.rounds:
            found = [by_id[i] for i in record.finding_ids if i in by_id]
            failed = [cell(str(c.get('name')), 80) for c in record.checks if c.get('status') != 'pass']
            checks = f'failed: {", ".join(failed)}' if failed else 'passed'
            reviewed = ('yes' if record.complete else 'stopped') if record.reviewed else 'no'
            lines.append(f'| {record.number} | {checks} | {reviewed} | '
                         f'{sum(f.blocking for f in found)} | {sum(not f.blocking for f in found)} |')
        return lines

    def _finding_lines(self) -> list[str]:
        if not self.findings:
            return ['', '### Findings', '', 'None.']
        lines = ['', '### Findings', '', '| Id | Severity | Where | Finding | Outcome |', '|---|---|---|---|---|']
        for finding in self.findings:
            where = f'{finding.file}:{finding.line}' if finding.line else finding.file
            outcome, note = self.outcome(finding)
            lines.append(f'| {finding.id} | {finding.severity} | {cell(where, 120) or "-"} | '
                         f'{cell(finding.title, 200)} | {outcome}{" — " + cell(note, 200) if note else ""} |')
        return lines

    def _closing_lines(self) -> list[str]:
        lines: list[str] = []
        if self.final_go is not None:
            lines += ['', f'### Final go: {"GO" if self.final_go.go else "NO-GO"}', '']
            lines += [f'- {cell(reason, 400)}' for reason in self.final_go.reasons] or ['- (no reasons given)']
        if self.tool_versions:
            lines += ['', '<details><summary>Tool versions</summary>', '']
            lines += [f'- {cell(name, 40)}: {cell(version, 200)}'
                      for name, version in sorted(self.tool_versions.items())]
            lines += ['', '</details>']
        return lines


# Reading a stored record back: each helper refuses a value of the wrong type (ValueError), so a record off the schema
# is never rendered half-read.
def _check(value: object) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError('a gate record entry is an object')
    return value


def _str(data: Mapping[str, Any], key: str) -> str:
    value = data.get(key, '')
    if not isinstance(value, str):
        raise ValueError(f'"{key}" is a string')
    return value


def _int(data: Mapping[str, Any], key: str) -> int:
    value = data.get(key, 0)
    if type(value) is not int or value < 0:
        raise ValueError(f'"{key}" is a whole number')
    return value


def _list(data: Mapping[str, Any], key: str) -> list[object]:
    value = data.get(key, [])
    if not isinstance(value, list):
        raise ValueError(f'"{key}" is a list')
    return value


def _strs(data: Mapping[str, Any], key: str) -> tuple[str, ...]:
    values = _list(data, key)
    if not all(isinstance(value, str) for value in values):
        raise ValueError(f'"{key}" is a list of strings')
    return tuple(str(value) for value in values)


def _map(data: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    return _check(data.get(key, {}))


def _shaped(data: Mapping[str, Any], key: str, pattern: re.Pattern[str]) -> str:
    value = _str(data, key)
    if not pattern.fullmatch(value):
        raise ValueError(f'"{key}" is not of the gate\'s own shape')
    return value


def _plain(value: str, key: str) -> str:
    if not PLAIN_NAME.fullmatch(value):
        raise ValueError(f'"{key}" holds plain names only')
    return value


def _finding(raw: object) -> Finding:
    item = _check(raw)
    severity = _str(item, 'severity')
    if severity not in SEVERITIES:
        raise ValueError(f'a finding\'s "severity" is one of {list(SEVERITIES)}')
    return Finding(id=_shaped(item, 'id', _FINDING_ID), round=_int(item, 'round'), reviewer=_str(item, 'reviewer'),
                   severity=severity, title=_str(item, 'title'), file=_str(item, 'file'),
                   line=_int(item, 'line'), quote=_str(item, 'quote'), trigger=_str(item, 'trigger'),
                   fix=_str(item, 'fix'), note=_str(item, 'note'))
