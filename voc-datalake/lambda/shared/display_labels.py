"""The ONE backend place a stored category / subcategory id becomes the label a person reads.

Mirrors ``frontend/src/utils/displayLabels.ts`` (``humanizeId``, ``categoryLabel``,
``subcategoryLabel``, ``sourceLabel``) so model-written text (the morning brief) names a
category exactly as the dashboard does: the configured ``description`` when it reads as a
label (non-empty, one line, at most 60 characters), else the humanised id —
underscores → spaces, sentence case, known acronyms spelled their own way
(``software_firmware`` → ``Software firmware``, ``api_automation`` → ``API automation``).

A source id reads like the SPA's ``sourceLabel``: its source profile's label when one is
set (and is not just the id), else ``<app>_<android|ios>`` → ``App (Android)``,
``web_<site>_<app>`` → ``App (Site)`` (a slugged hostname reads as the site's name), else the
humanised id.

``shared/test/test_display_labels.py`` pins this module to the TypeScript examples and
spelling table, so the two cannot drift. Pure functions only; ids are never changed.
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any, Final

__all__ = ['category_label', 'humanize_id', 'source_label', 'subcategory_label']

#: Words that never take sentence case (lowercase key → spelling). Same table as the TS one.
SPELLINGS: Final[Mapping[str, str]] = {
    'ai': 'AI', 'api': 'API', 'apis': 'APIs', 'b2b': 'B2B', 'b2c': 'B2C', 'csat': 'CSAT', 'csv': 'CSV', 'faq': 'FAQ',
    'faqs': 'FAQs', 'id': 'ID', 'ios': 'iOS', 'ipad': 'iPad', 'iphone': 'iPhone', 'json': 'JSON', 'kpi': 'KPI',
    'llm': 'LLM', 'macos': 'macOS', 'mcp': 'MCP', 'nps': 'NPS', 'os': 'OS', 'pdf': 'PDF', 'pii': 'PII', 'prd': 'PRD',
    'qa': 'QA', 'sdk': 'SDK', 'seo': 'SEO', 'sla': 'SLA', 'sms': 'SMS', 'sso': 'SSO', 'tv': 'TV', 'ui': 'UI',
    'url': 'URL', 'ux': 'UX', 'cx': 'CX', 'vpn': 'VPN', 'android': 'Android', 'github': 'GitHub', 'trustpilot': 'Trustpilot',
}

#: A configured name longer than this is an explanation, not a label.
MAX_CONFIGURED_LABEL: Final = 60


def _spell(word: str) -> str:
    return SPELLINGS.get(word.lower(), word)


def humanize_id(value: str) -> str:
    """A stored id as a label: ``existing_customer`` → ``Existing customer``. Empty in, empty out."""
    words = [_spell(word) for word in value.replace('_', ' ').split(' ') if word]
    if not words:
        return ''
    first, rest = words[0], words[1:]
    # A dotted word is a package / domain name (`com.examplemusic.player`): its case is its spelling.
    raised = first if '.' in first else first[:1].upper() + first[1:]
    return ' '.join([SPELLINGS.get(first.lower(), raised), *rest])


def _usable(name: object) -> str | None:
    """A configured name when it reads as a label (non-empty, one line, short)."""
    trimmed = name.strip() if isinstance(name, str) else ''
    return None if not trimmed or len(trimmed) > MAX_CONFIGURED_LABEL or '\n' in trimmed else trimmed


def _entries(raw: object) -> list[Mapping[str, Any]]:
    return [entry for entry in raw if isinstance(entry, Mapping)] if isinstance(raw, list | tuple) else []


def category_label(category_id: str, categories: Iterable[Mapping[str, Any]] = ()) -> str:
    """A category id's label: its configured name, else the humanised id."""
    configured = next((c for c in _entries(list(categories)) if c.get('name') == category_id), None)
    return _usable(configured.get('description') if configured else None) or humanize_id(category_id)


def subcategory_label(sub_id: str, parent: str | None, categories: Iterable[Mapping[str, Any]] = ()) -> str:
    """A subcategory id's label: looked up under ``parent`` first, then anywhere; else humanised."""
    rows = _entries(list(categories))
    in_parent = next((s for c in rows if c.get('name') == parent
                      for s in _entries(c.get('subcategories')) if s.get('name') == sub_id), None)
    anywhere = in_parent or next((s for c in rows for s in _entries(c.get('subcategories'))
                                  if s.get('name') == sub_id), None)
    return _usable(anywhere.get('description') if anywhere else None) or humanize_id(sub_id)


APP_PLATFORMS: Final[Mapping[str, str]] = {'android': 'Android', 'ios': 'iOS'}
#: Characters that join an app name to a platform it spells out (``Example Air - iOS``, ``Example Air (iOS)``).
_PLATFORM_JOINERS: Final = frozenset({'-', '_', '('})
_APP_CONNECTOR: Final = re.compile(r'^(.+)_(android|ios)\Z', re.IGNORECASE)
_WEB_CONNECTOR: Final = re.compile(r'^web_([a-z0-9-]+)_(.+)\Z')
#: Host prefixes / top-level domains of a slugged hostname (``www_trustpilot_com``). Same sets as the TS ones.
HOST_PREFIXES: Final = frozenset({'www', 'm'})
TOP_LEVEL_DOMAINS: Final = frozenset({
    'com', 'net', 'org', 'io', 'app', 'dev', 'info', 'biz', 'uk', 'de', 'fr', 'es', 'it', 'nl', 'be', 'ch',
    'at', 'se', 'no', 'dk', 'fi', 'pl', 'pt', 'ie', 'br', 'mx', 'ar', 'cl', 'au', 'nz', 'ca', 'jp', 'in',
})


def _without_platform_suffix(app: str, platform_id: str) -> str | None:
    """``app`` without a trailing ``platform_id`` it spells out after a joiner, else None."""
    trimmed = app.strip()
    closed = trimmed[:-1].rstrip() if trimmed.endswith(')') else trimmed
    if not closed.lower().endswith(platform_id.lower()):
        return None
    head = closed[:len(closed) - len(platform_id)]
    spaced = head.rstrip()
    joined = spaced[:-1].rstrip() if spaced[-1:] in _PLATFORM_JOINERS else spaced
    return joined if len(joined) < len(head) and joined else None


def _app_connector_label(source_id: str) -> str | None:
    match = _APP_CONNECTOR.match(source_id)
    if match is None:
        return None
    app, platform_id = match.group(1), match.group(2)
    platform = APP_PLATFORMS.get(platform_id.lower(), platform_id)
    base = _without_platform_suffix(app, platform_id)
    if base is not None:
        return f'{humanize_id(base)} ({platform})'
    name = humanize_id(app)
    says_platform = re.search(rf'(^|[^a-z]){platform_id}([^a-z]|\Z)', app, re.IGNORECASE) is not None
    return name if says_platform else f'{name} ({platform})'


def _is_tld(labels: list[str], index: int) -> bool:
    part = labels[index] if index < len(labels) else None
    following = labels[index + 1] if index + 1 < len(labels) else ''
    return part is not None and (part in TOP_LEVEL_DOMAINS or (part == 'co' and following in TOP_LEVEL_DOMAINS))


def _leading_domain(parts: list[str]) -> tuple[str, list[str]] | None:
    """The slugged hostname at the start of ``parts``: ``(domain, rest)``, else None."""
    labels = parts[1:] if parts and parts[0] in HOST_PREFIXES else parts
    if len(labels) < 2 or not _is_tld(labels, 1):
        return None
    end = next((i for i in range(1, len(labels)) if not _is_tld(labels, i)), len(labels))
    return '.'.join(labels[:end]), labels[end:]


def _web_connector_label(source_id: str) -> str | None:
    match = _WEB_CONNECTOR.match(source_id)
    if match is None:
        return None
    site, app = match.group(1), match.group(2)
    host = _leading_domain([site, *[part for part in app.split('_') if part]])
    if host is None:
        return f'{humanize_id(app)} ({humanize_id(site)})'
    domain, rest = host
    # The site's NAME (``trustpilot.com`` → ``Trustpilot``), like every other source label.
    site_name = humanize_id(domain.split('.')[0])
    return f"{humanize_id('_'.join(rest))} ({site_name})" if rest else site_name


def source_label(source_id: str, profiles: Iterable[Mapping[str, Any]] = ()) -> str:
    """A source id's label: its profile's label (when set and not just the id), else the connector-aware humanised id."""
    profile = next((p for p in _entries(list(profiles)) if p.get('id') == source_id), None)
    raw = profile.get('label') if profile else None
    label = raw.strip() if isinstance(raw, str) else ''
    if label and label != source_id:
        return label
    return _app_connector_label(source_id) or _web_connector_label(source_id) or humanize_id(source_id)
