"""The public GitHub REST API base URL and version, for every caller of api.github.com.

The design-reference reader (``shared.design_references``), the GitHub Issues plugin's client
(``plugins/_shared/github_api.py``, which also refuses to follow a pagination link off this host) and the
engineering broker's client (``engineering/connectors/github.py``) read the same API with their own clients and
auth; this is the one spelling of its address and of the REST API version they ask for.
"""
from __future__ import annotations

from typing import Final

GITHUB_API: Final = 'https://api.github.com'
#: The ``X-GitHub-Api-Version`` header's value.
GITHUB_API_VERSION: Final = '2022-11-28'
