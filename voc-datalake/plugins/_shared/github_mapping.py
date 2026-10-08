"""
GitHub REST/webhook payloads → the plugin's raw feedback items.

One mapping for both transports (the ingestor's ``GET /issues`` pages and the
webhook's ``issues`` / ``issue_comment`` deliveries carry the same issue and
comment objects), so a delivery and a later poll of the same issue produce the
same item id and fields, and the processor's id-based de-duplication sees one item.

COMMENTS ARE SEPARATE ITEMS, linked to their issue by ``parent_id``. Folding them
into the issue was the alternative and does not work here: the processor never
updates an item it has already stored (``check_duplicate`` skips any id it has
seen), so a folded issue would freeze with whatever comments existed at first
ingest and every later comment — usually where "+1, same on 0.4.3" and the
actual diagnosis live — would be lost. As their own items each comment is
categorised and scored on its own, carries its own version mention, and still
rolls up to its issue through ``parent_id``.
"""

from collections.abc import Iterable

from .github_text import (
    detect_component,
    error_signature,
    has_repro,
    linked_pull_requests,
    parse_software_version,
    strip_markdown,
)

__all__ = ["RAW_PAYLOAD_KEY", "comment_item", "is_bot", "is_pull_request", "issue_item", "issue_labels"]

#: Key under which an item carries the untouched GitHub payload for the raw
#: archive. Popped before the item is normalised, so it never reaches SQS.
RAW_PAYLOAD_KEY = "_github_payload"  # pragma: no mutate  internal name: every reader imports this constant and pops it

ISSUE_TEXT_CAP = 4000
COMMENT_TEXT_CAP = 2000
_MAX_LABELS = 30


def is_pull_request(issue: dict) -> bool:
    """GitHub's issues API returns pull requests too; they carry a ``pull_request`` key."""
    return "pull_request" in issue


def issue_labels(issue: dict) -> list[str]:
    """Label names, in GitHub's order, bounded to what the schema accepts."""
    names = []
    for label in issue.get("labels") or []:
        name = label.get("name") if isinstance(label, dict) else label
        if isinstance(name, str) and name.strip():
            names.append(name.strip()[:100])
    return names[:_MAX_LABELS]


def _login(entity: object) -> str | None:
    user = entity.get("user") if isinstance(entity, dict) else None
    login = user.get("login") if isinstance(user, dict) else None
    return login if isinstance(login, str) else None


def is_bot(entity: dict) -> bool:
    """Comments by GitHub Apps / bots (CI, stale-bot) are not customer voice."""
    user = entity.get("user")
    return isinstance(user, dict) and user.get("type") == "Bot"


def _reactions(entity: dict) -> tuple[int, int]:
    raw = entity.get("reactions")
    reactions = raw if isinstance(raw, dict) else {}
    plus_one = reactions.get("+1", 0)
    total = reactions.get("total_count", 0)
    return (plus_one if isinstance(plus_one, int) else 0, total if isinstance(total, int) else 0)


def _milestone(issue: dict) -> str | None:
    milestone = issue.get("milestone")
    title = milestone.get("title") if isinstance(milestone, dict) else None
    return title[:256] if isinstance(title, str) and title else None


def issue_id(repo: str, number: int) -> str:
    return f"{repo}#{number}"


def issue_item(issue: dict, repo: str, product_names: Iterable[str] = ()) -> dict:
    """The feedback item for one issue (the caller has already skipped pull requests)."""
    number = int(issue["number"])
    title = (issue.get("title") or "").strip()
    body = issue.get("body")
    labels = issue_labels(issue)
    version = parse_software_version(body, labels, product_names)
    plus_one, reactions_total = _reactions(issue)
    stripped = strip_markdown(body, ISSUE_TEXT_CAP)
    text = f"{title}\n\n{stripped}".strip()[:ISSUE_TEXT_CAP] if stripped else title
    attributes = {
        "kind": "issue",
        "repo": repo,
        "number": number,
        "state": issue.get("state"),
        "state_reason": issue.get("state_reason"),
        "labels": labels,
        "plus_one": plus_one,
        "reactions_total": reactions_total,
        "author_association": issue.get("author_association"),
        "milestone": _milestone(issue),
        "linked_prs": linked_pull_requests(body, repo),
        "comment_count": issue.get("comments") if isinstance(issue.get("comments"), int) else 0,
        "updated_at": issue.get("updated_at"),
        "software_version": version[0] if version else None,
        "version_source": version[1] if version else None,
        "component": detect_component(labels, body),
        "error_signature": error_signature(body),
        "has_repro": has_repro(body),
    }
    return {
        "id": issue_id(repo, number),
        "text": text or f"Issue #{number}",
        "created_at": issue.get("created_at"),
        "url": issue.get("html_url"),
        "channel": "issue",
        "author": _login(issue),
        "title": title[:500],
        "issue_attributes": _without_none(attributes),
        RAW_PAYLOAD_KEY: issue,
    }


def comment_item(
    comment: dict, repo: str, parent: dict, product_names: Iterable[str] = (),
) -> dict:
    """The feedback item for one comment on the issue *parent* (its REST payload).

    The comment's own version mention wins ("still broken on 0.4.3"); without one
    it inherits the issue's, so a thread's replies land in the release the issue
    was filed against rather than in "unversioned". Labels, state and milestone are
    the issue's — a comment has none of its own.
    """
    number = int(parent["number"])
    body = comment.get("body")
    parent_body = parent.get("body")
    labels = issue_labels(parent)
    own_version = parse_software_version(body, (), product_names)
    parent_version = parse_software_version(parent_body, labels, product_names)
    version = own_version or parent_version
    plus_one, reactions_total = _reactions(comment)
    title = (parent.get("title") or "").strip()
    stripped = strip_markdown(body, COMMENT_TEXT_CAP)
    attributes = {
        "kind": "comment",
        "repo": repo,
        "number": number,
        "parent_id": issue_id(repo, number),
        "state": parent.get("state"),
        "labels": labels,
        "plus_one": plus_one,
        "reactions_total": reactions_total,
        "author_association": comment.get("author_association"),
        "milestone": _milestone(parent),
        "linked_prs": linked_pull_requests(body, repo),
        "updated_at": comment.get("updated_at"),
        "software_version": version[0] if version else None,
        "version_source": version[1] if version else None,
        "component": detect_component(labels, parent_body),
        "error_signature": error_signature(body),
        "has_repro": has_repro(body),
    }
    return {
        "id": f"{issue_id(repo, number)}/comment-{comment['id']}",
        # The issue title gives a one-line reply ("same here") something to be about.
        "text": f"Re: {title}\n\n{stripped}".strip() if stripped else f"Re: {title}",
        "created_at": comment.get("created_at"),
        "url": comment.get("html_url"),
        "channel": "comment",
        "author": _login(comment),
        "title": f"Re: {title}"[:500],
        "issue_attributes": _without_none(attributes),
        RAW_PAYLOAD_KEY: comment,
    }


def _without_none(attributes: dict) -> dict:
    """Optional fields omitted rather than null — the schema and DynamoDB both prefer absent."""
    return {key: value for key, value in attributes.items() if value is not None}
