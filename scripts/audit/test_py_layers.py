"""py_layers finds planted unused, narrow, shadowing, mismatched and missing layer libraries in a temp tree.

Every planted case has a look-alike next to it that must NOT be reported (a lazy import in a live function, a
library reached only through another library's unguarded import, a parser loaded by name, a TYPE_CHECKING or
ImportError-guarded import, a stripped runtime package).
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from audit_common import CDK_DIR, AuditError
from layer_dists import RUNTIME_PROVIDED, DistIndex, Requirement
from py_assembly import Assembly, LayerAsset
from py_layers import main, run_scan, strip_entries
from py_reachability import analyse

from conftest import TreeMaker, lambda_function

STRIP = 'rm -rf /asset-output/python/jmespath /asset-output/python/jmespath-* && find /asset-output/python -name x'
LAYER_CMD = ['bash', '-c', f'pip install -r requirements.txt -t /asset-output/python && {STRIP}']
REQUIREMENTS = '\n'.join([
    '# planted layer', 'liba>=1.0', 'libsoft', 'libguarded', 'bigone', 'unusedlib', 'urllib3', 'jmespath', 'needsold', 'strparser',
    'pinned==1.0', 'absent-lib==2.0', 'winonly; sys_platform == "win32"', '',
])
HANDLER_A = '''
from typing import TYPE_CHECKING
import liba
if TYPE_CHECKING:
    import typing_only
try:
    import maybe_there
except ImportError:
    maybe_there = None

def lambda_handler(event, context):
    import bigone                     # lazy, in a live function: reached
    import not_installed_anywhere     # live, provided by nothing: missing
    return liba.go(parse(event, 'strparser'), bigone)

def parse(text, parser):
    return text, parser

def never_called():
    import unusedlib                  # a dead function: not a use
'''
HANDLER_B = 'import liba\n\ndef lambda_handler(event, context):\n    return liba.go(event)\n'
HANDLER_C = 'import pinned\n\ndef lambda_handler(event, context):\n    return pinned, liba_free()\n\ndef liba_free():\n    return 1\n'


def _dist(site: Path, name: str, version: str, files: dict[str, tuple[str, int]], requires: tuple[str, ...] = ()) -> None:
    info = site / f'{name.replace("-", "_")}-{version}.dist-info'
    info.mkdir(parents=True)
    meta = ['Metadata-Version: 2.1', f'Name: {name}', f'Version: {version}', *(f'Requires-Dist: {r}' for r in requires)]
    (info / 'METADATA').write_text('\n'.join(meta) + '\n', encoding='utf-8')
    for rel, (text, _) in files.items():
        (site / rel).parent.mkdir(parents=True, exist_ok=True)
        (site / rel).write_text(text, encoding='utf-8')
    record = [f'{rel},,{size}' for rel, (_, size) in files.items()] + [f'{info.name}/METADATA,,']
    (info / 'RECORD').write_text('\n'.join(record) + '\n', encoding='utf-8')


def _site(root: Path) -> DistIndex:
    site = root / 'site'
    _dist(site, 'liba', '1.2', {'liba/__init__.py': (
        'import libsoft\ntry:\n    import libguarded\nexcept ImportError:\n    libguarded = None\n', 1000)},
        ('libdep>=1', 'extra-only; extra == "fancy"'))
    _dist(site, 'libdep', '1.0', {'libdep.py': ('', 10)})
    _dist(site, 'libsoft', '1.0', {'libsoft/__init__.py': ('', 10)})
    _dist(site, 'libguarded', '1.0', {'libguarded/__init__.py': ('', 10)})
    _dist(site, 'extra-only', '1.0', {'extra_only.py': ('', 10)})
    _dist(site, 'bigone', '3.0', {'bigone/__init__.py': ('', 3_000_000), '_bigone_native.cpython-312-darwin.so': ('', 10)})
    _dist(site, 'unusedlib', '1.0', {'unusedlib/__init__.py': ('', 10)})
    _dist(site, 'urllib3', '2.8.0', {'urllib3/__init__.py': ('', 10)})
    _dist(site, 'jmespath', '1.1.0', {'jmespath/__init__.py': ('', 10), 'bin/jp.py': ('', 10)})
    _dist(site, 'needsold', '1.0', {'needsold/__init__.py': ('', 10)}, ('jmespath<1',))
    _dist(site, 'strparser', '1.0', {'strparser/__init__.py': ('', 10)})
    _dist(site, 'pinned', '2.0', {'pinned/__init__.py': ('', 10)})
    _dist(site, 'winonly', '1.0', {'winonly/__init__.py': ('', 10)})
    return DistIndex.from_paths([site])


def _fn_resource(*layers: str) -> dict:
    return {'Type': 'AWS::Lambda::Function', 'Properties': {'Layers': [{'Ref': lid} for lid in layers]}}


@pytest.fixture
def scan(make_tree: TreeMaker):
    root = make_tree({'lambda/api/a_handler.py': HANDLER_A, 'lambda/api/b_handler.py': HANDLER_B,
                      'lambda/api/c_handler.py': HANDLER_C, 'lambda/layers/deps/requirements.txt': REQUIREMENTS,
                      'lambda/layers/other/requirements.txt': 'libdep\n'})
    functions = [lambda_function(f'Api/{n.upper()}', f'{n}_handler.lambda_handler',
                                 f'cp /asset-input/api/{n}_handler.py /asset-output/') for n in ('a', 'b', 'c')]
    functions.append(lambda_function('Api/D', 'b_handler.lambda_handler', 'cp /asset-input/api/b_handler.py /asset-output/'))
    templates = {'Api': {'Resources': {
        'Deps': {'Type': 'AWS::Lambda::LayerVersion', 'Properties': {}},
        'Other': {'Type': 'AWS::Lambda::LayerVersion', 'Properties': {}},
        'A': _fn_resource('Deps'), 'B': _fn_resource('Deps'), 'C': _fn_resource('Deps'), 'D': _fn_resource('Deps', 'Other'),
    }}}
    layers = {'Api/Deps': LayerAsset('Api/Deps', 'lambda/layers/deps', LAYER_CMD),
              'Api/Other': LayerAsset('Api/Other', 'lambda/layers/other', LAYER_CMD),
              'Api/Cli': LayerAsset('Api/Cli', external=True)}
    assembly = Assembly(templates, {fn.fid: fn for fn in functions}, layers)
    return run_scan(assembly, analyse(root, assembly).functions, _site(root), root)


def _keys(scan, kind: str) -> list[str]:
    return sorted(f.key for f in scan.findings if f.kind == kind)


class TestPlantedLayer:
    def test_a_library_no_function_reaches_is_unused_and_reached_ones_are_not(self, scan) -> None:
        # unusedlib: only a dead function imports it; libguarded: only behind liba's ImportError guard;
        # needsold: required, never imported. libsoft (liba's unguarded import), libdep (liba's requirement)
        # and strparser (loaded by its name as a string) are reached.
        assert _keys(scan, 'unused-distribution') == [
            'Api/Deps::libguarded', 'Api/Deps::needsold', 'Api/Deps::unusedlib', 'Api/Deps::urllib3',
            'Api/Other::libdep']   # D reaches libdep through liba in Deps, never through Other

    def test_a_big_library_few_functions_reach_is_narrow(self, scan) -> None:
        assert _keys(scan, 'narrow-distribution') == ['Api/Deps::bigone']
        (finding,) = [f for f in scan.findings if f.kind == 'narrow-distribution']
        assert finding.extra['functions'] == ['Api/A']

    def test_an_unstripped_runtime_package_is_reported_and_a_stripped_one_is_not(self, scan) -> None:
        assert _keys(scan, 'runtime-provided') == ['Api/Deps::urllib3']
        assert 'jmespath' in scan.plans['Api/Deps'].stripped

    def test_a_requirement_the_runtime_version_breaks_is_a_conflict(self, scan) -> None:
        assert _keys(scan, 'runtime-conflict') == ['Api/Deps::needsold->jmespath']

    def test_a_pin_the_venv_does_not_satisfy_or_lacks_is_a_mismatch(self, scan) -> None:
        assert _keys(scan, 'version-mismatch') == ['Api/Deps::absent-lib', 'Api/Deps::pinned']

    def test_a_live_import_nothing_provides_is_missing_and_guarded_ones_are_not(self, scan) -> None:
        assert _keys(scan, 'missing-distribution') == ['Api/A::not_installed_anywhere']

    def test_a_layer_a_function_reaches_nothing_of_is_unused_there(self, scan) -> None:
        assert _keys(scan, 'unused-layer') == ['Api/D::Api/Other']

    def test_markers_extras_and_external_layers(self, scan) -> None:
        plan = scan.plans['Api/Deps']
        assert 'winonly' not in plan.installed          # a win32-only requirement on the Linux runtime
        assert 'extra-only' not in plan.installed       # an extra nobody requested
        assert 'Api/Cli' not in scan.plans              # CDK's own layer is never judged
        assert sorted(plan.functions) == ['Api/A', 'Api/B', 'Api/C', 'Api/D']


class TestPieces:
    def test_strip_entries_reads_only_the_python_dir_rm_steps(self) -> None:
        assert strip_entries(LAYER_CMD) == ['jmespath', 'jmespath-*']
        assert strip_entries(None) == []

    def test_requested_extras_are_followed(self) -> None:
        req = Requirement.parse('extra-only; extra == "fancy"')
        assert req.applies(['fancy'])
        assert not req.applies()

    def test_a_pip_option_in_a_requirements_file_is_refused(self, make_tree: TreeMaker) -> None:
        from layer_dists import read_requirements
        root = make_tree({'r.txt': '-r other.txt\n'})
        with pytest.raises(AuditError, match='pip option'):
            read_requirements(root / 'r.txt')


IMAGE = 'public.ecr.aws/lambda/python:3.14'
_PROBE = '''
import importlib.metadata as m, json
out = {}
for d in m.distributions():
    tops = sorted({f.parts[0].split('.')[0] for f in d.files or [] if not f.parts[0].endswith('.dist-info')
                   and f.parts[0] not in ('..', '__pycache__', 'bin')})
    out[d.metadata['Name'].lower().replace('_', '-')] = {'version': d.version, 'tops': tops}
print(json.dumps(out))
'''


def _image_dists() -> dict[str, dict]:
    docker = shutil.which('docker')
    if docker is None:
        pytest.skip('docker is not installed')
    if subprocess.run([docker, 'image', 'inspect', IMAGE], capture_output=True, check=False).returncode != 0:
        pytest.skip(f'{IMAGE} is not pulled')
    done = subprocess.run([docker, 'run', '--rm', '--entrypoint', 'python3', IMAGE, '-c', _PROBE],
                          capture_output=True, text=True, check=True)
    return json.loads(done.stdout)


def test_runtime_provided_matches_the_lambda_image() -> None:
    image = _image_dists()
    image.pop('pip', None)
    assert sorted(image) == sorted(RUNTIME_PROVIDED)
    for name, dist in RUNTIME_PROVIDED.items():
        assert set(dist.imports) <= set(image[name]['tops']), name


def test_the_real_tree_is_clean_and_not_vacuous() -> None:
    assert main(['--cdk-dir', str(CDK_DIR)]) == 0
