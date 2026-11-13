"""The keys of a project's rows: the one place they are spelled (docs/multi-workspace.md, phase 3).

A project's rows sit in one partition, ``PROJECT#{id}``: its ``META`` row and every child (personas, documents,
prototypes, research, pins, the product context) in voc-projects, its jobs in voc-jobs, its participant lists in
voc-participants. The project rows are listed through ``gsi1-by-type`` at ``TYPE#PROJECT``; a project's documents and
personas carry ``PROJECT#{id}#DOCUMENTS`` / ``#PERSONAS`` in ``gsi1pk``.

Every module builds these through here (but the product-doc extractor, a stdlib-only bundle with no ``shared/``,
which spells ``PROJECT#{id}`` itself: product_doc_extractor/handler.py), so moving projects under their workspace
(phase 3: ``WS#{ws}#PROJECT#{id}``, once shared/ws_repo.py has scoped transactions) gives each builder a scope in
one place; shared/test/test_ws_raw_access.py counts the modules that read project tables or spell these keys.
"""
from __future__ import annotations

from typing import Final

__all__ = ['PROJECT_PREFIX', 'PROJECT_TYPE_PK', 'document_keys', 'document_listing', 'personas_index_pk',
           'project_pk']

#: The start of every project partition (a reader that tells a project's partition from another's).
PROJECT_PREFIX: Final = 'PROJECT#'
#: ``gsi1-by-type``'s partition of the project rows (``META``).
PROJECT_TYPE_PK: Final = 'TYPE#PROJECT'


def project_pk(project_id: str) -> str:
    """A project's partition: its rows in voc-projects, its jobs in voc-jobs, its lists in voc-participants."""
    return f'{PROJECT_PREFIX}{project_id}'


def _documents_index_pk(project_id: str) -> str:
    """The ``gsi1pk`` of a project's documents."""
    return f'{project_pk(project_id)}#DOCUMENTS'


def document_listing(project_id: str, listed_at: str) -> dict[str, str]:
    """Where one of a project's documents is listed among them: ``gsi1pk`` / ``gsi1sk`` (``listed_at``)."""
    return {'gsi1pk': _documents_index_pk(project_id), 'gsi1sk': listed_at}


def document_keys(project_id: str, sort_key: str, listed_at: str) -> dict[str, str]:
    """The keys of one of a project's documents: its row ``sort_key`` in the project's partition, listed among the
    project's documents at ``listed_at`` (``document_listing``)."""
    return {'pk': project_pk(project_id), 'sk': sort_key, **document_listing(project_id, listed_at)}


def personas_index_pk(project_id: str) -> str:
    """The ``gsi1pk`` of a project's personas."""
    return f'{project_pk(project_id)}#PERSONAS'
