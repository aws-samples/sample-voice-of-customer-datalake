"""A report as Markdown: the run page shows it, and the PR report's goes into the pull request's description.

Every string an agent, a repository or a person wrote goes through ``text.cell`` (one line, Markdown-inert); the PR
report adds the quality gate's own section, rendered from its checked record.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from engineering.quality_gate.record import GateRecord
from engineering.quality_gate.text import cell

TITLES = {'commit': 'Commit report', 'pr': 'Pull request report', 'goal': 'Goal report'}


def _cost_lines(report: Mapping[str, Any]) -> list[str]:
    cost, time = report['cost'], report['time']
    seconds = time['seconds']
    return [
        '### Cost and time', '',
        (f'- Cost: ${cost["usd"]} (as metered); tokens in {cost["input_tokens"]}, '
         f'out {cost["output_tokens"]}; session-seconds {cost["microvm_seconds"]}; events {cost["events"]}'),
        f'- Time: {cell(time["started_at"], 40) or "not started"} to {cell(time["ended_at"], 40) or "running"}'
        + (f' ({seconds} s)' if seconds is not None else ''),
        # (never in a pull request's report: its Markdown is the PR's description, in the target repository)
        *(_budget_lines(cost.get('budget')) if report['level'] != 'pr' else []),
    ]


def _budget_lines(budget: Mapping[str, Any] | None) -> list[str]:
    """The flow's monthly budget and its flag (measured: session time only until tokens are priced)."""
    if not budget:
        return []
    line = f'- Flow budget: ${budget["monthly_usd"]:,.2f} a month'
    if budget.get('alert_percent'):
        line += f'; its month passed {budget["alert_percent"]}% of it ({cell(str(budget["alert_month"]), 10)})'
    return [line + ' (session time only until tokens are priced)']


def _agent_lines(report: Mapping[str, Any]) -> list[str]:
    lines = ['', '### Agents', '', '| Agent | Role | Skill version | Model |', '|---|---|---|---|']
    lines += [f'| {cell(a["agent"], 60)} | {cell(a["role"], 40)} | {cell(a["skill_version"], 40) or "-"} | '
              f'{cell(a["model"], 80) or "-"} |' for a in report['agents']]
    return lines if report['agents'] else ['', '### Agents', '', 'None recorded.']


def _finding_lines(report: Mapping[str, Any]) -> list[str]:
    findings = report['findings']
    by_severity = ', '.join(f'{name} {count}' for name, count in sorted(findings['by_severity'].items())) or 'none'
    lines = ['', '### Findings', '', f'{findings["total"]} ({by_severity})'
             + (f'; {findings["skipped_lines"]} lines off the schema skipped' if findings['skipped_lines'] else '')]
    shown = findings['top']
    if shown:
        lines += ['', '| Severity | Where | Finding | Rule |', '|---|---|---|---|']
        lines += [f'| {f["severity"]} | {cell(f"{f["file"]}:{f["line"]}" if f["line"] else f["file"], 120)} | '
                  f'{cell(f["title"], 200)} | {cell(f["rule"], 60) or "-"} |' for f in shown]
    return lines


def render_markdown(report: Mapping[str, Any], gate: GateRecord | None = None) -> str:
    run = report['run']
    states = ', '.join(f'{state} {count}' for state, count in sorted(report['tasks']['by_state'].items())) or 'none'
    lines = [
        f'## {TITLES[report["level"]]}: {cell(report["subject"], 80)} (v{report["version"]})', '',
        f'- Goal: {cell(run["goal"], 300) or "-"}', f'- Repository: {cell(run["repo"], 120) or "-"}',
        f'- Flow: {cell(run["flow"], 80) or "-"}; run {cell(report["run_id"], 40)} ({cell(run["status"], 40) or "-"})',
        f'- Tasks: {states}', '',
        *_cost_lines(report), *_agent_lines(report), *_finding_lines(report),
    ]
    text = '\n'.join(lines) + '\n'
    return text + '\n' + gate.render_markdown() if report['level'] == 'pr' and gate is not None else text
