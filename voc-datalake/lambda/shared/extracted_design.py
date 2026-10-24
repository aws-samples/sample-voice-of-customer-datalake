"""A design reference's ``extracted_design``: cleaning what a model or a parser proposed, and
merging it into the current design system as an unsaved DRAFT (docs/company-context.md).

Wire shape (stored on the ``REF#`` row, returned per reference by ``GET /settings/design-system``)::

    {colors:     [{name, value}],                  ≤ 40
     typography: [{role, family, size?, weight?}], ≤ 40
     spacing:    [{name, value}],                  ≤ 40
     radius:     [{name, value}],                  ≤ 40
     guidelines_md: str,                           ≤ 20,000
     components: [Component],                      ≤ 30 (shared/design_components.py: variants + styles)
     logo: {source_url, content_type, preview_key?} | None,  a CANDIDATE only (png / jpeg / webp);
           preview_key: the copy downloaded at read time (company-context/design/logo_preview_*),
           served as ``logo.preview_url`` by GET /settings/design-system
     source: 'computed_styles' | 'repo_files' | 'figma' | 'html' | 'screenshot'}

Every value goes through the token editor's own predicates (``shared.company_context.is_*``)
and every name through its injection check, but LENIENTLY: an invalid entry (or an invalid
optional field) is dropped, never stored and never an error — a model proposing one bad
colour must not cost the other thirty.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from shared.company_context import (
    MAX_GUIDELINES_CHARS,
    MAX_TOKEN_ENTRIES,
    MAX_TOKEN_NAME_CHARS,
    MAX_URL_CHARS,
    is_css_color,
    is_css_length,
    is_font_family,
    is_font_weight,
    validate_design_system,
)
from shared.design_components import clean_components, merge_components
from shared.prompt_safety import injection_findings, neutralise_tags

SOURCES = ('computed_styles', 'repo_files', 'figma', 'html', 'screenshot')
LOGO_CONTENT_TYPES = ('image/png', 'image/jpeg', 'image/webp')
#: Where a logo candidate's preview copy is stored (the settings and capture roles may put here only).
LOGO_PREVIEW_PREFIX = 'company-context/design/logo_preview_'
VALUE_GROUPS = {'colors': is_css_color, 'spacing': is_css_length, 'radius': is_css_length}
TOKEN_GROUPS = ('colors', 'typography', 'spacing', 'radius')
_SECTION_TITLE_CHARS = 120
_WS_RE = re.compile(r'\s+')


# ── Cleaning ────────────────────────────────────────────────────────────────

def _clean_text(value: object, limit: int) -> str:
    """A one-line, tag-neutral, injection-free string of at most ``limit`` characters, or ''."""
    if not isinstance(value, str):
        return ''
    text = _WS_RE.sub(' ', value).strip()
    if not text or len(text) > limit or injection_findings(text):
        return ''
    return neutralise_tags(text)


def _entries(raw: object) -> list[dict]:
    return [e for e in raw if isinstance(e, dict)] if isinstance(raw, list) else []


def _unique_rows(raw: object, build: Callable[[dict], dict | None], key: str, cap: int) -> list[dict]:
    """The rows ``build`` accepts, first one per ``key`` (case-insensitive), at most ``cap``."""
    out: list[dict] = []
    seen: set[str] = set()
    for entry in _entries(raw):
        row = build(entry)
        if row is None or row[key].lower() in seen:
            continue
        seen.add(row[key].lower())
        out.append(row)
        if len(out) == cap:
            break
    return out


def _named_values(raw: object, is_valid: Callable[[object], bool]) -> list[dict]:
    def build(entry: dict) -> dict | None:
        name, value = _clean_text(entry.get('name'), MAX_TOKEN_NAME_CHARS), entry.get('value')
        return {'name': name, 'value': str(value).strip()} if name and is_valid(value) else None
    return _unique_rows(raw, build, 'name', MAX_TOKEN_ENTRIES)


def _typography_row(entry: dict) -> dict | None:
    role = _clean_text(entry.get('role'), MAX_TOKEN_NAME_CHARS)
    family = entry.get('family')
    if not role or not isinstance(family, str) or not is_font_family(family):
        return None
    row: dict[str, Any] = {'role': role, 'family': _WS_RE.sub(' ', family).strip()}
    if is_css_length(entry.get('size')):
        row['size'] = str(entry['size']).strip()
    if is_font_weight(entry.get('weight')):
        row['weight'] = str(entry['weight']).strip()
    return row


def _guidelines(raw: object) -> str:
    if not isinstance(raw, str):
        return ''
    text = raw.strip()[:MAX_GUIDELINES_CHARS].strip()
    return '' if injection_findings(text) else neutralise_tags(text)


def clean_logo(raw: object) -> dict | None:
    """``{source_url, content_type, preview_key?}`` for an https raster candidate, else None."""
    if not isinstance(raw, dict):
        return None
    url, content_type = raw.get('source_url'), raw.get('content_type')
    if (not isinstance(url, str) or len(url) > MAX_URL_CHARS or not url.startswith('https://')
            or any(c.isspace() for c in url) or '@' in url.split('/', 3)[2]):
        return None
    if content_type not in LOGO_CONTENT_TYPES:
        return None
    logo = {'source_url': url, 'content_type': content_type}
    preview = raw.get('preview_key')
    if isinstance(preview, str) and preview.startswith(LOGO_PREVIEW_PREFIX) and '..' not in preview:
        logo['preview_key'] = preview
    return logo


def clean_extracted_design(raw: object, source: str) -> dict | None:
    """The valid part of a proposed design, or None when nothing in it survives."""
    if not isinstance(raw, dict) or source not in SOURCES:
        return None
    design: dict[str, Any] = {key: _named_values(raw.get(key), check) for key, check in VALUE_GROUPS.items()}
    design['typography'] = _unique_rows(raw.get('typography'), _typography_row, 'role', MAX_TOKEN_ENTRIES)
    design['guidelines_md'] = _guidelines(raw.get('guidelines_md'))
    design['components'] = clean_components(raw.get('components'))
    design['logo'] = clean_logo(raw.get('logo'))
    if not any(design.values()):
        return None
    design['source'] = source
    return design


def combine(preferred: dict | None, fallback: dict | None) -> dict:
    """Per group, ``preferred``'s entries when it has any, else ``fallback``'s (both already raw dicts)."""
    first, second = preferred or {}, fallback or {}
    keys = (*TOKEN_GROUPS, 'components', 'guidelines_md', 'logo')
    return {key: first.get(key) or second.get(key) for key in keys}


# ── Merge into a draft ──────────────────────────────────────────────────────

def _key_of(entry: dict, field: str) -> str:
    return str(entry.get(field, '')).strip().lower()


def _merge_group(current: list[dict], incoming: list[dict], field: str) -> tuple[list[dict], int, int]:
    """``current`` with same-named entries replaced in place and new ones appended (capped)."""
    merged = [dict(e) for e in current]
    index = {_key_of(e, field): i for i, e in enumerate(merged)}
    added = replaced = 0
    for entry in incoming:
        key = _key_of(entry, field)
        if key in index:
            if merged[index[key]] != entry:
                merged[index[key]] = dict(entry)
                replaced += 1
        elif len(merged) < MAX_TOKEN_ENTRIES:
            index[key] = len(merged)
            merged.append(dict(entry))
            added += 1
    return merged, added, replaced


def _section_title(title: object) -> str:
    text = _WS_RE.sub(' ', str(title or '')).strip()[:_SECTION_TITLE_CHARS]
    return neutralise_tags(text) or 'the reference'


def merged_guidelines(current: str, design: dict, title: object) -> str:
    """The guidelines after applying ``design``: as is when empty, else a "## From <title>" section appended.

    Only the reference's own ``guidelines_md``: its components are merged as first-class components.
    """
    body = str(design.get('guidelines_md') or '').strip()
    if not body:
        return current
    existing = current.strip()
    if not existing:
        return body[:MAX_GUIDELINES_CHARS]
    return f'{existing}\n\n## From {_section_title(title)}\n\n{body}'[:MAX_GUIDELINES_CHARS]


def _candidate_without_preview(raw: object) -> dict | None:
    """The draft's logo candidate: the URL and type only (the preview copy is served by GET, never keyed)."""
    logo = clean_logo(raw)
    return {k: v for k, v in logo.items() if k != 'preview_key'} if logo else None


def apply_to_draft(current: dict, design: dict, title: object) -> dict:
    """``{draft: {tokens, guidelines, components, logo_candidate}, changes}`` — the current design
    system merged with ``design`` (a reference's ``extracted_design``). Components merge by name
    (case-insensitive): same name replaced, new appended, ≤ 30; ``changes.components = {added, replaced}``. Nothing is saved: the admin saves the
    draft with ``PUT /settings/design-system``, which validates it again.
    """
    raw_tokens = current.get('tokens')
    tokens_in = raw_tokens if isinstance(raw_tokens, dict) else {}
    tokens: dict[str, list] = {}
    changes: dict[str, Any] = {}
    for group in TOKEN_GROUPS:
        field = 'role' if group == 'typography' else 'name'
        existing, incoming = _entries(tokens_in.get(group)), _entries(design.get(group))
        merged, added, replaced = _merge_group(existing, incoming, field)
        if group in ('colors', 'typography') or merged or group in tokens_in:
            tokens[group] = merged
        changes[group] = {'added': added, 'replaced': replaced}
    raw_guidelines = current.get('guidelines')
    guidelines_now = raw_guidelines if isinstance(raw_guidelines, str) else ''
    guidelines = merged_guidelines(guidelines_now, design, title)
    changes['guidelines_added'] = guidelines != guidelines_now
    components, added, replaced = merge_components(
        clean_components(current.get('components')), clean_components(design.get('components')))
    changes['components'] = {'added': added, 'replaced': replaced}
    # The editor's own validation, so a draft the SPA loads is one its Save accepts.
    clean = validate_design_system({'tokens': tokens, 'guidelines': guidelines, 'components': components})
    draft = {'tokens': clean['tokens'], 'guidelines': clean['guidelines'], 'components': clean['components'],
             'logo_candidate': _candidate_without_preview(design.get('logo'))}
    return {'draft': draft, 'changes': changes}
