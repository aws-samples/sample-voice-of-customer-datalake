"""
VoC Feedback Form API Lambda
Handles: /feedback-forms/* - multiple forms management
"""
import json
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any
from pathlib import Path

from aws_lambda_powertools.event_handler import Response

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

# Shared module imports
from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, get_sqs_client
from shared.api import create_api_resolver, api_handler, validate_limit
from shared.exceptions import (
    ApiError,
    ConfigurationError,
    ValidationError,
    NotFoundError,
    ServiceError,
)

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


# ============================================
# Form Configuration Schema & Defaults
# ============================================

DEFAULT_THEME = {
    'primary_color': '#3B82F6',
    'background_color': '#FFFFFF',
    'text_color': '#1F2937',
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
    'custom_fields', 'category', 'subcategory', 'project_id', 'document_id'
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
# Form identifier
# ============================================
#
# Two SEPARATE decisions, and they are deliberately not derived from each other:
# `_minted_form_id` is the one place the format this service ISSUES is decided,
# and `_FORM_ID_PATTERN` is a deliberately WIDER bound on what a caller may hand
# back. Narrowing the mint therefore does not tighten the validator, and is not
# meant to — the width is argued below and pinned in both directions by tests
# (`test_a_hand_seeded_form_id_is_still_embeddable` for the width,
# `test_an_over_long_id_is_refused_without_a_read` for the bound). The ONE
# coupling that must hold — the service can always serve a page for an id it
# issued — is checked by `test_a_minted_id_always_satisfies_the_validator`
# rather than assumed here.
FORM_ID_LENGTH = 8

# The shape a caller-supplied form id has to have before it reaches a read or a
# rendered page (`_validated_form_id`).
#
# WIDER than the mint on purpose, and that width is the whole decision worth
# arguing: the mint is `[0-9a-f]{8}`, but records seeded by hand or by an import
# carry ids like 'website-form', and their embeddable page must keep working — a
# validator narrowed to the mint would 404 the iframe for a form whose /config
# and /submit still answer, which reads as "the product broke" rather than as a
# refusal. So the bound is on the CHARACTER SET and the LENGTH instead, and every
# character that could end a JavaScript string or open an HTML tag — the quote,
# the parenthesis, the semicolon, '<', '>', '&', the backslash — is outside it.
# Powertools' dynamic-route capture group admits all of those (issue #379), so
# this pattern, not the route, is what bounds them.
#
# `.` IS INSIDE the class, and it is here for a compatibility reason rather than
# an aesthetic one. This pattern is a NEW refusal on records that already exist:
# the character class is the only bound in this change that can turn a row which
# used to resolve into a 404 on all eight of its routes, and unlike an id merely
# ADDRESSED with surrounding whitespace there is no argument that such a row was
# already unreachable (a row STORED with a space in its id has no such argument
# either, which is why the scan covers it). `acme.website`
# resolved correctly before — the dot was part of the key and the key was found —
# so narrowing it out is data loss dressed as hardening. A dotted id is also the
# most plausible hand-seeded spelling after `website-form`, since it is how a
# domain is written. It costs the fix nothing: `.` cannot close a JavaScript
# string, open a tag or start a statement, so admitting it moves no character the
# #379 serializer depends on. `test_a_dotted_hand_seeded_form_id_still_resolves`
# is what fails if it is dropped again, and the remaining exclusions (`:`, `+`,
# `@`, `%`, everything non-ASCII, and whitespace inside an id) are named to an
# operator with a pre-upgrade scan in CHANGELOG.md's upgrade notes, since for those
# the 404 is real.
#
# The `(?!\.{1,2}\Z)` in front of the class is what makes admitting `.` safe, and
# it is about URL RESOLUTION rather than about DynamoDB: '.' and '..' are the
# relative-path segments, so a snippet built by joining a base to
# `feedback-forms/../config` addresses a DIFFERENT resource — the id is removed
# from the path by the client before a request is ever sent, and the caller sees a
# working page for a form it did not ask for rather than a refusal. Only those two
# exact strings are affected ('...' is an ordinary segment), so the exclusion is
# an exact-match negative lookahead rather than a ban on leading dots, which would
# refuse `.hidden-form` for no reason. `test_the_two_relative_path_segments_are_not_form_ids`
# pins both directions.
#
# No whitespace either, and that is a choice rather than an oversight: see
# `_validated_form_id`.
#
# `\Z` rather than `$`, and that ONE character is load-bearing: Python's `$` also
# matches immediately before a trailing newline, so `$` with `.match` accepted
# `'deadbeef\n'` — the single whitespace character this pattern is supposed to
# exclude, arriving by the one route the character class does not police. It also
# made the length cap bound the MATCHED PREFIX rather than the id, so
# `'a' * FORM_ID_MAX_LENGTH + '\n'` was admitted at 65 characters. `\Z` matches
# only at the very end of the string, so the cap and the character class both mean
# what they say. `test_a_trailing_newline_is_not_a_valid_form_id` is what fails if
# it goes back.
FORM_ID_MAX_LENGTH = 64
_FORM_ID_PATTERN = re.compile(
    rf'^(?!\.{{1,2}}\Z)[0-9A-Za-z_.-]{{1,{FORM_ID_MAX_LENGTH}}}\Z'
)


def _minted_form_id() -> str:
    """A new form's id: the first `FORM_ID_LENGTH` hex characters of a uuid4.

    The only place a form id is created — it is never taken from a request body.

    `.hex` rather than `str(uuid4())[:n]`, so the constant above is safe to
    RAISE: the dashed form puts a '-' at offset 8, so slicing 9 characters of it
    would mint an id ending in a separator, and slicing 14 would mint one holding
    a '-' that the reader has no reason to expect. `.hex` is 32 hex characters
    with no separators, so every length from 1 to 32 yields the format this
    docstring claims.
    """
    return uuid.uuid4().hex[:FORM_ID_LENGTH]


def _validated_form_id(raw: Any) -> str | None:
    """The form id from the URL, or None if it cannot be one of ours.

    THE authoritative statement of why this exists; the call sites point here
    rather than restating it.

    Modelled on `ballots_handler._validated_session_id`, for the same two
    reasons: a format check before any read means a probe for
    `/feedback-forms/admin` or a 1 MB path segment costs no DynamoDB call, and
    None rather than a raise because every caller answers the same 404 — telling
    an anonymous caller "malformed" apart from "absent" only helps someone
    probing.

    Like that sibling, it is applied at EVERY route that takes a form id out of
    the URL and turns it into a key. All eight, so the claim can be read as
    written and a reader does not have to hold a list of exceptions:

    - unauthenticated: `/config`, `/submit`, `/iframe`
    - authenticated reads: `/submissions`, `/stats` (both through
      `_load_form_for_query`, the single read they make)
    - authenticated CRUD: `GET`, `PUT` and `DELETE /feedback-forms/<form_id>`

    The cost argument only earns its keep on the first three — the others are
    behind Cognito, so nobody is probing them for free. They are covered anyway
    because a universal claim is worth more than the three lines it saves: the
    next reader of this function should not have to check which routes meant it.
    `test_no_route_keys_on_a_form_id_without_validating_it_first` derives the list
    from the module's own routing table rather than from this docstring, so a
    route added later is a failure here instead of a quiet omission.

    The defect this closes (#379) is narrower than "unvalidated input", and worth
    stating so nobody relaxes the pattern on the grounds that the render escapes
    anyway: `get_form_iframe` returns HTML on the API's own origin, and the route
    pattern Powertools compiles accepts `'`, `)` and `;`, so
    `a');alert(document.domain);x=('` matched the route and used to be rendered
    into a `<script>` block verbatim. Validation bounds what reaches the handler;
    the structural serialization at the render site (`_js_value`) bounds what a
    value can do once there. Both, because either alone leaves the other's
    failure fatal.

    A NEW refusal on data that already exists, which is the one respect in which
    this is not purely additive: an id outside the pattern 404s on all eight of its
    routes, and for a hand-seeded row whose id resolved before, that is a reachable
    record becoming unreachable rather than a probe being refused. `.` is admitted
    for exactly that reason (see the pattern above). The characters still outside
    the class — `:`, `+`, `@`, `%`, `~`, everything non-ASCII, and whitespace
    WITHIN an id such as `'my form'` — are a deliberate narrowing rather than an
    oversight, and the upgrade path is an operator scan of the aggregates table for
    `FORM#` ids outside the class, written down in CHANGELOG.md's upgrade notes
    rather than left for whoever reads the 404.

    Interior whitespace belongs in that list rather than under the `.strip()`
    argument below, and the two are easy to conflate: that argument is about an id
    ADDRESSED with surrounding space, where nothing becomes unreachable because
    `' deadbeef'` never resolved to `'deadbeef'` to begin with. A row STORED as
    `'my form'` is the `acme.website` case instead — it resolved, and now it does
    not — so it is scanned for rather than argued away.

    NOT `.strip()`ed, which is where this parts company with the sibling it is
    modelled on. There a session id is a 128-bit token and the leniency is
    inconsequential; here it would make `' deadbeef'` an alias for `'deadbeef'`,
    so every whitespace variant of an id would be a distinct URL serving
    byte-identical HTML. That is a cache-key multiplier for the `Cache-Control`
    follow-up recorded in `lib/stacks/api-stack.ts`, whose whole premise is that
    the response is a pure function of the id and the host — with a strip it
    would be a pure function of the STRIPPED id while the cache keys on the raw
    path. An exact id keeps the URL-to-content mapping one-to-one, and no id this
    service mints has whitespace to forgive
    (`test_an_id_padded_with_whitespace_is_not_an_alias_for_the_id`).
    """
    if not isinstance(raw, str):
        return None
    return raw if _FORM_ID_PATTERN.match(raw) else None


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
        aggregates_table.update_item(
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
                ':now': datetime.now(timezone.utc).isoformat(),
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
    now = datetime.now(timezone.utc).isoformat()
    fid = form_id or _minted_form_id()
    
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
        'rating_max': int(item.get('rating_max', 5)),
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
        'brand_name': item.get('brand_name', ''),
        'created_at': item.get('created_at', ''),
        'updated_at': item.get('updated_at', ''),
    }


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
        'rating_max': int(item.get('rating_max', 5)),
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
        return _widget_js_cache
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

@app.get("/feedback-forms")
@tracer.capture_method
def list_forms():
    """List all feedback forms."""
    try:
        response = aggregates_table.query(
            KeyConditionExpression='pk = :pk',
            ExpressionAttributeValues={':pk': 'FEEDBACK_FORM'}
        )
        
        forms = [item_to_form(item) for item in response.get('Items', [])]
        forms.sort(key=lambda x: x.get('created_at', ''), reverse=True)
        
        return {'success': True, 'forms': forms}
    except Exception as e:
        logger.error(f"Error listing forms: {e}")
        raise ServiceError('Failed to list forms')


@app.post("/feedback-forms")
@tracer.capture_method
def create_form():
    """Create a new feedback form.

    The other half of `update_form`'s condition, and here for the mirror-image
    reason: PutItem OVERWRITES an item at the same key as silently as UpdateItem
    creates one. `attribute_not_exists(sk)` makes this write a create only, so a
    minted id that collides with a form already stored is refused instead of
    replacing it — a customer's live form, its `enabled` flag, its theme and its
    link to a prioritization document, gone with a 200 and a response echoing the
    NEW record. The idiom is `projects_handler`'s, at its own two creates.

    Reachable only through a collision, which is why this is a guard rather than a
    fix for something observed: the id is never taken from the caller
    (`build_form_item` mints it), so two `_minted_form_id()` draws would have to
    agree — a birthday problem over `FORM_ID_LENGTH` hex characters, 32 bits at
    the current 8. Small at a few thousand forms, and not zero. The constant's
    comment says it is safe to RAISE, and this condition is what keeps that a free
    choice rather than something eventually forced: it makes the collision a
    refused request instead of a silent loss, whatever the width.

    A collision is the SERVER's fault, not the caller's, so it answers 500 with
    the generic message rather than a 4xx — the client did nothing wrong and
    retrying is the right move, since the retry mints a different id.
    `test_a_create_that_would_overwrite_a_stored_form_is_refused` pins it.
    """
    body = app.current_event.json_body or {}
    # Link fields are validated inside build_form_item, structurally.
    item = build_form_item(body)

    try:
        aggregates_table.put_item(
            Item=item,
            # See the docstring: this is what makes the route a create rather than
            # a blind overwrite of whatever the minted id happens to name.
            ConditionExpression='attribute_not_exists(sk)',
        )
        logger.info(f"Created feedback form: {item['form_id']}")
        return {'success': True, 'form': item_to_form(item)}
    except Exception as e:
        if _is_conditional_check_failure(e):
            # A minted id that is already taken. Logged distinctly because it is
            # the one failure here that says something about FORM_ID_LENGTH rather
            # than about DynamoDB, and it would otherwise be invisible.
            logger.error(
                f"Refused to overwrite existing form {item['form_id']}: "
                'the minted id collided with a stored one'
            )
            raise ServiceError('Failed to create form') from e
        logger.error(f"Error creating form: {e}")
        # `from e` on both branches, and this is the one that needed it more: the
        # branch above already names its cause in prose, while here the underlying
        # ClientError is all the diagnosis there is and `logger.error` stringifies
        # it without a traceback. Matches `_load_form_for_query`,
        # `get_form_submissions` and `get_form_stats`, which is the module's
        # prevailing spelling. No response changes — both branches answer the same
        # generic message on purpose, so a client cannot tell a collision from a
        # table failure.
        raise ServiceError('Failed to create form') from e


@app.get("/feedback-forms/<form_id>")
@tracer.capture_method
def get_form(form_id: str):
    """Get a specific feedback form.

    Authenticated, so `_validated_form_id` is not buying a bound against an
    anonymous prober here — it is buying the SAME bound at every route that turns
    this URL segment into a key, so the claim in that function's docstring is true
    of the module rather than of the public trio only.
    """
    validated = _validated_form_id(form_id)
    if not validated:
        raise NotFoundError('Form not found')
    try:
        response = aggregates_table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{validated}'}
        )
        item = response.get('Item')
        
        if not item:
            raise NotFoundError('Form not found')
        
        return {'success': True, 'form': item_to_form(item)}
    except NotFoundError:
        raise
    except Exception as e:
        logger.error(f"Error getting form: {e}")
        raise ServiceError('Failed to get form')


@app.put("/feedback-forms/<form_id>")
@tracer.capture_method
def update_form(form_id: str):
    """Update a feedback form.

    UpdateItem is an UPSERT, which is the whole reason the two guards below are
    here rather than only on the public routes:

    - The id is format-checked first (`_validated_form_id`), so a segment that
      could not be one of ours never becomes a key.
    - `attribute_exists(sk)` makes this an UPDATE rather than a create. Without it
      a PUT to an id the table does not hold WROTE one: a bare
      {pk, sk, <updated fields>} row with no `form_id` attribute, which
      `item_to_form` reads back as `form_id: ''` — a nameless entry in
      `list_forms` that nothing can address or delete by id. That is the same
      phantom-stub shape `_anchor_form_brand` already refuses for the same reason;
      this route simply had no condition at all.

    Creation is `POST /feedback-forms`, which mints the id, so nothing legitimate
    reaches this route with an id that does not exist yet — a PUT to an absent id
    is a client bug or a probe, and 404 is the answer both want.
    """
    validated = _validated_form_id(form_id)
    if not validated:
        raise NotFoundError('Form not found')
    body = app.current_event.json_body or {}
    validate_link_fields(body)
    now = datetime.now(timezone.utc).isoformat()
    
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
        response = aggregates_table.update_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{validated}'},
            UpdateExpression='SET ' + ', '.join(update_parts),
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
            # See the docstring: this is what makes the route an update instead of
            # a create. One round trip, and no read-then-write race — a form
            # deleted between a check and this write would still be refused.
            ConditionExpression='attribute_exists(sk)',
            ReturnValues='ALL_NEW'
        )

        return {'success': True, 'form': item_to_form(response.get('Attributes', {}))}
    except Exception as e:
        # The condition failing is not a server error: it means the form is not
        # there, which is the same 404 `get_form` gives for the same id. Reported
        # before the generic branch so it cannot be logged as a failure to update.
        if _is_conditional_check_failure(e):
            raise NotFoundError('Form not found') from e
        logger.error(f"Error updating form: {e}")
        raise ServiceError('Failed to update form')


@app.delete("/feedback-forms/<form_id>")
@tracer.capture_method
def delete_form(form_id: str):
    """Delete a feedback form.

    Format-checked for the same module-wide reason as `get_form`. No
    `attribute_exists` condition, unlike `update_form`: DeleteItem on a key that
    is not there is a no-op rather than a write, so the idempotent 200 this
    already returns is the honest answer and there is no phantom row to prevent.
    """
    validated = _validated_form_id(form_id)
    if not validated:
        raise NotFoundError('Form not found')
    try:
        aggregates_table.delete_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{validated}'}
        )
        logger.info(f"Deleted feedback form: {validated}")
        return {'success': True}
    except Exception as e:
        logger.error(f"Error deleting form: {e}")
        raise ServiceError('Failed to delete form')


# ============================================
# Form Widget Endpoints (Public)
# ============================================

@app.get("/feedback-forms/<form_id>/config")
@tracer.capture_method
def get_form_config_by_id(form_id: str):
    """Get form config for widget (public endpoint).

    The id is format-checked before the read, for the reason `_validated_form_id`
    gives: this route is unauthenticated and its path segment is unbounded, so a
    probe for `/feedback-forms/admin` or a megabyte of path must not buy a
    DynamoDB call. Same 404 either way, so the refusal says no more than "no such
    form" does.
    """
    validated = _validated_form_id(form_id)
    if not validated:
        raise NotFoundError('Form not found')
    try:
        response = aggregates_table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{validated}'}
        )
        item = response.get('Item')
        
        if not item:
            raise NotFoundError('Form not found')

        # Narrower projection than item_to_form on purpose: this route is public.
        return {'success': True, 'config': item_to_widget_config(item)}
    except NotFoundError:
        raise
    except Exception as e:
        logger.error(f"Error getting form config: {e}")
        raise ServiceError('Failed to get form configuration')


@app.post("/feedback-forms/<form_id>/submit")
@tracer.capture_method
def submit_form_feedback(form_id: str):
    """Submit feedback to a specific form.

    The id is format-checked before the read (`_validated_form_id`), and BEFORE
    the body is looked at: the write side of the public trio is the one route here
    that also enqueues, so a form id that cannot be one of ours must not reach
    either the table or the queue. The validated value is used everywhere below —
    the key, `source_channel`, the metadata and `_anchor_form_brand` — so what is
    stored is what was checked.
    """
    validated = _validated_form_id(form_id)
    if not validated:
        raise NotFoundError('Form not found')
    body = app.current_event.json_body or {}

    text = body.get('text', '').strip()
    if not text:
        raise ValidationError('Feedback text is required')

    # Get form config
    try:
        response = aggregates_table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{validated}'}
        )
        form = response.get('Item')
        
        if not form:
            raise NotFoundError('Form not found')
        
        if not form.get('enabled', False):
            raise ValidationError('This form is not enabled')
    except (NotFoundError, ValidationError):
        raise
    except Exception as e:
        logger.error(f"Error fetching form: {e}")
        raise ServiceError('Failed to load form configuration')
    
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
        _anchor_form_brand(validated, effective_brand)

    now = datetime.now(timezone.utc)
    feedback_id = str(uuid.uuid4())

    # Build normalized record with category routing
    metadata = {
        'form_id': validated,
        'form_name': form.get('name', ''),
        'form_version': '2.0',
    }
    if form.get('collect_email') and body.get('email'):
        metadata['submitter_email'] = body['email']
    if form.get('collect_name') and body.get('name'):
        metadata['submitter_name'] = body['name']
    if body.get('custom_fields'):
        metadata['custom_fields'] = body['custom_fields']
    
    normalized_record = {
        'id': feedback_id,
        'source_platform': 'feedback_form',
        'source_channel': f'form_{validated}',
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
    }
    
    try:
        sqs.send_message(
            QueueUrl=PROCESSING_QUEUE_URL,
            MessageBody=json.dumps(normalized_record, default=str)
        )
        logger.info(f"Submitted feedback to form {validated}: {feedback_id}")
        return {
            'success': True,
            'feedback_id': feedback_id,
            'message': form.get('success_message', 'Thank you for your feedback!')
        }
    except Exception as e:
        logger.error(f"Error submitting feedback: {e}")
        raise ServiceError('Failed to submit feedback. Please try again.')


def _js_value(value: Any) -> str:
    """A trusted Python value as a JavaScript expression to inline in a script.

    `json.dumps` and nothing hand-written: JSON is a subset of JavaScript
    expression syntax, so the serializer — not the template — decides where the
    quotes go and how a quote inside the value is escaped. The spelling this
    replaced was `'{value}'`, a handwritten quote pair around raw text, and every
    reflected-XSS variant on this route came from a value that closed it (#379).
    Wrapping `json.dumps(...)` in quotes of our own would reintroduce exactly
    that: the result already carries its own, and a second pair round it makes the
    inner ones data again.

    The three replacements are for the HTML parser, which sees this text before
    any JavaScript engine does: inside a `<script>` element `</script>` ends the
    element wherever it appears — string literal or not — so `<` and `>` cannot be
    left as themselves. `&` goes with them because it is the other character an
    HTML parser gives meaning to. `html.escape` is deliberately NOT used here and
    could not be: it produces `&#x27;` and `&lt;`, which are entities the script
    context does not decode, so it would corrupt the value rather than protect it.
    Escaping to `\\uXXXX` keeps the string byte-identical to the JavaScript engine
    while making it inert to the parser above it.

    U+2028 and U+2029 need the same treatment (they terminate a JavaScript line
    but not a JSON string) and get it from `ensure_ascii=True`, which escapes
    every non-ASCII character. That is `json.dumps`'s default and is passed
    EXPLICITLY anyway: it is load-bearing here rather than cosmetic, and
    `ensure_ascii=False` is an inviting edit (it makes a non-ASCII value readable
    in a debug dump) that would put those two characters back into the script
    raw. `test_a_line_separator_cannot_end_the_statement` is what fails if it is
    removed.
    """
    return (
        json.dumps(value, ensure_ascii=True)
        .replace('<', '\\u003c')
        .replace('>', '\\u003e')
        .replace('&', '\\u0026')
    )


# Sent with the one response in this API that is HTML rather than JSON, so it is
# the one response a browser will parse as a document on the API's own origin.
#
# `script-src 'unsafe-inline'` is there because the widget is INLINED into the
# page (get_widget_js) and this is the deployment's only script host; removing it
# means a nonce and a widget that loads from a URL, which is a bigger change than
# this one. What the policy still buys with that in place is worth having: no
# EXTERNAL script can load, no image, font or frame can be fetched, and the only
# network destination is this same origin — so a value that did escape the
# serializer above has nowhere to send anything.
#
# `style-src 'unsafe-inline'` is required by the page's own <style> block and by
# the widget's `style.cssText` assignments; `connect-src 'self'` is the widget's
# fetch of /config and /submit, which are on this origin by construction
# (api_endpoint is built from this request's own host).
#
# That construction is what `'self'` depends on, and it holds for the ONE
# deployment topology this stack builds: API Gateway invoked directly, so
# `requestContext.domainName` — the host the document was served from — is also
# the host the widget fetches. `lib/stacks/api-stack.ts` takes a
# `frontendDistribution`, but that CloudFront distribution fronts the website
# bucket only; no behaviour points at the API, and no custom domain or base-path
# mapping is declared for it.
#
# If a deployment ever puts this API behind a distribution or a custom domain that
# rewrites Host, `'self'` and `api_endpoint` stop agreeing — `domainName` would be
# the ORIGIN's host while the document came from the EDGE's — and the widget's own
# fetch is refused, with nothing to see but a CSP violation in a console nobody is
# watching. The fix then is to derive both from the same forwarded host rather
# than to widen the directive: `connect-src` naming an explicit API host is still
# a bound, `'self' *` is not. Out of scope here because the topology does not
# exist yet, and recorded because this comment is where the reader of that
# deployment's blank frame will end up.
#
# Those three are what makes the page WORK, and `default-src 'none'` is the
# fallback for everything not named — so deleting any one of them is a total,
# silent failure of the product on a customer's site rather than a degraded page.
# That is why the whole policy is pinned as a directive-to-sources mapping by
# `test_the_policy_names_every_directive_the_page_needs_and_no_wildcard`, which
# fails on a removal AND on a widening.
#
# There is deliberately NO `img-src`, `font-src` or `frame-src`: the widget
# builds its UI from DOM elements, text and CSS only — no <img>, no `url(...)`,
# no `data:` URI, no webfont — so `default-src 'none'` blocks nothing it asks
# for. `form-action 'none'` is correct for the same kind of reason: the widget
# submits through `fetch`, never through a <form>. Those are claims about
# feedback-widget.js rather than about this dict, so they are derived from that
# file by `test_the_widget_asks_for_no_asset_the_policy_would_block` instead of
# being trusted here — the day the widget grows an icon, that test fails and
# names the directive to add.
#
# `frame-ancestors` is deliberately absent, and that is the decision this route
# turns on: it EXISTS to be framed on customers' sites (docs/feedback-forms.md),
# and the directive has no fallback to `default-src`, so leaving it out is how
# "any site may embed this" is spelled. Adding it, or an X-Frame-Options header,
# would break every embed.
#
# The other two headers are conventional, but each is here for a reason specific to
# THIS response rather than as boilerplate:
#
# `nosniff` matters more here than it would anywhere else in this API, because this
# is the only `text/html` it serves. Everything else is JSON, so this is the one
# response whose whole purpose is to be parsed as a document on the API's own
# origin — exactly the case where letting a browser decide the type for itself has
# something to get wrong.
#
# `no-referrer` is the one with a PRODUCT consequence, and it is the one worth
# recording so a future reader does not read it as data the product wanted and lost.
# The page is framed on a customer's site, so without it the `Referer` on the
# widget's own two fetches would carry the customer's page URL into this API's
# access logs. Note the widget already sends `page_url: window.location.href` in
# the submit body ON PURPOSE — so this is not withholding the URL from the product,
# which receives it as a field it chose. It keeps it out of a log nobody asked to
# collect it in.
#
# Both are pinned by `test_the_response_carries_the_two_headers_the_csp_does_not`:
# `test_the_policy_names_every_directive_the_page_needs_and_no_wildcard` reads the
# policy BY KEY and so would not notice either being removed or renamed.
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
    """Serve the HTML page a customer's site frames for one form.

    The only route in this API that answers with a document rather than JSON, on
    the API's own origin, unauthenticated — which is why two gates come before a
    single character of HTML is produced. `_validated_form_id` carries the
    argument for the FORMAT gate and is not restated here; what is specific to
    this route is the EXISTENCE gate below and the availability consequence of
    having one (#379).

    The form must EXIST. This route used to read nothing, so any string matching
    the capture group got a 200 and a page — unlike /config and /submit, which
    404 an id the table does not have. That is what let a caller mint an
    attacker-chosen page on this origin without even needing a malformed id, and
    it is why the check is here rather than left to the widget's own /config
    fetch. `_load_form_for_query` is the same one-get_item lookup /stats and
    /submissions make, so both gates answer the same 404 as every sibling.

    THE TRADE, because it is a new coupling and a reader hunting "why did every
    embed go blank" needs to find it: reading anything means the route can now
    fail. `_load_form_for_query` raises `ServiceError` if the get_item raises, so
    an aggregates-table blip answers 500 here where this route previously served
    a working page having read nothing — and a 500 on this route is a raw API
    Gateway error page inside the customer's iframe, with no widget string and no
    retry (the throttle comment in `lib/stacks/api-stack.ts` traces the same
    symptom for a 429). Accepted rather than overlooked: a page served for a form
    that may not exist is the defect being closed, and a page whose /config fetch
    is about to fail against the same table has nothing to render anyway, so
    failing at the frame is more honest than failing inside it. It is also
    observable — `_load_form_for_query` emits `FeedbackFormReadFailed` — which is
    what makes it a trade rather than a silent regression.

    Neither gate is trusted alone. Every value that reaches the script is built by
    `_js_value`, so the render is safe even if the pattern is later widened or the
    route's own regex changes underneath it.
    """
    validated = _validated_form_id(form_id)
    if not validated:
        raise NotFoundError('Form not found')
    # Return value unused: this is the existence gate, not a projection. The
    # page's content is a function of the id and the host, nothing stored.
    #
    # EXISTENCE ONLY — `enabled` is deliberately NOT consulted, which the unused
    # return value makes look like an oversight rather than a decision. A disabled
    # form still gets its page, matching `GET /config`, which publishes `enabled`
    # in its projection and leaves the decision to the widget; `submit_form_feedback`
    # is where it is enforced. The reason to keep the asymmetry is that the widget
    # has to RUN in order to show its own disabled state — gate the page on
    # `enabled` and the visitor gets a raw API Gateway 404 frame instead, which is
    # a worse answer for the customer who turned the form off on purpose.
    # `test_a_disabled_form_still_serves_its_page_so_the_widget_can_say_so` pins it.
    #
    # Both halves of the pair are discarded, including the validated id it hands
    # back for `/stats` and `/submissions` to build their filter from: this route
    # already holds that string, having passed it in.
    _load_form_for_query(validated, 'Failed to load form')

    host = app.current_event.request_context.get('domainName', '')
    stage = app.current_event.request_context.get('stage', 'v1')
    api_endpoint = f"https://{host}/{stage}" if host else ''

    # ONE serialized object rather than five interpolated fields: the options
    # object is a JSON object literal, so json.dumps writes every quote, brace and
    # comma in it and the template writes none. `api_endpoint` goes through it too
    # — it is derived from a request header (domainName), so it is not ours either.
    #
    # This is the page's ONLY reflected value, and it is in SCRIPT context, which
    # is why `html.escape` appears nowhere below: the <title>, the container id and
    # the <style> block are fixed text, so no request value reaches an HTML
    # context. `html.escape(..., quote=True)` is the right tool for a value
    # rendered as MARKUP and the wrong one inside a script, where its entities are
    # never decoded — so if a later change puts the form id in the title or an
    # attribute, that value needs it and NOT this function.
    init_options = _js_value({
        'container': '#voc-feedback-form',
        'apiEndpoint': api_endpoint,
        'formId': validated,
        'configEndpoint': f'/feedback-forms/{validated}/config',
        'submitEndpoint': f'/feedback-forms/{validated}/submit',
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
  <div id="voc-feedback-form"></div>
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


def _load_form_for_query(
    form_id: str, read_failure_message: str
) -> tuple[str, dict]:
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

    The FORMAT check is here rather than at each caller because this function is
    the one read those routes make, so one call covers `/stats`, `/submissions`
    and the iframe page's existence gate — `_validated_form_id`'s cost argument
    then holds at every route that states it rather than at one.

    Returns the VALIDATED id alongside the record, and that is the whole reason
    this signature is a pair rather than a dict. The key here is built from the
    validated value, but a caller's `source_channel` — the filter that selects
    which submissions belong to this form — used to be built from the raw
    parameter, so the read and the filter came from two different strings. They
    are the same string today, and relying on that was a latent split rather than
    a saving: a validator that normalized (a plausible "form ids are
    case-insensitive" change) would have this function read `FORM#DEADBEEF` while
    `/config` read `FORM#deadbeef` for the same URL, and the caller would filter
    on `form_DEADBEEF` while every write used `form_deadbeef` — zero submissions
    for a form that has them, reported as a 200. That is the exact defect class
    this function exists to prevent (#312), arriving through the door the format
    check installed. Handing the validated id back removes the dependency instead
    of documenting it, so `submit_form_feedback`'s write (`f'form_{validated}'`)
    and both read routes' filter are built from one string.
    `test_the_validator_returns_its_input_unchanged` still pins the exactness, and
    `test_the_key_a_query_route_reads_is_the_id_in_its_url` pins the pair
    end to end.
    """
    validated = _validated_form_id(form_id)
    if not validated:
        raise NotFoundError('Form not found')
    try:
        response = aggregates_table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{validated}'}
        )
    except Exception as e:
        # Surfaced as a metric because this failure used to be invisible: it was
        # reported to the caller as a zero count and to operations as nothing.
        metrics.add_metric(name='FeedbackFormReadFailed', unit='Count', value=1)
        logger.error(f"Error fetching form {form_id}: {e}")
        raise ServiceError(read_failure_message) from e

    form = response.get('Item')
    if not form:
        raise NotFoundError('Form not found')
    return validated, form


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
    validated, form = _load_form_for_query(form_id, 'Failed to fetch form')

    # From the VALIDATED id, so this filter and the write that produced the rows
    # it selects (`submit_form_feedback`, `'source_channel': f'form_{validated}'`)
    # are built from one string. See _load_form_for_query: a validator that
    # normalized would otherwise have this route filter on a channel no write ever
    # used, and the symptom is zero rows rather than an error.
    source_channel = f'form_{validated}'
    source_pk = _form_source_pk(form)

    try:
        items = []
        total_rating = 0
        rating_count = 0
        
        query_kwargs = {
            'KeyConditionExpression': Key('pk').eq(source_pk),
            'FilterExpression': 'source_channel = :sc',
            'ExpressionAttributeValues': {':sc': source_channel},
            'ScanIndexForward': False,
        }
        
        while len(items) < limit:
            response = feedback_table.query(**query_kwargs)
            
            for item in response.get('Items', []):
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
                
                if item.get('rating'):
                    total_rating += float(item.get('rating'))
                    rating_count += 1
            
            if 'LastEvaluatedKey' not in response:
                break
            query_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
        
        avg_rating = round(total_rating / rating_count, 2) if rating_count > 0 else None
        
        return {
            'success': True,
            # The VALIDATED id, like the key and the filter above: this response
            # names the record those two addressed, so a normalizing validator
            # cannot make it describe one row set while naming another id. See
            # _load_form_for_query, and `submit_form_feedback` which already
            # stores `'form_id': validated`.
            'form_id': validated,
            'stats': {
                'total_submissions': len(items),
                'avg_rating': avg_rating,
                'rating_count': rating_count,
            },
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
        logger.error(f"Error fetching submissions: {e}")
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
    validated, form = _load_form_for_query(form_id, 'Failed to fetch form stats')

    # From the VALIDATED id, for the same reason as get_form_submissions above:
    # this filter has to be the string `submit_form_feedback` wrote
    # (`'source_channel': f'form_{validated}'`), or the count is a false zero.
    source_channel = f'form_{validated}'
    source_pk = _form_source_pk(form)

    try:
        total_rating = 0
        rating_count = 0
        submission_count = 0
        
        query_kwargs = {
            'KeyConditionExpression': Key('pk').eq(source_pk),
            'FilterExpression': 'source_channel = :sc',
            'ExpressionAttributeValues': {':sc': source_channel},
            'ProjectionExpression': 'feedback_id, rating',
        }
        
        while True:
            response = feedback_table.query(**query_kwargs)
            
            for item in response.get('Items', []):
                submission_count += 1
                if item.get('rating'):
                    total_rating += float(item.get('rating'))
                    rating_count += 1
            
            if 'LastEvaluatedKey' not in response:
                break
            query_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
        
        avg_rating = round(total_rating / rating_count, 2) if rating_count > 0 else None
        
        return {
            'success': True,
            # The VALIDATED id, for the same reason as get_form_submissions: the
            # count reported here is of the rows the key and the filter above
            # selected, so the id naming it has to be the one they were built
            # from.
            'form_id': validated,
            'stats': {
                'total_submissions': submission_count,
                'avg_rating': avg_rating,
                'rating_count': rating_count,
            }
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
        logger.error(f"Error fetching form stats: {e}")
        raise ServiceError('Failed to fetch form stats') from e


# ============================================
# Lambda Handler
# ============================================

@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
