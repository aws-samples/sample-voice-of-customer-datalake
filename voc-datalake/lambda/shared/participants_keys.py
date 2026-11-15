"""The keys of voc-participants' people and lists: the one place they are spelled (docs/participants.md -> Data
model; docs/multi-workspace.md, the project plan, 3d).

Without a workspace (None) every builder gives exactly the deployment's key: ``PERSON#{id}`` / ``META`` (a person),
``EMAIL#{sha256(email)}`` / ``PERSON`` (its address guard), ``LIST#{id}`` / ``META`` (a list), ``LIST#{id}`` /
``MEMBER#{person}`` and its mirror ``PERSON#{person}`` / ``LIST#{id}`` (a membership), and the ``gsi1`` partitions
``LISTS`` and ``PEOPLE`` that list them. A project's link to a list or a person is ``PROJECT#{project}`` /
``LIST#{id}`` or ``PERSON#{id}`` (shared/project_keys.py ``project_pk``).

Inside a workspace (plumbing since 7.31.00: no route passes one yet) each is the same key inside it
(shared/scoped_keys.py ``scoped_pk``): ``WS#{ws}#PERSON#{id}``, ``WS#{ws}#EMAIL#{sha}``, ``WS#{ws}#LIST#{id}``,
``WS#{ws}#LISTS``, ``WS#{ws}#PEOPLE``, ``WS#{ws}#PROJECT#{project}``. A workspace also keeps an index of the partitions
its people and lists hold, ``WS#{ws}#PARTICIPANTS`` (``participants_index_pk``): one row per list (``LIST#{id}``), per
person (``PERSON#{id}``) and per address guard (``EMAIL#{sha}``), put before a list's ``META`` and in the same
transaction as a person and its guard. A membership or a project link is written only into a list or person a caller
has just read (the routes 404 an unknown id first), so its partition is already listed. A list's and a
person's row stay after they are deleted (opaque ids; a late write into the partition is still found); a guard's row,
which holds the address's hash, goes with an erasure only while no guard of that address is back. So the hard delete finds every one of them with a Query of one partition (jobs/workspace_delete/sweeps.py, the
``participants`` entry) and never a Scan.

The asks, their recipients, the tokens and the send counters are not per workspace yet: their stores refuse one
(``PARTICIPANT_ASKS_STORE``; shared/project_keys.py ``require_deployment``). Nor are the engagement settings
(``SETTINGS`` / ``engagement``), which the routes load and pass in: a new person in a workspace, whom they decide, is
refused (``PARTICIPANT_SETTINGS_STORE``).
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Final

from shared.digests import sha256_hex
from shared.project_keys import project_pk
from shared.scoped_keys import scoped_pk

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

#: The start of a list's partition, and of a membership's mirror in its person's partition.
LIST_PARTITION_PREFIX: Final = 'LIST#'
#: The start of a person's partition, and of a person's link in a project's partition.
PERSON_PARTITION_PREFIX: Final = 'PERSON#'
#: The start of an address guard's partition (``EMAIL#{sha256 of the lower-cased address}``).
_EMAIL_GUARD_PREFIX: Final = 'EMAIL#'
#: The sort key of a person's or a list's own row, and of an address guard.
META_SORT_KEY: Final = 'META'
EMAIL_GUARD_SORT_KEY: Final = 'PERSON'
#: ``gsi1``'s partitions of the lists (by name) and of the people (by address).
LISTS_PARTITION: Final = 'LISTS'
PEOPLE_PARTITION: Final = 'PEOPLE'
#: A workspace's index of its people's and lists' partitions (``WS#{ws}#PARTICIPANTS``).
_PARTICIPANTS_INDEX: Final = 'PARTICIPANTS'
#: The partitions the index may name, by how they start (inside the workspace).
_INDEXED_PREFIXES: Final = (LIST_PARTITION_PREFIX, PERSON_PARTITION_PREFIX, _EMAIL_GUARD_PREFIX)
#: The asks (``ASK#``), their recipients and mirrors, the tokens (``TOKEN#``) and the daily send counters
#: (``SENDCOUNT#``): deployment-wide, so a workspace is refused (shared/participants_asks.py) until they move.
PARTICIPANT_ASKS_STORE: Final = 'Participant asks'
#: The engagement settings (``SETTINGS`` / ``engagement``: who may be added): deployment-wide, so a new person in a
#: workspace, which the settings decide, is refused (shared/participants_store.py ``upsert_person``) until they move.
PARTICIPANT_SETTINGS_STORE: Final = 'Participant settings'


def participants_partition(part: str, *, workspace: WorkspaceScope | None = None) -> str:
    """``part`` itself (the deployment's partition), or the workspace's copy of it (``WS#{ws}#{part}``)."""
    return scoped_pk(workspace, part)


def person_partition(person_id: str, *, workspace: WorkspaceScope | None = None) -> str:
    """A person's partition: its ``META``, its list mirrors (``LIST#{id}``) and its ask mirrors (``ASK#{id}``)."""
    return participants_partition(f'{PERSON_PARTITION_PREFIX}{person_id}', workspace=workspace)


def person_key(person_id: str, *, workspace: WorkspaceScope | None = None) -> dict[str, str]:
    return {'pk': person_partition(person_id, workspace=workspace), 'sk': META_SORT_KEY}


def email_guard_key(email_lc: str, *, workspace: WorkspaceScope | None = None) -> dict[str, str]:
    """The uniqueness guard of an address: one person per address in the scope."""
    return {'pk': participants_partition(f'{_EMAIL_GUARD_PREFIX}{sha256_hex(email_lc)}', workspace=workspace),
            'sk': EMAIL_GUARD_SORT_KEY}


def people_index_pk(*, workspace: WorkspaceScope | None = None) -> str:
    """``gsi1``'s partition of the scope's people (``gsi1sk`` the lower-cased address)."""
    return participants_partition(PEOPLE_PARTITION, workspace=workspace)


def list_partition(list_id: str, *, workspace: WorkspaceScope | None = None) -> str:
    """A list's partition: its ``META`` and its members (``MEMBER#{person}``)."""
    return participants_partition(f'{LIST_PARTITION_PREFIX}{list_id}', workspace=workspace)


def list_key(list_id: str, *, workspace: WorkspaceScope | None = None) -> dict[str, str]:
    return {'pk': list_partition(list_id, workspace=workspace), 'sk': META_SORT_KEY}


def lists_index_pk(*, workspace: WorkspaceScope | None = None) -> str:
    """``gsi1``'s partition of the scope's lists (``gsi1sk`` the lower-cased name)."""
    return participants_partition(LISTS_PARTITION, workspace=workspace)


def list_members(list_id: str, *, workspace: WorkspaceScope | None = None) -> tuple[str, str]:
    """Where a list's members are: its partition, and the sort-key start of a membership (``MEMBER#``)."""
    return list_partition(list_id, workspace=workspace), 'MEMBER#'


def member_key(list_id: str, person_id: str, *, workspace: WorkspaceScope | None = None) -> dict[str, str]:
    """A membership, the list's side."""
    partition, prefix = list_members(list_id, workspace=workspace)
    return {'pk': partition, 'sk': f'{prefix}{person_id}'}


def membership_key(person_id: str, list_id: str, *, workspace: WorkspaceScope | None = None) -> dict[str, str]:
    """A membership's mirror, the person's side."""
    return {'pk': person_partition(person_id, workspace=workspace), 'sk': f'{LIST_PARTITION_PREFIX}{list_id}'}


def project_link_key(project_id: str, kind: str, target_id: str, *,
                     workspace: WorkspaceScope | None = None) -> dict[str, str]:
    """A project's link to a list (``kind`` ``LIST``) or a person (``PERSON``), in the project's partition."""
    return {'pk': project_pk(project_id, workspace=workspace), 'sk': f'{kind}#{target_id}'}


def participants_index_pk(workspace: WorkspaceScope) -> str:
    """The workspace's index of its people's and lists' partitions: ``WS#{ws}#PARTICIPANTS`` (a workspace only)."""
    return workspace.key(_PARTICIPANTS_INDEX)


def participants_index_key(partition: str, *, workspace: WorkspaceScope) -> dict[str, str]:
    """The index row naming ``partition`` (one of the workspace's ``LIST#``, ``PERSON#`` or ``EMAIL#`` partitions):
    ``WS#{ws}#PARTICIPANTS`` / the partition without the workspace's prefix. ValueError for any other partition."""
    suffix = partition.removeprefix(workspace.prefix) if workspace.owns(partition) else ''
    if not any(suffix.startswith(prefix) and len(suffix) > len(prefix) for prefix in _INDEXED_PREFIXES):
        raise ValueError('the participants index names a list, a person or an address guard of its workspace')
    return {'pk': participants_index_pk(workspace), 'sk': suffix}


def indexed_partitions(workspace: WorkspaceScope, row: Mapping[str, object]) -> list[str]:
    """The partition an index row names (its ``sk`` inside the workspace), or none for a row that names no list,
    person or address guard. A ``#`` in the rest still names a partition inside the workspace (its prefix is fixed)."""
    sort_key = row.get('sk')
    if not isinstance(sort_key, str) or not any(
            sort_key.startswith(prefix) and len(sort_key) > len(prefix) for prefix in _INDEXED_PREFIXES):
        return []
    return [participants_partition(sort_key, workspace=workspace)]
