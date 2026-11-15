"""A GitLab project's CI definitions, pinned before a push (docs/autonomous-engineering.md, "CI definitions on GitLab").

An agent never changes a CI definition. On GitLab those are the project's CI file and every file it includes from the
project itself. The broker can read this project alone (its token is the project's), so it allows only a CI
configuration it can read whole and pin, and refuses every push otherwise, failing closed:

* the CI file (``ci_config_path``): a project answer without the key is unresolved; an empty value is
  ``.gitlab-ci.yml``; a file of another project (``@``) or a URL is refused (the broker cannot read it);
* each CI file is parsed (``ci_yaml.load``: PyYAML's composer held strict; JSON is YAML too), its top level a
  mapping, its ``include`` walked as structure: a string (a local path, or a remote one when it is a URL), a mapping,
  or a list of those. A mapping may hold only ``local``, ``template`` (with ``inputs``), ``project``, ``file``, ``ref``
  and ``remote``; ``rules``, ``component`` or any other key refuses, and so does a ``*``, a ``$``, a ``[[`` or a
  backslash in any value of it, at any depth;
* ``local`` with a literal path is allowed, and the file it names is read and walked by the same rules (at most
  ``MAX_DEPTH`` deep and ``MAX_FILES`` files); ``template`` (GitLab's own) is allowed; ``project`` (this project or
  another), ``remote`` and ``component`` are refused: the broker cannot read what they hold or include;
* every job's ``trigger`` is walked the same way: a child pipeline's ``include`` (a string, a mapping or a list) is a
  CI definition too, pinned and walked like a local include, and anything but a literal ``local`` or a ``template``
  in it refuses; a multi-project trigger (``trigger: {project: ...}``) is allowed, since it runs another project's
  CI; a top-level key whose value is not a mapping where GitLab expects one (a job) refuses;
* GitLab's CI lint stays a cross-check: an answer that is not valid, an include it resolved of another kind than
  ``local`` or ``template``, or a local one the walk did not reach, refuses.

The CI definitions are the CI file and every local file the walk reached. Pure: the client hands in the project, the
lint and the files.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Final

from engineering.connectors.ci_yaml import Escaped, Node, Opaque, Unreadable, load
from engineering.connectors.transport import dig
from engineering.connectors.write_policy import WriteRefused

DEFAULT_CI_FILE: Final = '.gitlab-ci.yml'
#: How deep local includes may nest, and how many CI files one configuration may hold, for the walk to read them all.
MAX_DEPTH: Final = 10
MAX_FILES: Final = 50
CI_UNRESOLVED: Final = ("The repository's CI configuration could not be resolved (its CI file, or GitLab's lint of it at "
                        "the push's base, is not one the broker can read as valid); agents can't push to it until it "
                        'is.')
_ALLOWED_KEYS: Final = frozenset({'local', 'template', 'inputs', 'project', 'file', 'ref', 'remote'})
#: What no include value may hold: a glob, a variable, an input, or a backslash (an escape GitLab and a reader could
#: read apart).
_UNPINNED_MARKS: Final = ('*', '$', '[[', '\\')
#: The top-level keywords whose value is not a mapping (``include`` is walked apart); every other top-level key is a
#: job or a keyword GitLab reads as a mapping, so a value of another shape is unreadable.
_NOT_JOBS: Final = frozenset({'include', 'stages', 'image', 'services', 'cache', 'before_script', 'after_script'})
#: The top-level keywords GitLab reads as mappings that are not jobs (they hold no ``trigger``).
_GLOBAL_MAPPINGS: Final = frozenset({'default', 'variables', 'workflow'})
#: The include kinds GitLab's lint may list: anything else is one the walk refuses, so the lint naming one means the
#: two read the file differently.
_LINTED_KINDS: Final = frozenset({'local', 'template'})


def unpinned(what: str) -> WriteRefused:
    """The refusal naming the include the broker cannot read and pin."""
    return WriteRefused(f"The repository's CI configuration includes {what}, which the broker can't read and pin; agents "
                        "can't push to it while it does.")


def normalised(path: str) -> str:
    """``path`` as the repository names it: no leading ``./`` or ``/``; refused when it climbs out."""
    while path.startswith(('./', '/')):
        path = path[2:] if path.startswith('./') else path[1:]
    if not path or any(part in {'', '.', '..'} for part in path.split('/')):
        raise unpinned(f'a local file outside the repository ({path or "nothing"})')
    return path


def ci_file(project: Mapping[str, object]) -> str:
    """The project's own CI file; refused when the answer has no ``ci_config_path``, or it is another project's or a
    URL (the broker cannot read them)."""
    if 'ci_config_path' not in project:
        raise WriteRefused(CI_UNRESOLVED)
    configured = project['ci_config_path']
    if configured is None or configured == '':
        return DEFAULT_CI_FILE
    if not isinstance(configured, str):
        raise WriteRefused(CI_UNRESOLVED)
    if '@' in configured or '://' in configured:
        raise unpinned(f'its CI file from elsewhere ({configured})')
    return normalised(configured)


def _texts(value: Node) -> list[str]:
    """Every text in ``value``, at any depth (keys too); refused when it holds an alias or a tag."""
    if isinstance(value, Opaque):
        raise unpinned(f'a tagged value ({value.text})')
    if isinstance(value, Escaped):
        raise unpinned(f'a value written with a backslash escape ({value})')
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [text for item in value for text in _texts(item)]
    if isinstance(value, dict):
        return [text for key, item in value.items() for text in (key, *_texts(item))]
    return []


def _entry(entry: Node) -> str | None:
    """A local include's path from one ``include`` entry, ``None`` for a GitLab template; refused otherwise."""
    marked = [text for text in _texts(entry) if any(mark in text for mark in _UNPINNED_MARKS)]
    if marked:
        raise unpinned(f'a pattern or a variable ({marked[0]})')
    if isinstance(entry, str):
        if '://' in entry:
            raise unpinned(f'a remote file ({entry})')
        return normalised(entry)
    if not isinstance(entry, dict):
        raise unpinned('an entry that is neither a path nor a mapping')
    unknown = sorted(set(entry) - _ALLOWED_KEYS)
    if unknown:
        raise unpinned(f'an entry with {", ".join(unknown)}')
    if 'project' in entry or 'file' in entry or 'ref' in entry:
        raise unpinned(f'a project\'s file ({entry.get("project")})')
    if 'remote' in entry:
        raise unpinned(f'a remote file ({entry["remote"]})')
    local, template = entry.get('local'), entry.get('template')
    if isinstance(local, str) and set(entry) == {'local'}:
        return normalised(local)
    if isinstance(template, str) and set(entry) <= {'template', 'inputs'}:
        return None
    raise unpinned('an entry the broker does not read')


def _include_value(value: Node) -> list[str]:
    """The local files an ``include`` value names (a string, a mapping, or a list of them), by ``_entry``'s rules."""
    if value is None:
        return []
    entries = value if isinstance(value, list) else [value]
    return [path for path in (_entry(entry) for entry in entries) if path is not None]


#: What a job's own ``trigger`` may hold when the job ``extends`` another: only how the pipeline runs. GitLab merges it
#: into the extended job's ``trigger``, whose ``include`` the walk already reads and pins wherever that job is defined.
_TRIGGER_SETTINGS: Final = frozenset({'strategy', 'forward'})


def _trigger(job: str, trigger: Node, extends: bool = False) -> list[str]:
    """The local files a job's ``trigger`` runs as a child pipeline (``trigger: {include: ...}``), by the same rules
    as a top-level ``include``: those files are CI definitions too, and GitLab's lint does not list them. A trigger of
    another project (``trigger: <project>`` or ``trigger: {project: ...}``, a multi-project pipeline) is allowed: it
    runs that project's CI, and puts nothing of this repository in CI."""
    if trigger is None or (isinstance(trigger, str) and not any(mark in trigger for mark in _UNPINNED_MARKS)):
        return []
    if not isinstance(trigger, dict):
        raise unpinned(f'a trigger the broker does not read (job {job})')
    if 'include' in trigger:
        return _include_value(trigger['include'])
    if 'project' in trigger:
        return []
    if extends and trigger and set(trigger) <= _TRIGGER_SETTINGS:
        return []
    raise unpinned(f'a trigger the broker does not read (job {job})')


def includes(data: bytes) -> list[str]:
    """The local files one CI file includes or runs as a child pipeline (normalised): its ``include`` walked as
    structure, and every job's ``trigger``; refused when it does not parse (``ci_yaml.load``: PyYAML's composer, held
    strict), its top level is not a mapping or holds a non-mapping where GitLab expects a job, or it includes anything
    but literal local files and GitLab's templates."""
    try:
        document = load(data)
    except Unreadable as error:
        raise WriteRefused(CI_UNRESOLVED) from error
    if not isinstance(document, dict):
        raise WriteRefused(CI_UNRESOLVED)
    found = _include_value(document.get('include'))
    for key, value in document.items():
        if key in _NOT_JOBS:
            continue
        if not isinstance(value, dict):   # (a job, or a keyword GitLab reads as a mapping, that is not one)
            raise WriteRefused(CI_UNRESOLVED)
        if key not in _GLOBAL_MAPPINGS:
            found += _trigger(key, value.get('trigger'), extends='extends' in value)
    return list(dict.fromkeys(found))


@dataclass(frozen=True)
class CiFiles:
    """The CI definitions a push must not change: the CI file and every local file its includes reached."""

    paths: tuple[str, ...]


def pinned(project: Mapping[str, object], lint: Callable[[], object], read: Callable[[str], bytes | None]) -> CiFiles:
    """The project's CI definitions at the base (``read``: a file's bytes there, ``None`` for none; ``lint``: GitLab's
    lint of the CI file there, a cross-check), or ``WriteRefused`` for a configuration the broker cannot pin."""
    own = ci_file(project)
    reached, waiting = [own], [(own, 0)]
    while waiting:   # (bounded: each file is reached once, at most MAX_FILES of them)
        path, depth = waiting.pop(0)
        found = read(path)
        if found is None:
            raise WriteRefused(CI_UNRESOLVED)
        for included in includes(found):
            if included in reached:
                continue
            if depth + 1 > MAX_DEPTH or len(reached) >= MAX_FILES:
                raise unpinned(f'more local files, or deeper, than the broker reads ({included})')
            reached.append(included)
            waiting.append((included, depth + 1))
    _cross_check(lint(), reached)
    return CiFiles(paths=tuple(reached))


def _cross_check(linted: object, reached: list[str]) -> None:
    """GitLab's lint must say ``valid``, every include it resolved must be ``local`` or ``template``, and every local
    one must be a file the walk reached: GitLab's own reading of the files catches any reading the broker's missed."""
    listed = dig(linted, 'includes')
    if dig(linted, 'valid') is not True or not isinstance(listed, list):
        raise WriteRefused(CI_UNRESOLVED)
    for item in listed:
        kind, location = dig(item, 'type'), dig(item, 'location')
        if kind not in _LINTED_KINDS:
            raise unpinned(f'an include GitLab resolves that the broker does not read ({kind}: {location})')
        if kind == 'local' and (not isinstance(location, str) or normalised(location) not in reached):
            raise unpinned(f'a local file the broker did not reach ({location})')
