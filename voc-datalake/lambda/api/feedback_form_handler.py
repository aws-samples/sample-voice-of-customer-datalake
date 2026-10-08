"""
VoC Feedback Form API Lambda
Handles: /feedback-forms/* - multiple forms management
"""
import json
import math
import os
import re
import uuid
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import TYPE_CHECKING, Any

from aws_lambda_powertools.event_handler import Response
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared import category_access, prototype_pins
from shared.api import api_handler, create_api_resolver, validate_limit
from shared.aws import get_dynamodb_resource, get_sqs_client
from shared.category_gate import scope_for_event
from shared.exceptions import (
    ApiError,
    ConfigurationError,
    NotFoundError,
    ServiceError,
    ValidationError,
)

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table

# Shared module imports
from shared.logging import logger, metrics, tracer
from shared.producer_labels import clean_dimensions, message_labels, normalise_label_fields
from shared.request_body import json_body_value, json_object_body
from shared.snapstart import api_route_warmer, register_snapshot_hooks
from shared.source_policy import apply_source_policy
from shared.source_profiles import cached_source_profile_strict

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


def _forms_table() -> 'Table':
    """The aggregates table, where form configs live; ConfigurationError when unset."""
    if aggregates_table is None:
        raise ConfigurationError('AGGREGATES_TABLE not configured')
    return aggregates_table


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
# Ids this service mints: `str(uuid4())[:8]` (8 hex chars, build_form_item) and
# `pf_` + 16 hex (shared/prototype_pins.pin_form_id). The pattern is WIDER than
# both on purpose so hand-seeded or imported ids such as `website-form` or
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
    text = body.get('text')
    if text is None:
        text = ''
    if not isinstance(text, str):
        raise ValidationError('Feedback text must be a string')
    text = text.strip()
    if not text:
        raise ValidationError('Feedback text is required')
    if len(text) > MAX_SUBMISSION_TEXT_CHARS:
        raise ValidationError(
            f'Feedback text must be at most {MAX_SUBMISSION_TEXT_CHARS} characters'
        )
    return text


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
FEEDBACK_FORM_SOURCE = 'feedback_form'


def _widget_dimensions(body: dict) -> dict[str, str]:
    """The widget's `dimensions` embed option: an object of at most 10 entries.

    Malformed entries are dropped rather than refused (the embed option is
    written into a customer's page and may be stale); the processor keeps only
    the configured keys and values.
    """
    raw = body.get('dimensions')
    if raw is None:
        return {}
    if not isinstance(raw, dict) or len(raw) > MAX_WIDGET_DIMENSIONS:
        raise ValidationError(f'dimensions must be an object of at most {MAX_WIDGET_DIMENSIONS} entries')
    return clean_dimensions(raw)


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


def _anchor_form_brand(form_id: str, effective_brand: str) -> None:
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
    """
    try:
        _forms_table().update_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'},
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
                ':now': datetime.now(UTC).isoformat(),
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


def build_form_item(body: dict, form_id: str | None = None) -> dict:
    """Build DynamoDB item from request body with defaults.

    Validates the link fields here rather than leaving it to the caller: this is
    the only way a new record is constructed, so a future second caller cannot
    reach the table with an unvalidated link by forgetting a line.
    """
    validate_link_fields(body)
    now = datetime.now(UTC).isoformat()
    fid = form_id or str(uuid.uuid4())[:8]

    item = {
        'pk': 'FEEDBACK_FORM',
        'sk': f'FORM#{fid}',
        'form_id': fid,
        'brand_name': BRAND_NAME,
        'created_at': now,
        'updated_at': now,
    }

    # Apply defaults, then override with provided values
    for field, default in DEFAULT_FORM_CONFIG.items():
        item[field] = body.get(field, default)

    return item


def _stored_form(form_id: str) -> dict:
    """The form record as stored, or a 404. Read errors propagate to the caller."""
    response = _forms_table().get_item(
        Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
    )
    item = response.get('Item')
    if not item:
        raise NotFoundError('Form not found')
    return item


def _read_form(form_id: str, failure_message: str) -> dict:
    """`_stored_form` for a route: 404 stays a 404, any other read failure is a logged 500."""
    try:
        return _stored_form(form_id)
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
    """Convert DynamoDB item to form response."""
    return {
        'form_id': item.get('form_id', ''),
        'name': item.get('name', ''),
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
        'brand_name': item.get('brand_name', ''),
        'created_at': item.get('created_at', ''),
        'updated_at': item.get('updated_at', ''),
    }


# jscpd:ignore-start — item_to_widget_config restates item_to_form's rendering
# fields on purpose: it is the PUBLIC allowlist, and a shared "rendering fields"
# helper is exactly the path by which a field added for authenticated callers
# would leak to the widget (see the docstring below and
# test_widget_config_type_lockstep.py).
def item_to_widget_config(item: dict) -> dict:
    """Convert DynamoDB item to the PUBLIC widget config response.

    Deliberately a separate, narrower projection from `item_to_form` rather
    than "item_to_form minus a few keys": `GET /feedback-forms/<id>/config` is
    unauthenticated and fetched by the widget from the customer's own website,
    so every field here is one someone chose to publish. Adding a field to
    `item_to_form` must not leak it; it has to be added here too, on purpose.

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
# jscpd:ignore-end of the accepted pair


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
# API Setup - Embeddable form allows any origin
# ============================================

# NOTE: This form is designed to be embedded on external websites, so it allows
# any origin by default. Set ALLOWED_ORIGIN env var to restrict if needed.
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '*')
app = create_api_resolver(ALLOWED_ORIGIN)


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


def _stats_for_forms(items: list[dict]) -> dict[str, dict]:
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
    scope = scope_for_event(app.current_event.raw_event, aggregates_table)
    form_ids_by_pk: dict[str, list[str]] = {}
    for item in items:
        form_id = item.get('form_id')
        if isinstance(form_id, str) and form_id:
            form_ids_by_pk.setdefault(_form_source_pk(item), []).append(form_id)

    tallies = {fid: _RatingTally() for ids in form_ids_by_pk.values() for fid in ids}
    counts = dict.fromkeys(tallies, 0)
    for source_pk, form_ids in form_ids_by_pk.items():
        for chunk in _chunks(form_ids, _MAX_IN_OPERANDS):
            values = {f':sc{i}': f'form_{fid}' for i, fid in enumerate(chunk)}
            query_kwargs: dict[str, Any] = {
                'KeyConditionExpression': Key('pk').eq(source_pk),
                'FilterExpression': f"source_channel IN ({', '.join(values)})",
                'ExpressionAttributeValues': values,
                # `category` + `source_platform`: both access rules read them (admits_item).
                'ProjectionExpression': 'feedback_id, rating, category, source_platform, source_channel',
            }
            while True:
                response = feedback_table.query(**query_kwargs)
                for row in category_access.filter_items(scope, response.get('Items', [])):
                    form_id = str(row.get('source_channel', '')).removeprefix('form_')
                    if form_id in tallies:
                        counts[form_id] += 1
                        tallies[form_id].add(row)
                if 'LastEvaluatedKey' not in response:
                    break
                query_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
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
    """
    try:
        response = _forms_table().query(
            KeyConditionExpression='pk = :pk',
            ExpressionAttributeValues={':pk': 'FEEDBACK_FORM'}
        )
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
        stats = _stats_for_forms(items)
    except Exception as e:
        metrics.add_metric(name='FeedbackFormStatsReadFailed', unit='Count', value=1)
        logger.exception(f"Error fetching stats for the form list: {e}")
        return {'success': True, 'forms': forms, 'stats_error': 'Failed to fetch form stats'}
    return {'success': True, 'forms': forms, 'stats': stats}


@app.post("/feedback-forms")
@tracer.capture_method
def create_form():
    """Create a new feedback form."""
    body = json_object_body(app)
    _validate_form_labels(body)
    # Link fields are validated inside build_form_item, structurally.
    item = build_form_item(body)

    try:
        _forms_table().put_item(Item=item)
    except Exception as e:
        logger.exception(f"Error creating form: {e}")
        raise ServiceError('Failed to create form') from e
    logger.info(f"Created feedback form: {item['form_id']}")
    return {'success': True, 'form': item_to_form(item)}


@app.get("/feedback-forms/<form_id>")
@tracer.capture_method
def get_form(form_id: str):
    """Get a specific feedback form."""
    item = _read_form(form_id, 'Failed to get form')
    return {'success': True, 'form': item_to_form(item)}


@app.put("/feedback-forms/<form_id>")
@tracer.capture_method
def update_form(form_id: str):
    """Update a feedback form."""
    body = json_object_body(app)
    validate_link_fields(body)
    _validate_form_labels(body)
    now = datetime.now(UTC).isoformat()

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

    try:
        response = _forms_table().update_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'},
            UpdateExpression='SET ' + ', '.join(update_parts),
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
            ReturnValues='ALL_NEW'
        )
    except Exception as e:
        logger.exception(f"Error updating form: {e}")
        raise ServiceError('Failed to update form') from e
    return {'success': True, 'form': item_to_form(response.get('Attributes', {}))}


@app.delete("/feedback-forms/<form_id>")
@tracer.capture_method
def delete_form(form_id: str):
    """Delete a feedback form."""
    try:
        _forms_table().delete_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
        )
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
    """Get form config for widget (public endpoint)."""
    form_id = _public_form_id(form_id)
    item = _read_form(form_id, 'Failed to get form configuration')
    # Narrower projection than item_to_form on purpose: this route is public.
    return {'success': True, 'config': item_to_widget_config(item)}


@app.post("/feedback-forms/<form_id>/submit")
@tracer.capture_method
def submit_form_feedback(form_id: str):
    """Submit feedback to a specific form."""
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
    form = _read_form(form_id, 'Failed to load form configuration')
    if not form.get('enabled', False):
        raise ValidationError('This form is not enabled')
    if form.get('form_type') == prototype_pins.FORM_TYPE_PROTOTYPE_PIN:
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
        _anchor_form_brand(form_id, effective_brand)

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
        'preset_category': form.get('category', ''),
        'preset_subcategory': form.get('subcategory', ''),
        'metadata': metadata,
        # The form's own defaults WIN: the public embed option may only fill keys
        # the form leaves unset, so a page cannot relabel a form's product etc.
        **message_labels({**widget_dimensions, **(form.get('dimension_defaults') or {})}, form.get('tags')),
    }
    # The feedback_form source profile's PII policy, before anything is queued.
    # There is no raw archive on this path, so nothing else needs gating. Strict:
    # an unreadable policy answers 503 (the widget can retry) rather than queueing
    # under the allow default.
    policed = apply_source_policy(normalized_record, cached_source_profile_strict(FEEDBACK_FORM_SOURCE))
    if policed is None:
        raise ValidationError('Feedback text is required')
    normalized_record = policed

    try:
        sqs.send_message(
            QueueUrl=PROCESSING_QUEUE_URL,
            MessageBody=json.dumps(normalized_record, default=str)
        )
    except Exception as e:
        logger.exception(f"Error submitting feedback: {e}")
        raise ServiceError('Failed to submit feedback. Please try again.') from e
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
    form_id = _public_form_id(form_id)
    # Existence gate only; the page is a function of the id and host.
    _read_form(form_id, 'Failed to load form')

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

def _form_source_pk(form: dict) -> str:
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
    """
    effective_brand = form.get('brand_name') or BRAND_NAME
    return f"SOURCE#{effective_brand}" if effective_brand else 'SOURCE#feedback_form'


def _load_form_for_query(form_id: str, read_failure_message: str) -> dict:
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
    """
    try:
        response = _forms_table().get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
        )
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
    """Get submissions for a specific form with stats."""
    params = app.current_event.query_string_parameters or {}
    limit = validate_limit(params.get('limit'), default=50, max_val=100)

    if not feedback_table:
        raise ConfigurationError('Feedback table not configured')

    # One read answers both the 404 and the partition, where this route used to
    # do its own existence check and then have _get_form_source_pk re-read the
    # same record (and swallow a failure of it).
    form = _load_form_for_query(form_id, 'Failed to fetch form')

    source_channel = f'form_{form_id}'
    source_pk = _form_source_pk(form)
    # Read before the try: a failed access read is its own 500, not "no submissions".
    scope = scope_for_event(app.current_event.raw_event, aggregates_table)

    try:
        items = []
        ratings = _RatingTally()

        query_kwargs = {
            'KeyConditionExpression': Key('pk').eq(source_pk),
            'FilterExpression': 'source_channel = :sc',
            'ExpressionAttributeValues': {':sc': source_channel},
            'ScanIndexForward': False,
        }

        while len(items) < limit:
            response = feedback_table.query(**query_kwargs)

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
    if not feedback_table:
        raise ConfigurationError('Feedback table not configured')

    # 404 for a deleted form, and the partition its submissions are in, from the
    # one read — never a partition guessed from a read that failed.
    form = _load_form_for_query(form_id, 'Failed to fetch form stats')

    source_channel = f'form_{form_id}'
    source_pk = _form_source_pk(form)
    scope = scope_for_event(app.current_event.raw_event, aggregates_table)

    try:
        ratings = _RatingTally()
        submission_count = 0

        query_kwargs = {
            'KeyConditionExpression': Key('pk').eq(source_pk),
            'FilterExpression': 'source_channel = :sc',
            'ExpressionAttributeValues': {':sc': source_channel},
            # `category` + `source_platform` so a restricted caller's count covers only
            # what they can see: both access rules read them (admits_item).
            'ProjectionExpression': 'feedback_id, rating, category, source_platform',
        }

        while True:
            response = feedback_table.query(**query_kwargs)

            for item in category_access.filter_items(scope, response.get('Items', [])):
                submission_count += 1
                ratings.add(item)

            if 'LastEvaluatedKey' not in response:
                break
            query_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']

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
    return app.resolve(event, context)
