"""The checkout cache's writer (cache.py, cache_layout.py): the layout, the fill's order, its claim, its token's path."""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from engineering.connectors import cache
from engineering.connectors.cache import (
    FAILED_HOLD_SECONDS,
    FETCH_DENIED,
    FETCH_TIMEOUT_SECONDS,
    GIT_OPTIONS,
    LEASE_SECONDS,
    CacheBusy,
    CacheFailed,
    CacheFiller,
    GitFailed,
    S3EntryStore,
    TableFillClaims,
    authorization,
    fetch_refusal,
    git_environment,
    redacted,
    remote_url,
    token_environment,
)
from engineering.connectors.cache_layout import (
    BASE_REF,
    GENERATION_SECONDS,
    MAX_ENTRY_FILES,
    EntryFile,
    EntryRefused,
    check_entry,
    check_size,
    claim_key,
    entry_prefix,
    file_key,
    generation_at,
    manifest,
    previous_usable,
    ready_key,
)
from engineering.connectors.hosts import FetchAccess, HostBusy, HostError, NoConnection

CONNECTION = 'conn-1'
COMMIT = 'c' * 40
REPOSITORY = 'example-org/example'
#: A stand-in for an installation token (not one's shape, so no secret scanner takes it for one).
TOKEN = 'test-installation-token-of-the-cache-fetch'
NOW = 1_800_000_000.0
BUCKET = 'voc-raw-test'
TABLE = 'voc-engineering-test'
#: The generation at NOW (14-day generations since the epoch).
GEN = 1488
READY = f'engineering/cache/{CONNECTION}/{COMMIT}/g{GEN}/READY'


# --- the layout ----------------------------------------------------------------------------------------------------


def test_the_generation_is_the_clocks_14_day_period() -> None:
    assert generation_at(NOW) == GEN
    assert (generation_at(GEN * GENERATION_SECONDS - 1), generation_at(GEN * GENERATION_SECONDS)) == (GEN - 1, GEN)
    assert GENERATION_SECONDS == 14 * 86_400


def test_an_entry_is_one_prefix_per_connection_commit_and_generation_with_its_ready_beside_its_repository() -> None:
    assert entry_prefix(CONNECTION, COMMIT, GEN) == f'engineering/cache/{CONNECTION}/{COMMIT}/g{GEN}/'
    assert ready_key(CONNECTION, COMMIT, GEN) == READY
    assert file_key(CONNECTION, COMMIT, GEN, 'objects/pack/p.pack') == \
        f'engineering/cache/{CONNECTION}/{COMMIT}/g{GEN}/repo.git/objects/pack/p.pack'
    assert claim_key(CONNECTION, COMMIT, GEN) == {'pk': {'S': 'WS#default#CACHE#conn-1'},
                                                  'sk': {'S': f'COMMIT#{COMMIT}#G#{GEN}'}}


@pytest.mark.parametrize(('connection', 'commit', 'generation', 'said'), [
    ('Conn-1', COMMIT, GEN, 'connection'), ('conn/1', COMMIT, GEN, 'connection'), ('', COMMIT, GEN, 'connection'),
    ('-conn', COMMIT, GEN, 'connection'), (CONNECTION, 'main', GEN, 'commit'), (CONNECTION, 'c' * 39, GEN, 'commit'),
    (CONNECTION, 'C' * 40, GEN, 'commit'), (CONNECTION, COMMIT + '\n', GEN, 'commit'),
    (CONNECTION, '../' + 'c' * 37, GEN, 'commit'), (CONNECTION, COMMIT, -1, 'generation'),
    (CONNECTION, COMMIT, 100_000, 'generation'), (CONNECTION, COMMIT, True, 'generation'),
])
def test_a_connection_commit_or_generation_off_its_shape_is_refused(connection: str, commit: str, generation: int,
                                                                    said: str) -> None:
    with pytest.raises(EntryRefused, match=said):
        check_entry(connection, commit, generation)


def test_a_sha256_commit_is_a_full_commit_id() -> None:
    assert entry_prefix(CONNECTION, 'd' * 64, GEN) == f'engineering/cache/{CONNECTION}/{"d" * 64}/g{GEN}/'


@pytest.mark.parametrize('path', ['', '/etc/passwd', '../READY', 'objects/../../x', 'a//b', 'a\\b', 'a\nb', '.'])
def test_a_cached_file_never_leaves_the_entrys_repository(path: str) -> None:
    with pytest.raises(EntryRefused, match='plain path'):
        file_key(CONNECTION, COMMIT, GEN, path)


@pytest.mark.parametrize(('age_days', 'usable'), [(0, True), (27.99, True), (28, False), (29, False)])
def test_the_previous_generation_is_used_only_under_28_days_after_its_manifest(age_days: float, usable: bool) -> None:
    written = json.loads(manifest(CONNECTION, REPOSITORY, COMMIT, GEN, [], NOW))['written_at']
    assert previous_usable(written, NOW + age_days * 86_400) is usable


def test_a_manifest_time_that_does_not_read_is_never_used() -> None:
    assert not previous_usable('yesterday', NOW)


def test_the_size_cap_counts_every_file_and_says_how_big_the_repository_is() -> None:
    mb = 1024 * 1024
    assert check_size([EntryFile('a', 2 * mb, ''), EntryFile('b', 2 * mb, '')], max_bytes=4 * mb) == 4 * mb
    with pytest.raises(EntryRefused, match=r'is 5 MB, over the checkout cache\'s cap of 4 MB'):
        check_size([EntryFile('a', 4 * mb, ''), EntryFile('b', 1, '')], max_bytes=4 * mb)


def test_the_file_cap_is_refused_whatever_the_size() -> None:
    with pytest.raises(EntryRefused, match=f'more than {MAX_ENTRY_FILES} files'):
        check_size([EntryFile(f'f{i}', 1, '') for i in range(MAX_ENTRY_FILES + 1)])


def test_the_manifest_lists_every_file_sorted_with_its_size_and_sha256_and_when_it_was_written() -> None:
    body = json.loads(manifest(CONNECTION, REPOSITORY, COMMIT, GEN, [EntryFile('objects/pack/p.pack', 7, 'f' * 64),
                                                                    EntryFile('HEAD', 23, 'e' * 64)], NOW))
    assert body == {
        'format': 2, 'connection': CONNECTION, 'repository': REPOSITORY, 'commit': COMMIT, 'generation': GEN,
        'ref': BASE_REF, 'bytes': 30,
        'files': [{'path': 'repo.git/HEAD', 'size': 23, 'sha256': 'e' * 64},
                  {'path': 'repo.git/objects/pack/p.pack', 'size': 7, 'sha256': 'f' * 64}],
        'written_at': '2027-01-15T08:00:00Z'}


# --- the token's path through git -------------------------------------------------------------------------------------


def test_the_token_reaches_git_as_an_extra_header_for_the_one_repository_by_environment() -> None:
    env = token_environment(REPOSITORY, TOKEN)
    header = base64.b64encode(f'x-access-token:{TOKEN}'.encode()).decode()
    assert env == {'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'http.https://github.com/example-org/example.git.extraHeader',
                   'GIT_CONFIG_VALUE_0': f'Authorization: Basic {header}'}
    assert TOKEN not in json.dumps(env)   # (only its header form, in the one variable git reads it from)


@pytest.mark.parametrize('repository', ['example-org', 'example-org/example/extra', 'example-org/..', 'https://evil/x', '-o/x'])
def test_only_a_stored_owner_and_name_becomes_the_remote(repository: str) -> None:
    with pytest.raises(EntryRefused, match='owner/name'):
        remote_url(repository)


def test_every_git_command_runs_with_https_only_and_no_hooks_helpers_config_or_prompt() -> None:
    assert set(GIT_OPTIONS[::2]) == {'-c'}
    assert {'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'credential.helper=', 'protocol.allow=never',
            'protocol.https.allow=always', 'http.followRedirects=false', 'submodule.recurse=false'} <= \
        set(GIT_OPTIONS[1::2])
    env = git_environment('work-dir')
    assert env == {**env, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
                   'HOME': 'work-dir', 'PATH': '/usr/bin:/bin'}
    assert not any(name.startswith(('AWS_', 'GIT_CONFIG_COUNT')) for name in env)


def test_a_git_failure_is_redacted_cut_and_on_one_line() -> None:
    detail = (f'fatal: unable to access: {authorization(TOKEN)}\nheader {authorization(TOKEN).split()[-1]}\n'
              f'token {TOKEN}\n' + 'x' * 400)
    said = redacted(detail, TOKEN)
    assert TOKEN not in said
    assert authorization(TOKEN).split()[-1] not in said
    assert '\n' not in said
    assert len(said) <= 300


# --- the fill, through fakes -----------------------------------------------------------------------------------------


@dataclass
class FakeGit:
    """git as the filler drives it: each call recorded; ``init`` makes the repository, ``fetch`` its pack."""

    calls: list[tuple[tuple[str, ...], dict[str, str], float]] = field(default_factory=list)
    pack_bytes: int = 64
    fail: str = ''
    detail: str = ''

    def __call__(self, args: Sequence[str], *, env: Mapping[str, str], timeout: float) -> None:
        self.calls.append((tuple(args), dict(env), timeout))
        step = args[1] if args[0].startswith('--git-dir=') else args[0]
        if step == self.fail:
            raise GitFailed(step, self.detail)
        if step == 'init':
            repo = args[-1]
            os.makedirs(os.path.join(repo, 'objects', 'pack'))
            with open(os.path.join(repo, 'HEAD'), 'w') as head:
                head.write(f'ref: {BASE_REF}\n')
        if step == 'fetch':
            repo = args[0].removeprefix('--git-dir=')
            with open(os.path.join(repo, 'objects', 'pack', 'pack-1.pack'), 'wb') as pack:
                pack.write(b'P' * self.pack_bytes)
            with open(os.path.join(repo, 'FETCH_HEAD'), 'w') as fetched:
                fetched.write(COMMIT)

    def steps(self) -> list[str]:
        return [args[1] if args[0].startswith('--git-dir=') else args[0] for args, _env, _timeout in self.calls]


@dataclass
class FakeStore:
    objects: dict[str, bytes] = field(default_factory=dict)
    order: list[str] = field(default_factory=list)

    def exists(self, key: str) -> bool:
        return key in self.objects

    def upload(self, key: str, path: str, sha256: str) -> None:
        with open(path, 'rb') as body:
            self.objects[key] = body.read()
        assert hashlib.sha256(self.objects[key]).hexdigest() == sha256   # (what S3 checks of each put)
        self.order.append(key)

    def create(self, key: str, body: bytes) -> bool:
        self.order.append(key)
        if key in self.objects:
            return False
        self.objects[key] = body
        return True


#: The claim of the entry the fills here make (its sort key).
CLAIM = f'COMMIT#{COMMIT}#G#{GEN}'


@dataclass
class FakeClaims:
    #: a claim's sort key → (holder, when its lease ends)
    held: dict[str, tuple[str, float]] = field(default_factory=dict)
    released: list[str] = field(default_factory=list)

    def take(self, key: dict[str, dict[str, str]], holder: str, now: float) -> float | None:
        other = self.held.get(key['sk']['S'])
        if other is not None and other[1] > now:
            return other[1]
        self.held[key['sk']['S']] = (holder, now + LEASE_SECONDS)
        return None

    def release(self, key: dict[str, dict[str, str]], holder: str, until: float) -> None:
        if self.held.get(key['sk']['S'], ('', 0.0))[0] == holder:
            self.held[key['sk']['S']] = (holder, until)
            self.released.append(holder)


@dataclass
class Tokens:
    error: Exception | None = None
    asked: list[str] = field(default_factory=list)

    access: FetchAccess = field(default_factory=lambda: FetchAccess(REPOSITORY, TOKEN))

    def __call__(self, connection: str) -> FetchAccess:
        self.asked.append(connection)
        if self.error is not None:
            raise self.error
        return self.access


def filler(tmp_path: Any, git: FakeGit | None = None, store: FakeStore | None = None,
           claims: FakeClaims | None = None, tokens: Tokens | None = None, clock: Callable[[], float] = lambda: NOW,
           **change: Any) -> CacheFiller:
    return CacheFiller(git=git or FakeGit(), store=store or FakeStore(), claims=claims or FakeClaims(),
                       tokens=tokens or Tokens(), clock=clock, holder=lambda: 'me', scratch=str(tmp_path), **change)


#: A GitLab connection's own project token (in two parts: no secret scanner takes it for one).
GITLAB_TOKEN = 'glpat-' + 'exampleTokenForTests0123'
GITLAB_PROJECT = 'example-org/payments/refund-service'


def test_a_gitlab_fetch_reaches_the_projects_url_with_the_token_as_oauth2_by_environment_alone(tmp_path: Any) -> None:
    git, revoked = FakeGit(), list[str]()
    tokens = Tokens(access=FetchAccess(GITLAB_PROJECT, GITLAB_TOKEN, host='gitlab', revocable=False))
    assert filler(tmp_path, git, tokens=tokens, revoke=revoked.append).fill(CONNECTION, COMMIT, GEN) == 'filled'
    args, env, _timeout = next(call for call in git.calls if 'fetch' in call[0])
    header = base64.b64encode(f'oauth2:{GITLAB_TOKEN}'.encode()).decode()
    assert f'https://gitlab.com/{GITLAB_PROJECT}.git' in args
    assert (env['GIT_CONFIG_KEY_0'], env['GIT_CONFIG_VALUE_0']) == (
        f'http.https://gitlab.com/{GITLAB_PROJECT}.git.extraHeader', f'Authorization: Basic {header}')
    assert GITLAB_TOKEN not in ' '.join(arg for call in git.calls for arg in call[0])
    assert revoked == []   # (a project token is the connection's own: no revocation call is made for it)


@pytest.mark.parametrize('repository', ['example-org', 'a/../b', 'group/p.git', 'https://evil/x'])
def test_only_a_gitlab_project_path_becomes_a_gitlab_remote(repository: str) -> None:
    with pytest.raises(EntryRefused, match='GitLab project path'):
        remote_url(repository, 'gitlab')


def test_a_host_the_cache_does_not_know_is_no_remote() -> None:
    with pytest.raises(EntryRefused):
        remote_url(REPOSITORY, 'elsewhere')


def test_a_git_failure_never_holds_either_hosts_header_form_of_the_token() -> None:
    detail = f'{authorization(GITLAB_TOKEN, "gitlab")} {authorization(GITLAB_TOKEN, "gitlab").split()[-1]}'
    said = redacted(detail, GITLAB_TOKEN)
    assert GITLAB_TOKEN not in said
    assert authorization(GITLAB_TOKEN, 'gitlab').split()[-1] not in said


@pytest.mark.parametrize('said', ['remote: HTTP Basic: Access denied. The provided password or token is incorrect',
                                  'fatal: Authentication failed for https://gitlab.com/x.git/',
                                  'error: The requested URL returned error: 403'])
def test_a_token_the_host_refuses_is_a_refusal_a_person_fixes(said: str) -> None:
    assert fetch_refusal(GitFailed('fetch', said)) == FETCH_DENIED


@pytest.mark.parametrize('said', ['error: The requested URL returned error: 429',
                                  'error: The requested URL returned error: 503'])
def test_a_rate_limit_or_an_outage_is_transient(said: str) -> None:
    assert fetch_refusal(GitFailed('fetch', said)) is None


def test_a_fill_fetches_the_one_commit_lays_out_the_repository_then_writes_ready_last(tmp_path: Any) -> None:
    git, store = FakeGit(), FakeStore()
    assert filler(tmp_path, git, store).fill(CONNECTION, COMMIT, GEN) == 'filled'
    assert git.steps() == ['init', 'config', 'fetch', 'symbolic-ref', 'cat-file', 'repack']
    fetch = next(args for args, _env, _timeout in git.calls if 'fetch' in args)
    assert fetch[2:] == ('--depth=1', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--quiet',
                         'https://github.com/example-org/example.git', f'{COMMIT}:{BASE_REF}')
    configured = next(args for args, _e, _t in git.calls if 'config' in args)[1:]
    assert configured == ('config', 'uploadpack.allowFilter', 'true')
    assert store.order[-1] == READY
    assert sorted(store.order[:-1]) == [file_key(CONNECTION, COMMIT, GEN, 'HEAD'),
                                        file_key(CONNECTION, COMMIT, GEN, 'objects/pack/pack-1.pack')]


def test_ready_names_every_uploaded_file_with_its_size_and_sha256(tmp_path: Any) -> None:
    store = FakeStore()
    filler(tmp_path, store=store).fill(CONNECTION, COMMIT, GEN)
    assert json.loads(store.objects[READY])['repository'] == REPOSITORY   # (the token's repository)
    listed = json.loads(store.objects[READY])['files']
    assert [(item['path'], item['size']) for item in listed] == [('repo.git/HEAD', len(f'ref: {BASE_REF}\n')),
                                                                 ('repo.git/objects/pack/pack-1.pack', 64)]
    assert all(len(item['sha256']) == 64 for item in listed)
    assert not any('FETCH_HEAD' in key for key in store.objects)   # (git's own scratch is not the entry's)


def test_an_entry_that_is_ready_is_never_filled_again(tmp_path: Any) -> None:
    git, store, claims, tokens = FakeGit(), FakeStore({READY: b'{}'}), FakeClaims(), Tokens()
    assert filler(tmp_path, git, store, claims, tokens).fill(CONNECTION, COMMIT, GEN) == 'ready'
    assert (git.calls, store.order, claims.held, tokens.asked) == ([], [], {}, [])


def test_a_ready_written_meanwhile_is_kept_and_answered_ready(tmp_path: Any) -> None:
    class Racing(FakeStore):
        def create(self, key: str, body: bytes) -> bool:
            self.objects[key] = b'{"theirs": true}'   # (another fill's READY landed first)
            return super().create(key, body)

    racing = Racing()
    assert filler(tmp_path, store=racing).fill(CONNECTION, COMMIT, GEN) == 'ready'
    assert racing.objects[READY] == b'{"theirs": true}'


def test_a_claim_another_fill_holds_refuses_and_fetches_nothing(tmp_path: Any) -> None:
    git, tokens = FakeGit(), Tokens()
    claims = FakeClaims({CLAIM: ('other', NOW + 90)})
    with pytest.raises(CacheBusy, match='try again in 90 s'):
        filler(tmp_path, git, claims=claims, tokens=tokens).fill(CONNECTION, COMMIT, GEN)
    assert (git.calls, tokens.asked, claims.held[CLAIM][0]) == ([], [], 'other')


def test_a_claim_on_another_generation_never_holds_this_ones(tmp_path: Any) -> None:
    claims = FakeClaims({f'COMMIT#{COMMIT}#G#{GEN - 1}': ('other', NOW + 90)})
    assert filler(tmp_path, claims=claims).fill(CONNECTION, COMMIT, GEN) == 'filled'


def test_a_claim_whose_lease_ended_is_taken_over_and_released_when_done(tmp_path: Any) -> None:
    claims = FakeClaims({CLAIM: ('crashed', NOW - 1)})
    assert filler(tmp_path, claims=claims).fill(CONNECTION, COMMIT, GEN) == 'filled'
    assert claims.released == ['me']
    assert claims.held[CLAIM] == ('me', NOW)


@pytest.mark.parametrize(('connection', 'commit', 'generation'), [
    ('Conn', COMMIT, GEN), (CONNECTION, 'HEAD', GEN), (CONNECTION, COMMIT, GEN + 2), (CONNECTION, COMMIT, GEN - 2)],
    ids=['connection', 'commit', 'a-future-generation', 'a-past-generation'])
def test_a_bad_connection_commit_or_generation_is_refused_before_anything_is_read(
        tmp_path: Any, connection: str, commit: str, generation: int) -> None:
    store, tokens = FakeStore(), Tokens()
    with pytest.raises(EntryRefused):
        filler(tmp_path, store=store, tokens=tokens).fill(connection, commit, generation)
    assert (store.order, tokens.asked) == ([], [])


def test_a_fill_across_the_generations_boundary_is_taken(tmp_path: Any) -> None:
    store = FakeStore()
    assert filler(tmp_path, store=store).fill(CONNECTION, COMMIT, GEN + 1) == 'filled'
    assert ready_key(CONNECTION, COMMIT, GEN + 1) in store.objects
    assert json.loads(store.objects[ready_key(CONNECTION, COMMIT, GEN + 1)])['generation'] == GEN + 1


def test_a_repository_over_the_cap_is_refused_with_nothing_uploaded_and_no_ready(tmp_path: Any) -> None:
    store, claims = FakeStore(), FakeClaims()
    with pytest.raises(EntryRefused, match='over the checkout cache\'s cap of 1 MB'):
        filler(tmp_path, FakeGit(pack_bytes=2 * 1024 * 1024), store, claims, max_bytes=1024 * 1024).fill(
            CONNECTION, COMMIT, GEN)
    assert (store.objects, claims.released) == ({}, ['me'])
    assert os.listdir(tmp_path) == []   # (the working directory is removed whatever happened)


def test_a_git_failure_is_redacted_before_it_is_raised_and_nothing_is_marked_ready(tmp_path: Any) -> None:
    git = FakeGit(fail='fetch', detail=f'fatal: could not read from {authorization(TOKEN)} ({TOKEN})')
    store = FakeStore()
    with pytest.raises(CacheFailed) as failed:
        filler(tmp_path, git, store).fill(CONNECTION, COMMIT, GEN)
    assert str(failed.value).startswith('git fetch failed: fatal: could not read from <redacted>')
    assert TOKEN not in str(failed.value)
    assert authorization(TOKEN).split()[-1] not in str(failed.value)
    assert (failed.value.__cause__, store.objects) == (None, {})


def test_a_fetch_past_its_budget_is_refused_as_too_large_saying_so(tmp_path: Any) -> None:
    class SlowFetch(FakeGit):
        def __call__(self, args: Sequence[str], *, env: Mapping[str, str], timeout: float) -> None:
            if 'fetch' in args:
                raise GitFailed('fetch', f'timed out after {timeout:g} s', timed_out=True)
            super().__call__(args, env=env, timeout=timeout)

    store = FakeStore()
    # (a failure a later try may not meet, never a refusal: the host may only have been slow)
    with pytest.raises(CacheFailed, match='did not finish within its budget: the repository is too large for the '
                                          'cache, or the host was slow; a Resume tries again'):
        filler(tmp_path, SlowFetch(), store).fill(CONNECTION, COMMIT, GEN)
    assert store.objects == {}


def test_the_fetch_gets_only_what_is_left_of_the_deadline_after_a_slow_mint(tmp_path: Any) -> None:
    now = [NOW]

    class SlowTokens(Tokens):
        def __call__(self, connection: str) -> FetchAccess:
            now[0] += 120   # (two minutes to mint the token)
            return super().__call__(connection)

    git = FakeGit()
    filler(tmp_path, git, tokens=SlowTokens(), clock=lambda: now[0]).fill(CONNECTION, COMMIT, GEN)
    fetch = next(timeout for args, _env, timeout in git.calls if 'fetch' in args)
    assert fetch == 230 - 120 - 80 < FETCH_TIMEOUT_SECONDS   # (the deadline less the mint, less the later steps)


@dataclass
class LambdaContext:
    """Lambda's context, as far as the writer reads it: its remaining time."""
    remaining_ms: int

    def get_remaining_time_in_millis(self) -> int:
        return self.remaining_ms


@pytest.mark.parametrize(('remaining_ms', 'fetch'), [
    (100_000, 100 - 10 - 80),            # (100 s from its limit: less the margin and the later steps' reserve)
    (900_000, FETCH_TIMEOUT_SECONDS),    # (the remaining time never lengthens the fill's own deadline)
])
def test_the_fetch_keeps_to_the_earlier_of_lambdas_remaining_time_and_its_deadline(
        tmp_path: Any, monkeypatch: pytest.MonkeyPatch, remaining_ms: int, fetch: float) -> None:
    git = FakeGit()
    built = filler(tmp_path, git)
    monkeypatch.setattr(cache, '_filler', lambda: built)
    cache.lambda_handler({'connection': CONNECTION, 'commit': COMMIT, 'generation': GEN}, LambdaContext(remaining_ms))
    assert next(timeout for args, _env, timeout in git.calls if 'fetch' in args) == fetch


class OddContext:
    """A context whose remaining time is no number of milliseconds."""

    def get_remaining_time_in_millis(self) -> object:
        return True


@pytest.mark.parametrize('context', [None, object(), OddContext()])
def test_no_remaining_time_is_read_from_a_context_that_does_not_give_one(context: object) -> None:
    assert cache.invocation_ends_by(context, NOW) is None


def test_the_invocation_ends_its_margin_before_lambdas_limit() -> None:
    assert cache.invocation_ends_by(LambdaContext(60_500), NOW) == NOW + 60.5 - cache.REMAINING_MARGIN_SECONDS


def test_a_fill_with_too_little_time_left_for_its_fetch_stops_in_its_own_words(tmp_path: Any) -> None:
    now = [NOW]

    class StuckTokens(Tokens):
        def __call__(self, connection: str) -> FetchAccess:
            now[0] += 200
            return super().__call__(connection)

    git, revoked = FakeGit(), []
    with pytest.raises(CacheFailed, match='ran out of its time before its fetch'):
        filler(tmp_path, git, tokens=StuckTokens(), clock=lambda: now[0], revoke=revoked.append).fill(
            CONNECTION, COMMIT, GEN)
    assert ('fetch' not in git.steps(), revoked) == (True, [TOKEN])


def test_the_token_is_revoked_once_right_after_the_fetch_and_a_failed_revocation_is_only_logged(
        tmp_path: Any) -> None:
    git, revoked = FakeGit(), []

    def revoke(token: str) -> None:
        revoked.append((token, git.steps()[-1]))
        raise HostBusy('The repository host could not be reached.', retry_after=60)

    assert filler(tmp_path, git, revoke=revoke).fill(CONNECTION, COMMIT, GEN) == 'filled'
    assert revoked == [(TOKEN, 'fetch')]


def test_a_repository_off_its_shape_after_the_mint_still_revokes_the_token(tmp_path: Any) -> None:
    revoked: list[str] = []

    class OddRepository(Tokens):
        def __call__(self, connection: str) -> FetchAccess:
            self.asked.append(connection)
            return FetchAccess('example-org', TOKEN)

    with pytest.raises(EntryRefused, match='owner/name'):
        filler(tmp_path, tokens=OddRepository(), revoke=revoked.append).fill(CONNECTION, COMMIT, GEN)
    assert revoked == [TOKEN]


def test_a_failed_fetch_still_revokes_its_token(tmp_path: Any) -> None:
    revoked: list[str] = []
    with pytest.raises(CacheFailed):
        filler(tmp_path, FakeGit(fail='fetch', detail='fatal'), revoke=revoked.append).fill(CONNECTION, COMMIT, GEN)
    assert revoked == [TOKEN]


def test_the_token_is_in_no_argument_no_log_and_only_the_fetchs_environment(tmp_path: Any,
                                                                            caplog: pytest.LogCaptureFixture) -> None:
    git = FakeGit()
    caplog.set_level(logging.DEBUG)
    filler(tmp_path, git).fill(CONNECTION, COMMIT, GEN)
    header = authorization(TOKEN).split()[-1]
    assert not any(TOKEN in arg or header in arg for args, _env, _timeout in git.calls for arg in args)
    carrying = [args for args, env, _timeout in git.calls if any(header in value for value in env.values())]
    assert carrying == [next(args for args, _e, _t in git.calls if 'fetch' in args)]
    assert TOKEN not in caplog.text
    assert header not in caplog.text


@pytest.mark.parametrize(('error', 'raised', 'said'), [
    (NoConnection('no repository connection is configured'), EntryRefused, 'no usable credential'),
    # (a busy host is no other fill's claim: never CacheBusy, which the runtime waits out)
    (HostBusy('rate limited', retry_after=42), CacheFailed, 'busy or unreachable: try again in 42 s'),
    (HostError('The repository host answered 404 to the token request.'), CacheFailed, 'answered 404'),
])
def test_a_token_that_cannot_be_had_says_why_and_fetches_nothing(tmp_path: Any, error: Exception,
                                                                 raised: type[Exception], said: str) -> None:
    git, claims = FakeGit(), FakeClaims()
    with pytest.raises(raised, match=said):
        filler(tmp_path, git, claims=claims, tokens=Tokens(error=error)).fill(CONNECTION, COMMIT, GEN)
    assert (git.calls, claims.released) == ([], ['me'])


@pytest.mark.parametrize('status', [401, 403, 404])
def test_a_host_that_refuses_the_token_is_a_refusal_in_its_words(tmp_path: Any, status: int) -> None:
    refused = HostError(f'The repository host answered {status} to the token request.')
    refused.status = status
    with pytest.raises(EntryRefused, match=f'refused the connection\'s fetch token \\(it answered {status}\\)'):
        filler(tmp_path, tokens=Tokens(error=refused)).fill(CONNECTION, COMMIT, GEN)


@pytest.mark.parametrize(('status', 'raised'), [
    (400, EntryRefused), (422, EntryRefused), (451, EntryRefused),   # (the request refused the same way every time)
    (408, CacheFailed), (429, CacheFailed), (500, CacheFailed), (502, CacheFailed), (0, CacheFailed),   # (may pass)
])
def test_a_token_request_the_host_rejects_is_a_refusal_unless_a_later_try_may_pass(tmp_path: Any, status: int,
                                                                                   raised: type[Exception]) -> None:
    rejected = HostError(f'The repository host answered {status} to the token request.')
    rejected.status = status
    claims = FakeClaims()
    with pytest.raises(raised) as error:
        filler(tmp_path, claims=claims, tokens=Tokens(error=rejected)).fill(CONNECTION, COMMIT, GEN)
    if raised is EntryRefused:
        assert str(error.value) == (f'the repository host rejected the request for the connection\'s fetch token (it '
                                    f'answered {status}): an administrator checks the GitHub App, its installation '
                                    'and its access to the repository, under Agents → Connections')
        assert claims.held[claim_key(CONNECTION, COMMIT, GEN)['sk']['S']] == ('me', NOW)   # (no hold: nothing passes)


@pytest.mark.parametrize(('detail', 'said'), [
    (f'fatal: remote error: upload-pack: not our ref {COMMIT}', 'push it to the connection\'s repository'),
    (f"fatal: couldn't find remote ref {COMMIT}", 'push it to the connection\'s repository'),
    ('error: Server does not allow request for unadvertised object', 'push it to the connection\'s repository'),
    ("remote: Repository not found.\nfatal: repository 'https://github.com/example-org/example.git/' not found",
     'checks the connection\'s repository, and that the GitHub App is installed on it'),
    ('error: object 1234: badTimezone: invalid author/committer line\nfatal: fsck error in packed object',
     'failed git\'s integrity check (fsck)'),
])
def test_a_fetch_that_every_later_try_would_meet_is_a_refusal_saying_what_to_do(tmp_path: Any, detail: str,
                                                                                said: str) -> None:
    claims, revoked = FakeClaims(), list[str]()
    with pytest.raises(EntryRefused, match=re.escape(said)):
        filler(tmp_path, FakeGit(fail='fetch', detail=detail), claims=claims,
               revoke=revoked.append).fill(CONNECTION, COMMIT, GEN)
    assert revoked == [TOKEN]
    assert claims.held[claim_key(CONNECTION, COMMIT, GEN)['sk']['S']] == ('me', NOW)   # (let go at once)


@pytest.mark.parametrize('detail', [
    "fatal: unable to access 'https://github.com/example-org/example.git/': Could not resolve host: github.com",
    'error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502',
    'fatal: the remote end hung up unexpectedly',
    # (another quoted name followed by "not found" is no answer that the repository is missing)
    "fatal: unable to access 'https://github.com/example-org/example.git/': proxy 'proxy.example.com' not found",
    "error: file 'objects/info/alternates' not found",
])
def test_a_fetch_that_a_later_try_may_pass_stays_a_failure(tmp_path: Any, detail: str) -> None:
    with pytest.raises(CacheFailed, match='git fetch failed'):
        filler(tmp_path, FakeGit(fail='fetch', detail=detail)).fill(CONNECTION, COMMIT, GEN)


def test_a_timed_out_fetch_is_never_read_as_a_refusal() -> None:
    assert fetch_refusal(GitFailed('fetch', 'not our ref', timed_out=True)) is None


def test_every_git_step_is_bounded_and_the_fetch_has_its_own_limit(tmp_path: Any) -> None:
    git = FakeGit()
    filler(tmp_path, git).fill(CONNECTION, COMMIT, GEN)
    limits = {(args[1] if args[0].startswith('--git-dir=') else args[0]): timeout for args, _env, timeout in git.calls}
    assert limits['fetch'] == FETCH_TIMEOUT_SECONDS
    assert sum(limits.values()) < 240   # (the function's own limit, with room for the uploads)


def test_a_fill_that_ran_long_uploads_nothing_more_and_marks_nothing_ready(tmp_path: Any) -> None:
    # (the generation's check, the claim, the fill's start, the fetch's budget, then the first upload 231 s later)
    ticks = iter([NOW, NOW, NOW, NOW, NOW + 231] + [NOW + 260] * 10)
    store, claims = FakeStore(), FakeClaims()
    late = CacheFiller(git=FakeGit(), store=store, claims=claims, tokens=Tokens(), clock=lambda: next(ticks),
                       holder=lambda: 'me', scratch=str(tmp_path))
    with pytest.raises(CacheFailed, match='ran out of its time before the entry was uploaded'):
        late.fill(CONNECTION, COMMIT, GEN)
    assert (store.objects, claims.released) == ({}, ['me'])


def test_an_upload_whose_estimated_time_would_pass_the_deadline_is_not_started(tmp_path: Any) -> None:
    # A 600 KB pack takes about 0.012 s by the estimate: past a deadline 0.001 s away, though HEAD's 25 bytes are not.
    store = FakeStore()
    ticks = iter([NOW, NOW, NOW, NOW] + [NOW + 160] * 10)
    late = CacheFiller(git=FakeGit(pack_bytes=600 * 1024), store=store, claims=FakeClaims(), tokens=Tokens(),
                       clock=lambda: next(ticks), holder=lambda: 'me', scratch=str(tmp_path), deadline_seconds=160.001)
    with pytest.raises(CacheFailed, match='ran out of its time'):
        late.fill(CONNECTION, COMMIT, GEN)
    assert list(store.objects) == [file_key(CONNECTION, COMMIT, GEN, 'HEAD')]   # (no pack, no READY)


def test_a_claim_that_cannot_be_released_is_logged_never_raised_over_the_fill(tmp_path: Any) -> None:
    class Stuck(FakeClaims):
        def release(self, key: dict[str, dict[str, str]], holder: str, until: float) -> None:
            raise RuntimeError(f'throttled: {key} {holder} {until}')

    assert filler(tmp_path, claims=Stuck()).fill(CONNECTION, COMMIT, GEN) == 'filled'


def test_a_failed_fill_keeps_its_claim_a_while_so_the_launches_meanwhile_start_no_fetch(tmp_path: Any) -> None:
    now, claims = [NOW], FakeClaims()
    failing, tokens = FakeGit(fail='fetch', detail='fatal: unable to access'), Tokens()
    with pytest.raises(CacheFailed):
        filler(tmp_path, failing, claims=claims, tokens=tokens, clock=lambda: now[0]).fill(CONNECTION, COMMIT, GEN)
    assert claims.held[claim_key(CONNECTION, COMMIT, GEN)['sk']['S']] == ('me', NOW + FAILED_HOLD_SECONDS)
    now[0] = NOW + FAILED_HOLD_SECONDS - 1   # (a launch during the outage: the fill is held, nothing minted or fetched)
    git = FakeGit()
    with pytest.raises(CacheBusy, match='try again in 1 s'):
        filler(tmp_path, git, claims=claims, tokens=tokens, clock=lambda: now[0]).fill(CONNECTION, COMMIT, GEN)
    assert (git.calls, len(tokens.asked)) == ([], 1)
    now[0] = NOW + FAILED_HOLD_SECONDS   # (once the hold is over, the next fill tries again)
    assert filler(tmp_path, git, claims=claims, tokens=tokens, clock=lambda: now[0]).fill(CONNECTION, COMMIT, GEN) == 'filled'


def test_a_refused_or_finished_fill_lets_its_claim_go_at_once(tmp_path: Any) -> None:
    claims = FakeClaims()
    with pytest.raises(EntryRefused):
        filler(tmp_path, claims=claims, tokens=Tokens(error=NoConnection('none'))).fill(CONNECTION, COMMIT, GEN)
    assert claims.held[claim_key(CONNECTION, COMMIT, GEN)['sk']['S']] == ('me', NOW)
    assert filler(tmp_path, claims=claims).fill(CONNECTION, COMMIT, GEN) == 'filled'
    assert claims.held[claim_key(CONNECTION, COMMIT, GEN)['sk']['S']] == ('me', NOW)


# --- the adapters, on moto -------------------------------------------------------------------------------------------


@pytest.fixture
def aws() -> Any:
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        dynamodb = boto3.client('dynamodb', region_name='us-east-1')
        dynamodb.create_table(
            TableName=TABLE, BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': name, 'AttributeType': 'S'} for name in ('pk', 'sk')])
        yield s3, dynamodb


def test_the_store_reads_ready_by_head_and_writes_it_create_only(aws: Any, tmp_path: Any) -> None:
    s3, _ = aws
    store = S3EntryStore(s3, BUCKET)
    assert not store.exists(READY)
    assert store.create(READY, b'{"first": true}')
    assert not store.create(READY, b'{"second": true}')
    assert (store.exists(READY), s3.get_object(Bucket=BUCKET, Key=READY)['Body'].read()) == (True, b'{"first": true}')
    path = tmp_path / 'pack'
    path.write_bytes(b'one')
    store.upload('engineering/cache/conn-1/x/repo.git/p', str(path), hashlib.sha256(b'one').hexdigest())
    path.write_bytes(b'two')   # (a retry overwrites what nobody reads without READY)
    store.upload('engineering/cache/conn-1/x/repo.git/p', str(path), hashlib.sha256(b'two').hexdigest())
    assert s3.get_object(Bucket=BUCKET, Key='engineering/cache/conn-1/x/repo.git/p')['Body'].read() == b'two'


def test_each_upload_sends_its_sha256_for_s3_to_check(tmp_path: Any) -> None:
    sent: list[dict[str, Any]] = []

    class Recording:
        def put_object(self, **kwargs: Any) -> None:
            sent.append({key: value for key, value in kwargs.items() if key != 'Body'})

    path = tmp_path / 'pack'
    path.write_bytes(b'pack bytes')
    digest = hashlib.sha256(b'pack bytes')
    S3EntryStore(Recording(), BUCKET).upload('k', str(path), digest.hexdigest())
    assert sent == [{'Bucket': BUCKET, 'Key': 'k', 'ChecksumAlgorithm': 'SHA256',
                     'ChecksumSHA256': base64.b64encode(digest.digest()).decode()}]


def test_a_ready_write_meeting_another_in_flight_is_tried_again_not_taken_as_existing() -> None:
    codes = iter(['409', '409', None])

    class InFlight:
        def put_object(self, **_kwargs: Any) -> None:
            code = next(codes)
            if code is not None:
                raise ClientError({'Error': {'Code': 'ConditionalRequestConflict' if code else code}}, 'PutObject')

    slept: list[float] = []
    assert S3EntryStore(InFlight(), BUCKET, sleep=slept.append).create(READY, b'{}')
    assert len(slept) == 2


def test_a_ready_read_answering_403_is_taken_as_missing_and_logged_apart(caplog: pytest.LogCaptureFixture) -> None:
    class Denied:
        def head_object(self, **_kwargs: Any) -> None:
            raise ClientError({'Error': {'Code': '403', 'Message': 'Forbidden'}}, 'HeadObject')

    assert not S3EntryStore(Denied(), BUCKET).exists(READY)
    assert 'answered 403, taken as missing' in caplog.text


def test_a_claim_row_is_a_lease_another_holder_waits_out_and_takes_over_once_it_ends(aws: Any) -> None:
    _, dynamodb = aws
    claims, key = TableFillClaims(dynamodb, TABLE), claim_key(CONNECTION, COMMIT, GEN)
    assert claims.take(key, 'first', NOW) is None
    assert claims.take(key, 'second', NOW + 10) == NOW + LEASE_SECONDS
    assert claims.take(key, 'second', NOW + LEASE_SECONDS) is None   # (the first's lease ended)
    row = dynamodb.get_item(TableName=TABLE, Key=key)['Item']
    assert set(row) == {'pk', 'sk', 'holder', 'expires_at'}   # (engineering-cache.ts CLAIM_ATTRIBUTES, its grant)
    assert row['holder'] == {'S': 'second'}


def test_a_release_ends_only_its_own_holders_lease(aws: Any) -> None:
    _, dynamodb = aws
    claims, key = TableFillClaims(dynamodb, TABLE), claim_key(CONNECTION, COMMIT, GEN)
    claims.take(key, 'first', NOW)
    claims.release(key, 'someone-else', NOW + 1)
    assert claims.take(key, 'second', NOW + 2) == NOW + LEASE_SECONDS
    claims.release(key, 'first', NOW + 3)
    assert claims.take(key, 'second', NOW + 3) is None


def test_a_release_may_end_the_lease_later_and_the_claim_is_held_till_then(aws: Any) -> None:
    _, dynamodb = aws
    claims, key = TableFillClaims(dynamodb, TABLE), claim_key(CONNECTION, COMMIT, GEN)
    claims.take(key, 'first', NOW)
    claims.release(key, 'first', NOW + FAILED_HOLD_SECONDS)   # (a failed fill's hold)
    assert claims.take(key, 'second', NOW + 1) == NOW + FAILED_HOLD_SECONDS
    assert claims.take(key, 'second', NOW + FAILED_HOLD_SECONDS) is None


def test_the_handler_answers_the_fills_status_and_raises_its_refusals_by_type(monkeypatch: pytest.MonkeyPatch,
                                                                             tmp_path: Any) -> None:
    built = filler(tmp_path)
    monkeypatch.setattr(cache, '_filler', lambda: built)
    assert cache.lambda_handler({'connection': CONNECTION, 'commit': COMMIT, 'generation': GEN}, None) == {
        'connection': CONNECTION, 'commit': COMMIT, 'generation': GEN, 'status': 'filled'}
    with pytest.raises(EntryRefused):
        cache.lambda_handler({'connection': CONNECTION, 'commit': 'main', 'generation': GEN}, None)
    for generation in (None, '1488', True):
        with pytest.raises(EntryRefused, match='whole number'):
            cache.lambda_handler({'connection': CONNECTION, 'commit': COMMIT, 'generation': generation}, None)


def test_the_handlers_filler_is_wired_from_its_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in {'ENGINEERING_PARAMETER_PREFIX': '/voc/engineering/', 'RAW_DATA_BUCKET': BUCKET,
                        'ENGINEERING_TABLE': TABLE, 'AWS_DEFAULT_REGION': 'us-east-1'}.items():
        monkeypatch.setenv(name, value)
    cache._filler.cache_clear()
    built = cache._filler()
    cache._filler.cache_clear()
    assert isinstance(built.store, S3EntryStore)
    assert isinstance(built.claims, TableFillClaims)
    assert (built.store.bucket, built.claims.table) == (BUCKET, TABLE)
