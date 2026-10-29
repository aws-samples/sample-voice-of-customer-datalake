"""Feedback board fields, statuses and templates (docs/feature-requests.md -> Templates and fields).

The ONE place that knows which fields a board may ask for and how a value is checked. Routes,
the board store and the totals all read it. The SPA mirrors the constants in
``frontend/src/api/boardFields.ts``, whose lockstep test reads THIS file as text: every constant
below up to ``# ── Validation`` is one top-level ``NAME: Final = <literal>`` (strings, numbers,
booleans, tuples and dicts of those only), so keep them that way.

A board's ``fields`` is ``{'request': {key: {enabled, required}}, 'support': {key: {...}}}`` over the
two fixed catalogues (no free-form schemas). Title and description are always on; the description
is required only on the templates in ``DESCRIPTION_REQUIRED_TEMPLATES`` (a sales request says what the
customer needs, a service issue what happened; beta feedback and a blank board may be a title). A request
stores its values in ``fields`` on META; a support (+1) stores its values as top-level attributes
(the shape supports had before boards, so old rows read unchanged) and shows them as ``fields``.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Final
from urllib.parse import urlsplit

from shared.engagement_common import normalize_email, optional_text
from shared.exceptions import ValidationError

TEMPLATES: Final = ('sales', 'service', 'beta', 'blank')
DESCRIPTION_REQUIRED_TEMPLATES: Final = ('sales', 'service')
LEVELS: Final = ('request', 'support')
REQUEST_FIELD_KEYS: Final = (
    'customer', 'deal', 'impact', 'amount_usd', 'contact_email', 'kind', 'severity', 'reference', 'steps',
    'affected_count', 'area', 'outcome', 'rating', 'link',
)
SUPPORT_FIELD_KEYS: Final = ('customer', 'deal', 'impact', 'amount_usd', 'contact_email', 'note')
TEXT_FIELD_LIMITS: Final = {
    'customer': 160, 'deal': 160, 'reference': 80, 'steps': 2000, 'area': 80, 'note': 1000,
}
CHOICE_FIELD_OPTIONS: Final = {
    'impact': ('committed', 'at_risk', 'none'),
    'kind': ('bug', 'complaint', 'missing_feature', 'question'),
    'severity': ('low', 'medium', 'high', 'critical'),
    'outcome': ('works', 'broken', 'confusing'),
}
NUMBER_FIELD_RANGES: Final = {
    'amount_usd': (0, 10000000000),
    'affected_count': (1, 1000000),
    'rating': (1, 5),
}
EMAIL_FIELDS: Final = ('contact_email',)
URL_FIELDS: Final = ('link',)
MAX_LINK_CHARS: Final = 500
MAX_STATUSES: Final = 8
MAX_STATUS_LABEL: Final = 40
STATUS_KEY_PATTERN: Final = '^[a-z_]{1,30}$'
TEMPLATE_FIELDS: Final = {
    'sales': {
        'request': {
            'customer': {'enabled': True, 'required': True}, 'deal': {'enabled': True, 'required': False},
            'impact': {'enabled': True, 'required': True}, 'amount_usd': {'enabled': True, 'required': False},
            'contact_email': {'enabled': True, 'required': False},
        },
        'support': {
            'customer': {'enabled': True, 'required': True}, 'deal': {'enabled': True, 'required': False},
            'impact': {'enabled': True, 'required': True}, 'amount_usd': {'enabled': True, 'required': False},
            'contact_email': {'enabled': True, 'required': False}, 'note': {'enabled': True, 'required': False},
        },
    },
    'service': {
        'request': {
            'kind': {'enabled': True, 'required': True},
            'severity': {'enabled': True, 'required': True},
            'reference': {'enabled': True, 'required': False},
            'steps': {'enabled': True, 'required': False},
            'affected_count': {'enabled': True, 'required': False},
        },
        'support': {
            'note': {'enabled': True, 'required': False},
        },
    },
    'beta': {
        'request': {
            'area': {'enabled': True, 'required': True},
            'outcome': {'enabled': True, 'required': True},
            'rating': {'enabled': True, 'required': False},
            'link': {'enabled': True, 'required': False},
        },
        'support': {
            'note': {'enabled': True, 'required': False},
        },
    },
    'blank': {
        'request': {},
        'support': {},
    },
}
TEMPLATE_STATUSES: Final = {
    'sales': (
        {'key': 'new', 'label': 'New'},
        {'key': 'under_review', 'label': 'Under review'},
        {'key': 'planned', 'label': 'Planned'},
        {'key': 'shipped', 'label': 'Shipped'},
        {'key': 'declined', 'label': 'Declined'},
    ),
    'service': (
        {'key': 'new', 'label': 'New'},
        {'key': 'confirmed', 'label': 'Confirmed'},
        {'key': 'fixed', 'label': 'Fixed'},
        {'key': 'wont_fix', 'label': "Won't fix"},
    ),
    'beta': (
        {'key': 'new', 'label': 'New'},
        {'key': 'seen', 'label': 'Seen'},
        {'key': 'fixed', 'label': 'Fixed'},
    ),
    'blank': (
        {'key': 'new', 'label': 'New'},
        {'key': 'done', 'label': 'Done'},
    ),
}
TEMPLATE_TOTALS: Final = {
    'sales': ('supporters', 'customers', 'committed_usd', 'at_risk_usd'),
    'service': ('supporters', 'affected'),
    'beta': ('supporters', 'avg_rating'),
    'blank': ('supporters',),
}

# ── Validation ────────────────────────────────────────────────────────────────

_STATUS_KEY: Final = re.compile(STATUS_KEY_PATTERN.replace('$', r'\Z'))
_CATALOGUES: Final = {'request': REQUEST_FIELD_KEYS, 'support': SUPPORT_FIELD_KEYS}
_FLAGS: Final = ('enabled', 'required')
_IMPACT_WITH_AMOUNT: Final = frozenset({'committed', 'at_risk'})


def template_of(value: object) -> str:
    """A stored template, read leniently (anything unknown reads as ``blank``)."""
    return value if isinstance(value, str) and value in TEMPLATES else 'blank'


def description_required(board: Mapping[str, Any]) -> bool:
    """Whether a request on ``board`` must have a description (by its template)."""
    return template_of(board.get('template')) in DESCRIPTION_REQUIRED_TEMPLATES


def validate_template(value: object) -> str:
    if not isinstance(value, str) or value not in TEMPLATES:
        raise ValidationError(f'template must be one of: {", ".join(TEMPLATES)}')
    return value


def _flags(raw: object, where: str) -> dict[str, bool]:
    if not isinstance(raw, Mapping) or set(raw) - set(_FLAGS):
        raise ValidationError(f'{where} must be {{enabled, required}}')
    enabled, required = raw.get('enabled', False), raw.get('required', False)
    if not isinstance(enabled, bool) or not isinstance(required, bool):
        raise ValidationError(f'{where}: enabled and required must be true or false')
    if required and not enabled:
        raise ValidationError(f'{where} cannot be required while it is off')
    return {'enabled': enabled, 'required': required}


def _level_config(raw: object, level: str) -> dict[str, dict[str, bool]]:
    catalogue = _CATALOGUES[level]
    if raw is None:
        raw = {}
    if not isinstance(raw, Mapping):
        raise ValidationError(f'fields.{level} must be an object')
    unknown = sorted(set(raw) - set(catalogue))
    if unknown:
        raise ValidationError(f'fields.{level}: unknown field {unknown[0]}')
    return {key: _flags(raw[key], f'fields.{level}.{key}') if key in raw else {'enabled': False, 'required': False}
            for key in catalogue}


def validate_fields_config(raw: object) -> dict[str, dict[str, dict[str, bool]]]:
    """A board's ``fields``: every catalogue key of both levels with its flags (absent = off)."""
    if not isinstance(raw, Mapping) or set(raw) - set(LEVELS):
        raise ValidationError('fields must be {request, support}')
    return {level: _level_config(raw.get(level), level) for level in LEVELS}


def template_fields(template: str) -> dict[str, dict[str, dict[str, bool]]]:
    return validate_fields_config(TEMPLATE_FIELDS[template_of(template)])


def fields_of(board: Mapping[str, Any]) -> dict[str, dict[str, dict[str, bool]]]:
    """The board's stored ``fields`` read leniently (unreadable = its template's defaults)."""
    try:
        return validate_fields_config(board.get('fields'))
    except ValidationError:
        return template_fields(str(board.get('template', '')))


def validate_statuses(raw: object) -> list[dict[str, str]]:
    """1-8 ``{key, label}``, unique keys; the first is the status a new request starts in."""
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_STATUSES:
        raise ValidationError(f'statuses must be a list of 1 to {MAX_STATUSES} statuses')
    statuses: list[dict[str, str]] = []
    for entry in raw:
        if not isinstance(entry, Mapping) or set(entry) - {'key', 'label'}:
            raise ValidationError('each status must be {key, label}')
        key = entry.get('key')
        if not isinstance(key, str) or not _STATUS_KEY.match(key):
            raise ValidationError('a status key is 1-30 lower-case letters or underscores')
        label = optional_text(entry, 'label', MAX_STATUS_LABEL)
        if not label:
            raise ValidationError(f'status {key} needs a label of at most {MAX_STATUS_LABEL} characters')
        if any(status['key'] == key for status in statuses):
            raise ValidationError(f'status {key} is listed twice')
        statuses.append({'key': key, 'label': label})
    return statuses


def template_statuses(template: str) -> list[dict[str, str]]:
    return [dict(status) for status in TEMPLATE_STATUSES[template_of(template)]]


def statuses_of(board: Mapping[str, Any]) -> list[dict[str, str]]:
    try:
        return validate_statuses(board.get('statuses'))
    except ValidationError:
        return template_statuses(str(board.get('template', '')))


def status_keys(board: Mapping[str, Any]) -> list[str]:
    return [status['key'] for status in statuses_of(board)]


def validate_status(board: Mapping[str, Any], value: object) -> str:
    keys = status_keys(board)
    if not isinstance(value, str) or value not in keys:
        raise ValidationError(f'status must be one of: {", ".join(keys)}')
    return value


# ── Values ────────────────────────────────────────────────────────────────────

def _number(key: str, raw: object) -> int:
    low, high = NUMBER_FIELD_RANGES[key]
    if isinstance(raw, bool) or not isinstance(raw, int) or not low <= raw <= high:
        raise ValidationError(f'{key} must be a whole number from {low} to {high}')
    return raw


def _choice(key: str, raw: object) -> str:
    options = CHOICE_FIELD_OPTIONS[key]
    if not isinstance(raw, str) or raw not in options:
        raise ValidationError(f'{key} must be one of: {", ".join(options)}')
    return raw


def _email(key: str, raw: object) -> str:
    try:
        return normalize_email(raw)[1]
    except ValueError as exc:
        raise ValidationError(f'{key} is not an email address') from exc


def _link(key: str, raw: object) -> str:
    text = optional_text({key: raw}, key, MAX_LINK_CHARS)
    parts = urlsplit(text)
    if parts.scheme != 'https' or not parts.hostname or any(ch.isspace() for ch in text):
        raise ValidationError(f'{key} must be an https:// link')
    return text


def _is_empty(raw: object) -> bool:
    return raw is None or (isinstance(raw, str) and not raw.strip())


def field_value(key: str, raw: object) -> Any:
    """One catalogue value, checked and normalised; ValidationError (a 400) otherwise."""
    if key in TEXT_FIELD_LIMITS:
        return optional_text({key: raw}, key, TEXT_FIELD_LIMITS[key])
    if key in CHOICE_FIELD_OPTIONS:
        return _choice(key, raw)
    if key in NUMBER_FIELD_RANGES:
        return _number(key, raw)
    if key in EMAIL_FIELDS:
        return _email(key, raw)
    if key in URL_FIELDS:
        return _link(key, raw)
    raise ValidationError(f'{key} is not a board field')


def _source(raw_fields: object, body: Mapping[str, Any], level: str) -> tuple[Mapping[str, Any], bool]:
    """``(values, strict)``: the body's ``fields`` object, or (a client from before boards) the
    catalogue keys sent at the top level of the body, read leniently."""
    if raw_fields is None:
        return {key: body[key] for key in _CATALOGUES[level] if key in body}, False
    if not isinstance(raw_fields, Mapping):
        raise ValidationError('fields must be an object')
    return raw_fields, True


def _impact_amount(values: dict[str, Any], config: Mapping[str, Mapping[str, bool]]) -> None:
    """A committed / at-risk impact carries its amount (as before boards); no impact stores 0."""
    if 'impact' not in values or not config['amount_usd']['enabled']:
        return
    if values['impact'] == 'none':
        values['amount_usd'] = 0
    elif values['impact'] in _IMPACT_WITH_AMOUNT and 'amount_usd' not in values:
        low, high = NUMBER_FIELD_RANGES['amount_usd']
        raise ValidationError(f'amount_usd must be a whole number of US dollars from {low} to {high}')


def field_values(board: Mapping[str, Any], level: str, body: Mapping[str, Any]) -> dict[str, Any]:
    """The values of the board's enabled ``level`` fields in ``body`` (``body['fields']``, or the
    legacy top-level keys), checked; required ones must be present. Strict ``fields``: a key that
    is not an enabled field of this board is a 400."""
    config = fields_of(board)[level]
    raw, strict = _source(body.get('fields'), body, level)
    enabled = {key for key, flags in config.items() if flags['enabled']}
    extra = sorted(set(raw) - enabled) if strict else []
    if extra:
        raise ValidationError(f'{extra[0]} is not a field of this board')
    values: dict[str, Any] = {}
    for key in sorted(enabled):
        if _is_empty(raw.get(key)):
            if config[key]['required']:
                raise ValidationError(f'{key} is required')
            continue
        values[key] = field_value(key, raw.get(key))
    _impact_amount(values, config)
    return values
