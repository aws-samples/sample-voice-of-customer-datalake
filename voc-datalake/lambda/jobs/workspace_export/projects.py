"""A workspace's projects in its export (7.39.00, projects 3g-a; docs/multi-workspace.md, "Export and delete", step 2,
and the project plan's 3g).

Every project the workspace made is listed in its registry, ``WS#{ws}#PROJECT_IDS`` (shared/project_keys.py
``project_registry_pk``), each row read with its ``deleted_at`` (shared/project_tables.py ``registered_project``,
which reads any mark but null as deleted): a deleted project is skipped and counted, and none of its rows is
exported (its own partitions are never read; its review links' rows are read, to find the project they name, and
dropped; the objects phase still copies any object left under its ``ws/{ws}/projects/{id}/`` prefix, which the
per-project delete, 3h, removes with it). Each entity checks the registry again as it starts each project
(``_is_live``), so a project deleted while the export runs is skipped from then on (counted per entity,
``DELETED_DURING``). A row whose id is not shaped like a project id (``LONG_OPAQUE_ID_RE``, the claim's rule) names
no partition and is skipped and counted too; a row naming the company persona library's reserved id is skipped and
not counted (the library is walked anyway). After the registry, the workspace's company persona library
(shared/company_personas.py ``COMPANY_PERSONAS_CONTAINER``, which no registry lists) is walked like a project. Each
project's partitions are the ones shared/project_keys.py ``project_partitions`` names, by kind:

* ``projects_documents``: the project's own partition (kind ``project``), only the row kinds ``DOCUMENT_KINDS`` lists,
  each read by its own key condition: its ``META``, its documents (PR/FAQs, PRDs, research, custom documents,
  product reports, prototypes), its product documents' records (``PRODUCT_DOC#``: their uploads and extracted text
  are objects under ``ws/{ws}/projects/{id}/product_docs/``, which the objects phase copies) and its product context;
* ``personas``: the same partition's ``PERSONA#`` rows;
* ``document_versions``: its document versions and saved revisions (kind ``versions``,
  ``WS#{ws}#DOCUMENT_VERSIONS#PROJECT#{id}``: the revisions hold customer text);
* ``document_comments``: each series the project's partition lists (``COMMENT_SERIES#{series}``), then that series'
  threads (``WS#{ws}#DCOMMENTS#{project}#{series}``, its ``C#`` rows; never the ``SHARE`` row, which points at a link);
* ``project_jobs``: its jobs in voc-jobs (kind ``jobs``, ``JOB#`` rows), but an assist (``assist_*``: request
  plumbing, not work a person started, as the Background jobs panel leaves them out);
* ``project_lists``: its links to participant lists and people in voc-participants (kind ``lists``).

``review_links`` are found through the workspace's link registry, ``WS#{ws}#DOCSHARE_IDS``: each link's row
``WS#{ws}#DOCSHARE#{id}`` / ``META``, exported only when the project it names is a live one of the registry.

Every row is written with only the fields its entity exports: its ``*_FIELDS`` tuple, or, for the project's own
rows and its personas, the stored row through its classification (project_fields.py: every attribute the project
writers store is ``EXPORTED`` or ``EXCLUDED``, and an attribute in neither is left out and named in the manifest).
Never exported: a review link's id (the secret its URL carries) and its key, a thread's link id (only whether it came
from a link), the series' pointer row, a reviewer's email digest, the reviewers' daily counters (``DCRATE#``, never
read), a version counter's migration lease, a job's ``ttl`` and status index keys, who marked a thread addressed (the
API never shows it), and what project_fields.py excludes (credential-shaped attributes, a stored prototype URL, index
keys). Email addresses are exported as the workspace's own collaboration data: a project ``META``'s ``owner_email`` and
its ``members`` map, a link's audience and a reviewer's comments; and members' ids (an author, a link's creator, a
job's starter), which the members and audit entities already carry.

Every read is a Query of the workspace's own partitions through the workspace layer (shared/ws_repo.py
``WorkspaceTable``). The cursor carries where the registry's read is, the ids of its page still to do (the first is
the one being read), the part of that project and the Query's key; the comments add the project's series still to
do and where their listing is; the links the link ids of their registry page still to do. So a hand-over carries at
most a page of ids (100 ids of at most 128 characters, about 13 KB) and never a work object. Each page adds its
counts only once its rows are all written, and each row its own (an unclassified attribute) once it is written
(pages.py ``Page.tally``, ``Row.tally``, handler.py ``_write_pages``), so a hand-over never counts one twice or not
at all.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Final

from jobs.workspace_export.pages import TABLE_KEY, Page, Row, items, key, last_key, only, sort_key, start
from jobs.workspace_export.project_fields import EXCLUDED, EXPORTED, REFUSED, classified, nested_scrubbed
from shared.category_access import SCOPE_CONFIG_KEY
from shared.company_personas import COMPANY_PERSONAS_CONTAINER
from shared.deleted_sources import DOCUMENT_SORT_KEY_PREFIXES
from shared.document_comments import COMMENT_SK_PREFIX
from shared.engagement_config import PARTICIPANTS_TABLE_ENV
from shared.project_keys import (
    ASSIST_JOB_PREFIX,
    COMMENT_SERIES_PREFIX,
    PRODUCT_CONTEXT_SK,
    PRODUCT_DOC_SK_PREFIX,
    SERIES_ID_RE,
    comments_pk,
    project_partitions,
    project_pk,
    project_registry_pk,
    review_link_key,
    review_link_registry_pk,
)
from shared.project_tables import REGISTRY_PROJECTION, registered_project
from shared.project_walk import ID_PAGE, checked_ids, checked_key, is_project_id, query_page, registry_page
from shared.review_share_audience import is_share_id
from shared.scoped_query import SK_BEGINS, SK_EQUALS
from shared.tables import JOBS_TABLE_ENV
from shared.ws_repo import PROJECTS_TABLE_ENV, WorkspaceScope, WorkspaceTable

__all__ = ['DELETED_DURING', 'ENTITIES', 'UNCLASSIFIED', 'ProjectSource', 'add_tally', 'check_cursor']

#: The project entities, in the export's order (after the memory entities; a checkpoint names its phase).
ENTITIES: Final = ('projects_documents', 'personas', 'document_versions', 'document_comments', 'review_links',
                   'project_jobs', 'project_lists')
#: The entity whose registry pages are counted (each entity reads the registry; only this one counts it). Besides
#: each entity's rows the walk counts, for the manifest (entities.py ``_projects_section``): the registry's live
#: projects, the deleted ones and the malformed ids it skipped (``projects_live``, ``projects_deleted``,
#: ``projects_malformed``); and, counted by ``review_links``' own link steps, not by this entity, the links skipped
#: because their project is deleted or not the workspace's (``review_links_skipped``) or because their row is gone,
#: removed by its ``ttl`` (``review_links_expired``; a link past its expiry whose row is still there is exported);
#: by each entity, the projects found deleted as it reached them (``DELETED_DURING`` + the entity) and the nested keys
#: the secret-name check refused (project_fields.py ``REFUSED``); and, by ``projects_documents`` and ``personas``,
#: each attribute in neither of project_fields.py's lists, left out (``UNCLASSIFIED`` + its name).
_COUNTING: Final = ENTITIES[0]
#: The count of an attribute neither exported nor excluded (project_fields.py), by name: ``unclassified:{name}``.
UNCLASSIFIED: Final = 'unclassified:'
#: The most unclassified entries the run's counts keep, the ``UNCLASSIFIED_MORE`` bucket among them (``add_tally``).
MAX_UNCLASSIFIED_NAMES: Final = 50
UNCLASSIFIED_MORE: Final = '(more)'
#: The count of the projects an entity found deleted as it reached them, by entity: ``deleted_during:{entity}``.
DELETED_DURING: Final = 'deleted_during:'
#: The job configs that carry the starter's category scope (shared/category_access.py ``SCOPE_CONFIG_KEY``, an access
#: decision of the request, not the work): left out of each.
_CONFIGS: Final = ('filters', 'import_config', 'research_config', 'doc_config', 'merge_config')
#: A key condition on ``sk``: equal to the value, or beginning with it (shared/scoped_query.py's).
_EQUALS: Final = SK_EQUALS
_BEGINS: Final = SK_BEGINS
#: The row kinds of the project's own partition that ``projects_documents`` reads, each by its own key condition (an
#: allowlist: a kind a later release adds is never read until it is listed here).
DOCUMENT_KINDS: Final = ((_EQUALS, 'META'), (_EQUALS, PRODUCT_CONTEXT_SK),
                         *((_BEGINS, prefix) for prefix in (*DOCUMENT_SORT_KEY_PREFIXES, PRODUCT_DOC_SK_PREFIX)))
PERSONA_KIND: Final = (_BEGINS, 'PERSONA#')
#: A project job's rows in voc-jobs (shared/jobs.py ``_job_key``).
_JOB_KIND: Final = (_BEGINS, 'JOB#')

#: The fields each allowlisted entity exports, and no other (a field added to these rows later never reaches the
#: export by default).
#: A version partition's rows: a series' counter (without its migration lease, ``migration_owner`` and
#: ``migration_expires_at``), an allocation's history, a legacy assignment and an unmanaged document's saved revision.
VERSION_FIELDS: Final = (
    'pk', 'sk', 'document_id', 'document_type', 'base_title', 'normalized_base_title', 'title', 'version',
    'last_version', 'allocation_id', 'document_pk', 'document_sk', 'source_document_sk', 'revision', 'content',
    'saved_at', 'replaced_at', 'edit_kind', 'restored_from_version', 'created_at', 'updated_at',
)
#: A comment thread as the project's team sees it (shared/document_comments.py ``thread_view``, ``team``), plus its
#: key, its project and its marks' history; ``author``, ``replies``, ``addressed`` and ``addressed_history`` are
#: narrowed by ``_thread`` below.
THREAD_FIELDS: Final = (
    'pk', 'sk', 'comment_id', 'project_id', 'series_id', 'document_id', 'version', 'author', 'text', 'anchor',
    'status', 'status_by', 'flagged', 'verdict', 'replies', 'addressed', 'addressed_history', 'created_at',
    'updated_at',
)
#: An author: a member's id and name, a persona's id and name, a reviewer's address and name; never the digest.
AUTHOR_FIELDS: Final = ('kind', 'name', 'persona_id', 'sub', 'email')
REPLY_FIELDS: Final = ('reply_id', 'author', 'text', 'flagged', 'at')
#: A mark that a version answered a thread, without who made it (``by_sub``: the API never shows it).
ADDRESSED_FIELDS: Final = ('version', 'document_id', 'at', 'by_kind', 'addressed')
#: A review link without its id (the secret in its URL), its key, ``ttl`` and the derived ``expires_at_epoch``.
LINK_FIELDS: Final = (
    'project_id', 'document_id', 'series_id', 'document_type', 'base_title', 'audience', 'revoked', 'revoked_by',
    'created_at', 'created_by_sub', 'created_by_name', 'expires_at',
)
#: A project job (shared/jobs.py ``create_job`` / ``update_job_status``) and the config it was started with (under
#: the key its starter names, api/projects_handler.py); never its ``ttl`` or status index keys.
JOB_FIELDS: Final = (
    'pk', 'sk', 'job_id', 'project_id', 'job_type', 'status', 'progress', 'current_step', 'error', 'result',
    'created_at', 'updated_at', 'completed_at', 'initiated_by', 'filters', 'import_config', 'research_config',
    'doc_config', 'merge_config',
)
#: A project's link to a participant list or person (shared/participants_lists.py ``link``).
LIST_FIELDS: Final = ('pk', 'sk', 'target_id', 'added_at', 'added_by')

#: The per-project part of a cursor, as a project starts.
_PROJECT_START: Final = {'part': 0, 'start': None, 'series': [], 'series_from': None, 'series_listed': False,
                         'checked': False}


def _author(value: object) -> object:
    return only(value, AUTHOR_FIELDS) if isinstance(value, Mapping) else value


def _thread(item: Mapping[str, Any]) -> dict[str, Any]:
    """A thread with ``THREAD_FIELDS`` only, each author, reply and mark narrowed, and whether it came from a review
    link (its link id is that link's secret)."""
    shown = only(item, THREAD_FIELDS)
    shown['author'] = _author(item.get('author'))
    replies = item.get('replies')
    shown['replies'] = [{**only(reply, REPLY_FIELDS), 'author': _author(reply.get('author'))}
                        for reply in replies if isinstance(reply, Mapping)] if isinstance(replies, list) else []
    if isinstance(item.get('addressed'), Mapping):
        shown['addressed'] = only(item['addressed'], ADDRESSED_FIELDS)
    history = item.get('addressed_history')
    if isinstance(history, list):
        shown['addressed_history'] = [only(mark, ADDRESSED_FIELDS) for mark in history if isinstance(mark, Mapping)]
    shown['from_review_link'] = bool(item.get('share_id'))
    return shown


def _job(item: Mapping[str, Any]) -> dict[str, Any] | None:
    """A job with ``JOB_FIELDS`` only, each config without its category scope; None for an assist (request
    plumbing, not exported)."""
    if str(item.get('job_type') or '').startswith(ASSIST_JOB_PREFIX):
        return None
    shown = only(item, JOB_FIELDS)
    for name in _CONFIGS:
        if isinstance(shown.get(name), Mapping):
            shown[name] = {key: value for key, value in shown[name].items() if key != SCOPE_CONFIG_KEY}
    return shown


#: How each entity's rows are written (None: the row is left out), before the secret-name check of their nested
#: maps (project_fields.py ``nested_scrubbed``; ``classified`` runs it itself).
_SHOWN: Final[Mapping[str, Callable[[Mapping[str, Any]], dict[str, Any] | None]]] = {
    'document_comments': _thread, 'project_jobs': _job,
    'document_versions': lambda item: only(item, VERSION_FIELDS),
    'project_lists': lambda item: only(item, LIST_FIELDS),
}
#: The entities written through project_fields.py's classification.
_CLASSIFIED: Final = frozenset({'projects_documents', 'personas'})


def _shown(entity: str, item: Mapping[str, Any]) -> tuple[dict[str, Any] | None, int]:
    """``item`` as ``entity`` writes it (None: left out), and how many nested keys the secret-name check refused."""
    if entity in _CLASSIFIED:
        return classified(item)
    row = _SHOWN[entity](item)
    return (None, 0) if row is None else nested_scrubbed(row)


def _unclassified(entity: str, item: Mapping[str, Any]) -> dict[str, int]:
    """A classified entity's row's attributes in neither list (left out), each counted once, with the row."""
    if entity not in _CLASSIFIED:
        return {}
    return {f'{UNCLASSIFIED}{str(name)[:64]}': 1 for name in sorted(set(item) - EXPORTED - EXCLUDED)}


@dataclass(frozen=True)
class _Part:
    """One Query of a project: the kind of ``project_partitions`` it reads, and its key condition on ``sk``."""

    kind: str
    condition: tuple[str, str] | None = None


#: Each per-project entity's Queries, in order.
_PARTS: Final = {
    'projects_documents': tuple(_Part('project', condition) for condition in DOCUMENT_KINDS),
    'personas': (_Part('project', PERSONA_KIND),),
    'document_versions': (_Part('versions'),),
    'project_jobs': (_Part('jobs', _JOB_KIND),),
    'project_lists': (_Part('lists'),),
}


def _on_sk(condition: tuple[str, str] | None) -> dict[str, Any]:
    """``sort_key`` of one ``(expression, value)`` condition on ``sk`` (``:sk``), or none."""
    return {} if condition is None else sort_key(condition[0], {':sk': condition[1]})


def add_tally(counts: dict[str, int], tally: Mapping[str, int]) -> None:
    """Add ``tally`` to the run's ``counts`` (which every hand-over carries), keeping at most
    ``MAX_UNCLASSIFIED_NAMES`` unclassified entries, the ``UNCLASSIFIED_MORE`` bucket among them: a row's names can be
    anything a writer (or a model's answer) stored, so the first ``MAX_UNCLASSIFIED_NAMES - 1`` names are kept and
    any other counts under the bucket (7.43.00: before, 50 names and the bucket made 51 entries)."""
    more = f'{UNCLASSIFIED}{UNCLASSIFIED_MORE}'
    named = sum(1 for name in counts if name.startswith(UNCLASSIFIED) and name != more)
    for name, count in tally.items():
        kept = name
        if name.startswith(UNCLASSIFIED) and name not in counts:
            if name == more or named >= MAX_UNCLASSIFIED_NAMES - 1:
                kept = more
            else:
                named += 1
        counts[kept] = counts.get(kept, 0) + count


def check_cursor(cursor: Mapping[str, Any]) -> None:
    """A carried project entity's cursor, checked before the run goes on (handler.py ``RunState.from_event``): its
    ids each a project id, a series id or a review link id, as the walk would name them; ValueError for any other
    (the job then fails as a malformed run state), and each key it carries a map (shared/project_walk.py
    ``checked_key``)."""
    for name, valid in (('ids', is_project_id), ('series', SERIES_ID_RE.fullmatch), ('links', is_share_id)):
        checked_ids(cursor.get(name), valid, name)
    for name in ('registry', 'series_from', 'start'):
        checked_key(cursor.get(name))


class ProjectSource:
    """One workspace's project entities (``page``), through its views of voc-projects, voc-jobs and
    voc-participants."""

    def __init__(self, scope: WorkspaceScope, projects: WorkspaceTable, jobs: WorkspaceTable,
                 participants: WorkspaceTable) -> None:
        self.scope = scope
        self._projects = projects
        self._tables = {PROJECTS_TABLE_ENV: projects, JOBS_TABLE_ENV: jobs, PARTICIPANTS_TABLE_ENV: participants}

    def page(self, entity: str, cursor: Mapping[str, Any]) -> Page:
        if entity == 'review_links':
            return self._links_page(cursor)
        if entity == 'document_comments':
            return self._walk(entity, cursor, self._comments_page)
        return self._walk(entity, cursor, self._parts_page)

    # ── The walk: the registry's projects, then the library ─────────────────────────────────────────────────

    def _walk(self, entity: str, cursor: Mapping[str, Any],
              project_page: Callable[[str, str, dict[str, Any]], Page]) -> Page:
        """One step of ``entity``: the registry's next page of ids (no rows), or one page of the first project still
        to do; once the registry is read to its end, the company persona library, then the end."""
        here = {**_PROJECT_START, **cursor}
        ids = [str(project_id) for project_id in here.get('ids') or []]
        if not ids:
            if here.get('library'):
                return Page([], None)
            if here.get('registry_done'):
                return Page([], {**here, **_PROJECT_START, 'ids': [COMPANY_PERSONAS_CONTAINER], 'library': True})
            return self._registry_page(entity, here)
        if not is_project_id(ids[0]):
            # Only a carried cursor can hold one (the registry's are checked): the run state is malformed.
            raise ValueError('a carried project id is not a project id')
        if not here.get('library') and not here.get('checked'):
            # The registry read again as the project starts (as a link's step reads it): one deleted since the
            # registry page was read is skipped from here on, and counted.
            if not self._is_live(ids[0]):
                return Page([], {**here, **_PROJECT_START, 'ids': ids[1:]}, {f'{DELETED_DURING}{entity}': 1})
            here = {**here, 'checked': True}
        found = project_page(entity, ids[0], here)
        if found.following is None:
            return Page(found.rows, {**here, **_PROJECT_START, 'ids': ids[1:]}, found.tally)
        return found

    def _registry_page(self, entity: str, here: dict[str, Any]) -> Page:
        """A page of the registry, read with each row's ``deleted_at`` (shared/project_walk.py ``registry_page``): its
        live ids to do; its deleted and malformed ones skipped (counted by ``_COUNTING`` only), and the library's
        reserved id skipped (walked last anyway)."""
        page = registry_page(self._projects, self.scope, here.get('registry'))
        tally = {'projects_live': len(page.live), 'projects_deleted': len(page.ids) - len(page.live),
                 'projects_malformed': page.malformed} if entity == _COUNTING else {}
        last = page.following
        return Page([], {**here, **_PROJECT_START, 'registry': last, 'registry_done': last is None,
                         'ids': page.live}, tally)

    def _rows(self, entity: str, page: Mapping[str, Any], here: dict[str, Any]) -> list[Row]:
        """A page's rows as ``entity`` writes them, each with the cursor right after it (a row left out moves no
        cursor: the next row's, or the page's end, carries on past it)."""
        rows = []
        for item in items(page):
            row, refused = _shown(entity, item)
            if row is not None:
                tally = {**_unclassified(entity, item), **({REFUSED: refused} if refused else {})}
                rows.append(Row(row, {**here, 'start': key(item, TABLE_KEY)}, tally))
        return rows

    def _parts_page(self, entity: str, project_id: str, here: dict[str, Any]) -> Page:
        """One page of the project's current part (``_PARTS``); None as the following cursor once its parts are
        done."""
        parts = _PARTS[entity]
        index = int(here.get('part') or 0)
        if index >= len(parts):
            return Page([], None)
        part = parts[index]
        [partition] = [each for each in project_partitions(project_id, workspace=self.scope) if each.kind == part.kind]
        page = self._tables[partition.table_env].query('pk', partition.partition, **_on_sk(part.condition),
                                                       **start(here.get('start')))
        last = last_key(page)
        return Page(self._rows(entity, page, here), {**here, 'part': index if last else index + 1, 'start': last})

    def _comments_page(self, entity: str, project_id: str, here: dict[str, Any]) -> Page:
        """One page of the first series still to do; or, with none left, the next page of the project's series
        list (``COMMENT_SERIES#`` rows, their key alone); None as the following cursor once both are done."""
        series = [str(each) for each in here.get('series') or []]
        if not all(SERIES_ID_RE.fullmatch(each) for each in series):
            raise ValueError('a carried series id is not a series id')
        if series:
            page = self._projects.query('pk', comments_pk(project_id, series[0], workspace=self.scope),
                                        **_on_sk((_BEGINS, COMMENT_SK_PREFIX)), **start(here.get('start')))
            rows = self._rows(entity, page, here)
            last = last_key(page)
            return Page(rows, {**here, 'start': last} if last else {**here, 'series': series[1:], 'start': None})
        if here.get('series_listed'):
            return Page([], None)
        found, last = query_page(self._projects, project_pk(project_id, workspace=self.scope),
                                 checked_key(here.get('series_from')), Limit=ID_PAGE, ProjectionExpression='sk',
                                 **_on_sk((_BEGINS, COMMENT_SERIES_PREFIX)))
        listed = [str(item.get('sk', '')).removeprefix(COMMENT_SERIES_PREFIX) for item in found]
        return Page([], {**here, 'series': [each for each in listed if SERIES_ID_RE.fullmatch(each)],
                         'series_from': last, 'series_listed': last is None, 'start': None})

    # ── The review links ────────────────────────────────────────────────────────────────────────────────────

    def _links_page(self, cursor: Mapping[str, Any]) -> Page:
        """The first link still to do (its row read to find its project; exported when that project is live), or
        the link registry's next page of ids (no rows)."""
        links = [str(share_id) for share_id in cursor.get('links') or []]
        if not all(is_share_id(share_id) for share_id in links):
            raise ValueError('a carried review link id is not one')
        if not links:
            if cursor.get('done'):
                return Page([], None)
            listed, last = query_page(self._projects, review_link_registry_pk(workspace=self.scope),
                                      checked_key(cursor.get('registry')), Limit=ID_PAGE, ConsistentRead=True,
                                      ProjectionExpression='sk')
            ids = [str(item.get('sk', '')) for item in listed]
            return Page([], {'registry': last, 'done': last is None,
                             'links': [share_id for share_id in ids if is_share_id(share_id)]})
        following = {**cursor, 'links': links[1:]}
        link_key = review_link_key(links[0], workspace=self.scope)
        found = items(self._projects.query('pk', link_key['pk'], **_on_sk((_EQUALS, link_key['sk']))))
        if not found:
            # Its row is gone, removed by its ``ttl`` (30 days past its expiry; DynamoDB may take days more). A link
            # past its expiry whose row is still there is exported like any other, its expires_at saying so.
            return Page([], following, {'review_links_expired': 1})
        if not self._is_live(found[0].get('project_id')):
            return Page([], following, {'review_links_skipped': 1})
        row, refused = nested_scrubbed(only(found[0], LINK_FIELDS))
        return Page([Row(row, following, {REFUSED: refused} if refused else {})], following)

    def _is_live(self, project_id: object) -> bool:
        """Whether ``project_id`` is a live project of the workspace's registry (one Query of its one row)."""
        if not isinstance(project_id, str) or not is_project_id(project_id):
            return False
        page = self._projects.query('pk', project_registry_pk(workspace=self.scope), ConsistentRead=True,
                                    ProjectionExpression=REGISTRY_PROJECTION, **_on_sk((_EQUALS, project_id)))
        found = items(page)
        return bool(found) and not registered_project(found[0]).deleted
