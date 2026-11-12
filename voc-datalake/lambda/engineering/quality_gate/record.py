"""The gate record: what the gate judged, what it found, what was done about it, and its verdict.

It is stored with the run (``to_dict``) and goes into the pull request's description (``render_markdown``).
Every string a model or the repository wrote is made safe for Markdown first (``text.cell``).
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from engineering.quality_gate.review import Finding
from engineering.quality_gate.text import cell

SCHEMA = 'voc-gate-record/1'


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
