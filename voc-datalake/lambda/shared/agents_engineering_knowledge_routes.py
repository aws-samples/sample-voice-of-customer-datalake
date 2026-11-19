"""The knowledge flows' routes (7.52.00; included by ``api/agents_handler.py``): a repository's knowledge pack and its
approval, its tenets and their acceptance, and the pull request of the docs an administrator approved.

    GET  /agents/engineering/knowledge/<connection>                                   -> {connection, packages, rendering}
    GET  /agents/engineering/knowledge/<connection>/<package>/versions/<version>       -> {connection, version, documents}
    POST /agents/engineering/knowledge/<connection>/<package>/versions/<version>/approve {}
                                                                                      -> {connection, version, rendering_digest,
                                                                                          rendering}
    GET  /agents/engineering/tenets/<connection>                                      -> {connection, head, versions}
    GET  /agents/engineering/tenets/<connection>/versions/<version>                    -> {connection, version, log}
    POST /agents/engineering/tenets/<connection>/versions/<version>/accept {expected_accepted, reason?}
                                                                                      -> {connection, version, log}
    POST /agents/engineering/tenets/<connection>/versions/<version>/reject {expected_accepted, reason?}
                                                                                      -> {connection, version, log}
    GET  /agents/engineering/docs/<connection>/preview?kind=knowledge|tenets            -> {kind, version, branch, files,
                                                                                          digest, approved_digest, matches,
                                                                                          patch, patch_truncated,
                                                                                          texts_truncated}
    POST /agents/engineering/docs/<connection>/publish {kind, digest, pr?}              -> 202 {pr: {url, number, branch},
                                                                                          kind, version, digest, draft}

``<package>`` is the package path in the workspace layout's encoding (``workspace/layout.py`` ``encode_package``: the
root ``.`` is ``=2E``, ``packages/web`` is ``packages=2Fweb``). Approving a package's version records the docs it
renders with it (``knowledge/docs.py``: the rendering's digest on the version, and the connection's next rendering);
accepting a tenets version records its ``TENETS.md`` digest and the ids a triage may cite (``knowledge/tenets.py``).
Every version and decision stays (D1), with who and when (D4).

The publish asks voc-engineering-start's ``publish_docs`` (``runtime/docs_publish.py``), which asks the broker's
``push_approved_docs``: it renders the approved version again and holds the request's digest and the approval's to it,
writes ``docs/agents/**`` or ``TENETS.md`` only, on ``voc-agent/docs/<kind>-v<n>``, and opens the pull request ready
for review or as a draft (``pr``, else the flow's own setting: Understand the repository's for the knowledge, Tenets'
for the tenets). The requesting administrator's stored way of working applies, failing closed: Human-driven is 409
``human_driven`` (the preview's ``patch`` is theirs to apply); a version published before is 409 ``already_published``
with its pull request; another digest than the approval's is 409 ``digest_mismatch``. Merging is a person's, on the
host.

Administrators only, acting for themselves (403 for anyone else, a delegated credential included); 404 while the
engineering agents are off, as every ``/agents/engineering/*`` route; 503 when a store cannot be read or written. The
deployment's, like the agents (phase 3 of docs/multi-workspace.md). Kept in ``shared/`` because an API bundle ships
``api/<handler>.py`` and ``shared/`` only (api/test/test_api_bundle_imports.py); the engineering modules are imported
where they are used, since they ship only with the engineering agents on.
"""
from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from typing import Any, Final

from aws_lambda_powertools.event_handler import Response
from aws_lambda_powertools.event_handler.api_gateway import Router
from botocore.exceptions import BotoCoreError, ClientError

from shared.agents_store import get_agents_table
from shared.engineering_agent_runs import start_client as _start_client
from shared.engineering_agents import engineering_client_and_table as _client_and_table
from shared.engineering_agents import require_engineering_on
from shared.exceptions import (
    AuthorizationError,
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationError,
)
from shared.logging import logger, tracer
from shared.project_access import Caller
from shared.project_gate import caller_from_event, require_admin_caller
from shared.request_body import json_object_body
from shared.route_answers import json_response as _json

__all__ = ['app']

#: The engineering agents' one workspace (engineering/connectors/identity.py ``WORKSPACE``).
WS: Final = 'default'
#: The flow whose ``pr`` setting a kind's pull request follows when the request names none.
FLOW_OF_KIND: Final = {'knowledge': 'understand-repository', 'tenets': 'tenets'}
MAX_REASON: Final = 500
#: The largest patch a preview answers, less its files' texts (the rest is cut, ``patch_truncated``): under the
#: function's 6 MB answer. The texts take at most ``MAX_TEXT_BYTES`` of it (a file past it has no text:
#: ``texts_truncated``).
MAX_PATCH_BYTES: Final = 4_000_000
MAX_TEXT_BYTES: Final = 2_000_000
#: The most versions a tenets listing answers (newest first).
MAX_LISTED: Final = 100
#: The most rows of a connection's knowledge packs an overview reads (counters and versions together).
MAX_PACK_ROWS: Final = 5_000
NOT_SAVED: Final = 'the decision could not be saved: read it again and retry'
_STATUSES: Final = {'invalid': ValidationError, 'not_found': NotFoundError, 'forbidden': AuthorizationError,
                    'conflict': ConflictError, 'unavailable': ServiceUnavailableError}

app = Router()


def _admin() -> Caller:
    """404 while the engineering agents are off, then 403 for anyone but an administrator acting for themselves."""
    require_engineering_on()
    caller = caller_from_event(app.current_event.raw_event)
    require_admin_caller(caller)
    return caller


def _query(name: str) -> str:
    value = (app.current_event.query_string_parameters or {}).get(name)
    return value if isinstance(value, str) else ''


def _connection(connection_id: str) -> str:
    from engineering.workspace.layout import CONNECTION
    if not CONNECTION.fullmatch(connection_id):
        raise NotFoundError('no such connection')
    return connection_id


def _package(segment: str) -> str:
    from urllib.parse import unquote

    from engineering.workspace.layout import LayoutError, decode_package
    try:   # (a client may send the segment's '=' as %3D)
        return decode_package(unquote(segment))
    except LayoutError:
        raise NotFoundError('no such package: name it in the workspace layout\'s encoding (the root is =2E)') from None


def _version(version: str) -> int:
    from engineering.skills.views import VERSION_NUMBER
    if not VERSION_NUMBER.fullmatch(version):
        raise NotFoundError('no such version')
    return int(version)


def _kind(kind: object) -> str:
    from engineering.knowledge.render_docs import KINDS
    if kind not in KINDS:
        raise ValidationError('kind is knowledge or tenets')
    return str(kind)


def _call[T](call: Callable[[], T], failed: str = 'the knowledge store could not be read: retry') -> T:
    """``call()``, the stores' refusals answered with their status and a failed call with 503 (``failed``)."""
    from engineering.knowledge.store import PackError
    from engineering.workspace.layout import LayoutError
    try:
        return call()
    except PackError as refused:
        raise _STATUSES.get(refused.kind, ValidationError)(str(refused)[:500]) from None
    except LayoutError as refused:
        raise ValidationError(str(refused)[:500]) from None
    except (ClientError, BotoCoreError) as exc:
        logger.exception('engineering: a knowledge store call failed')
        raise ServiceUnavailableError(failed) from exc


def _packs() -> Any:
    """The knowledge store on this role's clients (no ListBucket: a missing object reads as denied, taken as
    missing)."""
    from engineering.knowledge.store import PackStore
    from engineering.workspace.store import WorkspaceStore
    from shared.aws import get_s3_client
    client, table = _client_and_table()
    return PackStore(client, table, WorkspaceStore(get_s3_client(), os.environ.get('ENGINEERING_WORKSPACE_BUCKET', ''),
                                                   denied_is_missing=True))


def _tenets() -> Any:
    from engineering.knowledge.tenets import TenetsStore
    return TenetsStore(*_client_and_table())


def _approved_docs() -> Any:
    from engineering.knowledge.docs import ApprovedDocs, KnowledgeDocs
    return ApprovedDocs(KnowledgeDocs(_packs()), _tenets())


def _person(caller: Caller) -> Any:
    from engineering.knowledge.store import Actor
    return Actor(caller.subject, 'person', admin=True)


def _reason(body: Mapping[str, Any]) -> str:
    if set(body) - {'reason'}:
        raise ValidationError('the body is {reason?}')
    reason = body.get('reason', '')
    if not isinstance(reason, str) or len(reason) > MAX_REASON:
        raise ValidationError(f'reason is text of at most {MAX_REASON} characters')
    return reason


def _decision(body: Mapping[str, Any]) -> tuple[str, int]:
    """A tenets decision's body (7.52.00's integration): ``{expected_accepted, reason?}``, the accepted version the
    screen showed (0 for none) and the person's reason."""
    if set(body) - {'reason', 'expected_accepted'}:
        raise ValidationError('the body is {expected_accepted, reason?}')
    expected = body.get('expected_accepted')
    if isinstance(expected, bool) or not isinstance(expected, int) or expected < 0:
        raise ValidationError('expected_accepted is the accepted version the screen showed (0 for none)')
    return _reason({'reason': body.get('reason', '')}), expected


# --- the knowledge pack ---------------------------------------------------------------------------------------------


def pack_overview(client: Any, table: str, connection: str) -> list[dict[str, Any]]:
    """Each package of the connection with a pack: its approved version, its versions (oldest first, summaries)."""
    from engineering.knowledge.store import PackVersion, repo_pk
    from engineering.rows import partition_rows
    from engineering.workspace.layout import encode_package
    rows = partition_rows(client, table, repo_pk(WS, connection), 'KPACK#', max_items=MAX_PACK_ROWS)
    approved = {item['sk']['S'].removeprefix('KPACK#'): int(item.get('approved_version', {}).get('N', '0'))
                for item in rows if item['sk']['S'].count('#') == 1}
    packages: dict[str, dict[str, Any]] = {}
    for item in rows:
        if item['sk']['S'].count('#') != 2:
            continue
        version = PackVersion.from_item(item)
        segment = encode_package(version.package)
        entry = packages.setdefault(version.package, {
            'package': version.package, 'segment': segment, 'approved_version': approved.get(segment) or None,
            'versions': []})
        entry['versions'].append(version.view())
    return sorted(packages.values(), key=lambda entry: (entry['package'] != '.', entry['package']))


@app.get('/agents/engineering/knowledge/<connection_id>')
@tracer.capture_method(capture_response=False)
def get_engineering_knowledge(connection_id: str):
    """The connection's knowledge pack: each package's versions and approved one, and the docs' recorded rendering."""
    _admin()
    connection = _connection(connection_id)
    client, table = _client_and_table()
    from engineering.knowledge.docs import KnowledgeDocs
    packages = _call(lambda: pack_overview(client, table, connection))
    rendering = _call(lambda: KnowledgeDocs(_packs()).recorded(WS, connection))
    return {'connection': connection, 'packages': packages, 'rendering': None if rendering is None else rendering.view()}


@app.get('/agents/engineering/knowledge/<connection_id>/<package>/versions/<version>')
@tracer.capture_method(capture_response=False)
def get_engineering_knowledge_version(connection_id: str, package: str, version: str):
    """One version of a package's pack: its row (who, when, from which commit, its approval) and its seven documents
    as Markdown; 404 for none."""
    _admin()
    connection, path, number = _connection(connection_id), _package(package), _version(version)
    loaded = _call(lambda: _packs().load(WS, connection, path, number))
    return {'connection': connection, 'version': loaded.version.view(), 'documents': dict(loaded.documents),
            'flagged': len(loaded.pack.flagged)}


@app.post('/agents/engineering/knowledge/<connection_id>/<package>/versions/<version>/approve')
@tracer.capture_method(capture_response=False)
def approve_engineering_knowledge_version(connection_id: str, package: str, version: str):
    """``{}``: an administrator approves a draft (``PackStore.approve``, its checks: never a version older than the
    approved one, nor one built on an older one), with the connection's docs as they render with it recorded
    (``rendering_digest``, the rendering's number); approving the approved version again answers it as it is. 409
    when the version or the approved one changed since the screen read them."""
    caller = _admin()
    connection, path, number = _connection(connection_id), _package(package), _version(version)
    if json_object_body(app):
        raise ValidationError('the body is {}')
    from engineering.knowledge.docs import KnowledgeDocs
    approved, rendering = _call(lambda: KnowledgeDocs(_packs()).approve(WS, connection, path, number, _person(caller)),
                                NOT_SAVED)
    logger.info('engineering: a knowledge pack version approved', extra={
        'connection_id': connection, 'version': number, 'rendering': rendering.version if rendering else None})
    return {'connection': connection, 'version': approved.view(), 'rendering_digest': approved.rendering_digest or None,
            'rendering': None if rendering is None else rendering.view()}


# --- the tenets -----------------------------------------------------------------------------------------------------


def _summary(view: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in view.items() if key != 'record'}


@app.get('/agents/engineering/tenets/<connection_id>')
@tracer.capture_method(capture_response=False)
def get_engineering_tenets(connection_id: str):
    """The connection's tenets: the counter (the accepted version, its ids) and the newest versions, summaries."""
    _admin()
    connection = _connection(connection_id)
    store = _tenets()
    head = _call(lambda: store.head(WS, connection))
    versions = _call(lambda: store.versions(WS, connection))
    return {'connection': connection, 'head': head.view(),
            'versions': [_summary(v.view(head.accepted_version)) for v in reversed(versions[-MAX_LISTED:])]}


def _tenets_version(store: Any, connection: str, number: int) -> dict[str, Any]:
    head = store.head(WS, connection)
    return {'connection': connection, 'version': store.version(WS, connection, number).view(head.accepted_version),
            'log': store.log(WS, connection, number)}


@app.get('/agents/engineering/tenets/<connection_id>/versions/<version>')
@tracer.capture_method(capture_response=False)
def get_engineering_tenets_version(connection_id: str, version: str):
    """One tenets version: its record, its status and its events (who drafted, accepted or rejected it, when)."""
    _admin()
    connection, number = _connection(connection_id), _version(version)
    store = _tenets()
    return _call(lambda: _tenets_version(store, connection, number))



def _decided(connection_id: str, version: str, *, accept: bool) -> dict[str, Any]:
    """An administrator's decision on a tenets version (``TenetsStore.accept`` or ``.reject``, its body
    ``{expected_accepted, reason?}``), then the version as it stands."""
    caller = _admin()
    connection, number = _connection(connection_id), _version(version)
    reason, expected = _decision(json_object_body(app))
    store = _tenets()
    decide = store.accept if accept else store.reject
    _call(lambda: decide(WS, connection, number, _person(caller), reason, expected_accepted=expected), NOT_SAVED)
    logger.info(f'engineering: a tenets version {"accepted" if accept else "rejected"}',
                extra={'connection_id': connection, 'version': number})
    return _call(lambda: _tenets_version(store, connection, number))

@app.post('/agents/engineering/tenets/<connection_id>/versions/<version>/accept')
@tracer.capture_method(capture_response=False)
def accept_engineering_tenets_version(connection_id: str, version: str):
    """``{expected_accepted, reason?}``: an administrator accepts a draft (``TenetsStore.accept``): its TENETS.md
    digest and its ids recorded, the accepted version moved up (never down); accepting the accepted version again
    answers it. 409 when the accepted version is no longer ``expected_accepted`` (the draft was read against another)."""
    return _decided(connection_id, version, accept=True)


@app.post('/agents/engineering/tenets/<connection_id>/versions/<version>/reject')
@tracer.capture_method(capture_response=False)
def reject_engineering_tenets_version(connection_id: str, version: str):
    """``{expected_accepted, reason?}``: an administrator rejects a draft; it stays, marked rejected, with its event.
    409 when the accepted version is no longer ``expected_accepted``."""
    return _decided(connection_id, version, accept=False)


# --- the docs pull request ------------------------------------------------------------------------------------------


@app.get('/agents/engineering/docs/<connection_id>/preview')
@tracer.capture_method(capture_response=False)
def preview_engineering_docs(connection_id: str):
    """``?kind=knowledge|tenets``: the files the approved docs render to now (path, sha256, bytes and, since 7.52.00's
    integration, text), their digest and the approval's, and a patch adding them (what a Human-driven administrator
    applies); 404 when nothing of the kind is approved yet."""
    _admin()
    connection, kind = _connection(connection_id), _kind(_query('kind'))
    from engineering.connectors.write_policy import docs_branch
    from engineering.knowledge.render_docs import patch
    approved = _call(lambda: _approved_docs().approved(WS, connection, kind))
    if approved is None:
        raise NotFoundError(f'no {kind} docs are approved for the connection yet')
    files, used = _preview_files(approved.rendering)
    text, budget = patch(approved.rendering), MAX_PATCH_BYTES - used
    cut = len(text.encode()) > budget
    recorded = approved.recorded
    return {'connection': connection, 'kind': kind, 'version': recorded.version,
            'branch': docs_branch(kind, recorded.version), 'files': files,
            'digest': approved.rendering.digest, 'approved_digest': recorded.digest, 'matches': approved.matches,
            'approved_by': recorded.approved_by or None, 'approved_at': recorded.approved_at or None,
            'patch': text.encode()[:budget].decode(errors='ignore') if cut else text, 'patch_truncated': cut,
            'texts_truncated': any(file['text'] is None for file in files)}


def _preview_files(rendering: Any) -> tuple[list[dict[str, Any]], int]:
    """Each rendered file as the preview lists it, with its text (7.52.00's integration: the web app reads each as a
    document) while the texts fit ``MAX_TEXT_BYTES``, else ``text: None``; and the bytes the texts took, which the
    patch's own bound gives up (the answer stays under the function's 6 MB)."""
    files, used = [], 0
    for rendered in rendering.files:
        fits = used + len(rendered.content) <= MAX_TEXT_BYTES
        used += len(rendered.content) if fits else 0
        files.append({**rendered.view(), 'text': rendered.content.decode('utf-8', errors='replace') if fits else None})
    return files, used


def flow_pr(kind: str) -> str:
    """The ``pr`` setting of the flow a kind's pull request follows (the bundle's; ``ready`` when it names none)."""
    from shared import engineering_templates
    flow = next((item for item in engineering_templates.bundle()['flows']
                 if item.get('template_id') == FLOW_OF_KIND[kind]), {})
    return 'draft' if flow.get('pr') == 'draft' else 'ready'


def _publish_body(body: Mapping[str, Any]) -> tuple[str, str, str]:
    if set(body) - {'kind', 'digest', 'pr'} or 'kind' not in body or 'digest' not in body:
        raise ValidationError('the body is {kind: knowledge | tenets, digest: <the preview\'s digest>, '
                              'pr?: ready | draft}')
    from engineering.knowledge.render_docs import DIGEST
    from shared.workflow_engineering import PR_STATES
    kind, digest, pr = _kind(body['kind']), body['digest'], body.get('pr')
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        raise ValidationError('digest is the preview\'s digest: 64 hexadecimal characters')
    if pr is not None and pr not in PR_STATES:
        raise ValidationError('pr is ready or draft')
    return kind, digest, str(pr or flow_pr(kind))


def _refused(answer: Mapping[str, Any]) -> Response:
    """The broker's refusal: its code's 409 (``human_driven``, ``not_approved``, ``digest_mismatch``), another state or
    write rule's 409, a store or host out of reach 503."""
    reason = str(answer.get('reason') or 'the broker refused the docs')[:500]
    code, status = str(answer.get('code') or ''), answer.get('http_status')
    if code:
        return _json(409, {'error': reason, 'code': code})
    if isinstance(status, int) and 400 <= status < 500:
        return _json(409, {'error': reason, 'code': 'refused'})
    return _json(503, {'error': f'{reason} Publish again to find out whether the pull request was opened.'})


@app.post('/agents/engineering/docs/<connection_id>/publish')
@tracer.capture_method(capture_response=False)
def publish_engineering_docs(connection_id: str):
    """``{kind, digest, pr?}`` → 202 ``{pr: {url, number, branch}, kind, version, digest, draft}``: the approved docs'
    pull request (the module's doc). 409 ``human_driven`` for an administrator whose stored way of working pushes
    nothing (read here first, and by the broker again), ``already_published`` with the pull request a publish of the
    same version opened, ``digest_mismatch``, ``not_approved``; 404 for a connection not stored."""
    caller = _admin()
    connection = _connection(connection_id)
    kind, digest, pr = _publish_body(json_object_body(app))
    from engineering.connectors.dial import PUSHING_MODES, WaysOfWorking
    from engineering.connectors.hosts import Unavailable
    from shared import engineering_agent_runs as eng_runs
    from shared.tables import get_aggregates_table
    row = eng_runs.connection_row(get_agents_table(), connection)
    if row is None:
        raise NotFoundError('no stored connection of that id: add it under Agent orchestration → Connections')
    try:
        mode = WaysOfWorking(get_aggregates_table()).mode(caller.subject)
    except Unavailable as exc:
        raise ServiceUnavailableError('your way of working could not be read: retry') from exc
    if mode not in PUSHING_MODES:
        return _json(409, {'error': 'You work Human-driven: the platform pushes nothing for you. Apply the patch of '
                                    f'GET /agents/engineering/docs/{connection}/preview?kind={kind} yourself, or change '
                                    'your way of working.', 'code': 'human_driven'})
    function = os.environ.get(eng_runs.START_FUNCTION_ENV, '')
    if not function:
        raise ServiceUnavailableError('docs cannot be published from here: the deployment names no start function')
    # (the start function's refusal of the request's shape 409 in its words; a broker out of reach, or any other
    # failure, 503: publishing again is safe, once per version)
    answer = eng_runs.ask_start(_start_client(), function, {
        'action': 'publish_docs', 'connection': connection, 'repository': str(row.get('repository', '')),
        'default_branch': str(row.get('default_branch', '')), 'kind': kind, 'digest': digest, 'draft': pr == 'draft',
        'actor': caller.subject}, answers=frozenset({'opened', 'repeated', 'refused'}),
        failed='the docs could not be published',
        again='publish again to find out whether the pull request was opened')
    if answer['status'] == 'refused':
        return _refused(answer)
    published = {'pr': answer.get('pr'), 'kind': kind, 'version': answer.get('version'), 'digest': digest,
                 'draft': answer.get('draft') is True}
    if answer['status'] == 'repeated':
        return _json(409, {'error': 'This version of the docs has its pull request already: a new approved version '
                                    'opens a new one.', 'code': 'already_published', **published})
    logger.info('engineering: approved docs published', extra={'connection_id': connection, 'kind': kind,
                                                               'version': answer.get('version')})
    return _json(202, published)
