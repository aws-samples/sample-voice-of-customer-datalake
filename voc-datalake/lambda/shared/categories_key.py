"""The deployment's categories row in voc-aggregates (a workspace's is under it: shared/workspace_config.py).

A leaf, imported by the cached reader every API Lambda loads (shared/api.py ``get_raw_categories_config``) and by the
processor's (shared/categorization.py ``load_categories_config``), so neither pulls in the other's imports.
"""
from __future__ import annotations

from typing import Final

__all__ = ['CATEGORIES_SETTINGS_KEY']

CATEGORIES_SETTINGS_KEY: Final = {'pk': 'SETTINGS#categories', 'sk': 'config'}
