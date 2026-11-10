"""Theme variants (light / dark …) read deterministically from a stylesheet's custom properties.

``shared.css_tokens.custom_properties`` keeps the FIRST declaration of every custom property, so a
repository's token groups hold its default theme (the ``:root`` block). The other themes live in
blocks such as ``[data-theme="kiro-light"]``, ``:root[data-mode=light]``, ``html.dark`` or
``@media (prefers-color-scheme: dark) { :root { … } }``; 5.35 live (the voc-v2 repository) they were
lost entirely.

The design system has ONE set of colour tokens (≤ 40, already filled by the default theme), so a
variant is not stored as tokens. ``theme_modes`` returns, per variant, the colour tokens whose value
differs from the default, and ``modes_markdown`` writes them as a "Theme variants" section of the
reference's ``guidelines_md`` (docs/company-context.md → "Theme variants"), which the prototype
and document generators read with the rest of the guidelines.
"""
from __future__ import annotations

import re
from typing import Final

from shared.css_rules import Rule, declarations, leaf_rules
from shared.css_tokens import custom_properties, resolved_value, tokens_from_properties

MAX_MODES: Final = 4
MAX_MODE_COLORS: Final = 60
_DEFAULT_SELECTORS: Final = frozenset({':root', 'html', ':host', 'body'})
_MODE_ATTR_RE: Final = re.compile(
    r'\[data-(?:theme|mode|color-scheme|bs-theme)\s*=\s*["\']?([\w-]{1,40})["\']?\s*\]', re.IGNORECASE)
_MODE_CLASS_RE: Final = re.compile(r'(?:^|[\s>]|:root|html|body)\.((?:theme-)?(?:light|dark)[\w-]{0,30})\b', re.IGNORECASE)
_SCHEME_MEDIA_RE: Final = re.compile(r'prefers-color-scheme\s*:\s*(light|dark)', re.IGNORECASE)


def _named_mode(part: str) -> str | None:
    match = _MODE_ATTR_RE.search(part) or _MODE_CLASS_RE.search(part)
    return match.group(1).lower() if match else None


def _scheme_media(rule: Rule) -> str | None:
    for parent in rule.parents:
        match = _SCHEME_MEDIA_RE.search(parent)
        if match:
            return match.group(1).lower()
    return None


def rule_mode(rule: Rule) -> tuple[bool, str | None]:
    """``(is_default, mode name)`` of a rule: the default theme (a plain ``:root`` / ``html`` among its
    selectors, outside a media query), a named variant, or neither (``(False, None)``)."""
    parts = rule.selector_parts()
    scheme = _scheme_media(rule)
    if scheme is not None:
        return False, (scheme if any(p in _DEFAULT_SELECTORS for p in parts) else None)
    if rule.in_media():
        return False, None
    named = next((m for p in parts if (m := _named_mode(p))), None)
    return any(p in _DEFAULT_SELECTORS for p in parts), named


def default_theme_name(rules: list[Rule]) -> str:
    """The default theme's own name when its block names one (``:root, [data-theme="kiro-dark"]``), else ''."""
    for rule in rules:
        is_default, name = rule_mode(rule)
        if is_default and name:
            return name
    return ''


def _variant_declarations(rules: list[Rule], default_name: str) -> dict[str, dict[str, str]]:
    """mode name → its custom properties (first declaration wins), the default theme's own name excluded."""
    modes: dict[str, dict[str, str]] = {}
    for rule in rules:
        is_default, name = rule_mode(rule)
        if is_default or not name or name == default_name:
            continue
        props = [(prop[2:].lower(), value) for prop, value in declarations(rule.body) if prop.startswith('--')]
        if not props:
            continue
        if name not in modes and len(modes) == MAX_MODES:
            continue
        mode = modes.setdefault(name, {})
        for prop, value in props:
            mode.setdefault(prop, value)
    return modes


def theme_modes(css: str) -> tuple[str, list[dict]]:
    """``(default theme name, [{name, colors: [{name, value, default}]}])``: per theme variant, the colour
    tokens that differ from the default theme."""
    rules = leaf_rules(css)
    default_name = default_theme_name(rules)
    defaults = custom_properties(css)
    default_colors = {c['name']: c['value'] for c in tokens_from_properties(defaults)['colors']}
    out: list[dict] = []
    for name, raw in _variant_declarations(rules, default_name).items():
        scope = {**defaults, **raw}
        resolved = {prop: resolved_value(scope, value) for prop, value in raw.items()}
        colors = [
            {**c, 'default': default_colors[c['name']]}
            for c in tokens_from_properties(resolved)['colors']
            if c['name'] in default_colors and default_colors[c['name']] != c['value']
        ][:MAX_MODE_COLORS]
        if colors:
            out.append({'name': name, 'colors': colors})
    return default_name, out


def modes_markdown(modes: list[dict], default_name: str) -> str:
    """The "Theme variants" guidelines section (``''`` when there is none)."""
    if not modes:
        return ''
    default = f'`{default_name}`' if default_name else 'the default'
    sections = ['## Theme variants (read from the CSS)',
                f'The colour tokens are the {default} theme. These tokens change in the other themes.']
    for mode in modes:
        rows = '\n'.join(f'| {c["name"]} | {c["value"]} | {c["default"]} |' for c in mode['colors'])
        sections.append(f'### `{mode["name"]}`\n\n| Token | {mode["name"]} | Default |\n|---|---|---|\n{rows}')
    return '\n\n'.join(sections)
