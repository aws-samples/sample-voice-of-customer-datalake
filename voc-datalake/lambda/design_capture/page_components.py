"""Design components MEASURED in a live page (pure; no AWS, no network).

``page_styles.STYLES_JS`` returns, per kind, up to 3 samples of computed styles (already in THE
CONTRACT's keys, shared/design_components.py) with a trimmed ``outerHTML``, and the ``:hover`` /
``:focus`` rules of the same-origin stylesheets. ``parse_components`` / ``parse_rules`` re-cap that
untrusted answer; ``measured_components`` turns it into contract components — the fallback when the
vision model returns none, and the source of ``example_html`` (sanitised by
``shared.html_sanitizer``) for a model component of the same name that has none.

Computed values are normalised first: fractional pixels are rounded (``13.3333px`` → ``13.33px``),
four equal paddings collapse, and defaults that say nothing (``0px`` gaps, ``none`` shadows, ``auto``)
are left out. A ``:hover`` rule whose selector names one of a sample's classes goes on that variant;
an element selector (``button:hover``) on every variant of its component.
"""
from __future__ import annotations

import re
from typing import Any, Final

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


def _rule_kind(selector: str) -> str | None:
    return next((kind for kind, pattern in _RULE_TARGETS if pattern.search(selector)), None)


def _rule_applies(selector: str, classes: set[str]) -> bool:
    """A class selector applies to a sample carrying that class; an element selector to every sample."""
    named = set(re.findall(r'\.([\w-]+)', selector))
    return not named or bool(named & classes)


def _state_styles(rules: list[dict], kind: str, classes: set[str]) -> tuple[dict[str, str], dict[str, str]]:
    hover: dict[str, str] = {}
    focus: dict[str, str] = {}
    for rule in rules:
        if _rule_kind(rule['selector']) != kind or not _rule_applies(rule['selector'], classes):
            continue
        if rule['state'] == 'hover':
            hover.update({k: v for k, v in rule['styles'].items() if k in HOVER_KEYS and k not in hover})
        elif 'outline' in rule['styles'] and 'outline' not in focus:
            focus['outline'] = rule['styles']['outline']
    return hover, focus


def _variant_name(kind: str, sample: dict[str, str], index: int) -> str:
    if kind == 'buttons' and sample.get('variant') in BUTTON_VARIANT_NAMES:
        return BUTTON_VARIANT_NAMES[sample['variant']]
    return 'default' if index == 0 else f'variant {index + 1}'


def measured_components(samples: dict[str, list[dict[str, str]]], rules: list[dict]) -> list[dict]:
    """Contract components from the page's measured samples and state rules (validated, ≤ 30)."""
    raw: list[dict] = []
    for kind, rows in samples.items():
        variants = []
        for i, sample in enumerate(rows):
            hover, focus = _state_styles(rules, kind, _classes(sample.get('html', '')))
            variant: dict[str, Any] = {'name': _variant_name(kind, sample, i), 'styles': _styles(sample)}
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


def with_measured_examples(design: dict | None, measured: list[dict]) -> dict | None:
    """``design`` whose components without ``example_html`` borrow the measured one of the same name."""
    if not isinstance(design, dict) or not measured:
        return design
    examples = {c['name'].lower(): c['example_html'] for c in measured if c.get('example_html')}
    components = [
        c if c.get('example_html') or c['name'].lower() not in examples
        else {**c, 'example_html': examples[c['name'].lower()]}
        for c in design.get('components') or []
    ]
    return {**design, 'components': components}
