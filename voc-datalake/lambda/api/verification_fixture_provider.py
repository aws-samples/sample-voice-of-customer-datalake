"""Private target-owned provider for the ABCA prioritization baseline fixture.

Direct Lambda invocation only: no API Gateway route, Cognito authorizer, browser
session, or target-controlled recipe. ABCA supplies one closed durable subject;
this provider owns every VoC key, item shape, relationship and cleanup rule.

No Metrics decorator, deliberately. Powertools Metrics publishes into the shared
"VoC" CloudWatch namespace that carries production KPIs, and this handler runs
only during verification -- emitting there would contaminate the dashboards a
verification run is supposed to leave untouched. Logs and traces are enough to
debug it, and 16 of the 19 handlers in lambda/api/ also opt out.
"""

from __future__ import annotations

import hashlib
import re
import time
from datetime import datetime, timedelta, timezone
from numbers import Number
from typing import Any

from botocore.exceptions import ClientError
from shared.exceptions import (
    ApiError,
    ConfigurationError,
    ConflictError,
    ServiceError,
    ValidationError,
)
from shared.logging import logger, tracer
from shared.tables import get_aggregates_table, get_projects_table

REQUEST_SCHEMA = 'verification.fixture.provider.request.v1'
RESULT_SCHEMA = 'verification.fixture.provider.result.v1'
CAPABILITY = 'seed.prioritization-baseline'
FIXTURE_TTL_SECONDS = 6 * 60 * 60
# Reusing a fixture whose TTL is nearly up would hand the caller records that can
# be deleted mid-run, so anything inside this margin is renewed rather than reused.
# Must exceed the longest single verification run; one hour of a six-hour lifetime.
RENEWAL_MARGIN_SECONDS = 60 * 60
TRANSACTION_ATTEMPTS = 3
PRIORITIZATION_PK = 'PRIORITIZATION'

_JOB_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
_SLOT_RE = re.compile(r'^[a-z]$')
_SHA_RE = re.compile(r'^(?:[0-9a-f]{40}|[0-9a-f]{64})$')
_REQUEST_KEYS = {
    'schema', 'operation', 'capability', 'verification_job_id', 'slot', 'tested_sha',
}
_OPERATIONS = frozenset({'setup', 'probe', 'teardown'})
_OWNER_FIELDS = (
    'verification_fixture_id',
    'verification_job_id',
    'verification_slot',
    'verification_tested_sha',
)
_RETRYABLE_TRANSACTION_CODES = frozenset({
    'TransactionConflict',
    'TransactionInProgressException',
    'ProvisionedThroughputExceeded',
    'ProvisionedThroughputExceededException',
    'RequestLimitExceeded',
    'ThrottlingError',
    'ThrottlingException',
})
_OBSERVATIONS = (
    'project_meta', 'scorable_prd', 'baseline_row', 'row_document_link',
)
_FIXED_CREATED_AT = '2026-01-01T00:00:00+00:00'


def _required_string(body: dict[str, Any], field: str, pattern: re.Pattern[str]) -> str:
    value = body.get(field)
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValidationError(f'{field} has an invalid format')
    return value


def parse_provider_request(raw: Any) -> dict[str, str]:
    """Validate the complete invoke request before table discovery or I/O."""
    if not isinstance(raw, dict):
        raise ValidationError('request must be an object')
    unknown = sorted(set(raw) - _REQUEST_KEYS)
    missing = sorted(_REQUEST_KEYS - set(raw))
    if unknown:
        raise ValidationError(f'field is not allowed: {unknown[0]}')
    if missing:
        raise ValidationError(f'field is required: {missing[0]}')
    if raw.get('schema') != REQUEST_SCHEMA:
        raise ValidationError(f'schema must equal {REQUEST_SCHEMA}')
    if raw.get('operation') not in _OPERATIONS:
        raise ValidationError('operation must be setup, probe, or teardown')
    if raw.get('capability') != CAPABILITY:
        raise ValidationError(f'capability must equal {CAPABILITY}')
    return {
        'schema': REQUEST_SCHEMA,
        'operation': raw['operation'],
        'capability': CAPABILITY,
        'verification_job_id': _required_string(raw, 'verification_job_id', _JOB_ID_RE),
        'slot': _required_string(raw, 'slot', _SLOT_RE),
        'tested_sha': _required_string(raw, 'tested_sha', _SHA_RE),
    }


def _ids(request: dict[str, str]) -> dict[str, Any]:
    subject = '\0'.join((
        CAPABILITY,
        request['verification_job_id'],
        request['slot'],
        request['tested_sha'],
    ))
    digest = hashlib.sha256(subject.encode('utf-8')).hexdigest()[:24]
    fixture_id = f'vfb_{digest}'
    project_id = f'proj_vf_{digest}'
    return {
        'fixture_id': fixture_id,
        'project_id': project_id,
        'document_ids': {'scorable_prd': f'prd_{fixture_id}'},
        'row_ids': {'baseline_row': f'row_{fixture_id}'},
    }


def _ownership(request: dict[str, str], fixture_id: str) -> dict[str, str]:
    return {
        'verification_fixture_id': fixture_id,
        'verification_job_id': request['verification_job_id'],
        'verification_slot': request['slot'],
        'verification_tested_sha': request['tested_sha'],
    }


def _table_name(table: Any, label: str) -> str:
    name = getattr(table, 'name', None)
    if not isinstance(name, str) or not name:
        raise ConfigurationError(f'{label} table not configured')
    return name


def _owner_expression(ownership: dict[str, str]) -> tuple[dict[str, str], dict[str, str]]:
    return ({
        '#fixture': 'verification_fixture_id',
        '#job': 'verification_job_id',
        '#slot': 'verification_slot',
        '#sha': 'verification_tested_sha',
    }, {
        ':fixture': ownership['verification_fixture_id'],
        ':job': ownership['verification_job_id'],
        ':slot': ownership['verification_slot'],
        ':sha': ownership['verification_tested_sha'],
    })


def _owned_put(table_name: str, item: dict[str, Any]) -> dict[str, Any]:
    names, values = _owner_expression(item)
    return {'Put': {
        'TableName': table_name,
        'Item': item,
        'ConditionExpression': (
            'attribute_not_exists(pk) OR '
            '(#fixture = :fixture AND #job = :job AND #slot = :slot AND #sha = :sha)'
        ),
        'ExpressionAttributeNames': names,
        'ExpressionAttributeValues': values,
    }}


def _owned_delete(
    table_name: str,
    key: dict[str, str],
    ownership: dict[str, str],
) -> dict[str, Any]:
    names, values = _owner_expression(ownership)
    return {'Delete': {
        'TableName': table_name,
        'Key': key,
        'ConditionExpression': (
            'attribute_not_exists(pk) OR '
            '(#fixture = :fixture AND #job = :job AND #slot = :slot AND #sha = :sha)'
        ),
        'ExpressionAttributeNames': names,
        'ExpressionAttributeValues': values,
    }}


def _transact(
    client: Any,
    items: list[dict[str, Any]],
    *,
    collision_message: str,
    failure_message: str,
) -> None:
    for attempt in range(TRANSACTION_ATTEMPTS):
        try:
            client.transact_write_items(TransactItems=items)
            return
        except ClientError as error:
            code = error.response.get('Error', {}).get('Code')
            reasons = error.response.get('CancellationReasons')
            reason_codes = {
                reason.get('Code')
                for reason in reasons
                if isinstance(reason, dict)
            } if isinstance(reasons, list) else set()
            if 'ConditionalCheckFailed' in reason_codes:
                raise ConflictError(collision_message) from error
            retryable = code in _RETRYABLE_TRANSACTION_CODES or bool(
                reason_codes & _RETRYABLE_TRANSACTION_CODES
            )
            if retryable and attempt + 1 < TRANSACTION_ATTEMPTS:
                time.sleep(0.05 * (2 ** attempt))
                continue
            raise ServiceError(failure_message) from error
    raise ServiceError(failure_message)


def _records(
    request: dict[str, str],
    ids: dict[str, Any],
    *,
    expires_at: str,
    ttl: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    fixture_id = ids['fixture_id']
    project_id = ids['project_id']
    document_id = ids['document_ids']['scorable_prd']
    row_id = ids['row_ids']['baseline_row']
    ownership = _ownership(request, fixture_id)
    project_items = [
        {
            'pk': f'PROJECT#{project_id}',
            'sk': 'META',
            'gsi1pk': 'TYPE#PROJECT',
            'gsi1sk': _FIXED_CREATED_AT,
            'project_id': project_id,
            'name': f'ABCA baseline fixture {fixture_id}',
            'description': 'Target-owned ABCA baseline fixture; safe to remove.',
            'status': 'active',
            'created_at': _FIXED_CREATED_AT,
            'updated_at': _FIXED_CREATED_AT,
            'persona_count': 0,
            'document_count': 1,
            'filters': {},
            'kiro_export_prompt': '',
            'fixture_expires_at': expires_at,
            'ttl': ttl,
            **ownership,
        },
        {
            'pk': f'PROJECT#{project_id}',
            'sk': f'PRD#{document_id}',
            'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
            'gsi1sk': _FIXED_CREATED_AT,
            'document_id': document_id,
            'document_type': 'prd',
            'title': 'ABCA prioritization baseline',
            'feature_idea': 'Verify one scorable document in one prioritization row.',
            'content': 'Deterministic target-owned document used only for ABCA verification.',
            'created_at': _FIXED_CREATED_AT,
            'updated_at': _FIXED_CREATED_AT,
            'ttl': ttl,
            **ownership,
        },
    ]
    aggregate_items = [{
        'pk': PRIORITIZATION_PK,
        'sk': f'ROW#{row_id}',
        'row_id': row_id,
        'project_id': project_id,
        'document_ids': [document_id],
        'prototype_id': '',
        'is_default': False,
        'created_at': _FIXED_CREATED_AT,
        'updated_at': _FIXED_CREATED_AT,
        'ttl': ttl,
        **ownership,
    }]
    return project_items, aggregate_items


def _existing_expiry(
    projects_table: Any,
    request: dict[str, str],
    ids: dict[str, Any],
    now: datetime,
) -> tuple[bool, str | None, int | None]:
    item = projects_table.get_item(
        Key={'pk': f"PROJECT#{ids['project_id']}", 'sk': 'META'},
        ConsistentRead=True,
    ).get('Item')
    if item is None:
        return False, None, None
    ownership = _ownership(request, ids['fixture_id'])
    if any(item.get(field) != ownership[field] for field in _OWNER_FIELDS):
        raise ConflictError('Fixture project key is owned by another subject')
    expires_at, ttl = item.get('fixture_expires_at'), item.get('ttl')
    if not isinstance(expires_at, str) or not isinstance(ttl, Number):
        raise ConflictError('Owned fixture metadata is incomplete')
    if int(ttl) <= int(now.timestamp()) + RENEWAL_MARGIN_SECONDS:
        # Two cases, one repair. Either the TTL already passed — DynamoDB deletes
        # asynchronously, so an expired META item can still be visible after its
        # siblings vanish — or it is close enough that a caller reusing the
        # fixture now could have its records deleted part-way through the run.
        # Both are fixed by treating this as a new generation: return "not
        # reused" so the caller mints a fresh expiry and atomically rewrites all
        # three records. The owner condition still fences other subjects out, and
        # the identity (ids) is derived from the request, so a renewal keeps the
        # same project/document/row keys and only moves the expiry forward.
        return False, None, None
    return True, expires_at, int(ttl)


def _result(
    request: dict[str, str],
    ids: dict[str, Any],
    *,
    state: str,
    expires_at: str | None,
    observations: list[str],
    verified_zero_remain: bool,
) -> dict[str, Any]:
    return {
        'schema': RESULT_SCHEMA,
        'operation': request['operation'],
        'capability': CAPABILITY,
        'success': True,
        'state': state,
        'fixture_id': ids['fixture_id'],
        'project_id': ids['project_id'],
        'document_ids': ids['document_ids'],
        'row_ids': ids['row_ids'],
        'counts': {'projects': 1, 'documents': 1, 'rows': 1},
        'expires_at': expires_at,
        'observations': observations,
        'verified_zero_remain': verified_zero_remain,
    }


def _tables() -> tuple[Any, Any]:
    projects, aggregates = get_projects_table(), get_aggregates_table()
    if projects is None or aggregates is None:
        raise ConfigurationError('fixture provider tables are not configured')
    return projects, aggregates


@tracer.capture_method
def setup_fixture(request: dict[str, str], *, now: datetime | None = None) -> dict[str, Any]:
    projects, aggregates = _tables()
    ids = _ids(request)
    current = now or datetime.now(timezone.utc)
    reused, expires_at, ttl = _existing_expiry(projects, request, ids, current)
    if not reused:
        ttl = int((current + timedelta(seconds=FIXTURE_TTL_SECONDS)).timestamp())
        expires_at = datetime.fromtimestamp(ttl, timezone.utc).isoformat()
    if expires_at is None or ttl is None:
        # `assert` would vanish under `python -O`, leaving the records below to be
        # built from None and fail far from the cause.
        raise ServiceError('fixture expiry could not be resolved')
    project_items, aggregate_items = _records(request, ids, expires_at=expires_at, ttl=ttl)
    _transact(
        projects.meta.client,
        [
            *(_owned_put(_table_name(projects, 'Projects'), item) for item in project_items),
            *(_owned_put(_table_name(aggregates, 'Aggregates'), item) for item in aggregate_items),
        ],
        collision_message='Fixture keys collide with another owner',
        failure_message='Failed to set up fixture',
    )
    return _result(
        request, ids, state='reused' if reused else 'created', expires_at=expires_at,
        observations=[], verified_zero_remain=False,
    )


def _get_exact(table: Any, key: dict[str, str]) -> dict[str, Any] | None:
    item = table.get_item(Key=key, ConsistentRead=True).get('Item')
    return item if isinstance(item, dict) else None


def _require_owned(item: dict[str, Any] | None, ownership: dict[str, str], label: str) -> dict[str, Any]:
    if item is None:
        raise ConflictError(f'{label} is missing')
    if any(item.get(field) != ownership[field] for field in _OWNER_FIELDS):
        raise ConflictError(f'{label} ownership does not match')
    return item


@tracer.capture_method
def probe_fixture(request: dict[str, str]) -> dict[str, Any]:
    projects, aggregates = _tables()
    ids = _ids(request)
    ownership = _ownership(request, ids['fixture_id'])
    project = _require_owned(_get_exact(
        projects, {'pk': f"PROJECT#{ids['project_id']}", 'sk': 'META'},
    ), ownership, 'project')
    document_id = ids['document_ids']['scorable_prd']
    document = _require_owned(_get_exact(
        projects, {'pk': f"PROJECT#{ids['project_id']}", 'sk': f'PRD#{document_id}'},
    ), ownership, 'document')
    row_id = ids['row_ids']['baseline_row']
    row = _require_owned(_get_exact(
        aggregates, {'pk': PRIORITIZATION_PK, 'sk': f'ROW#{row_id}'},
    ), ownership, 'row')
    if project.get('project_id') != ids['project_id'] or project.get('document_count') != 1:
        raise ConflictError('project shape does not match baseline')
    if document.get('document_id') != document_id or document.get('document_type') != 'prd':
        raise ConflictError('document shape does not match baseline')
    if (row.get('row_id') != row_id or row.get('project_id') != ids['project_id']
            or row.get('document_ids') != [document_id] or row.get('is_default') is not False):
        raise ConflictError('row relationship does not match baseline')
    expires_at = project.get('fixture_expires_at')
    if not isinstance(expires_at, str):
        raise ConflictError('fixture expiry is missing')
    return _result(
        request, ids, state='active', expires_at=expires_at,
        observations=list(_OBSERVATIONS), verified_zero_remain=False,
    )


@tracer.capture_method
def teardown_fixture(request: dict[str, str]) -> dict[str, Any]:
    projects, aggregates = _tables()
    ids = _ids(request)
    ownership = _ownership(request, ids['fixture_id'])
    project_id = ids['project_id']
    document_id = ids['document_ids']['scorable_prd']
    row_id = ids['row_ids']['baseline_row']
    project_name, aggregate_name = _table_name(projects, 'Projects'), _table_name(aggregates, 'Aggregates')
    keys = [
        (projects, project_name, {'pk': f'PROJECT#{project_id}', 'sk': 'META'}),
        (projects, project_name, {'pk': f'PROJECT#{project_id}', 'sk': f'PRD#{document_id}'}),
        (aggregates, aggregate_name, {'pk': PRIORITIZATION_PK, 'sk': f'ROW#{row_id}'}),
    ]
    _transact(
        projects.meta.client,
        [_owned_delete(table_name, key, ownership) for _, table_name, key in keys],
        collision_message='Fixture cleanup encountered another owner',
        failure_message='Failed to tear down fixture',
    )
    if any(_get_exact(table, key) is not None for table, _, key in keys):
        raise ServiceError('Fixture cleanup could not prove zero remains')
    return _result(
        request, ids, state='removed', expires_at=None,
        observations=[], verified_zero_remain=True,
    )


_ERROR_CODES = {
    ValidationError: 'validation',
    ConfigurationError: 'configuration',
    ConflictError: 'conflict',
    ServiceError: 'service',
}


def _failure(operation: Any, error_code: str) -> dict[str, Any]:
    return {
        'schema': RESULT_SCHEMA,
        'operation': operation if operation in _OPERATIONS else 'unknown',
        'capability': CAPABILITY,
        'success': False,
        'error_code': error_code,
    }


@logger.inject_lambda_context(clear_state=True)
@tracer.capture_lambda_handler
def lambda_handler(event: Any, _context: Any) -> dict[str, Any]:
    operation = event.get('operation') if isinstance(event, dict) else None
    try:
        request = parse_provider_request(event)
        if request['operation'] == 'setup':
            return setup_fixture(request)
        if request['operation'] == 'probe':
            return probe_fixture(request)
        return teardown_fixture(request)
    except ApiError as error:
        logger.warning('Fixture provider rejected %s: %s', operation, type(error).__name__)
        return _failure(operation, _ERROR_CODES.get(type(error), 'service'))
    except Exception:  # noqa: BLE001 -- final Lambda boundary returns a closed error envelope
        logger.exception('Fixture provider failed internally for %s', operation)
        return _failure(operation, 'internal')
