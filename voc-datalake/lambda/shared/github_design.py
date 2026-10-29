"""Which files of a GitHub repository describe its design (pure: works on the tree listing).

``shared.design_references`` makes ONE ``git/trees/{ref}?recursive=1`` call and hands the
blob paths here. ``rank_design_files`` picks the files worth reading — design tokens, theme
and palette CSS (Tailwind v4 ``@theme`` files), font faces, Tailwind configs, entry CSS with
``:root``, design docs and steering — across the WHOLE tree, so a monorepo whose design lives
in ``website/src/styles/`` is read as well as a design-system repo. The README is read only
when nothing better exists. ``component_names`` lists ``components/ui/**`` (names only),
``component_files`` the UI sources worth reading for their styles (button, input, card, badge,
tabs, dialog, select … under ``components/ui/``, or a ``components/ui.tsx`` of primitives) and
``logo_path`` the best raster ``*logo*`` image. ``svg_logo_path`` names an SVG logo (``*logo*.svg``, or
the one SVG in a ``public/`` directory, the usual favicon/brand mark) only so the reference can SAY it
was not read: an SVG is never downloaded (docs/company-context.md → "Logo candidates").
"""
from __future__ import annotations

import re
from pathlib import PurePosixPath

MAX_DESIGN_FILES = 12
MAX_COMPONENT_NAMES = 40
#: UI source files read for their component styles, beside the design files (one request each).
MAX_COMPONENT_FILES = 8
#: Read in this order (a ``ui`` file of primitives first: it holds several components at once).
COMPONENT_FILE_PRIORITY = ('ui', 'button', 'input', 'card', 'badge', 'tabs', 'dialog', 'select', 'textarea',
                           'table', 'checkbox', 'switch', 'navbar', 'nav')
_COMPONENT_FILE_RE = re.compile(r'(^|/)components/(ui/([^/]+?)(/index)?|(ui))\.(tsx|jsx|vue|svelte|ts|js)\Z',
                                re.IGNORECASE)
_SKIPPED_DIRS = frozenset({
    'node_modules', 'dist', 'build', 'out', 'vendor', '.git', 'coverage', '__pycache__', '.next',
    'test', 'tests', '__tests__', 'fixtures', '.venv', 'site-packages',
})
_STYLE_EXT = r'\.(css|scss|sass|less|pcss)\Z'
# (rank, pattern on the lower-cased path) after the token files (rank 0). Lower rank = read first.
_RANKS: tuple[tuple[int, re.Pattern[str]], ...] = (
    (1, re.compile(r'(^|/)(tailwind[-_.]theme|theme[-_.]?palettes?|palettes?|themes?)[^/]*' + _STYLE_EXT)),
    (2, re.compile(r'(^|/)(font[-_.]?faces?|fonts|typography)[^/]*' + _STYLE_EXT)),
    (3, re.compile(r'(^|/)tailwind\.config\.(js|cjs|mjs|ts)\Z')),
    (4, re.compile(r'(^|/)(index|globals?|app|main|base|variables|colou?rs)' + _STYLE_EXT)),
    # Visual-design docs: docs/**/theme*|design*, steering about design, *design-system*, a ROOT design.md.
    # Not a spec's design.md (.kiro/specs/<feature>/design.md describes software, not the look).
    (5, re.compile(r'^(docs?/(.+/)?(theme|design)[^/]*|\.kiro/steering/[^/]*design[^/]*|([^/]+/)*design[-_]?system[^/]*'
                   r'|design)\.md\Z')),
    (6, re.compile(r'(^|/)(styles?|css|theme)/[^/]+' + _STYLE_EXT)),
)
_README_RE = re.compile(r'^readme(\.md|\.markdown|\.txt)?\Z')
# Design-token files by name: a plural `tokens` word in a style / data file (tokens.json, design-tokens.css,
# tokens.base.json), or a `design-` / `brand-` / `theme-` / `color-` token file in any of those or JS/TS.
# A repository's auth and model code is full of `token` files (token-acquire.js, model_tokens.json,
# access-token.ts): names carrying one of _NOT_DESIGN_WORDS are never design tokens.
_TOKEN_FILE_RES = (
    re.compile(r'(^|[-_.])tokens([-_.][^/]*)?\.(json|ya?ml|css|scss)\Z'),
    re.compile(r'(^|[-_.])(design|brand|theme|colou?r)[-_.]?tokens?([-_.][^/]*)?\.(json|ya?ml|css|scss|js|ts)\Z'),
)
_NOT_DESIGN_WORDS = ('auth', 'access', 'refresh', 'session', 'jwt', 'csrf', 'oauth', 'api', 'model', 'llm',
                     'acquire', 'retry', 'reset', 'secret', 'count', 'usage', 'limit')
_TOKEN_RANK = 0
_COMPONENT_RE = re.compile(r'(^|/)components/ui/([^/]+?)(/index)?\.(tsx|jsx|vue|svelte|ts|js)\Z', re.IGNORECASE)
_COMPONENT_SKIP_RE = re.compile(r'(\.(test|spec|stories|story)\Z|^index\Z|^use[A-Z-])')
_LOGO_RE = re.compile(r'(^|/)[^/]*logo[^/]*\.(png|webp|jpe?g)\Z', re.IGNORECASE)
_LOGO_DIR_BONUS = ('public/', 'static/', 'assets/', 'images/', 'img/', 'brand')
LOGO_CONTENT_TYPES = {'png': 'image/png', 'webp': 'image/webp', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg'}


def _skipped(path: str) -> bool:
    parts = path.lower().split('/')
    return any(part in _SKIPPED_DIRS for part in parts[:-1]) or parts[-1].endswith(('.min.css', '.map'))


def _rank(path: str) -> int | None:
    lower = path.lower()
    name = lower.rsplit('/', 1)[-1]
    if any(r.search(name) for r in _TOKEN_FILE_RES) and not any(word in name for word in _NOT_DESIGN_WORDS):
        return _TOKEN_RANK
    for rank, pattern in _RANKS:
        if pattern.search(lower):
            return rank
    return None


def _under(path: str, base: str) -> bool:
    return not base or path == base or path.startswith(base.rstrip('/') + '/')


def rank_design_files(paths: list[str], base: str = '') -> list[str]:
    """The design files to read, best first (rank, then shallower, then by path); README only as a last resort."""
    candidates = [p for p in paths if _under(p, base) and not _skipped(p)]
    ranked = sorted(
        (rank, p.count('/'), p) for p in candidates if (rank := _rank(p)) is not None
    )
    chosen = [p for _, _, p in ranked[:MAX_DESIGN_FILES]]
    if chosen:
        return chosen
    readmes = sorted((p.count('/'), p) for p in candidates if _README_RE.match(p.lower().rsplit('/', 1)[-1]))
    return [p for _, p in readmes[:1]]


def _component_label(stem: str) -> str:
    words = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', stem).replace('-', ' ').replace('_', ' ').split()
    text = ' '.join(words).lower()
    return text[:1].upper() + text[1:]


def component_names(paths: list[str], base: str = '') -> list[str]:
    """Readable names of the ``components/ui`` components ("Button", "Dropdown menu"), unique, capped."""
    names: list[str] = []
    for path in sorted(paths):
        match = _COMPONENT_RE.search(path)
        if not match or not _under(path, base) or _skipped(path):
            continue
        stem = match.group(2)
        if _COMPONENT_SKIP_RE.search(stem):
            continue
        label = _component_label(stem)
        if label and label not in names:
            names.append(label)
        if len(names) == MAX_COMPONENT_NAMES:
            break
    return names


def _component_file_rank(path: str) -> int | None:
    match = _COMPONENT_FILE_RE.search(path)
    if not match:
        return None
    stem = (match.group(3) or match.group(5) or '').lower()
    if _COMPONENT_SKIP_RE.search(stem):
        return None
    return COMPONENT_FILE_PRIORITY.index(stem) if stem in COMPONENT_FILE_PRIORITY else None


def component_files(paths: list[str], base: str = '', limit: int = MAX_COMPONENT_FILES) -> list[str]:
    """The UI component sources to read for their styles, in COMPONENT_FILE_PRIORITY order, then shallower."""
    ranked = sorted(
        (rank, p.count('/'), p) for p in paths
        if _under(p, base) and not _skipped(p) and (rank := _component_file_rank(p)) is not None
    )
    return [p for _, _, p in ranked[:limit]]


def logo_path(paths: list[str]) -> str | None:
    """The best raster logo image: in a public/static/assets directory, PNG first, then the shortest path."""
    def score(path: str) -> tuple[int, int, int, str]:
        lower = path.lower()
        in_assets = 0 if any(word in lower for word in _LOGO_DIR_BONUS) else 1
        not_png = 0 if lower.endswith('.png') else 1
        return in_assets, not_png, len(path), path
    logos = [p for p in paths if _LOGO_RE.search(p) and not _skipped(p)]
    return min(logos, key=score) if logos else None


_SVG_LOGO_RE = re.compile(r'(^|/)[^/]*logo[^/]*\.svg\Z', re.IGNORECASE)
_PUBLIC_SVG_RE = re.compile(r'(^|/)public/[^/]+\.svg\Z', re.IGNORECASE)


def svg_logo_path(paths: list[str]) -> str | None:
    """The repository's SVG logo: the shortest ``*logo*.svg``, else the only SVG directly in a ``public/``."""
    usable = [p for p in paths if not _skipped(p)]
    named = sorted((len(p), p) for p in usable if _SVG_LOGO_RE.search(p))
    if named:
        return named[0][1]
    public = [p for p in usable if _PUBLIC_SVG_RE.search(p)]
    return public[0] if len(public) == 1 else None


def logo_content_type(path: str) -> str | None:
    return LOGO_CONTENT_TYPES.get(PurePosixPath(path).suffix.lower().lstrip('.'))
