"""The compiled orchestration bundle as the platform reads it: the standard library only, so it ships anywhere.

``bundle.json`` is compiled from voc-datalake/templates/orchestration (``compile.py``) and committed; the Lambdas ship
its copy, ``lambda/shared/orchestration_bundle.json`` (beside this package's tree: ``BUNDLE_FILE``), and an agent
image keeps one at ``/opt/voc/orchestration/bundle.json`` (its harness names it: ``harness/skills.py``
``BUNDLE_PATHS``). ``validate`` holds both to a fresh compile, so what a reader gets here is what the templates say.
"""
from __future__ import annotations

import json
import re
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


#: The harness's tool that reads a role's library skills (7.56.00, runtime/harness/library_tools.py), and a reference
#: file's path inside its skill as a SKILL.md names it and the tool takes it (``references/<file>.md``).
READ_SKILL: Final = 'read_skill'
REFERENCE_PATH: Final = re.compile(r'references/[A-Za-z0-9][A-Za-z0-9_.-]*\.md')
#: The most Learn's card's library skills add to the coach's system prompt (7.56.00, coach/prompt.py): their SKILL.md
#: bodies, so a coach call stays within its worst-case input (learning/budget.py ``WORST_TOKENS_IN``). The validator
#: holds the card's skills to it.
MAX_LEARN_SKILLS_CHARS: Final = 12_000
_FRONT_MATTER: Final = re.compile(r'\A---\n.*?\n---\n', re.DOTALL)


def skill_body(text: str) -> str:
    """A library SKILL.md's text without its front matter."""
    return _FRONT_MATTER.sub('', text, count=1).strip()


def card_library(role: str) -> list[tuple[str, str]]:
    """The library skills ``role``'s card names in the Lambdas' bundle (7.56.00), in its order: each its name and its
    SKILL.md's body."""
    document = load()
    card = next((item for item in document['agents'] if item['id'] == role), None)
    by_name = {item['name']: item for item in document.get('library', [])}
    names = card.get('skills', []) if card is not None else []
    return [(name, skill_body(str(by_name[name]['text']))) for name in names if name in by_name]
