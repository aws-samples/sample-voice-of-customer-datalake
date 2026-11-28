"""The CHANGELOG's released versions on this line, their sections, and the seed item each one gets.

THE LINE (docs/feature-tests/README.md, "Which releases"): CHANGELOG.md holds this branch's own releases, newest first,
and below them the sections other branches brought in by merges, marked with a suffix after the date
(``(from main)``, ``(voc-wiki)``, ``(voc-autonomous)``, ``(voc-wiki-mut)``). This line's releases are the run of
unsuffixed ``## [MAJOR.MM.PP] - <date>`` headings from the top down to the first suffixed one, ``[Unreleased]``
skipped, from 6.05.00 (the gate's floor) on. A heading below the first suffixed one is another branch's history even
when its suffix was left off (main's ``7.00.01``).

Headings inside a fenced code block are no headings. A version headed twice is a problem (``duplicates``, which
``check`` reports); only its FIRST copy is ever read, for its section and for its kind.

THE KIND is inferred from the release's first paragraph and its ``###`` subsections. Only the explicit phrasings seed a
kind below feature on their own: "no behaviour change" (plumbing) and "Tooling only:" (no-behaviour). Other words
("tests only", "internal only", "nothing changes for anyone", ...) only suggest a lower kind: the seed stays a feature,
marked uncertain with the proposal, and a reviewed decision lets the lower kind stand. A kind is also marked uncertain
when the text does not settle it (a merge, a patch release that fixes nothing). The seed only adds releases the
registry does not hold.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from . import registry

HEADING_RE = re.compile(r'^## \[(?P<version>[^\]]+)\](?: - (?P<date>\S+))?(?P<suffix>.*)$')
# The explicit phrasings, the only ones that seed a kind below feature on their own.
NO_BEHAVIOUR_RE = re.compile(r'(?:^|(?<=[.;:] ))Tooling only:')
PLUMBING_RE = re.compile(r'\bno (production )?behaviour change\b', re.IGNORECASE)
# Words that only suggest a lower kind: the seed stays a feature, the lower kind is proposed for a reviewed decision.
WEAK_RE = re.compile(r'\b(tests? only|tooling only|docs? only|docs and tenets only|nothing to deploy|internal only'
                     r'|nothing changes for anyone|nothing changes yet|plumbing)\b', re.IGNORECASE)
WEAK_PLUMBING = ('internal only', 'nothing changes for anyone', 'nothing changes yet', 'plumbing')
TRUST_FIX_RE = re.compile(r'\btrust fix\b', re.IGNORECASE)
MERGE_RE = re.compile(r'^merge of\b', re.IGNORECASE)
ALIAS_RE = re.compile(r'\b(?:slice|phase) (\d+[a-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)')
LINK_RE = re.compile(r'\[([^\]]*)\]\(([^)]*)\)')
DOC_RE = re.compile(r'(?<![\w/.-])(docs/[\w./-]+?\.md)\b')
BEHAVIOUR_SUBS = {'Added', 'Changed', 'Removed', 'Security'}
TITLE_MAX = 200


@dataclass(frozen=True)
class Release:
    version: str
    date: str
    intro: str               # the first paragraph, joined into one line
    subsections: list[str]   # its ### headings, in order
    line: int                # 1-based line of its heading


FENCE_RE = re.compile(r'^ {0,3}(`{3,}|~{3,})(.*)$')


def _fence(text: str) -> tuple[str, int, str] | None:
    """(the fence's character, its length, what follows it) when the line is a CommonMark fence line."""
    m = FENCE_RE.match(text)
    if not m or (m.group(1)[0] == '`' and '`' in m.group(2)):   # a backtick fence's info string has no backtick
        return None
    return m.group(1)[0], len(m.group(1)), m.group(2)


def _headings(lines: list[str]) -> list[tuple[int, re.Match[str]]]:
    """Every ``## [...]`` heading outside a fenced code block, fences read as CommonMark reads them: an opener has at
    most 3 spaces of indent (4 make an indented code line, never a fence), and only the same character, at the same
    length or more, with nothing after it, closes it."""
    out: list[tuple[int, re.Match[str]]] = []
    opened: tuple[str, int] | None = None
    for i, text in enumerate(lines):
        fence = _fence(text)
        if opened is None and fence is not None:
            opened = (fence[0], fence[1])
        elif opened is not None:
            if fence is not None and fence[0] == opened[0] and fence[1] >= opened[1] and not fence[2].strip():
                opened = None
        elif m := HEADING_RE.match(text):
            out.append((i, m))
    return out


def two_digit(version: str) -> str | None:
    """A package.json version in the CHANGELOG's form: ``7.104.0`` -> ``7.104.00`` (None: not MAJOR.MINOR.PATCH)."""
    m = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)', version)
    return f'{m.group(1)}.{int(m.group(2)):02d}.{int(m.group(3)):02d}' if m else None


@dataclass(frozen=True)
class _Head:
    version: str
    date: str
    start: int
    end: int


def _run(lines: list[str]) -> list[_Head]:
    """The line's own headings, top down to the first suffixed one, [Unreleased] skipped, every copy kept."""
    heads = _headings(lines)
    out = []
    for k, (i, m) in enumerate(heads):
        if m.group('version') == 'Unreleased':
            continue
        if m.group('suffix').strip():
            break
        end = heads[k + 1][0] if k + 1 < len(heads) else len(lines)
        out.append(_Head(m.group('version'), m.group('date') or '', i, end))
    return out


def malformed(changelog: str) -> list[tuple[int, str]]:
    """The line's bracketed headings whose version is not a release number in its canonical two-digit form
    (``## [7.105.00a]``, ``## [7.105.000]``, ``## [07.105.00]``): a problem line, never a crash and never a release."""
    lines = changelog.split('\n')
    return [(head.start + 1, lines[head.start]) for head in _run(lines)
            if not registry.is_release(head.version)]


def duplicates(changelog: str) -> list[str]:
    """The versions the line heads more than once (only the first copy is ever read)."""
    seen: list[str] = []
    out: list[str] = []
    for head in _run(changelog.split('\n')):
        if head.version in seen and head.version not in out:
            out.append(head.version)
        seen.append(head.version)
    return out


def heading_count(changelog: str, version: str) -> int:
    return sum(1 for head in _run(changelog.split('\n')) if head.version == version)


def _intro(body: list[str]) -> str:
    para: list[str] = []
    for text in body:
        if text.startswith('#'):
            break
        if text.strip():
            para.append(text.strip())
        elif para:
            break
    return ' '.join(para)


def line_releases(changelog: str) -> list[Release]:
    """This line's releases from the floor on, newest first, each version's FIRST copy only (a second heading of a
    version is a problem ``check`` reports, never a second source of its kind; see the module docstring)."""
    lines = changelog.split('\n')
    out: list[Release] = []
    seen: set[str] = set()
    for head in _run(lines):
        if head.version in seen or not registry.is_release(head.version):
            continue
        seen.add(head.version)
        if registry.parse_version(head.version) < registry.parse_version(registry.FLOOR):
            continue
        body = lines[head.start + 1:head.end]
        subs = [text[4:].strip() for text in body if text.startswith('### ')]
        out.append(Release(head.version, head.date, _intro(body), subs, head.start + 1))
    return out


def section(changelog: str, version: str) -> str:
    """The release's whole section (its heading to the next release heading), this line's first copy only."""
    lines = changelog.split('\n')
    for head in _run(lines):
        if head.version == version:
            return '\n'.join(lines[head.start:head.end]).rstrip() + '\n'
    raise KeyError(version)


def _is_patch(version: str) -> bool:
    return registry.parse_version(version)[2] != 0


def classify(release: Release) -> tuple[str, str | None]:
    """(kind, why it is uncertain or None)."""
    intro = release.intro
    subs = set(release.subsections)
    if NO_BEHAVIOUR_RE.search(intro):
        return 'no-behaviour', None
    if PLUMBING_RE.search(intro):
        return 'plumbing', None
    if m := WEAK_RE.search(intro):
        words = m.group(0).lower()
        proposed = 'plumbing' if words in WEAK_PLUMBING else 'no-behaviour'
        return 'feature', f'the words "{words}" suggest {proposed}: a reviewed decision lets it stand'
    if TRUST_FIX_RE.search(intro):
        return 'fix', None
    if MERGE_RE.search(intro):
        return 'feature', 'a merge of another branch: it may hold several features, fixes or none'
    if 'Fixed' in subs and (_is_patch(release.version) or not subs & BEHAVIOUR_SUBS):
        return 'fix', None
    if _is_patch(release.version):
        return 'feature', 'a patch release that names no fix'
    return 'feature', None


def aliases(release: Release) -> list[str]:
    out = [registry.semver(release.version)]
    for m in ALIAS_RE.finditer(release.intro):
        if m.group(1) not in out:
            out.append(m.group(1))
    return out


def title(release: Release) -> str:
    text = LINK_RE.sub(lambda m: m.group(1), release.intro).replace('**', '').replace('`', '')
    end = re.search(r'[.!?](\s|$)', text)
    sentence = text[:end.start() + 1] if end else text
    return sentence if len(sentence) <= TITLE_MAX else sentence[:TITLE_MAX - 1].rstrip() + '…'


def doc_link(release: Release) -> str | None:
    m = DOC_RE.search(release.intro)
    return m.group(1) if m else None


def seed_item(release: Release) -> dict[str, Any]:
    kind, why = classify(release)
    item: dict[str, Any] = {
        'id': release.version, 'aliases': aliases(release), 'title': title(release),
        'source': {'changelog': release.version, 'doc': doc_link(release)}, 'kind': kind, 'status': 'done',
        'unit': [], 'e2e': [], 'exemption': None,
    }
    if why:
        item['uncertain'] = why
    return item


def covered(reg: registry.Registry, version: str) -> bool:
    """A release is covered by an item named for it, or by its ``<version>/<slice>`` items."""
    return version in reg.by_id or any(item_id.startswith(version + '/') for item_id in reg.by_id)


def seed(reg: registry.Registry, releases: list[Release]) -> list[dict[str, Any]]:
    """Adds an item for every release the registry does not cover; an alias another item holds is dropped."""
    taken = {a for it in reg.items for a in [str(it.get('id')), *it.get('aliases', [])]}
    added = []
    for release in releases:
        if covered(reg, release.version):
            continue
        item = seed_item(release)
        item['aliases'] = [a for a in item['aliases'] if a not in taken]
        taken.update([item['id'], *item['aliases']])
        reg.items.append(item)
        reg.by_id[item['id']] = item
        reg.slice_of[item['id']] = registry.slice_for(release.version)
        added.append(item)
    return added
