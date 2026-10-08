"""Prototype pin feedback (todofeatures §6.2): forms, widget injection, validation, storage.

A built prototype document gets ONE feedback form of type ``prototype_pin``
(``pin_form_id(document_id)`` — deterministic, so a retried build re-creates
nothing). The generated HTML carries a self-contained widget
(``static/prototype-pin-widget.js``) that lets a tester click an element to drop
a pin and write a comment. The prototype's CloudFront CSP has no
``connect-src``, so the widget never talks to the network itself: it posts the
pin to its host frame (the SPA prototype viewer), which submits it through the
EXISTING public ``POST /feedback-forms/{form_id}/submit`` route and its rate
limit.

Pins live in the AGGREGATES table (``PINS#{form_id}`` / ``PIN#{pin_id}``):
the two Lambdas that touch pins — the feedback-form API (the public submit) and
the projects API (list / reply / resolve / reopen, the agent's reads) — already
hold read-write grants on it, while the projects table is not granted to the
publicly reachable feedback-form Lambda and should not be.

Every field a tester sends is type-checked and size-capped here; console text,
the snippet and the route are redacted (emails, tokens, long digit runs) — the
widget redacts too, this is the server half. Nothing in this module logs
content.
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
from datetime import UTC, datetime
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared.aws import is_conditional_check_failure
from shared.exceptions import ValidationError
from shared.prompt_safety import injection_findings

FORM_TYPE_PROTOTYPE_PIN = 'prototype_pin'

STATUS_OPEN = 'open'
STATUS_ADDRESSED = 'addressed'
STATUS_RESOLVED = 'resolved'
STATUSES = (STATUS_OPEN, STATUS_ADDRESSED, STATUS_RESOLVED)

MAX_BODY_BYTES = 24_000
MAX_COMMENT_CHARS = 2000
MAX_SELECTOR_CHARS = 512
MAX_SNIPPET_CHARS = 200
MAX_ROUTE_CHARS = 300
MAX_USER_AGENT_CHARS = 300
MAX_CONSOLE_ENTRIES = 20
MAX_CONSOLE_CHARS = 500
MAX_REPLIES = 50
MAX_REPLY_CHARS = 2000
MAX_PINS_LISTED = 200
MAX_BATCH_PINS = 50
MAX_VIEWPORT_PX = 20_000
MAX_SCROLL_PX = 1_000_000
CONSOLE_LEVELS = ('error', 'rejection')  # an entry without one of these gets the first

_FORM_ID_RE = re.compile(r'^pf_[0-9a-f]{16}$')
_PIN_ID_RE = re.compile(r'^pin_[0-9]{20}[0-9a-f]{6}$')

WIDGET_START = '<!-- voc-pin-widget:start -->'
WIDGET_END = '<!-- voc-pin-widget:end -->'
_WIDGET_BLOCK_RE = re.compile(re.escape(WIDGET_START) + r'.*?' + re.escape(WIDGET_END) + r'\n?', re.DOTALL)
_WIDGET_PATH = Path(__file__).parent / 'static' / 'prototype-pin-widget.js'


# ---------------------------------------------------------------------------
# Identifiers
# ---------------------------------------------------------------------------

def pin_form_id(document_id: str) -> str:
    """The prototype's pin form id — a pure function of the document id."""
    return 'pf_' + hashlib.sha256(f'prototype_pin|{document_id}'.encode()).hexdigest()[:16]


def is_pin_form_id(value: object) -> bool:
    return isinstance(value, str) and bool(_FORM_ID_RE.fullmatch(value))


def is_pin_id(value: object) -> bool:
    return isinstance(value, str) and bool(_PIN_ID_RE.fullmatch(value))


def new_pin_id(now: datetime | None = None) -> str:
    """``pin_`` + a 20-digit UTC timestamp + 6 hex: unique and time-sortable."""
    moment = now or datetime.now(UTC)
    return f"pin_{moment.strftime('%Y%m%d%H%M%S%f')}{secrets.token_hex(3)}"


def pins_pk(form_id: str) -> str:
    return f'PINS#{form_id}'


def pin_key(form_id: str, pin_id: str) -> dict[str, str]:
    return {'pk': pins_pk(form_id), 'sk': f'PIN#{pin_id}'}


# ---------------------------------------------------------------------------
# The form record
# ---------------------------------------------------------------------------

def pin_form_item(project_id: str, document_id: str, title: str, now: str) -> dict:
    """The aggregates-table form record for one prototype document.

    Same key shape and rendering fields as a dashboard-created form, so the
    Feedback forms page lists it; ``enabled`` from the start because the widget
    is live in the HTML from the moment it is written.
    """
    form_id = pin_form_id(document_id)
    return {
        'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}', 'form_id': form_id,
        'form_type': FORM_TYPE_PROTOTYPE_PIN,
        'name': f'Pins: {title}'[:120],
        'enabled': True,
        'title': 'Prototype feedback',
        'description': 'Click an element of the prototype and tell us what you think.',
        'question': 'What should change here?',
        'placeholder': 'Describe what you expected or what is confusing…',
        'rating_enabled': False, 'rating_type': 'stars', 'rating_max': 5,
        'submit_button_text': 'Send', 'success_message': 'Thanks — your pin was saved.',
        'theme': {}, 'collect_email': False, 'collect_name': False, 'custom_fields': [],
        'category': '', 'subcategory': '',
        'project_id': project_id, 'document_id': document_id,
        'brand_name': '', 'created_at': now, 'updated_at': now,
    }


def ensure_pin_form(table: Any, project_id: str, document_id: str, title: str) -> str:
    """Create the document's pin form if it does not exist yet; return its id.

    Conditional put, so a replayed build (same document id) neither duplicates
    nor overwrites the record — and nothing here ever deletes one.
    """
    item = pin_form_item(project_id, document_id, title, datetime.now(UTC).isoformat())
    try:
        table.put_item(Item=item, ConditionExpression='attribute_not_exists(sk)')
    except ClientError as error:
        if not is_conditional_check_failure(error):
            raise
    return item['form_id']


# ---------------------------------------------------------------------------
# Widget injection
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)  # pragma: no mutate  a zero-argument function caches one entry whatever the size
def widget_source() -> str:
    return _WIDGET_PATH.read_text(encoding='utf-8')


def strip_pin_widget(html: str) -> str:
    """``html`` without the injected widget (a revision must not feed it to the model)."""
    return _WIDGET_BLOCK_RE.sub('', html or '')


def inject_pin_widget(html: str, form_id: str) -> str:
    """``html`` with the widget before its last ``</body>`` (or appended).

    Idempotent: an existing widget block is replaced, never duplicated.
    """
    if not is_pin_form_id(form_id):
        raise ValueError('not a prototype pin form id')
    block = (
        f'{WIDGET_START}\n<script>\n{widget_source()}\n'
        f"window.VoCPinWidget && window.VoCPinWidget.init({{formId: '{form_id}'}});\n"
        f'</script>\n{WIDGET_END}'
    )
    clean = strip_pin_widget(html)
    index = clean.lower().rfind('</body>')
    if index == -1:
        return f'{clean}\n{block}\n'
    return f'{clean[:index]}{block}\n{clean[index:]}'


# ---------------------------------------------------------------------------
# Redaction (mirrors redact() in static/prototype-pin-widget.js)
# ---------------------------------------------------------------------------

_EMAIL_RE = re.compile(r'[\w.+-]+@[\w-]+(?:\.[\w-]+)+')
_JWT_RE = re.compile(r'\beyJ[\w-]+\.[\w-]+\.[\w-]+')
_BEARER_RE = re.compile(r'\bbearer\s+[^\s&,;]+', re.IGNORECASE)
_KEYED_SECRET_RE = re.compile(
    r'\b(token|access_token|id_token|api[_-]?key|key|secret|password|passwd|signature|sig)'
    r'\s*[=:]\s*("[^"]*"|\'[^\']*\'|[^\s&,;]+)', re.IGNORECASE)
_LONG_TOKEN_RE = re.compile(r'[A-Za-z0-9_\-+/=]{24,}')
_DIGIT_RUN_RE = re.compile(r'\d(?:[\s-]?\d){4,}')


def _long_token(match: re.Match[str]) -> str:
    text = match.group(0)
    return '[token]' if re.search(r'\d', text) and re.search(r'[A-Za-z]', text) else text


def redact(text: str) -> str:
    """Emails, JWTs, key=value secrets, long mixed tokens and digit runs (≥5) removed."""
    out = _EMAIL_RE.sub('[email]', text)
    out = _JWT_RE.sub('[token]', out)
    out = _BEARER_RE.sub('Bearer [redacted]', out)
    out = _KEYED_SECRET_RE.sub(r'\1=[redacted]', out)
    out = _LONG_TOKEN_RE.sub(_long_token, out)
    return _DIGIT_RUN_RE.sub('[number]', out)


# ---------------------------------------------------------------------------
# Validation of a tester's submission
# ---------------------------------------------------------------------------

def _text(value: object, field: str, limit: int, *, required: bool = False) -> str:
    if value is None:
        value = ''
    if not isinstance(value, str):
        raise ValidationError(f'{field} must be a string')
    clean = value.replace('\x00', '').strip()
    if required and not clean:
        raise ValidationError(f'{field} is required')
    return clean[:limit]


def _number(value: object, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        return 0.0
    return min(max(float(value), low), high)


def _decimal(value: float) -> Decimal:
    return Decimal(str(round(value, 2)))


def _pair(value: object, keys: tuple[str, str], high: int) -> dict[str, int]:
    source = value if isinstance(value, dict) else {}
    return {k: int(_number(source.get(k), 0, high)) for k in keys}


def _bbox(value: object) -> dict[str, Decimal]:
    source = value if isinstance(value, dict) else {}
    return {k: _decimal(_number(source.get(k), 0, 100)) for k in ('x', 'y', 'w', 'h')}


def _route(value: object) -> str:
    """The in-prototype route with any query string dropped (a signed URL's credentials live there)."""
    route = _text(value, 'pin.route', 2000)
    path, _, rest = route.partition('?')
    fragment = rest.partition('#')[2] if rest else ''
    return redact(path + (f'#{fragment}' if fragment else ''))[:MAX_ROUTE_CHARS]


def _console(value: object) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValidationError('pin.console must be a list')
    entries: list[dict[str, str]] = []
    for raw in value[-MAX_CONSOLE_ENTRIES:]:
        entry = raw if isinstance(raw, dict) else {'message': raw}
        raw_level = entry.get('level')
        level = raw_level if raw_level in CONSOLE_LEVELS else CONSOLE_LEVELS[0]
        message = entry.get('message')
        if not isinstance(message, str) or not message.strip():
            continue
        entries.append({'level': level, 'message': redact(message.strip()[:2000])[:MAX_CONSOLE_CHARS]})
    return entries


def validate_submission(body: dict) -> dict:
    """The sanitised pin from a public submit body, or ValidationError.

    Shape: ``{text, pin: {selector, text_snippet, bbox, viewport, scroll, route,
    user_agent, console}}``. Unknown keys are dropped; strings are capped;
    numbers are clamped; console, snippet and route are redacted.
    """
    if len(json.dumps(body, default=str).encode()) > MAX_BODY_BYTES:
        raise ValidationError('The pin is too large')
    comment = _text(body.get('text'), 'text', MAX_COMMENT_CHARS, required=True)
    pin = body.get('pin')
    if not isinstance(pin, dict):
        raise ValidationError('pin must be an object')
    return {
        'comment': comment,
        'anchor': {
            'selector': _text(pin.get('selector'), 'pin.selector', MAX_SELECTOR_CHARS),
            'text_snippet': redact(_text(pin.get('text_snippet'), 'pin.text_snippet', 1000))[:MAX_SNIPPET_CHARS],
            'bbox': _bbox(pin.get('bbox')),
            'viewport': _pair(pin.get('viewport'), ('w', 'h'), MAX_VIEWPORT_PX),
            'scroll': _pair(pin.get('scroll'), ('x', 'y'), MAX_SCROLL_PX),
            'route': _route(pin.get('route')),
        },
        'user_agent': _text(pin.get('user_agent'), 'pin.user_agent', MAX_USER_AGENT_CHARS),
        'console': _console(pin.get('console')),
        # Screened, not refused: a tester is not an admin pasting prose, and a
        # flagged pin still reaches humans — the agent node leaves it out.
        'screening': injection_findings(comment),
    }


def pin_item(form: dict, pin: dict, now: datetime | None = None) -> dict:
    """The stored pin row for a validated submission against ``form``."""
    moment = now or datetime.now(UTC)
    pin_id = new_pin_id(moment)
    return {
        **pin_key(form['form_id'], pin_id),
        'pin_id': pin_id, 'form_id': form['form_id'],
        'project_id': form.get('project_id', ''), 'document_id': form.get('document_id', ''),
        'status': STATUS_OPEN, 'flagged': bool(pin['screening']),
        'created_at': moment.isoformat(), 'updated_at': moment.isoformat(),
        'replies': [], **pin,
    }


def put_pin(table: Any, item: dict) -> None:
    table.put_item(Item=item, ConditionExpression='attribute_not_exists(sk)')


# ---------------------------------------------------------------------------
# Reads and state changes (projects API)
# ---------------------------------------------------------------------------

def _plain(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


def public_pin(item: dict) -> dict:
    """A stored pin as the API returns it (keys dropped, Decimals plain)."""
    return _plain({k: v for k, v in item.items() if k not in ('pk', 'sk')})


def list_pins(table: Any, form_id: str, status: str | None = None) -> list[dict]:
    """The form's pins, oldest first, optionally one status, at most MAX_PINS_LISTED."""
    pins: list[dict] = []
    kwargs: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(pins_pk(form_id)) & Key('sk').begins_with('PIN#'),
    }
    while len(pins) < MAX_PINS_LISTED:
        response = table.query(**kwargs)
        pins += [i for i in response.get('Items', []) if status is None or i.get('status') == status]
        if 'LastEvaluatedKey' not in response:
            break
        kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
    return [public_pin(i) for i in pins[:MAX_PINS_LISTED]]


def validate_reply(body: dict) -> str:
    text = _text(body.get('text'), 'text', MAX_REPLY_CHARS, required=True)
    if injection_findings(text):
        raise ValidationError('text reads like an instruction to the model; rephrase it')
    return text


def append_reply(table: Any, form_id: str, pin_id: str, reply: dict) -> dict:
    """Append ``reply`` to the pin's thread (capped); returns the updated pin."""
    response = table.update_item(
        Key=pin_key(form_id, pin_id),
        UpdateExpression='SET replies = list_append(if_not_exists(replies, :empty), :reply), updated_at = :now',
        ConditionExpression='attribute_exists(sk) AND (attribute_not_exists(replies) OR size(replies) < :max)',
        ExpressionAttributeValues={':empty': [], ':reply': [reply], ':now': reply['at'], ':max': MAX_REPLIES},
        ReturnValues='ALL_NEW',
    )
    return public_pin(response.get('Attributes', {}))


def set_status(table: Any, form_id: str, pin_id: str, status: str, *, actor: str,
               only_from: tuple[str, ...] = STATUSES, extra: dict | None = None) -> dict:
    """Move one pin to ``status`` (only from ``only_from``); returns the updated pin.

    Raises the ConditionalCheckFailedException when the pin is missing or in a
    state it may not move from — callers map it to 404/409.
    """
    now = datetime.now(UTC).isoformat()
    sets = {'status': status, 'updated_at': now, 'status_by': actor[:200], **(extra or {})}
    names = {f'#{k}': k for k in sets}
    values = {f':{k}': v for k, v in sets.items()}
    allowed = {f':from{i}': s for i, s in enumerate(only_from)}
    response = table.update_item(
        Key=pin_key(form_id, pin_id),
        UpdateExpression='SET ' + ', '.join(f'#{k} = :{k}' for k in sets),
        ConditionExpression=f"attribute_exists(sk) AND #status IN ({', '.join(allowed)})",
        ExpressionAttributeNames=names,
        ExpressionAttributeValues={**values, **allowed},
        ReturnValues='ALL_NEW',
    )
    return public_pin(response.get('Attributes', {}))


def batch_pin_ids(body: dict) -> list[str]:
    raw = body.get('pin_ids')
    if not isinstance(raw, list) or not raw:
        raise ValidationError('pin_ids must be a non-empty list')
    if len(raw) > MAX_BATCH_PINS:
        raise ValidationError(f'at most {MAX_BATCH_PINS} pin_ids are allowed')
    if not all(is_pin_id(p) for p in raw):
        raise ValidationError('pin_ids holds an invalid pin id')
    return list(dict.fromkeys(raw))
