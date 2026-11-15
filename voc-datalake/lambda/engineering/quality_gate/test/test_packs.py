"""The gate packs: the shipped manifests, detection, planning, and the refusals of a bad manifest."""
from __future__ import annotations

import tomllib
from typing import Any

import pytest

from engineering.quality_gate.packs import (
    PackError,
    RepoView,
    default_packs_dir,
    detect,
    language_roots,
    load_pack,
    load_packs,
    parse_pack,
    plan,
)
from engineering.quality_gate.test.gate_fakes import FIXTURES, PACKS_DIR, repo_of

PACKS = load_packs(PACKS_DIR)
BY_ID = {pack.id: pack for pack in PACKS}


def _plan(files: dict[str, str], **kwargs: Any):
    repo = repo_of(files)
    return plan(detect(PACKS, repo), repo, **kwargs)


def _keys(files: dict[str, str], **kwargs: Any) -> list[str]:
    return [c.key for c in _plan(files, **kwargs).checks]


class TestShippedPacks:
    def test_the_three_packs_load(self):
        assert sorted(BY_ID) == ['java', 'python-ts', 'rust-ts']

    def test_the_typescript_half_is_the_same_in_both_packs(self):
        """Shared steps run once per root, so they must be identical wherever they appear."""
        rust_ts = {s.id: s for s in BY_ID['rust-ts'].steps if s.language == 'ts'}
        python_ts = {s.id: s for s in BY_ID['python-ts'].steps if s.language == 'ts'}
        assert rust_ts == python_ts
        assert sorted(rust_ts) == ['ts.install', 'ts.lint', 'ts.test', 'ts.typecheck']

    def test_every_pack_names_its_registries_and_image(self):
        for pack in PACKS:
            assert pack.needs.network, pack.id
            assert pack.needs.image, pack.id

    def test_the_default_directory_is_the_repositorys_engineering_gates(self):
        assert default_packs_dir() == PACKS_DIR

    def test_only_setup_steps_name_registries_and_no_later_step_installs(self):
        for pack in PACKS:
            for step in pack.steps:
                argvs = [step.argv, *(alt.argv for alt in step.prefer)]
                if step.kind == 'setup':
                    continue
                assert not any({'install', 'ci', 'fetch', 'dependency:go-offline'} & set(argv) for argv in argvs), step.id


class TestFixtures:
    @pytest.mark.parametrize(('fixture', 'packs', 'checks'), [
        ('rust-ts/passing', ('python-ts', 'rust-ts'),
         ['rust.fetch@.', 'rust.fmt@.', 'rust.clippy@.', 'ts.test@.', 'rust.test@.']),
        ('python-ts/passing', ('python-ts',), ['py.ruff@.', 'py.test@.']),
        ('java/passing', ('java',), ['java.fetch@.', 'java.maven@.']),
    ])
    def test_each_fixture_gets_its_packs_checks(self, fixture, packs, checks):
        for variant in (fixture, fixture.replace('passing', 'failing')):
            repo = RepoView.from_dir(FIXTURES / variant)
            gate_plan = plan(detect(PACKS, repo), repo)
            assert gate_plan.packs == packs
            assert [c.key for c in gate_plan.checks] == checks

    def test_from_dir_skips_build_output_and_reads_only_inside(self, tmp_path):
        (tmp_path / 'node_modules' / 'x').mkdir(parents=True)
        (tmp_path / 'node_modules' / 'x' / 'index.ts').write_text('')
        (tmp_path / 'src').mkdir()
        (tmp_path / 'src' / 'a.py').write_text('x = 1')
        repo = RepoView.from_dir(tmp_path)
        assert repo.files == frozenset({'src/a.py'})
        assert repo.read_text('src/a.py') == 'x = 1'
        assert repo.read_text('../etc/passwd') is None
        assert repo.read_text('missing.txt') is None

    def test_from_dir_does_not_read_a_huge_config_file(self, tmp_path):
        (tmp_path / 'package.json').write_text(' ' * 1_000_001)
        assert RepoView.from_dir(tmp_path).read_text('package.json') is None


class TestDetection:
    def test_workspace_members_are_checked_through_the_workspace_root(self):
        repo = repo_of({'Cargo.toml': '[workspace]\nmembers = ["crates/*"]', 'crates/a/Cargo.toml': '',
                        'crates/a/src/lib.rs': ''})
        assert language_roots(BY_ID['rust-ts'].languages[0], repo) == ('',)
        npm = repo_of({'package.json': '{"workspaces": ["web"]}', 'web/package.json': '{}', 'web/a.ts': ''})
        assert language_roots(BY_ID['rust-ts'].languages[1], npm) == ('',)

    def test_a_marker_that_is_not_a_workspace_hides_no_app_below_it(self):
        files = {'package.json': '{"devDependencies": {}}', 'tools.ts': '',
                 'web/package.json': '{"scripts": {"test": "t"}}', 'web/tsconfig.json': '{}', 'web/src/a.ts': ''}
        assert language_roots(BY_ID['rust-ts'].languages[1], repo_of(files)) == ('', 'web')
        assert {'ts.typecheck@web', 'ts.test@web'} <= set(_keys(files))

    def test_one_workspace_per_app_gives_one_root_per_app(self):
        repo = repo_of({'app1/Cargo.toml': '', 'app1/src/main.rs': '', 'app2/Cargo.toml': '',
                                      'app2/src/main.rs': '', 'docs/Cargo.toml': ''})
        assert language_roots(BY_ID['rust-ts'].languages[0], repo) == ('app1', 'app2')

    def test_a_marker_without_sources_is_not_a_language(self):
        repo = repo_of({'package.json': '{}', 'index.js': ''})
        assert detect(PACKS, repo) == ()


class TestPlanning:
    def test_steps_run_only_for_tools_the_repository_adopted(self):
        gate_plan = _plan({'pyproject.toml': '[project]\nname = "a"\n', 'a.py': '', 'requirements.txt': ''})
        assert [c.key for c in gate_plan.checks] == ['py.install@.']
        assert dict(gate_plan.skipped)['py.ruff@.'] == 'the repository does not use this tool'

    def test_the_dependency_steps_fetch_without_running_code(self):
        argv = {c.step_id: c.argv for c in _plan({'requirements.txt': '', 'requirements-dev.txt': '', 'a.py': '',
                                                  'Cargo.toml': '',
                                                  'Cargo.lock': '', 'b.rs': ''}).checks}
        assert argv['py.install'] == ('python3', '-I', '-m', 'pip', 'install', '--isolated', '--quiet',
                                      '--only-binary=:all:', '--index-url', 'https://pypi.org/simple',
                                      '-r', 'requirements-dev.txt')
        assert argv['rust.fetch'] == ('cargo', '--config', "build.rustc-wrapper=''", '--config',
                                      "build.rustc-workspace-wrapper=''", 'fetch', '--locked')
        assert all('--offline' in argv[step] for step in ('rust.clippy', 'rust.test'))
        pnpm = _plan({'package.json': '{}', 'pnpm-lock.yaml': '', 'a.ts': ''}).checks[0].argv
        assert {'--ignore-scripts', '--ignore-pnpmfile'} <= set(pnpm)
        java = {c.step_id: c.argv for c in _plan({'pom.xml': '', 'mvnw': '', 'A.java': ''}).checks}
        assert java == {'java.fetch': ('mvn', '-B', '-ntp', 'dependency:go-offline'),
                        'java.maven': ('mvn', '-B', '-ntp', '--offline', 'verify')}

    def test_the_repositorys_own_script_wins(self):
        checks = _plan({'package.json': '{"scripts": {"lint": "x", "test": "y", "typecheck": "z"}}',
                        'package-lock.json': '{}', 'tsconfig.json': '{}', 'a.ts': ''}).checks
        assert [(c.key, c.argv) for c in checks] == [
            ('ts.install@.', ('npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund',
                              '--registry=https://registry.npmjs.org/')),
            ('ts.lint@.', ('npm', 'run', '--silent', 'lint')),
            ('ts.typecheck@.', ('npm', 'run', '--silent', 'typecheck')),
            ('ts.test@.', ('npm', 'test', '--silent'))]

    def test_without_its_scripts_the_packs_own_command_runs(self):
        checks = _plan({'package.json': '{"scripts": []}', 'tsconfig.json': '{}', 'eslint.config.mjs': '',
                        'a.ts': ''}).checks
        assert [c.argv[:3] for c in checks] == [('npx', '--no-install', 'eslint'), ('npx', '--no-install', 'tsc')]
        assert _keys({'package.json': 'not json', 'tsconfig.json': '{}', 'a.ts': ''}) == ['ts.typecheck@.']

    def test_a_lock_file_makes_cargo_locked(self):
        argv = {c.step_id: c.argv for c in _plan({'Cargo.toml': '', 'Cargo.lock': '', 'src/lib.rs': ''}).checks}
        assert '--locked' in argv['rust.clippy']
        assert '--locked' in argv['rust.test']

    def test_the_own_gate_replaces_every_step(self):
        gate_plan = _plan({'Cargo.toml': '', 'src/lib.rs': '', 'scripts/validate.sh': ''})
        assert gate_plan.own_gate is True
        assert [(c.key, c.argv[-1]) for c in gate_plan.checks] == [
            ('rust.fetch@.', 'fetch'), ('own:scripts/validate.sh', 'scripts/validate.sh')]
        mono = {'a/Cargo.toml': '', 'a/src/lib.rs': '', 'b/Cargo.toml': '', 'b/src/lib.rs': '', 'scripts/validate.sh': ''}
        assert _keys(mono, changed_paths=['a/src/lib.rs']) == ['rust.fetch@a', 'rust.fetch@b', 'own:scripts/validate.sh']
        assert _plan({'scripts/validate.sh': '', 'notes.md': ''}).checks == ()

    def test_a_change_checks_only_the_roots_it_touches(self):
        files = {'a/Cargo.toml': '', 'a/src/lib.rs': '', 'b/Cargo.toml': '', 'b/src/lib.rs': ''}
        touched = _plan(files, changed_paths=['a/src/lib.rs'])
        assert [c.key for c in touched.checks] == ['rust.fetch@a', 'rust.fmt@a', 'rust.clippy@a', 'rust.test@a']
        assert dict(touched.skipped)['rust.fmt@b'] == 'not touched by the change'
        assert len(_plan(files, changed_paths=['README.md']).checks) == 8
        assert len(_plan(files).checks) == 8

    def test_a_change_in_one_languages_root_is_not_a_shared_file_for_another(self):
        files = {'svc/pyproject.toml': '[tool.ruff]', 'svc/a.py': '', 'web/package.json': '{"scripts": {"test": "t"}}',
                 'web/a.ts': ''}
        assert _keys(files, changed_paths=['web/a.ts']) == ['ts.test@web']

    def test_python_is_substituted_into_commands_and_tool_checks(self):
        gate_plan = _plan({'ruff.toml': '', 'a.py': '', 'requirements.txt': ''}, python='/py')
        assert [c.argv[0] for c in gate_plan.checks] == ['/py', '/py']
        assert {t.name: t.version_argv for t in gate_plan.needs.tools}['python'] == ('/py', '--version')

    def test_the_test_step_looks_for_tests_by_glob(self):
        assert 'py.test@.' in _keys({'pyproject.toml': '', 'test_a.py': ''})
        assert 'py.test@.' in _keys({'pyproject.toml': '', 'pkg/a_test.py': ''})
        assert 'py.test@.' not in _keys({'pyproject.toml': '', 'a.py': ''})
        assert 'py.test@svc' in _keys({'svc/pyproject.toml': '', 'svc/tests/test_a.py': ''})


def _manifest(**changes: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        'schema': 'voc-gate-pack/1', 'id': 'demo', 'name': 'Demo',
        'languages': {'py': {'markers': ['pyproject.toml'], 'extensions': ['.py']}},
        'steps': [{'id': 'py.test', 'language': 'py', 'name': 'pytest', 'kind': 'test', 'argv': ['pytest']}]}
    base.update(changes)
    return base


def _step(**changes: Any) -> dict[str, Any]:
    return {**_manifest()['steps'][0], **changes}


class TestRefusals:
    @pytest.mark.parametrize(('changes', 'message'), [
        ({'schema': 'v2'}, '"schema" must be "voc-gate-pack/1"'),
        ({'id': 'Demo!'}, 'pack id "Demo!" must be lowercase'),
        ({'id': 'a.b'}, 'pack id "a.b" must be lowercase'),
        ({'id': 'demo\n'}, 'pack id "demo\n" must be lowercase'),
        ({'languages': {}}, '[languages] must declare at least one language'),
        ({'languages': {'py': 'x'}}, 'every [languages] entry must be a table'),
        ({'languages': {'py': {'markers': [], 'extensions': ['.py']}}}, '"markers" must not be empty'),
        ({'steps': []}, 'a pack needs at least one [[steps]] entry'),
        ({'steps': [_step(), _step()]}, 'step id "py.test" is declared twice'),
        ({'steps': [_step(id='Bad')]}, 'step id "Bad" must look like'),
        ({'steps': [_step(language='go')]}, 'language "go" is not declared'),
        ({'steps': [_step(kind='deploy')]}, 'kind "deploy" is not one of'),
        ({'steps': [_step(argv=[])]}, 'a step needs "argv" or at least one "prefer"'),
        ({'steps': [_step(argv='pytest')]}, '"argv" must be a list of non-empty strings'),
        ({'steps': [_step(timeout_s=0)]}, '"timeout_s" must be an integer from 1 to 10800'),
        ({'steps': [_step(timeout_s=True)]}, '"timeout_s" must be an integer'),
        ({'steps': [_step(empty_exit_codes=[0])]}, '"empty_exit_codes" must be a list of non-zero exit codes'),
        ({'steps': [_step(empty_exit_codes=[300])]}, '"empty_exit_codes" must be a list of non-zero exit codes'),
        ({'steps': [_step(ok_exit_codes=[1])]}, "unknown keys ['ok_exit_codes']"),
        ({'steps': [_step(expect_output='(')]}, '"expect_output" is not a valid regular expression'),
        ({'steps': [_step(prefer=['x'])]}, 'an alternative must be a table'),
        ({'steps': [_step(when_any={'file': 'a'})]}, 'conditions must be a list of tables'),
        ({'steps': [_step(when_any=['a'])]}, 'a condition must be a table'),
        ({'steps': [_step(when_any=[{'path': 'a'}])]}, "unknown keys ['path']"),
        ({'steps': [_step(when_any=[{'file': 'a', 'glob': '*'}])]}, 'exactly one of "file" and "glob"'),
        ({'steps': [_step(when_any=[{'file': '../a'}])]}, '"../a" must be a path inside the repository'),
        ({'own_gate': []}, "unknown keys ['own_gate']"),
        ({'tools': {'x': 'cargo'}}, 'every [tools] entry must be a table'),
        ({'image': {'rust': 1}}, '[image] maps each toolchain to a version string'),
        ({'name': ''}, '"name" must be a non-empty string'),
    ])
    def test_a_bad_manifest_is_refused_with_its_reason(self, changes, message):
        with pytest.raises(PackError, match=r'^demo\.toml') as raised:
            parse_pack(_manifest(**changes), 'demo.toml')
        assert message in str(raised.value)

    def test_a_good_manifest_parses(self):
        pack = parse_pack(_manifest(), 'demo.toml')
        assert (pack.id, pack.steps[0].empty_exit_codes, pack.steps[0].timeout_s) == ('demo', frozenset(), 900)

    def test_the_id_must_match_the_directory(self, tmp_path):
        (tmp_path / 'other').mkdir()
        manifest = tmp_path / 'other' / 'manifest.toml'
        manifest.write_text((PACKS_DIR / 'java' / 'manifest.toml').read_text())
        with pytest.raises(PackError, match='must match its directory "other"'):
            load_pack(manifest)

    def test_bad_toml_and_an_empty_directory_are_refused(self, tmp_path):
        (tmp_path / 'demo').mkdir()
        (tmp_path / 'demo' / 'manifest.toml').write_text('schema = ')
        with pytest.raises(PackError, match='not valid TOML'):
            load_packs(tmp_path)
        with pytest.raises(PackError, match='no gate packs found'):
            load_packs(tmp_path / 'demo')

    def test_the_readmes_example_manifest_is_a_valid_pack(self):
        readme = (PACKS_DIR / 'README.md').read_text()
        example = readme.split('```toml\n', 1)[1].split('```', 1)[0]
        pack = parse_pack(tomllib.loads(example), 'README.md')
        assert (pack.id, [s.id for s in pack.steps], pack.steps[0].prefer[0].argv) == (
            'example', ['py.test'], ('make', 'test'))

    def test_the_shipped_manifests_are_valid_toml_with_no_unknown_top_level_keys(self):
        known = {'schema', 'id', 'name', 'network', 'image', 'languages', 'tools', 'steps'}
        for manifest in PACKS_DIR.glob('*/manifest.toml'):
            assert set(tomllib.loads(manifest.read_text())) <= known, manifest
