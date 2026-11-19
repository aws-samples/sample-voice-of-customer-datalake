"""The skills library as the app reads it (7.56.00): Skills → Library, from the orchestration bundle (``library``).

``library_view``: every library skill without its text (its name, description, source, licence, what was adapted,
path, digest, size, the roles whose cards name it, and its reference files' paths, digests and sizes);
``library_file``: one skill's SKILL.md, or one of its reference files, with its text. Pure, read only: the bundle is the
repository's, compiled (``orchestration/compile.py`` ``library_entry``). The text is data the app shows through its
document component, never HTML.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Final

from engineering.orchestration.bundle import READ_SKILL

#: A library skill's name (``schemas/library-skill.schema.json``).
SKILL_NAME: Final = re.compile(r'[a-z][a-z0-9-]{1,40}')
LISTED: Final = ('name', 'description', 'source', 'license', 'adapted', 'path', 'digest', 'bytes', 'roles')
FILE: Final = ('digest', 'bytes')


def card_skills(template: Mapping[str, Any] | None, tools: Any) -> list[str]:
    """The library skills a Registry card uses: its role template's, when the tools it runs with have ``read_skill``
    (a skill version stored before 7.56.00 has not, so it uses none), or Learn's card's, which its prompt carries."""
    if template is None:
        return []
    skills = [str(name) for name in template.get('skills', [])]
    uses = template.get('harness') == 'learn' or (isinstance(tools, list) and READ_SKILL in tools)
    return skills if uses else []


def with_skills(card: Mapping[str, Any], bundle: Mapping[str, Any]) -> dict[str, Any]:
    """A made card (``kind: card``) with the library skills it uses (``card_skills`` of its base role's template)."""
    template = next((agent for agent in bundle['agents'] if agent['id'] == card.get('base_role')), None)
    return {**card, 'skills': card_skills(template, card.get('tools'))}


def library_view(bundle: Mapping[str, Any]) -> dict[str, Any]:
    """``{skills: [...]}``: every library skill, by name, without its text."""
    return {'skills': [{**{key: item[key] for key in LISTED},
                        'references': [{'path': ref['path'], **{key: ref[key] for key in FILE}}
                                       for ref in item['references']]}
                       for item in bundle.get('library', [])]}


def library_file(bundle: Mapping[str, Any], name: str, reference: str = '') -> dict[str, Any] | None:
    """``{name, reference, path, text, digest, bytes}``: the skill's SKILL.md (``reference`` '': None in the answer), or
    that reference file of it; None for no such skill or reference."""
    skill = next((item for item in bundle.get('library', []) if item['name'] == name), None)
    if skill is None:
        return None
    if not reference:
        return {'name': name, 'reference': None, 'path': skill['path'], 'text': skill['text'],
                **{key: skill[key] for key in FILE}}
    found = next((ref for ref in skill['references'] if ref['path'] == reference), None)
    if found is None:
        return None
    folder = skill['path'].rsplit('/', 1)[0]
    return {'name': name, 'reference': reference, 'path': f'{folder}/{reference}', 'text': found['text'],
            **{key: found[key] for key in FILE}}
