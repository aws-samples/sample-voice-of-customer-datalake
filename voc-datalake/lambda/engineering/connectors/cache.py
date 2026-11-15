"""voc-engineering-cache: the checkout cache's writer (docs/autonomous-engineering.md, "The checkout cache").

``{"connection", "commit", "generation"}`` → ``{..., "status": "ready" | "filled"}``: the entry of that commit and
generation (``cache_layout.py``, ``g<N>/`` under the commit) made once, before any agent of a run is launched on it
(the runtime invokes this function with the current generation and waits: ``runtime/checkout_cache.py``). A fill
that finds ``READY`` does nothing ("ready"); a generation more than one from this function's own is refused.

Trusted code that runs no repository code: git only fetches. Every git command runs without the system or global
config, hooks, the file-system monitor, credential helpers or terminal prompts, with https the one protocol, no
redirect and no submodule, from a fresh directory under ``/tmp`` that is removed afterwards:

1. ``git init --bare`` (no template: no sample hooks), ``uploadpack.allowFilter`` set (the agents clone with
   ``--filter=blob:none``);
2. ``git fetch --depth=1 --no-tags https://github.com/<owner>/<repo>.git <commit>``, with an installation token for
   ``contents: read`` on the connection's one repository (``github.GitHubHost.fetch_token``, the broker's own minting),
   or, for a GitLab connection, ``https://gitlab.com/<namespace>/<project>.git`` with its own project access token
   (``router.HostRouter.fetch_access``);
3. ``refs/heads/voc-base`` set to the commit (the fetch's refspec), HEAD pointed at it, the commit checked to be
   there, the objects repacked into one pack (the ref stays one loose file: S3 keeps no empty directory, and git
   needs the ``refs/`` directory to open a repository);
4. the files checked against the caps (``cache_layout.check_size``), uploaded under ``repo.git/``, then ``READY``,
   create-only, last.

The token reaches git only through its environment (``GIT_CONFIG_COUNT``/``KEY``/``VALUE``: an ``http.extraHeader``
for that repository's URL, ``Authorization: Basic`` of ``x-access-token:<token>``, as the host documents for an App
installation token over https, or of ``oauth2:<token>`` for a GitLab token), and only for the fetch: never in a URL,
an argument, a file, a log line or an error (a git failure's words are redacted before they are raised). A minted
GitHub token is revoked after the fetch; a GitLab project token is the connection's own and is not.

Two fills of one commit are kept apart by a claim row in voc-engineering (``WS#<ws>#CACHE#<connection>``,
``COMMIT#<commit>#G#<N>``): a conditional put that holds a lease (``LEASE_SECONDS``, longer than the function may run), so
a fill that crashed is taken over once its lease ends. Every step has its time limit, all of them inside the
function's own.
"""
from __future__ import annotations

import base64
import hashlib
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from functools import cache
from typing import Any, Final, Protocol

from botocore.exceptions import BotoCoreError, ClientError

from engineering.connectors.cache_layout import (
    BASE_REF,
    FSCK_REJECTED,
    MAX_ENTRY_BYTES,
    MAX_ENTRY_FILES,
    NO_COMMIT,
    REPOSITORY_DIR,
    EntryFile,
    EntryRefused,
    check_entry,
    check_size,
    claim_key,
    file_key,
    generation_at,
    manifest,
    ready_key,
)
from engineering.connectors.connections import PARAMETER_PREFIX_ENV, REPOSITORY
from engineering.connectors.gitlab_api import GITLAB_URL, is_project_path
from engineering.connectors.hosts import FetchAccess, HostBusy, HostError, NoConnection, remaining_until
from engineering.quality_gate.text import redact
from engineering.workspace.store import DENIED_CODES, MISSING_CODES, WRITE_BACKOFF_S, WRITE_TRIES
from shared.invocation_cost import measure_invocation_cost
from shared.logging import logger

#: The fetch's own budget, and every other git step's (seconds); with the uploads they fit in the function's 240 s
#: (lib/stacks/engineering-cache.ts CACHE_TIMEOUT_SECONDS), which the runtime waits for inside its own 300 s. The
#: fetch gets at most this, and never more than what is left of the fill's deadline less ``FETCH_RESERVE_SECONDS``
#: (a slow mint must not push the writer into Lambda's limit). A fetch past its budget is a failure a later try may
#: not meet (``CacheFailed``, ``FETCH_BUDGET``): too large a repository, or a slow host.
FETCH_TIMEOUT_SECONDS: Final = 150
#: No upload starts that would end, by its estimated time (``UPLOAD_BYTES_PER_SECOND``), past this many seconds into a
#: fill: the function's 240 s less a margin, so a fill that ran long ends in its own words rather than at Lambda's
#: limit (an estimate: an upload far slower than it still meets that limit).
FILL_DEADLINE_SECONDS: Final = 230
UPLOAD_BYTES_PER_SECOND: Final = 50 * 1024 * 1024
REPACK_TIMEOUT_SECONDS: Final = 30
STEP_TIMEOUT_SECONDS: Final = 10
#: A fill's lease on its claim: longer than the function may run, so a live fill's lease never lapses under it.
LEASE_SECONDS: Final = 300
#: How long a fill that failed (``CacheFailed``) keeps its claim after it: during a host outage the launches meanwhile
#: find the fill held rather than each minting a token and starting a fetch (one fill per this long, not one per launch).
FAILED_HOLD_SECONDS: Final = 120
FETCH_BUDGET: Final = ('the fetch did not finish within its budget: the repository is too large for the cache, or the '
                       'host was slow; a Resume tries again')
#: What the steps after the fetch need of the deadline: the symbolic-ref and the check (10 s each), the repack, and
#: the uploads' own margin.
FETCH_RESERVE_SECONDS: Final = 2 * STEP_TIMEOUT_SECONDS + REPACK_TIMEOUT_SECONDS + 30
#: A fetch given less than this is not started: the fill ran out of time before it.
MIN_FETCH_SECONDS: Final = 10
#: The most of a git failure's words that are kept (after redaction).
MAX_GIT_ERROR: Final = 300
HOST_URL: Final = 'https://github.com/'
#: Each host's web address (the fetch's remote) and the user name of its token's Basic authorization: an App's
#: installation token goes as ``x-access-token``, a GitLab project access token as ``oauth2`` (as each host documents
#: for a token over https).
_REMOTES: Final = {'github': (HOST_URL, 'x-access-token'), 'gitlab': (GITLAB_URL, 'oauth2')}
#: What git says when the host refuses the token itself (expired, revoked, or without read access): a refusal.
GIT_DENIED: Final = ('http basic: access denied', 'authentication failed', 'returned error: 401',
                     'returned error: 403')
FETCH_DENIED: Final = ('the repository host refused the connection\'s token (git: access denied): it may have expired '
                       'or lost its access; an administrator replaces it under Agents → Connections')
#: What every git command runs with: no hooks, no file-system monitor, no credential helper, https the only protocol,
#: no redirect, no submodule, every fetched object checked.
GIT_OPTIONS: Final = ('-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=',
                      '-c', 'core.askPass=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
                      '-c', 'http.followRedirects=false', '-c', 'submodule.recurse=false',
                      '-c', 'fetch.fsckObjects=true', '-c', 'init.defaultBranch=voc-base')
#: The files git writes for itself that the entry never needs.
_SKIPPED: Final = frozenset({'FETCH_HEAD', 'ORIG_HEAD', 'index'})
RAW_BUCKET_ENV: Final = 'RAW_DATA_BUCKET'
#: The host's answers to the token request that mean the App may not mint it (a refusal, not a passing failure).
TOKEN_REFUSED: Final = frozenset({401, 403, 404})
#: The 4xx answers to the token request a later try may not meet (a timeout, a rate limit): every other 4xx refuses.
TOKEN_PASSING: Final = frozenset({408, 429})
#: What git's fetch of a commit by id says when the host has no such commit (never pushed, or pushed away since).
GIT_NO_COMMIT: Final = ('not our ref', "couldn't find remote ref", 'unadvertised object', 'no such remote ref')
#: ... when the host has no repository the token can fetch: the host's "Repository not found.", or git's own
#: ``fatal: repository '<url>' not found`` (that form only: another quoted name and "not found" is no such answer).
GIT_NO_REPOSITORY: Final = re.compile(r"repository not found|fatal: repository '[^'\n]*' not found")
#: ... when an object fetched fails its check (``fetch.fsckObjects``).
GIT_FSCK: Final = ('fsck error', 'fsckobjects')
NO_REPOSITORY: Final = ('the repository host has no repository the connection\'s token can fetch (git: not found): an '
                        'administrator checks the connection\'s repository, and that the GitHub App is installed on it '
                        '(or the GitLab token is the project\'s), under Agents → Connections')


class CacheBusy(RuntimeError):
    """Another fill of the commit holds its claim, or the host is rate limiting: try again later."""


class CacheFailed(RuntimeError):
    """The fill failed (git, the host, the store): nothing was marked ready. The reason is redacted."""


class GitFailed(Exception):
    """A git command failed or timed out: ``detail`` is its last words, still unredacted (the filler redacts them)."""

    def __init__(self, step: str, detail: str, *, timed_out: bool = False) -> None:
        super().__init__(step)
        self.step = step
        self.detail = detail
        self.timed_out = timed_out


class GitRunner(Protocol):
    def __call__(self, args: Sequence[str], *, env: Mapping[str, str], timeout: float) -> None: ...


class EntryStore(Protocol):
    def exists(self, key: str) -> bool: ...

    def upload(self, key: str, path: str, sha256: str) -> None:
        """Write ``path`` to ``key``; the store refuses it unless the bytes it stored have ``sha256`` (hex)."""
        ...

    def create(self, key: str, body: bytes) -> bool:
        """Write ``key`` only when it does not exist: False when it already did."""
        ...


#: A claim row's key (``cache_layout.claim_key``), low-level form.
ClaimKey = dict[str, dict[str, str]]


class FillClaims(Protocol):
    def take(self, key: ClaimKey, holder: str, now: float) -> float | None:
        """Take the claim ``key`` for ``holder``; None when taken, else when the other holder's lease ends."""
        ...

    def release(self, key: ClaimKey, holder: str, until: float) -> None:
        """End ``holder``'s lease of ``key`` at ``until`` (now, or later after a failure); never another's."""
        ...


@dataclass(frozen=True)
class SubprocessGit:
    """``git`` itself (the distro's, an absolute path), with ``GIT_OPTIONS`` before every command and only the
    environment it is given: its output is captured, never logged, and a failure carries only its last words."""

    git: str = '/usr/bin/git'

    def __call__(self, args: Sequence[str], *, env: Mapping[str, str], timeout: float) -> None:
        step = args[1] if args and args[0].startswith('--git-dir=') and len(args) > 1 else (args[0] if args else '')
        try:
            done = subprocess.run(  # noqa: S603 — the distro's git, a fixed option list and the filler's own argv
                [self.git, *GIT_OPTIONS, *args], env=dict(env), capture_output=True, timeout=timeout, check=False,
                stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            raise GitFailed(step, f'timed out after {timeout:g} s', timed_out=True) from None
        except OSError as error:
            raise GitFailed(step, error.strerror or 'git could not be run') from None
        if done.returncode != 0:
            raise GitFailed(step, done.stderr.decode('utf-8', 'replace')[-2 * MAX_GIT_ERROR:])


def git_environment(home: str) -> dict[str, str]:
    """The environment of every git command: nothing inherited, no system or global config, no prompt."""
    return {'PATH': '/usr/bin:/bin', 'HOME': home, 'LANG': 'C', 'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': '/bin/false',
            'GIT_NO_REPLACE_OBJECTS': '1'}


def remote_url(repository: str, host: str = 'github') -> str:
    """``https://github.com/<owner>/<name>.git``, or ``https://gitlab.com/<namespace>/<project>.git``: only a
    repository of the host's stored shape."""
    if host == 'gitlab':
        if not is_project_path(repository):
            raise EntryRefused('the connection\'s repository is not a GitLab project path (group/project)')
    elif host != 'github' or not REPOSITORY.fullmatch(repository) or repository.split('/')[1] in {'.', '..'}:
        raise EntryRefused('the connection\'s repository is not an owner/name')
    return f'{_REMOTES[host][0]}{repository}.git'


def authorization(token: str, host: str = 'github') -> str:
    """The header git sends: ``Authorization: Basic`` of ``x-access-token:<token>`` (GitHub) or ``oauth2:<token>``
    (GitLab)."""
    return 'Authorization: Basic ' + base64.b64encode(f'{_REMOTES[host][1]}:{token}'.encode()).decode('ascii')


def token_environment(repository: str, token: str, host: str = 'github') -> dict[str, str]:
    """The token's one way into git: an ``http.<url>.extraHeader`` for that repository's URL, by environment."""
    return {'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': f'http.{remote_url(repository, host)}.extraHeader',
            'GIT_CONFIG_VALUE_0': authorization(token, host)}


def redacted(detail: str, token: str) -> str:
    """A git failure's words with the token, its header forms (either host's) and any credential-shaped string cut
    out, at most ``MAX_GIT_ERROR`` characters, on one line."""
    headers = [authorization(token, host) for host in _REMOTES] if token else []
    for secret in (*headers, *(header.removeprefix('Authorization: Basic ') for header in headers), token):
        if secret:
            detail = detail.replace(secret, '<redacted>')
    return ' '.join(redact(detail).split())[-MAX_GIT_ERROR:]


def fetch_refusal(failed: GitFailed) -> str | None:
    """The refusal a failed fetch is, in words saying what a person does, when every later try would meet it too: no
    such commit on the host, no such repository, an object that fails its check. None for anything else (a host
    outage, a network error, a timeout: a later try may pass). Read from git's last words, case-insensitively."""
    if failed.timed_out:
        return None
    said = failed.detail.lower()
    if any(word in said for word in GIT_NO_COMMIT):
        return NO_COMMIT
    if GIT_NO_REPOSITORY.search(said):
        return NO_REPOSITORY
    if any(word in said for word in GIT_FSCK):
        return FSCK_REJECTED
    if any(word in said for word in GIT_DENIED):
        return FETCH_DENIED
    return None


def entry_files(repository: str, max_bytes: int = MAX_ENTRY_BYTES) -> list[EntryFile]:
    """Every file of the built repository, its size and sha256; refused past ``MAX_ENTRY_FILES`` or
    ``MAX_ENTRY_BYTES`` (counted before any is hashed), and a link or anything but a file is refused."""
    found: list[tuple[str, int]] = []
    for directory, _dirs, names in os.walk(repository):
        for name in names:
            path = os.path.join(directory, name)
            relative = os.path.relpath(path, repository).replace(os.sep, '/')
            if relative in _SKIPPED:
                continue
            if os.path.islink(path) or not os.path.isfile(path):
                raise CacheFailed('the fetched repository holds something other than files')
            found.append((relative, os.path.getsize(path)))
            if len(found) > MAX_ENTRY_FILES:
                check_size([EntryFile(p, s, '') for p, s in found], max_bytes)
    check_size([EntryFile(p, s, '') for p, s in found], max_bytes)
    return [EntryFile(p, s, _sha256(os.path.join(repository, p))) for p, s in sorted(found)]


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass
class CacheFiller:
    """The fill of one entry: its seams are git, the store, the claims, the token and the clock."""

    git: GitRunner
    store: EntryStore
    claims: FillClaims
    #: ``connection`` → its host, repository and read token (``router.HostRouter.fetch_access``: a GitHub installation
    #: token for contents: read on that repository, minted now; or the GitLab connection's own project token).
    tokens: Callable[[str], FetchAccess]
    #: A minted token revoked after the fetch (``GitHubHost.revoke_fetch_token``; tests record it): never a GitLab
    #: project token, the connection's own long-lived credential: no revocation call is made for it (it would cut the
    #: connection).
    revoke: Callable[[str], None] = field(default=lambda _token: None)
    clock: Callable[[], float] = time.time
    holder: Callable[[], str] = field(default=lambda: secrets.token_hex(16))
    #: Where each fill's working directory is made (Lambda's ephemeral storage).
    scratch: str = tempfile.gettempdir()
    max_bytes: int = MAX_ENTRY_BYTES
    #: No file is uploaded past this many seconds into the fill.
    deadline_seconds: float = FILL_DEADLINE_SECONDS

    def fill(self, connection: str, commit: str, generation: int, *, ends_by: float | None = None) -> str:
        """``ready`` when the entry of ``generation`` was already there, ``filled`` when this fill made it. Only the
        current generation, by this function's clock, or one either side of it (a caller across the boundary).
        ``ends_by``: when, by ``clock``, the invocation must be done (Lambda's remaining time less a margin); the fill
        keeps to the earlier of it and ``deadline_seconds`` after it began."""
        check_entry(connection, commit, generation)
        if abs(generation - generation_at(self.clock())) > 1:
            raise EntryRefused('the generation is not the cache\'s current one: ask for the current generation')
        ready = ready_key(connection, commit, generation)
        if self.store.exists(ready):
            return 'ready'
        holder, now = self.holder(), self.clock()
        claim = claim_key(connection, commit, generation)
        lease_ends = self.claims.take(claim, holder, now)
        if lease_ends is not None:
            raise CacheBusy(f'another fill of this commit is under way: try again in {max(1, int(lease_ends - now))} s')
        held_for = 0.0
        try:
            if self.store.exists(ready):   # (finished between the first look and the claim)
                return 'ready'
            return 'filled' if self._fill(connection, commit, generation, ends_by) else 'ready'
        except CacheFailed:
            # A failure a later try may not meet (a host outage, a slow fetch): the claim is kept a while, so the
            # launches meanwhile find a fill held (they wait, or say so) instead of each starting a fetch of its own.
            held_for = FAILED_HOLD_SECONDS
            raise
        finally:
            try:
                self.claims.release(claim, holder, self.clock() + held_for)
            except Exception:   # (its lease ends on its own)
                logger.exception('engineering cache: a claim could not be released', extra={'connection': connection})

    def _fill(self, connection: str, commit: str, generation: int, ends_by: float | None) -> bool:
        work = tempfile.mkdtemp(prefix='voc-cache-', dir=self.scratch)
        try:
            deadline = self.clock() + self.deadline_seconds
            deadline = deadline if ends_by is None else min(deadline, ends_by)
            repository, files = self._build(work, connection, commit, deadline)
            for entry in files:
                # (each upload's own time estimated from its size: the last one of a pack near the cap fits too)
                if self.clock() + entry.size / UPLOAD_BYTES_PER_SECOND > deadline:
                    raise CacheFailed('the fill ran out of its time before the entry was uploaded (a repository near '
                                      'the cap, or a slow link): try again; nothing was marked ready')
                self.store.upload(file_key(connection, commit, generation, entry.path),
                                  os.path.join(work, REPOSITORY_DIR, entry.path), entry.sha256)
            return self.store.create(ready_key(connection, commit, generation),
                                     manifest(connection, repository, commit, generation, files, self.clock()))
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _build(self, work: str, connection: str, commit: str, deadline: float) -> tuple[str, list[EntryFile]]:
        """The repository (``owner/name``) and the files of its entry, built in ``work`` (the fill ends by
        ``deadline``, by ``clock``: the fetch gets what is left of it)."""
        try:
            access = self.tokens(connection)
        except NoConnection:
            raise EntryRefused('the connection has no usable credential: an administrator stores it under '
                               'Agents → Connections') from None
        except HostBusy as busy:
            # (not CacheBusy: that one means another fill holds the claim, which the runtime waits out)
            raise CacheFailed(f'the repository host is busy or unreachable: try again in {busy.retry_after} s') from None
        except HostError as error:
            if error.status in TOKEN_REFUSED:
                # (the App's installation, or its contents permission, gone: no later try meets anything else)
                raise EntryRefused(f'the repository host refused the connection\'s fetch token (it answered '
                                   f'{error.status}): the GitHub App\'s installation or its contents permission may '
                                   'have been removed; an administrator checks it under Agents → Connections') from None
            if 400 <= error.status < 500 and error.status not in TOKEN_PASSING:
                # (a 422, say: the request itself is refused, the same way every time)
                raise EntryRefused(f'the repository host rejected the request for the connection\'s fetch token (it '
                                   f'answered {error.status}): an administrator checks the GitHub App, its '
                                   'installation and its access to the repository, under Agents → Connections') from None
            raise CacheFailed(f'the repository host refused the fetch token ({error})') from None
        repo, token = os.path.join(work, REPOSITORY_DIR), access.token
        try:   # (from the token's mint on: whatever fails, a minted one is revoked)
            for args, step_env, limit in _steps(work, repo, access, commit):
                timeout = self._fetch_budget(deadline) if 'fetch' in args else limit
                try:
                    self.git(args, env=step_env, timeout=timeout)
                except GitFailed as failed:
                    if failed.step == 'fetch' and failed.timed_out:
                        raise CacheFailed(FETCH_BUDGET) from None
                    refusal = fetch_refusal(failed) if failed.step == 'fetch' else None
                    if refusal is not None:
                        raise EntryRefused(refusal) from None
                    raise CacheFailed(f'git {failed.step} failed: {redacted(failed.detail, access.token)}') from None
                if 'fetch' in args:
                    self._revoke(token, access.revocable)
                    token = ''   # (no step after the fetch holds it)
        finally:
            if token:
                self._revoke(token, access.revocable)
        return access.repository, entry_files(repo, self.max_bytes)

    def _fetch_budget(self, deadline: float) -> float:
        """The fetch's time limit: ``FETCH_TIMEOUT_SECONDS`` at most, and never more than what is left of the
        deadline once the later steps' reserve is kept; too little left, and the fill stops in its own words."""
        left = deadline - self.clock() - FETCH_RESERVE_SECONDS
        if left < MIN_FETCH_SECONDS:
            raise CacheFailed('the fill ran out of its time before its fetch (a slow token or host): a Resume tries '
                              'again')
        return min(float(FETCH_TIMEOUT_SECONDS), left)

    def _revoke(self, token: str, revocable: bool) -> None:
        """A minted token revoked once the fetch is over: best effort, never retried, a failure only logged. A
        connection's own token (``revocable`` False: GitLab's project token) is left as it is."""
        if not revocable:
            return
        try:
            self.revoke(token)
        except HostError:   # (the host's refusal, a rate limit or a lost connection: the client's only failures)
            logger.warning('engineering cache: the fetch token was not revoked (it lapses within the hour)')


def _steps(work: str, repo: str, access: FetchAccess,
           commit: str) -> list[tuple[list[str], Mapping[str, str], float]]:
    """The fill's git steps, each with its environment (only the fetch's holds the token) and its time limit."""
    url, env = remote_url(access.repository, access.host), git_environment(work)
    git_dir = f'--git-dir={repo}'
    return [
        (['init', '--bare', '--quiet', '--template=', repo], env, STEP_TIMEOUT_SECONDS),
        ([git_dir, 'config', 'uploadpack.allowFilter', 'true'], env, STEP_TIMEOUT_SECONDS),
        ([git_dir, 'fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
          '--quiet', url, f'{commit}:{BASE_REF}'],
         {**env, **token_environment(access.repository, access.token, access.host)},
         FETCH_TIMEOUT_SECONDS),   # (bounded by the deadline)
        ([git_dir, 'symbolic-ref', 'HEAD', BASE_REF], env, STEP_TIMEOUT_SECONDS),
        ([git_dir, 'cat-file', '-e', f'{commit}^{{commit}}'], env, STEP_TIMEOUT_SECONDS),
        # (Its one ref stays a loose file, never packed: S3 has no empty directory, and git takes a directory for a
        # repository only when it has a refs/.)
        ([git_dir, 'repack', '-a', '-d', '-q'], env, REPACK_TIMEOUT_SECONDS),
    ]


@dataclass(frozen=True)
class S3EntryStore:
    """The raw bucket's cache keys: a missing key reads 404, or 403 to a role with no ListBucket (this one)."""

    s3: Any
    bucket: str
    #: The wait between READY's tries when another conditional write of it is in flight (a test's records it).
    sleep: Callable[[float], None] = field(default=time.sleep)

    def exists(self, key: str) -> bool:
        """Whether ``key`` is there. S3 answers a missing key 403 to a role with no ListBucket (this one has none: a
        ListBucket narrowed to the cache's prefix does not count, and one on the whole raw bucket would list customer
        data), so a 403 cannot be told from a missing READY here: it is read as missing and logged apart (not counted
        as a denied read: every first fill meets one), and a policy that really denies the read shows when the READY
        this fill then creates answers that it exists (412)."""
        try:
            self.s3.head_object(Bucket=self.bucket, Key=key)
        except ClientError as error:
            code = str(error.response.get('Error', {}).get('Code'))
            if code in DENIED_CODES:
                logger.info('engineering cache: a READY read answered 403, taken as missing', extra={'key': key})
                return False
            if code in MISSING_CODES:
                return False
            raise CacheFailed('the checkout cache could not be read') from None
        except BotoCoreError:
            raise CacheFailed('the checkout cache could not be read') from None
        return True

    def upload(self, key: str, path: str, sha256: str) -> None:
        """One PutObject per file (at most ``MAX_ENTRY_BYTES``, under S3's 5 GB): no multipart upload. It sends the
        file's sha256, which S3 checks against the bytes it received and refuses the put on a mismatch, so the
        manifest's hashes are what S3 stored."""
        try:
            with open(path, 'rb') as body:
                self.s3.put_object(Bucket=self.bucket, Key=key, Body=body, ChecksumAlgorithm='SHA256',
                                   ChecksumSHA256=base64.b64encode(bytes.fromhex(sha256)).decode('ascii'))
        except (ClientError, BotoCoreError):
            raise CacheFailed('the checkout cache could not be written') from None

    def create(self, key: str, body: bytes) -> bool:
        """READY written create-only: False when it exists (412). S3's 409 (another conditional write of it still in
        flight) is not "exists": tried again after a short wait, at most ``WRITE_TRIES`` times, as the workspace's
        writes are (``workspace/store.py``), then a failure."""
        for attempt in range(1, WRITE_TRIES + 1):
            try:
                self.s3.put_object(Bucket=self.bucket, Key=key, Body=body, IfNoneMatch='*',
                                   ContentType='application/json')
            except ClientError as error:
                code = str(error.response.get('Error', {}).get('Code'))
                if code in {'PreconditionFailed', '412'}:
                    return False
                if code in {'ConditionalRequestConflict', '409'} and attempt < WRITE_TRIES:
                    self.sleep(WRITE_BACKOFF_S * attempt)
                    continue
                raise CacheFailed('the checkout cache\'s entry could not be marked ready') from None
            except BotoCoreError:
                raise CacheFailed('the checkout cache\'s entry could not be marked ready') from None
            return True
        raise CacheFailed('the checkout cache\'s entry could not be marked ready')   # (not reached: the loop answers)


@dataclass(frozen=True)
class TableFillClaims:
    """The claim rows in voc-engineering: a conditional put of a lease, read back only to say when it ends. A row holds
    ``pk``, ``sk``, ``holder`` and ``expires_at``, all the role's grant allows (lib/stacks/engineering-cache.ts, its
    ``dynamodb:Attributes`` condition)."""

    client: Any
    table: str
    lease_seconds: int = LEASE_SECONDS

    def take(self, key: ClaimKey, holder: str, now: float) -> float | None:
        try:
            self.client.put_item(
                TableName=self.table,
                Item={**key, 'holder': {'S': holder}, 'expires_at': {'N': str(int(now) + self.lease_seconds)}},
                ConditionExpression='attribute_not_exists(pk) OR expires_at <= :now',
                ExpressionAttributeValues={':now': {'N': str(int(now))}})
        except ClientError as error:
            if error.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
                raise CacheFailed('the fill could not be claimed') from None
        except BotoCoreError:
            raise CacheFailed('the fill could not be claimed') from None
        else:
            return None
        try:
            item = self.client.get_item(TableName=self.table, Key=key, ConsistentRead=True,
                                        ProjectionExpression='expires_at').get('Item') or {}
        except (ClientError, BotoCoreError):
            return now + self.lease_seconds
        return float(item.get('expires_at', {}).get('N', now + self.lease_seconds))

    def release(self, key: ClaimKey, holder: str, until: float) -> None:
        """End this holder's lease at ``until`` (never another's): the next fill may take it from then on."""
        try:
            self.client.update_item(
                TableName=self.table, Key=key, UpdateExpression='SET expires_at = :until',
                ConditionExpression='holder = :holder',
                ExpressionAttributeValues={':until': {'N': str(int(until))}, ':holder': {'S': holder}})
        except ClientError as error:
            if error.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
                raise


@cache
def _filler() -> CacheFiller:
    """The filler on this container's clients, built once: the connections' SSM credentials and the broker's host
    clients (each connection on its own host's), the raw bucket, voc-engineering."""
    import boto3

    from engineering.connectors.handler import TABLE_ENV, host_router

    host = host_router(os.environ[PARAMETER_PREFIX_ENV])
    return CacheFiller(git=SubprocessGit(), store=S3EntryStore(boto3.client('s3'), os.environ[RAW_BUCKET_ENV]),
                       claims=TableFillClaims(boto3.client('dynamodb'), os.environ[TABLE_ENV]),
                       tokens=host.fetch_access, revoke=host.revoke_fetch_token)


#: What a fill leaves of Lambda's remaining time: the function's 240 s less FILL_DEADLINE_SECONDS.
REMAINING_MARGIN_SECONDS: Final = 10


def invocation_ends_by(context: object, now: float) -> float | None:
    """When, on the clock that reads ``now``, the invocation must be done: Lambda's remaining time (``context``'s
    ``get_remaining_time_in_millis``) less ``REMAINING_MARGIN_SECONDS``; None without a context that gives it."""
    return remaining_until(context, now, REMAINING_MARGIN_SECONDS)


@measure_invocation_cost
def lambda_handler(event: Mapping[str, Any], context: object) -> dict[str, Any]:
    """``{"connection", "commit", "generation"}``: the entry made, or found ready. A refusal raises ``EntryRefused``, a
    claim held by another fill ``CacheBusy``, a failure ``CacheFailed`` (the runtime reads each by its type). The fill
    keeps to Lambda's remaining time too, when ``context`` gives it (``invocation_ends_by``)."""
    connection, commit = str(event.get('connection', '')), str(event.get('commit', ''))
    generation: object = event.get('generation')
    if not isinstance(generation, int) or isinstance(generation, bool):
        raise EntryRefused('the generation is a whole number (the runtime sends the cache\'s current one)')
    started = time.monotonic()
    try:
        filler = _filler()
        status = filler.fill(connection, commit, generation, ends_by=invocation_ends_by(context, filler.clock()))
    except (EntryRefused, CacheBusy, CacheFailed) as error:
        logger.warning('engineering cache: no entry', extra={'connection': connection[:64], 'commit': commit[:64],
                                                              'error_type': type(error).__name__})
        raise
    logger.info('engineering cache', extra={'connection': connection, 'commit': commit, 'generation': generation,
                                            'status': status, 'seconds': round(time.monotonic() - started, 1)})
    return {'connection': connection, 'commit': commit, 'generation': generation, 'status': status}
