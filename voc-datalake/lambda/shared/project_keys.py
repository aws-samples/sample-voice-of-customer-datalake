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

Every module builds these through here (but the product-doc extractor, a stdlib-only bundle with no ``shared/``,
which spells ``PROJECT#{id}`` itself: product_doc_extractor/handler.py); shared/test/test_ws_raw_access.py counts
the modules that read project tables or spell these keys.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Final, NamedTuple

from shared.digests import sha256_hex
from shared.scoped_keys import scoped_pk

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

__all__ = ['DOCUMENT_COMMENTS_STORE', 'PROJECT_GATE_STORE', 'PROJECT_PREFIX', 'PROJECT_TYPE_PK', 'NotPerWorkspaceError', 'ProjectPartition',
           'document_keys', 'document_listing', 'document_revision_key', 'document_revisions_prefix', 'job_status_pk',
           'legacy_assignment_key', 'legacy_assignment_prefix', 'personas_index_pk', 'project_id_of',
           'project_partitions', 'project_pk', 'project_registry_key', 'project_registry_pk', 'project_type_pk',
           'require_deployment',
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
#: A series' comment threads and its persona review (shared/document_comments.py, shared/document_review.py),
#: keyed ``DCOMMENTS#{project}#{series}``, not per workspace yet.
DOCUMENT_COMMENTS_STORE: Final = 'Document comments'
#: The project access gate (shared/project_access.py, shared/project_gate.py): the deployment's admins and public
#: visibility decide it, so it refuses a workspace until the switch decides from the workspace's own membership.
PROJECT_GATE_STORE: Final = 'Project gate'
#: A workspace's registry of its project ids, one row per project, ``WS#{ws}#PROJECT_IDS`` / ``{id}``.
_PROJECT_REGISTRY: Final = 'PROJECT_IDS'


class NotPerWorkspaceError(RuntimeError):
    """A workspace reached a project store that is not per workspace yet: a programming error (500), never a
    fallback to the deployment's keys."""


def require_deployment(workspace: WorkspaceScope | None, store: str) -> None:
    """Fail closed (``NotPerWorkspaceError``) when a workspace reaches ``store``, a project store not per workspace
    yet (the comments, slice 3e; the access gate, slice 3h; docs/multi-workspace.md)."""
    if workspace is not None:
        raise NotPerWorkspaceError(f'{store} is not per workspace yet')


def _project_prefix(workspace: WorkspaceScope | None) -> str:
    """How every project partition of the scope starts: ``PROJECT#``, or ``WS#{ws}#PROJECT#`` in a workspace."""
    return PROJECT_PREFIX if workspace is None else f'{workspace.prefix}{PROJECT_PREFIX}'


def project_pk(project_id: str, *, workspace: WorkspaceScope | None = None) -> str:
    """A project's partition: its rows in voc-projects, its jobs in voc-jobs, its lists in voc-participants
    (``PROJECT#{id}``; ``WS#{ws}#PROJECT#{id}`` in a workspace)."""
    return scoped_pk(workspace, f'{PROJECT_PREFIX}{project_id}')


def project_type_pk(*, workspace: WorkspaceScope | None = None) -> str:
    """``gsi1-by-type``'s partition of the scope's project rows: ``TYPE#PROJECT``, ``WS#{ws}#TYPE#PROJECT``."""
    return scoped_pk(workspace, PROJECT_TYPE_PK)


def project_registry_pk(workspace: WorkspaceScope) -> str:
    """The workspace's registry of its project ids in voc-projects: ``WS#{ws}#PROJECT_IDS`` (since 7.26.00). A Query
    of it, knowing only the workspace, names every project made there (the export, the delete, an erasure)."""
    return workspace.key(_PROJECT_REGISTRY)


def project_registry_key(project_id: str, *, workspace: WorkspaceScope) -> dict[str, str]:
    """A project's row in its workspace's registry: ``WS#{ws}#PROJECT_IDS`` / ``{id}``, written in the same
    transaction as the project's ``META`` (shared/project_writes.py ``create_workspace_project``)."""
    if not project_id:
        raise ValueError('a registry row names a project id')
    return {'pk': project_registry_pk(workspace), 'sk': project_id}


def project_id_of(partition_key: object, *, workspace: WorkspaceScope | None = None) -> str | None:
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


def document_listing(project_id: str, listed_at: str, *, workspace: WorkspaceScope | None = None) -> dict[str, str]:
    """Where one of a project's documents is listed among them: ``gsi1pk`` / ``gsi1sk`` (``listed_at``)."""
    return {'gsi1pk': _documents_index_pk(project_id, workspace), 'gsi1sk': listed_at}


def document_keys(project_id: str, sort_key: str, listed_at: str, *,
                  workspace: WorkspaceScope | None = None) -> dict[str, str]:
    """The keys of one of a project's documents: its row ``sort_key`` in the project's partition, listed among the
    project's documents at ``listed_at`` (``document_listing``)."""
    return {'pk': project_pk(project_id, workspace=workspace), 'sk': sort_key,
            **document_listing(project_id, listed_at, workspace=workspace)}


def personas_index_pk(project_id: str, *, workspace: WorkspaceScope | None = None) -> str:
    """The ``gsi1pk`` of a project's personas."""
    return f'{project_pk(project_id, workspace=workspace)}#PERSONAS'


def version_partition_key(project_id: str, *, workspace: WorkspaceScope | None = None) -> str:
    """The partition of a project's document-version rows in voc-projects, apart from the project's own so they do not
    weigh on its document queries: ``DOCUMENT_VERSIONS#PROJECT#{id}`` (``WS#{ws}#DOCUMENT_VERSIONS#PROJECT#{id}`` in a
    workspace)."""
    return scoped_pk(workspace, f'{_DOCUMENT_VERSIONS_PREFIX}{project_id}')


def version_counter_key(project_id: str, document_type: str, normalized_title: str, *,
                        workspace: WorkspaceScope | None = None) -> dict[str, str]:
    """A series' version counter: ``{TYPE}#{sha256 of the normalized base title}`` in the version partition."""
    return {'pk': version_partition_key(project_id, workspace=workspace),
            'sk': f'{document_type.upper()}#{sha256_hex(normalized_title)}'}


def version_allocation_key(project_id: str, document_type: str, allocation_id: str, *,
                           workspace: WorkspaceScope | None = None) -> dict[str, str]:
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
                          workspace: WorkspaceScope | None = None) -> dict[str, str]:
    """One saved revision of an unmanaged document: ``REVISION#{document id}#{revision:06d}`` in the version
    partition."""
    return {'pk': version_partition_key(project_id, workspace=workspace),
            'sk': f'{document_revisions_prefix(document_id)}{revision:06d}'}


def job_status_pk(status: str, *, workspace: WorkspaceScope | None = None) -> str:
    """voc-jobs' ``gsi1-by-status`` partition of a project job's status: ``STATUS#{status}`` (one partition for every
    project of the deployment), ``WS#{ws}#STATUS#{status}`` in a workspace (since 7.27.00; no job is written in one
    yet: the jobs are slice 3c)."""
    return scoped_pk(workspace, f'{_JOB_STATUS_PREFIX}{status}')


class ProjectPartition(NamedTuple):
    """One partition keyed by a project's id: what it holds (``kind``: ``project``, ``versions``, ``jobs``,
    ``lists``), the environment variable naming its table, and its ``pk``."""

    kind: str
    table_env: str
    partition: str


def project_partitions(project_id: str, *, workspace: WorkspaceScope | None = None) -> tuple[ProjectPartition, ...]:
    """The partitions keyed by the project id alone, each with its kind and table (since 7.27.00), for the workspace
    export, the hard delete's projects entry and the per-project delete (slices 3g, 3h; none calls it yet): in
    voc-projects its own partition (``project_pk``) and its document versions (``version_partition_key``: the saved
    revisions hold customer text); in voc-jobs and voc-participants the same ``project_pk``. Each in the workspace when
    given. The jobs (3c) and the participant lists (3d) still write the deployment's keys only, so in a workspace
    their entries name where those rows will be.

    Left out, each reached another way:

    * the comment threads, ``DCOMMENTS#{project}#{series}``: one partition per series, derived from the project's
      series (shared/document_comments.py);
    * the review links' ``DOCSHARE#{id}`` rows (deployment-wide);
    * the S3 objects (avatars, product documents, prototypes; ``ws/{ws}/`` prefixes in a workspace);
    * the id's claim and the workspace's registry row (kept on a project delete: shared/ws_repo.py);
    * the workspace's own ``LIST#`` / ``PERSON#`` rows in voc-participants, and the ``project_ids`` attributes on
      them, which a delete must clean."""
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
