"""The shapes of an agent's outputs, in one home the harness and the readers share.

The harness ships alone in the agents' images (templates/orchestration/images: no reader's module goes with it), and its
``role_tools`` write these outputs; the readers take the same values from here: a ``voc-finding/1`` line
(workspace/findings.py), a ``voc-note/1`` line (knowledge/notes.py), a ``voc-gate-record/1`` record and its verdicts
and severities (quality_gate/record.py, review.py), a package path as one workspace key segment
(workspace/layout.py), the agents' branch prefix and (7.71.03) a run's own branch (connectors/write_policy.py), a
submitted patch's key and the broker's size bound for it (connectors/patches.py: the gate judges only a patch the
broker would read), a triage record and, since 7.52.00, a ``voc-tenets/1`` record and the rule that holds a triage to
the accepted tenets. Pure: the standard library only.
"""
from __future__ import annotations

import re
from typing import Any, Final

FINDING_SCHEMA: Final = 'voc-finding/1'
NOTE_SCHEMA: Final = 'voc-note/1'
GATE_SCHEMA: Final = 'voc-gate-record/1'
#: A gate record's object name under its ``_gate/attempt-<n>/`` (the harness writes it, the GO ledger reads it).
GATE_RECORD_FILE: Final = 'record.json'
SEVERITIES: Final = ('blocking', 'should_fix', 'nit')
#: The seven documents of a knowledge pack, in the order they are rendered (docs/autonomous-engineering.md's table).
NOTE_KINDS: Final = ('architecture', 'convention', 'review-guide', 'test-strategy', 'ci', 'glossary', 'how-we-work')
GATE_VERDICTS: Final = frozenset({'GO', 'NO-GO', 'STOPPED'})
#: A finding's file: a repository path of path characters only (no spaces, no ``@`` of an e-mail address), so a
#: ``file`` cannot carry text.
FINDING_FILE: Final = re.compile(r'[A-Za-z0-9_./+-]{1,300}\Z')
#: The agents' branches' prefix; a run's own branch is one level under it (``run_branch``).
AGENT_BRANCH_PREFIX: Final = 'voc-agent/'


def run_branch(run_id: str) -> str:
    """The run's own branch, ``voc-agent/<run id>-fix`` (7.71.03): the one the harness has the committer push to and
    the PR author open from (the model never types it), and the only one the broker lets the run push to
    (connectors/write_policy.py). One level under ``voc-agent/``, because the setup guide's GitHub ruleset that leaves
    ``refs/heads/voc-agent/*`` unprotected matches one level only (its ``*`` does not cross a ``/``): 7.71.02's
    ``voc-agent/<run id>/fix`` got that ruleset's rules on a repository set up as the guide says, and the broker
    refuses a push to a protected agent branch (the first live Bug fixer rerun's 409)."""
    return f'{AGENT_BRANCH_PREFIX}{run_id}-fix'
#: How the run's pull request opens (7.50.00, META's ``pull_request``): ready for review unless its flow says
#: ``pr: draft`` (the flow's settings, its start step's ``data.params``); the broker reads it at the open
#: (connectors/records.py ``RunRecord.draft_pr``), and since 7.71.02 the PR author's opening says it.
PULL_REQUEST_READY: Final = 'ready'
PULL_REQUEST_DRAFT: Final = 'draft'
#: A gate record's plain names (a gate pack's, a reviewer's) and a STOPPED record's reason, as the harness writes
#: them and quality_gate/record.py reads them back.
PLAIN_NAME: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z')
STOP_REASON: Final = re.compile(r'[a-z_]{0,40}\Z')
#: A patch a fixer or builder submitted (``submit_work``): the one the gate judges and the committer pushes. Never a
#: checkpoint's snapshot (connectors/patches.py takes the same keys for the committer's push).
SUBMITTED_PATCH: Final = re.compile(r'ws/default/runs/(?P<run>[A-Za-z0-9_-]{1,64})/(?:fixer|builder)-[0-9]{1,3}/'
                                    r'commits/(?P<commit>[0-9a-f]{40}|[0-9a-f]{64})/_patches/attempt-[1-9][0-9]{0,3}/'
                                    r'(?P<name>[A-Za-z0-9][A-Za-z0-9_.-]{0,122}\.diff)\Z')
#: The roles whose task names a submitted patch: the gate's (which judge it), the reviewers (7.54.00: which review it)
#: and the committer (which pushes it); a child run never seeds one of their tasks (runtime/restart.py: they are posted
#: again on the child's own patch).
PATCH_ROLES: Final = frozenset({'gate-runner', 'final-go', 'committer', 'commit-reviewer', 'pr-reviewer'})
#: The roles that judge a submitted patch without running code (7.54.00): the harness's ``read_patch`` answers them its
#: text, and the reviewers' checkout has it applied (harness/review_tools.py; the final go's is the gate's tree).
PATCH_READERS: Final = frozenset({'commit-reviewer', 'pr-reviewer', 'final-go'})
#: The largest submitted patch the broker reads, and so the largest the gate judges.
MAX_SUBMITTED_PATCH_BYTES: Final = 6 * 1024 * 1024

#: A reviewer's verdict (7.54.00, ``write_review``): ``voc-review/1``, under its own keys
#: (``ws/<ws>/runs/<run>/<agent>/commits/<sha>/_review/attempt-<n>/review.json``), which a board's ``review.no_blocking``
#: reads (orchestration/assertions.py): a reviewer that recorded none, or could not review, is never a pass.
REVIEW_SCHEMA: Final = 'voc-review/1'
REVIEW_FILE: Final = 'review.json'
REVIEW_ROLES: Final = frozenset({'commit-reviewer', 'pr-reviewer'})
APPROVE, REQUEST_CHANGES, COULD_NOT_REVIEW = 'approve', 'request_changes', 'could_not_review'
REVIEW_VERDICTS: Final = (APPROVE, REQUEST_CHANGES, COULD_NOT_REVIEW)
MAX_REVIEW_REASONS: Final = 10
MAX_REVIEW_REASON: Final = 400
_PLAIN: Final = re.compile(rb'[A-Za-z0-9_-]')


def is_submitted_patch(key: str, run_id: str, commit: str) -> bool:
    """Whether ``key`` is a patch a fixer or builder of run ``run_id`` submitted at ``commit``: the one the gate
    judges (harness/role_tools.py) and the broker pushes for the committer (connectors/patches.py)."""
    match = SUBMITTED_PATCH.fullmatch(key)
    return (match is not None and match.group('run') == run_id and match.group('commit') == commit
            and not match.group('name').startswith('checkpoint-'))


def review_verdict(record: object) -> tuple[str, str]:
    """A ``voc-review/1`` record's verdict and its first reason (``('', '')`` for anything off its shape): what the
    finish and a board's ``review.no_blocking`` read of it."""
    if not isinstance(record, dict) or record.get('schema') != REVIEW_SCHEMA or record.get('verdict') not in REVIEW_VERDICTS:
        return '', ''
    reasons = record.get('reasons')
    first = reasons[0] if isinstance(reasons, list) and reasons and isinstance(reasons[0], str) else ''
    return str(record['verdict']), first[:MAX_REVIEW_REASON]


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
    for name, choices in (('kind', TRIAGE_KINDS), ('severity', TRIAGE_SEVERITIES), ('priority', TRIAGE_PRIORITIES)):
        if raw.get(name) not in choices:
            raise TriageError(f'{name} is one of {", ".join(choices)}')
    kind, severity, priority = raw['kind'], raw['severity'], raw['priority']
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


def unaccepted_tenets(cited: object, accepted: frozenset[str]) -> list[str]:
    """The tenet ids a triage cites that the connection's accepted tenets version does not hold (7.52.00, the hard
    lock: ``write_triage`` and the run's end refuse a triage that names one). With no version accepted, ``accepted`` is
    empty and every cited id is one: such a triage cites none (``[]``)."""
    listed = cited if isinstance(cited, list) else []
    return [str(tenet) for tenet in listed if str(tenet) not in accepted]


#: A repository's tenets (7.52.00): the understander's ``write_tenets`` record in the Tenets flow, under its own keys
#: (``ws/<ws>/runs/<run>/<agent>/commits/<sha>/_tenets/attempt-<n>/tenets.json``), which the run's end
#: (``runtime/tenets_end.py``) drafts as the connection's next tenets version (``knowledge/tenets.py``) for an
#: administrator to accept or reject; an accepted version is what TENETS.md is rendered from and what a triage may cite.
TENETS_SCHEMA: Final = 'voc-tenets/1'
TENETS_FILE: Final = 'tenets.json'
MAX_TENETS: Final = 30
MAX_TENET_TITLE: Final = 120
MAX_TENET_TEXT: Final = 600
MAX_TENET_CITATIONS: Final = 8
MAX_TENETS_SUMMARY: Final = 1_000
#: A tenet's citation: a repository path, ``path:line`` or a full commit sha (path characters only, no space).
TENET_CITATION: Final = re.compile(r'[A-Za-z0-9_./@+-]{1,300}(?::[1-9][0-9]{0,8})?\Z')


class TenetsError(ValueError):
    """A tenets record off its shape: the harness hands the reason to the model, a reader drops the record."""


def _tenet_text(raw: object, name: str, limit: int, *, required: bool = True) -> str:
    text = raw.strip() if isinstance(raw, str) else None
    one_line = name == 'title'
    if text is None or (required and not text) or len(text) > limit or (one_line and '\n' in text):
        raise TenetsError(f'{name} is text of {1 if required else 0}-{limit} characters'
                          + (' on one line' if one_line else ''))
    return text


def _citations(raw: object) -> list[str]:
    if not isinstance(raw, list) or len(raw) > MAX_TENET_CITATIONS or not all(
            isinstance(c, str) and TENET_CITATION.fullmatch(c) and not c.startswith('/') and '..' not in c.split('/')
            for c in raw):
        raise TenetsError(f'a tenet cites at most {MAX_TENET_CITATIONS} places: repository paths (path or path:line, '
                          'relative, no "..") or commits')
    return list(dict.fromkeys(raw))


def _tenet(raw: object) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise TenetsError('a tenet is an object: {id, title, statement, rationale?, citations?}')
    tenet_id = raw.get('id')
    if not isinstance(tenet_id, str) or not TENET_ID.fullmatch(tenet_id):
        raise TenetsError('a tenet\'s id is 1-40 letters, digits, ".", "_" or "-", starting with a letter or digit')
    return {'id': tenet_id, 'title': _tenet_text(raw.get('title'), 'title', MAX_TENET_TITLE),
            'statement': _tenet_text(raw.get('statement'), 'statement', MAX_TENET_TEXT),
            'rationale': _tenet_text(raw.get('rationale', ''), 'rationale', MAX_TENET_TEXT, required=False),
            'citations': _citations(raw.get('citations', []))}


def tenets_record(raw: object) -> dict[str, Any]:
    """``raw`` as a ``voc-tenets/1`` record: ``tenets`` (1 to ``MAX_TENETS``, each ``{id, title, statement,
    rationale, citations}``, the ids unique) and an optional ``summary``; ``TenetsError`` for anything else. Every
    field is text a model wrote: data, never an instruction, wherever it is read."""
    if not isinstance(raw, dict):
        raise TenetsError('a tenets record is an object: {tenets: [...], summary?}')
    listed = raw.get('tenets')
    if not isinstance(listed, list) or not 0 < len(listed) <= MAX_TENETS:
        raise TenetsError(f'tenets is a list of 1-{MAX_TENETS} tenets')
    tenets = [_tenet(item) for item in listed]
    ids = [str(tenet['id']) for tenet in tenets]
    if len(set(ids)) != len(ids):
        raise TenetsError('each tenet has an id of its own')
    summary = _tenet_text(raw.get('summary', ''), 'summary', MAX_TENETS_SUMMARY, required=False)
    return {'schema': TENETS_SCHEMA, 'summary': summary, 'tenets': tenets}
