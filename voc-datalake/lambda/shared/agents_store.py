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
- agent log  ``AGENT#{agent_id}`` / ``LOG#{at}#{n}``: a pause or a resume (7.52.00, ``set_paused``), create-only

In a workspace (7.80.00, docs/multi-workspace.md, the project plan 3g3-a) the same rows are that workspace's own:
every key above starts ``WS#{ws}#`` (shared/ws_repo.py ``agent_pk``, ``workflow_pk``, ``agent_run_pk``, the listing
partitions ``agents_index_pk``), and each agent and workflow also has a row in the workspace's registry,
``WS#{ws}#AGENT_REGISTRY`` / ``AGENT#{id}`` or ``WORKFLOW#{id}`` (``agent_registry_pk``), written in the same
transaction as its first row: the export and the hard delete walk it. The functions that read or write an agent, its
history, a workflow or a run's rows take a keyword-only ``workspace`` (None: the deployment's rows, every request the
one sent before) and send every call in a workspace through the workspace layer (``ws_table``, shared/ingest_tables.py
``scoped_calls``, shared/scoped_query.py ``query_partition``), which refuses a key outside it before DynamoDB. The
run writers (``start_run``, ``finish_run``, ``append_event``, the lock and the counters) take none: runs are the
deployment's runtime's only, and the agents API refuses a run in a workspace before it reaches them.

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
from typing import Any, Final
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

from shared import agent_run_decisions, workflow_schema
from shared.agent_ids import AGENT_ID_RE, RUN_ID_RE, WORKFLOW_ID_RE
from shared.agent_run_decisions import RUN_NEEDS_HUMAN
from shared.aws import (
    consistent_item,
    get_dynamodb_resource,
    is_conditional_check_failure,
    update_unless_condition_fails,
)
from shared.category_access import CategoryScope, item_category
from shared.dynamo_paging import query_all
from shared.dynamo_values import plain
from shared.exceptions import ConfigurationError, ConflictError, NotFoundError, ServiceError, ValidationError
from shared.indexes import AGENTS_LISTING_INDEX
from shared.ingest_tables import scoped_calls
from shared.logging import logger
from shared.model_config import ALLOWED_MODEL_IDS
from shared.model_profile import payload_fields
from shared.request_body import validated_text as _text
from shared.row_ids import validated_row_id
from shared.scoped_query import SortRange, query_partition
from shared.source_profiles import SOURCE_ID_RE
from shared.update_expressions import set_clause
from shared.ws_repo import (
    WorkspaceScope,
    agent_pk,
    agent_registry_pk,
    agent_run_pk,
    agents_index_pk,
    workflow_pk,
    ws_table,
)

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
RUN_COMPLETED: Final = 'completed'
RUN_FAILED: Final = 'failed'
RUN_CANCELLED: Final = 'cancelled'
ACTIVE_RUN_STATUSES: Final = (RUN_QUEUED, RUN_RUNNING)
TERMINAL_RUN_STATUSES: Final = (RUN_NEEDS_HUMAN, RUN_COMPLETED, RUN_FAILED, RUN_CANCELLED)

TRIGGER_MANUAL: Final = 'manual'
TRIGGER_SCHEDULE: Final = 'schedule'
TRIGGER_NEW_REVIEWS: Final = 'new_reviews'
TRIGGER_THRESHOLD: Final = 'threshold'
#: An engineering agent's trigger (7.47.00): a labelled GitHub issue of its connection's repository, from the data lake.
TRIGGER_GITHUB_ISSUE: Final = 'github_issue'

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
# An engineering agent (7.47.00, docs/autonomous-agents.md "Engineering agents"): its own daily cap and instructions.
MAX_ENGINEERING_RUNS_PER_DAY: Final = 5
DEFAULT_ENGINEERING_RUNS_PER_DAY: Final = 1
#: An engineering agent's instructions become the trusted start of its run's goal (500 characters at most, refused).
MAX_ENGINEERING_INSTRUCTIONS_CHARS: Final = 300
#: What an engineering agent works on: the ``feedback_type`` of the reviews and issues it takes (shared/feedback_types).
ENGINEERING_FEEDBACK_TYPES: Final = ('bug', 'feature_request')
ENGINEERING_FIELDS: Final = frozenset({'connection', 'language', 'feedback_type'})
#: A ``github_issue`` trigger's label (GitHub's own limit is 50 characters) and its look-back.
DEFAULT_ISSUE_LABEL: Final = 'voc-agent'
MAX_ISSUE_LABEL_CHARS: Final = 50
DEFAULT_ISSUE_LOOKBACK_DAYS: Final = 7
MAX_ISSUE_LOOKBACK_DAYS: Final = 30
#: A ``github_issue`` trigger's stage (7.50.00): ``act`` (a Bug fixer, a Feature builder: the issue's run, today's
#: claim) or ``triage`` (the Issue triage automation: its own claim beside the act one, so triaging an issue never
#: keeps the agent that acts on it from it).
ISSUE_STAGE_ACT: Final = 'act'
ISSUE_STAGE_TRIAGE: Final = 'triage'
ISSUE_STAGES: Final = (ISSUE_STAGE_ACT, ISSUE_STAGE_TRIAGE)
#: The triage kind an act trigger may require (``requires_triage``): the issue's trusted triage row must say it.
REQUIRED_TRIAGE_KINDS: Final = ('bug', 'feature')
#: ``scope.sources``: the ``source_platform`` ids an agent's reviews come from (none: every source).
MAX_SCOPE_SOURCES: Final = 20
DEFAULT_MODEL_CALLS_PER_RUN: Final = 150
MIN_MODEL_CALLS_PER_RUN: Final = 10
MAX_MODEL_CALLS_PER_RUN: Final = 500
DEFAULT_MONTHLY_CALL_CAP: Final = 5000
MAX_MONTHLY_CALL_CAP: Final = 1_000_000

_AGENT_ID_RE: Final = AGENT_ID_RE
_WORKFLOW_ID_RE: Final = WORKFLOW_ID_RE
_RUN_ID_RE: Final = RUN_ID_RE
#: A repository connection's id (engineering/connectors/connections.py CONNECTION_ID; a lockstep test holds them equal).
CONNECTION_ID_RE: Final = re.compile(r'[a-z0-9][a-z0-9-]{0,62}')
#: A toolchain's name as the engineering runtime lists them (engineering/runtime/egress.py REGISTRY_HOSTS); the agents
#: API checks the name against that list, this only its shape.
_LANGUAGE_RE: Final = re.compile(r'[a-z][a-z0-9+-]{0,31}')

# Fields a create/update body may set; everything else is server-maintained.
EDITABLE_FIELDS: Final = (
    'name', 'description', 'enabled', 'owner_sub', 'scope', 'instructions', 'personas',
    'triggers', 'models', 'output', 'workflow_id', 'budget', 'engineering',
)


# --------------------------------------------------------------------------
# Ids, clocks, keys, value plumbing.
# --------------------------------------------------------------------------

def utc_now() -> datetime:
    return datetime.now(UTC)


def iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec='seconds')


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


def _agent_partition(agent_id: str, workspace: WorkspaceScope | None) -> str:
    """The agent's partition: ``AGENT#{id}``, or the workspace's (shared/ws_repo.py ``agent_pk``)."""
    return f'AGENT#{agent_id}' if workspace is None else agent_pk(workspace, agent_id)


def _workflow_partition(workflow_id: str, workspace: WorkspaceScope | None) -> str:
    return f'WORKFLOW#{workflow_id}' if workspace is None else workflow_pk(workspace, workflow_id)


def _events_partition(run_id: str, workspace: WorkspaceScope | None) -> str:
    return f'RUN#{run_id}' if workspace is None else agent_run_pk(workspace, run_id)


def _listing(gsi_pk: str, workspace: WorkspaceScope | None) -> str:
    """A ``gsi1`` listing partition (``AGENTS``, ``WORKFLOWS``, ``RUNS_ACTIVE``), the workspace's in one."""
    return gsi_pk if workspace is None else agents_index_pk(workspace, gsi_pk)


def agent_key(agent_id: str, *, workspace: WorkspaceScope | None = None) -> dict[str, str]:
    return {'pk': _agent_partition(agent_id, workspace), 'sk': META_SK}


def run_key(agent_id: str, run_id: str, *, workspace: WorkspaceScope | None = None) -> dict[str, str]:
    return {'pk': _agent_partition(agent_id, workspace), 'sk': f'RUN#{run_id}'}


def workflow_current_key(workflow_id: str, *, workspace: WorkspaceScope | None = None) -> dict[str, str]:
    return {'pk': _workflow_partition(workflow_id, workspace), 'sk': CURRENT_SK}


def workflow_revision_key(workflow_id: str, revision: int, *,
                          workspace: WorkspaceScope | None = None) -> dict[str, str]:
    return {'pk': _workflow_partition(workflow_id, workspace), 'sk': f'REV#{revision:06d}'}


def _registry_entry(sort_key: str, row_id_field: str, row_id: str, stamp: str,
                    workspace: WorkspaceScope) -> dict[str, Any]:
    """The registry row of an agent or workflow of ``workspace`` (``WS#{ws}#AGENT_REGISTRY`` / ``AGENT#{id}`` or
    ``WORKFLOW#{id}``), put create-only in the transaction that writes its first row."""
    return {'Put': {'Item': {'pk': agent_registry_pk(workspace), 'sk': sort_key, row_id_field: row_id,
                             'created_at': stamp},
                    'ConditionExpression': 'attribute_not_exists(pk)'}}


def _calls(table: Any, workspace: WorkspaceScope | None) -> Any:
    """``table``'s single-item calls in ``workspace``: the table itself without one (every request as before), else
    the workspace's view (shared/ingest_tables.py ``scoped_calls``), which refuses a key outside it."""
    return scoped_calls(table, workspace)


def _transact(table: Any, entries: list[dict[str, Any]], workspace: WorkspaceScope | None) -> None:
    """One ``TransactWriteItems`` of ``entries`` (each ``{action: body}``, no ``TableName``) on ``table``: through
    the table's client without a workspace (each entry naming the table, the request sent before), through the
    workspace's view in one (every key checked, one outside it refusing the whole transaction before it is sent)."""
    if workspace is not None:
        ws_table(workspace, table).transact_write_items(entries)
        return
    table.meta.client.transact_write_items(TransactItems=[
        {action: {'TableName': table.name, **body} for action, body in entry.items()} for entry in entries])


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


def require_agents_table() -> Any:
    """The ``voc-agents`` table resource; ConfigurationError when ``AGENTS_TABLE`` is unset (a route's 500)."""
    table = get_agents_table()
    if table is None:
        raise ConfigurationError('Agents table not configured')
    return table


def _service_error(what: str, exc: Exception) -> ServiceError:
    logger.exception(f'Agents store: {what} failed', extra={'error_type': type(exc).__name__})  # noqa: LOG004 — only called from an except handler, which supplies the traceback
    return ServiceError(f'Could not {what}. Please retry.')


def _cancellation_codes(error: ClientError) -> list[str]:
    reasons = error.response.get('CancellationReasons') or []
    return [str((reason or {}).get('Code') or 'None') for reason in reasons]


def _is_cancelled_transaction(error: Exception) -> bool:
    return isinstance(error, ClientError) and error.response.get('Error', {}).get('Code') == \
        'TransactionCanceledException'


def _query_index(table: Any, gsi_pk: str, what: str, workspace: WorkspaceScope | None = None) -> list[dict]:
    """Every row of one ``gsi1`` partition (agents, workflows, active runs: small by design), the workspace's in one."""
    try:
        if workspace is not None:
            return list(ws_table(workspace, table).iter_query('gsi1pk', _listing(gsi_pk, workspace),
                                                              IndexName=AGENTS_INDEX))
        kwargs: dict[str, Any] = {'IndexName': AGENTS_INDEX, 'KeyConditionExpression': Key('gsi1pk').eq(gsi_pk)}
        return query_all(table, kwargs)
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


def _sources(value: object) -> list[str]:
    """``scope.sources``: the ``source_platform`` ids the agent's reviews must come from (empty: every source)."""
    sources = [] if value is None else value
    if (not isinstance(sources, list) or len(sources) > MAX_SCOPE_SOURCES
            or not all(isinstance(each, str) and SOURCE_ID_RE.match(each) for each in sources)):
        raise ValidationError(f'scope.sources must name at most {MAX_SCOPE_SOURCES} sources by their id (lower case, '
                              'digits, "_" or "-")')
    return list(dict.fromkeys(sources))


def _with_sources(scope: dict[str, Any], sources: list[str]) -> dict[str, Any]:
    """The scope as stored: ``sources`` only when it names any (a scope from before 7.47.00 reads the same)."""
    return {**scope, 'sources': sources} if sources else scope


def normalize_scope(value: object, categories_config: list[dict]) -> dict[str, Any]:
    """``{all, categories, subcategories, sources?}`` checked against the categories config."""
    raw = _object(value, 'scope')
    sources = _sources(raw.get('sources'))
    if _flag(raw.get('all'), 'scope.all', not {key for key in raw if key != 'sources'}):
        return _with_sources({'all': True, 'categories': [], 'subcategories': []}, sources)
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
    for raw_entry in subcategories:
        entry = _object(raw_entry, 'scope.subcategories entry')
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
    return _with_sources({'all': False, 'categories': names, 'subcategories': subs}, sources)


def _issue_trigger(raw: Mapping[str, Any]) -> dict[str, Any]:
    """``github_issue``: ``{label, trusted_authors, lookback_days, stage?, requires_triage?}`` (the label
    ``voc-agent`` when left out; an empty label only on a private repository, which the agents API checks against the
    agent's connection). ``stage`` (7.50.00): ``act`` when left out, kept only when ``triage``; ``requires_triage``
    (``bug`` or ``feature``, an act trigger's only): kept only when set."""
    label = raw.get('label', DEFAULT_ISSUE_LABEL)
    stage = _choice(raw.get('stage') or ISSUE_STAGE_ACT, 'github_issue stage', ISSUE_STAGES)
    required = raw.get('requires_triage')
    trigger = {'kind': TRIGGER_GITHUB_ISSUE,
               'label': _text(DEFAULT_ISSUE_LABEL if label is None else label, 'label', MAX_ISSUE_LABEL_CHARS),
               'trusted_authors': _flag(raw.get('trusted_authors'), 'trusted_authors', False),
               'lookback_days': _whole(raw.get('lookback_days'), 'lookback_days', 1, MAX_ISSUE_LOOKBACK_DAYS,
                                       DEFAULT_ISSUE_LOOKBACK_DAYS)}
    if stage == ISSUE_STAGE_TRIAGE:
        if required is not None:
            raise ValidationError('a triage trigger requires no triage: requires_triage is an act trigger\'s')
        trigger['stage'] = ISSUE_STAGE_TRIAGE
    elif required is not None:
        trigger['requires_triage'] = _choice(required, 'github_issue requires_triage', REQUIRED_TRIAGE_KINDS)
    return trigger


def issue_stage(trigger: Mapping[str, Any]) -> str:
    """A ``github_issue`` trigger's stage: ``triage`` when it says so, else ``act``."""
    return ISSUE_STAGE_TRIAGE if trigger.get('stage') == ISSUE_STAGE_TRIAGE else ISSUE_STAGE_ACT


def _trigger(value: object) -> dict[str, Any]:
    raw = _object(value, 'trigger')
    kind = _choice(raw.get('kind'), 'trigger kind',
                   (TRIGGER_NEW_REVIEWS, TRIGGER_SCHEDULE, TRIGGER_THRESHOLD, TRIGGER_GITHUB_ISSUE))
    if kind == TRIGGER_GITHUB_ISSUE:
        return _issue_trigger(raw)
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


def _triggers(value: object, *, engineering: bool, sources: bool) -> list[dict[str, Any]]:
    """The triggers; ``github_issue`` (at most one) only for an engineering agent, and ``threshold`` never with
    ``scope.sources`` (its counters have no source dimension, so it would count every source's reviews)."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_TRIGGERS:
        raise ValidationError(f'triggers must be a list of at most {MAX_TRIGGERS}')
    triggers = [_trigger(entry) for entry in value]
    kinds = [trigger['kind'] for trigger in triggers]
    if TRIGGER_GITHUB_ISSUE in kinds and not engineering:
        raise ValidationError("a github_issue trigger is an engineering agent's: give the agent its engineering settings")
    if kinds.count(TRIGGER_GITHUB_ISSUE) > 1:
        raise ValidationError('an agent has at most one github_issue trigger')
    if TRIGGER_THRESHOLD in kinds and sources:
        raise ValidationError('a threshold trigger counts every source: remove scope.sources, or use new_reviews')
    return triggers


def _personas(value: object) -> dict[str, Any]:
    raw = _object(value, 'personas')
    fixed = raw.get('fixed') or []
    if not isinstance(fixed, list) or len(fixed) > MAX_FIXED_PERSONAS:
        raise ValidationError(f'personas.fixed must be a list of at most {MAX_FIXED_PERSONAS}')
    refs: list[dict[str, str]] = []
    for raw_entry in fixed:
        entry = _object(raw_entry, 'personas.fixed entry')
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


def _budget(value: object, *, engineering: bool) -> dict[str, Any]:
    """The budget; an engineering agent's runs per day are 0-5 (default 1): what each of its runs may spend is its
    flow's monthly budget and the run caps, not model calls."""
    raw = _object(value, 'budget')
    cap = raw.get('monthly_call_cap', DEFAULT_MONTHLY_CALL_CAP)
    most, default = ((MAX_ENGINEERING_RUNS_PER_DAY, DEFAULT_ENGINEERING_RUNS_PER_DAY) if engineering
                     else (MAX_SCHEDULED_RUNS_PER_DAY, MAX_SCHEDULED_RUNS_PER_DAY))
    return {
        'max_scheduled_runs_per_day': _whole(raw.get('max_scheduled_runs_per_day'), 'max_scheduled_runs_per_day',
                                             0, most, default),
        'max_model_calls_per_run': _whole(raw.get('max_model_calls_per_run'), 'max_model_calls_per_run',
                                          MIN_MODEL_CALLS_PER_RUN, MAX_MODEL_CALLS_PER_RUN,
                                          DEFAULT_MODEL_CALLS_PER_RUN),
        # null is an explicit "uncapped", never the default.
        'monthly_call_cap': None if cap is None else _whole(cap, 'monthly_call_cap', 0, MAX_MONTHLY_CALL_CAP,
                                                            DEFAULT_MONTHLY_CALL_CAP),
    }


def _optional_id(value: object, label: str, pattern: re.Pattern[str]) -> str | None:
    """An optional setting of an engineering agent: None for none (or ''), else a name ``pattern`` takes."""
    if value is None or value == '':
        return None
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValidationError(f'{label} is not a valid name')
    return value


def normalize_engineering(value: object) -> dict[str, Any] | None:
    """``engineering``: ``{connection, language, feedback_type}``; None for an agent that runs an agents workflow.

    ``connection`` and ``language`` may be None while the agent is disabled ("Set up" in the web app): enabling it
    needs both (the agents API, which also checks that the connection is stored and that the language has an image).
    ``feedback_type``: what the agent works on, ``bug`` (the default) or ``feature_request``.
    """
    if value is None:
        return None
    raw = _object(value, 'engineering')
    if set(raw) - ENGINEERING_FIELDS:
        raise ValidationError('engineering takes connection, language and feedback_type only')
    return {'connection': _optional_id(raw.get('connection'), 'engineering.connection', CONNECTION_ID_RE),
            'language': _optional_id(raw.get('language'), 'engineering.language', _LANGUAGE_RE),
            'feedback_type': _choice(raw.get('feedback_type'), 'engineering.feedback_type', ENGINEERING_FEEDBACK_TYPES,
                                     ENGINEERING_FEEDBACK_TYPES[0])}


def is_engineering_agent(agent: Mapping[str, Any]) -> bool:
    """An agent that runs an engineering flow (it has ``engineering`` settings, 7.47.00)."""
    return isinstance(agent.get('engineering'), Mapping)


def normalize_agent(body: Mapping[str, Any], categories_config: list[dict],
                    base: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The editable agent fields, validated; ``base`` (an existing agent) fills omissions.

    ``workflow_id`` is only shape-checked here (existence is the caller's read). An engineering agent (``engineering``
    set) keeps its instructions to ``MAX_ENGINEERING_INSTRUCTIONS_CHARS`` and its runs per day to 0-5; only it may
    have a ``github_issue`` trigger.
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
    engineering = normalize_engineering(merged.get('engineering'))
    scope = normalize_scope(merged.get('scope'), categories_config)
    instructions_limit = MAX_INSTRUCTIONS_CHARS if engineering is None else MAX_ENGINEERING_INSTRUCTIONS_CHARS
    return {
        'name': _text(merged.get('name'), 'name', MAX_NAME_CHARS, required=True),
        'description': _text(merged.get('description'), 'description', MAX_DESCRIPTION_CHARS),
        'enabled': _flag(merged.get('enabled'), 'enabled', False),
        'owner_sub': owner_sub,
        'scope': scope,
        'instructions': _text(merged.get('instructions'), 'instructions', instructions_limit),
        'personas': _personas(merged.get('personas')),
        'triggers': _triggers(merged.get('triggers'), engineering=engineering is not None,
                              sources=bool(scope.get('sources'))),
        'models': _models(merged.get('models')),
        'output': {'visibility': _choice(output.get('visibility'), 'output.visibility', VISIBILITIES, 'private')},
        'workflow_id': workflow_id,
        'budget': _budget(merged.get('budget'), engineering=engineering is not None),
        'engineering': engineering,
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
    """True when a feedback item falls inside an agent's scope (its ``sources`` first, when it names any)."""
    sources = scope.get('sources')
    if isinstance(sources, list) and sources and item.get('source_platform') not in sources:
        return False
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

def get_agent(table: Any, agent_id: str, *, workspace: WorkspaceScope | None = None) -> dict | None:
    try:
        item = _calls(table, workspace).get_item(Key=agent_key(agent_id, workspace=workspace),
                                                 ConsistentRead=True).get('Item')
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('read the agent', exc) from exc
    return item if isinstance(item, dict) else None


def list_agents(table: Any, *, workspace: WorkspaceScope | None = None) -> list[dict]:
    """Every agent row (≤ a few dozen by design), name order: the workspace's own in one."""
    return _query_index(table, AGENTS_GSI_PK, 'list agents', workspace)


def create_agent(table: Any, fields: Mapping[str, Any], *, created_by: str, now: datetime,
                 workspace: WorkspaceScope | None = None) -> dict:
    """A new agent; in a workspace, its registry row in the same transaction."""
    agent_id = new_agent_id()
    stamp = iso(now)
    item = {
        **agent_key(agent_id, workspace=workspace), 'gsi1pk': _listing(AGENTS_GSI_PK, workspace),
        'gsi1sk': fields['name'], 'agent_id': agent_id, **fields, 'owner_sub': fields.get('owner_sub') or created_by,
        'status': AGENT_STATUS_ACTIVE, 'created_by': created_by, 'created_at': stamp,
        'updated_by': created_by, 'updated_at': stamp,
        # New reviews are counted from creation, never from the start of history.
        'last_run_cursor': stamp, 'runs_total': 0,
    }
    try:
        if workspace is None:
            table.put_item(Item=item, ConditionExpression='attribute_not_exists(pk)')
        else:
            _transact(table, [{'Put': {'Item': item, 'ConditionExpression': 'attribute_not_exists(pk)'}},
                              _registry_entry(f'AGENT#{agent_id}', 'agent_id', agent_id, stamp, workspace)], workspace)
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('create the agent', exc) from exc
    return item


def update_agent(table: Any, agent_id: str, fields: Mapping[str, Any], *, updated_by: str, now: datetime,
                 allow_archived: bool = False, workspace: WorkspaceScope | None = None) -> dict:
    """SET ``fields`` (plus updated_by/at) on an existing agent; 404 when missing/archived."""
    to_set = {**fields, 'updated_by': updated_by, 'updated_at': iso(now)}
    if 'name' in fields:
        to_set['gsi1sk'] = fields['name']
    clause, names, values = set_clause(to_set)
    condition = 'attribute_exists(pk)'
    if not allow_archived:
        condition += ' AND #status <> :archived'
        names['#status'] = 'status'
        values[':archived'] = AGENT_STATUS_ARCHIVED
    try:
        return _calls(table, workspace).update_item(
            Key=agent_key(agent_id, workspace=workspace), UpdateExpression=f'SET {clause}',
            ConditionExpression=condition, ExpressionAttributeNames=names, ExpressionAttributeValues=values,
            ReturnValues='ALL_NEW',
        )['Attributes']
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            raise NotFoundError('Agent not found') from exc
        raise _service_error('update the agent', exc) from exc
    except BotoCoreError as exc:
        raise _service_error('update the agent', exc) from exc


def set_agent_attributes(table: Any, agent_id: str, fields: Mapping[str, Any]) -> None:
    """Server-maintained bookkeeping (no updated_by/at): skip reasons, trigger state."""
    clause, names, values = set_clause(fields)
    try:
        update_unless_condition_fails(table, Key=agent_key(agent_id), UpdateExpression=f'SET {clause}',
                                      ConditionExpression='attribute_exists(pk)',
                                      ExpressionAttributeNames=names, ExpressionAttributeValues=values)
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('update agent bookkeeping', exc) from exc


def record_skip(table: Any, agent: Mapping[str, Any], reason: str) -> str:
    """The agent's skip ``reason`` (a cap, ``not_set_up``, an engineering agent's ``owner_not_admin`` or
    ``token_expired``), stored the first time it is hit (the Agents page shows it); the reason."""
    if agent.get('last_skip_reason') != reason:
        set_agent_attributes(table, agent['agent_id'], {'last_skip_reason': reason})
    return reason


def clear_lock(table: Any, agent_id: str, run_id: str) -> None:
    """Drop a lock left pointing at a run that is already terminal or gone."""
    try:
        update_unless_condition_fails(table, Key=agent_key(agent_id), UpdateExpression='REMOVE active_run_id',
                                      ConditionExpression='active_run_id = :run',
                                      ExpressionAttributeValues={':run': run_id})
    except (ClientError, BotoCoreError) as exc:
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
        # An engineering agent runs as the administrator who enabled it (7.47.00): their name, beside owner_sub.
        'owner_username': data.get('owner_username'),
        'created_by': data.get('created_by'),
        'created_at': data.get('created_at'),
        'updated_at': data.get('updated_at'),
        # An automation an administrator paused (7.52.00, ``set_paused``): on, and no run starts by itself until resumed.
        'paused': data.get('paused') is True,
        'paused_at': data.get('paused_at'),
        'paused_by': data.get('paused_by'),
        'stats': agent_stats(item, now or utc_now()),
    }


# --------------------------------------------------------------------------
# Paused (7.52.00): an automation that is on, held by an administrator. The heartbeat starts no run of it (no
# schedule, no new reviews, no threshold, no issue) until someone resumes it; Run now still runs it. Each change is
# written with a create-only history row in the agent's partition, ``LOG#<at>#<n>`` (D1, D4: who, when, what), in the
# same transaction. Only an automation that is on is paused, and turning it off ends its pause (logged as resumed,
# ``via: disabled``), so a paused agent is always an enabled one.
# --------------------------------------------------------------------------

NOT_ON: Final = 'only an automation that is on is paused: this one is off'
PAUSE_MOVED: Final = 'the automation changed since you read it: read it again'


def agent_log_key(agent_id: str, at: datetime, *, workspace: WorkspaceScope | None = None) -> dict[str, str]:
    """A create-only history row of the agent (``LOG#<at, to the microsecond>#<n>``: in the order they were made, and
    two changes at one instant never share a key), in the agent's own partition."""
    return {'pk': _agent_partition(agent_id, workspace),
            'sk': f'LOG#{at.astimezone(UTC).isoformat(timespec="microseconds")}#{secrets.token_hex(4)}'}


def set_paused(table: Any, agent_id: str, paused: bool, *, by: str, username: str, now: datetime,
               via: str = 'route', workspace: WorkspaceScope | None = None) -> dict:
    """Pause (``paused``) or resume the agent, with its history row, in one transaction; the agent as saved. A pause
    needs the agent on and not paused, a resume a paused one (409 ``PAUSE_MOVED`` when that changed since it was read;
    404 for an agent gone or archived). ``via``: what asked (the route, or turning the agent off)."""
    stamp = iso(now)
    values: dict[str, Any] = {':true': True, ':at': stamp, ':by': by}
    if paused:
        change: dict[str, Any] = {
            'UpdateExpression': ('SET paused = :true, paused_at = :at, paused_by = :username, '
                                 'updated_at = :at, updated_by = :by'),
            'ConditionExpression': ('attribute_exists(pk) AND #status <> :archived AND enabled = :true '
                                    'AND (attribute_not_exists(paused) OR paused <> :true)'),
            'ExpressionAttributeNames': {'#status': 'status'},
            'ExpressionAttributeValues': {**values, ':username': username, ':archived': AGENT_STATUS_ARCHIVED}}
    else:
        change = {
            'UpdateExpression': ('SET paused = :false, updated_at = :at, updated_by = :by '
                                 'REMOVE paused_at, paused_by'),
            'ConditionExpression': 'attribute_exists(pk) AND paused = :true',
            'ExpressionAttributeValues': {**values, ':false': False}}
    log = {**agent_log_key(agent_id, now, workspace=workspace), 'event': 'paused' if paused else 'resumed', 'by': by,
           'username': username, 'at': stamp, 'via': via}
    try:
        _transact(table, [
            {'Update': {'Key': agent_key(agent_id, workspace=workspace), **change}},
            {'Put': {'Item': log, 'ConditionExpression': 'attribute_not_exists(sk)'}},
        ], workspace)
    except ClientError as exc:
        if not _is_cancelled_transaction(exc):
            raise _service_error('pause or resume the agent', exc) from exc
        found = get_agent(table, agent_id, workspace=workspace)
        if found is None or found.get('status') == AGENT_STATUS_ARCHIVED:
            raise NotFoundError('Agent not found') from exc
        raise ConflictError(NOT_ON if paused and found.get('enabled') is not True else PAUSE_MOVED) from exc
    except BotoCoreError as exc:
        raise _service_error('pause or resume the agent', exc) from exc
    found = get_agent(table, agent_id, workspace=workspace)
    if found is None:
        raise NotFoundError('Agent not found')
    return found


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


def get_workflow(table: Any, workflow_id: str, *, workspace: WorkspaceScope | None = None) -> dict | None:
    """The CURRENT row of ``workflow_id`` (the built-in for ``wf_default``, in every scope), or None."""
    if workflow_id == workflow_schema.DEFAULT_WORKFLOW_ID:
        return builtin_workflow()
    try:
        item = _calls(table, workspace).get_item(Key=workflow_current_key(workflow_id, workspace=workspace),
                                                 ConsistentRead=True).get('Item')
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('read the workflow', exc) from exc
    return item if isinstance(item, dict) else None


def list_workflows(table: Any, *, workspace: WorkspaceScope | None = None) -> list[dict]:
    """Every stored workflow's CURRENT row (the workspace's own in one), plus the built-in first."""
    return [builtin_workflow(), *_query_index(table, WORKFLOWS_GSI_PK, 'list workflows', workspace)]


def list_revisions(table: Any, workflow_id: str, limit: int = 50, *,
                   workspace: WorkspaceScope | None = None) -> list[dict]:
    """Newest-first revision summaries (no definitions)."""
    if workflow_id == workflow_schema.DEFAULT_WORKFLOW_ID:
        return [{'revision': BUILTIN_REVISION, 'saved_at': None, 'saved_by_username': None}]
    try:
        page = query_partition(
            workspace, table, 'pk', _workflow_partition(workflow_id, workspace), sort=SortRange('sk', 'begins_with', 'REV#'),
            ScanIndexForward=False, Limit=limit, ProjectionExpression='revision, saved_at, saved_by_username',
        )
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('list workflow revisions', exc) from exc
    return [plain(item) for item in page.get('Items', [])]


MAX_REVISION: Final = 999_999  # the `REV#{revision:06d}` sort key holds six digits


def _revision_view(workflow_id: str, row: Mapping[str, Any]) -> dict[str, Any]:
    """A revision as served: the allowlisted fields only (``saved_by``, the saver's sub, is never served)."""
    data = plain(dict(row))
    return {'workflow_id': workflow_id, 'revision': data.get('revision'), 'name': data.get('name'),
            'definition': workflow_schema.decode_definition(data.get('definition')),
            'saved_at': data.get('saved_at'), 'saved_by_username': data.get('saved_by_username')}


def get_revision(table: Any, workflow_id: str, revision: int, *,
                 workspace: WorkspaceScope | None = None) -> dict[str, Any] | None:
    """One revision of ``workflow_id`` as served, or None when it has no such revision.

    The built-in ``wf_default`` has exactly one revision: the built-in template.
    """
    if workflow_id == workflow_schema.DEFAULT_WORKFLOW_ID:
        return _revision_view(workflow_id, builtin_workflow()) if revision == BUILTIN_REVISION else None
    try:
        item = _calls(table, workspace).get_item(Key=workflow_revision_key(workflow_id, revision, workspace=workspace),
                                                 ConsistentRead=True).get('Item')
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('read the workflow revision', exc) from exc
    return _revision_view(workflow_id, item) if isinstance(item, dict) else None


def _revision_attrs(definition: Mapping[str, Any], revision: int, *, saved_by: str, username: str,
                    stamp: str) -> dict[str, Any]:
    # `saved_by` (the saver's sub) is an audit trail: stored, never served; views show `saved_by_username`.
    return {'revision': revision, 'definition': workflow_schema.encode_definition(definition),
            'name': definition['name'], 'saved_at': stamp, 'saved_by': saved_by, 'saved_by_username': username}


def create_workflow(table: Any, definition: Mapping[str, Any], *, created_by: str, username: str,
                    now: datetime, derived_from: str | None = None, workspace: WorkspaceScope | None = None) -> dict:
    """A new library workflow at revision 1 (CURRENT + REV#000001 in one transaction; in a workspace its registry
    row too)."""
    workflow_id = new_workflow_id()
    stamp = iso(now)
    revision = _revision_attrs(definition, 1, saved_by=created_by, username=username, stamp=stamp)
    current = {
        **workflow_current_key(workflow_id, workspace=workspace), 'gsi1pk': _listing(WORKFLOWS_GSI_PK, workspace),
        'gsi1sk': f"{definition['name'].lower()}#{workflow_id}", 'workflow_id': workflow_id,
        'slug': workflow_schema.slugify(definition['name']), 'description': definition.get('description', ''),
        'derived_from': derived_from, 'created_at': stamp, 'created_by': created_by,
        'updated_at': stamp, 'updated_by_username': username, **revision,
    }
    rev_item = {**workflow_revision_key(workflow_id, 1, workspace=workspace), 'workflow_id': workflow_id, **revision}
    entries: list[dict[str, Any]] = [
        {'Put': {'Item': current, 'ConditionExpression': 'attribute_not_exists(pk)'}},
        {'Put': {'Item': rev_item, 'ConditionExpression': 'attribute_not_exists(pk)'}},
    ]
    if workspace is not None:
        entries.append(_registry_entry(f'WORKFLOW#{workflow_id}', 'workflow_id', workflow_id, stamp, workspace))
    try:
        _transact(table, entries, workspace)
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('create the workflow', exc) from exc
    return current


def save_revision(table: Any, workflow_id: str, definition: Mapping[str, Any], *, expected_revision: int,
                  saved_by: str, username: str, now: datetime, workspace: WorkspaceScope | None = None) -> dict:
    """Append revision ``expected_revision + 1`` and move CURRENT to it; 409 when stale."""
    if workflow_id == workflow_schema.DEFAULT_WORKFLOW_ID:
        raise ConflictError('The built-in workflow is read-only; duplicate it to edit')
    new_revision = expected_revision + 1
    stamp = iso(now)
    revision = _revision_attrs(definition, new_revision, saved_by=saved_by, username=username, stamp=stamp)
    current_sets = {**revision, 'description': definition.get('description', ''), 'updated_at': stamp,
                    'updated_by_username': username, 'slug': workflow_schema.slugify(definition['name']),
                    'gsi1sk': f"{definition['name'].lower()}#{workflow_id}"}
    clause, names, values = set_clause(current_sets)
    names['#rev'] = 'revision'
    names['#status'] = 'status'
    values[':expected'] = expected_revision
    values[':archived'] = WORKFLOW_STATUS_ARCHIVED
    try:
        _transact(table, [
            {'Update': {
                'Key': workflow_current_key(workflow_id, workspace=workspace),
                'UpdateExpression': f'SET {clause}', 'ConditionExpression': ('attribute_exists(pk) AND #rev = :expected '
                                        'AND (attribute_not_exists(#status) OR #status <> :archived)'),
                'ExpressionAttributeNames': names, 'ExpressionAttributeValues': values,
            }},
            {'Put': {'Item': {**workflow_revision_key(workflow_id, new_revision, workspace=workspace),
                              'workflow_id': workflow_id, **revision},
                     'ConditionExpression': 'attribute_not_exists(pk)'}},
        ], workspace)
    except ClientError as exc:
        if not _is_cancelled_transaction(exc):
            raise _service_error('save the workflow', exc) from exc
        if get_workflow(table, workflow_id, workspace=workspace) is None:
            raise NotFoundError('Workflow not found') from exc
        raise ConflictError('The workflow was changed by someone else; reload and retry') from exc
    except BotoCoreError as exc:
        raise _service_error('save the workflow', exc) from exc
    current = get_workflow(table, workflow_id, workspace=workspace)
    if current is None:
        raise NotFoundError('Workflow not found')
    return current


def is_archived_workflow(item: Mapping[str, Any]) -> bool:
    return item.get('status') == WORKFLOW_STATUS_ARCHIVED


def archive_workflow(table: Any, workflow_id: str, *, archived_by: str, username: str, now: datetime,
                     workspace: WorkspaceScope | None = None) -> dict:
    """Mark a stored workflow archived (idempotent); 404 when it does not exist.

    ``archived_by`` (the archiver's sub) is an audit trail: stored, never served.
    """
    if workflow_id == workflow_schema.DEFAULT_WORKFLOW_ID:
        raise ConflictError('The built-in workflow cannot be archived')
    stamp = iso(now)
    try:
        response = _calls(table, workspace).update_item(
            Key=workflow_current_key(workflow_id, workspace=workspace),
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


def _monthly_budget(definition: Mapping[str, Any] | None) -> Any:
    """An engineering flow's ``budget.monthly_usd`` as stored, None for none (or a stored budget that is not one:
    a row from before its rule never fails the library's list)."""
    budget = (definition or {}).get('budget')
    return budget.get('monthly_usd') if isinstance(budget, Mapping) else None


def workflow_view(item: Mapping[str, Any], *, include_definition: bool = True) -> dict[str, Any]:
    data = plain(dict(item))
    definition = workflow_schema.decode_definition(data.get('definition'))
    view = {
        # An engineering flow (voc-workflow/2) is listed for the editor, never offered to an agent.
        'kind': 'engineering' if (definition or {}).get('schema') == workflow_schema.SCHEMA_V2 else 'agents',
        'workflow_id': data.get('workflow_id'), 'slug': data.get('slug'), 'name': data.get('name'),
        'description': data.get('description', ''), 'revision': data.get('revision'),
        'derived_from': data.get('derived_from'), 'builtin': bool(data.get('builtin')),
        'created_at': data.get('created_at'), 'updated_at': data.get('updated_at'),
        'updated_by_username': data.get('updated_by_username'),
        'status': WORKFLOW_STATUS_ARCHIVED if is_archived_workflow(data) else AGENT_STATUS_ACTIVE,
        # An engineering flow's monthly budget (its definition's budget.monthly_usd), None for none.
        'monthly_budget_usd': _monthly_budget(definition),
    }
    if include_definition:
        view['definition'] = definition
    return view


# --------------------------------------------------------------------------
# Runs: start (lock + caps), progress, finish, events.
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class RunStart:
    """What a starter asks for. ``extra_agent_sets`` lets the heartbeat record trigger state.

    An engineering agent's run (7.47.00) also gives ``run_fields`` (``kind: engineering``, its ``engineering_run_id``,
    the ``issue`` or ``prd`` it starts from, its ``feedback_count``: written on the run row) and, from a GitHub issue,
    ``issue_claim``: the issue's ``ISSUE_RUN#`` row (:func:`issue_claim_item`), put create-only in the same transaction,
    so one issue starts one run, ever, whichever agent or tick asks (:class:`IssueClaimed`).
    """

    trigger: str
    requested_by: str
    workflow_revision: int
    trigger_detail: Mapping[str, Any] | None = None
    counts_against_daily_cap: bool = False
    daily_cap: int = MAX_SCHEDULED_RUNS_PER_DAY
    extra_agent_sets: Mapping[str, Any] | None = None
    run_fields: Mapping[str, Any] | None = None
    issue_claim: Mapping[str, Any] | None = None
    #: The run's id when the starter minted it (the issue claim names it); else one is minted here.
    run_id: str | None = None


class IssueClaimed(Exception):
    """The issue a run would start from has started one already (its ``ISSUE_RUN#`` row): nothing was written."""


#: The run of a GitHub issue (7.47.00): one row per issue for every agent, ``ISSUE_RUN#<ws>`` / ``<owner/name>#<n>``,
#: the engineering agents' fixed scope (engineering/connectors/identity.py WORKSPACE: ``default`` until agents move per
#: workspace, docs/multi-workspace.md 3g3).
ISSUE_RUN_PK: Final = 'ISSUE_RUN#default'
RUN_KIND_ENGINEERING: Final = 'engineering'


def issue_claim_key(repository: str, number: int, stage: str = ISSUE_STAGE_ACT) -> dict[str, str]:
    """The issue's claim row of ``stage``: its repository lower-cased (GitHub's names are case-insensitive) and its
    number, ``<repo>#<n>`` for the act (7.47.00's key, unchanged), ``<repo>#<n>#triage`` for the triage (7.50.00)."""
    suffix = '#triage' if stage == ISSUE_STAGE_TRIAGE else ''
    return {'pk': ISSUE_RUN_PK, 'sk': f'{repository.lower()}#{number}{suffix}'}


def issue_claim_item(repository: str, number: int, *, agent_id: str, run_id: str, engineering_run_id: str,
                     feedback_id: str, now: datetime, stage: str = ISSUE_STAGE_ACT) -> dict[str, Any]:
    """The claim a run of issue ``number`` of ``repository`` writes with its run, for its ``stage``: which agent, run
    and engineering run took it, from which feedback item, when. Create-only, never updated or deleted."""
    return {**issue_claim_key(repository, number, stage), 'repository': repository, 'number': number,
            'agent_id': agent_id, 'agent_run_id': run_id, 'engineering_run_id': engineering_run_id,
            'feedback_id': feedback_id, 'claimed_at': iso(now), 'stage': stage}


def issue_claimed(table: Any, repository: str, number: int, stage: str = ISSUE_STAGE_ACT) -> bool:
    """Whether issue ``number`` of ``repository`` has started a run of ``stage`` already (a consistent read of its
    claim)."""
    try:
        return consistent_item(table, issue_claim_key(repository, number, stage)) is not None
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('read the issue claim', exc) from exc


#: An issue's trusted triage (7.50.00): one row per issue, ``ISSUE_TRIAGE#<ws>`` / ``<owner/name>#<n>`` (lower-cased),
#: written create-only by voc-engineering-runtime at a triage run's end from its understander's ``voc-triage/1`` record
#: (engineering/runtime/triage_end.py); what an act trigger's ``requires_triage`` reads. GitHub labels are informative
#: only: they never stand in for this row.
ISSUE_TRIAGE_PK: Final = 'ISSUE_TRIAGE#default'


def issue_triage_key(repository: str, number: int) -> dict[str, str]:
    return {'pk': ISSUE_TRIAGE_PK, 'sk': f'{repository.lower()}#{number}'}


def issue_triage(table: Any, repository: str, number: int) -> dict[str, Any] | None:
    """Issue ``number``'s trusted triage row (a consistent read), None when it has none yet."""
    try:
        return consistent_item(table, issue_triage_key(repository, number))
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('read the issue triage', exc) from exc


def claim_issue_if_free(table: Any, item: Mapping[str, Any]) -> bool:
    """An admin's Run now of an issue (it reruns one already claimed): its claim written when the issue has none yet,
    so a tick never starts it too; True when written, False when it had one (that one is kept)."""
    try:
        table.put_item(Item=dict(item), ConditionExpression='attribute_not_exists(pk)')
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            return False
        raise _service_error('claim the issue', exc) from exc
    except BotoCoreError as exc:
        raise _service_error('claim the issue', exc) from exc
    return True


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
    agent_id, run_id, stamp = agent['agent_id'], request.run_id or new_run_id(now), iso(now)
    sets = {'active_run_id': run_id, 'last_run_at': stamp, 'last_run_id': run_id,
            'last_run_status': RUN_QUEUED, 'last_run_cursor': stamp, **(request.extra_agent_sets or {})}
    clause, names, values = set_clause(sets)
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
        'model_calls': 0, 'event_seq': 0,
        # The starter's model profile (shared/model_profile.py; an e2e user's POST /agents/{id}/run), read
        # back by the conductor and the node steps. A scheduled run has no request, so none.
        **payload_fields(),
        **(request.run_fields or {}),
    }
    items: list[dict[str, Any]] = [
        {'Update': {'Key': agent_key(agent_id), 'UpdateExpression': update, 'ConditionExpression': condition,
                    'ExpressionAttributeNames': names, 'ExpressionAttributeValues': values}},
        {'Put': {'Item': run, 'ConditionExpression': 'attribute_not_exists(pk)'}},
    ]
    if request.issue_claim is not None:
        items.append({'Put': {'Item': dict(request.issue_claim), 'ConditionExpression': 'attribute_not_exists(pk)'}})
    try:
        _transact(table, items, None)   # (the deployment's runtime only: no run starts in a workspace yet)
    except ClientError as exc:
        if _is_cancelled_transaction(exc):
            codes = _cancellation_codes(exc)
            logger.info('Agent run not started', extra={'agent_id': agent_id, 'reasons': codes})
            if request.issue_claim is not None and codes[2:3] == ['ConditionalCheckFailed']:
                raise IssueClaimed('this issue has started a run already') from exc
            return None
        raise _service_error('start the agent run', exc) from exc
    except BotoCoreError as exc:
        raise _service_error('start the agent run', exc) from exc
    return run


def get_run(table: Any, agent_id: str, run_id: str, *, workspace: WorkspaceScope | None = None) -> dict | None:
    try:
        return consistent_item(_calls(table, workspace), run_key(agent_id, run_id, workspace=workspace))
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('read the run', exc) from exc


def list_runs(table: Any, agent_id: str, *, limit: int, cursor: object = None,
              workspace: WorkspaceScope | None = None) -> tuple[list[dict], str | None]:
    """Newest-first runs of one agent, paginated (a cursor of another agent or scope is refused, 400)."""
    partition = _agent_partition(agent_id, workspace)
    kwargs: dict[str, Any] = {'ScanIndexForward': False, 'Limit': limit}
    start = decode_cursor(cursor, partition)
    if start:
        kwargs['ExclusiveStartKey'] = start
    try:
        page = query_partition(workspace, table, 'pk', partition, sort=SortRange('sk', 'begins_with', 'RUN#'), **kwargs)
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('list runs', exc) from exc
    return page.get('Items', []), encode_cursor(page.get('LastEvaluatedKey'))


def run_view(item: Mapping[str, Any]) -> dict[str, Any]:
    """The API shape of a run, with what a human may decide on a ``needs_human`` one.

    A completed run answers ``error: None``: runs closed after needs_human up to 5.35.02
    kept the pause reason stored ("Needs a human: the workflow asks for a human.").
    """
    data = plain(dict(item))
    keys = ('run_id', 'agent_id', 'status', 'trigger', 'trigger_detail', 'started_at', 'finished_at',
            'project_id', 'current_node_id', 'model_calls', 'error', 'workflow_id', 'workflow_revision',
            # An engineering agent's run (7.47.00): its engineering run (the run monitor's), what it started from.
            'kind', 'engineering_run_id', 'issue', 'prd', 'feedback_count',
            # The calls its flow expanded (7.52.00, shared/flow_expand.py): [{step, flow, revision, inputs?}].
            'expansion')
    view = {key: data.get(key) for key in keys}
    if view['status'] == RUN_COMPLETED:
        view['error'] = None
    return {**view,
            'needs_human': agent_run_decisions.needs_human_view(data),
            'decision': agent_run_decisions.decision_view(data),
            'actions': agent_run_decisions.allowed_actions(data)}


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


def mark_engineering_running(table: Any, agent_id: str, run_id: str) -> dict | None:
    """An engineering agent's queued run once its start wrote (or may have written) its engineering run: ``running``
    until the heartbeat reads that run ended (agents/heartbeat/engineering.py), and (7.71.03) the agent's own
    ``last_run_status`` with it (``record_last_run_running``). None when it is no longer queued."""
    run = _run_update(table, agent_id, run_id, 'SET #st = :running', {'#st': 'status'},
                      {':running': RUN_RUNNING, ':queued': RUN_QUEUED}, 'attribute_exists(pk) AND #st = :queued')
    if run is not None:
        record_last_run_running(table, agent_id, run_id)
    return run


def record_last_run_running(table: Any, agent_id: str, run_id: str) -> None:
    """The agent's ``last_run_status`` follows its run from queued to running: the agents list and the agent's stats
    read only the agent row, which said "Queued" for a run that had been working for an hour (a workflow agent's
    before, an engineering agent's until 7.71.03). Conditional on this run still being the agent's last one and still
    recorded as queued, so it never writes over a newer run or a finish that landed first. Best effort (Q5, 7.71.04):
    it follows the run's own move to running, which has landed, so a failure here is logged, never raised (the stats
    say "Queued" until the run's finish writes them)."""
    try:
        update_unless_condition_fails(
            table, Key=agent_key(agent_id), UpdateExpression='SET last_run_status = :running',
            ConditionExpression='last_run_id = :run AND last_run_status = :queued',
            ExpressionAttributeValues={':run': run_id, ':running': RUN_RUNNING, ':queued': RUN_QUEUED})
    except (ClientError, BotoCoreError):
        logger.exception('Agent last run status not recorded as running', extra={'agent_id': agent_id,
                                                                                  'run_id': run_id})


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
    clause, names, values = set_clause(sets)
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
        released = update_unless_condition_fails(
            table,
            Key=agent_key(agent_id),
            UpdateExpression='REMOVE active_run_id SET last_run_status = :s, #c = if_not_exists(#c, :zero) + :one',
            ConditionExpression='active_run_id = :run',
            ExpressionAttributeNames={'#c': f'runs_{status}'},
            ExpressionAttributeValues={':s': status, ':run': run_id, ':zero': 0, ':one': 1},
        )
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('release the agent run lock', exc) from exc
    if not released:
        logger.info('Agent lock already held by another run', extra={'agent_id': agent_id, 'run_id': run_id})


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


def list_events(table: Any, run_id: str, *, after: int, limit: int,
                workspace: WorkspaceScope | None = None) -> list[dict]:
    """Events with ``seq > after``, oldest first."""
    try:
        page = query_partition(workspace, table, 'pk', _events_partition(run_id, workspace),
                               sort=SortRange('sk', 'between', f'EVT#{after + 1:08d}', 'EVT#99999999'), Limit=limit)
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('list run events', exc) from exc
    # ``detail``: a failed step's technical reason (masked, bounded) beside its plain ``summary``.
    # ``methodology``: the block a methodology step's route or job answered (skipped steps, warnings).
    keys = ('seq', 'at', 'kind', 'node_id', 'role', 'summary', 'detail', 'ref', 'methodology')
    return [{k: v for k, v in plain(item).items() if k in keys} for item in page.get('Items', [])]


# --------------------------------------------------------------------------
# Step Functions.
# --------------------------------------------------------------------------

_sfn_client: Any = None


def stepfunctions_client() -> Any:
    """This Lambda's one Step Functions client, built on first use (plans_store starts plan runs through it)."""
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


def start_execution(run: Mapping[str, Any], name: str | None = None) -> str:
    """Start ``voc-agent-run`` for ``run``; its ARN.

    The execution is named after the run id; a resumed run's later executions are
    named ``{run_id}-r{n}`` (Step Functions refuses a reused name).
    """
    response = stepfunctions_client().start_execution(
        stateMachineArn=state_machine_arn(), name=name or run['run_id'],
        input=json.dumps({'run_id': run['run_id'], 'agent_id': run['agent_id']}),
    )
    return str(response['executionArn'])


def stop_execution(execution_arn: str) -> None:
    """Best effort: a run is already ``cancelled`` in the table, which the interpreter honours."""
    try:
        stepfunctions_client().stop_execution(executionArn=execution_arn, cause='Cancelled by an admin')
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

