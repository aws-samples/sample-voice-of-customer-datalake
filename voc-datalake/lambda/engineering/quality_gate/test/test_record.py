"""The gate record as stored with the run and as the pull request's "Quality gate" section."""
from __future__ import annotations

from typing import Any

from engineering.quality_gate.record import FinalGoRecord, GateRecord, RoundRecord
from engineering.quality_gate.review import Finding

FINDINGS = (
    Finding(id='R1-checks-1', round=1, reviewer='checks', severity='blocking', title='pytest: fail (exit 1)',
            file='.', trigger='exit 1'),
    Finding(id='R2-quality-1', round=2, reviewer='quality', severity='blocking', title='drops | the last <item>',
            file='app/paging.py', line=3),
    Finding(id='R2-security-1', round=2, reviewer='security', severity='should_fix', title='ask @owners',
            note='downgraded: the quoted code is not in the diff'),
)
ROUNDS = (
    RoundRecord(number=1, checks=({'name': 'pytest', 'status': 'fail'},), reviewed=False,
                finding_ids=('R1-checks-1',)),
    RoundRecord(number=2, checks=({'name': 'pytest', 'status': 'pass'},), reviewed=True,
                finding_ids=('R2-quality-1', 'R2-security-1')),
    RoundRecord(number=3, checks=({'name': 'pytest', 'status': 'pass'},), reviewed=True, finding_ids=()),
)


def _record(**changes: Any) -> GateRecord:
    fields: dict[str, Any] = {
        'verdict': 'GO', 'tree_hash': 'b' * 40, 'packs': ('python-ts',), 'max_rounds': 3, 'rounds': ROUNDS,
        'findings': FINDINGS, 'reviewers': ('security', 'quality'), 'model_calls': 9,
        'outcomes': {'R1-checks-1': ('fixed', 'test repaired'), 'R2-quality-1': ('fixed', '')},
        'tool_versions': {'python': 'Python 3.12.3'},
        'final_go': FinalGoRecord(agent='final-go', model_id='m', go=True, reasons=('all fixed',))}
    fields.update(changes)
    return GateRecord(**fields)


def test_the_markdown_section_for_a_go():
    assert _record().render_markdown() == '\n'.join([
        '## Quality gate', '',
        '**Verdict: GO**',
        f'- Tree: `{"b" * 40}`',
        '- Rounds: 3 of at most 3; reviewers: security, quality',
        '- Gate packs: python-ts',
        '- Model calls: 9', '',
        '| Round | Checks | Reviewed | Blocking | Other |', '|---|---|---|---|---|',
        '| 1 | failed: `pytest` | no | 1 | 0 |',
        '| 2 | passed | yes | 1 | 1 |',
        '| 3 | passed | yes | 0 | 0 |',
        '', '### Findings', '',
        '| Id | Severity | Where | Finding | Outcome |', '|---|---|---|---|---|',
        '| R1-checks-1 | blocking | `.` | `pytest: fail (exit 1)` | fixed — `test repaired` |',
        '| R2-quality-1 | blocking | `app/paging.py:3` | `drops \\| the last <item>` | fixed |',
        '| R2-security-1 | should_fix | - | `ask @owners` | open |',
        '', '### Final go: GO', '', '- `all fixed`',
        '', '<details><summary>Tool versions</summary>', '', '- `python`: `Python 3.12.3`', '', '</details>',
    ]) + '\n'


def test_a_stopped_gate_without_findings_or_a_final_go():
    rounds = (RoundRecord(number=1, checks=(), reviewed=True, finding_ids=(), complete=False),)
    text = _record(verdict='STOPPED', stop_reason='verification', findings=(), rounds=rounds, final_go=None,
                   tool_versions={}, tree_hash='', own_gate=True, reviewers=()).render_markdown()
    assert '**Verdict: STOPPED** (verification)' in text
    assert '- Tree: not hashed' in text
    assert "- Gate packs: python-ts (the repository's own gate)" in text
    assert 'reviewers: none' in text
    assert '| 1 | passed | stopped | 0 | 0 |' in text
    assert text.endswith('### Findings\n\nNone.\n')


def test_an_accepted_no_go_names_who_accepted_it():
    text = _record(verdict='NO-GO', final_go=FinalGoRecord('final-go', 'm', False, ()),
                   accepted_by='qa-ben').render_markdown()
    assert '**Verdict: NO-GO**\n- Accepted by: `qa-ben`\n' in text
    assert '### Final go: NO-GO\n\n- (no reasons given)' in text


def test_to_dict_carries_every_finding_with_its_outcome():
    data = _record(accepted_by='qa-ben').to_dict()
    assert (data['schema'], data['accepted_by']) == ('voc-gate-record/1', 'qa-ben')
    assert data['final_go'] == {'agent': 'final-go', 'model_id': 'm', 'verdict': 'GO', 'reasons': ['all fixed']}
    assert [(f['id'], f['outcome'], f['outcome_note']) for f in data['findings']] == [
        ('R1-checks-1', 'fixed', 'test repaired'), ('R2-quality-1', 'fixed', ''), ('R2-security-1', 'open', '')]
    assert data['rounds'][0] == {'number': 1, 'checks': [{'name': 'pytest', 'status': 'fail'}],
                                 'reviewed': False, 'complete': True, 'finding_ids': ['R1-checks-1']}
    assert _record(final_go=None).to_dict()['final_go'] is None
