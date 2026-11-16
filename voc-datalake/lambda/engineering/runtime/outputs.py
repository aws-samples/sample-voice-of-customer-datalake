"""The shapes of an agent's outputs, in one home the harness and the readers share.

The harness ships alone in the agents' images (engineering-images: no reader's module goes with it), and its
``role_tools`` write these outputs; the readers take the same values from here: a ``voc-finding/1`` line
(workspace/findings.py), a ``voc-note/1`` line (knowledge/notes.py), a ``voc-gate-record/1`` record and its verdicts
and severities (quality_gate/record.py, review.py), a package path as one workspace key segment
(workspace/layout.py), the agents' branch prefix (connectors/write_policy.py), and a submitted patch's key and the
broker's size bound for it (connectors/patches.py: the gate judges only a patch the broker would read). Pure: the
standard library only.
"""
from __future__ import annotations

import re
from typing import Final

FINDING_SCHEMA: Final = 'voc-finding/1'
NOTE_SCHEMA: Final = 'voc-note/1'
GATE_SCHEMA: Final = 'voc-gate-record/1'
SEVERITIES: Final = ('blocking', 'should_fix', 'nit')
#: The seven documents of a knowledge pack, in the order they are rendered (docs/autonomous-engineering.md's table).
NOTE_KINDS: Final = ('architecture', 'convention', 'review-guide', 'test-strategy', 'ci', 'glossary', 'how-we-work')
GATE_VERDICTS: Final = frozenset({'GO', 'NO-GO', 'STOPPED'})
#: A finding's file: a repository path of path characters only (no spaces, no ``@`` of an e-mail address), so a
#: ``file`` cannot carry text.
FINDING_FILE: Final = re.compile(r'[A-Za-z0-9_./+-]{1,300}\Z')
#: The branches an agent's push may name: ``voc-agent/<run id>/<name>``.
AGENT_BRANCH_PREFIX: Final = 'voc-agent/'
#: A gate record's plain names (a gate pack's, a reviewer's) and a STOPPED record's reason, as the harness writes
#: them and quality_gate/record.py reads them back.
PLAIN_NAME: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z')
STOP_REASON: Final = re.compile(r'[a-z_]{0,40}\Z')
#: A patch a fixer or builder submitted (``submit_work``): the one the gate judges and the committer pushes. Never a
#: checkpoint's snapshot (connectors/patches.py takes the same keys for the committer's push).
SUBMITTED_PATCH: Final = re.compile(r'ws/default/runs/(?P<run>[A-Za-z0-9_-]{1,64})/(?:fixer|builder)-[0-9]{1,3}/'
                                    r'commits/(?P<commit>[0-9a-f]{40}|[0-9a-f]{64})/_patches/attempt-[1-9][0-9]{0,3}/'
                                    r'(?P<name>[A-Za-z0-9][A-Za-z0-9_.-]{0,122}\.diff)\Z')
#: The largest submitted patch the broker reads, and so the largest the gate judges.
MAX_SUBMITTED_PATCH_BYTES: Final = 6 * 1024 * 1024
_PLAIN: Final = re.compile(rb'[A-Za-z0-9_-]')


def is_submitted_patch(key: str, run_id: str, commit: str) -> bool:
    """Whether ``key`` is a patch a fixer or builder of run ``run_id`` submitted at ``commit``: the one the gate
    judges (harness/role_tools.py) and the broker pushes for the committer (connectors/patches.py)."""
    match = SUBMITTED_PATCH.fullmatch(key)
    return (match is not None and match.group('run') == run_id and match.group('commit') == commit
            and not match.group('name').startswith('checkpoint-'))


def encode_package(package: str) -> str:
    """A package path as one key segment (workspace/layout.py checks and decodes it): every UTF-8 byte outside
    ``[A-Za-z0-9_-]`` as ``=XX``, and a leading ``_`` too (only the artifact kinds begin with one)."""
    return ''.join(chr(byte) if _PLAIN.fullmatch(bytes([byte])) and not (i == 0 and byte == ord('_'))
                   else f'={byte:02X}' for i, byte in enumerate(package.encode()))


#: An issue's triage (7.50.00): the understander's ``write_triage`` record, under its own keys
#: (``ws/<ws>/runs/<run>/<agent>/commits/<sha>/_triage/attempt-<n>/triage.json``), which a triage run's end copies to
#: the issue's trusted row (``ISSUE_TRIAGE#<ws>`` / ``<owner/name>#<n>`` in voc-agents), the row a Bug fixer's or
#: Feature builder's ``requires_triage`` reads. The labels are the broker's ``label_issue`` allowlist, the only labels
#: an agent ever puts on an issue.
TRIAGE_SCHEMA: Final = 'voc-triage/1'
TRIAGE_FILE: Final = 'triage.json'
TRIAGE_KINDS: Final = ('bug', 'feature', 'investigation')
TRIAGE_SEVERITIES: Final = ('S1', 'S2', 'S3', 'S4')
TRIAGE_PRIORITIES: Final = ('P1', 'P2', 'P3', 'P4')
TRIAGE_LABELS: Final = frozenset({*(f'voc-triage/{kind}' for kind in TRIAGE_KINDS),
                                  *(f'voc-severity/{severity.lower()}' for severity in TRIAGE_SEVERITIES)})
MAX_TRIAGE_SUMMARY: Final = 1_000
MAX_TRIAGE_ITEMS: Final = 10
MAX_TRIAGE_ITEM: Final = 300
MAX_TRIAGE_PATHS: Final = 20
#: A tenet's id as TENETS.md names one (``1``, ``D5``, a repository's own ``T-3``).
TENET_ID: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,39}\Z')


class TriageError(ValueError):
    """A triage record off its shape: the harness hands the reason to the model, a reader drops the record."""


def triage_labels(kind: str, severity: str) -> tuple[str, str]:
    """The two labels a triage puts on its issue: ``voc-triage/<kind>``, ``voc-severity/s<n>``."""
    return f'voc-triage/{kind}', f'voc-severity/{severity.lower()}'


def _triage_texts(raw: object, name: str, limit: int, pattern: re.Pattern[str] | None = None) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > limit:
        raise TriageError(f'{name} is a list of at most {limit} items')
    items = [item.strip() if isinstance(item, str) else '' for item in raw]
    if not all(item and len(item) <= MAX_TRIAGE_ITEM and (pattern is None or pattern.fullmatch(item))
               for item in items):
        raise TriageError(f'each of {name} is text of 1-{MAX_TRIAGE_ITEM} characters'
                          + (' of its own shape' if pattern is not None else ''))
    return list(dict.fromkeys(items))


def triage_record(raw: object) -> dict[str, object]:
    """``raw`` as a ``voc-triage/1`` record: ``kind`` (bug, feature or investigation), ``severity`` (S1-S4),
    ``priority`` (P1-P4), ``summary``, ``tenets`` (the ids it cites; none: ``[]``), ``paths`` (repository paths) and
    ``acceptance_criteria``; ``TriageError`` for anything else. Every field is text the model wrote: data, never an
    instruction, wherever it is read."""
    if not isinstance(raw, dict):
        raise TriageError('a triage is an object')
    kind, severity, priority = raw.get('kind'), raw.get('severity'), raw.get('priority')
    if kind not in TRIAGE_KINDS:
        raise TriageError(f'kind is one of {", ".join(TRIAGE_KINDS)}')
    if severity not in TRIAGE_SEVERITIES:
        raise TriageError(f'severity is one of {", ".join(TRIAGE_SEVERITIES)}')
    if priority not in TRIAGE_PRIORITIES:
        raise TriageError(f'priority is one of {", ".join(TRIAGE_PRIORITIES)}')
    summary = raw.get('summary')
    if not isinstance(summary, str) or not summary.strip() or len(summary) > MAX_TRIAGE_SUMMARY:
        raise TriageError(f'summary is text of 1-{MAX_TRIAGE_SUMMARY} characters')
    paths = _triage_texts(raw.get('paths'), 'paths', MAX_TRIAGE_PATHS, FINDING_FILE)
    if any(path.startswith('/') or '..' in path.split('/') for path in paths):
        raise TriageError('a path is a repository path (relative, no "..")')
    return {'schema': TRIAGE_SCHEMA, 'kind': kind, 'severity': severity, 'priority': priority,
            'summary': summary.strip(), 'tenets': _triage_texts(raw.get('tenets'), 'tenets', MAX_TRIAGE_ITEMS, TENET_ID),
            'paths': paths,
            'acceptance_criteria': _triage_texts(raw.get('acceptance_criteria'), 'acceptance_criteria',
                                                 MAX_TRIAGE_ITEMS)}
