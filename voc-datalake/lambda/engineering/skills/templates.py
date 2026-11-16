"""The bundled role templates (7.50.00): each launchable role's skill as the repository ships it, the last place a
launch resolves a skill from (``resolve.py``), labelled ``<role>@template-<version>``.

One interface, ``Templates`` (``skill``: a role's template, ``card_models``: the model each role's card names), and
one loader, ``bundled()``. The templates are compiled from ``voc-datalake/templates/orchestration/agents/<role>/``
(``agent.yaml`` and ``SKILL.md``) into the bundle, which ships in every Lambda that stages ``lambda/`` as
``lambda/shared/orchestration_bundle.json`` (``BUNDLE_PATH``). Its agents' part, as read here::

    {"agents": {"<role>": {"version": <template version>, "skill": <its voc-skill/1 record>,
                           "card": {"model": {"id": <model id>}, ...}}, ...}, ...}

A deployment whose bundle is missing (before the templates land) reads the skills the harness ships
(runtime/harness/skills.py ``SKILLS``), each as its own template version. Either way a template is a role's
skill as shipped: no person accepted it, so it comes last, after any version the skills store holds for the role.
"""
from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any, Final, Protocol

from engineering.connectors.identity import AGENT_ROLES
from engineering.runtime.harness.skills import SKILLS, Skill, SkillError

#: The bundle every Lambda that stages ``lambda/`` ships (the templates' compiler writes it, byte for byte the one in
#: voc-datalake/templates/orchestration/bundle.json).
BUNDLE_PATH: Final = Path(__file__).resolve().parents[2] / 'shared' / 'orchestration_bundle.json'
TEMPLATE_LABEL: Final = re.compile(r'(?P<role>[a-z][a-z-]{0,39})@template-(?P<version>[1-9][0-9]{0,5})\Z')


def template_label(role: str, version: int) -> str:
    """``<role>@template-<version>``: what a session row records for a launch on a role's template."""
    return f'{role}@template-{version}'


def parse_template_label(label: str) -> tuple[str, int] | None:
    """The role and template version a template label names; None for any other label."""
    match = TEMPLATE_LABEL.fullmatch(label)
    return None if match is None else (match.group('role'), int(match.group('version')))


@dataclass(frozen=True)
class TemplateSkill:
    """A role's bundled template: its version and its ``voc-skill/1`` record (whose ``version`` is that one)."""

    role: str
    version: int
    skill: Skill

    @property
    def label(self) -> str:
        return template_label(self.role, self.version)

    @property
    def record(self) -> dict[str, Any]:
        return self.skill.to_record()


class Templates(Protocol):
    def skill(self, role: str) -> TemplateSkill | None:
        """The role's template, None for a role that has none (the coach)."""
        ...

    def card_models(self) -> Mapping[str, str]:
        """The model each role's card names: what a run of the role calls (readiness checks Bedrock for each)."""
        ...


@dataclass(frozen=True)
class BundleTemplates:
    """The templates of one bundle (``from_bundle``) or of the shipped skills (``shipped``)."""

    skills: Mapping[str, TemplateSkill]

    def skill(self, role: str) -> TemplateSkill | None:
        return self.skills.get(role)

    def card_models(self) -> Mapping[str, str]:
        return {role: template.skill.model for role, template in sorted(self.skills.items())}

    @classmethod
    def shipped(cls) -> BundleTemplates:
        """The harness's shipped skills, each as its own template version."""
        return cls({role: TemplateSkill(role, skill.version, skill) for role, skill in SKILLS.items()})

    @classmethod
    def from_bundle(cls, bundle: Mapping[str, Any]) -> BundleTemplates:
        """The agents' part of a bundle (the module's doc); ``SkillError`` when it is off its shape (a bundle that
        does not read is never half used)."""
        agents = bundle.get('agents')
        if not isinstance(agents, Mapping):
            raise SkillError('the bundle has no agents')
        skills: dict[str, TemplateSkill] = {}
        for role, entry in agents.items():
            if role not in AGENT_ROLES or not isinstance(entry, Mapping) or 'skill' not in entry:
                continue   # (the coach's card: Learn's, never launched)
            version = entry.get('version')
            if isinstance(version, bool) or not isinstance(version, int) or not 0 < version < 1_000_000:
                raise SkillError(f'the bundle\'s {role} template has no version')
            skill = Skill.from_record(entry['skill'])
            if skill.name != role or skill.version != version:
                raise SkillError(f'the bundle\'s {role} template is the skill of {skill.name}@{skill.version}')
            skills[role] = TemplateSkill(role, version, skill)
        return cls(skills)


def load(path: Path = BUNDLE_PATH) -> BundleTemplates:
    """The templates of the bundle at ``path``; the shipped skills when there is none."""
    if not path.is_file():
        return BundleTemplates.shipped()
    return BundleTemplates.from_bundle(json.loads(path.read_text(encoding='utf-8')))


@cache
def bundled() -> BundleTemplates:
    """This deployment's templates (read once per container)."""
    return load()
