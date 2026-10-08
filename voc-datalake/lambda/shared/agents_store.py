"""Autonomous agents: the agent model and the ``voc-agents`` data access.

Shared by the agents API (``api/agents_handler.py``), the heartbeat
(``agents/heartbeat/handler.py``) and the run interpreter, so all three read and
write agents, workflows, runs and run events the same way.

Rows (``voc-agents``, ``pk``/``sk`` + ``gsi1`` on ``gsi1pk``/``gsi1sk``):

- agent      ``AGENT#{agent_id}`` / ``META``; ``gsi1pk=AGENTS``, ``gsi1sk={name}``
- workflow   ``WORKFLOW#{workflow_id}`` / ``REV#{revision:06d}`` plus a ``CURRENT``
             pointer row (``gsi1pk=WORKFLOWS``); the built-in ``wf_default`` is not
             stored — it is :func:`shared.workflow_schema.default_template`
- run        ``AGENT#{agent_id}`` / ``RUN#{run_id}``; ``gsi1pk=RUNS_ACTIVE`` while
             ``queued``/``running``
- run event  ``RUN#{run_id}`` / ``EVT#{seq:08d}``

One active run per agent is enforced by a lock on the agent row
(``active_run_id``), taken in the SAME transaction that writes the run, and the
scheduled-runs-per-day cap by a conditional counter on that row — so two
concurrent starters (two heartbeat ticks, a tick and a "Run now") cannot both win.
Every terminal transition (:func:`finish_run`) releases the lock.

Never log a subject, an e-mail or agent instructions: ids and counts only.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import secrets
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Final
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

from shared import workflow_schema
from shared.aws import get_dynamodb_resource, is_conditional_check_failure
from shared.category_access import CategoryScope, item_category
from shared.exceptions import ConflictError, NotFoundError, ServiceError, ValidationError
from shared.indexes import AGENTS_LISTING_INDEX
from shared.logging import logger
from shared.model_config import ALLOWED_MODEL_IDS
from shared.row_ids import validated_row_id

AGENTS_TABLE_ENV: Final = 'AGENTS_TABLE'
STATE_MACHINE_ENV: Final = 'AGENT_RUN_STATE_MACHINE_ARN'
# The voc-agents GSI over gsi1pk/gsi1sk — named in lib/stacks/core-stack.ts.
AGENTS_INDEX: Final = AGENTS_LISTING_INDEX

AGENTS_GSI_PK: Final = 'AGENTS'
WORKFLOWS_GSI_PK: Final = 'WORKFLOWS'
RUNS_ACTIVE_GSI_PK: Final = 'RUNS_ACTIVE'
META_SK: Final = 'META'
CURRENT_SK: Final = 'CURRENT'

AGENT_STATUS_ACTIVE: Final = 'active'
AGENT_STATUS_ARCHIVED: Final = 'archived'
# A workflow is archived the same way an agent is: a soft flag on its CURRENT row,
# hidden from the library, read-only, never deleted (its revisions and the runs
# that used it keep their meaning). Unset means active.
WORKFLOW_STATUS_ARCHIVED: Final = AGENT_STATUS_ARCHIVED

RUN_QUEUED: Final = 'queued'
RUN_RUNNING: Final = 'running'
RUN_NEEDS_HUMAN: Final = 'needs_human'
RUN_COMPLETED: Final = 'completed'
RUN_FAILED: Final = 'failed'
RUN_CANCELLED: Final = 'cancelled'
ACTIVE_RUN_STATUSES: Final = (RUN_QUEUED, RUN_RUNNING)
TERMINAL_RUN_STATUSES: Final = (RUN_NEEDS_HUMAN, RUN_COMPLETED, RUN_FAILED, RUN_CANCELLED)

TRIGGER_MANUAL: Final = 'manual'
TRIGGER_SCHEDULE: Final = 'schedule'
TRIGGER_NEW_REVIEWS: Final = 'new_reviews'
TRIGGER_THRESHOLD: Final = 'threshold'

EVENT_KINDS: Final = ('node_started', 'node_finished', 'node_failed', 'message', 'verdict', 'decision', 'artifact')
EVENT_REF_KEYS: Final = ('project_id', 'document_id', 'persona_id', 'job_id')
EVENT_ROLES: Final = (*workflow_schema.ROLES, 'system')
MAX_EVENT_SUMMARY_CHARS: Final = 2000

MAX_NAME_CHARS: Final = 80
MAX_DESCRIPTION_CHARS: Final = 2000
MAX_INSTRUCTIONS_CHARS: Final = 8000
MAX_TRIGGERS: Final = 5
MAX_FIXED_PERSONAS: Final = 6
MAX_SCOPE_ENTRIES: Final = 50
MAX_SUB_CHARS: Final = 254
MODEL_ROLES: Final = workflow_schema.ROLES  # orchestrator, worker, reviewer, persona
VISIBILITIES: Final = ('private', 'public')
SCHEDULE_EVERY: Final = ('12h', '24h', 'cron')
THRESHOLD_PER: Final = ('category', 'subcategory')

MAX_SCHEDULED_RUNS_PER_DAY: Final = 2
DEFAULT_MODEL_CALLS_PER_RUN: Final = 150
MIN_MODEL_CALLS_PER_RUN: Final = 10
MAX_MODEL_CALLS_PER_RUN: Final = 500
DEFAULT_MONTHLY_CALL_CAP: Final = 5000
MAX_MONTHLY_CALL_CAP: Final = 1_000_000

_AGENT_ID_RE: Final = re.compile(r'ag_[0-9a-f]{12}')
_WORKFLOW_ID_RE: Final = re.compile(r'wf_[0-9a-f]{12}')
_RUN_ID_RE: Final = re.compile(r'ar_[0-9a-f]{12,20}')

# Fields a create/update body may set; everything else is server-maintained.
EDITABLE_FIELDS: Final = (
    'name', 'description', 'enabled', 'owner_sub', 'scope', 'instructions', 'personas',
    'triggers', 'models', 'output', 'workflow_id', 'budget',
)


# --------------------------------------------------------------------------
# Ids, clocks, keys, value plumbing.
# --------------------------------------------------------------------------

def utc_now() -> datetime:
    return datetime.now(UTC)


def iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec='seconds')


def parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def new_agent_id() -> str:
    return f'ag_{secrets.token_hex(6)}'


def new_workflow_id() -> str:
    return f'wf_{secrets.token_hex(6)}'


def new_run_id(now: datetime | None = None) -> str:
    """``ar_`` + the start time in ms as 12 hex digits + 8 random hex digits.

    Time-first so run ids sort by start; the random tail keeps runs started in the
    same millisecond (one heartbeat tick) from sharing ``RUN#{run_id}`` rows. Four
    random bytes, not two: with two, 50 runs in one millisecond collided about 2% of
    the time. ``_RUN_ID_RE`` still accepts the older 4-digit tails.
    """
    millis = int((now or utc_now()).timestamp() * 1000)
    return f'ar_{millis:012x}{secrets.token_hex(4)}'


def is_agent_id(value: object) -> bool:
    return isinstance(value, str) and bool(_AGENT_ID_RE.fullmatch(value))


def is_workflow_id(value: object) -> bool:
    return value == workflow_schema.DEFAULT_WORKFLOW_ID or (
        isinstance(value, str) and bool(_WORKFLOW_ID_RE.fullmatch(value)))


def is_run_id(value: object) -> bool:
    return isinstance(value, str) and bool(_RUN_ID_RE.fullmatch(value))


def agent_key(agent_id: str) -> dict[str, str]:
    return {'pk': f'AGENT#{agent_id}', 'sk': META_SK}


def run_key(agent_id: str, run_id: str) -> dict[str, str]:
    return {'pk': f'AGENT#{agent_id}', 'sk': f'RUN#{run_id}'}


def workflow_current_key(workflow_id: str) -> dict[str, str]:
    return {'pk': f'WORKFLOW#{workflow_id}', 'sk': CURRENT_SK}


def workflow_revision_key(workflow_id: str, revision: int) -> dict[str, str]:
    return {'pk': f'WORKFLOW#{workflow_id}', 'sk': f'REV#{revision:06d}'}


def plain(value: Any) -> Any:
    """DynamoDB's Decimals back to int/float, recursively (JSON-safe output)."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, Mapping):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, list | tuple | set):
        return [plain(v) for v in value]
    return value


def _int_attr(item: Mapping[str, Any], name: str) -> int:
    value = plain(item.get(name))
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def encode_cursor(last_key: Mapping[str, Any] | None) -> str | None:
    if not last_key:
        return None
    raw = json.dumps(plain(dict(last_key)), sort_keys=True).encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii')


def decode_cursor(cursor: object, expected_pk: str) -> dict[str, Any] | None:
    """A pagination cursor back to an ExclusiveStartKey; it must stay in ``expected_pk``."""
    if cursor in (None, ''):
        return None
    try:
        value = json.loads(base64.urlsafe_b64decode(str(cursor).encode('ascii')))
    except (ValueError, binascii.Error, UnicodeError) as exc:
        raise ValidationError('cursor is not valid') from exc
    if not isinstance(value, dict) or value.get('pk') != expected_pk or not isinstance(value.get('sk'), str):
        raise ValidationError('cursor is not valid')
    return value


_table_cache: dict[str, Any] = {}


def get_agents_table() -> Any:
    """The ``voc-agents`` table resource, or None when ``AGENTS_TABLE`` is unset."""
    name = os.environ.get(AGENTS_TABLE_ENV, '')
    if not name:
        return None
    if name not in _table_cache:
        _table_cache[name] = get_dynamodb_resource().Table(name)
    return _table_cache[name]


def _service_error(what: str, exc: Exception) -> ServiceError:
    logger.exception(f'Agents store: {what} failed', extra={'error_type': type(exc).__name__})
    return ServiceError(f'Could not {what}. Please retry.')


def _cancellation_codes(error: ClientError) -> list[str]:
    reasons = error.response.get('CancellationReasons') or []
    return [str((reason or {}).get('Code') or 'None') for reason in reasons]


def _is_cancelled_transaction(error: Exception) -> bool:
    return isinstance(error, ClientError) and error.response.get('Error', {}).get('Code') == \
        'TransactionCanceledException'


def _query_index(table: Any, gsi_pk: str, what: str) -> list[dict]:
    """Every row of one ``gsi1`` partition (agents, workflows, active runs: small by design)."""
    items: list[dict] = []
    kwargs: dict[str, Any] = {'IndexName': AGENTS_INDEX, 'KeyConditionExpression': Key('gsi1pk').eq(gsi_pk)}
    try:
        while True:
            page = table.query(**kwargs)
            items.extend(page.get('Items', []))
            if not page.get('LastEvaluatedKey'):
                return items
            kwargs['ExclusiveStartKey'] = page['LastEvaluatedKey']
    except (ClientError, BotoCoreError) as exc:
        raise _service_error(what, exc) from exc


# --------------------------------------------------------------------------
# Cron (5 fields: minute hour day-of-month month day-of-week, numbers only).
# --------------------------------------------------------------------------

_CRON_FIELDS: Final = (('minute', 0, 59), ('hour', 0, 23), ('day of month', 1, 31),
                       ('month', 1, 12), ('day of week', 0, 7))


@dataclass(frozen=True)
class CronSpec:
    minutes: frozenset[int]
    hours: frozenset[int]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]  # 0 = Sunday (7 is folded into 0)
    days_restricted: bool
    weekdays_restricted: bool

    def matches(self, local: datetime) -> bool:
        """Vixie semantics: with both day fields restricted, either may match."""
        if local.minute not in self.minutes or local.hour not in self.hours or local.month not in self.months:
            return False
        day_ok = local.day in self.days
        weekday_ok = (local.isoweekday() % 7) in self.weekdays
        if self.days_restricted and self.weekdays_restricted:
            return day_ok or weekday_ok
        return day_ok and weekday_ok


def _cron_part(part: str, label: str, low: int, high: int) -> set[int]:
    body, _, step_text = part.partition('/')
    step = 1
    if step_text:
        if not step_text.isdigit() or int(step_text) < 1:
            raise ValueError(f'cron {label}: step must be a positive number')
        step = int(step_text)
    if body == '*':
        start, end = low, high
    else:
        first, _, last = body.partition('-')
        if not first.isdigit() or (last and not last.isdigit()):
            raise ValueError(f'cron {label}: use numbers, ranges (a-b), lists (a,b), steps (*/n)')
        start, end = int(first), int(last) if last else (high if step_text else int(first))
    if not low <= start <= end <= high:
        raise ValueError(f'cron {label} must be within {low}-{high}')
    return set(range(start, end + 1, step))


def parse_cron(expression: object) -> CronSpec:
    """Parse a 5-field cron expression; ValueError with a client-safe message."""
    if not isinstance(expression, str) or len(expression) > 120:
        raise ValueError('cron must be a string of at most 120 characters')
    fields = expression.split()
    if len(fields) != len(_CRON_FIELDS):
        raise ValueError('cron needs 5 fields: minute hour day-of-month month day-of-week')
    values = []
    for text, (label, low, high) in zip(fields, _CRON_FIELDS, strict=True):  # pragma: no mutate  lengths checked above
        allowed: set[int] = set()
        for part in text.split(','):
            allowed |= _cron_part(part, label, low, high)
        values.append(frozenset(allowed))
    weekdays = frozenset(0 if day == 7 else day for day in values[4])
    return CronSpec(values[0], values[1], values[2], values[3], weekdays,
                    days_restricted=fields[2] != '*', weekdays_restricted=fields[4] != '*')


def resolve_timezone(name: object) -> Any:
    """``ZoneInfo(name)``; UTC when the zone database lacks it (logged, never raised)."""
    if not isinstance(name, str) or name in ('', 'UTC'):
        return UTC
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        logger.warning('Agent schedule timezone not found; using UTC')
        return UTC


# --------------------------------------------------------------------------
# The agent model: validation of create/update bodies.
# --------------------------------------------------------------------------

def _text(value: object, label: str, max_chars: int, *, required: bool = False) -> str:
    if value is None:
        value = ''
    if not isinstance(value, str):
        raise ValidationError(f'{label} must be a string')
    text = value.strip()
    if required and not text:
        raise ValidationError(f'{label} is required')
    if len(text) > max_chars:
        raise ValidationError(f'{label} must be at most {max_chars} characters')
    return text


def _whole(value: object, label: str, low: int, high: int, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValidationError(f'{label} must be a whole number from {low} to {high}')
    return value


def _flag(value: object, label: str, default: bool) -> bool:
    if value is None:
        return default
    if not isinstance(value, bool):
        raise ValidationError(f'{label} must be true or false')
    return value


def _object(value: object, label: str) -> Mapping[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValidationError(f'{label} must be an object')
    return value


def _choice(value: object, label: str, choices: tuple[str, ...], default: str | None = None) -> str:
    if value is None and default is not None:
        return default
    if value not in choices:
        raise ValidationError(f"{label} must be one of: {', '.join(choices)}")
    return str(value)


def subcategory_names(category: Mapping[str, Any]) -> list[str]:
    """The subcategory names one categories-config entry lists (malformed dropped)."""
    subs = category.get('subcategories')
    return [s['name'] for s in subs if isinstance(s, Mapping) and isinstance(s.get('name'), str)] \
        if isinstance(subs, list) else []


def normalize_scope(value: object, categories_config: list[dict]) -> dict[str, Any]:
    """``{all, categories, subcategories}`` checked against the categories config."""
    raw = _object(value, 'scope')
    if _flag(raw.get('all'), 'scope.all', not raw):
        return {'all': True, 'categories': [], 'subcategories': []}
    configured = {c['name']: c for c in categories_config if isinstance(c.get('name'), str)}
    categories = raw.get('categories') or []
    subcategories = raw.get('subcategories') or []
    if not isinstance(categories, list) or not isinstance(subcategories, list):
        raise ValidationError('scope.categories and scope.subcategories must be lists')
    if len(categories) > MAX_SCOPE_ENTRIES or len(subcategories) > MAX_SCOPE_ENTRIES:
        raise ValidationError(f'scope lists at most {MAX_SCOPE_ENTRIES} entries each')
    names = list(dict.fromkeys(categories))
    if any(not isinstance(name, str) or name not in configured for name in names):
        raise ValidationError('scope.categories must name configured categories')
    subs: list[dict[str, str]] = []
    for entry in subcategories:
        entry = _object(entry, 'scope.subcategories entry')
        category, name = entry.get('category'), entry.get('name')
        if not isinstance(category, str) or category not in configured or not isinstance(name, str):
            raise ValidationError('each scope subcategory needs a configured category and a name')
        listed = subcategory_names(configured[category])
        if listed and name not in listed:
            raise ValidationError('a scope subcategory must belong to its category')
        if {'category': category, 'name': name} not in subs:
            subs.append({'category': category, 'name': name})
    if not names and not subs:
        raise ValidationError('scope needs all: true, or at least one category or subcategory')
    return {'all': False, 'categories': names, 'subcategories': subs}


def _trigger(value: object) -> dict[str, Any]:
    raw = _object(value, 'trigger')
    kind = _choice(raw.get('kind'), 'trigger kind', (TRIGGER_NEW_REVIEWS, TRIGGER_SCHEDULE, TRIGGER_THRESHOLD))
    if kind == TRIGGER_NEW_REVIEWS:
        return {'kind': kind,
                'min_new': _whole(raw.get('min_new'), 'min_new', 1, 10_000, 1),
                'cooldown_hours': _whole(raw.get('cooldown_hours'), 'cooldown_hours', 0, 168, 12)}
    if kind == TRIGGER_SCHEDULE:
        every = _choice(raw.get('every'), 'schedule every', SCHEDULE_EVERY)
        tz_name = _text(raw.get('timezone'), 'timezone', 64) or 'UTC'
        if tz_name != 'UTC':
            try:
                ZoneInfo(tz_name)
            except (ZoneInfoNotFoundError, ValueError) as exc:
                raise ValidationError('timezone must be an IANA time zone such as Europe/Paris') from exc
        trigger: dict[str, Any] = {'kind': kind, 'every': every, 'timezone': tz_name}
        if every == 'cron':
            try:
                parse_cron(raw.get('cron'))
            except ValueError as exc:
                raise ValidationError(str(exc)) from exc
            trigger['cron'] = ' '.join(str(raw.get('cron')).split())
        return trigger
    return {'kind': kind,
            'count': _whole(raw.get('count'), 'threshold count', 1, 100_000, 10),
            'per': _choice(raw.get('per'), 'threshold per', THRESHOLD_PER, 'category'),
            'window_days': _whole(raw.get('window_days'), 'window_days', 1, 90, 7)}


def _triggers(value: object) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_TRIGGERS:
        raise ValidationError(f'triggers must be a list of at most {MAX_TRIGGERS}')
    return [_trigger(entry) for entry in value]


def _personas(value: object) -> dict[str, Any]:
    raw = _object(value, 'personas')
    fixed = raw.get('fixed') or []
    if not isinstance(fixed, list) or len(fixed) > MAX_FIXED_PERSONAS:
        raise ValidationError(f'personas.fixed must be a list of at most {MAX_FIXED_PERSONAS}')
    refs: list[dict[str, str]] = []
    for entry in fixed:
        entry = _object(entry, 'personas.fixed entry')
        ref = {'project_id': validated_row_id(entry.get('project_id'), field='project_id'),
               'persona_id': validated_row_id(entry.get('persona_id'), field='persona_id')}
        if ref not in refs:
            refs.append(ref)
    return {'fixed': refs, 'allow_generate': _flag(raw.get('allow_generate'), 'personas.allow_generate', True)}


def _models(value: object) -> dict[str, str | None]:
    raw = _object(value, 'models')
    unknown = set(raw) - set(MODEL_ROLES)
    if unknown:
        raise ValidationError(f"models keys must be among: {', '.join(MODEL_ROLES)}")
    for role in MODEL_ROLES:
        model_id = raw.get(role)
        if model_id is not None and model_id not in ALLOWED_MODEL_IDS:
            raise ValidationError(f'models.{role} must be an allowed model id or null')
    return {role: raw.get(role) for role in MODEL_ROLES}


def _budget(value: object) -> dict[str, Any]:
    raw = _object(value, 'budget')
    cap = raw.get('monthly_call_cap', DEFAULT_MONTHLY_CALL_CAP)
    return {
        'max_scheduled_runs_per_day': _whole(raw.get('max_scheduled_runs_per_day'), 'max_scheduled_runs_per_day',
                                             0, MAX_SCHEDULED_RUNS_PER_DAY, MAX_SCHEDULED_RUNS_PER_DAY),
        'max_model_calls_per_run': _whole(raw.get('max_model_calls_per_run'), 'max_model_calls_per_run',
                                          MIN_MODEL_CALLS_PER_RUN, MAX_MODEL_CALLS_PER_RUN,
                                          DEFAULT_MODEL_CALLS_PER_RUN),
        # null is an explicit "uncapped", never the default.
        'monthly_call_cap': None if cap is None else _whole(cap, 'monthly_call_cap', 0, MAX_MONTHLY_CALL_CAP,
                                                            DEFAULT_MONTHLY_CALL_CAP),
    }


def normalize_agent(body: Mapping[str, Any], categories_config: list[dict],
                    base: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The editable agent fields, validated; ``base`` (an existing agent) fills omissions.

    ``workflow_id`` is only shape-checked here (existence is the caller's read).
    """
    unknown = set(body) - set(EDITABLE_FIELDS)
    if unknown:
        raise ValidationError(f'unknown agent fields: {", ".join(sorted(unknown))}')
    merged = {**{k: plain(v) for k, v in (base or {}).items() if k in EDITABLE_FIELDS}, **body}
    workflow_id = merged.get('workflow_id')
    if workflow_id is not None and not is_workflow_id(workflow_id):
        raise ValidationError('workflow_id is not a workflow id')
    owner_sub = merged.get('owner_sub')
    if owner_sub is not None:
        owner_sub = _text(owner_sub, 'owner_sub', MAX_SUB_CHARS, required=True)
    output = _object(merged.get('output'), 'output')
    return {
        'name': _text(merged.get('name'), 'name', MAX_NAME_CHARS, required=True),
        'description': _text(merged.get('description'), 'description', MAX_DESCRIPTION_CHARS),
        'enabled': _flag(merged.get('enabled'), 'enabled', False),
        'owner_sub': owner_sub,
        'scope': normalize_scope(merged.get('scope'), categories_config),
        'instructions': _text(merged.get('instructions'), 'instructions', MAX_INSTRUCTIONS_CHARS),
        'personas': _personas(merged.get('personas')),
        'triggers': _triggers(merged.get('triggers')),
        'models': _models(merged.get('models')),
        'output': {'visibility': _choice(output.get('visibility'), 'output.visibility', VISIBILITIES, 'private')},
        'workflow_id': workflow_id,
        'budget': _budget(merged.get('budget')),
    }


# --------------------------------------------------------------------------
# Visibility and scope matching (pure).
# --------------------------------------------------------------------------

def agent_visible(viewer: CategoryScope, agent: Mapping[str, Any]) -> bool:
    """True when ``viewer`` may see EVERY category the agent works on (fails closed)."""
    if viewer.all:
        return True
    scope = agent.get('scope')
    if not isinstance(scope, Mapping) or scope.get('all') is not False:
        return False
    categories = [c for c in scope.get('categories') or [] if isinstance(c, str)]
    categories += [s.get('category') for s in scope.get('subcategories') or [] if isinstance(s, Mapping)]
    return bool(categories) and all(isinstance(c, str) and c in viewer.categories for c in categories)


def item_in_scope(scope: Mapping[str, Any], item: Mapping[str, Any]) -> bool:
    """True when a feedback item falls inside an agent's scope."""
    if scope.get('all') is True:
        return True
    category = item_category(item)
    if category in (scope.get('categories') or []):
        return True
    subcategory = item.get('subcategory')
    return any(isinstance(s, Mapping) and s.get('category') == category and s.get('name') == subcategory
               for s in scope.get('subcategories') or [])


# --------------------------------------------------------------------------
# Agents.
# --------------------------------------------------------------------------

def get_agent(table: Any, agent_id: str) -> dict | None:
    try:
        item = table.get_item(Key=agent_key(agent_id), ConsistentRead=True).get('Item')
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('read the agent', exc) from exc
    return item if isinstance(item, dict) else None


def list_agents(table: Any) -> list[dict]:
    """Every agent row (≤ a few dozen by design), name order."""
    return _query_index(table, AGENTS_GSI_PK, 'list agents')


def create_agent(table: Any, fields: Mapping[str, Any], *, created_by: str, now: datetime) -> dict:
    agent_id = new_agent_id()
    stamp = iso(now)
    item = {
        **agent_key(agent_id), 'gsi1pk': AGENTS_GSI_PK, 'gsi1sk': fields['name'],
        'agent_id': agent_id, **fields, 'owner_sub': fields.get('owner_sub') or created_by,
        'status': AGENT_STATUS_ACTIVE, 'created_by': created_by, 'created_at': stamp,
        'updated_by': created_by, 'updated_at': stamp,
        # New reviews are counted from creation, never from the start of history.
        'last_run_cursor': stamp, 'runs_total': 0,
    }
    try:
        table.put_item(Item=item, ConditionExpression='attribute_not_exists(pk)')
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('create the agent', exc) from exc
    return item


def _set_clause(fields: Mapping[str, Any]) -> tuple[str, dict[str, str], dict[str, Any]]:
    names = {f'#f{i}': name for i, name in enumerate(fields)}
    values = {f':v{i}': value for i, value in enumerate(fields.values())}
    clause = ', '.join(f'#f{i} = :v{i}' for i in range(len(fields)))
    return clause, names, values


def update_agent(table: Any, agent_id: str, fields: Mapping[str, Any], *, updated_by: str, now: datetime,
                 allow_archived: bool = False) -> dict:
    """SET ``fields`` (plus updated_by/at) on an existing agent; 404 when missing/archived."""
    to_set = {**fields, 'updated_by': updated_by, 'updated_at': iso(now)}
    if 'name' in fields:
        to_set['gsi1sk'] = fields['name']
    clause, names, values = _set_clause(to_set)
    condition = 'attribute_exists(pk)'
    if not allow_archived:
        condition += ' AND #status <> :archived'
        names['#status'] = 'status'
        values[':archived'] = AGENT_STATUS_ARCHIVED
    try:
        return table.update_item(
            Key=agent_key(agent_id), UpdateExpression=f'SET {clause}', ConditionExpression=condition,
            ExpressionAttributeNames=names, ExpressionAttributeValues=values, ReturnValues='ALL_NEW',
        )['Attributes']
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            raise NotFoundError('Agent not found') from exc
        raise _service_error('update the agent', exc) from exc
    except BotoCoreError as exc:
        raise _service_error('update the agent', exc) from exc


def set_agent_attributes(table: Any, agent_id: str, fields: Mapping[str, Any]) -> None:
    """Server-maintained bookkeeping (no updated_by/at): skip reasons, trigger state."""
    clause, names, values = _set_clause(fields)
    try:
        table.update_item(Key=agent_key(agent_id), UpdateExpression=f'SET {clause}',
                          ConditionExpression='attribute_exists(pk)',
                          ExpressionAttributeNames=names, ExpressionAttributeValues=values)
    except ClientError as exc:
        if not is_conditional_check_failure(exc):
            raise _service_error('update agent bookkeeping', exc) from exc
    except BotoCoreError as exc:
        raise _service_error('update agent bookkeeping', exc) from exc


def clear_lock(table: Any, agent_id: str, run_id: str) -> None:
    """Drop a lock left pointing at a run that is already terminal or gone."""
    try:
        table.update_item(Key=agent_key(agent_id), UpdateExpression='REMOVE active_run_id',
                          ConditionExpression='active_run_id = :run', ExpressionAttributeValues={':run': run_id})
    except ClientError as exc:
        if not is_conditional_check_failure(exc):
            raise _service_error('release the agent run lock', exc) from exc
    except BotoCoreError as exc:
        raise _service_error('release the agent run lock', exc) from exc


def agent_stats(item: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    today, month = now.strftime('%Y-%m-%d'), now.strftime('%Y-%m')
    return {
        'runs_total': _int_attr(item, 'runs_total'),
        'runs_completed': _int_attr(item, 'runs_completed'),
        'runs_failed': _int_attr(item, 'runs_failed'),
        'runs_cancelled': _int_attr(item, 'runs_cancelled'),
        'runs_needs_human': _int_attr(item, 'runs_needs_human'),
        'last_run_at': item.get('last_run_at'),
        'last_run_id': item.get('last_run_id'),
        'last_run_status': item.get('last_run_status'),
        'active_run_id': item.get('active_run_id'),
        'scheduled_runs_today': _int_attr(item, 'scheduled_count') if item.get('scheduled_day') == today else 0,
        'model_calls_this_month': _int_attr(item, 'month_calls') if item.get('month_key') == month else 0,
        'last_skip_reason': item.get('last_skip_reason'),
    }


def agent_view(item: Mapping[str, Any], now: datetime | None = None) -> dict[str, Any]:
    """The client shape of an agent row."""
    data = plain(dict(item))
    return {
        'agent_id': data.get('agent_id'),
        **{name: data.get(name) for name in EDITABLE_FIELDS},
        'status': data.get('status', AGENT_STATUS_ACTIVE),
        'created_by': data.get('created_by'),
        'created_at': data.get('created_at'),
        'updated_at': data.get('updated_at'),
        'stats': agent_stats(item, now or utc_now()),
    }


# --------------------------------------------------------------------------
# Workflows (library with revisions; `wf_default` is built in and read-only).
# --------------------------------------------------------------------------

BUILTIN_REVISION: Final = 1


def builtin_workflow() -> dict[str, Any]:
    """The built-in template as a CURRENT-shaped row (never stored)."""
    definition = workflow_schema.default_template()
    return {
        'workflow_id': workflow_schema.DEFAULT_WORKFLOW_ID, 'slug': workflow_schema.DEFAULT_WORKFLOW_SLUG,
        'name': definition['name'], 'description': definition['description'], 'revision': BUILTIN_REVISION,
        'definition': workflow_schema.encode_definition(definition), 'builtin': True, 'derived_from': None,
    }


def get_workflow(table: Any, workflow_id: str) -> dict | None:
    """The CURRENT row of ``workflow_id`` (the built-in for ``wf_default``), or None."""
    if workflow_id == workflow_schema.DEFAULT_WORKFLOW_ID:
        return builtin_workflow()
    try:
        item = table.get_item(Key=workflow_current_key(workflow_id), ConsistentRead=True).get('Item')
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('read the workflow', exc) from exc
    return item if isinstance(item, dict) else None


def list_workflows(table: Any) -> list[dict]:
    """Every stored workflow's CURRENT row, plus the built-in first."""
    return [builtin_workflow(), *_query_index(table, WORKFLOWS_GSI_PK, 'list workflows')]


def list_revisions(table: Any, workflow_id: str, limit: int = 50) -> list[dict]:
    """Newest-first revision summaries (no definitions)."""
    if workflow_id == workflow_schema.DEFAULT_WORKFLOW_ID:
        return [{'revision': BUILTIN_REVISION, 'saved_at': None, 'saved_by_username': None}]
    try:
        page = table.query(
            KeyConditionExpression=Key('pk').eq(f'WORKFLOW#{workflow_id}') & Key('sk').begins_with('REV#'),
            ScanIndexForward=False, Limit=limit,
            ProjectionExpression='revision, saved_at, saved_by_username',
        )
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('list workflow revisions', exc) from exc
    return [plain(item) for item in page.get('Items', [])]


def _revision_attrs(definition: Mapping[str, Any], revision: int, *, saved_by: str, username: str,
                    stamp: str) -> dict[str, Any]:
    return {'revision': revision, 'definition': workflow_schema.encode_definition(definition),
            'name': definition['name'], 'saved_at': stamp, 'saved_by': saved_by, 'saved_by_username': username}


def create_workflow(table: Any, definition: Mapping[str, Any], *, created_by: str, username: str,
                    now: datetime, derived_from: str | None = None) -> dict:
    """A new library workflow at revision 1 (CURRENT + REV#000001 in one transaction)."""
    workflow_id = new_workflow_id()
    stamp = iso(now)
    revision = _revision_attrs(definition, 1, saved_by=created_by, username=username, stamp=stamp)
    current = {
        **workflow_current_key(workflow_id), 'gsi1pk': WORKFLOWS_GSI_PK,
        'gsi1sk': f"{definition['name'].lower()}#{workflow_id}", 'workflow_id': workflow_id,
        'slug': workflow_schema.slugify(definition['name']), 'description': definition.get('description', ''),
        'derived_from': derived_from, 'created_at': stamp, 'created_by': created_by,
        'updated_at': stamp, 'updated_by_username': username, **revision,
    }
    rev_item = {**workflow_revision_key(workflow_id, 1), 'workflow_id': workflow_id, **revision}
    try:
        table.meta.client.transact_write_items(TransactItems=[
            {'Put': {'TableName': table.name, 'Item': current, 'ConditionExpression': 'attribute_not_exists(pk)'}},
            {'Put': {'TableName': table.name, 'Item': rev_item, 'ConditionExpression': 'attribute_not_exists(pk)'}},
        ])
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('create the workflow', exc) from exc
    return current


def save_revision(table: Any, workflow_id: str, definition: Mapping[str, Any], *, expected_revision: int,
                  saved_by: str, username: str, now: datetime) -> dict:
    """Append revision ``expected_revision + 1`` and move CURRENT to it; 409 when stale."""
    if workflow_id == workflow_schema.DEFAULT_WORKFLOW_ID:
        raise ConflictError('The built-in workflow is read-only; duplicate it to edit')
    new_revision = expected_revision + 1
    stamp = iso(now)
    revision = _revision_attrs(definition, new_revision, saved_by=saved_by, username=username, stamp=stamp)
    current_sets = {**revision, 'description': definition.get('description', ''), 'updated_at': stamp,
                    'updated_by_username': username, 'slug': workflow_schema.slugify(definition['name']),
                    'gsi1sk': f"{definition['name'].lower()}#{workflow_id}"}
    clause, names, values = _set_clause(current_sets)
    names['#rev'] = 'revision'
    names['#status'] = 'status'
    values[':expected'] = expected_revision
    values[':archived'] = WORKFLOW_STATUS_ARCHIVED
    try:
        table.meta.client.transact_write_items(TransactItems=[
            {'Update': {
                'TableName': table.name, 'Key': workflow_current_key(workflow_id),
                'UpdateExpression': f'SET {clause}', 'ConditionExpression': ('attribute_exists(pk) AND #rev = :expected '
                                        'AND (attribute_not_exists(#status) OR #status <> :archived)'),
                'ExpressionAttributeNames': names, 'ExpressionAttributeValues': values,
            }},
            {'Put': {'TableName': table.name,
                     'Item': {**workflow_revision_key(workflow_id, new_revision), 'workflow_id': workflow_id,
                              **revision},
                     'ConditionExpression': 'attribute_not_exists(pk)'}},
        ])
    except ClientError as exc:
        if not _is_cancelled_transaction(exc):
            raise _service_error('save the workflow', exc) from exc
        if get_workflow(table, workflow_id) is None:
            raise NotFoundError('Workflow not found') from exc
        raise ConflictError('The workflow was changed by someone else; reload and retry') from exc
    except BotoCoreError as exc:
        raise _service_error('save the workflow', exc) from exc
    current = get_workflow(table, workflow_id)
    if current is None:
        raise NotFoundError('Workflow not found')
    return current


def is_archived_workflow(item: Mapping[str, Any]) -> bool:
    return item.get('status') == WORKFLOW_STATUS_ARCHIVED


def archive_workflow(table: Any, workflow_id: str, *, archived_by: str, username: str, now: datetime) -> dict:
    """Mark a stored workflow archived (idempotent); 404 when it does not exist."""
    if workflow_id == workflow_schema.DEFAULT_WORKFLOW_ID:
        raise ConflictError('The built-in workflow cannot be archived')
    stamp = iso(now)
    try:
        response = table.update_item(
            Key=workflow_current_key(workflow_id),
            UpdateExpression=('SET #status = :archived, archived_at = if_not_exists(archived_at, :now), '
                              'archived_by = if_not_exists(archived_by, :by), updated_at = :now, '
                              'updated_by_username = :username'),
            ConditionExpression='attribute_exists(pk)',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':archived': WORKFLOW_STATUS_ARCHIVED, ':now': stamp,
                                       ':by': archived_by, ':username': username},
            ReturnValues='ALL_NEW',
        )
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            raise NotFoundError('Workflow not found') from exc
        raise _service_error('archive the workflow', exc) from exc
    except BotoCoreError as exc:
        raise _service_error('archive the workflow', exc) from exc
    return response['Attributes']


def workflow_view(item: Mapping[str, Any], *, include_definition: bool = True) -> dict[str, Any]:
    data = plain(dict(item))
    view = {
        'workflow_id': data.get('workflow_id'), 'slug': data.get('slug'), 'name': data.get('name'),
        'description': data.get('description', ''), 'revision': data.get('revision'),
        'derived_from': data.get('derived_from'), 'builtin': bool(data.get('builtin')),
        'created_at': data.get('created_at'), 'updated_at': data.get('updated_at'),
        'updated_by_username': data.get('updated_by_username'),
        'status': WORKFLOW_STATUS_ARCHIVED if is_archived_workflow(data) else AGENT_STATUS_ACTIVE,
    }
    if include_definition:
        view['definition'] = workflow_schema.decode_definition(data.get('definition'))
    return view


# --------------------------------------------------------------------------
# Runs: start (lock + caps), progress, finish, events.
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class RunStart:
    """What a starter asks for. ``extra_agent_sets`` lets the heartbeat record trigger state."""

    trigger: str
    requested_by: str
    workflow_revision: int
    review_since: str
    trigger_detail: Mapping[str, Any] | None = None
    counts_against_daily_cap: bool = False
    daily_cap: int = MAX_SCHEDULED_RUNS_PER_DAY
    extra_agent_sets: Mapping[str, Any] | None = None


def _daily_cap_clause(agent: Mapping[str, Any], today: str, cap: int) -> tuple[str, str, dict[str, Any]]:
    """(SET fragment, condition fragment, values) for the scheduled-runs-per-day counter."""
    if agent.get('scheduled_day') == today:
        return ('scheduled_count = scheduled_count + :one',
                'scheduled_day = :today AND scheduled_count < :cap', {':today': today, ':cap': cap, ':one': 1})
    return ('scheduled_day = :today, scheduled_count = :one',
            '(attribute_not_exists(scheduled_day) OR scheduled_day <> :today)', {':today': today, ':one': 1})


def start_run(table: Any, agent: Mapping[str, Any], request: RunStart, *, now: datetime) -> dict | None:
    """Write a queued run and take the agent's run lock atomically.

    Returns the run row, or None when the agent already has an active run, is
    archived/missing, or has used its scheduled runs for today. Starting the
    execution is the caller's next step (:func:`start_execution`).
    """
    if request.counts_against_daily_cap and request.daily_cap <= 0:
        return None
    agent_id, run_id, stamp = agent['agent_id'], new_run_id(now), iso(now)
    sets = {'active_run_id': run_id, 'last_run_at': stamp, 'last_run_id': run_id,
            'last_run_status': RUN_QUEUED, 'last_run_cursor': stamp, **(request.extra_agent_sets or {})}
    clause, names, values = _set_clause(sets)
    names['#status'] = 'status'
    values.update({':archived': AGENT_STATUS_ARCHIVED, ':zero': 0, ':inc': 1})
    update = f'SET {clause}, runs_total = if_not_exists(runs_total, :zero) + :inc'
    condition = 'attribute_exists(pk) AND #status <> :archived AND attribute_not_exists(active_run_id)'
    if request.counts_against_daily_cap:
        cap_set, cap_condition, cap_values = _daily_cap_clause(agent, now.strftime('%Y-%m-%d'), request.daily_cap)
        update, condition = f'{update}, {cap_set}', f'{condition} AND {cap_condition}'
        values.update(cap_values)
    run = {
        **run_key(agent_id, run_id), 'gsi1pk': RUNS_ACTIVE_GSI_PK, 'gsi1sk': f'{stamp}#{run_id}',
        'run_id': run_id, 'agent_id': agent_id, 'status': RUN_QUEUED, 'trigger': request.trigger,
        'trigger_detail': dict(request.trigger_detail or {}), 'requested_by': request.requested_by,
        'started_at': stamp, 'workflow_id': agent.get('workflow_id') or workflow_schema.DEFAULT_WORKFLOW_ID,
        'workflow_revision': request.workflow_revision,
        'review_window': {'since': request.review_since, 'until': stamp},
        'model_calls': 0, 'event_seq': 0,
    }
    try:
        table.meta.client.transact_write_items(TransactItems=[
            {'Update': {'TableName': table.name, 'Key': agent_key(agent_id), 'UpdateExpression': update,
                        'ConditionExpression': condition, 'ExpressionAttributeNames': names,
                        'ExpressionAttributeValues': values}},
            {'Put': {'TableName': table.name, 'Item': run, 'ConditionExpression': 'attribute_not_exists(pk)'}},
        ])
    except ClientError as exc:
        if _is_cancelled_transaction(exc):
            logger.info('Agent run not started', extra={'agent_id': agent_id, 'reasons': _cancellation_codes(exc)})
            return None
        raise _service_error('start the agent run', exc) from exc
    except BotoCoreError as exc:
        raise _service_error('start the agent run', exc) from exc
    return run


def get_run(table: Any, agent_id: str, run_id: str) -> dict | None:
    try:
        item = table.get_item(Key=run_key(agent_id, run_id), ConsistentRead=True).get('Item')
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('read the run', exc) from exc
    return item if isinstance(item, dict) else None


def list_runs(table: Any, agent_id: str, *, limit: int, cursor: object = None) -> tuple[list[dict], str | None]:
    """Newest-first runs of one agent, paginated."""
    kwargs: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(f'AGENT#{agent_id}') & Key('sk').begins_with('RUN#'),
        'ScanIndexForward': False, 'Limit': limit,
    }
    start = decode_cursor(cursor, f'AGENT#{agent_id}')
    if start:
        kwargs['ExclusiveStartKey'] = start
    try:
        page = table.query(**kwargs)
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('list runs', exc) from exc
    return page.get('Items', []), encode_cursor(page.get('LastEvaluatedKey'))


def run_view(item: Mapping[str, Any]) -> dict[str, Any]:
    data = plain(dict(item))
    keys = ('run_id', 'agent_id', 'status', 'trigger', 'trigger_detail', 'started_at', 'finished_at',
            'project_id', 'current_node_id', 'model_calls', 'error', 'workflow_id', 'workflow_revision',
            'review_window')
    return {key: data.get(key) for key in keys}


def _run_update(table: Any, agent_id: str, run_id: str, update: str, names: dict, values: dict,
                condition: str) -> dict | None:
    """One conditional run update; None when the condition refused it.

    ``ExpressionAttributeNames`` is sent only when there are names: DynamoDB refuses an
    empty map ("ExpressionAttributeNames must not be empty"), which made every Run now
    answer 500 after its execution had already started (E2E s2 F3).
    """
    kwargs: dict[str, Any] = {
        'Key': run_key(agent_id, run_id), 'UpdateExpression': update, 'ConditionExpression': condition,
        'ExpressionAttributeValues': values, 'ReturnValues': 'ALL_NEW',
    }
    if names:
        kwargs['ExpressionAttributeNames'] = names
    try:
        return table.update_item(**kwargs)['Attributes']
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            return None
        raise _service_error('update the run', exc) from exc
    except BotoCoreError as exc:
        raise _service_error('update the run', exc) from exc


def attach_execution(table: Any, agent_id: str, run_id: str, execution_arn: str) -> None:
    _run_update(table, agent_id, run_id, 'SET execution_arn = :arn', {}, {':arn': execution_arn},
                'attribute_exists(pk)')


def finish_run(table: Any, agent_id: str, run_id: str, status: str, *, now: datetime,
               error: str | None = None) -> dict | None:
    """Move an active run to a terminal ``status`` and release the agent's lock.

    Returns the updated run, or None when it was already terminal (idempotent).
    """
    if status not in TERMINAL_RUN_STATUSES:
        raise ValueError(f'not a terminal run status: {status}')
    sets: dict[str, Any] = {'status': status, 'finished_at': iso(now)}
    if error:
        sets['error'] = error[:500]
    clause, names, values = _set_clause(sets)
    names['#st'] = 'status'
    values.update({':queued': RUN_QUEUED, ':running': RUN_RUNNING})
    run = _run_update(table, agent_id, run_id, f'SET {clause} REMOVE gsi1pk, gsi1sk', names, values,
                      'attribute_exists(pk) AND #st IN (:queued, :running)')
    if run is None:
        return None
    release_lock(table, agent_id, run_id, status)
    return run


def release_lock(table: Any, agent_id: str, run_id: str, status: str) -> None:
    """Free the agent's run lock held by ``run_id`` and count the terminal ``status``.

    Every path that ends a run calls this — the API (cancel), the heartbeat
    (stale run) and the run interpreter (agents/store.finish_run) — so "Run now"
    is available again the moment a run ends. A lock already held by another
    run is left alone.
    """
    try:
        table.update_item(
            Key=agent_key(agent_id),
            UpdateExpression='REMOVE active_run_id SET last_run_status = :s, #c = if_not_exists(#c, :zero) + :one',
            ConditionExpression='active_run_id = :run',
            ExpressionAttributeNames={'#c': f'runs_{status}'},
            ExpressionAttributeValues={':s': status, ':run': run_id, ':zero': 0, ':one': 1},
        )
    except ClientError as exc:
        if not is_conditional_check_failure(exc):
            raise _service_error('release the agent run lock', exc) from exc
        logger.info('Agent lock already held by another run', extra={'agent_id': agent_id, 'run_id': run_id})
    except BotoCoreError as exc:
        raise _service_error('release the agent run lock', exc) from exc


def count_month_calls(table: Any, agent: Mapping[str, Any], calls: int, *, now: datetime) -> None:
    """Add ``calls`` to the agent's model calls this month (``month_key``/``month_calls`` on META).

    The ONE counter the heartbeat's monthly cap and the agents list read
    (:func:`agent_stats`); the run interpreter bumps it per reserved call.
    """
    month = now.strftime('%Y-%m')
    same_month = agent.get('month_key') == month
    update = 'ADD month_calls :n' if same_month else 'SET month_key = :m, month_calls = :n'
    condition = 'month_key = :m' if same_month else '(attribute_not_exists(month_key) OR month_key <> :m)'
    try:
        table.update_item(Key=agent_key(agent['agent_id']), UpdateExpression=update, ConditionExpression=condition,
                          ExpressionAttributeValues={':n': calls, ':m': month})
    except ClientError as exc:
        if not is_conditional_check_failure(exc):
            raise _service_error('count model calls', exc) from exc
        # Another writer rolled the month between our read and this write: it now
        # holds `month`, so the plain add is the right write.
        try:
            table.update_item(Key=agent_key(agent['agent_id']), UpdateExpression='ADD month_calls :n',
                              ConditionExpression='month_key = :m',
                              ExpressionAttributeValues={':n': calls, ':m': month})
        except (ClientError, BotoCoreError):
            logger.warning('Model calls not counted against the month', extra={'agent_id': agent['agent_id']})
    except BotoCoreError as exc:
        raise _service_error('count model calls', exc) from exc


def _event_fields(kind: str, summary: str, node_id: str | None, role: str | None,
                  ref: Mapping[str, Any] | None) -> dict[str, Any]:
    if kind not in EVENT_KINDS:
        raise ValueError(f'unknown run event kind: {kind}')
    if role is not None and role not in EVENT_ROLES:
        raise ValueError(f'unknown run event role: {role}')
    fields: dict[str, Any] = {'kind': kind, 'summary': summary[:MAX_EVENT_SUMMARY_CHARS]}
    if node_id:
        fields['node_id'] = node_id
    if role:
        fields['role'] = role
    clean_ref = {k: v for k, v in (ref or {}).items() if k in EVENT_REF_KEYS and isinstance(v, str) and v}
    if clean_ref:
        fields['ref'] = clean_ref
    return fields


def append_event(table: Any, agent_id: str, run_id: str, kind: str, summary: str, *, now: datetime,
                 node_id: str | None = None, role: str | None = None,
                 ref: Mapping[str, Any] | None = None) -> dict:
    """Append one event to a run's journal with the next sequence number."""
    fields = _event_fields(kind, summary, node_id, role, ref)
    counter = _run_update(table, agent_id, run_id, 'ADD event_seq :one', {}, {':one': 1}, 'attribute_exists(pk)')
    if counter is None:
        raise NotFoundError('Run not found')
    seq = _int_attr(counter, 'event_seq')
    item = {'pk': f'RUN#{run_id}', 'sk': f'EVT#{seq:08d}', 'run_id': run_id, 'seq': seq, 'at': iso(now), **fields}
    try:
        table.put_item(Item=item)
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('record the run event', exc) from exc
    return item


def list_events(table: Any, run_id: str, *, after: int, limit: int) -> list[dict]:
    """Events with ``seq > after``, oldest first."""
    try:
        page = table.query(
            KeyConditionExpression=Key('pk').eq(f'RUN#{run_id}') & Key('sk').between(
                f'EVT#{after + 1:08d}', 'EVT#99999999'),
            Limit=limit,
        )
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('list run events', exc) from exc
    keys = ('seq', 'at', 'kind', 'node_id', 'role', 'summary', 'ref')
    return [{k: v for k, v in plain(item).items() if k in keys} for item in page.get('Items', [])]


# --------------------------------------------------------------------------
# Step Functions.
# --------------------------------------------------------------------------

_sfn_client: Any = None


def _stepfunctions() -> Any:
    global _sfn_client
    if _sfn_client is None:
        _sfn_client = boto3.client('stepfunctions')
    return _sfn_client


def state_machine_arn() -> str:
    return os.environ.get(STATE_MACHINE_ENV, '')


def execution_arn_for(run: Mapping[str, Any]) -> str:
    """The run's execution ARN: the recorded one, else derived (executions are named after the run id).

    A run whose ``execution_arn`` was never recorded (the start succeeded, the bookkeeping write
    did not — E2E s2 F3) must still be stoppable; cancel used to skip it and the run went on.
    """
    recorded = run.get('execution_arn')
    if isinstance(recorded, str) and recorded:
        return recorded
    machine = state_machine_arn()
    if ':stateMachine:' not in machine or not is_run_id(run.get('run_id')):
        return ''
    return f"{machine.replace(':stateMachine:', ':execution:', 1)}:{run['run_id']}"


def start_execution(run: Mapping[str, Any]) -> str:
    """Start ``voc-agent-run`` for ``run`` (execution name = run id); its ARN."""
    response = _stepfunctions().start_execution(
        stateMachineArn=state_machine_arn(), name=run['run_id'],
        input=json.dumps({'run_id': run['run_id'], 'agent_id': run['agent_id']}),
    )
    return str(response['executionArn'])


def stop_execution(execution_arn: str) -> None:
    """Best effort: a run is already ``cancelled`` in the table, which the interpreter honours."""
    try:
        _stepfunctions().stop_execution(executionArn=execution_arn, cause='Cancelled by an admin')
    except (ClientError, BotoCoreError):
        logger.warning('Could not stop the agent run execution')


def launch_run(table: Any, run: Mapping[str, Any], *, now: datetime) -> dict:
    """Start the execution for a freshly queued run; on failure fail the run and free the lock."""
    try:
        arn = start_execution(run)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Agent run execution failed to start', extra={'run_id': run['run_id']})
        finish_run(table, run['agent_id'], run['run_id'], RUN_FAILED, now=now,
                   error='The run could not be started')
        raise ServiceError('Could not start the agent run. Please retry.') from exc
    attach_execution(table, run['agent_id'], run['run_id'], arn)
    append_event(table, run['agent_id'], run['run_id'], 'decision',
                 f"Run queued ({run['trigger']})", now=now, role='system')
    return {**run, 'execution_arn': arn}


def iter_days(first: str, last: str) -> Iterable[str]:
    """``YYYY-MM-DD`` strings from ``first`` to ``last`` inclusive (empty if reversed)."""
    start = datetime.strptime(first, '%Y-%m-%d').replace(tzinfo=UTC)
    end = datetime.strptime(last, '%Y-%m-%d').replace(tzinfo=UTC)
    while start <= end:
        yield start.strftime('%Y-%m-%d')
        start = datetime.fromtimestamp(start.timestamp() + 86_400, UTC)

