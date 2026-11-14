"""The repository connections, as administrators store them (docs/autonomous-engineering.md, "Repository connectors":
connections and credentials).

A connection is a row in voc-agents and, while it holds a credential, one SSM Parameter Store SecureString:

* the row, ``CONNECTIONS#<ws>`` / ``CONNECTION#<id>``: the host (``github``), the repository (``owner/name``), the
  default branch, the GitHub App's ids (not secret), whether a credential is set, who created and last changed it,
  and its version (each change is conditioned on the version read, so two administrators never overwrite each
  other unseen). A removed connection keeps its row, marked removed (the table's writers never delete: the
  history stays readable), and is listed no more;
* the credential, ``{prefix}<id>`` (``/[<prefix>-]voc/engineering/<id>``, the name the broker's reader reads:
  ``credentials.py``), standard tier, encrypted with the stack's customer-managed key, holding the JSON the reader
  parses: ``app_id``, ``installation_id``, ``repository`` and ``private_key``. It is written here and read only by
  the broker: this code never reads it back (its role has no ``ssm:GetParameter``), and the private key is never
  answered, logged, put in an error, or stored anywhere but the parameter;
* every change, a create-only audit row in the same partition, ``LOG#<at>#<hex>`` (D4: who, when, what changed:
  the fields' old and new values, and for the credential only ``replaced`` / ``kept`` / ``removed``; and why, when
  the administrator says: an optional ``reason``, one line of at most ``MAX_REASON`` characters, credential-shaped
  text redacted), written in the same transaction as the row.

A connection's CI attestation (6.32.00, ``attestations.py``): an administrator confirms the setup guide's points for
it (``attest``) or withdraws the confirmation (``withdraw``); a repository change and a removal void it. Each is a
create-only version row in the attestation's own partition, written in one transaction with the connection's audit
row (``ci_attested``, ``ci_withdrawn``; a void is a change of the save's or the removal's own audit row) and, for an
attestation or a withdrawal, a bump of the connection row's version, so a change of the connection made meanwhile
refuses one of the two (409). The list answers each connection's newest version (one Query of one row each).

The credential is written before the row and removed before the row is marked removed, so a failure between the two
never leaves a removed connection whose credential the broker could still use. A repository change while a run of
the connection is live is refused (409): the run's agents would otherwise read and push to another repository than
the one it started on. That check reads the runs, then writes: a run started between the two is not seen, so what
guarantees it is the broker's own check, which serves a run only while the connection's credential names the run's
repository (``broker.py`` ``OTHER_REPOSITORY``), failing closed. Removing a connection is not refused: it is the way to cut a connection's access (within five
minutes: a warm broker keeps a credential it read that long, ``credentials.py`` ``CACHE_SECONDS``).

Nothing here imports ``cryptography`` (the Agents API ships without the signing layer): the private key's shape is
checked here, and the broker's reader parses the key itself.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
import secrets
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final, Literal

from botocore.exceptions import BotoCoreError, ClientError

from engineering.connectors import attestations
from engineering.connectors.attestations import ATTESTED, POINTS, WITHDRAWN
from engineering.connectors.identity import WORKSPACE
from engineering.runtime.outputs import AGENT_BRANCH_PREFIX
from engineering.settings import UNNAMED
from shared.dynamo_paging import query_all
from shared.logging import logger
from shared.model_fallback import error_code

#: The env var with the parameters' prefix (``/voc/engineering/``), the broker's and the Agents API's alike.
PARAMETER_PREFIX_ENV: Final = 'ENGINEERING_PARAMETER_PREFIX'
#: The env var with the stack's customer-managed key (its ARN), which encrypts every connection's parameter.
PARAMETER_KEY_ENV: Final = 'ENGINEERING_PARAMETER_KEY'
#: The connections' partition in voc-agents, and the prefixes of its rows.
PARTITION: Final = f'CONNECTIONS#{WORKSPACE}'
ROW_PREFIX: Final = 'CONNECTION#'
LOG_PREFIX: Final = 'LOG#'
#: The most connections a deployment keeps (removed ones do not count).
MAX_CONNECTIONS: Final = 20
#: A standard parameter's largest value (a larger one is an advanced parameter, which has a monthly charge).
MAX_PARAMETER_BYTES: Final = 4096
HOSTS: Final = ('github',)
#: A connection id: what a run's ``connection`` names (runtime/interface.py ``check_id``), lower case.
CONNECTION_ID: Final = re.compile(r'[a-z0-9][a-z0-9-]{0,62}')
#: ``owner/name`` as GitHub spells them (the broker's reader holds a stored value to the same rule).
REPOSITORY: Final = re.compile(r'(?P<owner>[A-Za-z0-9][A-Za-z0-9-]{0,38})/(?P<name>[A-Za-z0-9._-]{1,100})')
#: A GitHub App's id or installation id: digits, no leading zero (the broker's reader holds them to the same rule).
APP_NUMBER: Final = re.compile(r'[1-9][0-9]{0,19}')
_BRANCH: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,254}')
#: An unencrypted RSA private key in PEM, PKCS#1 (as GitHub hands an App's key out) or PKCS#8.
_PEM: Final = re.compile(r'-----BEGIN (RSA |)PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]{1,76}\n)+-----END \1PRIVATE KEY-----')
#: rsaEncryption's object identifier (1.2.840.113549.1.1.1) in DER: what a PKCS#8 RSA key's algorithm names.
_RSA_ENCRYPTION: Final = bytes.fromhex('06092a864886f70d010101')
_FIELDS: Final = frozenset({'host', 'repository', 'default_branch', 'credential', 'reason'})
_CREDENTIAL_FIELDS: Final = frozenset({'app_id', 'installation_id', 'private_key'})
#: The row's fields an audit row records the change of (never the private key).
_AUDITED: Final = ('repository', 'default_branch', 'app_id', 'installation_id')
_MAX_NAME: Final = 128
#: The longest reason a change takes (one line; longer is refused, never cut).
MAX_REASON: Final = 500
#: A CI attestation or withdrawal of a connection that changed after the administrator reviewed it (409).
_REVIEWED_CHANGED: Final = 'the connection changed meanwhile: reload it, review its repository again and try again'
#: The fields of a row the view answers as text or null.
_OPTIONAL_TEXT: Final = ('app_id', 'installation_id', 'created_at', 'created_by', 'updated_at', 'updated_by')

Kind = Literal['invalid', 'not_found', 'conflict', 'unavailable']


class ConnectionRefused(Exception):
    """A connection change refused: ``kind`` is the answer's status (400, 404, 409, 503), the message a plain
    sentence that never repeats a credential."""

    def __init__(self, kind: Kind, message: str) -> None:
        super().__init__(message)
        self.kind: Kind = kind


def _invalid(message: str) -> ConnectionRefused:
    return ConnectionRefused('invalid', message)


@dataclass(frozen=True)
class AppCredential:
    """A GitHub App's credential as a save sends it: the ids, and the private key (``repr`` leaves it out)."""

    app_id: str
    installation_id: int
    private_key: str

    def __repr__(self) -> str:
        return f'AppCredential(app_id={self.app_id!r}, installation_id={self.installation_id!r})'


@dataclass(frozen=True)
class ConnectionRequest:
    """A checked save: the host, the repository, the default branch, when the save replaces it the credential, and
    the administrator's reason ('' for none)."""

    host: str
    repository: str
    default_branch: str
    credential: AppCredential | None
    reason: str = ''


@dataclass(frozen=True)
class Actor:
    """Who makes a change: their subject (the audit's ``by``) and the name the page shows."""

    subject: str
    name: str


def check_connection_id(connection_id: str) -> str:
    if not CONNECTION_ID.fullmatch(connection_id):
        raise _invalid('the connection id is 1 to 63 lower-case letters, digits or "-", starting with a letter or digit')
    return connection_id


def is_branch_name(branch: str) -> bool:
    """A default branch git takes (check-ref-format's rules on an ASCII name) that is not an agent's branch."""
    components = branch.split('/')
    return (bool(_BRANCH.fullmatch(branch)) and '..' not in branch and '@{' not in branch
            and not branch.endswith(('/', '.')) and not branch.startswith(AGENT_BRANCH_PREFIX)
            and all(part and not part.startswith('.') and not part.endswith('.lock') for part in components))


def _repository(value: object) -> str:
    match = REPOSITORY.fullmatch(value) if isinstance(value, str) else None
    if match is None or match.group('name') in {'.', '..'}:
        raise _invalid('repository is the GitHub repository as owner/name')
    return match.group(0)


def _digits(value: object, name: str) -> str:
    text = str(value) if isinstance(value, int) and not isinstance(value, bool) else value
    if not isinstance(text, str) or not APP_NUMBER.fullmatch(text):
        raise _invalid(f'{name} is the GitHub App\'s number (digits only, as its settings page shows it)')
    return text


def _private_key(value: object) -> str:
    """The key, its line ends made ``\\n``, or a refusal that never quotes it."""
    if not isinstance(value, str) or not value.strip():
        raise _invalid('private_key is the GitHub App\'s private key (the .pem file\'s whole text)')
    key = value.replace('\r\n', '\n').strip() + '\n'
    pem = _PEM.fullmatch(key.rstrip('\n'))
    if pem is None or not _rsa_der(pem.group(0), pkcs1=bool(pem.group(1))):
        raise _invalid('private_key is an unencrypted RSA private key in PEM (the .pem file GitHub generates for '
                       'the App, pasted whole)')
    return key


def _rsa_der(pem: str, *, pkcs1: bool) -> bool:
    """The PEM's body is base64 DER, and a PKCS#8 one names the RSA algorithm near its start (an EC or other key is
    refused here; the broker's reader parses the key itself)."""
    try:
        der = base64.b64decode(''.join(pem.split('\n')[1:-1]), validate=True)
    except binascii.Error:
        return False
    return der[:1] == b'\x30' and (pkcs1 or _RSA_ENCRYPTION in der[:32])


def _credential(value: object) -> AppCredential:
    if not isinstance(value, dict) or frozenset(value) != _CREDENTIAL_FIELDS:
        raise _invalid('credential is {app_id, installation_id, private_key}: the GitHub App\'s')
    return AppCredential(app_id=_digits(value['app_id'], 'app_id'),
                         installation_id=int(_digits(value['installation_id'], 'installation_id')),
                         private_key=_private_key(value['private_key']))


def parse_reason(value: object) -> str:
    """Why the change is made, for its audit row: one line (whitespace collapsed), credential-shaped text redacted
    (a pasted key or token never reaches a row), at most ``MAX_REASON`` characters; '' for none."""
    if value is None:
        return ''
    if not isinstance(value, str):
        raise _invalid(f'reason is text: why the change is made, at most {MAX_REASON} characters')
    from engineering.quality_gate.text import redact

    text = ' '.join(''.join(char if char.isprintable() else ' ' for char in redact(value)).split())
    if len(text) > MAX_REASON:
        raise _invalid(f'reason is at most {MAX_REASON} characters')
    return text


def parse_request(body: Mapping[str, object]) -> ConnectionRequest:
    """A save's body, each field checked (``ConnectionRefused('invalid')`` naming the field, never its value)."""
    if not set(body) <= _FIELDS or not {'host', 'repository', 'default_branch'} <= set(body):
        raise _invalid('the body is {host, repository, default_branch, credential?, reason?}')
    if body['host'] not in HOSTS:
        raise _invalid('host is github (GitLab is planned)')
    branch = body['default_branch']
    if not isinstance(branch, str) or not is_branch_name(branch):
        raise _invalid('default_branch is a branch name git accepts (letters, digits, ".", "_", "-" and "/", at most '
                       '255), not an agent\'s voc-agent/ branch')
    credential = body.get('credential')
    return ConnectionRequest(host=str(body['host']), repository=_repository(body['repository']), default_branch=branch,
                             credential=None if credential is None else _credential(credential),
                             reason=parse_reason(body.get('reason')))


@dataclass(frozen=True)
class AttestationRequest:
    """A checked attestation: the points confirmed, the repository and the connection's version the administrator
    reviewed (what the dialog showed), and their reason ('' for none)."""

    points: tuple[str, ...]
    repository: str
    version: int
    reason: str = ''


def parse_attestation(body: Mapping[str, object]) -> AttestationRequest:
    """An attestation's body, ``{points, repository, version, reason?}``: every point of the setup guide confirmed
    (``attestations.POINTS``), the repository and the connection's version the administrator reviewed, and their
    reason; ``ConnectionRefused('invalid')`` naming what is off, never echoing a value."""
    if not set(body) <= {'points', 'repository', 'version', 'reason'} or not {'points', 'repository', 'version'} <= set(body):
        raise _invalid('the body is {points, repository, version, reason?}: the setup guide\'s points confirmed for '
                       'the repository and the connection version reviewed')
    repository, version = body['repository'], body['version']
    if not isinstance(repository, str) or not REPOSITORY.fullmatch(repository):
        raise _invalid('repository is the connection\'s repository as owner/name, as the attestation reviewed it')
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise _invalid('version is the connection\'s version the attestation reviewed (a positive whole number)')
    points = body['points']
    if not isinstance(points, list) or not all(isinstance(point, str) for point in points):
        raise _invalid('points is the list of the setup guide\'s points confirmed, each by its id')
    if not set(points) <= set(POINTS):
        raise _invalid(f'points names a point the setup guide does not have (its points: {", ".join(POINTS)})')
    missing = [point for point in POINTS if point not in points]
    if missing:
        raise _invalid(f'every point of the setup guide is confirmed: not yet {", ".join(missing)}')
    return AttestationRequest(points=POINTS, repository=repository, version=version,
                              reason=parse_reason(body.get('reason')))


def parameter_value(repository: str, credential: AppCredential) -> str:
    """The parameter's JSON, as the broker's reader parses it (credentials.py ``parse_credential``)."""
    value = json.dumps({'app_id': credential.app_id, 'installation_id': credential.installation_id,
                        'repository': repository, 'private_key': credential.private_key})
    if len(value.encode()) > MAX_PARAMETER_BYTES:
        raise _invalid('private_key is larger than a credential holds (4 KB with the rest): use the App\'s own '
                       '2048-bit key')
    return value


def _name(text: str) -> str:
    return ''.join(char for char in text if char.isprintable())[:_MAX_NAME] or UNNAMED


def view(item: Mapping[str, Any], attestation: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """A stored connection as the API answers it: never a secret, only whether the credential is set; and its CI
    attestation's newest version (``attestation``, None for none)."""
    texts = {field: item[field] if isinstance(item.get(field), str) and item[field] else None for field in _OPTIONAL_TEXT}
    return {
        'connection_id': str(item.get('connection_id', '')), 'host': str(item.get('host', 'github')),
        'repository': str(item.get('repository', '')), 'default_branch': str(item.get('default_branch', '')),
        'credential': {'kind': 'app', 'set': item.get('credential_set') is True,
                       'app_id': texts['app_id'], 'installation_id': texts['installation_id']},
        **{field: texts[field] for field in ('created_at', 'created_by', 'updated_at', 'updated_by')},
        # (what an attestation names as the version it reviewed: any change of the connection moves it)
        'version': int(item.get('version', 0)),
        'ci_attestation': attestations.view(attestation),
    }


def _key(connection_id: str) -> dict[str, str]:
    return {'pk': PARTITION, 'sk': f'{ROW_PREFIX}{connection_id}'}


def _row(table: Any, connection_id: str) -> dict[str, Any] | None:
    try:
        return table.get_item(Key=_key(connection_id), ConsistentRead=True).get('Item')
    except (ClientError, BotoCoreError) as exc:
        raise ConnectionRefused('unavailable', 'the connection could not be read: retry') from exc


def stored_connection(table: Any, connection_id: str) -> dict[str, Any] | None:
    """A stored connection as the API answers it (None for none, or a removed one): a run's start reads its
    repository."""
    item = _row(table, check_connection_id(connection_id))
    return None if item is None or item.get('removed') is True else view(item)


def _canceled(error: ClientError) -> bool:
    return error_code(error) in {'TransactionCanceledException', 'ConditionalCheckFailedException'}


class ConnectionStore:
    """The connections over voc-agents (a boto3 ``Table``), SSM (a client) and the runs' registry (``live_runs``: the
    runs of a connection that have not ended)."""

    def __init__(self, table: Any, ssm: Callable[[], Any], prefix: str, key_id: str,
                 live_runs: Callable[[str], Sequence[str]], clock: Callable[[], datetime] = lambda: datetime.now(UTC)
                 ) -> None:
        self._table = table
        self._ssm = ssm
        self._prefix = prefix
        self._key_id = key_id
        self._live_runs = live_runs
        self._clock = clock

    # --- reads ------------------------------------------------------------------------------------------------

    def _rows(self) -> list[dict[str, Any]]:
        return query_all(self._table, {
            'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :row)', 'ConsistentRead': True,
            'ExpressionAttributeValues': {':pk': PARTITION, ':row': ROW_PREFIX}})

    def list(self) -> list[dict[str, Any]]:
        """The stored connections (not the removed ones), by id, each with its CI attestation's newest version (one
        Query of one row per connection: at most ``MAX_CONNECTIONS``)."""
        try:
            return [view(item, attestations.newest(self._table, str(item.get('connection_id', ''))))
                    for item in self._rows() if item.get('removed') is not True]
        except (ClientError, BotoCoreError) as exc:
            raise ConnectionRefused('unavailable', 'the connections could not be read: retry') from exc

    def _row(self, connection_id: str) -> dict[str, Any] | None:
        return _row(self._table, connection_id)

    def _newest_attestation(self, connection_id: str) -> dict[str, Any] | None:
        try:
            return attestations.newest(self._table, connection_id)
        except (ClientError, BotoCoreError) as exc:
            raise ConnectionRefused('unavailable', 'the CI attestation could not be read: retry') from exc

    # --- writes -----------------------------------------------------------------------------------------------

    def _parameter(self, connection_id: str) -> str:
        if not (self._prefix and self._key_id):
            raise ConnectionRefused('unavailable', 'connections cannot be stored here: the deployment names no '
                                                   'parameter path or key')
        return f'{self._prefix}{connection_id}'

    def _put_credential(self, name: str, value: str, connection_id: str) -> None:
        try:
            self._ssm().put_parameter(Name=name, Value=value, Type='SecureString', KeyId=self._key_id,
                                      Overwrite=True, Tier='Standard')
        except (ClientError, BotoCoreError) as error:
            logger.warning('engineering connection credential not stored',
                           extra={'connection_id': connection_id, 'error_code': error_code(error)})
            raise ConnectionRefused('unavailable', 'the credential could not be stored: save again') from None

    def _delete_credential(self, name: str, connection_id: str) -> None:
        ssm = self._ssm()
        try:
            ssm.delete_parameter(Name=name)
        except ssm.exceptions.ParameterNotFound:
            return   # (already gone)
        except (ClientError, BotoCoreError) as error:
            logger.warning('engineering connection credential not removed',
                           extra={'connection_id': connection_id, 'error_code': error_code(error)})
            raise ConnectionRefused('unavailable', 'the credential could not be removed: remove it again') from None

    def _check_save(self, connection_id: str, request: ConnectionRequest, before: Mapping[str, Any] | None) -> None:
        earlier: Mapping[str, Any] = before or {}
        if before is None or earlier.get('removed') is True:
            if request.credential is None:
                raise _invalid('credential is needed to add a connection')
            if sum(1 for item in self._rows() if item.get('removed') is not True) >= MAX_CONNECTIONS:
                raise ConnectionRefused('conflict', f'at most {MAX_CONNECTIONS} connections: remove one to add another')
        elif request.credential is None and (earlier.get('credential_set') is not True
                                              or earlier.get('repository') != request.repository):
            raise _invalid('credential is needed again: the stored one holds the repository it was saved with')
        if before is not None and earlier.get('repository') != request.repository:
            runs = self._live_runs(connection_id)
            if runs:
                raise ConnectionRefused('conflict', f'{len(runs)} run(s) of this connection are live: the repository '
                                                    'changes once they end (or stop them first)')

    def save(self, connection_id: str, request: ConnectionRequest, actor: Actor) -> tuple[dict[str, Any], bool]:
        """Store the connection (its credential first, when the save carries one), with its audit row; the
        connection as stored and whether it was created."""
        check_connection_id(connection_id)
        name = self._parameter(connection_id)
        try:
            before = self._row(connection_id)
            self._check_save(connection_id, request, before)
        except (ClientError, BotoCoreError) as exc:
            raise ConnectionRefused('unavailable', 'the connection could not be read: retry') from exc
        earlier: Mapping[str, Any] = before or {}
        live = before is not None and earlier.get('removed') is not True
        moved = live and earlier.get('repository') != request.repository
        # (a repository change voids the attestation: it stood for the repository the connection had)
        attestation = self._newest_attestation(connection_id) if live else None
        credential = request.credential
        if credential is not None:
            self._put_credential(name, parameter_value(request.repository, credential), connection_id)
        at, who = self._clock().astimezone(UTC).isoformat(), _name(actor.name)
        # (a save without a credential is one of a live connection whose credential is set: _check_save)
        item: dict[str, Any] = {
            **_key(connection_id), 'connection_id': connection_id, 'host': request.host,
            'repository': request.repository, 'default_branch': request.default_branch, 'credential_set': True,
            'app_id': credential.app_id if credential else earlier.get('app_id'),
            'installation_id': str(credential.installation_id) if credential else earlier.get('installation_id'),
            'created_at': earlier.get('created_at') if live else at,
            'created_by': earlier.get('created_by') if live else who,
            'updated_at': at, 'updated_by': who, 'version': int(earlier.get('version', 0)) + 1,
        }
        item = {key: value for key, value in item.items() if value is not None}
        changes: dict[str, Any] = {
            field: {'from': earlier.get(field) if live else None, 'to': item.get(field)}
            for field in _AUDITED if not live or earlier.get(field) != item.get(field)}
        changes['credential'] = 'replaced' if credential is not None else 'kept'
        void = self._void(attestation if moved else None, attestations.REPOSITORY_CHANGED, actor, at)
        if void is not None:
            changes['ci_attestation'] = attestations.VOIDED
        audit = self._audit(connection_id, 'updated' if live else 'created', changes, actor, at, item['version'],
                            request.reason)
        undo = self._credential_undo(connection_id, name, live, actor) if credential is not None else None
        self._write(item, before, audit, undo=undo, extra=() if void is None else (void,))
        logger.info('engineering connection saved', extra={'connection_id': connection_id, 'connection_created': not live,
                                                            'credential_replaced': credential is not None})
        return view(item, attestation if void is None else void['Put']['Item']), not live

    def _void(self, attestation: Mapping[str, Any] | None, cause: str, actor: Actor, at: str) -> dict[str, Any] | None:
        """The transaction's Put voiding ``attestation`` when it is one (``attestations.void_put``), else None."""
        return attestations.void_put(self._table.name, attestation, cause, by=_name(actor.subject),
                                     by_name=_name(actor.name), at=at)

    def remove(self, connection_id: str, actor: Actor, reason: str = '') -> None:
        """Remove the connection: its credential first (the broker refuses its runs once its cached copy goes), then
        its row is marked removed, with its audit row (``reason``, checked by ``parse_reason``, on it). 404 for a
        connection that is not stored."""
        check_connection_id(connection_id)
        name = self._parameter(connection_id)
        before = self._row(connection_id)
        if before is None or before.get('removed') is True:
            raise ConnectionRefused('not_found', 'Connection not found')
        attestation = self._newest_attestation(connection_id)
        self._delete_credential(name, connection_id)
        at = self._clock().astimezone(UTC).isoformat()
        version = int(before.get('version', 0)) + 1
        item = {**before, 'removed': True, 'credential_set': False, 'removed_at': at,
                'removed_by': _name(actor.name), 'version': version}
        changes = {'repository': {'from': before.get('repository'), 'to': None}, 'credential': 'removed'}
        void = self._void(attestation, attestations.CONNECTION_REMOVED, actor, at)
        if void is not None:
            changes['ci_attestation'] = attestations.VOIDED
        self._write(item, before, self._audit(connection_id, 'removed', changes, actor, at, version, reason),
                    undo=self._credential_undo(connection_id, name, True, actor), extra=() if void is None else (void,))
        logger.info('engineering connection removed', extra={'connection_id': connection_id})

    # --- the CI attestation ----------------------------------------------------------------------------------------

    def _live_row(self, connection_id: str) -> dict[str, Any]:
        row = self._row(check_connection_id(connection_id))
        if row is None or row.get('removed') is True:
            raise ConnectionRefused('not_found', 'Connection not found')
        return row

    def attest(self, connection_id: str, request: AttestationRequest, actor: Actor) -> tuple[dict[str, Any], bool]:
        """Record an administrator's confirmation of the setup guide's points (``parse_attestation``) for the
        repository they reviewed: the new version and True, or the one that already holds and False (nothing
        written). It is the connection's only while the connection still holds that repository at that version:
        409 otherwise (another administrator changed it after the dialog was shown), checked on the row read and
        again in the transaction's own condition, so a change landing in between refuses the write. 404 for a
        connection that is not stored."""
        row = self._live_row(connection_id)
        if row.get('repository') != request.repository or int(row.get('version', 0)) != request.version:
            raise ConnectionRefused('conflict', _REVIEWED_CHANGED)
        newest = self._newest_attestation(connection_id)
        if attestations.is_attested(newest, request.repository):
            return attestations.view(newest) or {}, False
        at = self._clock().astimezone(UTC).isoformat()
        item = attestations.version_row(connection_id, attestations.version_of(newest) + 1, ATTESTED,
                                        request.repository, by=_name(actor.subject), by_name=_name(actor.name), at=at,
                                        points=request.points, reason=request.reason)
        self._attestation_write(row, item, newest, actor, request.reason)
        logger.info('engineering CI attestation recorded', extra={'connection_id': connection_id,
                                                                   'attestation_version': item['version']})
        return attestations.view(item) or {}, True

    def withdraw(self, connection_id: str, actor: Actor, reason: str = '') -> None:
        """Withdraw the connection's attestation (a new version, ``withdrawn``): the broker refuses every push and pull
        request on it again. 404 when none holds."""
        row = self._live_row(connection_id)
        repository = str(row.get('repository', ''))
        newest = self._newest_attestation(connection_id)
        if not attestations.is_attested(newest, repository):
            raise ConnectionRefused('not_found', 'no CI attestation holds for this connection')
        at = self._clock().astimezone(UTC).isoformat()
        item = attestations.version_row(connection_id, attestations.version_of(newest) + 1, WITHDRAWN, repository,
                                        by=_name(actor.subject), by_name=_name(actor.name), at=at, reason=reason)
        self._attestation_write(row, item, newest, actor, reason)
        logger.info('engineering CI attestation withdrawn', extra={'connection_id': connection_id,
                                                                    'attestation_version': item['version']})

    def _attestation_write(self, row: Mapping[str, Any], item: Mapping[str, Any], newest: Mapping[str, Any] | None,
                           actor: Actor, reason: str) -> None:
        """The version row, the connection's audit row and a bump of the connection row's version, in one transaction.
        The bump is conditioned on the version read and on the row still holding the version row's repository (the one
        reviewed), so a change of the connection made meanwhile, its repository's above all, refuses this (409)."""
        connection_id = str(item['connection_id'])
        version = int(row.get('version', 0)) + 1
        action = 'ci_attested' if item['state'] == ATTESTED else 'ci_withdrawn'
        changes = {'ci_attestation': {'from': None if newest is None else newest.get('state'), 'to': item['state'],
                                      'version': item['version'], 'repository': item['repository']}}
        audit = self._audit(connection_id, action, changes, actor, str(item['at']), version, reason)
        try:
            self._table.meta.client.transact_write_items(TransactItems=[
                {'Update': {'TableName': self._table.name, 'Key': _key(connection_id),
                            'UpdateExpression': 'SET #version = :version',
                            'ConditionExpression': ('#version = :read AND #repository = :reviewed '
                                                    'AND attribute_not_exists(removed)'),
                            'ExpressionAttributeNames': {'#version': 'version', '#repository': 'repository'},
                            'ExpressionAttributeValues': {':version': version, ':read': row.get('version', 0),
                                                          ':reviewed': item['repository']}}},
                {'Put': {'TableName': self._table.name, 'Item': dict(item),
                         'ConditionExpression': 'attribute_not_exists(sk)'}},   # (D1: create-only)
                {'Put': {'TableName': self._table.name, 'Item': audit, 'ConditionExpression': 'attribute_not_exists(sk)'}},
            ])
        except (ClientError, BotoCoreError) as error:
            logger.warning('engineering CI attestation not recorded', extra={
                'connection_id': connection_id, 'error_code': error_code(error)})
            if isinstance(error, ClientError) and _canceled(error):
                raise ConnectionRefused('conflict', _REVIEWED_CHANGED) from None
            raise ConnectionRefused('unavailable', 'the CI attestation could not be recorded: try again') from None

    def _audit(self, connection_id: str, action: str, changes: Mapping[str, Any], actor: Actor, at: str,
               version: int, reason: str = '') -> dict[str, Any]:
        """The change's create-only audit row (D4): who, when, what and, when given, why; never the private key."""
        row = {'pk': PARTITION, 'sk': f'{LOG_PREFIX}{at}#{secrets.token_hex(4)}', 'connection_id': connection_id,
               'action': action, 'changes': dict(changes), 'by': _name(actor.subject), 'by_name': _name(actor.name),
               'at': at, 'version': version}
        return {**row, 'reason': reason} if reason else row

    def _credential_undo(self, connection_id: str, name: str, live: bool, actor: Actor) -> Callable[[], None]:
        """What a changed credential needs when its row is not written: a new connection's parameter is deleted
        again, unless another save stored the connection meanwhile (``_undo_new``); a stored connection's row is
        marked credential not set (its parameter, replaced or deleted, no longer matches the row, so the page says so
        and the next save needs the credential; the broker still refuses a run whose repository the parameter does
        not name)."""
        if not live:
            return lambda: self._undo_new(connection_id, name, actor)
        return lambda: self._mark_unset(connection_id, actor)

    def _undo_new(self, connection_id: str, name: str, actor: Actor) -> None:
        """A new connection's save whose row was not written: two administrators adding the same id at once both put
        the parameter, and the save that wrote its row first won. The row is read again: with none stored (or a
        removed one) the parameter is deleted; once a save stored one, the parameter is never deleted (it may be the
        winner's), but it may hold this save's credential instead, so the stored row is marked credential not set
        (its next save needs the credential; the broker refuses a run whose repository the parameter does not name).
        After a delete the row is read once more: a save that put its parameter just before the delete and wrote its
        row after it is marked not set too. A row that cannot be read is taken as none: the parameter is deleted,
        failing closed (a winner's runs are refused until its credential is saved again).

        One ordering is not prevented: this save's row write fails for another reason than a conflict, another save
        puts its parameter, this undo (finding no row yet) deletes it, and the other save's row is written after the
        second read. SSM has no conditional delete and this role cannot read a parameter, so the delete cannot be
        held to this save's own version. It fails closed: that row says its credential is set with none behind it,
        so the broker reads no credential and refuses every run on the connection (503) until it is saved again
        with its credential; no run is ever served with another save's credential."""
        try:
            row = self._row(connection_id)
        except ConnectionRefused:
            row = None
        if row is None or row.get('removed') is True:
            self._delete_credential(name, connection_id)
            row = self._row(connection_id)
        if row is not None and row.get('removed') is not True and row.get('credential_set') is True:
            self._mark_unset(connection_id, actor)

    def _mark_unset(self, connection_id: str, actor: Actor) -> None:
        at = self._clock().astimezone(UTC).isoformat()
        try:
            row = self._row(connection_id)
            if row is None:
                return
            version = int(row.get('version', 0)) + 1
            audit = self._audit(connection_id, 'credential_unset', {'credential': 'not recorded'}, actor, at, version)
            self._table.meta.client.transact_write_items(TransactItems=[
                {'Update': {'TableName': self._table.name, 'Key': _key(connection_id),
                            'UpdateExpression': 'SET credential_set = :unset, #version = :version',
                            'ConditionExpression': '#version = :read',
                            'ExpressionAttributeNames': {'#version': 'version'},
                            'ExpressionAttributeValues': {':unset': False, ':version': version,
                                                          ':read': row.get('version', 0)}}},
                {'Put': {'TableName': self._table.name, 'Item': audit, 'ConditionExpression': 'attribute_not_exists(sk)'}},
            ])
        except (ClientError, BotoCoreError):
            raise ConnectionRefused('unavailable', 'the connection could not be recorded') from None

    def _write(self, item: Mapping[str, Any], before: Mapping[str, Any] | None, audit: Mapping[str, Any],
               undo: Callable[[], None] | None = None, extra: Sequence[Mapping[str, Any]] = ()) -> None:
        """The row and its audit row in one transaction, the row conditioned on the version read (``extra``: the
        attestation's void, when the change voids it)."""
        if before is None:
            condition: dict[str, Any] = {'ConditionExpression': 'attribute_not_exists(sk)'}
        else:
            condition = {'ConditionExpression': '#version = :version', 'ExpressionAttributeNames': {'#version': 'version'},
                         'ExpressionAttributeValues': {':version': before.get('version', 0)}}
        try:
            self._table.meta.client.transact_write_items(TransactItems=[
                {'Put': {'TableName': self._table.name, 'Item': dict(item), **condition}},
                {'Put': {'TableName': self._table.name, 'Item': dict(audit),
                         'ConditionExpression': 'attribute_not_exists(sk)'}},   # (D1: create-only)
                *(dict(write) for write in extra),
            ])
        except (ClientError, BotoCoreError) as error:
            if undo is not None:
                try:
                    undo()   # (the credential changed for a row that was not written: _credential_undo)
                except ConnectionRefused:
                    logger.exception('engineering connection credential and row disagree',
                                 extra={'connection_id': item.get('connection_id')})
            logger.warning('engineering connection not recorded', extra={
                'connection_id': item.get('connection_id'), 'error_code': error_code(error)})
            if isinstance(error, ClientError) and _canceled(error):
                raise ConnectionRefused('conflict', 'the connection changed meanwhile: reload it and save again') \
                    from None
            raise ConnectionRefused('unavailable', 'the connection could not be saved: save again') from None


def live_runs_of(runs: Any) -> Callable[[str], list[str]]:
    """The runs of a connection that have not ended, from the runs' registry (``runtime/runs.py`` RunStore: the
    runs the supervisor watches, one Query, then each listed run's META, read consistently)."""
    from engineering.runtime.runs import ENDED

    def live(connection_id: str) -> list[str]:
        found = []
        for run_id in runs.listed():
            run = runs.get(run_id)
            if run is not None and run.connection == connection_id and run.status not in ENDED:
                found.append(run_id)
        return found

    return live
