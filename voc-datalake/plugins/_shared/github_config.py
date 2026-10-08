"""
The github_issues plugin's settings, parsed once for the ingestor and the webhook.

All of them arrive as strings in the plugin's secret namespace (the Settings UI
writes every manifest field there):

* ``repos``: one ``owner/name`` per line or comma-separated. A pasted GitHub URL
  works too, including a deep link such as ``https://github.com/owner/name/issues``;
* ``labels`` (optional): comma-separated, ANY-of;
* ``product_names`` (optional): extra names a body may cite a version under, e.g. ``Kiro``;
* ``created_after`` (optional): ``YYYY-MM-DD``; issues and comments created
  before that day are not ingested;
* ``exclude_associations`` (optional): comma-separated GitHub author
  associations (``OWNER, MEMBER, COLLABORATOR``) whose issues and comments are
  not customer voice.
"""

import re
from dataclasses import dataclass
from datetime import date

__all__ = ["AUTHOR_ASSOCIATIONS", "GitHubSourceConfig", "parse_repo"]

_REPO = re.compile(r"^[A-Za-z0-9_.-]{1,39}/[A-Za-z0-9_.-]{1,100}$")
#: ``https://github.com/…``, ``github.com/…`` or ``www.github.com/…``, query and fragment cut.
#: Any other host falls through to the bare ``owner/name`` check and fails it.
_GITHUB_URL = re.compile(r"^(?:https?://)?(?:www\.)?github\.com/(?P<path>[^?#]*)", re.IGNORECASE)
MAX_REPOS = 20
#: GitHub's ``author_association`` values (REST ``issue`` / ``issue-comment`` schemas).
AUTHOR_ASSOCIATIONS = frozenset({
    "OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR",
    "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN", "NONE",
})


def _split(value: object) -> list[str]:
    if not isinstance(value, str):
        return []
    return [part.strip() for part in re.split(r"[\n,]", value) if part.strip()]


def parse_repo(candidate: str) -> str | None:
    """``owner/name`` from what a user pasted, or None when it names no GitHub repository.

    A GitHub URL keeps only its first two path segments, so a link to the
    repository's issues, pull requests, a file or a single issue all name the
    repository itself. A bare value must be exactly ``owner/name``: ``a/b/c``
    without a host is a typo, not a deep link.
    """
    match = _GITHUB_URL.match(candidate)
    if match:
        segments = [segment for segment in match.group("path").split("/") if segment]
        if len(segments) < 2:
            return None
        repo = f"{segments[0]}/{segments[1]}"
    else:
        repo = candidate.strip("/")
    repo = repo.removesuffix(".git")
    return repo if _REPO.fullmatch(repo) else None


def _created_after(value: object) -> str | None:
    """``YYYY-MM-DD`` → GitHub's timestamp form at midnight UTC, or None when unset or invalid."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        day = date.fromisoformat(value.strip())
    except ValueError:
        return None
    return f"{day.isoformat()}T00:00:00Z"


@dataclass(frozen=True)
class GitHubSourceConfig:
    repos: tuple[str, ...]
    labels: frozenset[str]
    product_names: tuple[str, ...]
    #: Entries of ``repos`` that name no GitHub repository, so the ingestor can say so.
    rejected_repos: tuple[str, ...] = ()
    #: GitHub-format timestamp (``2026-01-01T00:00:00Z``), or None for no lower bound.
    created_after: str | None = None
    excluded_associations: frozenset[str] = frozenset()

    @classmethod
    def from_secrets(cls, secrets: dict) -> "GitHubSourceConfig":
        repos: list[str] = []
        rejected: list[str] = []
        seen: set[str] = set()
        for candidate in _split(secrets.get("repos")):
            repo = parse_repo(candidate)
            if repo is None:
                rejected.append(candidate[:200])
            elif repo.lower() not in seen:
                seen.add(repo.lower())
                repos.append(repo)
        # The repo's own name is the obvious product name ("Kiro 0.4.2" in kirodotdev/Kiro).
        names = _split(secrets.get("product_names")) + [repo.split("/")[1] for repo in repos]
        unique_names = tuple(dict.fromkeys(name for name in names if len(name) >= 2))
        associations = {value.upper().replace(" ", "_") for value in _split(secrets.get("exclude_associations"))}
        return cls(
            repos=tuple(repos[:MAX_REPOS]),
            labels=frozenset(label.lower() for label in _split(secrets.get("labels"))),
            product_names=unique_names,
            rejected_repos=tuple(rejected),
            created_after=_created_after(secrets.get("created_after")),
            excluded_associations=frozenset(associations & AUTHOR_ASSOCIATIONS),
        )

    def admits_labels(self, labels: list[str]) -> bool:
        """No filter admits everything; otherwise the issue needs ANY configured label."""
        return not self.labels or any(label.lower() in self.labels for label in labels)

    def admits_author(self, entity: dict) -> bool:
        """False for an issue or comment whose author association is excluded (e.g. the maintainers)."""
        association = entity.get("author_association")
        return not (isinstance(association, str) and association.upper() in self.excluded_associations)

    def admits_created(self, entity: dict) -> bool:
        """False for an issue or comment created before ``created_after``.

        GitHub timestamps share one fixed format, so they compare as strings. An
        entity without a ``created_at`` is admitted: the filter bounds volume, it
        must not silently drop malformed data.
        """
        created_at = entity.get("created_at")
        return not (self.created_after and isinstance(created_at, str) and created_at < self.created_after)

    def admits(self, entity: dict) -> bool:
        """Both per-item filters: author association and creation date."""
        return self.admits_author(entity) and self.admits_created(entity)

    def listing_since(self, watermark: str | None) -> str | None:
        """The ``since`` to ask GitHub for: the watermark, raised to ``created_after``.

        ``since`` filters on ``updated_at``, and nothing created on or after the
        cut-off can have been updated before it, so raising ``since`` never hides
        an item the date filter would admit — it only skips listing pages of
        older ones. Both values are GitHub-format timestamps.
        """
        if not self.created_after:
            return watermark
        if not watermark:
            return self.created_after
        return max(watermark, self.created_after)

    def canonical_repo(self, full_name: object) -> str | None:
        """The configured spelling of *full_name* (GitHub names are case-insensitive), or None."""
        if not isinstance(full_name, str):
            return None
        return next((repo for repo in self.repos if repo.lower() == full_name.lower()), None)
