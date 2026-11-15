"""A prototype's guided walkthrough: its steps, in the version's HTML (docs/prototype-builder.md, Part 1).

One copy of the steps, the one that runs: a JSON data block (``<script type="application/json"
id="voc-walkthrough-steps">``, never executed) followed by the walkthrough runtime
(``static/prototype-walkthrough.js``), both injected by the server before ``</body>`` between
``WALKTHROUGH_START`` and ``WALKTHROUGH_END``, as the pin widget is. No row field holds them.

* **Validation** (``validate_steps``): 0 to ``MAX_STEPS`` steps, each ``{title, body, selector?, anchor?}``
  with at least one of selector / anchor (``{route?, bbox}``: the route is the hash of the prototype's location
  without ``#``, ``""`` for any screen, as the runtime compares it; one leading ``#`` is dropped), the caps
  below, the text screened (``injection_findings``: an editor or a model wrote it, and people and tools read
  it back through the GET and MCP), unknown keys dropped; a 400 names the step and the field.
* **Injection** (``inject_walkthrough``): every ``<`` of the JSON written as its JSON escape, so step text
  can neither close the data block nor open a tag. Every version the server writes gets the block, with
  ``{"steps":[]}`` when it has none (the runtime holds the editor's element picker and starts nothing with no
  steps); a draft's object gets none (no bridge reaches a draft's frame).
* **Stripping** (``strip_walkthrough``): every block, every lone marker and any steps data block, repeated
  until nothing changes (nested markers cannot rebuild a block). Applied to every model output before it is
  stored, so the only block a stored object holds is one the server injected, and to any HTML a model is given.
* **Reading** (``extract_steps``): only the last block between the markers (the server's, just before
  ``</body>``), re-validated; one that fails gives no steps.
"""
from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Final

from shared.exceptions import ValidationError
from shared.prompt_safety import injection_findings

WALKTHROUGH_START: Final = '<!-- voc-walkthrough:start -->'
WALKTHROUGH_END: Final = '<!-- voc-walkthrough:end -->'
STEPS_SCRIPT_ID: Final = 'voc-walkthrough-steps'
MAX_STEPS: Final = 10
MAX_TITLE_CHARS: Final = 80
MAX_BODY_CHARS: Final = 280
MAX_SELECTOR_CHARS: Final = 512  # the pins' selector cap (prototype_pins.MAX_SELECTOR_CHARS)
MAX_ROUTE_CHARS: Final = 300  # the pins' route cap (prototype_pins.MAX_ROUTE_CHARS)
RUNTIME_PATH: Final = Path(__file__).parent / 'static' / 'prototype-walkthrough.js'

_BLOCK_RE: Final = re.compile(re.escape(WALKTHROUGH_START) + r'.*?' + re.escape(WALKTHROUGH_END) + r'\n?', re.DOTALL)
_MARKER_RE: Final = re.compile(r'<!--\s*voc-walkthrough:(?:start|end)\s*-->', re.IGNORECASE)
_STEPS_RE: Final = re.compile(
    r'<script type="application/json" id="' + STEPS_SCRIPT_ID + r'">(.*?)</script>', re.DOTALL)
# Any script element naming the steps' id, however written (a model's decoy outside the markers).
_DECOY_RE: Final = re.compile(
    r'<script\b[^>]*\bid\s*=\s*["\']?' + STEPS_SCRIPT_ID + r'\b[^>]*>.*?</script\s*>', re.IGNORECASE | re.DOTALL)
_BBOX_KEYS: Final = ('x', 'y', 'w', 'h')
# A "<" in the data block, as JSON writes it escaped (six characters: backslash, u, 0, 0, 3, c).
_LT_ESCAPE: Final = '\\u003c'


# What the runtime may never contain: inlined in a script element, ``</script`` would end it (the rest would
# render as page text), and a comment opener or a marker would make the block's own boundaries ambiguous.
_RUNTIME_FORBIDDEN: Final = re.compile(r'</script|<!--|voc-walkthrough:(?:start|end)', re.IGNORECASE)


def runtime_source() -> str:
    """The walkthrough runtime the block runs (a static, self-contained script, as the pin widget is).

    Refused (a RuntimeError) when it holds anything that would break the block it is inlined into.
    """
    source = RUNTIME_PATH.read_text(encoding='utf-8')
    found = _RUNTIME_FORBIDDEN.search(source)
    if found:
        raise RuntimeError(f'static/prototype-walkthrough.js must not contain {found.group(0)!r}: it is inlined in a '
                           'script element between the walkthrough markers')
    return source


def _text(step: Mapping[str, Any], key: str, limit: int, number: int) -> str:
    value = step.get(key)
    text = ' '.join(value.split()) if isinstance(value, str) else ''
    if not text:
        raise ValidationError(f'step {number}: {key} is required')
    if len(text) > limit:
        raise ValidationError(f'step {number}: {key} must be at most {limit} characters')
    if injection_findings(text):
        raise ValidationError(f'step {number}: {key} reads like an instruction to the AI; rephrase it')
    return text


def _share(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return None
    return float(value) if 0 <= value <= 1 else None


def _anchor(raw: object, number: int) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise ValidationError(f'step {number}: anchor must be an object with a bbox')
    bbox = raw.get('bbox')
    shares = {key: _share(bbox.get(key)) for key in _BBOX_KEYS} if isinstance(bbox, Mapping) else {}
    if len(shares) != len(_BBOX_KEYS) or any(value is None for value in shares.values()):
        raise ValidationError(f'step {number}: anchor.bbox needs x, y, w and h, each a share of the viewport (0 to 1)')
    anchor: dict[str, Any] = {'bbox': shares}
    route = raw.get('route')
    if route is not None:
        # The runtime compares the location's hash without its '#': one written with it would never match.
        route = route[1:] if isinstance(route, str) and route.startswith('#') else route
        if not isinstance(route, str) or len(route) > MAX_ROUTE_CHARS:
            raise ValidationError(f'step {number}: anchor.route must be text of at most {MAX_ROUTE_CHARS} characters')
        if injection_findings(route):
            raise ValidationError(f'step {number}: anchor.route reads like an instruction to the AI')
        anchor['route'] = route
    return anchor


def _step(raw: object, number: int) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise ValidationError(f'step {number}: must be an object')
    step: dict[str, Any] = {'title': _text(raw, 'title', MAX_TITLE_CHARS, number),
                            'body': _text(raw, 'body', MAX_BODY_CHARS, number)}
    selector = raw.get('selector')
    if selector is not None:
        if not isinstance(selector, str) or not selector.strip() or len(selector) > MAX_SELECTOR_CHARS:
            raise ValidationError(f'step {number}: selector must be text of 1 to {MAX_SELECTOR_CHARS} characters')
        if injection_findings(selector):
            raise ValidationError(f'step {number}: selector reads like an instruction to the AI')
        step['selector'] = selector.strip()
    if raw.get('anchor') is not None:
        step['anchor'] = _anchor(raw['anchor'], number)
    if 'selector' not in step and 'anchor' not in step:
        raise ValidationError(f'step {number}: needs a selector or an anchor')
    return step


def validate_steps(raw: object) -> list[dict[str, Any]]:
    """0 to MAX_STEPS valid steps (unknown keys dropped, text whitespace collapsed); else a 400 naming step and field."""
    if not isinstance(raw, list):
        raise ValidationError('steps must be a list')
    if len(raw) > MAX_STEPS:
        raise ValidationError(f'at most {MAX_STEPS} steps are allowed')
    return [_step(step, number) for number, step in enumerate(raw, start=1)]


def strip_walkthrough(html: str) -> str:
    """``html`` without any walkthrough block, lone marker or steps data block a model may have written.

    Repeated until nothing changes: one pass over nested markers (a marker written inside a marker) would
    leave the outer one whole and rebuild a fake block. A steps data block without markers (a decoy) goes too.
    Each pass that changes anything shortens the text, so the loop ends.
    """
    current = html or ''
    while True:
        cleaned = _DECOY_RE.sub('', _MARKER_RE.sub('', _BLOCK_RE.sub('', current)))
        if cleaned == current:
            return cleaned
        current = cleaned


def walkthrough_block(steps: list[dict[str, Any]]) -> str:
    """The block for ``steps`` (already valid): the data block, then the runtime and its start call."""
    data = json.dumps({'steps': steps}, ensure_ascii=False, separators=(',', ':')).replace('<', _LT_ESCAPE)
    return (
        f'{WALKTHROUGH_START}\n<script type="application/json" id="{STEPS_SCRIPT_ID}">{data}</script>\n'
        f'<script>\n{runtime_source()}\nwindow.VoCWalkthrough && window.VoCWalkthrough.init();\n</script>\n'
        f'{WALKTHROUGH_END}'
    )


def inject_walkthrough(html: str, steps: list[dict[str, Any]]) -> str:
    """``html`` with its walkthrough replaced by ``steps``, before its last ``</body>``.

    The block goes into every version, ``{"steps":[]}`` when it has none: the editor's element picker
    lives in the runtime, and with no steps the runtime starts nothing.
    """
    clean = strip_walkthrough(html)
    block = walkthrough_block(steps)
    index = clean.lower().rfind('</body>')
    if index == -1:
        return f'{clean}\n{block}\n'
    return f'{clean[:index]}{block}\n{clean[index:]}'


def extract_steps(html: str) -> list[dict[str, Any]]:
    """The steps of the injected block, re-validated; ``[]`` for no block or one that fails validation.

    Only the LAST block is read: the server injects its own just before ``</body>``, after anything a model
    wrote (which the stripping removes before every store anyway).
    """
    text = html or ''
    end = text.rfind(WALKTHROUGH_END)
    start = text.rfind(WALKTHROUGH_START, 0, end) if end != -1 else -1
    data = _STEPS_RE.search(text[start:end]) if start != -1 else None
    if data is None:
        return []
    try:
        parsed = json.loads(data.group(1))
        return validate_steps(parsed.get('steps') if isinstance(parsed, dict) else None)
    except (ValueError, ValidationError):
        return []
