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
* the public widget routes (config, iframe, submit) never read the header: they look the form id up
  (``_public_form``). A form with a lookup row is its workspace's (the row's workspace, which must be ``active``):
  its config is served from the workspace's form, and a submission is queued with that ``workspace_id``
  (``workspace_payload``, after every other field) and its raw copy kept under ``ws/{ws}/raw/feedback_form/``. A form
  without one is a deployment form, exactly as before; a row naming a malformed, unknown or ``deleting`` workspace
  answers the same 404 as an unknown id.
"""
import json
import math
import os
import re
import secrets
import uuid
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeGuard

from aws_lambda_powertools.event_handler import Response
from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

from shared import category_access, feedback_category, null_origin_cors, prototype_pins
from shared.api import api_handler, create_api_resolver, get_caller_subject, get_raw_categories_config, validate_limit
from shared.audit_rows import put_new_audit_row
from shared.aws import get_dynamodb_resource, get_sqs_client
from shared.category_gate import scope_for_event
from shared.dynamo_paging import iter_query
from shared.exceptions import (
    ApiError,
    AuthorizationError,
    ConfigurationError,
    NotFoundError,
    ServiceError,
    ValidationError,
)
from shared.feedback_form_participants import record_response, resolve_participant
from shared.feedback_form_raw import FEEDBACK_FORM_SOURCE, archive_submission
from shared.feedback_partitions import source_partition
from shared.form_theme import validate_theme
from shared.ingest_tables import table_view
from shared.onboarding import FEEDBACK_FORM_PK
from shared.scoped_query import query_partition
from shared.tables import configured_table, get_workspaces_table
from shared.workspace import EDITING_ROLES, audit_key, audit_sort_key
from shared.workspace_plugin_settings import hold_workspace_ingestion
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

aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None
feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None



def _preset_routing(form: dict) -> tuple[str, str]:
    """The form's category routing as category NAMES (a pre-5.25 form may hold config ids).

    This is the public, unauthenticated submit path, so the config comes from the
    warm-container cache (5 minutes, ``shared.api.get_raw_categories_config``), and a
    config that cannot be read keeps the stored values: a submission is never lost
    over a mapping that only rewrites a legacy id.
    """
    category = str(form.get('category') or '')
    subcategory = str(form.get('subcategory') or '')
    if not category:
        return '', subcategory
    return feedback_category.routed_names(get_raw_categories_config(aggregates_table), category, subcategory)

def _forms_table() -> 'Table':
    """The aggregates table, where form configs live; ConfigurationError when unset."""
    if aggregates_table is None:
        raise ConfigurationError('AGGREGATES_TABLE not configured')
    return aggregates_table


def _forms_partition(scope: WorkspaceScope | None) -> str:
    """The partition of the form configs: ``FEEDBACK_FORM`` (shared/onboarding.py ``FEEDBACK_FORM_PK``, its one
    home), or a workspace's ``WS#{ws}#FEEDBACK_FORM``."""
    return scope.key(FEEDBACK_FORM_PK) if scope is not None else FEEDBACK_FORM_PK


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

# Kiro Light palette (docs/kiro-design-system.md): accent, page background,
# strong text. White on the accent is 4.64:1 (WCAG AA); the old blue default
# was 3.68:1 and failed axe colour-contrast on the widget's start button (E2E F6).
# Mirrored by frontend/mock-forms.js and the widget's own KIRO defaults.
DEFAULT_THEME = {
    'primary_color': '#8e48ff',
    'background_color': '#ffffff',
    'text_color': '#19161d',
    'border_radius': '8px'
}

DEFAULT_FORM_CONFIG = {
    'name': 'New Feedback Form',
    'enabled': False,
    'title': 'Share Your Feedback',
    'description': 'We value your opinion.',
    'question': 'How was your experience?',
    'placeholder': 'Tell us about your experience...',
    'rating_enabled': True,
    'rating_type': 'stars',
    'rating_max': 5,
    'submit_button_text': 'Submit Feedback',
    'success_message': 'Thank you for your feedback!',
    'theme': DEFAULT_THEME,
    'collect_email': False,
    'collect_name': False,
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
UPDATABLE_FIELDS = [
    'name', 'enabled', 'title', 'description', 'question', 'placeholder',
    'rating_enabled', 'rating_type', 'rating_max', 'submit_button_text',
    'success_message', 'theme', 'collect_email', 'collect_name',
    'custom_fields', 'category', 'subcategory', 'project_id', 'document_id',
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
DEFAULT_RATING_MAX = 5


def _rating_max(item: dict) -> int:
    """The stored `rating_max` as an int in 1..MAX_SUBMISSION_RATING, else the default.

    `PUT /feedback-forms/<id>` stores whatever JSON the caller sent, so the value
    read back may be a string, a list, a bool…; the public config route must not
    500 on it.
    """
    raw = item.get('rating_max', DEFAULT_RATING_MAX)
    if isinstance(raw, bool):
        return DEFAULT_RATING_MAX
    try:
        value = Decimal(str(raw))
    except (InvalidOperation, ValueError):
        return DEFAULT_RATING_MAX
    if not value.is_finite():
        return DEFAULT_RATING_MAX
    return min(max(int(value), 1), MAX_SUBMISSION_RATING)


def _validated_submission_text(body: dict) -> str:
    """The stripped feedback text, or a 400 when absent, not a string, or too long."""
    return validated_text(body.get('text'), 'Feedback text', MAX_SUBMISSION_TEXT_CHARS, required=True)


def _validate_optional_string(body: dict, field: str, max_chars: int) -> None:
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


def _validate_form_labels(body: dict) -> None:
    """Normalise `dimension_defaults` / `tags` in a create/update body in place (400 when invalid)."""
    normalise_label_fields(_forms_table(), body)

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


def build_form_item(body: dict, form_id: str | None = None, scope: WorkspaceScope | None = None) -> dict:
    """Build DynamoDB item from request body with defaults (a workspace's form under its own partition).

    Validates the link fields here rather than leaving it to the caller: this is
    the only way a new record is constructed, so a future second caller cannot
    reach the table with an unvalidated link by forgetting a line.
    """
    validate_link_fields(body)
    validate_theme(body)
    now = now_iso()
    fid = form_id or new_form_id(scope)

    item = {
        **_form_key(fid, scope),
        'form_id': fid,
        'brand_name': BRAND_NAME,
        'created_at': now,
        'updated_at': now,
    }

    # Apply defaults, then override with provided values
    for field, default in DEFAULT_FORM_CONFIG.items():
        item[field] = body.get(field, default)

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
    """

    def __init__(self):
        self.total_rating = 0
        self.rating_count = 0

    def add(self, item: dict) -> None:
        rating = item.get('rating')
        if rating:
            self.total_rating += float(rating)
            self.rating_count += 1

    def stats(self, total_submissions: int) -> dict:
        avg_rating = round(self.total_rating / self.rating_count, 2) if self.rating_count > 0 else None
        return {
            'total_submissions': total_submissions,
            'avg_rating': avg_rating,
            'rating_count': self.rating_count,
        }


def item_to_form(item: dict) -> dict:
    """Convert DynamoDB item to the authenticated form response: the public widget
    projection (`item_to_widget_config`) plus the fields only signed-in callers see.

    The public projection is the base and never the other way round, so a field added
    here stays out of the unauthenticated `GET /feedback-forms/<id>/config`."""
    return {
        'form_id': item.get('form_id', ''),
        'name': item.get('name', ''),
        **item_to_widget_config(item),
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
        'created_at': item.get('created_at', ''),
        'updated_at': item.get('updated_at', ''),
    }


def item_to_widget_config(item: dict) -> dict:
    """Convert DynamoDB item to the PUBLIC widget config response.

    The narrower projection `item_to_form` is built on, never "item_to_form minus a
    few keys": `GET /feedback-forms/<id>/config` is unauthenticated and fetched by
    the widget from the customer's own website, so every field here is one someone
    chose to publish. A field added to `item_to_form` does not reach it; one added
    here is published, on purpose.

    Mirrors `FeedbackFormConfig` in frontend/src/api/types.ts — the rendering
    fields the widget reads plus `enabled` and `brand_name`.
    """
    return {
        'enabled': item.get('enabled', False),
        'title': item.get('title', ''),
        'description': item.get('description', ''),
        'question': item.get('question', ''),
        'placeholder': item.get('placeholder', ''),
        'rating_enabled': item.get('rating_enabled', True),
        'rating_type': item.get('rating_type', 'stars'),
        'rating_max': _rating_max(item),
        'submit_button_text': item.get('submit_button_text', ''),
        'success_message': item.get('success_message', ''),
        'theme': item.get('theme', {}),
        'collect_email': item.get('collect_email', False),
        'collect_name': item.get('collect_name', False),
        'custom_fields': item.get('custom_fields', []),
        'brand_name': item.get('brand_name', ''),
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
    access = scope_for_event(app.current_event.raw_event, aggregates_table)
    form_ids_by_pk: dict[str, list[str]] = {}
    for item in items:
        form_id = item.get('form_id')
        if isinstance(form_id, str) and form_id:
            form_ids_by_pk.setdefault(_form_source_pk(item, scope), []).append(form_id)

    tallies = {fid: _RatingTally() for ids in form_ids_by_pk.values() for fid in ids}
    counts = dict.fromkeys(tallies, 0)
    for source_pk, form_ids in form_ids_by_pk.items():
        for chunk in _chunks(form_ids, _MAX_IN_OPERANDS):
            values = {f':sc{i}': f'form_{fid}' for i, fid in enumerate(chunk)}
            query_kwargs: dict[str, Any] = {
                'FilterExpression': f"source_channel IN ({', '.join(values)})",
                'ExpressionAttributeValues': values,
                # `category` + `source_platform`: both access rules read them (admits_item).
                'ProjectionExpression': 'feedback_id, rating, category, source_platform, source_channel',
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
        response = query_partition(scope, _forms_table(), 'pk', _forms_partition(scope), ConsistentRead=True)
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


@app.post("/feedback-forms")
@tracer.capture_method
def create_form():
    """Create a new feedback form (in a workspace: its form, and the lookup row that routes its public id there)."""
    scope = _request_scope(write=True)
    if scope is not None:
        # A workspace form exists to take submissions into its workspace, which the ingestion hold refuses: while it
        # is on, creating one answers the same 409 (shared/workspace_plugin_settings.py), so no form is embedded that
        # would refuse every visitor's feedback.
        hold_workspace_ingestion()
    body = json_object_body(app)
    _validate_form_labels(body)
    # Link fields are validated inside build_form_item, structurally.
    item = build_form_item(body, scope=scope)

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


@app.put("/feedback-forms/<form_id>")
@tracer.capture_method
def update_form(form_id: str):
    """Update a feedback form (in a workspace: only one of its own, 404 otherwise)."""
    scope = _request_scope(write=True)
    body = json_object_body(app)
    validate_link_fields(body)
    validate_theme(body)
    _validate_form_labels(body)
    now = now_iso()

    # Build update expression dynamically
    update_parts = []
    expr_names = {'#updated_at': 'updated_at'}
    expr_values = {':updated_at': now}

    for field in UPDATABLE_FIELDS:
        if field in body:
            update_parts.append(f'#{field} = :{field}')
            expr_names[f'#{field}'] = field
            expr_values[f':{field}'] = body[field]

    if not update_parts:
        raise ValidationError('No fields to update')

    update_parts.append('#updated_at = :updated_at')

    if scope is None:
        _refuse_a_workspaces_id(form_id, 'Failed to update form')
    # Only an existing form is updated, on either path (never an upsert: a stub row would be a form nobody created,
    # and in a workspace one without a lookup row, which no public route could reach).
    try:
        response = _forms(scope).update_item(
            _form_key(form_id, scope),
            UpdateExpression='SET ' + ', '.join(update_parts),
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
            ReturnValues='ALL_NEW',
            ConditionExpression='attribute_exists(sk)',
        )
    except Exception as e:
        if _is_conditional_check_failure(e):
            raise NotFoundError('Form not found') from e
        logger.exception(f"Error updating form: {e}")
        raise ServiceError('Failed to update form') from e
    return {'success': True, 'form': item_to_form(response.get('Attributes', {}))}


FORM_DELETED = 'form_deleted'


def _record_form_delete(scope: WorkspaceScope, form_id: str) -> None:
    """The ``AUDIT#WS#{ws}`` row of a workspace form's delete, written before it (a new row, never an overwrite)."""
    at = now_iso()
    put_new_audit_row(configured_table(get_workspaces_table(), 'Workspaces'), {
        'pk': audit_key(scope.ws), 'sk': audit_sort_key(at), 'kind': FORM_DELETED,
        'actor': get_caller_subject(app.current_event.raw_event), 'form_id': form_id, 'at': at})


@app.delete("/feedback-forms/<form_id>")
@tracer.capture_method
def delete_form(form_id: str):
    """Delete a feedback form (in a workspace: its form, then its lookup row, only when the row names it).

    A workspace's delete is recorded first (TENETS.md D5: a workspace delete is recorded), in its audit partition
    ``AUDIT#WS#{ws}`` (kind ``form_deleted``, the actor's sub, the form id, the time; under the audit-row guard, so no
    role can change or remove it): a row that cannot be written deletes nothing, and the row records the attempt. Only
    a form the workspace holds is recorded and deleted: an unknown id, or another workspace's, is the 404, with no
    audit row (the deployment's delete stays idempotent).
    """
    scope = _request_scope(write=True)
    if scope is None:
        _refuse_a_workspaces_id(form_id, 'Failed to delete form')
    else:
        _read_form(form_id, 'Failed to delete form', scope)  # 404 for a form this workspace does not hold
    try:
        if scope is not None:
            _record_form_delete(scope, form_id)
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
    return {'success': True, 'pin_id': item['pin_id'],
            'message': form.get('success_message', 'Thanks — your pin was saved.')}


@app.get("/feedback-forms/<form_id>/config")
@tracer.capture_method
def get_form_config_by_id(form_id: str):
    """Get form config for widget (public endpoint; a workspace's form by its lookup row, never the request)."""
    _form_id, item, _routed = _public_form(form_id, 'Failed to get form configuration')
    # Narrower projection than item_to_form on purpose: this route is public.
    return {'success': True, 'config': item_to_widget_config(item)}


@app.post("/feedback-forms/<form_id>/submit")
@tracer.capture_method
def submit_form_feedback(form_id: str):
    """Submit feedback to a specific form.

    A workspace's form (its lookup row's workspace, never the request's) queues the submission with that
    ``workspace_id`` (``workspace_payload``, after every other field) and keeps its raw copy under
    ``ws/{ws}/raw/feedback_form/``. Participant asks and prototype pins are the deployment's (phase 3): only a
    deployment form attributes an answer to an ask or takes the pin path.
    """
    form_id = _public_form_id(form_id)
    # Public route: only unparseable JSON (once a 500) changes, to a 400. The
    # `or {}` and the message below are this route's long-standing contract with
    # embedded widgets and are kept exactly as they were.
    body = json_body_value(app) or {}
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object')

    # Bounded before the form read: junk costs no DynamoDB call, and nothing
    # oversized reaches the queue (and the Bedrock call behind it). #222.
    text = _validated_submission(body)
    widget_dimensions = _widget_dimensions(body)
    form_id, form, routed = _public_form(form_id, 'Failed to load form configuration')
    scope = routed.scope if routed is not None else None
    if scope is not None:
        # A workspace form's submission is ingestion into that workspace: held, like enabling a plugin and every run in
        # a workspace, while per-workspace ingestion is off (409, before anything is archived, anchored or queued).
        hold_workspace_ingestion()
    if not form.get('enabled', False):
        raise ValidationError('This form is not enabled')
    # Defence in depth: no workspace form carries this form_type (only the document generator sets it, on
    # deployment forms), so `scope is None` changes nothing today; it keeps a pin out of a workspace if one ever does.
    if scope is None and form.get('form_type') == prototype_pins.FORM_TYPE_PROTOTYPE_PIN:
        # A standalone prototype is sandboxed to an opaque origin, so its widget
        # posts with `Origin: null`; only a pin form's answer echoes that
        # (shared/null_origin_cors.py). Every other form keeps the resolver's CORS.
        null_origin_cors.accept()
        return _submit_prototype_pin(form, body)

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
    }
    if form.get('collect_email') and body.get('email'):
        # Lower-cased by apply_source_policy below, so an erasure by email matches.
        metadata['submitter_email'] = body['email']
    if form.get('collect_name') and body.get('name'):
        metadata['submitter_name'] = body['name']
    if body.get('custom_fields'):
        metadata['custom_fields'] = body['custom_fields']
    # A participant ask's link (shared/feedback_form_participants.py): ids only, or nothing. Asks are the
    # deployment's (phase 3), so a workspace's form attributes none.
    participant = resolve_participant(body) if scope is None else None
    if participant:
        metadata['participant'] = participant

    preset_category, preset_subcategory = _preset_routing(form)
    normalized_record = {
        'id': feedback_id,
        'source_platform': FEEDBACK_FORM_SOURCE,
        'source_channel': f'form_{form_id}',
        'text': text,
        'rating': body.get('rating'),
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
    # The feedback_form source profile's PII policy, before anything is archived or
    # queued. Strict: an unreadable policy answers 503 (the widget can retry) rather
    # than archiving or queueing under the allow default.
    profile = cached_source_profile_strict(FEEDBACK_FORM_SOURCE)
    policed = apply_source_policy(normalized_record, profile)
    if policed is None:
        raise ValidationError('Feedback text is required')
    # The body as the widget sent it, kept only when the profile permits a raw copy
    # (shared/feedback_form_raw.py); a failed write is logged and the submission queued.
    raw_uri = archive_submission(form_id, form, feedback_id, body, (text, widget_dimensions), profile, now,
                                 scope=scope)
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
    logger.info(f"Submitted feedback to form {form_id}: {feedback_id}")
    return {
        'success': True,
        'feedback_id': feedback_id,
        'message': form.get('success_message', 'Thank you for your feedback!')
    }


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


# A participant ask's link opens this page with ``?r=<response token>``
# (shared/feedback_form_participants.py). Only THIS page reads it (the widget embedded on a
# customer's own site never looks at that site's query), hands it to the widget, which posts it
# as ``participant_token``, and drops it from the address so neither ``page_url`` nor a Referer
# carries it.
_ASK_LINK_JS = (
    "VoCFeedbackForm.participantToken = (function () { "
    "var token = new URLSearchParams(window.location.search).get('r'); "
    "if (token) { history.replaceState(null, '', window.location.pathname); } "
    "return token; })();"
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
    # Existence gate only (a workspace's form by its lookup row); the page is a function of the id and host.
    form_id, _form, _routed = _public_form(form_id, 'Failed to load form')

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
    })
    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Feedback Form</title>
  <style>
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{ font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; }}
    #voc-feedback-form {{ min-height: 100vh; }}
  </style>
</head>
<body>
  <main id="voc-feedback-form"></main>
  <script>
  {get_widget_js()}
  {_ASK_LINK_JS}
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
    scope = scope_for_event(app.current_event.raw_event, aggregates_table)

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
    scope = scope_for_event(app.current_event.raw_event, aggregates_table)

    try:
        ratings = _RatingTally()
        submission_count = 0

        query_kwargs: dict[str, Any] = {
            'FilterExpression': 'source_channel = :sc',
            'ExpressionAttributeValues': {':sc': source_channel},
            # `category` + `source_platform` so a restricted caller's count covers only
            # what they can see: both access rules read them (admits_item).
            'ProjectionExpression': 'feedback_id, rating, category, source_platform',
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
