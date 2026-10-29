"""Design-system COMPONENTS: the one validator for the stored design system and for a reference's
``extracted_design`` (docs/company-context.md → "Components").

Wire shape (``SETTINGS#design_system/config`` ``components``, ≤ 30; and ``extracted_design.components``)::

    {name: str ≤ 60 (unique, case-insensitive), description: str ≤ 300,
     variants: [{name: str ≤ 40,                                    ≤ 8 per component
                 styles: {background?, color?, border_color?,        colour or "var:<token name>"
                          border_width?, radius?, gap?, height?,     a CSS length
                          width?,
                          padding?,                                  1-4 CSS lengths
                          font_family?, font_size?, font_weight?,
                          letter_spacing?, text_transform?,          none | uppercase | capitalize
                          shadow?},                                  ≤ 200, a box-shadow, no url()/expression
                 hover?: {background?, color?, border_color?, shadow?},
                 focus?: {outline?,                                  ≤ 80, an outline shorthand
                          border_color?, shadow?}}],                 the focus ring (a colour / a box-shadow)
     example_html?: str ≤ 2,000}                                     rebuilt by shared.html_sanitizer

Two modes, ONE rule set:

- ``validate_components`` (``PUT /settings/design-system``) raises ``ValidationError`` naming the
  field for an invalid value, a duplicate name or a cap exceeded;
- ``clean_components`` (what a model or a parser proposed) drops what is invalid — an entry, a
  variant, a single style — and never raises.

Unknown style keys are dropped in both modes.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any, Final

from shared.css_values import (
    is_css_color,
    is_css_length,
    is_font_family,
    is_font_weight,
)
from shared.exceptions import ValidationError
from shared.html_sanitizer import CSS_FUNCTION_RE, sanitize_html
from shared.prompt_safety import injection_findings, neutralise_tags

MAX_COMPONENTS: Final = 30
MAX_COMPONENT_NAME_CHARS: Final = 60
MAX_COMPONENT_DESCRIPTION_CHARS: Final = 300
MAX_VARIANTS: Final = 8
MAX_VARIANT_NAME_CHARS: Final = 40
MAX_EXAMPLE_HTML_CHARS: Final = 2_000
MAX_SHADOW_CHARS: Final = 200
MAX_OUTLINE_CHARS: Final = 80
TEXT_TRANSFORMS: Final = ('none', 'uppercase', 'capitalize')

_WS_RE: Final = re.compile(r'\s+')
#: A token name is at most 60 characters (shared.company_context.MAX_TOKEN_NAME_CHARS).
_TOKEN_REF_RE: Final = re.compile(r'^var:[\w .-]{1,60}\Z')
_LETTER_SPACING_RE: Final = re.compile(r'^(normal|0|-?\d{1,3}(\.\d{1,3})?(px|rem|em))\Z')
_EFFECT_RE: Final = re.compile(r'^[\w\s#%.,()/+-]{1,200}\Z')
_EFFECT_FUNCTIONS: Final = frozenset({'rgb', 'rgba', 'hsl', 'hsla', 'oklch', 'oklab', 'lab', 'lch'})


# ── Value predicates ────────────────────────────────────────────────────────

def is_token_ref(value: object) -> bool:
    """``var:<token name>`` — a reference to a colour token, resolved by whoever renders it."""
    return isinstance(value, str) and bool(_TOKEN_REF_RE.match(value.strip()))


def is_component_color(value: object) -> bool:
    return is_css_color(value) or is_token_ref(value)


def is_padding(value: object) -> bool:
    """One to four CSS lengths (``12px`` / ``8px 16px`` / ``4px 8px 4px 8px``)."""
    if not isinstance(value, str):
        return False
    parts = value.split()
    return 1 <= len(parts) <= 4 and all(is_css_length(p) for p in parts)


def is_letter_spacing(value: object) -> bool:
    return isinstance(value, str) and bool(_LETTER_SPACING_RE.match(value.strip()))


def is_text_transform(value: object) -> bool:
    return isinstance(value, str) and value.strip() in TEXT_TRANSFORMS


def _is_effect(value: object, limit: int) -> bool:
    """A box-shadow / outline: lengths, keywords and colour functions only (no url(), no expression())."""
    if not isinstance(value, str) or len(value) > limit:
        return False
    text = value.strip()
    if not _EFFECT_RE.match(text):
        return False
    return all(fn.lower() in _EFFECT_FUNCTIONS for fn in CSS_FUNCTION_RE.findall(text))


def is_shadow(value: object) -> bool:
    return _is_effect(value, MAX_SHADOW_CHARS)


def is_outline(value: object) -> bool:
    return _is_effect(value, MAX_OUTLINE_CHARS)


#: key → (predicate, what a valid value looks like — for the 400 message).
STYLE_RULES: Final[dict[str, tuple[Callable[[object], bool], str]]] = {
    'background': (is_component_color, 'a CSS colour or var:<token name>'),
    'color': (is_component_color, 'a CSS colour or var:<token name>'),
    'border_color': (is_component_color, 'a CSS colour or var:<token name>'),
    'border_width': (is_css_length, 'a CSS length such as 1px'),
    'radius': (is_css_length, 'a CSS length such as 8px'),
    'padding': (is_padding, '1 to 4 CSS lengths such as 8px 16px'),
    'gap': (is_css_length, 'a CSS length such as 8px'),
    'height': (is_css_length, 'a CSS length such as 40px'),
    'width': (is_css_length, 'a CSS length such as 36px'),
    'font_family': (is_font_family, 'a font-family list'),
    'font_size': (is_css_length, 'a CSS length such as 14px'),
    'font_weight': (is_font_weight, '100-900 or normal/bold'),
    'letter_spacing': (is_letter_spacing, 'normal or a CSS length such as -0.01em'),
    'text_transform': (is_text_transform, 'none, uppercase or capitalize'),
    'shadow': (is_shadow, 'a CSS box-shadow of at most 200 characters (no url())'),
}
HOVER_KEYS: Final = ('background', 'color', 'border_color', 'shadow')
FOCUS_RULES: Final[dict[str, tuple[Callable[[object], bool], str]]] = {
    'outline': (is_outline, 'a CSS outline of at most 80 characters such as 2px solid #7c3aed'),
    'border_color': STYLE_RULES['border_color'],
    'shadow': STYLE_RULES['shadow'],
}
FOCUS_KEYS: Final = tuple(FOCUS_RULES)


# ── One rule set, two modes ─────────────────────────────────────────────────

class _Mode:
    """``strict`` raises ValidationError with the field; lenient returns None (the caller drops)."""

    def __init__(self, strict: bool):
        self.strict = strict

    def fail(self, message: str) -> None:
        if self.strict:
            raise ValidationError(message)

    def text(self, value: object, field: str, limit: int, *, required: bool, clip: bool = False) -> str | None:
        """A one-line, injection-free, tag-neutral string. ``clip``: a lenient read cuts it to ``limit``
        instead of dropping it (a long model-written description is still worth its first sentence)."""
        if value is None:
            value = ''
        if not isinstance(value, str):
            self.fail(f'{field} must be a string')
            return None
        text = _WS_RE.sub(' ', value).strip()
        if clip and not self.strict:
            text = text[:limit].strip()
        if required and not text:
            self.fail(f'{field} is required')
            return None
        if len(text) > limit:
            self.fail(f'{field} must be at most {limit} characters')
            return None
        if injection_findings(text):
            self.fail(f'{field} contains text that looks like instructions to the AI; rephrase it as plain content')
            return None
        return neutralise_tags(text)


def _styles(raw: object, field: str, rules: dict, mode: _Mode) -> dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        mode.fail(f'{field} must be an object')
        return {}
    out: dict[str, str] = {}
    for key, (is_valid, what) in rules.items():
        value = raw.get(key)
        if value in (None, ''):
            continue
        if is_valid(value):
            out[key] = _WS_RE.sub(' ', str(value)).strip()
        else:
            mode.fail(f'{field}.{key} must be {what}')
    return out


def _variant(raw: object, field: str, mode: _Mode) -> dict | None:
    if not isinstance(raw, dict):
        mode.fail(f'{field} must be an object')
        return None
    name = mode.text(raw.get('name'), f'{field}.name', MAX_VARIANT_NAME_CHARS, required=True)
    if not name:
        return None
    variant: dict[str, Any] = {'name': name, 'styles': _styles(raw.get('styles'), f'{field}.styles', STYLE_RULES, mode)}
    hover = _styles(raw.get('hover'), f'{field}.hover', {k: STYLE_RULES[k] for k in HOVER_KEYS}, mode)
    focus = _styles(raw.get('focus'), f'{field}.focus', FOCUS_RULES, mode)
    if hover:
        variant['hover'] = hover
    if focus:
        variant['focus'] = focus
    return variant


def _unique_named(raw: object, field: str, cap: int, build: Callable[[object, str, _Mode], dict | None],
                  mode: _Mode) -> list[dict]:
    """The entries ``build`` accepts, unique by ``name`` (case-insensitive), at most ``cap``."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        mode.fail(f'{field} must be a list')
        return []
    if len(raw) > cap:
        mode.fail(f'{field} may hold at most {cap} entries')
    out: list[dict] = []
    seen: set[str] = set()
    for i, entry in enumerate(raw):
        row = build(entry, f'{field}[{i}]', mode)
        if row is None:
            continue
        if row['name'].lower() in seen:
            mode.fail(f'{field}[{i}].name must be unique (case-insensitive)')
            continue
        seen.add(row['name'].lower())
        out.append(row)
        if len(out) == cap:
            break
    return out


def _example_html(raw: object, field: str, mode: _Mode) -> str:
    if raw in (None, ''):
        return ''
    if not isinstance(raw, str) or len(raw) > MAX_EXAMPLE_HTML_CHARS:
        mode.fail(f'{field} must be a string of at most {MAX_EXAMPLE_HTML_CHARS} characters')
        return ''
    clean = sanitize_html(raw)
    if injection_findings(clean):
        mode.fail(f'{field} contains text that looks like instructions to the AI; rephrase it as plain content')
        return ''
    return clean if len(clean) <= MAX_EXAMPLE_HTML_CHARS else ''


def _component(raw: object, field: str, mode: _Mode) -> dict | None:
    if not isinstance(raw, dict):
        mode.fail(f'{field} must be an object')
        return None
    name = mode.text(raw.get('name'), f'{field}.name', MAX_COMPONENT_NAME_CHARS, required=True)
    if not name:
        return None
    description = mode.text(raw.get('description'), f'{field}.description', MAX_COMPONENT_DESCRIPTION_CHARS,
                            required=False, clip=True)
    component: dict[str, Any] = {
        'name': name, 'description': description or '',
        'variants': _unique_named(raw.get('variants'), f'{field}.variants', MAX_VARIANTS, _variant, mode),
    }
    example = _example_html(raw.get('example_html'), f'{field}.example_html', mode)
    if example:
        component['example_html'] = example
    return component


def validate_components(raw: object) -> list[dict]:
    """The components of a ``PUT /settings/design-system`` body; ValidationError naming the field."""
    return _unique_named(raw, 'components', MAX_COMPONENTS, _component, _Mode(strict=True))


def clean_components(raw: object) -> list[dict]:
    """The valid part of proposed components (a model's or a parser's); never raises."""
    return _unique_named(raw, 'components', MAX_COMPONENTS, _component, _Mode(strict=False))


# ── Merge (apply a reference) ───────────────────────────────────────────────

def merge_components(current: list[dict], incoming: list[dict]) -> tuple[list[dict], int, int]:
    """``current`` with same-named components replaced in place and new ones appended (≤ 30):
    ``(merged, added, replaced)``. Names compare case-insensitively."""
    merged = [dict(c) for c in current]
    index = {str(c.get('name', '')).strip().lower(): i for i, c in enumerate(merged)}
    added = replaced = 0
    for component in incoming:
        key = str(component.get('name', '')).strip().lower()
        if key in index:
            if merged[index[key]] != component:
                merged[index[key]] = dict(component)
                replaced += 1
        elif len(merged) < MAX_COMPONENTS:
            index[key] = len(merged)
            merged.append(dict(component))
            added += 1
    return merged, added, replaced


# ── Prompt text ─────────────────────────────────────────────────────────────

def _style_pairs(styles: object) -> str:
    return ', '.join(f'{k}={v}' for k, v in styles.items()) if isinstance(styles, dict) else ''


def component_text(component: dict) -> str:
    """One component as compact prompt text: the name, description and each variant's styles."""
    head = f'- {component.get("name", "")}'
    description = str(component.get('description') or '').strip()
    lines = [f'{head}: {description}' if description else head]
    for variant in component.get('variants') or []:
        if not isinstance(variant, dict):
            continue
        parts = [p for p in (
            _style_pairs(variant.get('styles')),
            f'hover: {_style_pairs(variant.get("hover"))}' if variant.get('hover') else '',
            f'focus: {_style_pairs(variant.get("focus"))}' if variant.get('focus') else '',
        ) if p]
        lines.append(f'    - {variant.get("name", "")}: ' + '; '.join(parts))
    return '\n'.join(lines)


def components_text(components: object, budget: int) -> str:
    """A "Components:" section of at most ``budget`` characters ('' when there are none).

    Each component gets a fair share of the budget (at least 200 characters); a component's text
    longer than its share is cut, and components that no longer fit are left out.
    """
    rows = [c for c in components if isinstance(c, dict)] if isinstance(components, list) else []
    if not rows:
        return ''
    heading = 'Components (use these styles for buttons, inputs, cards and the other elements they name):'
    share = max(200, (budget - len(heading)) // len(rows))
    out = heading
    for component in rows:
        text = component_text(component)[:share]
        if len(out) + 1 + len(text) > budget:
            break
        out += '\n' + text
    return out if out != heading else ''
