"""
VoC Anonymous Ballots API Lambda
Handles: /voting-sessions/* — a room scoring ONE document from their phones.

WHY THIS IS ITS OWN HANDLER, AND ITS OWN API GATEWAY RESOURCE
------------------------------------------------------------
Two of the five routes below are served WITHOUT credentials, which is the whole
risk of this feature. They are therefore not carved out of the authenticated
`/projects/{proxy+}`: that proxy applies the Cognito authorizer to everything
beneath it, and a public exception inside it is the exact shape that once left
feedback-form update, delete and submission reads unauthenticated in this
repository. They are not added to the feedback-form routes either — those are
public for an embeddable CUSTOMER widget and a stack test pins exactly which
routes are anonymous.

So: one small handler, one resource tree (`/voting-sessions/*`), explicit methods
in `lib/stacks/api-stack.ts`, and an execution role with write access to ONE
table (the aggregates table). `lib/stacks/api-stack.test.ts` names the two public
routes in its allowlist, deliberately and in review.

THE SESSION IS THE CONTROL, NOT OBSCURITY
-----------------------------------------
A ballot is accepted only when ALL of these hold:

  * the session id in the URL addresses a real session record (128 bits of
    `secrets` entropy — unguessable, and the only thing the QR encodes),
  * the session is OPEN (closing it is the revocation, the same semantics the
    feedback form's `enabled` flag already has),
  * the session has not EXPIRED (a wall-clock bound, so a link that leaks after
    the meeting stops working even if nobody remembered to close it), and
  * the session is below its BALLOT CAP.

The cap is enforced by a CONDITIONAL ATOMIC INCREMENT on the session record, not
by a read-then-write check: a room full of phones submitting at once is exactly
the case a read-then-write loses, and a flood has to be refused by the database
rather than by arithmetic that raced. The read that happens first exists only to
give an honest error message ("closed" vs "full" vs "no such session"); the
condition is what actually holds the line.

ONE DEVICE, ONE BALLOT
----------------------
Every ballot lands on its own key, `BALLOT#{document_id}#anon:{ballot_id}`, where
`ballot_id` is minted HERE (never accepted from the caller) and handed back to the
device. Re-submitting with that id upserts the same record, so a phone correcting
its vote replaces it rather than adding one, and no cap is consumed. Stuffing
therefore means obtaining new ids, and each new id costs one slot of a cap that
defaults to a room's worth of people.

The `anon:` kind is why an anonymous ballot can never overwrite a signed-in
reviewer's: the reviewer half of a ballot sort key is namespaced by kind, and
`projects_handler` writes `user:{cognito_sub}`. `test_anon_ballot_key_lockstep.py`
pins the two spellings against each other — a drift there would corrupt or
overwrite real ballots silently.

WHAT A BALLOT IS NOT
--------------------
It is a decision record, not customer voice. Nothing here writes to the feedback
table or the processing queue: no enrichment, no sentiment, no persona, and no
appearance in any customer metric. This module has no client for either, and the
Lambda's role grants neither, so that split is enforced rather than remembered.

And no ballot carries the `ttl` attribute. The aggregates table expires anything
that does, so a ballot with one would quietly vanish out of the team's score weeks
later. The SESSION record carries it (its own state is worthless once it has
expired); the ballot never does.

WHAT SURFACES WHERE
-------------------
Nothing here reads or changes the aggregate. `_aggregate_scores` in
`projects_handler` already counts EVERY ballot row in the partition whatever its
kind, so a correctly keyed `anon:` ballot appears in the team's combined score,
`reviewer_count` and `score_spread` with no change to the read, its response shape
or the page that renders it.
"""
import json
import math
import os
import re
import secrets
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any

from aws_lambda_powertools.event_handler import Response, content_types
from botocore.exceptions import ClientError

from shared.api import (
    api_handler,
    create_api_resolver,
    get_caller_subject,
    validate_int,
)
from shared.exceptions import (
    ApiError,
    ConfigurationError,
    NotFoundError,
    ServiceError,
    ValidationError,
)
from shared.logging import logger, tracer
from shared.tables import get_aggregates_table

ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', 'http://localhost:5173')
app = create_api_resolver(ALLOWED_ORIGIN)


# ============================================
# Session record
# ============================================
#
# Its own partition, beside the feedback-form configurations it is modelled on
# (pk='FEEDBACK_FORM', sk='FORM#{id}'):
#
#     pk = 'VOTING_SESSION'
#     sk = 'SESSION#{session_id}'
#
# Deliberately NOT in the 'PRIORITIZATION' partition. That partition is read whole
# on every page load and has a documented scale ceiling (ballots grow as documents
# x reviewers); session records would be read on every one of those loads for no
# reader's benefit and would count against the same page budget.
VOTING_SESSION_PK = 'VOTING_SESSION'
SESSION_SK_PREFIX = 'SESSION#'

# The session id IS the unguessable token the QR encodes — 128 bits from
# `secrets`, which is what makes the URL alone insufficient to guess and the
# record itself the thing that authorizes a write. Prefixed so a value read out of
# a log or a table is recognisable, and so the format check below can refuse
# anything that is not one of ours before it reaches DynamoDB.
SESSION_ID_PREFIX = 'vs_'
SESSION_ID_BYTES = 16
_SESSION_ID_PATTERN = re.compile(rf'^{SESSION_ID_PREFIX}[0-9a-f]{{{SESSION_ID_BYTES * 2}}}$')

STATUS_OPEN = 'open'
STATUS_CLOSED = 'closed'

# How long a session may accept ballots for. A prioritization meeting is an hour
# or two, so three hours is generous while still bounding a link that leaks: the
# facilitator closing the session is the intended revocation, and this is what
# happens when nobody remembers to.
DEFAULT_SESSION_MINUTES = 180
MIN_SESSION_MINUTES = 5
MAX_SESSION_MINUTES = 1440

# How many ballots one session may accept. Modest on purpose, in TENS rather than
# thousands: it bounds ballot stuffing (each new device id costs a slot) and it
# bounds growth of a single DynamoDB partition that is read whole on every page
# load. A room bigger than MAX_BALLOT_CAP opens a second session.
DEFAULT_BALLOT_CAP = 40
MIN_BALLOT_CAP = 1
MAX_BALLOT_CAP = 200


# ============================================
# Ballot record — the key shape projects_handler owns
# ============================================
#
# Duplicated here rather than imported because the two handlers are packaged as
# separate Lambda bundles and neither may import the other. The duplication is
# PINNED by `lambda/api/test/test_anon_ballot_key_lockstep.py`: a ballot written
# under a drifted key is unreadable to the page and, worse, a drifted KIND
# namespace could land on a signed-in reviewer's key and destroy their vote.
PRIORITIZATION_PK = 'PRIORITIZATION'
BALLOT_SK_PREFIX = 'BALLOT#'
REVIEWER_KIND_ANON = 'anon'

# Minted here, never accepted from a caller — see `_minted_ballot_id`.
BALLOT_ID_BYTES = 16
_BALLOT_ID_PATTERN = re.compile(rf'^[0-9a-f]{{{BALLOT_ID_BYTES * 2}}}$')

SCORE_AXES = ('impact', 'time_to_market', 'confidence', 'strategic_fit')
MIN_AXIS_VALUE = 0
MAX_AXIS_VALUE = 5

# The same bound `projects_handler` enforces on a signed-in reviewer's note, and
# for the same reason: the note is stored verbatim and read back on every page
# load, and the characters past the bound are content rather than a number that
# can be clamped, so an over-long note is REFUSED and not truncated.
MAX_BALLOT_NOTE_LEN = 2000

# A display name is untrusted, optional PII. Short, because it is a name and not a
# comment; sanitised, because it is stored verbatim; and never logged, never
# prompted with, never exported.
MAX_DISPLAY_NAME_LEN = 60

# What the ballot page shows the room so they know WHICH proposal they are
# scoring. Copied onto the session at creation rather than read live from the
# projects table: this Lambda has no access to that table by design, and the
# session is a record of what the facilitator put on screen.
MAX_DOCUMENT_TITLE_LEN = 200

# A DynamoDB sort key is capped at 1024 bytes; the same bound the document-aiming
# fields in `projects_handler` use, so an absurd id is a 400 naming the field
# rather than a ValidationException surfacing as a 500.
MAX_SOURCE_DOCUMENT_ID_LEN = 256


# ============================================
# Refusals a public caller has to be able to tell apart
# ============================================
#
# The ballot page cannot explain a bare status code: `fetchApi` discards a
# response body, and the page needs to say "this session is closed" rather than
# "something went wrong". So every refusal of a submission carries a stable,
# machine-readable `reason` beside the human sentence, and the page maps it to its
# own translated copy.
#
# Returned as an explicit `Response` rather than raised: the shared exception
# classes map to fixed statuses and carry no room for an extra field, and adding
# one to `shared/api.py` for a single caller would put unused surface in a module
# every handler imports.
REASON_NOT_FOUND = 'not_found'
REASON_CLOSED = 'closed'
REASON_EXPIRED = 'expired'
REASON_CAP_REACHED = 'cap_reached'

_REFUSAL_STATUS = {
    REASON_NOT_FOUND: 404,
    REASON_CLOSED: 409,
    REASON_EXPIRED: 409,
    # 429 rather than 409: the session is in a perfectly good state and the
    # request is one too many, which is what "too many requests" means. It also
    # keeps "the room filled up" distinguishable from "the facilitator sat down"
    # for a page that shows different words for each.
    REASON_CAP_REACHED: 429,
}

_REFUSAL_MESSAGE = {
    REASON_NOT_FOUND: 'This voting session does not exist',
    REASON_CLOSED: 'This voting session is closed',
    REASON_EXPIRED: 'This voting session has expired',
    REASON_CAP_REACHED: 'This voting session has reached its ballot limit',
}


def _refusal(reason: str) -> Response:
    """One refusal shape for every reason a ballot is not accepted."""
    return Response(
        status_code=_REFUSAL_STATUS[reason],
        content_type=content_types.APPLICATION_JSON,
        body=json.dumps({
            'success': False,
            'reason': reason,
            'error': _REFUSAL_MESSAGE[reason],
        }),
    )


# ============================================
# Validation
# ============================================


def _table():
    table = get_aggregates_table()
    if not table:
        raise ConfigurationError('Aggregates table not configured')
    return table


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _session_sk(session_id: str) -> str:
    return f'{SESSION_SK_PREFIX}{session_id}'


def _ballot_sk(document_id: str, ballot_id: str) -> str:
    """The ballot's sort key: kind-namespaced, so an anonymous ballot can never
    land on a signed-in reviewer's key.

    Both halves are known not to contain '#': the document id is checked on the
    way in (`_validated_document_id`) and the ballot id is minted here as hex.
    That is what keeps `BALLOT#{id}#{kind}:{subject}` splittable by the read.
    """
    return f'{BALLOT_SK_PREFIX}{document_id}#{REVIEWER_KIND_ANON}:{ballot_id}'


def _minted_ballot_id() -> str:
    """A new device's ballot id.

    ALWAYS minted here, never taken from the request, even when the caller sends
    one that looks well-formed. A caller-chosen key would put the sort key's
    second half under the control of the one unauthenticated writer in this
    system, and the no-'#'/no-':' invariant the whole partition is parsed on would
    then rest on a validator instead of on construction. A device re-submits by
    sending back an id this function produced; anything else is treated as a first
    submission (see `_existing_ballot`).
    """
    return secrets.token_hex(BALLOT_ID_BYTES)


def _validated_session_id(raw: Any) -> str | None:
    """The session id from the URL, or None if it cannot be one of ours.

    Format-checked before any read, so a scan for `/voting-sessions/admin` or a
    1MB path segment costs no DynamoDB call. None (rather than a raise) because
    every caller answers the same 404 for "no such session": telling an anonymous
    caller apart "malformed" from "absent" only helps someone probing.
    """
    if not isinstance(raw, str):
        return None
    session_id = raw.strip()
    return session_id if _SESSION_ID_PATTERN.match(session_id) else None


def _validated_document_id(raw: Any) -> str:
    """Check that a facilitator-supplied document id can be a ballot sort key.

    The same three rules `projects_handler._validated_ballot_document_id` applies,
    for the same reasons: '#' is the sort-key delimiter and would make the key
    ambiguous to the read, and an absurd length is a 400 naming the field rather
    than a DynamoDB ValidationException surfacing as a 500. Neither message echoes
    the value, which is unbounded caller input.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValidationError('document_id is required')
    document_id = raw.strip()
    if '#' in document_id:
        raise ValidationError("document_id must not contain '#', the sort-key delimiter")
    if len(document_id) > MAX_SOURCE_DOCUMENT_ID_LEN:
        raise ValidationError(
            f'document_id must be at most {MAX_SOURCE_DOCUMENT_ID_LEN} characters'
        )
    return document_id


def _sanitized_text(raw: Any, max_length: int) -> str:
    """Free text reduced to something safe to store and to show a room.

    Control characters are stripped rather than escaped — a name or a title has no
    use for them, and they are what turns stored text into a broken line in a log
    or a terminal. Unicode category 'Cc'/'Cf' covers C0/C1 and the bidi and
    zero-width formatting characters that make one displayed name impersonate
    another. Whitespace is collapsed for the same reason: 60 spaces is not a name.
    """
    if not isinstance(raw, str):
        return ''
    stripped = ''.join(
        ch for ch in raw if unicodedata.category(ch) not in ('Cc', 'Cf')
    )
    return ' '.join(stripped.split())[:max_length]


def _validated_note(raw: Any) -> str | None:
    """The optional note beside the sliders, or None when there is none.

    REFUSED rather than truncated past the bound, matching the signed-in save
    path: the tail of a justification is content, and a note runs long exactly
    when it is doing the most work. The bound is pinned against that path by
    `test_anon_ballot_key_lockstep.py`, so the two cannot drift.
    """
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValidationError('notes must be a string')
    note = raw.strip()
    if not note:
        return None
    if len(note) > MAX_BALLOT_NOTE_LEN:
        raise ValidationError(f'notes must be at most {MAX_BALLOT_NOTE_LEN} characters')
    return note


def _is_clampable_number(value: Any) -> bool:
    """Whether an axis value is a number this route may clamp into 0-5.

    The same reading `projects_handler._is_clampable_number` documents at length:
    clamp a number, refuse a non-number. A `bool` is refused although
    `isinstance(True, int)` holds (a flag is not a slider position), and a
    non-finite float is refused because `int(float('inf'))` raises `OverflowError`
    — reachable over the wire, since a JSON body is parsed non-strictly and
    accepts the `Infinity` literal.
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, float) and not math.isfinite(value):
        return False
    try:
        int(value)
    except (ValueError, TypeError, OverflowError):
        return False
    return True


def _validated_axes(body: dict) -> dict[str, int]:
    """The axes this ballot scored, clamped into range.

    At least one is REQUIRED, which is stricter than the signed-in PATCH — and
    deliberately so. That route is a patch of a durable ballot a reviewer may
    return to, so "notes only" is a legal save. This one mints a NEW record and
    consumes a slot of the session's cap, and a ballot expressing no score is not
    a vote: it would be one fewer phone in the room able to submit, in exchange
    for a row the aggregate correctly ignores.

    An axis of the wrong type is refused rather than coerced, because
    `validate_int`'s fallback would store an INVENTED 0 that the aggregate cannot
    tell from a deliberate lowest score.
    """
    axes: dict[str, int] = {}
    for axis in SCORE_AXES:
        value = body.get(axis)
        if value is None:
            continue
        if not _is_clampable_number(value):
            raise ValidationError(
                f'{axis} must be a number between {MIN_AXIS_VALUE} and {MAX_AXIS_VALUE}'
            )
        axes[axis] = validate_int(
            value,
            default=MIN_AXIS_VALUE,
            min_val=MIN_AXIS_VALUE,
            max_val=MAX_AXIS_VALUE,
        )
    if not axes:
        raise ValidationError(
            'a ballot must score at least one of: ' + ', '.join(SCORE_AXES)
        )
    return axes


# ============================================
# Session state
# ============================================


def _session_state(item: dict, now: datetime) -> str:
    """`STATUS_OPEN`, `STATUS_CLOSED`, or the expired reason.

    Expiry is decided by comparing the stored deadline, NOT by the record's
    absence: DynamoDB's TTL deletes an expired item within about 48 hours, so for
    up to two days after a meeting the record is still there and still says
    'open'. Reading the deadline is what makes the wall-clock bound real; the
    `ttl` attribute is only how the row eventually cleans itself up.
    """
    if item.get('status') != STATUS_OPEN:
        return REASON_CLOSED
    expires_at = item.get('ttl')
    try:
        deadline = float(expires_at)
    except (TypeError, ValueError):
        # A session with no readable deadline is treated as expired, i.e. fails
        # CLOSED. A missing bound on the one unauthenticated write path is not
        # something to interpret generously.
        return REASON_EXPIRED
    return STATUS_OPEN if deadline > now.timestamp() else REASON_EXPIRED


def _load_session(session_id: str) -> dict | None:
    try:
        response = _table().get_item(
            Key={'pk': VOTING_SESSION_PK, 'sk': _session_sk(session_id)}
        )
    except ApiError:
        raise
    except Exception as e:
        logger.exception(f'Failed to read voting session {session_id}: {e}')
        raise ServiceError('Failed to read the voting session') from e
    item = response.get('Item')
    return item if isinstance(item, dict) else None


def _session_payload(item: dict, now: datetime) -> dict:
    """The facilitator's view of a session.

    `created_by` is deliberately absent: it identifies a person, the facilitator
    reading this is the only one who can reach the route, and a field nobody
    renders is a field that ends up in a log or an export.
    """
    return {
        'session_id': item.get('session_id', ''),
        'document_id': item.get('document_id', ''),
        'document_title': item.get('document_title', ''),
        'status': item.get('status', STATUS_CLOSED),
        'state': _session_state(item, now),
        'ballot_cap': int(item.get('ballot_cap', 0)),
        'ballot_count': int(item.get('ballot_count', 0)),
        'created_at': item.get('created_at', ''),
        'expires_at': item.get('expires_at', ''),
        'closed_at': item.get('closed_at', ''),
    }


# ============================================
# Facilitator routes (Cognito-authenticated)
# ============================================


@app.post('/voting-sessions')
@tracer.capture_method
def create_voting_session():
    """Open a voting session for ONE scorable document.

    Authenticated: a session is a thing that authorizes anonymous writes, so only
    a signed-in facilitator may create one, and the creator is recorded.

    ONE DOCUMENT, said plainly because it is a known limitation rather than an
    oversight: a proposal that exists as both a PRD row and a PR/FAQ row is two
    documents today, and a room scanning this QR scores the one document this
    session names. Resolving the row unit is a separate change; the facilitator UI
    names the document the session scores so the limitation is visible.
    """
    body = app.current_event.json_body or {}
    document_id = _validated_document_id(body.get('document_id'))
    document_title = _sanitized_text(body.get('document_title'), MAX_DOCUMENT_TITLE_LEN)
    ballot_cap = validate_int(
        body.get('ballot_cap'),
        default=DEFAULT_BALLOT_CAP,
        min_val=MIN_BALLOT_CAP,
        max_val=MAX_BALLOT_CAP,
    )
    minutes = validate_int(
        body.get('expires_in_minutes'),
        default=DEFAULT_SESSION_MINUTES,
        min_val=MIN_SESSION_MINUTES,
        max_val=MAX_SESSION_MINUTES,
    )

    # Fails CLOSED (403) when the caller has no readable subject: a session whose
    # creator is a placeholder records nobody as having opened a public write
    # window.
    creator = get_caller_subject(app.current_event.raw_event)

    now = _now()
    expires = now + timedelta(minutes=minutes)
    session_id = SESSION_ID_PREFIX + secrets.token_hex(SESSION_ID_BYTES)
    item = {
        'pk': VOTING_SESSION_PK,
        'sk': _session_sk(session_id),
        'session_id': session_id,
        'document_id': document_id,
        'document_title': document_title,
        'status': STATUS_OPEN,
        'ballot_cap': ballot_cap,
        'ballot_count': 0,
        'created_by': creator,
        'created_at': now.isoformat(),
        'updated_at': now.isoformat(),
        'expires_at': expires.isoformat(),
        # The aggregates table expires anything carrying this attribute. A session
        # is worthless once expired, so it cleans itself up. A BALLOT never
        # carries it — see the module docstring.
        'ttl': int(expires.timestamp()),
    }

    try:
        _table().put_item(Item=item)
    except ApiError:
        raise
    except Exception as e:
        logger.exception(f'Failed to open voting session for {document_id}: {e}')
        raise ServiceError('Failed to open the voting session') from e

    # The session id is a credential (it is the whole of what the QR carries), so
    # it is logged: an operator needs to be able to see which sessions were opened
    # against which document, and the id alone authorizes nothing without the
    # session being open. The creator's subject is NOT logged — it identifies a
    # person.
    logger.info(f'Opened voting session {session_id} for document {document_id}')
    return {'success': True, 'session': _session_payload(item, now)}


@app.get('/voting-sessions/<session_id>')
@tracer.capture_method
def get_voting_session(session_id: str):
    """The facilitator's status view: is it open, and how many ballots are in."""
    validated = _validated_session_id(session_id)
    if not validated:
        raise NotFoundError('Voting session not found')
    item = _load_session(validated)
    if not item:
        raise NotFoundError('Voting session not found')
    return {'success': True, 'session': _session_payload(item, _now())}


@app.post('/voting-sessions/<session_id>/close')
@tracer.capture_method
def close_voting_session(session_id: str):
    """Close the session. THIS IS THE REVOCATION.

    Idempotent, and deliberately so: "make sure nobody can vote any more" is the
    thing a facilitator does under time pressure, in front of a room, possibly
    twice. A second close answering 404 or 409 would read as "it is still open".

    Conditional on the record EXISTING rather than on its state, because
    `update_item` is an upsert: without that, closing a session id that never
    existed would create a bare `{pk, sk, status: closed}` stub.
    """
    validated = _validated_session_id(session_id)
    if not validated:
        raise NotFoundError('Voting session not found')
    now = _now()
    try:
        response = _table().update_item(
            Key={'pk': VOTING_SESSION_PK, 'sk': _session_sk(validated)},
            UpdateExpression='SET #status = :closed, closed_at = :now, updated_at = :now',
            ConditionExpression='attribute_exists(sk)',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':closed': STATUS_CLOSED, ':now': now.isoformat()},
            ReturnValues='ALL_NEW',
        )
    except ClientError as e:
        if e.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            raise NotFoundError('Voting session not found') from e
        logger.exception(f'Failed to close voting session {validated}: {e}')
        raise ServiceError('Failed to close the voting session') from e
    except Exception as e:
        logger.exception(f'Failed to close voting session {validated}: {e}')
        raise ServiceError('Failed to close the voting session') from e

    logger.info(f'Closed voting session {validated}')
    return {'success': True, 'session': _session_payload(response.get('Attributes', {}), now)}


# ============================================
# Public routes — the room's phones
# ============================================


@app.get('/voting-sessions/<session_id>/config')
@tracer.capture_method
def get_ballot_config(session_id: str):
    """What the ballot page needs before it can show a form. PUBLIC.

    A narrow projection, written as its own dictionary rather than as
    `_session_payload` minus some keys — the same reasoning
    `item_to_widget_config` records in the feedback-form handler. This route is
    reachable by anyone holding the link, so every field here is one somebody
    chose to publish, and adding a field to the facilitator's view must not leak
    it. Notably absent: the creator, the ballot count and the cap. How full the
    room is tells a stranger how many people are in it and helps nobody fill in a
    form.

    A closed, expired or unknown session answers `open: false` with a reason
    rather than an error, because the page's job in that state is to say so in
    words. A room pointing phones at a dead QR otherwise gets a blank screen.
    """
    validated = _validated_session_id(session_id)
    item = _load_session(validated) if validated else None
    if not item:
        return {
            'success': True,
            'session': {'open': False, 'reason': REASON_NOT_FOUND, 'document_title': ''},
        }
    state = _session_state(item, _now())
    return {
        'success': True,
        'session': {
            'open': state == STATUS_OPEN,
            'reason': None if state == STATUS_OPEN else state,
            'document_title': item.get('document_title', ''),
        },
    }


def _existing_ballot(document_id: str, session_id: str, raw_ballot_id: Any) -> str | None:
    """The ballot id this device already has ON THIS SESSION, or None.

    Two checks, and both matter:

    * FORMAT, before any read: the id goes into a sort key, and an unvalidated one
      is the single place a public caller could otherwise influence that key.
    * THE SESSION IT WAS CAST IN: a ballot id from another session must not act as
      a free pass here. Without this, one id obtained legitimately anywhere could
      correct — that is, overwrite — a ballot on any document, without ever
      consuming a cap slot.

    Anything that fails either check is not an error: it is simply not a
    correction, so the submission proceeds as a first ballot, mints a fresh id and
    pays for a slot.
    """
    if not isinstance(raw_ballot_id, str) or not _BALLOT_ID_PATTERN.match(raw_ballot_id.strip()):
        return None
    ballot_id = raw_ballot_id.strip()
    try:
        response = _table().get_item(
            Key={'pk': PRIORITIZATION_PK, 'sk': _ballot_sk(document_id, ballot_id)}
        )
    except ApiError:
        raise
    except Exception as e:
        logger.exception(f'Failed to read an anonymous ballot for session {session_id}: {e}')
        raise ServiceError('Failed to record the ballot') from e
    item = response.get('Item')
    if not isinstance(item, dict) or item.get('voting_session') != session_id:
        return None
    return ballot_id


def _claim_ballot_slot(session_id: str, now: datetime) -> bool:
    """Take one slot of the session's cap, atomically. False when refused.

    THE conditional atomic increment. Everything the read before it checked is
    checked again HERE, because only this is race-proof: a room submitting at once
    means many invocations reading the same count and then writing it, which is
    exactly the interleaving a read-then-write check loses. Four conjuncts:

    * `attribute_exists(sk)` — `update_item` is an upsert, so without this a
      submission against a deleted or invented session id would CREATE a session
      record with one ballot in it.
    * `#status = :open` — closing the session is the revocation, and it has to
      hold at the moment of the write, not at the moment of the read.
    * `#ttl > :now` — the wall-clock bound, read from the stored deadline rather
      than inferred from the row's continued existence (TTL deletion lags by up to
      about 48 hours).
    * `ballot_count < ballot_cap` — the cap. Both attributes are written at
      creation; if either is somehow absent the comparison is false and the
      submission is refused, which is the direction to fail in.
    """
    try:
        _table().update_item(
            Key={'pk': VOTING_SESSION_PK, 'sk': _session_sk(session_id)},
            UpdateExpression='SET ballot_count = ballot_count + :one, updated_at = :now',
            ConditionExpression=(
                'attribute_exists(sk) AND #status = :open AND #ttl > :now_epoch '
                'AND ballot_count < ballot_cap'
            ),
            ExpressionAttributeNames={'#status': 'status', '#ttl': 'ttl'},
            ExpressionAttributeValues={
                ':one': 1,
                ':now': now.isoformat(),
                ':open': STATUS_OPEN,
                ':now_epoch': int(now.timestamp()),
            },
        )
        return True
    except ClientError as e:
        if e.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            return False
        logger.exception(f'Failed to claim a ballot slot on session {session_id}: {e}')
        raise ServiceError('Failed to record the ballot') from e
    except Exception as e:
        logger.exception(f'Failed to claim a ballot slot on session {session_id}: {e}')
        raise ServiceError('Failed to record the ballot') from e


def _write_ballot(
    document_id: str,
    ballot_id: str,
    session_id: str,
    axes: dict[str, int],
    note: str | None,
    display_name: str,
    now: datetime,
) -> None:
    """Upsert one anonymous ballot on its own key.

    A single `update_item`, so a device correcting its vote replaces its own
    record and touches nobody else's — the same property that lets two signed-in
    reviewers save at the same moment without losing each other's numbers.

    NO `ttl` IS EVER ASSIGNED HERE. The aggregates table expires anything carrying
    that attribute, and a ballot is a durable decision record: an expiring one
    would silently leave the team's score weeks after the meeting, with the
    reviewer count quietly falling.

    `voting_session` is stored because it is what makes a correction verifiable
    (see `_existing_ballot`) and because a ballot nobody's name is on should at
    least record which room cast it. `display_name` is stored only when the
    submitter gave one, and no read exposes it today.
    """
    assignments = ['#document_id = :document_id', '#reviewer = :reviewer',
                   '#updated_at = :updated_at', '#voting_session = :voting_session']
    names = {
        '#document_id': 'document_id',
        '#reviewer': 'reviewer',
        '#updated_at': 'updated_at',
        '#voting_session': 'voting_session',
    }
    values: dict[str, Any] = {
        ':document_id': document_id,
        ':reviewer': f'{REVIEWER_KIND_ANON}:{ballot_id}',
        ':updated_at': now.isoformat(),
        ':voting_session': session_id,
    }
    for axis, value in axes.items():
        assignments.append(f'#{axis} = :{axis}')
        names[f'#{axis}'] = axis
        values[f':{axis}'] = value
    if note is not None:
        assignments.append('#notes = :notes')
        names['#notes'] = 'notes'
        values[':notes'] = note
    if display_name:
        assignments.append('#display_name = :display_name')
        names['#display_name'] = 'display_name'
        values[':display_name'] = display_name

    try:
        _table().update_item(
            Key={'pk': PRIORITIZATION_PK, 'sk': _ballot_sk(document_id, ballot_id)},
            UpdateExpression='SET ' + ', '.join(assignments),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
    except ApiError:
        raise
    except Exception as e:
        # Never echoes the note or the display name — both are submitter content,
        # and one of them is PII.
        logger.exception(f'Failed to write an anonymous ballot for session {session_id}: {e}')
        raise ServiceError('Failed to record the ballot') from e


@app.post('/voting-sessions/<session_id>/submit')
@tracer.capture_method
def submit_ballot(session_id: str):
    """Record one anonymous ballot against the session's document. PUBLIC.

    The order of work is the point:

    1. VALIDATE the body before touching the table, so nothing malformed can
       consume a cap slot.
    2. READ the session, to answer with the reason a room can act on — closed,
       expired, no such session.
    3. Is this a CORRECTION? A device sending back an id it was given, on this
       session, upserts its own record and consumes no slot. This is what makes
       "one device, one ballot" true without cookies, accounts or fingerprinting.
    4. Otherwise CLAIM A SLOT with the conditional atomic increment, which is the
       enforcement; the read in step 2 only supplied the wording.
    5. WRITE the ballot on its own key and hand the device its id.

    A failure between 4 and 5 loses a slot without recording a ballot, and answers
    500. That is the honest direction: the alternative (write first, count after)
    would let a flood past the cap, which is the whole thing the cap exists for.
    The document id comes from the SESSION, never from the body — a public caller
    does not get to choose which proposal it is scoring.
    """
    validated_session = _validated_session_id(session_id)
    body = app.current_event.json_body or {}
    axes = _validated_axes(body)
    note = _validated_note(body.get('notes'))
    display_name = _sanitized_text(body.get('display_name'), MAX_DISPLAY_NAME_LEN)

    item = _load_session(validated_session) if validated_session else None
    if not item or not validated_session:
        return _refusal(REASON_NOT_FOUND)
    now = _now()
    state = _session_state(item, now)
    if state != STATUS_OPEN:
        return _refusal(state)

    document_id = item.get('document_id')
    if not isinstance(document_id, str) or not document_id or '#' in document_id:
        # A session that cannot name a ballot key is not a session to write
        # against. Unreachable through `create_voting_session`, which validates
        # the id; refused rather than trusted because the write would otherwise
        # land on a mis-split key and appear in the aggregate as a phantom
        # document.
        logger.error(f'Voting session {validated_session} has no usable document_id')
        return _refusal(REASON_NOT_FOUND)

    ballot_id = _existing_ballot(document_id, validated_session, body.get('ballot_id'))
    corrected = ballot_id is not None
    if ballot_id is None:
        if not _claim_ballot_slot(validated_session, now):
            # The condition is the authority, and it does not say which conjunct
            # failed. Re-read to name the reason: by now the session may have been
            # closed, may have expired, or may be full, and the room deserves the
            # right sentence. A read that comes back open means the cap is what
            # refused.
            refreshed = _load_session(validated_session)
            if not refreshed:
                return _refusal(REASON_NOT_FOUND)
            state = _session_state(refreshed, now)
            return _refusal(REASON_CAP_REACHED if state == STATUS_OPEN else state)
        ballot_id = _minted_ballot_id()

    _write_ballot(document_id, ballot_id, validated_session, axes, note, display_name, now)

    # The ballot id is the device's own credential for correcting its vote, so it
    # is never logged; nor is the note or the display name.
    logger.info(
        f'Recorded an anonymous ballot on session {validated_session} '
        f'(correction={corrected})'
    )
    return {
        'success': True,
        'ballot_id': ballot_id,
        'corrected': corrected,
        'document_title': item.get('document_title', ''),
    }


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
