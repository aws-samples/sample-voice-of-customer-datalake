"""The public GitHub REST API base URL, for every caller of api.github.com.

The design-reference reader (``shared.design_references``) and the GitHub Issues plugin's client
(``plugins/_shared/github_api.py``, which also refuses to follow a pagination link off this host)
read the same API with their own clients and auth; this is the one spelling of its address.
"""
from __future__ import annotations

from typing import Final

GITHUB_API: Final = 'https://api.github.com'
