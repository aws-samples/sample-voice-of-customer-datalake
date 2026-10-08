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
* for every changed issue with comments, ``GET …/issues/{n}/comments?since=<W>``
  — a new comment bumps its issue's ``updated_at``, so this sees every new one.

WATERMARKS ARE COMMITTED ONLY AFTER ``BaseIngestor.run`` HAS ENQUEUED EVERYTHING.
``run`` buffers items and sends them in batches; advancing the watermark inside
the generator would let a failed final send lose the buffered items for good.
Staged here, written in :meth:`run` once the base run returned — so a failure
re-fetches (and the processor de-duplicates by id) rather than skips.

Rate limits never sleep: a 403/429 with ``Retry-After`` or an exhausted quota,
a quota near its floor, or too little Lambda time left raise ``StopRun`` in the
client, which ends the run successfully with its progress kept.
"""

import json
import os
import sys
import time
from collections.abc import Generator
from typing import SupportsFloat

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _shared.base_ingestor import BaseIngestor, logger, metrics, tracer
from _shared.github_api import GITHUB_API, GitHubClient, GitHubNotFound, StopRun
from _shared.github_config import GitHubSourceConfig
from _shared.github_mapping import RAW_PAYLOAD_KEY, comment_item, is_bot, is_pull_request, issue_item
from shared.invocation_cost import measure_invocation_cost

#: Hard cap per run across all repos (issues + comments), so one backfill of a
#: busy repo cannot monopolise the processing queue — the rest comes next run.
MAX_ITEMS_PER_RUN = 1500
#: Seconds kept back from the Lambda's remaining time for the final SQS sends
#: and the watermark commits.
SAFETY_MARGIN_SECONDS = 60
PER_PAGE = 100


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

    def __init__(self, execution_id: str | None = None, deadline: float | None = None):
        # execution_id goes through the constructor: BaseIngestor clears the
        # secret cache on manual runs BEFORE the read (issues #141/#215).
        super().__init__(execution_id=execution_id)
        # Never logged, never returned: it only ever reaches GitHubClient's header.
        self._token = str(self.secrets.get("token", "")).strip()
        self.config = GitHubSourceConfig.from_secrets(self.secrets)
        self._deadline = deadline
        self._staged: dict[str, str] = {}
        self._items = 0
        self.stop_reason = None

    # -- BaseIngestor hooks ---------------------------------------------------

    def normalize_item(self, item: dict, raw_content: str | None = None) -> dict:
        """Archive the untouched GitHub payload as ``raw_content``; send only the mapped item."""
        payload = item.pop(RAW_PAYLOAD_KEY, None)
        if payload is not None:
            raw_content = json.dumps(payload, default=str)
        return super().normalize_item(item, raw_content)

    def fetch_new_items(self) -> Generator[dict, None, None]:
        if not self._token or not self.config.repos:
            logger.warning("github_issues: token or repos not configured; nothing to fetch")
            return
        for rejected in self.config.rejected_repos:
            logger.warning(f"github_issues: {rejected!r} names no GitHub repository (expected owner/name); ignored")
        client = GitHubClient(self._token, deadline=self._deadline)
        try:
            for repo in self.config.repos:
                try:
                    yield from self._fetch_repo(client, repo)
                except GitHubNotFound:
                    # One mistyped or inaccessible repo must not starve the others.
                    logger.warning(f"github_issues: {repo} not found or not visible to the token; skipped")
        except StopRun as stop:
            self.stop_reason = stop.reason
            logger.info(f"github_issues: stopping early ({stop}); resuming next run")
            metrics.add_metric(name="GitHubRunStoppedEarly", unit="Count", value=1)
        logger.info(f"github_issues: {client.requests_made} GitHub requests, {self._items} items")

    def run(self) -> dict:
        result = super().run()
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
                    yield from self._issue_with_comments(client, repo, issue, state, listing_since)
            if state.since == start_since and first_etag:
                # Nothing moved the watermark, so the next listing has this same
                # URL and this ETag will answer it with a free 304.
                state.etag = first_etag
        finally:
            # Staged even on StopRun: everything before the stop was yielded.
            self._staged[repo] = state.serialize()

    def _issue_with_comments(
        self, client: GitHubClient, repo: str, issue: object, state: _RepoState, since: str | None,
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
                yield from self._comments(client, repo, issue, since)
        # Pull requests and filtered-out issues advance the watermark too.
        state.advance(updated_at, number)

    def _comments(
        self, client: GitHubClient, repo: str, issue: dict, since: str | None,
    ) -> Generator[dict, None, None]:
        params: dict = {"per_page": PER_PAGE}
        if since:
            params["since"] = since
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
    """Lambda entry point (EventBridge schedule or a manual "Run now")."""
    execution_id = event.get("execution_id") if isinstance(event, dict) else None
    ingestor = GitHubIssuesIngestor(execution_id=execution_id, deadline=_deadline_for(context))
    return ingestor.run()
