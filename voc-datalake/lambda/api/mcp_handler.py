"""
MCP (Model Context Protocol) Server Lambda Handler.

Implements the MCP JSON-RPC protocol over HTTP with Bearer token authentication.
Tokens are validated against hashed tokens stored in DynamoDB (created via the
MCP Access tab in the frontend).

Public endpoint — no Cognito auth. Auth is handled by validating the Bearer token
from the Authorization header against SHA-256 hashes in the projects table.
"""

import base64
import binascii
import hashlib
import json
import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from aws_lambda_powertools import Logger, Tracer, Metrics
from boto3.dynamodb.conditions import Key
# Imported as a module because botocore's own `ConnectionError` would shadow the builtin.
from botocore import exceptions as botocore_exceptions

from shared.api import DecimalEncoder, MAX_FEEDBACK_WINDOW_DAYS, SEARCH_QUERY_MIN_LENGTH
from shared.mcp_delegate import (
    DelegationUnavailable,
    DomainCall,
    DomainResult,
    call_domain,
    synthetic_claims,
)
from shared.mcp_tokens import (
    MCP_TOKEN_PK,
    REACH_KIND_PROJECT,
    REACH_KIND_WORKSPACE,
    REACH_NONE,
    REACH_PROJECT_SET,
    REACH_WORKSPACE,
    SCOPE_FEEDBACK_READ,
    SCOPE_METRICS_READ,
    SCOPE_PROJECTS_READ,
    DEFAULT_READ_REACH,
    parse_token,
    reach_allows,
    secret_matches,
    token_sk,
)
from shared.tables import get_projects_table

logger = Logger()
tracer = Tracer()
metrics = Metrics(namespace="VoC-MCP")

# The ONLY table this function reads directly, and only its token partition:
# authentication is the one thing that cannot be delegated, because it is what
# decides who the delegated call is made as. Every tool's data now comes from
# the domain function that owns the route (shared/mcp_delegate.py), which is why
# FEEDBACK_TABLE and AGGREGATES_TABLE are gone from this Lambda's environment
# and its role no longer holds a grant on either.
projects_table = get_projects_table()

# MCP protocol versions — a RANGE that is negotiated, not one pinned string.
#
# The skew this replaces was real and was recorded here: `structuredContent` and
# `outputSchema` arrived in the 2025-06-18 revision while the handler advertised
# 2024-11-05, so it shipped fields the version it claimed does not define. The
# honest fix is not to bump the number — it is to negotiate, because a number
# alone claims a conformance the envelope has to actually provide (`resultType`,
# transport-header validation, `server/discover`), which is what this change adds.
#
# ⚠️ 2026-07-28 IS DELIBERATELY ABSENT, and this is the same argument the previous
# `MCP_PROTOCOL_VERSION` comment used to defer the bump in the first place. That
# revision REMOVES the `initialize` handshake and protocol-level sessions: every
# request instead carries `io.modelcontextprotocol/protocolVersion` and
# `clientCapabilities` in `_meta` as REQUIRED fields, a request missing them must
# be refused with -32602, and the `MCP-Protocol-Version` header must match the
# `_meta` value. This handler implements none of that — it reads the version from
# the header alone, ignores request `_meta`, and still routes the handshake through
# `initialize`, which the spec's own compatibility matrix calls a "legacy server"
# and where it notes a modern client FAILS. Advertising it would have been the
# exact dishonesty this range was created to end: a client that took the
# counter-offer at face value and then sent modern requests would be served by a
# handler ignoring the metadata it was told to trust.
#
# So this is the honest range: every revision here is handshake-based and is one
# this envelope really implements. 2026-07-28 is the next phase's work, and it is
# a real phase (per-request `_meta`, the -32602 refusal, the header/`_meta` match)
# rather than an entry in this tuple.
#
# The OLDEST entry is here for compatibility rather than because it defines
# anything this server needs, and leaving it out was a live client break: the
# deployed handler pinned 2024-11-05, so every client that has completed a
# handshake against it sends `MCP-Protocol-Version: 2024-11-05` on every
# subsequent request — which a header validator that only knew the newer revisions
# refused with a 400. Accepting a revision is not the same as preferring it.
#
# ⚠️ 2025-03-26 IS DELIBERATELY ABSENT TOO, and for the same class of reason as
# 2026-07-28: it is the ONE revision that mandates JSON-RPC BATCHING, and this
# handler implements none. That revision's *Sending Messages to the Server* says
# the POST body MUST be a single message, "an array batching one or more requests
# and/or notifications", or an array of responses — batching arrived in 2025-03-26
# and was removed again in 2025-06-18, so it is a one-revision-wide obligation this
# range happened to straddle. Advertising it while answering a legal batch body
# with `404 -32601 "Method not found: "` was the same skew this tuple exists to
# end, and the 404 was worse than the wrong code: on the advertised revisions a 404
# on this endpoint means the SESSION was terminated and the client MUST
# re-initialize, so a client batching its `initialized` notification was told to
# tear down and try again — which got it there again.
#
# It SURVIVES as `ASSUMED_PROTOCOL_VERSION` below, which is not a contradiction:
# the spec names 2025-03-26 as the READING for a request carrying no header at all,
# and a fallback reading is not an advertisement. Nothing is offered on it, so no
# client concludes from a counter-offer that its batches will be served. A client
# whose own newest revision is 2025-03-26 and which sends the header now gets the
# spec's -32022 with `data.supported` and retries on 2024-11-05 or 2025-06-18 —
# one round trip, against a batch body being answered with a session teardown.
#
# A batch body is refused explicitly rather than left to fall through the dispatch:
# see `_is_batch` and the `-32600` refusal in `lambda_handler`.
#
# Ordered NEWEST FIRST, and that order is load-bearing: `_negotiate_protocol_version`
# answers with the client's version when it is one of these, and otherwise with
# the first entry — the newest this server speaks — which is what the spec's
# initialize handshake tells a client to expect when its request cannot be met.
SUPPORTED_PROTOCOL_VERSIONS: tuple[str, ...] = (
    "2025-11-25",
    "2025-06-18",
    "2024-11-05",
)

# The revisions whose TRANSPORT-LEVEL BODY GRAMMAR this handler does not accept, so
# that "we advertise only what we implement" is checked rather than remembered.
# 2025-03-26 requires an array body to be handled; this server refuses one.
#
# Declared beside the tuple it constrains, and asserted against it below, because
# the way this went wrong was a revision being re-added for a good reason (a header
# validator was refusing deployed clients) by someone reasoning about the header
# and not about the body grammar.
BODY_GRAMMAR_UNIMPLEMENTED_VERSIONS: frozenset[str] = frozenset({"2025-03-26"})

# `raise` rather than `assert`, which this tree requires: a bare `assert` is
# stripped under `python -O`.
if set(SUPPORTED_PROTOCOL_VERSIONS) & BODY_GRAMMAR_UNIMPLEMENTED_VERSIONS:
    raise RuntimeError(
        'advertising a revision whose body grammar this handler does not accept: '
        f'{sorted(set(SUPPORTED_PROTOCOL_VERSIONS) & BODY_GRAMMAR_UNIMPLEMENTED_VERSIONS)}'
    )

# What an `initialize` that asks for nothing usable is answered with. Derived
# rather than restated so it cannot disagree with the tuple above.
#
# This replaces the `MCP_PROTOCOL_VERSION` constant outright rather than aliasing
# it. An alias would have kept a name meaning "the only version this server
# speaks" alive next to the tuple that makes that untrue — and nothing outside
# this module read it, so keeping it would have been a second name for one fact,
# maintained by nobody.
PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

# What a request carrying NO `MCP-Protocol-Version` header is read as, which is
# not the preferred version and is the spec's own backwards-compatibility rule:
# the header was introduced in 2025-06-18, so a request without it comes from a
# client written against an earlier revision, and 2025-03-26 is the value the spec
# names for that case. Reading absence as the NEWEST supported revision — as this
# did — silently upgrades exactly the clients that cannot be upgraded.
#
# ⚠️ DELIBERATELY NOT IN `SUPPORTED_PROTOCOL_VERSIONS`, and the distinction is the
# whole reason this is a separate constant rather than an index into that tuple. A
# FALLBACK READING is what this server assumes about a client that said nothing; an
# ADVERTISEMENT is what it offers a client that asked. 2025-03-26 mandates JSON-RPC
# batching, which this handler does not implement (see the tuple's comment), so it
# must not be offered — and it is exactly the value the spec tells a server to
# assume for a header-less request, so it must not be dropped either. Nothing reads
# this value beyond `_validated_protocol_version`, which is what makes assuming an
# unadvertised revision harmless: the assumption gates nothing and shapes nothing.
ASSUMED_PROTOCOL_VERSION = "2025-03-26"

# 🔑 THE NEGOTIATED VERSION IS A GATE, NOT A MODE — and this is a deliberate
# decision rather than an unfinished one, recorded here because the alternative is
# a reader hunting for a consumer that does not exist.
#
# `_validated_protocol_version` is called for its EXCEPTION: nothing reads its
# return value, and nothing reads `ASSUMED_PROTOCOL_VERSION` beyond it.
# `_handle_initialize` puts the negotiated version in its answer and no later
# request consults what was negotiated. So the version decides whether a request is
# SERVED, never what it is served.
#
# That is honest as long as the envelope is revision-invariant, which it is: every
# revision in the range above is handshake-based, none of them differs in a way
# this server exercises, and the same fields go out whichever one was negotiated.
# The transport's stated purpose for the header — "allowing the MCP server to
# respond based on the MCP protocol version" — is therefore satisfied vacuously
# rather than ignored.
#
# Per-revision response SHAPING is the next phase's work, and it arrives with
# 2026-07-28 rather than before it: that is the revision that actually defines
# fields the older ones do not (see the provenance note below), so it is the first
# one where "which revision is this" changes what should be sent. Threading the
# validated version into the dispatch now would add a parameter every handler
# ignores, which is a seam that looks load-bearing and is not.
#
# ---------------------------------------------------------------------------
# ⚠️ PROVENANCE: what this envelope sends that the advertised range does not define
# ---------------------------------------------------------------------------
#
# Several envelope constructs here are defined by 2026-07-28 — the revision this
# server deliberately does NOT advertise. Recorded once, and referenced from each
# declaration, so the next reader can tell a deliberate forward-compatibility bet
# from a mistake:
#
#   • `resultType` (`RESULT_TYPE_KEY`, value `complete`)
#   • `ttlMs` and `cacheScope` (`CACHE_SCOPE_*`, `_TOOL_LIST_TTL_MS`,
#     `_DISCOVER_TTL_MS`)
#   • `-32020 HeaderMismatch` and `-32022 UnsupportedProtocolVersion`
#   • the `server/discover` method and its `DiscoverResult` field names
#
# None of these appears in 2025-11-25 or earlier. They are sent anyway, and it is
# safe because it is ADDITIVE: those revisions' `Result` is
# `additionalProperties: {}` and `ListToolsResult` sets no
# `additionalProperties: false`, so a conforming client of an advertised revision
# IGNORES a member it does not know rather than rejecting the message. No field
# any advertised revision defines is replaced or retyped — `_additive_only` in the
# envelope tests pins that half, which is the half that could break a client.
#
# The alternative was to hold these back until 2026-07-28 is negotiable, which
# would mean shipping a locally-invented equivalent in the meantime and renaming it
# later — the exact defect the previous round removed.
#
# THE ERROR CODES ARE THE ONE JUDGEMENT CALL, so it is stated rather than implied.
# 2026-07-28 reserves -32020..-32099 for the specification and says an
# implementation "MUST NOT emit any code from this sub-range that is not defined by
# this specification". Read literally, that rule is satisfied: -32020 and -32022
# ARE defined by that specification and are used with exactly its meaning, and no
# neighbour in the range is invented. Read from a 2025-11-25 client's seat, the
# sub-range has no definitions at all, so the code is one that client cannot
# interpret. Both readings were weighed and the codes are KEPT:
#
#   • the fallback, `-32600`, is actively worse for the client this matters to. The
#     transport's backward-compatibility rules have a dual-era client read a 400
#     body for a RECOGNIZED modern error to conclude "modern server, retry with a
#     supported version", and anything else to conclude "legacy server". `-32600`
#     sent a client that merely guessed a version wrong into legacy fallback
#     against a server advertising a modern revision. That was the earlier finding
#     these codes exist to answer.
#   • an unrecognized error CODE is not a validation failure the way an
#     unrecognized `resultType` value is. There is no schema rule obliging a client
#     to reject it, the human-readable `message` is unaffected, and the recovery
#     path travels in `data.supported`, which a client reads without knowing the
#     code at all.
#
# When 2026-07-28 becomes negotiable, none of this changes shape — it stops being
# early. What changes is that these constructs become REQUIRED rather than
# additive, and the reserved-range question stops having two readings.
# ---------------------------------------------------------------------------

# Semver on the SERVER, independent of the protocol revision above, and the only
# signal a client gets that a tool's output shape moved — it is advertised in
# `serverInfo` on every `initialize`.
#
# 2.0.0 carried `structuredContent` alongside the text block, turned sad paths
# that used to arrive as prose in a successful result into tool errors, and made
# `get_project` report the documents it had been dropping.
#
# 3.0.0 changes the persona shape both persona-reporting tools publish:
# `list_personas` now mirrors `schemas/persona.schema.json` and no longer
# declares `goals`, `age_range`, `occupation`, `quote`, `journey_stage` or
# `type`, and `get_project`'s persona summary reports `tagline` in place of
# `type`. Those six keys existed on no stored row and `list_personas` was
# uncallable against real data, so nothing could have consumed them — but a
# client coded against the NAMES loses them, which is a major bump by this
# file's own rule rather than a judgement about how many clients exist.
#
# 3.1.0 ADDS `is_partial` to `search_feedback`'s output — an added field, which
# is a minor bump by the rule above. ⚠️ Minor does not mean invisible: these
# output shapes carry `additionalProperties: false` and a client validates
# against the `tools/list` it cached at CONNECT, so a session that predates the
# deploy rejects the new field until it reconnects. The server honestly declares
# `tools.listChanged: false`, so there is no notification path to tell it.
#
# 3.2.0 is the ENVELOPE change, and it is a minor bump for the same reason: every
# part of it ADDS. Each published tool gains `annotations` and a `_meta.costClass`;
# every result gains a `resultType`; `tools/list` gains a `_meta.cacheHints` and
# is now FILTERED by the credential presented. No declared output shape moved, so
# a client validating `structuredContent` is unaffected.
#
# ⚠️ The filtering is the part that is not merely additive from a caller's seat: a
# credential holding one scope now sees fewer tools than it did, which is the
# defect being fixed (it was shown tools it would be refused) rather than a
# regression. And the same reconnect caveat as 3.1.0 applies with more force —
# a session that cached `tools/list` before this deploy holds a catalogue with no
# annotations and no cost classes, and `listChanged: false` means nothing will
# tell it. Connected clients must reconnect.
#
# 3.3.0 makes the envelope's field NAMES the spec's own, and the rename is why this
# is a version bump rather than a patch: 3.2.0 published a local vocabulary in
# spec-owned places, which a conforming client of the newest advertised revision had
# to reject outright.
#   • `resultType` now carries the spec's `"complete"`; the local shape vocabulary
#     moved to `_meta['com.amazonaws.voc-datalake/resultShape']`.
#   • `_meta.costClass` on each published tool became the vendor-prefixed key, and
#     each tool gained the top-level `title` the current revision defines.
#   • `tools/list` and `server/discover` carry the spec's `ttlMs`/`cacheScope`
#     instead of a locally invented `_meta.cacheHints`.
#   • `server/discover` answers `supportedVersions` and puts `serverInfo` under the
#     spec's reserved `_meta` key.
#   • The advertised protocol range became the revisions this envelope actually
#     implements — the handshake-based ones — and REGAINED `2024-11-05` and
#     `2025-03-26`, which the deployed build negotiated and which a header
#     validator knowing only the newer revisions refused with a 400.
# Minor rather than major because no declared tool INPUT or OUTPUT shape moved: a
# client validating `structuredContent` against a cached `outputSchema` is
# unaffected. The reconnect caveat above applies with the same force.
#
# ⚠️ Minor for a RENAME needs the argument the 3.0.0 entry above implies, because
# by that entry's own rule — "a client coded against the NAMES loses them, which is
# a major bump by this file's own rule rather than a judgement about how many
# clients exist" — renaming a published field reads like the major case. What makes
# it minor here is not the count of affected clients but that there can be none:
# every field 3.3.0 renames was INTRODUCED IN 3.2.0, and 3.2.0 was never deployed.
# No client can hold a catalogue or a cached result containing `_meta.cacheHints`,
# a local `resultType` value or a bare `costClass`, because no build that published
# them ever left the account. Measured against the last DEPLOYED version, 3.1.0,
# every part of 3.3.0 is an addition.
#
# So the rule stands and is worth restating sharply: renaming a field a DEPLOYED
# version published is a MAJOR bump. Renaming one introduced and superseded between
# two deploys is bookkeeping. The distinction is "could a client have cached it",
# not "is the diff large".
#
# 3.4.0 fixes what the envelope does with a message it must not answer, and with a
# status that means something else on the revisions it advertises:
#   • A NOTIFICATION is now `202 Accepted` with no body, which every advertised
#     revision states as a MUST. It was answered `200` with a JSON-RPC result
#     carrying `id: null` — a reply to a message that gets no reply, and an
#     ill-formed one, since a result's id must not be null.
#   • The notifications this server does NOT dispatch — `notifications/cancelled`
#     above all — were answered `404`, and on the advertised revisions a 404 on this
#     endpoint means the session was terminated and the client MUST re-initialize.
#     Routine cancellation traffic was tearing down live sessions. An unknown
#     REQUEST is still 404 with -32601.
#   • `initialize` no longer refuses an `MCP-Protocol-Version` naming a revision
#     this server does not implement; it counter-offers, which is what a
#     current-generation client's very first request needs (it must send its own
#     revision and has nothing else to send). Every other method still refuses.
#   • `RESULT_SHAPE_ACK` is GONE, because the response it described must not be
#     sent. This is the only REMOVAL, and it is why this entry is not a patch.
#
# Minor rather than major, and the rule above is what decides it: no published tool
# declaration moved, so the fingerprinted catalogue is untouched, and the removed
# `ack` shape was introduced in 3.3.0 — undeployed — so no client can have seen it.
# What DOES change for a deployed 3.1.0 client is the notification path, and that
# change is from an ill-formed answer to the one the spec mandates: a client
# ignoring the ack (the only correct thing to do with it) is unaffected, and one
# parsing it was parsing a response it should never have received.
#
# 3.5.0 stops claiming three things this envelope does not do, and each was a claim
# a client could act on:
#   • `2025-03-26` IS NO LONGER ADVERTISED. It is the one revision that mandates
#     JSON-RPC batching and this handler implements none: a legal batch body was
#     answered `404 -32601`, and on the advertised revisions that 404 means the
#     session was terminated, so a client batching its `initialized` notification was
#     told to tear down and re-initialize — which got it there again. A batch is now
#     refused with `-32600` and a message naming batching, and the revision remains
#     the reading for a HEADER-LESS request (`ASSUMED_PROTOCOL_VERSION`), which is a
#     fallback rather than an offer.
#   • `server/discover` DECLARES `cacheScope: private`, not `public`. The payload is
#     credential-independent; the RESPONSE is not, because the method is liveness-
#     checked — no credential is a 200 and a revoked one is a 401. `public` licenses a
#     shared cache to serve that 200 across authorization contexts for an hour,
#     including to the request that was owed the 401.
#   • A refusal aimed at a message that is not a request OMITS the `id` member
#     instead of sending `id: null`. The 202 path had fixed the accepted case; a
#     notification failing a transport guard, and the Origin 403 (which runs before
#     the body is parsed), still replied with an id matching no request the client
#     sent.
# Also `Vary: Authorization` and `Cache-Control: private` on every response — the
# header-level form of `cacheScope`, for the intermediaries that never parse a body.
#
# ⚠️ MINOR, and the rule at 3.3.0 is what decides it, but this entry is the closest
# call in this file's history. Dropping an advertised revision REMOVES something a
# deployed client can hold: a client that handshook on 2025-03-26 against the 3.3.0
# build and sends that header now gets `-32022` where it got a 200. It is minor
# because no 3.x build advertising it was ever DEPLOYED — the deployed build pinned
# 2024-11-05, which is still advertised — so the set of clients that can hold
# 2025-03-26 from this server is empty. Were it non-empty, this would be major: the
# distinction remains "could a client have cached it", and the refusal it gets now
# carries `data.supported` and one retry, against a batch body being answered with a
# session teardown.
#
# No published tool declaration moved, so the fingerprinted catalogue is untouched
# again.
#
# 3.6.0 makes three things REACHABLE that this envelope already claimed. Each was a
# claim a client could act on and then find unhonoured:
#   • `server/discover` no longer refuses the header its own revision mandates. The
#     method and its `DiscoverResult` are defined only by 2026-07-28, so the only
#     client that can know the name is one obliged to send
#     `MCP-Protocol-Version: 2026-07-28` — and the version refusal was exempt on
#     `initialize` alone, so discovery answered 200 for a header-less request and 400
#     for the conforming one. The answer whose purpose is "everything a client would
#     otherwise learn from a failed call" was itself learnable only from a failed
#     call. The exemption is now `_PRE_HANDSHAKE_METHODS`, named for the position
#     rather than for its members; `ping` and both `tools/*` still refuse.
#   • A POSTED JSON-RPC RESPONSE is `202 Accepted` with no body. The transport clause
#     the notification path is built on has two subjects ("a JSON-RPC response or
#     notification") and only the second was recognised: a response carries no
#     `method`, so it fell through to the unknown-method branch and was answered
#     `404 -32601`, which on every advertised revision means the session was
#     terminated and the client MUST re-initialize. Third route to the defect the
#     notification and batch branches each closed.
#   • `Allow` is EXPOSED to a browser. It is not CORS-safelisted, so a browser
#     received the 405 and hid the one header that said what to retry with — which
#     made resolving it per resource (`GET` on the autoseed path, not `POST`)
#     invisible to exactly the client class the expose list exists for.
#
# Two more refusals join it, and both are the fail-closed reading applied where the
# permissive one was picking between two things a caller said:
#   • A HEADER SENT MORE THAN ONCE with different values is `-32020`. The reader saw
#     one value — it read `headers` and never `multiValueHeaders`, and returned on the
#     first case-insensitive match — so a request carrying two `Mcp-Method` values was
#     answered according to dict order, which is the two-hops-disagree case the
#     mismatch refusal exists for, reached through a duplicate. A duplicated `Origin`
#     is a 403 (a rebinding guard must not pick one of two claimed origins) and a
#     duplicated `Authorization` is a 401 (two credentials are not one). Two IDENTICAL
#     values are still one value.
#   • AN ID-LESS message on a non-notification method is `-32600` with the `id`
#     OMITTED. This was the last place a RESULT carrying `id: null` was sent to a
#     message that carries no id: `{"jsonrpc": "2.0", "method": "ping"}` got a 200 and
#     a full result. By JSON-RPC's definition that message is a notification, so no
#     reply may be sent; by MCP's it is nothing, since no id-less `ping` exists. Not a
#     202 either — an id-less `tools/call` is a request a client is waiting on.
#
# ⚠️ MINOR, decided by the rule at 3.3.0. Nothing a client could hold is renamed or
# removed: the `Access-Control-Expose-Headers` value GAINS an entry, which a client
# reads as more of its own answer becoming readable, and every other part turns a
# refusal into an answer or an ill-formed answer into a refusal. Three message shapes
# that used to be answered are answered differently, and in each case what they got
# was wrong under the revision they negotiated — a 404 instructing a session teardown
# for a posted response, a result with a null id for an id-less request, and one of
# two contradictory header values served as though the caller had sent one.
#
# No published tool declaration moved, so the fingerprinted catalogue is untouched a
# third time.
#
# 3.7.0 ADDS `is_partial` to `get_metrics_summary`'s output, which is a minor bump by
# the rule above — but the reason it has to be declared is not "a field appeared".
# `/metrics/summary` and the four breakdown routes now MEASURE window completeness on
# their aggregates path instead of reporting a hardcoded `False`, and these tools pass
# the route body through unprojected, so the flag reaches a client whether or not it
# is declared. Publishing it is what makes it readable: `additionalProperties` is
# absent from these two output shapes (not `false`), so an undeclared field would have
# validated and then been invisible to a model reading the catalogue to decide what
# the answer contains — a truncated total presented as authoritative, which is exactly
# the defect being closed.
#
# `get_metrics_breakdown` already declared the field; what changed there is its
# DESCRIPTION, which said "an aggregate read failed" and now names both reasons the
# window can be short (a truncated read, and a window wider than the ~90 days
# aggregates are retained for). A description is what a model reasons about, so one
# that omits half the cause is the same class of untruth in prose.
#
# Declared but deliberately NOT `required` on either tool; the argument is at
# `_IS_PARTIAL_DESCRIPTION`, where the declaration is, and it turns on these two
# tools forwarding the route body unprojected.
#
# 3.8.0 ADDS FIVE TOOLS and changes no existing one, which is a MINOR bump under the
# rule above: `list_feedback`, `get_similar_feedback`, `list_urgent_feedback`,
# `list_feedback_facets` and `list_jobs`. Every one adapts a route that already
# exists, so this is declaration and projection work — no route moved, and the four
# new `DOMAIN_ROUTES` entries are all inside the two functions `mcpRole` already
# invokes.
#
# Additive is the honest reading even though a client CACHES the catalogue at
# connect: the five names are new, so nothing a client already validates against
# changes shape. The version moving is what tells it to re-fetch and see them; the
# etag beside it moves for the same reason.
#
# ⚠️ One existing declaration was TOUCHED without changing: `search_feedback`'s four
# filter arguments now read from `_CATEGORY_ARG`/`_SENTIMENT_ARG`/`_SOURCE_ARG`/
# `_DATE_BASIS_ARG` instead of restating their literals, because four tools forward
# the same parameters to the same routes. The published values are byte-identical, so
# the fingerprint moves for the five additions alone.
#
# 3.9.0 ADDS managed document identity to `get_project`: each document now reads
# `type` from its persisted `document_type` and may expose `base_title` and a
# positive stored `version`. Bodies, prototype HTML, and signed URLs remain
# excluded. This is additive, so it is a minor bump under the rule above.
MCP_SERVER_VERSION = "3.9.0"


# ============================================
# Domain routes — the delegation map
# ============================================

# Which domain function owns which route. Two functions serve every tool: the
# metrics Lambda owns /feedback/* and /metrics/*, the projects Lambda owns
# /projects/*. Adding a tool for a third domain means adding its function here
# AND a grantInvoke in api-stack.ts — the lockstep test in api-stack.test.ts
# fails if a route named here is not wired and invokable.
DOMAIN_METRICS = 'metrics'
DOMAIN_PROJECTS = 'projects'

_DOMAIN_FUNCTION_ENV: dict[str, str] = {
    DOMAIN_METRICS: 'METRICS_FUNCTION',
    DOMAIN_PROJECTS: 'PROJECTS_FUNCTION',
}

# route key → (owning domain, method, path template). Load-bearing at runtime
# (every call is built from it) so it cannot rot into stale documentation the
# way a test-only table would.
DOMAIN_ROUTES: dict[str, tuple[str, str, str]] = {
    'feedback_list': (DOMAIN_METRICS, 'GET', '/feedback'),
    'feedback_search': (DOMAIN_METRICS, 'GET', '/feedback/search'),
    'feedback_item': (DOMAIN_METRICS, 'GET', '/feedback/{feedback_id}'),
    'feedback_similar': (DOMAIN_METRICS, 'GET', '/feedback/{feedback_id}/similar'),
    'feedback_urgent': (DOMAIN_METRICS, 'GET', '/feedback/urgent'),
    # 🔑 REACHABLE, and still a RESERVED SEGMENT. `/feedback/entities` is in
    # `_RESERVED_PATH_SEGMENTS['/feedback']` because it is a static sibling of
    # `/feedback/{feedback_id}` — that entry stops a feedback id from
    # impersonating this route, which is a different question from whether a tool
    # may address it deliberately. `list_feedback_facets` addresses it by its own
    # route key, interpolating nothing.
    'feedback_entities': (DOMAIN_METRICS, 'GET', '/feedback/entities'),
    'metrics_summary': (DOMAIN_METRICS, 'GET', '/metrics/summary'),
    # The four breakdown axes behind the single get_metrics_breakdown tool.
    'metrics_sentiment': (DOMAIN_METRICS, 'GET', '/metrics/sentiment'),
    'metrics_categories': (DOMAIN_METRICS, 'GET', '/metrics/categories'),
    'metrics_sources': (DOMAIN_METRICS, 'GET', '/metrics/sources'),
    'metrics_personas': (DOMAIN_METRICS, 'GET', '/metrics/personas'),
    'project_get': (DOMAIN_PROJECTS, 'GET', '/projects/{project_id}'),
    'project_jobs': (DOMAIN_PROJECTS, 'GET', '/projects/{project_id}/jobs'),
    'project_autoseed': (DOMAIN_PROJECTS, 'GET', '/projects/{project_id}/autoseed'),
}


# ---------------------------------------------------------------------------
# Path-parameter confinement
# ---------------------------------------------------------------------------
#
# 🔑 A ROUTE-CONFUSION guard, not input tidiness. The delegated path is what the
# Powertools resolver matches on — `pathParameters` is never consulted — so a
# parameter value is not data, it is part of the routing key. Two ways an
# unvalidated value changes which route answers:
#
#   • EXTRA SEGMENTS. `project_id='p/api-tokens'` builds `/projects/p/api-tokens`
#     and lands on the token-list route instead of the project route.
#   • A COLLISION WITH A STATIC SIBLING. `project_id='prioritization'` builds
#     `/projects/prioritization`, and Powertools resolves static routes BEFORE
#     dynamic ones, so it lands on `api_get_prioritization_scores` — the surface
#     deliberately excluded from MCP altogether. Segment counting does not catch
#     this: it is a well-formed single segment.
#
# The guard is a SHAPE rule plus a reserved-segment set, deliberately NOT a
# format allowlist per id. An allowlist (`proj_…`, 32 hex) was the first
# implementation and it bet on id PROVENANCE: any project seeded, imported or
# minted by an older generator becomes permanently unreachable through MCP, and
# reported as a malformed argument rather than as a missing project. That trades
# a security property for an availability one, and it is avoidable — the shape
# rule stops segment injection, and the reserved set stops sibling collisions,
# without either caring where an id came from.
#
# The reserved sets are DERIVED from the owning handlers' static routes by
# `test_reserved_segments_cover_every_static_sibling`, so a new static sibling
# added to one of those handlers fails the suite instead of quietly becoming
# reachable. That is the same lockstep shape as the route and throttle tests.
_RESERVED_PATH_SEGMENTS: dict[str, frozenset[str]] = {
    '/projects': frozenset({'config', 'prioritization'}),
    '/feedback': frozenset({'search', 'urgent', 'entities'}),
}

# Characters that would let a value escape its segment or its path entirely.
# `/` is the injection above; `?` and `#` would graft a query or fragment onto
# the routing key; `%` would let a percent-encoded `/` arrive decoded at a
# resolver that has already matched.
_FORBIDDEN_PATH_CHARS = frozenset('/?#%\\')


def _reserved_for(template: str, name: str) -> frozenset[str]:
    """The static sibling segments a parameter must not impersonate.

    Keyed on the path PREFIX above the parameter, so `/projects/{project_id}` and
    `/projects/{project_id}/autoseed` share one set — both put the value in the
    same position, which is what decides which siblings it can collide with.

    FAILS CLOSED on a prefix with no entry, which is the property the previous
    format-allowlist version had and this one lost when it was rewritten: a
    `.get(prefix, frozenset())` silently permits sibling collisions for any
    future templated route whose prefix nobody remembered to declare, so adding
    a route becomes how the hole reopens. Declaring an explicit
    `frozenset()` is how a prefix with genuinely no static siblings opts out, and
    that is a deliberate line in a diff rather than an omission.
    """
    segments = template.strip('/').split('/')
    position = segments.index(f'{{{name}}}')
    prefix = '/' + '/'.join(segments[:position])
    if prefix not in _RESERVED_PATH_SEGMENTS:
        # DelegationUnavailable, not InvalidToolArgument: this is a SERVER
        # misconfiguration, and -32602 "Invalid params" would tell the caller its
        # arguments are wrong when nothing it could send would work. The state is
        # unreachable in a deployed build — the prefix lockstep fails first — so
        # this is about not lying if it ever is reached.
        logger.error('No reserved-segment set declared', extra={'prefix': prefix})
        raise DelegationUnavailable(f'no reserved-segment set declared for {prefix}')
    return _RESERVED_PATH_SEGMENTS[prefix]


def _validated_path_parameters(route_key: str, params: dict[str, str]) -> dict[str, str]:
    """Refuse any path parameter that could change which route answers."""
    _domain, _method, template = DOMAIN_ROUTES[route_key]
    for name, value in params.items():
        if f'{{{name}}}' not in template:
            # Fail closed rather than ignoring it: a parameter the template does
            # not interpolate means caller and route disagree about the call.
            raise InvalidToolArgument(f"{route_key}: unexpected path parameter '{name}'")
        # Distinct messages per condition: the caller can act on each of these
        # differently, and "must be a single path segment" for a stray space sends
        # them looking for a slash they never sent.
        if not isinstance(value, str) or not value:
            raise InvalidToolArgument(f'{name} must be a non-empty identifier')
        if value.strip() != value:
            # Split from the emptiness check on purpose: bundling them reported
            # "must be a non-empty identifier" for a value that plainly was not
            # empty, which is the same misdirection the messages below avoid.
            raise InvalidToolArgument(f'{name} must not be surrounded by whitespace')
        offending = sorted(_FORBIDDEN_PATH_CHARS & set(value))
        if offending:
            raise InvalidToolArgument(
                f'{name} may not contain {" ".join(offending)}: it must be a single path segment'
            )
        if any(c.isspace() or ord(c) < 0x20 for c in value):
            raise InvalidToolArgument(f'{name} may not contain whitespace or control characters')
        if value in {'.', '..'}:
            raise InvalidToolArgument(f'{name} may not be a relative path segment')
        if value in _reserved_for(template, name):
            # Named explicitly, because "not found" would be a lie and the caller
            # cannot otherwise tell why a plausible-looking id was refused.
            raise InvalidToolArgument(
                f"{name} may not be '{value}': that names a different route"
            )
    return params


def _domain_call(
    route_key: str,
    *,
    path_parameters: dict[str, str] | None = None,
    query: dict[str, Any] | None = None,
) -> DomainCall:
    """Build the call for a declared route, resolving its function name.

    The env var is read per call rather than captured at import so a test can
    set it, and so a missing one surfaces as this route being unconfigured
    rather than as the whole module failing to load.

    Every delegated call is built here — tools and the autoseed route alike — so
    this is the one place path parameters have to be confined.
    """
    domain, method, template = DOMAIN_ROUTES[route_key]
    params = _validated_path_parameters(route_key, dict(path_parameters or {}))
    return DomainCall(
        function_name=os.environ.get(_DOMAIN_FUNCTION_ENV[domain], ''),
        method=method,
        path=template.format(**params) if params else template,
        path_parameters=params,
        query=dict(query or {}),
    )


class ToolRouteError(Exception):
    """The delegated route refused the call — a 4xx the model should hear.

    Distinct from DelegationUnavailable (a 5xx or transport fault, which is a
    server problem the model cannot fix). The MCP spec draws exactly this line:
    input-validation and business-logic failures belong in the tool RESULT with
    `isError: true`, because a model can self-correct from them, while malformed
    requests and server faults belong in the JSON-RPC `error`.
    """


@dataclass(frozen=True)
class ToolResult:
    """A tool's answer: the structured payload plus its serialized text form.

    Both are returned because the spec says a tool SHOULD keep sending the
    serialized JSON in a `TextContent` for clients that predate structured
    output, and `structuredContent` is what a modern client validates against
    the tool's `outputSchema`. One value produces both, so they cannot drift.
    """

    structured: dict

    @property
    def text(self) -> str:
        return json.dumps(self.structured, indent=2, cls=DecimalEncoder)


def _delegate(call: DomainCall, token_info: dict) -> DomainResult:
    """Invoke a domain route and map its refusals onto the MCP error taxonomy."""
    result = call_domain(call, claims=synthetic_claims(token_info))
    if result.ok:
        return result
    if 400 <= result.status_code < 500:
        raise ToolRouteError(_route_error_message(result))
    # A 5xx from the route is a server fault, not something a model can fix.
    logger.error(
        'Delegated route returned a server error',
        extra={'route': f'{call.method} {call.path}', 'status': result.status_code},
    )
    raise DelegationUnavailable(f'{call.method} {call.path} returned {result.status_code}')


def _route_error_message(result: DomainResult) -> str:
    """The route's own message, so the model reads the real reason.

    Powertools serializes its exceptions as `{"message": ...}`; anything else is
    reported by status alone rather than by dumping an unknown body into the
    model's context.
    """
    payload = result.payload
    if isinstance(payload, dict):
        message = payload.get('message') or payload.get('error')
        if isinstance(message, str) and message:
            return message
    return f'The request was refused (HTTP {result.status_code})'

# The credential format lives in shared/mcp_tokens.py — this module does not
# spell the prefix. It used to, as did projects_handler and an inline authorizer
# in api-stack.ts, three copies of one rule.

# The one origin a BROWSER may present. Not a CORS setting (see CORS_HEADERS
# below) — it is the allowlist for the MCP spec's DNS-rebinding guard, which
# REQUIRES that an invalid Origin be refused with 403. Real MCP clients are not
# browsers and send no Origin header at all; those requests are untouched.
# In dev deployments the stack sets '*', which disables the check.
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '')


# ============================================
# CORS helpers
# ============================================

# The transport headers this server reads, spelled once and lowercased because
# API Gateway lowercases header names in proxy mode.
#
# `MCP-Protocol-Version` is the transport's own version statement, sent on every
# request AFTER the initialize handshake — the spec's answer to "the session
# negotiated 2025-06-18 but this request assumes 2026-07-28". The other two are
# ROUTING ECHOES: a client (or an intermediary) that names the method and the
# tool in headers has stated the same thing twice, and the two statements must
# agree or the request is ambiguous about what it is asking for. Serving the body
# and ignoring a contradicting header is the shape that lets a proxy route on one
# value while the server acts on the other.
PROTOCOL_VERSION_HEADER = 'mcp-protocol-version'
METHOD_HEADER = 'mcp-method'
NAME_HEADER = 'mcp-name'

# ⚠️ A vitest READS THIS DECLARATION by regex — 'mcp transport headers reach a
# browser' in api-stack.test.ts — because the gateway's preflight allow-list has to
# name every header this handler validates, and a browser that cannot SEND one is a
# rule with no reachable subject. The coupling is to the spelling as well as to the
# contents: dropping the `: tuple[str, ...]` annotation, or reformatting the tuple
# so the entries are not one NAMED CONSTANT per line, breaks the parse. The test
# fails loudly rather than silently (it asserts the recovered names match the
# entries it can see), but the fix is here as much as there.
TRANSPORT_HEADERS: tuple[str, ...] = (
    PROTOCOL_VERSION_HEADER,
    METHOD_HEADER,
    NAME_HEADER,
)


# The wire spelling of each transport header, as the SPEC spells it. Not derivable
# from the lowercase form by one rule, because the spec is not internally
# consistent about it: `MCP-Protocol-Version` carries the acronym in caps while
# `Mcp-Method` and `Mcp-Name` title-case it. An earlier version of this module
# applied a single `MCP` rule to all three and published `MCP-Method` — harmless
# on the wire (HTTP header names are case-insensitive, and this module matches
# case-insensitively) but a discovery answer and a CORS allowlist stating a
# spelling the spec does not use is a contract that quietly disagrees with it.
#
# Declared as a table rather than computed so the exception is visible, and
# asserted against TRANSPORT_HEADERS below so the two cannot drift.
_CANONICAL_HEADER_NAMES: dict[str, str] = {
    PROTOCOL_VERSION_HEADER: 'MCP-Protocol-Version',
    METHOD_HEADER: 'Mcp-Method',
    NAME_HEADER: 'Mcp-Name',
}


def _canonical_header_name(header: str) -> str:
    """The wire spelling of a header this module reads in lowercase.

    Looked up rather than declared twice at each use: the lowercase forms exist
    only because API Gateway normalises what it delivers, while a CORS allowlist,
    a discovery answer and an error message are read by clients that spell headers
    the way the spec does. Two hand-written lists is how one gains a header the
    other does not.

    Unknown headers fall back to plain title-casing. Nothing reaches that path
    today — the assertion below pins every declared transport header to the table
    — and it exists so a future caller passing some other header name gets a
    reasonable spelling rather than a KeyError.
    """
    known = _CANONICAL_HEADER_NAMES.get(header)
    if known is not None:
        return known
    return '-'.join(part.capitalize() for part in header.split('-'))


# Every transport header has a declared wire spelling. A header added above
# without a spelling here would otherwise be published title-cased by the
# fallback, silently, which is the drift the table exists to prevent.
#
# `raise` rather than `assert`, which this tree requires: a bare `assert` is
# stripped under `python -O`, so the invariant would go unchecked exactly where it
# matters, and an AssertionError bypasses this tree's logging.
if set(_CANONICAL_HEADER_NAMES) != set(TRANSPORT_HEADERS):
    raise RuntimeError(
        'transport headers and their canonical spellings disagree: '
        f'{sorted(set(TRANSPORT_HEADERS) ^ set(_CANONICAL_HEADER_NAMES))}'
    )


# Every transport header in the spelling a client sends, for the CORS allowlist and
# for `server/discover`. Sorted so a client diffing two discoveries sees a change
# only when one happened.
CANONICAL_TRANSPORT_HEADERS: tuple[str, ...] = tuple(
    sorted(_canonical_header_name(header) for header in TRANSPORT_HEADERS)
)

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    # X-Project-Id is gone: the credential carries its own project reach, so a
    # client has no reason to send it and allowing it would keep a dead contract
    # looking alive.
    #
    # The three MCP transport headers ARE listed, because a browser-based client
    # that sends one would otherwise be stopped by its own preflight before this
    # function ever saw it — a header the server validates but a browser may not
    # send is a rule with no reachable subject. Derived from TRANSPORT_HEADERS so
    # the two cannot drift.
    'Access-Control-Allow-Headers': ','.join((
        'Content-Type',
        'Authorization',
        *CANONICAL_TRANSPORT_HEADERS,
    )),
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    # Without this a BROWSER-based MCP client can receive the 401 challenge but
    # never read it: WWW-Authenticate is not a CORS-safelisted response header.
    #
    # `Vary` is exposed for the same reason. It is not CORS-safelisted either, so a
    # browser-based client that wanted to reason about its own cache — or to notice
    # that this endpoint varies by credential — could not read the header that says
    # so. Pinned in lockstep with the gateway's `exposeHeaders` by
    # api-stack.test.ts, because a gateway-GENERATED response (the authorizer's 401)
    # carries the gateway's list and not this one.
    #
    # `Allow` is the third, and it is the header that says WHAT TO RETRY WITH. Also
    # not CORS-safelisted, so a browser received the 405 and hid the one header that
    # made it actionable — which made the per-resource work below
    # (`_ALLOW_JSONRPC` vs `_ALLOW_AUTOSEED`, so a `DELETE` on the autoseed path is
    # told `GET` rather than `POST`) invisible to exactly the client class this list
    # exists for. The status alone says "not this verb"; `Allow` says which one.
    #
    # ⚠️ A vitest READS THIS LITERAL by regex — 'mcp transport headers reach a
    # browser' in api-stack.test.ts — to pin the gateway's own `exposeHeaders`
    # against it. Reformatting the value (double quotes, or a `','.join((...))`
    # expression like the allow-list above) breaks that test rather than the
    # contract; add the header to `CORS_EXPOSE_HEADERS` in api-stack.ts in the same
    # commit.
    'Access-Control-Expose-Headers': 'WWW-Authenticate,Vary,Allow',
    # 🔑 The HTTP-layer counterpart of `cacheScope`, and it is needed because those
    # two words live in the JSON-RPC BODY while every cache likely to sit in front of
    # this endpoint — API Gateway, a CDN, a corporate proxy — reads headers and never
    # parses a body. `tools/list` genuinely varies: a full credential lists six tools
    # and a `metrics:read` one lists two, with different etags. Declaring
    # `cacheScope: private` in a payload no intermediary reads is a mitigation that
    # reaches only the clients that were never the risk.
    #
    # Sent UNCONDITIONALLY, from the one choke point, rather than on the responses
    # that happen to vary today. Two reasons: the header costs nothing on an answer
    # that does not vary (it forbids a cache hit that would have been correct, and
    # nothing in the current path caches POST at all), while getting the condition
    # wrong costs a cross-credential hit — so the asymmetry says do not have a
    # condition. And `Allow`/`WWW-Authenticate` above are attached by STATUS, which
    # is a fact about one response; "this endpoint's answers depend on the
    # credential" is a fact about the endpoint.
    #
    # `Authorization` alone: `Access-Control-Allow-Origin` is the static `*` above,
    # so the answer does not vary by `Origin` and naming it would forbid cache hits
    # for no reason. The credential is the only axis.
    'Vary': 'Authorization',
    # And the statement a cache actually obeys. `Vary` says WHICH request header
    # partitions the cache; `Cache-Control: private` says a SHARED cache must not
    # store the response at all. Both, because they answer different questions and a
    # cache may honour one and not the other — a proxy that ignores `Vary` and
    # respects `private` still cannot serve one credential's catalogue to another.
    #
    # `private` alone, with no `no-store` and no `no-cache`: a client's OWN cache
    # reusing its OWN answer for `ttlMs` is exactly what the hint invites, and
    # `no-cache` would forbid at the HTTP layer the reuse the body asks for. The two
    # statements have to agree, and the one they agree on is "yours to reuse, not to
    # share".
    'Cache-Control': 'private',
}

# RFC 6750 §3: a 401 for a protected resource carries a WWW-Authenticate
# challenge. MCP clients read it to learn the auth scheme; its absence is a
# spec-conformance gap, not merely a nicety. `resource_metadata` is added when
# the well-known route lands (plan §4.4 Track A).
#
# ⚠️ Delivery caveat, verified live 2026-08-18: REST API Gateway
# unconditionally renames this header to `x-amzn-remapped-www-authenticate`
# on Lambda proxy responses (documented, no opt-out). Keep sending it — the
# value reaches clients under the remapped name, and gateway-GENERATED 401s
# (the token authorizer's shape rejections) carry the true header via the
# Unauthorized gateway response in api-stack.ts.
_WWW_AUTHENTICATE_401 = 'Bearer error="invalid_token"'


# What each endpoint of this function actually serves, which is what RFC 9110
# §15.5.6 defines `Allow` to mean: "the set of methods supported by the TARGET
# RESOURCE".
#
# ⚠️ This is per-resource and cannot be derived from `Access-Control-Allow-Methods`,
# which the first draft of this change did. That header answers a different
# question — "what may a browser preflight against this Lambda" — and it is one
# constant for the whole function, so a `DELETE /v1/mcp/autoseed/p1` was refused
# with `Allow: POST, OPTIONS`: an advertised set omitting the one method that
# resource actually serves, sending a client to retry with `POST` on a path that
# only handles `GET`. Deriving one from the other bought consistency at the cost of
# being wrong.
_ALLOW_JSONRPC: tuple[str, ...] = ('POST', 'OPTIONS')
_ALLOW_AUTOSEED: tuple[str, ...] = ('GET', 'OPTIONS')


def _cors_response(body: dict, status_code: int = 200,
                   allow: tuple[str, ...] = _ALLOW_JSONRPC) -> dict:
    """Return a Lambda proxy response with CORS headers.

    Every 401 gains the RFC 6750 challenge here, and every 405 gains the `Allow`
    header RFC 9110 §15.5.6 REQUIRES, at the one choke point all responses pass
    through, so no future path of either kind can forget it.

    `allow` defaults to the JSON-RPC endpoint's set because that is what nearly
    every caller is answering for; the autoseed path passes its own. The default
    is safe to get wrong in only one direction — a caller that forgets it on a 405
    for some future resource publishes the JSON-RPC set — so the two 405 call sites
    are pinned by tests naming both paths.
    """
    headers = {**CORS_HEADERS, 'Content-Type': 'application/json'}
    if status_code == 401:
        headers['WWW-Authenticate'] = _WWW_AUTHENTICATE_401
    if status_code == 405:
        headers['Allow'] = ', '.join(allow)
    return {
        'statusCode': status_code,
        'headers': headers,
        'body': json.dumps(body, cls=DecimalEncoder),
    }


def _accepted_no_content() -> dict:
    """202 Accepted with NO body — the transport's answer to a notification.

    Every revision this server advertises states the rule in identical words
    (Streamable HTTP, *Sending Messages to the Server*): "If the input is a
    JSON-RPC response or notification: If the server accepts the input, the server
    MUST return HTTP status code 202 Accepted with no body."

    ⚠️ What this replaces was not merely untidy. A notification used to be answered
    with `200` and a full JSON-RPC result carrying `id: null`, which breaks the rule
    twice over: it REPLIES to a message JSON-RPC says gets no reply, and the reply
    it sends is ill-formed, because a result's `id` must not be null and a client
    correlating responses by id holds one matching no request it ever made.

    A separate function from `_cors_response` because the difference is the absence
    of a body, and threading a "no body" flag through the builder every other
    answer uses would have made an empty body a thing a caller can produce by
    accident. CORS headers still travel — a browser-based client must be able to
    read the 202 — while `Content-Type` deliberately does not: there is no content
    to describe, and announcing `application/json` for an empty body is the sort of
    small lie a strict client is entitled to complain about.
    """
    return {
        'statusCode': 202,
        'headers': dict(CORS_HEADERS),
        'body': '',
    }


def _header_values(event: dict, name: str) -> list[tuple[str, str]]:
    """EVERY value the request carries for one header, deduplicated, in order.

    Each entry is a `(value, display)` pair: the USABLE value (non-strings coerce
    to `''`, the reading `_request_header` documents) and the `repr` of what the
    request actually carried. The display exists because a refusal about two
    values has to show the two values — building the message from the coerced
    side produced `('', '')`, a sentence asserting the values differ while
    displaying two identical ones.

    Both places a REST proxy event puts them are read, and reading only the first
    was the gap this closes:

      • `headers` keeps ONE value per header — API Gateway collapses duplicates
        last-wins — but a DIRECT invoke can carry two keys that fold to the same
        name (`Mcp-Method` and `mcp-method`), and a reader returning on the first
        match then answered whichever key came first in the dict. The same wire
        request got two different answers depending on how the event was built.
      • `multiValueHeaders` keeps ALL of them, and nothing here looked at it. A
        request with two `Mcp-Method` values was compared against one of them and
        the other was never seen — which is exactly the two-hops-disagree case the
        `-32020` refusal exists for, reached through a duplicate rather than
        through a header/body disagreement.

    Deduplicated ON THE DISPLAY — the `repr` of the raw candidate — so two
    IDENTICAL values are one value: a client (or an intermediary) restating the
    same thing twice has not contradicted itself, and refusing that would refuse
    requests for no gain. Not on the coerced value, and not on the raw candidate
    either, and each rejection has its own defect behind it:

      • coercing non-strings to `''` BEFORE the dedup collapsed two DIFFERENT
        unusable values into one, so `multiValueHeaders={'origin': [None, 42]}`
        reached `_request_header` as a single `''` and never hit its
        `len(values) > 1` refusal — and `''` is how this module spells ABSENT, so
        the DNS-rebinding guard read two contradictory origins as no origin at
        all and served the request;
      • deduplicating on the raw candidate with `in` (i.e. `==`) refolded the
        pairs Python equates across types — `True`/`1`, `False`/`0`, `1`/`1.0` —
        so `multiValueHeaders={'origin': [True, 1]}` was the same fail-open one
        equality quirk deeper. The dedup identity and the displayed identity are
        now THE SAME FACT: the message can never again assert two values differ
        while displaying two identical ones.

    The precise claim, and its limit: `repr` never folds two values a reader
    could tell apart IN THE MESSAGE. It does fold two values that merely compare
    unequal while spelling the same — two `float('nan')` candidates
    (`nan != nan`, identical repr) fold to one, coerce to `''`, and an
    all-unusable `Origin` reads as absent. Accepted deliberately rather than
    patched with an identity-based key: the ambiguity this guard refuses is two
    DISTINGUISHABLE claims (an intermediary acting on one while this server acts
    on the other), and two indistinguishable spellings of one unusable value are
    the single-unusable-value case restated — which the anti-overreach tests pin
    as keeping its existing empty-value reading. A refusal here would display
    `nan, nan`: the self-contradicting message again, for values no reader and
    no intermediary could route apart.

    `test_two_unusable_values_for_one_header_are_still_a_duplicate` and
    `test_two_unusable_origins_are_refused_not_read_as_absent` fail if the
    coercion moves back inside the dedup;
    `test_equatable_but_distinct_unusable_origins_are_still_two_values` fails if
    the dedup key goes back to `==` on the raw candidate.

    ⚠️ The guard's REACH is tied to the REST proxy event shape read here. An
    HTTP API (payload 2.0) event carries no `multiValueHeaders` at all and
    comma-joins duplicated headers into one `headers` value, so the ambiguity
    this refuses would arrive pre-collapsed as a single value and be served.
    This endpoint is declared on a REST API in `api-stack.ts`, so that shape
    does not reach it today — but a migration to an HTTP API must revisit this
    reader, because none of the duplicate refusals downstream of it would fire.

    A non-dict `headers` or `multiValueHeaders` reads as absence rather than
    raising: a Lambda proxy event always delivers a dict or null, so this needs a
    direct invoke to reach, and `.get` on a list raised `AttributeError` from the
    one caller that runs before the handler's try/except — a 502 with no JSON-RPC
    envelope and no CORS headers.
    """
    values: list[tuple[str, str]] = []
    # The displays already seen. `repr` of the raw candidate, decided BEFORE any
    # coercion: identity is what the request actually carried, and the repr is a
    # plain string, so a `set` needs no hashability caveat and `==` on it has no
    # cross-type equalities to fold (`repr(True) != repr(1)`, where `True == 1`).
    seen: set[str] = set()
    for source_key in ('headers', 'multiValueHeaders'):
        source = event.get(source_key) or {}
        if not isinstance(source, dict):
            continue
        for key, raw in source.items():
            if not isinstance(key, str) or key.lower() != name:
                continue
            # A `multiValueHeaders` entry is a list; a `headers` entry is a scalar.
            # A non-string value reads as the empty string for the reason
            # `_request_header` documents: a header that arrived carrying something
            # unusable said something, and it is not a valid value here. The
            # coercion runs AFTER the dedup — coercing first erased the identity
            # of two DIFFERENT unusable values, and `_origin_allowed` read the
            # resulting single `''` as an absent Origin (see the docstring).
            candidates = raw if isinstance(raw, list) else [raw]
            for candidate in candidates:
                display = repr(candidate)
                if display in seen:
                    continue
                seen.add(display)
                values.append(
                    (candidate if isinstance(candidate, str) else '', display)
                )
    return values


def _request_header(event: dict, name: str) -> str | None:
    """One header, matched case-insensitively, or None when absent.

    `name` is the LOWERCASE spelling; every key on the event is folded before
    comparison. API Gateway lowercases header names in proxy mode, but a direct
    invoke (a test, a local driver) does not, and a guard has to hold for both.
    An empty value is NOT absence: a client that sent a header empty said
    something, and what it said is not a valid value for any header read here.

    ⚠️ A header carrying TWO DIFFERENT VALUES RAISES rather than resolving to one
    of them, and that is the fail-closed reading this module applies everywhere
    else. It is the same fault `_validate_routing_headers` refuses — an
    intermediary routing on the first `Mcp-Method` while this server acts on the
    last is two hops serving different requests — and that guard's own words cover
    it: "there is no way to know which of the two statements was the caller's
    intent", which is as true of two headers as of a header and a body. Reported as
    `-32020 HeaderMismatch` for the same reason.

    Every caller must be able to answer the raise, and each answers in its own
    currency rather than being made to speak JSON-RPC: `_origin_allowed` refuses
    403 (a rebinding guard must not pick one of two claimed origins), the
    credential read refuses 401 (two different credentials are not one credential),
    and the transport headers reach the `InvalidTransportHeader` catch in
    `lambda_handler` and become the spec's 400.

    A non-dict `headers` reads as absence. A Lambda proxy event always delivers a
    dict or null, so this needs a direct invoke or a non-API-Gateway trigger to
    reach — but the alternative is an `AttributeError` from `.get`, and the one
    caller that ran before the handler's try/except turned that into a 502 with no
    JSON-RPC envelope and no CORS headers.

    ⚠️ Shared by `_origin_allowed`, the transport headers and the credential read,
    which is the point: it is the only header reader in this module, so a casing
    or a shape that would bypass one guard bypasses none of them. `_origin_allowed`
    used to match `'origin'` and `'Origin'` by hand, so `ORIGIN:` or `oRigin:`
    walked past the DNS-rebinding guard on a direct invoke.
    """
    values = _header_values(event, name)
    if not values:
        return None
    if len(values) > 1:
        # The DISPLAY halves, not the coerced values: a message asserting two
        # values differ has to show the two things that differ, and the coerced
        # side of two unusable values reads `'', ''` — a sentence contradicting
        # itself. The display is the dedup key, so what is shown as different is
        # exactly what was judged different.
        raise InvalidTransportHeader(
            f'{_canonical_header_name(name)} was sent more than once with different '
            f'values ({", ".join(display for _value, display in values)}); there is '
            f'no way to know which one was meant',
            code=JSONRPC_HEADER_MISMATCH,
        )
    return values[0][0]


def _origin_allowed(event: dict) -> bool:
    """DNS-rebinding guard: reject a browser-presented Origin that is not ours.

    The MCP Streamable HTTP transport REQUIRES servers to validate the Origin
    header and answer 403 when it is present and invalid — a malicious page can
    otherwise use DNS rebinding to reach this endpoint from a victim's browser.

    Absent Origin (every non-browser MCP client) passes. A configured origin of
    '*' (dev deployments) passes everything. Comparison is exact-string on the
    scheme+host+port tuple the browser sends — no normalisation, mirroring the
    strictness the MCP auth spec demands for issuer comparison.

    The header is read through `_request_header`, the shared reader, which closes
    two gaps this function had while it read `event['headers']` by hand: it matched
    only `'origin'` and `'Origin'`, so `ORIGIN:` or `oRigin:` bypassed the guard
    entirely on a direct invoke, and `.get` on a non-dict `headers` raised
    `AttributeError`. This function runs FIRST in `lambda_handler`, outside its
    try/except, so that raise was a 502 with no JSON-RPC envelope and no CORS
    headers — the exact shape the `BotoCoreError` clause exists to avoid.

    ⚠️ TWO DIFFERENT ORIGINS IS A REFUSAL, not a choice between them. `Origin` is
    what this guard exists to compare, so picking one of two claimed origins is the
    one thing a rebinding guard must not do: an intermediary that forwarded the
    victim's origin alongside the attacker's would have this function compare
    whichever it happened to read. The raise is CAUGHT here rather than propagated,
    because this function's contract is a boolean and its caller's answer is a 403 —
    which is the right status for a browser-presented Origin this server will not
    serve, however many were presented.
    """
    try:
        origin = _request_header(event, 'origin') or ''
    except InvalidTransportHeader:
        return False
    if not origin:
        return True
    if ALLOWED_ORIGIN == '*':
        return True
    return origin == ALLOWED_ORIGIN


# ============================================
# Transport headers
# ============================================
#
# The transport carries three statements ALONGSIDE the JSON-RPC body, and a
# server that reads the body and ignores them is not speaking the same protocol
# as the client that sent them:
#
#   • `MCP-Protocol-Version` says which revision this request is written against.
#     Unvalidated, a client speaking a revision this server does not implement is
#     answered as though it spoke one that it does — the failure then surfaces as
#     a field the client cannot parse, several calls later.
#   • `MCP-Method` and `MCP-Name` echo the method and the tool name. They exist so
#     an intermediary can route without parsing a body, which means the header and
#     the body can DISAGREE — and serving the body while a proxy routed on the
#     header is how one hop's view of a request stops matching the next hop's.
#     A disagreement is refused rather than resolved in either direction: there is
#     no way to know which of the two statements was the caller's intent.
#
# Every one of them may arrive in the ENCODED-WORD sentinel form below.

# `=?base64?<payload>?=` — the sentinel form a conforming client may use for any
# of these values. A header value is a constrained token on the wire, so a client
# that cannot be sure its value survives an intermediary base64s it and marks it.
# DOTALL because the payload is opaque: a newline inside it is malformed base64,
# which is refused BELOW with a message about the encoding rather than silently
# not matching the pattern and being compared as literal text.
_ENCODED_WORD = re.compile(r'\A=\?base64\?(.*)\?=\Z', re.DOTALL)


# The spec's own codes for the two transport faults this server can report.
# `-32020`–`-32099` is reserved for spec-defined codes, so these are used with
# EXACTLY the spec's meaning and no neighbour in the range is invented:
#
#   -32020 HeaderMismatch            — a routing header contradicts the body.
#   -32022 UnsupportedProtocolVersion — with `data.supported` / `data.requested`.
#
# (-32021 MissingRequiredClientCapability is the third in the range and is not
# used here: this server requires no client capability.)
#
# ⚠️ WHICH spec: BOTH CODES ARE DEFINED BY 2026-07-28 ONLY, and no advertised
# revision defines any code in that sub-range. So every client this server actually
# talks to receives a code its own revision does not define. That is the one
# genuine judgement call in the provenance note at `ASSUMED_PROTOCOL_VERSION`, and
# it is argued in full there: kept because the fallback (-32600) actively misleads
# a dual-era client's era probe into legacy fallback, and because an unrecognized
# error CODE — unlike an unrecognized `resultType` VALUE — obliges a client to
# reject nothing, while the recovery path travels in `data.supported`, which is
# readable without knowing the code.
JSONRPC_HEADER_MISMATCH = -32020
JSONRPC_UNSUPPORTED_PROTOCOL_VERSION = -32022

# JSON-RPC's own code for a method this server does not implement — from JSON-RPC
# 2.0 itself, so unlike the two above every revision knows it.
#
# Paired with HTTP 404 by the Streamable HTTP transport, which is what lets a client
# tell this apart from the 404 of a legacy HTTP+SSE server that does not host the
# endpoint. ⚠️ That PAIRING is 2026-07-28's rule, and on the advertised revisions a
# 404 here also carries a session meaning — which is why only a REQUEST is answered
# with it and a notification is answered 202. See the unknown-method branch in
# `lambda_handler`.
JSONRPC_METHOD_NOT_FOUND = -32601

# `-32600 Invalid Request` for a malformed transport that is neither of the two
# spec-defined faults — a sentinel that claims base64 and does not decode. The
# BODY may be perfectly well formed, and it is the REQUEST as a whole that is not;
# `-32602 Invalid params` would send the caller looking at its arguments.
JSONRPC_INVALID_REQUEST = -32600


class InvalidTransportHeader(Exception):
    """A transport header is absent-or-fine, or it is malformed. Never ignored.

    Carries the JSON-RPC code and `data` payload the SPEC defines for the fault,
    rather than being flattened to one generic code at the handler. The first
    draft of this change reported every one of these as `-32600` with the detail
    only in the human-readable message, which broke two things:

      • A client could not machine-read the recovery path. The spec's own rule for
        an unsupported version is "select a mutually supported version from the
        `supported` list and retry" — with the list only in an English sentence,
        retrying means parsing prose.
      • ERA DETECTION. The Streamable HTTP backward-compatibility rules say a
        dual-era client sends a modern request and, on a 400, inspects the body: a
        RECOGNIZED modern error means "modern server, retry with a supported
        version", anything else means "legacy server, fall back to `initialize`".
        `-32600` is not a recognized modern error, so a client that guessed the
        version wrong concluded this server was legacy — while the server was
        advertising a modern revision.

    The HTTP status travels too, because the spec pins it per fault (400 for both
    spec-defined codes here) and the status is half of what the era probe reads.
    """

    def __init__(self, message: str, code: int = JSONRPC_INVALID_REQUEST,
                 data: Any = None, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.data = data
        self.status_code = status_code


def _decoded_header(raw: str, name: str) -> str:
    """A header value with the encoded-word sentinel resolved.

    A value that is not in sentinel form is returned unchanged — the sentinel is
    optional, and a plain `2025-06-18` is the ordinary spelling. A value that
    CLAIMS the sentinel form and then does not decode is refused rather than
    compared literally: treating `=?base64?not-base64?=` as a version string
    would report "unsupported protocol version =?base64?…?=", which sends the
    caller after a version number when the fault is the encoding.

    Accepted on `MCP-Protocol-Version` too, which is WIDER than the spec asks: the
    sentinel is defined for `Mcp-Name` and `Mcp-Param-{Name}`, and a date string is
    always header-safe so a conforming client has no reason to encode one. Kept
    deliberately — decoding is not permitting, and the version rule survives the
    spelling — rather than refusing a decodable value on the grounds that nobody
    should have sent it.

    ⚠️ CONSTRAINT ON FUTURE CALLERS. `validate=True` rejects non-alphabet
    characters in the payload, but the DECODED UTF-8 may still carry control
    characters — a CR or an LF is exactly what an encoded-word smuggles past a
    header parser. Every value this returns today is compared against a body value
    and then discarded, so nothing is injected anywhere; that is a property of the
    three call sites, NOT of this function. A caller that logs a decoded value or
    forwards it into a downstream header or path needs a CR/LF guard first, and
    that is the moment to add one here rather than at the new call site.
    """
    match = _ENCODED_WORD.match(raw)
    if not match:
        return raw
    try:
        decoded = base64.b64decode(match.group(1), validate=True).decode('utf-8')
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        # `_canonical_header_name`, as in every neighbouring refusal: `name` is
        # the lowercase form API Gateway normalisation forced on this module, and
        # interpolating it told a client about a header it never sent. The
        # fallback branch covers callers passing a non-transport name.
        raise InvalidTransportHeader(
            f'{_canonical_header_name(name)} is in encoded-word form but its '
            f'payload is not base64-encoded UTF-8'
        ) from exc
    if not decoded:
        # `=?base64??=` is well-formed base64 of nothing. Refused HERE, with the
        # encoding named, rather than passed on as `''`: an empty payload is a
        # client that meant to say something and encoded nothing, and letting it
        # through would report "unsupported protocol version ''" — an answer about
        # a version, for a fault in the encoding.
        raise InvalidTransportHeader(
            f'{_canonical_header_name(name)} is in encoded-word form but its '
            f'base64 payload is empty'
        )
    return decoded


def _header_mismatch_message(header: str, header_value: Any, body_value: Any) -> str:
    """A header/body disagreement, worded the way the spec's own example words it.

    `Header mismatch: Mcp-Name header value 'foo' does not match body value 'bar'`.
    Matching the spec's phrasing is not cosmetic: it is the sentence an operator
    reading two implementations' logs side by side has to recognize as the same
    fault, and the canonical header spelling is what the client actually sent.
    """
    return (
        f'Header mismatch: {_canonical_header_name(header)} header value '
        f'{header_value!r} does not match body value {body_value!r}'
    )


def _negotiate_protocol_version(requested: Any) -> str:
    """The revision this session will speak.

    The client's own version when this server implements it, and otherwise the
    NEWEST this server implements — which is what the spec's handshake defines,
    and it is a counter-offer rather than a refusal: `initialize` is where a
    client learns what it is talking to, so answering an unknown request with an
    error would leave it with nothing to fall back to. A client that cannot live
    with the counter-offer closes the connection, which is its decision to make.

    Contrast the HEADER (`_validated_protocol_version` below), where an
    unsupported value IS refused — for every method EXCEPT this one. See that
    function for why the handshake is the exception.
    """
    if isinstance(requested, str) and requested in SUPPORTED_PROTOCOL_VERSIONS:
        return requested
    return PREFERRED_PROTOCOL_VERSION


# The methods a client calls BEFORE it has negotiated anything, and therefore the
# methods where an `MCP-Protocol-Version` this server does not implement is
# answered rather than refused. The rule is one question: has this client had the
# chance to learn what to send?
#
#   • `initialize` — the handshake itself. A current-generation client MUST put its
#     own revision in the header on its very first POST (2026-07-28 requires the
#     header on every request and has no handshake to learn a different value
#     from), so a refusal here is a refusal of first contact.
#   • `server/discover` — the same position without the handshake. This one is the
#     sharper case, because the method is defined ONLY by 2026-07-28: a client that
#     knows the name is by construction a client of that revision, which is
#     obliged to send `MCP-Protocol-Version: 2026-07-28`. Refusing it meant the one
#     client class that would ever call this method was served only when it
#     VIOLATED its own revision's header rule, and the answer whose whole purpose is
#     "everything a client would otherwise learn from a failed call" was itself
#     learnable only from a failed call.
#
# ⚠️ NOT derived from `_LIVENESS_CHECKED_METHODS`, which today holds the same two
# entries. That set means "the response depends on the credential"; this one means
# "the client has nothing negotiated to send". The coincidence is real and is not a
# shared fact: `ping` is in neither for two unrelated reasons, and a future method
# that is credential-gated but post-handshake would have to be in one and not the
# other. `test_the_two_sets_are_not_the_same_fact` records that they are separate
# claims that happen to name the same pair.
#
# `ping` and `tools/*` keep the refusal, and that is the asymmetry: past the
# handshake a client HAS a negotiated value, so one this server never offered is
# the client contradicting itself.
_PRE_HANDSHAKE_METHODS: frozenset[str] = frozenset({
    'initialize',
    'server/discover',
})


def _validated_protocol_version(event: dict, method: str = '') -> str:
    """The revision named by the transport header, refusing one we cannot speak.

    An ABSENT header reads as `ASSUMED_PROTOCOL_VERSION` (2025-03-26), which is
    the spec's own backwards-compatibility rule rather than a guess: the header
    was introduced in 2025-06-18, so a request without it comes from a client
    written against an earlier revision. Requiring it would refuse every one of
    those clients; reading it as the NEWEST supported revision — as this did —
    silently upgrades precisely the clients that cannot be upgraded. A client that
    DOES send the header has made a claim this server can check.

    ⚠️ THE PRE-HANDSHAKE METHODS ARE EXEMPT from the refusal, and this is the
    asymmetry the docstring above points at. The earlier reading — "by then the
    handshake has happened, so a version this server never offered can only be a
    client contradicting itself" — is true of request N and false of request 1. A
    client whose newest revision is 2026-07-28 MUST send that value on its very
    first POST: that revision requires the header on every request and has no
    handshake to learn a different value from. Refusing it here meant a
    current-generation SDK's first contact was a hard 400 and
    `_negotiate_protocol_version` — the counter-offer that exists for exactly this
    client — was unreachable, because validation runs before dispatch and
    `initialize` never ran.

    So on the handshake an unsupported header value falls THROUGH to
    `_handle_initialize`, which counter-offers the newest revision this server
    speaks, and the client learns in one round trip what it would otherwise have
    had to parse out of an error. A 400 on first contact is also what a dual-era
    client reads as "possibly a legacy server", so the refusal cost a round trip
    and risked an era misdetection to enforce a rule the handshake already handles.

    ⚠️ `server/discover` IS EXEMPT TOO, and confining the exemption to
    `initialize` — as the first version of it did — left this method unreachable by
    the only clients that can know it exists. The method and its `DiscoverResult`
    are defined ONLY by 2026-07-28, so a client that calls it is a client of that
    revision, which its own rules oblige to send
    `MCP-Protocol-Version: 2026-07-28` on every POST. The result was that discovery
    answered 200 for a header-less or a downlevel request and 400 for the
    conforming one: served only to a client violating its own revision, and refused
    to the client it was written for. This docstring's own justification for the
    handshake exemption covers it verbatim — a client that STARTS at discovery has
    negotiated nothing, which is exactly why the liveness check calls that method
    "the same decision without the handshake".

    The exemption is not "these two methods are special": it is the pre-handshake
    POSITION, which is why the set is named for that rather than for its members.
    See `_PRE_HANDSHAKE_METHODS`.

    Every other method keeps the refusal, `ping` and both `tools/*` included: past
    the handshake a client has a negotiated value to send, and one this server never
    offered is the client contradicting itself.

    The exemption is narrow: it covers a well-formed value naming a revision this
    server does not implement, which is the case a counter-offer answers. Two
    faults are still refused on the exempt methods too:

      • a malformed encoded-word sentinel, which raises from `_decoded_header`
        before this function compares anything — there is nothing to counter-offer
        about a value that does not decode, and the fault is the encoding;
      • an EMPTY value, refused just below. A client that sent the header empty has
        not named a revision, so there is no claim to negotiate against; treating
        it as an unsupported version would answer a version question nobody asked.
    """
    raw = _request_header(event, PROTOCOL_VERSION_HEADER)
    if raw is None:
        return ASSUMED_PROTOCOL_VERSION
    version = _decoded_header(raw, PROTOCOL_VERSION_HEADER)
    if version not in SUPPORTED_PROTOCOL_VERSIONS:
        if method in _PRE_HANDSHAKE_METHODS and version:
            # Not an error, and not the client's value either: the session speaks
            # what this server implements, which is `PREFERRED_PROTOCOL_VERSION`
            # for a header naming a revision it does not. On `initialize` that
            # value IS the counter-offer the client is told; on `server/discover`
            # nothing reads it and the client reads `supportedVersions` out of the
            # answer instead — which is the whole point of that method.
            #
            # `and version` keeps an EMPTY header refused on both: a client that
            # sent the header empty named no revision, so there is nothing to
            # counter-offer.
            return PREFERRED_PROTOCOL_VERSION
        raise InvalidTransportHeader(
            f'Unsupported protocol version {version!r}. This server speaks: '
            f'{", ".join(SUPPORTED_PROTOCOL_VERSIONS)}',
            code=JSONRPC_UNSUPPORTED_PROTOCOL_VERSION,
            # The machine-readable half, and the reason this error has a `data`
            # payload at all: `supported` is what the spec tells the client to
            # retry with, and `requested` echoes the rejected value so a client
            # with several in flight knows which request this answers.
            data={
                "supported": list(SUPPORTED_PROTOCOL_VERSIONS),
                "requested": version,
            },
        )
    return version


def _validate_routing_headers(event: dict, method: str, params: Any) -> None:
    """Refuse a routing echo that contradicts the body it travels with.

    Reported as `-32020 HeaderMismatch`, which is the spec's code for exactly this
    and carries the spec's own rationale: a load balancer routes on the header
    while the server executes on the body, so the two hops would be serving
    different requests.

    Both headers are OPTIONAL, so absence is silent. A present one is compared
    against the body, and the comparison is exact: these are protocol tokens, not
    prose, so there is no case folding or trimming to argue about.

    `MCP-Name` names a TOOL, so it is meaningful only on `tools/call`. Sent with
    any other method it is refused rather than ignored — a client that names a
    tool on `tools/list` has asked for something this server cannot do, and
    answering the list would be answering a different question.
    """
    raw_method = _request_header(event, METHOD_HEADER)
    if raw_method is not None:
        declared = _decoded_header(raw_method, METHOD_HEADER)
        if declared != method:
            raise InvalidTransportHeader(
                _header_mismatch_message(METHOD_HEADER, declared, method),
                code=JSONRPC_HEADER_MISMATCH,
            )

    raw_name = _request_header(event, NAME_HEADER)
    if raw_name is None:
        return
    declared_name = _decoded_header(raw_name, NAME_HEADER)
    if method != 'tools/call':
        raise InvalidTransportHeader(
            f'{_canonical_header_name(NAME_HEADER)} names a tool, which is meaningful '
            f'only on tools/call, not on {method!r}',
            code=JSONRPC_HEADER_MISMATCH,
        )
    body_name = params.get('name') if isinstance(params, dict) else None
    if declared_name != body_name:
        raise InvalidTransportHeader(
            _header_mismatch_message(NAME_HEADER, declared_name, body_name),
            code=JSONRPC_HEADER_MISMATCH,
        )


# ============================================
# Token authentication
# ============================================

# DynamoDB error codes that mean "the lookup could not be performed right now".
# The token may well be valid, so these are reported as an authentication
# failure (401) — a retry can succeed.
_RETRYABLE_DYNAMODB_ERRORS: frozenset[str] = frozenset({
    'ProvisionedThroughputExceededException',
    'ThrottlingException',
    'ThrottlingException.TooManyRequests',
    'RequestLimitExceeded',
    'InternalServerError',
    'ServiceUnavailable',
    'TransactionConflictException',
})

# The transient half of the BotoCoreError family: a connection or timeout fault
# behaves like a throttle, so 401 (with a retry) is an acceptable answer.  The two
# *base* classes are named rather than their leaves, so a transient leaf botocore
# adds later is covered by inheritance instead of by an edit here.  Neither base is
# an ancestor of NoCredentialsError, NoRegionError or ParamValidationError, so no
# configuration fault is reclassified as transient.
_RETRYABLE_BOTOCORE_ERRORS: tuple[type[botocore_exceptions.BotoCoreError], ...] = (
    botocore_exceptions.ConnectionError,
    botocore_exceptions.HTTPClientError,
)


def _credential_expired(item: dict) -> bool:
    """True when a matched token row must be refused because of its expiry.

    Expiry is enforced HERE, in the credential check, not by a DynamoDB TTL:
    TTL deletion is eventual (up to ~48 h), so a TTL alone would keep an
    expired credential working for up to two days after its stated end.

    An absent or empty ``expires_at`` means a non-expiring token — every row
    minted before the field existed keeps working. A malformed value fails
    CLOSED (the credential is refused, and the row's token_id is logged so an
    operator can fix it): an unreadable expiry must not become an unlimited
    one. Only the token_id — never the token or its hash — reaches the log.

    Log severities differ on purpose: an EXPIRED token is an expected lifecycle
    event (info — the caller re-mints and moves on), while a MALFORMED value is
    server-side data damage nobody can fix from the client (warning — it wants
    an operator).
    """
    expires_at = item.get('expires_at')
    if not expires_at:
        return False
    try:
        expired = datetime.fromisoformat(expires_at) <= datetime.now(timezone.utc)
    except (TypeError, ValueError):
        logger.warning(
            'Token has malformed expires_at; refusing credential',
            extra={'token_id': item.get('token_id', '')},
        )
        return True
    if expired:
        logger.info(
            'Expired token presented',
            extra={'token_id': item.get('token_id', '')},
        )
    return expired


class AuthBackendUnavailable(Exception):
    """The token store could not be consulted, so the credential was never compared.

    Raised for *permanent* faults — an unset table name, a missing/misnamed table
    (``ResourceNotFoundException``), an IAM ``AccessDeniedException``, absent
    credentials (``NoCredentialsError``), … — and for any *unrecognised* fault out
    of the token lookup.  Callers must answer with a server error: a 401 here says
    the token is invalid when nothing ever checked it.
    """


@tracer.capture_method
def _authenticate(event: dict, *, touch: bool = True) -> dict | None:
    """
    Validate Bearer token from Authorization header.

    Returns the token DynamoDB item (with project_id, scope, etc.) on success,
    or None if authentication fails.

    `touch=False` skips the `last_used_at` write. It exists for the pre-dispatch
    liveness check on the unauthenticated methods: "last used" is a fact about
    when a credential was USED to read something, and stamping it from a `ping`
    would turn a keepalive loop into "last used: continuously" on the MCP Access
    tab — a field an operator reads to decide whether a token is still wanted.

    Raises:
        AuthBackendUnavailable: the token store could not be consulted because
            of a permanent server-side fault.  Callers must answer with a
            server error, not a 401 — the credential was never checked.
    """
    # Matched case-insensitively rather than by trying two spellings: API Gateway
    # lowercases in proxy mode and a direct invoke does not, and `Authorization`
    # is no more exempt from that than the transport headers are. The two-spelling
    # form this replaces missed `AUTHORIZATION` and every other casing, which on
    # the liveness check below would have let a dead credential through the very
    # gate it was added to close.
    #
    # TWO DIFFERENT `Authorization` values authenticate NOTHING, and this is the
    # fail-closed reading rather than a tidy-up: two credentials are not one
    # credential, and comparing whichever was read first would let a caller present
    # a good token alongside a revoked one — or probe the store with two per
    # request. Reported as this function's ordinary "no usable credential", which
    # every caller already answers with a 401, because from here that is what it is.
    try:
        auth_header = _request_header(event, 'authorization') or ''
    except InvalidTransportHeader:
        logger.info("Authorization presented more than once with different values")
        return None

    if not auth_header.startswith('Bearer '):
        return None

    # NO X-Project-Id. The credential carries its own id, so the lookup is one
    # keyed read instead of "Query a project's token rows and hash each one" —
    # which is what required the header, and what made a workspace-wide tool
    # such as list_projects unimplementable. Parsing is strict, so malformed
    # caller text never becomes a key lookup.
    parsed = parse_token(auth_header[7:])  # strip "Bearer "
    if not parsed:
        return None
    token_id, presented_secret = parsed

    if not projects_table:
        # An unset PROJECTS_TABLE is the same class of fault as a missing table
        # *resource* (ResourceNotFoundException below): the credential was never
        # checked.  Returning None here would answer 401 for one and 500 for the
        # other, sending an operator off to re-mint tokens for what is a
        # deployment problem.
        logger.error("Projects table not configured")
        raise AuthBackendUnavailable('projects table not configured')

    # ONE item, addressed by the id inside the credential. A Query with an
    # exact sort key rather than get_item on purpose: it is the same single-item
    # read, and it keeps the IAM grant at exactly Query + UpdateItem — the
    # narrowed grant that makes this bearer-token-reachable function unable to
    # write project artifacts. Adding GetItem would widen it for no gain.
    try:
        response = projects_table.query(
            KeyConditionExpression=(
                Key('pk').eq(MCP_TOKEN_PK) & Key('sk').eq(token_sk(token_id))
            ),
        )
    except botocore_exceptions.ClientError as exc:
        # A throttle or transient service fault: the token may be fine, so a
        # 401 (with a retry) is an acceptable answer.  A permanent fault —
        # missing table, AccessDenied — is a server problem and must not be
        # reported to the client as "your token is invalid".
        error_code = exc.response.get('Error', {}).get('Code', '')
        if error_code in _RETRYABLE_DYNAMODB_ERRORS:
            logger.warning(
                'Token lookup temporarily unavailable',
                extra={'error_code': error_code},
            )
            return None
        logger.exception(
            'Token lookup failed with a permanent error; reporting a server error',
            extra={'error_code': error_code},
        )
        raise AuthBackendUnavailable(error_code or 'ClientError') from exc
    except botocore_exceptions.BotoCoreError as exc:
        # BotoCoreError is a sibling of ClientError, not a subclass, so it needs
        # this clause or it escapes as a 502 with no JSON-RPC envelope and no
        # CORS headers.  Split exactly as above: a connection/timeout fault is
        # transient, anything else in the family is a configuration fault that
        # re-minting a token cannot fix.  Only the exception *type* is logged —
        # never the token or its hash.
        error_type = type(exc).__name__
        if isinstance(exc, _RETRYABLE_BOTOCORE_ERRORS):
            logger.warning(
                'Token lookup temporarily unavailable',
                extra={'error_type': error_type},
            )
            return None
        logger.exception(
            'Token lookup failed with a permanent client-side error; reporting a server error',
            extra={'error_type': error_type},
        )
        raise AuthBackendUnavailable(error_type) from exc
    except Exception as exc:
        # Catches whatever escaped both clauses above; ordered last so those two
        # still win.  It RAISES, and must never be "simplified" into `return
        # None`: this guard was `return None` once and that was the bug —
        # configuration faults reported to the client as "your token is invalid".
        # An unrecognised fault means the credential was never compared, so a
        # server error is the only honest answer.
        error_type = type(exc).__name__
        logger.exception(
            'Token lookup failed with an unexpected error; reporting a server error',
            extra={'error_type': error_type},
        )
        raise AuthBackendUnavailable(error_type) from exc

    items = response.get('Items', [])
    if not items:
        # No such token id. Indistinguishable to the caller from a wrong
        # secret: both are a plain 401.
        return None
    item = items[0]

    stored_hash = item.get('secret_hash', '')
    # Guard against a malformed row where secret_hash is stored as a non-string
    # type (Binary, Decimal, …). Calling .encode() on such a value would raise
    # AttributeError and turn one bad row into a 500 instead of a 401. Log the
    # type so an operator can clean it up, never the value.
    if not isinstance(stored_hash, str):
        logger.warning(
            'Unexpected secret_hash type in DynamoDB item; refusing credential',
            extra={'type': type(stored_hash).__name__, 'token_id': item.get('token_id', '')},
        )
        return None

    # Constant-time, to deny timing-based enumeration of the stored digest.
    if not secret_matches(presented_secret=presented_secret, stored_hash=stored_hash):
        return None

    # Checked AFTER the secret matches, so a wrong secret and an expired
    # credential cost the same work.
    if _credential_expired(item):
        return None

    if touch:
        try:
            projects_table.update_item(
                Key={'pk': MCP_TOKEN_PK, 'sk': item['sk']},
                UpdateExpression='SET last_used_at = :now',
                ExpressionAttributeValues={':now': datetime.now(timezone.utc).isoformat()},
            )
        except Exception as e:
            logger.warning(f"Failed to update last_used_at: {e}")

    return item


# ============================================
# MCP Tool definitions
# ============================================

# The project argument shared by the project-shaped tools. One definition so
# the two schemas cannot drift, and so the "optional when unambiguous" rule is
# stated to clients exactly once.
_PROJECT_ID_ARG = {
    "type": "string",
    "description": (
        "Which project to read. Optional when this credential names exactly one "
        "project, in which case that one is used; required otherwise."
    ),
}

# How much of a verbatim a LIST answer carries. A single item is never
# truncated; twenty of them would otherwise crowd out the model's own reasoning.
_SUMMARY_TEXT_LIMIT = 500


# ---------------------------------------------------------------------------
# Output schemas
# ---------------------------------------------------------------------------
#
# `outputSchema` describes what a tool puts in `structuredContent`, so a client
# can validate the answer instead of parsing prose. The schemas are built from
# shared pieces for the same reason the projections are: the two feedback tools
# agree on ten fields, and two hand-maintained copies is how the declaration
# stops matching the code.
#
# 🔑 `additionalProperties` is deliberately NOT uniform, and the split is the
# honest one: a tool that PROJECTS its answer controls every key, so it declares
# `false` and a stray field becomes a test failure. A tool that PASSES THROUGH a
# route's payload does not control the keys — the route may add one tomorrow —
# so declaring `false` there would make this file the thing that breaks when a
# route grows a field, which is precisely the coupling delegation removes.

# What `is_partial` means on the two metrics tools, stated once because they mean
# the same thing by it and a model reads the DESCRIPTION to decide how much weight
# a number carries. It names both reasons an aggregates answer can be short — they
# are independent, and a description mentioning one taught a reader that the other
# could not happen:
#
#   • a metric partition read stopped before the end of its window, or
#   • the requested window reaches further back than the ~90 days of aggregate
#     rows DynamoDB still holds, in which case no complete answer exists to give.
#
# Either way the counts are a LOWER BOUND, which is the operative fact and so is
# said in those words rather than left to be inferred from "incomplete".
#
# DECLARED BUT NOT `required`, unlike `search_feedback`'s copy of the same flag,
# and the difference is the projection: `search_feedback` BUILDS its body (`items`
# from `_FEEDBACK_SUMMARY_PROPERTIES`), so every key it promises is a key it
# writes, and a missing `is_partial` there really would be a bug. These two
# forward the route body unprojected and fall back to `{}` when the delegated
# payload is not a dict — so a `required` list here would make that honest empty
# answer a schema violation in a validating client, reporting a transport-level
# degradation as a malformed tool. Optional-and-declared is what these shapes can
# truthfully say: the field is readable when present, and absent means the route
# did not send it, not that the window was complete.
_IS_PARTIAL_DESCRIPTION = (
    "True when the window could not be answered in full — a metric read stopped "
    "short, or the window is wider than aggregates are retained for. The counts "
    "are then a lower bound, not a total."
)

# ---------------------------------------------------------------------------
# `is_partial` vs `is_partial_window` — stated ONCE, here
# ---------------------------------------------------------------------------
#
# Four tools now report a completeness flag and they do not all report the same
# fact. The difference is argued here and referenced from each declaration rather
# than re-argued beside three of them, for the reason `_DAYS_ARG` gives about
# copies: three statements of one rule is how they stop agreeing.
#
#   `is_partial`        — THE ANSWER is short. On `get_metrics_summary`,
#                         `get_metrics_breakdown` and `list_feedback_facets` it is
#                         the route's own flag over pre-aggregated rows: a metric
#                         read stopped early, or the window is wider than
#                         aggregates are retained for. All three read the
#                         description above. `search_feedback` uses the same NAME
#                         for a soft-capped candidate scan, which is a different
#                         cause with the same consequence, so it spells its own
#                         description out instead of reusing this one.
#   `is_partial_window` — THE WINDOW behind the answer is short, which is
#                         `list_feedback`'s case alone. It is the route's own name
#                         for the candidate window hitting the route's cap, and it
#                         carries a second fact `is_partial` does not: `total` is a
#                         lower bound AND the items past it are unreachable by
#                         paging. One name for both would have to drop that half.
#
# `list_urgent_feedback` reports NEITHER, and that absence is load-bearing: its
# route publishes no flag, so the tool says in `count`'s own description that the
# number is a page rather than a window total, and names the tool that has one.

_FEEDBACK_SUMMARY_PROPERTIES: dict[str, Any] = {
    "id": {"type": "string"},
    "source": {"type": "string", "description": "Source platform"},
    "date": {"type": "string", "description": "YYYY-MM-DD"},
    "sentiment": {"type": "string"},
    "sentiment_score": {"type": "string", "description": "Stringified decimal"},
    "category": {"type": "string"},
    "urgency": {"type": "string"},
    "rating": {"type": "string", "description": "Stringified, or 'N/A'"},
    "persona_type": {"type": "string"},
    "text": {"type": "string", "description": f"Verbatim, first {_SUMMARY_TEXT_LIMIT} characters"},
    "problem_summary": {"type": "string"},
}

_FEEDBACK_DETAIL_PROPERTIES: dict[str, Any] = {
    **_FEEDBACK_SUMMARY_PROPERTIES,
    "date": {"type": "string", "description": "Full ISO-8601 timestamp"},
    "text": {"type": "string", "description": "Full verbatim, untruncated"},
    "journey_stage": {"type": "string"},
    "problem_root_cause": {"type": "string"},
    "direct_quote": {"type": "string"},
    "keywords": {"type": "array", "items": {"type": "string"}},
}

# The document sort-key prefixes, mapped to the kind of document each names.
#
# 🔑 This map is why delegating mattered. The in-process tool recognised two of
# these six — `PRD#` and `PRFAQ#` — so an MCP client saw a third of a project's
# documents and was told nothing had been filtered: no research reports, no
# uploaded documents, no product reports, no prototypes. The route always knew
# all six. Reading the kind from the sort key rather than from a `type`
# attribute is deliberate: the four formerly-invisible kinds do not all carry
# one, so keying on `type` alone would have made them visible but unlabelled.
_DOCUMENT_KINDS: dict[str, str] = {
    'PRD#': 'prd',
    'PRFAQ#': 'prfaq',
    'RESEARCH#': 'research',
    'DOC#': 'document',
    'PRODUCT_REPORT#': 'product_report',
    'PROTOTYPE#': 'prototype',
}

_STRING_LIST: dict[str, Any] = {"type": "array", "items": {"type": "string"}}

# The persona, mirroring `schemas/persona.schema.json` — the repo's canonical
# declaration, what both writers persist, and what the frontend
# `ProjectPersona` type already describes. Section numbers below are the
# canonical schema's own: 1-5 and 7 are objects and are declared here, 6
# (`quotes`) is an array declared under `_QUOTE_PROPERTIES`, and 8
# (`research_notes`) is researcher annotation rather than persona content and is
# deliberately not reported. That division is enforced against the schema file
# by `test_every_canonical_persona_section_is_reported_or_excluded`, so a ninth
# section cannot go missing here the way 5 and 7 first did.
#
# `additionalProperties` is deliberately OPEN on each section. These values are
# LLM-authored, and a prompt is a request rather than enforcement: live rows
# carry `primary_frustration`, `frustration`, `tooling`, `current_practices`,
# `related_issues`. Declaring `false` would make the tool fail on its own
# product; declaring the known keys and permitting the rest is the honest
# contract, and the variance belongs to the writer.
_PERSONA_SECTIONS: dict[str, dict[str, Any]] = {
    # Section 1 — Identity & Demographics.
    "identity": {
        "age_range": {"type": "string"},
        "location": {"type": "string"},
        "occupation": {"type": "string"},
        "income_bracket": {"type": "string"},
        "education": {"type": "string"},
        "family_status": {"type": "string"},
        "bio": {"type": "string"},
    },
    # Section 2 — Goals & Motivations.
    "goals_motivations": {
        "primary_goal": {"type": "string"},
        "secondary_goals": _STRING_LIST,
        "success_definition": {"type": "string"},
        "underlying_motivations": _STRING_LIST,
    },
    # Section 3 — Pain Points & Frustrations.
    "pain_points": {
        "current_challenges": _STRING_LIST,
        "blockers": _STRING_LIST,
        "workarounds": _STRING_LIST,
        "emotional_impact": {"type": "string"},
    },
    # Section 4 — Behaviors & Habits.
    "behaviors": {
        "current_solutions": _STRING_LIST,
        "tools_used": _STRING_LIST,
        "activity_frequency": {"type": "string"},
        "tech_savviness": {"type": "string"},
        "decision_style": {"type": "string"},
    },
    # Section 5 — Context & Environment.
    "context_environment": {
        "usage_context": {"type": "string"},
        "devices": _STRING_LIST,
        "time_constraints": {"type": "string"},
        "social_context": {"type": "string"},
        "influencers": _STRING_LIST,
    },
    # Section 7 — Scenario / User Story.
    "scenario": {
        "title": {"type": "string"},
        "narrative": {"type": "string"},
        "trigger": {"type": "string"},
        "outcome": {"type": "string"},
    },
}

# Section 6 — Representative Quotes. Objects on the row, not strings, and the
# old single `quote` key never existed. Named separately from the sections above
# because it is an array, so it needs its own projection.
#
# `source_feedback_id` is the quote's own citation and is declared, unlike the
# persona's top-level `source_feedback_ids`, which is dropped: one is where this
# sentence came from and is the id `get_feedback_detail` takes, the other is the
# row's provenance list.
_QUOTE_PROPERTIES: dict[str, Any] = {
    "text": {"type": "string"},
    "context": {"type": "string"},
    "source_feedback_id": {"type": "string"},
}

_PERSONA_PROPERTIES: dict[str, Any] = {
    "persona_id": {"type": "string"},
    "name": {"type": "string"},
    # `tagline` is the persona's one-line characterisation and is REQUIRED by the
    # canonical schema. It replaces the old `type`, which no row has ever carried.
    "tagline": {"type": "string"},
    "confidence": {"type": "string"},
    "feedback_count": {"type": "integer"},
    **{
        section: {
            "type": "object",
            "properties": properties,
            "additionalProperties": True,
        }
        for section, properties in _PERSONA_SECTIONS.items()
    },
    "quotes": {
        "type": "array",
        "items": {
            "type": "object",
            "properties": _QUOTE_PROPERTIES,
            "additionalProperties": True,
        },
    },
}


def _declared_types(properties: dict[str, Any]) -> dict[str, str]:
    """The declared JSON type of each property, so the projection can coerce to it.

    Read off the declarations by VALUE rather than by identity with
    `_STRING_LIST`: an author who inlines a literal instead of reusing the
    constant must still get coercion, or this derivation would have exactly the
    silent-omission hole it exists to close. Deriving EVERY type rather than
    only the arrays is what stops the next declared field from being the one
    nobody coerces — `confidence` was that field.
    """
    return {
        key: declared["type"]
        for key, declared in properties.items()
        if isinstance(declared.get("type"), str)
    }


_PERSONA_SECTION_TYPES: dict[str, dict[str, str]] = {
    section: _declared_types(properties)
    for section, properties in _PERSONA_SECTIONS.items()
}
_QUOTE_TYPES: dict[str, str] = _declared_types(_QUOTE_PROPERTIES)
# The top-level scalars only: the sections and `quotes` are objects and arrays of
# objects, each with its own projection below.
_PERSONA_SCALAR_TYPES: dict[str, str] = {
    key: declared_type
    for key, declared_type in _declared_types(_PERSONA_PROPERTIES).items()
    if declared_type not in ("object", "array")
}

# Each projected feedback key, mapped to the row keys it reads — first non-empty
# wins.
#
# 🔑 This map exists so the feedback projection can be driven by its own
# declarations, exactly as `_project_persona` is. It could not simply iterate the
# declared properties against the row, because this projection RENAMES
# (`source_platform`→`source`, `original_text`→`text`,
# `problem_root_cause_hypothesis`→`problem_root_cause`), so the declared key is
# not the key to read. Stating the mapping once is what lets EVERY declared field
# be coerced instead of the handful someone remembered to wrap in `str()`.
#
# `id` is the only multi-key entry, preserving the existing fallback: the
# processor writes `feedback_id`, and a row that happens to carry a plain `id` is
# not worth breaking to make a point.
_FEEDBACK_SOURCE_KEYS: dict[str, tuple[str, ...]] = {
    "id": ('feedback_id', 'id'),
    "source": ('source_platform',),
    "date": ('source_created_at',),
    "sentiment": ('sentiment_label',),
    "sentiment_score": ('sentiment_score',),
    "category": ('category',),
    "urgency": ('urgency',),
    "rating": ('rating',),
    "persona_type": ('persona_type',),
    "text": ('original_text',),
    "problem_summary": ('problem_summary',),
    "journey_stage": ('journey_stage',),
    "problem_root_cause": ('problem_root_cause_hypothesis',),
    "direct_quote": ('direct_customer_quote',),
    "keywords": ('keywords',),
}
_FEEDBACK_SUMMARY_TYPES: dict[str, str] = _declared_types(_FEEDBACK_SUMMARY_PROPERTIES)
_FEEDBACK_DETAIL_TYPES: dict[str, str] = _declared_types(_FEEDBACK_DETAIL_PROPERTIES)

# A window argument, stated once. `maximum` is the route's real ceiling rather
# than a tighter number restated here: the adapter no longer clamps, so a limit
# this file invented would be a promise nothing keeps. The route CLAMPS rather
# than refuses, which is why an out-of-range value is not an error.
#
# 🔑 IMPORTED from `MAX_FEEDBACK_WINDOW_DAYS`, not written as `365`. It was the
# literal, with the real bound named only in this comment — which is precisely
# the declaration-vs-enforcement drift the rest of this file exists to remove,
# sitting in the file that removes it. A comment cannot fail CI; an import
# cannot disagree.
_DAYS_ARG: dict[str, Any] = {
    "type": "integer",
    "description": "Days to look back (default 7). Values above the route's ceiling are clamped, not refused.",
    "default": 7,
    "minimum": 1,
    "maximum": MAX_FEEDBACK_WINDOW_DAYS,
}

# One background job as `list_jobs` reports it, mirroring `api_list_jobs`'s own
# projection in `projects_handler.py` field for field — minus `result`.
#
# 🔑 `result` IS DELIBERATELY NOT DECLARED, and not projected either. It holds
# whatever the job produced: a research report, a product report, a generated
# prototype's HTML. That is the same argument `_tool_get_project` makes for
# listing documents by title rather than inlining their bodies — the 6 MB
# synchronous-invoke ceiling on the delegated call, and a model's context budget,
# both of which a single completed prototype can exhaust on its own. A caller that
# wants a finished artifact reads it where it lives (`get_project` lists the
# documents a job wrote).
#
# Every value is declared a string except `progress`, because that is what the
# route's own projection produces: `progress` defaults to the integer `0` and the
# rest default to `None`, so the projection here coerces each to its declared
# type rather than forwarding a `None` under a `string` declaration — the M1
# failure mode.
_JOB_PROPERTIES: dict[str, Any] = {
    "job_id": {"type": "string"},
    "job_type": {
        "type": "string",
        "description": "What the job does, e.g. generate_personas, research",
    },
    "status": {"type": "string", "description": "e.g. pending, running, completed, failed"},
    "progress": {"type": "integer", "description": "Percent complete, 0-100"},
    "current_step": {"type": "string", "description": "Free text, e.g. queued, starting"},
    "created_at": {"type": "string", "description": "ISO-8601 timestamp"},
    "updated_at": {"type": "string", "description": "ISO-8601 timestamp"},
    "completed_at": {"type": "string", "description": "ISO-8601 timestamp, empty while running"},
    "error": {"type": "string", "description": "The failure reason, empty unless status is failed"},
}

_JOB_TYPES: dict[str, str] = _declared_types(_JOB_PROPERTIES)

# The three post-query filters and the window basis that `GET /feedback`,
# `GET /feedback/search`, `GET /feedback/urgent` and `GET /feedback/entities` all
# read under the same names, stated once for the same reason `_DAYS_ARG` is: four
# tools now forward them, and four hand-maintained copies of one enum is how the
# declarations stop agreeing with each other and then with the routes.
#
# ⚠️ WHICH ROUTES HONOUR WHICH is a per-tool fact, not a property of these blocks —
# `list_feedback_facets` takes `source` and `date_basis` and no `category`, because
# `get_entities` reads no `category` parameter. A tool declares only the ones its
# own route reads; that is what keeps the input schema a promise rather than a
# suggestion.
_CATEGORY_ARG: dict[str, Any] = {
    "type": "string",
    "description": "Filter by category (e.g. delivery, pricing, product_quality)",
}
_SENTIMENT_ARG: dict[str, Any] = {
    "type": "string",
    "enum": ["positive", "negative", "neutral", "mixed"],
    "description": "Filter by sentiment label",
}
_SOURCE_ARG: dict[str, Any] = {
    "type": "string",
    "description": "Filter by source platform (e.g. webscraper, feedback-form)",
}
_DATE_BASIS_ARG: dict[str, Any] = {
    "type": "string",
    "enum": ["imported", "review"],
    "description": (
        "Which date the days window applies to: 'imported' (default, "
        "when the item entered the data lake) or 'review' (when the "
        "customer wrote it)"
    ),
    "default": "imported",
}

# ---------------------------------------------------------------------------
# The vendor `_meta` prefix
# ---------------------------------------------------------------------------
#
# Every non-spec field this server publishes travels under `_meta` behind this
# prefix. `_meta` is the spec's own extension point, and the prefix is what keeps
# a local field from colliding with a future spec field of the same name — a
# collision that is free to avoid now and awkward to fix once a client has cached
# the declaration carrying it.
#
# Legal precisely because the second label is `amazonaws`: the spec reserves any
# prefix whose second label is `modelcontextprotocol` or `mcp`.
VENDOR_META_PREFIX = 'com.amazonaws.voc-datalake/'

# The `_meta` keys this server publishes. Named rather than spelled at each use so
# a test can read them, and so the prefix is applied in one place.
COST_CLASS_KEY = f'{VENDOR_META_PREFIX}costClass'
RESULT_SHAPE_KEY = f'{VENDOR_META_PREFIX}resultShape'

# ---------------------------------------------------------------------------
# Cost classes
# ---------------------------------------------------------------------------
#
# What a call COSTS, so a model can choose between two tools that answer nearly
# the same question without discovering the difference by waiting for one. The
# axis is the shape of the underlying read, which is the thing a caller cannot
# see and cannot infer from the tool's name:
#
#   cheap     — one keyed read. Bounded by the item, not by the window.
#   moderate  — one Query over one partition, or a small set of aggregate rows.
#               Bounded by the data the route already indexes for it.
#   expensive — a candidate scan bounded by a soft cap rather than by an index,
#               which is why `search_feedback` is the tool that can come back
#               `is_partial`. Truncation IS the cost showing.
#
# Ordered cheapest first, and that order is the vocabulary's content: a client
# comparing two classes needs to know which is which, and an unordered set of
# adjectives does not say.
COST_CHEAP = 'cheap'
COST_MODERATE = 'moderate'
COST_EXPENSIVE = 'expensive'

COST_CLASSES: tuple[str, ...] = (COST_CHEAP, COST_MODERATE, COST_EXPENSIVE)

# Per-tool, and fail-closed at publication time rather than defaulted: a tool
# with no entry raises when the catalogue is built, because a MISSING cost class
# would silently read as "cheap" to a model that expected every tool to carry one.
TOOL_COST_CLASSES: dict[str, str] = {
    # One GSI lookup by feedback id.
    "get_feedback_detail": COST_CHEAP,
    # One Query of the project's partition; personas and documents come back with
    # the metadata, so listing personas costs the same read.
    "get_project": COST_MODERATE,
    "list_personas": COST_MODERATE,
    # One Query of the project's job partition, capped at 50 rows by the route.
    "list_jobs": COST_MODERATE,
    # Pre-aggregated daily rows over the window.
    "get_metrics_summary": COST_MODERATE,
    "get_metrics_breakdown": COST_MODERATE,
    # One id lookup plus one Query of that item's category partition.
    "get_similar_feedback": COST_MODERATE,
    # The candidate scan. Soft-capped, hence `is_partial`.
    "search_feedback": COST_EXPENSIVE,
    # `GET /feedback` walks one day partition per day of the window and, with any
    # post-query filter, scans the whole window up to its cap — the same shape of
    # read `search_feedback` pays for, which is why it carries the same class and
    # reports `is_partial_window`.
    "list_feedback": COST_EXPENSIVE,
    # One GSI Query per urgent candidate PLUS a keyed `get_item` for each, until
    # `limit` survive the filters. The per-item read is what makes this expensive
    # rather than moderate.
    "list_urgent_feedback": COST_EXPENSIVE,
    # One aggregate window read per configured category, two metric-type index
    # Queries, and up to seven day partitions for the issue sample.
    "list_feedback_facets": COST_EXPENSIVE,
}

# A human-readable title per tool, which is what `annotations.title` is for: the
# NAME is an identifier a model matches on, the title is what a client shows a
# person in a permission prompt. Declared here rather than inline so the
# annotation block below can be derived for every tool at once and no tool can
# have one and not the other.
TOOL_TITLES: dict[str, str] = {
    "search_feedback": "Search customer feedback",
    "get_feedback_detail": "Read one feedback item",
    "get_metrics_summary": "Summarise feedback metrics",
    "get_metrics_breakdown": "Break metrics down by one axis",
    "get_project": "Read a project",
    "list_personas": "List a project's personas",
    "list_feedback": "List customer feedback by page",
    "get_similar_feedback": "Find feedback like this one",
    "list_urgent_feedback": "List urgent customer feedback",
    "list_feedback_facets": "List a window's categories and issues",
    "list_jobs": "List a project's background jobs",
}


def _tool_annotations(name: str) -> dict:
    """The spec's behaviour hints for one tool.

    Every tool in this server is a READ, and all four hints say so — which is
    worth declaring rather than leaving to inference, because the hints are what a
    client uses to decide whether a call needs a human's permission. A read-only
    tool that does not declare itself read-only gets prompted for like a write.

    ⚠️ These are HINTS, and the spec is explicit that a client must not treat them
    as a security boundary. The enforcement is elsewhere and stays elsewhere: the
    scope table, the reach axes, and the domain function's own rules. Phase 3's
    first write tool must set `readOnlyHint: False` here AND require a write
    scope; setting only the hint would be a label, and setting only the scope would
    make a client prompt for a write as though it were a read.
    """
    return {
        "title": TOOL_TITLES[name],
        "readOnlyHint": True,
        # No tool here deletes or overwrites anything. Meaningful only when
        # `readOnlyHint` is false, and declared anyway so the block has one shape.
        "destructiveHint": False,
        # Same arguments, same answer — modulo the corpus changing underneath,
        # which is true of any read and is not what this hint is about.
        "idempotentHint": True,
        # A closed world: every tool reads this workspace's own data lake. Nothing
        # here reaches the internet, which is what a client would otherwise have
        # to assume.
        "openWorldHint": False,
    }


def _published_tool(declaration: dict) -> dict:
    """One tool as `tools/list` publishes it: declaration plus envelope.

    The annotations and the cost class are ADDED here rather than written into
    each literal, so they cannot be forgotten for one tool out of six — the
    failure mode a per-literal `annotations` block has, and the reason
    `TOOL_COST_CLASSES` raises instead of defaulting.
    """
    name = declaration["name"]
    if name not in TOOL_COST_CLASSES:
        raise KeyError(f'{name} declares no cost class in TOOL_COST_CLASSES')
    cost_class = TOOL_COST_CLASSES[name]
    if cost_class not in COST_CLASSES:
        raise ValueError(f'{name} declares undeclared cost class {cost_class!r}')
    return {
        **declaration,
        # BOTH spellings of the title, which is the compatible choice and costs one
        # line. `title` is where the current revision defines it — a client written
        # against that revision reads the top level and would otherwise show the raw
        # `name` in its permission prompt, the exact failure `TOOL_TITLES` exists to
        # prevent. `annotations.title` is the pre-2026 spelling and is what older
        # clients read. One source value, so the two cannot disagree.
        "title": TOOL_TITLES[name],
        "annotations": _tool_annotations(name),
        # `_meta` is the spec's own extension point, which is where a non-standard
        # signal belongs: a client that does not know the key ignores `_meta`
        # wholesale rather than failing to validate a tool declaration carrying a
        # field its schema does not define.
        #
        # VENDOR-PREFIXED rather than a bare `costClass`. Bare is legal today, but it
        # is also the name a future revision could take for the same idea with
        # different semantics — and a prefix is free to adopt now and awkward once a
        # client has cached the entry.
        "_meta": {COST_CLASS_KEY: cost_class},
    }


_TOOL_DECLARATIONS = [
    {
        "name": "search_feedback",
        "description": (
            "Search customer feedback items with optional filters. "
            "Returns feedback text, sentiment, category, urgency, and metadata."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    # DECLARED, not just described. The sentence below always said
                    # "at least 2 characters" while the schema accepted "a", so a
                    # validating client had nothing to check against and the route
                    # answered a one-character search with `{'count': 0}` and no
                    # error. Both the constraint and the sentence now read from
                    # `SEARCH_QUERY_MIN_LENGTH`, so the prose cannot drift from the
                    # rule the route actually enforces.
                    "minLength": SEARCH_QUERY_MIN_LENGTH,
                    # ⚖️ The declaration is STRICTER than the server, on purpose.
                    #
                    # `minLength` forbids `""`, while `_tool_search_feedback` still
                    # treats a blank query as "no query" and answers from
                    # `/feedback`. That tolerance is tested rather than incidental,
                    # by `test_mcp_delegation.py::TestRouteSelection::test_a_blank_query_is_not_a_search`.
                    #
                    # That asymmetry is safe in the direction it runs. A schema
                    # says what a caller MAY send, and a client that sends `""`
                    # instead of omitting gets told to omit, which is the
                    # documented spelling. The defect this file keeps fixing is
                    # the OPPOSITE shape — a declaration LOOSER than reality, or a
                    # promise reality ignores — because that one yields a WRONG
                    # ANSWER. Being tolerant of an input the schema discourages
                    # yields the right answer by another spelling.
                    "description": (
                        "Text to match in the verbatim, title or problem summary. "
                        f"Must be at least {SEARCH_QUERY_MIN_LENGTH} characters. "
                        "Omit to list by filters alone."
                    ),
                },
                "days": _DAYS_ARG,
                # The four filter blocks now live above, beside `_DAYS_ARG`, because
                # `list_feedback`, `list_urgent_feedback` and `list_feedback_facets`
                # forward the same parameters to the same routes. The values are
                # unchanged — this is one source for four declarations, not a new
                # contract.
                "category": _CATEGORY_ARG,
                "sentiment": _SENTIMENT_ARG,
                "date_basis": _DATE_BASIS_ARG,
                "source": _SOURCE_ARG,
                "limit": {
                    "type": "integer",
                    "description": "Max items to return (default 20). Clamped to the route's ceiling of 100.",
                    "default": 20,
                    "minimum": 1,
                    "maximum": 100,
                },
            },
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "count": {"type": "integer", "description": "Items returned"},
                "query": {"type": "string", "description": "The text matched, empty when filtering only"},
                # The tool most likely to truncate was the only one that hid it.
                # `get_metrics_breakdown` has always published `is_partial`; this
                # one collected the same flag from the route and threw it away, so
                # `count: 0` could mean "nothing matches in your window" or "the
                # scan stopped before reaching the end of it" and a caller had no
                # way to tell. REQUIRED, because a flag that is sometimes missing
                # is read as absence of truncation — the same mistake as asserting
                # it false.
                "is_partial": {
                    "type": "boolean",
                    "description": (
                        "True when the candidate scan stopped on its soft cap before "
                        "covering the whole window, so results are a sample of it"
                    ),
                },
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": _FEEDBACK_SUMMARY_PROPERTIES,
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["count", "query", "is_partial", "items"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_metrics_summary",
        "description": (
            "Dashboard summary over a time window: total feedback, average sentiment, "
            "urgent count, and the daily totals and sentiment series. "
            "For counts per category, sentiment, source or persona use get_metrics_breakdown."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": {**_DAYS_ARG, "description": "Days to aggregate (default 7)."},
            },
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "period_days": {"type": "integer"},
                "total_feedback": {"type": "integer"},
                "avg_sentiment": {"type": "number", "description": "Weighted mean, -1..1"},
                "urgent_count": {"type": "integer"},
                "is_partial": {"type": "boolean", "description": _IS_PARTIAL_DESCRIPTION},
                "daily_totals": {"type": "array", "items": {"type": "object"}},
                "daily_sentiment": {"type": "array", "items": {"type": "object"}},
            },
        },
    },
    {
        "name": "get_metrics_breakdown",
        "description": (
            "Counts along one axis over a time window: sentiment labels, categories, "
            "source platforms, or inferred personas."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "dimension": {
                    "type": "string",
                    "enum": ["sentiment", "categories", "sources", "personas"],
                    "description": "Which axis to break the window down by",
                },
                "days": {**_DAYS_ARG, "description": "Days to aggregate (default 7)."},
            },
            "required": ["dimension"],
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "period_days": {"type": "integer"},
                "is_partial": {"type": "boolean", "description": _IS_PARTIAL_DESCRIPTION},
                "breakdown": {"type": "object", "description": "Counts, when dimension=sentiment"},
                "percentages": {"type": "object", "description": "Shares, when dimension=sentiment"},
                "categories": {"type": "object", "description": "When dimension=categories"},
                "sources": {"type": "object", "description": "When dimension=sources"},
                "personas": {"type": "object", "description": "When dimension=personas"},
            },
        },
    },
    {
        "name": "get_project",
        "description": (
            "Project metadata with its personas and its documents listed by title. "
            "Documents cover PRDs, PR/FAQs, research reports, uploaded documents, "
            "product reports and prototypes; bodies are not included."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": _PROJECT_ID_ARG,
            },
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "string"},
                "name": {"type": "string"},
                "description": {"type": "string"},
                "created_at": {"type": "string"},
                "persona_count": {"type": "integer"},
                "document_count": {"type": "integer"},
                "personas": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "persona_id": {"type": "string"},
                            "name": {"type": "string"},
                            # `tagline`, not `type`: no stored persona has ever
                            # carried a `type`, so this summary reported an empty
                            # string for every persona in every project.
                            "tagline": {"type": "string"},
                        },
                        "additionalProperties": False,
                    },
                },
                "documents": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "document_id": {"type": "string"},
                            "title": {"type": "string"},
                            "type": {
                                "type": "string",
                                "description": "Persisted document_type",
                            },
                            "base_title": {
                                "type": "string",
                                "description": "Unversioned series title, when managed",
                            },
                            "version": {
                                "type": "integer",
                                "minimum": 1,
                                "description": "Stored managed-document version, when present",
                            },
                            "kind": {
                                "type": "string",
                                "enum": sorted(set(_DOCUMENT_KINDS.values())) + [""],
                                "description": "Document kind, derived from its storage prefix",
                            },
                        },
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["project_id", "persona_count", "document_count", "personas", "documents"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_personas",
        "description": (
            "List all personas for a project: identity and demographics, goals "
            "and motivations, pain points, behaviors, context and environment, "
            "representative quotes, and scenario. Researcher notes are not "
            "included."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": _PROJECT_ID_ARG,
            },
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "count": {"type": "integer"},
                "personas": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": _PERSONA_PROPERTIES,
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["count", "personas"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_feedback_detail",
        "description": "Get a single feedback item by its ID with full details.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "feedback_id": {
                    "type": "string",
                    "description": "The feedback item ID",
                },
            },
            "required": ["feedback_id"],
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": _FEEDBACK_DETAIL_PROPERTIES,
            # Every key is always emitted (the projection uses typed defaults),
            # so declaring them costs nothing and lets a client rely on them.
            "required": sorted(_FEEDBACK_DETAIL_PROPERTIES),
            "additionalProperties": False,
        },
    },
    {
        "name": "list_feedback",
        # 🔑 WHY THIS EXISTS BESIDE `search_feedback`, which already delegates to
        # `GET /feedback` for its filter-only branch: that tool drops `total`,
        # `offset` and `limit`, so a model filtering a window learns how many items
        # it received and never how many there are. This tool carries all four of
        # the route's pagination fields through, which is what makes paging
        # possible at all — without `total` a caller cannot tell a last page from a
        # full one, and without `offset` it cannot ask for the next.
        "description": (
            "List customer feedback in a window with optional filters, PAGED: reports "
            "the size of the filtered window and the page's offset alongside the items, "
            "so a caller can walk it. Use search_feedback to match text instead."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": _DAYS_ARG,
                "category": _CATEGORY_ARG,
                "sentiment": _SENTIMENT_ARG,
                "date_basis": _DATE_BASIS_ARG,
                "source": _SOURCE_ARG,
                "limit": {
                    "type": "integer",
                    "description": (
                        "Page size (the route's default is 50). Clamped to the route's "
                        "ceiling of 100, not refused."
                    ),
                    "default": 50,
                    "minimum": 1,
                    "maximum": 100,
                },
                "offset": {
                    "type": "integer",
                    # No `maximum`, deliberately. The route's ceiling is its own
                    # `MAX_FEEDBACK_OFFSET`, which lives in `metrics_handler` — a
                    # DIFFERENT Lambda bundle this one does not (and must not) import.
                    # Writing the number here would be exactly the un-CI-able copy
                    # `_DAYS_ARG`'s comment argues against, and the route clamps rather
                    # than refusing, so an over-large value is not an error. Naming the
                    # bound in prose without declaring it is the honest reading.
                    "description": (
                        "How many items to skip (default 0). The route clamps this to "
                        "its own candidate-window cap, which is also the furthest this "
                        "route can page: beyond it, raise `days` or narrow the filters."
                    ),
                    "default": 0,
                    "minimum": 0,
                },
            },
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "count": {"type": "integer", "description": "Items on this page"},
                # The three fields `search_feedback` drops, and the reason this tool
                # is worth having. `total` is the route's own word for the size of
                # the FILTERED CANDIDATE WINDOW, not of the corpus, and it is a lower
                # bound whenever `is_partial_window` is true — so the description
                # says both rather than leaving a model to read it as a corpus total.
                "total": {
                    "type": "integer",
                    "description": (
                        "Items matching in the whole window, which is what to page "
                        "through — not a count of the corpus. A LOWER BOUND when "
                        "is_partial_window is true."
                    ),
                },
                "offset": {"type": "integer", "description": "The offset this page starts at"},
                "limit": {"type": "integer", "description": "The page size the route applied"},
                # `is_partial_window`, the route's own name, and NOT the `is_partial`
                # the other four flag-carrying tools use — the difference is argued
                # once beside `_IS_PARTIAL_DESCRIPTION`.
                "is_partial_window": {
                    "type": "boolean",
                    "description": (
                        "True when the candidate window hit the route's cap before the "
                        "window ended, so `total` is a lower bound and items beyond it "
                        "are unreachable by paging."
                    ),
                },
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": _FEEDBACK_SUMMARY_PROPERTIES,
                        "additionalProperties": False,
                    },
                },
            },
            # Every key is written by the projection below, unconditionally, so all
            # six can be promised — the same argument `search_feedback` makes for
            # requiring its own four.
            "required": ["count", "total", "offset", "limit", "is_partial_window", "items"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_similar_feedback",
        "description": (
            "Feedback items in the same category as one item, newest first — the "
            "route's notion of similarity. Use it to find whether one complaint is "
            "isolated or part of a pattern."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "feedback_id": {
                    "type": "string",
                    # DECLARED, because `_tool_get_similar_feedback` enforces it:
                    # an empty or whitespace-only id is an `InvalidToolArgument`
                    # before any invoke. A schema that accepted `""` while the
                    # server refused it is the declaration-vs-enforcement gap the
                    # `query` argument above records — the harmless direction of it,
                    # but a validating client still learns the rule one round trip
                    # later than it could.
                    "minLength": 1,
                    "description": "The feedback item to find neighbours of",
                },
                "limit": {
                    "type": "integer",
                    # `maximum` is the route's OWN ceiling (`validate_limit(..., max_val=50)`),
                    # not a tighter number invented here: a bound this file made up
                    # would be a promise nothing keeps, which is the drift `_DAYS_ARG`
                    # records. The route clamps rather than refusing, so an
                    # out-of-range value is not an error.
                    "description": "Max neighbours to return (default 8). Clamped to the route's ceiling of 50.",
                    "default": 8,
                    "minimum": 1,
                    "maximum": 50,
                },
            },
            "required": ["feedback_id"],
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "source_feedback_id": {
                    "type": "string",
                    "description": "The item the neighbours were found for; never one of them",
                },
                "count": {"type": "integer", "description": "Neighbours returned"},
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": _FEEDBACK_SUMMARY_PROPERTIES,
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["source_feedback_id", "count", "items"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_urgent_feedback",
        "description": (
            "The high-urgency feedback of a window, newest first. One page only: the "
            "route stops scanning at `limit` and offers no continuation, so ask for "
            "more by raising `limit` rather than by paging."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                # The route's `days` default here is 30, not the 7 `_DAYS_ARG`
                # states, so the description is overridden the way the metrics tools
                # override theirs. The bounds are the shared ones, because the route
                # validates this parameter through the same `validate_days`.
                "days": {
                    **_DAYS_ARG,
                    "description": (
                        "Days to look back (default 30). Values above the route's "
                        "ceiling are clamped, not refused."
                    ),
                    "default": 30,
                },
                "category": _CATEGORY_ARG,
                "sentiment": _SENTIMENT_ARG,
                "date_basis": _DATE_BASIS_ARG,
                "source": _SOURCE_ARG,
                "limit": {
                    "type": "integer",
                    "description": "Max items to return (default 50). Clamped to the route's ceiling of 100.",
                    "default": 50,
                    "minimum": 1,
                    "maximum": 100,
                },
            },
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                # 🔑 THE ONE ACCURACY POINT ON THIS TOOL. The route's scan stops the
                # moment `limit` items have survived its filters, and it publishes no
                # truncation flag, so `count` is the length of THIS PAGE and can never
                # exceed `limit`. Reading it as a window total is a live defect on
                # record: the sidebar urgent badge did exactly that with `limit=10`
                # and could never show more than 10. A model asking "how urgent is
                # this week" needs `get_metrics_summary`'s `urgent_count`, which sums
                # the exact daily aggregates, and this says so rather than leaving it
                # to be inferred.
                "count": {
                    "type": "integer",
                    "description": (
                        "Items on this page, NOT the number of urgent items in the "
                        "window: the scan stops at `limit` and the route reports no "
                        "truncation flag, so count == limit means 'at least this many'. "
                        "For a window total use get_metrics_summary's urgent_count."
                    ),
                },
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": _FEEDBACK_SUMMARY_PROPERTIES,
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["count", "items"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_feedback_facets",
        "description": (
            "What a window is ABOUT, as two counted maps: feedback per category, and "
            "the recurring problem summaries. Use it to pick a filter for "
            "list_feedback or search_feedback before reading any verbatim."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": _DAYS_ARG,
                # No `category` and no `sentiment`: `get_entities` reads neither, so
                # declaring them would be this tool promising a filter the route
                # ignores — the shape of untruth PR #356 fixed.
                "date_basis": _DATE_BASIS_ARG,
                "source": _SOURCE_ARG,
                "limit": {
                    "type": "integer",
                    "description": (
                        "How many recent items the `issues` sample is drawn from "
                        "(default 100). Clamped to the route's ceiling of 200. It does "
                        "NOT bound the category counts, which cover the whole window."
                    ),
                    "default": 100,
                    "minimum": 1,
                    "maximum": 200,
                },
            },
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "period_days": {"type": "integer"},
                "feedback_count": {
                    "type": "integer",
                    "description": "Items in the window, a lower bound when is_partial is true",
                },
                # The shared description, not a near-copy of it: this flag is the
                # metrics one — the route computes it from the same aggregate reads —
                # and the first version of this declaration restated the same sentence
                # with "counted" for "answered", which is one rule in two spellings.
                # See the note beside `_IS_PARTIAL_DESCRIPTION` for why this is
                # `is_partial` and `list_feedback`'s is `is_partial_window`.
                "is_partial": {"type": "boolean", "description": _IS_PARTIAL_DESCRIPTION},
                "categories": {
                    "type": "object",
                    "description": (
                        "Category name → count over the window, highest first. Empty "
                        "when nothing in the window has a counted category."
                    ),
                },
                "issues": {
                    "type": "object",
                    "description": (
                        "Recurring problem summary (lowercased, first 100 characters) → "
                        "how many items said it, highest first. A SAMPLE of at most 20 "
                        "entries drawn from the newest items, never the whole window, "
                        "and `is_partial` does not describe it."
                    ),
                },
                # ⚠️ `keywords` IS DELIBERATELY ABSENT, and so is any argument for it.
                # The route returns `entities.keywords` as `{}` from BOTH of its
                # branches — it is the hardcoded literal in each, with no keyword
                # extraction behind it — so declaring the field would advertise data
                # no real answer ever carries. That is the defect PR #356 fixed and
                # PR #368 now guards: `test_every_declared_property_is_demonstrated_by
                # _some_sample` would report it, because no sample taken from the
                # route can demonstrate it. It becomes declarable the day the route
                # extracts keywords, and not before.
                #
                # `personas`, `sources` and `has_legacy_persona_buckets` are dropped
                # for a different and weaker reason: they are real, and
                # `get_metrics_breakdown` already reports the first two per axis with
                # the legacy-bucket caveat attached. Two tools reporting one map is
                # the duplication delegation exists to avoid.
            },
            "required": ["period_days", "feedback_count", "is_partial", "categories", "issues"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_jobs",
        "description": (
            "The background jobs of a project — persona generation, research, document "
            "and prototype builds — newest first, with each one's status and progress. "
            "⚠️ The route caps its answer at 50 jobs and offers no continuation token, "
            "so a project with more than 50 is silently truncated at 50 and the older "
            "ones cannot be reached through this tool. Job RESULTS are not included; "
            "read finished artifacts through get_project."
        ),
        "inputSchema": {
            "type": "object",
            # `project_id` ALONE. The route reads no query-string parameters at all —
            # no limit, no status, no job_type — so any other argument declared here
            # would be silently ignored, which is the declaration-looser-than-reality
            # shape this file exists to prevent. Adding a filter means adding it to
            # the route first.
            "properties": {
                "project_id": _PROJECT_ID_ARG,
            },
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "count": {
                    "type": "integer",
                    "description": "Jobs returned, at most the route's cap of 50",
                },
                "jobs": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": _JOB_PROPERTIES,
                        # Required one level DOWN for the same reason the top level
                        # requires its two: `_project_job` writes every declared key
                        # unconditionally (it iterates `_JOB_TYPES` and coerces each),
                        # so all nine are promises the projection keeps. Leaving them
                        # optional would tell a client to branch on the presence of a
                        # field that is never absent — and would let a future
                        # projection drop one without failing anything.
                        "required": sorted(_JOB_PROPERTIES),
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["count", "jobs"],
            "additionalProperties": False,
        },
    },
]

# What `tools/list` publishes: every declaration above, wrapped. Built at import
# so a tool missing its cost class or its title fails the module rather than the
# first client that asks for the catalogue.
MCP_TOOLS = [_published_tool(declaration) for declaration in _TOOL_DECLARATIONS]

# ---------------------------------------------------------------------------
# Cache hints
# ---------------------------------------------------------------------------
#
# The spec's own two fields, `ttlMs` and `cacheScope`, and it REQUIRES them on
# every `resultType: "complete"` result from `server/discover` and `tools/list`.
#
# ⚠️ The first draft of this change invented a parallel `_meta.cacheHints` object
# with `maxAgeSeconds` and `scope: "credential"`. The SEMANTICS were right and the
# encoding was a reinvention, with two consequences: a spec-reading client found no
# `ttlMs`, defaulted it to 0 (immediately stale) and cached nothing; and — the
# safety-relevant half — with no `cacheScope`, nothing told a gateway cache it must
# not serve one token's catalogue to another.
#
# `private` is the spec's own encoding of exactly the property the credential
# filter makes load-bearing: "Cached responses MAY be reused for the same
# authorization context. Caches MUST NOT be shared across authorization contexts."
#
# 🔑 THE SCOPE DESCRIBES THE RESPONSE, NOT THE PAYLOAD, and getting that backwards
# was a live hole. `server/discover` was declared `public` on the argument that its
# CONTENT names no project, no tool and no data — true of the content, and beside
# the point. `server/discover` is in `_LIVENESS_CHECKED_METHODS`, so whether there
# is an answer at all is a function of the credential: no credential is a 200, a
# revoked one is a 401. `public` says a shared cache MAY serve the response "across
# authorization contexts", which licenses replaying that unauthenticated 200 for an
# hour to the request carrying the dead token — defeating the liveness check on the
# one method whose whole reason for being in that set is the client that STARTS at
# discovery. Two changes each right on their own terms: the liveness check made
# discovery credential-sensitive and the cache hints declared it
# credential-insensitive.
#
# `public` is therefore reserved for a response whose EXISTENCE is credential-
# independent, and no answer this server currently sends qualifies. The invariant is
# checked rather than remembered: `test_no_public_answer_is_credential_gated` derives
# both halves from the constants and fails if a method declaring `public` appears in
# `_LIVENESS_CHECKED_METHODS`.
#
# ⚠️ BOTH FIELDS ARE DEFINED BY 2026-07-28, which this server does not advertise —
# so "it REQUIRES them" above is that revision's requirement, and under the
# advertised range they are additive extras a client may ignore. Sending them early
# is the deliberate bet recorded in the PROVENANCE block at
# `ASSUMED_PROTOCOL_VERSION`; the alternative was the locally-invented
# `_meta.cacheHints` this replaced, renamed later.
#
# `CACHE_SCOPE_PUBLIC` is declared and currently SENT BY NOTHING, which is deliberate
# rather than dead: it is half of the spec's vocabulary, it is what the invariant
# above is stated in terms of, and the test that enforces that invariant needs the
# value to compare against. Keeping the name is what lets the rule be written down;
# deleting it would leave the rule expressible only as a string literal in a test.
CACHE_SCOPE_PUBLIC = 'public'
CACHE_SCOPE_PRIVATE = 'private'

# How long a client may reuse a cached `tools/list`. Five minutes, matching the MCP
# authorizer's own `resultsCacheTtl` in api-stack.ts — not because the two caches
# interact, but because a client holding a catalogue longer than the credential's
# authorization decision lives is holding the older of two facts about the same
# token.
#
# It is a HINT, and the etag beside it is what makes staleness detectable rather
# than merely time-bounded: `listChanged: false` means no notification is coming,
# so the honest contract is "re-ask, compare the etag, and reconnect if it moved".
_TOOL_LIST_MAX_AGE_SECONDS = 300

# The same duration in the unit the spec's field uses. Converted here, at the one
# boundary, rather than by writing `300000` next to `300` and trusting the two to
# stay in step — the unit is the whole reason the reinvented `maxAgeSeconds` could
# not simply be renamed.
_TOOL_LIST_TTL_MS = _TOOL_LIST_MAX_AGE_SECONDS * 1000

# Discovery's CONTENT is cacheable for longer than the catalogue, and for a
# different reason: it is a function of the DEPLOYED BUILD (versions, methods,
# headers), not of any credential, so the only thing that invalidates the content is
# a deploy.
#
# The hour stands even under `private`. A per-authorization-context cache can serve
# a stale 200 to the holder of a credential revoked in the meantime, and that costs
# nothing this server was protecting: the liveness check on discovery is an HONESTY
# fix — it stops a dead credential presenting as a connected server — not a
# confidentiality boundary, and this payload names no project, no tool and no data.
# What `private` prevents is the case that IS a boundary: replaying it to a
# DIFFERENT authorization context that was owed a 401.
_DISCOVER_TTL_MS = 3_600_000

# The two cacheable answers and the scope each declares, as ONE table rather than a
# literal at each handler — because the invariant that binds it (`public` must not
# be a credential-gated answer) spans this and `_LIVENESS_CHECKED_METHODS`, and an
# invariant across two facts needs both to be readable in one place. The test
# derives from this and from that set rather than restating either.
METHOD_CACHE_SCOPES: dict[str, str] = {
    # Credential-gated by `_LIVENESS_CHECKED_METHODS`, so not `public`. See the
    # 🔑 note above `CACHE_SCOPE_PUBLIC`.
    'server/discover': CACHE_SCOPE_PRIVATE,
    # Credential-gated twice over: it requires a credential AND its content varies
    # by one.
    'tools/list': CACHE_SCOPE_PRIVATE,
}


# ============================================
# MCP Tool implementations
# ============================================

def _row_value(item: dict[str, Any], keys: tuple[str, ...]) -> Any:
    """The first present value among `keys`, or None.

    Presence is "not absent and not empty string" rather than truthiness, so a
    `rating` or `sentiment_score` of 0 counts as present and reports as `'0'`.
    Testing truthiness here would report a zero rating as unrated.
    """
    for key in keys:
        value = item.get(key)
        if value is not None and value != '':
            return value
    return None


def _project_feedback(item: dict, *, summary: bool) -> dict:
    """Reshape one raw feedback record for a model to read.

    The projection is the adapter's job, not the route's: a raw record carries
    pk/sk/gsi keys, enrichment internals and the full verbatim, and a list of 20
    of them would spend a model's context on fields it cannot use. The renames
    (`source_platform`→`source`, `sentiment_label`→`sentiment`,
    `original_text`→`text`) are the names the tools have always reported.

    ONE function for both feedback tools, parameterized by `summary`, because
    they agree on ten fields and differ only in truncation and in the five
    detail-only fields. Two copies is how the pair drifts — which is exactly the
    defect that made delegating worth doing in the first place.

    `sentiment_score` and `rating` are stringified, preserving the existing
    contract: both are DynamoDB Decimals, and a client that pattern-matched on
    `"rating": "N/A"` for an unrated item still sees it.

    Every field is coerced to the type it is DECLARED as, driven by
    `_FEEDBACK_SOURCE_KEYS` and the declarations rather than field by field. The
    version this replaces read each field with `item.get(key, default)`, and a
    default fires only when a key is ABSENT — it cannot correct a value of the
    wrong TYPE. That is the same defect that made `list_personas` uncallable, and
    here it was worse than a schema violation: `date` and `text` are SLICED
    (`[:10]`, `[:_SUMMARY_TEXT_LIMIT]`), so a row storing either as a number or a
    dict raised `TypeError` inside the projection and took down the whole tool
    call. Coercing first makes both slices safe by construction.

    Only `id` and `rating` keep behaviour that the declarations cannot express:
    `id` falls back across two row keys, and an absent `rating` reports the
    documented `'N/A'` rather than an empty string.
    """
    # `feedback_id` FIRST, and this is a bug fix rather than a rename.
    #
    # Both feedback tools reported `item.get('id')`, and the processor that
    # writes these rows never sets a plain `id` — the identifier is
    # `feedback_id`, which is also the key `GET /feedback/{id}` looks up on its
    # GSI. So `search_feedback` advertised an `id` field and filled it with `""`
    # for every item in the corpus, which made `get_feedback_detail` unreachable
    # for an agent: the only way to learn a feedback id is to search, and search
    # reported none. Verified live against the deployed API before fixing.
    declared = _FEEDBACK_SUMMARY_TYPES if summary else _FEEDBACK_DETAIL_TYPES
    projected = {
        # `.get(key, (key,))` rather than `[key]`: a declared property with no
        # entry in the map reads the row key of its own name instead of raising
        # `KeyError` and killing the tool call — the M1 failure mode. The
        # omission is still a CI failure, pinned by
        # `test_source_key_map_covers_every_declared_field`; this only decides
        # whether the symptom is a red test or a dead tool in production.
        key: _coerce_declared(_row_value(item, _FEEDBACK_SOURCE_KEYS.get(key, (key,))), declared_type)
        for key, declared_type in declared.items()
    }
    # An unrated item reads `'N/A'`, not `''`. Applied after coercion so a stored
    # `None` reports `'N/A'` too — `str(None)` used to put the literal `'None'`
    # in front of a model, which reads as a value rather than as an absence.
    if not projected["rating"]:
        projected["rating"] = 'N/A'
    if summary:
        # A list answer carries the date as a plain day and clips the verbatim;
        # the single-item answer carries both in full.
        projected["date"] = projected["date"][:10]
        projected["text"] = projected["text"][:_SUMMARY_TEXT_LIMIT]
    return projected


@tracer.capture_method
def _tool_search_feedback(args: dict, token_info: dict) -> ToolResult:
    """Search feedback, via the route that owns the corpus.

    TWO routes behind one tool, chosen by whether a `query` was given, because
    that is what this tool has always done: `GET /feedback/search` is a text
    search and REFUSES a query shorter than two characters, while the filters
    alone (no text) are what `GET /feedback` answers. Mapping the tool onto
    `/feedback/search` alone would have made every filter-only call return
    nothing; splitting it into two tools is Phase 3's `list_feedback`.
    """
    query = args.get('query')
    query = query.strip() if isinstance(query, str) else ''
    shared_filters = {
        'days': args.get('days', 7),
        'limit': args.get('limit', 20),
        'category': args.get('category'),
        'sentiment': args.get('sentiment'),
        'source': args.get('source'),
        'date_basis': args.get('date_basis'),
    }

    if query:
        call = _domain_call('feedback_search', query={'q': query, **shared_filters})
    else:
        call = _domain_call('feedback_list', query=shared_filters)

    body = _delegate(call, token_info).payload
    raw_items = body.get('items', []) if isinstance(body, dict) else []
    # Projected FIRST, then counted, so `count` describes what the caller
    # received. Counting the route's list instead would let a non-dict entry make
    # `count` exceed `len(items)` in the same payload.
    items = [_project_feedback(item, summary=True) for item in raw_items
             if isinstance(item, dict)]
    # Both routes publish the flag under the same name, so one read covers the
    # search branch and the filter-only branch. Coerced with `bool()` rather than
    # passed through: the declaration says boolean, and a route that answered
    # `null` would otherwise reproduce M1 in the field added to fix M5.
    truncated = bool(body.get('is_partial_window')) if isinstance(body, dict) else False
    return ToolResult({
        "count": len(items),
        "query": query,
        "is_partial": truncated,
        "items": items,
    })


@tracer.capture_method
def _tool_get_metrics_summary(args: dict, token_info: dict) -> ToolResult:
    """Dashboard summary metrics, from the route the dashboard itself uses.

    ⚠️ The answer's SHAPE changed at server 2.0.0, and not only by field names.
    This tool used to recompute the summary from raw aggregate rows and reported
    `sentiment_breakdown` + `top_categories`; the route reports `avg_sentiment`,
    `urgent_count` and the daily series instead. The counts per sentiment and
    per category now come from `get_metrics_breakdown`, which is why that tool
    is in this phase rather than the next one — between them the two tools
    report strictly more than the old one did, so no client loses information.

    The window-clamping helper this used to need is gone with it: `days` is
    bounded by the route's own `validate_days`, which is a validator documented
    never to raise (it clamps and defaults), so a nonsense window degrades the
    same way it does for every other caller of that route instead of the way
    one hand-written clamp in this file happened to.
    """
    body = _delegate(
        _domain_call('metrics_summary', query={'days': args.get('days', 7)}),
        token_info,
    ).payload
    return ToolResult(body if isinstance(body, dict) else {})


# The four breakdown routes, as the `dimension` argument names them. One tool
# over four routes: they answer the same question about different axes, and four
# near-identical tool declarations would spend a model's context to say so.
_BREAKDOWN_DIMENSIONS: dict[str, str] = {
    'sentiment': '/metrics/sentiment',
    'categories': '/metrics/categories',
    'sources': '/metrics/sources',
    'personas': '/metrics/personas',
}


@tracer.capture_method
def _tool_get_metrics_breakdown(args: dict, token_info: dict) -> ToolResult:
    """Counts along one axis: sentiment, categories, sources or personas.

    Passed through unprojected, deliberately: each of these routes answers with
    a small `{period_days, is_partial, <axis>: {...}}` object that is already
    exactly what a model needs, and re-shaping it here would reintroduce the
    second implementation that delegating exists to remove. It also carries the
    routes' own `is_partial`, so a degraded aggregate read is still reported.
    """
    dimension = args.get('dimension')
    if dimension not in _BREAKDOWN_DIMENSIONS:
        # A -32602 rather than a delegated 404: the enum is this tool's own
        # contract, so an unknown value is a malformed call, not a route refusal.
        raise InvalidToolArgument(
            f"dimension must be one of: {', '.join(sorted(_BREAKDOWN_DIMENSIONS))}"
        )
    body = _delegate(
        _domain_call(f'metrics_{dimension}', query={'days': args.get('days', 7)}),
        token_info,
    ).payload
    return ToolResult(body if isinstance(body, dict) else {})


def _document_kind(item: dict) -> str:
    sk = item.get('sk', '')
    for prefix, kind in _DOCUMENT_KINDS.items():
        if sk.startswith(prefix):
            return kind
    return ''


def _as_string(value: Any) -> str:
    """Coerce a declared-string persona field to the string it promises.

    A list is joined rather than passed through: `emotional_impact` and
    `primary_goal` are declared strings, and a list arriving in either would
    reproduce the defect this schema fix is about — a payload contradicting its
    own declaration. A dict becomes JSON rather than a Python `repr`, because
    the reader is a model and `{'a': 'x'}` is not machine-readable.
    """
    if value is None:
        return ''
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return '; '.join(_as_string(v) for v in value if v not in (None, ''))
    if isinstance(value, dict):
        return json.dumps(value, cls=DecimalEncoder)
    return str(value)


def _as_int(value: Any, default: Any = 0) -> int:
    """Coerce a declared-integer field, defaulting rather than lying.

    `feedback_count` arrives from DynamoDB as a `Decimal`, and not at all on
    rows that predate it. An unparseable value becomes the default instead of
    travelling as the string it was.

    🔑 `default` IS COERCED TOO, and it fires on an absent OR uncoercible value
    rather than only on absence. Both halves matter and both are the M1 rule:
    `.get(key, fallback)` cannot correct a value of the wrong TYPE (it only fires
    on a missing key), and a fallback RETURNED RAW would put a caller's own `"20"`
    under an `integer` declaration — the same defect one argument later. A
    legitimate `0` is not absence, which is why absence is tested as `is None` (or
    `''`) rather than with `or`: `_as_int(0, 50)` is 0, and only a missing, blank
    or uncoercible value reaches the default at all.
    """
    for candidate in (value, default):
        if candidate is None or candidate == '':
            continue
        try:
            return int(candidate)
        except (TypeError, ValueError):
            continue
    return 0


def _project_document(document: dict) -> dict[str, Any]:
    """Project document metadata without content or transient URLs."""
    projected: dict[str, Any] = {
        'document_id': _as_string(document.get('document_id')),
        'title': _as_string(document.get('title')),
        'type': _as_string(document.get('document_type')),
        'kind': _document_kind(document),
    }
    if document.get('base_title') is not None:
        projected['base_title'] = _as_string(document.get('base_title'))
    version = _as_int(document.get('version'))
    if version > 0:
        projected['version'] = version
    return projected


def _within_declared_bounds(tool: str, argument: str, args: dict, default: Any) -> int:
    """A requested page value, held inside the bounds its own `inputSchema` declares.

    Placed beside `_as_int` because it is the same kind of thing — a coercion that
    refuses to let an unchecked value travel under a declaration — and because it
    needs both `_as_int` and `_TOOL_DECLARATIONS`, so it belongs after each.

    `inputSchema` is advertised to clients and enforced on nothing: `tools/call`
    reaches a handler with whatever `arguments` arrived. A caller's `limit: 500`
    travels unchallenged, so reporting it back under a field described as the page
    size the route applied would be a claim the route never made — it caps at its
    own ceiling.

    Bounds are READ FROM THE DECLARATION, not restated here. Same rule `_DAYS_ARG`
    follows by importing `MAX_FEEDBACK_WINDOW_DAYS`: a literal duplicate does not
    fail CI when the schema moves, it just quietly disagrees.

    ⚠️ THIS CLAMPS ONLY WHAT THE DECLARATION STATES, so it is NOT a promise that both
    bounds are enforced for every argument. `offset` declares a `minimum` and
    deliberately no `maximum` — the route's ceiling is `MAX_FEEDBACK_OFFSET`, which
    lives in a different Lambda bundle this one must not import, so the declaration
    names it in prose instead (see the `offset` comment in `list_feedback`). An
    out-of-range `offset` therefore still reports the value asked for while the route
    clamped to its own ceiling. That asymmetry is the declaration's, not this
    helper's, and it is the honest one available: the alternative is an un-CI-able
    copy of another bundle's constant.

    An absent or uncoercible value takes `default`, coerced, keeping `_as_int`'s
    contract so this cannot become the M1 defect one argument later.
    """
    declaration = next(
        (d for d in _TOOL_DECLARATIONS if d['name'] == tool), None,
    )
    if declaration is None:                       # pragma: no cover - registry typo
        raise KeyError(f'no declaration for tool {tool!r}')
    schema = declaration['inputSchema'].get('properties', {}).get(argument, {})
    value = _as_int(args.get(argument), default)
    minimum, maximum = schema.get('minimum'), schema.get('maximum')
    if minimum is not None:
        value = max(value, minimum)
    if maximum is not None:
        value = min(value, maximum)
    return value


def _as_string_list(value: Any) -> list[str]:
    """Coerce a declared-array persona field to the list of strings it promises.

    A writer that leaves a single value unwrapped (`workarounds` is a string on
    some imported rows and a list on generated ones) must not make the payload
    contradict its own schema, so the boundary coerces instead of passing the
    scalar through. Non-string entries are stringified rather than dropped: the
    value is a model's evidence, and silently losing it is worse than reporting
    it in the declared type.
    """
    if value is None or value == '':
        return []
    if isinstance(value, (list, tuple)):
        return [_as_string(v) for v in value if v not in (None, '')]
    return [_as_string(value)]


# One coercion per JSON type the persona schema declares. Objects are absent on
# purpose: the sections and quotes have their own projections, which is also why
# `_PERSONA_SCALAR_TYPES` excludes them.
_COERCIONS: dict[str, Callable[[Any], Any]] = {
    "string": _as_string,
    "integer": _as_int,
    "array": _as_string_list,
}


def _coerce_declared(value: Any, declared_type: str) -> Any:
    """Coerce one value to the JSON type its own schema declares.

    A type with no coercion passes through unchanged, so an undeclared key keeps
    whatever the row holds — `additionalProperties: true` permits it and
    rewriting it would claim a structure the row does not have.
    """
    coerce = _COERCIONS.get(declared_type)
    return coerce(value) if coerce else value


def _persona_section(name: str, value: Any, declared: dict[str, str]) -> dict:
    """One canonical persona section, coerced to its declared types.

    Unrecognised keys are PRESERVED, not dropped. The section's declared keys
    are what the prompts pin; a prompt is a request, so real rows also carry
    `primary_frustration`, `tooling`, `related_issues`. Dropping those would
    make the tool answer "this persona has no pain points" about a persona whose
    pain points are simply under a key this file did not predict — the same
    class of silent under-report the surface is being fixed for.
    """
    if not isinstance(value, dict):
        # Absent, or a shape no writer produces. Both writers persist an object
        # (both default to `{}`) and all five live rows are objects, so there is
        # no flat-list case to salvage — and guessing a destination key would
        # file content under a misleading heading (`sorted()` would pick
        # `blockers` for a list of pain points). An absent section is normal and
        # silent; anything else is logged, because a section that cannot be
        # reported should be visible rather than invisible. The value itself is
        # never logged: it is customer-derived text.
        if value not in (None, '', [], {}):
            logger.warning(
                "Persona section not reported: not an object",
                extra={"section": name, "arrived_as": type(value).__name__},
            )
        return {}
    return {
        key: _coerce_declared(inner, declared[key]) if key in declared else inner
        for key, inner in value.items()
    }


def _as_quote(value: Any) -> dict | None:
    """One representative quote, as the object the schema declares.

    A bare string entry used to be filtered out, which answered "this persona
    has no quotes" about a persona who had them — the same silent under-report
    this file argues against everywhere else. These entries are LLM-authored on
    a path that pinned nothing until now, so `quotes: ["…"]` is a plausible
    stored shape and it becomes `{"text": …}`. `None` means the entry carried no
    content, not that content was discarded.
    """
    if isinstance(value, dict):
        return {
            key: _coerce_declared(inner, _QUOTE_TYPES[key]) if key in _QUOTE_TYPES else inner
            for key, inner in value.items()
        }
    text = _as_string(value)
    return {"text": text} if text else None


def _project_persona(item: dict) -> dict:
    """One persona in the canonical shape of `schemas/persona.schema.json`.

    Used ONLY by `list_personas`. `get_project` deliberately renders a two-field
    summary of its own — an earlier version of this docstring claimed the two
    shared a projection, which was never true and is why the schema mismatch
    went unnoticed for so long.

    Every field is coerced to the type it is DECLARED as, driven by the
    declarations rather than written out field by field. The bug this replaces
    read each field with `item.get(key, default)`, and a default fires only when
    a key is ABSENT: it cannot correct a value of the wrong TYPE, so the object
    `pain_points` travelled unchanged under a schema declaring `array<string>`
    and a validating client rejected the whole result. Driving it from the
    declarations is the second half of that lesson — the field-by-field version
    of this function guarded `feedback_count` and left `confidence` unchecked.

    Everything not declared — avatar keys, source feedback ids, researcher
    notes, timestamps, llm metadata — is still dropped: a project's personas are
    the answer, not its storage layout.
    """
    projected: dict[str, Any] = {
        key: _coerce_declared(item.get(key), declared_type)
        for key, declared_type in _PERSONA_SCALAR_TYPES.items()
    }
    for section, declared in _PERSONA_SECTION_TYPES.items():
        projected[section] = _persona_section(section, item.get(section), declared)

    quotes = item.get('quotes')
    entries = quotes if isinstance(quotes, (list, tuple)) else [quotes]
    projected["quotes"] = [q for q in map(_as_quote, entries) if q is not None]
    return projected


def _delegated_object(call: DomainCall, token_info: dict, route: str) -> dict:
    """The route's answer as the OBJECT it is declared to return, or a server fault.

    🔑 ONE TREATMENT FOR EVERY PROJECTING TOOL, because the alternative was decided
    per handler and diverged inside a single commit: `list_feedback_facets` raised
    on a non-dict body while `list_feedback`, `list_urgent_feedback` and `list_jobs`
    coerced the same condition into an empty answer. Both cannot be right, and the
    difference is not cosmetic — it is what a model is told happened.

    RAISING IS THE HONEST HALF. Every route behind these tools returns a JSON
    object; a body that is not one is not a thin answer, it is a malfunction —
    a truncated payload, a route that changed shape, a proxy that answered instead.
    Coercing it to `{}` reports "the window is empty" or "this project has run
    nothing", which is a claim about the CORPUS that the call never established.
    That is the truthfulness class this file exists to protect (see
    `analysis/BUG-mcp-tool-truthfulness-GITHUB-ISSUE.md`): a model cannot retry
    what it was told succeeded, and "nobody said that" is unrecoverable where
    "the call failed" is not. `DelegationUnavailable` becomes a JSON-RPC error with
    no upstream detail in it, which is exactly "try again, this was not your fault".

    ⚠️ THREE TOOLS DELIBERATELY STILL COERCE and are not routed through here:
    `get_metrics_summary` and `get_metrics_breakdown` forward the route body
    UNPROJECTED and declare nothing `required`, so `{}` is a shape their own
    declaration permits — the argument recorded at `_IS_PARTIAL_DESCRIPTION` for why
    their `is_partial` is optional stands on it. `search_feedback` predates this
    rule. Moving those three is a behaviour change to shipped tools with its own
    version implication, so it is not smuggled in beside five additions.
    """
    body = _delegate(call, token_info).payload
    if not isinstance(body, dict):
        raise DelegationUnavailable(f'{route} route returned no object')
    return body


def _get_project_payload(token_info: dict) -> tuple[dict, list[dict], list[dict]]:
    """Fetch one project from the route that owns it.

    `project_id` is the project `_handle_tools_call` resolved from the arguments
    (or the token's single project) AND authorized against the token's read
    reach. It is not "the token's project" — a credential can reach several — so
    it must not be re-derived here.
    """
    project_id = token_info['project_id']
    body = _delegated_object(
        _domain_call('project_get', path_parameters={'project_id': project_id}),
        token_info,
        'project',
    )
    meta = body.get('project')
    personas = body.get('personas') or []
    documents = body.get('documents') or []
    return (
        meta if isinstance(meta, dict) else {},
        [p for p in personas if isinstance(p, dict)],
        [d for d in documents if isinstance(d, dict)],
    )


@tracer.capture_method
def _tool_get_project(args: dict, token_info: dict) -> ToolResult:
    """Project metadata with its personas and documents listed by name.

    Documents are listed, never inlined: a generated prototype is hundreds of
    kilobytes and a PRD is thousands of words, so returning bodies here would
    blow both the model's context and the 6 MB synchronous-invoke ceiling.
    Bodies become resources in a later phase.
    """
    meta, personas, documents = _get_project_payload(token_info)
    # Every field below is declared a string in this tool's own `outputSchema`, so
    # every one is coerced. `.get(key, '')` defaults on an ABSENT key and cannot
    # correct a value of the wrong TYPE — the mechanism behind `list_personas`
    # being uncallable, and this tool reports a persona `tagline` from the same
    # LLM-authored rows. Well-formed rows are unaffected: `_as_string` returns a
    # string unchanged.
    return ToolResult({
        "project_id": token_info['project_id'],
        "name": _as_string(meta.get('name')),
        "description": _as_string(meta.get('description')),
        "created_at": _as_string(meta.get('created_at')),
        "persona_count": len(personas),
        "document_count": len(documents),
        "personas": [
            {"persona_id": _as_string(p.get('persona_id')), "name": _as_string(p.get('name')),
             "tagline": _as_string(p.get('tagline'))}
            for p in personas
        ],
        "documents": [_project_document(document) for document in documents],
    })


@tracer.capture_method
def _tool_list_personas(args: dict, token_info: dict) -> ToolResult:
    """Every persona for a project, in full.

    Derived from the same project route rather than from a personas-only read:
    there is no such route, and inventing a second path to the same rows is what
    delegating exists to avoid. The cost is reading the project's documents to
    discard them, which is one Query either way.
    """
    _meta, personas, _documents = _get_project_payload(token_info)
    return ToolResult({
        "count": len(personas),
        "personas": [_project_persona(p) for p in personas],
    })


@tracer.capture_method
def _tool_get_feedback_detail(args: dict, token_info: dict) -> ToolResult:
    """One feedback item in full, by id.

    A missing item is now the route's 404 arriving as a tool ERROR rather than
    the prose "not found" inside a successful result this tool used to return.
    That is the point of the change: a model reading `isError: false` has been
    told the call worked, so it treats the prose as data and reports the item as
    empty rather than retrying with a different id.
    """
    feedback_id = args.get('feedback_id')
    if not isinstance(feedback_id, str) or not feedback_id.strip():
        raise InvalidToolArgument('feedback_id must be a non-empty string')

    body = _delegated_object(
        _domain_call('feedback_item',
                     path_parameters={'feedback_id': feedback_id.strip()}),
        token_info,
        'feedback',
    )
    return ToolResult(_project_feedback(body, summary=False))


def _projected_rows(body: dict, key: str = 'items') -> list[dict]:
    """The route's item list, projected as feedback summaries.

    Stated once because four tools now do exactly this to the same route family.
    A non-dict ENTRY is skipped rather than handed to `_project_feedback`, which
    reads `.get` — the jobs and feedback tables are written by several producers and
    a stray scalar in a list is a shape no schema stops. Projecting before counting
    is what keeps `count` a description of what the caller received: counting the
    route's own list would let a skipped entry make `count` exceed `len(items)`
    inside one payload.

    `body` is a dict by contract, not by defence: every caller obtains it from
    `_delegated_object`, which is where a non-object answer becomes the server fault
    it is. The earlier `isinstance(body, dict)` guard here was the coercing half of
    the inconsistency that helper records.
    """
    rows = body.get(key, [])
    if not isinstance(rows, (list, tuple)):
        return []
    return [_project_feedback(row, summary=True) for row in rows if isinstance(row, dict)]


def _feedback_filters(args: dict) -> dict[str, Any]:
    """The filter arguments the /feedback family reads, under the routes' own names.

    `None` values are dropped by `build_proxy_event`, so an omitted filter is
    forwarded as absence rather than as a value this file invented — the rule
    `test_mcp_date_basis.py::test_omits_date_basis_when_the_caller_gave_none`
    pins. Nothing is validated here on purpose: the routes' own validators are the
    single implementation of each allowlist, and a copy in the adapter is the drift
    delegation exists to remove.
    """
    return {
        'category': args.get('category'),
        'sentiment': args.get('sentiment'),
        'source': args.get('source'),
        'date_basis': args.get('date_basis'),
    }


@tracer.capture_method
def _tool_list_feedback(args: dict, token_info: dict) -> ToolResult:
    """One page of the feedback window, WITH its pagination reported.

    The same route `_tool_search_feedback` uses for its filter-only branch, and
    the difference is the whole reason this tool exists: that one reports `count`
    and `items` and discards `total`, `offset`, `limit` and `is_partial_window`, so
    a model could see twenty items and never learn whether the window held twenty
    or two thousand. All four travel through here.

    The counts are read off the ROUTE rather than recomputed: `total` describes the
    filtered candidate window, which this process never sees, so it can only be
    reported or dropped — and dropping it was the defect.
    """
    # Clamped to what this tool DECLARES, because the fallback below is reported
    # under a field described as the page the route applied. `inputSchema` is a
    # declaration, not an enforcement — nothing rejects `limit: 500` before it gets
    # here — so an unclamped fallback would report `limit: 500` for a page the route
    # would have capped at 100. The route always echoes today, which makes this
    # hypothetical rather than live, and it is exactly the "declaration looser than
    # reality" shape the rest of this file spends its length preventing.
    #
    # Bounds are READ FROM THE DECLARATION rather than restated: a literal 100 here
    # would be a second source of truth that cannot fail CI when the schema moves.
    requested_limit = _within_declared_bounds('list_feedback', 'limit', args, 50)
    requested_offset = _within_declared_bounds('list_feedback', 'offset', args, 0)
    body = _delegated_object(
        _domain_call('feedback_list', query={
            'days': args.get('days', 7),
            'limit': requested_limit,
            'offset': requested_offset,
            **_feedback_filters(args),
        }),
        token_info,
        'feedback',
    )
    items = _projected_rows(body)
    return ToolResult({
        "count": len(items),
        # `_as_int` rather than a bare `.get(key, 0)`: the route's own values are
        # ints, and a default fires only on an ABSENT key — it cannot correct a
        # value of the wrong type, which is the M1 mechanism. Declared integers get
        # coerced to integers.
        #
        # 🔑 `offset` AND `limit` FALL BACK TO THE REQUEST, not to 0. A page size of
        # zero is a value this route can never mean, and it is not inert: a client
        # walking `offset + limit` never advances, so a body that merely omitted the
        # echo turned into an infinite loop reading the same page. The effective
        # request value is what the page actually WAS — the route's own default is
        # what these arguments carry — so reporting it is a description of the call
        # rather than a guess.
        #
        # `total` deliberately keeps the 0, because every candidate fallback is a
        # lie: `len(items)` or `offset + count` would assert that this page is the
        # whole filtered window, which is the last-page claim the route did not make
        # and the exact reading `total` exists to stop being invented. Nothing in
        # this process knows the window's size. A 0 beside a non-empty `items` is
        # visibly self-contradictory, which is the honest signal available here.
        "total": _as_int(body.get('total')),
        "offset": _as_int(body.get('offset'), requested_offset),
        "limit": _as_int(body.get('limit'), requested_limit),
        # Coerced with `bool()` for the same reason `_tool_search_feedback` coerces
        # its copy: the declaration says boolean, and a route answering `null` would
        # otherwise put a null under a boolean declaration.
        "is_partial_window": bool(body.get('is_partial_window')),
        "items": items,
    })


@tracer.capture_method
def _tool_get_similar_feedback(args: dict, token_info: dict) -> ToolResult:
    """The neighbours of one feedback item, by the route's own similarity.

    An unknown id is the route's 404 arriving as a tool ERROR, exactly as in
    `_tool_get_feedback_detail` and for the same reason: a successful result
    carrying no items would tell a model this complaint is unique when in fact the
    id was wrong.

    The route answers with RAW rows, the same shape `/feedback` returns, so
    `_project_feedback(summary=True)` applies unchanged — no second projection.
    """
    feedback_id = args.get('feedback_id')
    if not isinstance(feedback_id, str) or not feedback_id.strip():
        raise InvalidToolArgument('feedback_id must be a non-empty string')

    body = _delegated_object(
        _domain_call('feedback_similar',
                     path_parameters={'feedback_id': feedback_id.strip()},
                     query={'limit': args.get('limit', 8)}),
        token_info,
        'similar feedback',
    )
    items = _projected_rows(body)
    return ToolResult({
        # The caller's own id, not the route's echo of it: the two are the same
        # value, and reporting the argument keeps the field present even if the
        # route ever stopped echoing it.
        "source_feedback_id": feedback_id.strip(),
        "count": len(items),
        "items": items,
    })


@tracer.capture_method
def _tool_list_urgent_feedback(args: dict, token_info: dict) -> ToolResult:
    """The window's high-urgency items, one page deep.

    `count` is `len(items)` — this page — and that is the route's semantics too:
    its scan stops as soon as `limit` items survive the filters, and it publishes
    no truncation flag, so no total exists to report. The output declaration says
    so in the field's own description and points at `get_metrics_summary`'s
    `urgent_count` for a window total; see that description for the defect this
    prevents.
    """
    body = _delegated_object(
        _domain_call('feedback_urgent', query={
            'days': args.get('days', 30),
            'limit': args.get('limit', 50),
            **_feedback_filters(args),
        }),
        token_info,
        'urgent feedback',
    )
    items = _projected_rows(body)
    return ToolResult({"count": len(items), "items": items})


def _counts_map(value: Any) -> dict:
    """A declared-object counts map, or an empty one.

    The counterpart of `_as_string`/`_as_int` for the two maps `list_feedback_facets`
    declares: a value of the wrong TYPE cannot be corrected by `.get(key, {})`,
    which fires only on an absent key, and that gap is the M1 mechanism. Values pass
    through unchanged — the maps are open (their keys are category names and problem
    summaries, which no schema can enumerate) so there is nothing to coerce inside
    them.
    """
    return value if isinstance(value, dict) else {}


@tracer.capture_method
def _tool_list_feedback_facets(args: dict, token_info: dict) -> ToolResult:
    """What a window is about: counts per category, and the recurring problems.

    PROJECTED rather than passed through, unlike the metrics tools, because the
    route's `entities` object holds five maps and only two of them are this tool's
    answer. The other three:

      • `keywords` is a hardcoded `{}` in BOTH branches of the route — there is no
        keyword extraction behind it — so it is neither projected nor declared. A
        declared field no real answer fills is finding M1's shape, and PR #368's
        substance check reports it.
      • `personas` and `sources` are real, and `get_metrics_breakdown` already
        reports each per axis, with the legacy-persona-bucket caveat attached to
        that tool's own dimension description. Two tools reporting one map is the
        duplication delegation exists to remove.
    """
    body = _delegated_object(
        _domain_call('feedback_entities', query={
            'days': args.get('days', 7),
            'limit': args.get('limit', 100),
            'source': args.get('source'),
            'date_basis': args.get('date_basis'),
        }),
        token_info,
        'entities',
    )
    entities = body.get('entities')
    entities = entities if isinstance(entities, dict) else {}
    return ToolResult({
        "period_days": _as_int(body.get('period_days')),
        "feedback_count": _as_int(body.get('feedback_count')),
        # `bool()` because only ONE of the route's two branches used to publish this
        # flag, so an absent value is a real case — and `_tool_search_feedback`
        # coerces its copy of the same fact for the same reason.
        "is_partial": bool(body.get('is_partial')),
        # `_counts_map` rather than the raw value: both are declared objects, and a
        # route answering a list would put a list under an `object` declaration.
        "categories": _counts_map(entities.get('categories')),
        "issues": _counts_map(entities.get('issues')),
    })


def _project_job(item: dict) -> dict:
    """One background job, in the shape `_JOB_PROPERTIES` declares.

    `result` is dropped, deliberately: it holds whatever the job produced — a
    research report, a product report, a prototype's HTML — which is the same
    reason `_tool_get_project` lists documents by title instead of inlining their
    bodies. The 6 MB synchronous-invoke ceiling and the model's context budget are
    both reachable by ONE completed prototype.

    Every field is coerced to its declared type rather than read with a default,
    because the route projects `None` into most of these slots for a job that has
    not finished: a `None` under a `string` declaration is exactly the M1 shape,
    and `_as_string(None)` is `''`.
    """
    return {
        key: _coerce_declared(item.get(key), declared_type)
        for key, declared_type in _JOB_TYPES.items()
    }


@tracer.capture_method
def _tool_list_jobs(args: dict, token_info: dict) -> ToolResult:
    """A project's background jobs, newest first.

    `project_id` is the project `_handle_tools_call` resolved and authorized, the
    same contract `_get_project_payload` documents: it is not "the token's
    project" — a credential can reach several — so it is read from `token_info`
    rather than re-derived from the arguments.

    ⚠️ TRUNCATION IS SILENT AT THE ROUTE. `api_list_jobs` applies a hardcoded
    `Limit=50` and returns no `LastEvaluatedKey`, so a project with more jobs than
    that is answered with 50 and nothing says so. The tool's description states it;
    it cannot be detected here, because a full page and a truncated one are the
    same answer. Making it detectable is a route change and is deliberately out of
    this slice.
    """
    body = _delegated_object(
        _domain_call('project_jobs',
                     path_parameters={'project_id': token_info['project_id']}),
        token_info,
        'jobs',
    )
    rows = body.get('jobs')
    rows = rows if isinstance(rows, (list, tuple)) else []
    jobs = [_project_job(row) for row in rows if isinstance(row, dict)]
    # `success` is dropped: it is the route's own always-true envelope field, and a
    # constant is not information a model can act on. A real failure arrives as a
    # non-2xx and is already a tool error by the time this line runs.
    return ToolResult({"count": len(jobs), "jobs": jobs})


# Tool name → implementation mapping
TOOL_HANDLERS = {
    "search_feedback": _tool_search_feedback,
    "get_feedback_detail": _tool_get_feedback_detail,
    "get_metrics_summary": _tool_get_metrics_summary,
    "get_metrics_breakdown": _tool_get_metrics_breakdown,
    "get_project": _tool_get_project,
    "list_personas": _tool_list_personas,
    "list_feedback": _tool_list_feedback,
    "get_similar_feedback": _tool_get_similar_feedback,
    "list_urgent_feedback": _tool_list_urgent_feedback,
    "list_feedback_facets": _tool_list_feedback_facets,
    "list_jobs": _tool_list_jobs,
}

# The scope each registered tool requires, from the vocabulary in
# shared/mcp_tokens.py.
#
# Every entry in TOOL_HANDLERS MUST appear here. The dispatch in
# _handle_tools_call is fail-closed: a tool with no declared scope is rejected
# rather than defaulting to allowed, so an author who adds a handler without
# updating this table gets an immediate error at call time rather than an
# accidentally-public endpoint.
#
# Scopes are now per-domain (`feedback:read`, not `read`), so a token can be
# minted that reads feedback without reading anybody's product strategy. The
# previous single `read`/`read-write` pair could not express that, and its
# `read-write` half was a phantom — mintable, stored and badged in the UI while
# no tool ever required it.
TOOL_SCOPE_REQUIREMENTS: dict[str, str] = {
    "search_feedback": SCOPE_FEEDBACK_READ,
    "get_feedback_detail": SCOPE_FEEDBACK_READ,
    # The four /feedback readers, all under the feedback scope — including
    # `list_feedback_facets`, whose answer is COUNTED rather than verbatim: it
    # aggregates the same corpus (and its `issues` map holds real problem summaries),
    # so a credential that may not read feedback may not read counts of it either.
    # `metrics:read` covers the pre-aggregated dashboards, which is a different set
    # of rows.
    "list_feedback": SCOPE_FEEDBACK_READ,
    "get_similar_feedback": SCOPE_FEEDBACK_READ,
    "list_urgent_feedback": SCOPE_FEEDBACK_READ,
    "list_feedback_facets": SCOPE_FEEDBACK_READ,
    "get_metrics_summary": SCOPE_METRICS_READ,
    "get_metrics_breakdown": SCOPE_METRICS_READ,
    "get_project": SCOPE_PROJECTS_READ,
    "list_personas": SCOPE_PROJECTS_READ,
    "list_jobs": SCOPE_PROJECTS_READ,
}

# How each tool's data is SHAPED, which decides how the token's read_reach
# applies to it (shared.mcp_tokens.reach_allows).
#
# `workspace` — the data has no project dimension at all. The feedback corpus
#   is keyed `SOURCE#{platform}` with no project_id, and metrics are workspace
#   aggregates. A token whose reach is `project-set` therefore cannot call
#   these: there is nothing to narrow, so allowing them would hand a supposedly
#   sealed credential the entire verbatim history.
# `project` — the tool addresses exactly one project, named by a `project_id`
#   argument (or defaulted from the token's project set when unambiguous), and
#   that project must be within reach.
#
# Also fail-closed: a tool with no declared reach kind is rejected.
TOOL_REACH_KINDS: dict[str, str] = {
    "search_feedback": REACH_KIND_WORKSPACE,
    "get_feedback_detail": REACH_KIND_WORKSPACE,
    # Every /feedback route reads the same project-less corpus, so all four of the
    # new feedback tools are workspace-shaped for the reason stated above: there is
    # no project dimension to narrow, and admitting a `project-set` credential would
    # hand a supposedly sealed token the whole verbatim history.
    "list_feedback": REACH_KIND_WORKSPACE,
    "get_similar_feedback": REACH_KIND_WORKSPACE,
    "list_urgent_feedback": REACH_KIND_WORKSPACE,
    "list_feedback_facets": REACH_KIND_WORKSPACE,
    "get_metrics_summary": REACH_KIND_WORKSPACE,
    "get_metrics_breakdown": REACH_KIND_WORKSPACE,
    "get_project": REACH_KIND_PROJECT,
    "list_personas": REACH_KIND_PROJECT,
    # Jobs are keyed `PROJECT#{project_id}`, so this addresses exactly one project
    # and takes the same `project_id` argument `get_project` does.
    "list_jobs": REACH_KIND_PROJECT,
}


# ============================================
# MCP JSON-RPC protocol handling
# ============================================

# `resultType` — the SPEC's field, carrying the spec's own value.
#
# ⚠️ This was the defect the first draft of this change shipped: the seven local
# shape names below travelled in `resultType` itself. That field's value space is
# owned by the spec, which defines `complete` and `input_required` (the MRTR
# interim result) and says a value the client does not recognize "MUST be
# considered invalid" — extension values are legal only when advertised through a
# capability-declared extension, and this server declares none. So a strict
# 2026-07-28 client had to reject EVERY result from this server, which made the
# newest advertised revision less interoperable than the pinned 2024-11-05 it
# replaced (where the field is absent and an absent value reads as `complete`).
#
# `complete` on every result here is the whole vocabulary this server needs:
# `input_required` belongs to multi-round-trip requests, and no tool asks the
# caller for more input mid-call.
#
# ⚠️ DEFINED BY 2026-07-28, which this server does not advertise. Sent anyway
# because it is additive under every advertised revision's permissive `Result`
# schema; see the PROVENANCE block at `ASSUMED_PROTOCOL_VERSION` for the full
# argument and for what changes when that revision becomes negotiable.
RESULT_TYPE_KEY = 'resultType'
RESULT_TYPE_COMPLETE = 'complete'

# The local shape discriminator travels under `RESULT_SHAPE_KEY` (declared with the
# other vendor `_meta` keys, above the tool catalogue) rather than in the spec's
# field. Same reasoning the cost class already followed: a client that does not
# know the key ignores `_meta` wholesale, instead of failing to validate a result
# carrying a field its schema does not define.
#
# 🔑 Why a discriminator at all, rather than "look at which keys are present":
# every result here is a bare JSON object, and telling them apart by key
# inference is guesswork that gets worse as shapes grow. A tool result and a tool
# ERROR differ only by a boolean and by whether `structuredContent` happens to be
# there; `ping` answers a bare `{}`. A client switching on inferred shape
# re-derives that table from scratch, gets it subtly wrong, and the failure lands
# in the client rather than here.
#
# `toolError` is a distinct shape rather than "a toolResult with isError" ON
# PURPOSE, and `isError` is still sent: the flag is what the spec defines, the
# shape is what says the payload has no `structuredContent` to validate.
#
# ⚠️ There is NO `ack` shape, and its absence is load-bearing rather than an
# omission. It existed to describe the answer to a notification — and a
# notification gets 202 Accepted with no body, which every advertised revision
# states as a MUST, so there is no result to name. Adding one back would be
# describing a response the transport says must not be sent; the pong/ack pair
# that half-justified this discriminator was a pair of answers to a message that
# should have had one.
RESULT_SHAPE_INITIALIZE = 'initialize'
RESULT_SHAPE_DISCOVERY = 'discovery'
RESULT_SHAPE_TOOL_LIST = 'toolList'
RESULT_SHAPE_TOOL_RESULT = 'toolResult'
RESULT_SHAPE_TOOL_ERROR = 'toolError'
RESULT_SHAPE_PONG = 'pong'

RESULT_SHAPES: frozenset[str] = frozenset({
    RESULT_SHAPE_INITIALIZE,
    RESULT_SHAPE_DISCOVERY,
    RESULT_SHAPE_TOOL_LIST,
    RESULT_SHAPE_TOOL_RESULT,
    RESULT_SHAPE_TOOL_ERROR,
    RESULT_SHAPE_PONG,
})


# The id of a message that HAS none — passed to `_jsonrpc_error` for a refusal
# whose subject is not a request, where the `id` member is OMITTED rather than sent
# as null.
#
# A sentinel object rather than `None`, because `None` is a legitimate id to echo:
# JSON-RPC's own rule for a malformed body is that an id it could not detect is
# reported as `null`, and `test_a_non_object_body_is_not_a_crash` pins exactly that.
# So "no id at all" and "an id of null" are two different answers and cannot share
# one spelling — which is the same distinction `_is_notification` turns on, one
# layer down.
#
# ⚠️ THE RULE FOR WHICH REFUSALS USE WHICH, stated here because it was previously
# only inferable from which call sites happened to be changed:
#
#   • `_NO_ID` — NO JSON-RPC message could have carried an id. A notification and
#     an id-less request (their bodies carry no `id` member, by `_carries_no_id`);
#     the Origin 403 (it runs before the body is parsed, and its subject may
#     legitimately be a notification); and the 405 (a `GET` or `DELETE` typically
#     carries no body — there is no message at all, so there is no id to have
#     failed to detect).
#   • `None`, i.e. `"id": null` — a message WAS claimed and its id could not be
#     DETECTED. The parse error, the non-object body, and the batch (many
#     messages, no single id): JSON-RPC's own rule for an undetectable id is
#     `null`, and `test_a_non_object_body_is_not_a_crash` pins it deliberately.
#
# The discriminator is whether "there is an id, and what is it?" was a question
# this server can honestly say it could not answer (null), or a question that has
# no subject (omitted). A future refusal that runs before `json.loads` should ask
# which of those two it is, not copy its nearest neighbour.
_NO_ID = object()


def _jsonrpc_error(req_id: Any, code: int, message: str, data: Any = None) -> dict:
    """Build a JSON-RPC error response, optionally carrying machine-readable data.

    `data` is omitted entirely when absent rather than sent as `null`: the spec
    makes the member optional, and a present-but-null member is a third state a
    client has to handle for no gain.

    It exists because two of the spec's own errors put the caller's recovery path
    in `data` rather than in prose — `-32022` lists the versions this server does
    speak, which is what the client retries with. Prose is not a recovery path.

    ⚠️ `req_id=_NO_ID` OMITS the `id` member, and that is not a cosmetic option. The
    202 path stopped answering notifications with a result carrying `id: null`, but
    the REFUSAL path still did: a notification failing a transport guard was answered
    `400 {"id": null, "error": …}`. Every advertised revision says a notification the
    server cannot accept gets an HTTP error status whose body "MAY comprise a
    JSON-RPC error response that has NO id" — and `id: null` is a PRESENT member with
    a null value, which this module already holds is not the same thing (see
    `_is_notification`, and the 3.4.0 note recording that a result's id must not be
    null). A client correlating by id held an error entry matching no request it sent.

    Passing `None` still sends `"id": null`, which is what JSON-RPC requires for a
    body whose id could not be detected at all — a parse error, a batch, a non-object.
    The two cases are spelled differently because they are different answers.
    """
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    envelope: dict[str, Any] = {"jsonrpc": "2.0"}
    if req_id is not _NO_ID:
        envelope["id"] = req_id
    envelope["error"] = error
    return envelope


def _jsonrpc_result(req_id: Any, result_shape: str, result: dict) -> dict:
    """Build a JSON-RPC success response: spec `resultType`, local shape in `_meta`.

    The shape is a REQUIRED positional argument rather than an optional keyword,
    which is the whole design: every result this server returns is built here, so
    a new result shape cannot ship without naming itself. An optional parameter
    would have made the discriminator a thing authors remember, which is the same
    class of defect as a declaration nothing checks.

    An undeclared shape raises rather than travelling: a client switching on the
    value cannot switch on a typo, and finding out at the client is finding out
    too late.

    A payload that already carries either key ALSO raises. Ordering the spread so
    the injected value wins would have been the one-character fix, but silently
    overwriting a caller's value is the same defect in the other direction — and
    the earlier `{KEY: value, **result}` form let a payload replace the validated
    discriminator outright, which is exactly the guarantee this function exists to
    provide.

    `_meta` is MERGED rather than replaced, because a caller's `_meta` (the cache
    hints on `tools/list`, the cost class on a tool result) has to survive
    alongside the shape.
    """
    if result_shape not in RESULT_SHAPES:
        raise ValueError(f'undeclared result shape {result_shape!r}')
    if RESULT_TYPE_KEY in result:
        raise ValueError(
            f'result already carries {RESULT_TYPE_KEY!r}; it is set here, not by callers'
        )
    caller_meta = result.get('_meta') or {}
    if RESULT_SHAPE_KEY in caller_meta:
        raise ValueError(
            f'result _meta already carries {RESULT_SHAPE_KEY!r}; it is set here, '
            f'not by callers'
        )
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "result": {
            **result,
            RESULT_TYPE_KEY: RESULT_TYPE_COMPLETE,
            "_meta": {**caller_meta, RESULT_SHAPE_KEY: result_shape},
        },
    }


def _server_capabilities() -> dict:
    """What this server can do, stated once for `initialize` and `server/discover`.

    `listChanged: false` is honest rather than lazy — there is no notification
    path here, so a client that caches `tools/list` at connect holds it until it
    reconnects. That is why an envelope change is a reconnect (see the
    MCP_SERVER_VERSION notes) and why the list carries cache hints of its own.
    """
    return {
        "tools": {"listChanged": False},
    }


def _handle_initialize(req_id: Any, params: dict) -> dict:
    """Handle MCP initialize — the version handshake.

    The client states the revision it wants in `params.protocolVersion` and this
    answers with what the session will actually speak, which is the client's
    version when this server implements it and the newest one it does implement
    otherwise. Pinning a single string here, as this used to, meant the answer was
    the same whatever was asked — a handshake in shape only.
    """
    requested = params.get('protocolVersion') if isinstance(params, dict) else None
    return _jsonrpc_result(req_id, RESULT_SHAPE_INITIALIZE, {
        "protocolVersion": _negotiate_protocol_version(requested),
        "capabilities": _server_capabilities(),
        "serverInfo": {
            "name": "voc-datalake",
            "version": MCP_SERVER_VERSION,
        },
    })


def _handle_discover(req_id: Any, _params: dict) -> dict:
    """Handle `server/discover` — what this server supports, without guessing.

    Everything a client would otherwise learn from a FAILED call: the protocol
    revisions on offer, the methods that exist, the transport headers that are
    read, the `resultType` vocabulary, and the cost classes tools are labelled
    with. A client that has to discover a method by receiving -32601 for it cannot
    tell "this server does not implement that" from "that method is spelled
    differently here", and it pays a round trip per guess.

    Every list is DERIVED from the registry that implements the thing, not
    restated: a method added to the dispatch tables appears here, and one that is
    only listed here cannot exist.

    Deliberately does NOT list tools. `tools/list` does that, and it varies by
    credential — repeating a credential-shaped answer on an unauthenticated
    method would either leak the catalogue or contradict the other method.

    ⚠️ The field names here are the SPEC's `DiscoverResult`, not this module's own
    vocabulary. The first draft published `protocolVersions` and a top-level
    `serverInfo`, which meant a client calling this method precisely to learn the
    supported versions read `supportedVersions`, found it absent, and was no better
    off than if the method did not exist. The extra facts this server can report
    are still reported — under a vendor-prefixed `_meta` key, which is where the
    cost class already lives and for the same reason.

    ⚠️ THE METHOD ITSELF, and `DiscoverResult` with it, is defined by 2026-07-28 —
    the revision this server does not advertise. It is offered under the advertised
    range as an extra method a client is free never to call, which is additive in
    the strongest sense: a client that does not know it asks for `initialize`
    instead and loses nothing, and one that does know it gets the spec's own field
    names rather than a local approximation it would have to unlearn. See the
    PROVENANCE block at `ASSUMED_PROTOCOL_VERSION`.
    """
    return _jsonrpc_result(req_id, RESULT_SHAPE_DISCOVERY, {
        # The spec's name for this list, and the one field a client calls this
        # method to read.
        "supportedVersions": list(SUPPORTED_PROTOCOL_VERSIONS),
        "capabilities": _server_capabilities(),
        # `server/discover` is in the spec's cacheable-results list, so the hints
        # are REQUIRED rather than a nicety.
        #
        # ⚠️ `private`, NOT `public`, and the earlier `public` was wrong for a reason
        # worth stating at the site: the scope describes the RESPONSE, not the
        # payload. This payload is genuinely credential-independent — it names no
        # project, no tool and no data — but this method is in
        # `_LIVENESS_CHECKED_METHODS`, so whether there is a 200 at all depends on
        # the credential presented. `public` licenses an intermediary to serve the
        # unauthenticated 200 "across authorization contexts" for the hour below,
        # including to the request carrying a revoked token that was owed a 401 —
        # defeating the liveness check on the one method that exists in that set for
        # the client which starts here. Full argument at `CACHE_SCOPE_PUBLIC`.
        "ttlMs": _DISCOVER_TTL_MS,
        "cacheScope": METHOD_CACHE_SCOPES['server/discover'],
        "_meta": {
            # The spec's reserved key for server identity — self-reported, and the
            # spec says clients SHOULD NOT make security decisions on it.
            'io.modelcontextprotocol/serverInfo': {
                "name": "voc-datalake",
                "version": MCP_SERVER_VERSION,
            },
            # Everything below is this server's own reporting, not the spec's, so
            # it travels under a vendor prefix: a client that does not know these
            # keys ignores them, instead of failing to validate a `DiscoverResult`
            # carrying fields its schema does not define.
            f'{VENDOR_META_PREFIX}serverDetail': {
                "preferredProtocolVersion": PREFERRED_PROTOCOL_VERSION,
                # Sorted, because this is a set rather than a sequence and a client
                # diffing two discoveries should see a change only when one happened.
                "methods": sorted({*MCP_METHODS, *MCP_AUTH_METHODS}),
                "authenticatedMethods": sorted(MCP_AUTH_METHODS),
                # In the spelling a client SENDS, not the lowercase form this
                # module reads after API Gateway has normalised it. Reporting the
                # internal spelling would document an implementation detail as a
                # contract.
                "transportHeaders": list(CANONICAL_TRANSPORT_HEADERS),
                # Named `resultShapes`, NOT `resultTypes`: the spec owns the
                # `resultType` vocabulary and this is not it. Publishing this list
                # as `resultTypes` would have claimed otherwise.
                "resultShapes": sorted(RESULT_SHAPES),
                "costClasses": list(COST_CLASSES),
                # The list varies by credential, so a client cannot conclude "these
                # are the tools" from an unauthenticated discovery. Saying so is
                # cheaper than letting it find out by calling one it was never
                # granted.
                "toolsVaryByCredential": True,
            },
        },
    })


# The stand-in a LISTING uses when it must ask a project-shaped question without
# a project. Only ever reached under `workspace` reach, which admits every project
# without consulting the id — so this value is never compared against anything and
# never becomes a path. Named rather than inlined so that is legible at the one
# place it is read.
_ANY_PROJECT = 'any-project'


def _token_projects(token_info: dict) -> list[str]:
    """The project ids on this credential: usable strings only, junk dropped.

    Read through one helper at every site that consults `projects`, because the
    value is STORED data and every caller of it is deciding reach. Two shapes are
    dropped here rather than downstream:

      • Entries that are not non-empty strings. A `None`, a `7` or a `{}` names no
        project, and counting one as a project would let a damaged row widen what
        a `project-set` token reaches.
      • A `projects` that is not a list at all — notably a bare STRING. `"proj1"`
        is iterable, so the per-entry filter above happily yielded `'p'`, `'r'`,
        `'o'`, … and the first of them passed as a project id; `reach_allows` then
        compared it with `in`, which against a string is a substring test, so the
        listing and the dispatch AGREED and both were wrong. `reach_allows` is
        hardened too — this is the fail-closed reading applied at both ends.
    """
    projects = token_info.get('projects')
    if not isinstance(projects, (list, tuple)):
        return []
    return [p for p in projects if isinstance(p, str) and p]


def _tool_is_authorized(tool_name: str, token_info: dict) -> bool:
    """Whether this credential could actually call *tool_name*.

    Both gates, in the same order `_handle_tools_call` applies them, and
    fail-closed on a tool with no declaration for either — the listing must not
    advertise a tool the dispatch would refuse as undeclared.

    The reach half asks the question a LISTING can ask, which is weaker than the
    per-call one by exactly one thing: a project-shaped tool is listed when the
    credential can reach SOME project, not when it can reach the one a later call
    will name. That is the honest bound — which project a call addresses is an
    argument of that call — and it is why `_handle_tools_call` still checks reach
    itself rather than trusting this.
    """
    required_scope = TOOL_SCOPE_REQUIREMENTS.get(tool_name)
    tool_reach_kind = TOOL_REACH_KINDS.get(tool_name)
    if required_scope is None or tool_reach_kind is None:
        return False
    if not _scope_allows(token_info.get('scopes'), required_scope):
        return False

    token_projects = _token_projects(token_info)
    read_reach = token_info.get('read_reach') or DEFAULT_READ_REACH
    # `reach_allows` decides on a CONCRETE project, and a listing has none, so a
    # project-shaped tool is asked about a representative one. A project from the
    # token's own set is the honest representative under every reach; only
    # `workspace` reach has no such set to draw on, and it is also the one reach
    # that does not consult the id at all, which is what makes the sentinel safe
    # rather than a guess. A `project-set` token with an empty set gets None here
    # and `reach_allows` refuses it, which is right — it can reach no project.
    representative = None
    if tool_reach_kind == REACH_KIND_PROJECT:
        representative = next(iter(token_projects), None)
        if representative is None and read_reach == REACH_WORKSPACE:
            representative = _ANY_PROJECT

    return reach_allows(
        read_reach=read_reach,
        token_projects=token_projects,
        tool_reach_kind=tool_reach_kind,
        project_id=representative,
    )


def _tools_for(token_info: dict) -> list[dict]:
    """The tools this credential may call, in a deterministic order.

    Sorted BY NAME rather than left in declaration order: the list is now
    credential-shaped, so two callers see different subsets, and a stable order is
    what makes a cached list comparable to a fresh one (and an `etag` over it
    mean anything). Declaration order would make the answer depend on where
    somebody inserted a literal.
    """
    return sorted(
        (tool for tool in MCP_TOOLS if _tool_is_authorized(tool["name"], token_info)),
        key=lambda tool: tool["name"],
    )


def _tools_list_etag(tools: list[dict]) -> str:
    """A stable fingerprint of exactly what this answer published.

    Over the SERIALIZED tools plus the server version, so it moves when a
    declaration moves and also when the version does — a client comparing etags
    is asking "is my cached catalogue still the one this server would send", and
    the server version is part of that answer even for an unchanged shape.

    `sort_keys` so reformatting a declaration is free, matching the convention the
    published-shape fingerprint test states.
    """
    serialized = json.dumps(
        {"version": MCP_SERVER_VERSION, "tools": tools}, sort_keys=True, cls=DecimalEncoder,
    )
    return hashlib.sha256(serialized.encode('utf-8')).hexdigest()[:32]


def _handle_tools_list(req_id: Any, _params: dict, token_info: dict) -> dict:
    """Handle MCP tools/list — filtered by the authorization actually presented.

    The spec blesses a tool set that varies by credential, and until now every
    caller saw every tool regardless of the scopes on its token: a
    `metrics:read`-only credential was shown `search_feedback` and `get_project`,
    called one, and was refused with -32003. A catalogue that lists what the
    caller cannot call is a catalogue that has to be tried to be believed.

    Cache hints travel with the answer because `listChanged: false` means the
    client is on its own: nothing will tell it the list moved. `cacheScope:
    private` is the load-bearing one — a shared cache keyed on the endpoint alone
    would serve one token's catalogue to another token, which only became possible
    the moment the list started varying.
    """
    tools = _tools_for(token_info)
    return _jsonrpc_result(req_id, RESULT_SHAPE_TOOL_LIST, {
        "tools": tools,
        # The spec's caching fields, at the top level where a spec-reading client
        # looks for them. `private` because this answer is a function of the
        # CREDENTIAL rather than of the endpoint — the spec names this exact case
        # ("filtered list results that vary per user").
        "ttlMs": _TOOL_LIST_TTL_MS,
        "cacheScope": METHOD_CACHE_SCOPES['tools/list'],
        "_meta": {
            # Not spec fields, so vendor-prefixed. The etag is what makes staleness
            # DETECTABLE rather than merely time-bounded, which matters more here
            # than for most caches: `listChanged: false` means no notification is
            # coming, so "re-ask and compare" is the only path a client has.
            f'{VENDOR_META_PREFIX}catalogue': {
                "etag": _tools_list_etag(tools),
                "serverVersion": MCP_SERVER_VERSION,
                # Stated rather than implied by the capability: a client reading
                # the hints should not have to also read `initialize` to learn
                # that nothing will notify it.
                "listChangedNotifications": False,
            },
        },
    })


def _scope_allows(token_scopes: Any, required_scope: str) -> bool:
    """Return True when the token's scope set contains *required_scope*.

    Pure predicate — no side effects. Callers are responsible for logging when
    this returns False.

    Exact membership, with no hierarchy: scopes are per-domain, so nothing
    "includes" anything else and there is no ordering to get wrong. A row whose
    `scopes` is missing or not a list of strings grants NOTHING rather than
    falling back to a default — the old code defaulted a missing scope to
    "read" because deployed rows predated the field, but the format change
    means every row now carries an explicit set, so a row without one is data
    damage and must not be guessed at.
    """
    if not required_scope:
        return False
    if not isinstance(token_scopes, (list, tuple, set, frozenset)):
        return False
    return required_scope in token_scopes


class InvalidToolArgument(Exception):
    """A tool argument is malformed on the tool's OWN terms.

    Reported as `-32602 Invalid params` and never delegated, which is the line
    worth keeping straight: a value the tool's `inputSchema` forbids (an unknown
    enum member, a `project_id` that is not a string) is a malformed request,
    while a well-formed value the DATA refuses (a project that does not exist)
    is the route's 404 and arrives as a tool error the model can act on. Sending
    the first kind downstream would turn a client bug into a domain lookup.
    """


class InvalidProjectArgument(InvalidToolArgument):
    """`project_id` was supplied but is not a usable project id."""


def _resolve_project_id(args: dict, token_info: dict) -> str | None:
    """Which project a project-shaped tool is addressing, or None.

    Explicit argument wins. Absent, it defaults to the token's project set when
    that set names exactly one project — the common case, since a token is
    minted from a project — so single-project clients need not pass it. An
    ambiguous default (a set with several projects) resolves to None rather
    than picking one, which the caller sees as a request to name the project.

    🔑 A PRESENT but unusable argument (`123`, `["p"]`, `"  "`) RAISES rather
    than falling back to the token's project. Falling back would read a
    *different* project than the client named and report success, which is worse
    than an error: the caller gets someone else's data believing it is the
    project they asked for. Absence and garbage are different intents and get
    different answers.
    """
    if 'project_id' in args:
        explicit = args['project_id']
        if not isinstance(explicit, str) or not explicit.strip():
            raise InvalidProjectArgument(
                f'project_id must be a non-empty string, got '
                f'{type(explicit).__name__}'
            )
        return explicit.strip()
    # One usable project on the credential is an unambiguous default; anything
    # else (none, or several) is not, and returns None rather than picking. The
    # shape filtering lives in `_token_projects`, so a `projects` stored as a bare
    # string cannot present its first character as "the only project".
    token_projects = _token_projects(token_info)
    if len(token_projects) == 1:
        return token_projects[0]
    return None


def _handle_tools_call(req_id: Any, params: dict, token_info: dict) -> dict:
    """Handle MCP tools/call request."""
    tool_name = params.get('name', '')
    arguments = params.get('arguments', {})

    # An explicit `"arguments": null` means "no arguments", not "bad request".
    # `params.get('arguments', {})` cannot supply the default for it, because the
    # KEY IS PRESENT — and some JSON-RPC/MCP clients serialize an omitted
    # optional object as null rather than dropping it. Every tool here has only
    # optional arguments, so `{}` is exactly what such a caller meant; refusing
    # it would be a compatibility edge invented by this guard rather than a real
    # protocol error.
    if arguments is None:
        arguments = {}

    # Anything else non-object is genuinely malformed. A list, string or number
    # reaches the project resolution below, where both `'project_id' in args` and
    # `args['project_id']` raise TypeError — and that resolution runs OUTSIDE the
    # try/except around the handler, so it escapes as a 502 with no JSON-RPC
    # envelope and no CORS headers. Refused here at the boundary, which is the
    # same lesson the BotoCoreError clause in _authenticate records: an unhandled
    # type is a protocol-level error, not a server crash.
    if not isinstance(arguments, dict):
        return _jsonrpc_error(
            req_id, -32602,
            f"'arguments' must be an object, got {type(arguments).__name__}",
        )

    handler = TOOL_HANDLERS.get(tool_name)
    if not handler:
        return _jsonrpc_error(req_id, -32602, f"Unknown tool: {tool_name}")

    # Scope enforcement — fail-closed: a tool with no declared requirement
    # is rejected rather than defaulting to allowed.
    required_scope = TOOL_SCOPE_REQUIREMENTS.get(tool_name)
    if required_scope is None:
        logger.error("Tool has no declared scope requirement", extra={"tool": tool_name})
        return _jsonrpc_error(req_id, -32603, f"Tool {tool_name} has no declared scope requirement")

    # Same fail-closed treatment for the reach kind: without it there is no way
    # to know whether read_reach even applies to this tool, and guessing would
    # mean guessing in the permissive direction.
    tool_reach_kind = TOOL_REACH_KINDS.get(tool_name)
    if tool_reach_kind is None:
        logger.error("Tool has no declared reach kind", extra={"tool": tool_name})
        return _jsonrpc_error(req_id, -32603, f"Tool {tool_name} has no declared reach kind")

    token_scopes = token_info.get('scopes')
    if not _scope_allows(token_scopes, required_scope):
        logger.warning(
            "Scope insufficient for tool",
            extra={"tool": tool_name, "required": required_scope},
        )
        return _jsonrpc_error(
            req_id, -32003,
            f"Forbidden: token lacks the '{required_scope}' scope required by '{tool_name}'",
        )

    # Reach enforcement. Separate from scope on purpose: scope says WHICH KIND
    # of data a token may read, reach says HOW FAR. A token can hold
    # `projects:read` and still be refused a particular project.
    read_reach = token_info.get('read_reach') or DEFAULT_READ_REACH
    token_projects = _token_projects(token_info)
    project_id = None
    if tool_reach_kind == REACH_KIND_PROJECT:
        try:
            project_id = _resolve_project_id(arguments, token_info)
        except InvalidProjectArgument as exc:
            return _jsonrpc_error(req_id, -32602, str(exc))

    if not reach_allows(
        read_reach=read_reach,
        token_projects=token_projects,
        tool_reach_kind=tool_reach_kind,
        project_id=project_id,
    ):
        # The refusals read differently because they need different fixes: one
        # wants an argument, the other wants a differently-scoped token.
        #
        # Ordering, precisely — a MALFORMED argument is reported earlier, by
        # _resolve_project_id, because an ill-formed request is ill-formed
        # whatever the token's reach (syntax before authorization, as everywhere
        # else). What is checked reach-first is the MISSING-argument case below:
        # a `none`-reach token can never call anything, so asking it for a
        # project_id would send the caller after an argument that cannot help.
        reach_covers_nothing = (
            read_reach == REACH_NONE
            or (read_reach == REACH_PROJECT_SET and tool_reach_kind == REACH_KIND_WORKSPACE)
        )
        if tool_reach_kind == REACH_KIND_PROJECT and not project_id and not reach_covers_nothing:
            return _jsonrpc_error(
                req_id, -32602,
                f"'{tool_name}' needs a project_id argument: this token's project "
                f"set does not name exactly one project",
            )
        logger.warning(
            "Read reach does not cover this call",
            extra={"tool": tool_name, "read_reach": read_reach, "kind": tool_reach_kind},
        )
        return _jsonrpc_error(
            req_id, -32003,
            f"Forbidden: this token's read reach ('{read_reach}') does not cover "
            f"'{tool_name}'",
        )

    if tool_reach_kind == REACH_KIND_PROJECT:
        # The AUTHORIZED project for this one call, which is what the
        # project-shaped tools read. Injected rather than passed as a new
        # parameter so resolution and authorization stay in this one place
        # instead of being repeated per tool.
        token_info = {**token_info, 'project_id': project_id}

    # The three outcomes are separated because the MCP spec separates them, and
    # the distinction is what lets a model behave sensibly:
    #
    #   malformed call        → JSON-RPC error   (-32602) — the client is wrong
    #   route refused a call  → RESULT isError   — the model can try something else
    #   infrastructure fault  → JSON-RPC error   (-32603) — nobody upstream can fix it
    #
    # Collapsing the middle case into the first would tell a model its request
    # was malformed when it was merely unlucky; collapsing it into a successful
    # result (what this handler used to do for "not found") tells the model the
    # call worked and the data is empty, which it then reports as fact.
    try:
        result = handler(arguments, token_info)
    except InvalidToolArgument as exc:
        return _jsonrpc_error(req_id, -32602, str(exc))
    except ToolRouteError as exc:
        return _tool_error(req_id, str(exc))
    except DelegationUnavailable:
        # Already logged with the route and fault type at the point of failure.
        # The client is told only that the server failed: the detail is a
        # function name, a status code or a stack trace, none of which is the
        # caller's business and one of which is a fingerprint of the topology.
        logger.error("Delegation failed", extra={"tool": tool_name})
        return _jsonrpc_error(req_id, -32603, "Internal error: upstream service unavailable")
    except Exception as e:
        logger.exception(f"Tool execution error: {tool_name}")
        return _tool_error(req_id, f"Error: {str(e)}")

    return _jsonrpc_result(req_id, RESULT_SHAPE_TOOL_RESULT, {
        "content": [{"type": "text", "text": result.text}],
        # Structured output alongside the text block, not instead of it: the
        # spec says a tool SHOULD keep sending the serialized form for clients
        # that predate `structuredContent`, and both come from one value here so
        # they cannot disagree.
        "structuredContent": result.structured,
        "isError": False,
        # The cost the call actually carried, which is the same class the
        # catalogue advertised — read from one table so an advertised `cheap` and
        # a billed `expensive` cannot be two different facts.
        #
        # `.get` rather than `[...]`, for the same reason `_FEEDBACK_SOURCE_KEYS`
        # is read with a fallback: a tool with no declared class must not turn
        # into a `KeyError` that kills a working call. The omission is still a CI
        # failure (`_published_tool` refuses to build the catalogue, and the
        # declaration tables are asserted to agree), so this decides only whether
        # the symptom is a red test or a dead tool.
        # Same vendor-prefixed key the catalogue publishes, so a client reading the
        # class off a result and off the declaration reads one name.
        **({"_meta": {COST_CLASS_KEY: TOOL_COST_CLASSES[tool_name]}}
           if tool_name in TOOL_COST_CLASSES else {}),
    })


def _tool_error(req_id: Any, message: str) -> dict:
    """A tool EXECUTION error: a successful JSON-RPC call reporting a failure.

    Its own `resultType`, distinct from a successful tool result, because the
    payloads differ in a way `isError` alone does not describe: there is no
    `structuredContent` to validate against the tool's `outputSchema`. A client
    switching on the type knows that without having to test for the key.
    """
    return _jsonrpc_result(req_id, RESULT_SHAPE_TOOL_ERROR, {
        "content": [{"type": "text", "text": message}],
        "isError": True,
    })


def _handle_ping(req_id: Any, _params: dict) -> dict:
    """Handle MCP ping request."""
    return _jsonrpc_result(req_id, RESULT_SHAPE_PONG, {})


# Method → handler mapping.
#
# `initialize`, `ping` and `server/discover` require no credential, and
# `server/discover` is deliberately in this half: it answers what the SERVER
# supports, which a client needs before it has decided which credential to
# present — and it names no project, no tool and no data. `tools/list` is in the
# other half precisely because its answer IS credential-shaped.
MCP_METHODS = {
    "initialize": _handle_initialize,
    "ping": _handle_ping,
    "server/discover": _handle_discover,
    # `None` means "this method produces no result": it is answered with 202 and
    # no body, not with a result carrying `id: null`. See `_is_notification`.
    "notifications/initialized": None,
}

# Methods that require authentication
MCP_AUTH_METHODS = {
    "tools/list": _handle_tools_list,
    "tools/call": _handle_tools_call,
}


# The prefix MCP gives every notification method it defines. Used to tell a
# fire-and-forget message from a request WITHOUT a table of them, which matters
# because the notifications this server does not implement are the ones that need
# recognising: `notifications/cancelled`, `notifications/progress` and
# `notifications/roots/list_changed` are all methods a conforming client may send
# and none of them is dispatched here.
_NOTIFICATION_METHOD_PREFIX = 'notifications/'


def _is_notification(body: Any, method: str) -> bool:
    """True when this message is a JSON-RPC notification: no reply may be sent.

    Two conditions, and BOTH are required:

      • no `id` MEMBER in the body — JSON-RPC's own definition of a notification
        is "a Request object without an id member". Tested with `not in` rather
        than by truthiness, because `"id": 0` and `"id": null` are present members
        and only one of the three is a notification;
      • a `notifications/`-prefixed method — MCP's naming convention for the whole
        class of them.

    Requiring both keeps two things straight that a single test would confuse. An
    `id` PRESENT on a `notifications/` method makes it a request by JSON-RPC's
    definition, so it is answered like one (`-32601` for a method that is not
    dispatched) instead of being silently accepted; and a malformed body with no
    `id` — a bare `[]`, a string, a number — is not promoted to a notification and
    accepted, which is what an id-only test would have done to precisely the input
    that used to crash this handler.

    ⚠️ THE PREFIX HALF DRAWS A LINE, and what falls on the other side of it is
    stated here rather than left to be discovered. An id-less message on a method
    that is NOT `notifications/`-prefixed — `{"jsonrpc": "2.0", "method": "ping"}` —
    is a notification by JSON-RPC's definition and nothing at all by MCP's, which
    defines no id-less `ping`. This predicate says False for it, deliberately, and
    `lambda_handler` refuses it `-32600` with the `id` member OMITTED rather than
    doing either of the things that look adjacent: it used to be answered with a
    RESULT carrying `id: null`, which replies to a message that gets no reply and
    does it ill-formedly, and accepting it 202 would silently drop an id-less
    `tools/call` that a client is waiting on. The argument in full is at that
    branch; the boundary is recorded here because this is where a reader asks about
    it.
    """
    if not isinstance(body, dict) or 'id' in body:
        return False
    return method.startswith(_NOTIFICATION_METHOD_PREFIX)


def _carries_no_id(body: Any) -> bool:
    """True when the message body carries NO `id` member at all.

    The condition the transport's no-id allowance actually turns on. A refusal's
    envelope omits the `id` when its subject carries none — and that is true of a
    notification AND of an id-less non-notification alike, which is why this is a
    separate predicate from `_is_notification` rather than a call to it.

    It exists because the transport-guard refusal used to ask the narrower
    question: `_is_notification` is deliberately False for an id-less `ping`
    (MCP defines no id-less form of it), so an id-less `ping` that tripped a
    header guard was answered `id: null` — the exact defect the id-less `-32600`
    branch removes, reached one guard earlier. The two branches were disagreeing
    about the same message. Both now ask this predicate, so they cannot.

    `not in` rather than truthiness, for the same reason `_is_notification`
    documents: `"id": 0` and `"id": null` are PRESENT members, and a refusal must
    echo them (`test_a_refused_request_still_carries_its_id` pins the echo).
    A non-dict body answers False — its id is UNDETECTABLE rather than absent,
    and JSON-RPC's own rule spells an undetectable id as `null`, not as omission
    (the distinction `_NO_ID`'s comment records).
    """
    return isinstance(body, dict) and 'id' not in body


def _is_batch(body: Any) -> bool:
    """True when the body is a JSON-RPC BATCH — an array of messages.

    A list is the only shape this can be, and it is a shape only ONE revision ever
    required: 2025-03-26 added batching to the transport and 2025-06-18 removed it
    again. This server implements none of it, which is why that revision is not
    advertised (see `SUPPORTED_PROTOCOL_VERSIONS`).

    An EMPTY list counts, and deliberately: `[]` is not a legal batch under the
    revision that defined them ("one or more"), but it is unambiguously an array
    body, and the answer a caller needs is "this server does not do arrays" rather
    than a count of the elements in the array it should not have sent.
    """
    return isinstance(body, list)


def _is_response(body: Any) -> bool:
    """True when the body is a JSON-RPC RESPONSE rather than a request.

    The transport clause the notification branch is built on has TWO subjects —
    "If the input is a JSON-RPC response or notification" — and only the second
    was recognised. A single response fell through: it is a dict with no `method`,
    so `method` became `''`, `_is_notification` was False (an `id` is present) and
    `_is_batch` was False, and it landed on the unknown-method branch and was
    answered `404 -32601 "Method not found: "`. On every advertised revision that
    404 means the SESSION was terminated and the client MUST re-initialize, which
    is the third route to the same defect the notification and batch branches each
    closed.

    Three conditions, and each excludes something:

      • a dict — an ARRAY of responses is a batch, and `_is_batch` runs first and
        refuses it naming batching. Two shapes, two answers, decided by the shape
        rather than by what is inside it;
      • NO `method` member — a body carrying both `method` and `result` is a
        request that also happens to have a `result` key, and it stays a request.
        A predicate that ignored `method` would swallow one;
      • a `result` or an `error` member — JSON-RPC's own definition of a response,
        and it is what separates a response from the malformed bodies
        (`{"jsonrpc": "2.0"}`, `{"id": 1}`) that must keep their -32601.

    Reachable in practice rather than theoretical: a response is what a client
    sends after the SERVER has issued a request to it (sampling, elicitation,
    `roots/list`). This server issues none, so no correct client sends one — but a
    client with a shared outbound queue, or a misconfigured proxy, sends one to the
    wrong endpoint, and the answer must not instruct it to tear down a working
    session.
    """
    if not isinstance(body, dict) or 'method' in body:
        return False
    return 'result' in body or 'error' in body


@tracer.capture_method
def _handle_autoseed(event: dict) -> dict:
    """Handle GET /mcp/autoseed/{project_id} with Bearer token auth.

    The project_id comes from the URL path (injected into pathParameters by the
    router). It no longer has to be echoed into an X-Project-Id header: the
    credential resolves on its own, so the path is simply the project being
    asked for, and the token's reach decides whether that is allowed.
    """
    path_params = event.get('pathParameters', {}) or {}
    project_id = path_params.get('project_id', '')

    try:
        token_info = _authenticate(event)
    except AuthBackendUnavailable:
        # A server-side fault in the token store, not a bad credential.
        return _cors_response(
            {'message': 'Token store unavailable'}, status_code=500
        )
    if not token_info:
        return _cors_response({'message': 'Unauthorized'}, status_code=401)

    # Autoseed hands back the project's personas and documents, so it is a
    # project-shaped read of exactly the kind get_project performs, and it goes
    # through the same gate — including the scope check, which the old
    # equality-against-the-token's-project test did not perform at all.
    if not _scope_allows(token_info.get('scopes'), SCOPE_PROJECTS_READ):
        return _cors_response(
            {'message': f"Forbidden: token lacks the '{SCOPE_PROJECTS_READ}' scope"},
            status_code=403,
        )
    if not reach_allows(
        read_reach=token_info.get('read_reach') or DEFAULT_READ_REACH,
        token_projects=_token_projects(token_info),
        tool_reach_kind=REACH_KIND_PROJECT,
        project_id=project_id,
    ):
        return _cors_response(
            {'message': 'Forbidden: project is outside this token\'s read reach'},
            status_code=403,
        )

    # Delegated like every tool, and this one is why the projects-table grant
    # could be narrowed to the token partition: autoseed was the last reader of
    # project ARTIFACT rows in this function. The filter arguments are passed
    # through as the route's own query string rather than re-parsed here — the
    # comma-splitting used to be duplicated in both places.
    query_params = event.get('queryStringParameters') or {}
    # ONE try around both steps, because both can raise both kinds. Building the
    # call can fail on a malformed path parameter (400 — the credential is fine
    # and the path is not) OR on a missing reserved-segment declaration, which is
    # a server fault and belongs with the delegation failure below. Two separate
    # try blocks let the second kind escape from the first step to the outer
    # catch-all, answering something other than the 502 this route establishes.
    try:
        call = _domain_call('project_autoseed', path_parameters={'project_id': project_id}, query={
            'persona_ids': query_params.get('persona_ids'),
            'document_ids': query_params.get('document_ids'),
        })
        result = call_domain(call, claims=synthetic_claims(token_info))
    except InvalidToolArgument as exc:
        return _cors_response({'message': str(exc)}, status_code=400)
    except DelegationUnavailable:
        logger.error('Autoseed delegation failed', extra={'project_id': project_id})
        return _cors_response({'message': 'Upstream service unavailable'}, status_code=502)
    # The route's own status travels with its body: a 404 for an unknown project
    # stays a 404 here instead of becoming the 500 this used to answer for it.
    #
    # An empty upstream body becomes `{}` rather than `null`: this route's clients
    # read fields off the response, and `null` makes that a TypeError where `{}`
    # makes it a missing key.
    return _cors_response(result.payload if result.payload is not None else {},
                          status_code=result.status_code)


# ============================================
# Lambda handler
# ============================================

@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    """MCP server Lambda handler — JSON-RPC over HTTP POST + autoseed GET."""

    # DNS-rebinding guard, FIRST — before auth, before method dispatch, and
    # including OPTIONS. The MCP transport spec requires 403 for a present,
    # invalid Origin; checking before _authenticate also means a rebound page
    # cannot use a victim's browser to probe the token store at all.
    #
    # `_NO_ID`, not `None`: this guard runs before the body is even parsed, so the
    # message being refused may well be a notification — and the transport's own
    # wording for this refusal is that the body "MAY comprise a JSON-RPC error
    # response that has no `id`". Sending `id: null` handed a correlating client an
    # entry matching no request it made, for a message that may have carried no id
    # in the first place.
    if not _origin_allowed(event):
        return _cors_response(
            _jsonrpc_error(_NO_ID, -32600, "Forbidden: invalid Origin"),
            status_code=403,
        )

    # Handle CORS preflight
    http_method = event.get('httpMethod', '')
    if http_method == 'OPTIONS':
        return _cors_response({})

    # Handle GET /mcp/autoseed/{project_id} (public, token auth)
    path = event.get('path', '')
    # Path from API Gateway includes stage: /v1/mcp/autoseed/{project_id}
    # Strip leading /v1 or any stage prefix, then match
    autoseed_match = re.match(r'(?:/[^/]+)?/mcp/autoseed/([^/]+)$', path)
    if http_method == 'GET' and autoseed_match:
        # Inject project_id into pathParameters for _handle_autoseed
        if 'pathParameters' not in event or event['pathParameters'] is None:
            event['pathParameters'] = {}
        event['pathParameters']['project_id'] = autoseed_match.group(1)
        return _handle_autoseed(event)

    # GET and DELETE are the two the Streamable HTTP transport defines and this
    # server does not implement — GET opens an SSE stream, DELETE terminates a
    # session — so they get 405 with an `Allow` header (attached in
    # `_cors_response`) naming what IS allowed, which is what tells a client to
    # stop trying rather than to retry differently. Everything else that is not
    # POST lands here too, for the same reason and with the same answer.
    #
    # The allowed set is the one belonging to the RESOURCE being refused, not to
    # this Lambda: a non-GET verb on the autoseed path is refused with `GET,
    # OPTIONS`, because that is what that path serves. `autoseed_match` has already
    # been evaluated above, so the two answers cannot disagree about which path
    # this is.
    #
    # `_NO_ID`, not `None`: a `GET` or a `DELETE` typically carries no body, so
    # this is not a message whose id could not be detected — it is no JSON-RPC
    # message at all, and `id: null` claimed an undetectable id for a request
    # that never claimed to carry one. Same side of the rule at `_NO_ID` as the
    # Origin 403; the parse error below stays `null`, because there a message WAS
    # claimed and its id is genuinely undetectable.
    if http_method != 'POST':
        return _cors_response(
            _jsonrpc_error(_NO_ID, JSONRPC_INVALID_REQUEST,
                           f"Method not allowed: {http_method or 'unknown'}"),
            status_code=405,
            allow=_ALLOW_AUTOSEED if autoseed_match else _ALLOW_JSONRPC,
        )

    # Parse JSON-RPC request
    try:
        body = json.loads(event.get('body', '{}'))
    except (json.JSONDecodeError, TypeError):
        return _cors_response(
            _jsonrpc_error(None, -32700, "Parse error"),
            status_code=400,
        )

    req_id = body.get('id') if isinstance(body, dict) else None
    method = body.get('method', '') if isinstance(body, dict) else ''
    params = body.get('params', {}) if isinstance(body, dict) else {}

    logger.info(f"MCP request: method={method}, id={req_id}")

    # A BATCH — an array body — is refused here, naming batching, rather than left
    # to fall through the dispatch.
    #
    # It used to fall through: `body.get(...) if isinstance(body, dict)` made
    # `method` the empty string, and a legal 2025-03-26 batch landed on the
    # unknown-method branch and was answered `404 -32601 "Method not found: "`. Three
    # things were wrong with that and only one of them was the code. The 404 means
    # "the session was terminated, re-initialize" on the revisions this server
    # advertises, so a client batching its `initialized` notification was told to
    # tear down a working session — and re-initializing got it there again. And an
    # empty method name in the message told a caller nothing about what it had
    # actually done wrong.
    #
    # `-32600 Invalid Request`, not `-32601`: the fault is the SHAPE of the request,
    # not a method that is missing — there is no method here to be found. The
    # message names batching so the caller learns the actual constraint, and the
    # `data` payload carries the machine-readable version of it.
    #
    # The honest fix upstream is that 2025-03-26 is no longer advertised (see
    # `SUPPORTED_PROTOCOL_VERSIONS`), so no client is told this server accepts a
    # shape it refuses. This branch is what makes the refusal legible to a client
    # that sends one anyway.
    #
    # Before the transport-header guards, and that ordering is deliberate: a batch
    # has no single `method` for `Mcp-Method` to be compared against, so validating
    # the routing echoes first would report a header/body mismatch against `''` —
    # an answer about a header, for a request whose whole shape this server does not
    # accept. The batch refusal still buys no probe of the token store, which is the
    # property the guard ordering exists for.
    if _is_batch(body):
        logger.info("MCP batch body refused: this server accepts one message per POST")
        return _cors_response(
            _jsonrpc_error(
                None, JSONRPC_INVALID_REQUEST,
                'Batched requests are not supported: send one JSON-RPC message per '
                'POST. Batching is defined only by protocol revision 2025-03-26, '
                'which this server does not advertise.',
                data={
                    "supported": list(SUPPORTED_PROTOCOL_VERSIONS),
                    "batchingSupported": False,
                },
            ),
            status_code=400,
        )

    # A posted JSON-RPC RESPONSE is accepted 202 with no body, exactly as a
    # notification is — and for the same reason, from the same clause. The transport
    # rule the notification branch quotes has two subjects: "If the input is a
    # JSON-RPC response or notification: If the server accepts the input, the server
    # MUST return HTTP status code 202 Accepted with no body." Only the second was
    # recognised.
    #
    # A single response fell through to the unknown-method branch — it is a dict with
    # no `method`, so `method` became `''` — and was answered
    # `404 -32601 "Method not found: "`. That is the third route to the defect the
    # notification and the batch branches each closed: on every advertised revision a
    # 404 on this endpoint means the SESSION was terminated and the client MUST
    # re-initialize, so a stray response tore down a working session, and the empty
    # method name in the message told the caller nothing about what it had sent.
    #
    # ACCEPTED rather than refused, and the clause makes accepting the honest answer
    # here in a way it does not for a batch. A batch is a body grammar this server
    # does not implement, so refusing names a real constraint the caller can act on.
    # A response is a message this server has NOTHING TO DO WITH: it issues no
    # requests to clients (no sampling, no elicitation, no `roots/list`), so it holds
    # no outstanding request to correlate one against, and "accept and ignore" is
    # precisely what a server with no such requests outstanding does. Refusing would
    # report a failure to a sender that, like a notification's, is not listening for
    # one.
    #
    # Before the transport-header guards, for the reason the batch branch is: a
    # response carries no `method` for `Mcp-Method` to be compared against, so
    # validating the routing echoes first reported a header/body mismatch against
    # `''` — an answer about a header, for a message that is not a request at all. It
    # buys no probe of the token store either.
    if _is_response(body):
        logger.info("MCP response body accepted and ignored: this server issues no requests")
        return _accepted_no_content()

    # Transport-header validation, BEFORE dispatch and before authentication.
    #
    # Before dispatch because a request whose transport and body disagree has not
    # said what it wants, so there is nothing to dispatch to; before
    # authentication for the same reason `_origin_allowed` is — a malformed
    # request should not buy a probe of the token store.
    #
    # The METHOD is passed to the version check because the PRE-HANDSHAKE methods
    # are exempt from the refusal: a current-generation client MUST send its own
    # revision in the header on its very first request and has no negotiated value
    # to send instead, so refusing there made `_handle_initialize`'s counter-offer
    # unreachable for exactly the clients it exists for — and made
    # `server/discover`, a method only a 2026-07-28 client knows, unreachable by any
    # client obeying that revision's header rule. Every other method keeps the
    # refusal. The reasoning is at `_PRE_HANDSHAKE_METHODS`.
    try:
        _validated_protocol_version(event, method)
        _validate_routing_headers(event, method, params)
    except InvalidTransportHeader as exc:
        # The code, the `data` payload and the status all come from the exception
        # rather than being decided here: the spec pins a different code per fault
        # (-32022 with the supported-version list, -32020 for a header/body
        # disagreement), and a single generic code at this one catch site is how the
        # first draft of this change lost both the client's recovery path and the
        # era-detection signal.
        #
        # ⚠️ WHETHER THE BODY CARRIES AN ID is consulted here even though this runs
        # before the notification branch, and it has to be: a message that fails a
        # guard still carries (or does not carry) whatever id it carried, and this
        # refusal was the last place `id: null` was sent to a message that carries
        # no id. The advertised revisions say a notification the server cannot
        # accept gets an HTTP error status whose body "MAY comprise a JSON-RPC
        # error response that has NO id" — so the STATUS and the code stay exactly
        # as they were and only the envelope changes.
        #
        # `_carries_no_id`, NOT `_is_notification`: the condition the transport's
        # allowance turns on is "the subject carries no id", and an id-less `ping`
        # is exactly as id-less as a notification. Asking the narrower question
        # here answered `id: null` to an id-less non-notification that tripped a
        # header guard — the defect the id-less `-32600` branch below removes,
        # reached one guard earlier — so the two branches disagreed about the same
        # message. `test_an_idless_request_refused_by_a_transport_guard_omits_the_id`
        # fails if `_is_notification` comes back;
        # `test_a_refused_request_still_carries_its_id` fails if the id stops
        # being echoed for a body that has one. This branch is not the
        # notification's acceptance path (that is the 202 below, and it is
        # deliberately still after the guards); it is the refusal path learning
        # what it is refusing.
        return _cors_response(
            _jsonrpc_error(
                _NO_ID if _carries_no_id(body) else req_id,
                exc.code, str(exc), exc.data,
            ),
            status_code=exc.status_code,
        )

    # A NOTIFICATION is answered 202 with no body and nothing else — before the
    # dispatch tables are consulted, because the answer is the same whether or not
    # this server implements the notification in question.
    #
    # Every advertised revision states it as a MUST: "If the input is a JSON-RPC
    # response or notification: If the server accepts the input, the server MUST
    # return HTTP status code 202 Accepted with no body." Two defects lived here:
    #
    #   • `notifications/initialized` was answered with a 200 and a full JSON-RPC
    #     result carrying `id: null` — a reply to a message that gets no reply, and
    #     an ill-formed one, since a result's id must not be null;
    #   • every OTHER notification fell through to the unknown-method branch and
    #     was answered `404`. On this endpoint a 404 has a specific meaning in the
    #     advertised revisions — the session was terminated, and a client receiving
    #     one "MUST start a new session by sending a new InitializeRequest". So a
    #     client sending `notifications/cancelled`, which is the transport's own
    #     cancellation mechanism, was told by the revision it negotiated to tear
    #     down its session and re-initialize. The 404-for-an-unknown-method rule is
    #     2026-07-28's, and that revision is deliberately not advertised here.
    #
    # ACCEPTED rather than refused, for the notifications this server does not
    # implement as much as for the one it does: a notification carries no
    # obligation to act, so accepting and ignoring one is what a server with no
    # cancellation semantics honestly does. Refusing would report a failure to a
    # sender that is not listening for one.
    if _is_notification(body, method):
        logger.info(f"MCP notification accepted: method={method}")
        return _accepted_no_content()

    # An ID-LESS message on a method that is NOT a notification is refused, with the
    # `id` member OMITTED — and this is the last place a result carrying `id: null`
    # was sent to a message that carries no id.
    #
    # ⚠️ Why it is not accepted 202 like a notification, and not answered like a
    # request either. By JSON-RPC's own definition ("a Request object without an id
    # member") this IS a notification, so a reply is forbidden; by MCP's, it is
    # nothing at all, because MCP defines no id-less `ping` or `initialize`. Those
    # two readings disagree, and the answer has to satisfy both:
    #
    #   • a RESULT is wrong under both. `{"id": null, "result": …}` — which is what
    #     an id-less `ping`, `initialize` and `server/discover` used to get — replies
    #     to a message JSON-RPC says gets no reply, and does it with an envelope
    #     whose id must not be null. Exactly the pair of faults the 202 fix removed
    #     from the notification path and the `_NO_ID` fix removed from the refusals;
    #   • a 202 would be wrong too, and this is the half that decides it. 202 says
    #     "accepted", and `_accepted_no_content` is reserved for a message this
    #     server can honestly accept and drop. An id-less `tools/call` is a request
    #     a client is WAITING on (which is why
    #     test_a_non_notification_method_without_an_id_is_not_accepted pins it), and
    #     answering silence to a caller expecting a result is the worse failure. The
    #     shape cannot be decided per method without inventing an id-less variant of
    #     each.
    #
    # So: `-32600 Invalid Request`, the code for a message that is not a well-formed
    # request, with NO `id` — the transport's own allowance for a refusal whose
    # subject carries none, and the same envelope a refused notification now gets.
    # A client that meant a notification is not replied to in any way it correlates;
    # a client that forgot an id learns the request was not served.
    #
    # Placed after the notification branch and before the dispatch, so a real
    # notification still reaches its 202 and no handler is ever called without an id.
    if _carries_no_id(body):
        logger.info(f"MCP id-less non-notification refused: method={method}")
        return _cors_response(
            _jsonrpc_error(
                _NO_ID, JSONRPC_INVALID_REQUEST,
                f'A request must carry an id: {method!r} is not a notification, and '
                f'this server defines no id-less form of it. Send an id, or send one '
                f'of the notifications/* methods.',
            ),
            status_code=400,
        )

    # Handle the methods that need no credential (initialize, ping,
    # server/discover).
    if method in MCP_METHODS:
        # A PRESENTED credential is checked on the methods a client uses to decide
        # it is CONNECTED, and this is the honesty fix this envelope owes: a revoked
        # or expired token used to complete the whole handshake and fail only at the
        # first `tools/call`, so a dead credential presented as a connected server
        # and whoever was debugging went looking at the tools. An ABSENT credential
        # still passes — a client is entitled to ask what this server is before
        # deciding what to present — so this refuses only a credential that was
        # offered and does not work. The method is passed because the check is
        # scoped: `ping` and the notifications are out (see the constant).
        refusal = _refuse_a_dead_credential(event, req_id, method)
        if refusal is not None:
            return refusal
        handler = MCP_METHODS[method]
        if handler is None:
            # A `None` handler is a method that produces no result, which is only
            # ever a notification — and one carrying an `id` reached here rather
            # than the 202 above, so it is a REQUEST naming a notification method.
            # JSON-RPC says the id makes it a request, and this server implements
            # no request by that name, so it gets the request answer.
            return _cors_response(
                _jsonrpc_error(req_id, JSONRPC_METHOD_NOT_FOUND,
                               f"Method not found: {method} is a notification and "
                               f"takes no id"),
                status_code=404,
            )
        return _cors_response(handler(req_id, params))

    # All other methods require authentication
    if method in MCP_AUTH_METHODS:
        try:
            token_info = _authenticate(event)
        except AuthBackendUnavailable:
            # The token store could not be consulted because of a server-side
            # fault (missing table, AccessDenied, …).  Answering 401 here would
            # send operators to re-mint tokens for a configuration problem, so
            # report it honestly as an internal error instead.
            return _cors_response(
                _jsonrpc_error(req_id, -32603, "Internal error: token store unavailable"),
                status_code=500,
            )
        if not token_info:
            return _cors_response(
                _jsonrpc_error(req_id, -32001, "Unauthorized: invalid or missing API token"),
                status_code=401,
            )

        # Uniform arity across both authenticated methods: `tools/list` now needs
        # the credential too, because the catalogue it publishes is filtered by it.
        # The per-method branch this replaces was how a handler could be given the
        # wrong arguments without anything saying so.
        return _cors_response(MCP_AUTH_METHODS[method](req_id, params, token_info))

    # An unknown REQUEST is JSON-RPC's own -32601, and nothing else: a client
    # probing for a method this server might have needs to be able to tell
    # "no such method here" from a refusal it could fix. `server/discover` exists
    # so the probe is unnecessary in the first place.
    #
    # Only a request reaches here. A notification was answered 202 above, which is
    # the distinction this branch used to miss: `notifications/cancelled` and its
    # siblings are not dispatched by this server, so they landed here and were told
    # 404 — see that comment for why that is worse than untidy.
    #
    # HTTP 404 alongside the code, which the Streamable HTTP transport REQUIRES and
    # which is not merely decorative: it is what a dual-era client's fallback probe
    # reads, and the JSON-RPC body is what distinguishes this 404 from the 404 of a
    # legacy HTTP+SSE server that does not host the modern endpoint at all.
    # Answering 200 — as this did — left the status saying "your request was fine"
    # about a method that does not exist, while the 405 path in this same module
    # already set a status for the same class of "this server does not do that".
    #
    # ⚠️ The 404 is OVERLOADED on this endpoint, and the overload is why it is
    # confined to requests. The dedicated 404-for-an-unknown-method rule is
    # 2026-07-28's; in the revisions this server actually advertises, a 404 on the
    # MCP endpoint means the SESSION was terminated and a client receiving one
    # "MUST start a new session by sending a new InitializeRequest". A client that
    # asked for a method this server does not implement re-initializing is a wasted
    # round trip and no worse — it re-establishes a session that still works and
    # the method is still absent. A client whose CANCELLATION was answered that way
    # tore down a live session over routine traffic, which is why notifications
    # never reach this line.
    return _cors_response(
        _jsonrpc_error(req_id, JSONRPC_METHOD_NOT_FOUND, f"Method not found: {method}"),
        status_code=404,
    )


# The unauthenticated methods where a dead credential must be reported, and the
# rule is "which method does a client use to decide it is CONNECTED":
#
#   • `initialize` — the handshake. A client that completes it believes it has a
#     working session.
#   • `server/discover` — the same decision without the handshake, for a client
#     that starts here.
#
# `ping` and the notifications are deliberately NOT here. Two reasons, and the
# second is the stronger one:
#
#   • Cost. `ping` is a keepalive, so checking it put a DynamoDB Query (and, before
#     `touch=False`, an UpdateItem) on every heartbeat of every session — on a route
#     throttled at 20 rps whose authorizer caches for 300 s, so a single valid-shaped
#     token could drive that stream straight past the cache. `ping` previously
#     touched nothing.
#   • A NOTIFICATION CARRIES NO ID. JSON-RPC says a notification gets no response at
#     all, so answering one with a 401 replies to a message that must not be replied
#     to. The honesty defect was never about notifications anyway: nobody concludes
#     "connected" from an un-refused notification. This is now structural rather
#     than a matter of this set's contents — a notification is answered 202 before
#     the dispatch is reached, so it cannot arrive here — and the entry stays out
#     for the same reason it was never in.
_LIVENESS_CHECKED_METHODS: frozenset[str] = frozenset({
    'initialize',
    'server/discover',
})


def _refuse_a_dead_credential(event: dict, req_id: Any, method: str) -> dict | None:
    """401 when a credential was presented and does not authenticate, else None.

    🔑 The honesty defect this closes: `initialize` needs no credential, so a
    revoked or expired token completed the handshake, `tools/list` answered, and
    the first `tools/call` was the first refusal. A client shows that as a
    connected server with failing tools, which sends whoever is debugging at the
    tools, at the scopes, at the routes — anywhere but the credential.

    Scoped to `_LIVENESS_CHECKED_METHODS` — the methods a client uses to decide it
    is connected — rather than to every unauthenticated method. See that constant
    for why `ping` and the notifications are out.

    Only a PRESENTED credential is checked. No `Authorization` header is not a
    dead credential, it is no credential, and an unauthenticated `initialize` or
    `server/discover` is exactly how a client learns what to present.

    A backend fault is a 500 here as it is on the authenticated path: reporting
    "your token is invalid" for a table nobody could read sends an operator to
    re-mint a credential that was never compared.
    """
    if method not in _LIVENESS_CHECKED_METHODS:
        return None

    # Case-insensitive, via the same helper the transport headers use: a spelling
    # this failed to match would read as "no credential presented" and skip the
    # check entirely, which is the one way this guard can silently not run.
    #
    # A DUPLICATED `Authorization` is a credential that was presented and cannot be
    # used, so it belongs on the refusing side of this branch rather than on the
    # "nothing was presented" side. Falling through to `_authenticate` would reach
    # the same 401, but only after this function had decided the caller presented
    # nothing — and the raise would escape here, outside the transport-header catch,
    # as a 502 with no JSON-RPC envelope.
    try:
        auth_header = _request_header(event, 'authorization') or ''
    except InvalidTransportHeader:
        auth_header = ''
        presented = True
    else:
        presented = auth_header.startswith('Bearer ')
    if not presented:
        return None

    try:
        # `touch=False`: this is a liveness probe, not a use. Stamping
        # `last_used_at` here would make the field mean "last pinged".
        token_info = _authenticate(event, touch=False)
    except AuthBackendUnavailable:
        return _cors_response(
            _jsonrpc_error(req_id, -32603, "Internal error: token store unavailable"),
            status_code=500,
        )
    if token_info:
        return None
    logger.info("Credential presented on an unauthenticated method does not authenticate")
    return _cors_response(
        _jsonrpc_error(
            req_id, -32001,
            "Unauthorized: the presented API token is invalid, revoked or expired",
        ),
        status_code=401,
    )
