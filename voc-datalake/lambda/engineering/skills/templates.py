"""The bundled role templates (7.50.00): each launchable role's skill as the repository ships it, the last place a
launch resolves a skill from (``resolve.py``), labelled ``<role>@template-<version>``, and the platform's rules the
harness puts around every skill.

One interface, ``Templates`` (``skill``: a role's template; ``platform_rules``: the rules' text), one loader,
``bundled()``, whose ``card_models`` also names the model each role's card names (readiness). The templates are
compiled from ``voc-datalake/templates/orchestration/`` into its ``bundle.json`` (``voc-orchestration-bundle/1``),
which every Lambda that stages ``lambda/`` ships byte for byte as ``orchestration_bundle.json`` in its ``shared``
package (the first of ``BUNDLE_PATHS``). The parts read here::

    {"agents": [{"id": "<role>", "version": <template version>, "label": "<role>@template-<version>",
                 "skill": <its voc-skill/1 record, null for the coach>, ...}, ...],
     "platform_rules": {"text": "...", "digest": "sha256:..."}, ...}

A deployment without a bundle reads the skills the harness ships (runtime/harness/skills.py ``SKILLS``), each as its own
template version, and the harness's own rules. Either way a template is a role's skill as shipped: no person accepted
it, so it comes last, after any version the skills store holds for the role.
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

_LAMBDA: Final = Path(__file__).resolve().parents[2]
#: The bundle's places, the first that exists read: the copy every Lambda ships, then the repository's own (a local
#: run and the tests; no Lambda stages ``templates/``).
BUNDLE_PATHS: Final = (_LAMBDA / 'shared' / 'orchestration_bundle.json',
                       _LAMBDA.parent / 'templates' / 'orchestration' / 'bundle.json')
BUNDLE_SCHEMA: Final = 'voc-orchestration-bundle/1'
TEMPLATE_LABEL: Final = re.compile(r'(?P<role>[a-z][a-z-]{0,39})@template-(?P<version>[1-9][0-9]{0,5})\Z')
MAX_RULES: Final = 20_000


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

    def platform_rules(self) -> str:
        """The platform's rules the harness puts around every skill ('' for the harness's own)."""
        ...


@dataclass(frozen=True)
class BundleTemplates:
    """The templates of one bundle (``from_bundle``) or of the shipped skills (``shipped``)."""

    skills: Mapping[str, TemplateSkill]
    rules: str = ''

    def skill(self, role: str) -> TemplateSkill | None:
        return self.skills.get(role)

    def card_models(self) -> Mapping[str, str]:
        """The model each role's card names: what a run of the role calls (readiness checks Bedrock for each)."""
        return {role: template.skill.model for role, template in sorted(self.skills.items())}

    def platform_rules(self) -> str:
        return self.rules

    @classmethod
    def shipped(cls) -> BundleTemplates:
        """The harness's shipped skills, each as its own template version."""
        return cls({role: TemplateSkill(role, skill.version, skill) for role, skill in SKILLS.items()})

    @classmethod
    def from_bundle(cls, bundle: Mapping[str, Any]) -> BundleTemplates:
        """The agents and the rules of a bundle (the module's doc); ``SkillError`` when it is off its shape (a bundle
        that does not read is never half used)."""
        agents = bundle.get('agents')
        if bundle.get('schema') != BUNDLE_SCHEMA or not isinstance(agents, list):
            raise SkillError(f'not a {BUNDLE_SCHEMA} bundle with its agents')
        skills: dict[str, TemplateSkill] = {}
        for entry in agents:
            role = entry.get('id') if isinstance(entry, Mapping) else None
            if role not in AGENT_ROLES or role in skills:
                raise SkillError('each of the bundle\'s agents is one agent role, once')
            if entry.get('skill') is None:
                continue   # (the coach's card: Learn's, never launched)
            version = entry.get('version')
            if isinstance(version, bool) or not isinstance(version, int) or not 0 < version < 1_000_000:
                raise SkillError(f'the bundle\'s {role} template has no version')
            skill = Skill.from_record(entry['skill'])
            if skill.name != role or skill.version != version:
                raise SkillError(f'the bundle\'s {role} template is the skill of {skill.name}@{skill.version}')
            skills[str(role)] = TemplateSkill(str(role), version, skill)
        rules = bundle.get('platform_rules')
        text = rules.get('text') if isinstance(rules, Mapping) else None
        if not isinstance(text, str) or not 0 < len(text) <= MAX_RULES:
            raise SkillError('the bundle has no platform rules')
        return cls(skills, text)


def load(paths: tuple[Path, ...] = BUNDLE_PATHS) -> BundleTemplates:
    """The templates of the first bundle of ``paths`` that exists; the shipped skills when there is none."""
    for path in paths:
        if path.is_file():
            return BundleTemplates.from_bundle(json.loads(path.read_text(encoding='utf-8')))
    return BundleTemplates.shipped()


@cache
def bundled() -> BundleTemplates:
    """This deployment's templates (read once per container)."""
    return load()
