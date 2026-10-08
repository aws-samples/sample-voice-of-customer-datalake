"""GitHub REST fixtures for the github_issues tests: payloads and a scripted HTTP seam.

Nothing here opens a socket — :class:`FakeGitHub` replaces
``_shared.github_api._http_get`` (the client's only network call) and answers
from a script keyed by URL path.
"""
from dataclasses import dataclass, field
from urllib.parse import urlsplit

REPO = "acme/Kiro"
API = "https://api.github.com"
ISSUES_PATH = f"/repos/{REPO}/issues"


def issue(number: int, updated_at: str = "2026-01-02T00:00:00Z", **overrides) -> dict:
    """A REST issue object shaped like GitHub's, with sensible defaults."""
    body = {
        "number": number,
        "title": f"Chat freezes #{number}",
        "body": "### Kiro version\n\n0.4.2\n\n### Steps to reproduce\n\n1. open chat\n\n"
                "```\nTypeError: Cannot read properties of undefined (reading 'id')\n```",
        "state": "open",
        "state_reason": None,
        "labels": [{"name": "bug"}, {"name": "area: chat"}],
        "reactions": {"+1": 3, "total_count": 4},
        "author_association": "NONE",
        "milestone": {"title": "0.5"},
        "comments": 0,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": updated_at,
        "html_url": f"https://github.com/{REPO}/issues/{number}",
        "user": {"login": "someone", "type": "User"},
    }
    body.update(overrides)
    return body


def comment(comment_id: int, issue_number: int, body: str = "Same here on Kiro 0.4.3", **overrides) -> dict:
    data = {
        "id": comment_id,
        "body": body,
        "created_at": "2026-01-02T00:00:00Z",
        "updated_at": "2026-01-02T00:00:00Z",
        "html_url": f"https://github.com/{REPO}/issues/{issue_number}#issuecomment-{comment_id}",
        "issue_url": f"{API}/repos/{REPO}/issues/{issue_number}",
        "author_association": "CONTRIBUTOR",
        "reactions": {"+1": 1, "total_count": 1},
        "user": {"login": "other", "type": "User"},
    }
    data.update(overrides)
    return data


@dataclass
class FakeResponse:
    status_code: int = 200
    body: object = None
    headers: dict = field(default_factory=dict)

    def json(self):
        return self.body


def ok(body, *, etag: str | None = None, next_url: str | None = None, remaining: int = 4000) -> FakeResponse:
    headers = {"X-RateLimit-Remaining": str(remaining)}
    if etag:
        headers["ETag"] = etag
    if next_url:
        headers["Link"] = f'<{next_url}>; rel="next", <{API}/last>; rel="last"'
    return FakeResponse(200, body, headers)


@dataclass
class Call:
    url: str
    headers: dict
    params: dict | None


class FakeGitHub:
    """Answers each GET from ``script[path]`` (a list consumed in order) and records the call."""

    def __init__(self, script: dict[str, list[FakeResponse]]):
        self.script = {path: list(responses) for path, responses in script.items()}
        self.calls: list[Call] = []

    def __call__(self, url, headers, params, _timeout):
        self.calls.append(Call(url, dict(headers), dict(params) if params else None))
        path = urlsplit(url).path
        queue = self.script.get(path)
        if not queue:
            raise AssertionError(f"unscripted GitHub request: {url}")
        return queue.pop(0)

    def paths(self) -> list[str]:
        return [urlsplit(call.url).path for call in self.calls]
