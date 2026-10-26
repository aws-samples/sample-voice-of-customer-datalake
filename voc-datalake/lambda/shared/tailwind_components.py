"""Component styles read DETERMINISTICALLY from a repository's UI sources (no model involved).

``components_from_source`` takes one ``components/ui/**`` file (or a ``components/ui.tsx`` of
primitives) and the repository's CSS custom properties, finds each exported component, its base
class list and its variants, and maps the common Tailwind utilities to THE CONTRACT's style keys
(shared/design_components.py), resolving theme colours, radii and fonts to the parsed values:

- variants come from a ``cva(base, {variants: {variant: {…}}})`` map, an object map of class
  strings the component indexes (``ICON_BUTTON_VARIANTS[variant]``), or a ternary chain
  (``primary ? '…' : danger ? '…' : '…'`` / ``variant === 'ok' ? '…' : …``; the final ``else`` is
  ``default``); a component with none of these is one ``default`` variant;
- ``bg-accent`` → the ``--color-accent`` / ``--accent`` value, ``text-sm`` → 14px, ``text-[13px]``,
  ``rounded-lg`` → ``--radius-lg`` or Tailwind's 0.5rem, ``px-4`` → 16px, ``border`` → 1px,
  ``font-semibold`` → 600, ``font-body`` → ``--font-body``, ``tracking-tight``, ``uppercase``,
  ``shadow-sm`` / ``shadow-[0_0_12px_var(--x)]``; ``hover:`` utilities fill ``hover``.

Anything not mapped (responsive / dark / state prefixes, opacity modifiers, unknown colours) is
left out: the model reads the source beside these facts and may infer it. The output is raw —
``shared.design_components.clean_components`` validates every value.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Final

from shared.css_values import is_css_color, is_css_length

MAX_COMPONENTS_PER_FILE: Final = 12
MAX_VARIANTS: Final = 6
NAME_ALIASES: Final = {'Btn': 'Button', 'Btn group': 'Button group'}

_DECLARATION_RE: Final = re.compile(r'^(export\s+)?(default\s+)?(function|const|let)\s+([A-Za-z_]\w*)', re.MULTILINE)
_STRING_RE: Final = re.compile(r"'([^'\n]*)'|\"([^\"\n]*)\"|`([^`]*)`")
_TERNARY_RE: Final = re.compile(
    r"""(?:(\w+)\s*===\s*['"](\w[\w-]*)['"]|(?<![=!<>])\b([a-z]\w*))\s*\?\s*(['"`])([^'"`]*)\4""")
_ELSE_RE: Final = re.compile(r""":\s*(['"`])([^'"`]*)\1\s*[)}\n;]""")
_MAP_RE: Final = re.compile(r'(?:const|let)\s+(\w+)\s*(?::[^=]{0,200})?=\s*\{')
_MAP_ENTRY_RE: Final = re.compile(r"""(?:^|[,{\s])(?:['"]?)([\w-]+)(?:['"]?)\s*:\s*(['"`])([^'"`]*)\2""")
_CVA_RE: Final = re.compile(r'(?:const|let)\s+(\w+)\s*=\s*cva\(\s*([\'"`])([^\'"`]*)\2')
_CVA_VARIANTS_RE: Final = re.compile(r'variants\s*:\s*\{')
_UTILITY_HINT_RE: Final = re.compile(r'(^|\s)(bg-|text-|border|rounded|p[xytrbl]?-|gap-|h-|font-|shadow)')

_TEXT_SIZES: Final = {'xs': '12px', 'sm': '14px', 'base': '16px', 'lg': '18px', 'xl': '20px', '2xl': '24px',
                      '3xl': '30px', '4xl': '36px'}
_RADII: Final = {'none': '0', 'xs': '2px', 'sm': '4px', 'DEFAULT': '4px', 'md': '6px', 'lg': '8px', 'xl': '12px',
                 '2xl': '16px', '3xl': '24px', 'full': '9999px'}
_WEIGHTS: Final = {'thin': '100', 'extralight': '200', 'light': '300', 'normal': '400', 'medium': '500',
                   'semibold': '600', 'bold': '700', 'extrabold': '800', 'black': '900'}
_TRACKING: Final = {'tighter': '-0.05em', 'tight': '-0.025em', 'normal': 'normal', 'wide': '0.025em',
                    'wider': '0.05em', 'widest': '0.1em'}
_SHADOWS: Final = {
    'xs': '0 1px 1px rgb(0 0 0 / 5%)', 'sm': '0 1px 3px rgb(0 0 0 / 10%), 0 1px 2px -1px rgb(0 0 0 / 10%)',
    'DEFAULT': '0 1px 3px rgb(0 0 0 / 10%), 0 1px 2px -1px rgb(0 0 0 / 10%)',
    'md': '0 4px 6px -1px rgb(0 0 0 / 10%), 0 2px 4px -2px rgb(0 0 0 / 10%)',
    'lg': '0 10px 15px -3px rgb(0 0 0 / 10%), 0 4px 6px -4px rgb(0 0 0 / 10%)', 'none': 'none',
}
_TRANSFORMS: Final = {'uppercase': 'uppercase', 'capitalize': 'capitalize', 'normal-case': 'none'}
_SIDES: Final = {'p': (0, 1, 2, 3), 'px': (1, 3), 'py': (0, 2), 'pt': (0,), 'pr': (1,), 'pb': (2,), 'pl': (3,)}
#: An innermost ``var(--name[, fallback])`` (its fallback holds no parenthesis).
_INNER_VAR_RE: Final = re.compile(r'var\(\s*--([\w-]+)\s*(?:,([^()]*))?\)')
_RESOLVE_DEPTH: Final = 8
_HOVER_KEYS: Final = ('background', 'color', 'border_color', 'shadow')


# ── Values ──────────────────────────────────────────────────────────────────

@dataclass
class Theme:
    """The repository's custom properties (``shared.css_tokens.custom_properties``, var() resolved)."""
    props: dict[str, str] = field(default_factory=dict)

    def resolve_vars(self, value: str) -> str:
        """``var(--x)`` → the value of ``--x``; an unknown one → its fallback, or nothing."""
        current = value
        for _ in range(_RESOLVE_DEPTH):
            match = _INNER_VAR_RE.search(current)
            if not match:
                break
            known = self.props.get(match.group(1).lower())
            replacement = known if known is not None and 'var(' not in known else (match.group(2) or '')
            current = current[:match.start()] + replacement.strip() + current[match.end():]
        # A removed var() leaves an empty list item ("a, , b" / ", b"): drop it, keep every other separator.
        return ','.join(part for part in current.split(',') if part.strip()).strip()

    def color(self, name: str) -> str | None:
        if name.startswith('[') and name.endswith(']'):
            value = self.resolve_vars(name[1:-1].replace('_', ' '))
        else:
            value = self.props.get(f'color-{name}') or self.props.get(name) or name
        return value if is_css_color(value) else None

    def radius(self, key: str) -> str | None:
        if key.startswith('['):
            value = self.resolve_vars(key[1:-1])
            return value if is_css_length(value) else None
        value = self.props.get(f'radius-{key}') or self.props.get(f'rounded-{key}') or _RADII.get(key)
        return value if is_css_length(value) else None

    def font(self, key: str) -> str | None:
        value = self.props.get(f'font-{key}') or self.props.get(f'font-family-{key}')
        return self.resolve_vars(value) if value else None


def _spacing(key: str, theme: Theme) -> str | None:
    if key.startswith('[') and key.endswith(']'):
        value = theme.resolve_vars(key[1:-1])
        return value if is_css_length(value) else None
    if re.fullmatch(r'\d{1,3}(\.5)?', key):
        return f'{float(key) * 4:g}px' if key != '0' else '0'
    return None


def _shadow(key: str, theme: Theme) -> str | None:
    if key.startswith('[') and key.endswith(']'):
        return theme.resolve_vars(key[1:-1].replace('_', ' '))
    return _SHADOWS.get(key)


# ── Utilities → styles ──────────────────────────────────────────────────────

@dataclass
class _Box:
    styles: dict[str, str] = field(default_factory=dict)
    padding: list[str | None] = field(default_factory=lambda: [None, None, None, None])

    def finish(self) -> dict[str, str]:
        if any(self.padding):
            sides = [p or '0' for p in self.padding]
            if sides[0] == sides[2] and sides[1] == sides[3]:
                sides = [sides[0]] if sides[0] == sides[1] else sides[:2]
            self.styles['padding'] = ' '.join(sides)
        return self.styles


def _text_utility(rest: str, theme: Theme, box: _Box) -> None:
    if rest in _TEXT_SIZES:
        box.styles['font_size'] = _TEXT_SIZES[rest]
    elif rest.startswith('[') and is_css_length(rest[1:-1]):
        box.styles['font_size'] = rest[1:-1]
    elif (color := theme.color(rest)) is not None:
        box.styles['color'] = color


def _border_utility(rest: str, theme: Theme, box: _Box) -> None:
    if rest in ('', '1'):
        box.styles['border_width'] = '1px'
    elif rest.isdigit():
        box.styles['border_width'] = f'{rest}px'
    elif rest == 'none':
        box.styles['border_width'] = '0'
    elif (color := theme.color(rest)) is not None:
        box.styles['border_color'] = color


def _font_utility(rest: str, theme: Theme, box: _Box) -> None:
    if rest in _WEIGHTS:
        box.styles['font_weight'] = _WEIGHTS[rest]
    elif (family := theme.font(rest)) is not None:
        box.styles['font_family'] = family


def _set(box: _Box, key: str, value: str | None) -> None:
    if value is not None:
        box.styles[key] = value


def _padding_utility(head: str, rest: str, theme: Theme, box: _Box) -> None:
    length = _spacing(rest, theme)
    if length is not None:
        for side in _SIDES[head]:
            box.padding[side] = length


_Handler = Callable[[str, Theme, _Box], None]
#: utility head (the text before the first ``-``) → handler of the rest.
_HANDLERS: Final[dict[str, _Handler]] = {
    'bg': lambda rest, theme, box: _set(box, 'background', theme.color(rest)),
    'text': _text_utility,
    'border': _border_utility,
    'rounded': lambda rest, theme, box: _set(box, 'radius', theme.radius(rest or 'DEFAULT')),
    'gap': lambda rest, theme, box: _set(box, 'gap', _spacing(rest, theme)),
    'h': lambda rest, theme, box: _set(box, 'height', _spacing(rest, theme)),
    'font': _font_utility,
    'tracking': lambda rest, _theme, box: _set(box, 'letter_spacing', _TRACKING.get(rest)),
    'shadow': lambda rest, theme, box: _set(box, 'shadow', _shadow(rest or 'DEFAULT', theme)),
}


def _apply_utility(utility: str, theme: Theme, box: _Box) -> None:
    if utility in _TRANSFORMS:
        box.styles['text_transform'] = _TRANSFORMS[utility]
        return
    if utility.startswith('min-h-'):
        utility = utility.removeprefix('min-')
    head, _, rest = utility.partition('-')
    if head in _SIDES:
        _padding_utility(head, rest, theme, box)
    elif head == 'border' and rest[:2] in ('t-', 'b-', 'l-', 'r-', 'x-', 'y-'):
        return  # one side only: not the component's border
    elif head in _HANDLERS:
        _HANDLERS[head](rest, theme, box)


def _split_prefixes(token: str) -> tuple[list[str], str]:
    """``hover:bg-x`` → (['hover'], 'bg-x'); colons inside ``[…]`` are part of the utility."""
    depth, cut = 0, -1
    for i, char in enumerate(token):
        depth += (char == '[') - (char == ']')
        if char == ':' and depth == 0:
            cut = i
    return (token[:cut].split(':'), token[cut + 1:]) if cut >= 0 else ([], token)


def styles_from_classes(classes: str, theme: Theme) -> tuple[dict[str, str], dict[str, str]]:
    """``(styles, hover)`` for a Tailwind class list (later utilities win, like Tailwind's cascade)."""
    base, hover = _Box(), _Box()
    for raw in classes.split():
        prefixes, utility = _split_prefixes(raw.strip().lstrip('!'))
        if '/' in utility.split('[')[0] or '${' in utility:
            continue  # an opacity modifier or an interpolation: not a plain value
        if not prefixes:
            _apply_utility(utility, theme, base)
        elif prefixes == ['hover']:
            _apply_utility(utility, theme, hover)
    hover_styles = {k: v for k, v in hover.finish().items() if k in _HOVER_KEYS}
    return base.finish(), hover_styles


# ── Source → components ─────────────────────────────────────────────────────

def _is_class_list(text: str) -> bool:
    return bool(_UTILITY_HINT_RE.search(text)) and len(text.split()) >= 2


def _static_part(template: str) -> str:
    """A template literal without its ``${…}`` interpolations."""
    return re.sub(r'\$\{[^{}]*(\{[^{}]*\}[^{}]*)*\}', ' ', template)


def _block(text: str, start: int) -> str:
    """The ``{…}`` block whose opening brace is at ``start`` (balanced), or the rest of ``text``."""
    depth = 0
    for i in range(start, len(text)):
        depth += (text[i] == '{') - (text[i] == '}')
        if depth == 0:
            return text[start:i + 1]
    return text[start:]


def _string_maps(text: str) -> dict[str, list[tuple[str, str]]]:
    """``const NAME = {key: 'classes', …}`` maps whose values are class lists."""
    maps: dict[str, list[tuple[str, str]]] = {}
    for match in _MAP_RE.finditer(text):
        entries = [(k, v) for k, _q, v in _MAP_ENTRY_RE.findall(_block(text, match.end() - 1)) if _is_class_list(v)]
        if len(entries) >= 2:
            maps[match.group(1)] = entries[:MAX_VARIANTS]
    return maps


def _cva_maps(text: str) -> dict[str, tuple[str, list[tuple[str, str]]]]:
    """``const fooVariants = cva(base, {variants: {variant: {…}}})`` → (base, the first variant group)."""
    found: dict[str, tuple[str, list[tuple[str, str]]]] = {}
    for match in _CVA_RE.finditer(text):
        rest = text[match.end():]
        group = _CVA_VARIANTS_RE.search(rest)
        entries: list[tuple[str, str]] = []
        if group:
            variants = _block(rest, group.end() - 1)
            inner = re.search(r'\{', variants[1:])
            if inner:
                first = _block(variants, inner.start() + 1)
                entries = [(k, v) for k, _q, v in _MAP_ENTRY_RE.findall(first[1:])][:MAX_VARIANTS]
        found[match.group(1)] = (match.group(3), entries)
    return found


def _ternary_variants(chunk: str) -> list[tuple[str, str]]:
    """``a ? 'x' : b === 'k' ? 'y' : 'z'`` → [(a, x), (k, y), (default, z)] — class-list branches only."""
    branches = [(m.group(2) or m.group(3), m.group(5)) for m in _TERNARY_RE.finditer(chunk) if _is_class_list(m.group(5))]
    if not branches:
        return []
    tail = chunk[chunk.rfind(branches[-1][1]) + len(branches[-1][1]):]
    otherwise = _ELSE_RE.search(tail)
    if otherwise and _is_class_list(otherwise.group(2)):
        branches.append(('default', otherwise.group(2)))
    return branches[:MAX_VARIANTS]


def _chunks(text: str) -> list[tuple[str, str]]:
    """``(ExportedComponentName, its source)`` for every exported PascalCase declaration."""
    starts = list(_DECLARATION_RE.finditer(text))
    out = []
    for i, match in enumerate(starts):
        name = match.group(4)
        if match.group(1) and name[:1].isupper():
            end = starts[i + 1].start() if i + 1 < len(starts) else len(text)
            out.append((name, text[match.start():end]))
    return out


def _label(name: str) -> str:
    words = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', name).split()
    text = ' '.join(words).lower()
    label = text[:1].upper() + text[1:]
    return NAME_ALIASES.get(label, label)


def _utility_count(text: str) -> int:
    return sum(1 for token in text.split() if _UTILITY_HINT_RE.search(f' {token}'))


def _base_classes(chunk: str, branch_texts: set[str]) -> str:
    """The component's richest class literal that is not a variant branch (its root element's classes)."""
    candidates = [_static_part(next(g for g in m.groups() if g is not None)) for m in _STRING_RE.finditer(chunk)]
    lists = [c for c in candidates if c not in branch_texts and _is_class_list(c)]
    return max(lists, key=_utility_count, default='')


def _variant(name: str, base: str, extra: str, theme: Theme) -> dict:
    styles, hover = styles_from_classes(f'{base} {extra}', theme)
    variant: dict = {'name': name, 'styles': styles}
    if hover:
        variant['hover'] = hover
    return variant


def _component(name: str, chunk: str, theme: Theme, maps: dict, cvas: dict) -> dict | None:
    cva_name = next((n for n in cvas if re.search(rf'\b{n}\s*\(', chunk)), None)
    map_name = next((n for n in maps if re.search(rf'\b{n}\s*\[', chunk)), None)
    if cva_name:
        base, branches = cvas[cva_name]
    else:
        branches = maps[map_name] if map_name else _ternary_variants(chunk)
        base = _base_classes(chunk, {b for _, b in branches})
    pairs = branches or [('default', '')]
    variants = [_variant(v, base, extra, theme) for v, extra in pairs]
    variants = [v for v in variants if v['styles'] or v.get('hover')]
    return {'name': _label(name), 'description': '', 'variants': variants} if variants else None


def components_from_source(text: str, path: str, theme: Theme) -> list[dict]:
    """The components one UI source file defines, with their variants' styles (raw, uncleaned)."""
    maps, cvas = _string_maps(text), _cva_maps(text)
    chunks = _chunks(text)
    out: list[dict] = []
    for name, chunk in chunks:
        component = _component(name, chunk, theme, maps, cvas)
        if component and component['name'].lower() not in {c['name'].lower() for c in out}:
            out.append(component)
        if len(out) == MAX_COMPONENTS_PER_FILE:
            break
    stem = PurePosixPath(path).stem
    if len(out) == 1 and stem.lower() != 'ui':
        out[0]['name'] = _label(stem.replace('-', ' ').replace('_', ' ').title().replace(' ', ''))
    return out
