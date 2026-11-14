"""scripts/mutmut_run.py: the lines `mutate-python.sh --patch` / `--lines` mutate, and the module's import names."""
from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / 'scripts' / 'mutmut_run.py'


@pytest.fixture(scope='module')
def driver() -> ModuleType:
    spec = importlib.util.spec_from_file_location('mutmut_run', SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# `git diff --unified=0 <range> -- lambda/shared/llm_json.py`, run from voc-datalake/: git still prints the
# repo-root path. mutmut 2 matched that path against its own, never matched, and mutated nothing.
REPO_ROOT_PATH_DIFF = """diff --git a/voc-datalake/lambda/shared/llm_json.py b/voc-datalake/lambda/shared/llm_json.py
index 1111111..2222222 100644
--- a/voc-datalake/lambda/shared/llm_json.py
+++ b/voc-datalake/lambda/shared/llm_json.py
@@ -32,0 +33,12 @@ def first_json_object(text: str) -> str | None:
+def json_object_or_none(text: str) -> dict | None:
"""


def test_a_diff_with_repo_root_paths_still_scopes_its_added_lines(driver: ModuleType) -> None:
    assert driver.spans_from_diff(REPO_ROOT_PATH_DIFF) == '33-44'


@pytest.mark.parametrize(('hunks', 'expected'), [
    (['@@ -10 +10 @@'], '10-10'),                       # one changed line: no count means 1
    (['@@ -3,2 +3,3 @@', '@@ -20,0 +22,2 @@'], '3-5,22-23'),
    (['@@ -7,4 +6,0 @@'], ''),                            # a pure deletion mutates nothing
    ([], ''),
])
def test_spans_from_diff_takes_every_hunks_new_side(driver: ModuleType, hunks: list[str], expected: str) -> None:
    diff = ''.join(f'{header} context\n-old\n+new\n' for header in hunks)
    assert driver.spans_from_diff(diff) == expected


def test_parse_line_spans_expands_the_spans(driver: ModuleType) -> None:
    assert driver.parse_line_spans('3-5,9-9') == {3, 4, 5, 9}


@pytest.mark.parametrize('spec', ['5-3', '0-2', 'x-1', '4'])
def test_parse_line_spans_refuses_a_malformed_or_reversed_span(driver: ModuleType, spec: str) -> None:
    with pytest.raises(ValueError, match=r'not a line span|invalid literal'):
        driver.parse_line_spans(spec)


def test_import_names_lists_every_name_the_file_was_loaded_under_longest_first(
    driver: ModuleType, tmp_path: Path,
) -> None:
    module = tmp_path / 'llm_json.py'
    module.write_text('', encoding='utf-8')
    modules = {
        'llm_json': SimpleNamespace(__file__=str(module)),
        'shared.llm_json': SimpleNamespace(__file__=str(module)),
        'shared.other': SimpleNamespace(__file__=str(tmp_path / 'other.py')),
        'builtins_like': SimpleNamespace(),
    }
    assert driver.import_names(str(module), modules) == ['shared.llm_json', 'llm_json']


def test_the_recorder_keeps_names_a_module_no_longer_has_at_the_end(driver: ModuleType, tmp_path: Path) -> None:
    module = tmp_path / 'exporter.py'
    module.write_text('', encoding='utf-8')
    recorder = driver.ImportNameRecorder(str(module))
    recorder.record({'exporter': SimpleNamespace(__file__=str(module))})
    recorder.record({'project_bundle.exporter': SimpleNamespace(__file__=str(module))})
    recorder.record({'exporter': SimpleNamespace(__file__=str(module))})
    assert recorder.names({'other': SimpleNamespace(__file__=str(tmp_path / 'other.py'))}) == [
        'project_bundle.exporter', 'exporter',
    ]
    assert recorder.names({'z.exporter': SimpleNamespace(__file__=str(module))}) == [
        'project_bundle.exporter', 'z.exporter', 'exporter',
    ]


def test_the_baseline_names_a_module_a_fixture_loads_and_drops_again(tmp_path: Path) -> None:
    """The project export's tests: a module fixture loads `project_bundle.exporter`, its teardown removes it."""
    package = tmp_path / 'scripts' / 'project_bundle'
    package.mkdir(parents=True)
    (package / '__init__.py').write_text('', encoding='utf-8')
    (package / 'exporter.py').write_text('def f():\n    return 1\n', encoding='utf-8')
    (tmp_path / 'test_export.py').write_text(
        'import sys\n'
        'import pytest\n'
        f'sys.path.insert(0, {str(tmp_path / "scripts")!r})\n'
        '@pytest.fixture(scope="module")\n'
        'def ex():\n'
        '    import project_bundle.exporter\n'
        '    yield project_bundle.exporter\n'
        '    for name in [n for n in sys.modules if n.startswith("project_bundle")]:\n'
        '        sys.modules.pop(name)\n'
        'def test_f(ex):\n'
        '    assert ex.f() == 1\n',
        encoding='utf-8',
    )
    names = tmp_path / 'names.txt'
    result = subprocess.run(  # noqa: S603 (this interpreter, a fixed program)
        [sys.executable, str(SCRIPT), 'baseline', str(names), 'scripts/project_bundle/exporter.py', 'test_export.py'],
        cwd=tmp_path, capture_output=True, text=True, timeout=120, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert names.read_text(encoding='utf-8') == 'project_bundle.exporter\n'
