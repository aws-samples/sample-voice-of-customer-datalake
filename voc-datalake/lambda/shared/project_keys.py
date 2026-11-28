"""The keys of a project's rows: the one place they are spelled (docs/multi-workspace.md, phase 3).

A project's rows sit in one partition, ``PROJECT#{id}``: its ``META`` row and every child (personas, documents,
prototypes, research, pins, the product context) in voc-projects, its jobs in voc-jobs, its participant lists in
voc-participants. The project rows are listed through ``gsi1-by-type`` at ``TYPE#PROJECT``; a project's documents and
personas carry ``PROJECT#{id}#DOCUMENTS`` / ``#PERSONAS`` in ``gsi1pk``.

Inside a workspace (plumbing since 7.21.00: no route passes one yet) every builder takes the workspace
(``WorkspaceScope``) and gives the same key inside it (shared/scoped_keys.py ``scoped_pk``): ``WS#{ws}#PROJECT#{id}``,
``WS#{ws}#PROJECT#{id}#DOCUMENTS`` / ``#PERSONAS`` and the type partition ``WS#{ws}#TYPE#PROJECT``. Without one (None)
each gives exactly the deployment's key above. ``project_id_of`` reads a stored ``pk`` back for one scope (the
project's id, or None when it is not one of that scope's project partitions), so a reader never takes another
scope's partition for one of its projects. A workspace also keeps a registry of its project ids (since 7.26.00),
``WS#{ws}#PROJECT_IDS`` / ``{id}`` (``project_registry_key``); the deployment-wide claim of an id, ``PROJECT_ID#{id}``,
is the workspace layer's own (shared/ws_repo.py ``claim_project_id``).

A project's document versions (shared/document_versions.py, shared/document_history.py, shared/human_documents.py) keep
their bookkeeping in a partition of their own, ``DOCUMENT_VERSIONS#PROJECT#{id}`` (``version_partition_key``;
``WS#{ws}#DOCUMENT_VERSIONS#PROJECT#{id}`` in a workspace, since 7.27.00): a series' counter
(``version_counter_key``), an allocation's history (``version_allocation_key``), a legacy document's assignment
(``legacy_assignment_key``, in its counter's partition) and an unmanaged document's revisions
(``document_revision_key``).

A series' comment threads and its review link's pointer sit in ``DCOMMENTS#{project}#{series}`` (``comments_pk``), a
review link in ``DOCSHARE#{id}`` (``review_link_key``) and a reviewer's daily counter in ``DCRATE#…``
(``reviewer_rate_pk``); in a workspace (since 7.37.00) each inside it, the project's commented series listed in its
own partition (``comment_series_key``), the workspace's links in ``WS#{ws}#DOCSHARE_IDS`` (``review_link_registry_key``)
and each link's deployment-wide routing row the workspace layer's own (shared/ws_repo.py ``route_share_id``). Since
7.48.00 (3g-d) the deployment keeps the same two lists, each one deployment-wide partition: its links in
``DOCSHARE_IDS`` (``deployment_link_registry_key``) and its commented series in ``COMMENT_SERIES_IDS``
(``deployment_series_registry_key``), not in each project's partition, which a deployment project's delete empties
(shared/review_registries.py says why and how an erasure reads them).

Every module builds these through here (but the product-doc extractor, a stdlib-only bundle with no ``shared/``,
which spells ``PROJECT#{id}`` itself: product_doc_extractor/handler.py); shared/test/test_ws_raw_access.py counts
the modules that read project tables or spell these keys.
"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING, Final, NamedTuple

from shared.digests import sha256_hex
from shared.review_share_audience import REVIEWER_ROUTES_STORE, SHARE_PK_PREFIX, SHARE_SK
from shared.scoped_keys import scoped_object_key, scoped_pk

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

__all__ = ['AGENT_RUNS_STORE', 'ASSIST_JOB_PREFIX', 'COMMENT_PARTITION_PREFIX', 'COMMENT_SERIES_PREFIX',
           'DEPLOYMENT_LINK_REGISTRY_PK', 'DEPLOYMENT_PROJECT_REGISTRY_PK', 'DEPLOYMENT_SERIES_REGISTRY_PK',
           'PRODUCT_CONTEXT_SK',
           'PRODUCT_DOC_SK_PREFIX', 'PRODUCT_EXTRACT_SK', 'PRODUCT_EXTRACT_STORE', 'PRODUCT_PROPOSAL_SK_PREFIX',
           'PROJECT_GATE_STORE', 'PROJECT_JOB_WORK_STORE',
           'PROJECT_TYPE_PK', 'PROTOTYPE_BUILDER_STORE', 'PROTOTYPE_SK_PREFIX', 'REVIEWER_ROUTES_STORE',
           'REVIEW_REGISTRIES_MARKER_KEY', 'REVIEW_REGISTRIES_MARKER_SK', 'REVISE_FROM_COMMENTS_STORE', 'SERIES_ID_RE', 'NotPerWorkspaceError',
           'ProjectPartition', 'comment_partition_ids', 'comment_series_item', 'comments_pk',
           'deployment_link_registry_key', 'deployment_project_item', 'deployment_series_item',
           'document_keys', 'document_listing', 'document_revision_key',
           'document_revisions_prefix', 'job_status_pk',
           'legacy_assignment_key', 'legacy_assignment_prefix', 'persona_keys', 'personas_index_pk', 'product_docs_prefix',
           'project_id_of',
           'project_partitions', 'project_pk', 'project_registry_key', 'project_registry_pk', 'project_type_pk',
           'require_deployment', 'review_link_key', 'review_link_registry_key', 'review_link_registry_pk',
           'reviewer_rate_pk', 'series_registry_ids',
           'version_allocation_key', 'version_counter_key', 'version_partition_key']

#: The start of every project partition of the deployment (a reader that tells a project's partition from another's).
PROJECT_PREFIX: Final = 'PROJECT#'
#: ``gsi1-by-type``'s partition of the deployment's project rows (``META``).
PROJECT_TYPE_PK: Final = 'TYPE#PROJECT'
#: The start of a project's document-version partition (``version_partition_key``).
_DOCUMENT_VERSIONS_PREFIX: Final = f'DOCUMENT_VERSIONS#{PROJECT_PREFIX}'
#: The sort-key starts of an allocation's history, a legacy document's assignment and an unmanaged document's revision.
_ALLOCATION_PREFIX: Final = 'ALLOCATION#'
_LEGACY_ASSIGNMENT_PREFIX: Final = 'LEGACY_ASSIGNMENT#'
_REVISION_PREFIX: Final = 'REVISION#'
#: The start of a project job's status partition in voc-jobs' ``gsi1-by-status`` (``job_status_pk``).
_JOB_STATUS_PREFIX: Final = 'STATUS#'
#: The partition of a series' comment threads and its review link's pointer (shared/document_comments.py,
#: shared/document_share.py): ``DCOMMENTS#{project}#{series}`` (``comments_pk``).
_COMMENTS_PREFIX: Final = 'DCOMMENTS#'
#: The same start, for a reader that tells a deployment's comment partition from a Scan's other rows (3g-d).
COMMENT_PARTITION_PREFIX: Final = _COMMENTS_PREFIX
#: The sort-key start of a project's list of its commented series, in the project's own partition (a workspace's
#: only: ``comment_series_key``), so a delete finds every comment partition by a Query.
COMMENT_SERIES_PREFIX: Final = 'COMMENT_SERIES#'
#: A reviewer's writes on one review link in one UTC day (shared/document_share.py ``count_reviewer_write``).
_REVIEWER_RATE_PREFIX: Final = 'DCRATE#'
#: A workspace's registry of its review link ids, one row per link, ``WS#{ws}#DOCSHARE_IDS`` / ``{share id}``.
_REVIEW_LINK_REGISTRY: Final = 'DOCSHARE_IDS'
#: The deployment's own registries (since 7.48.00, projects 3g-d): its review links, ``DOCSHARE_IDS`` / ``{share id}``
#: (``deployment_link_registry_key``), and its commented series, ``COMMENT_SERIES_IDS`` / ``{project}#{series}``
#: (``deployment_series_registry_key``), each one deployment-wide partition, so an erasure by email finds every link
#: and comment partition of the deployment by a Query. ``REVIEW_REGISTRIES_MARKER_SK``, a row of the link registry,
#: says the backfill (scripts/projects/backfill_review_registries.py) listed everything made before 7.48.00; until it
#: is there, an erasure finds them by its own Scan.
DEPLOYMENT_LINK_REGISTRY_PK: Final = _REVIEW_LINK_REGISTRY
DEPLOYMENT_SERIES_REGISTRY_PK: Final = 'COMMENT_SERIES_IDS'
REVIEW_REGISTRIES_MARKER_SK: Final = 'MIGRATION#review-registries'
#: The marker's key, the one copy (the backfill and the switch's reader, shared/project_scope.py, both name it).
REVIEW_REGISTRIES_MARKER_KEY: Final = {'pk': DEPLOYMENT_LINK_REGISTRY_PK, 'sk': REVIEW_REGISTRIES_MARKER_SK}
#: ``REVIEWER_ROUTES_STORE`` (imported above): a review link kept in a workspace, refused by its reviewer routes and its
#: sign-up trigger alike until the switch (3h); defined in the stdlib module the trigger bundle ships, re-exported here
#: beside the other stores that refuse a workspace.
#: The project access gate (shared/project_access.py, shared/project_gate.py): since 7.101.00 (3h-S2) it decides a
#: workspace's project from the caller's membership there, but the callers that hold no membership yet (the persona
#: copy, the voice sessions, the persona grounding, the participants' gate) refuse a workspace under this name.
PROJECT_GATE_STORE: Final = 'Project gate'
#: The work of a project job (since 7.29.00: the document generator and merger, the persona generator and importer,
#: the research steps). Its job row is per workspace (shared/jobs.py), but the work reads the deployment's feedback,
#: its prompt labels and company context, and writes under the deployment's object prefixes, so a job event that
#: names a workspace marks its own row failed and does nothing else until the switch (3h).
PROJECT_JOB_WORK_STORE: Final = 'Project job work'
#: voc-agent-run's agent runs and plans (agents/conductor, agents/nodes, agents/persona_panel): the agent rows are the
#: deployment's, and a plan takes its workspace from its own META, so a state that names one is refused (since 7.29.00),
#: but for the failure states, which mark the run's or the plan's own row failed.
AGENT_RUNS_STORE: Final = 'Agent runs'
#: "Revise from comments" (shared/document_revision.py; its series-head check and its next version,
#: shared/document_history.py ``require_series_head`` / ``revise_document``): it reads the deployment's feedback as
#: evidence and writes the series' next version on the deployment's version keys, so a workspace is refused (since the
#: merge in 7.37.00) until the switch (3h) threads it.
REVISE_FROM_COMMENTS_STORE: Final = 'Revise from comments'
#: The Prototype builder (docs/prototype-builder.md: shared/prototype_versions.py ``PrototypeStore`` and its HTML
#: objects, shared/prototype_drafts.py, shared/prototype_feedback.py, shared/prototype_incorporation.py; the series
#: head of shared/document_versions.py ``series_head_version``): its version rows, draft job rows, pin-form reads and
#: objects are the deployment's, so a workspace is refused (since the merge in 7.37.00) until the switch (3h).
PROTOTYPE_BUILDER_STORE: Final = 'Prototype builder'
#: A workspace's registry of its project ids, one row per project, ``WS#{ws}#PROJECT_IDS`` / ``{id}``.
_PROJECT_REGISTRY: Final = 'PROJECT_IDS'
#: The deployment's own registry of its project ids, ``PROJECT_IDS`` / ``{id}`` (since 7.48.00, projects 3g-d;
#: ``deployment_project_registry_key``): put at a project's create, never removed by its delete (which takes the
#: tombstoned ``META`` off ``gsi1-by-type``), so an erasure by email finds a deleted project's rows too.
DEPLOYMENT_PROJECT_REGISTRY_PK: Final = _PROJECT_REGISTRY
#: A project's product context row and its product documents' records, in the project's partition (the context read
#: and written by shared/product_proposals.py, the records by shared/product_sources.py and api/product_context.py,
#: which names their prefix ``DOC_SK_PREFIX``; the workspace export reads them).
PRODUCT_CONTEXT_SK: Final = 'PRODUCT_CONTEXT'
PRODUCT_DOC_SK_PREFIX: Final = 'PRODUCT_DOC#'
#: A prototype document's row in its project's partition (api/projects_handler.py; the erasure's pins walk, 7.98.00).
PROTOTYPE_SK_PREFIX: Final = 'PROTOTYPE#'
#: A project's product proposals (7.104.00), in the project's partition: one per extract of its product sources,
#: ``PRODUCT_PROPOSAL#{iso}#{hex}`` (its creation time, then a random suffix), so the newest sorts last.
PRODUCT_PROPOSAL_SK_PREFIX: Final = 'PRODUCT_PROPOSAL#'
#: A project's extract lock (7.104.00, shared/product_proposals.py): one row, held while one extract runs (its
#: ``lock_id``), stale after 16 minutes; released by an update, never deleted (a project delete sweeps it). Neither
#: the workspace export nor the project bundle carries it.
PRODUCT_EXTRACT_SK: Final = 'PRODUCT_EXTRACT'
#: The Product tab's extract (7.104.00): its proposal's put, its lock and its limits' counters
#: (shared/product_proposals.py), reached only by the extract's route and its document-generator job, refused in a
#: workspace until that job moves (3h-S8). The sources, the context and the proposals' review take the workspace since
#: 7.106.00 (3h-S3b), which retired the store name they were refused by, ``Product sources``.
PRODUCT_EXTRACT_STORE: Final = 'The product extract'
#: A series id's shape (shared/document_series.py ``series_id``: ``ser_`` + 24 hex), which a reader of a project's
#: ``COMMENT_SERIES#`` rows checks before it names a comment partition (the hard delete, the workspace export).
SERIES_ID_RE: Final = re.compile(r'ser_[0-9a-f]{24}')
#: The start of an assist's ``job_type`` (shared/assist_jobs.py): request plumbing kept in a project's job partition,
#: which the Background jobs panel and the workspace export leave out.
ASSIST_JOB_PREFIX: Final = 'assist_'


class NotPerWorkspaceError(RuntimeError):
    """A workspace reached a project store that is not per workspace yet: a programming error (500), never a
    fallback to the deployment's keys."""


def require_deployment(workspace: WorkspaceScope | None, store: str) -> None:
    """Fail closed (``NotPerWorkspaceError``) when a workspace reaches ``store``, a project store not per workspace
    yet (the access gate, a project job's work, the agent runs, a review link's reviewer routes, Revise from
    comments and the Prototype builder, slice 3h;
    docs/multi-workspace.md)."""
    if workspace is not None:
        raise NotPerWorkspaceError(f'{store} is not per workspace yet')


def _project_prefix(workspace: WorkspaceScope | None) -> str:
    """How every project partition of the scope starts: ``PROJECT#``, or ``WS#{ws}#PROJECT#`` in a workspace."""
    return PROJECT_PREFIX if workspace is None else f'{workspace.prefix}{PROJECT_PREFIX}'


def project_pk(project_id: str, *, workspace: WorkspaceScope | None) -> str:
    """A project's partition: its rows in voc-projects, its jobs in voc-jobs, its lists in voc-participants
    (``PROJECT#{id}``; ``WS#{ws}#PROJECT#{id}`` in a workspace)."""
    return scoped_pk(workspace, f'{PROJECT_PREFIX}{project_id}')


def project_type_pk(*, workspace: WorkspaceScope | None) -> str:
    """``gsi1-by-type``'s partition of the scope's project rows: ``TYPE#PROJECT``, ``WS#{ws}#TYPE#PROJECT``."""
    return scoped_pk(workspace, PROJECT_TYPE_PK)


def project_registry_pk(*, workspace: WorkspaceScope) -> str:
    """The workspace's registry of its project ids in voc-projects: ``WS#{ws}#PROJECT_IDS`` (since 7.26.00). A Query
    of it, knowing only the workspace, names every project made there (the export, the delete, an erasure)."""
    return workspace.key(_PROJECT_REGISTRY)


def project_registry_key(project_id: str, *, workspace: WorkspaceScope) -> dict[str, str]:
    """A project's row in its workspace's registry: ``WS#{ws}#PROJECT_IDS`` / ``{id}``, written in the same
    transaction as the project's ``META`` (shared/project_writes.py ``create_workspace_project``)."""
    if not project_id:
        raise ValueError('a registry row names a project id')
    return {'pk': project_registry_pk(workspace=workspace), 'sk': project_id}


def deployment_project_registry_key(project_id: str) -> dict[str, str]:
    """A deployment project's row in the deployment's registry, ``PROJECT_IDS`` / ``{id}`` (since 7.48.00, 3g-d): put
    if absent before the project's ``META`` (shared/project_writes.py ``register_deployment_project``), and once for
    every project made before by the backfill (scripts/projects/backfill_review_registries.py)."""
    if not project_id:
        raise ValueError('a registry row names a project id')
    return {'pk': DEPLOYMENT_PROJECT_REGISTRY_PK, 'sk': project_id}


def deployment_project_item(project_id: str, created_at: str) -> dict[str, str]:
    """The one row naming a deployment project in its registry (``deployment_project_registry_key`` and its
    ``created_at``), put if absent by the create (shared/project_writes.py), the bundle import and the backfill."""
    return {**deployment_project_registry_key(project_id), 'created_at': created_at}


def project_id_of(partition_key: object, *, workspace: WorkspaceScope | None) -> str | None:
    """The project id of a stored ``pk`` that is one of the scope's project partitions, else None (another scope's
    partition, a document or persona index partition is not one: it carries a ``#`` after the id)."""
    prefix = _project_prefix(workspace)
    if not isinstance(partition_key, str) or not partition_key.startswith(prefix):
        return None
    project_id = partition_key[len(prefix):]
    return project_id if project_id and '#' not in project_id else None


def _documents_index_pk(project_id: str, workspace: WorkspaceScope | None) -> str:
    """The ``gsi1pk`` of a project's documents."""
    return f'{project_pk(project_id, workspace=workspace)}#DOCUMENTS'


def document_listing(project_id: str, listed_at: str, *, workspace: WorkspaceScope | None) -> dict[str, str]:
    """Where one of a project's documents is listed among them: ``gsi1pk`` / ``gsi1sk`` (``listed_at``)."""
    return {'gsi1pk': _documents_index_pk(project_id, workspace), 'gsi1sk': listed_at}


def document_keys(project_id: str, sort_key: str, listed_at: str, *,
                  workspace: WorkspaceScope | None) -> dict[str, str]:
    """The keys of one of a project's documents: its row ``sort_key`` in the project's partition, listed among the
    project's documents at ``listed_at`` (``document_listing``)."""
    return {'pk': project_pk(project_id, workspace=workspace), 'sk': sort_key,
            **document_listing(project_id, listed_at, workspace=workspace)}


def personas_index_pk(project_id: str, *, workspace: WorkspaceScope | None) -> str:
    """The ``gsi1pk`` of a project's personas."""
    return f'{project_pk(project_id, workspace=workspace)}#PERSONAS'


def persona_keys(project_id: str, persona_id: str, listed_at: str, *,
                 workspace: WorkspaceScope | None) -> dict[str, str]:
    """The keys of one of a project's personas: ``PERSONA#{id}`` in the project's partition, listed among the
    project's personas at ``listed_at`` (``personas_index_pk``)."""
    return {'pk': project_pk(project_id, workspace=workspace), 'sk': f'PERSONA#{persona_id}',
            'gsi1pk': personas_index_pk(project_id, workspace=workspace), 'gsi1sk': listed_at}


def version_partition_key(project_id: str, *, workspace: WorkspaceScope | None) -> str:
    """The partition of a project's document-version rows in voc-projects, apart from the project's own so they do not
    weigh on its document queries: ``DOCUMENT_VERSIONS#PROJECT#{id}`` (``WS#{ws}#DOCUMENT_VERSIONS#PROJECT#{id}`` in a
    workspace)."""
    return scoped_pk(workspace, f'{_DOCUMENT_VERSIONS_PREFIX}{project_id}')


def version_counter_key(project_id: str, document_type: str, normalized_title: str, *,
                        workspace: WorkspaceScope | None) -> dict[str, str]:
    """A series' version counter: ``{TYPE}#{sha256 of the normalized base title}`` in the version partition."""
    return {'pk': version_partition_key(project_id, workspace=workspace),
            'sk': f'{document_type.upper()}#{sha256_hex(normalized_title)}'}


def version_allocation_key(project_id: str, document_type: str, allocation_id: str, *,
                           workspace: WorkspaceScope | None) -> dict[str, str]:
    """An allocation's history row (kept after its document is deleted, so a late retry cannot recreate it):
    ``ALLOCATION#{TYPE}#{sha256 of the allocation id}`` in the version partition."""
    return {'pk': version_partition_key(project_id, workspace=workspace),
            'sk': f'{_ALLOCATION_PREFIX}{document_type.upper()}#{sha256_hex(allocation_id)}'}


def legacy_assignment_prefix(counter_key: dict[str, str]) -> str:
    """The sort-key start of a series' legacy assignments: ``LEGACY_ASSIGNMENT#{counter sk}#``."""
    return f"{_LEGACY_ASSIGNMENT_PREFIX}{counter_key['sk']}#"


def legacy_assignment_key(counter_key: dict[str, str], source_document_sk: str) -> dict[str, str]:
    """A legacy document's assigned version, in its series counter's partition (so in the counter's scope: no
    workspace of its own to pass): ``LEGACY_ASSIGNMENT#{counter sk}#{sha256 of the document's sk}``."""
    return {'pk': counter_key['pk'], 'sk': f'{legacy_assignment_prefix(counter_key)}{sha256_hex(source_document_sk)}'}


def document_revisions_prefix(document_id: str) -> str:
    """The sort-key start of an unmanaged document's saved revisions: ``REVISION#{document id}#``."""
    return f'{_REVISION_PREFIX}{document_id}#'


def document_revision_key(project_id: str, document_id: str, revision: int, *,
                          workspace: WorkspaceScope | None) -> dict[str, str]:
    """One saved revision of an unmanaged document: ``REVISION#{document id}#{revision:06d}`` in the version
    partition."""
    return {'pk': version_partition_key(project_id, workspace=workspace),
            'sk': f'{document_revisions_prefix(document_id)}{revision:06d}'}


def comments_pk(project_id: str, series_id: str, *, workspace: WorkspaceScope | None) -> str:
    """The partition of a series' comment threads and of its review link's pointer row (``SHARE``):
    ``DCOMMENTS#{project}#{series}``, ``WS#{ws}#DCOMMENTS#{project}#{series}`` in a workspace (since 7.37.00). The
    series id is the same in every scope (shared/document_series.py ``series_id``: project ids are unique in the
    deployment)."""
    return scoped_pk(workspace, f'{_COMMENTS_PREFIX}{project_id}#{series_id}')


def comment_series_key(project_id: str, series_id: str, *, workspace: WorkspaceScope) -> dict[str, str]:
    """A project's row listing one of its commented series, in the project's own partition:
    ``WS#{ws}#PROJECT#{id}`` / ``COMMENT_SERIES#{series}`` (a workspace's only, since 7.37.00). Put (if absent) before
    the series' comment partition gets its first row, so the hard delete finds every one by a Query of the project's
    partition (``comments_pk`` of each listed series), without a Scan; deleted with the project's partition."""
    if not series_id:
        raise ValueError('a commented series names its id')
    return {'pk': project_pk(project_id, workspace=workspace), 'sk': f'{COMMENT_SERIES_PREFIX}{series_id}'}


def comment_series_item(project_id: str, series_id: str, listed_at: str, *, workspace: WorkspaceScope) -> dict[str, str]:
    """The one row listing a commented series (``comment_series_key``, its ``series_id`` and ``listed_at``), put by
    a series' first thread (shared/document_comments.py ``list_series``, only if absent) and by a review link's create
    (shared/document_share.py), which puts it unconditioned inside its transaction: a condition there would cancel
    the link's whole create when the series is already listed, and rewriting the row changes only ``listed_at``,
    which nothing reads (the row's job is to exist, so the delete finds the series)."""
    return {**comment_series_key(project_id, series_id, workspace=workspace), 'series_id': series_id,
            'listed_at': listed_at}


def review_link_key(share_id: str, *, workspace: WorkspaceScope | None) -> dict[str, str]:
    """A review link's row: the deployment's ``DOCSHARE#{id}`` / ``META`` (shared/review_share_audience.py
    ``share_key``); a workspace's ``WS#{ws}#DOCSHARE#{id}`` / ``META`` (since 7.37.00), whose deployment-wide
    ``DOCSHARE#{id}`` row only routes to it (shared/ws_repo.py ``route_share_id``)."""
    return {'pk': scoped_pk(workspace, f'{SHARE_PK_PREFIX}{share_id}'), 'sk': SHARE_SK}


def review_link_registry_pk(*, workspace: WorkspaceScope) -> str:
    """The workspace's registry of its review link ids in voc-projects: ``WS#{ws}#DOCSHARE_IDS`` (since 7.37.00). The
    hard delete's ``docshares`` entry Queries it to release every routing row the workspace holds."""
    return workspace.key(_REVIEW_LINK_REGISTRY)


def review_link_registry_key(share_id: str, *, workspace: WorkspaceScope) -> dict[str, str]:
    """A link's row in its workspace's registry, ``WS#{ws}#DOCSHARE_IDS`` / ``{share id}``, written in the same
    transaction as the link and its routing row (shared/document_share.py ``create_share``)."""
    if not share_id:
        raise ValueError('a registry row names a review link id')
    return {'pk': review_link_registry_pk(workspace=workspace), 'sk': share_id}


def deployment_link_registry_key(share_id: str) -> dict[str, str]:
    """A deployment's review link's row in the deployment's link registry, ``DOCSHARE_IDS`` / ``{share id}`` (since
    7.48.00, projects 3g-d): written in the same transaction as the link (shared/document_share.py ``create_share``),
    and once for every link made before by the backfill (scripts/projects/backfill_review_registries.py), so an
    erasure by email finds every deployment link, a revoked one too (a revoke deletes the series' ``SHARE`` pointer),
    by a Query. No ``ttl``: kept after the link expires and is gone, as a workspace's registry row is."""
    if not share_id:
        raise ValueError('a registry row names a review link id')
    return {'pk': DEPLOYMENT_LINK_REGISTRY_PK, 'sk': share_id}


def deployment_series_registry_key(project_id: str, series_id: str) -> dict[str, str]:
    """A deployment's commented series in the deployment's series registry, ``COMMENT_SERIES_IDS`` /
    ``{project}#{series}`` (since 7.48.00, 3g-d). Deployment-wide, not in the project's partition (a workspace's list
    is, ``comment_series_key``): the deployment's project delete empties the project's partition and leaves the
    series' comment partitions, so a list kept there would lose them; this one keeps naming them."""
    if not project_id or not series_id or '#' in project_id or '#' in series_id:
        raise ValueError('a series registry row names a project id and a series id')
    return {'pk': DEPLOYMENT_SERIES_REGISTRY_PK, 'sk': f'{project_id}#{series_id}'}


def deployment_series_item(project_id: str, series_id: str, listed_at: str) -> dict[str, str]:
    """The one row naming a deployment's commented series (``deployment_series_registry_key``, its ids and
    ``listed_at``): put if absent by a series' first thread (shared/document_comments.py ``put_thread``), unconditioned
    inside a link's create (its reason: ``comment_series_item``)."""
    return {**deployment_series_registry_key(project_id, series_id), 'project_id': project_id, 'series_id': series_id,
            'listed_at': listed_at}


def series_registry_ids(sort_key: object) -> tuple[str, str] | None:
    """``(project id, series id)`` of a series registry row's sort key (``{project}#{series}``), or None when it is not
    shaped like one (the series id ``SERIES_ID_RE``)."""
    if not isinstance(sort_key, str):
        return None
    parts = sort_key.split('#')
    if len(parts) != 2 or not parts[0] or SERIES_ID_RE.fullmatch(parts[1]) is None:
        return None
    return parts[0], parts[1]


def comment_partition_ids(partition_key: object) -> tuple[str, str] | None:
    """``(project id, series id)`` of a deployment's comment partition (``DCOMMENTS#{project}#{series}``,
    ``comments_pk`` without a workspace), or None for any other key: the backfill's Scan reads a series from its
    comment rows (scripts/projects/backfill_review_registries.py; since 7.93.00 no erasure Scans)."""
    if not isinstance(partition_key, str) or not partition_key.startswith(_COMMENTS_PREFIX):
        return None
    return series_registry_ids(partition_key[len(_COMMENTS_PREFIX):])


def reviewer_rate_pk(share_id: str, email_digest: str, *, workspace: WorkspaceScope | None) -> str:
    """The partition of a reviewer's daily write counters on one link (``sk`` the UTC day, a ``ttl`` two days on):
    ``DCRATE#{share}#{email digest}``, ``WS#{ws}#DCRATE#…`` in a workspace."""
    return scoped_pk(workspace, f'{_REVIEWER_RATE_PREFIX}{share_id}#{email_digest}')


def product_docs_prefix(project_id: str, *, workspace: WorkspaceScope | None) -> str:
    """The object prefix of a project's product documents, their uploads (``raw/``) and extracted text
    (``extracted/``): ``projects/{id}/product_docs/``, ``ws/{ws}/projects/{id}/product_docs/`` in a workspace
    (api/product_context.py builds both keys from it; an erasure lists it for review, jobs/retention/project_people.py).
    """
    if not project_id:
        raise ValueError('a product documents prefix names a project id')
    return scoped_object_key(workspace, f'projects/{project_id}/product_docs/')


def job_status_pk(status: str, *, workspace: WorkspaceScope | None) -> str:
    """voc-jobs' ``gsi1-by-status`` partition of a project job's status: ``STATUS#{status}`` (one partition for every
    project of the deployment), ``WS#{ws}#STATUS#{status}`` in a workspace (since 7.27.00; the job stores write it
    since 7.29.00, slice 3c: shared/jobs.py, shared/assist_jobs.py; no route passes a workspace yet)."""
    return scoped_pk(workspace, f'{_JOB_STATUS_PREFIX}{status}')


class ProjectPartition(NamedTuple):
    """One partition keyed by a project's id: what it holds (``kind``: ``project``, ``versions``, ``jobs``,
    ``lists``), the environment variable naming its table, and its ``pk``."""

    kind: str
    table_env: str
    partition: str


def project_partitions(project_id: str, *, workspace: WorkspaceScope | None) -> tuple[ProjectPartition, ...]:
    """The partitions keyed by the project id alone, each with its kind and table (since 7.27.00), for the workspace
    export, the hard delete's projects entry and the per-project delete (slices 3g, 3h; none calls it yet): in
    voc-projects its own partition (``project_pk``) and its document versions (``version_partition_key``: the saved
    revisions hold customer text); in voc-jobs and voc-participants the same ``project_pk``. Each in the workspace when
    given. The job stores write there since 7.29.00 (3c), and a project's links to its participant lists and people
    since 7.31.00 (3d: shared/participants_lists.py ``link``); no route passes a workspace yet.

    Left out, each reached another way:

    * the comment threads, ``DCOMMENTS#{project}#{series}``: one partition per series; in a workspace each series is
      listed in the project's own partition (``comment_series_key``), which the hard delete reads first (since
      7.37.00);
    * the review links' rows: the deployment's ``DOCSHARE#{id}``; a workspace's ``WS#{ws}#DOCSHARE#{id}`` and its
      deployment-wide routing row, found through the workspace's ``WS#{ws}#DOCSHARE_IDS`` registry;
    * the S3 objects (avatars, product documents, prototypes; under ``ws/{ws}/`` in a workspace since 7.37.00,
      shared/avatar.py, shared/prototypes.py, api/projects.py, api/product_context.py);
    * the id's claim and the workspace's registry row (kept on a project delete: shared/ws_repo.py);
    * the workspace's own ``LIST#`` / ``PERSON#`` / ``EMAIL#`` rows in voc-participants (and the ``project_ids``
      attributes on them): listed in the workspace's ``WS#{ws}#PARTICIPANTS`` index (shared/participants_keys.py),
      which the hard delete's ``participants`` entry sweeps."""
    # Imported here, not at the top: these modules import boto3, and this one stays standard library only for its
    # other callers (scripts/project_bundle/remap.py).
    from shared.engagement_config import PARTICIPANTS_TABLE_ENV
    from shared.tables import JOBS_TABLE_ENV
    from shared.ws_repo import PROJECTS_TABLE_ENV

    own = project_pk(project_id, workspace=workspace)
    return (ProjectPartition('project', PROJECTS_TABLE_ENV, own),
            ProjectPartition('versions', PROJECTS_TABLE_ENV, version_partition_key(project_id, workspace=workspace)),
            ProjectPartition('jobs', JOBS_TABLE_ENV, own),
            ProjectPartition('lists', PARTICIPANTS_TABLE_ENV, own))
