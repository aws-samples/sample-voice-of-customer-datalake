#!/usr/bin/env python3
# audit-detector: run by scripts/audit/run-all.sh
"""doc_contract: what the repo docs claim about the code that the code no longer backs.

PATTERN (5.34: the steering listed ``GET /logs``, a ``POST .../test`` route gone since #115, "15 handlers" next to
20, a ``lib/model-override.ts`` that had moved; ``docs/code-audit.md`` cited three audit files that were never in
the repo). Docs are read by people and by agents, and nothing checks them against the tree.

SCOPE. ``docs/*.md`` (``docs/history/`` excluded: a record, not a description), ``README.md``, ``CONTRIBUTING.md``
and ``.kiro/steering/*.md``; fenced code blocks are skipped.

KINDS (key ``<doc>::<kind>::<target>``):

- ``broken-link``: a relative markdown link whose file does not exist, or whose ``#anchor`` matches no heading (GitHub
  slug, ``-1`` for repeats) and no ``<a id|name>`` of the target.
- ``missing-path``: a backticked repo path (a ``/`` and a file extension, or a trailing ``/``) that no file or
  directory of the repo ends with (docs write paths relative to the root, to ``voc-datalake/`` or to a package's
  ``src/``, so a path is judged by its tail; ``lambda/stream/src/lib/x.ts`` still fails when the file moved to
  ``src/bedrock/``). Not judged: placeholders and globs (``{x}``, ``<x>``, ``*``), one-word prefixes (``raw/``, an S3
  prefix as often as a directory), build outputs (``dist/``, ``cdk.out``, ``.venv``, ``coverage_html``,
  ``node_modules``), URLs, and a line that says the path is gone (deleted, removed, retired, ...).
- ``route-not-served``: a table row ``| VERB | `/path` |`` (verbs ``GET/PUT`` and paths ``a`, `b`` split) that no
  Powertools route and no explicit API Gateway method serves (``route_targets.py``, shared with ``py_route_callers``).
  A doc path under a ``{proxy+}`` row (``ANY /memory/{proxy+}``) is a prefix and matches any route below it.
- ``handler-list``: a doc naming at least 5 ``*_handler.py`` files of ``lambda/api/`` names one that does not exist
  (key target ``extra:<name>``), or, when it presents itself as the full list (it names at least 3/4 of them), omits
  one (``missing:<name>``).
- ``uncited-file``: a ``*.md`` file name the doc cites that is in no directory of the repo (``deadpy.md``).

The root ``.gitignore``'s anchored entries (``/docs/history/``, ``/docs/pending*.md``: local notes) are neither scanned
nor counted as existing, so every checkout judges alike.

FALSE POSITIVES: a path that exists only after a build or in another repo, a route an operator must type by hand.
Silence with ``{"key": "<doc>::<kind>::<target>", "reason": ...}`` in ``scripts/audit/allowlists/doc_contract.json``.

Run: ``voc-datalake/.venv/bin/python scripts/audit/doc_contract.py [--json]`` (no synth needed).
"""
from __future__ import annotations

import posixpath
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from audit_common import Finding, glob_regex, guard, parse_repo_cli, report, run_main
from route_targets import Request, Served, gateway_methods, python_routes, segments, serves

TOOL = 'doc_contract'
FENCE = re.compile(r'^\s*(```|~~~)')
LINK = re.compile(r'\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)')
TICKED = re.compile(r'`([^`\s]+)`')
EXTENSION = re.compile(r'\.(?:md|py|ts|tsx|mjs|cjs|js|json|sh|ya?ml|toml|txt|html|css|drawio|png|jpg|csv|cfg|ini)$')
GONE = re.compile(r'\b(?:deleted|removed|retired|gone|no longer|was|were|used to|old|former|renamed|moved|replaced|instead of)\b',
                  re.IGNORECASE)
#: Not part of the tree a doc describes (dependency and cache dirs; `layers/` IS: it holds requirement files).
TREE_SKIP = frozenset({'node_modules', '.venv', 'cdk.out', '__pycache__', '.git', '.cache', '.stryker-tmp', '.mutmut-cache',
                       '.ruff_cache', 'coverage_html'})
NOT_JUDGED_PARTS = frozenset({'dist', 'cdk.out', '.venv', 'coverage_html', 'node_modules', 'build', 'coverage', '.cache'})
ROW = re.compile(r'^\|\s*([A-Z][A-Z/ ,]*?)\s*\|\s*([^|]+)\|')
ROW_VERBS = frozenset({'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ANY'})
HANDLER = re.compile(r'(?<![\w/])([a-z0-9_]+_handler\.py)\b')
MD_NAME = re.compile(r'(?<![\w/.-])([\w.-]+\.md)\b')


@dataclass(frozen=True)
class Line:
    doc: str
    number: int
    text: str


def docs_in(root: Path) -> list[str]:
    found = [p.relative_to(root).as_posix() for p in sorted((root / 'docs').glob('*.md'))]
    found += [p.relative_to(root).as_posix() for p in sorted((root / '.kiro' / 'steering').glob('*.md'))]
    ignored = ignored_by_root(root)
    return [d for d in found if not ignored(d)] + [n for n in ('README.md', 'CONTRIBUTING.md') if (root / n).is_file()]


def prose_lines(root: Path, doc: str) -> Iterator[Line]:
    in_fence = False
    for number, text in enumerate((root / doc).read_text(encoding='utf-8', errors='ignore').splitlines(), 1):
        if FENCE.match(text):
            in_fence = not in_fence
        elif not in_fence:
            yield Line(doc, number, text)


# ---- the tree ----------------------------------------------------------------------------------------------------

@dataclass
class Tree:
    root: Path
    files: set[str]      # every repo-relative file and directory
    tails: set[str]      # every trailing run of segments of those (`hooks/useCopyToClipboard.ts`)
    names: set[str]

    @classmethod
    def of(cls, root: Path) -> Tree:
        ignored = ignored_by_root(root)
        files = {rel.as_posix() for rel in (p.relative_to(root) for p in root.rglob('*'))
                 if not TREE_SKIP.intersection(rel.parts) and not ignored(rel.as_posix())}
        tails = {'/'.join(f.split('/')[i:]) for f in files for i in range(f.count('/') + 1)}
        return cls(root, files, tails, {f.rsplit('/', 1)[-1] for f in files})

    def exists(self, rel: str) -> bool:
        return rel.rstrip('/') in self.files

    def has_tail(self, partial: str) -> bool:
        """A path written relative to some directory (`components/ui.tsx`): some file or directory ends with it."""
        return partial.rstrip('/') in self.tails


def ignored_by_root(root: Path) -> Callable[[str], bool]:
    """The root ``.gitignore``'s anchored entries (``/docs/history/``, ``/docs/pending*.md``): notes one checkout has and
    another lacks, so they are neither scanned nor counted as existing (every checkout then judges alike)."""
    file = root / '.gitignore'
    lines = file.read_text(encoding='utf-8').splitlines() if file.is_file() else []
    anchored = [line.strip()[1:] for line in lines if line.strip().startswith('/') and not line.startswith('#')]
    dirs = tuple(p for p in anchored if p.endswith('/'))
    globs = [p for p in anchored if not p.endswith('/')]
    return lambda rel: rel.startswith(dirs) or f'{rel}/'.startswith(dirs) or any(glob_regex(g).match(rel) for g in globs)


def slug(heading: str) -> str:
    text = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', heading.strip())
    text = re.sub(r'[`*]', '', text).lower()
    text = re.sub(r'[^\w\- ]', '', text)
    return text.replace(' ', '-')


@lru_cache(maxsize=256)
def anchors_of(file: Path) -> frozenset[str]:
    seen: dict[str, int] = {}
    out: set[str] = set()
    in_fence = False
    for text in file.read_text(encoding='utf-8', errors='ignore').splitlines():
        if FENCE.match(text):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        heading = re.match(r'^#{1,6}\s+(.*?)\s*#*\s*$', text)
        if heading:
            base = slug(heading.group(1))
            count = seen.get(base, 0)
            seen[base] = count + 1
            out.add(base if count == 0 else f'{base}-{count}')
        out.update(re.findall(r'<a\s+(?:name|id)="([^"]+)"', text))
    return frozenset(out)


# ---- the checks --------------------------------------------------------------------------------------------------

def link_findings(tree: Tree, line: Line) -> Iterator[Finding]:
    for target in LINK.findall(line.text):
        if re.match(r'^(?:[a-z]+:|//)', target):
            continue
        path, _, anchor = target.partition('#')
        normalized = posixpath.normpath(posixpath.join(posixpath.dirname(line.doc), path)) if path else line.doc
        if path and not tree.exists(normalized):
            yield Finding('broken-link', f'{line.doc}::broken-link::{target}', f'{line.doc}:{line.number}: no file {normalized}')
        elif anchor and normalized.endswith('.md') and anchor not in anchors_of(tree.root / normalized):
            yield Finding('broken-link', f'{line.doc}::broken-link::{target}', f'{line.doc}:{line.number}: no heading #{anchor}')


def _looks_like_path(token: str) -> bool:
    if '/' not in token or token.startswith(('/', 'http', 's3:', '~', '$', '-', '@', '.github/', 'arn:')) or '://' in token:
        return False
    if re.search(r'[{}<>*()\[\]=:,;|]', token):
        return False
    first = token.split('/', maxsplit=1)[0]
    if '.' in first.strip('.') and not EXTENSION.search(first):
        return False   # a host name (`example-air.example/rss/changelog.json`), not a repo path
    return bool(EXTENSION.search(token) or token.endswith('/'))


def path_findings(tree: Tree, line: Line) -> Iterator[Finding]:
    if GONE.search(line.text):
        return
    for ticked in TICKED.findall(line.text):
        token = ticked.rstrip('.,').removeprefix('./').removeprefix('…/').removeprefix('.../')
        if not _looks_like_path(token) or NOT_JUDGED_PARTS.intersection(token.split('/')):
            continue
        if token.endswith('/') and token.count('/') == 1:
            continue   # a one-word prefix (`raw/`, `inbound/`): an S3 or archive prefix as often as a directory
        if not tree.has_tail(token):
            yield Finding('missing-path', f'{line.doc}::missing-path::{token}', f'{line.doc}:{line.number}: no file or directory ends with it')


def _row_paths(cell: str) -> list[str]:
    return [p.strip() for p in re.findall(r'`([^`]+)`', cell) if p.strip().startswith('/')]


def route_findings(served: list[Served], line: Line) -> Iterator[Finding]:
    row = ROW.match(line.text)
    if not row:
        return
    verbs = [v for v in re.split(r'[ /,]+', row.group(1)) if v]
    if not verbs or any(v not in ROW_VERBS for v in verbs):
        return
    paths = [p.split('[')[0] for raw in _row_paths(row.group(2)) for p in re.split(r'\\\|', raw)]
    for index, written in enumerate(paths):
        path = written if written.startswith('/') else '/' + written
        # A later path in the cell may continue the first one (`/participants/projects/{id}/lists/{x}`, `/people/{y}`).
        first = segments(paths[0])
        tried = [path] + ([f'/{"/".join(first[:cut])}{path}' for cut in range(1, len(first))] if index else [])
        if any(_row_served(served, verbs, candidate) for candidate in tried):
            continue
        key = f'{"/".join(verbs)} {path}'
        yield Finding('route-not-served', f'{line.doc}::route-not-served::{key}', f'{line.doc}:{line.number}: no route serves it')


def _row_served(served: list[Served], verbs: list[str], path: str) -> bool:
    segs = segments(path)
    if path.rstrip('/').endswith('{proxy+}'):
        prefix = segs[:-1]
        return any(target.segments[:len(prefix)] == prefix and len(target.segments) > len(prefix) for target in served)
    asked = [v for v in verbs if v != 'ANY'] or ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
    need_all = 'ANY' not in verbs
    hits = [any(serves(target, Request(verb, path, segs, '')) and len(target.segments) == len(segs) for target in served)
            for verb in asked]
    return all(hits) if need_all else any(hits)


def handler_findings(handlers: set[str], doc: str, text: str) -> Iterator[Finding]:
    named = set(HANDLER.findall(text))
    if len(named) < 5:
        return
    for name in sorted(named - handlers):
        yield Finding('handler-list', f'{doc}::handler-list::extra:{name}', f'{doc}: names {name}, which lambda/api/ has not')
    if len(named & handlers) * 4 >= len(handlers) * 3:
        for name in sorted(handlers - named):
            yield Finding('handler-list', f'{doc}::handler-list::missing:{name}',
                          f'{doc}: lists {len(named & handlers)} of the {len(handlers)} handlers, not {name}')


def citation_findings(tree: Tree, line: Line) -> Iterator[Finding]:
    for name in MD_NAME.findall(LINK.sub('', line.text)):   # a link target is judged as a link
        if name not in tree.names:
            yield Finding('uncited-file', f'{line.doc}::uncited-file::{name}', f'{line.doc}:{line.number}: no {name} in the repo')


def scan(root: Path) -> tuple[list[Finding], dict[str, int]]:
    tree = Tree.of(root)
    cdk = root / 'voc-datalake'
    served = python_routes(cdk) + gateway_methods(cdk)
    handlers = {p.name for p in (cdk / 'lambda' / 'api').glob('*_handler.py')}
    found: list[Finding] = []
    counts = {'docs': 0, 'links': 0, 'rows': 0}
    for doc in docs_in(root):
        counts['docs'] += 1
        prose: list[str] = []
        for line in prose_lines(root, doc):
            prose.append(line.text)
            counts['links'] += len(LINK.findall(line.text))
            counts['rows'] += bool(ROW.match(line.text))
            found += [*link_findings(tree, line), *path_findings(tree, line), *route_findings(served, line),
                      *citation_findings(tree, line)]
        found += handler_findings(handlers, doc, '\n'.join(prose))
    unique = {f.key: f for f in found}
    return list(unique.values()), counts


def main(argv: list[str] | None = None) -> int:
    args = parse_repo_cli(__doc__, argv)
    found, counts = scan(args.root)
    guard(counts['docs'] >= 40 and counts['links'] >= 100, f'only {counts["docs"]} docs / {counts["links"]} links')
    return report(TOOL, found, as_json=args.json, use_allowlist=not args.no_allowlist,
                  summary=f'{counts["docs"]} docs, {counts["links"]} links, {counts["rows"]} table rows')


if __name__ == '__main__':
    run_main(main)
