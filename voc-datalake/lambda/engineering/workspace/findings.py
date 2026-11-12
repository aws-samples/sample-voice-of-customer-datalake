"""``voc-finding/1``: one line of a finding shard (``<shard>.jsonl``), as agents write it and reports read it.

``{"schema": "voc-finding/1", "file": "src/a.py", "line": 12, "severity": "blocking", "rule": "B101" | reviewer,
"title": "...", "evidence": "..."}``. Agent output is data: a line off the schema is skipped and counted, never
trusted, a ``file`` is a repository path of path characters only, and the text a report keeps from a line (rule,
title, evidence) is cut short, with credential-shaped strings and personal data (e-mail addresses, phone numbers, card
numbers…) replaced first, so no customer text or secret reaches a report or a pull request through a finding.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from engineering.quality_gate.review import SEVERITIES
from engineering.quality_gate.text import redact
from shared.pii_redaction import redact_text

SCHEMA = 'voc-finding/1'
MAX_TITLE = 200
MAX_EVIDENCE = 500
MAX_LINE_BYTES = 8 * 1024
#: A repository path: path characters only (no spaces, no ``@`` of an e-mail address), so a ``file`` cannot carry text.
_PATH = re.compile(r'[A-Za-z0-9_./+-]{1,300}\Z')


@dataclass(frozen=True)
class Finding:
    file: str
    line: int
    severity: str
    rule: str
    title: str
    evidence: str

    @property
    def rank(self) -> tuple[int, str, int]:
        """Most severe first, then by place."""
        return SEVERITIES.index(self.severity), self.file, self.line


def _safe(text: str, limit: int) -> str:
    return redact_text(redact(text)).text[:limit]


def _finding(raw: str) -> Finding | None:
    if len(raw.encode()) > MAX_LINE_BYTES:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or data.get('schema') != SCHEMA:
        return None
    file, line, severity = data.get('file'), data.get('line', 0), data.get('severity')
    rule, title, evidence = data.get('rule', ''), data.get('title'), data.get('evidence', '')
    texts_ok = all(isinstance(value, str) for value in (file, rule, title, evidence))
    if not (texts_ok and severity in SEVERITIES and type(line) is int and line >= 0):
        return None
    path = str(file)
    if not _PATH.fullmatch(path) or path.startswith('/') or '..' in path.split('/') or not str(title).strip():
        return None
    return Finding(file=path, line=line, severity=str(severity), rule=_safe(str(rule), 100),
                   title=_safe(str(title), MAX_TITLE), evidence=_safe(str(evidence), MAX_EVIDENCE))


def parse_shard(text: str) -> tuple[list[Finding], int]:
    """The shard's findings, and how many of its non-empty lines were off the schema (skipped)."""
    findings: list[Finding] = []
    skipped = 0
    for raw in text.splitlines():
        if raw.strip():
            finding = _finding(raw)
            if finding is None:
                skipped += 1
            else:
                findings.append(finding)
    return findings, skipped
