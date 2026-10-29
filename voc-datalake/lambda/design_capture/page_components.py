"""Design components MEASURED in a live page (pure; no AWS, no network).

``page_styles.STYLES_JS`` returns, per kind, up to 3 samples of computed styles (already in THE
CONTRACT's keys, shared/design_components.py) with a trimmed ``outerHTML``, and the ``:hover`` /
``:focus`` rules of the same-origin stylesheets. ``parse_components`` / ``parse_rules`` re-cap that
untrusted answer; ``measured_components`` turns it into contract components, which
``shared.component_overlay`` puts over the vision model's (measured styles and rule hovers win).

Computed values are normalised first: fractional pixels are rounded (``13.3333px`` → ``13.33px``),
four equal paddings collapse, and defaults that say nothing (``0px`` gaps, ``none`` shadows, ``auto``)
are left out. Filled buttons are one variant PER BACKGROUND (``primary`` for a coloured one, ``inverse``
for a light neutral one, ``neutral`` for a dark one — kiromail: the purple call-to-action and the white
nav button). A state rule goes on a sample only when the rule's SUBJECT (the part after the last
combinator, pseudo-elements excluded) matches it: its classes are all on the element and its tag, when
it names one, is the element's tag; an element subject under an ancestor (``.site-nav a:hover``) is
skipped, the ancestry being unknown (5.35.02 live: the kiromail buttons carried hover colours of
other selectors). A subject with neither (``[role=tab]:focus``) applies to every sample of the rule's kind.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any, Final

from shared.css_color_mix import parse_color
from shared.design_components import HOVER_KEYS, clean_components

COMPONENT_NAMES: Final = {
    'buttons': 'Button', 'links': 'Link', 'inputs': 'Input', 'cards': 'Card', 'nav': 'Nav bar', 'tabs': 'Tabs',
    'badges': 'Badge', 'tables': 'Table', 'modals': 'Dialog',
}
BUTTON_VARIANT_NAMES: Final = {'filled': 'primary', 'outlined': 'outline', 'text': 'ghost'}
#: Which kinds a state rule's selector may style (by word).
_RULE_TARGETS: Final = (
    ('buttons', re.compile(r'\b(button|btn)', re.IGNORECASE)),
    ('tabs', re.compile(r'\btab\b|role=.?tab', re.IGNORECASE)),
    ('inputs', re.compile(r'\b(input|textarea|select)\b', re.IGNORECASE)),
    ('cards', re.compile(r'card', re.IGNORECASE)),
    ('badges', re.compile(r'\b(badge|chip|pill)', re.IGNORECASE)),
    ('links', re.compile(r'(^|[\s,>+~])a([:.\[\s]|\Z)|\blink\b', re.IGNORECASE)),
    ('nav', re.compile(r'\bnav\b', re.IGNORECASE)),
)
SAMPLE_KEYS: Final = ('background', 'color', 'border_color', 'border_width', 'radius', 'padding', 'gap', 'height',
                      'font_family', 'font_size', 'font_weight', 'letter_spacing', 'text_transform', 'shadow')
RULE_KEYS: Final = ('background', 'color', 'border_color', 'shadow', 'outline')
FOCUS_RULE_KEYS: Final = ('outline', 'border_color', 'shadow')
#: Caps shared with the page (page_styles.PAGE_LIMITS hands them to STYLES_JS).
MAX_KIND_CANDIDATES: Final = 60
MAX_SAMPLES: Final = 3
MAX_RULES: Final = 30
MAX_VALUE_CHARS: Final = 300
MAX_SNIPPET_CHARS: Final = 600
_FRACTION_RE: Final = re.compile(r'(\d+\.\d{2})\d+(px|rem|em)')
#: Computed values that say nothing about the design, per key.
_SILENT: Final = {'gap': ('0px', 'normal', 'auto'), 'height': ('auto',), 'shadow': ('none',)}
_CLASS_RE: Final = re.compile(r'class="([^"]*)"')
_TAG_RE: Final = re.compile(r'^<([a-z][a-z0-9]{0,20})\b', re.IGNORECASE)
#: The subject compound of a selector: everything after the last descendant/child/sibling combinator.
_COMBINATOR_RE: Final = re.compile(r'\s*[\s>+~]\s*')
_SUBJECT_TAG_RE: Final = re.compile(r'^([a-z][a-z0-9]{0,20})', re.IGNORECASE)
_SUBJECT_CLASS_RE: Final = re.compile(r'\.([\w-]{1,80})')
_NEUTRAL_SPREAD: Final = 24
_LIGHT_LEVEL: Final = 160


# ── Parsing (re-capping the page's answer) ──────────────────────────────────

def _text(value: object, limit: int) -> str:
    return str(value)[:limit] if isinstance(value, (str, int, float)) and not isinstance(value, bool) else ''


def _sample(raw: object) -> dict[str, str] | None:
    if not isinstance(raw, dict):
        return None
    sample = {key: _text(raw.get(key), MAX_VALUE_CHARS) for key in SAMPLE_KEYS}
    sample['html'] = _text(raw.get('html'), MAX_SNIPPET_CHARS)
    variant = raw.get('variant')
    if variant in BUTTON_VARIANT_NAMES:
        sample['variant'] = str(variant)
    return sample


def parse_components(raw: object) -> dict[str, list[dict[str, str]]]:
    """``{kind: [sample, …]}`` for the known kinds only, ≤ 3 samples each, every value capped."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, list[dict[str, str]]] = {}
    for kind in COMPONENT_NAMES:
        rows = raw.get(kind)
        samples = [s for s in (_sample(r) for r in rows[:MAX_SAMPLES]) if s] if isinstance(rows, list) else []
        if samples:
            out[kind] = samples
    return out


def parse_rules(raw: object) -> list[dict[str, Any]]:
    """``[{selector, state, styles}]`` — ≤ 30 hover / focus rules with their known declarations only."""
    rows = raw if isinstance(raw, list) else []
    out: list[dict[str, Any]] = []
    for row in rows[:MAX_RULES]:
        if not isinstance(row, dict) or row.get('state') not in ('hover', 'focus', 'focus-visible'):
            continue
        styles_raw = row.get('styles')
        styles = {k: _text(styles_raw.get(k), MAX_VALUE_CHARS) for k in RULE_KEYS
                  if isinstance(styles_raw, dict) and _text(styles_raw.get(k), MAX_VALUE_CHARS)}
        if styles:
            out.append({'selector': _text(row.get('selector'), 200), 'state': row['state'], 'styles': styles})
    return out


# ── Samples → components ────────────────────────────────────────────────────

def _normalise(key: str, value: str) -> str | None:
    text = _FRACTION_RE.sub(r'\1\2', value.strip())
    if not text or text in _SILENT.get(key, ()):
        return None
    if key == 'padding':
        parts = text.split()
        if len(parts) == 4 and parts[0] == parts[2] and parts[1] == parts[3]:
            parts = [parts[0]] if parts[0] == parts[1] else parts[:2]
        text = ' '.join(parts)
    return text


def _styles(sample: dict[str, str]) -> dict[str, str]:
    return {key: norm for key in SAMPLE_KEYS if (norm := _normalise(key, sample.get(key, ''))) is not None}


def _classes(html: str) -> set[str]:
    match = _CLASS_RE.search(html)
    return set(match.group(1).split()) if match else set()


def _tag(html: str) -> str:
    match = _TAG_RE.match(html.strip())
    return match.group(1).lower() if match else ''


def _rule_kind(selector: str) -> str | None:
    return next((kind for kind, pattern in _RULE_TARGETS if pattern.search(selector)), None)


def _subject(part: str) -> tuple[str, bool]:
    """``(subject compound, has ancestors)`` of one selector (``.nav a:hover`` → ``('a:hover', True)``);
    the subject is '' for a pseudo-element (``.btn:hover::before`` styles the pseudo-element, not the button)."""
    pieces = [p for p in _COMBINATOR_RE.split(part.strip()) if p]
    subject = pieces[-1] if pieces else ''
    if '::' in subject or re.search(r':(before|after)\b', subject):
        subject = ''
    return subject, len(pieces) > 1


def _part_applies(part: str, sample_kind: str, classes: set[str], tag: str) -> bool:
    """A class subject applies when all its classes are on the element (and its tag, if named, matches); a
    bare element subject (``button:hover``) only without ancestors — whether the element sits inside
    ``.site-nav`` is not known; a subject with neither applies to the rule's kind."""
    subject, nested = _subject(part)
    if not subject:
        return False
    named = set(_SUBJECT_CLASS_RE.findall(subject))
    tag_match = _SUBJECT_TAG_RE.match(subject)
    if named:
        return named <= classes and (tag_match is None or tag_match.group(1).lower() == tag)
    if tag_match:
        return not nested and tag_match.group(1).lower() == tag
    return not nested and _rule_kind(part) == sample_kind


def _rule_applies(selector: str, sample_kind: str, classes: set[str], tag: str = '') -> bool:
    """Whether a state rule styles this sample: one of its comma-separated selectors' subject matches it."""
    return any(_part_applies(part, sample_kind, classes, tag) for part in selector.split(','))


def _state_styles(rules: list[dict], kind: str, html: str) -> tuple[dict[str, str], dict[str, str]]:
    classes, tag = _classes(html), _tag(html)
    hover: dict[str, str] = {}
    focus: dict[str, str] = {}
    for rule in rules:
        if not _rule_applies(rule['selector'], kind, classes, tag):
            continue
        target, keys = (hover, HOVER_KEYS) if rule['state'] == 'hover' else (focus, FOCUS_RULE_KEYS)
        target.update({k: v for k, v in rule['styles'].items() if k in keys and k not in target})
    return hover, focus


def _filled_name(background: str) -> str:
    """``primary`` for a coloured fill, ``inverse`` for a light neutral one, ``neutral`` for a dark one."""
    color = parse_color(background)
    if color is None:
        return 'primary'
    red, green, blue = color[0], color[1], color[2]
    if max(red, green, blue) - min(red, green, blue) > _NEUTRAL_SPREAD:
        return 'primary'
    return 'inverse' if (red + green + blue) / 3 >= _LIGHT_LEVEL else 'neutral'


def _variant_name(kind: str, sample: dict[str, str], index: int) -> str:
    variant = sample.get('variant')
    if kind == 'buttons' and variant == 'filled':
        return _filled_name(sample.get('background', ''))
    if kind == 'buttons' and variant in BUTTON_VARIANT_NAMES:
        return BUTTON_VARIANT_NAMES[variant]
    return 'default' if index == 0 else f'variant {index + 1}'


def _unique(name: str, taken: set[str]) -> str:
    candidate, n = name, 2
    while candidate in taken:
        candidate, n = f'{name} {n}', n + 1
    taken.add(candidate)
    return candidate


def measured_components(samples: dict[str, list[dict[str, str]]], rules: list[dict],
                        resolve: Callable[[str], str] = str) -> list[dict]:
    """Contract components from the page's measured samples and state rules (validated, ≤ 30).

    A stylesheet rule reports its SPECIFIED values (``color: var(--black)``), so ``resolve`` (the page's
    ``:root`` custom properties, ``Theme.resolve_vars``) turns them into colours first.
    """
    rules = [{**rule, 'styles': {k: resolve(v) for k, v in rule['styles'].items()}} for rule in rules]
    raw: list[dict] = []
    for kind, rows in samples.items():
        variants = []
        taken: set[str] = set()
        for i, sample in enumerate(rows):
            hover, focus = _state_styles(rules, kind, sample.get('html', ''))
            name = _unique(_variant_name(kind, sample, i), taken)
            variant: dict[str, Any] = {'name': name, 'styles': _styles(sample)}
            if hover:
                variant['hover'] = hover
            if focus:
                variant['focus'] = focus
            variants.append(variant)
        component: dict[str, Any] = {'name': COMPONENT_NAMES[kind], 'description': '', 'variants': variants}
        snippet = next((s['html'] for s in rows if s.get('html')), '')
        if snippet:
            component['example_html'] = snippet
        raw.append(component)
    return clean_components(raw)
