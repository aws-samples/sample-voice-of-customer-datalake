"""Static resolution of a registered test: it exists, the gate collects it (no skip, only or fixme), and its digest."""
from __future__ import annotations

import hashlib
from pathlib import Path

import planted
import pytest
from feature_gate import resolve

WIDGET_PY = 'voc-datalake/lambda/api/test/test_widget.py'


def entry_for(test_id: str) -> dict[str, str]:
    return resolve.entry_from_id(test_id)


def test_a_test_id_names_its_runner_and_fields():
    assert entry_for(planted.PYTEST_ID) == {'runner': 'pytest', 'node': planted.PYTEST_ID}
    assert entry_for(planted.VITEST_ID) == {
        'runner': 'vitest', 'suite': 'frontend', 'file': 'voc-datalake/frontend/src/widget.test.ts',
        'name': 'Widget > counts'}
    assert entry_for(planted.SPEC_ID) == {
        'runner': 'playwright', 'spec': 'voc-datalake/frontend/e2e/tests/widget.spec.ts',
        'title': 'Widget page > shows the count'}
    assert entry_for('voc-datalake/lib/stack.test.ts::Stack > synths')['suite'] == 'cdk'
    assert entry_for('voc-datalake/lambda/stream/src/a.test.ts::A > b')['suite'] == 'stream'
    for test_id in (planted.PYTEST_ID, planted.VITEST_ID, planted.SPEC_ID):
        assert resolve.test_id(entry_for(test_id)) == test_id


@pytest.mark.parametrize('bad', ['voc-datalake/x.py', 'README.md::x', 'voc-datalake/frontend/src/a.ts::A > b'])
def test_an_id_no_runner_owns_is_refused(bad: str):
    with pytest.raises(ValueError, match='no runner owns it'):
        resolve.entry_from_id(bad)


def found(repo: Path, test_id: str) -> resolve.Resolved:
    return resolve.resolve(repo, entry_for(test_id))


def only_problem(repo: Path, test_id: str) -> str:
    problems = found(repo, test_id).problems
    assert len(problems) == 1, problems
    return problems[0]


def digest_of(repo: Path, *paths: str) -> str:
    h = hashlib.sha256()
    for rel in paths:
        h.update(rel.encode() + b'\0' + (repo / rel).read_bytes() + b'\0')
    return h.hexdigest()


def test_a_pytest_method_resolves_and_its_digest_covers_its_file_and_conftest_chain(repo: Path):
    got = found(repo, planted.PYTEST_ID)
    assert got.problems == []
    assert got.segment == '    def test_counts(self):\n        assert 1 + 1 == 2'
    chain = [WIDGET_PY, 'voc-datalake/lambda/conftest.py', 'voc-datalake/pytest.ini']
    assert got.files == chain
    assert got.digest == digest_of(repo, *chain)


def test_the_digest_moves_with_a_conftest_and_with_another_test_in_the_file(repo: Path):
    before = found(repo, planted.PYTEST_ID).digest
    planted.write(repo, 'voc-datalake/lambda/conftest.py', 'import pytest\n\n\n@pytest.fixture\ndef x():\n    return 1\n')
    after_conftest = found(repo, planted.PYTEST_ID).digest
    assert after_conftest != before
    path = repo / WIDGET_PY
    path.write_text(path.read_text().replace('[1][0] == 1', '[2][0] == 2'))
    assert found(repo, planted.PYTEST_ID).digest != after_conftest


def test_a_js_digest_is_its_file(repo: Path):
    got = found(repo, planted.VITEST_ID)
    assert got.files == ['voc-datalake/frontend/src/widget.test.ts']
    assert got.digest == digest_of(repo, 'voc-datalake/frontend/src/widget.test.ts')
    assert got.segment.startswith("it('counts', () => {")
    assert got.segment.endswith('})')


def test_a_module_level_and_a_parametrized_pytest_function_resolve(repo: Path):
    assert found(repo, f'{WIDGET_PY}::test_module_level').problems == []
    assert found(repo, f'{WIDGET_PY}::test_module_level[a-1]').problems == []


@pytest.mark.parametrize(('test_id', 'message'), [
    (f'{WIDGET_PY}::TestWidget::test_skipped', "test_skipped is marked skip: the gate does not run it"),
    (f'{WIDGET_PY}::TestWidget::test_gone', f'no test TestWidget::test_gone in {WIDGET_PY}'),
    ('voc-datalake/lambda/api/test/test_nope.py::test_x', 'no file voc-datalake/lambda/api/test/test_nope.py'),
    ('voc-datalake/frontend/src/widget.test.ts::Widget > later', "'Widget > later' is marked .skip: the gate does not run it"),
    ('voc-datalake/frontend/e2e/tests/widget.spec.ts::Widget page > draws the chart',
     "'Widget page > draws the chart' is marked .fixme: the gate does not run it"),
    ('voc-datalake/frontend/e2e/tests/widget.spec.ts::Widget page > needs a deployment',
     "'Widget page > needs a deployment' calls skip() unconditionally: the gate does not run it"),
])
def test_a_test_that_does_not_run_or_exist_is_refused(repo: Path, test_id: str, message: str):
    assert only_problem(repo, test_id) == message


@pytest.mark.parametrize('path', ['/etc/test_x.py', 'voc-datalake/lambda/../../test_x.py'])
def test_a_path_outside_the_tree_is_refused(repo: Path, path: str):
    assert only_problem(repo, f'{path}::test_x').startswith(f'{path}: a test path is relative to the repository')


@pytest.mark.parametrize('path', ['./voc-datalake/lambda/api/test/test_widget.py',
                                  'voc-datalake//lambda/api/test/test_widget.py',
                                  'voc-datalake/lambda/api/./test/test_widget.py',
                                  'voc-datalake/lambda/api/test/../test/test_widget.py'])
def test_a_path_not_in_canonical_form_is_refused(repo: Path, path: str):
    assert only_problem(repo, f'{path}::TestWidget::test_counts').startswith(
        f'{path}: a test path is relative to the repository root, in canonical form')


def test_a_test_file_reached_through_a_link_is_refused(repo: Path, tmp_path_factory: pytest.TempPathFactory):
    outside = tmp_path_factory.mktemp('outside') / 'test_widget.py'
    outside.write_text((repo / WIDGET_PY).read_text())
    (repo / WIDGET_PY).unlink()
    (repo / WIDGET_PY).symlink_to(outside)
    assert only_problem(repo, planted.PYTEST_ID).startswith(f'{WIDGET_PY}: a test path is relative to the repository root')


def test_an_import_reached_through_a_link_is_refused(repo: Path, tmp_path_factory: pytest.TempPathFactory):
    outside = tmp_path_factory.mktemp('outside') / 'helpers.ts'
    outside.write_text('export const two = 2\n')
    (repo / 'voc-datalake/frontend/src/helpers.ts').symlink_to(outside)
    planted.write(repo, 'voc-datalake/frontend/src/widget.test.ts',
                  "import { two } from './helpers'\ndescribe('Widget', () => {\n  it('counts', () => {})\n})\n")
    assert only_problem(repo, planted.VITEST_ID) == (
        'voc-datalake/frontend/src/helpers.ts is a link: the gate never reads a test, a config or an import through one')


def test_the_same_test_named_two_ways_has_one_key():
    assert resolve.test_key(entry_for(f'{WIDGET_PY}::test_module_level[a-1]')) == (
        resolve.test_key(entry_for(f'{WIDGET_PY}::test_module_level')))
    assert resolve.test_key(entry_for(planted.VITEST_ID)) != resolve.test_key(entry_for(planted.PYTEST_ID))


def test_the_pytest_digest_covers_its_test_side_imports_not_product_code(repo: Path):
    planted.write(repo, 'voc-datalake/lambda/api/test/helpers.py', 'X = 1\n')
    plant_py(repo, WIDGET_PY, 'import os\nimport widget\nimport helpers\nfrom . import nothing_here\n\n\n'
                              'def test_x():\n    assert widget.count([]) == helpers.X - 1\n')
    got = found(repo, f'{WIDGET_PY}::test_x')
    assert got.files == [WIDGET_PY, 'voc-datalake/lambda/conftest.py', 'voc-datalake/pytest.ini',
                         'voc-datalake/lambda/api/test/helpers.py']
    before = got.digest
    # A product edit (what the test proves) leaves the acceptance standing; a test-side helper's edit voids it.
    planted.write(repo, 'voc-datalake/lambda/api/widget.py', 'def count(items):\n    return 0\n')
    assert found(repo, f'{WIDGET_PY}::test_x').digest == before
    planted.write(repo, 'voc-datalake/lambda/api/test/helpers.py', 'X = 2\n')
    assert found(repo, f'{WIDGET_PY}::test_x').digest != before


def test_a_relative_import_above_the_tree_is_a_problem_not_a_crash(repo: Path):
    plant_py(repo, WIDGET_PY, 'from ......... import far\n\n\ndef test_x():\n    assert 1\n')
    assert only_problem(repo, f'{WIDGET_PY}::test_x') == (
        f'{WIDGET_PY} line 1: a relative import above the repository (from ......... import)')


def test_the_vitest_digest_covers_the_setup_files_its_config_names(repo: Path):
    planted.write(repo, 'voc-datalake/frontend/vitest.config.ts',
                  "export default defineConfig({ test: { setupFiles: ['./src/test/setup.ts'], "
                  "globalSetup: './src/test/global.ts' } })\n")
    planted.write(repo, 'voc-datalake/frontend/src/test/setup.ts', 'x()\n')
    planted.write(repo, 'voc-datalake/frontend/src/test/global.ts', 'y()\n')
    assert found(repo, planted.VITEST_ID).files == [
        'voc-datalake/frontend/src/widget.test.ts', 'voc-datalake/frontend/vitest.config.ts',
        'voc-datalake/frontend/src/test/setup.ts', 'voc-datalake/frontend/src/test/global.ts']


@pytest.mark.parametrize(('source', 'message'), [
    ("describe('Widget', () => {\n  it('counts', { skip: true }, () => {})\n})\n",
     "'Widget > counts' is marked .skip: the gate does not run it"),
    ("describe('Widget', () => {\n  it('counts', { timeout: 5, todo: true }, () => {})\n})\n",
     "'Widget > counts' is marked .todo: the gate does not run it"),
    ("describe('Widget', () => {\n  it('counts', (ctx) => {\n    ctx.skip()\n  })\n})\n",
     "'Widget > counts' calls skip() unconditionally: the gate does not run it"),
    ("const later = describe.skip\nlater('Widget', () => {\n  it('counts', () => {})\n})\n",
     "'Widget > counts' is inside describe.skip 'Widget': the gate does not run it"),
])
def test_other_ways_of_skipping_a_vitest_test_are_seen(repo: Path, source: str, message: str):
    planted.write(repo, 'voc-datalake/frontend/src/widget.test.ts', source)
    assert only_problem(repo, planted.VITEST_ID) == message


def test_options_without_a_skip_do_not_skip(repo: Path):
    planted.write(repo, 'voc-datalake/frontend/src/widget.test.ts',
                  "describe('Widget', () => {\n  it('counts', { skip: false, retry: 2 }, () => {})\n})\n")
    assert found(repo, planted.VITEST_ID).problems == []


def plant_py(repo: Path, rel: str, text: str) -> str:
    planted.write(repo, rel, text)
    return rel


@pytest.mark.parametrize(('rel', 'message'), [
    ('voc-datalake/scripts/test/test_x.py', 'outside the pytest testpaths (lambda, plugins)'),
    ('voc-datalake/lambda/layers/test_x.py', 'under layers, which pytest does not collect'),
    ('voc-datalake/lambda/_template/test_x.py', 'under _template, which pytest does not collect'),
    ('scripts/test_x.py', 'outside voc-datalake/, the pytest rootdir'),
])
def test_a_pytest_file_pytest_does_not_collect_is_refused(repo: Path, rel: str, message: str):
    plant_py(repo, rel, 'def test_x():\n    assert 1\n')
    assert only_problem(repo, f'{rel}::test_x') == f'{rel} is {message}'


@pytest.mark.parametrize(('source', 'node', 'message'), [
    ('class Widgets:\n    def test_x(self):\n        assert 1\n', 'Widgets::test_x',
     'class Widgets is not collected (python_classes Test*)'),
    ('class TestW:\n    def __init__(self):\n        pass\n\n    def test_x(self):\n        assert 1\n', 'TestW::test_x',
     'class TestW has an __init__: pytest does not collect it'),
    ('def check_x():\n    assert 1\n', 'check_x', 'check_x is not a test function (python_functions test_*)'),
    ('def test_x():\n    assert 1\n\n\ndef test_x():\n    assert 2\n', 'test_x',
     'test_x is defined twice in the same scope (pytest keeps the last)'),
    ('class TestW:\n    def test_x(self):\n        assert 1\n\n    def test_x(self):\n        assert 2\n', 'TestW::test_x',
     'test_x is defined twice in the same scope (pytest keeps the last)'),
    ('import pytest\n\npytestmark: list = [pytest.mark.skip]\n\n\ndef test_x():\n    assert 1\n', 'test_x',
     'is marked skip at module level'),
    ('import pytest\n\nlater = pytest.mark.skipif(True, reason="x")\n\n\n@later\ndef test_x():\n    assert 1\n',
     'test_x', 'test_x is marked skipif: the gate does not run it'),
    ('import pytest\n\nlater = pytest.mark.xfail\npytestmark = later\n\n\ndef test_x():\n    assert 1\n',
     'test_x', 'is marked xfail at module level'),
    ('def test_x(:\n', 'test_x', 'cannot be parsed'),
])
def test_pytest_collection_rules(repo: Path, source: str, node: str, message: str):
    plant_py(repo, WIDGET_PY, source)
    assert message in only_problem(repo, f'{WIDGET_PY}::{node}')


TWICE = 'test_x is defined twice in the same scope (pytest keeps the last)'


@pytest.mark.parametrize('other', [
    'test_x = None\n',
    'from helpers import test_x\n',
    'import test_x\n',
    'if True:\n    def test_x():\n        assert 2\n',
    'try:\n    test_x = 1\nexcept ImportError:\n    pass\n',
    'with open(__file__) as test_x:\n    pass\n',
    'for test_x in ():\n    pass\n',
])
def test_any_other_binding_of_the_name_in_its_scope_counts(repo: Path, other: str):
    plant_py(repo, WIDGET_PY, f'def test_x():\n    assert 1\n\n\n{other}')
    assert only_problem(repo, f'{WIDGET_PY}::test_x') == TWICE


@pytest.mark.parametrize('test', ['False', '0', 'None', 'not True', "''"])
def test_a_test_bound_only_under_an_always_false_if_is_refused(repo: Path, test: str):
    plant_py(repo, WIDGET_PY, f'if {test}:\n    def test_x():\n        assert 1\n')
    assert only_problem(repo, f'{WIDGET_PY}::test_x') == (
        'test_x is bound only under an `if` that is always false: pytest never collects it')


@pytest.mark.parametrize('source', [
    'import sys\n\nif sys.version_info >= (3, 12):\n    def test_x():\n        assert 1\n',
    'if 0:\n    pass\nelse:\n    def test_x():\n        assert 1\n',
])
def test_a_test_defined_under_a_live_if_is_found(repo: Path, source: str):
    plant_py(repo, WIDGET_PY, source)
    assert found(repo, f'{WIDGET_PY}::test_x').problems == []


def test_a_binding_inside_a_function_does_not_count(repo: Path):
    plant_py(repo, WIDGET_PY, 'def helper():\n    test_x = 1\n    return test_x\n\n\ndef test_x():\n    assert 1\n')
    assert found(repo, f'{WIDGET_PY}::test_x').problems == []


@pytest.mark.parametrize(('source', 'node', 'message'), [
    ('__test__ = False\n\n\ndef test_x():\n    assert 1\n', 'test_x',
     f'{WIDGET_PY} sets __test__ = False: pytest does not collect it'),
    ('class TestW:\n    __test__ = False\n\n    def test_x(self):\n        assert 1\n', 'TestW::test_x',
     'TestW sets __test__ = False: pytest does not collect it'),
])
def test_test_false_is_refused(repo: Path, source: str, node: str, message: str):
    plant_py(repo, WIDGET_PY, source)
    assert only_problem(repo, f'{WIDGET_PY}::{node}') == message


def test_the_pytest_digest_covers_the_pytest_config(repo: Path):
    got = found(repo, planted.PYTEST_ID)
    assert got.files == [WIDGET_PY, 'voc-datalake/lambda/conftest.py', 'voc-datalake/pytest.ini']
    before = got.digest
    planted.write(repo, 'voc-datalake/pytest.ini', planted.PYTEST_INI + 'timeout = 5\n')
    assert found(repo, planted.PYTEST_ID).digest != before


def test_a_js_digest_covers_its_config_and_the_relative_imports_it_reaches(repo: Path):
    planted.write(repo, 'voc-datalake/frontend/vitest.config.ts', 'export default {}\n')
    planted.write(repo, 'voc-datalake/frontend/src/test/helpers.ts', 'export const two = 2\n')
    planted.write(repo, 'voc-datalake/frontend/src/lib/index.ts', "import { x } from '../far'\nexport const y = 1\n")
    planted.write(repo, 'voc-datalake/frontend/src/widget.test.ts',
                  "import { two } from './test/helpers'\nimport { y } from './lib'\nimport 'vitest'\n"
                  "describe('Widget', () => {\n  it('counts', () => {})\n})\n")
    got = found(repo, planted.VITEST_ID)
    # src/lib is product code: left out, so a product edit does not void the acceptance; the test helper counts.
    assert got.files == ['voc-datalake/frontend/src/widget.test.ts', 'voc-datalake/frontend/vitest.config.ts',
                         'voc-datalake/frontend/src/test/helpers.ts']
    before = got.digest
    planted.write(repo, 'voc-datalake/frontend/src/test/helpers.ts', 'export const two = 3\n')
    assert found(repo, planted.VITEST_ID).digest != before


def test_a_spec_digest_covers_the_playwright_config(repo: Path):
    planted.write(repo, 'voc-datalake/frontend/e2e/playwright.config.ts', 'export default {}\n')
    assert found(repo, planted.SPEC_ID).files == ['voc-datalake/frontend/e2e/tests/widget.spec.ts',
                                                  'voc-datalake/frontend/e2e/playwright.config.ts']


def test_a_file_level_skip_is_seen(repo: Path):
    planted.write(repo, 'voc-datalake/frontend/e2e/tests/widget.spec.ts', 'test.skip()\n' + spec_with('    x()'))
    assert only_problem(repo, planted.SPEC_ID) == (
        'voc-datalake/frontend/e2e/tests/widget.spec.ts skips every test at file level: the gate does not run it')
    planted.write(repo, 'voc-datalake/frontend/e2e/tests/widget.spec.ts',
                  "test.skip(process.env.X === '1', 'later')\n" + spec_with('    x()'))
    got = found(repo, planted.SPEC_ID)
    assert got.problems == []
    assert got.notes == ['voc-datalake/frontend/e2e/tests/widget.spec.ts has a file-level conditional skip']


@pytest.mark.parametrize(('source', 'message'), [
    ('import pytest\n\n\ndef test_x():\n    pytest.skip("later")\n    assert 1\n',
     'test_x calls pytest.skip() in its body unconditionally: the gate does not run it'),
    ('import pytest\n\nyaml = pytest.importorskip("yaml")\n\n\ndef test_x():\n    assert 1\n',
     f'{WIDGET_PY} calls pytest.importorskip at module level: it may skip every test'),
    ('import os\nimport pytest\n\nif os.environ.get("CI"):\n    pytestmark = pytest.mark.skip\n\n\ndef test_x():\n    assert 1\n',
     f'{WIDGET_PY} is marked skip at module level: the gate does not run it'),
    ('import pytest\n\npytestmark = []\npytestmark += [pytest.mark.xfail]\n\n\ndef test_x():\n    assert 1\n',
     f'{WIDGET_PY} is marked xfail at module level: the gate does not run it'),
    ('from pytest import mark as m\n\n\n@m.skip\ndef test_x():\n    assert 1\n',
     'test_x is marked skip: the gate does not run it'),
])
def test_more_ways_pytest_skips_are_seen(repo: Path, source: str, message: str):
    plant_py(repo, WIDGET_PY, source)
    assert only_problem(repo, f'{WIDGET_PY}::test_x') == message


def test_a_skip_under_a_condition_in_the_body_is_not_unconditional(repo: Path):
    plant_py(repo, WIDGET_PY, 'import pytest\n\n\ndef test_x():\n    if 0:\n        pytest.skip("x")\n    assert 1\n')
    assert found(repo, f'{WIDGET_PY}::test_x').problems == []


def test_a_deeply_nested_file_is_a_problem_not_a_crash(repo: Path):
    plant_py(repo, WIDGET_PY, 'x = ' + '(' * 300_000 + ')' * 300_000 + '\n\n\ndef test_x():\n    assert 1\n')
    assert 'cannot be parsed' in only_problem(repo, f'{WIDGET_PY}::test_x')


def test_a_module_skip_marker_skips_every_test(repo: Path):
    plant_py(repo, WIDGET_PY, 'import pytest\n\npytestmark = pytest.mark.skipif(True, reason="x")\n\n\ndef test_a():\n    assert 1\n')
    assert only_problem(repo, f'{WIDGET_PY}::test_a') == f'{WIDGET_PY} is marked skipif at module level: the gate does not run it'


def test_vitest_resolves_through_comments_regex_literals_and_each(repo: Path):
    assert found(repo, planted.VITEST_ID).problems == []
    assert found(repo, 'voc-datalake/frontend/src/widget.test.ts::Widget > adds %i').problems == []


def test_jsx_closing_slashes_are_no_regex(repo: Path):
    planted.write(repo, 'voc-datalake/frontend/src/widget.test.tsx',
                  "describe('Widget', () => {\n  it('draws', () => {\n    render(<Widget {...props} />)\n"
                  "    render(<p>a</p>)\n    render(<A face={<>Run</>} b=\"x\" c={[f('A')]} />)\n  })\n"
                  "  it('counts', () => {})\n})\n")
    for name in ('draws', 'counts'):
        assert found(repo, f'voc-datalake/frontend/src/widget.test.tsx::Widget > {name}').problems == []


def test_a_title_built_at_runtime_cannot_be_named(repo: Path):
    assert only_problem(repo, 'voc-datalake/frontend/src/widget.test.ts::Widget > uses a template').startswith(
        "no test 'Widget > uses a template'")


def test_an_only_anywhere_in_the_file_refuses_every_test(repo: Path):
    planted.write(repo, 'voc-datalake/frontend/src/widget.test.ts',
                  "describe('Widget', () => {\n  it('counts', () => {})\n  it.only('x', () => {})\n})\n")
    assert only_problem(repo, planted.VITEST_ID) == (
        'voc-datalake/frontend/src/widget.test.ts holds a .only: the gate would run only that test')


def test_a_skipped_describe_skips_its_tests(repo: Path):
    planted.write(repo, 'voc-datalake/frontend/src/widget.test.ts',
                  "describe.skipIf(process.env.CI)('Widget', () => {\n  it('counts', () => {})\n})\n")
    assert only_problem(repo, planted.VITEST_ID) == "'Widget > counts' is inside describe.skipIf 'Widget': the gate does not run it"


def spec_with(body: str) -> str:
    return f"test.describe('Widget page', () => {{\n  test('shows the count', async () => {{\n{body}\n  }})\n}})\n"


@pytest.mark.parametrize('call', ["    test.skip(true, 'later')", '    test.skip(!0)', '    test.fixme(true)'])
def test_a_literal_true_skip_is_unconditional(repo: Path, call: str):
    planted.write(repo, 'voc-datalake/frontend/e2e/tests/widget.spec.ts', spec_with(call))
    assert only_problem(repo, planted.SPEC_ID).endswith('calls skip() unconditionally: the gate does not run it')


def test_a_playwright_test_resolves_and_a_conditional_skip_is_only_a_note(repo: Path):
    assert found(repo, planted.SPEC_ID).problems == []
    got = found(repo, 'voc-datalake/frontend/e2e/tests/widget.spec.ts::Widget page > mock only')
    assert got.problems == []
    assert got.notes == ["'Widget page > mock only' has a conditional skip (it may skip itself on the mock or a deployment)"]


def test_a_spec_the_mock_does_not_run_is_refused(repo: Path):
    rel = 'voc-datalake/frontend/e2e/tests/prod-only.spec.ts'
    planted.write(repo, rel, spec_with('    await page.goto("/")'))
    assert only_problem(repo, f'{rel}::Widget page > shows the count') == (
        f'{rel}: prod-only is not in MOCK_SPEC_NAMES (voc-datalake/frontend/e2e/lib/env.ts), so the mock run skips it')


def test_the_mock_list_is_read_from_its_literals(repo: Path):
    assert resolve.mock_spec_names(repo) == ['error-states', 'widget', 'memory']


def test_a_title_named_twice_is_ambiguous(repo: Path):
    planted.write(repo, 'voc-datalake/frontend/src/widget.test.ts',
                  "describe('Widget', () => {\n  it('counts', () => {})\n  it('counts', () => {})\n})\n")
    assert only_problem(repo, planted.VITEST_ID) == "'Widget > counts' is named twice in voc-datalake/frontend/src/widget.test.ts"


def test_the_pinned_command_runs_only_that_test():
    assert resolve.command(entry_for(planted.PYTEST_ID)) == (
        'bash scripts/pinned.sh python -m pytest -c voc-datalake/pytest.ini --rootdir voc-datalake -p no:cacheprovider '
        '--no-cov -q ' + planted.PYTEST_ID)
    assert resolve.command(entry_for(planted.VITEST_ID)) == (
        'bash scripts/pinned.sh npx --prefix voc-datalake/frontend vitest run --root voc-datalake/frontend '
        "src/widget.test.ts -t '^Widget counts$'")
    assert resolve.command(entry_for(planted.SPEC_ID)) == (
        'bash scripts/pinned.sh env E2E_MOCK=1 npx --prefix voc-datalake/frontend/e2e playwright test '
        '-c voc-datalake/frontend/e2e/playwright.config.ts voc-datalake/frontend/e2e/tests/widget.spec.ts '
        "-g '(^| )Widget page shows the count$'")


def test_the_red_run_names_the_test():
    assert resolve.red_name(entry_for(planted.PYTEST_ID)) == planted.PYTEST_ID
    assert resolve.red_name(entry_for(planted.VITEST_ID)) == 'counts'
    assert resolve.red_name(entry_for(planted.SPEC_ID)) == 'shows the count'
