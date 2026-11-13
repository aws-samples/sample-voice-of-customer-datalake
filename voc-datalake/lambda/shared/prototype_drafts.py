"""Prototype drafts: an editor's instruction, drafted, read, applied or discarded (docs/prototype-builder.md, part 2).

A draft is a finished ``draft_prototype`` job plus ONE write-once object,
``prototypes/{project_id}/drafts/{job_id}.html`` (``prototype_draft_s3_key``), with no
pin-submit metadata. There is no document row until Apply, so a draft is in no list,
no project read and no Prioritization row. Its detail (the model's summary, the base,
the instruction, the model that wrote it) is the job row's ``draft`` attribute, which
no job route answers (as the job's config is not): only the draft GET, at EDIT,
reads it, and the job's result is exactly ``{draft_id}``, which a viewer polling the
job may see.

A draft lives as long as its job row: it expires with the job (7 days after it ends,
``shared/jobs.py``) or goes at once when an editor deletes the job (Discard). The
draft GET and Apply accept a job row only when it is a COMPLETED draft job whose
``ttl`` has not passed (DynamoDB removes expired rows late) and whose base is a
version of the series asked about, and they read the object from the row's own job
id, never from a key the request names.

Apply is the next version of the series through ``version_from_html`` (its own pin
form and widget), idempotent on ``apply:{draft_id}`` and conditioned on the base's
version (409 once the series moved past it).
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.aws import S3_CONDITIONAL_WRITE_CONFLICTS, is_missing_s3_object
from shared.document_history import EDIT_KIND_REVISE, series_versions
from shared.document_versions import get_versioned_document_by_allocation
from shared.engagement_common import update_existing
from shared.exceptions import ConflictError, NotFoundError, ValidationError
from shared.prototype_versions import PROTOTYPE_TYPE, PrototypeStore, version_from_html, version_html
from shared.prototypes import prototype_draft_s3_key

DRAFT_JOB_TYPE: Final = 'draft_prototype'
#: The job row attribute holding a draft's detail (never answered by a job route).
DRAFT_FIELD: Final = 'draft'
MAX_INSTRUCTION_CHARS: Final = 2000
MAX_SUMMARY_LINES: Final = 12
MAX_SUMMARY_LINE_CHARS: Final = 240
MAX_SUMMARY_CHARS: Final = 2000
#: The version of what a draft job sends the model (the draft prompt in
#: jobs/document_generator/handler.py), recorded as ``llm_metadata.prompt_version`` on
#: the draft and on the version Apply writes. Bump it with ANY change to that prompt:
#: its test pins each version to a digest of the prompt (append only).
DRAFT_PROMPT_VERSION: Final = '1.0.0'
PINS_NOT_YET: Final = 'Incorporating feedback into a draft is not available yet'
DRAFT_NOT_FOUND: Final = 'Draft not found'
_SUMMARY_BLOCK_RE: Final = re.compile(r'<change_summary>(.*?)</change_summary>', re.IGNORECASE | re.DOTALL)
_TAG_RE: Final = re.compile(r'<[^>]*>')


def validated_instruction(body: Mapping[str, Any]) -> str:
    """The body's ``instruction``, stripped, 1 to 2,000 characters; else a 400.

    ``pin_ids`` (a feedback draft, part 3) is refused by name until it is built, so a
    client that sends it learns why rather than getting a draft that ignored them.
    """
    if 'pin_ids' in body:
        raise ValidationError(PINS_NOT_YET)
    instruction = body.get('instruction')
    if not isinstance(instruction, str) or not instruction.strip():
        raise ValidationError('instruction is required')
    text = instruction.strip()
    if len(text) > MAX_INSTRUCTION_CHARS:
        raise ValidationError(f'instruction must be at most {MAX_INSTRUCTION_CHARS} characters')
    return text


def series_head(table: Any, project_id: str, document: Mapping[str, Any]) -> dict:
    """The newest stored version of ``document``'s series: a draft's base, whatever version was asked about."""
    versions = series_versions(table, project_id, dict(document))
    if not versions:
        raise NotFoundError('Prototype not found')
    return versions[0]


def draft_config(store: PrototypeStore, project_id: str, document: Mapping[str, Any], instruction: str,
                 response_language: object) -> dict:
    """The draft job's config: drafted on the series head, refused now (400/404) when its HTML cannot be read."""
    base = series_head(store.table, project_id, document)
    # Read once and dropped: the job reads it again minutes later, and this one GET is what lets a
    # version that can never give HTML be refused before any job exists.
    version_html(store.s3, store.bucket, project_id, base)
    return {
        'doc_type': DRAFT_JOB_TYPE, 'base_document_id': str(base['document_id']),
        'base_version': int(base['version']), 'instruction': instruction,
        'response_language': response_language,
    }


def parse_change_summary(raw: str) -> tuple[str, str]:
    """``(summary, the rest of the answer)``: the first ``<change_summary>`` block as plain text, and the
    answer without it (the HTML is extracted from that).

    The summary is model text read by editors: tags and every remaining angle bracket are
    dropped, so it holds no markup; blank lines go; at most ``MAX_SUMMARY_LINES`` lines of
    ``MAX_SUMMARY_LINE_CHARS`` and ``MAX_SUMMARY_CHARS`` in all. No block is an empty summary.
    """
    match = _SUMMARY_BLOCK_RE.search(raw or '')
    if match is None:
        return '', raw or ''
    text = _TAG_RE.sub('', match.group(1)).replace('<', '').replace('>', '')
    lines = [line.strip()[:MAX_SUMMARY_LINE_CHARS].rstrip() for line in text.splitlines()]
    summary = '\n'.join([line for line in lines if line][:MAX_SUMMARY_LINES])
    return summary[:MAX_SUMMARY_CHARS].rstrip(), raw[:match.start()] + raw[match.end():]


def put_draft_html(s3: Any, bucket: str, project_id: str, draft_id: str, html: str) -> None:
    """The draft's write-once object, with NO metadata: the prototype CSP function never widens a draft.

    A conditional conflict is an earlier attempt of the same job (the key is the job's), kept as it is.
    """
    try:
        s3.put_object(Bucket=bucket, Key=prototype_draft_s3_key(project_id, draft_id), Body=html.encode('utf-8'),
                      ContentType='text/html; charset=utf-8', IfNoneMatch='*')
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') not in S3_CONDITIONAL_WRITE_CONFLICTS:
            raise


def record_draft(jobs_table: Any, project_id: str, job_id: str, detail: Mapping[str, Any]) -> None:
    """Store ``detail`` as the job row's ``draft`` (no job route answers it, and the row's ``updated_at``
    moves); a 404 once the row is gone (``update_existing``, conditioned on the row).

    The row goes when an editor discards the draft while it is being made: the job then
    ends there, before its object is written.
    """
    update_existing(jobs_table, {'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'},
                    {DRAFT_FIELD: dict(detail)}, 'The draft was discarded before it was ready')


def draft_object_exists(s3: Any, bucket: str, project_id: str, draft_id: str) -> bool:
    try:
        s3.head_object(Bucket=bucket, Key=prototype_draft_s3_key(project_id, draft_id))
    except ClientError as error:
        if is_missing_s3_object(error):
            return False
        raise
    return True


def _read_draft_html(s3: Any, bucket: str, project_id: str, draft_id: str) -> str:
    try:
        obj = s3.get_object(Bucket=bucket, Key=prototype_draft_s3_key(project_id, draft_id))
    except ClientError as error:
        if is_missing_s3_object(error):
            raise NotFoundError("This draft's HTML is no longer stored: ask for the change again") from error
        raise
    return obj['Body'].read().decode('utf-8')


def _epoch(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        return None
    return int(value)


def usable_draft(job: Mapping[str, Any] | None, *, now_epoch: int) -> Mapping[str, Any] | None:
    """The job row's draft detail when the row is a completed, unexpired draft job; else None (a 404).

    A row whose ``ttl`` has passed is gone, though DynamoDB may not have removed it yet.
    """
    if not isinstance(job, Mapping) or job.get('job_type') != DRAFT_JOB_TYPE or job.get('status') != 'completed':
        return None
    ttl = _epoch(job.get('ttl'))
    if ttl is None or ttl <= now_epoch:
        return None
    draft = job.get(DRAFT_FIELD)
    if not isinstance(draft, Mapping) or not isinstance(draft.get('base_document_id'), str) \
            or _epoch(draft.get('base_version')) is None:
        return None
    return draft


def drafted_base_id(job: Mapping[str, Any] | None) -> str | None:
    """The base a draft job was started on, whatever its status (its config's, which the start wrote);
    None for anything that is not a draft job."""
    if not isinstance(job, Mapping) or job.get('job_type') != DRAFT_JOB_TYPE:
        return None
    config = job.get('doc_config')
    base_id = config.get('base_document_id') if isinstance(config, Mapping) else None
    return base_id if isinstance(base_id, str) and base_id else None


def drafted_base(table: Any, project_id: str, document: Mapping[str, Any], draft: Mapping[str, Any]) -> dict:
    """The stored version the draft was made on, when it is a version of ``document``'s series; else a 404."""
    base = next((row for row in series_versions(table, project_id, dict(document))
                 if row.get('document_id') == draft['base_document_id']), None)
    if base is None:
        raise NotFoundError(DRAFT_NOT_FOUND)
    return base


def draft_view(job: Mapping[str, Any], draft: Mapping[str, Any], preview_url: str | None) -> dict:
    """The draft GET's answer. ``preview_url`` is the signed URL of the job's own draft key (None unsigned)."""
    return {
        'draft_id': str(job['job_id']), 'base_document_id': draft['base_document_id'],
        'base_version': _epoch(draft.get('base_version')), 'instruction': str(draft.get('instruction') or ''),
        'summary': str(draft.get('summary') or ''), 'preview_url': preview_url,
        'completed_at': job.get('completed_at'),
    }


def _llm_metadata(draft: Mapping[str, Any]) -> dict[str, Any] | None:
    """The draft's ``{model, prompt_version}`` as the generator stored it, when it names a model."""
    stored = draft.get('llm_metadata')
    return dict(stored) if isinstance(stored, Mapping) and isinstance(stored.get('model'), str) else None


def apply_draft(store: PrototypeStore, project_id: str, job: Mapping[str, Any], draft: Mapping[str, Any],
                base: Mapping[str, Any], *, now: str, actor: Mapping[str, str]) -> tuple[dict, bool]:
    """``(the version, whether THIS call created it)``: the draft's HTML as the next version of its base's series.

    A replay (the allocation already landed before the call) answers that version, False, and
    reads nothing else. The version records ``edit_kind`` ``revise``, ``revised_from_id`` the
    base, ``revision_feedback`` the instruction, ``edited_by`` the applier and ``llm_metadata``
    the draft's model and prompt; no ``edited_from_id`` (``revised_from_id`` names the base).
    A series moved past the base is the stale-series 409 (``expected_last_version``), unless
    what moved it is this draft's own version: a concurrent Apply that landed after this call
    looked. That one is answered as the replay it is. Two Applies at the same moment therefore
    give one version, and both may answer True (each looked before the other landed).
    """
    draft_id = str(job['job_id'])
    allocation_id = f'apply:{draft_id}'
    existing = get_versioned_document_by_allocation(store.table, project_id, PROTOTYPE_TYPE, allocation_id)
    if existing is not None:
        return existing, False
    try:
        return _write_applied_version(store, project_id, draft, base, allocation_id=allocation_id,
                                      draft_id=draft_id, now=now, actor=actor), True
    except ConflictError:
        landed = get_versioned_document_by_allocation(store.table, project_id, PROTOTYPE_TYPE, allocation_id)
        if landed is None:
            raise
        return landed, False


def _write_applied_version(store: PrototypeStore, project_id: str, draft: Mapping[str, Any], base: Mapping[str, Any],
                           *, allocation_id: str, draft_id: str, now: str, actor: Mapping[str, str]) -> dict:
    html = _read_draft_html(store.s3, store.bucket, project_id, draft_id)
    provenance: dict[str, Any] = {
        'edit_kind': EDIT_KIND_REVISE, 'revised_from_id': draft['base_document_id'],
        'revision_feedback': str(draft.get('instruction') or '')[:MAX_INSTRUCTION_CHARS], 'edited_by': dict(actor),
    }
    llm_metadata = _llm_metadata(draft)
    if llm_metadata is not None:
        provenance['llm_metadata'] = llm_metadata
    return version_from_html(store, project_id, base, html, allocation_id=allocation_id, now=now,
                             provenance=provenance, expected_last_version=_epoch(draft.get('base_version')))
