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
scope's partition for one of its projects.

Every module builds these through here (but the product-doc extractor, a stdlib-only bundle with no ``shared/``,
which spells ``PROJECT#{id}`` itself: product_doc_extractor/handler.py); shared/test/test_ws_raw_access.py counts
the modules that read project tables or spell these keys.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Final

from shared.scoped_keys import scoped_pk

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

__all__ = ['DOCUMENT_COMMENTS_STORE', 'DOCUMENT_VERSIONS_STORE', 'PROJECT_GATE_STORE', 'PROJECT_PREFIX', 'PROJECT_TYPE_PK',
           'NotPerWorkspaceError', 'document_keys', 'document_listing', 'personas_index_pk', 'project_id_of',
           'project_pk', 'project_type_pk', 'require_deployment']

#: The start of every project partition of the deployment (a reader that tells a project's partition from another's).
PROJECT_PREFIX: Final = 'PROJECT#'
#: ``gsi1-by-type``'s partition of the deployment's project rows (``META``).
PROJECT_TYPE_PK: Final = 'TYPE#PROJECT'
#: The document versions and their history (shared/document_versions.py, shared/document_history.py,
#: shared/human_documents.py), not per workspace yet: the name ``require_deployment`` refuses a workspace with.
DOCUMENT_VERSIONS_STORE: Final = 'Document versions'
#: A series' comment threads and its persona review (shared/document_comments.py, shared/document_review.py),
#: keyed ``DCOMMENTS#{project}#{series}``, not per workspace yet.
DOCUMENT_COMMENTS_STORE: Final = 'Document comments'
#: The project access gate (shared/project_access.py, shared/project_gate.py): the deployment's admins and public
#: visibility decide it, so it refuses a workspace until the switch decides from the workspace's own membership.
PROJECT_GATE_STORE: Final = 'Project gate'


class NotPerWorkspaceError(RuntimeError):
    """A workspace reached a project store that is not per workspace yet: a programming error (500), never a
    fallback to the deployment's keys."""


def require_deployment(workspace: WorkspaceScope | None, store: str) -> None:
    """Fail closed (``NotPerWorkspaceError``) when a workspace reaches ``store``, a project store not per workspace
    yet (the document versions, slice 3b; the comments, slice 3e; the access gate, slice 3h; docs/multi-workspace.md)."""
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
