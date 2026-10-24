"""The deployed shape of every Python Lambda, without Docker: templates + replayed bundling commands.

WHY a synth of our own rather than ``voc-datalake/cdk.out``: ``cdk.out`` exists only after a real
``cdk synth`` with Docker bundling, is usually stale against the working tree, and is absent on a fresh
worktree. This module runs ``bin/voc-datalake.ts`` exactly the way ``lib/test-support/synth-app.ts``
does (same fixed account/region, ``cdk.json`` + ``cdk.context.json`` context, Docker bundling skipped,
frontend freshness check off; pinned by ``test_py_assembly.py``), in ~7 s and offline. Skipping bundling
leaves the SOURCE directory in the assembly, so ``py_capture_bundling.cjs`` (a ``node -r`` preload)
records each asset's bundling command, and :func:`emulate_bundle` replays its ``mkdir``/``cp``/``if``/
``find -prune`` steps over the source tree. The result is, per function, the exact file set that ships
(bundle-relative path -> source file), which is what import resolution must run against: each Lambda
has its own ``sys.path`` root, and ``api/projects.py`` is ``projects`` in one bundle and ``api.projects``
in another.

A second synth with every context-gated feature switched on (verification fixture provider, model pin,
inbound email, Bedrock model access) adds the functions the default deploy does not create; their
function ids are marked ``context_only``. Results are cached in ``.cache/audit/py-assembly-<dir hash>.json``, keyed
by the CDK sources (``bin/``, ``lib/`` minus tests, ``cdk*.json``, plugin manifests, this module).
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import shlex
import subprocess
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

from audit_common import CDK_DIR, REPO, AuditError

CACHE_DIR = REPO / '.cache' / 'audit'
CAPTURE = Path(__file__).resolve().parent / 'py_capture_bundling.cjs'
SYNTH_ACCOUNT = '111111111111'
SYNTH_REGION = 'us-east-1'
GATED_PREFIX = 'b'  # a one-letter prefix: plugin rule names hit the 64-char limit otherwise
# Context that switches on every optional Lambda (each key is a `tryGetContext` in bin/ or lib/).
GATED_CONTEXT: dict[str, object] = {
    'deploymentPrefix': GATED_PREFIX,
    'enableVerificationFixtureProvider': True,
    'defaultModelId': 'global.anthropic.claude-sonnet-5-5',
    'inboundEmailDomain': 'voc.example.com',
    'inferenceScope': 'eu',          # BEDROCK_INFERENCE_SCOPE / AVATARS_ENABLED on every Lambda
    'enableWebSearch': False,        # the one default-ON feature: its env must look optional too
    'anthropicUseCase': {
        'companyName': 'Example Air', 'companyWebsite': 'https://example.com', 'intendedUsers': '0',
        'industryOption': 'Technology', 'useCases': 'Audit synth.', 'otherIndustryOption': '',
    },
}


@dataclass
class Function:
    """One ``AWS::Lambda::Function`` of the synthesized app."""

    fid: str                      # "<stack>/<logicalId>", stack without the deployment prefix
    runtime: str
    handler: str
    env: dict[str, object]        # raw template values (str or an intrinsic)
    role: str | None              # "<stack>/<logicalId>" of its execution role
    asset_source: str | None = None   # bundling source dir, relative to voc-datalake ('' = the dir itself)
    asset_command: list[str] | None = None  # None: staged by copying the source directory as-is
    inline: str | None = None
    external: bool = False        # CDK's own handler (asset outside the repo): never analysed
    context_only: bool = False
    default_env: set[str] = field(default_factory=set)  # env names set by the DEFAULT synth
    gated_env: set[str] | None = None   # env names the GATED synth sets (None: absent there)

    def always_sets(self, name: str) -> bool:
        """Set in the default deploy AND with every optional feature flipped."""
        return name in self.default_env and (self.gated_env is None or name in self.gated_env)

    @property
    def is_python(self) -> bool:
        return self.runtime.startswith('python')

    @property
    def stack(self) -> str:
        return self.fid.split('/', 1)[0]


@dataclass
class Assembly:
    templates: dict[str, dict]            # stack -> template (default synth, gated-only resources merged)
    functions: dict[str, Function]
    _exports: dict[str, str] | None = field(default=None, repr=False)

    def resource(self, rid: str) -> dict:
        stack, logical = rid.split('/', 1)
        return self.templates.get(stack, {}).get('Resources', {}).get(logical, {})

    def exports(self) -> dict[str, str]:
        """Export name -> "<stack>/<logicalId>" of the resource its value names (computed once)."""
        if self._exports is not None:
            return self._exports
        found: dict[str, str] = {}
        for stack, template in self.templates.items():
            for output in template.get('Outputs', {}).values():
                name = output.get('Export', {}).get('Name')
                if isinstance(name, str):
                    for rid in refs(output.get('Value'), stack, {}):
                        found[name] = rid
        self._exports = found
        return found


def refs(value: object, stack: str, exports: dict[str, str]) -> Iterator[str]:
    """Every "<stack>/<logicalId>" an intrinsic value points at (Ref, GetAtt, ImportValue, nested)."""
    if isinstance(value, dict):
        if 'Ref' in value and isinstance(value['Ref'], str) and not value['Ref'].startswith('AWS::'):
            yield f'{stack}/{value["Ref"]}'
            return
        att = value.get('Fn::GetAtt')
        if isinstance(att, list) and att and isinstance(att[0], str):
            yield f'{stack}/{att[0]}'
            return
        imported = value.get('Fn::ImportValue')
        if isinstance(imported, str) and imported in exports:
            yield exports[imported]
            return
        for inner in value.values():
            yield from refs(inner, stack, exports)
    elif isinstance(value, list):
        for inner in value:
            yield from refs(inner, stack, exports)


def literal_strings(value: object) -> Iterator[str]:
    """Every plain string inside an intrinsic (``Fn::Join`` parts, ``Fn::Sub`` templates)."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for inner in value.values():
            yield from literal_strings(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from literal_strings(inner)


# --- synth ------------------------------------------------------------------------------------

def _base_context(cdk_dir: Path) -> dict[str, object]:
    """Mirror of synth-app.ts ``baseContext()``: cdk.json context + cdk.context.json, no bundling."""
    cdk_json = json.loads((cdk_dir / 'cdk.json').read_text(encoding='utf-8')).get('context', {})
    committed_path = cdk_dir / 'cdk.context.json'
    committed = json.loads(committed_path.read_text(encoding='utf-8')) if committed_path.exists() else {}
    return {**cdk_json, **committed, 'aws:cdk:bundling-stacks': [], 'skipFrontendBuildCheck': True}


def _synth(cdk_dir: Path, extra: dict[str, object]) -> tuple[dict[str, dict], list[dict]]:
    with tempfile.TemporaryDirectory(prefix='voc-audit-synth-') as outdir:
        capture_out = Path(outdir) / 'bundling.json'
        env = {**os.environ, 'TS_NODE_PREFER_TS_EXTS': 'true', 'CDK_OUTDIR': outdir,
               'CDK_DEFAULT_ACCOUNT': SYNTH_ACCOUNT, 'CDK_DEFAULT_REGION': SYNTH_REGION,
               'CDK_CONTEXT_JSON': json.dumps({**_base_context(cdk_dir), **extra}),
               'VOC_AUDIT_BUNDLING_OUT': str(capture_out)}
        command = ['node', '-r', str(CAPTURE), '-r', 'ts-node/register', 'bin/voc-datalake.ts']
        done = subprocess.run(command, cwd=cdk_dir, env=env, capture_output=True, text=True, check=False)  # noqa: S603
        if done.returncode != 0:
            raise AuditError(f'cdk synth failed ({done.returncode}):\n{done.stdout[-2000:]}\n{done.stderr[-2000:]}')
        templates = {p.name.removesuffix('.template.json'): json.loads(p.read_text(encoding='utf-8'))
                     for p in Path(outdir).glob('*.template.json')}
        records = json.loads(capture_out.read_text(encoding='utf-8')) if capture_out.exists() else []
    return templates, records


def _functions(templates: dict[str, dict], records: list[dict], cdk_dir: Path, prefix: str = '') -> dict[str, Function]:
    by_hash = {r['assetHash']: r for r in records}
    found: dict[str, Function] = {}
    for stack_id, template in templates.items():
        stack = stack_id.removeprefix(f'{prefix}-') if prefix else stack_id
        for logical, resource in template.get('Resources', {}).items():
            if resource.get('Type') != 'AWS::Lambda::Function':
                continue
            props = resource.get('Properties', {})
            code = props.get('Code', {})
            role = next(refs(props.get('Role'), stack, {}), None)
            fn = Function(fid=f'{stack}/{logical}', runtime=str(props.get('Runtime', '')),
                          handler=str(props.get('Handler', '')),
                          env=dict(props.get('Environment', {}).get('Variables', {})), role=role)
            key = code.get('S3Key')
            record = by_hash.get(key.split('.')[0]) if isinstance(key, str) else None
            if record:
                source = Path(record['sourcePath'])
                # CDK's own handlers (BucketDeployment, AwsCustomResource, ...) are staged from
                # voc-datalake/node_modules: inside the CDK dir, but not repo code to judge.
                if source.is_relative_to(cdk_dir) and 'node_modules' not in source.relative_to(cdk_dir).parts:
                    fn.asset_source = source.relative_to(cdk_dir).as_posix() if source != cdk_dir else ''
                    fn.asset_command = record['command']
                else:
                    fn.external = True
            elif 'S3Key' in code:
                fn.external = True
            if 'ZipFile' in code:   # a plain string, or an Fn::Join around a rendered value
                fn.inline = ''.join(literal_strings(code['ZipFile'])) if not isinstance(code['ZipFile'], str) \
                    else code['ZipFile']
            found[fn.fid] = fn
    return found


def _strip_prefix(templates: dict[str, dict], prefix: str) -> dict[str, dict]:
    return {k.removeprefix(f'{prefix}-'): v for k, v in templates.items()}


def cache_key(cdk_dir: Path) -> str:
    digest = hashlib.sha256()
    # package-lock.json: an aws-cdk-lib upgrade changes the functions CDK itself adds, so it must refresh the cache.
    paths = [cdk_dir / 'cdk.json', cdk_dir / 'cdk.context.json', cdk_dir / 'package-lock.json', Path(__file__), CAPTURE]
    for sub in ('bin', 'lib'):
        paths += [p for p in (cdk_dir / sub).rglob('*.ts') if not p.name.endswith('.test.ts')]
    paths += list((cdk_dir / 'plugins').glob('*/manifest.json'))
    for path in sorted(paths):
        if path.exists():
            digest.update(str(path.relative_to(cdk_dir) if path.is_relative_to(cdk_dir) else path.name).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def load_assembly(cdk_dir: Path = CDK_DIR, *, refresh: bool = False, cache_dir: Path = CACHE_DIR) -> Assembly:
    key = cache_key(cdk_dir)
    cache_file = cache_dir / f'py-assembly-{hashlib.sha256(str(cdk_dir).encode()).hexdigest()[:12]}.json'
    if not refresh and cache_file.exists():
        cached = json.loads(cache_file.read_text(encoding='utf-8'))
        if cached.get('key') == key and cached.get('cdk_dir') == str(cdk_dir):
            return _decode(cached)
    templates, records = _synth(cdk_dir, {})
    functions = _functions(templates, records, cdk_dir)
    gated_templates, gated_records = _synth(cdk_dir, GATED_CONTEXT)
    gated = _functions(gated_templates, gated_records, cdk_dir, GATED_PREFIX)
    for fn in functions.values():
        fn.default_env = set(fn.env)
    for fid, fn in gated.items():
        if fid in functions:
            functions[fid].gated_env = set(fn.env)
            for name, value in fn.env.items():   # vars only a gated feature sets
                functions[fid].env.setdefault(name, value)
        else:
            fn.context_only = True
            functions[fid] = fn
    for stack, template in _strip_prefix(gated_templates, GATED_PREFIX).items():
        merged = templates.setdefault(stack, {'Resources': {}, 'Outputs': {}})
        for section in ('Resources', 'Outputs'):
            for logical, body in template.get(section, {}).items():
                merged.setdefault(section, {}).setdefault(logical, body)
    assembly = Assembly(templates, functions)
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(_encode(assembly, key, cdk_dir)), encoding='utf-8')
    return assembly


def _encode(assembly: Assembly, key: str, cdk_dir: Path) -> dict:
    fns = [{**fn.__dict__, 'default_env': sorted(fn.default_env),
            'gated_env': None if fn.gated_env is None else sorted(fn.gated_env)} for fn in assembly.functions.values()]
    return {'key': key, 'cdk_dir': str(cdk_dir), 'templates': assembly.templates, 'functions': fns}


def _decode(cached: dict) -> Assembly:
    functions = {}
    for raw in cached['functions']:
        gated = raw['gated_env']
        fn = Function(**{**raw, 'default_env': set(raw['default_env']), 'gated_env': None if gated is None else set(gated)})
        functions[fn.fid] = fn
    return Assembly(cached['templates'], functions)


# --- bundle emulation -------------------------------------------------------------------------

_IF = re.compile(r'^if \[ -([fd]) (\S+) \]; then (.+); fi$')
# What a copy-staged asset's `exclude` drops in this repo (core-stack.ts: ['test', '__pycache__']).
COPY_STAGING_PRUNE = "find /asset-output -type d -name 'test' -name 'tests' -name '__pycache__'"
IGNORED_STEPS = re.compile(r'^(mkdir -p \S+|cd \S+)$')


class Bundle:
    """The virtual ``/asset-output`` of one bundling command: bundle-relative path -> source file."""

    def __init__(self, source_root: Path) -> None:
        self.input = source_root
        self.files: dict[str, Path] = {}
        self.dirs: set[str] = {''}
        self.unknown: list[str] = []

    def _src(self, token: str) -> Path | None:
        if not token.startswith('/asset-input'):
            return None
        return self.input / token.removeprefix('/asset-input').lstrip('/')

    @staticmethod
    def _out(token: str) -> str | None:
        if not token.startswith('/asset-output'):
            return None
        return token.removeprefix('/asset-output').strip('/')

    def _expand(self, token: str) -> list[Path]:
        src = self._src(token)
        if src is None:
            return []
        if '*' not in src.name:
            return [src] if src.exists() else []
        return sorted(p for p in src.parent.iterdir() if fnmatch.fnmatch(p.name, src.name)) if src.parent.is_dir() else []

    def _copy(self, src: Path, target: str) -> None:
        if src.is_dir():
            self.dirs.add(target)
            for path in src.rglob('*'):
                rel = f'{target}/{path.relative_to(src).as_posix()}'.strip('/')
                if path.is_dir():
                    self.dirs.add(rel)
                else:
                    self.files[rel] = path
        else:
            self.files[target] = src

    def cp(self, args: list[str]) -> None:
        operands = [a for a in args if not a.startswith('-')]
        *sources, dest_token = operands
        dest = self._out(dest_token)
        if dest is None:
            self.unknown.append('cp ' + ' '.join(args))
            return
        into_dir = dest_token.endswith('/') or dest in self.dirs or len(sources) > 1 or '*' in ''.join(sources)
        for token in sources:
            for src in self._expand(token):
                self._copy(src, f'{dest}/{src.name}'.strip('/') if into_dir else dest)

    def prune(self, step: str) -> None:
        names = re.findall(r"-name '([^']+)'", step)
        if '-type d' in step:
            self.files = {r: p for r, p in self.files.items()
                          if not any(fnmatch.fnmatch(part, n) for part in r.split('/')[:-1] for n in names)}
        else:
            self.files = {r: p for r, p in self.files.items()
                          if not any(fnmatch.fnmatch(r.rsplit('/', 1)[-1], n) for n in names)}

    def run(self, step: str) -> None:
        step = step.strip()
        cond = _IF.match(step)
        if cond:
            src = self._src(cond.group(2))
            exists = src is not None and (src.is_file() if cond.group(1) == 'f' else src.is_dir())
            if exists:
                self.run(cond.group(3))
            return
        if step.startswith('mkdir -p '):
            out = self._out(step.split()[-1])
            if out is not None:
                self.dirs.add(out)
            return
        if step.startswith('find /asset-output'):
            self.prune(step)
            return
        words = shlex.split(step)
        if words and words[0] == 'cp':
            self.cp(words[1:])
        elif not IGNORED_STEPS.match(step):
            self.unknown.append(step)


def emulate_bundle(cdk_dir: Path, fn: Function) -> Bundle:
    """Replay ``fn``'s bundling command over the source tree."""
    if fn.asset_source is None:
        raise AuditError(f'{fn.fid}: no bundling record for its asset')
    bundle = Bundle(cdk_dir / fn.asset_source)
    command = fn.asset_command
    if command is None:   # copied as-is: the whole directory, minus what never ships
        bundle.cp(['-r', '/asset-input/*', '/asset-output/'])
        bundle.prune(COPY_STAGING_PRUNE)
        return bundle
    script = command[-1] if len(command) >= 3 and command[:2] == ['bash', '-c'] else ' '.join(command)
    for step in re.split(r'\s+&&\s+', script):
        bundle.run(step)
    if fn.is_python and bundle.unknown:
        raise AuditError(f'{fn.fid}: bundling steps the emulator does not understand: {bundle.unknown}')
    return bundle


def python_modules(bundle: Bundle) -> dict[str, Path]:
    """Importable module name -> source file, for the ``.py`` files the bundle ships."""
    modules: dict[str, Path] = {}
    for rel, src in bundle.files.items():
        if not rel.endswith('.py'):
            continue
        name = rel[:-3].replace('/', '.')
        modules[name.removesuffix('.__init__') if name.endswith('.__init__') else name] = src
    return modules


def inline_source(cdk_dir: Path, fn: Function, candidates: list[Path]) -> Path | None:
    """The repo file an inline (``ZipFile``) handler was read from, matched by content."""
    if fn.inline is None:
        return None
    wanted = fn.inline.strip()
    for rel in candidates:
        if (cdk_dir / rel).read_text(encoding='utf-8').strip() == wanted:
            return rel
    return None
