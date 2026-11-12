"""``voc-note/1``: one line of what the map step learned from a shard, as the mapper writes it and the reduce reads it.

``{"schema": "voc-note/1", "kind": "convention", "package": "packages/web", "subject": "error handling",
"claim": "...", "citations": ["src/a.ts:12", "<full commit sha>", "<a pull request comment's URL>"]}``.

Model output is data: a line off the schema is dropped and counted, never trusted. A citation is one of three
shapes, each checked against what the shard itself read (``CitationRules``, narrowed per shard by the mapper):
``path:line`` (a path of path characters, no ``..``, a line from 1; one of the shard's files, and a line it showed),
a full commit sha (one of the shard's history window), or the URL of a review comment on the connection's own
repository (GitHub ``…/pull/<n>#discussion_r<id>``, ``#issuecomment-<id>``, ``#pullrequestreview-<id>``; GitLab
``…/-/merge_requests/<n>#note_<id>``) that appears in the shard's pull request page; nothing else: no other host, no
query string. A citation that is not one of them is removed; a note left with no citation is dropped (counted as ``citation``). The claim is repository text: it
is cut to ``MAX_CLAIM`` characters on one line, with credential-shaped strings and personal data (e-mail addresses,
phone numbers, card numbers…) replaced first, as ``workspace/findings.py`` does for a finding. ``subject`` (a few
lower-case words, optional) names what the claim is about: two claims on one subject of one document say the same
thing or contradict each other (``reduce``).
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from engineering.quality_gate.text import redact
from engineering.workspace.findings import schema_line
from engineering.workspace.layout import SHA
from shared.pii_redaction import redact_text

SCHEMA = 'voc-note/1'
#: The seven documents of a pack, in the order they are rendered (docs/autonomous-engineering.md's table).
KINDS = ('architecture', 'convention', 'review-guide', 'test-strategy', 'ci', 'glossary', 'how-we-work')
MAX_CLAIM = 400
MAX_SUBJECT = 80
MAX_CITATIONS = 8
MAX_LINE_BYTES = 8 * 1024
MAX_NOTES = 200
_PATH = re.compile(r'[A-Za-z0-9_./@+-]{1,300}\Z')
#: A subject: a few lower-case words (a note's here, an agent memory's in engineering/agent_memory/model.py).
SUBJECT = re.compile(r'[a-z0-9][a-z0-9 ._-]{0,79}\Z')
_GITHUB_COMMENT = re.compile(r'/pull/[1-9][0-9]{0,9}#(?:discussion_r|issuecomment-|pullrequestreview-)[1-9][0-9]{0,19}\Z')
_GITLAB_NOTE = re.compile(r'/-/merge_requests/[1-9][0-9]{0,9}#note_[1-9][0-9]{0,19}\Z')
_WEB_URL = re.compile(r'https://[a-z0-9.-]{1,253}(?::[0-9]{1,5})?/[A-Za-z0-9._/-]{1,300}\Z')


@dataclass(frozen=True)
class CitationRules:
    """What a citation may point at: the connection's repository, and (when given) what the shard read."""

    host: Literal['github', 'gitlab']
    #: The repository's web address, ``https://github.com/<owner>/<name>`` or a GitLab project's.
    web_url: str
    #: The paths a ``path:line`` may name, the commits a sha may name and the comment URLs a URL may name (None:
    #: any well-formed one); ``lines``: for a path it holds, the first and last line that may be cited.
    paths: Collection[str] | None = None
    shas: Collection[str] | None = None
    urls: Collection[str] | None = None
    lines: Mapping[str, tuple[int, int]] | None = None

    def __post_init__(self) -> None:
        if not _WEB_URL.fullmatch(self.web_url) or self.web_url.endswith('/'):
            raise ValueError('the repository web address is https://<host>/<path>, with no trailing slash')

    def valid(self, citation: str) -> bool:
        if citation.startswith('https://'):
            rest = citation.removeprefix(self.web_url)
            pattern = _GITHUB_COMMENT if self.host == 'github' else _GITLAB_NOTE
            return (rest != citation and pattern.fullmatch(rest) is not None
                    and (self.urls is None or citation in self.urls))
        if SHA.fullmatch(citation):
            return self.shas is None or citation in self.shas
        path, _, line = citation.rpartition(':')
        # A path is repository text too: one that reads as personal data (an e-mail address) is not cited.
        shown = (self.lines or {}).get(path)
        return (line.isdigit() and redact_text(path).text == path and 0 < int(line) <= 10_000_000
                and _PATH.fullmatch(path) is not None and '..' not in path.split('/') and '' not in path.split('/')
                and (self.paths is None or path in self.paths)
                and (shown is None or shown[0] <= int(line) <= shown[1]))

    def comment_urls(self, text: str) -> set[str]:
        """The review comment URLs of the connection's repository that ``text`` (a pull request read) holds."""
        tail = (r'/pull/[1-9][0-9]{0,9}#(?:discussion_r|issuecomment-|pullrequestreview-)[1-9][0-9]{0,19}'
                if self.host == 'github' else r'/-/merge_requests/[1-9][0-9]{0,9}#note_[1-9][0-9]{0,19}')
        found = re.findall(re.escape(self.web_url) + tail + r'(?![0-9])', text)
        return {url for url in found if self.valid(url)}


@dataclass(frozen=True)
class Note:
    kind: str
    package: str
    claim: str
    citations: tuple[str, ...]
    subject: str = ''
    #: Who wrote the claim: ``''`` for the map step, a person's id for a human edit (the edit wins, ``reduce``).
    author: str = ''

    @property
    def key(self) -> str:
        """The claim as two notes saying the same thing share it: case, spacing and the final full stop aside."""
        return ' '.join(self.claim.casefold().split()).rstrip('.')

    @property
    def id(self) -> str:
        return hashlib.sha256(json.dumps([self.package, self.kind, self.key]).encode()).hexdigest()[:16]

    def to_line(self) -> str:
        return json.dumps({'schema': SCHEMA, 'kind': self.kind, 'package': self.package, 'subject': self.subject,
                           'claim': self.claim, 'citations': list(self.citations)}, sort_keys=True)


@dataclass(frozen=True)
class NoteBatch:
    notes: tuple[Note, ...]
    #: Lines dropped, by reason: ``schema``, ``package``, ``citation`` (no valid citation left), ``cap``.
    dropped: Mapping[str, int] = field(default_factory=dict)
    #: Citations removed from notes that were kept.
    citations_removed: int = 0


def safe_text(text: str, limit: int) -> str:
    """Repository text for a claim: redacted, invisible and control characters dropped, one line, at most ``limit``."""
    visible = ''.join(ch for ch in unicodedata.normalize('NFKC', text) if unicodedata.category(ch) not in {'Cf', 'Cc'}
                      or ch in ' \t\n')
    flat = ' '.join(redact_text(redact(visible)).text.split())
    return flat if len(flat) <= limit else f'{flat[:limit - 1].rstrip()}…'


def subject_of(value: Any) -> str:
    flat = ' '.join(str(value).casefold().split())[:MAX_SUBJECT] if isinstance(value, str) else ''
    return flat if SUBJECT.fullmatch(flat) and flat == safe_text(flat, MAX_SUBJECT) else ''


def _fields(raw: str) -> dict[str, Any] | None:
    data = schema_line(raw, SCHEMA, MAX_LINE_BYTES)
    if data is None or data.get('kind') not in KINDS:
        return None
    citations = data.get('citations')
    claim = data.get('claim')
    if not isinstance(claim, str) or not isinstance(citations, list) or not safe_text(claim, MAX_CLAIM):
        return None
    return data


def _drop(dropped: dict[str, int], reason: str) -> None:
    dropped[reason] = dropped.get(reason, 0) + 1


def parse_notes(text: str, package: str, rules: CitationRules, packages: Collection[str]) -> NoteBatch:
    """The notes of a shard of ``package``: a note names its package (one of ``packages``), the shard's by default."""
    notes: list[Note] = []
    dropped: dict[str, int] = {}
    removed = 0
    for raw in text.splitlines():
        data = _fields(raw) if raw.strip() else {}
        if not data:
            if data is None:
                _drop(dropped, 'schema')
            continue
        named = data.get('package', package)
        if not isinstance(named, str) or named not in packages:
            _drop(dropped, 'package')
            continue
        kept = tuple(sorted({c for c in data['citations'] if isinstance(c, str) and rules.valid(c)}))[:MAX_CITATIONS]
        if not kept:
            _drop(dropped, 'citation')
        elif len(notes) >= MAX_NOTES:
            _drop(dropped, 'cap')
        else:
            removed += len(data['citations']) - len(kept)
            notes.append(Note(kind=str(data['kind']), package=named, claim=safe_text(data['claim'], MAX_CLAIM),
                              citations=kept, subject=subject_of(data.get('subject'))))
    return NoteBatch(tuple(notes), dropped, removed)
