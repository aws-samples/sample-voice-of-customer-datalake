"""What a workspace's export holds, read one page at a time, and its manifest (docs/multi-workspace.md, "Export and
delete", step 2).

Every read is a Query (``dynamodb:LeadingKeys`` cannot limit a Scan) of the workspace's own partitions, through the
workspace layer (shared/ws_repo.py):

* ``feedback``: voc-feedback's ``gsi1-by-date`` (every attribute projected), one partition per day,
  ``WS#{ws}#DATE#{yyyy-mm-dd}``, from the workspace's earliest date (``WS#{ws}#METRIC#meta`` / ``earliest_date``) to
  the day after the export started;
* from voc-aggregates (``ws_table``): ``plugin_configs`` (``WS#{ws}#PLUGIN_CONFIG``), ``plugin_config_history``
  (``#PLUGIN_CONFIG#HISTORY``: every list a save replaced, who saved it and who replaced it), ``feedback_forms``
  (``#FEEDBACK_FORM``), ``import_runs`` (each run's detail row ``#IMPORT_RUN#{run}``, found from its summary in
  ``#IMPORT_RUN``; the summary itself when the detail is gone) and ``erasure_jobs`` (``#JOB#erasure``, ``er_…`` rows,
  without ``value_hash``);
* from voc-workspaces (``control_query``): ``workspace`` (``WS#{ws}`` / ``META``), ``members`` (its ``MEMBER#``
  rows) and ``audit`` (``AUDIT#WS#{ws}``);
* from voc-memory (slice 4c, jobs/workspace_export/memory.py): the company memory only, ``memory_company``,
  ``memory_imports`` and ``memory_events``; personal memories and the extraction cursors are their owners' and are
  only counted;
* from voc-projects, voc-jobs and voc-participants (7.39.00, projects 3g-a, jobs/workspace_export/projects.py): the
  workspace's projects, found through its registry (a deleted project skipped and counted), each project's rows,
  personas, document versions, comment threads, jobs and list links, and the workspace's review links, found through
  its link registry; each entity only the fields or row kinds it lists.

The members' conversations in voc-conversations are their own: not included; only how many people have any is
counted (7.24.00, jobs/workspace_export/conversations.py).

Each page's rows come with the cursor that resumes right after them, so an invocation that runs out of time stops
after any row and the next one carries on from it.
"""
from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from datetime import date, timedelta
from typing import Any, Final

from jobs.workspace_export.memory import ENTITIES as MEMORY_ENTITIES
from jobs.workspace_export.memory import MemorySource
from jobs.workspace_export.pages import TABLE_KEY, Page, Row, items, key, last_key, sort_key, start
from jobs.workspace_export.project_fields import REFUSED
from jobs.workspace_export.projects import DELETED_DURING, UNCLASSIFIED, ProjectSource
from jobs.workspace_export.projects import ENTITIES as PROJECT_ENTITIES
from shared.dynamo_values import as_count, plain
from shared.earliest_date import EARLIEST_DATE_ATTRIBUTE, earliest_date_key, parse_iso_date
from shared.import_runs import DETAIL_SK, LIST_PK
from shared.indexes import FEEDBACK_BY_DATE_INDEX
from shared.metric_keys import DAILY_TOTAL_PK, metric_partition
from shared.onboarding import FEEDBACK_FORM_PK
from shared.retention import ERASURE_JOB_PREFIX
from shared.ws_repo import (
    WorkspaceScope,
    WorkspaceTable,
    control_query,
    date_pk,
    erasure_job_pk,
    plugin_config_history_pk,
    plugin_config_pk,
)

__all__ = ['ENTITIES', 'FILE_CAP', 'ExportRefused', 'Source', 'encode_row', 'manifest']

#: The entities in the order the export writes them, the first phases of a run (handler.py ``PHASES``: then the
#: objects, the memory counts, the conversations' count and the completion). A checkpoint names its phase, so an entity added in any position
#: never shifts a running export onto another: one that was past it across a deploy finishes without it (its count
#: reads 0), one that was before it writes it. A checkpoint from before phases were named is read by the 4b order.
#: The project entities (7.39.00) come last, after the memory's.
ENTITIES: Final = ('feedback', 'plugin_configs', 'feedback_forms', 'import_runs', 'erasure_jobs', 'workspace',
                   'members', 'audit', 'plugin_config_history', *MEMORY_ENTITIES, *PROJECT_ENTITIES)
#: The most one JSONL file holds (before compression): a longer entity continues in its next file.
FILE_CAP: Final = 256 * 1024 * 1024
#: The index key of a feedback row: its table key and gsi1's, the cursor that resumes after it.
_FEEDBACK_KEY: Final = ('pk', 'sk', 'gsi1pk', 'gsi1sk')
#: What an export never carries of a row: a hash of a person's value (it could confirm a guessed one): an erasure's
#: value hash, and an `account_created` audit row's email hash (shared/workspace_members.py).
_DROPPED: Final = {'erasure_jobs': ('value_hash',), 'audit': ('email_sha256',)}
#: At most this many rows a feedback page (a day may hold many: the page then continues within the day).
PAGE_LIMIT: Final = 500

#: What a later phase keys by workspace (docs/multi-workspace.md, Phases): nothing of it is the workspace's yet.
#: The projects, documents and personas are exported since 7.39.00 (projects.py); the agents and workflows are slice
#: 3g3.
NOT_PER_WORKSPACE: Final = ('agents_workflows', 'settings')
#: Rows of the workspace an export leaves out, and why.
NOT_EXPORTED: Final = {
    # The company memory is exported since 7.22.00 (memory.py); personal memories (since 7.22.00) and the members'
    # conversations (since 7.24.00, conversations.py: how many people have any) are only counted (EXCLUDED).
    'metrics': 'Derived: the METRIC# counters are rebuilt from the feedback (scripts/retention/rebuild_aggregates.py).',
    'runs': 'Operational: the source and scraper run records (SOURCE_RUN#, SCRAPER_RUN#).',
    'circuit_breaker': "Operational: the plugins' failure counts and breaker rows (FAILURES#, CIRCUIT#).",
    'logs': 'Operational: the validation and processing logs (LOGS#).',
    'watermarks': "Operational: each plugin's ingestion watermarks (voc-watermarks).",
    'idempotency': 'Operational: the processing claims (voc-idempotency).',
    'form_lookups': "Routing: each form's FORM# lookup row (the forms themselves are in feedback_forms).",
    'user_rows': "Routing: each member's USER# row behind their workspace list (the members are in members).",
    'participants': ("The workspace's participant lists, people and address guards (voc-participants' LIST#, "
                     'PERSON# and EMAIL# rows) are not in this release\'s export; a project\'s links to them are '
                     '(project_lists).'),
    'project_assists': ("Operational: a project's assist job rows (assist_*, request plumbing the Background jobs "
                        'panel does not show either); its other jobs are in project_jobs.'),
    'project_bookkeeping': ("Routing: the project and review link registries (PROJECT_IDS, DOCSHARE_IDS), each "
                            "project's list of its commented series (COMMENT_SERIES#), a series' pointer to its "
                            "current review link (SHARE) and each link's routing row; the projects and links they "
                            'list are exported.'),
}
#: What an export never holds, by design.
EXCLUDED: Final = {
    'credentials': ("A workspace's plugin credentials (SSM Parameter Store SecureStrings) are never exported: the "
                    'export job has no permission to read them. Save them again where the data is imported.'),
    'erasure_value_hash': "An erasure job's value hash is left out of erasure_jobs.",
    'email_hashes': "An audit row's email hash (a new account's) is left out of audit.",
    'memory_embeddings': ("A memory's embedding (a vector computed from its statement) is left out of memory_company: "
                          'it is derived, and is recomputed from the statement.'),
    'memory_derived': ("A memory's search_text (its statement in lower case, for search) and its status index keys "
                       '(gsi1pk, gsi1sk) are left out of memory_company: each is derived from the fields exported.'),
    'memory_people': ('Each memory entity exports only the fields it lists (any field added later stays out): a '
                      "company memory, the memory API's fields plus its key (pk, sk) and what a merge or an archive "
                      'writes (merged_from, archived_reason, archived_at); an import, the API\'s fields but '
                      'created_by_username, plus its key; an event, its key, action, at and detail. So never a '
                      "memory's supporter_set (hashes of its supporters' ids), an event's actor (a supporter's "
                      "hash), nor an import's created_by_hash or created_by_username. A company memory's "
                      "conflicts_with can hold a personal memory's id (an id only, never its content), and an "
                      "event's detail is exported whole."),
    'personal_memory': ("Personal memories and the extraction cursors are their owners' only (docs/memory.md): "
                        'never in the workspace export, only counted (memory.not_exported); personal memories\' '
                        'events are neither exported nor counted.'),
    'conversations': ("The members' assistant conversations in the workspace are not included, and a member gets no "
                      'copy of their own from this export; only how many people have any is given (conversations).'),
    'project_secrets': ("A review link's id (the secret its URL carries) and its key are left out of review_links, "
                        "and a comment's link id of document_comments (from_review_link says whether it came from "
                        "a link); a reviewer's email digest, the reviewers' daily write counters (DCRATE#), a "
                        "version counter's migration lease, a job's ttl and status index keys, who marked a comment "
                        'addressed (by_sub), a credential-shaped attribute (token_hash, secret_hash), a stored '
                        'prototype URL (prototype_url), an unused stored prompt (kiro_export_prompt), index keys '
                        "(gsi1pk, gsi1sk), a legacy migration's lease, a delete's fence and a job config's category "
                        'scope are never exported.'),
    'project_fields': ('document_versions, document_comments, review_links, project_jobs and project_lists export only '
                       'the fields each lists (any field added later stays out). projects_documents and personas '
                       'read only the row kinds they list (META, PRODUCT_CONTEXT, PRD#, PRFAQ#, RESEARCH#, DOC#, '
                       'PRODUCT_REPORT#, PROTOTYPE#, PRODUCT_DOC#; PERSONA#), each the stored row through its '
                       'classification: top-level attributes classified, exported or excluded (one in neither is '
                       "left out and named in projects.unclassified_fields), and a META's members entries narrowed "
                       'to role, username, name, email, added_by and added_at. In every project entity, nested maps '
                       'are exported after a secret-name check: a key at any depth whose name looks like a secret '
                       "(a token, secret, hash, digest, signature, password, credential and the like) is left out "
                       'and counted in projects.secret_named_fields_refused. The check reads key names only, never '
                       'values: a secret written under an ordinary name (pasted into a document\'s text, say) is '
                       'exported as it was stored.'),
}
#: Why the conversations are not in the export, in every conversations note.
_CONVERSATIONS_OWN: Final = ("The members' assistant conversations in the workspace are their own and are not "
                             'included, and a member gets no copy of their own from this export.')
#: What a reader of the conversations' count should know.
CONVERSATIONS_NOTE: Final = (f'{_CONVERSATIONS_OWN} people is how many people (current or former members) have at '
                             'least one conversation in the workspace, read when the export reached each of them. No '
                             "conversation count, person's id or conversation is given. Two exports compared show how "
                             'many people started or stopped keeping conversations here in between, so whether a given '
                             'member started using the assistant can be seen that way.')
#: The conversations' note for an export started before 7.24.00 and resumed past the point where they are counted.
CONVERSATIONS_NOT_COUNTED: Final = (f'{_CONVERSATIONS_OWN} Not counted in this export: it was started by an earlier '
                                    'release and had already passed the point where the conversations are counted '
                                    'when it resumed. Export again to include how many people have any.')
#: What a reader of the memory entities should know.
MEMORY_NOTE: Final = ("The workspace's company memory: every company memory (memory_company), the events of each "
                      '(memory_events) and the import rows (memory_imports; the imported files are among the '
                      'objects, under memory-imports/). Personal memories are their owners\' only (docs/memory.md) '
                      'and are not in the workspace export, nor are the extraction cursors (each points at a '
                      "member's session): those two are counted in memory.not_exported, approximately (the status "
                      "index is eventually consistent); personal memories' events are neither exported nor counted. "
                      'What every memory row leaves out is in excluded.')
#: The manifest's memory note for an export started before 7.22.00 and resumed past the memory entities.
MEMORY_NOT_RUN: Final = ('Not in this export: it was started by an earlier release and had already passed the point '
                         'where the memory entities are written when it resumed, so memory_company, memory_events '
                         'and memory_imports are empty here. Export again to include the company memory.')
#: What a reader of the project entities should know (7.39.00).
PROJECTS_NOTE: Final = (
    "The workspace's projects, found through its registry of project ids: each live project's rows "
    '(projects_documents), personas, document versions and saved revisions (document_versions), comment threads '
    '(document_comments), jobs (project_jobs) and links to participant lists and people (project_lists), and the '
    "workspace's company persona library (its META in projects_documents, its personas in personas); then its review "
    'links (review_links), each exported only when its project is live. A project deleted in the workspace is skipped '
    'and counted (deleted_skipped): none of its rows is exported (its links\' rows are read to find their project), '
    "but any object left under its projects/<project id>/ prefix is still in objects until the project's own delete "
    'removes it (a later release); one deleted while the export ran is skipped by each entity that reaches it after '
    '(deleted_during_export). A registry row not shaped like a project id is skipped and counted (malformed_skipped). '
    "Email addresses are exported as the workspace's own collaboration data: a project META's owner_email and its "
    "members map (each member's id, role, name and email), a review link's audience and a reviewer's comments and replies; so are members' "
    "ids (an author, a link's creator, a job's starter), as the members entity carries the members. Each entity "
    'reads the registry again, so a project deleted while the export ran can be in some entities and not in others. '
    'What every project row leaves out is in excluded.')
#: Where a project's product documents are (their records are in projects_documents).
PRODUCT_DOCUMENTS_NOTE: Final = (
    "A product document's record (PRODUCT_DOC#) is in projects_documents; its upload and its extracted text are "
    'objects under projects/<project id>/product_docs/ (raw/ and extracted/), in objects.')
#: The manifest's projects note for an export started before 7.39.00 and resumed past the project entities.
PROJECTS_NOT_RUN: Final = ('Not in this export: it was started by an earlier release and had already passed the point '
                           'where the project entities are written when it resumed, so they are empty here. Export '
                           'again to include the projects.')


def _shown(entity: str, item: Mapping[str, Any]) -> dict[str, Any]:
    """``item`` as the export writes it: without what ``_DROPPED`` leaves out of ``entity``."""
    dropped = _DROPPED.get(entity, ())
    return {name: value for name, value in item.items() if name not in dropped}


class ExportRefused(RuntimeError):
    """The export cannot be made complete; its message names no row and says what to do (the job row's error)."""


FEEDBACK_START_UNKNOWN: Final = ('The workspace counts feedback but records no first day for it (no earliest date '
                                 'and no daily counter): rebuild its counters, then export again.')


class Source:
    """One workspace's entities, through its views of voc-feedback and voc-aggregates (``ws_table``) and voc-workspaces
    (read by ``control_query`` only), voc-memory (``memory``) and the project tables (``projects``)."""

    def __init__(self, scope: WorkspaceScope, feedback: WorkspaceTable, aggregates: WorkspaceTable,
                 workspaces: Any, memory: WorkspaceTable, projects: ProjectSource) -> None:
        self.scope = scope
        self._feedback = feedback
        self._aggregates = aggregates
        self._workspaces = workspaces
        self.memory = MemorySource(scope, memory)
        self.projects = projects

    # ── Where each entity starts ────────────────────────────────────────────────────────────────────────────

    def first_cursor(self, entity: str, started: date) -> dict[str, Any] | None:
        """The cursor of ``entity``'s first page, or None when it holds nothing to read (no feedback yet)."""
        if entity != 'feedback':
            return {'start': None}
        known = [day for day in (self._earliest_date(), self._first_counted_day()) if day is not None]
        if not known:
            # No feedback, or feedback with no first day on record: never an export that quietly holds none of it.
            if self.daily_total() > 0:
                raise ExportRefused(FEEDBACK_START_UNKNOWN)
            return None
        last = started + timedelta(days=1)
        return {'day': min(*known, last).isoformat(), 'last': last.isoformat(), 'start': None}

    def _earliest_date(self) -> date | None:
        item = self._aggregates.get_item(earliest_date_key(self.scope), ConsistentRead=True).get('Item')
        return parse_iso_date(item.get(EARLIEST_DATE_ATTRIBUTE)) if isinstance(item, Mapping) else None

    def _first_counted_day(self) -> date | None:
        """The first day of the workspace's ``daily_total`` counters (their ``sk``), a check on the watermark."""
        page = self._aggregates.query('pk', metric_partition(self.scope, DAILY_TOTAL_PK), Limit=1)
        first = items(page)
        return parse_iso_date(first[0].get('sk')) if first else None

    # ── One page ────────────────────────────────────────────────────────────────────────────────────────────

    def page(self, entity: str, cursor: Mapping[str, Any]) -> Page:
        if entity == 'feedback':
            return self._feedback_page(cursor)
        if entity == 'import_runs':
            return self._import_runs_page(cursor)
        if entity in MEMORY_ENTITIES:
            # Already only the fields each memory entity lists (memory.py ``FIELDS``).
            return self.memory.page(entity, cursor)
        if entity in PROJECT_ENTITIES:
            # Already only the fields each project entity exports (projects.py ``_SHOWN``).
            return self.projects.page(entity, cursor)
        if entity in _AGGREGATE_PARTITIONS:
            partition, condition, values = _AGGREGATE_PARTITIONS[entity](self.scope)
            page = self._aggregates.query('pk', partition, **sort_key(condition, values), **start(cursor.get('start')))
            return self._rows(entity, page)
        which, condition, values = _CONTROL_PARTITIONS[entity]
        page = control_query(self.scope, self._workspaces, which, **sort_key(condition, values),
                             **start(cursor.get('start')))
        return self._rows(entity, page)

    def _rows(self, entity: str, page: Mapping[str, Any]) -> Page:
        rows = [Row(_shown(entity, item), {'start': key(item, TABLE_KEY)}) for item in items(page)]
        last = last_key(page)
        return Page(rows, {'start': last} if last else None)

    def _feedback_page(self, cursor: Mapping[str, Any]) -> Page:
        day, last_day = str(cursor['day']), str(cursor['last'])
        page = self._feedback.query('gsi1pk', date_pk(self.scope, day), IndexName=FEEDBACK_BY_DATE_INDEX,
                                    Limit=PAGE_LIMIT, **start(cursor.get('start')))
        rows = [Row(item, {'day': day, 'last': last_day, 'start': key(item, _FEEDBACK_KEY)})
                for item in items(page)]
        following = last_key(page)
        if following is not None:
            return Page(rows, {'day': day, 'last': last_day, 'start': following})
        next_day = date.fromisoformat(day) + timedelta(days=1)
        if next_day > date.fromisoformat(last_day):
            return Page(rows, None)
        return Page(rows, {'day': next_day.isoformat(), 'last': last_day, 'start': None})

    def _import_runs_page(self, cursor: Mapping[str, Any]) -> Page:
        """Each run's detail row (its summary's fields and its warnings and errors), the summary when it is gone."""
        page = self._aggregates.query('pk', self.scope.key(LIST_PK), **start(cursor.get('start')))
        rows = []
        for summary in items(page):
            run_id = summary.get('run_id')
            detail = None
            if isinstance(run_id, str) and run_id:
                found = self._aggregates.get_item({'pk': self.scope.key(LIST_PK, run_id), 'sk': DETAIL_SK})
                detail = found.get('Item')
            rows.append(Row(dict(detail) if isinstance(detail, Mapping) else summary,
                            {'start': key(summary, TABLE_KEY)}))
        last = last_key(page)
        return Page(rows, {'start': last} if last else None)

    # ── The counts check ────────────────────────────────────────────────────────────────────────────────────

    def daily_total(self) -> int:
        """The sum of the workspace's ``daily_total`` counters (``WS#{ws}#METRIC#daily_total``, every day)."""
        rows = self._aggregates.iter_query('pk', metric_partition(self.scope, DAILY_TOTAL_PK))
        return sum(as_count(row.get('count')) for row in rows)


def _erasure_jobs(scope: WorkspaceScope) -> tuple[str, str | None, dict[str, str]]:
    return erasure_job_pk(scope), 'begins_with(#sk, :prefix)', {':prefix': ERASURE_JOB_PREFIX}


#: An aggregates entity: its partition, and the sort condition and values that keep its own rows (a lock row out).
_AGGREGATE_PARTITIONS: Final = {
    'plugin_configs': lambda scope: (plugin_config_pk(scope), None, {}),
    'plugin_config_history': lambda scope: (plugin_config_history_pk(scope), None, {}),
    'feedback_forms': lambda scope: (scope.key(FEEDBACK_FORM_PK), None, {}),
    'erasure_jobs': _erasure_jobs,
}
#: A control-plane entity: its partition (``control_query``), sort condition and values.
_CONTROL_PARTITIONS: Final = {
    'workspace': ('meta', '#sk = :meta', {':meta': 'META'}),
    'members': ('meta', 'begins_with(#sk, :member)', {':member': 'MEMBER#'}),
    'audit': ('audit', None, {}),
}


def _bytes(value: object) -> str:
    """A binary attribute as base64 text (json cannot carry bytes)."""
    raw = getattr(value, 'value', value)
    if isinstance(raw, bytes | bytearray):
        return base64.b64encode(bytes(raw)).decode('ascii')
    raise TypeError(f'not exportable: {type(value).__name__}')


def encode_row(item: Mapping[str, Any]) -> bytes:
    """One JSONL line: the row as stored (numbers as numbers, sets as sorted lists, binary as base64), keys sorted."""
    return (json.dumps(plain(item), ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=_bytes)
            + '\n').encode('utf-8')


def _conversations_section(people: int | None) -> dict[str, Any]:
    """The manifest's ``conversations``: how many people have any (a finished count: the phase ends only once it is
    done), or that they were not counted (``counted`` False, ``people`` null)."""
    if people is None:
        return {'counted': False, 'people': None, 'note': CONVERSATIONS_NOT_COUNTED}
    return {'counted': True, 'people': people, 'note': CONVERSATIONS_NOTE}


def _named(counts: Mapping[str, int], prefix: str) -> dict[str, int]:
    """The counts named ``{prefix}{name}``, by name."""
    return {name.removeprefix(prefix): int(count) for name, count in sorted(counts.items()) if name.startswith(prefix)}


def _projects_section(counts: Mapping[str, int], *, exported: bool) -> dict[str, Any]:
    """The manifest's ``projects``: the registry's live projects, the deleted and malformed ids skipped, the review
    links skipped because their project is not a live one or their row is gone (removed by its ``ttl``; a link past
    its expiry whose row is still there is exported, its ``expires_at`` saying so), each attribute left out because
    project_fields.py classifies it neither way (``unclassified_fields``: how many rows held it), and where the
    product documents are; or, for a run resumed past the project entities, that they are not in this export."""
    return {'exported': exported, 'note': PROJECTS_NOTE if exported else PROJECTS_NOT_RUN,
            'live': int(counts.get('projects_live', 0)),
            'deleted_skipped': int(counts.get('projects_deleted', 0)),
            'malformed_skipped': int(counts.get('projects_malformed', 0)),
            'review_links_skipped': int(counts.get('review_links_skipped', 0)),
            'review_links_expired': int(counts.get('review_links_expired', 0)),
            'unclassified_fields': _named(counts, UNCLASSIFIED),
            'deleted_during_export': _named(counts, DELETED_DURING),
            'secret_named_fields_refused': int(counts.get(REFUSED, 0)),
            'product_documents': PRODUCT_DOCUMENTS_NOTE}


def manifest(*, export_id: str, scope: WorkspaceScope, workspace: Mapping[str, Any], created_at: str,
             completed_at: str, files: Mapping[str, list[str]], counts: Mapping[str, int],
             daily_total: int, objects: Mapping[str, Any], memory_left_out: Mapping[str, tuple[int, bool]],
             conversations: int | None, memory_exported: bool = True, projects_exported: bool = True) -> bytes:
    """``manifest.json``: every entity with its files and count, the counts check against the workspace's
    ``daily_total`` counters, what is not per workspace yet, not exported or excluded, the workspace's objects
    (``objects``: jobs/workspace_export/objects.py ``manifest_section``), and the memory left out (``memory_left_out``:
    ``{what: (count, complete)}``, counted by jobs/workspace_export/memory.py; ``complete`` is always true once
    counted, since the phase ends only when its counts are done). ``memory_exported`` False (a run
    resumed from an earlier release's checkpoint past the memory entities) lists ``memory`` as not exported.
    ``conversations``: how many people have any (jobs/workspace_export/conversations.py), None for a run resumed
    from an earlier release's checkpoint past their count (the section then says they were not counted).
    ``projects_exported`` False (a run resumed from a checkpoint of an earlier release past the project entities)
    lists ``projects`` as not exported; the ``projects`` section counts the projects (``_projects_section``)."""
    feedback = int(counts.get('feedback', 0))
    not_exported = dict(NOT_EXPORTED)
    if not memory_exported:
        not_exported['memory'] = MEMORY_NOT_RUN
    if not projects_exported:
        not_exported['projects'] = PROJECTS_NOT_RUN
    document = {
        'format': 'voc-workspace-export',
        'version': 1,
        'export_id': export_id,
        'workspace': {'id': scope.ws, 'name': workspace.get('name'), 'slug': workspace.get('slug')},
        'created_at': created_at,
        'completed_at': completed_at,
        'entities': {entity: {'files': list(files.get(entity, [])), 'count': int(counts.get(entity, 0))}
                     for entity in ENTITIES},
        'counts_check': {
            'feedback': feedback, 'daily_total': daily_total, 'matches': feedback == daily_total,
            'note': ('The feedback exported, against the sum of the daily_total counters. A difference means items '
                     'without a date, counters that expired, or items that arrived while the export ran.'),
        },
        'memory': {
            'note': MEMORY_NOTE if memory_exported else MEMORY_NOT_RUN,
            'not_exported': {what: {'count': count, 'complete': complete, 'approximate': True}
                             for what, (count, complete) in memory_left_out.items()},
        },
        'conversations': _conversations_section(conversations),
        'projects': _projects_section(counts, exported=projects_exported),
        'not_per_workspace': {name: {'status': 'not_per_workspace', 'phase': 3, 'count': 0}
                              for name in NOT_PER_WORKSPACE},
        'not_exported': not_exported,
        'excluded': dict(EXCLUDED),
        'objects': dict(objects),
    }
    return (json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode('utf-8')
