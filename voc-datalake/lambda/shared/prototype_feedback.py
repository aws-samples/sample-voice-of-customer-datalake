"""A prototype series' feedback, grouped and deduplicated (docs/prototype-builder.md, Part 3).

"The feedback" is the prototype's own pins: the pins of every version's pin form
(``prototype_pins.pin_form_id``) and their replies. Nothing else, and no model:

* ``read_feedback`` reads the series (``document_history.series_versions``, newest
  first), at most the newest ``VERSION_LIST_LIMIT`` versions, one pin query per
  version (``prototype_pins.list_pins``, which stops at ``MAX_PINS_LISTED``), and
  says so in ``partial``: each version whose list reached the cap is in ``cut``,
  and ``older_versions_unread`` counts the versions it did not read.
* ``group_pins`` groups them by screen (the pin's route), then folds the pins at
  the same position whose texts match into one item ("3 testers said this").
  Deterministic: the pins are sorted by (route, selector, created_at, pin_id)
  first, so the same pins in any order give the same answer.

The answer carries flagged (instruction-shaped) items' text and replies: the route
is read at EDIT and the editor sees them. The tools that hand it to a model leave
that text out (``mcp_global_tools``' projection).
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from decimal import Decimal
from typing import Any, Final

from shared import prototype_pins
from shared.document_history import VERSION_LIST_LIMIT, series_versions
from shared.dynamo_values import as_text
from shared.exceptions import ValidationError
from shared.text_clip import collapse_whitespace

# Two selector-less pins are at one position when their bounding-box centres are within this
# share of the viewport of each other on both axes. The stored bbox is already in percent of
# the tester's viewport (``pct`` in static/prototype-pin-widget.js), so the centre's share of it
# is its left edge plus half its width, over a hundred (and the same down).
POSITION_TOLERANCE: Final = 0.05
# Two normalised texts match when they are equal or their word sets overlap this much (Jaccard).
TEXT_SIMILARITY: Final = 0.8
CUT_REASON_PIN_CAP: Final = 'pin_cap'

_PUNCTUATION_RE: Final = re.compile(r'[^\w\s]')
_REPLY_FIELDS: Final = ('by', 'name', 'text', 'at')


# ── Normalising ─────────────────────────────────────────────────────────────

def normalised_text(text: object) -> str:
    """Lower case, punctuation dropped, whitespace collapsed."""
    if not isinstance(text, str):
        return ''
    return collapse_whitespace(_PUNCTUATION_RE.sub('', text.lower()))


def texts_match(first: object, second: object) -> bool:
    """Equal after normalising, or a word-set Jaccard of at least ``TEXT_SIMILARITY``."""
    left, right = normalised_text(first), normalised_text(second)
    if left == right:
        return True
    left_words, right_words = set(left.split()), set(right.split())
    union = left_words | right_words
    return bool(union) and len(left_words & right_words) / len(union) >= TEXT_SIMILARITY


def _anchor(pin: Mapping[str, Any]) -> Mapping[str, Any]:
    anchor = pin.get('anchor')
    return anchor if isinstance(anchor, Mapping) else {}


def _number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return 0.0
    return float(value)


def _centre(pin: Mapping[str, Any]) -> tuple[float, float]:
    """The bbox centre as a share of the viewport (the bbox is stored in percent of it)."""
    raw = _anchor(pin).get('bbox')
    bbox = raw if isinstance(raw, Mapping) else {}
    x, y, w, h = (_number(bbox.get(key)) for key in ('x', 'y', 'w', 'h'))
    return (x + w / 2) / 100, (y + h / 2) / 100


def same_position(first: Mapping[str, Any], second: Mapping[str, Any]) -> bool:
    """Same route, and the same non-empty selector or, both without one, centres within 5 %."""
    a, b = _anchor(first), _anchor(second)
    if as_text(a, 'route') != as_text(b, 'route'):
        return False
    a_selector, b_selector = as_text(a, 'selector'), as_text(b, 'selector')
    if a_selector or b_selector:
        return a_selector == b_selector
    (ax, ay), (bx, by) = _centre(first), _centre(second)
    # A float difference like 0.30 - 0.25 lands a hair over 0.05: compare it rounded to 6 places.
    return round(abs(ax - bx), 6) <= POSITION_TOLERANCE and round(abs(ay - by), 6) <= POSITION_TOLERANCE


# ── Grouping ────────────────────────────────────────────────────────────────

def _sort_key(pin: Mapping[str, Any]) -> tuple[str, str, str, str, str]:
    anchor = _anchor(pin)
    return (as_text(anchor, 'route'), as_text(anchor, 'selector'), as_text(pin, 'created_at'),
            as_text(pin, 'pin_id'), as_text(pin, 'document_id'))


def _replies(pin: Mapping[str, Any]) -> list[dict]:
    raw = pin.get('replies')
    rows = raw if isinstance(raw, list) else []
    return [{key: reply.get(key) for key in _REPLY_FIELDS} for reply in rows if isinstance(reply, Mapping)]


def _version(pin: Mapping[str, Any]) -> int | None:
    value = pin.get('version')
    return int(value) if isinstance(value, (int, Decimal)) and not isinstance(value, bool) else None


def pin_view(pin: Mapping[str, Any]) -> dict:
    """One pin as the feedback answer lists it."""
    addressed_by = pin.get('addressed_by')
    return {
        'pin_id': as_text(pin, 'pin_id'),
        'document_id': as_text(pin, 'document_id'),
        'version': _version(pin),
        'status': as_text(pin, 'status') or prototype_pins.STATUS_OPEN,
        'created_at': as_text(pin, 'created_at'),
        'addressed_by': addressed_by if isinstance(addressed_by, str) and addressed_by else None,
        'flagged': bool(pin.get('flagged')),
        'text': as_text(pin, 'comment'),
        'replies': _replies(pin),
    }


def _new_item(pin: Mapping[str, Any]) -> dict:
    anchor = _anchor(pin)
    return {
        'item_id': as_text(pin, 'pin_id'),
        'pin_ids': [],
        'count': 0,
        'flagged': bool(pin.get('flagged')),
        'text': as_text(pin, 'comment'),
        'anchor': {key: as_text(anchor, key) for key in prototype_pins.ANCHOR_TEXT_FIELDS},
        # The fields a model must not get (the editor sees them): judged one by one, as the comment is.
        'unsafe_fields': prototype_pins.unsafe_anchor_fields(dict(anchor)),
        'first_at': as_text(pin, 'created_at'),
        'pins': [],
        '_first': pin,
    }


def _folds_into(item: dict, pin: Mapping[str, Any]) -> bool:
    first = item['_first']
    return (not item['flagged'] and same_position(first, pin)
            and texts_match(first.get('comment'), pin.get('comment')))


def group_pins(pins: Iterable[Mapping[str, Any]]) -> list[dict]:
    """The pins grouped by route ("" for none) and folded into items; the same pins in any order, the same answer.

    A pin folds into the FIRST earlier item of its route whose first pin is at the same position
    with a matching text; a flagged pin never folds and nothing folds into a flagged item.
    """
    groups: dict[str, list[dict]] = {}
    for pin in sorted(pins, key=_sort_key):
        items = groups.setdefault(as_text(_anchor(pin), 'route'), [])
        item = None if pin.get('flagged') else next((i for i in items if _folds_into(i, pin)), None)
        if item is None:
            item = _new_item(pin)
            items.append(item)
        item['pin_ids'].append(as_text(pin, 'pin_id'))
        item['pins'].append(pin_view(pin))
        item['count'] = len(item['pin_ids'])
    answer = []
    for route in sorted(groups):
        items = sorted(groups[route], key=lambda i: (i['anchor']['selector'], i['first_at'], i['item_id']))
        answer.append({'route': route, 'route_unsafe': 'route' in prototype_pins.unsafe_anchor_fields({'route': route}),
                       'items': [{k: v for k, v in i.items() if k != '_first'} for i in items]})
    return answer


# ── The series read ─────────────────────────────────────────────────────────

def checked_status(raw: object) -> str | None:
    """``?status``: None, or one of the pin statuses (else 400)."""
    if raw in (None, ''):
        return None
    if raw not in prototype_pins.STATUSES:
        raise ValidationError('status must be open, addressed or resolved')
    return str(raw)


def checked_version(raw: object) -> int | None:
    """``?version``: None, or a positive version number (else 400)."""
    if raw in (None, ''):
        return None
    if not isinstance(raw, str) or not (raw.isascii() and raw.isdecimal()) or len(raw) > 6 or int(raw) < 1:
        raise ValidationError('version must be a positive version number')
    return int(raw)


def _series(projects_table: Any, project_id: str, document: Mapping[str, Any]) -> list[dict[str, Any]]:
    """``[{document_id, version}]`` newest first; a row outside any series is its own version 1."""
    rows = series_versions(projects_table, project_id, dict(document))
    series = [{'document_id': str(row['document_id']), 'version': int(row['version'])}
              for row in rows if isinstance(row.get('document_id'), str)]
    if not any(entry['document_id'] == document.get('document_id') for entry in series):
        return [{'document_id': str(document.get('document_id')), 'version': _version(document) or 1}]
    return series


def read_feedback(projects_table: Any, pins_table: Any, project_id: str, document: Mapping[str, Any], *,
                  status: str | None = None, version: int | None = None) -> dict:
    """The series' feedback answer for the prototype row ``document`` (docs/prototype-builder.md, Part 3)."""
    series = _series(projects_table, project_id, document)
    if version is None:
        read = series[:VERSION_LIST_LIMIT]
        unread = len(series) - len(read)
    else:
        read = [entry for entry in series if entry['version'] == version]
        if not read:
            raise ValidationError('version is not a version of this prototype')
        unread = 0
    pins: list[dict] = []
    cut: list[dict] = []
    for entry in read:
        listed = prototype_pins.list_pins(pins_table, prototype_pins.pin_form_id(entry['document_id']), status)
        if len(listed) >= prototype_pins.MAX_PINS_LISTED:
            cut.append({**entry, 'reason': CUT_REASON_PIN_CAP})
        pins += [{**pin, **entry} for pin in listed]
    return {
        'document_id': str(document.get('document_id')),
        'versions_read': read,
        'partial': bool(cut) or unread > 0,
        'cut': cut,
        'older_versions_unread': unread,
        'pin_count': len(pins),
        'groups': group_pins(pins),
    }
