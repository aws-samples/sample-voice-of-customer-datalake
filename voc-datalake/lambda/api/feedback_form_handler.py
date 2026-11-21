"""
VoC Feedback Form API Lambda
Handles: /feedback-forms/* - multiple forms management

Two paths (docs/multi-workspace.md, "Public and non-user entry points"; docs/feedback-forms.md, "Workspaces"):

* the signed-in routes (list, create, update, delete, stats, submissions) act in the workspace ``X-Workspace-Id``
  names when the request sends it (shared/workspace_request.py ``RequestWorkspace``, resolved first in each route:
  400 for an empty header, the one 404 for a non-member, an unknown or ``deleting`` workspace; a platform admin
  enters as admin, live-checked and audited). There any member reads, and only its editors and admins create,
  update and delete (a viewer 403; the role read from the table, never the 30 s cache). The workspace's forms live
  in ``WS#{ws}#FEEDBACK_FORM`` / ``FORM#{id}`` (through ``ws_table``), each with a lookup row ``FORM#{id}`` / ``META``
  in voc-workspaces naming the workspace (shared/workspace_routing.py), and their stats read the workspace's
  feedback partition. Without the header, everything is deployment-wide, as before;
* the public widget routes (config, iframe, submit, events) never read the header: they look the form id up
  (``_public_form``). A form with a lookup row is its workspace's (the row's workspace, which must be ``active``):
  its config is served from the workspace's form, and a submission is queued with that ``workspace_id``
  (``workspace_payload``, after every other field) and its raw copy kept under ``ws/{ws}/raw/feedback_form/``. A form
  without one is a deployment form, exactly as before; a row naming a malformed, unknown or ``deleting`` workspace
  answers the same 404 as an unknown id.
"""
import copy
import hmac
import html as html_text
import json
import math
import os
import re
import secrets
import uuid
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeGuard

from aws_lambda_powertools.event_handler import Response
from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

from shared import category_access, feedback_category, form_theme, null_origin_cors, prototype_pins
from shared import forms_v2 as fv2
from shared import forms_v2_csv as fcsv
from shared import forms_v2_responses as fresp
from shared.api import api_handler, create_api_resolver, get_caller_subject, get_raw_categories_config, validate_limit
from shared.app_feedback_tag import APP_FEEDBACK_TEMPLATE_ID, RESERVED_MESSAGE, names_app_feedback
from shared.audit_rows import put_new_audit_row
from shared.aws import get_dynamodb_resource, get_sqs_client
from shared.category_gate import scope_for_event
from shared.delete_audit import actor_from_event, record_delete_first, record_delete_once
from shared.dynamo_paging import iter_query
from shared.dynamo_values import is_whole
from shared.exceptions import (
    ApiError,
    AuthorizationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    ServiceError,
    ValidationError,
)
from shared.feedback_form_participants import record_response, resolve_participant
from shared.feedback_form_raw import FEEDBACK_FORM_SOURCE, archive_submission
from shared.feedback_partitions import source_partition
from shared.form_test_responses import form_sk_prefix, test_response_key, test_responses_partition
from shared.form_theme import validate_theme
from shared.forms_v2_report import REPORT_PREFIX, ai_view, latest_report, report_sections, themes
from shared.forms_v2_results import (
    LEFT_COUNTER_PREFIX,
    ResultRow,
    filter_rows,
    funnel_counts,
    headline,
    legacy_row,
    tally_results,
)
from shared.forms_v2_segments import (
    MAX_COMPARED_FORMS,
    MIN_SEGMENT,
    FormSide,
    GroupBy,
    compare,
    parse_group_by,
    segment_results,
)
from shared.ingest_tables import table_view
from shared.onboarding import forms_partition as _forms_partition
from shared.project_gate import caller_from_event
from shared.request_workspace import require_settings_admin
from shared.scoped_query import SortRange, iter_partition, query_partition
from shared.source_profiles import PII_ALLOW
from shared.tables import configured_table, get_workspaces_table
from shared.workspace import EDITING_ROLES, audit_key, audit_sort_key
from shared.workspace_request import RequestWorkspace
from shared.workspace_routing import (
    RoutedWorkspace,
    Unroutable,
    claim_lookup,
    release_lookup,
    route_public_id,
    workspace_payload,
)
from shared.ws_repo import WorkspaceScope, scope_of, ws_table

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table

# Shared module imports
from shared.logging import logger, metrics, tracer
from shared.producer_labels import clean_dimensions, message_labels, normalise_label_fields
from shared.request_body import json_body_value, json_object_body, optional_field, validated_text
from shared.snapstart import api_route_warmer, register_snapshot_hooks
from shared.source_policy import apply_source_policy
from shared.source_profiles import cached_source_profile_strict
from shared.timestamps import now_iso

# AWS Clients
dynamodb = get_dynamodb_resource()
sqs = get_sqs_client()

# Configuration
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')
FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
PROCESSING_QUEUE_URL = os.environ.get('PROCESSING_QUEUE_URL', '')
BRAND_NAME = os.environ.get('BRAND_NAME', '')

#: The primary language a version 1 form that names none is migrated to (the deployment's processing language,
#: ``-c primaryLanguage``; 'en' when unset or not one of the app's nine).
DEFAULT_FORM_LANGUAGE = os.environ.get('PRIMARY_LANGUAGE', 'en')

aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None
feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None



def _preset_routing(routing: Mapping[str, Any], scope: WorkspaceScope | None = None) -> tuple[str, str]:
    """A category routing (the form's own ``category`` / ``subcategory``, or the answered option's) as category
    NAMES (a pre-5.25 form may hold config ids), against the categories of the form's workspace (``scope``; the
    deployment's for a deployment form).

    This is the public, unauthenticated submit path, so the config comes from the
    warm-container cache (5 minutes, ``shared.api.get_raw_categories_config``), and a
    config that cannot be read keeps the stored values: a submission is never lost
    over a mapping that only rewrites a legacy id.
    """
    category = str(routing.get('category') or '')
    subcategory = str(routing.get('subcategory') or '')
    if not category:
        return '', subcategory
    return feedback_category.routed_names(get_raw_categories_config(aggregates_table, scope), category, subcategory)

def _forms_table() -> 'Table':
    """The aggregates table, where form configs live; ConfigurationError when unset."""
    if aggregates_table is None:
        raise ConfigurationError('AGGREGATES_TABLE not configured')
    return aggregates_table


def _form_key(form_id: str, scope: WorkspaceScope | None = None) -> dict[str, str]:
    """A form config's key: ``FEEDBACK_FORM`` / ``FORM#{id}``, or the workspace's ``WS#{ws}#FEEDBACK_FORM``."""
    return {'pk': _forms_partition(scope), 'sk': f'FORM#{form_id}'}


def _forms(scope: WorkspaceScope | None) -> Any:
    """The forms table on either path: deployment-wide the table's own calls, in a workspace through ``ws_table``
    (a key outside the workspace refused before DynamoDB)."""
    return table_view(scope, _forms_table())


# The workspace a signed-in request acts in (shared/workspace_request.py): its warm container's memberships (30 s).
# Create, update and delete are writes: EDITING_ROLES (shared/workspace.py, docs/multi-workspace.md "Roles").
_workspace = RequestWorkspace()


def _request_scope(*, write: bool = False) -> WorkspaceScope | None:
    """The workspace a signed-in route acts in (None: deployment-wide), resolved first in each route, before the
    body is read. A write (``write``) needs the editor or admin role there (403), read from the table (``fresh``),
    never the 30 s cache, so a member demoted a moment ago cannot write."""
    context = _workspace.context(app.current_event.raw_event, fresh=write)
    if context is None:
        return None
    if write and context.role not in EDITING_ROLES:
        raise AuthorizationError('Managing feedback forms needs the editor or admin role in this workspace')
    return scope_of(context)


# ============================================
# Form Configuration Schema & Defaults
# ============================================

# VoC light shown (the Kiro Light palette, docs/kiro-design-system.md: accent, page background, strong text; white
# on the accent is 4.64:1, where the old blue default was 3.68:1 and failed axe colour-contrast on the widget's start
# button, E2E F6), VoC dark as the dark palette, the system font at the default size (shared/form_theme.py).
# Mirrored by frontend …/model/formsV2.ts DEFAULT_THEME, frontend/mock-forms-v2.js and the widget's own defaults.
DEFAULT_THEME = form_theme.default_theme()

#: A new form's fields besides its definition (shared/forms_v2.py ``DEFINITION_FIELDS``) and test settings, with
#: their defaults. A create body without ``questions`` is a version 1 body: its v1 fields (shared/forms_v2.py
#: ``V1_DEFAULTS`` filled in) are migrated, so the form is stored as version 2 from its first write.
DEFAULT_FORM_CONFIG = {
    'name': 'New Feedback Form',
    'enabled': False,
    'theme': DEFAULT_THEME,
    'custom_fields': [],
    'category': '',
    'subcategory': '',
    # Optional link to the artefact this form validates (issue: prioritization
    # evidence). Empty string means "validates nothing in particular" — the
    # standalone website-survey case, which must keep behaving exactly as it
    # did before these fields existed. `project_id` is the durable half of the
    # link: regenerating a document mints a new document_id, so readers match
    # on project first and treat document_id as a refinement.
    'project_id': '',
    'document_id': '',
    # Dimension values and tags every submission starts with (KVD contract):
    # validated against the dimensions config on save, merged UNDER the
    # widget's own `dimensions` embed option at submit.
    'dimension_defaults': {},
    'tags': [],
}

# Fields that can be updated via PUT
#
# `brand_name` is deliberately absent, and that is a decision rather than an
# omission: it is the form's partition key input (see _form_source_pk), so
# editing it moves where this form's stats read looks WITHOUT moving the
# submissions already stored under the old value — the exact stranding this
# module's write/read agreement exists to prevent, only triggered by hand. A
# form's brand is therefore set once (build_form_item, or _anchor_form_brand for
# a record created without one) and then fixed for the life of the form. If a
# brand ever genuinely needs correcting, it needs a migration that rewrites the
# feedback records' partition too, not a PUT.
#
# The case that migration is the ONLY remedy for, spelled out because it exists
# in deployed data rather than in theory: a form whose submissions predate its
# anchor can have them spread over two SOURCE# partitions already — before the
# brand was resolved onto the record, a submission was stamped from the live
# BRAND_NAME, so any deployment renamed (or given a brand for the first time)
# while a brandless form was collecting has some submissions under the old value
# and some under the new. The anchor pins the form to one of them, and the stats
# read reports only that half. This is not a regression — that form reported the
# same half before — but the anchor makes it durable where a further rename used
# to flip it, and no PUT can move it. Accepted deliberately: the alternative is
# recording the pre-anchor brand and querying both partitions, which doubles the
# reads on a route that already reads a whole partition (see get_form_stats).
# Recovering the other half means rewriting those feedback records' pk.
#
# A PUT also takes the definition (``fv2.DEFINITION_FIELDS``: a new revision when it changes), ``settings.test``
# (``link_enabled`` and ``record``; the token only through POST …/test-link) and, for compatibility, a version 1
# patch (``fv2.V1_FIELDS``; see ``_definition_update``).
UPDATABLE_FIELDS = [
    'name', 'enabled', 'theme', 'custom_fields', 'category', 'subcategory', 'project_id', 'document_id',
    'dimension_defaults', 'tags',
]


# The link fields hold server-minted identifiers (`proj_20260101120000`,
# `prfaq_...`), so anything long is not one. A cap keeps a client from writing an
# arbitrarily large blob into an attribute the Prioritization page then reads
# back, and keeps the item within DynamoDB's 400 KB limit for reasons a caller
# cannot argue with.
LINK_FIELD_MAX_LENGTH = 128

# Fields whose value is an identifier the API mints, not free text the caller
# composes. Validated on the way in — see validate_link_fields.
LINK_FIELDS = ('project_id', 'document_id')


# ============================================
# Form identifier (issue #379; design from upstream PR #396)
# ============================================
#
# Ids this service mints: `ff_` (a workspace's form) or `fd_` (a deployment
# form) + 32 hex (128 random bits, new_form_id, since the public routes'
# workspace slice: an id nobody can guess, so a public route never learns of a
# form it was not handed) and `pf_` + 16 hex
# (shared/prototype_pins.pin_form_id). Forms created before keep their
# `str(uuid4())[:8]` ids (8 hex chars), which every route still serves. The
# pattern is WIDER than all of them on purpose so hand-seeded or imported ids such as `website-form` or
# `acme.website` keep working; what it bounds is the character set and length.
# Every character that can end a JavaScript string or open an HTML tag — quote,
# parentheses, semicolon, `<`, `>`, `&`, backslash, whitespace — is outside it,
# while Powertools' route capture group admits most of them.
#
# `(?!\.{1,2}\Z)` refuses exactly '.' and '..', the relative-path segments a URL
# join would resolve away. `\Z` rather than `$`: Python's `$` also matches before
# a trailing newline, which would admit 'deadbeef\n'.
FORM_ID_MAX_LENGTH = 64
_FORM_ID_PATTERN = re.compile(
    rf'^(?!\.{{1,2}}\Z)[0-9A-Za-z_.-]{{1,{FORM_ID_MAX_LENGTH}}}\Z'
)


#: A workspace form's id prefix, and a new deployment form's: two shapes, so the public routes look up only the first.
FORM_ID_PREFIX = 'ff_'
DEPLOYMENT_FORM_ID_PREFIX = 'fd_'
FORM_ID_BYTES = 16
#: The shape a workspace's form has (new_form_id in a workspace), the only one the public routes look up (FORM#{id});
#: every other id (a deployment form's `fd_` one, an 8-character one, a pin form's, a hand-seeded one) is the
#: deployment's, with no voc-workspaces read.
_ROUTABLE_FORM_ID = re.compile(rf'{FORM_ID_PREFIX}[0-9a-f]{{{FORM_ID_BYTES * 2}}}')


def new_form_id(scope: WorkspaceScope | None = None) -> str:
    """A new form's id, 32 hex characters (128 bits from `secrets`) after its prefix: `ff_` in a workspace (routable:
    unique across workspaces through its lookup row), `fd_` deployment-wide (never looked up). Unguessable either way."""
    prefix = FORM_ID_PREFIX if scope is not None else DEPLOYMENT_FORM_ID_PREFIX
    return prefix + secrets.token_hex(FORM_ID_BYTES)


def _validated_form_id(raw: Any) -> str | None:
    """The form id from the URL, or None if it cannot be one of ours.

    Modelled on `ballots_handler._validated_session_id`: checked before any read,
    so a junk id costs no DynamoDB call, and None rather than a raise because every
    caller answers the same 404 (telling "malformed" from "absent" only helps a
    prober). Not stripped: an exact id keeps URL-to-page one-to-one.
    """
    if not isinstance(raw, str):
        return None
    return raw if _FORM_ID_PATTERN.match(raw) else None


def _public_form_id(raw: Any) -> str:
    """`_validated_form_id` for the unauthenticated routes: the id, or a 404."""
    validated = _validated_form_id(raw)
    if validated is None:
        raise NotFoundError('Form not found')
    return validated


def _route_form(form_id: str, failure_message: str) -> RoutedWorkspace | None:
    """The workspace a public route's form belongs to, from its lookup row (never from the request): None for a
    deployment form (no row, or an id of a shape no workspace form has). A row naming a malformed, unknown or
    `deleting` workspace is the unknown id's 404; a failed read a logged 500. Without voc-workspaces configured
    (a local run) no form can be a workspace's (creating one resolves the workspace there), so none is looked up."""
    table = get_workspaces_table()
    if table is None or not _ROUTABLE_FORM_ID.fullmatch(form_id):
        return None
    try:
        return route_public_id(table, form_id)
    except Unroutable:
        raise NotFoundError('Form not found') from None
    except (ClientError, BotoCoreError) as e:
        logger.exception(f"Error routing form {form_id}: {type(e).__name__}")
        raise ServiceError(failure_message) from e


def _refuse_a_workspaces_id(form_id: str, failure_message: str) -> None:
    """Deployment-wide, an update or delete of an id a workspace's lookup row holds is the unknown id's 404 (a row of
    a live workspace or not): a deployment row under it would be served by the public routes once the workspace
    deletes its form, so its embed would feed the deployment. (A row naming a dead workspace raises the 404 in
    ``_route_form`` itself.)"""
    if _route_form(form_id, failure_message) is not None:
        raise NotFoundError('Form not found')


def _public_form(raw_id: Any, failure_message: str) -> tuple[str, dict, RoutedWorkspace | None]:
    """A public route's form: its id (404 when it cannot be one), the workspace its lookup row routes it to (None:
    a deployment form) and the stored form there (404 when absent)."""
    form_id = _public_form_id(raw_id)
    routed = _route_form(form_id, failure_message)
    return form_id, _read_form(form_id, failure_message, routed.scope if routed else None), routed


# ============================================
# Public submission limits (issue #222)
# ============================================
#
# POST /submit is unauthenticated and every accepted submission buys a
# Comprehend + Translate + Bedrock enrichment, so the body is bounded before the
# form is even read. The form config carries no text-length setting of its own,
# so these constants are the only limit. They sit far above what the widget's own
# fields produce (a textarea, a name, an email and `window.location.href`).
MAX_SUBMISSION_TEXT_CHARS = 10_000
#: The query parameter of a test link (``…/iframe?test=<token>``), read by the iframe page (``_LINK_JS``).
TEST_LINK_PARAMETER = 'test'
MAX_SUBMITTER_NAME_CHARS = 200
MAX_SUBMITTER_EMAIL_CHARS = 254  # RFC 5321 path limit
MAX_PAGE_URL_CHARS = 4096
MAX_CUSTOM_FIELDS = 20
MAX_CUSTOM_FIELD_KEY_CHARS = 64
MAX_CUSTOM_FIELD_VALUE_CHARS = 1000
# The widget's numeric rating renders 1..10 whatever `rating_max` says, stars
# render 1..rating_max, emoji 1..5 (static/feedback-widget.js). Lockstepped with
# shared/ingest_schemas.MAX_RATING (the processor's bound) by a test.
MAX_SUBMISSION_RATING = 10
# Schema version 2's own bounds the gateway model restates (lib/stacks/api-request-models.ts, lockstepped by
# api-request-validation.test.ts; equal to shared/forms_v2.py's, pinned by test_feedback_form_v2.py).
MAX_FORM_ANSWERS = 30
MAX_HIDDEN_FIELDS = 20
MAX_TEST_TOKEN_CHARS = 64
MAX_FORM_ID_CHARS = 44


def _validated_submission_text(body: dict) -> str:
    """The stripped feedback text, or a 400 when absent, not a string, or too long."""
    return validated_text(body.get('text'), 'Feedback text', MAX_SUBMISSION_TEXT_CHARS, required=True)


def _validate_optional_string(body: Mapping[str, Any], field: str, max_chars: int) -> None:
    """`field` may be absent or null (the widget sends null); otherwise a bounded string."""
    value = body.get(field)
    if value is None:
        return
    if not isinstance(value, str):
        raise ValidationError(f'{field} must be a string')
    if len(value) > max_chars:
        raise ValidationError(f'{field} must be at most {max_chars} characters')


def _validate_custom_field_value(key: str, value: object) -> None:
    """One custom field answer: a short scalar (string, finite number, boolean or null).

    `json.loads` accepts the non-standard `NaN` / `Infinity` literals; they are
    refused here because they cannot be stored in DynamoDB nor re-serialised as
    standard JSON downstream.
    """
    if isinstance(value, float) and not math.isfinite(value):
        raise ValidationError(f'custom_fields.{key} must be a finite number')
    if value is None or isinstance(value, bool | int | float):
        return
    if not isinstance(value, str):
        raise ValidationError(f'custom_fields.{key} must be a string, number, boolean or null')
    if len(value) > MAX_CUSTOM_FIELD_VALUE_CHARS:
        raise ValidationError(
            f'custom_fields.{key} must be at most {MAX_CUSTOM_FIELD_VALUE_CHARS} characters'
        )


def _validate_custom_fields(body: dict) -> None:
    """`custom_fields`, when present, is a small mapping of short keys to short scalars."""
    fields = body.get('custom_fields')
    if fields is None:
        return
    if not isinstance(fields, dict):
        raise ValidationError('custom_fields must be an object')
    if len(fields) > MAX_CUSTOM_FIELDS:
        raise ValidationError(f'custom_fields may hold at most {MAX_CUSTOM_FIELDS} entries')
    for key, value in fields.items():
        if not key or len(key) > MAX_CUSTOM_FIELD_KEY_CHARS:
            raise ValidationError(
                f'custom_fields keys must be 1-{MAX_CUSTOM_FIELD_KEY_CHARS} characters'
            )
        _validate_custom_field_value(key, value)


def _validate_rating(body: dict) -> None:
    """`rating` is absent, null, or a finite number in 1..MAX_SUBMISSION_RATING.

    Booleans are refused although Python counts them as ints (`true` is not a
    rating), and so are NaN / Infinity, which `json.loads` accepts.
    """
    rating = body.get('rating')
    if rating is None:
        return
    is_number = isinstance(rating, int | float) and not isinstance(rating, bool)
    if not is_number or not math.isfinite(rating) or not 1 <= rating <= MAX_SUBMISSION_RATING:
        raise ValidationError(f'rating must be null or a number from 1 to {MAX_SUBMISSION_RATING}')


def _validated_submission(body: dict) -> str:
    """Bound every caller-supplied field of a public submission; returns the text."""
    text = _validated_submission_text(body)
    _validate_rating(body)
    _validate_optional_string(body, 'name', MAX_SUBMITTER_NAME_CHARS)
    _validate_optional_string(body, 'email', MAX_SUBMITTER_EMAIL_CHARS)
    _validate_optional_string(body, 'page_url', MAX_PAGE_URL_CHARS)
    _validate_custom_fields(body)
    return text


MAX_WIDGET_DIMENSIONS = 10


def _widget_dimensions(body: dict) -> dict[str, str]:
    """The widget's `dimensions` embed option: an object of at most 10 entries.

    Malformed entries are dropped rather than refused (the embed option is
    written into a customer's page and may be stale); the processor keeps only
    the configured keys and values.
    """
    raw = optional_field(body, 'dimensions', _is_widget_dimensions, lambda: ValidationError(
        f'dimensions must be an object of at most {MAX_WIDGET_DIMENSIONS} entries'))
    return {} if raw is None else clean_dimensions(raw)


def _is_widget_dimensions(value: object) -> TypeGuard[dict]:
    return isinstance(value, dict) and len(value) <= MAX_WIDGET_DIMENSIONS


def _validate_form_labels(body: dict, scope: WorkspaceScope | None = None, *, app_feedback: bool) -> None:
    """Normalise `dimension_defaults` / `tags` in a create/update body in place (400 when invalid), against the
    dimensions of the form's workspace (``scope``; the deployment's for a deployment form). ``app_feedback``: the form
    may carry the in-app micro-feedback's reserved tag (one made from its template, shared/app_feedback_tag.py)."""
    normalise_label_fields(_forms_table(), body, scope, app_feedback=app_feedback)


def _made_for_app_feedback(form: Mapping[str, Any]) -> bool:
    """Whether ``form`` (a create body, or a stored form) was made from the In-app micro-feedback template: the one
    kind of form whose tags may hold ``voc_app`` (7.66.00)."""
    template = fv2.plain(form.get('template'))
    return isinstance(template, Mapping) and template.get('id') == APP_FEEDBACK_TEMPLATE_ID

def validate_link_fields(body: dict) -> None:
    """Reject a malformed project_id / document_id before it is persisted.

    These two are the only writable fields whose values another surface later
    matches on (Prioritization pairs a form to a document by them), so a
    non-string — a dict, a list, a number — would be stored verbatim and then
    silently match nothing. Failing the request says so instead.

    Absent is always fine: the link is optional, and '' is how "validates
    nothing" is spelled.
    """
    for field in LINK_FIELDS:
        if field not in body:
            continue
        value = body[field]
        if not isinstance(value, str):
            raise ValidationError(f'{field} must be a string')
        if len(value) > LINK_FIELD_MAX_LENGTH:
            raise ValidationError(
                f'{field} must be at most {LINK_FIELD_MAX_LENGTH} characters'
            )


def _anchor_form_brand(form_id: str, effective_brand: str, scope: WorkspaceScope | None = None) -> None:
    """Pin a form with no stored brand to the brand its submissions are going to.

    build_form_item writes 'brand_name': BRAND_NAME, so a form created while
    BRAND_NAME was unset is stored with ''. For those records BOTH sides of the
    partition fall through to the live environment variable — the write's
    `form.get('brand_name') or BRAND_NAME` and _form_source_pk's identical
    fallback. They agree at any instant, so nothing looks wrong, but the
    agreement is only as stable as the environment: rename the deployment and
    every submission collected before the rename becomes unreachable to the
    form's own stats read. That is exactly the stranding the write-site fix was
    chosen to avoid.

    Writing the resolved brand back onto the form record removes the dependence
    on the environment for good: from here on both sides read a stored value the
    next deployment cannot move.

    Conditional so it is idempotent and can never overwrite a real brand — if a
    concurrent submission (or an admin edit) got there first, the condition fails
    and that value stands, which is the outcome we want either way. Best effort:
    the submission itself must not fail because the anchor did not stick, since
    the record being enqueued already carries the same brand.

    Writes updated_at as well, because brand_name is not an internal detail: it
    is published by item_to_form AND by the public item_to_widget_config, and
    every other write path here maintains updated_at (build_form_item sets it,
    update_form always appends it). A published field that changes with no trace
    of when is harder to explain later than the split this prevents.

    A workspace's form (``scope``) is anchored in place, through ``ws_table``.
    """
    try:
        _forms(scope).update_item(
            _form_key(form_id, scope),
            UpdateExpression='SET brand_name = :brand, updated_at = :now',
            # attribute_exists(sk) leads, because UpdateItem is an UPSERT and
            # attribute_not_exists(brand_name) is SATISFIED by a missing item: a
            # form deleted between submit_form_feedback's get_item and this write
            # (a widget on a customer's site racing DELETE /feedback-forms/<id>)
            # would otherwise be written back as a bare {pk, sk, brand_name}
            # stub — a nameless row in list_forms whose own form_id is '', and a
            # deleted form answering 200 with total_submissions 0 again on the
            # very route this change made honest. Existence-first turns that into
            # a ConditionalCheckFailedException, i.e. nothing.
            #
            # The parentheses are for readability only, NOT for correctness:
            # DynamoDB binds AND tighter than OR, and a comparison against an
            # absent attribute evaluates false rather than erroring, so the
            # unparenthesised spelling rejects a missing item identically
            # (verified against a real table). attribute_exists(sk) is the whole
            # of the guard — said explicitly so nobody re-derives a precedence
            # rule that does not exist and then "protects" the brackets instead
            # of the conjunct that matters.
            ConditionExpression=(
                'attribute_exists(sk) AND '
                '(attribute_not_exists(brand_name) OR brand_name = :empty)'
            ),
            ExpressionAttributeValues={
                ':brand': effective_brand,
                ':empty': '',
                ':now': now_iso(),
            },
        )
        logger.info(f"Anchored form {form_id} to brand '{effective_brand}'")
    except Exception as e:  # noqa: BLE001 - see below; a submission outlives it
        # One handler, so there is exactly one place this can be logged from.
        # Deliberately blind: an anchor is a convenience for future reads, and no
        # failure of it — throttling, a denied grant, a bug in this function — is
        # worth dropping a customer's feedback for. The record already on its way
        # to the queue carries the same brand either way.
        if _is_conditional_check_failure(e):
            # The condition did its job: the form already carries a brand, or the
            # record no longer exists. The stored state wins; nothing to do.
            return
        logger.warning(f"Could not anchor brand_name for form {form_id}: {e}")


def _is_conditional_check_failure(error: Exception) -> bool:
    """Was this DynamoDB refusing a write because its condition did not hold?"""
    if not isinstance(error, ClientError):
        return False
    return (
        error.response.get('Error', {}).get('Code')
        == 'ConditionalCheckFailedException'
    )


def _definition(item: Mapping[str, Any]) -> dict[str, Any]:
    """The form's definition as version 2 (a version 1 form migrated, in the deployment's language when it names
    none)."""
    return fv2.definition_of(item, DEFAULT_FORM_LANGUAGE)


def _is_v2_body(body: Mapping[str, Any]) -> bool:
    """A create or update body in schema version 2: it names ``questions`` (or says ``schema_version: 2``)."""
    return 'questions' in body or fv2.is_v2(body)


def _body_definition(body: Mapping[str, Any]) -> dict[str, Any]:
    """A create body's definition: its version 2 fields (``language`` 'en' when absent), or its version 1 fields
    (defaults filled in) migrated."""
    if _is_v2_body(body):
        return {'language': fv2.DEFAULT_LOCALE, **{f: body[f] for f in fv2.DEFINITION_FIELDS if f in body}}
    v1 = {f: body[f] for f in (*fv2.V1_FIELDS, 'language') if f in body}
    return fv2.migrate_v1({**fv2.V1_DEFAULTS, **v1}, DEFAULT_FORM_LANGUAGE)


def build_form_item(body: dict, form_id: str | None = None, scope: WorkspaceScope | None = None,
                    actor: str = '') -> dict:
    """Build DynamoDB item from request body with defaults (a workspace's form under its own partition).

    Stored as schema version 2, revision 1, whatever the body's version (a version 1 body is migrated). Validates
    the link fields and the definition here rather than leaving it to the caller: this is the only way a new record
    is constructed, so a future second caller cannot reach the table with an unvalidated one by forgetting a line.
    """
    validate_link_fields(body)
    validate_theme(body)
    definition = fv2.validate_definition(_body_definition(body))
    # Created live: its text must be readable and no text may show a placeholder as written (shared/forms_v2.py); a
    # form created Off is always stored.
    fv2.validate_publishable(body.get('theme', DEFAULT_THEME), live=bool(body.get('enabled', False)))
    fv2.validate_placeholders(definition, live=bool(body.get('enabled', False)))
    test = fv2.test_settings_of({})
    if 'settings' in body:
        test = fv2.validate_test_settings(body['settings'], test)
    # The app template it was made from (7.63.00): set once, here, so Compare can match the forms one template made.
    template = fv2.validate_template(body['template']) if body.get('template') is not None else None
    now = now_iso()
    fid = form_id or new_form_id(scope)

    item = {
        **_form_key(fid, scope),
        'form_id': fid,
        'brand_name': BRAND_NAME,
        'created_at': now,
        'updated_at': now,
        'schema_version': fv2.SCHEMA_VERSION,
        'revision': 1,
        'write_count': 0,
        # (7.58.01) Not answered yet: its first real response marks it (``_mark_answered``), so a definition change
        # never reads the brand's responses for it (``_plan_update`` does for a form created before, with no flag).
        'has_responses': False,
        **definition,
        'settings': {'test': test},
    }
    if actor:
        item['created_by'] = item['updated_by'] = actor
    if template is not None:
        item['template'] = template

    # Apply defaults, then override with provided values
    for name, default in DEFAULT_FORM_CONFIG.items():
        item[name] = body.get(name, default)
    if 'theme' not in body:
        item['theme'] = form_theme.default_theme()  # its own copy: the default holds a nested palette

    return item


def _stored_form(form_id: str, scope: WorkspaceScope | None = None) -> dict:
    """The form record as stored (in ``scope``'s partition for a workspace's form), or a 404. Read errors propagate
    to the caller."""
    response = _forms(scope).get_item(_form_key(form_id, scope))
    item = response.get('Item')
    if not item:
        raise NotFoundError('Form not found')
    return item


def _read_form(form_id: str, failure_message: str, scope: WorkspaceScope | None = None) -> dict:
    """`_stored_form` for a route: 404 stays a 404, any other read failure is a logged 500."""
    try:
        return _stored_form(form_id, scope)
    except NotFoundError:
        raise
    except Exception as e:
        logger.exception(f"Error reading form {form_id}: {e}")
        raise ServiceError(failure_message) from e


class _RatingTally:
    """The rating statistics the submissions and stats routes both report.

    Both page the same partition and both derive the same three numbers from it;
    `add` sees every submission row, `stats` reports them for `total_submissions`
    rows (which the submissions route bounds by its page, the stats route does not).

    Given the form's definition (the stats and list routes), ``stats`` also reports the
    card's ``headline`` (shared/forms_v2_results.py ``headline``: the first measuring
    question's NPS, CSAT % or average, None without one) and, when a counted response carries
    its time, ``last_response_at``: the latest ``source_created_at`` (the card's "last response
    2 h ago"; absent when none does), and ``channels``: for each way the form was answered
    (``metadata.form_channel``: link, iframe, script), the latest time it was (absent when no
    response says; a widget from before 7.55.01 sends none). Derived when the stats are read,
    so a submit writes nothing more than its response. Test responses are never feedback
    items, so no figure here counts them.
    """

    def __init__(self, definition: Mapping[str, Any] | None = None):
        self.total_rating = 0
        self.rating_count = 0
        self._definition = definition
        self._rows: list[ResultRow] = []
        self._last_response_at = ''
        self._channels: dict[str, str] = {}

    def add(self, item: dict) -> None:
        rating = item.get('rating')
        if rating:
            self.total_rating += float(rating)
            self.rating_count += 1
        if self._definition is not None and (row := _result_row(item, self._definition)) is not None:
            self._rows.append(row)
        # (ISO 8601 UTC timestamps, so the latest is the greatest string)
        created = item.get('source_created_at')
        if not isinstance(created, str):
            return
        self._last_response_at = max(self._last_response_at, created)
        metadata = item.get('metadata')
        channel = metadata.get('form_channel') if isinstance(metadata, Mapping) else None
        if channel in fresp.CHANNELS:
            self._channels[channel] = max(self._channels.get(channel, ''), created)

    def stats(self, total_submissions: int) -> dict:
        avg_rating = round(self.total_rating / self.rating_count, 2) if self.rating_count > 0 else None
        out: dict[str, Any] = {
            'total_submissions': total_submissions,
            'avg_rating': avg_rating,
            'rating_count': self.rating_count,
        }
        if self._definition is not None:
            out['headline'] = headline(self._definition)(self._rows)
            if self._last_response_at:
                out['last_response_at'] = self._last_response_at
            if self._channels:
                out['channels'] = {name: self._channels[name] for name in fresp.CHANNELS if name in self._channels}
        return out


def _test_settings_view(item: Mapping[str, Any]) -> dict[str, Any]:
    """``settings.test`` for a signed-in reader: whether a test link is on and how it records, and whether (and when)
    its token was issued. Never the token: only POST …/test-link answers it, to an admin."""
    test = fv2.test_settings_of(item)
    view = {'link_enabled': test['link_enabled'], 'record': test['record'], 'token_issued': 'token' in test}
    if 'token_issued_at' in test:
        view['token_issued_at'] = test['token_issued_at']
    return view


def item_to_form(item: dict) -> dict:
    """Convert DynamoDB item to the authenticated form response: the public widget
    projection (`item_to_widget_config`) plus the fields only signed-in callers see.

    The public projection is the base and never the other way round, so a field added
    here stays out of the unauthenticated `GET /feedback-forms/<id>/config`. Two of its
    fields are re-stated in full here: ``questions`` with each option's category mapping
    and ``hidden_fields`` with their labels, which the public one leaves out."""
    definition = _definition(item)
    return {
        'form_id': item.get('form_id', ''),
        'name': item.get('name', ''),
        **item_to_widget_config(item),
        'questions': definition.get('questions') or [],
        'hidden_fields': definition.get('hidden_fields') or [],
        'settings': {'test': _test_settings_view(item)},
        'custom_fields': item.get('custom_fields', []),
        'category': item.get('category', ''),
        'subcategory': item.get('subcategory', ''),
        # Optional validation link — authenticated callers only. Deliberately
        # absent from item_to_widget_config below.
        'project_id': item.get('project_id', ''),
        'document_id': item.get('document_id', ''),
        'dimension_defaults': item.get('dimension_defaults') or {},
        'tags': item.get('tags') or [],
        # 'standard' for every dashboard-created form; 'prototype_pin' for the
        # one form each built prototype gets (shared/prototype_pins.py). Set by
        # the document generator only — not creatable or updatable here.
        'form_type': item.get('form_type') or 'standard',
        # The app template it was made from (7.63.00), never changed by a save; absent for any other form.
        **({'template': template} if (template := fv2.template_of(item)) is not None else {}),
        'brand_name': item.get('brand_name', ''),
        'created_at': item.get('created_at', ''),
        'updated_at': item.get('updated_at', ''),
        'updated_by': item.get('updated_by', ''),
        # A real response was accepted (the submit route marks the form once, from 7.55.00; `GET /feedback-forms/{id}`
        # also counts the stored ones): the builder locks option codes and question ids from the first. A test
        # response never marks it.
        'has_responses': item.get('has_responses') is True,
        # The question ids the form had and removed, which no question may take again (a save that does is a 400
        # ``question_id_reused``): the builder never offers one for a new question, a copy or a follow-up.
        'retired_ids': [qid for qid in fv2.plain(item.get('retired_ids') or []) if isinstance(qid, str)],
        # How many saves the form row has taken: a save's ``expected_write_count`` (the builder's precondition).
        'write_count': _write_count(item),
        # Still stored as version 1 (served migrated until its first save writes it back as version 2).
        **({} if fv2.is_v2(item) else {'migrated_from': 1}),
    }


def _write_count(item: Mapping[str, Any]) -> int:
    """The form row's save counter (0 for a row written before 7.58.00, which has none)."""
    value = fv2.plain(item.get('write_count'))
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def item_to_widget_config(item: dict) -> dict:
    """Convert DynamoDB item to the PUBLIC widget config response: schema version 2.

    The narrower projection `item_to_form` is built on, never "item_to_form minus a
    few keys": `GET /feedback-forms/<id>/config` is unauthenticated and fetched by
    the widget from the customer's own website, so every field here is one someone
    chose to publish. A field added to `item_to_form` does not reach it; one added
    here is published, on purpose.

    Only what the widget renders and checks: whether the form is on, its revision (a
    response names it), its languages, welcome, questions (shared/forms_v2.py
    ``public_definition``: no option category mapping), hidden field ids, endings and
    theme. Never the internal name, the routing, the links, the labels or the test
    settings. A version 1 form is served migrated. Mirrors `FeedbackFormConfig` in
    frontend/src/api/types.ts.
    """
    return {
        'enabled': item.get('enabled', False),
        'schema_version': fv2.SCHEMA_VERSION,
        'revision': fv2.revision_of(item),
        **fv2.public_definition(_definition(item)),
        # A version 1 form without a language: migrated to the deployment's, which its author has not confirmed yet.
        'language_assumed': fv2.language_assumed(item),
        # Every field: a theme stored before 7.55.01 answers its new ones' defaults (shared/form_theme.py).
        'theme': form_theme.with_defaults(item.get('theme')),
    }


# ============================================
# Widget JavaScript Loader
# ============================================

_widget_js_cache: str | None = None


def get_widget_js() -> str:
    """Load widget JavaScript from static file (cached)."""
    global _widget_js_cache

    if _widget_js_cache is not None:
        return _widget_js_cache

    # Try to load from static file
    static_path = Path(__file__).parent / 'static' / 'feedback-widget.js'
    try:
        _widget_js_cache = static_path.read_text()
    except FileNotFoundError:
        logger.warning(f"Widget JS not found at {static_path}, using fallback")
        _widget_js_cache = _get_fallback_widget_js()
    return _widget_js_cache


def _get_fallback_widget_js() -> str:
    """Minimal fallback if static file is missing."""
    return '''
(function() {
  window.VoCFeedbackForm = {
    init: function(options) {
      var container = document.querySelector(options.container);
      if (container) container.innerHTML = '<p style="color:#666;text-align:center;padding:40px;">Widget loading error.</p>';
    }
  };
})();
'''


# ============================================
# API Setup
# ============================================

# CORS origin: the CDK stack always sets ALLOWED_ORIGIN, to '*' for THIS Lambda
# (the widget's public routes run on customers' own sites; the reason is recorded
# in lib/stacks/api-engagement-lambdas.ts). Unset, it fails CLOSED like every
# other API Lambda: create_api_resolver() falls back to the local-dev origin
# rather than opening the API to every site.
app = create_api_resolver()


# ============================================
# Forms CRUD Endpoints
# ============================================
#
# Access decision (owner, recorded so reviewers stop re-raising #242 here):
# create, update and delete are INTENTIONALLY open to any authenticated user and
# are not admin-gated — the Feedback Forms UI is available to every user. Do not
# add require_admin; the public routes are hardened by input validation instead.

# DynamoDB caps an IN list at 100 operands.
_MAX_IN_OPERANDS = 100


def _chunks(values: list[str], size: int) -> list[list[str]]:
    return [values[i:i + size] for i in range(0, len(values), size)]


def _partition_rows(table: Any, scope: WorkspaceScope | None, source_pk: str, query_kwargs: dict[str, Any]) -> Any:
    """Every row of one feedback partition of ``table`` (the query's filter and projection applied): deployment-wide
    the request this module always sent, in a workspace through ``ws_table`` (the partition and every cursor its
    own)."""
    if scope is None:
        return iter_query(table, {'KeyConditionExpression': Key('pk').eq(source_pk), **query_kwargs})
    return ws_table(scope, table).iter_query('pk', source_pk, **query_kwargs)


def _stats_for_forms(items: list[dict], scope: WorkspaceScope | None = None) -> dict[str, dict]:
    """`get_form_stats` for every form in `items`, reading each partition ONCE.

    The Feedback Forms page used to ask `/feedback-forms/{id}/stats` once per
    card (E2E F11), and each of those pages the whole brand partition — shared by
    every form of that brand — to filter one form's rows out of it. This reads
    each distinct partition once with an `IN` over the forms' source channels and
    tallies the rows per form, so N cards cost one request and one partition read
    instead of N of each. Same counting rules as the single-form route: category
    scope applied, the same rating tally.
    """
    if not feedback_table:
        raise ConfigurationError('Feedback table not configured')
    access = scope_for_event(app.current_event.raw_event, aggregates_table, scope)
    form_ids_by_pk: dict[str, list[str]] = {}
    definitions: dict[str, dict[str, Any]] = {}
    for item in items:
        form_id = item.get('form_id')
        if isinstance(form_id, str) and form_id:
            form_ids_by_pk.setdefault(_form_source_pk(item, scope), []).append(form_id)
            definitions[form_id] = _definition(item)

    tallies = {fid: _RatingTally(definitions[fid]) for ids in form_ids_by_pk.values() for fid in ids}
    counts = dict.fromkeys(tallies, 0)
    for source_pk, form_ids in form_ids_by_pk.items():
        for chunk in _chunks(form_ids, _MAX_IN_OPERANDS):
            values = {f':sc{i}': f'form_{fid}' for i, fid in enumerate(chunk)}
            query_kwargs: dict[str, Any] = {
                'FilterExpression': f"source_channel IN ({', '.join(values)})",
                'ExpressionAttributeValues': values,
                # `category` + `source_platform`: both access rules read them (admits_item).
                # `metadata` (and `source_created_at`): the headline figure's answers.
                'ProjectionExpression': 'feedback_id, rating, category, source_platform, source_channel, metadata, '
                                        'source_created_at',
            }
            for row in category_access.filter_items(access, _partition_rows(feedback_table, scope, source_pk, query_kwargs)):
                form_id = str(row.get('source_channel', '')).removeprefix('form_')
                if form_id in tallies:
                    counts[form_id] += 1
                    tallies[form_id].add(row)
    return {fid: tally.stats(counts[fid]) for fid, tally in tallies.items()}


@app.get("/feedback-forms")
@tracer.capture_method
def list_forms():
    """List all feedback forms; `?include=stats` adds every form's card stats.

    The stats travel as a separate `stats` map keyed by form id (the
    `/feedback-forms/{id}/stats` payload's `stats` object), so the form objects
    keep their shape. A stats read that fails does NOT fail the list: the forms
    are still returned, `stats` is absent and `stats_error` says why, and the
    page falls back to asking per form — loud, never a zero (see get_form_stats).
    In a workspace, its own forms (``WS#{ws}#FEEDBACK_FORM``) and their stats from its own feedback.
    """
    scope = _request_scope()
    try:
        # Consistent: the page refetches right after a create/update/delete, and an
        # eventually consistent read could still list a form just deleted.
        response = query_partition(scope, _forms_table(), 'pk', _forms_partition(scope),
                                   sort=SortRange('sk', 'begins_with', _FORM_PREFIX), ConsistentRead=True)
        items = response.get('Items', [])
        forms = [item_to_form(item) for item in items]
        forms.sort(key=lambda x: x['created_at'], reverse=True)
    except Exception as e:
        logger.exception(f"Error listing forms: {e}")
        raise ServiceError('Failed to list forms') from e

    params = app.current_event.query_string_parameters or {}
    if params.get('include') != 'stats':
        return {'success': True, 'forms': forms}
    try:
        stats = _stats_for_forms(items, scope)
    except Exception as e:
        metrics.add_metric(name='FeedbackFormStatsReadFailed', unit='Count', value=1)
        logger.exception(f"Error fetching stats for the form list: {e}")
        return {'success': True, 'forms': forms, 'stats_error': 'Failed to fetch form stats'}
    return {'success': True, 'forms': forms, 'stats': stats}


@app.get("/feedback-forms/<form_id>")
@tracer.capture_method
def get_form(form_id: str):
    """One form, as the list shows it (`item_to_form`: its revision, who saved it last, a version 1 form's
    ``migrated_from``), plus ``response_count``: its stored responses as `GET …/stats` counts them (the caller's
    category scope applied), and ``has_responses`` also when that count is not 0. The builder's read. In a workspace
    only one of its own (404 otherwise); any member. A count that cannot be read leaves it out (``stats_error``),
    never a 0 it did not measure. ``can_delete_test_responses``: whether this caller may delete the form's test
    responses (``_may_delete_test_responses``), so the builder offers Delete all to those people only."""
    scope = _request_scope()
    item = _read_form(form_id, 'Failed to fetch form', scope)
    form = item_to_form(item)
    try:
        count = int((_stats_for_forms([item], scope).get(form_id) or {}).get('total_submissions') or 0)
    except Exception as e:
        metrics.add_metric(name='FeedbackFormStatsReadFailed', unit='Count', value=1)
        logger.exception(f"Error counting the responses of form {form_id}: {e}")
        return {'success': True, 'form': {**form, 'can_delete_test_responses': _may_delete_test_responses(item)},
                'stats_error': 'Failed to count the form\'s responses'}
    return {'success': True,
            'form': {**form, 'response_count': count, 'has_responses': form['has_responses'] or count > 0,
                     'can_delete_test_responses': _may_delete_test_responses(item)}}


@app.post("/feedback-forms")
@tracer.capture_method
def create_form():
    """Create a new feedback form (in a workspace: its form, and the lookup row that routes its public id there)."""
    scope = _request_scope(write=True)
    body = json_object_body(app)
    _validate_form_labels(body, scope, app_feedback=_made_for_app_feedback(body))
    # Link fields and the definition are validated inside build_form_item, structurally.
    item = build_form_item(body, scope=scope, actor=get_caller_subject(app.current_event.raw_event))

    try:
        if scope is None:
            _forms_table().put_item(Item=item)
        else:
            _create_workspace_form(item, scope)
    except Exception as e:
        logger.exception(f"Error creating form: {e}")
        raise ServiceError('Failed to create form') from e
    logger.info(f"Created feedback form: {item['form_id']}")
    return {'success': True, 'form': item_to_form(item)}


def _create_workspace_form(item: dict, scope: WorkspaceScope) -> None:
    """A workspace's new form: its lookup row ``FORM#{id}`` first (a conditional put: an id already routed is never
    taken over), then the form itself (a conditional put through ``ws_table``). When the form cannot be written the
    lookup row is removed again; if that fails too it routes to a form that is not there, which every public route
    answers with the unknown id's 404."""
    form_id = item['form_id']
    routing = configured_table(get_workspaces_table(), 'Workspaces')
    claim_lookup(routing, form_id, scope, item['created_at'])
    try:
        _forms(scope).put_item(item, ConditionExpression='attribute_not_exists(pk)')
    except Exception:
        try:
            release_lookup(routing, form_id, scope)
        except (ClientError, BotoCoreError):
            logger.exception(f"Could not remove the lookup row of form {form_id}")
        raise


# ============================================
# Revisions (schema version 2)
# ============================================
#
# The form row holds its CURRENT revision (``revision``, from 1). A save that changes the definition first writes the
# definition it replaces as a snapshot row ``FORMREV#{form_id}#{revision:06d}`` in the same partition (idempotent: a
# revision's definition never changes once it was the form's), then moves the row to the next revision. Every save
# also counts one more on the row (``write_count``, from 7.58.00) and is conditional on the revision and the count it
# read (a concurrent save is a 409, never a lost write); a save that sends ``expected_write_count`` (the builder's) is
# a 409 once any save came in between, a name, a theme or Enable included, not only a definition. A response names the revision it
# answered (``form_revision``), so a respondent who opened the form before an edit is validated against what they
# saw. A version 1 form is revision 1: its first save writes that snapshot too, with its version 1 fields as stored
# (``v1``), so the migration loses nothing. Snapshots (``FORMREV#…``) and the funnel's rows (``FORMFUNNEL#…``,
# ``FORMSESSION#…``) sort apart from every ``FORM#{id}`` row, so the form list reads ``begins_with(sk, 'FORM#')``
# only. Test responses are not in this partition at all: they have their own beside it (``FEEDBACK_FORM_TEST``, a
# workspace's ``WS#{ws}#FEEDBACK_FORM_TEST``; shared/form_test_responses.py), the only one voc-retention may delete in.

_REVISION_PREFIX = 'FORMREV#'
_FORM_PREFIX = 'FORM#'
#: The v1 fields a version 2 form still maps from a version 1 patch (the assistant's update tool sends them).
_MAPPED_V1_FIELDS = frozenset({'title', 'description', 'success_message', 'submit_button_text'})
_CHANGED_MEANWHILE = 'The form was changed by someone else: reload it, then save again'
_ANSWERS_LOCKED = ('This form has responses: its question ids, types, ranges and option codes cannot change. Name each '
                   'question or option you remove in removes (its answers stay in Results), or keep it; to ask a '
                   'question another way, remove it and add a new one')


def _saved_by(stored: Mapping[str, Any]) -> dict[str, Any]:
    """A 409's details: the stored revision and save count, and who saved it when (the editor's conflict banner)."""
    return {'revision': fv2.revision_of(stored), 'write_count': _write_count(stored),
            'updated_by': str(stored.get('updated_by') or ''), 'updated_at': str(stored.get('updated_at') or '')}


def _revision_key(form_id: str, revision: int, scope: WorkspaceScope | None) -> dict[str, str]:
    return {'pk': _forms_partition(scope), 'sk': f'{_REVISION_PREFIX}{form_id}#{revision:06d}'}


def _put_revision(form_id: str, scope: WorkspaceScope | None, revision: int, definition: Mapping[str, Any],
                  v1: Mapping[str, Any] | None) -> None:
    """The snapshot of ``revision``'s definition (and, for a version 1 form, its v1 fields as stored)."""
    item: dict[str, Any] = {**_revision_key(form_id, revision, scope), 'form_id': form_id, 'revision': revision,
                            'schema_version': fv2.SCHEMA_VERSION, 'snapshot_at': now_iso(), **definition}
    if v1:
        item['v1'] = dict(v1)
    _forms(scope).put_item(item)


def _read_revision(form_id: str, scope: WorkspaceScope | None, revision: int) -> dict[str, Any] | None:
    """An earlier revision's definition, None when no snapshot is kept for it."""
    item = _forms(scope).get_item(_revision_key(form_id, revision, scope)).get('Item')
    return {name: fv2.plain(item.get(name)) for name in fv2.DEFINITION_FIELDS} if item else None


def _canonical(definition: Mapping[str, Any]) -> str:
    return json.dumps(fv2.plain(dict(definition)), sort_keys=True, ensure_ascii=False, default=str)


def _put_text(container: dict[str, Any], key: str, value: object, field_name: str, primary: str) -> None:
    """Set ``container[key]``'s text in the primary language to a version 1 patch's ``value`` ('' removes it)."""
    if not isinstance(value, str):
        raise ValidationError(f'{field_name} must be a string')
    texts = {**(container.get(key) or {}), primary: value.strip()}
    container[key] = {locale: text for locale, text in texts.items() if text}


def _v1_patch_on_v2(current: Mapping[str, Any], body: Mapping[str, Any]) -> dict[str, Any]:
    """A version 1 patch applied to a version 2 form: the welcome title / description, the first ending's title and
    the last question's button, in the primary language. A v1 field with no single place in version 2 is a 400."""
    unmapped = sorted(f for f in fv2.V1_FIELDS if f in body and f not in _MAPPED_V1_FIELDS)
    if unmapped:
        raise ValidationError(f'{unmapped[0]} is a version 1 field and this form uses questions: edit questions')
    out = copy.deepcopy(dict(current))
    primary = out.get('language') or fv2.DEFAULT_LOCALE
    welcome = out.setdefault('welcome', {'enabled': False})
    for name in ('title', 'description'):
        if name in body:
            _put_text(welcome, name, body[name], name, primary)
    if 'title' in body:
        welcome['enabled'] = bool(welcome.get('title'))
    if 'success_message' in body and out.get('endings'):
        _put_text(out['endings'][0], 'title', body['success_message'], 'success_message', primary)
    if 'submit_button_text' in body and out.get('questions'):
        _put_text(out['questions'][-1], 'button_label', body['submit_button_text'], 'submit_button_text', primary)
    return out


def _definition_update(stored: Mapping[str, Any], current: Mapping[str, Any],
                       body: Mapping[str, Any]) -> dict[str, Any] | None:
    """The definition a PUT asks for (None: it leaves the definition alone).

    Version 2 fields replace their part of the definition. A version 1 patch (the fields of the pre-7.55 API, which
    the assistant's update tool still sends) is applied to a version 1 form's own fields before the migration, and to
    a version 2 form where it maps (``_v1_patch_on_v2``). ``language`` alone is a version 1 patch on a version 1
    form (7.54.00's field) and a version 2 change otherwise."""
    as_v2 = fv2.is_v2(stored) or _is_v2_body(body)
    v2_fields = [f for f in fv2.DEFINITION_FIELDS if f in body and (f != 'language' or as_v2)]
    if v2_fields:
        return {**current, **{f: body[f] for f in v2_fields}}
    v1_fields = [f for f in (*fv2.V1_FIELDS, 'language') if f in body]
    if not v1_fields:
        return None
    if not fv2.is_v2(stored):
        return fv2.migrate_v1({**stored, **{f: body[f] for f in v1_fields}}, DEFAULT_FORM_LANGUAGE)
    return _v1_patch_on_v2(current, body)


@dataclass(frozen=True)
class _Update:
    """What one PUT writes: the attributes to set (``nested_test``: in place, under ``settings.test``) and remove,
    and the snapshot to keep first (or None)."""

    sets: dict[str, Any]
    removes: list[str]
    snapshot: tuple[int, dict[str, Any], dict[str, Any] | None] | None
    nested_test: dict[str, Any] = dataclass_field(default_factory=dict)
    #: What the save answers besides the form (``warnings``): ``theme_unreadable`` for a live form kept unreadable.
    warnings: list[str] = dataclass_field(default_factory=list)


def _settings_update(stored: Mapping[str, Any], body: Mapping[str, Any]) -> tuple[dict | None, dict[str, Any]]:
    """``(settings to set whole, test fields to set in place)``: a form whose test token was issued keeps it (only
    its ``link_enabled`` and ``record`` are written, in place), so a save racing a rotation cannot restore an old
    token. A form without ``settings`` gets its defaults."""
    current = fv2.test_settings_of(stored)
    if 'settings' not in body:
        return ({'test': current} if not isinstance(stored.get('settings'), Mapping) else None), {}
    test = fv2.validate_test_settings(body['settings'], current)
    if 'token' in current:
        return None, {'link_enabled': test['link_enabled'], 'record': test['record']}
    return {'test': test}, {}


def _require_update_fields(body: Mapping[str, Any]) -> None:
    """400 for a PUT that names nothing updatable (before the form is read), or a malformed ``expected_write_count``.
    (An old client's ``expected_revision`` is ignored, whatever it holds: 7.58.01.)"""
    if not any(f in body for f in (*UPDATABLE_FIELDS, *fv2.DEFINITION_FIELDS, *fv2.V1_FIELDS, 'settings')):
        raise ValidationError('No fields to update')
    count = body.get('expected_write_count')
    if count is not None and (isinstance(count, bool) or not isinstance(count, int)):
        raise ValidationError('expected_write_count must be a whole number')


def _plan_update(stored: Mapping[str, Any], body: Mapping[str, Any], actor: str,
                 answered: Callable[[], bool] = lambda: False) -> _Update:
    """The write of a PUT on ``stored``: the definition validated when the PUT changes it (a new revision when it
    does), a version 1 form written back as version 2 (its v1 fields removed), the plain fields as sent, and the row's
    save count one up.

    ``expected_write_count`` in the body (the ``write_count`` the editor loaded) is the precondition: another one is a
    409. The save count moves with every save, so a stale editor cannot write back what a later save changed (a form
    turned Off turned on again); the revision moves only with the definition, which only a save changes, so the count
    implies it (7.58.01: an old client's ``expected_revision`` is ignored, never a 400). Both are read-only (the form
    API returns them) and ignored as fields. On a form with a real response
    (``has_responses``, else ``answered()``) a definition change that drops a question id or an option code without
    naming it in ``removes``, or gives a question it keeps another type or range, is a 409 ``answers_locked``
    (shared/forms_v2.py ``unnamed_removals``, ``reshaped_questions``). ``answered`` is asked only of such a change on a
    form whose flag is not True (``_answered_before``: one created before 7.58.01 with no flag, which a submit may
    never have marked, or one whose first response's mark failed), never of a save the lock has nothing to refuse. A
    write that leaves the form live while a text shows a placeholder as written is a 409 ``unresolved_placeholder``."""
    _require_update_fields(body)
    revision = fv2.revision_of(stored)
    expected_writes, writes = body.get('expected_write_count'), _write_count(stored)
    if is_whole(expected_writes) and expected_writes != writes:
        raise ConflictError(_CHANGED_MEANWHILE, code='revision_conflict', details=_saved_by(stored))
    current = _definition(stored)
    proposed = _definition_update(stored, current, body)
    retired = [qid for qid in fv2.plain(stored.get('retired_ids') or []) if isinstance(qid, str)]
    # A version 1 form written back by a PUT that leaves its definition alone (the list card's Enable) is stored as
    # version 2 too: its migration is validated like any save, never persisted unchecked.
    to_check = proposed if proposed is not None else (None if fv2.is_v2(stored) else current)
    definition = fv2.validate_definition(to_check, retired=retired) if to_check is not None else current
    changed = proposed is not None and _canonical(definition) != _canonical(current)
    # Publish, and a colour change on a live form, need readable text; any other save of a live form whose stored
    # theme is already unreadable goes through with a warning; turning a form Off always works.
    live = body['enabled'] if 'enabled' in body else stored.get('enabled', False)
    theme = body['theme'] if 'theme' in body else stored.get('theme')
    warnings = fv2.validate_publishable(theme, live=bool(live), was_live=stored.get('enabled') is True,
                                        theme_changed='theme' in body and not fv2.same_theme(theme, stored.get('theme')))
    removes = fv2.validate_removes(body.get('removes'))
    if changed:
        # The lock of an answered form (shared/forms_v2.py): a dropped question id or option code is named, or refused;
        # a question kept with another type or range is refused (its answers would be read on the new scale). Whether
        # the form is answered is asked only when there is something to refuse.
        unnamed = fv2.unnamed_removals(current, definition, removes)
        reshaped = fv2.reshaped_questions(current, definition)
        if (unnamed or reshaped) and (stored.get('has_responses') is True or answered()):
            raise ConflictError(_ANSWERS_LOCKED, code='answers_locked',
                                details={**unnamed, **({'changed': reshaped} if reshaped else {})})
    # A form put (or kept) live shows no placeholder as written (7.61.00): a form saved earlier with one keeps serving,
    # and turning it Off always works, but it is not published again until it is fixed.
    fv2.validate_placeholders(definition, live=bool(live))
    sets: dict[str, Any] = {name: body[name] for name in UPDATABLE_FIELDS if name in body}
    sets.update({**definition, 'schema_version': fv2.SCHEMA_VERSION, 'revision': revision + int(changed),
                 'write_count': writes + 1, 'updated_at': now_iso(), 'updated_by': actor})
    if changed:
        sets['retired_ids'] = fv2.retired_ids(current, definition, retired)
    whole, nested = _settings_update(stored, body)
    if whole is not None:
        sets['settings'] = whole
    v1 = None if fv2.is_v2(stored) else fv2.v1_source(stored)
    snapshot = (revision, current, v1) if changed or v1 is not None else None
    return _Update(sets, [name for name in fv2.V1_FIELDS if name in stored], snapshot, nested, warnings)


def _update_request(stored: Mapping[str, Any], plan: _Update) -> dict[str, Any]:
    """The UpdateItem arguments of ``plan``: conditional on the revision and the save count ``stored`` had (none for a
    version 1 form, and none for a row saved before 7.58.00), so any save in between is a 409."""
    names: dict[str, str] = {'#revision': 'revision', '#writes': 'write_count'}
    values: dict[str, Any] = {}
    parts = []
    for index, (name, value) in enumerate(plan.sets.items()):
        names[f'#f{index}'] = name
        values[f':f{index}'] = value
        parts.append(f'#f{index} = :f{index}')
    for key, value in plan.nested_test.items():
        names.update({'#settings': 'settings', '#test': 'test', f'#t_{key}': key})
        values[f':t_{key}'] = value
        parts.append(f'#settings.#test.#t_{key} = :t_{key}')
    expression = 'SET ' + ', '.join(parts)
    if plan.removes:
        names.update({f'#r{index}': name for index, name in enumerate(plan.removes)})
        expression += ' REMOVE ' + ', '.join(f'#r{index}' for index in range(len(plan.removes)))
    if 'revision' in stored:
        values[':expected'] = stored['revision']
        condition = 'attribute_exists(sk) AND #revision = :expected'
    else:
        condition = 'attribute_exists(sk) AND attribute_not_exists(#revision)'
    if 'write_count' in stored:
        values[':writes'] = stored['write_count']
        condition += ' AND #writes = :writes'
    else:
        condition += ' AND attribute_not_exists(#writes)'
    return {'UpdateExpression': expression, 'ExpressionAttributeNames': names, 'ExpressionAttributeValues': values,
            'ConditionExpression': condition, 'ReturnValues': 'ALL_NEW'}


@app.put("/feedback-forms/<form_id>")
@tracer.capture_method
def update_form(form_id: str):
    """Update a feedback form (in a workspace: only one of its own, 404 otherwise).

    Reads the form, applies the body (``_plan_update``), keeps the replaced revision's snapshot, then writes,
    conditional on the revision read: a form changed in between is a 409, a form deleted in between the 404. A
    version 1 form is written back as version 2 (its v1 fields removed). Never an upsert: a stub row would be a form
    nobody created, and in a workspace one without a lookup row, which no public route could reach.
    """
    scope = _request_scope(write=True)
    body = json_object_body(app)
    validate_link_fields(body)
    validate_theme(body)
    # (the reserved tag is judged on the stored form's template, below)
    _validate_form_labels(body, scope, app_feedback=True)
    _require_update_fields(body)
    if scope is None:
        _refuse_a_workspaces_id(form_id, 'Failed to update form')
    stored = _read_form(form_id, 'Failed to update form', scope)
    if names_app_feedback(body.get('tags')) and not _made_for_app_feedback(stored):
        raise ValidationError(RESERVED_MESSAGE)
    plan = _plan_update(stored, body, get_caller_subject(app.current_event.raw_event),
                        answered=lambda: _answered_before(form_id, stored, scope))
    try:
        if plan.snapshot is not None:
            _put_revision(form_id, scope, *plan.snapshot)
        response = _forms(scope).update_item(_form_key(form_id, scope), **_update_request(stored, plan))
    except Exception as e:
        if _is_conditional_check_failure(e):
            current = _read_form(form_id, 'Failed to update form', scope)  # the 404 when it was deleted meanwhile
            raise ConflictError(_CHANGED_MEANWHILE, code='revision_conflict', details=_saved_by(current)) from e
        logger.exception(f"Error updating form: {e}")
        raise ServiceError('Failed to update form') from e
    saved: dict[str, Any] = {'success': True, 'form': item_to_form(response.get('Attributes', {}))}
    if plan.warnings:
        saved['warnings'] = plan.warnings
    return saved


def _really_opened(form_id: str, scope: WorkspaceScope | None) -> bool:
    """Whether a real visitor ever opened the form: a real day's ``opened`` counter among its own funnel rows (one row
    per day, so a cheap read of the form's own rows, never of the brand's feedback). A failed read refuses the save
    (the lock never guesses)."""
    try:
        rows = _funnel_rows(form_id, scope, {})
    except Exception as e:
        logger.exception(f"Error reading the funnel of form {form_id}: {type(e).__name__}")
        raise ServiceError('Failed to update form') from e
    return any(not row.get('is_test') and isinstance(row.get('opened'), int) and row['opened'] > 0 for row in rows)


def _answered_before(form_id: str, stored: Mapping[str, Any], scope: WorkspaceScope | None) -> bool:
    """Whether a form whose ``has_responses`` is not True has a real response stored anyway, asked only by a save the
    lock would refuse on an answered form (``_plan_update``): one with no flag (created before 7.58.01) answered only
    before 7.55.00, whose submits never marked it; or one created since whose first response's mark failed
    (``_mark_answered``'s metric). Marked once found, so the next save reads the flag. A form that says
    ``has_responses: false`` is read only when a real visitor ever opened it (``_really_opened``, cheap): a form being
    built is never read for its responses."""
    if stored.get('has_responses') is False and not _really_opened(form_id, scope):
        return False
    found = _real_response_stored(form_id, stored, scope)
    if found:
        _mark_answered(form_id, stored, scope)
    return found


def _real_response_stored(form_id: str, stored: Mapping[str, Any], scope: WorkspaceScope | None) -> bool:
    """Whether the form's brand partition holds a real response of it: read as ``GET /feedback-forms/{id}`` counts
    them, but every real response, whoever saves (the lock never depends on what the saver may read). A test response
    is never a feedback item."""
    if not feedback_table:
        raise ConfigurationError('Feedback table not configured')
    query_kwargs: dict[str, Any] = {'FilterExpression': 'source_channel = :sc',
                                    'ExpressionAttributeValues': {':sc': f'form_{form_id}'},
                                    'ProjectionExpression': 'feedback_id, is_test'}
    try:
        return any(not row.get('is_test') for row in
                   _partition_rows(feedback_table, scope, _form_source_pk(dict(stored), scope), query_kwargs))
    except Exception as e:
        logger.exception(f"Error reading the responses of form {form_id}: {type(e).__name__}")
        raise ServiceError('Failed to update form') from e


FORM_DELETED = 'form_deleted'
#: The kind of a deployment form's ``AUDIT#delete`` row (shared/delete_audit.py).
FORM_DELETE_KIND = 'feedback_form'
#: The kind of a test responses' delete's row (``DELETE …/responses?test=true``), in either audit partition.
TEST_RESPONSES_DELETE_KIND = 'feedback_form_test_responses'
#: A form delete's row says how many test responses go with the form (TENETS.md D5), under this name.
TEST_RESPONSES_DELETED = 'test_responses_deleted'


def _record_form_delete(scope: WorkspaceScope, form_id: str, *, kind: str = FORM_DELETED,
                        count: int | None = None, test_responses: int | None = None) -> None:
    """The ``AUDIT#WS#{ws}`` row of a workspace form's delete (with ``test_responses``: how many of its test
    responses go with it), or of its test responses' (with ``count``), written before it (a new row, never an
    overwrite; raises when it cannot be written)."""
    at = now_iso()
    put_new_audit_row(configured_table(get_workspaces_table(), 'Workspaces'), {
        'pk': audit_key(scope.ws), 'sk': audit_sort_key(at), 'kind': kind,
        'actor': get_caller_subject(app.current_event.raw_event), 'form_id': form_id, 'at': at,
        **({'count': count} if count is not None else {}),
        **({TEST_RESPONSES_DELETED: test_responses} if test_responses is not None else {})})


def _row_keys(scope: WorkspaceScope | None, prefix: str, *, pk: str | None = None,
              test_only: bool = False) -> list[dict[str, str]]:
    """The keys of partition ``pk``'s rows (the scope's forms partition by default) whose ``sk`` starts with
    ``prefix`` (only ``is_test`` ones when ``test_only``)."""
    rows = iter_partition(scope, _forms_table(), 'pk', pk or _forms_partition(scope), sort_prefix=prefix,
                          ProjectionExpression='pk, sk, is_test')
    return [{'pk': row['pk'], 'sk': row['sk']} for row in rows if row.get('is_test') or not test_only]


def _test_response_keys(form_id: str, scope: WorkspaceScope | None) -> list[dict[str, str]]:
    """The keys of the form's test responses (``{form_id}#…`` in the scope's ``FEEDBACK_FORM_TEST`` partition)."""
    return _row_keys(scope, form_sk_prefix(form_id), pk=test_responses_partition(scope))


def _delete_keys(scope: WorkspaceScope | None, keys: list[dict[str, str]]) -> int:
    for key in keys:
        _forms(scope).delete_item(key)
    return len(keys)


def _delete_rows(scope: WorkspaceScope | None, prefix: str) -> int:
    """Delete the rows of the forms partition whose ``sk`` starts with ``prefix``; how many were deleted."""
    return _delete_keys(scope, _row_keys(scope, prefix))


def _delete_form_rows(form_id: str, scope: WorkspaceScope | None, tests: list[dict[str, str]]) -> None:
    """Delete the rows that belong to the form: its revision snapshots (``FORMREV#{id}#…``), funnel counters
    (``FORMFUNNEL#{id}#…``) and stored AI report summaries (``FORMREPORT#{id}#…``, 7.63.00) in its forms partition, and
    its test responses (``tests``: their keys in the scope's ``FEEDBACK_FORM_TEST``, as the delete's record counted
    them). The funnel's visit rows (``FORMSESSION#{id}#…``) are left to their 7-day ``ttl``: plumbing, never data, and
    a busy form's week of them is not worth a delete that could outrun the request."""
    for prefix in (_REVISION_PREFIX, _FUNNEL_PREFIX, REPORT_PREFIX):
        _delete_rows(scope, f'{prefix}{form_id}#')
    _delete_keys(scope, tests)


@app.delete("/feedback-forms/<form_id>")
@tracer.capture_method
def delete_form(form_id: str):
    """Delete a feedback form (in a workspace: its form, then its lookup row, only when the row names it).

    Every delete of a form is recorded first (TENETS.md D5; the owner's decision of 2026-11-18), under the audit-row
    guard, so no role can change or remove the row, and a row that cannot be written deletes nothing:

    * a workspace's form in its audit partition ``AUDIT#WS#{ws}`` of voc-workspaces (kind ``form_deleted``, the actor's
      sub, the form id, the time). Only a form the workspace holds: an unknown id, or another workspace's, is the 404,
      with no audit row;
    * a deployment form as the deployment's other deletes are (shared/delete_audit.py ``record_delete_once``):
      ``AUDIT#delete`` / ``feedback_form#{id}`` in voc-aggregates (kind ``feedback_form``, the form id, the actor
      ``{sub, kind}``, the time), one row per form however often a failed delete is retried (the first attempt's
      count stays). The deployment's delete stays idempotent: an unknown id answers success and records nothing.

    Both rows say how many test responses go with the form (``test_responses_deleted``, TENETS.md D5; never their
    content): their keys are read first, counted on the row, and then those same keys are deleted.
    """
    scope = _request_scope(write=True)
    if scope is None:
        _refuse_a_workspaces_id(form_id, 'Failed to delete form')
    else:
        _read_form(form_id, 'Failed to delete form', scope)  # 404 for a form this workspace does not hold
    try:
        tests = _test_response_keys(form_id, scope)
        if scope is not None:
            _record_form_delete(scope, form_id, test_responses=len(tests))
        elif _forms(None).get_item(_form_key(form_id, None)).get('Item'):
            record_delete_once(_forms_table(), kind=FORM_DELETE_KIND, record_id=form_id, target={'form_id': form_id},
                               actor=actor_from_event(app.current_event.raw_event),
                               counts={TEST_RESPONSES_DELETED: len(tests)})
        # Its revision snapshots and test responses first: a failure here leaves the form, and a retry finishes.
        _delete_form_rows(form_id, scope, tests)
        _forms(scope).delete_item(_form_key(form_id, scope))
        if scope is not None:
            release_lookup(configured_table(get_workspaces_table(), 'Workspaces'), form_id, scope)
    except Exception as e:
        logger.exception(f"Error deleting form: {e}")
        raise ServiceError('Failed to delete form') from e
    logger.info(f"Deleted feedback form: {form_id}")
    return {'success': True}


# ============================================
# Form Widget Endpoints (Public)
# ============================================

def _ending_message(form: Mapping[str, Any], ending_id: str | None = None, language: str | None = None) -> str:
    """The title of the ending a respondent reached (the first ending by default) in their language, the primary's
    when it has none; the form's version 1 ``success_message`` for a pin form stored before 7.55."""
    if not fv2.is_v2(form):
        message = form.get('success_message')
        return message if isinstance(message, str) and message else 'Thank you for your feedback!'
    definition = _definition(form)
    endings = definition.get('endings') or []
    ending = next((e for e in endings if e.get('id') == ending_id), endings[0] if endings else {})
    primary = str(definition.get('language') or fv2.DEFAULT_LOCALE)
    return fv2.text_in(ending.get('title'), language or primary, primary) or 'Thank you for your feedback!'


def _submit_prototype_pin(form: dict, body: dict) -> dict:
    """A pin on a prototype (form_type ``prototype_pin``), through the public submit route.

    Stored in this table as a ``PINS#{form_id}`` row — never enqueued for
    enrichment: a prototype tester is not customer voice, and a pin must not buy
    a Bedrock call. Validation, caps, redaction and injection screening are
    shared/prototype_pins.py's. Logs ids only, never content.
    """
    pin = prototype_pins.validate_submission(body)
    item = prototype_pins.pin_item(form, pin)
    try:
        prototype_pins.put_pin(_forms_table(), item)
    except Exception as e:
        logger.exception(f"Error storing pin for form {form.get('form_id')}: {type(e).__name__}")
        raise ServiceError('Failed to save the pin. Please try again.') from e
    metrics.add_metric(name='PrototypePinSubmitted', unit='Count', value=1)
    logger.info('Stored prototype pin', extra={'form_id': form.get('form_id'), 'pin_id': item['pin_id'],
                                                 'flagged': item['flagged']})
    message = form.get('success_message') if isinstance(form.get('success_message'), str) else ''
    return {'success': True, 'pin_id': item['pin_id'],
            'message': message or (_ending_message(form) if fv2.is_v2(form) else 'Thanks — your pin was saved.')}


def _test_link_state(form: Mapping[str, Any], token: object) -> dict[str, Any]:
    """``{valid, record}`` of a test link's token for this form (``record`` only when it is valid): the widget shows
    its TEST strip ("Responses aren't counted" / "Nothing is saved"), or "This test link no longer works", before the
    respondent answers. Never the token itself."""
    try:
        record = _test_mode(form, {'test': token})
    except AuthorizationError:
        return {'valid': False}
    return {'valid': True, 'record': record} if record else {'valid': False}


@app.get("/feedback-forms/<form_id>/config")
@tracer.capture_method
def get_form_config_by_id(form_id: str):
    """Get form config for widget (public endpoint; a workspace's form by its lookup row, never the request).

    ``?test=<token>`` (the test link's) adds ``test: {valid, record}`` beside the config. A read, never a write: the
    funnel's open is the widget's own ``opened`` beacon on the submit route (``_record_event``), so a cached or
    retried GET counts nothing (from 7.55.00's AI review; any other query parameter, ``open`` included, is ignored).
    """
    _form_id, item, _routed = _public_form(form_id, 'Failed to get form configuration')
    params = app.current_event.query_string_parameters or {}
    token = params.get(TEST_LINK_PARAMETER)
    # Narrower projection than item_to_form on purpose: this route is public.
    out: dict[str, Any] = {'success': True, 'config': item_to_widget_config(item)}
    test = _test_link_state(item, token) if isinstance(token, str) and token else None
    if test is not None:
        out['test'] = test
    return out


@dataclass(frozen=True)
class _Submission:
    """A submission checked against its form: the item's text, rating, category (the first answered option that maps
    one; None for the form's own routing) and form metadata; the content a raw copy or a test response keeps; the
    message of the ending reached; for a version 2 response its contact answers' ids (their names are not kept under
    a redacting policy)."""

    text: str
    rating: Any
    metadata: dict[str, Any]
    category: dict[str, str] | None
    content: dict[str, Any]
    message: str
    ending_id: str | None = None
    contact_ids: tuple[str, ...] = ()


def _definition_for(form_id: str, form: Mapping[str, Any], scope: WorkspaceScope | None,
                    revision: object) -> tuple[dict[str, Any], int]:
    """The definition of the revision a response answered (the current one when it names none). A revision the form
    has not reached, or one no snapshot is kept for, is a 409: the respondent should reload the form."""
    current = fv2.revision_of(form)
    if revision is None or revision == current:
        return _definition(form), current
    stale = ConflictError('This form has changed since it was opened: reload it and answer again',
                          code='form_changed')
    if not isinstance(revision, int) or revision > current:
        raise stale
    try:
        definition = _read_revision(form_id, scope, revision)
    except (ClientError, BotoCoreError) as e:
        logger.exception(f"Error reading revision {revision} of form {form_id}: {type(e).__name__}")
        raise ServiceError('Failed to load form configuration') from e
    if definition is None:
        raise stale
    return definition, revision


def _v2_submission(form_id: str, form: Mapping[str, Any], scope: WorkspaceScope | None,
                   body: Mapping[str, Any]) -> _Submission:
    """A version 2 response (``answers``) checked against the revision it answered, as the item it becomes."""
    definition, revision = _definition_for(form_id, form, scope, body.get('form_revision'))
    response = fresp.validate_response(definition, body)
    metadata: dict[str, Any] = {
        'form_version': '3.0', 'form_revision': revision, 'form_language': response.language,
        'form_ending_id': response.ending_id, 'form_path': response.path, 'form_answers': response.answers,
    }
    if response.hidden:
        metadata['form_hidden'] = response.hidden
    if isinstance(body.get('session'), str):
        metadata['form_session'] = body['session']
    if body.get('channel') in fresp.CHANNELS:
        # Where it was answered (the list card's channels): kept with the response, read back by the list stats.
        metadata['form_channel'] = body['channel']
    contact = fresp.contact_of(definition, response)
    # The keys an erasure by email matches, and the name the version 1 route kept (a redacting policy drops it).
    for key, field_name in (('submitter_email', 'email'), ('submitter_name', 'name')):
        if contact.get(field_name):
            metadata[key] = contact[field_name]
    content = {'form_revision': revision, 'language': response.language, 'answers': response.answers,
               'hidden': response.hidden, 'ending_id': response.ending_id, 'path': response.path,
               **({'session': body['session']} if isinstance(body.get('session'), str) else {}),
               **({'channel': body['channel']} if body.get('channel') in fresp.CHANNELS else {})}
    contact_ids = tuple(q['id'] for q in definition.get('questions') or [] if q.get('type') == fv2.CONTACT)
    return _Submission(fresp.response_text(definition, response), fresp.item_rating(definition, response), metadata,
                       fresp.answer_category(definition, response), content,
                       _ending_message({**form, **definition, 'schema_version': 2}, response.ending_id,
                                       response.language), response.ending_id, contact_ids)


def _collects(form: Mapping[str, Any], name: str) -> bool:
    """Whether the form asks for the submitter's ``name`` / ``email``: a version 1 form's ``collect_*`` flag, a
    version 2 form's contact_info question showing that field."""
    if not fv2.is_v2(form):
        return form.get(f'collect_{name}') is True
    return any(((q.get('fields') or {}).get(name) or {}).get('show') for q in _definition(form)['questions']
               if q.get('type') == fv2.CONTACT)


def _v1_submission(form: Mapping[str, Any], body: Mapping[str, Any], text: str) -> _Submission:
    """A version 1 widget's body (``text``, ``rating``, ``name``, ``email``): kept as before."""
    metadata: dict[str, Any] = {}
    if _collects(form, 'email') and body.get('email'):
        # Lower-cased by apply_source_policy below, so an erasure by email matches.
        metadata['submitter_email'] = body['email']
    if _collects(form, 'name') and body.get('name'):
        metadata['submitter_name'] = body['name']
    content = {'text': text, 'rating': body.get('rating')}
    return _Submission(text, body.get('rating'), metadata, None, content, _ending_message(form))


def _same_secret(given: object, expected: object) -> bool:
    """``given == expected`` in constant time, on their UTF-8 bytes: ``hmac.compare_digest`` refuses a ``str`` that is
    not ASCII with a TypeError, and a public caller chooses ``given`` (``?test=é`` must be a refusal, never a 500)."""
    return hmac.compare_digest(str(given).encode('utf-8', 'surrogatepass'), str(expected).encode('utf-8', 'surrogatepass'))


def _test_mode(form: Mapping[str, Any], body: Mapping[str, Any]) -> str | None:
    """``tag`` or ``drop`` for a submission through the form's test link (``test`` = its token), None for any other.
    A token that is not the form's, or a test link that is off, is a 403."""
    token = body.get('test')
    if token is None or token == '':
        return None
    test = fv2.test_settings_of(form)
    issued = test.get('token')
    if not test['link_enabled'] or not issued or not _same_secret(token, issued):
        raise AuthorizationError('This test link is not valid', code='test_link_invalid')
    return str(test['record'])


def _test_response_item(form_id: str, scope: WorkspaceScope | None, submission: _Submission,
                        page_url: object) -> dict[str, Any]:
    now = now_iso()
    response_id = uuid.uuid4().hex
    item: dict[str, Any] = {
        **test_response_key(form_id, now, response_id, scope),
        'form_id': form_id, 'response_id': response_id, 'is_test': True, 'created_at': now,
        'text': submission.text, **submission.content,
    }
    if submission.rating is not None:
        item['rating'] = Decimal(str(submission.rating))
    if isinstance(page_url, str) and page_url:
        item['page_url'] = page_url
    # The keys a person's erasure matches (voc-retention's form_tests phase, docs/source-policies.md): the email
    # lower-cased as ingestion stores a real item's, the name as typed.
    email, name = submission.metadata.get('submitter_email'), submission.metadata.get('submitter_name')
    if isinstance(email, str) and email.strip():
        item['submitter_email'] = email.strip().lower()
    if isinstance(name, str) and name.strip():
        item['submitter_name'] = name
    return {key: value for key, value in item.items() if value is not None}


def _record_test_response(form_id: str, scope: WorkspaceScope | None, submission: _Submission, mode: str,
                          body: Mapping[str, Any]) -> dict[str, Any]:
    """A response through the test link: validated like any other, then ``tag`` keeps it apart from the form (the
    scope's ``FEEDBACK_FORM_TEST`` / ``{form_id}#…``, ``is_test: true``) and ``drop`` keeps nothing. Never queued,
    archived, attributed to a participant ask or counted: no processing, no metric, no NPS, no dashboard ever sees
    it. A kept one closes its funnel visit (``_close_session``), as a real response does."""
    out: dict[str, Any] = {'success': True, 'test': mode, 'message': submission.message}
    if submission.ending_id:
        out['ending_id'] = submission.ending_id
    if mode == 'drop':
        metrics.add_metric(name='FeedbackFormTestResponseDropped', unit='Count', value=1)
        return out
    item = _test_response_item(form_id, scope, submission, body.get('page_url'))
    try:
        _forms(scope).put_item(item)
    except Exception as e:
        logger.exception(f"Error storing a test response for form {form_id}: {type(e).__name__}")
        raise ServiceError('Failed to submit feedback. Please try again.') from e
    metrics.add_metric(name='FeedbackFormTestResponseTagged', unit='Count', value=1)
    _close_session(form_id, scope, body.get('session'), mode)
    return {**out, 'response_id': item['response_id']}


def _validated_envelope(body: dict, v2: bool) -> str:
    """The submission's own bounds, before the form is read: a version 1 body's text (``_validated_submission``), or
    a version 2 body's shape (shared/forms_v2_responses.py ``check_envelope``) and its page URL and custom fields."""
    _validate_optional_string(body, 'test', MAX_TEST_TOKEN_CHARS)
    if not v2:
        return _validated_submission(body)
    fresp.check_envelope(body)
    _validate_optional_string(body, 'page_url', MAX_PAGE_URL_CHARS)
    _validate_custom_fields(body)
    return ''


def _public_body(code: str | None = None) -> dict[str, Any]:
    """A public POST's JSON object body. Only unparseable JSON (once a 500) changes, to a 400: the ``or {}`` and the
    message are the submit route's long-standing contract with embedded widgets and are kept exactly as they were."""
    body = json_body_value(app) or {}
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object', code=code)
    return body


def _open_form(form: Mapping[str, Any], body: Mapping[str, Any]) -> str | None:
    """The test mode of a public POST on ``form`` (its lookup already done): a disabled form takes nothing (``400
    form_off``) unless the body carries its valid test token (a wrong one is ``403 test_link_invalid``)."""
    test_mode = _test_mode(form, body)
    if not form.get('enabled', False) and test_mode is None:
        raise ValidationError('This form is not enabled', code='form_off')
    return test_mode


@app.post("/feedback-forms/<form_id>/submit")
@tracer.capture_method
def submit_form_feedback(form_id: str):
    """Submit feedback to a specific form.

    Two bodies: a version 2 response (``answers``, docs/feedback-forms.md "Responses"), checked answer by answer
    against the revision it names, and the version 1 widget's ``text`` (kept as it was). With the form's test token
    (``test``) the submission is a test response (``_record_test_response``), also on a disabled form. The widget's
    beacons are not taken here (``POST …/events``, ``record_form_event``): this route's limit is for responses only.

    A workspace's form (its lookup row's workspace, never the request's) queues the submission with that
    ``workspace_id`` (``workspace_payload``, after every other field) and keeps its raw copy under
    ``ws/{ws}/raw/feedback_form/``. Participant asks and prototype pins are the deployment's (phase 3): only a
    deployment form attributes an answer to an ask or takes the pin path.
    """
    form_id = _public_form_id(form_id)
    body = _public_body()

    # Bounded before the form read: junk costs no DynamoDB call, and nothing
    # oversized reaches the queue (and the Bedrock call behind it). #222.
    if 'event' in body:
        raise ValidationError('A beacon goes to POST /feedback-forms/{id}/events, not to submit',
                              code='submission_invalid')
    v2 = fresp.is_v2_response(body)
    text = _validated_envelope(body, v2)
    widget_dimensions = _widget_dimensions(body)
    form_id, form, routed = _public_form(form_id, 'Failed to load form configuration')
    scope = routed.scope if routed is not None else None
    test_mode = _open_form(form, body)
    # Defence in depth: no workspace form carries this form_type (only the document generator sets it, on
    # deployment forms), so `scope is None` changes nothing today; it keeps a pin out of a workspace if one ever does.
    if scope is None and form.get('form_type') == prototype_pins.FORM_TYPE_PROTOTYPE_PIN:
        # A standalone prototype is sandboxed to an opaque origin, so its widget
        # posts with `Origin: null`; only a pin form's answer echoes that
        # (shared/null_origin_cors.py). Every other form keeps the resolver's CORS.
        null_origin_cors.accept()
        return _submit_prototype_pin(form, body)
    submission = _v2_submission(form_id, form, scope, body) if v2 else _v1_submission(form, body, text)
    if test_mode is not None:
        return _record_test_response(form_id, scope, submission, test_mode, body)
    return _ingest(form_id, form, routed, body, submission, widget_dimensions)


def _without_contact_names(metadata: dict[str, Any], contact_ids: tuple[str, ...]) -> dict[str, Any]:
    """``metadata`` with the contact answers' names left out, as a redacting policy drops ``submitter_name``."""
    answers = metadata.get('form_answers')
    if not isinstance(answers, dict) or not contact_ids:
        return metadata
    kept = {qid: ({k: v for k, v in value.items() if k != 'name'} if qid in contact_ids and isinstance(value, dict)
                  else value) for qid, value in answers.items()}
    return {**metadata, 'form_answers': {qid: value for qid, value in kept.items() if value != {}}}


def _ingest(form_id: str, form: dict, routed: RoutedWorkspace | None, body: dict, submission: _Submission,
            widget_dimensions: dict[str, str]) -> dict[str, Any]:
    """Queue a submission for the processor, as a feedback item of the form's source channel."""
    scope = routed.scope if routed is not None else None
    # The FORM's brand, not the deployment's: the stats read builds its partition
    # from the form's stored brand_name (_form_source_pk), so stamping BRAND_NAME
    # here splits a form's submissions across two partitions the day the
    # deployment is renamed. `or` rather than a get() default because a stored ''
    # must take the fallback too — that is how the read side treats it. The
    # consequence, chosen rather than incidental, is that a pre-rename form keeps
    # writing under its OLD brand; _anchor_form_brand's docstring is the canonical
    # explanation of why that beats the alternative.
    #
    # _form_source_pk, in this module, is the one brand-scoped read of the
    # feedback partition; every other reader scopes by source_platform. That is a
    # claim about other modules, so it is asserted by a test rather than trusted
    # here — see test_no_other_module_derives_a_feedback_partition_from_the_brand.
    effective_brand = form.get('brand_name') or BRAND_NAME
    if not form.get('brand_name') and effective_brand:
        # Store it, so this form stops depending on the environment variable —
        # see _anchor_form_brand.
        _anchor_form_brand(form_id, effective_brand, scope)

    now = datetime.now(UTC)
    feedback_id = str(uuid.uuid4())

    # Build normalized record with category routing
    metadata = {
        'form_id': form_id,
        'form_name': form.get('name', ''),
        'form_version': '2.0',
        **submission.metadata,
    }
    if body.get('custom_fields'):
        metadata['custom_fields'] = body['custom_fields']
    # A participant ask's link (shared/feedback_form_participants.py): ids only, or nothing. Asks are the
    # deployment's (phase 3), so a workspace's form attributes none.
    participant = resolve_participant(body) if scope is None else None
    if participant:
        metadata['participant'] = participant

    # The first answered option that maps a category wins over the form's own routing (docs/feedback-forms.md).
    routing = submission.category or {'category': form.get('category'), 'subcategory': form.get('subcategory')}
    preset_category, preset_subcategory = _preset_routing(routing, scope)
    normalized_record = {
        'id': feedback_id,
        'source_platform': FEEDBACK_FORM_SOURCE,
        'source_channel': f'form_{form_id}',
        'text': submission.text,
        'rating': submission.rating,
        'created_at': now.isoformat(),
        'ingested_at': now.isoformat(),
        # Resolved above, from the form record already loaded for the enabled
        # check: the form's own brand, so this submission lands in the partition
        # _form_source_pk queries for the whole life of the form.
        'brand_name': effective_brand,
        'url': body.get('page_url'),
        'preset_category': preset_category,
        'preset_subcategory': preset_subcategory,
        'metadata': metadata,
        # The form's own defaults WIN: the public embed option may only fill keys
        # the form leaves unset, so a page cannot relabel a form's product etc.
        **message_labels({**widget_dimensions, **(form.get('dimension_defaults') or {})}, form.get('tags')),
    }
    if submission.metadata.get('form_language') in fv2.FORM_LOCALES:
        # The response's language: the redaction's, and the processor's hint.
        normalized_record['language'] = submission.metadata['form_language']
    # The feedback_form source profile's PII policy, before anything is archived or
    # queued. Strict: an unreadable policy answers 503 (the widget can retry) rather
    # than archiving or queueing under the allow default. A workspace's form: that workspace's profile.
    profile = cached_source_profile_strict(FEEDBACK_FORM_SOURCE, scope)
    if profile.get('pii', PII_ALLOW) != PII_ALLOW:
        normalized_record['metadata'] = _without_contact_names(metadata, submission.contact_ids)
    policed = apply_source_policy(normalized_record, profile)
    if policed is None:
        raise ValidationError('Feedback text is required')
    # The body as the widget sent it, kept only when the profile permits a raw copy
    # (shared/feedback_form_raw.py); a failed write is logged and the submission queued.
    raw_form = {**form, 'collect_email': _collects(form, 'email'), 'collect_name': _collects(form, 'name')}
    # A version 2 response is kept as checked (``response``); a version 1 body's own fields as before.
    response = submission.content if fresp.is_v2_response(body) else None
    raw_uri = archive_submission(form_id, raw_form, feedback_id, body, (submission.text, widget_dimensions),
                                 profile, now, scope=scope, response=response)
    normalized_record = {**policed, 's3_raw_uri': raw_uri} if raw_uri else policed

    try:
        sqs.send_message(
            QueueUrl=PROCESSING_QUEUE_URL,
            # The workspace of the form's lookup row, set last (none for a deployment form).
            MessageBody=json.dumps(workspace_payload(normalized_record, routed), default=str)
        )
    except Exception as e:
        logger.exception(f"Error submitting feedback: {e}")
        raise ServiceError('Failed to submit feedback. Please try again.') from e
    record_response(participant)
    _mark_answered(form_id, form, scope)
    _close_session(form_id, scope, body.get('session'), None)
    logger.info(f"Submitted feedback to form {form_id}: {feedback_id}")
    out = {'success': True, 'feedback_id': feedback_id, 'message': submission.message}
    if submission.ending_id:
        out['ending_id'] = submission.ending_id
    return out


def _mark_answered(form_id: str, form: Mapping[str, Any], scope: WorkspaceScope | None) -> None:
    """Mark the form answered (``has_responses``) on its first queued real response: the builder locks option codes
    and question ids from then on. Once per form, never a write per submission: the form this submit read says it is
    marked. Best effort, once the response is queued (a mark is never worth a refusal); only on the existing row (never
    a stub of a form deleted meanwhile), and never its revision, so no save conflicts."""
    if form.get('has_responses') is True:
        return
    try:
        _forms(scope).update_item(_form_key(form_id, scope), UpdateExpression='SET has_responses = :yes',
                                  ConditionExpression='attribute_exists(sk)', ExpressionAttributeValues={':yes': True})
    except Exception as e:  # noqa: BLE001 - the response is queued already: its mark never fails it
        if not _is_conditional_check_failure(e):  # a failed condition: the form was deleted meanwhile
            # (counted: a form left unmarked is read for its responses by a save that would drop or reshape one)
            metrics.add_metric(name='FeedbackFormMarkAnsweredFailed', unit='Count', value=1)
            logger.warning(f"Could not mark form {form_id} answered: {type(e).__name__}")


def _js_value(value: Any) -> str:
    """A Python value as a JavaScript expression safe to inline in a <script> (#379, PR #396).

    `json.dumps` decides every quote and escape, so a value can never close a
    string literal the template wrote. `<`, `>` and `&` become `\\uXXXX` because
    the HTML parser sees the text first and ends the element at `</script>`
    even inside a string; `ensure_ascii=True` (explicit, load-bearing) escapes
    U+2028/U+2029 and all other non-ASCII. `html.escape` is NOT used: its
    entities are not decoded inside a script, so it would corrupt the value.
    """
    return (
        json.dumps(value, ensure_ascii=True)
        .replace('<', '\\u003c')
        .replace('>', '\\u003e')
        .replace('&', '\\u0026')
    )


# The only text/html response in this API, on its own origin. `'unsafe-inline'`
# script/style because the widget is inlined; what the policy still buys is that
# no external script, image, font or frame loads and the only network destination
# is this origin (the widget's /config and /submit fetches — api_endpoint is built
# from this request's own host). `frame-ancestors` is deliberately absent: the
# page exists to be framed on customers' sites.
_IFRAME_SECURITY_HEADERS = {
    'Content-Security-Policy': (
        "default-src 'none'; "
        "script-src 'unsafe-inline'; "
        "style-src 'unsafe-inline'; "
        "connect-src 'self'; "
        "base-uri 'none'; "
        "form-action 'none'"
    ),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
}


# What this page reads from its own address (only THIS page: the widget embedded on a customer's own site never looks
# at that site's query), set on ``VoCFeedbackForm`` before ``init`` for the widget to use:
#
# * ``participantToken``: a participant ask's link opens the page with ``?r=<response token>``
#   (shared/feedback_form_participants.py); the widget posts it as ``participant_token``;
# * ``testToken``: the form's test link adds ``?test=<token>`` (POST …/test-link); the widget posts it as ``test``;
# * ``linkHidden``: every ``hf_<id>=<value>`` of the link, as ``{id: value}``; the widget posts the form's declared
#   ones as ``hidden`` (the server refuses the rest);
# * ``linkLanguage``: the link's ``lang=``, the respondent's language when the form has it (else the browser's,
#   else the primary).
#
# A token is dropped from the address once read, so neither ``page_url`` nor a Referer carries it.
_LINK_JS = (
    "(function () { "
    "var params = new URLSearchParams(window.location.search); var hidden = {}; "
    "params.forEach(function (value, key) { if (key.indexOf('hf_') === 0) { hidden[key.slice(3)] = value; } }); "
    "VoCFeedbackForm.linkHidden = hidden; "
    f"VoCFeedbackForm.testToken = params.get('{TEST_LINK_PARAMETER}'); "
    "VoCFeedbackForm.linkLanguage = params.get('lang'); "
    "VoCFeedbackForm.participantToken = params.get('r'); "
    "if (VoCFeedbackForm.participantToken || VoCFeedbackForm.testToken) { "
    "history.replaceState(null, '', window.location.pathname); } "
    "})();"
)


@app.get("/feedback-forms/<form_id>/iframe")
@tracer.capture_method
def get_form_iframe(form_id: str):
    """Serve HTML page for form-specific iframe embedding.

    Two gates before any HTML (#379): the id must match the form-id pattern, and
    the form must exist (this route used to render a page for any string). A
    disabled form still gets its page, like GET /config, so the widget can show
    its own "unavailable" state. Every reflected value then goes through
    `_js_value`, so the render is safe independent of the pattern.
    """
    # Existence gate (a workspace's form by its lookup row); the page is a function of the id, the host and the
    # form's primary language and welcome title.
    form_id, form, _routed = _public_form(form_id, 'Failed to load form')
    definition = _definition(form)
    language = str(definition.get('language') or fv2.DEFAULT_LOCALE)
    title = fv2.text_in((definition.get('welcome') or {}).get('title'), language, language) or 'Feedback Form'

    host = app.current_event.request_context.get('domainName', '')
    stage = app.current_event.request_context.get('stage', 'v1')
    api_endpoint = f"https://{host}/{stage}" if host else ''

    # One serialised object: json.dumps writes every quote, brace and comma.
    # api_endpoint comes from request context, so it is serialised too.
    init_options = _js_value({
        'container': '#voc-feedback-form',
        'apiEndpoint': api_endpoint,
        'formId': form_id,
        'configEndpoint': f'/feedback-forms/{form_id}/config',
        'submitEndpoint': f'/feedback-forms/{form_id}/submit',
        'eventsEndpoint': f'/feedback-forms/{form_id}/events',
    })
    # The page styles only itself: the widget ships its own reset inside its shadow root (7.55.01), so this page,
    # a script embed and the editor's preview draw the same form.
    html = f'''<!DOCTYPE html>
<html lang="{html_text.escape(language)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{html_text.escape(title[:200])}</title>
  <style>
    html, body {{ margin: 0; }}
    #voc-feedback-form {{ min-height: 100vh; }}
  </style>
</head>
<body>
  <main id="voc-feedback-form"></main>
  <script>
  {get_widget_js()}
  {_LINK_JS}
  VoCFeedbackForm.init({init_options});
  </script>
</body>
</html>'''

    return Response(
        status_code=200,
        content_type="text/html",
        body=html,
        headers=dict(_IFRAME_SECURITY_HEADERS),
    )


# ============================================
# Form Stats & Submissions
# ============================================

def _form_source_pk(form: dict, scope: WorkspaceScope | None = None) -> str:
    """The feedback partition this form's submissions live in.

    Pure: derived from the form record the caller already holds, never from a
    read of its own. A partition GUESSED from a failed form read is the whole
    problem — it resolves to BRAND_NAME, which after a rename is a partition the
    form's submissions were never written to, so the query finds nothing and the
    route reports 0 submissions for a form that has them (issue #312's false zero
    arriving by another door). Callers get the record from _load_form_for_query,
    which fails loudly instead.

    Mirrors submit_form_feedback's write side: the form's own brand, the
    deployment's only for a form recorded without one, and `or` rather than a
    get() default so a stored '' takes the fallback on both sides alike.

    A workspace's form (``scope``): the same partition in the workspace, ``WS#{ws}#SOURCE#…``, where the processor
    stores its submissions (shared/feedback_partitions.py ``source_partition``, the processor's own key).
    """
    effective_brand = form.get('brand_name') or BRAND_NAME
    return source_partition(scope, effective_brand or FEEDBACK_FORM_SOURCE)


def _load_form_for_query(form_id: str, read_failure_message: str, scope: WorkspaceScope | None = None) -> dict:
    """Load a form record for a stats/submissions query, failing loudly.

    One get_item answers both questions those routes need, so neither has to be
    guessed:

    - Does this form exist? A form id that was deleted (or never existed) must be
      a 404, not a 200 with a measured-looking 0 — LinkedFormEvidence renders
      that zero as evidence against a work item and has an `evidence.unavailable`
      branch waiting for the error.
    - Which feedback partition are its submissions in? See _form_source_pk: a
      degraded fallback here queries the wrong partition after a brand rename.

    Both failure modes previously produced HTTP 200 with total_submissions: 0 on
    the stats route, which is the exact defect issue #312 is about.

    In a workspace (``scope``) the form is its own (another workspace's id, or the deployment's, is a 404).
    """
    try:
        response = _forms(scope).get_item(_form_key(form_id, scope))
    except Exception as e:
        # Surfaced as a metric because this failure used to be invisible: it was
        # reported to the caller as a zero count and to operations as nothing.
        metrics.add_metric(name='FeedbackFormReadFailed', unit='Count', value=1)
        logger.exception(f"Error fetching form {form_id}: {e}")
        raise ServiceError(read_failure_message) from e

    form = response.get('Item')
    if not form:
        raise NotFoundError('Form not found')
    return form


@app.get("/feedback-forms/<form_id>/submissions")
@tracer.capture_method
def get_form_submissions(form_id: str):
    """Get submissions for a specific form with stats (in a workspace: one of its forms, from its feedback)."""
    workspace = _request_scope()
    params = app.current_event.query_string_parameters or {}
    limit = validate_limit(params.get('limit'), default=50, max_val=100)

    if not feedback_table:
        raise ConfigurationError('Feedback table not configured')

    # One read answers both the 404 and the partition, where this route used to
    # do its own existence check and then have _get_form_source_pk re-read the
    # same record (and swallow a failure of it).
    form = _load_form_for_query(form_id, 'Failed to fetch form', workspace)

    source_channel = f'form_{form_id}'
    source_pk = _form_source_pk(form, workspace)
    # Read before the try: a failed access read is its own 500, not "no submissions".
    scope = scope_for_event(app.current_event.raw_event, aggregates_table, workspace)

    try:
        items = []
        ratings = _RatingTally()

        query_kwargs: dict[str, Any] = {
            'FilterExpression': 'source_channel = :sc',
            'ExpressionAttributeValues': {':sc': source_channel},
            'ScanIndexForward': False,
        }

        while len(items) < limit:
            response = query_partition(workspace, feedback_table, 'pk', source_pk, **query_kwargs)

            for item in category_access.filter_items(scope, response.get('Items', [])):
                items.append({
                    'feedback_id': item.get('feedback_id', ''),
                    'original_text': item.get('original_text', ''),
                    'rating': float(item.get('rating')) if item.get('rating') else None,
                    'sentiment_label': item.get('sentiment_label', ''),
                    'sentiment_score': float(item.get('sentiment_score', 0)),
                    'category': item.get('category', ''),
                    'created_at': item.get('source_created_at', ''),
                    'persona_name': item.get('persona_name', ''),
                })
                ratings.add(item)

            if 'LastEvaluatedKey' not in response:
                break
            query_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']

        return {
            'success': True,
            'form_id': form_id,
            'stats': ratings.stats(len(items)),
            'submissions': items[:limit]
        }
    except ApiError:
        # Precautionary, not currently reachable: the only typed raise on this
        # route (_load_form_for_query) happens ABOVE the try, and nothing inside
        # it raises an ApiError today. It is here so that when something in this
        # block eventually does — a validation of a page of items, a helper that
        # 404s — its status survives instead of being flattened to a 500 by the
        # handler below. Pinned by a test that raises a typed exception from
        # feedback_table.query; without this clause that test gets a 500.
        raise
    except Exception as e:
        logger.exception(f"Error fetching submissions: {e}")
        raise ServiceError('Failed to fetch submissions') from e


@app.get("/feedback-forms/<form_id>/stats")
@tracer.capture_method
def get_form_stats(form_id: str):
    """Get quick stats for a form (lightweight endpoint for card display).

    Fails loudly, like get_form_submissions above. The count this returns is
    rendered next to a prioritization score, so "0 submissions" is a claim about
    the product, not a placeholder: a read that could not be completed must not
    be reported as a form nobody answered.

    That applies to EVERY read this route makes, not just the feedback query: an
    unconfigured table, a failed form lookup, a form that no longer exists and a
    failed feedback query all used to arrive as total_submissions: 0.

    Cost, noted next to the loudness because the two interact: the query below
    pages a whole SOURCE# partition with no Limit and filters source_channel
    server-side but AFTER the partition is read. That partition is the BRAND's,
    not the form's — plugin ingestion stamps brand_name from the same BRAND_NAME —
    so the work scales with total brand feedback volume rather than with this
    form's own submissions, against a 30s Lambda timeout. Failing loudly turns
    exceeding that from a silent zero into a user-visible error, and because the
    partition is shared it would surface for every form in the deployment at once.
    Reading it honestly is still right; bounding it needs an index on the
    submission-to-form link, which is deliberately not done here.
    """
    workspace = _request_scope()
    if not feedback_table:
        raise ConfigurationError('Feedback table not configured')

    # 404 for a deleted form, and the partition its submissions are in, from the
    # one read — never a partition guessed from a read that failed.
    form = _load_form_for_query(form_id, 'Failed to fetch form stats', workspace)

    source_channel = f'form_{form_id}'
    source_pk = _form_source_pk(form, workspace)
    scope = scope_for_event(app.current_event.raw_event, aggregates_table, workspace)

    try:
        ratings = _RatingTally(_definition(form))
        submission_count = 0

        query_kwargs: dict[str, Any] = {
            'FilterExpression': 'source_channel = :sc',
            'ExpressionAttributeValues': {':sc': source_channel},
            # `category` + `source_platform` so a restricted caller's count covers only
            # what they can see: both access rules read them (admits_item). `metadata`
            # and `source_created_at`: the headline figure's answers.
            'ProjectionExpression': 'feedback_id, rating, category, source_platform, metadata, source_created_at',
        }

        for item in category_access.filter_items(scope, _partition_rows(feedback_table, workspace, source_pk, query_kwargs)):
            submission_count += 1
            ratings.add(item)

        return {
            'success': True,
            'form_id': form_id,
            'stats': ratings.stats(submission_count),
        }
    except ApiError:
        # See get_form_submissions: precautionary. No statement in this block
        # raises a typed exception today (the form load, which does, is above the
        # try), but a future one would otherwise be reported as a server fault —
        # and would take the FeedbackFormStatsReadFailed metric with it, which is
        # meant to count read failures rather than every 4xx-shaped cause.
        raise
    except Exception as e:
        # This read failure was previously reported as a zero count and so was
        # invisible in dashboards; the metric is what makes it observable.
        metrics.add_metric(name='FeedbackFormStatsReadFailed', unit='Count', value=1)
        logger.exception(f"Error fetching form stats: {e}")
        raise ServiceError('Failed to fetch form stats') from e


# ============================================
# Test link and results (schema version 2)
# ============================================

def _require_test_link_admin() -> None:
    """403 unless the caller is an admin: of the workspace the request names (acting as themselves), else of the
    deployment (shared/request_workspace.py ``require_settings_admin``). A test token lets its holder submit to the
    form even while it is off, so only an admin issues or rotates one."""
    event = app.current_event.raw_event
    require_settings_admin(event, _workspace.context(event, fresh=True))


TEST_RESPONSES_DELETERS = "Only an admin or the form's creator can delete its test responses"


def _may_delete_test_responses(form: Mapping[str, Any], *, fresh: bool = False) -> bool:
    """Whether the caller may delete ``form``'s test responses: the person who created it (its ``created_by``,
    acting as themselves, never a delegated caller), or an admin (of the workspace the request names, else of the
    deployment: ``require_settings_admin``). ``fresh`` reads the workspace role from the table, as a write does; the
    single read's flag takes the request's cached one. A form created before 7.55.00 has no ``created_by``: its
    admins only."""
    event = app.current_event.raw_event
    creator = form.get('created_by')
    if isinstance(creator, str) and creator and not caller_from_event(event).delegated \
            and creator == get_caller_subject(event):
        return True
    try:
        require_settings_admin(event, _workspace.context(event, fresh=fresh))
    except AuthorizationError:
        return False
    return True


def _iframe_url(form_id: str) -> str:
    """The form's iframe page on this API's own host and stage ('' when the request carries no host)."""
    host = app.current_event.request_context.get('domainName', '')
    stage = app.current_event.request_context.get('stage', 'v1')
    return f'https://{host}/{stage}/feedback-forms/{form_id}/iframe' if host else ''


@app.post("/feedback-forms/<form_id>/test-link")
@tracer.capture_method
def issue_test_link(form_id: str):
    """Issue the form's test link, or rotate it (admins; docs/feedback-forms.md "Test mode").

    Body (all optional): ``rotate`` (true: a new token, the old link stops working), ``link_enabled`` (default true:
    issuing a link turns it on) and ``record`` (``tag`` | ``drop``). Answers ``{test: {link_enabled, record, token,
    token_issued_at}, test_link, test_query}``: the token only ever leaves the server here. A form with a token keeps
    it unless ``rotate`` is sent. The public routes, their auth and their rate limits are unchanged: the token rides
    the existing submit as its ``test`` field.
    """
    scope = _request_scope(write=True)
    _require_test_link_admin()
    body = json_object_body(app)
    rotate = body.get('rotate', False)
    if not isinstance(rotate, bool):
        raise ValidationError('rotate must be true or false')
    if scope is None:
        _refuse_a_workspaces_id(form_id, 'Failed to issue the test link')
    stored = _read_form(form_id, 'Failed to issue the test link', scope)
    current = fv2.test_settings_of(stored)
    asked = {key: body[key] for key in ('link_enabled', 'record') if key in body}
    test = fv2.validate_test_settings({'test': {'link_enabled': True, **asked}}, current)
    now, actor = now_iso(), get_caller_subject(app.current_event.raw_event)
    if rotate or 'token' not in current:
        test.update({'token': secrets.token_urlsafe(24), 'token_issued_at': now, 'token_issued_by': actor})
    try:
        _forms(scope).update_item(
            _form_key(form_id, scope),
            UpdateExpression='SET #settings = :settings, updated_at = :now, updated_by = :actor',
            ConditionExpression='attribute_exists(sk)',
            ExpressionAttributeNames={'#settings': 'settings'},
            ExpressionAttributeValues={':settings': {'test': test}, ':now': now, ':actor': actor},
        )
    except Exception as e:
        if _is_conditional_check_failure(e):
            raise NotFoundError('Form not found') from e
        logger.exception(f"Error issuing the test link of form {form_id}: {type(e).__name__}")
        raise ServiceError('Failed to issue the test link') from e
    query = f"{TEST_LINK_PARAMETER}={test['token']}"
    iframe = _iframe_url(form_id)
    view = {key: test[key] for key in ('link_enabled', 'record', 'token', 'token_issued_at') if key in test}
    return {'success': True, 'form_id': form_id, 'test': view, 'test_query': query,
            'test_link': f'{iframe}?{query}' if iframe else ''}


def _result_row(item: Mapping[str, Any], definition: Mapping[str, Any]) -> ResultRow | None:
    """A feedback item of the form as a results row: its v2 answers, else its version 1 rating and text."""
    metadata = fv2.plain(item.get('metadata')) if isinstance(item.get('metadata'), Mapping) else {}
    extra: dict[str, Any] = {
        'response_id': str(item.get('feedback_id') or ''), 'sentiment': item.get('sentiment_label') or None,
        'language': metadata.get('form_language') or None,
        'revision': metadata.get('form_revision') if isinstance(metadata.get('form_revision'), int) else None,
        'session': metadata.get('form_session') if isinstance(metadata.get('form_session'), str) else None,
        'channel': metadata.get('form_channel') if isinstance(metadata.get('form_channel'), str) else None,
        'category': item.get('category') if isinstance(item.get('category'), str) else None,
        'subcategory': item.get('subcategory') if isinstance(item.get('subcategory'), str) else None,
    }
    created_at = str(item.get('source_created_at') or '')
    answers = metadata.get('form_answers')
    if isinstance(answers, Mapping):
        raw_path, raw_hidden = metadata.get('form_path'), metadata.get('form_hidden')
        path = [str(qid) for qid in raw_path] if isinstance(raw_path, list) else [str(qid) for qid in answers]
        hidden: Mapping[str, Any] = raw_hidden if isinstance(raw_hidden, Mapping) else {}
        return ResultRow(answers, path, metadata.get('form_ending_id'), created_at, hidden=hidden, **extra)
    return legacy_row(definition, fv2.plain(item.get('rating')), item.get('original_text'), created_at, **extra)


#: What the results read of each feedback item (``category`` + ``source_platform``: both access rules read them;
#: ``subcategory`` too, for the report's themes).
_RESULT_FIELDS = {'#fid': 'feedback_id', '#rating': 'rating', '#cat': 'category', '#src': 'source_platform',
                  '#meta': 'metadata', '#text': 'original_text', '#at': 'source_created_at', '#test': 'is_test',
                  '#sent': 'sentiment_label', '#sub': 'subcategory'}


def _feedback_rows(form: Mapping[str, Any], form_id: str, workspace: WorkspaceScope | None,
                   definition: Mapping[str, Any], access: category_access.CategoryScope) -> Iterator[ResultRow]:
    """The form's feedback items that ``access`` admits (the caller's category access AND source access, as on the
    stats routes and every feedback read: ``admits_item`` reads ``category`` and ``source_platform``) as results
    rows. An item tagged ``is_test`` is never one (none should exist: test responses are never queued)."""
    if not feedback_table:
        raise ConfigurationError('Feedback table not configured')
    query_kwargs: dict[str, Any] = {
        'FilterExpression': 'source_channel = :sc',
        'ExpressionAttributeValues': {':sc': f'form_{form_id}'},
        'ProjectionExpression': ', '.join(_RESULT_FIELDS),
        'ExpressionAttributeNames': dict(_RESULT_FIELDS),
    }
    rows = _partition_rows(feedback_table, workspace, _form_source_pk(dict(form), workspace), query_kwargs)
    for item in category_access.filter_items(access, rows):
        if item.get('is_test'):
            continue
        row = _result_row(item, definition)
        if row is not None:
            yield row


def _test_rows(form_id: str, scope: WorkspaceScope | None, definition: Mapping[str, Any]) -> Iterator[ResultRow]:
    """The form's tagged test responses (``{form_id}#…`` in the scope's ``FEEDBACK_FORM_TEST``) as results rows."""
    for item in iter_partition(scope, _forms_table(), 'pk', test_responses_partition(scope),
                               sort_prefix=form_sk_prefix(form_id)):
        answers = fv2.plain(item.get('answers'))
        extra: dict[str, Any] = {'is_test': True, 'response_id': str(item.get('response_id') or ''),
                                 'language': item.get('language') or None,
                                 'revision': fv2.plain(item.get('form_revision')),
                                 'session': item.get('session') if isinstance(item.get('session'), str) else None,
                                 'channel': item.get('channel') if isinstance(item.get('channel'), str) else None}
        hidden = fv2.plain(item.get('hidden')) if isinstance(item.get('hidden'), Mapping) else {}
        created_at = str(item.get('created_at') or '')
        if isinstance(answers, Mapping) and answers:
            yield ResultRow(answers, fv2.plain(item.get('path') or list(answers)), item.get('ending_id'),
                            created_at, hidden=hidden, **extra)
        elif (row := legacy_row(definition, fv2.plain(item.get('rating')), item.get('text'), created_at,
                                **extra)) is not None:
            yield row


def _view_filters(params: Mapping[str, Any]) -> dict[str, Any]:
    """The Results / Responses filters of the query string: ``from``, ``to``, ``language``, ``ending`` and
    ``hidden.<id>=<value>`` (each value at most 200 characters)."""
    def text(key: str) -> str:
        value = str(params.get(key) or '')
        if len(value) > fv2.MAX_HIDDEN_VALUE_CHARS:
            raise ValidationError(f'{key} must be at most {fv2.MAX_HIDDEN_VALUE_CHARS} characters')
        return value
    hidden = {key.removeprefix('hidden.'): text(key) for key in params if key.startswith('hidden.')}
    return {'date_from': text('from'), 'date_to': text('to'), 'language': text('language'),
            'ending': text('ending'), 'hidden': hidden}


def _include_test(params: Mapping[str, Any], *, allow_only: bool = False) -> str:
    """``include_test``: ``false`` (default: real responses only), ``true`` (real and test) or ``only`` (test)."""
    value = str(params.get('include_test', 'false')).lower()
    allowed = ('false', 'true', 'only') if allow_only else ('false', 'true')
    if value not in allowed:
        raise ValidationError(f'include_test must be one of: {", ".join(allowed)}')
    return value


def _admits_test_rows(access: category_access.CategoryScope, form: Mapping[str, Any]) -> bool:
    """Whether the caller sees the form's TEST responses. They are no feedback items (no ``source_platform`` or
    ``category`` of their own), so they are judged as the form files its responses: source ``feedback_form`` (a
    deployment, or a workspace, may mark it restricted) under the form's own category (``other`` when it routes to
    none). Fail closed: a caller who could not see a real response of this form sees no test one either."""
    return category_access.admits_item(access, {'source_platform': FEEDBACK_FORM_SOURCE,
                                                'category': form.get('category')})


def _read_view_rows(form: Mapping[str, Any], form_id: str, workspace: WorkspaceScope | None,
                    definition: Mapping[str, Any], *, real: bool, test: bool) -> tuple[list[ResultRow], list[ResultRow]]:
    """``(real rows, test rows)`` of the form (each read only when asked for): only what the caller's category access
    and source access admit, against the workspace's configuration in a workspace (``scope_for_event``: a failed read
    of either is a 500, never "everything")."""
    access = scope_for_event(app.current_event.raw_event, aggregates_table, workspace)
    try:
        reals = list(_feedback_rows(form, form_id, workspace, definition, access)) if real else []
        tests = list(_test_rows(form_id, workspace, definition)) if test and _admits_test_rows(access, form) else []
    except ApiError:
        raise
    except Exception as e:
        metrics.add_metric(name='FeedbackFormResultsReadFailed', unit='Count', value=1)
        logger.exception(f"Error fetching form results: {type(e).__name__}")
        raise ServiceError('Failed to fetch form results') from e
    return reals, tests


def _view_rows(form: Mapping[str, Any], form_id: str, workspace: WorkspaceScope | None,
               definition: Mapping[str, Any], include_test: str) -> list[ResultRow]:
    """The rows a Responses view lists (its JSON and its CSV): real ones unless ``only``, test ones unless ``false``
    (``_read_view_rows``)."""
    reals, tests = _read_view_rows(form, form_id, workspace, definition, real=include_test != 'only',
                                   test=include_test != 'false')
    return reals + tests


def _revisions(form_id: str, scope: WorkspaceScope | None, form: Mapping[str, Any]) -> dict[int, dict[str, Any]]:
    """The form's earlier revisions' definitions by number (its ``FORMREV#`` snapshots), so Results score each response
    against the revision it answered; none for a form still at its first revision. One query of the form's own rows,
    bounded by how often its definition changed."""
    if fv2.revision_of(form) <= 1:
        return {}
    out: dict[int, dict[str, Any]] = {}
    try:
        for item in iter_partition(scope, _forms_table(), 'pk', _forms_partition(scope),
                                   sort_prefix=f'{_REVISION_PREFIX}{form_id}#'):
            number = fv2.plain(item.get('revision'))
            if isinstance(number, int) and not isinstance(number, bool):
                out[number] = {name: fv2.plain(item.get(name)) for name in fv2.DEFINITION_FIELDS}
    except Exception as e:
        metrics.add_metric(name='FeedbackFormResultsReadFailed', unit='Count', value=1)
        logger.exception(f"Error reading the revisions of form {form_id}: {type(e).__name__}")
        raise ServiceError('Failed to fetch form results') from e
    return out


def _funnel_hidden(filters: Mapping[str, Any]) -> bool:
    """Whether the view narrows its responses by what the funnel's counters do not know (a language, an ending, a
    hidden value): then no funnel is answered, rather than filtered completions against every visit's opens."""
    return bool(filters.get('language') or filters.get('ending') or filters.get('hidden'))


def _funnel_rows(form_id: str, scope: WorkspaceScope | None, filters: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The form's daily funnel counters (``FORMFUNNEL#{form_id}#{day}[#test]``: ``opened`` and ``left:{question_id}``)
    within the view's dates: one row per day, so the read is bounded by the view's days, never by its visitors."""
    first, last = str(filters.get('date_from') or '')[:10], str(filters.get('date_to') or '')[:10]
    rows = []
    for item in iter_partition(scope, _forms_table(), 'pk', _forms_partition(scope),
                               sort_prefix=f'{_FUNNEL_PREFIX}{form_id}#'):
        day = str(item.get('day') or '')
        if (not first or day >= first) and (not last or day <= last):
            rows.append(fv2.plain(dict(item)))
    return rows


@app.get("/feedback-forms/<form_id>/results")
@tracer.capture_method
def get_form_results(form_id: str):
    """The form's results per question of its current revision (docs/feedback-forms.md "Results"): admins and
    editors in a workspace (a viewer 403), whoever manages forms deployment-wide, with the caller's category access
    and source access applied as on stats (a caller denied the ``feedback_form`` source counts no response, real or
    test).

    ``?include_test=true`` adds the test link's tagged responses (default: real responses only); ``test_responses``
    counts the test responses the view admits either way, so the page can say how many it left out. ``from``, ``to``,
    ``language``, ``ending`` and ``hidden.<id>=<value>`` filter the responses counted; the funnel follows the dates
    only, so a language, ending or hidden-value filter answers ``funnel: null`` (its counters know none of them).
    Counts per option code, rating histograms, NPS / CSAT / CES, the open-text count with the latest answers, the
    reach of each question, the endings, and the widget's open and step counts (shared/forms_v2_results.py), each
    response scored against the revision it answered (the form's snapshots). (Segments are the report's:
    ``GET …/report?group_by=``.)
    """
    workspace = _request_scope(write=True)
    view = _results_view(workspace, form_id, 'Failed to fetch form results')
    return {'success': True, 'form_id': form_id, 'revision': fv2.revision_of(view.form),
            'include_test': view.include_test, **view.results()}


@dataclass(frozen=True)
class _ResultsView:
    """One Results-shaped read of a form (its results, its report and the report's segments): the form, its definition
    and revisions, the caller's real rows (every one their access admits, whatever the filters), the view's rows
    (filtered, with the test ones when asked) and the test rows the view admits."""

    workspace: WorkspaceScope | None
    form: Mapping[str, Any]
    definition: Mapping[str, Any]
    revisions: Mapping[int, Mapping[str, Any]]
    reals: list[ResultRow]
    rows: list[ResultRow]
    tests: list[ResultRow]
    funnel: dict[str, Any] | None
    include_test: bool
    group_by: GroupBy | None

    def results(self) -> dict[str, Any]:
        return tally_results(self.definition, self.rows, self.funnel, revisions=self.revisions,
                             test_responses=len(self.tests))

    def segments(self) -> dict[str, Any] | None:
        return None if self.group_by is None else segment_results(self.definition, self.rows, self.group_by,
                                                                    revisions=self.revisions)


def _results_view(workspace: WorkspaceScope | None, form_id: str, failure_message: str, *,
                  report: bool = False) -> _ResultsView:
    """The view a Results-shaped GET asks for in ``workspace`` (the route's ``_request_scope(write=True)``: a
    workspace's editors and admins, a viewer 403): its filters and ``include_test`` checked before anything is read.
    ``report``: the report's read, whose ``group_by`` is checked too, and which reads no daily counters (the report
    shows no funnel)."""
    params = app.current_event.query_string_parameters or {}
    include_test = _include_test(params) == 'true'
    filters = _view_filters(params)
    form = _load_form_for_query(form_id, failure_message, workspace)
    definition = _definition(form)
    group_by = parse_group_by(definition, params['group_by']) if report and params.get('group_by') else None
    reals, tests = _read_view_rows(form, form_id, workspace, definition, real=True, test=True)
    tests = filter_rows(tests, **filters)
    rows = filter_rows(reals, **filters) + (tests if include_test else [])
    counted = None if report or _funnel_hidden(filters) else funnel_counts(
        _funnel_rows(form_id, workspace, filters), include_test=include_test)
    return _ResultsView(workspace, form, definition, _revisions(form_id, workspace, form), reals, rows, tests, counted,
                        include_test, group_by)


@app.get("/feedback-forms/<form_id>/report")
@tracer.capture_method
def get_form_report(form_id: str):
    """The form's report (7.63.00, docs/feedback-forms.md "Report"), with the access, filters and ``include_test`` of
    the results: ``{responses, first_response_at, last_response_at, kpis, matrices, segments (with ``group_by``),
    themes, ai, min_segment}`` (shared/forms_v2_report.py). ``ai`` is the newest stored AI summary as this reader may
    see it (its quotes joined against their own rows under the summary's own filters, whatever the view's, and stale
    under them; withheld when it read one they cannot see), None without one. Never a contact detail."""
    workspace = _request_scope(write=True)
    view = _results_view(workspace, form_id, 'Failed to fetch the form report', report=True)
    results = view.results()
    times = [row.created_at for row in view.rows if row.created_at]
    try:
        stored = latest_report(view.workspace, _forms_table(), _forms_partition(view.workspace), form_id)
    except Exception as e:
        metrics.add_metric(name='FeedbackFormResultsReadFailed', unit='Count', value=1)
        logger.exception(f"Error reading the report of form {form_id}: {type(e).__name__}")
        raise ServiceError('Failed to fetch the form report') from e
    return {'success': True, 'form_id': form_id, 'revision': fv2.revision_of(view.form),
            'name': view.form.get('name', ''), 'template': fv2.template_of(view.form),
            'include_test': view.include_test, 'responses': results['responses'],
            'test_responses': results['test_responses'], 'first_response_at': min(times, default=None),
            'last_response_at': results['last_response_at'], **report_sections(view.definition, results),
            'segments': view.segments(), 'themes': themes(view.definition, view.rows),
            'ai': ai_view(stored, view.definition, view.reals), 'min_segment': MIN_SEGMENT}


def _compared_ids(form_id: str, raw: object) -> list[str]:
    """``with``: up to ``MAX_COMPARED_FORMS`` other form ids, comma-separated (the form itself and repeats dropped)."""
    ids = [part.strip() for part in str(raw or '').split(',') if part.strip()]
    if len(ids) > MAX_COMPARED_FORMS:
        raise ValidationError(f'with names at most {MAX_COMPARED_FORMS} forms')
    out = []
    for raw_id in ids:
        valid = _validated_form_id(raw_id)
        if valid is None:
            raise ValidationError('with must be form ids, comma-separated')
        if valid != form_id and valid not in out:
            out.append(valid)
    return out


def _form_side(form_id: str, workspace: WorkspaceScope | None, filters: Mapping[str, Any],
               include_test: bool) -> FormSide:
    """One form of a comparison, read as Results read it (404 for a form this scope does not hold)."""
    form = _load_form_for_query(form_id, 'Failed to compare forms', workspace)
    definition = _definition(form)
    reals, tests = _read_view_rows(form, form_id, workspace, definition, real=True, test=include_test)
    rows = filter_rows(reals, **filters) + (filter_rows(tests, **filters) if include_test else [])
    return FormSide(form_id, str(form.get('name') or ''), fv2.template_of(form), definition, rows,
                    _revisions(form_id, workspace, form))


@app.get("/feedback-forms/<form_id>/compare")
@tracer.capture_method
def compare_forms(form_id: str):
    """The form beside up to 10 others (7.63.00, docs/feedback-forms.md "Compare"): ``with=<form ids,
    comma-separated>`` (each one of the same scope's forms: another workspace's is the 404) and ``by=hidden.<id>``
    (each compared form's responses split by the value; a 400 without ``with``: one form's split is its report's
    segments). Its measured questions are matched in each other form by id and what their figures mean, every point of
    at least 5 responses (shared/forms_v2_segments.py ``compare``), with the access, filters and ``include_test`` of
    the results."""
    workspace = _request_scope(write=True)
    params = app.current_event.query_string_parameters or {}
    include_test = _include_test(params) == 'true'
    filters = _view_filters(params)
    others = _compared_ids(form_id, params.get('with'))
    if params.get('by') and not others:
        raise ValidationError('by splits the forms compared: name at least one other form in with (a form split on its '
                              'own is its report\'s segments)', code='group_by_invalid')
    base = _form_side(form_id, workspace, filters, include_test)
    by = parse_group_by(base.definition, params['by'], hidden_only=True) if params.get('by') else None
    sides = [_form_side(other, workspace, filters, include_test) for other in others]
    return {'success': True, 'form_id': form_id, 'include_test': include_test, **compare(base, sides, by)}


MAX_RESPONSES_PAGE = 100
DEFAULT_RESPONSES_PAGE = 50
#: A CSV export holds at most this many responses (the newest), within API Gateway's answer size.
MAX_CSV_RESPONSES = 10_000


def _response_view(row: ResultRow) -> dict[str, Any]:
    out: dict[str, Any] = {'response_id': row.response_id, 'is_test': row.is_test, 'created_at': row.created_at,
                           'revision': row.revision, 'language': row.language, 'ending_id': row.ending_id,
                           'answers': dict(row.answers), 'hidden': dict(row.hidden), 'path': list(row.path)}
    if row.sentiment:
        out['sentiment'] = row.sentiment
    if not row.is_test:
        out['feedback_id'] = row.response_id
    return out


def _page_offset(params: Mapping[str, Any]) -> int:
    raw = params.get('cursor') or '0'
    if not str(raw).isdigit() or len(str(raw)) > 7:
        raise ValidationError('cursor must be the next_cursor of the previous page')
    return int(raw)


def _csv_options(params: Mapping[str, Any]) -> tuple[str, bool]:
    """``layout`` (``familiar``, the default since 7.61.00, or ``detailed``) and ``ids`` (``true`` / ``false``)."""
    layout = str(params.get('layout') or 'familiar')
    if layout not in fcsv.LAYOUTS:
        raise ValidationError(f'layout must be one of: {", ".join(fcsv.LAYOUTS)}')
    ids = str(params.get('ids') or 'false').lower()
    if ids not in ('true', 'false'):
        raise ValidationError('ids must be true or false')
    return layout, ids == 'true'


def _responses_csv(form: Mapping[str, Any], form_id: str, definition: Mapping[str, Any], rows: list[ResultRow],
                   options: tuple[str, bool]) -> Response:
    """The CSV file of ``rows`` (shared/forms_v2_csv.py) in ``options``' layout, as a download."""
    layout, ids = options
    body = fcsv.detailed_csv(definition, rows) if layout == 'detailed' else \
        fcsv.familiar_csv(definition, rows, tags=[str(tag) for tag in fv2.plain(form.get('tags') or [])], ids=ids)
    name = fcsv.csv_filename(form.get('name'), form_id, datetime.now(UTC), layout)
    return Response(status_code=200, content_type='text/csv; charset=utf-8', body=body,
                    headers={'Content-Disposition': f'attachment; filename="{name}"'})


@app.get("/feedback-forms/<form_id>/responses")
@tracer.capture_method
def get_form_responses(form_id: str):
    """The form's responses, newest first (docs/feedback-forms.md "Responses"), with the same access and filters as
    the results: their answers (contact details included, as the submissions route shows text), hidden values,
    language, ending, revision and ``is_test``.

    ``include_test``: ``false`` (default), ``true``, or ``only`` (the Test tab's list). Pages of ``limit`` (default
    50, at most 100) from ``cursor`` (the previous page's ``next_cursor``); ``format=csv`` answers every matching
    response (the newest 10,000) as a CSV file instead, in ``layout`` ``familiar`` (the default since 7.61.00, with
    ``ids=true`` a second header row of ids) or ``detailed`` (7.55.00's).
    """
    workspace = _request_scope(write=True)
    params = app.current_event.query_string_parameters or {}
    include_test = _include_test(params, allow_only=True)
    filters = _view_filters(params)
    csv_out = params.get('format') == 'csv'
    csv_options = _csv_options(params) if csv_out else ('familiar', False)
    limit = validate_limit(params.get('limit'), default=DEFAULT_RESPONSES_PAGE, max_val=MAX_RESPONSES_PAGE)
    offset = _page_offset(params)
    form = _load_form_for_query(form_id, 'Failed to fetch form responses', workspace)
    definition = _definition(form)
    rows = filter_rows(_view_rows(form, form_id, workspace, definition, include_test), **filters)
    rows.sort(key=lambda row: row.created_at, reverse=True)
    if csv_out:
        return _responses_csv(form, form_id, definition, rows[:MAX_CSV_RESPONSES], csv_options)
    page = rows[offset:offset + limit]
    more = offset + limit < len(rows)
    return {'success': True, 'form_id': form_id, 'revision': fv2.revision_of(form), 'total': len(rows),
            'responses': [_response_view(row) for row in page],
            'next_cursor': str(offset + limit) if more else None}


@app.delete("/feedback-forms/<form_id>/responses")
@tracer.capture_method
def delete_test_responses(form_id: str):
    """Delete the form's TEST responses and the test link's funnel counters (``?test=true`` is required). Test responses are kept
    until an admin or the form's creator deletes them (the owner's decision of 2026-11-18): anyone else is a 403
    (``_may_delete_test_responses``). A real response is a feedback item of the lake: it is never deleted here
    (TENETS.md D5).

    Every delete that removes a row is recorded first (TENETS.md D4), as a form's delete is, and a record that cannot
    be written deletes nothing: a workspace's form in ``AUDIT#WS#{ws}`` of voc-workspaces (``_record_form_delete``:
    kind ``feedback_form_test_responses``, the actor's sub, the form id, ``count``, the time), a deployment form in
    ``AUDIT#delete`` of voc-aggregates (shared/delete_audit.py ``record_delete_first``: the same kind, the form id, the
    actor ``{sub, kind}``, ``count``, the time). ``count`` is the test responses removed; never their content. A delete
    of nothing records nothing, and each delete is its own row."""
    scope = _request_scope(write=True)
    params = app.current_event.query_string_parameters or {}
    if params.get('test') != 'true':
        raise ValidationError('Only test responses can be deleted here: send ?test=true')
    if scope is None:
        _refuse_a_workspaces_id(form_id, 'Failed to delete test responses')
    form = _read_form(form_id, 'Failed to delete test responses', scope)
    if not _may_delete_test_responses(form, fresh=True):
        raise AuthorizationError(TEST_RESPONSES_DELETERS, code='test_responses_admin_or_creator')
    try:
        responses = _test_response_keys(form_id, scope)
        # The test link's funnel counters; its visit rows (FORMSESSION#) expire by their own ttl.
        funnel = _row_keys(scope, f'{_FUNNEL_PREFIX}{form_id}#', test_only=True)
        if responses or funnel:
            # Recorded first, like a form's delete (TENETS.md D4): a row that cannot be written deletes nothing.
            if scope is not None:
                _record_form_delete(scope, form_id, kind=TEST_RESPONSES_DELETE_KIND, count=len(responses))
            else:
                record_delete_first(_forms_table(), kind=TEST_RESPONSES_DELETE_KIND, target={'form_id': form_id},
                                    actor=actor_from_event(app.current_event.raw_event), count=len(responses))
        deleted = _delete_keys(scope, responses)
        _delete_keys(scope, funnel)
    except Exception as e:
        logger.exception(f"Error deleting the test responses of form {form_id}: {type(e).__name__}")
        raise ServiceError('Failed to delete test responses') from e
    return {'success': True, 'form_id': form_id, 'deleted': deleted}


# ============================================
# Beacons: the widget's open and step events (D6)
# ============================================
#
# Two signals per respondent at most, on their OWN public route, ``POST …/events`` (``record_form_event``), with its
# own throttle (lib/stacks/api-gateway.ts) and model (lib/stacks/api-request-models.ts ``FeedbackFormEvent``), so a
# beacon never spends the submit route's limit, which is for responses only (7.55.00's AI review, round 2). A
# workspace's form is found by its lookup row, exactly as on submit (``_public_form``), and its rows are written in
# that workspace's forms partition (``_forms(scope)``). Both are sent with ``navigator.sendBeacon`` (a text/plain
# body: no preflight), never an answer:
#
# * the OPEN: ``{event: {kind: 'opened', session, revision?}, test?}``, once per page load of a form the widget shows
#   (never in the editor's preview). Not on the config read: a public GET only reads;
# * the furthest question a respondent reached when they LEFT without submitting: ``{event: {kind: 'left',
#   question_id, session, revision?}, test?}`` on ``pagehide`` or when the page is hidden.
#
# What is kept, and for how long (TENETS.md D2):
#
# * the funnel's record is a BOUNDED set of counters, one row per form per day (``FORMFUNNEL#{form_id}#{day}``,
#   ``#test`` for the test link's): ``opened``, and ``left:{question_id}`` per question. Kept without expiry; they go
#   with the form's delete (the test link's with its test responses'). The results read these rows only;
# * the dedupe of one visit is a short-lived row per session (``FORMSESSION#{form_id}#{session}``, ``ttl`` 7 days
#   after its last write): the question its ``left`` is counted at, the day it is counted on, and whether the visit
#   then submitted. A later ``left`` further on MOVES the count (the old question -1, the new +1, on the same day's
#   row); a response with the same ``session`` takes it back (-1) and closes the row, so a respondent who switched tabs,
#   then answered, counts once, as a response. A row past its ``ttl`` dedupes nothing: a response more than 7 days
#   after its ``left`` leaves that ``left`` counted. Never a person's data: the session id is the widget's random id.
#
# The counter and the visit row are two writes, best effort: one that fails costs a count (the funnel is advisory).

_FUNNEL_PREFIX = 'FORMFUNNEL#'
_SESSION_PREFIX = 'FORMSESSION#'
#: How long a visit's dedupe row lives after its last write.
SESSION_ROW_TTL_SECONDS = 7 * 24 * 3600
_EVENT_KINDS = ('left', 'opened')
#: The fields each beacon kind carries (``revision`` optional).
_EVENT_FIELDS = {'left': {'kind', 'question_id', 'session', 'revision'}, 'opened': {'kind', 'session', 'revision'}}


def _validated_event(body: Mapping[str, Any]) -> dict[str, Any]:
    """The beacon of an events body (``event`` and at most ``test``), checked before any read."""
    unknown = sorted(str(key)[:40] for key in body if key not in {'event', 'test'})
    if unknown:
        raise ValidationError(f'an event carries only event and test, not {", ".join(unknown[:5])}',
                              code='submission_invalid')
    event = body.get('event')
    kind = event.get('kind') if isinstance(event, Mapping) else None
    if not isinstance(event, Mapping) or kind not in _EVENT_KINDS:
        raise ValidationError('event must be {kind: left, question_id, session, revision?} or {kind: opened, session, '
                              'revision?}', code='submission_invalid')
    if not set(event) <= _EVENT_FIELDS[kind]:
        raise ValidationError(f"a {kind} event carries only {', '.join(sorted(_EVENT_FIELDS[kind]))}",
                              code='submission_invalid')
    _validate_optional_string(body, 'test', MAX_TEST_TOKEN_CHARS)
    question_id = event.get('question_id')
    if kind == 'left' and not (isinstance(question_id, str) and fv2.QUESTION_ID.fullmatch(question_id)):
        raise ValidationError('a left event names the question_id the respondent left at', code='submission_invalid')
    revision = event.get('revision')
    if revision is not None and (isinstance(revision, bool) or not isinstance(revision, int) or revision < 1):
        raise ValidationError('event.revision must be a whole number from 1', code='submission_invalid')
    session = event.get('session')
    if not (isinstance(session, str) and fresp.SESSION_ID.fullmatch(session)):
        raise ValidationError('event.session must be 8 to 64 letters, digits, _ or -', code='submission_invalid')
    return {'kind': kind, 'session': session, **({'question_id': question_id} if kind == 'left' else {})}


@app.post("/feedback-forms/<form_id>/events")
@tracer.capture_method
def record_form_event(form_id: str):
    """The widget's funnel beacons (public, like submit; its own throttle and model; a workspace's form by its lookup
    row, never the request). The same form checks as the submit: a disabled form takes none (``400 form_off``) unless
    the body carries a valid test token (``403 test_link_invalid`` for a wrong one). Bounded before the form read:
    junk costs no DynamoDB call."""
    form_id = _public_form_id(form_id)
    event_body = _public_body(code='submission_invalid')
    event = _validated_event(event_body)
    form_id, form, routed = _public_form(form_id, 'Failed to load form configuration')
    scope = routed.scope if routed is not None else None
    return _record_event(form_id, form, scope, _open_form(form, event_body), event)


def _today() -> str:
    """The UTC day a funnel count lands on (``YYYY-MM-DD``, the date part of ``now_iso``)."""
    return now_iso()[:10]


def _session_key(form_id: str, scope: WorkspaceScope | None, session: str) -> dict[str, str]:
    return {'pk': _forms_partition(scope), 'sk': f'{_SESSION_PREFIX}{form_id}#{session}'}


def _session_ttl() -> int:
    return int(datetime.now(UTC).timestamp()) + SESSION_ROW_TTL_SECONDS


def _update_visit(form_id: str, scope: WorkspaceScope | None, session: str, sets: str, condition: str,
                  values: Mapping[str, Any], names: Mapping[str, str] | None = None) -> dict[str, Any] | None:
    """Write a visit's dedupe row (``SET`` ``sets``, its ``ttl`` renewed) if ``condition`` holds; the row as it was
    before (``{}`` when new), or None when the condition failed or the write did (logged: best effort)."""
    try:
        return _forms(scope).update_item(
            _session_key(form_id, scope, session), UpdateExpression=f'SET {sets}, form_id = :form, #ttl = :ttl',
            ConditionExpression=condition, ExpressionAttributeNames={'#ttl': 'ttl', **(names or {})},
            ExpressionAttributeValues={':form': form_id, ':ttl': _session_ttl(), **values}, ReturnValues='ALL_OLD',
        ).get('Attributes') or {}
    except (ClientError, BotoCoreError) as e:
        if not _is_conditional_check_failure(e):  # a failed condition is the dedupe itself
            logger.warning(f"Could not write a funnel visit of form {form_id}: {type(e).__name__}")
        return None


def _record_event(form_id: str, form: Mapping[str, Any], scope: WorkspaceScope | None, test_mode: str | None,
                  event: Mapping[str, Any]) -> dict:
    """Record one beacon (nothing for the test link's ``drop``): an ``opened`` adds 1 to the day's ``opened``; a
    ``left`` updates its visit's row, which keeps the furthest question (by the current order; a question the form no
    longer has is not a funnel step), and moves the day's ``left:`` count to it. Best effort: a count is never worth
    a widget error."""
    out = {'success': True, **({'test': test_mode} if test_mode else {})}
    if test_mode == 'drop':
        return out
    if event['kind'] == 'opened':
        _count_event(form_id, scope, {'opened': 1}, test_mode, _today())
        return out
    order = [q.get('id') for q in _definition(form).get('questions') or []]
    if event['question_id'] not in order:
        return out
    # A failed condition: the visit submitted, or its furthest question stands.
    before = _update_visit(
        form_id, scope, event['session'],
        'question_id = :qid, #pos = :pos, #day = if_not_exists(#day, :day), is_test = :test',
        'attribute_not_exists(submitted) AND (attribute_not_exists(#pos) OR #pos < :pos)',
        {':qid': event['question_id'], ':pos': order.index(event['question_id']), ':day': _today(),
         ':test': bool(test_mode)}, {'#pos': 'position', '#day': 'day'})
    if before is None:
        return out
    moves = {f"{LEFT_COUNTER_PREFIX}{event['question_id']}": 1}
    if isinstance(before.get('question_id'), str):
        moves[f"{LEFT_COUNTER_PREFIX}{before['question_id']}"] = -1
    _count_event(form_id, scope, moves, test_mode, str(before.get('day') or _today()))
    return out


def _close_session(form_id: str, scope: WorkspaceScope | None, session: object, test_mode: str | None) -> None:
    """A response of the visit ``session`` (a real one, or the test link's ``tag``): close its row, so no later
    ``left`` counts, and take back the ``left`` it had counted. Best effort, after the response is kept."""
    if not isinstance(session, str) or not fresp.SESSION_ID.fullmatch(session) or test_mode == 'drop':
        return
    # A failed condition: the visit had submitted already.
    before = _update_visit(form_id, scope, session, 'submitted = :yes, is_test = :test',
                           'attribute_not_exists(submitted)', {':yes': True, ':test': bool(test_mode)})
    if before is not None and isinstance(before.get('question_id'), str) and isinstance(before.get('day'), str):
        _count_event(form_id, scope, {f"{LEFT_COUNTER_PREFIX}{before['question_id']}": -1}, test_mode,
                     str(before['day']))


def _count_event(form_id: str, scope: WorkspaceScope | None, counters: Mapping[str, int], test_mode: str | None,
                 day: str) -> None:
    """Add each of ``counters`` (a name and its delta) to the form's funnel row of ``day`` (the test link's own row).
    Best effort: a count is never worth a widget error."""
    names = {'#day': 'day', **{f'#c{index}': name for index, name in enumerate(counters)}}
    values: dict[str, Any] = {':form': form_id, ':day': day, ':test': bool(test_mode),
                              **{f':c{index}': delta for index, delta in enumerate(counters.values())}}
    adds = ', '.join(f'#c{index} :c{index}' for index in range(len(counters)))
    try:
        _forms(scope).update_item(
            {'pk': _forms_partition(scope), 'sk': f"{_FUNNEL_PREFIX}{form_id}#{day}{'#test' if test_mode else ''}"},
            UpdateExpression=f'ADD {adds} SET form_id = :form, #day = :day, is_test = :test',
            ExpressionAttributeNames=names, ExpressionAttributeValues=values,
        )
    except (ClientError, BotoCoreError) as e:
        logger.warning(f"Could not count a funnel event for form {form_id}: {type(e).__name__}")


# ============================================
# Lambda Handler
# ============================================

# SnapStart (lib/utils/snapstart.ts): the DynamoDB resource, its tables and the SQS
# client are built at import, so they are in the snapshot already. Before the
# snapshot, also build every route's request model (3.00.00 capacity: the first call
# after a restore ran at 93 % CPU p95); reseed after restore.
register_snapshot_hooks(api_route_warmer(app))


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    null_origin_cors.reset()
    try:
        return null_origin_cors.apply(event, app.resolve(event, context))
    finally:
        null_origin_cors.reset()
