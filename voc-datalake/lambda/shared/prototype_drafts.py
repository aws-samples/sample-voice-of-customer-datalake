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

A draft is of kind ``chat`` (an instruction) or ``feedback`` (selected tester pins, Part 3's
Incorporate: shared/prototype_incorporation.py selects the pins, parses the per-pin outcomes and
writes Apply's marks and replies).
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
from shared.prototype_incorporation import (
    INCORPORATE_INSTRUCTION,
    TAG_RE,
    incorporate,
    revision_feedback,
    selected_pins,
)
from shared.prototype_pins import batch_pin_ids
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
DRAFT_PROMPT_VERSION: Final = '1.1.0'
DRAFT_NOT_FOUND: Final = 'Draft not found'
#: A draft from an editor's instruction, or from selected tester pins (Part 3's Incorporate).
KIND_CHAT: Final = 'chat'
KIND_FEEDBACK: Final = 'feedback'
_SUMMARY_BLOCK_RE: Final = re.compile(r'<change_summary>(.*?)</change_summary>', re.IGNORECASE | re.DOTALL)


def validated_request(body: Mapping[str, Any]) -> tuple[str, str | list[str]]:
    """``(KIND_CHAT, the instruction)`` or ``(KIND_FEEDBACK, the pin ids)``: exactly one of the two; else a 400.

    ``pin_ids`` is 1 to 50 pin ids (duplicates folded, ``prototype_pins.batch_pin_ids``); never text.
    """
    has_instruction, has_pins = body.get('instruction') is not None, body.get('pin_ids') is not None
    if has_instruction and has_pins:
        raise ValidationError('Give an instruction or pin_ids, not both')
    if has_pins:
        return KIND_FEEDBACK, batch_pin_ids(dict(body))
    if not has_instruction:
        raise ValidationError('Give an instruction or pin_ids')
    return KIND_CHAT, validated_instruction(body)


def validated_instruction(body: Mapping[str, Any]) -> str:
    """The body's ``instruction``, stripped, 1 to 2,000 characters; else a 400."""
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


def draft_config(store: PrototypeStore, project_id: str, document: Mapping[str, Any], request: tuple[str, Any],
                 response_language: object) -> dict:
    """The draft job's config: drafted on the series head, refused now (400/404) when its HTML cannot be read.

    ``request`` is ``validated_request``'s answer. A feedback draft's pins are resolved here, before any job
    (``selected_pins``: ids of this series only, flagged ones withheld), and its instruction is the server's.
    """
    kind, value = request
    base = series_head(store.table, project_id, document)
    feedback: dict[str, Any] = {}
    if kind == KIND_FEEDBACK:
        accepted, withheld = selected_pins(store.table, store.pins_table, project_id, document, value)
        feedback = {'pins': accepted, 'withheld': withheld}
    # Read once and dropped: the job reads it again minutes later, and this one GET is what lets a
    # version that can never give HTML be refused before any job exists.
    version_html(store.s3, store.bucket, project_id, base)
    return {
        'doc_type': DRAFT_JOB_TYPE, 'kind': kind, 'base_document_id': str(base['document_id']),
        'base_version': int(base['version']),
        'instruction': INCORPORATE_INSTRUCTION if kind == KIND_FEEDBACK else value,
        'response_language': response_language, **feedback,
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
    text = TAG_RE.sub('', match.group(1)).replace('<', '').replace('>', '')
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


def draft_kind(draft: Mapping[str, Any]) -> str:
    """``KIND_FEEDBACK`` for a draft from pins, else ``KIND_CHAT`` (a 6.12.00 draft carries no kind)."""
    return KIND_FEEDBACK if draft.get('kind') == KIND_FEEDBACK else KIND_CHAT


def _ids(draft: Mapping[str, Any], key: str) -> list[str]:
    raw = draft.get(key)
    return [str(value) for value in raw if isinstance(value, str)] if isinstance(raw, list) else []


def _outcomes(draft: Mapping[str, Any]) -> list[dict[str, str]]:
    raw = draft.get('outcomes')
    rows = raw if isinstance(raw, list) else []
    return [{'pin_id': str(row.get('pin_id')), 'outcome': str(row.get('outcome')), 'note': str(row.get('note') or '')}
            for row in rows if isinstance(row, Mapping)]


def draft_view(job: Mapping[str, Any], draft: Mapping[str, Any], preview_url: str | None) -> dict:
    """The draft GET's answer. ``preview_url`` is the signed URL of the job's own draft key (None unsigned).

    ``kind`` is ``chat`` or ``feedback``; a feedback draft adds its per-pin ``outcomes`` (accepted pins only),
    the ``withheld`` ids (flagged, never sent) and the ``ignored`` ids (answered by the model, not selected).
    """
    view = {
        'draft_id': str(job['job_id']), 'kind': draft_kind(draft), 'base_document_id': draft['base_document_id'],
        'base_version': _epoch(draft.get('base_version')), 'instruction': str(draft.get('instruction') or ''),
        'summary': str(draft.get('summary') or ''), 'preview_url': preview_url,
        'completed_at': job.get('completed_at'),
    }
    if view['kind'] == KIND_FEEDBACK:
        view.update({'outcomes': _outcomes(draft), 'withheld': _ids(draft, 'withheld'),
                     'ignored': _ids(draft, 'ignored')})
    return view


def accepted_pins(doc_config: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """A feedback draft job config's accepted pins (``{pin_id, form_id, document_id, version}``): the only pins the
    generator sends and Apply touches."""
    raw = doc_config.get('pins')
    return [pin for pin in raw if isinstance(pin, Mapping)] if isinstance(raw, list) else []


def incorporation_of(store: PrototypeStore, job: Mapping[str, Any], draft: Mapping[str, Any],
                     document: Mapping[str, Any], *, actor: Mapping[str, str], now: str) -> dict[str, list] | None:
    """A feedback draft's marks and replies for the applied ``document`` (every Apply call); None for a chat draft.

    The pins it may touch are the job config's accepted set, never the request's.
    """
    if draft_kind(draft) != KIND_FEEDBACK:
        return None
    config = job.get('doc_config')
    accepted = accepted_pins(config if isinstance(config, Mapping) else {})
    return incorporate(store.pins_table, draft_id=str(job['job_id']), accepted=accepted, outcomes=_outcomes(draft),
                       new_document_id=str(document['document_id']), actor=actor, llm_metadata=_llm_metadata(draft),
                       now=now)


def _llm_metadata(draft: Mapping[str, Any]) -> dict[str, Any] | None:
    """The draft's ``{model, prompt_version}`` as the generator stored it, when it names a model."""
    stored = draft.get('llm_metadata')
    return dict(stored) if isinstance(stored, Mapping) and isinstance(stored.get('model'), str) else None


def apply_draft(store: PrototypeStore, project_id: str, job: Mapping[str, Any], draft: Mapping[str, Any],
                base: Mapping[str, Any], *, now: str, actor: Mapping[str, str]) -> tuple[dict, bool]:
    """``(the version, whether THIS call created it)``: the draft's HTML as the next version of its base's series.

    A replay (the allocation already landed before the call) answers that version, False, and
    reads nothing else. The version records ``edit_kind`` ``revise``, ``revised_from_id`` the
    base, ``revision_feedback`` the instruction (a feedback draft: "Incorporated N pins (k done)"),
    ``edited_by`` the applier and ``llm_metadata``
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
    # A feedback draft's version says only how many pins and how many done: no pin text, no model note.
    feedback = (revision_feedback(_outcomes(draft)) if draft_kind(draft) == KIND_FEEDBACK
                else str(draft.get('instruction') or '')[:MAX_INSTRUCTION_CHARS])
    provenance: dict[str, Any] = {
        'edit_kind': EDIT_KIND_REVISE, 'revised_from_id': draft['base_document_id'],
        # The draft it was applied from: how a client tells an applied draft from the others (two feedback
        # drafts can share their "Incorporated N pins (k done)" line).
        'revised_from_draft_id': draft_id,
        'revision_feedback': feedback, 'edited_by': dict(actor),
    }
    llm_metadata = _llm_metadata(draft)
    if llm_metadata is not None:
        provenance['llm_metadata'] = llm_metadata
    return version_from_html(store, project_id, base, html, allocation_id=allocation_id, now=now,
                             provenance=provenance, expected_last_version=_epoch(draft.get('base_version')))
