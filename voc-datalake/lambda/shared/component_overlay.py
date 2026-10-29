"""Read component styles win over a model's guess (the design references' components, pure).

A reference's model answer is preferred group by group (``extracted_design.combine``), so a
component the model listed replaced the one READ without a model wholesale. 5.35.02 live that
lost values the parser or the page had right: the voc-v2 Badge ``info`` / ``aim`` tones, the
Input focus ring, the Switch width, the kiromail purple call-to-action (the model named the white
nav button ``primary`` and gave both buttons a hover colour no rule set).

``overlay_components(design, read)`` puts the read components (parsed from a repository's CSS
and UI sources, or measured in a live page) over the model's, by component name:

- a read variant matches the model's variant of the same name, else the one with the same
  background; its styles override the model's, its ``focus`` keys too, and its ``hover`` REPLACES
  the model's (hover is never visible in a screenshot or a summary: only a CSS rule is evidence);
- a matched read variant with a generic name (``default``, ``variant 2``) takes the model's name
  (``success`` reads better than ``variant 2``);
- the model's unmatched variants follow the read ones (≤ MAX_VARIANTS), a read component the model
  did not list is appended, the model's description / example are kept and the read ones fill gaps (a read component
  with no variants — a name from the repository tree — is never added).

The result is cleaned again (``clean_components``).
"""
from __future__ import annotations

import re
from typing import Any, Final

from shared.css_color_mix import format_color, parse_color
from shared.design_components import MAX_COMPONENT_DESCRIPTION_CHARS, MAX_VARIANTS, clean_components

_GENERIC_NAME_RE: Final = re.compile(r'^(default|variant \d{1,2})\Z', re.IGNORECASE)


def _key(entry: dict) -> str:
    """A component's or variant's name as the case-insensitive match key."""
    return str(entry.get('name', '')).strip().lower()


def _colour_key(value: object) -> str:
    text = str(value or '').strip().lower()
    parsed = parse_color(text)
    return format_color(parsed) if parsed else text


def _match(read: dict, candidates: list[dict]) -> dict | None:
    name = _key(read)
    by_name = next((c for c in candidates if _key(c) == name), None)
    if by_name is not None:
        return by_name
    background = _colour_key((read.get('styles') or {}).get('background'))
    if not background:
        return None
    return next((c for c in candidates if _colour_key((c.get('styles') or {}).get('background')) == background), None)


def _merged_variant(read: dict, model: dict | None) -> dict:
    if model is None:
        return dict(read)
    name = read['name']
    if _GENERIC_NAME_RE.match(str(name)) and model.get('name'):
        name = model['name']
    variant: dict[str, Any] = {'name': name, 'styles': {**(model.get('styles') or {}), **(read.get('styles') or {})}}
    if read.get('hover'):
        variant['hover'] = dict(read['hover'])
    focus = {**(model.get('focus') or {}), **(read.get('focus') or {})}
    if focus:
        variant['focus'] = focus
    return variant


def _merged_variants(read: list[dict], model: list[dict]) -> list[dict]:
    left = list(model)
    out: list[dict] = []
    taken: set[str] = set()
    for variant in read:
        partner = _match(variant, left)
        if partner is not None:
            left.remove(partner)
        merged = _merged_variant(variant, partner)
        if _key(merged) not in taken:
            taken.add(_key(merged))
            out.append(merged)
    out += [v for v in left if _key(v) not in taken]
    return out[:MAX_VARIANTS]


def _description(model: str, read: str) -> str:
    if not read or read in model:
        return model
    return f'{model} {read}'.strip()[:MAX_COMPONENT_DESCRIPTION_CHARS]


def _merged_component(model: dict, read: dict) -> dict:
    merged: dict[str, Any] = {
        'name': model['name'],
        'description': _description(str(model.get('description') or ''), str(read.get('description') or '')),
        'variants': _merged_variants(read.get('variants') or [], model.get('variants') or []),
    }
    example = model.get('example_html') or read.get('example_html')
    if example:
        merged['example_html'] = example
    return merged


def overlay_components(design: dict | None, read: list[dict]) -> dict | None:
    """``design`` whose components carry the read styles over the model's (see the module docstring)."""
    if not isinstance(design, dict) or not read:
        return design
    by_name = {_key(c): c for c in read}
    used: set[str] = set()
    components: list[dict] = []
    for component in design.get('components') or []:
        key = _key(component)
        own = by_name.get(key)
        components.append(component if own is None else _merged_component(component, own))
        used.add(key)
    # A read component the model did not list is added when it carries styles (a bare tree name adds nothing).
    components += [c for key, c in by_name.items() if key not in used and c.get('variants')]
    return {**design, 'components': clean_components(components)}
