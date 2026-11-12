"""Language gate packs: load the manifests, detect the packs a repository needs, plan their checks.

A pack is a directory of voc-datalake/engineering-gates with a manifest.toml (schema voc-gate-pack/1):
the languages it covers (marker files and source extensions), the repository's own gate it prefers, the tools
it expects with their pinned versions, the registries it needs, and its ordered steps. Detection reads only a
listing of the repository plus a few small config files (a ``RepoView``: a connector's tree listing works as well
as a checkout), so a large repository is never read whole.

A step runs only where the repository has adopted its tool (``when_any``): the gate checks a change against the
repository's own rules, never against rules the team never chose.
"""
from __future__ import annotations

import dataclasses
import fnmatch
import json
import os
import re
import tomllib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

SCHEMA = 'voc-gate-pack/1'
MANIFEST = 'manifest.toml'
#: Step kinds in the order the gate runs them: setup first, then the cheapest checks, tests last.
KIND_ORDER = ('setup', 'format', 'lint', 'types', 'build', 'test')
STEP_KINDS = frozenset(KIND_ORDER)
DEFAULT_TIMEOUT_S = 900
MAX_TIMEOUT_S = 3 * 3600
MAX_CONFIG_BYTES = 1_000_000
#: Directories never walked or counted: dependencies, build output, virtualenvs, version control.
SKIP_DIRS = frozenset({'.git', 'node_modules', 'target', 'build', 'dist', '.venv', 'venv', '__pycache__',
                       '.gradle', '.mvn', '.tox', '.mypy_cache', '.ruff_cache', 'coverage'})
_ID = re.compile(r'[a-z][a-z0-9-]{0,39}(?:\.[a-z][a-z0-9-]{0,39})?\Z')
NO_CODES: frozenset[int] = frozenset()
#: The one placeholder a manifest may use: the sandbox's interpreter.
PYTHON = '{python}'
PACK_KEYS = frozenset({'schema', 'id', 'name', 'network', 'image', 'languages', 'tools', 'steps'})
STEP_KEYS = frozenset({'id', 'language', 'name', 'kind', 'argv', 'timeout_s', 'when_any', 'prefer',
                       'empty_exit_codes', 'expect_output'})


class PackError(ValueError):
    """A manifest that does not follow ``voc-gate-pack/1``."""


@dataclass(frozen=True)
class RepoView:
    """What detection may know about a repository: its file paths and a reader for small config files."""

    files: frozenset[str]
    read_text: Callable[[str], str | None]

    @classmethod
    def from_dir(cls, root: Path) -> RepoView:
        """Every file under ``root`` (POSIX paths relative to it), skipping ``SKIP_DIRS``."""
        files: set[str] = set()
        for current, dirs, names in os.walk(root):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
            base = Path(current).relative_to(root)
            files.update((base / name).as_posix() for name in names)
        resolved_root = root.resolve()

        def read(path: str) -> str | None:
            target = (resolved_root / path).resolve()
            if not target.is_relative_to(resolved_root) or not target.is_file():
                return None
            if target.stat().st_size > MAX_CONFIG_BYTES:
                return None
            return target.read_text(encoding='utf-8', errors='replace')

        return cls(frozenset(files), read)


@dataclass(frozen=True)
class Condition:
    """True when ``file`` (relative to the root) exists, holds ``contains``, or names ``npm_script``.

    ``glob`` instead of ``file``: true when any file under the root matches it.
    """

    file: str = ''
    glob: str = ''
    contains: str = ''
    npm_script: str = ''

    def holds(self, repo: RepoView, root: str) -> bool:
        if self.glob:
            prefix = f'{root}/' if root else ''
            return any(path.startswith(prefix) and fnmatch.fnmatch(path[len(prefix):], self.glob)
                       for path in repo.files)
        path = join(root, self.file)
        if path not in repo.files:
            return False
        if not self.contains and not self.npm_script:
            return True
        text = repo.read_text(path) or ''
        if self.contains and self.contains not in text:
            return False
        return not self.npm_script or self.npm_script in _npm_scripts(text)


@dataclass(frozen=True)
class Alternative:
    """A command used instead of the step's own when every condition holds (the repository's own script)."""

    when: tuple[Condition, ...]
    argv: tuple[str, ...]


@dataclass(frozen=True)
class Step:
    id: str
    language: str
    name: str
    kind: str
    argv: tuple[str, ...]
    timeout_s: int = DEFAULT_TIMEOUT_S
    when_any: tuple[Condition, ...] = ()
    prefer: tuple[Alternative, ...] = ()
    empty_exit_codes: frozenset[int] = NO_CODES
    expect_output: str = ''


@dataclass(frozen=True)
class Language:
    id: str
    markers: tuple[str, ...]
    extensions: tuple[str, ...]
    #: A root where one of these holds is a workspace: the roots under it are its members, checked through it.
    workspace: tuple[Condition, ...] = ()


#: The repository's own gate: when a repository a pack covers has it, it runs instead of every pack step.
OWN_GATE_FILE = 'scripts/validate.sh'
OWN_GATE_ARGV = ('bash', OWN_GATE_FILE)
OWN_GATE_TIMEOUT_S = 7200


@dataclass(frozen=True)
class Tool:
    name: str
    version_argv: tuple[str, ...]


@dataclass(frozen=True)
class Needs:
    """What packs need from the gate runner's MicroVM.

    ``tools``: the versions the gate records; ``network``: the registries the setup steps reach (the dependency
    step's egress allowlist); ``image``: the toolchain versions the pack's image installs (toolchain → version).
    """

    tools: tuple[Tool, ...] = ()
    network: tuple[str, ...] = ()
    image: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Pack:
    id: str
    name: str
    languages: tuple[Language, ...]
    steps: tuple[Step, ...]
    needs: Needs = field(default_factory=Needs)


@dataclass(frozen=True)
class PlannedCheck:
    """One command of the deterministic gate, resolved for one root of the repository."""

    key: str
    pack_id: str
    step_id: str
    name: str
    kind: str
    language: str
    root: str
    argv: tuple[str, ...]
    timeout_s: int
    empty_exit_codes: frozenset[int] = NO_CODES
    expect_output: str = ''


@dataclass(frozen=True)
class GatePlan:
    checks: tuple[PlannedCheck, ...]
    packs: tuple[str, ...]
    own_gate: bool = False
    skipped: tuple[tuple[str, str], ...] = ()
    needs: Needs = field(default_factory=Needs)


@dataclass(frozen=True)
class Detection:
    pack: Pack
    roots: Mapping[str, tuple[str, ...]] = field(default_factory=dict)


def join(root: str, path: str) -> str:
    return f'{root}/{path}' if root else path


def _npm_scripts(text: str) -> frozenset[str]:
    try:
        data = json.loads(text)
    except ValueError:
        return frozenset()
    scripts = data.get('scripts') if isinstance(data, dict) else None
    return frozenset(scripts) if isinstance(scripts, dict) else frozenset()


# ── loading ─────────────────────────────────────────────────────────────────────


def _str(table: Mapping[str, Any], key: str, where: str, *, default: str | None = None) -> str:
    value = table.get(key, default)
    if not isinstance(value, str) or (default is None and not value):
        raise PackError(f'{where}: "{key}" must be a non-empty string')
    return value


def _strs(table: Mapping[str, Any], key: str, where: str, *, required: bool = False) -> tuple[str, ...]:
    value = table.get(key, [])
    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
        raise PackError(f'{where}: "{key}" must be a list of non-empty strings')
    if required and not value:
        raise PackError(f'{where}: "{key}" must not be empty')
    return tuple(value)


def _codes(table: Mapping[str, Any], key: str, where: str) -> frozenset[int]:
    value = table.get(key, [])
    if not isinstance(value, list) or not all(isinstance(v, int) and 1 <= v <= 255 for v in value):
        raise PackError(f'{where}: "{key}" must be a list of non-zero exit codes (1-255)')
    return frozenset(value)


def _pattern(table: Mapping[str, Any], key: str, where: str) -> str:
    value = _str(table, key, where, default='')
    try:
        re.compile(value)
    except re.error as exc:
        raise PackError(f'{where}: "{key}" is not a valid regular expression ({exc})') from exc
    return value


def _timeout(table: Mapping[str, Any], where: str) -> int:
    value = table.get('timeout_s', DEFAULT_TIMEOUT_S)
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= MAX_TIMEOUT_S:
        raise PackError(f'{where}: "timeout_s" must be an integer from 1 to {MAX_TIMEOUT_S}')
    return value


def _relative(path: str, where: str) -> str:
    pure = PurePosixPath(path)
    if pure.is_absolute() or '..' in pure.parts:
        raise PackError(f'{where}: "{path}" must be a path inside the repository')
    return path


def _conditions(raw: Any, where: str) -> tuple[Condition, ...]:
    if not isinstance(raw, list):
        raise PackError(f'{where}: conditions must be a list of tables')
    out = []
    for index, item in enumerate(raw):
        at = f'{where}[{index}]'
        if not isinstance(item, dict):
            raise PackError(f'{at}: a condition must be a table')
        unknown = set(item) - {'file', 'glob', 'contains', 'npm_script'}
        if unknown:
            raise PackError(f'{at}: unknown keys {sorted(unknown)}')
        file = _relative(_str(item, 'file', at, default=''), at)
        glob = _str(item, 'glob', at, default='')
        if bool(file) == bool(glob):
            raise PackError(f'{at}: a condition names exactly one of "file" and "glob"')
        out.append(Condition(file=file, glob=glob, contains=_str(item, 'contains', at, default=''),
                             npm_script=_str(item, 'npm_script', at, default='')))
    return tuple(out)


def _step(raw: Mapping[str, Any], languages: set[str], where: str) -> Step:
    unknown = set(raw) - STEP_KEYS
    if unknown:
        raise PackError(f'{where}: unknown keys {sorted(unknown)}')
    step_id = _str(raw, 'id', where)
    if not _ID.match(step_id):
        raise PackError(f'{where}: step id "{step_id}" must look like "rust.clippy"')
    language = _str(raw, 'language', where)
    if language not in languages:
        raise PackError(f'{where}: language "{language}" is not declared in [languages]')
    kind = _str(raw, 'kind', where)
    if kind not in STEP_KINDS:
        raise PackError(f'{where}: kind "{kind}" is not one of {sorted(STEP_KINDS)}')
    prefer = []
    for index, alt in enumerate(raw.get('prefer', [])):
        at = f'{where}.prefer[{index}]'
        if not isinstance(alt, dict):
            raise PackError(f'{at}: an alternative must be a table')
        prefer.append(Alternative(when=_conditions(alt.get('when', []), at),
                                  argv=_strs(alt, 'argv', at, required=True)))
    argv = _strs(raw, 'argv', where)
    if not argv and not prefer:
        raise PackError(f'{where}: a step needs "argv" or at least one "prefer" alternative')
    return Step(
        id=step_id, language=language, name=_str(raw, 'name', where), kind=kind, argv=argv,
        timeout_s=_timeout(raw, where), when_any=_conditions(raw.get('when_any', []), f'{where}.when_any'),
        prefer=tuple(prefer), empty_exit_codes=_codes(raw, 'empty_exit_codes', where),
        expect_output=_pattern(raw, 'expect_output', where),
    )


def _languages(data: Mapping[str, Any], where: str) -> tuple[Language, ...]:
    raw = data.get('languages')
    if not isinstance(raw, dict) or not raw:
        raise PackError(f'{where}: [languages] must declare at least one language')
    if not all(isinstance(spec, dict) for spec in raw.values()):
        raise PackError(f'{where}: every [languages] entry must be a table')
    return tuple(Language(id=lang_id, markers=_strs(spec, 'markers', f'{where}.languages.{lang_id}', required=True),
                          extensions=_strs(spec, 'extensions', f'{where}.languages.{lang_id}', required=True),
                          workspace=_conditions(spec.get('workspace', []), f'{where}.languages.{lang_id}.workspace'))
                 for lang_id, spec in raw.items())


def _steps(data: Mapping[str, Any], languages: tuple[Language, ...], where: str) -> tuple[Step, ...]:
    steps = tuple(_step(raw, {lang.id for lang in languages}, f'{where}.steps[{index}]')
                  for index, raw in enumerate(data.get('steps', [])))
    if not steps:
        raise PackError(f'{where}: a pack needs at least one [[steps]] entry')
    ids = [step.id for step in steps]
    twice = sorted({step_id for step_id in ids if ids.count(step_id) > 1})
    if twice:
        raise PackError(f'{where}: step id "{twice[0]}" is declared twice')
    return steps


def _tools(data: Mapping[str, Any], where: str) -> tuple[Tool, ...]:
    raw = data.get('tools', {})
    if not isinstance(raw, dict) or not all(isinstance(spec, dict) for spec in raw.values()):
        raise PackError(f'{where}: every [tools] entry must be a table')
    return tuple(Tool(name=name, version_argv=_strs(spec, 'version_argv', f'{where}.tools.{name}', required=True))
                 for name, spec in raw.items())


def _image(data: Mapping[str, Any], where: str) -> dict[str, str]:
    image = data.get('image', {})
    if not isinstance(image, dict) or not all(isinstance(v, str) and v for v in image.values()):
        raise PackError(f'{where}: [image] maps each toolchain to a version string')
    return dict(image)


def parse_pack(data: Mapping[str, Any], where: str) -> Pack:
    """A ``Pack`` from a parsed manifest; ``PackError`` names the first thing wrong with it."""
    if data.get('schema') != SCHEMA:
        raise PackError(f'{where}: "schema" must be "{SCHEMA}"')
    unknown = set(data) - PACK_KEYS
    if unknown:
        raise PackError(f'{where}: unknown keys {sorted(unknown)}')
    pack_id = _str(data, 'id', where)
    if not _ID.match(pack_id) or '.' in pack_id:
        raise PackError(f'{where}: pack id "{pack_id}" must be lowercase letters, digits and dashes')
    languages = _languages(data, where)
    return Pack(id=pack_id, name=_str(data, 'name', where), languages=languages,
                steps=_steps(data, languages, where),
                needs=Needs(tools=_tools(data, where), network=_strs(data, 'network', where),
                            image=_image(data, where)))


def load_pack(path: Path) -> Pack:
    try:
        data = tomllib.loads(path.read_text(encoding='utf-8'))
    except tomllib.TOMLDecodeError as exc:
        raise PackError(f'{path}: not valid TOML ({exc})') from exc
    pack = parse_pack(data, str(path))
    if pack.id != path.parent.name:
        raise PackError(f'{path}: pack id "{pack.id}" must match its directory "{path.parent.name}"')
    return pack


def load_packs(directory: Path) -> tuple[Pack, ...]:
    """Every pack under ``directory`` (one sub-directory each, with its ``manifest.toml``), by id."""
    manifests = sorted(directory.glob(f'*/{MANIFEST}'))
    if not manifests:
        raise PackError(f'{directory}: no gate packs found')
    return tuple(load_pack(manifest) for manifest in manifests)


def default_packs_dir() -> Path:
    """voc-datalake/engineering-gates, next to this package (the MicroVM image keeps the same layout)."""
    return Path(__file__).resolve().parents[3] / 'engineering-gates'


# ── detection and planning ─────────────────────────────────────────────────────


def language_roots(language: Language, repo: RepoView) -> tuple[str, ...]:
    """The directories holding a marker of ``language`` with at least one of its source files under them.

    A workspace's members (the directories under a root where a ``workspace`` condition holds: a Cargo
    ``[workspace]``, npm ``workspaces``, Maven ``<modules>``) are checked through the workspace, never twice. Any
    other marker below a root is a root of its own: a tooling-only package.json at the top hides no app.
    """
    candidates = sorted({_parent(path) for path in repo.files if PurePosixPath(path).name in language.markers},
                        key=lambda root: (root.count('/') + bool(root), root))
    roots: list[str] = []
    workspaces = [root for root in candidates if any(cond.holds(repo, root) for cond in language.workspace)]
    for candidate in candidates:
        if any(_under(candidate, ws) and candidate != ws for ws in workspaces if ws in roots):
            continue
        if any(_under(path, candidate) and path.endswith(language.extensions) for path in repo.files):
            roots.append(candidate)
    return tuple(sorted(roots))


def _parent(path: str) -> str:
    parent = PurePosixPath(path).parent.as_posix()
    return '' if parent == '.' else parent


def _under(path: str, root: str) -> bool:
    return not root or path == root or path.startswith(f'{root}/')


def detect(packs: Sequence[Pack], repo: RepoView) -> tuple[Detection, ...]:
    """The packs with at least one language present, each with that language's roots."""
    found = []
    for pack in packs:
        roots = {lang.id: language_roots(lang, repo) for lang in pack.languages}
        roots = {lang_id: lang_roots for lang_id, lang_roots in roots.items() if lang_roots}
        if roots:
            found.append(Detection(pack=pack, roots=roots))
    return tuple(found)


def _affected(root: str, all_roots: frozenset[str], changed: Sequence[str] | None) -> bool:
    """A root is checked when the change touches it, or touches a file outside every root (shared config).

    ``all_roots`` holds the roots of every detected language, so a change in one language's root is not a
    shared file for another's.
    """
    if changed is None or not root:
        return True
    return any(_under(path, root) or not any(_under(path, other) for other in all_roots if other)
               for path in changed)


def _resolve(step: Step, repo: RepoView, root: str) -> tuple[str, ...]:
    for alternative in step.prefer:
        if all(cond.holds(repo, root) for cond in alternative.when):
            return alternative.argv
    return step.argv


def _with_python(argv: tuple[str, ...], python: str) -> tuple[str, ...]:
    return tuple(python if arg == PYTHON else arg for arg in argv)


def plan(detections: Sequence[Detection], repo: RepoView, *, changed_paths: Sequence[str] | None = None,
         python: str = 'python3') -> GatePlan:
    """The ordered checks for the detected packs.

    ``changed_paths`` limits the checks to the roots the change touches (a round's first pass); ``None`` checks
    every root. A repository a pack covers that has ``OWN_GATE_FILE`` runs that instead of every pack step but the
    dependency steps (``setup``), which run first so the own gate finds its dependencies offline.
    Steps shared by two packs (the TypeScript half of rust-ts and python-ts) run once per root. ``python`` is
    the sandbox's interpreter, put where a manifest says ``{python}``.
    """
    empty = GatePlan(
        checks=(), packs=tuple(d.pack.id for d in detections),
        needs=Needs(
            tools=tuple({tool.name: Tool(tool.name, _with_python(tool.version_argv, python))
                         for d in detections for tool in d.pack.needs.tools}.values()),
            network=tuple(sorted({host for d in detections for host in d.pack.needs.network})),
            image={name: version for d in detections for name, version in d.pack.needs.image.items()}))
    own_gate = bool(detections) and OWN_GATE_FILE in repo.files
    if own_gate:
        changed_paths = None   # the own gate checks the whole repository, so every root's dependencies come first
    all_roots = frozenset(root for d in detections for roots in d.roots.values() for root in roots)
    checks: dict[str, PlannedCheck] = {}
    skipped: dict[str, str] = {}
    for detection in detections:
        for step in detection.pack.steps:
            for root in detection.roots.get(step.language, ()):
                key = f'{step.id}@{root or "."}'
                if key in checks or key in skipped:
                    continue
                planned = _plan_step(detection.pack, step, repo, root, python, key)
                if isinstance(planned, str):
                    skipped[key] = planned
                elif _affected(root, all_roots, changed_paths):
                    checks[key] = planned
                else:
                    skipped[key] = 'not touched by the change'
    ordered = sorted(checks.values(), key=lambda c: KIND_ORDER.index(c.kind))
    if own_gate:
        # The repository's own gate replaces every pack step but the dependency step: it runs offline after it.
        own = PlannedCheck(key=f'own:{OWN_GATE_FILE}', pack_id=detections[0].pack.id, step_id='own', kind='test',
                           name=f"the repository's own gate ({OWN_GATE_FILE})", language='repo', root='',
                           argv=OWN_GATE_ARGV, timeout_s=OWN_GATE_TIMEOUT_S)
        setup = tuple(c for c in ordered if c.kind == 'setup')
        return dataclasses.replace(empty, checks=(*setup, own), own_gate=True)
    return dataclasses.replace(empty, checks=tuple(ordered), skipped=tuple(skipped.items()))


def _plan_step(pack: Pack, step: Step, repo: RepoView, root: str, python: str, key: str) -> PlannedCheck | str:
    """The step's check for ``root``, or why it does not apply there."""
    if step.when_any and not any(cond.holds(repo, root) for cond in step.when_any):
        return 'the repository does not use this tool'
    argv = _resolve(step, repo, root)
    if not argv:
        return 'the repository has no script for it'
    return PlannedCheck(key=key, pack_id=pack.id, step_id=step.id, name=step.name, kind=step.kind,
                        language=step.language, root=root, argv=_with_python(argv, python),
                        timeout_s=step.timeout_s, empty_exit_codes=step.empty_exit_codes,
                        expect_output=step.expect_output)
