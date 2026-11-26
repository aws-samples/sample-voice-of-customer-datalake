"""voc-retention: an erasure by email reaches the addresses in a workspace's projects (7.43.00, projects 3g-b) and in
the deployment's own (7.48.00, 3g-d; TENETS.md D5; docs/multi-workspace.md, the project plan's 3g).

Where a workspace's projects hold an address or a name that can be one (written since 7.37.00; no route writes them
in a workspace until the switch, 3h), ``ERASED_FIELDS`` lists each, and a test holds it to every such field the
workspace export carries (jobs/workspace_export/projects.py, project_fields.py), so the two cannot drift:

- a comment thread (``WS#{ws}#DCOMMENTS#{project}#{series}`` / ``C#…``): its ``author`` and each reply's ``author``
  (a review-link reviewer's: ``email``, its ``email_digest`` and a ``name``, before 7.43.00 the address itself when
  they gave none, shared/document_comments.py ``reviewer_author``; a member's ``name``, which before 7.43.00 fell
  back to their address, shared/document_review_routes.py ``_member_author``) and its ``status_by`` (who resolved
  it, by name);
- a review link (``WS#{ws}#DOCSHARE#{id}`` / ``META``): ``audience.emails``, the addresses it admits, and
  ``created_by_name`` and ``revoked_by``, names;
- a project ``META``: its ``owner_email`` and each ``members`` entry's ``email`` (an entry holds ``role``,
  ``username``, ``email``, ``added_by`` and ``added_at``; a ``name`` too when a writer set one);
- a persona (``PERSONA#``, the persona library's too): each research note's ``author``, free text a member typed;
- a product document's record (``PRODUCT_DOC#``): its ``filename`` (``LISTED_FIELDS``: never rewritten, the
  document is listed for review instead, below).

What an erasure does to each, the boards' and memberships' rule (boards.py, members.py): the row is DE-IDENTIFIED,
never deleted. The address and name are removed; an access entry keyed by the sub stays:

- an author whose ``email`` is the address loses ``email`` and ``email_digest``; a reviewer then loses its ``name``
  too (the reviewer no longer sees the thread as theirs); an author of any kind whose ``name`` is the address loses
  that name (a reviewer's removed, a member's or persona's replaced by ``TEAM_MEMBER_NAME``, the label a nameless
  member gets); the text stays, as a board request's text does: the thread is the project's shared review, and the
  replies around it are other people's (text that names the person is not searched);
- ``status_by``, ``created_by_name``, ``revoked_by`` and a research note's ``author`` that are the address become
  ``TEAM_MEMBER_NAME``;
- a link's audience loses the address from ``emails`` (its domains stay: an allowed domain may still admit the
  person, by domain, not by address). A list audience left with no address and no domain would admit nobody, so the
  link is also revoked (``revoked`` true, ``revoked_by`` ``erasure``): a revoked link is never handed back by
  shared/document_share.py ``create_share``, which makes a new one;
- a ``META``'s ``owner_email`` is REMOVEd when it is the address, and each ``members`` entry whose ``email`` or
  ``name`` is the address loses both; subs, roles and usernames stay (only the sub decides access,
  shared/project_access.py). ``members`` is a map; a list of entries (no writer stores one, and the access gate
  reads none) is de-identified the same way. Re-adding the member, or making them owner, copies the address again
  from the user directory: a member's complete erasure is deleting the user (TENETS.md D5).

The writes, for one row (``_erase_row``): its changes are worked out from the row as read, and the workspace's exports
are closed (exports.py ``note_workspace``: an export copies these addresses, 7.39.00; the ``exports`` phase deletes
them, as for a matched feedback item); a record of the attempt is put (``AUDIT#tombstone#workspace_projects`` /
``{ws}#{kind}#{ref}#{job}``, ``action`` ``deidentifying``); then ONE UpdateItem sets or removes every changed
attribute, conditioned on every attribute of the row's kind being as read (``attribute_not_exists`` for one that was
not there). When it succeeds the outcome is put beside it (the same key and ``#done``, ``action`` ``deidentified``),
and the row counts once (``project_rows_deidentified``, so the ``#done`` records and the count agree, but for a
step cut by a crash between the write and its outcome record, which a rerun does not redo). When the row
changed meanwhile it is read again, whole, and its changes worked out again, at most ``MAX_TRIES`` times; past that,
if something still holds the address, the job fails (``RowKeptChanging``): an admin runs the erasure again, which is
safe, since every step is idempotent (a de-identified row matches nothing). Crash safety: the attempt is recorded
before the write, so a crash after the write leaves a record of the attempt, never a change without one; a rerun then
finds the row already clean. A record names the workspace, the kind and the ids (the project and comment ids, the
project id, or the project and a digest of the link's id): never the address, and never a link's id, the secret its
URL carries.

A project's product documents (``ws/{ws}/projects/{id}/product_docs/``): in a workspace an upload is a ``.md`` or
``.txt`` file or an image (the extractor's rules take no PDF there, 3f) and an image is never extracted (it is marked
failed, 3f). Each record (``PRODUCT_DOC#``, ``DOCS_PAGE`` a step) is judged, and lands on one of two lists the job
and audit rows carry (runs.py), each capped at 200 with its own ``more``, so a document that holds the address is
never crowded out by those that could not be judged:

- ``files_needing_review``, the document holds the address: its ``filename`` does, or its text does (the extracted
  text when the record says the extractor wrote it, ``status`` ``ready`` and ``s3_extracted_key`` under its folder;
  else the ``.md`` or ``.txt`` upload itself; matched with ``casefold``). The workspace's exports, which copy the
  document, are closed as for any match;
- ``files_not_checked`` (counted in ``product_docs_not_checked``), it could not be judged: an image (its folder
  listed once, however many it holds), an upload neither text nor image, text not extracted that is no ``.md`` or
  ``.txt``, a file over ``MAX_TEXT_BYTES``, a record whose upload key is not under its folder (its folder listed), or
  an object the role cannot read. The role holds no ``s3:ListBucket``, so a key that is not there (a record never
  uploaded, still pending, or failed) answers 403 like one it may not read: either is "cannot be judged", never a
  failure of the job.

Nothing there is changed or deleted: a document is the project's, and a person decides. A document not checked does
not close the workspace's exports: if it holds the person's data, its copy in an export's zip stays until that zip
expires (10 days), unless the erasure closed the exports for another match. A file's text is decoded strictly
(``decoded_text``: UTF-16 by its byte-order mark or a NUL byte, else UTF-8); text that decodes neither way, and any
answer S3 gives instead of the object (a KMS refusal, an archived object), is "not checked", never "does not hold
it"; a failure with no answer (a timeout) fails the job.

How the rows are found, without a Scan: the deployment's erasure by email (no source) walks every workspace the
platform lists (workspaces.py); an erasure in one workspace by email walks that workspace only, and its cursor may
name no other (``workspaces.checked_page``). In each workspace, first its review links (its link registry
``WS#{ws}#DOCSHARE_IDS``, then each link's row: an audience scrubbed first stops admitting the address before the
threads are read), then every project its registry lists (a deleted one too: its rows stay until its delete sweeps
them): its ``META``, its product document records, its personas, its ``COMMENT_SERIES#`` rows, each series'
threads; then its company persona library (``COMPANY_PERSONAS_CONTAINER``, which no registry lists) as a project.
Every read is a strongly consistent Query page through the workspace layer (shared/ws_repo.py ``ws_table``;
shared/project_walk.py), projected to the attributes it judges. An id not shaped like one (a listing or registry
row, a link, a series, a document) is skipped and counted (``project_ids_malformed``). The match is
case-insensitive (``casefold``), as members.py's.

The deployment's own projects (since 7.48.00, projects 3g-d), where every real reviewer address is today: the
deployment's erasure by email walks them first (the cursor's ``DEPLOYMENT`` part, ``deployment_state``), by the same
steps and the same writes, a step's scope None (voc-projects seen as itself, shared/ingest_tables.py ``table_view``),
each change recorded under ``AUDIT#tombstone#deployment_projects`` / ``{kind}#{ref}#{job}`` and closing no export (the
deployment's projects have none). Its links and commented series are found first: the backfill's marker read
(shared/review_registries.py), then the deployment's link registry (``DOCSHARE_IDS``) and series registry
(``COMMENT_SERIES_IDS``) by Query, or, without the marker, the backfill's own Scans (one page a step). Every link
is scrubbed, then every series' threads (a deleted project's too: its delete leaves them), then every project the
deployment's project registry lists (``PROJECT_IDS``, put at a project's create and never removed by its delete,
shared/project_walk.py ``registry_page``; or, without the marker, the backfill's third Scan, of the projects'
``META`` rows: the delete's fence takes a deleted or half-deleted project off ``gsi1-by-type``, so no index names it),
its ``META``, product documents and personas, then the persona library. A product document there is
judged by its extracted text of any kind (``_text_key``): the extractor writes text for every kind in the deployment.

The cursor (a hand-over carries it) holds the listing's next key and the page of workspace ids still to do (the
first being walked), and for that workspace where its link registry, its links, its project registry, its projects
and the current project's part are; each state (``ProjectPeopleEraser.state``) has its own step. A page of threads,
personas or product documents is cut after a row when the invocation's time runs low (the next step resumes after
that row), so no step outlasts the hand-over reserve by more than one row's writes.

The Documents Library (7.62.00, docs/documents-library.md): after the persona library, each scope's library items
(``LIBRARY`` / ``WS#{ws}#LIBRARY``, ``ITEM#`` rows, ``DOCS_PAGE`` a step) are judged as product documents are: an
item whose title, file name, source, tags or ``created_by`` / ``updated_by`` name hold the address (an item stored
before 7.63.00 could name its uploader by address), or whose extracted text (``library/{item}/extracted``)
does, is listed in ``files_needing_review`` by its original's key (and closes the workspace's exports); one not
extracted yet, or whose text cannot be read, in ``files_not_checked``. Never changed: the file is the team's.
"""
from __future__ import annotations

import codecs
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from jobs.retention import exports, workspaces
from jobs.retention.copies import tombstone_record
from jobs.retention.members import MEMBER_PERSON_FIELDS, STORE_MEMBERS
from jobs.retention.runs import (
    DEPLOYMENT_FOUND,
    DEPLOYMENT_WALKED,
    email_without_source,
    note_review_file,
    note_unchecked_file,
)
from shared import review_registries
from shared.aws import is_conditional_check_failure
from shared.digests import sha256_hex
from shared.document_comments import AUTHOR_REVIEWER, COMMENT_SK_PREFIX, MAX_NAME_CHARS, TEAM_MEMBER_NAME
from shared.ingest_tables import DeploymentTable, table_view
from shared.library_keys import ITEM_SK_PREFIX as LIBRARY_ITEM_SK_PREFIX
from shared.library_keys import extracted_key as library_extracted_key
from shared.library_keys import is_item_id, library_pk
from shared.library_keys import original_key as library_original_key
from shared.project_keys import (
    COMMENT_SERIES_PREFIX,
    DEPLOYMENT_LINK_REGISTRY_PK,
    DEPLOYMENT_SERIES_REGISTRY_PK,
    PRODUCT_DOC_SK_PREFIX,
    REVIEW_REGISTRIES_MARKER_SK,
    SERIES_ID_RE,
    comments_pk,
    product_docs_prefix,
    project_pk,
    review_link_key,
    review_link_registry_pk,
    series_registry_ids,
)
from shared.project_walk import (
    ID_PAGE,
    checked_ids,
    checked_key,
    is_project_id,
    is_series_ref,
    merged,
    query_page,
    sort_key,
)
from shared.project_writes import PROJECT_DELETION_ATTRIBUTE, is_project_tombstone
from shared.retention import DOCS_NOT_CHECKED_COUNTER, MALFORMED_ID_COUNTER, PROJECT_COUNTER
from shared.review_share_audience import MODE_LIST, is_share_id
from shared.scoped_query import SK_BEGINS, SK_EQUALS
from shared.timestamps import now_iso
from shared.ws_repo import (
    WORKSPACE_FIELD,
    WORKSPACE_KEY_PREFIX,
    OutOfScopeError,
    WorkspaceScope,
    WorkspaceTable,
    scope_from_message,
)

#: The tombstones' source and partition of a workspace's rows (``AUDIT#tombstone#workspace_projects``), and the
#: phase's name (handler.py), which walks the deployment's own projects too since 7.48.00.
STORE_PROJECTS: Final = 'workspace_projects'
#: The tombstones' source and partition of the deployment's rows (``AUDIT#tombstone#deployment_projects``, 7.48.00).
STORE_DEPLOYMENT_PROJECTS: Final = 'deployment_projects'
#: The part of the phase's cursor that walks the deployment's own projects (first, before the listed workspaces), and
#: the flag the cursor carries once they are done (workspaces.py ``DEPLOYMENT_DONE``; a cursor with neither walks them
#: first).
DEPLOYMENT: Final = 'deployment'
DEPLOYMENT_DONE: Final = workspaces.DEPLOYMENT_DONE
#: Set in the ``deployment`` part of a cursor carried from 7.43.00 (its listing already under way, kept as it is).
_CARRIED: Final = 'carried'
#: A row that changed meanwhile is read again and rewritten at most this many times, then the job fails.
MAX_TRIES: Final = 3
#: A product document's text read to look for the address, at most (a larger file is listed for review unread).
MAX_TEXT_BYTES: Final = 16 * 1024 * 1024
#: What a revoked-by-erasure link names as its revoker.
ERASURE_REVOKER: Final = 'erasure'
#: Every field of a workspace's project rows that can hold an address or a name, by row kind (the module docstring):
#: a test holds it to the fields the workspace export carries.
ERASED_FIELDS: Final = {
    'thread': ('author.email', 'author.email_digest', 'author.name', 'replies.author.email',
               'replies.author.email_digest', 'replies.author.name', 'status_by'),
    'link': ('audience.emails', 'created_by_name', 'revoked_by'),
    'project': ('owner_email', 'members.email', 'members.name'),
    'persona': ('research_notes.author',),
}
#: The fields of a product document's record that can hold an address: never rewritten (the record names a file the
#: team uploaded), but a record whose field holds it is listed for review (``_product_doc``).
#: A library item's ``created_by`` / ``updated_by`` are ``{sub, name}``: their ``name`` is judged (an item stored before
#: 7.63.00 could hold the uploader's address there, see library_routes.py ``_actor``).
LISTED_FIELDS: Final = {'product_doc': ('filename',),
                        'library_item': ('title', 'filename', 'source', 'tags', 'created_by', 'updated_by')}
#: The product document records one docs step reads (each may be one or two object reads).
DOCS_PAGE: Final = 5
#: The attributes each kind's write reads and conditions on (its projection), and the attributes any write of this
#: module or lineage.py names: lib/stacks/retention-worker.ts pins voc-projects' UpdateItem to them
#: (``dynamodb:Attributes``), and a test records every update the job sends against this list.
ROW_ATTRIBUTES: Final = {
    kind: (*dict.fromkeys(field.split('.')[0] for field in fields), *(('revoked',) if kind == 'link' else ()))
    for kind, fields in ERASED_FIELDS.items()
}
#: Image uploads: never extracted in a workspace (3f), so never matched; their folder is listed as not checked.
_IMAGE_SUFFIXES: Final = ('.gif', '.jpg', '.jpeg', '.png', '.webp')
#: The uploads the worker may read (lib/stacks/retention-worker.ts grants GetObject on these and the extracted text).
_TEXT_SUFFIXES: Final = ('.md', '.txt')
#: A record whose text the extractor wrote (product_doc_extractor/handler.py's final status).
_EXTRACTED: Final = 'ready'
#: A rewrite that removes the attribute.
_REMOVE: Final = object()
#: The parts of one project, in order.
_META, _DOCS, _PERSONAS, _SERIES = 'meta', 'docs', 'personas', 'series'


class RowKeptChanging(RuntimeError):
    """A row changed under every one of ``MAX_TRIES`` writes and still holds the address: the job fails and says
    so (an admin reruns it), never leaving the address silently."""


def applies(run: Mapping[str, Any], tables: Mapping[str, Any]) -> bool:
    """An erasure by email that is not limited to a source, with voc-projects configured: a workspace's own erasure
    walks that workspace; the deployment's walks its own projects (since 7.48.00) and then, with voc-workspaces
    configured, every listed workspace's."""
    return email_without_source(run) and 'projects' in tables


def decoded_text(data: bytes) -> str | None:
    """A text file's characters: UTF-16 when it starts with a byte-order mark or holds a NUL byte (UTF-8 text never
    does), else strict UTF-8; None when it is neither (the document is then not checked, never read as clean)."""
    utf16 = data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)) or b'\x00' in data
    try:
        return data.decode('utf-16') if utf16 else data.decode('utf-8-sig')
    except UnicodeDecodeError:
        return None


def _same(value: object, wanted: str) -> bool:
    """Whether ``value`` is the address (``casefold``), or its first ``MAX_NAME_CHARS`` characters: before 7.43.00 a
    name that fell back to a long address was stored cut to that length."""
    if not isinstance(value, str):
        return False
    held = value.strip().casefold()
    return held == wanted or (len(wanted) > MAX_NAME_CHARS and held == wanted[:MAX_NAME_CHARS])


def _is_series_id(value: str) -> bool:
    return SERIES_ID_RE.fullmatch(value) is not None


class ProjectPeopleEraser:
    """One erasure's walk of the workspaces' projects (the module docstring), one step at a time."""

    def __init__(self, run: dict[str, Any], tables: Mapping[str, Any], value: str, s3: Any = None,
                 bucket: str = '', time_left: Callable[[], bool] = lambda: True,
                 clock: Callable[[], datetime] = workspaces.utc_now) -> None:
        self._run = run
        self._projects = tables['projects']
        self._aggregates = tables['aggregates']
        self._workspaces = tables.get(STORE_MEMBERS)
        self._wanted = value.strip().casefold()
        self._s3 = s3
        self._bucket = bucket
        # The invocation's clock, read after each row of a page: a page cut there resumes after that row.
        self._time_left = time_left
        # The wall clock: when the walk of the listing began, and each re-walk pass (workspaces.py).
        self._clock = clock

    # ── The walk ──────────────────────────────────────────────────────────────────────────────────────────────

    def step(self, cursor: Mapping[str, Any] | None) -> dict[str, Any] | None:
        """One step from ``cursor`` (None: the start), and the cursor of the next; None once every workspace is
        done. The deployment's job walks its own projects first (the cursor's ``deployment`` part; once they are done
        the cursor says ``deployment_done``), then the listed workspaces. A deployment job's cursor that says neither
        (a 7.43.00 hand-over carried across the upgrade) walks the deployment first, then goes on where it was."""
        only = workspaces.named(self._run)
        here = dict(cursor) if cursor else workspaces.start(self._run, self._clock)
        if only is None and DEPLOYMENT not in here and here.get(DEPLOYMENT_DONE) is not True:
            # A carried 7.43.00 cursor keeps its listing state as it is; a fresh one takes it again at the end.
            here[DEPLOYMENT] = {_CARRIED: True} if cursor else {}
        if DEPLOYMENT in here:
            return self._deployment_step(here, only)
        page = workspaces.checked_page(self._run, here)
        if not page:
            if here.get('listing_done') or self._workspaces is None:
                # Done; or no voc-workspaces configured (a deployment without workspaces lists none).
                return None
            return workspaces.listing_page(self._run, self._workspaces, here, self._clock())
        scope = scope_from_message({WORKSPACE_FIELD: page[0]})
        at = dict(here.get('at') or {})
        moved = self._steps()[self.state(at)](scope, at)
        return {**here, 'ws': page[1:], 'at': {}} if moved is None else {**here, 'at': moved}

    def _deployment_step(self, here: dict[str, Any], only: str | None) -> dict[str, Any]:
        """One step of the deployment's own projects (``deployment_state``); once they are done, the cursor without its
        ``deployment`` part and with ``deployment_done``, and the run says it walked them (``DEPLOYMENT_WALKED``, on
        the job row). A walk that began with the job takes the listing's start again then (workspaces.py
        ``listing_start``: the hours the deployment's walk took are not the listing's window, which would read every
        rename meanwhile as a moved row); one carried from 7.43.00 keeps the listing where it was. A one-workspace job
        never walks them (ValueError: a hand-over of one must not)."""
        if only is not None:
            raise ValueError("a one-workspace job carried the deployment's walk")
        carried = here[DEPLOYMENT]
        if not isinstance(carried, Mapping):
            raise ValueError("a carried deployment's walk is not a map")
        at = dict(carried)
        moved = self._deployment_steps()[self.deployment_state(at)](None, at)
        if moved is not None:
            return {**here, DEPLOYMENT: moved}
        self._run[DEPLOYMENT_WALKED] = True
        rest = {name: value for name, value in here.items() if name != DEPLOYMENT}
        if carried.get(_CARRIED) is not True:
            rest.update(workspaces.listing_start(self._clock()))
        return {**rest, DEPLOYMENT_DONE: True}

    def _steps(self) -> Mapping[str, Callable[[WorkspaceScope, dict[str, Any]], dict[str, Any] | None]]:
        """Each cursor state's step in a workspace (``state``)."""
        return {'link_registry': self._link_pages_step, 'series': self._series_step, 'registry': self._registry_step,
                **self._shared_steps()}

    def _deployment_steps(self) -> Mapping[str, Callable[[None, dict[str, Any]], dict[str, Any] | None]]:
        """Each cursor state's step of the deployment's own projects (``deployment_state``)."""
        return {'found': self._found_step, 'link_pages': self._link_pages_step, 'pair_pages': self._pair_pages_step,
                'projects': self._registry_step, **self._shared_steps()}

    def _shared_steps(self) -> dict[str, Callable[[Any, dict[str, Any]], dict[str, Any] | None]]:
        """The steps both scopes share: a link, a series' threads, one project's parts, the persona library and the
        end (the next page of projects is each scope's own state: ``registry``, ``projects``)."""
        return {'link': self._link_step, 'threads': self._threads_step, _META: self._meta_step,
                _DOCS: self._docs_step, _PERSONAS: self._personas_step, 'project_done': self._project_done_step,
                'library': self._library_step, 'documents_library': self._documents_library_step,
                'done': self._done_step}

    @staticmethod
    def state(at: Mapping[str, Any]) -> str:
        """Which step a workspace's cursor is at: its links first, then its projects, each project's parts in
        order, then its persona library (as a project); ``done`` once all are."""
        if at.get('links'):
            return 'link'
        if not at.get('links_done'):
            return 'link_registry'
        return ProjectPeopleEraser._project_state(at, workspace=True)

    @staticmethod
    def deployment_state(at: Mapping[str, Any]) -> str:
        """Which step the deployment's cursor is at: how its links and series are found (``found``: the registries,
        or the Scans until the backfill ran), then every link, then every commented series' threads (a deleted
        project's too: the series registry is deployment-wide), then its projects (each
        one's ``META``, product documents and personas: its series are walked already) and its persona library. The
        cursor's names are its own: ``links_from``, ``pairs_from``, ``threads_from``, ``projects_from``. The projects
        come from its registry, ``PROJECT_IDS``, or from the ``PROJECTS`` Scan until the backfill ran: a deleted or
        half-deleted project's ``META`` is off ``gsi1-by-type`` (the delete's fence removes its index keys)."""
        if 'found' not in at:
            return 'found'
        workspaces.checked_found(at)
        if at.get('links'):
            return 'link'
        if not at.get('links_done'):
            return 'link_pages'
        if at.get('pairs'):
            return 'threads'
        if not at.get('pairs_done'):
            return 'pair_pages'
        return ProjectPeopleEraser._project_state(at, workspace=False)

    @staticmethod
    def _project_state(at: Mapping[str, Any], *, workspace: bool) -> str:
        """The projects' part of a cursor: a project's parts in order (its series too in a workspace), the next page
        of projects (a workspace's ``registry``, the deployment's ``projects``), the persona library, ``done``."""
        if at.get('ids'):
            part = at.get('part') or _META
            if part == _SERIES:
                if not workspace:
                    return 'project_done'
                return 'threads' if at.get('series') else ('project_done' if at.get('series_listed') else 'series')
            if part not in (_META, _DOCS, _PERSONAS):
                raise ValueError('a carried project part is not one')
            return part
        if not at.get('registry_done' if workspace else 'projects_done'):
            return 'registry' if workspace else 'projects'
        if not at.get('library'):
            return 'library'
        return 'done' if at.get('documents_library_done') else 'documents_library'

    def _cut(self, rows: list[dict[str, Any]], n: int) -> dict[str, Any] | None:
        """The key to resume after row ``n`` of a page when the time ran low and rows remain, else None."""
        if n < len(rows) - 1 and not self._time_left():
            return {'pk': rows[n]['pk'], 'sk': rows[n]['sk']}
        return None

    def _view(self, scope: WorkspaceScope | None) -> WorkspaceTable | DeploymentTable:
        """voc-projects in the scope: a workspace's through the layer, the deployment's (None) as the table itself."""
        return table_view(scope, self._projects)

    # ── The deployment's own projects (since 7.48.00) ─────────────────────────────────────────────────────────────

    def _found_step(self, _scope: None, at: dict[str, Any]) -> dict[str, Any]:
        """Whether the backfill listed what was made before 7.48.00 (workspaces.py ``deployment_found``: its marker,
        complete): then the registries are walked by Query, else the same links, series and projects are found by
        Scan. The run keeps which (``DEPLOYMENT_FOUND``, on the job row)."""
        found = workspaces.deployment_found(self._projects)
        self._run[DEPLOYMENT_FOUND] = found
        return {**at, 'found': found, 'links_done': False, 'pairs_done': False}

    def _link_pages_step(self, scope: WorkspaceScope | None, at: dict[str, Any]) -> dict[str, Any]:
        """The next page of the scope's links: a workspace's link registry, the deployment's (``DOCSHARE_IDS``, the
        backfill's own rows left out), or, until the backfill ran, a Scan page's."""
        if scope is None and at.get('found') == workspaces.FOUND_SCAN:
            page = workspaces.scan(self._run, self._projects, review_registries.LINKS, at.get('links_from'))
            links, following = page.ids, page.following
        else:
            partition = DEPLOYMENT_LINK_REGISTRY_PK if scope is None else review_link_registry_pk(scope)
            links, following = self._registry_ids(scope, partition, at.get('links_from'), is_share_id)
        return {**at, 'links': links, 'links_from': following, 'links_done': following is None}

    def _registry_ids(self, scope: WorkspaceScope | None, partition: str, start: object,
                      valid: Callable[[str], bool]) -> tuple[list[str], dict[str, Any] | None]:
        """One strongly consistent page of a registry's sort keys (a link registry's or the series registry), the
        ones ``valid`` accepts, the others counted (``project_ids_malformed``; the backfill's own rows, its marker and
        its progress row, ``MIGRATION#…``, left out, uncounted), and the key the next page starts from."""
        rows, following = query_page(self._view(scope), partition, checked_key(start), Limit=ID_PAGE,
                                     ConsistentRead=True, ProjectionExpression='sk')
        listed = [str(row.get('sk', '')) for row in rows
                  if not str(row.get('sk', '')).startswith(_MIGRATION_PREFIX)]
        ids = [each for each in listed if valid(each)]
        workspaces.count(self._run, MALFORMED_ID_COUNTER, len(listed) - len(ids))
        return ids, following

    def _pair_pages_step(self, _scope: None, at: dict[str, Any]) -> dict[str, Any]:
        """The next page of the deployment's commented series (``{project}#{series}``): its series registry's
        (``COMMENT_SERIES_IDS``), or a Scan page's (the last partition it met carried, ``last_pk``, so the next page
        does not meet it again); one rule judges a series either way (shared/project_walk.py ``is_series_ref``)."""
        if at['found'] == workspaces.FOUND_SCAN:
            page = workspaces.scan(self._run, self._projects, review_registries.SERIES, at.get('pairs_from'),
                                   at.get('last_pk'))
            pairs, following, last = page.ids, page.following, page.last_pk or at.get('last_pk')
        else:
            pairs, following = self._registry_ids(None, DEPLOYMENT_SERIES_REGISTRY_PK, at.get('pairs_from'),
                                                  is_series_ref)
            last = None
        return {**at, 'pairs': pairs, 'pairs_from': following, 'pairs_done': following is None, 'last_pk': last,
                'threads_from': None}

    def _link_step(self, scope: WorkspaceScope | None, at: dict[str, Any]) -> dict[str, Any]:
        links = checked_ids(at.get('links'), is_share_id, 'links')
        key = review_link_key(links[0], workspace=scope)
        for row in self._read(scope, key, 'link'):
            # The ref names the link by a digest of its id: its id is the secret its URL carries.
            self._erase_row(scope, row, 'link', f"{row.get('project_id') or '-'}#{sha256_hex(links[0])[:24]}")
        return {**at, 'links': links[1:]}

    def _registry_step(self, scope: WorkspaceScope | None, at: dict[str, Any]) -> dict[str, Any]:
        """The scope's next page of projects (workspaces.py ``registry_step``: a workspace's registry, or the
        deployment's, ``PROJECT_IDS``, or its ``PROJECTS`` Scan until the backfill ran; a deleted project too)."""
        return workspaces.registry_step(self._projects, self._run, scope, at, **_project_start(scope))

    def _meta_step(self, scope: WorkspaceScope | None, at: dict[str, Any]) -> dict[str, Any]:
        """The project's ``META``; a deployment project being or already deleted also lists its product documents
        folder as not checked: its delete sweeps the objects before the records, but an object S3 refused to delete
        outlives its record (and the delete still finishes), so no record would name it."""
        project_id = self._project(at)
        for row in self._read(scope, {'pk': project_pk(project_id, workspace=scope), 'sk': 'META'}, 'project'):
            if scope is None and is_project_tombstone(row):
                self._not_checked(product_docs_prefix(project_id, workspace=scope))
            self._erase_row(scope, row, 'project', project_id)
        return {**at, 'part': _DOCS, 'docs_from': None}

    def _docs_step(self, scope: WorkspaceScope | None, at: dict[str, Any]) -> dict[str, Any]:
        """One page of the project's product document records (``DOCS_PAGE``), each judged (the module docstring);
        cut after a record when the time runs low."""
        project_id = self._project(at)
        rows, following = query_page(self._view(scope), project_pk(project_id, workspace=scope),
                                     checked_key(at.get('docs_from')), Limit=DOCS_PAGE, ConsistentRead=True,
                                     **merged(sort_key(SK_BEGINS, {':sk': PRODUCT_DOC_SK_PREFIX}), _DOC_PROJECTION))
        for n, row in enumerate(rows):
            self._product_doc(scope, project_id, row)
            if (cut := self._cut(rows, n)) is not None:
                return {**at, 'docs_from': cut}
        return {**at, 'docs_from': following} if following else {**at, 'part': _PERSONAS, 'docs_from': None}

    def _personas_step(self, scope: WorkspaceScope | None, at: dict[str, Any]) -> dict[str, Any]:
        """One page of the project's personas (their research notes' authors); cut after a row when the time runs
        low. Then the project's series in a workspace (the deployment's were walked through its series registry)."""
        project_id = self._project(at)
        rows, following = query_page(self._view(scope), project_pk(project_id, workspace=scope),
                                     checked_key(at.get('personas_from')), Limit=ID_PAGE, ConsistentRead=True,
                                     **merged(sort_key(SK_BEGINS, {':sk': 'PERSONA#'}), _projection('persona')))
        for n, row in enumerate(rows):
            self._erase_row(scope, row, 'persona', f"{project_id}#{str(row['sk']).removeprefix('PERSONA#')}")
            if (cut := self._cut(rows, n)) is not None:
                return {**at, 'personas_from': cut}
        return ({**at, 'personas_from': following} if following
                else {**at, 'part': _SERIES, 'personas_from': None})

    def _library_step(self, scope: WorkspaceScope | None, at: dict[str, Any]) -> dict[str, Any]:
        """The scope's company persona library (workspaces.py ``library_step``), walked as a project last."""
        return workspaces.library_step(at, **_project_start(scope))

    def _documents_library_step(self, scope: WorkspaceScope | None, at: dict[str, Any]) -> dict[str, Any]:
        """One page of the scope's Documents Library items (7.62.00, shared/library_keys.py), each judged as a product
        document is (``_library_item``), last; cut after an item when the time runs low."""
        rows, following = query_page(self._view(scope), library_pk(workspace=scope),
                                     checked_key(at.get('documents_library_from')), Limit=DOCS_PAGE,
                                     ConsistentRead=True,
                                     **merged(sort_key(SK_BEGINS, {':sk': LIBRARY_ITEM_SK_PREFIX}), _LIBRARY_PROJECTION))
        for n, row in enumerate(rows):
            self._library_item(scope, row)
            if (cut := self._cut(rows, n)) is not None:
                return {**at, 'documents_library_from': cut}
        if following:
            return {**at, 'documents_library_from': following}
        return {**at, 'documents_library_done': True, 'documents_library_from': None}

    def _library_item(self, scope: WorkspaceScope | None, row: Mapping[str, Any]) -> None:
        """Judge one library item (docs/documents-library.md "Erasure"): its metadata or its extracted text holds the
        address, it is listed for review by its original's key (and a workspace's exports close); one not extracted, or
        whose text cannot be read, is listed apart as not checked. Nothing is changed: the file is the team's."""
        item_id = str(row.get('sk', '')).removeprefix(LIBRARY_ITEM_SK_PREFIX)
        if not is_item_id(item_id):
            workspaces.count(self._run, MALFORMED_ID_COUNTER)
            return
        original = library_original_key(item_id, workspace=scope)
        if any(self._wanted in value.casefold() for name in LISTED_FIELDS['library_item']
               for value in _texts_of(row.get(name))):
            self._holds_it(scope, original)
            return
        if row.get('status') != _EXTRACTED:
            self._not_checked(original)
            return
        verdict = self._holds_address(library_extracted_key(item_id, workspace=scope))
        if verdict is None:
            self._not_checked(original)
        elif verdict:
            self._holds_it(scope, original)

    def _series_step(self, scope: WorkspaceScope, at: dict[str, Any]) -> dict[str, Any]:
        project_id = self._project(at)
        rows, following = query_page(self._view(scope), project_pk(project_id, workspace=scope),
                                     checked_key(at.get('series_from')), Limit=ID_PAGE, ConsistentRead=True,
                                     **merged(sort_key(SK_BEGINS, {':sk': COMMENT_SERIES_PREFIX}),
                                              {'ProjectionExpression': '#sk'}))
        listed = [str(row.get('sk', '')).removeprefix(COMMENT_SERIES_PREFIX) for row in rows]
        series = [each for each in listed if _is_series_id(each)]
        workspaces.count(self._run, MALFORMED_ID_COUNTER, len(listed) - len(series))
        return {**at, 'series': series, 'series_from': following, 'series_listed': following is None, 'start': None}

    def _threads_step(self, scope: WorkspaceScope | None, at: dict[str, Any]) -> dict[str, Any]:
        """One page of the first listed series' threads: a workspace's project's series (``series``, ``start``), or
        the deployment's series registry's (``pairs``, ``threads_from``); cut after a row when the time runs low."""
        if scope is None:
            listed_key, start_key = 'pairs', 'threads_from'
            listed = checked_ids(at.get(listed_key), is_series_ref, listed_key)
            project_id, series_id = series_registry_ids(listed[0]) or ('', '')
        else:
            listed_key, start_key = 'series', 'start'
            listed = checked_ids(at.get(listed_key), _is_series_id, listed_key)
            project_id, series_id = self._project(at), listed[0]
        following, done = self._thread_page(scope, project_id, series_id, at.get(start_key))
        return {**at, listed_key: listed[1:], start_key: None} if done else {**at, start_key: following}

    def _thread_page(self, scope: WorkspaceScope | None, project_id: str, series_id: str,
                     start: object) -> tuple[dict[str, Any] | None, bool]:
        """One page of a series' threads from ``start``, each de-identified: the key the next page starts from (the
        row the page was cut after, when the time ran low), and whether the series is done."""
        rows, following = query_page(self._view(scope), comments_pk(project_id, series_id, workspace=scope),
                                     checked_key(start), Limit=ID_PAGE, ConsistentRead=True,
                                     **merged(sort_key(SK_BEGINS, {':sk': COMMENT_SK_PREFIX}), _projection('thread')))
        for n, row in enumerate(rows):
            self._erase_row(scope, row, 'thread',
                            f"{project_id}#{str(row['sk']).removeprefix(COMMENT_SK_PREFIX)}")
            if (cut := self._cut(rows, n)) is not None:
                return cut, False
        return following, following is None

    def _project_done_step(self, scope: WorkspaceScope | None, at: dict[str, Any]) -> dict[str, Any]:
        return {**at, 'ids': checked_ids(at.get('ids'), is_project_id, 'ids')[1:], **_project_start(scope)}

    def _done_step(self, _scope: WorkspaceScope | None, _at: dict[str, Any]) -> None:
        """The scope is done (None): the walk moves to the next one."""

    @staticmethod
    def _project(at: Mapping[str, Any]) -> str:
        return checked_ids(at.get('ids'), is_project_id, 'ids')[0]

    # ── Product documents ─────────────────────────────────────────────────────────────────────────────────────

    def _product_doc(self, scope: WorkspaceScope | None, project_id: str, row: Mapping[str, Any]) -> None:
        """Judge one product document (the module docstring, "Product documents"): one that holds the address (in
        its text or its filename) is listed for review and closes the workspace's exports; one that cannot be judged
        is listed apart, as not checked; nothing is changed or deleted. Each scope reads by its own rule
        (``_text_key``)."""
        folder = product_docs_prefix(project_id, workspace=scope)
        doc_id = str(row.get('sk', '')).removeprefix(PRODUCT_DOC_SK_PREFIX)
        raw = row.get('s3_raw_key')
        shaped = is_project_id(doc_id) and isinstance(raw, str) and raw.startswith(f'{folder}raw/')
        if not shaped:
            workspaces.count(self._run, MALFORMED_ID_COUNTER)
        if any(isinstance(row.get(name), str) and self._wanted in str(row[name]).casefold()
               for name in LISTED_FIELDS['product_doc']):
            # Checked before the record's shape: a record that names the person is listed whatever else it holds.
            self._holds_it(scope, raw if shaped and isinstance(raw, str) else folder)
            return
        if not shaped or not isinstance(raw, str):
            self._not_checked(folder)
            return
        key = self._text_key(scope, folder, raw, row)
        if key is None:
            return
        verdict = self._holds_address(key)
        if verdict is None:
            self._not_checked(raw)
        elif verdict:
            self._holds_it(scope, raw)

    def _text_key(self, scope: WorkspaceScope | None, folder: str, raw: str, row: Mapping[str, Any]) -> str | None:
        """The object whose text says whether a document holds the address, or None once it is listed as not checked:

        * the deployment's (7.48.00, 3g-d): the extractor writes text for every kind there (a PDF's text, an image's
          description by the model), so only the extracted text is read, every kind alike (``status`` ``ready``,
          ``s3_extracted_key`` under its folder), and a document with none (pending, failed, never uploaded) is not
          checked, by its upload's key;
        * a workspace's: an image is never extracted there (its folder listed once, however many it holds), and the
          extracted text, else a ``.md`` or ``.txt`` upload itself, is read."""
        extracted = row.get('s3_extracted_key')
        ready = (extracted if row.get('status') == _EXTRACTED and isinstance(extracted, str)
                 and extracted.startswith(f'{folder}extracted/') else None)
        if scope is None:
            if ready is not None:
                return ready
            self._not_checked(raw)
            return None
        lowered, content_type = raw.lower(), str(row.get('content_type') or '').lower()
        if content_type.startswith('image/') or lowered.endswith(_IMAGE_SUFFIXES):
            self._not_checked(folder)
            return None
        if ready is not None:
            return ready
        if lowered.endswith(_TEXT_SUFFIXES):
            return raw
        # Neither a text upload nor its extracted text to read (another kind, or text not extracted yet).
        self._not_checked(raw)
        return None

    def _holds_it(self, scope: WorkspaceScope | None, raw: str) -> None:
        """A document that holds the address: listed for review, and a workspace's exports (which copy it) closed (the
        deployment has no export of its projects)."""
        if scope is not None:
            exports.note_workspace(self._run, scope, self._aggregates)
        note_review_file(self._run, raw)

    def _not_checked(self, key: str) -> None:
        workspaces.count(self._run, DOCS_NOT_CHECKED_COUNTER)
        note_unchecked_file(self._run, key)

    def _holds_address(self, key: str) -> bool | None:
        """Whether the object holds the address; None when it cannot be judged: any answer S3 gives instead of the
        object (a key not there reads 403 too, since the role holds no ListBucket; a KMS refusal; an archived object),
        larger than ``MAX_TEXT_BYTES``, or text it cannot decode. A failure with no answer (a timeout) is raised."""
        if self._s3 is None or not self._bucket:
            return None
        try:
            body = self._s3.get_object(Bucket=self._bucket, Key=key)['Body']
        except ClientError:
            return None
        try:
            data = body.read(MAX_TEXT_BYTES + 1)
        finally:
            body.close()
        if len(data) > MAX_TEXT_BYTES:
            return None
        text = decoded_text(data)
        return None if text is None else self._wanted in text.casefold()

    # ── What each attribute loses (None: nothing of the person's in it) ───────────────────────────────────────

    def _author(self, author: object) -> object:
        if not isinstance(author, Mapping):
            return None
        by_email, by_name = _same(author.get('email'), self._wanted), _same(author.get('name'), self._wanted)
        if not (by_email or by_name):
            return None
        out = {name: field for name, field in author.items()
               if not (by_email and name in ('email', 'email_digest'))}
        if author.get('kind') == AUTHOR_REVIEWER:
            out.pop('name', None)
        elif by_name:
            out['name'] = TEAM_MEMBER_NAME
        return out

    def _replies(self, value: object) -> object:
        if not isinstance(value, list):
            return None
        changed, replies = False, []
        for reply in value:
            author = self._author(reply.get('author')) if isinstance(reply, Mapping) else None
            replies.append(reply if author is None else {**reply, 'author': author})
            changed = changed or author is not None
        return replies if changed else None

    def _label(self, value: object) -> object:
        return TEAM_MEMBER_NAME if _same(value, self._wanted) else None

    def _owner(self, value: object) -> object:
        return _REMOVE if _same(value, self._wanted) else None

    def _member(self, entry: object) -> object:
        """A members entry without its email and name when either is the address, else None."""
        if not isinstance(entry, Mapping) or not any(_same(entry.get(name), self._wanted)
                                                     for name in MEMBER_PERSON_FIELDS):
            return None
        return {name: field for name, field in entry.items() if name not in MEMBER_PERSON_FIELDS}

    def _members(self, value: object) -> object:
        """The members map (or a list of entries, a shape no writer stores but a row could hold) with each entry
        that names the address de-identified; None when none does."""
        if isinstance(value, Mapping):
            changed = {sub: self._member(entry) for sub, entry in value.items()}
            if all(entry is None for entry in changed.values()):
                return None
            return {sub: entry if changed[sub] is None else changed[sub] for sub, entry in value.items()}
        if isinstance(value, list):
            listed = [self._member(entry) for entry in value]
            if all(entry is None for entry in listed):
                return None
            return [entry if new is None else new for entry, new in zip(value, listed, strict=True)]
        return None

    def _research_notes(self, value: object) -> object:
        """A persona's research notes, each whose free-text ``author`` holds the address anywhere (``casefold``, a
        name around it too: "Rae <rae@…>") replaced whole by ``TEAM_MEMBER_NAME``; None when none does."""
        if not isinstance(value, list):
            return None
        hit = [isinstance(note, Mapping) and isinstance(note.get('author'), str)
               and self._wanted in str(note['author']).casefold() for note in value]
        if not any(hit):
            return None
        return [{**note, 'author': TEAM_MEMBER_NAME} if matched else note for note, matched in zip(value, hit,
                                                                                                  strict=True)]

    def _audience(self, value: object) -> object:
        if not isinstance(value, Mapping) or not isinstance(value.get('emails'), list):
            return None
        kept = [email for email in value['emails'] if not _same(email, self._wanted)]
        return {**value, 'emails': kept} if len(kept) != len(value['emails']) else None

    def changes(self, kind: str, row: Mapping[str, Any]) -> dict[str, object]:
        """Every attribute of ``row`` (of ``kind``) to rewrite, and its new value (``_REMOVE``: removed)."""
        judges: dict[str, Callable[[object], object]] = {
            'thread': {'author': self._author, 'replies': self._replies, 'status_by': self._label},
            'link': {'audience': self._audience, 'created_by_name': self._label, 'revoked_by': self._label},
            'project': {'owner_email': self._owner, 'members': self._members},
            'persona': {'research_notes': self._research_notes},
        }[kind]
        found = {name: judge(row.get(name)) for name, judge in judges.items() if name in row}
        found = {name: value for name, value in found.items() if value is not None}
        audience = found.get('audience')
        if (isinstance(audience, Mapping) and audience.get('mode') == MODE_LIST and not audience.get('emails')
                and not audience.get('domains') and row.get('revoked') is not True):
            # It would admit nobody: revoked, so the series' next share makes a new link (the module docstring).
            found.update(revoked=True, revoked_by=ERASURE_REVOKER)
        return found

    # ── The writes ────────────────────────────────────────────────────────────────────────────────────────────

    def _read(self, scope: WorkspaceScope | None, key: Mapping[str, str], kind: str) -> list[dict[str, Any]]:
        """The row at ``key``, strongly consistent, projected to what its kind judges (none when it is gone)."""
        rows, _ = query_page(self._view(scope), key['pk'], None, ConsistentRead=True,
                             **merged(sort_key(SK_EQUALS, {':sk': key['sk']}), _projection(kind)))
        return rows

    def _erase_row(self, scope: WorkspaceScope | None, row: Mapping[str, Any], kind: str, ref: str) -> None:
        """De-identify one row (the module docstring, "The writes"); a deployment's (``scope`` None) is recorded
        under ``deployment_projects`` and closes no export."""
        job = self._run.get('job_id') or self._run['run_id']
        record = f'{kind}#{ref}#{job}' if scope is None else f'{scope.ws}#{kind}#{ref}#{job}'
        key = {'pk': str(row['pk']), 'sk': str(row['sk'])}
        current: Mapping[str, Any] = row
        for _try in range(MAX_TRIES):
            found = self.changes(kind, current)
            if not found:
                return
            if scope is not None:
                exports.note_workspace(self._run, scope, self._aggregates)
            self._record(scope, kind, record, 'deidentifying')
            if self._write(scope, current, kind, found):
                self._record(scope, kind, f'{record}#done', 'deidentified')
                workspaces.count(self._run, PROJECT_COUNTER)
                return
            rows = self._read(scope, key, kind)
            if not rows:
                return
            current = rows[0]
        if self.changes(kind, current):
            raise RowKeptChanging('A project row kept changing while an address was being erased from it')

    def _record(self, scope: WorkspaceScope | None, kind: str, sort_key_: str, action: str) -> None:
        store = STORE_DEPLOYMENT_PROJECTS if scope is None else STORE_PROJECTS
        item = tombstone_record(self._run, store, sort_key_, store, now_iso())
        named = {} if scope is None else {'workspace_id': scope.ws}
        self._aggregates.put_item(Item={**item, **named, 'kind': kind, 'action': action})

    def _write(self, scope: WorkspaceScope | None, row: Mapping[str, Any], kind: str,
               found: Mapping[str, object]) -> bool:
        """One UpdateItem: every change, conditioned on every attribute of the kind as read; False when the row
        changed meanwhile."""
        names: dict[str, str] = {}
        values: dict[str, Any] = {}
        sets, removes, conditions = [], [], ['attribute_exists(pk)']
        for n, name in enumerate(ROW_ATTRIBUTES[kind]):
            names[f'#a{n}'] = name
            if name in row:
                values[f':o{n}'] = row[name]
                conditions.append(f'#a{n} = :o{n}')
            else:
                conditions.append(f'attribute_not_exists(#a{n})')
            if name not in found:
                continue
            if found[name] is _REMOVE:
                removes.append(f'#a{n}')
            else:
                values[f':n{n}'] = found[name]
                sets.append(f'#a{n} = :n{n}')
        expression = ' '.join(part for part in (f"SET {', '.join(sets)}" if sets else '',
                                                f"REMOVE {', '.join(removes)}" if removes else '') if part)
        if not set(names.values()) <= set(PEOPLE_UPDATE_ATTRIBUTES):
            # IAM refuses any other (dynamodb:Attributes): fail here, saying so, rather than as AccessDenied.
            raise RuntimeError('An erasure write names an attribute the worker may not update')
        if scope is None and str(row['pk']).startswith(WORKSPACE_KEY_PREFIX):
            # The deployment's walk writes the deployment's rows only (a workspace's row goes through its own layer).
            raise OutOfScopeError("the deployment's erasure writes no workspace's row")
        try:
            self._view(scope).update_item({'pk': row['pk'], 'sk': row['sk']}, UpdateExpression=expression,
                                          ConditionExpression=' AND '.join(conditions),
                                          ExpressionAttributeNames=names, ExpressionAttributeValues=values)
        except ClientError as error:
            if is_conditional_check_failure(error):
                return False
            raise
        return True


def _texts_of(value: object) -> list[str]:
    """The text values of one attribute: itself when it is text, its text members when it is a list (tags), its
    ``name`` when it is a map (a library item's ``created_by`` / ``updated_by``, ``{sub, name}``)."""
    values: list[object] = list(value) if isinstance(value, list) else (
        [value.get('name')] if isinstance(value, Mapping) else [value])
    return [entry for entry in values if isinstance(entry, str)]


def _projection(kind: str) -> dict[str, Any]:
    """A Query's projection to a row's key and the attributes its kind judges (a link's project too, and a
    ``META``'s delete state: ``_meta_step``)."""
    names = {f'#a{n}': name for n, name in enumerate(ROW_ATTRIBUTES[kind])}
    extra = {'#pid': 'project_id'} if kind == 'link' else (
        {'#st': 'status', '#del': PROJECT_DELETION_ATTRIBUTE} if kind == 'project' else {})
    return {'ProjectionExpression': ', '.join(['#pk', '#sk', *names, *extra]),
            'ExpressionAttributeNames': {'#pk': 'pk', '#sk': 'sk', **names, **extra}}


#: What a docs step reads of a product document record.
_DOC_PROJECTION: Final = {
    'ProjectionExpression': '#pk, #sk, #raw, #type, #status, #text, #file',
    'ExpressionAttributeNames': {'#pk': 'pk', '#sk': 'sk', '#raw': 's3_raw_key', '#type': 'content_type',
                                 '#status': 'status', '#text': 's3_extracted_key', '#file': 'filename'},
}
#: What the documents library step reads of an item (lib/stacks/retention-worker.ts holds the deployment's Query to
#: these among DEPLOYMENT_QUERY_ATTRIBUTES): its key, status, the metadata a person typed and who made and changed it.
_LIBRARY_PROJECTION: Final = {
    'ProjectionExpression': '#pk, #sk, #status, #title, #file, #source, #tags, #cb, #ub',
    'ExpressionAttributeNames': {'#pk': 'pk', '#sk': 'sk', '#status': 'status', '#title': 'title',
                                 '#file': 'filename', '#source': 'source', '#tags': 'tags', '#cb': 'created_by',
                                 '#ub': 'updated_by'},
}
#: The per-project part of a workspace's cursor, as a project starts.
_PROJECT_START: Final = {'part': _META, 'docs_from': None, 'personas_from': None, 'series': [], 'series_from': None,
                         'series_listed': False, 'start': None}
#: The same of the deployment's: its series are walked through its series registry, not per project.
_DEPLOYMENT_PROJECT_START: Final = {'part': _META, 'docs_from': None, 'personas_from': None}
#: The sort-key start of the backfill's own rows in the link registry (its marker and its progress row): never a link.
_MIGRATION_PREFIX: Final = REVIEW_REGISTRIES_MARKER_SK.split('#', 1)[0] + '#'


def _project_start(scope: WorkspaceScope | None) -> dict[str, Any]:
    """The per-project part of the scope's cursor, as a project starts."""
    return dict(_PROJECT_START if scope is not None else _DEPLOYMENT_PROJECT_START)

#: The attributes this module's UpdateItems name on voc-projects, with the key: lib/stacks/retention-worker.ts grants
#: them in a statement of their own (``PEOPLE_UPDATE_ATTRIBUTES``), on the deployment's and one workspace id's
#: ``PROJECT#``, ``DCOMMENTS#`` and ``DOCSHARE#`` partitions only (the deployment's since 7.48.00); lineage.py's marks
#: are the other statement (``LINEAGE_UPDATE_ATTRIBUTES``). A test holds each list to its statement.
PEOPLE_UPDATE_ATTRIBUTES: Final = ('pk', 'sk', *(name for kind in ROW_ATTRIBUTES.values() for name in kind))
