"""The orchestration templates' sources: where each lives, how it is read, and the JSON Schemas it must follow.

``voc-datalake/templates/orchestration/`` (its README) holds, per role, ``agents/<role>/agent.yaml`` (a
``voc-agent-card/1``) and ``SKILL.md`` (the Agent Skills format: front matter, then the sections ``REQUIRED_SECTIONS``
in order); ``flows/<id>.yaml`` (``voc-flow-template/1``); ``automations/<id>.yaml`` (``voc-automation/1``); the gate
packs under ``gates/``; the eval cases under ``evals/<flow>/cases/<case>/``; and ``_shared/PLATFORM_RULES.md``. The
schemas are ``schemas/*.schema.json`` (draft 2020-12), each with a ``urn:voc-orchestration:<name>`` id so one can
refer to another.

The YAML is read with PyYAML's safe loader, refusing a key given twice (a silent override is how a template drifts
from what its author meant). This module is the compiler's and the validator's (a development step: ``npm run
orchestration:validate``); what ships is the compiled bundle, read by ``bundle.py`` with the standard library alone.
"""
from __future__ import annotations

import json
import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any, Final

import yaml
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

#: voc-datalake/templates/orchestration (this file is voc-datalake/lambda/engineering/orchestration/schema.py).
ROOT: Final = Path(__file__).resolve().parents[3] / 'templates' / 'orchestration'
SCHEMA_NAMES: Final = ('agent-card', 'assertion', 'automation', 'bundle', 'flow', 'skill-frontmatter')
#: A SKILL.md's sections, in this order; everything above ``Examples`` is the record's instructions.
REQUIRED_SECTIONS: Final = ('Role', 'Reads', 'Writes', 'Steps', 'Rules', 'When to stop', 'Examples')
EXAMPLES: Final = 'Examples'
_FRONT_MATTER: Final = re.compile(r'\A---\n(?P<head>.*?)\n---\n(?P<body>.*)\Z', re.DOTALL)
_SECTION: Final = re.compile(r'^## (?P<title>.+)$', re.MULTILINE)
_EXAMPLE: Final = re.compile(r'^### (?P<name>[^\n]+)\n(?P<text>.*?)(?=^### |\Z)', re.MULTILINE | re.DOTALL)
_WHEN_DO: Final = re.compile(r'\A\*\*When:\*\*(?P<when>.*?)\*\*Do:\*\*(?P<do>.*)\Z', re.DOTALL)


class TemplateError(ValueError):
    """A source the compiler cannot read: the file and what is wrong with it."""


class _StrictLoader(yaml.SafeLoader):
    """PyYAML's safe loader, refusing a mapping that gives one key twice, with YAML 1.2's booleans: only true and
    false are, so a flow step's ``on:`` and an automation's ``cross_run: off`` stay the words they are (YAML 1.1 reads
    on, off, yes and no as booleans)."""


def _mapping(loader: _StrictLoader, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
    keys = [loader.construct_object(key, deep=deep) for key, _ in node.value]
    twice = sorted({str(key) for key in keys if keys.count(key) > 1})
    if twice:
        raise yaml.constructor.ConstructorError(None, None, f'the key {twice[0]!r} is given twice', node.start_mark)
    return loader.construct_mapping(node, deep=deep)


_BOOL: Final = 'tag:yaml.org,2002:bool'
_StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping)
_StrictLoader.yaml_implicit_resolvers = {
    first: [(tag, pattern) for tag, pattern in resolvers if tag != _BOOL]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()}
_StrictLoader.add_implicit_resolver(_BOOL, re.compile(r'(?:true|True|TRUE|false|False|FALSE)\Z'), list('tTfF'))


def relative(path: Path, root: Path = ROOT) -> str:
    return path.relative_to(root).as_posix()


def read_yaml(path: Path, root: Path = ROOT) -> Any:
    try:
        return yaml.load(path.read_text(encoding='utf-8'), Loader=_StrictLoader)  # noqa: S506 - a SafeLoader subclass
    except yaml.YAMLError as error:
        raise TemplateError(f'{relative(path, root)}: not readable YAML ({error})') from error


@dataclass(frozen=True)
class SkillText:
    """A SKILL.md, split: its front matter, its sections in order, and its examples."""

    front_matter: Mapping[str, Any]
    sections: tuple[tuple[str, str], ...]
    instructions: str
    examples: tuple[tuple[str, str, str], ...]


def _examples(text: str, where: str) -> tuple[tuple[str, str, str], ...]:
    found = []
    for match in _EXAMPLE.finditer(text):
        parts = _WHEN_DO.match(match['text'].strip())
        if parts is None:
            raise TemplateError(f'{where}: the example "{match["name"]}" is "**When:** ... **Do:** ..."')
        found.append((match['name'].strip(), ' '.join(parts['when'].split()), ' '.join(parts['do'].split())))
    return tuple(found)


def read_skill(path: Path, root: Path = ROOT) -> SkillText:
    """A role's SKILL.md: front matter (YAML), sections by their ``## `` headings, the examples under Examples."""
    where = relative(path, root)
    match = _FRONT_MATTER.match(path.read_text(encoding='utf-8'))
    if match is None:
        raise TemplateError(f'{where}: SKILL.md starts with its front matter between two "---" lines')
    try:
        head = yaml.load(match['head'], Loader=_StrictLoader)  # noqa: S506 - a SafeLoader subclass
    except yaml.YAMLError as error:
        raise TemplateError(f'{where}: its front matter is not readable YAML ({error})') from error
    body = match['body']
    starts = list(_SECTION.finditer(body))
    sections = tuple((start['title'].strip(), body[start.end():end].strip())
                     for start, end in zip(starts, [s.start() for s in starts[1:]] + [len(body)], strict=True))
    titles = [title for title, _ in sections]
    examples_at = next((s.start() for s in starts if s['title'].strip() == EXAMPLES), len(body))
    examples = dict(sections).get(EXAMPLES, '')
    return SkillText(front_matter=head if isinstance(head, Mapping) else {}, sections=sections,
                     instructions=body[:examples_at].strip(),
                     examples=_examples(examples, where) if EXAMPLES in titles else ())


@cache
def _schemas(root: Path) -> Mapping[str, Mapping[str, Any]]:
    return {name: json.loads((root / 'schemas' / f'{name}.schema.json').read_text(encoding='utf-8'))
            for name in SCHEMA_NAMES}


def schema(name: str, root: Path = ROOT) -> Mapping[str, Any]:
    return _schemas(root)[name]


@cache
def _validator(name: str, root: Path) -> Draft202012Validator:
    registry: Registry[Any] = Registry().with_resources(
        (document['$id'], Resource.from_contents(document)) for document in _schemas(root).values())
    return Draft202012Validator(_schemas(root)[name], registry=registry)


def errors(name: str, document: Any, root: Path = ROOT) -> Iterator[str]:
    """Each way ``document`` breaks the ``name`` schema: ``<path>: <message>``."""
    for error in sorted(_validator(name, root).iter_errors(document), key=lambda e: list(map(str, e.absolute_path))):
        where = '/'.join(str(part) for part in error.absolute_path) or '(top)'
        yield f'{where}: {error.message}'
