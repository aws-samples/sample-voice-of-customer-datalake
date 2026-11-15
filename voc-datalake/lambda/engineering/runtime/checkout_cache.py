"""The runtime's side of the checkout cache: which generation of a run's entry is usable, and its fill before the
first launch.

An agent clones its run's commit from the cache (``checkout.py``), so no agent is launched on a commit with no usable
entry (``engineering/connectors/cache_layout.py``): the launch is refused, in words the coordinator reads
(``RuntimeRefused``, a 409 from the board), and a launch that finds one records its generation on the agent's
session, from which its checkout clones. Usable is READY of the current generation ``N``, or of ``N - 1`` when its
manifest was written under 28 days ago (``cache_layout.previous_usable``): an entry in use is so always at least two
days from the cache's 30-day expiry, and none is ever rewritten. The runtime fills generation ``N`` before it launches
a run's coordinator when neither is, in an invocation of its own (``handler.launch_coordinator``): it invokes
voc-engineering-cache (``ENGINEERING_CACHE_FUNCTION``) and waits for it. A fill that meets another fill's claim waits
for that one's READY.

This role reads ``engineering/cache/*/*/*/READY`` only and lists nothing, so S3 answers a missing READY 403, as it
answers a READY the role may not read: the two cannot be told apart without a ListBucket on the whole raw bucket. A
403 is so taken as missing, logged apart (not counted as a denied read, which every entry not filled yet would
trip), and marked on what
``look`` answers (``Found.denied``): once a fill has written READY and a 403 still answers, the role cannot read the
cache, and the run is refused saying so (``DENIED``), never held in silence.

An entry of generation ``N`` whose manifest names another repository than the run's (a connection repointed since it
was filled) is passed over for the run's own usable ``N - 1``; with none, it launches nothing until the next
generation. One of ``N - 1`` of another repository is ignored, and ``N`` filled.
"""
from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Final, Literal

from botocore.exceptions import BotoCoreError, ClientError

from engineering.connectors.cache_layout import EntryRefused, claim_key, generation_at, previous_usable, ready_key
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.supervisor import SessionBusy
from engineering.workspace.store import DENIED_CODES, MISSING_CODES
from shared.logging import logger

#: How long the runtime waits for a fill: the cache function's own limit (lib/stacks/engineering-cache.ts, 240 s)
#: and a cold start of its image (up to 30 s), inside this function's 300 s; the coordinator's launch is a later
#: invocation of its own.
FILL_READ_TIMEOUT_SECONDS: Final = 270
#: The cache function's refusals the runtime passes on in their own words (each a plain sentence, already redacted);
#: its ``CacheBusy`` (another fill holds the claim) is a launch under way, ``SessionBusy``.
FILL_REFUSALS: Final = frozenset({'EntryRefused', 'CacheFailed'})
FILL_BUSY: Final = 'CacheBusy'
#: How long a fill that met another fill's claim waits for that one's READY (the busy answer is immediate, so this
#: fits the invocation's 300 s), and how often it reads.
BUSY_WAIT_SECONDS: Final = 210
BUSY_POLL_SECONDS: Final = 10
NOT_READY: Final = ('the run\'s commit has no usable checkout in the cache: no agent can be launched on it until it '
                    'is filled (a person\'s Resume of the run fills it)')
#: NOT_READY's words when a fill of the commit was just handed on, or one holds its claim: nobody needs to act yet.
FILLING: Final = ('the run\'s commit has no usable checkout in the cache yet: a fill of it is under way; try the launch '
                  'again in a few minutes')
DENIED: Final = ('the role cannot read the checkout cache (403): its READY was written, and S3 still refuses the '
                 'read; an administrator checks the runtime role\'s grant on engineering/cache/ and the key')
FOREIGN: Final = ('the cached checkout of the run\'s commit is of {cached}, not of the run\'s repository {repository} '
                  '(its connection was repointed since): no agent is launched on this commit through this connection '
                  'until the cache\'s next generation (within 14 days); meanwhile point the connection back to '
                  '{cached}, or start the run on another commit')
UNASKED: Final = ('the run\'s checkout could not be cached: the cache writer could not be asked, or did not answer in '
                  'time')
#: READY's manifest is small (a handful of files); more is not read.
MAX_MANIFEST_BYTES: Final = 256 * 1024
EntryState = Literal['ready', 'missing', 'refused']
WaitEnd = Literal['ready', 'lapsed', 'held']


class CheckoutUnavailable(RuntimeRefused):
    """The run's commit could not be put in the cache (the writer refused or failed, the role cannot read it): its
    words are the writer's own, already redacted, and the run goes to a person at the ``checkout_cache`` point.
    ``transient``: a failure a later try may not meet (the writer's ``CacheFailed``: a slow or busy host, a fetch
    past its budget; an invoke that failed or timed out); not a refusal (``EntryRefused``, another repository's
    entry, a role that cannot read the cache)."""

    def __init__(self, reason: str, *, transient: bool = False) -> None:
        super().__init__(reason)
        self.transient = transient


@dataclass(frozen=True)
class Found:
    """What the cache holds for a run: ``ready`` (``generation`` is the one to clone), ``missing`` (fill
    ``generation``, the current one) or ``refused`` (``refusal`` says why)."""

    state: EntryState
    generation: int
    #: The cache's current generation (``generation`` is one less when the previous one is what is usable).
    current: int
    refusal: str = ''
    #: A READY read of the current generation answered 403: missing, or a role that cannot read it.
    denied: bool = False
    #: The current generation has a READY (of another repository, when ``generation`` is not ``current``): no fill
    #: can replace it, so none is asked for.
    current_written: bool = False

    @property
    def fill_ahead(self) -> bool:
        """Only the previous generation serves, and the current one has no READY yet: worth filling ahead."""
        return self.state == 'ready' and self.generation != self.current and not self.current_written


@dataclass(frozen=True)
class CheckoutCache:
    """``look`` reads READY (S3); ``fill`` invokes the cache function and waits for it; ``fill_under_way`` reads the
    fill's claim row (voc-engineering)."""

    s3: Any
    bucket: str
    #: boto3's Lambda client with ``FILL_READ_TIMEOUT_SECONDS`` (or a test's), and the cache function's name ('' none).
    lambda_client: Any
    function_name: str
    #: boto3's DynamoDB client and voc-engineering, where the claim rows are (``fill_under_way``).
    dynamodb: Any = None
    table: str = ''
    clock: Callable[[], float] = field(default=time.time)
    sleep: Callable[[float], None] = field(default=time.sleep)

    def _manifest(self, connection: str, commit: str, generation: int) -> dict[str, Any] | Literal['denied'] | None:
        """The READY manifest of ``generation`` (``{}`` when it does not read), None without one, ``denied`` on 403."""
        try:
            key = ready_key(connection, commit, generation)
        except EntryRefused as refused:
            raise RuntimeRefused(str(refused)) from None
        try:
            answer = self.s3.get_object(Bucket=self.bucket, Key=key)
        except ClientError as error:
            code = str(error.response.get('Error', {}).get('Code'))
            if code in DENIED_CODES:
                # (logged apart, never counted as a denied read: every entry not filled yet answers it)
                logger.info('engineering runtime: a READY read answered 403 (missing, or not readable)',
                            extra={'key': key})
                return 'denied'
            if code in MISSING_CODES:
                return None
            raise
        try:
            body = json.loads(answer['Body'].read(MAX_MANIFEST_BYTES))
        except ValueError:
            return {}
        return body if isinstance(body, dict) else {}

    def look(self, connection: str, commit: str, repository: str) -> Found:
        """The usable entry for a run on ``repository`` (``owner/name``): generation ``N``'s, else ``N - 1``'s while
        its manifest is under 28 days old; else ``N`` to fill."""
        now = self.clock()
        current = generation_at(now)
        found = self._manifest(connection, commit, current)
        if isinstance(found, dict) and str(found.get('repository') or '') == repository:
            return Found('ready', current, current)
        if current > 0:
            # (N - 1 serves too when N is of another repository: a connection repointed and then pointed back)
            previous = self._manifest(connection, commit, current - 1)
            if isinstance(previous, dict) and previous.get('repository') == repository \
                    and previous_usable(str(previous.get('written_at') or ''), now):
                return Found('ready', current - 1, current, current_written=isinstance(found, dict))
        if isinstance(found, dict):
            cached = str(found.get('repository') or '')
            return Found('refused', current, current, FOREIGN.format(cached=cached or 'an unknown repository',
                                                                     repository=repository or '(none recorded)'))
        return Found('missing', current, current, NOT_READY, denied=found == 'denied')

    def wait_for(self, connection: str, commit: str, repository: str, generation: int) -> WaitEnd:
        """Wait for another fill of ``generation`` (one that holds its claim) to write READY: read READY and the claim
        every ``BUSY_POLL_SECONDS`` for at most ``BUSY_WAIT_SECONDS``. ``ready`` once a READY is there (usable or
        not); ``lapsed`` when the claim's lease ends with no READY (that fill crashed: a fresh invocation takes it
        over, since a fill no longer fits in this one); ``held`` when the wait ran out under a live claim."""
        for _ in range(BUSY_WAIT_SECONDS // BUSY_POLL_SECONDS):
            if self.look(connection, commit, repository).state != 'missing':
                return 'ready'
            if not self.fill_under_way(connection, commit, generation):
                return 'lapsed'
            self.sleep(BUSY_POLL_SECONDS)
        return 'ready' if self.look(connection, commit, repository).state != 'missing' else 'held'

    def fill_under_way(self, connection: str, commit: str, generation: int) -> bool:
        """Whether a fill of ``generation`` holds a live claim (its lease not ended): a read of the claim's
        ``expires_at`` only. A read that fails answers False (a handoff more, never one fewer)."""
        if self.dynamodb is None or not self.table:
            return False
        try:
            item = self.dynamodb.get_item(TableName=self.table, Key=claim_key(connection, commit, generation),
                                          ConsistentRead=True, ProjectionExpression='expires_at').get('Item') or {}
        except (ClientError, BotoCoreError):
            logger.warning('engineering runtime: a fill\'s claim could not be read', extra={'commit': commit})
            return False
        try:
            return float(item.get('expires_at', {}).get('N', '0')) > self.clock()
        except ValueError:
            return False

    def fill(self, connection: str, commit: str, generation: int) -> None:
        """The entry of ``generation`` filled (or found ready) by the cache function, waited for: a fill it refused or
        could not make is ``CheckoutUnavailable`` in its words, one another fill holds ``SessionBusy``."""
        if not self.function_name:
            raise CheckoutUnavailable('this deployment has no checkout cache writer: no agent can be launched')
        try:
            answer = self.lambda_client.invoke(
                FunctionName=self.function_name, InvocationType='RequestResponse',
                Payload=json.dumps({'connection': connection, 'commit': commit, 'generation': generation}).encode())
            read = json.loads(answer['Payload'].read() or b'{}')
        except ClientError as error:
            if error.response.get('Error', {}).get('Code') == 'ResourceNotReadyException':
                # (a container-image function idle for weeks goes Inactive; Lambda wakes it on this first call)
                raise CheckoutUnavailable('the run\'s checkout could not be cached: the cache writer had been idle '
                                          'and is being woken; a Resume of the run in a few minutes fills it',
                                          transient=True) from None
            raise CheckoutUnavailable(UNASKED, transient=True) from None
        except (BotoCoreError, ValueError, KeyError):
            # (a throttle, a refusal of the invoke, a read past FILL_READ_TIMEOUT_SECONDS, an answer that does not read)
            raise CheckoutUnavailable(UNASKED, transient=True) from None
        payload: dict[str, Any] = read if isinstance(read, dict) else {}
        if answer.get('FunctionError'):
            said, kind = str(payload.get('errorMessage') or '')[:500], payload.get('errorType')
            if kind == FILL_BUSY:
                raise SessionBusy(f'the run\'s checkout is being cached: {said}')
            if kind not in FILL_REFUSALS:
                said = ''
            # (only the writer's own refusal is final; its failure, or one of its own kind, may pass)
            raise CheckoutUnavailable(f'the run\'s checkout could not be cached: {said or "the cache writer failed"}',
                                      transient=kind != 'EntryRefused')
        if payload.get('status') not in ('ready', 'filled'):
            raise CheckoutUnavailable('the run\'s checkout could not be cached: the cache writer answered otherwise',
                                      transient=True)
