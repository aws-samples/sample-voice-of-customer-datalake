"""Decision records: a project document of type ``decision`` (no table of its own).

A decision answers "what did we decide about this, and why": a **verdict**
(``pursue`` / ``park`` / ``reject``), the **rationale**, a **success metric**, a
**kill criterion**, the **evidence** it rests on (feedback ids and project
document ids — ids only, never copied text), an optional **review-by** date and,
once the thing shipped, a **launched-at** date that release watch compares
around (``shared/release_watch.py``).

Storage: a ``DOC#{id}`` row in ``voc-projects`` like a custom document, with
``document_type = 'decision'``, the fields under ``decision`` and a rendered
markdown ``content`` so every document surface (the Documents tab, export, the
assistant's project context, a PR/FAQ's reference documents) reads it unchanged.
``decided_by`` / ``decided_at`` are set by the server from the caller and reset
when the verdict changes; earlier verdicts are kept in ``decision.history``.

Edits go through ``PUT /projects/{id}/decisions/{document_id}`` only (the generic
document edit refuses a decision, so ``content`` can never drift from the fields)
and are conditioned on the stored ``revision`` — a stale ``expected_revision`` or a
concurrent save is a 409, never a silent overwrite.

"Pursue" seeds the existing PR/FAQ chain on request (``pursue_doc_config``): the
route starts the ordinary PR/FAQ generation with the decision as its first
reference document. Nothing is generated automatically.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared.derivation import ROLE_REFERENCE, build_derivation, derivation_source
from shared.dynamo_paging import iter_query
from shared.exceptions import ConflictError, NotFoundError, ValidationError
from shared.project_access import Caller
from shared.project_writes import create_counted_project_child, projects_table_name, transact_project_actions

DECISION_DOCUMENT_TYPE = 'decision'
VERDICTS = ('pursue', 'park', 'reject')
VERDICT_PURSUE = 'pursue'

MAX_TITLE = 200
MAX_RATIONALE = 4000
MAX_CRITERION = 1000
MAX_FEEDBACK_EVIDENCE = 50
MAX_DOCUMENT_EVIDENCE = 20
MAX_HISTORY = 20
EVIDENCE_ID_RE = re.compile(r'^[A-Za-z0-9_.:#-]{1,128}\Z')

TEXT_FIELDS = {'rationale': MAX_RATIONALE, 'success_metric': MAX_CRITERION, 'kill_criterion': MAX_CRITERION}
DATE_FIELDS = ('review_by', 'launched_at')
EDITABLE_FIELDS = ('title', 'verdict', *TEXT_FIELDS, 'evidence', *DATE_FIELDS)

STALE_DECISION_MESSAGE = 'This decision changed since you opened it. Reload it and try again.'
# How the PR/FAQ seeded by "Pursue" reads its inputs (the generator's own doc_config keys).
PURSUE_FEEDBACK_DAYS = 30
PURSUE_MAX_EVIDENCE_DOCUMENTS = 2


# ── Validation ───────────────────────────────────────────────────────────────

def _text(body: Mapping[str, Any], name: str, limit: int, *, required: bool) -> str:
    value = body.get(name)
    if value is None and not required:
        return ''
    if not isinstance(value, str) or (required and not value.strip()):
        raise ValidationError(f'{name} is required' if required else f'{name} must be a string')
    value = value.strip()
    if len(value) > limit:
        raise ValidationError(f'{name} must be at most {limit} characters')
    return value


def _verdict(value: object) -> str:
    if value not in VERDICTS:
        raise ValidationError(f'verdict must be one of: {", ".join(VERDICTS)}')
    return str(value)


def _day(name: str, value: object) -> str | None:
    if value is None or value == '':
        return None
    if isinstance(value, str) and len(value) == 10:
        try:
            return date.fromisoformat(value).isoformat()
        except ValueError:
            pass
    raise ValidationError(f'{name} must be a YYYY-MM-DD date')


def _ids(name: str, value: object, limit: int) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > limit:
        raise ValidationError(f'evidence.{name} must be a list of at most {limit} ids')
    if not all(isinstance(v, str) and EVIDENCE_ID_RE.match(v) for v in value):
        raise ValidationError(f'evidence.{name} must contain only ids')
    return list(dict.fromkeys(value))


def _evidence(value: object) -> dict[str, list[str]]:
    if value is None:
        return {'feedback_ids': [], 'document_ids': []}
    if not isinstance(value, dict):
        raise ValidationError('evidence must be an object')
    return {
        'feedback_ids': _ids('feedback_ids', value.get('feedback_ids'), MAX_FEEDBACK_EVIDENCE),
        'document_ids': _ids('document_ids', value.get('document_ids'), MAX_DOCUMENT_EVIDENCE),
    }


def validated_fields(body: Mapping[str, Any], *, partial: bool) -> dict[str, Any]:
    """The decision fields a create (every required field) or an edit (only those sent) carries."""
    names = [n for n in EDITABLE_FIELDS if n in body] if partial else list(EDITABLE_FIELDS)
    if partial and not names:
        raise ValidationError(f'Send at least one of: {", ".join(EDITABLE_FIELDS)}')
    fields: dict[str, Any] = {}
    for name in names:
        if name == 'title':
            fields[name] = _text(body, name, MAX_TITLE, required=True)
        elif name == 'verdict':
            fields[name] = _verdict(body.get(name))
        elif name in TEXT_FIELDS:
            fields[name] = _text(body, name, TEXT_FIELDS[name], required=name == 'rationale')
        elif name == 'evidence':
            fields[name] = _evidence(body.get(name))
        else:
            fields[name] = _day(name, body.get(name))
    return fields


def validated_expected_revision(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValidationError('expected_revision must be a positive integer')
    return value


# ── Rendering ────────────────────────────────────────────────────────────────

def render_content(title: str, decision: Mapping[str, Any]) -> str:
    """The markdown every document surface shows (English headings, the user's own words)."""
    evidence = decision.get('evidence') or {}
    lines = [f'# {title}', '', f"**Verdict:** {str(decision.get('verdict', '')).capitalize()}", '',
             '## Rationale', '', str(decision.get('rationale') or '')]
    for heading, field in (('Success metric', 'success_metric'), ('Kill criterion', 'kill_criterion')):
        if decision.get(field):
            lines += ['', f'## {heading}', '', str(decision[field])]
    dates = [f'- {label}: {decision[f]}' for label, f in (('Review by', 'review_by'), ('Launched', 'launched_at'))
             if decision.get(f)]
    if dates:
        lines += ['', '## Dates', '', *dates]
    refs = [f'- Feedback: {fid}' for fid in evidence.get('feedback_ids', [])]
    refs += [f'- Document: {did}' for did in evidence.get('document_ids', [])]
    if refs:
        lines += ['', '## Evidence', '', *refs]
    return '\n'.join(lines).strip() + '\n'


def decision_derivation(decision: Mapping[str, Any]) -> dict:
    """Ids and counts only: the documents and the feedback the decision cites."""
    evidence = decision.get('evidence') or {}
    document_ids = list(evidence.get('document_ids') or [])
    return build_derivation(
        sources=[derivation_source(d, ROLE_REFERENCE) for d in document_ids],
        selected_document_count=len(document_ids),
        feedback_count=len(evidence.get('feedback_ids') or []),
    )


# ── Storage ──────────────────────────────────────────────────────────────────

def _project_document_ids(table: Any, project_id: str) -> set[str]:
    query: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(f'PROJECT#{project_id}'),
        'ProjectionExpression': 'document_id',
        'ConsistentRead': True,
    }
    return {str(i['document_id']) for i in iter_query(table, query) if i.get('document_id')}


def _require_documents_exist(table: Any, project_id: str, document_ids: list[str], own_id: str = '') -> None:
    if not document_ids:
        return
    if own_id in document_ids:
        raise ValidationError('A decision cannot cite itself as evidence')
    missing = [d for d in document_ids if d not in _project_document_ids(table, project_id)]
    if missing:
        raise ValidationError(f'evidence.document_ids names {len(missing)} document(s) not in this project')


def _decided(caller: Caller, now: str) -> dict[str, str]:
    return {'decided_by': caller.subject, 'decided_by_name': caller.username, 'decided_at': now}


def create_decision(table: Any, project_id: str, body: Mapping[str, Any], caller: Caller) -> dict:
    """Create a decision document; answers ``{success, document}``."""
    fields = validated_fields(body, partial=False)
    title = fields.pop('title')
    _require_documents_exist(table, project_id, fields['evidence']['document_ids'])
    now_dt = datetime.now(UTC)
    now = now_dt.isoformat()
    decision = {**fields, **_decided(caller, now), 'history': []}

    def build(doc_id: str) -> dict:
        return {
            'pk': f'PROJECT#{project_id}', 'sk': f'DOC#{doc_id}',
            'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS', 'gsi1sk': now,
            'document_id': doc_id, 'document_type': DECISION_DOCUMENT_TYPE,
            'title': title, 'content': render_content(title, decision), 'decision': decision,
            'derivation': decision_derivation(decision), 'revision': 1,
            'created_at': now, 'updated_at': now,
        }

    item = create_counted_project_child(table, project_id, 'doc', build, 'document_count', now=now_dt)
    return {'success': True, 'document': item}


def stored_decision(table: Any, project_id: str, document_id: str) -> dict:
    """The decision document, or 404 (a missing id and a non-decision document alike)."""
    if not EVIDENCE_ID_RE.match(document_id):
        raise NotFoundError('Decision not found')
    item = table.get_item(Key={'pk': f'PROJECT#{project_id}', 'sk': f'DOC#{document_id}'},
                          ConsistentRead=True).get('Item')
    if not isinstance(item, dict) or item.get('document_type') != DECISION_DOCUMENT_TYPE:
        raise NotFoundError('Decision not found')
    return item


def _next_decision(stored: Mapping[str, Any], fields: Mapping[str, Any], caller: Caller, now: str) -> dict:
    """The stored decision with ``fields`` applied; a new verdict re-stamps who decided."""
    current = dict(stored.get('decision') or {})
    updated = {**current, **fields}
    if 'verdict' in fields and fields['verdict'] != current.get('verdict'):
        earlier = {k: current.get(k) for k in ('verdict', 'decided_by', 'decided_by_name', 'decided_at')}
        updated['history'] = [*list(current.get('history') or []), earlier][-MAX_HISTORY:]
        updated.update(_decided(caller, now))
    else:
        updated['updated_by'] = caller.subject
    return updated


def _revision(item: Mapping[str, Any]) -> int:
    """The stored edit counter (DynamoDB returns a Decimal); absent or unreadable = 1."""
    value = item.get('revision')
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        return 1
    return max(int(value), 1)


def update_decision(table: Any, project_id: str, document_id: str, body: Mapping[str, Any],
                    caller: Caller) -> dict:
    """Apply an edit in place (revision + 1); answers ``{success, document}``."""
    expected = validated_expected_revision(body.get('expected_revision'))
    fields = validated_fields(body, partial=True)
    stored = stored_decision(table, project_id, document_id)
    observed = _revision(stored)
    if expected is not None and expected != observed:
        raise ConflictError(STALE_DECISION_MESSAGE)
    title = fields.pop('title', None) or str(stored.get('title') or '')
    if 'evidence' in fields:
        _require_documents_exist(table, project_id, fields['evidence']['document_ids'], own_id=document_id)
    now = datetime.now(UTC).isoformat()
    decision = _next_decision(stored, fields, caller, now)
    changes = {'title': title, 'content': render_content(title, decision), 'decision': decision,
               'derivation': decision_derivation(decision), 'updated_at': now, 'revision': observed + 1}
    names = {f'#f{n}': name for n, name in enumerate(changes)}
    values = {f':v{n}': value for n, value in enumerate(changes.values())}
    try:
        transact_project_actions(table, project_id, [{'Update': {
            'TableName': projects_table_name(table), 'Key': {'pk': stored['pk'], 'sk': stored['sk']},
            'UpdateExpression': 'SET ' + ', '.join(f'{name} = :v{n}' for n, name in enumerate(names)),
            'ConditionExpression': '#type = :type AND #rev = :observed',
            'ExpressionAttributeNames': {**names, '#type': 'document_type', '#rev': 'revision'},
            'ExpressionAttributeValues': {**values, ':type': DECISION_DOCUMENT_TYPE, ':observed': observed},
        }}])
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
            raise ConflictError(STALE_DECISION_MESSAGE) from error
        raise
    return {'success': True, 'document': {**stored, **changes}}


# ── Pursue → PR/FAQ ──────────────────────────────────────────────────────────

def pursue_doc_config(decision_item: Mapping[str, Any], body: Mapping[str, Any]) -> dict:
    """The PR/FAQ generation request a "Pursue" decision seeds (the generator's own body shape)."""
    decision = decision_item.get('decision') or {}
    if decision.get('verdict') != VERDICT_PURSUE:
        raise ValidationError('Only a Pursue decision seeds a PR/FAQ')
    idea = [str(decision.get('rationale') or '')]
    idea += [f'{label}: {decision[f]}' for label, f in (('Success metric', 'success_metric'),
                                                        ('Kill criterion', 'kill_criterion')) if decision.get(f)]
    evidence_docs = list((decision.get('evidence') or {}).get('document_ids') or [])
    language = body.get('response_language')
    config = {
        'doc_type': 'prfaq',
        'title': str(decision_item.get('title') or 'Untitled'),
        'feature_idea': '\n\n'.join(idea),
        'data_sources': {'feedback': True, 'personas': True, 'documents': True, 'research': False},
        'selected_persona_ids': [],
        'selected_document_ids': [str(decision_item['document_id']), *evidence_docs[:PURSUE_MAX_EVIDENCE_DOCUMENTS]],
        'feedback_sources': [],
        'feedback_categories': [],
        'days': PURSUE_FEEDBACK_DAYS,
        'source_decision_id': str(decision_item['document_id']),
    }
    if isinstance(language, str) and 0 < len(language) <= 16:
        config['response_language'] = language
    return config


def record_seeded_prfaq(table: Any, item: Mapping[str, Any], job_id: str) -> None:
    """Note on the decision which PR/FAQ job it seeded (outside ``decision``, so edits keep it)."""
    table.update_item(
        Key={'pk': item['pk'], 'sk': item['sk']},
        UpdateExpression='SET seeded_prfaq_job_id = :job, seeded_prfaq_at = :at',
        ConditionExpression='attribute_exists(pk)',
        ExpressionAttributeValues={':job': job_id, ':at': datetime.now(UTC).isoformat()},
    )
