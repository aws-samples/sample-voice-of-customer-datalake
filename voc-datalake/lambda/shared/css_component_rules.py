"""Component styles read deterministically from PLAIN CSS component classes (no model involved).

Many repositories style their controls with ``@layer components`` classes rather than cva maps in
``components/ui`` — ``.btn { @apply … }``, ``.btn-ghost { background: transparent; … }``,
``.badge-ok { @apply bg-ok-subtle text-ok; }``, ``.tab-active``, ``.input``, ``.select``,
``.switch``. 5.35 live (the voc-v2 repository) none of them was read. ``components_from_css``:

- finds the rules whose selector is one component class (``.btn``), a variant of it
  (``.btn-ghost``, ``.tab-active``, ``.switch-on``: the suffix is in VARIANT_WORDS) or its hover
  (``.btn:hover``, ``.btn-primary:not(:disabled):hover``) / focus (``.input:focus-visible``);
- maps ``@apply`` utilities with ``shared.tailwind_components.styles_from_classes`` and plain
  declarations (``background``, ``color``, ``border-color``, ``border``, ``border-radius``,
  ``padding``, ``gap``, ``height``, ``font-*``, ``letter-spacing``, ``text-transform``,
  ``box-shadow``, ``outline``) to THE CONTRACT's style keys, ``var(--x)`` resolved;
- builds one component per class family (COMPONENT_CLASSES): its ``default`` variant from the
  base class (left out when the base sets no colour and the family has variants: ``.badge`` is
  only the layout every tone shares), every variant as the base styles overridden by its own;
- a focus rule (``.input:focus``) gives ``focus`` its outline AND its ring: the focused border
  colour and box-shadow (5.35.02 live: only the outline was kept);
- a part class (``.switch-knob``, ``.slider-thumb``: PART_WORDS) is described in the component's
  ``description`` (``Knob: width=16px, …``) — the contract has no slot for sub-parts.

Size modifiers (``.btn-sm``), other parts (``.dialog-title``) and rules inside a media query are not
variants. The output is raw — ``shared.design_components.clean_components``
validates every value.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Final

from shared.css_rules import Rule, declarations, leaf_rules
from shared.design_components import FOCUS_KEYS, HOVER_KEYS
from shared.tailwind_components import Theme, styles_from_classes

#: Component class (the family) → its component name.
COMPONENT_CLASSES: Final = {
    'btn': 'Button', 'button': 'Button', 'icon-btn': 'Icon button', 'input': 'Input', 'textarea': 'Textarea',
    'select': 'Select', 'badge': 'Badge', 'tag': 'Tag', 'chip': 'Chip', 'pill': 'Pill', 'tab': 'Tab',
    'card': 'Card', 'switch': 'Switch', 'toggle': 'Toggle', 'checkbox': 'Checkbox', 'alert': 'Alert',
    'menu-item': 'Menu item', 'link': 'Link', 'dialog-panel': 'Dialog',
}
#: A ``.<family>-<suffix>`` class is a variant when its suffix is one of these.
VARIANT_WORDS: Final = frozenset({
    'primary', 'secondary', 'tertiary', 'ghost', 'outline', 'link', 'subtle', 'solid', 'soft', 'plain',
    'danger', 'danger-solid', 'destructive', 'error', 'ok', 'success', 'warn', 'warning', 'info', 'muted',
    'accent', 'aim', 'neutral', 'active', 'selected', 'on', 'checked', 'inverse', 'dark', 'light',
})
#: A ``.<family>-<word>`` class that styles a PART of the component (described, not a variant).
PART_WORDS: Final = frozenset({'knob', 'thumb', 'handle', 'indicator'})
_COLOR_KEYS: Final = ('background', 'color')
_HOVER_SUFFIX_RE: Final = re.compile(r'^((?::not\(:disabled\))?:hover(?::not\(:disabled\))?|:enabled:hover)\Z')
_FOCUS_SUFFIX_RE: Final = re.compile(r'^:focus(-visible)?\Z')
#: One optional pseudo suffix: ``:`` then the rest (``(?::[...]+)*`` matched the same strings but backtracked
#: exponentially on a long run of ``(:`` in fetched CSS, CodeQL py/redos).
_CLASS_PART_RE: Final = re.compile(r'^\.([a-z][\w-]{0,40})((?::[\w():-]+)?)\Z', re.IGNORECASE)
#: Longest family first, so ``icon-btn-ghost`` is an Icon button variant, not a Button one.
_FAMILIES_LONGEST_FIRST: Final = tuple(sorted(COMPONENT_CLASSES, key=len, reverse=True))
_TEXT_TRANSFORMS: Final = {'uppercase': 'uppercase', 'capitalize': 'capitalize', 'none': 'none'}
#: Plain declarations copied to a style key as is (after var() resolution); validated downstream.
_DIRECT: Final = {
    'background-color': 'background', 'background': 'background', 'color': 'color',
    'border-color': 'border_color', 'border-width': 'border_width', 'border-radius': 'radius',
    'padding': 'padding', 'gap': 'gap', 'height': 'height', 'min-height': 'height', 'width': 'width',
    'font-family': 'font_family', 'font-size': 'font_size', 'font-weight': 'font_weight',
    'letter-spacing': 'letter_spacing', 'box-shadow': 'shadow',
}


@dataclass
class _State:
    styles: dict[str, str] = field(default_factory=dict)
    hover: dict[str, str] = field(default_factory=dict)
    focus: dict[str, str] = field(default_factory=dict)


@dataclass
class _Family:
    base: _State = field(default_factory=_State)
    variants: dict[str, _State] = field(default_factory=dict)
    parts: dict[str, dict[str, str]] = field(default_factory=dict)


def _family_of(name: str, words: frozenset[str] = VARIANT_WORDS) -> tuple[str, str] | None:
    """``btn-ghost`` → ('btn', 'ghost'); ``btn`` → ('btn', ''); not a component class → None.
    With ``words=PART_WORDS``: ``switch-knob`` → ('switch', 'knob') (and no bare family)."""
    lower = name.lower()
    if lower in COMPONENT_CLASSES and words is VARIANT_WORDS:
        return lower, ''
    for family in _FAMILIES_LONGEST_FIRST:
        suffix = lower.removeprefix(f'{family}-')
        if suffix != lower and suffix in words:
            return family, suffix
    return None


def _border_shorthand(value: str, theme: Theme, out: dict[str, str]) -> None:
    for token in theme.resolve_vars(value).split():
        if token[:1].isdigit():
            out['border_width'] = token
        elif token not in ('solid', 'dashed', 'dotted', 'none'):
            out['border_color'] = token


def _declared_styles(pairs: list[tuple[str, str]], theme: Theme) -> tuple[dict[str, str], dict[str, str]]:
    """``(styles, hover)`` of a rule body: ``@apply`` utilities first, plain declarations over them."""
    styles: dict[str, str] = {}
    hover: dict[str, str] = {}
    for prop, value in pairs:
        if prop == '@apply':
            applied, applied_hover = styles_from_classes(value, theme)
            styles.update(applied)
            hover.update(applied_hover)
        elif prop in _DIRECT:
            styles[_DIRECT[prop]] = theme.resolve_vars(value)
        elif prop == 'border':
            _border_shorthand(value, theme, styles)
        elif prop == 'text-transform' and value in _TEXT_TRANSFORMS:
            styles['text_transform'] = _TEXT_TRANSFORMS[value]
        elif prop == 'outline':
            styles['outline'] = theme.resolve_vars(value)
    return styles, hover


def _record(state: _State, suffix: str, pairs: list[tuple[str, str]], theme: Theme) -> None:
    styles, hover = _declared_styles(pairs, theme)
    if _HOVER_SUFFIX_RE.match(suffix):
        state.hover.update({k: v for k, v in styles.items() if k in HOVER_KEYS})
    elif _FOCUS_SUFFIX_RE.match(suffix):
        state.focus.update({k: styles[k] for k in FOCUS_KEYS if k in styles})
    elif not suffix:
        styles.pop('outline', None)
        state.styles.update(styles)
        state.hover.update(hover)


def _collect(rules: list[Rule], theme: Theme) -> dict[str, _Family]:
    families: dict[str, _Family] = {}
    for rule in rules:
        if rule.in_media():
            continue
        pairs = declarations(rule.body)
        for part in rule.selector_parts():
            match = _CLASS_PART_RE.match(part)
            if match and not match.group(2) and (piece := _family_of(match.group(1), PART_WORDS)):
                styles, _hover = _declared_styles(pairs, theme)
                families.setdefault(piece[0], _Family()).parts.setdefault(piece[1], {}).update(styles)
                continue
            found = _family_of(match.group(1)) if match else None
            if match is None or found is None:
                continue
            family = families.setdefault(found[0], _Family())
            state = family.variants.setdefault(found[1], _State()) if found[1] else family.base
            _record(state, match.group(2), pairs, theme)
    return families


def _variant(name: str, base: _State, own: _State | None) -> dict:
    state = own or _State()
    variant: dict = {'name': name, 'styles': {**base.styles, **state.styles}}
    hover = {**base.hover, **state.hover}
    focus = {**base.focus, **state.focus}
    if hover:
        variant['hover'] = hover
    if focus:
        variant['focus'] = focus
    return variant


def _parts_description(parts: dict[str, dict[str, str]]) -> str:
    """``Knob: background=#ffffff, width=16px.`` per described part (the contract has no sub-part slot)."""
    lines = [f'{word.capitalize()}: ' + ', '.join(f'{k}={v}' for k, v in styles.items()) + '.'
             for word, styles in parts.items() if styles]
    return ' '.join(lines)


def _has_default(family: _Family) -> bool:
    """The base class is a variant of its own unless it only carries the layout its colour variants share."""
    if not family.base.styles:
        return False
    return not family.variants or any(k in family.base.styles for k in _COLOR_KEYS)


def components_from_css(css: str, theme: Theme) -> list[dict]:
    """The components the stylesheet's component classes define (raw, uncleaned), one per family."""
    out: list[dict] = []
    for family_name, family in _collect(leaf_rules(css), theme).items():
        label = COMPONENT_CLASSES[family_name]
        variants = [_variant('default', family.base, None)] if _has_default(family) else []
        variants += [_variant(name, family.base, own) for name, own in family.variants.items()]
        variants = [v for v in variants if v['styles'] or v.get('hover')]
        if variants and label.lower() not in {c['name'].lower() for c in out}:
            out.append({'name': label, 'description': _parts_description(family.parts), 'variants': variants})
    return out
