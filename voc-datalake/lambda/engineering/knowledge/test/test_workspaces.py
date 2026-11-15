"""Packages from a listing: every ecosystem's manifests, workspaces adding members, Bazel as the fallback, owners."""
from __future__ import annotations

import pytest

from engineering.knowledge import workspaces
from engineering.knowledge.test.fixtures import MANIFESTS, PACKAGES, PATHS
from engineering.knowledge.workspaces import ListingError, Package, check_paths, detect, manifest_paths


def by_path(paths: tuple[str, ...] | list[str], manifests: dict[str, str]) -> dict[str, Package]:
    return {p.path: p for p in detect(paths, manifests).packages}


def test_the_fictional_monorepo_has_its_packages_names_kinds_and_workspaces() -> None:
    layout = detect(PATHS, MANIFESTS)
    packages = {p.path: p for p in layout.packages}
    assert set(packages) == PACKAGES   # node_modules/left-pad is vendored, not the repository's
    assert layout.packages[0].path == '.'
    assert packages['packages/web'] == Package('packages/web', '@harbor/web', ('npm',), '.', ('@harbor/frontend',))
    assert packages['packages/api'].name == 'api'   # a member whose manifest names nothing keeps its directory
    assert packages['packages/api'].workspace == '.'
    assert (packages['services/billing'].name, packages['services/billing'].kinds) == ('harbor-billing', ('python',))
    assert packages['services/billing'].workspace == ''
    assert (packages['crates/ledger'].kinds, packages['crates/ledger'].workspace) == (('cargo',), '.')
    assert (packages['.'].name, packages['.'].kinds) == ('harbor', ('npm',))   # a virtual Cargo workspace is no crate
    assert layout.skipped == 0


def test_every_path_is_held_by_the_deepest_package_above_it() -> None:
    files = detect(PATHS, MANIFESTS).files
    assert files['services/billing'] == ('services/billing/billing/__init__.py', 'services/billing/billing/invoice.py',
                                         'services/billing/pyproject.toml', 'services/billing/tests/test_invoice.py')
    assert 'README.md' in files['.']
    assert 'node_modules/left-pad/index.js' in files['.']
    assert sorted(path for held in files.values() for path in held) == sorted(PATHS)


def test_owners_are_the_last_matching_rule_and_handles_only() -> None:
    packages = by_path(PATHS, MANIFESTS)
    assert packages['.'].owners == ('@harbor/core',)
    assert packages['packages/web'].owners == ('@harbor/frontend',)   # the e-mail address is not kept
    assert packages['services/billing'].owners == ('@harbor/billing',)   # unanchored: any services/ directory
    assert packages['crates/ledger'].owners == ('@harbor/core',)   # a file pattern (*.py) owns no package


def test_codeowners_comes_from_the_first_place_github_reads() -> None:
    manifests = {**MANIFESTS, 'CODEOWNERS': '* @harbor/root-file\n'}
    assert by_path([*PATHS, 'CODEOWNERS'], manifests)['.'].owners == ('@harbor/core',)
    del manifests['.github/CODEOWNERS']
    assert by_path([*PATHS, 'CODEOWNERS'], manifests)['.'].owners == ('@harbor/root-file',)


def test_detection_is_deterministic_whatever_the_listing_order() -> None:
    shuffled = [*PATHS[7:], *reversed(PATHS[:7])]
    assert detect(shuffled, MANIFESTS) == detect(PATHS, MANIFESTS)


@pytest.mark.parametrize('path', ['../etc/passwd', 'a/../b', '/abs', 'a//b', './a', 'a\\b', 'a\x00b', ''])
def test_a_path_off_the_repository_shape_refuses_the_listing(path: str) -> None:
    with pytest.raises(ListingError):
        detect([*PATHS, path], MANIFESTS)


def test_a_listing_over_the_cap_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(workspaces, 'MAX_PATHS', 3)
    assert check_paths(['b', 'a', 'a']) == ['a', 'b']
    with pytest.raises(ListingError, match='more than 3 paths'):
        check_paths(['a', 'b', 'c', 'd'])


def test_manifest_paths_names_what_to_read_shallow_first(monkeypatch: pytest.MonkeyPatch) -> None:
    wanted = manifest_paths(PATHS)
    assert '.github/CODEOWNERS' in wanted
    assert 'crates/ledger/Cargo.toml' in wanted
    assert 'node_modules/left-pad/package.json' not in wanted
    assert 'README.md' not in wanted
    monkeypatch.setattr(workspaces, 'MAX_MANIFESTS', 2)
    assert manifest_paths(PATHS) == ['Cargo.toml', 'package.json']
    layout = detect(PATHS, MANIFESTS)   # the other manifests are not read, and counted
    assert layout.skipped == len(wanted) - 2
    assert [p.path for p in layout.packages] == ['.', 'crates/ledger', 'packages/api', 'packages/web']


def test_pnpm_workspaces_with_an_exclusion() -> None:
    paths = ['pnpm-workspace.yaml', 'apps/site/package.json', 'apps/legacy/package.json', 'tools/x.ts']
    manifests = {'pnpm-workspace.yaml': "# workspace\npackages:\n  - 'apps/*'\n  - \"!apps/legacy\"\nother: 1\n",
                 'apps/site/package.json': '{}', 'apps/legacy/package.json': '{}'}
    packages = by_path(paths, manifests)
    assert packages['apps/site'].workspace == '.'
    assert packages['apps/legacy'].workspace == ''   # excluded from the workspace, still a package of its own


def test_yarn_workspaces_object_form() -> None:
    paths = ['package.json', 'libs/a/package.json', 'libs/a/node_modules/dep/package.json']
    manifests = {'package.json': '{"workspaces": {"packages": ["libs/**"]}}', 'libs/a/package.json': '{}',
                 'libs/a/node_modules/dep/package.json': '{}'}
    packages = by_path(paths, manifests)
    assert packages['libs/a'].workspace == '.'
    assert set(packages) == {'.', 'libs/a'}   # a glob never reaches into node_modules


def test_go_modules_and_a_go_work() -> None:
    paths = ['go.work', 'svc/auth/go.mod', 'svc/auth/main.go', 'svc/queue/go.mod']
    manifests = {'go.work': 'go 1.22\n\nuse (\n  ./svc/auth // the login service\n)\n',
                 'svc/auth/go.mod': 'module example.test/harbor/auth\n', 'svc/queue/go.mod': 'module example.test/q\n'}
    packages = by_path(paths, manifests)
    assert (packages['svc/auth'].name, packages['svc/auth'].workspace) == ('example.test/harbor/auth', '.')
    assert packages['svc/queue'].workspace == ''
    assert by_path(['go.work', 'a/go.mod'], {'go.work': 'use ./a\n', 'a/go.mod': ''})['a'].workspace == '.'


def test_gradle_includes_and_maven_modules() -> None:
    paths = ['settings.gradle.kts', 'app/src/Main.kt', 'core/data/build.gradle.kts', 'pom.xml', 'svc/pom.xml']
    manifests = {'settings.gradle.kts': 'rootProject.name = "harbor"\ninclude(":app", ":core:data")\n',
                 'pom.xml': '<project><modules><module>svc</module><module>../outside</module></modules></project>',
                 'svc/pom.xml': '<project/>'}
    packages = by_path(paths, manifests)
    assert packages['app'].kinds == ('gradle',)   # a Gradle module needs no build file
    assert packages['core/data'].workspace == '.'
    assert (packages['svc'].kinds, packages['svc'].workspace) == (('maven',), '.')
    assert '.' in packages
    assert packages['.'].kinds == ('maven',)
    assert 'outside' not in packages


def test_python_setup_cfg_setup_py_and_a_uv_workspace() -> None:
    paths = ['pyproject.toml', 'libs/one/pyproject.toml', 'libs/two/setup.cfg', 'libs/three/setup.py', 'cfg/setup.cfg',
             'tool/pyproject.toml']
    manifests = {'pyproject.toml': '[tool.uv.workspace]\nmembers = ["libs/one"]\n',
                 'libs/one/pyproject.toml': '[tool.poetry]\nname = "one"\n', 'libs/two/setup.cfg': '[metadata]\nname = two\n',
                 'cfg/setup.cfg': '[flake8]\nmax-line-length = 120\n', 'tool/pyproject.toml': '[tool.ruff]\nline-length = 1\n'}
    packages = by_path(paths, manifests)
    assert (packages['libs/one'].name, packages['libs/one'].workspace) == ('one', '.')
    assert packages['libs/two'].name == 'two'
    assert packages['libs/three'].kinds == ('python',)
    assert 'cfg' not in packages
    assert 'tool' not in packages
    assert packages['.'].kinds == ()


def test_unreadable_manifests_are_counted_not_guessed(monkeypatch: pytest.MonkeyPatch) -> None:
    paths = ['a/Cargo.toml', 'b/package.json', 'c/setup.cfg', 'd/pyproject.toml', 'pnpm-workspace.yaml']
    manifests = {'a/Cargo.toml': '[package', 'b/package.json': '[1]', 'c/setup.cfg': 'no section',
                 'd/pyproject.toml': 'x' * 300}
    monkeypatch.setattr(workspaces, 'MAX_MANIFEST_BYTES', 200)
    layout = detect(paths, manifests)
    assert [p.path for p in layout.packages] == ['.']
    assert layout.skipped == 5   # four malformed or too big, and the pnpm file never read


def test_bazel_build_roots_only_as_the_fallback() -> None:
    paths = ['MODULE.bazel', 'BUILD', 'src/BUILD.bazel', 'src/lib/BUILD', 'tools/BUILD', 'docs/readme.md']
    assert [p.path for p in detect(paths, {}).packages] == ['.', 'src', 'tools']
    assert [p.path for p in detect(['src/BUILD', 'tools/BUILD'], {}).packages] == ['.']   # not a Bazel repository
    with_crate = [*paths, 'rs/Cargo.toml']
    assert [p.path for p in detect(with_crate, {'rs/Cargo.toml': '[package]\nname = "rs"\n'}).packages] == ['.', 'rs']


def test_packages_over_the_cap_are_counted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(workspaces, 'MAX_PACKAGES', 3)
    layout = detect(PATHS, MANIFESTS)
    assert [p.path for p in layout.packages] == ['.', 'crates/ledger', 'packages/api']
    assert layout.skipped == 2
    assert 'packages/web/src/app.ts' in layout.files['.']


def test_a_name_off_the_safe_shape_falls_back_to_the_directory() -> None:
    packages = by_path(['x/package.json'], {'x/package.json': '{"name": "<script>"}'})
    assert packages['x'].name == 'x'


def test_a_manifest_nested_past_the_parser_is_counted() -> None:
    layout = detect(['a/package.json'], {'a/package.json': '[' * 100_000 + ']' * 100_000})
    assert ([p.path for p in layout.packages], layout.skipped) == (['.'], 1)


def test_a_workspace_reads_only_its_first_member_patterns(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(workspaces, 'MAX_MEMBER_PATTERNS', 1)
    paths = ['Cargo.toml', 'a/Cargo.toml', 'b/Cargo.toml']
    # Neither member's manifest names a crate: each is a package only as a declared member.
    manifests = {'Cargo.toml': '[workspace]\nmembers = ["a", "b"]\n', 'a/Cargo.toml': '', 'b/Cargo.toml': ''}
    layout = detect(paths, manifests)
    packages = {p.path: p for p in layout.packages}
    assert packages['a'].workspace == '.'
    assert 'b' not in packages
    assert layout.skipped == 1   # the workspace whose patterns were cut
