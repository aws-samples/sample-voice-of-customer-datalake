"""The CI attestation of a repository connection (docs/autonomous-engineering.md, "Repository connectors": the
target's CI).

A push to an agent branch can start the repository's own pipelines, which run scripts an agent can change, and the
GitHub App holds no permission that could read the settings that keep them harmless. So an administrator confirms
each point of the setup guide (``POINTS``) for the connection, and the broker refuses every push and pull request
until that confirmation stands. The broker also checks, at each push and pull request, what the App's read-only
token can read of the host's branch rules (``github.py`` ``ci_protection``).

Each change is a create-only, versioned row in a partition of the connection's attestations alone (D1, D4):
``CONNECTIONS#<ws>#CI#<connection>`` / ``V#<version>``, with its state (``attested``, ``withdrawn``, or ``voided``
when the connection's repository changed or the connection was removed), the repository it stands for, the points
confirmed, who (subject and name) and when, and the administrator's reason when given. The newest version is the one
that holds. The Agents API writes them (``connections.py`` ``ConnectionStore``), each in one transaction with the
connection's own audit row and a bump of the connection row's version, so a change of the connection made meanwhile
refuses the one or the other; the broker only reads the newest (``attested_version``), and serves a push or a pull
request only while it is ``attested`` for the repository the run started on.

The partition matches ``CONNECTIONS#*``, so every role that may write voc-agents elsewhere is denied writes here too
(engineering-runtime-grants.ts ``denyHardCapWrites``), and the broker's one grant on voc-agents is a Query of these
partitions alone, of the attributes ``attested_version`` projects (engineering-broker.ts).
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from engineering.connectors.identity import WORKSPACE

#: The setup guide's points an administrator confirms, each by its id (what the API takes and answers), in order.
POINTS: Final = (
    # CI secrets scoped to protected branches (environments with branch rules): an agent branch gets none.
    'protected_secrets',
    # A read-only default workflow token, and no workflow that asks for write ``permissions:``.
    'read_only_token',
    # Cloud trust through OIDC (``id-token: write``) pinned to protected branches or environments.
    'oidc_pinned',
    # No self-hosted runner for unprotected branches.
    'no_self_hosted_runner',
    # No workflow in the default branch's context on a pull request (``pull_request_target``, or ``workflow_run``
    # downloading the triggering run's artifacts) checks out, runs or downloads the pull request's code or artifacts.
    'no_privileged_pull_request',
    # The default branch protected with the repository's required checks, and the App's pushes limited to voc-agent/*.
    'branch_rules',
)
ATTESTED: Final = 'attested'
WITHDRAWN: Final = 'withdrawn'
VOIDED: Final = 'voided'
#: Why a version was voided: the connection's repository changed, or the connection was removed.
REPOSITORY_CHANGED: Final = 'repository_changed'
CONNECTION_REMOVED: Final = 'connection_removed'
VERSION_PREFIX: Final = 'V#'
#: The attributes the broker reads of the newest version (its IAM grant allows these alone).
BROKER_ATTRIBUTES: Final = ('pk', 'sk', 'state', 'repository', 'version')


def attestation_pk(connection_id: str) -> str:
    """The partition of one connection's attestations (beside, never inside, the connections' own)."""
    return f'CONNECTIONS#{WORKSPACE}#CI#{connection_id}'


def version_sk(version: int) -> str:
    """A version's sort key, zero-padded so the newest sorts last."""
    return f'{VERSION_PREFIX}{version:06d}'


def _newest_query() -> dict[str, Any]:
    return {'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :v)', 'ConsistentRead': True,
            'ScanIndexForward': False, 'Limit': 1}


def newest(table: Any, connection_id: str) -> dict[str, Any] | None:
    """The newest version of the connection's attestation (a boto3 ``Table``), None for none: one Query, one row."""
    found = table.query(**_newest_query(), ExpressionAttributeValues={
        ':pk': attestation_pk(connection_id), ':v': VERSION_PREFIX}).get('Items', [])
    return found[0] if found else None


def attested_version(client: Any, table: str, connection_id: str, repository: str) -> int:
    """The version of the attestation that holds for ``repository`` (a low-level client), 0 when none does: the
    newest version is ``attested`` and stands for that same repository. One Query of one row, projected."""
    found = client.query(
        TableName=table, **_newest_query(),
        ExpressionAttributeValues={':pk': {'S': attestation_pk(connection_id)}, ':v': {'S': VERSION_PREFIX}},
        ProjectionExpression=', '.join(f'#{name}' for name in BROKER_ATTRIBUTES),
        ExpressionAttributeNames={f'#{name}': name for name in BROKER_ATTRIBUTES}).get('Items', [])
    item = found[0] if found else {}
    state, stands_for = item.get('state', {}).get('S'), item.get('repository', {}).get('S')
    if state != ATTESTED or not repository or stands_for != repository:
        return 0
    return int(item.get('version', {}).get('N', '0'))


def version_of(item: Mapping[str, Any] | None) -> int:
    return int(item.get('version', 0)) if item is not None else 0


def is_attested(item: Mapping[str, Any] | None, repository: str) -> bool:
    """Whether ``item`` (a version as ``newest`` reads it) is an attestation that holds for ``repository``."""
    return item is not None and item.get('state') == ATTESTED and item.get('repository') == repository


def version_row(connection_id: str, version: int, state: str, repository: str, *, by: str, by_name: str, at: str,
                points: tuple[str, ...] = (), reason: str = '', cause: str = '') -> dict[str, Any]:
    """A version's create-only row: its state, the repository it stands for, who and when (D4), and the points
    confirmed (an attestation), the reason (when given) or the cause (a void)."""
    row: dict[str, Any] = {'pk': attestation_pk(connection_id), 'sk': version_sk(version),
                           'connection_id': connection_id, 'version': version, 'state': state,
                           'repository': repository, 'by': by, 'by_name': by_name, 'at': at}
    extra = {'points': list(points), 'reason': reason, 'cause': cause}
    return {**row, **{key: value for key, value in extra.items() if value}}


def void_put(table: str, newest_item: Mapping[str, Any] | None, cause: str, *, by: str, by_name: str,
             at: str) -> dict[str, Any] | None:
    """The transaction's Put of a void of ``newest_item`` when it is an attestation (None otherwise): the next version,
    create-only, so an attestation written meanwhile refuses the transaction."""
    if newest_item is None or newest_item.get('state') != ATTESTED:
        return None
    row = version_row(str(newest_item['connection_id']), version_of(newest_item) + 1, VOIDED,
                      str(newest_item.get('repository', '')), by=by, by_name=by_name, at=at, cause=cause)
    return {'Put': {'TableName': table, 'Item': row, 'ConditionExpression': 'attribute_not_exists(sk)'}}


def view(item: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The newest version as the API answers it (None for none): never a subject, only the name the page shows."""
    if item is None:
        return None
    points = item.get('points')
    return {
        'version': version_of(item), 'state': str(item.get('state', '')), 'repository': str(item.get('repository', '')),
        'points': [str(point) for point in points] if isinstance(points, list) else [],
        'by': str(item.get('by_name', '')) or None, 'at': str(item.get('at', '')) or None,
        'reason': str(item.get('reason', '')) or None, 'cause': str(item.get('cause', '')) or None,
    }
