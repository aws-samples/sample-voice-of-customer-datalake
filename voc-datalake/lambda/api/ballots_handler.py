"""
VoC Anonymous Ballots API Lambda
Handles: /voting-sessions/* — a room scoring ONE PRIORITIZATION ROW from their
phones. A row is a project's set of documents, so the room scores a whole
proposal rather than whichever of its documents a QR happened to sit on.

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
condition is what actually holds the line. A CORRECTION goes through the same
condition, minus the cap it does not consume — see `_hold_open_session`.

AND THE TOKEN IS NEVER WRITTEN TO A LOG IN FULL. While the session is open the id
is a bearer credential, so a log line carrying it would turn log read access into
vote access. Every line in this module puts it through `_session_ref`.

ONE DEVICE, ONE BALLOT
----------------------
Every ballot lands on its own key, `BALLOT#{row_id}#anon:{ballot_id}`, where
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
#
# The first half of the key is a ROW id — a prioritization row, which is one
# project's set of documents. This handler never reads a row record: it has no
# need to know what a row contains, only which one the facilitator opened the vote
# for, and a row's composition is `projects_handler`'s business. What that buys is
# that a room scores the whole proposal rather than one of its documents.
PRIORITIZATION_PK = 'PRIORITIZATION'
BALLOT_SK_PREFIX = 'BALLOT#'
# The row-record prefix `projects_handler.ROW_SK_PREFIX` writes. Read here for one
# purpose only: to check, at session creation, that the row the facilitator names
# exists (`_row_exists`). This module still never composes or interprets a row.
ROW_SK_PREFIX = 'ROW#'
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
#
# It names the ROW now — a project's set of documents — so the sentence the room
# reads is about the proposal it is scoring rather than about one document of it.
# Still `row_title` on the record and in the payload, because what it titles is
# what a ballot is keyed to; a field called `document_title` naming a row would
# be the wrong claim in the one place a public reader looks.
MAX_ROW_TITLE_LEN = 200

# A DynamoDB sort key is capped at 1024 bytes; the same bound `projects_handler`
# holds every id that becomes half of a key to, so an absurd row id is a 400 naming
# the field rather than a ValidationException surfacing as a 500. Named for the key
# SEGMENT, not for a document: what it bounds here is a row id.
MAX_KEY_SEGMENT_ID_LEN = 256


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
# A body this route cannot read: an axis that is not a number, a note past the
# bound, a ballot that scores nothing. PERMANENT, which is why it needs a reason
# of its own: the shared `ValidationError` handler answers 400 with a message and
# no `reason`, and the page reads only the reason — so every one of these arrived
# as `unknown` and was rendered as "try again in a moment", which is advice that
# can never work.
REASON_INVALID = 'invalid'

_REFUSAL_STATUS = {
    REASON_NOT_FOUND: 404,
    REASON_CLOSED: 409,
    REASON_EXPIRED: 409,
    # 429 rather than 409: the session is in a perfectly good state and the
    # request is one too many, which is what "too many requests" means. It also
    # keeps "the room filled up" distinguishable from "the facilitator sat down"
    # for a page that shows different words for each.
    REASON_CAP_REACHED: 429,
    REASON_INVALID: 400,
}

_REFUSAL_MESSAGE = {
    REASON_NOT_FOUND: 'This voting session does not exist',
    REASON_CLOSED: 'This voting session is closed',
    REASON_EXPIRED: 'This voting session has expired',
    REASON_CAP_REACHED: 'This voting session has reached its ballot limit',
    REASON_INVALID: 'This ballot could not be read',
}


def _refusal(reason: str, message: str | None = None) -> Response:
    """One refusal shape for every reason a ballot is not accepted.

    `message` overrides the human sentence while leaving the machine-readable
    `reason` alone — used for a validation refusal, where the validator's own
    message names the field and the bound and is worth more to somebody holding a
    terminal than 'could not be read'. It never echoes submitted content: every
    validator in this module reports the field and the limit, never the value.
    """
    return Response(
        status_code=_REFUSAL_STATUS[reason],
        content_type=content_types.APPLICATION_JSON,
        body=json.dumps({
            'success': False,
            'reason': reason,
            'error': message or _REFUSAL_MESSAGE[reason],
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


def _json_object_body() -> dict:
    """The request body as a JSON object, or a ValidationError.

    Every route here reads its body through this, because `json_body` alone is two
    unhandled failures on a route a stranger can reach: unparseable JSON raises
    `JSONDecodeError`, and a body that parses to a LIST or a string passes the
    `or {}` guard truthy and then dies on `.get` — both of which surface as a bare
    500 with nothing the page can say. A `ValidationError` instead becomes the
    caller's own refusal reason (see `REASON_INVALID`).
    """
    try:
        body = app.current_event.json_body
    except ValueError as e:
        # json.JSONDecodeError is a ValueError; a body that is not JSON at all is
        # the caller's mistake, not this service's.
        raise ValidationError('the request body must be JSON') from e
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise ValidationError('the request body must be a JSON object')
    return body


def _session_sk(session_id: str) -> str:
    return f'{SESSION_SK_PREFIX}{session_id}'


# How much of a session id may be written to a log. The full id is the BEARER
# CREDENTIAL the QR carries: while the session is open, anyone who can read a log
# line containing it can cast a ballot, so log read access would become vote
# access. An operator needs to correlate the lines about one session and to see
# which document a session was opened for; neither needs the whole token.
#
# Eight hex characters is 32 bits of the id, which distinguishes a meeting's
# sessions from each other while leaving 96 bits unknown — and the record itself
# still has to be open, unexpired and under its cap before those bits are worth
# guessing.
SESSION_LOG_REF_CHARS = 8


def _session_ref(session_id: Any) -> str:
    """A session id in a form that is safe to log.

    Every log line in this module goes through this. The truncation is the point:
    see `SESSION_LOG_REF_CHARS`.
    """
    if not isinstance(session_id, str):
        return '<none>'
    return session_id[:len(SESSION_ID_PREFIX) + SESSION_LOG_REF_CHARS] + '...'


def _ballot_sk(row_id: str, ballot_id: str) -> str:
    """The ballot's sort key: kind-namespaced, so an anonymous ballot can never
    land on a signed-in reviewer's key.

    Both halves are known not to contain '#': the row id is checked on the
    way in (`_validated_row_id`) and the ballot id is minted here as hex.
    That is what keeps `BALLOT#{id}#{kind}:{subject}` splittable by the read.
    """
    return f'{BALLOT_SK_PREFIX}{row_id}#{REVIEWER_KIND_ANON}:{ballot_id}'


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


def _validated_row_id(raw: Any) -> str:
    """Check that a facilitator-supplied ROW id can be a ballot sort key.

    The same three rules `projects_handler._validated_ballot_row_id` applies,
    for the same reasons: '#' is the sort-key delimiter and would make the key
    ambiguous to the read, and an absurd length is a 400 naming the field rather
    than a DynamoDB ValidationException surfacing as a 500. Neither message echoes
    the value, which is unbounded caller input.

    The SHAPE only; existence is the route's check (`_row_exists`), because this
    function has one key in hand and no table. The route CAN check existence
    honestly — one `get_item` on the aggregates table, which is exactly the
    read this Lambda's role already grants — and it must (#342): a session
    opened for a row that does not resolve collects a room's ballots that the
    page then discards on read, and a room's votes are unrepeatable. The check
    is at session CREATION and not at submit, deliberately: submit takes the
    row id from the stored session, never from the body, so a session that
    named a real row cannot start naming a phantom one (nothing deletes rows
    today — phase 2's delete path owes the write-time condition), and the
    public submit path stays at its current cost.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValidationError('row_id is required')
    row_id = raw.strip()
    if '#' in row_id:
        raise ValidationError("row_id must not contain '#', the sort-key delimiter")
    if len(row_id) > MAX_KEY_SEGMENT_ID_LEN:
        raise ValidationError(
            f'row_id must be at most {MAX_KEY_SEGMENT_ID_LEN} characters'
        )
    return row_id


def _row_exists(row_id: str) -> bool:
    """Does a row record exist for this id — the check a session must pass to open.

    One `get_item`, the read this role already grants. A FAILED read raises
    rather than answering either way: "missing" refuses a facilitator standing
    in front of a room over a transient throttle, and "present" opens a window
    that collects unrepeatable votes the page will discard (#342). The same
    direction the signed-in save path fails in, for the same reason.
    """
    table = _table()  # its ConfigurationError is not this read's failure
    try:
        # Strongly consistent, because this read GATES the write that opens a
        # public window: the facilitator's flow is create-row-then-open-vote,
        # and an eventually-consistent read can miss a row created moments ago
        # — refusing a legitimate session with 404 in front of a room.
        response = table.get_item(
            Key={'pk': PRIORITIZATION_PK, 'sk': f'{ROW_SK_PREFIX}{row_id}'},
            ConsistentRead=True,
        )
    except Exception as e:
        logger.exception(f'Failed to read a prioritization row before opening a session: {e}')
        raise ServiceError('Failed to open the voting session') from e
    return isinstance(response.get('Item'), dict)


def _sanitized_text(raw: Any, max_length: int) -> str:
    """Free text reduced to something safe to store and to show a room.

    Control characters go rather than being escaped — a name or a title has no use
    for them, and they are what turns stored text into a forged extra line in a log
    or a terminal. The two Unicode categories are treated DIFFERENTLY, on purpose:

    * 'Cc' (C0/C1 controls, which includes newline and tab) becomes a SPACE. Simply
      deleting it would join what the submitter separated, so `'Sam\\nADMIN'` would
      read back as the single name `'SamADMIN'` — a worse outcome than the newline,
      because it fabricates a plausible name nobody typed.
    * 'Cf' (format characters: the bidi overrides and zero-width joiners) is
      DELETED, because it separates nothing. Those are what make one displayed name
      impersonate another, and turning each into a space would instead put a gap
      inside a legitimate name that needs one to render.

    Whitespace is then collapsed, so 60 spaces is not a name, and the result is
    truncated: a display name is a courtesy rather than content, so unlike a note
    there is nothing lost worth refusing the whole ballot over.
    """
    if not isinstance(raw, str):
        return ''
    cleaned = []
    for ch in raw:
        category = unicodedata.category(ch)
        if category == 'Cc':
            cleaned.append(' ')
        elif category != 'Cf':
            cleaned.append(ch)
    return ' '.join(''.join(cleaned).split())[:max_length]


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


def _session_row_id(item: dict) -> str:
    """The row a session's ballots are keyed to, or '' if the record cannot name one.

    '' for a session written by the deployment BEFORE this one, which recorded a
    `document_id` and no `row_id`. Such a session is not adopted onto the document
    it names: the document id is not a row id, so every ballot would land on
    `BALLOT#{document_id}#anon:...`, a key the page resolves to no row and drops on
    read — the room votes, each phone says "thanks", and the team's score does not
    move. That silent loss is the exact failure the sort-key lockstep test exists to
    prevent, so it is not worth buying deploy continuity with.

    Instead the caller treats '' as CLOSED (see `_session_state`), which is a state
    the ballot page already has words for and the facilitator already has a button
    for: re-open, put the new QR on screen, and the room's ballots land on the row.
    """
    row_id = item.get('row_id')
    return row_id if isinstance(row_id, str) and row_id and '#' not in row_id else ''


def _session_row_title(item: dict) -> str:
    """What to call the thing being scored, tolerating a pre-row session record.

    Falls back to the legacy `document_title` purely so the facilitator's own status
    view names the session it is telling them is closed. Titling is presentation and
    a stale title misleads nobody; keying is not, which is why `_session_row_id`
    refuses the matching fallback.
    """
    for key in ('row_title', 'document_title'):
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return ''


def _session_state(item: dict, now: datetime) -> str:
    """`STATUS_OPEN`, `STATUS_CLOSED`, or the expired reason.

    Expiry is decided by comparing the stored deadline, NOT by the record's
    absence: DynamoDB's TTL deletes an expired item within about 48 hours, so for
    up to two days after a meeting the record is still there and still says
    'open'. Reading the deadline is what makes the wall-clock bound real; the
    `ttl` attribute is only how the row eventually cleans itself up.

    A record that names no usable ROW reads as CLOSED, and that is what carries this
    change across its own deploy. A session opened by the previous deployment holds a
    `document_id` and no `row_id`; answering `open: true` for it would give a room a
    green ballot page whose every submission is then refused by `submit_ballot`, or —
    had the id been adopted — recorded on a key no aggregate reads. Closed is the one
    answer that is both true of what can be done with the session and already
    expressible on the pages: the room reads "this voting session is closed" and the
    facilitator re-opens, which composes a session on the row.
    """
    if item.get('status') != STATUS_OPEN or not _session_row_id(item):
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
        logger.exception(f'Failed to read voting session {_session_ref(session_id)}: {e}')
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
        'row_id': _session_row_id(item),
        'row_title': _session_row_title(item),
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
    """Open a voting session for ONE PRIORITIZATION ROW.

    Authenticated: a session is a thing that authorizes anonymous writes, so only
    a signed-in facilitator may create one, and the creator is recorded.

    ONE ROW, which is one project's set of documents — so a room scanning this QR
    scores a whole proposal, not whichever of its documents the QR sat on. That was
    the known limitation this module's docstring used to name as a separate change;
    it is this one, and what changed is a single slot in the key.

    The row is named, not composed, here: this Lambda has no access to the projects
    table by design and never interprets a row record. It does now check that one
    EXISTS (`_row_exists`, #342): a session is a public write window onto that row,
    and one opened for a row nothing describes collects a room's ballots that the
    page then discards — votes that cannot be recast. `row_title` is still copied
    onto the session so the public page can say what is being scored without
    reading anything.
    """
    body = _json_object_body()
    row_id = _validated_row_id(body.get('row_id'))
    if not _row_exists(row_id):
        # 404 about the world, not 400 about the request: the id is well-formed
        # and the page sent one it was shown — a row created moments ago in
        # another tab, or a stale tab after this deployment re-keyed rows. The
        # id is not echoed (unbounded caller input, the module's standing rule).
        raise NotFoundError(
            'that prioritization row does not exist; reload the page and '
            'reopen the vote'
        )
    row_title = _sanitized_text(body.get('row_title'), MAX_ROW_TITLE_LEN)
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
        'row_id': row_id,
        'row_title': row_title,
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
        logger.exception(f'Failed to open voting session for {row_id}: {e}')
        raise ServiceError('Failed to open the voting session') from e

    # TRUNCATED, because the session id is the credential the QR carries and this
    # line would otherwise hand a vote to anyone who can read a log. What an
    # operator actually needs is which row a session was opened against and
    # enough of the id to follow that session's other lines, which
    # `_session_ref` leaves intact. The creator's subject is not logged at all —
    # it identifies a person.
    logger.info(f'Opened voting session {_session_ref(session_id)} for row {row_id}')
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
        logger.exception(f'Failed to close voting session {_session_ref(validated)}: {e}')
        raise ServiceError('Failed to close the voting session') from e
    except Exception as e:
        logger.exception(f'Failed to close voting session {_session_ref(validated)}: {e}')
        raise ServiceError('Failed to close the voting session') from e

    logger.info(f'Closed voting session {_session_ref(validated)}')
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
            'session': {'open': False, 'reason': REASON_NOT_FOUND, 'row_title': ''},
        }
    state = _session_state(item, _now())
    return {
        'success': True,
        'session': {
            'open': state == STATUS_OPEN,
            'reason': None if state == STATUS_OPEN else state,
            # Names the ROW — a project's set of documents — so the sentence a
            # phone reads is about the proposal it is scoring. Copied off the
            # session, which is what the facilitator put on screen.
            'row_title': _session_row_title(item),
        },
    }


def _existing_ballot(row_id: str, session_id: str, raw_ballot_id: Any) -> str | None:
    """The ballot id this device already has ON THIS SESSION, or None.

    Two checks, and both matter:

    * FORMAT, before any read: the id goes into a sort key, and an unvalidated one
      is the single place a public caller could otherwise influence that key.
    * THE SESSION IT WAS CAST IN: a ballot id from another session must not act as
      a free pass here. Without this, one id obtained legitimately anywhere could
      correct — that is, overwrite — a ballot on any row, without ever
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
            Key={'pk': PRIORITIZATION_PK, 'sk': _ballot_sk(row_id, ballot_id)}
        )
    except ApiError:
        raise
    except Exception as e:
        logger.exception(f'Failed to read an anonymous ballot for session {_session_ref(session_id)}: {e}')
        raise ServiceError('Failed to record the ballot') from e
    item = response.get('Item')
    if not isinstance(item, dict) or item.get('voting_session') != session_id:
        return None
    return ballot_id


def _hold_open_session(session_id: str, now: datetime, *, claim_slot: bool) -> bool:
    """Assert at WRITE TIME that the session still accepts this ballot, in one
    conditional write. False when it refuses.

    Everything the read before it checked is checked again HERE, because only this
    is race-proof: a room submitting at once means many invocations reading the
    same record and then writing, which is exactly the interleaving a
    read-then-write check loses. The read only supplied the wording of the refusal.

    Three conjuncts always hold:

    * `attribute_exists(sk)` — `update_item` is an upsert, so without this a
      submission against a deleted or invented session id would CREATE a session
      record out of thin air.
    * `#status = :open` — closing the session is the revocation, and it has to
      hold at the moment of the write, not at the moment of the read.
    * `#ttl > :now` — the wall-clock bound, read from the stored deadline rather
      than inferred from the row's continued existence (TTL deletion lags by up to
      about 48 hours).

    `claim_slot` adds the FOURTH conjunct and the increment, and is what
    distinguishes the two ways a ballot arrives:

    * A NEW ballot claims a slot: `ballot_count < ballot_cap`, then
      `ballot_count + 1`. Both attributes are written at creation; if either is
      somehow absent the comparison is false and the submission is refused, which
      is the direction to fail in.
    * A CORRECTION claims none — it upserts a record this device already owns, so
      it consumes nothing and the cap does not apply to it. It still takes this
      path, though, so that a correction is refused by the same authority a new
      ballot is: without it the correction path checked the session only at the
      READ, and a device could amend its vote after the facilitator closed the
      room. That asymmetry is the bug this argument exists to remove; the write is
      a bare `updated_at` touch whose only purpose is to carry the condition.
    """
    assignments = ['updated_at = :now']
    condition = ['attribute_exists(sk)', '#status = :open', '#ttl > :now_epoch']
    values: dict[str, Any] = {
        ':now': now.isoformat(),
        ':open': STATUS_OPEN,
        ':now_epoch': int(now.timestamp()),
    }
    if claim_slot:
        assignments.append('ballot_count = ballot_count + :one')
        condition.append('ballot_count < ballot_cap')
        # Added only on this branch: DynamoDB rejects an ExpressionAttributeValues
        # entry that no expression references.
        values[':one'] = 1

    try:
        _table().update_item(
            Key={'pk': VOTING_SESSION_PK, 'sk': _session_sk(session_id)},
            UpdateExpression='SET ' + ', '.join(assignments),
            ConditionExpression=' AND '.join(condition),
            ExpressionAttributeNames={'#status': 'status', '#ttl': 'ttl'},
            ExpressionAttributeValues=values,
        )
        return True
    except ClientError as e:
        if e.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            return False
        logger.exception(f'Failed to claim a ballot slot on session {_session_ref(session_id)}: {e}')
        raise ServiceError('Failed to record the ballot') from e
    except Exception as e:
        logger.exception(f'Failed to claim a ballot slot on session {_session_ref(session_id)}: {e}')
        raise ServiceError('Failed to record the ballot') from e


def _write_ballot(
    row_id: str,
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
    # `row_id`, the same attribute name the signed-in save stamps
    # (`BALLOT_STAMP_FIELDS` in `projects_handler`), because both write the same
    # kind of record and it is read back by one page.
    assignments = ['#row_id = :row_id', '#reviewer = :reviewer',
                   '#updated_at = :updated_at', '#voting_session = :voting_session']
    names = {
        '#row_id': 'row_id',
        '#reviewer': 'reviewer',
        '#updated_at': 'updated_at',
        '#voting_session': 'voting_session',
    }
    values: dict[str, Any] = {
        ':row_id': row_id,
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
            Key={'pk': PRIORITIZATION_PK, 'sk': _ballot_sk(row_id, ballot_id)},
            UpdateExpression='SET ' + ', '.join(assignments),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
    except ApiError:
        raise
    except Exception as e:
        # Never echoes the note or the display name — both are submitter content,
        # and one of them is PII.
        logger.exception(f'Failed to write an anonymous ballot for session {_session_ref(session_id)}: {e}')
        raise ServiceError('Failed to record the ballot') from e


@app.post('/voting-sessions/<session_id>/submit')
@tracer.capture_method
def submit_ballot(session_id: str):
    """Record one anonymous ballot against the session's ROW. PUBLIC.

    The order of work is the point:

    1. VALIDATE the body before touching the table, so nothing malformed can
       consume a cap slot.
    2. READ the session, to answer with the reason a room can act on — closed,
       expired, no such session.
    3. Is this a CORRECTION? A device sending back an id it was given, on this
       session, upserts its own record and consumes no slot. This is what makes
       "one device, one ballot" true without cookies, accounts or fingerprinting.
    4. HOLD THE SESSION with the conditional write, which is the enforcement; the
       read in step 2 only supplied the wording. A new ballot claims a slot of the
       cap here; a correction claims none but is checked by the same condition, so
       neither can land after the room was closed.
    5. WRITE the ballot on its own key and hand the device its id.

    A failure between 4 and 5 loses a slot without recording a ballot, and answers
    500. That is the honest direction: the alternative (write first, count after)
    would let a flood past the cap, which is the whole thing the cap exists for.
    The row id comes from the SESSION, never from the body — a public caller
    does not get to choose which proposal it is scoring.
    """
    validated_session = _validated_session_id(session_id)
    try:
        body = _json_object_body()
        axes = _validated_axes(body)
        note = _validated_note(body.get('notes'))
    except ValidationError as e:
        # Answered as a REFUSAL rather than left to the shared `ValidationError`
        # handler, which returns 400 with a message and no `reason`. This page
        # reads only the reason, so every malformed ballot arrived as `unknown`
        # and was rendered as "try again in a moment" — advice that can never
        # work for a permanent failure. The validator's own message is carried
        # through for anyone reading the body directly; it names the field and
        # the bound, never the value.
        return _refusal(REASON_INVALID, e.message)
    display_name = _sanitized_text(body.get('display_name'), MAX_DISPLAY_NAME_LEN)

    item = _load_session(validated_session) if validated_session else None
    if not item or not validated_session:
        return _refusal(REASON_NOT_FOUND)
    now = _now()
    state = _session_state(item, now)
    if state != STATUS_OPEN:
        return _refusal(state)

    row_id = _session_row_id(item)
    if not row_id:
        # Unreachable: `_session_state` above already reads a record naming no
        # usable row as CLOSED, which is what a session from the deployment before
        # this one — holding a `document_id` and no `row_id` — answers, and it is
        # answered with words both pages have. Kept as a belt-and-braces guard
        # because the alternative is writing a mis-split sort key that surfaces in
        # the aggregate as a phantom row, and because it must not silently become
        # reachable if that state test is ever relaxed.
        logger.error(f'Voting session {_session_ref(validated_session)} has no usable row_id')
        return _refusal(REASON_CLOSED)

    ballot_id = _existing_ballot(row_id, validated_session, body.get('ballot_id'))
    corrected = ballot_id is not None

    # BOTH paths pass through the conditional write, and that is the point: a
    # correction consumes no slot, but it must be refused by the same authority a
    # new ballot is. Checking the session only at the read above would let a device
    # amend its vote after the facilitator closed the room.
    if not _hold_open_session(validated_session, now, claim_slot=not corrected):
        # The condition is the authority, and it does not say which conjunct
        # failed. Re-read to name the reason: by now the session may have been
        # closed, may have expired, or may be full, and the room deserves the
        # right sentence.
        refreshed = _load_session(validated_session)
        if not refreshed:
            return _refusal(REASON_NOT_FOUND)
        state = _session_state(refreshed, now)
        if state != STATUS_OPEN:
            return _refusal(state)
        # It reads open, so the conjunct that refused is one the read cannot see —
        # the cap, which is the only conjunct a claiming submission has and a
        # correction does not. A correction reaching here would mean the session
        # was shut between the two calls and re-opened, which no route can do, so
        # it answers CLOSED: the fail-closed reading of a refusal nothing explains.
        return _refusal(REASON_CAP_REACHED if not corrected else REASON_CLOSED)

    if ballot_id is None:
        ballot_id = _minted_ballot_id()

    _write_ballot(row_id, ballot_id, validated_session, axes, note, display_name, now)

    # The ballot id is the device's own credential for correcting its vote, so it
    # is never logged; nor is the note or the display name.
    logger.info(
        f'Recorded an anonymous ballot on session {_session_ref(validated_session)} '
        f'(correction={corrected})'
    )
    return {
        'success': True,
        'ballot_id': ballot_id,
        'corrected': corrected,
        'row_title': _session_row_title(item),
    }


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
