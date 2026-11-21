"""Every attribute of a project's own rows (its ``META``, product context, documents, product documents' records and
personas), classified for the workspace export (7.39.00, projects.py ``projects_documents`` and ``personas``): each
top-level attribute is ``EXPORTED`` or ``EXCLUDED``, and the export writes the ``EXPORTED`` ones only; nested maps
are exported after a secret-name check (``scrubbed``: any key at any depth whose name looks like a secret's, a token,
secret, hash, digest, signature, password, credential and the like, is left out and counted in the manifest's
``projects.secret_named_fields_refused``), and a ``META``'s ``members`` entries are narrowed to ``MEMBER_FIELDS``.
The same check runs over every project entity's rows (projects.py), the jobs' results, errors and configs among them.
It reads key names only, never values: a secret stored under an ordinary name (a token pasted into a document's text,
a credential in a persona's quote) is exported as it was stored; the manifest's ``project_fields`` note says so.

The lists hold every attribute the project-row writers store, as scripts/audit/py_stored_attrs.py reads them
(``test/test_project_fields.py`` fails on one in neither list, and on one in both; a dict key that audit's allowlist
says is not a DynamoDB attribute is not one), and every top-level field of
``schemas/persona.schema.json``. So a new attribute, a credential among them, is classified before it ships: never
exported by default, and never dropped without a decision. The static view sees dict literals and update
expressions, not an attribute set through a variable (``item['x'] = value``) or spread from a model's answer: such an
attribute is caught at run time instead, left out and named in the manifest (``projects.unclassified_fields``), never
exported.

``EXCLUDED``, each with its reason:

* ``token_hash``, ``secret_hash``: credential-shaped (the project bundle's rule, scripts/project_bundle/exporter.py);
* ``prototype_url``: a signed URL the projects API mints on every read and never trusts when stored (the prototypes
  are among the objects);
* ``kiro_export_prompt``: a stored prompt no release reads since 3.00.00 (the projects API drops it on read);
* ``gsi1pk``, ``gsi1sk``: index keys, derived from the row's own fields;
* ``migration_owner``, ``migration_expires_at``: a legacy series migration's lease, meaningless outside its run;
  ``last``, ``base``, ``owner``, ``expires``: the version counter's update-expression placeholders (``#last``,
  ``#base``, ``#owner``, ``#expires`` in shared/document_versions.py), which the static view reads as names; no row
  stores them (the counter's ``last_version`` and ``base_title`` are exported, its lease is not);
* ``deleting``, ``deletion_started_at``: a project delete's fence (a live project never holds it);
* the verification fixtures' plumbing (``verification_*``, ``fixture_id``, ``baseline_row``, ``capability``,
  ``operation``, ``row_ids``, ``schema``, ``scorable_prd``, ``slot``, ``tested_sha``: lambda/api/
  verification_fixture_provider.py, the deployment's own test fixtures, never in a workspace).
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from itertools import pairwise
from typing import Any, Final

__all__ = ['EXCLUDED', 'EXPORTED', 'REFUSED', 'classified', 'nested_scrubbed']

EXCLUDED: Final = frozenset({
    'token_hash', 'secret_hash', 'prototype_url', 'kiro_export_prompt', 'gsi1pk', 'gsi1sk', 'migration_owner',
    'migration_expires_at', 'deleting', 'deletion_started_at', 'verification_fixture_id', 'verification_job_id',
    'verification_slot', 'verification_tested_sha', 'fixture_id', 'baseline_row', 'capability', 'operation', 'row_ids',
    'schema', 'scorable_prd', 'slot', 'tested_sha', 'last', 'base', 'owner', 'expires',
})

EXPORTED: Final = frozenset({
    # The row's key, and what every row carries.
    'pk', 'sk', 'project_id', 'created_at', 'updated_at', 'status', 'kind', 'name', 'title', 'description',
    # A project's META: who owns it and who works on it (emails included: the workspace's own collaboration data).
    'owner_email', 'owner_sub', 'owner_username', 'members', 'role', 'user', 'username', 'email',
    'visibility', 'purpose', 'project', 'project_name', 'document_count', 'persona_count', 'personas', 'documents',
    'filters', 'categories', 'sentiments', 'sources', 'tags', 'days', 'date_basis', 'brand', 'methodology', 'code',
    'step', 'message', 'reason', 'prfaq', 'feedback', 'feedback_id', 'note_id', 'added_at', 'added_by', 'author',
    'deleted', 'deleted_at', 'count', 'deleted_sources', 'erased_evidence',
    # A document: its content, its version and series, and how it was made.
    'document_id', 'document_type', 'document_ids', 'document_pk', 'document_sk', 'doc_type', 'content', 'text',
    'summary', 'section', 'version', 'base_title', 'normalized_base_title', 'last_version',
    'allocation_id', 'version_allocation_id', 'revision', 'saved_at', 'replaced_at', 'source_document_sk',
    'edit_kind', 'edited_by', 'edited_from_id', 'restored_from_id', 'restored_from_version', 'revise_id',
    'revise_job_id', 'revised_from_draft_id', 'revised_from_id', 'revision_feedback', 'origin', 'created_by_sub',
    'derivation', 'decision', 'seeded_prfaq_at', 'seeded_prfaq_job_id', 'source_documents', 'source_prd_id',
    'source_prfaq_id', 'base_document_id', 'base_prototype_id', 'base_version', 'prototype_id', 'prototype_format',
    'format', 'llm_metadata', 'model', 'prompt_version', 'feedback_items_used', 'context_truncated',
    'merge_instructions', 'instruction', 'custom_instructions', 'response_language', 'mode', 'job_id', 'max_attempts',
    'max_tokens', 'thinking_budget', 'system_prompt', 'step_name', 'metadata', 'research_notes', 'outcome',
    'outcomes', 'question', 'is_default',
    'frozen_at', 'input_type', 'media_type', 'body_json', 'ack', 'actor', 'ballot_writes', 'row_id', 'thread_ids',
    'use_design_system', 'use_product_context', 'use_research', 'use_web_search', 'web_query_cap', 'generate_avatars',
    'keep_existing_personas', 'selected_document_ids', 'selected_persona_ids', 'selected_product_doc_ids',
    'selected_research_ids', 'persona_ids', 'included', 'ignored', 'withheld', 'image', 'bytes', 'source',
    # A product document's record and the product context.
    'doc_id', 'filename', 'content_type', 'size_bytes', 's3_raw_key', 's3_extracted_key', 'extracted_chars', 'error',
    'context',
    # A persona (schemas/persona.schema.json and its writers).
    'persona_id', 'tagline', 'avatar_url', 'avatar_prompt', 'confidence', 'feedback_count', 'identity',
    'goals_motivations', 'pain_points', 'behaviors', 'context_environment', 'quotes', 'scenario', 'source_breakdown',
    'source_feedback_ids', 'input_feedback_ids', 'imported_from', 'copied_from', 'protected',
    # A persona's evidence refreshes (7.64.00, shared/persona_grounding.py): who refreshed, when, why, the review ids.
    'evidence_updates', 'evidence_refreshed_at', 'feedback_ids', 'sub',
    # A saved focus group (7.64.00, shared/focus_group_documents.py): synthetic, never evidence.
    'synthetic',
    # The Validate step (7.68.00): the META's block (shared/project_validation.py: who last wrote it, when and why) and
    # its documents' plan, synthetic run and report (shared/validation_documents.py).
    'validation', 'updated_by', 'plan', 'run', 'report', 'criteria', 'tasks', 'guide', 'verdicts', 'ces', 'evidence',
    'responses', 'missing_count', 'prd_document_id', 'prototype_document_id', 'plan_document_id', 'run_document_id',
    'report_document_id', 'synthetic_run_id', 'form_id', 'form_language', 'form_open', 'form_revision',
    'card_in_prototype', 'results',
})

#: A project ``META``'s ``members`` entry (api/projects.py: who was added, with which role, by whom and when); an
#: entry's other keys are left out (a nested allowlist, the one map whose shape is fixed and cheap to name).
MEMBER_FIELDS: Final = ('role', 'username', 'name', 'email', 'added_by', 'added_at')
#: The words of a name that looks like a secret's (a name's words: split at ``_``, ``-``, ``.``, spaces and camelCase,
#: lower-cased). ``token`` alone: ``tokens`` (a model's usage counts, ``input_tokens``) is not a secret.
SECRET_WORDS: Final = frozenset({
    'token', 'secret', 'secrets', 'hash', 'hashes', 'digest', 'signature', 'sig', 'password', 'passwd', 'passphrase',
    'credential', 'credentials', 'apikey', 'privatekey', 'cookie', 'bearer', 'authorization', 'otp',
})
#: Two words that together name a secret (``api_key``, ``private_key``, ``access_key``, ``session_id``).
SECRET_PAIRS: Final = frozenset({('api', 'key'), ('private', 'key'), ('access', 'key'), ('secret', 'key'),
                                 ('session', 'id'), ('refresh', 'token'), ('client', 'secret')})
_WORDS: Final = re.compile(r'[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])')
#: What the nested check counts, for the manifest (``projects.secret_named_fields_refused``).
REFUSED: Final = 'secret_named_fields_refused'
#: The deepest map the nested check walks (a stored row's maps are a few levels deep at most); one deeper is left
#: out whole and counted.
MAX_DEPTH: Final = 32


def is_secret_name(name: object) -> bool:
    """Whether a key's name looks like a secret's (``SECRET_WORDS``, ``SECRET_PAIRS``)."""
    words = [word.lower() for word in _WORDS.findall(str(name))]
    return bool(SECRET_WORDS.intersection(words)) or any(pair in SECRET_PAIRS for pair in pairwise(words))


def scrubbed(value: Any, depth: int = 0) -> tuple[Any, int]:
    """``value`` with every nested key whose name looks like a secret's left out, at any depth (maps in maps and in
    lists), and how many were. A map nested deeper than ``MAX_DEPTH`` is left out whole and counted once."""
    if depth > MAX_DEPTH:
        return None, 1
    if isinstance(value, Mapping):
        kept: dict[str, Any] = {}
        refused = 0
        for name, inner in value.items():
            if is_secret_name(name):
                refused += 1
                continue
            kept[name], below = scrubbed(inner, depth + 1)
            refused += below
        return kept, refused
    if isinstance(value, list | tuple):
        shown = [scrubbed(inner, depth + 1) for inner in value]
        return [inner for inner, _ in shown], sum(count for _, count in shown)
    return value, 0


def classified(item: Mapping[str, Any]) -> tuple[dict[str, Any], int]:
    """A project row or persona through its classification: its ``EXPORTED`` top-level attributes; ``members``
    entries narrowed to ``MEMBER_FIELDS``; then every nested map after the secret-name check (``scrubbed``). Returns
    the row and how many nested keys the check refused."""
    row = {name: item[name] for name in sorted(EXPORTED.intersection(item))}
    if isinstance(row.get('members'), Mapping):
        row['members'] = {sub: _member(entry) for sub, entry in row['members'].items()}
    elif isinstance(row.get('members'), list):
        row['members'] = [_member(entry) for entry in row['members']]
    return nested_scrubbed(row)


def _member(entry: object) -> object:
    return {name: entry[name] for name in MEMBER_FIELDS if name in entry} if isinstance(entry, Mapping) else entry


def nested_scrubbed(row: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """``row`` with its top-level names kept (each classified, or its entity's allowlist's) and every nested map
    after the secret-name check (``scrubbed``); and how many nested keys the check refused."""
    refused = 0
    for name, value in row.items():
        row[name], count = scrubbed(value, 1)
        refused += count
    return row, refused
