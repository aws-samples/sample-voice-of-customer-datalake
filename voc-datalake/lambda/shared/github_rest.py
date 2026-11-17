"""The public GitHub REST API base URL and version, for every caller of api.github.com.

The design-reference reader (``shared.design_references``), the GitHub Issues plugin's client
(``plugins/_shared/github_api.py``, which also refuses to follow a pagination link off this host) and the
engineering broker's client (``engineering/connectors/github.py``) read the same API with their own clients and
auth; this is the one spelling of its address and of the REST API version they ask for. Since 7.50.02 also the one
parse of a repository entry (``parse_repo``), which the GitHub Issues plugin's settings (``plugins/_shared/
github_config.py``) and the connections' follow of that source (``engineering/connectors/issues_sync.py``) share.
"""
from __future__ import annotations

import re
from typing import Final

GITHUB_API: Final = 'https://api.github.com'
#: The ``X-GitHub-Api-Version`` header's value.
GITHUB_API_VERSION: Final = '2022-11-28'
#: A GitHub App's id or an installation's: digits, no leading zero (the engineering connections' ``APP_NUMBER`` and the
#: github_issues source's ``github_app_id``).
GITHUB_NUMBER: Final = re.compile(r'[1-9][0-9]{0,19}')
#: A repository as ``owner/name`` (GitHub's limits: a 39-character owner, a 100-character name).
GITHUB_REPOSITORY: Final = re.compile(r'^[A-Za-z0-9_.-]{1,39}/[A-Za-z0-9_.-]{1,100}\Z')
#: ``https://github.com/…``, ``github.com/…`` or ``www.github.com/…``, query and fragment cut. Any other host falls
#: through to the bare ``owner/name`` check and fails it.
GITHUB_URL: Final = re.compile(r'^(?:https?://)?(?:www\.)?github\.com/(?P<path>[^?#]*)', re.IGNORECASE)


def parse_repo(candidate: str) -> str | None:
    """``owner/name`` from what a user pasted, or None when it names no GitHub repository.

    A GitHub URL keeps only its first two path segments, so a link to the repository's issues, pull requests, a file
    or a single issue all name the repository itself. A bare value must be exactly ``owner/name``: ``a/b/c`` without a
    host is a typo, not a deep link.
    """
    match = GITHUB_URL.match(candidate)
    if match:
        segments = [segment for segment in match.group('path').split('/') if segment]
        if len(segments) < 2:
            return None
        repo = f'{segments[0]}/{segments[1]}'
    else:
        repo = candidate.strip('/')
    repo = repo.removesuffix('.git')
    return repo if GITHUB_REPOSITORY.fullmatch(repo) else None
