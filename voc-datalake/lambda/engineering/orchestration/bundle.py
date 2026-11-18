"""The compiled orchestration bundle as the platform reads it: the standard library only, so it ships anywhere.

``bundle.json`` is compiled from voc-datalake/templates/orchestration (``compile.py``) and committed; the Lambdas ship
its copy, ``lambda/shared/orchestration_bundle.json`` (beside this package's tree: ``BUNDLE_FILE``), and an agent
image keeps one at ``/opt/voc/orchestration/bundle.json`` (its harness names it: ``harness/skills.py``
``BUNDLE_PATHS``). ``validate`` holds both to a fresh compile, so what a reader gets here is what the templates say.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from functools import cache
from pathlib import Path
from typing import Any, Final

SCHEMA: Final = 'voc-orchestration-bundle/1'
#: lambda/shared/orchestration_bundle.json (this file is lambda/engineering/orchestration/bundle.py).
BUNDLE_FILE: Final = Path(__file__).resolve().parents[2] / 'shared' / 'orchestration_bundle.json'


class BundleError(ValueError):
    """A bundle that is not ``voc-orchestration-bundle/1``."""


@cache
def _read(path: Path) -> Mapping[str, Any]:
    document = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(document, Mapping) or document.get('schema') != SCHEMA:
        raise BundleError(f'{path.name} is not {SCHEMA}')
    return document


def load(path: Path | None = None) -> Mapping[str, Any]:
    """The bundle (read once per path): ``path``, or the Lambdas' copy."""
    return _read(path or BUNDLE_FILE)


def agent(role: str, path: Path | None = None) -> Mapping[str, Any] | None:
    """The bundled card of ``role``: its ``label`` (``<role>@template-<version>``, as a session row names the bundled
    template), its ``digest`` and its ``skill`` (the ``voc-skill/1`` record; None for Learn's card); None for no
    role of the bundle."""
    return next((item for item in load(path)['agents'] if item['id'] == role), None)


def flow(template_id: str, path: Path | None = None) -> Mapping[str, Any] | None:
    """The bundled flow template (its ``definition`` the ``voc-workflow/2`` one), or None."""
    return next((item for item in load(path)['flows'] if item['template_id'] == template_id), None)


def platform_rules(path: Path | None = None) -> str:
    """The rules the harness puts around every skill (``_shared/PLATFORM_RULES.md``)."""
    return str(load(path)['platform_rules']['text'])
