"""
GitHub Issues Ingestor — issues and their comments from the configured repos.

Incremental per repo, from the watermark table:

* ``GET /repos/{repo}/issues?state=all&sort=updated&direction=asc&since=<W>``,
  oldest change first, so the watermark can advance issue by issue and a run cut
  short (rate limit, time budget, item cap) resumes exactly where it stopped;
* ``If-None-Match`` with the ETag of the last listing at the same ``since`` — an
  unchanged repo answers 304, which GitHub does not count against the quota;
* ``Link: rel="next"`` pagination; pull requests (which the issues API also
  returns) are skipped;
* for every changed issue with comments, ``GET …/issues/{n}/comments`` (all of
  them) — a new comment bumps its issue's ``updated_at``, so this sees every new
  one, and every stored comment receives the issue's current labels / state
  (the processor refreshes stored items in place, see shared/source_updates.py).

WATERMARKS ARE COMMITTED ONLY AFTER ``BaseIngestor.run`` HAS ENQUEUED EVERYTHING.
``run`` buffers items and sends them in batches; advancing the watermark inside
the generator would let a failed final send lose the buffered items for good.
Staged here, written in :meth:`run` once the base run returned — so a failure
re-fetches (and the processor de-duplicates by id) rather than skips.

Rate limits never sleep: a 403/429 with ``Retry-After`` or an exhausted quota,
a quota near its floor, or too little Lambda time left raise ``StopRun`` in the
client, which ends the run successfully with its progress kept.

Sign-in: the source's fine-grained ``token``, or (7.45.00) one of the deployment's
GitHub Apps (``github_app_id``), for a deployment-wide run only, where the
engineering agents are deployed: the run asks the token function
(voc-engineering-app-tokens, ``ENGINEERING_APP_TOKENS_FUNCTION``) for
``issues_token`` with its repositories, gets one installation token per
installation, each exactly ``{issues: read, metadata: read}`` and narrowed to the
run's repositories it covers, reads each repository with its installation's
token, skips the ones no installation covers (``uncovered``, logged), and revokes
every token when the run ends. A run in a workspace ignores ``github_app_id``: it
signs in with its own token (the Apps are the deployment's, D8). No token is
logged or answered.
"""

import json
import os
import sys
import time
from collections.abc import Generator
from functools import lru_cache
from typing import SupportsFloat

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _shared.base_ingestor import BaseIngestor, logger, metrics, run_in_workspace, tracer
from _shared.github_api import GITHUB_API, GitHubClient, GitHubNotFound, StopRun, revoke_token
from _shared.github_config import GitHubSourceConfig
from _shared.github_mapping import comment_item, is_bot, is_pull_request, issue_item
from shared.engineering_agents import APP_TOKENS_FUNCTION_ENV
from shared.invocation_cost import measure_invocation_cost
from shared.ws_repo import WorkspaceScope

#: Hard cap per run across all repos (issues + comments), so one backfill of a
#: busy repo cannot monopolise the processing queue — the rest comes next run.
MAX_ITEMS_PER_RUN = 1500
#: Seconds kept back from the Lambda's remaining time for the final SQS sends
#: and the watermark commits.
SAFETY_MARGIN_SECONDS = 60
PER_PAGE = 100
#: How long the run waits for the token function (one attempt: a second ask would mint a second set of tokens).
APP_TOKENS_READ_TIMEOUT_SECONDS = 25


@lru_cache(maxsize=1)
def _lambda_client():
    """The container's Lambda client for the token function (built on the first App sign-in, kept warm after)."""
    import boto3
    from botocore.config import Config

    return boto3.client("lambda", config=Config(read_timeout=APP_TOKENS_READ_TIMEOUT_SECONDS, connect_timeout=5,
                                                retries={"total_max_attempts": 1}))


def _app_tokens(function: str, app_id: str, repos: tuple[str, ...]) -> dict | None:
    """The token function's ``issues_token`` answer, or None when it refused or could not be reached (logged by kind,
    never with a token)."""
    from botocore.exceptions import BotoCoreError, ClientError

    try:
        response = _lambda_client().invoke(FunctionName=function, InvocationType="RequestResponse", Payload=json.dumps(
            {"action": "issues_token", "app_id": app_id, "repositories": list(repos)}).encode())
        payload = json.loads(response["Payload"].read() or b"{}")
    except (BotoCoreError, ClientError, ValueError, KeyError, OSError) as error:
        logger.warning(f"github_issues: the GitHub App's tokens could not be asked for ({type(error).__name__})")
        return None
    if not isinstance(payload, dict) or response.get("FunctionError"):
        error_type = payload.get("errorType") if isinstance(payload, dict) else None
        logger.warning(f"github_issues: the GitHub App's tokens were refused ({str(error_type)[:60]})")
        return None
    return payload


def _repo_url(repo: str, suffix: str) -> str:
    # `repo` is always from `GitHubSourceConfig.repos`, which admits only
    # `owner/name` in [A-Za-z0-9_.-]: no character in it needs URL-quoting.
    return f"{GITHUB_API}/repos/{repo}/{suffix}"


class _RepoState:
    """One repo's watermark: ``since`` (an ISO ``updated_at``), the issue numbers
    already processed AT that instant, and the ETag of a listing made at it."""

    def __init__(self, since: str | None = None, boundary: list[int] | None = None, etag: str | None = None):
        self.since = since
        self.boundary = set(boundary or [])
        self.etag = etag

    @classmethod
    def parse(cls, raw: str | None) -> "_RepoState":
        try:
            data = json.loads(raw) if raw else {}
        except ValueError:
            return cls()
        if not isinstance(data, dict):
            return cls()
        since = data.get("since") if isinstance(data.get("since"), str) else None
        boundary = [n for n in data.get("boundary", []) if isinstance(n, int)] if isinstance(data.get("boundary"), list) else []
        etag = data.get("etag") if isinstance(data.get("etag"), str) else None
        return cls(since, boundary, etag)

    def advance(self, updated_at: str, number: int) -> None:
        if updated_at != self.since:
            self.since, self.boundary = updated_at, set()
        self.boundary.add(number)
        self.etag = None

    def already_processed(self, updated_at: str, number: int) -> bool:
        # `since` is inclusive, so the boundary issue comes back every run.
        return updated_at == self.since and number in self.boundary

    def serialize(self) -> str:
        return json.dumps({"since": self.since, "boundary": sorted(self.boundary)[-200:], "etag": self.etag})


class GitHubIssuesIngestor(BaseIngestor):
    """Issues and comments from GitHub, one feedback item each."""

    #: Why the run ended early (``StopRun.reason``), or None when it ran to the end.
    stop_reason: str | None

    def __init__(self, scope: WorkspaceScope | None, execution_id: str | None = None, deadline: float | None = None):
        # execution_id goes through the constructor: BaseIngestor clears the
        # secret cache on manual runs BEFORE the read (issues #141/#215).
        super().__init__(scope, execution_id=execution_id)
        # Never logged, never returned: it only ever reaches GitHubClient's header.
        self._token = str(self.secrets.get("token", "")).strip()
        self.config = GitHubSourceConfig.from_secrets(self.secrets)
        self._deadline = deadline
        self._staged: dict[str, str] = {}
        self._items = 0
        self.stop_reason = None
        #: The GitHub App's installation tokens this run was handed (revoked when it ends; never logged).
        self._app_tokens: list[str] = []

    # -- BaseIngestor hooks ---------------------------------------------------

    def fetch_new_items(self) -> Generator[dict, None, None]:
        if not self.config.repos:
            logger.warning("github_issues: token or repos not configured; nothing to fetch")
            return
        for rejected in self.config.rejected_repos:
            logger.warning(f"github_issues: {rejected!r} names no GitHub repository (expected owner/name); ignored")
        clients = self._sign_in()
        try:
            for client, repos in clients:
                for repo in repos:
                    try:
                        yield from self._fetch_repo(client, repo)
                    except GitHubNotFound:
                        # One mistyped or inaccessible repo must not starve the others.
                        logger.warning(f"github_issues: {repo} not found or not visible to the token; skipped")
        except StopRun as stop:
            self.stop_reason = stop.reason
            logger.info(f"github_issues: stopping early ({stop}); resuming next run")
            metrics.add_metric(name="GitHubRunStoppedEarly", unit="Count", value=1)
        if clients:
            logger.info(f"github_issues: {sum(c.requests_made for c, _ in clients)} GitHub requests, {self._items} items")

    def _sign_in(self) -> list[tuple[GitHubClient, tuple[str, ...]]]:
        """Each client the run reads with and the repositories it reads: the GitHub App's tokens (a deployment-wide run
        naming one), else the source's token; none when neither is configured."""
        app_id = self.config.github_app_id
        if app_id and self.scope is None:
            return self._app_sign_in(app_id)
        if app_id:
            logger.info("github_issues: a workspace's run signs in with its own token; github_app_id is ignored")
        if not self._token:
            logger.warning("github_issues: token or repos not configured; nothing to fetch")
            return []
        return [(GitHubClient(self._token, deadline=self._deadline), self.config.repos)]

    def _app_sign_in(self, app_id: str) -> list[tuple[GitHubClient, tuple[str, ...]]]:
        function = os.environ.get(APP_TOKENS_FUNCTION_ENV, "")
        if not function:
            logger.warning("github_issues: signing in with a GitHub App needs the engineering agents; nothing fetched")
            return []
        answer = _app_tokens(function, app_id, self.config.repos)
        if answer is None:
            metrics.add_metric(name="GitHubAppSignInFailed", unit="Count", value=1)
            return []
        clients = []
        listed = answer.get("tokens")
        for entry in listed if isinstance(listed, list) else []:
            token, names = (entry.get("token"), entry.get("repositories")) if isinstance(entry, dict) else (None, None)
            if not isinstance(token, str) or not token or not isinstance(names, list):
                continue
            self._app_tokens.append(token)
            covered = {name.lower() for name in names if isinstance(name, str)}
            repos = tuple(repo for repo in self.config.repos if repo.lower() in covered)
            clients.append((GitHubClient(token, deadline=self._deadline), repos))
        uncovered = answer.get("uncovered")
        for repo in uncovered if isinstance(uncovered, list) else []:
            logger.warning(f"github_issues: {str(repo)[:200]} is not covered by the GitHub App's installation; skipped")
        return clients

    def _revoke_app_tokens(self) -> None:
        for token in self._app_tokens:
            if not revoke_token(token):
                logger.warning("github_issues: a GitHub App token could not be revoked (it expires within the hour)")
        self._app_tokens = []

    def run(self) -> dict:
        try:
            result = super().run()
        finally:
            self._revoke_app_tokens()
        # Reached only when the base run enqueued everything (it re-raises otherwise).
        for repo, state in self._staged.items():
            self.set_watermark(f"repo#{repo}", state)
        return {**result, "stopped_early": self.stop_reason} if self.stop_reason is not None else result

    # -- fetching -------------------------------------------------------------

    def _count(self) -> None:
        self._items += 1
        if self._items >= MAX_ITEMS_PER_RUN:
            raise StopRun("item_cap")

    def _fetch_repo(self, client: GitHubClient, repo: str) -> Generator[dict, None, None]:
        state = _RepoState.parse(self.get_watermark(f"repo#{repo}"))
        start_since = state.since
        # Raised to `created_after` when set: a first backfill then never lists
        # the pages of issues the date filter would drop anyway.
        listing_since = self.config.listing_since(start_since)
        params = {"state": "all", "sort": "updated", "direction": "asc", "per_page": PER_PAGE}
        if listing_since:
            params["since"] = listing_since
        first_etag = None  # pragma: no mutate  paginate always yields page 0 first, which reassigns it before any read
        try:
            for index, page in enumerate(client.paginate(_repo_url(repo, "issues"), params, etag=state.etag)):
                if page.not_modified:
                    logger.info(f"github_issues: {repo} unchanged (304)")
                    return
                if index == 0:
                    first_etag = page.etag
                for issue in page.body if isinstance(page.body, list) else []:
                    yield from self._issue_with_comments(client, repo, issue, state)
            if state.since == start_since and first_etag:
                # Nothing moved the watermark, so the next listing has this same
                # URL and this ETag will answer it with a free 304.
                state.etag = first_etag
        finally:
            # Staged even on StopRun: everything before the stop was yielded.
            self._staged[repo] = state.serialize()

    def _issue_with_comments(
        self, client: GitHubClient, repo: str, issue: object, state: _RepoState,
    ) -> Generator[dict, None, None]:
        if not isinstance(issue, dict) or not isinstance(issue.get("number"), int):
            return
        number, updated_at = issue["number"], issue.get("updated_at") or ""
        if state.already_processed(updated_at, number):
            return
        item = None if is_pull_request(issue) else issue_item(issue, repo, self.config.product_names)
        # Labels are the thread's topic: an issue outside them drops its comments too.
        if item and self.config.admits_labels(item["issue_attributes"].get("labels", [])):
            # Author and date judge each item on its own: a customer's reply on a
            # maintainer's issue, or a new reply on an old issue, is still ingested.
            if self.config.admits(issue):
                self._count()
                yield item
            if issue.get("comments"):
                yield from self._comments(client, repo, issue)
        # Pull requests and filtered-out issues advance the watermark too.
        state.advance(updated_at, number)

    def _comments(self, client: GitHubClient, repo: str, issue: dict) -> Generator[dict, None, None]:
        # Every comment, not only those changed since the watermark: each comment
        # item carries its issue's labels / state / milestone, so a label change or
        # a close must reach the comments already stored too (the processor
        # refreshes them in place; an unchanged one is a no-op there).
        params: dict = {"per_page": PER_PAGE}
        for page in client.paginate(_repo_url(repo, f"issues/{issue['number']}/comments"), params):
            for comment in page.body if isinstance(page.body, list) else []:
                if isinstance(comment, dict) and "id" in comment and not is_bot(comment) and self.config.admits(comment):
                    self._count()
                    yield comment_item(comment, repo, issue, self.config.product_names)


def _deadline_for(context: object) -> float | None:
    remaining_ms = getattr(context, "get_remaining_time_in_millis", None)
    if not callable(remaining_ms):
        return None
    try:
        remaining = remaining_ms()
        if not isinstance(remaining, SupportsFloat | str):
            return None  # what `float()` would refuse with a TypeError
        return time.monotonic() + float(remaining) / 1000 - SAFETY_MARGIN_SECONDS
    except (TypeError, ValueError):
        return None


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@measure_invocation_cost
def lambda_handler(event, context):
    """Lambda entry point (``run_in_workspace``): an event naming a workspace runs in it, one naming none (a manual
    "Run now", the EventBridge tick's own run) runs deployment-wide, and the tick also fans out."""
    execution_id = event.get("execution_id") if isinstance(event, dict) else None
    deadline = _deadline_for(context)
    return run_in_workspace(
        event, lambda scope: GitHubIssuesIngestor(scope, execution_id=execution_id, deadline=deadline).run())
