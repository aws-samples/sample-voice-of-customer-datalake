"""The reduce step: a package's notes become its seven documents; the root package's are the repository's overview.

- **Merge.** Within one document, notes making the same claim (``Note.key``: case, spacing and the final full stop
  aside) become one claim with the union of their citations (at most ``MAX_CITATIONS``, in order).
- **Human edits win.** The claims a person wrote (``Note.author``) are carried from the version the refresh starts
  from. A refreshed claim saying what an edit says adds its citations to the edit; a refreshed claim on the same
  ``subject`` that says something else **contradicts** the edit: it is flagged (``Pack.flagged``, shown for review
  in the version's ``pack.json`` and its documents), never applied. A claim without a subject contradicts nothing.
- **Deterministic.** Claims are ordered by subject (those without one last), then by their key; footnotes are
  numbered by first use within a document. The same notes always render the same bytes, so a refresh whose notes did
  not change renders documents equal to the last version's.

The overview is the root package's pack (``.``: the files no package holds, CI and repository-wide notes) with
the table of every package, its kinds and its owners at the top of its architecture document.
"""
from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any

from engineering.knowledge.notes import (
    KINDS,
    MAX_CITATIONS,
    MAX_CLAIM,
    CitationRules,
    Note,
    safe_text,
    subject_of,
)
from engineering.knowledge.workspaces import KINDS as PACKAGE_KINDS
from engineering.knowledge.workspaces import ROOT, Package

PACK_SCHEMA = 'voc-kpack/1'
TITLES = {'architecture': 'Architecture', 'convention': 'Conventions', 'review-guide': 'Review guide',
          'test-strategy': 'Test strategy', 'ci': 'CI and gates', 'glossary': 'Glossary', 'how-we-work': 'How we work'}
_ESCAPED = frozenset('\\`*_[]<>!|#~&')


@dataclass(frozen=True)
class Flagged:
    """A refreshed claim that contradicts a person's edit: kept for review, not applied."""

    claim: Note
    edit: Note


@dataclass(frozen=True)
class Edit:
    """A person's claim; ``replaces``: the id of the claim it takes the place of (``''``: an added claim)."""

    note: Note
    replaces: str = ''


@dataclass(frozen=True)
class Pack:
    package: str
    #: Each of ``KINDS`` -> its claims, in order.
    documents: Mapping[str, tuple[Note, ...]]
    flagged: tuple[Flagged, ...] = ()
    #: The packages the overview lists (the root package's pack only).
    packages: tuple[Package, ...] = field(default=())

    def human_claims(self) -> list[Note]:
        return [note for kind in KINDS for note in self.documents.get(kind, ()) if note.author]


def _order(note: Note) -> tuple[bool, str, str]:
    return not note.subject, note.subject, note.key


def _with_citations(note: Note, citations: Iterable[str]) -> Note:
    return replace(note, citations=tuple(sorted({*note.citations, *citations}))[:MAX_CITATIONS])


def _merged(notes: Iterable[Note]) -> list[Note]:
    by_key: dict[str, Note] = {}
    for note in notes:
        known = by_key.get(note.key)
        by_key[note.key] = note if known is None else _with_citations(known, note.citations)
    return sorted(by_key.values(), key=_order)


def _document(mapped: Iterable[Note], edits: Iterable[Note]) -> tuple[list[Note], list[Flagged]]:
    claims = {note.key: note for note in edits}
    edited_subjects = {note.subject: note.key for note in claims.values() if note.subject}
    contradicting: list[Note] = []
    for note in _merged(mapped):
        if note.key in claims:
            claims[note.key] = _with_citations(claims[note.key], note.citations)
        elif note.subject in edited_subjects:
            contradicting.append(note)
        else:
            claims[note.key] = note
    flagged = [Flagged(note, claims[edited_subjects[note.subject]]) for note in contradicting]
    return sorted(claims.values(), key=_order), flagged


def reduce_package(package: str, notes: Iterable[Note], previous: Pack | None = None,
                   packages: Sequence[Package] = ()) -> Pack:
    """``package``'s pack from its notes (others are ignored), keeping the human edits of ``previous``."""
    own = [note for note in notes if note.package == package and note.kind in KINDS]
    edits = previous.human_claims() if previous is not None else []
    documents: dict[str, tuple[Note, ...]] = {}
    flagged: list[Flagged] = []
    for kind in KINDS:
        claims, contradicted = _document((n for n in own if n.kind == kind), (e for e in edits if e.kind == kind))
        documents[kind] = tuple(claims)
        flagged.extend(contradicted)
    return Pack(package, documents, tuple(flagged), tuple(packages) if package == ROOT else ())


def _checked(edit: Edit, package: str, rules: CitationRules) -> Edit:
    """A person's claim held to the bar of a mapped one: one safe line (redacted, bounded), a subject of its shape,
    and only citations ``rules`` accepts (a person may cite nothing; an unchecked one refuses the edit)."""
    note = edit.note
    if not note.author or note.kind not in KINDS or note.package != package:
        raise ValueError('an edit is a person\'s claim for one of the pack\'s documents')
    claim = safe_text(note.claim, MAX_CLAIM)
    if not claim:
        raise ValueError('an edited claim has text')
    refused = [c for c in note.citations if not rules.valid(c)]
    if refused or len(set(note.citations)) > MAX_CITATIONS:
        raise ValueError(f'an edited claim cites at most {MAX_CITATIONS} of the repository\'s paths, commits or review '
                         f'comments; not one of them: {safe_text(refused[0], 80) if refused else "too many"}')
    return Edit(replace(note, claim=claim, subject=subject_of(note.subject), citations=tuple(sorted(set(note.citations)))),
                edit.replaces)


def apply_edits(pack: Pack, edits: Sequence[Edit], *, rules: CitationRules) -> Pack:
    """``pack`` with each person's claim added, or in place of the claim it replaces (a later edit of the same
    claim wins); each claim is checked first (``_checked``). A flagged claim that an edit now agrees with, or
    replaces, is no longer flagged."""
    checked = [_checked(edit, pack.package, rules) for edit in edits]
    documents = {kind: list(pack.documents.get(kind, ())) for kind in KINDS}
    for edit in checked:
        note = edit.note
        for kind in KINDS:
            documents[kind] = [c for c in documents[kind] if c.id != edit.replaces
                               and not (kind == note.kind and c.key == note.key)]
        documents[note.kind].append(note)
    agreed = {(e.note.kind, e.note.key) for e in checked}
    replaced = {e.replaces for e in checked}
    flagged = tuple(f for f in pack.flagged if (f.claim.kind, f.claim.key) not in agreed and f.edit.id not in replaced)
    return Pack(pack.package, {kind: tuple(sorted(claims, key=_order)) for kind, claims in documents.items()},
                flagged, pack.packages)


def _escape(text: str) -> str:
    """Repository text as literal Markdown: no link, image, HTML, heading or table cell can come from it."""
    return ''.join(f'\\{ch}' if ch in _ESCAPED else ch for ch in text)


def _footnote(citation: str) -> str:
    if citation.startswith('https://'):
        return f'<{citation}>'
    if ':' in citation:
        return f'`{citation}`'
    return f'commit `{citation}`'


def _claims(claims: Sequence[Note], numbers: dict[str, int]) -> list[str]:
    lines = []
    for note in claims:
        marks = ''.join(f'[^{numbers.setdefault(c, len(numbers) + 1)}]' for c in note.citations)
        about = f'**{_escape(note.subject)}**: ' if note.subject else ''
        lines.append(f'- {about}{_escape(note.claim)}{marks}{" (edited by a person)" if note.author else ""}')
    return lines


def _package_table(packages: Sequence[Package]) -> list[str]:
    rows = ['| Package | Name | Kinds | Owners |', '|---|---|---|---|']
    rows += [f'| `{p.path}` | {_escape(p.name)} | {", ".join(p.kinds) or "none"} | '
             f'{_escape(" ".join(p.owners)) or "none"} |' for p in packages]
    return [*rows, '']


def render(pack: Pack, kind: str) -> str:
    """One document of the pack as Markdown, its citations as footnotes."""
    name = 'the repository' if pack.package == ROOT else f'`{pack.package}`'
    lines = [f'# {TITLES[kind]}: {name}', '']
    if kind == 'architecture' and pack.packages:
        lines += ['## Packages', '', *_package_table(pack.packages)]
    numbers: dict[str, int] = {}
    claims = pack.documents.get(kind, ())
    lines += _claims(claims, numbers) if claims else ['Nothing is known about this yet.']
    contradicted = [f for f in pack.flagged if f.claim.kind == kind]
    if contradicted:
        lines += ['', '## Flagged for review: contradicts an edit, not applied', '']
        lines += _claims([f.claim for f in contradicted], numbers)
    if numbers:
        lines += ['', *(f'[^{n}]: {_footnote(c)}' for c, n in numbers.items())]
    return '\n'.join(lines) + '\n'


def _note_json(note: Note) -> dict[str, Any]:
    return {'claim': note.claim, 'citations': list(note.citations), 'subject': note.subject, 'author': note.author}


def to_json(pack: Pack) -> dict[str, Any]:
    return {'schema': PACK_SCHEMA, 'package': pack.package,
            'documents': {kind: [_note_json(n) for n in pack.documents.get(kind, ())] for kind in KINDS},
            'flagged': [{'kind': f.claim.kind, 'claim': _note_json(f.claim), 'edit': f.edit.id} for f in pack.flagged],
            # The overview's table of packages, so an edit of the overview (a pack read back from here) keeps it.
            'packages': [{'path': p.path, 'name': p.name, 'kinds': list(p.kinds), 'workspace': p.workspace,
                          'owners': list(p.owners)} for p in pack.packages]}


def _strings(value: Any, allowed: Collection[str] | None = None) -> tuple[str, ...] | None:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        return None
    return tuple(value) if allowed is None or set(value) <= set(allowed) else None


def _package(raw: Any) -> Package | None:
    if not isinstance(raw, dict):
        return None
    path, name, workspace = raw.get('path'), raw.get('name'), raw.get('workspace', '')
    kinds, owners = _strings(raw.get('kinds'), PACKAGE_KINDS), _strings(raw.get('owners'))
    if not (isinstance(path, str) and isinstance(name, str) and isinstance(workspace, str)) or kinds is None \
            or owners is None:
        return None
    return Package(path, name, kinds, workspace, owners)


def _note(package: str, kind: str, raw: Any) -> Note | None:
    if not isinstance(raw, dict):
        return None
    claim, citations, author = raw.get('claim'), raw.get('citations'), raw.get('author', '')
    if not isinstance(claim, str) or not isinstance(citations, list) or not isinstance(author, str):
        return None
    return Note(kind, package, safe_text(claim, MAX_CLAIM), tuple(str(c) for c in citations)[:MAX_CITATIONS],
                subject_of(raw.get('subject')), author[:200])


def from_json(data: Mapping[str, Any]) -> Pack:
    """A stored ``pack.json`` back as a pack, with the flags whose edit it still holds and the overview's table of
    packages."""
    package = data.get('package')
    documents = data.get('documents')
    if data.get('schema') != PACK_SCHEMA or not isinstance(package, str) or not isinstance(documents, dict):
        raise ValueError(f'not a {PACK_SCHEMA} document')
    parsed: dict[str, tuple[Note, ...]] = {}
    for kind in KINDS:
        raws = documents.get(kind)
        notes = (_note(package, kind, raw) for raw in (raws if isinstance(raws, list) else []))
        parsed[kind] = tuple(sorted((n for n in notes if n is not None), key=_order))
    edits = {note.id: note for kind in KINDS for note in parsed[kind] if note.author}
    flagged: list[Flagged] = []
    raws = data.get('flagged')
    for raw in raws if isinstance(raws, list) else []:
        if not isinstance(raw, dict) or raw.get('kind') not in KINDS:
            continue
        claim, edit = _note(package, str(raw['kind']), raw.get('claim')), edits.get(str(raw.get('edit')))
        if claim is not None and edit is not None:
            flagged.append(Flagged(claim, edit))
    listed = data.get('packages')
    packages = [p for p in (_package(raw) for raw in (listed if isinstance(listed, list) else [])) if p is not None]
    return Pack(package, parsed, tuple(flagged), tuple(packages) if package == ROOT else ())
