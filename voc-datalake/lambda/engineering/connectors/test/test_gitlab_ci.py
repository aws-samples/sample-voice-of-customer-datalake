"""A GitLab project's CI definitions pinned before a push (gitlab_ci.py): only plain local includes and GitLab's own
templates; every other include, and every file the broker cannot parse, refuses the push."""
from __future__ import annotations

from typing import Any

import pytest

from engineering.connectors import gitlab_ci
from engineering.connectors.gitlab_ci import CI_UNRESOLVED, CiFiles, ci_file, includes, normalised, pinned
from engineering.connectors.write_policy import WriteRefused

PROJECT = 'example-org/payments/refund-service'
PLAIN = b'include:\n  - local: ci/build.yml\n  - template: Jobs/SAST.gitlab-ci.yml\n\ntest:\n  script: make test\n'
BUILD = b'build:\n  script: make\n'
VALID = {'valid': True, 'includes': [{'type': 'local', 'location': '/ci/build.yml'},
                                     {'type': 'template', 'location': 'Jobs/SAST.gitlab-ci.yml'}]}


def pin(project: dict[str, Any] | None = None, linted: object = VALID, files: dict[str, bytes] | None = None
        ) -> CiFiles:
    read = {'.gitlab-ci.yml': PLAIN, 'ci/build.yml': BUILD, **(files or {})}
    return pinned({'ci_config_path': ''} if project is None else project, lambda: linted, read.get)


def refusal(files: dict[str, bytes] | None = None) -> str:
    with pytest.raises(WriteRefused) as refused:
        pin(files=files)
    return refused.value.reason


def test_the_ci_file_and_the_local_files_its_includes_reach_are_the_definitions() -> None:
    assert pin() == CiFiles(paths=('.gitlab-ci.yml', 'ci/build.yml'))


def test_a_local_include_is_walked_by_the_same_rules_and_its_own_includes_reached() -> None:
    nested = b'include: "/ci/deep.yml"\nbuild:\n  script: make\n'
    linted = {'valid': True, 'includes': [*VALID['includes'], {'type': 'local', 'location': 'ci/deep.yml'}]}
    assert pin(linted=linted, files={'ci/build.yml': nested, 'ci/deep.yml': BUILD}).paths == (
        '.gitlab-ci.yml', 'ci/build.yml', 'ci/deep.yml')


@pytest.mark.parametrize(('text', 'said'), [
    (b'include:\n  - local: "ci/*.yml"\n', 'a pattern or a variable (ci/*.yml)'),
    (b'include:\n  - local: ci/$TARGET.yml\n', 'a pattern or a variable'),
    (b'include:\n  - local: ci/a.yml\n    rules:\n      - if: $X\n', 'a pattern or a variable'),
    (b'include:\n  - local: ci/a.yml\n    rules:\n      - exists: [a.txt]\n', 'an entry with rules'),
    (b'include:\n  - "local": ci/a.yml\n    "rules":\n      - exists: [a.txt]\n', 'an entry with rules'),
    (b'{"include": [{"local": "ci/a.yml", "rules": [{"exists": ["a.txt"]}]}], "t": {"script": "x"}}',
     'an entry with rules'),
    (b'include: [{local: ci/a.yml, rules: [{exists: [a.txt]}]}]\n', 'an entry with rules'),
    (b'include:\n  - project: example-org/payments/refund-service\n    file: ci/a.yml\n', "a project's file"),
    (b'include:\n  - project: example-org/other\n    ref: main\n    file: ci/a.yml\n', "a project's file"),
    (b'include:\n  - remote: https://gitlab.com/example-org/x/-/raw/main/a.yml\n', 'a remote file'),
    (b'include: https://ci.example.com/a.yml\n', 'a remote file'),
    (b'include:\n  - component: gitlab.com/example-org/lint/check@1.0\n', 'an entry with component'),
    (b'include:\n  - local: ci/[[ inputs.name ]].yml\n', 'a pattern or a variable'),
    (b'include:\n  - !reference [.base, include]\n', 'a tagged value'),
    (b'include:\n  - local: ../outside.yml\n', 'outside the repository'),
    (b'include:\n  - [a.yml]\n', 'neither a path nor a mapping'),
    (b'include:\n  - local: "ci/\\x2a.yml"\n', 'a backslash escape'),
    (b'include:\n  - local: "ci/\\u0061gent.yml"\n', 'a backslash escape'),
    (b"include:\n  - local: 'ci\\agent.yml'\n", 'a pattern or a variable'),
], ids=['wildcard', 'variable', 'rules with a variable', 'rules', 'quoted rules', 'JSON-style', 'flow mapping',
        'this project', 'another project', 'remote', 'remote string', 'component', 'inputs', 'reference tag',
        'dot dot', 'not a path', 'hex escape', 'unicode escape', 'a backslash'])
def test_an_include_the_broker_cannot_read_and_pin_refuses_saying_which(text: bytes, said: str) -> None:
    reason = refusal({'.gitlab-ci.yml': text})
    assert said in reason
    assert reason.endswith("which the broker can't read and pin; agents can't push to it while it does.")


@pytest.mark.parametrize('text', [
    b'- include: a.yml\n',                               # (a flow or block list at its top level)
    b'[{"include": "a.yml"}]',
    b'include:\n  - local: a.yml\ninclude:\n  - local: b.yml\n',    # (a duplicate key)
    b'include: [a.yml\n',                                # (a flow list that does not close)
    b'test:\n\tscript: x\n',                             # (a tab)
    b'a: 1\n---\nb: 2\n',                                # (two documents)
    b'include: *shared\n',                               # (an alias)
    b'<<: {include: [{local: ci/agent.yml}]}\ntest:\n  script: x\n',   # (a merge key)
    # The round-3 case: an include hidden from a reader that reads escapes, BOMs or line breaks apart from GitLab.
    b'"\\u0069nclude": [{local: ci/agent.yml, rules: [{exists: [ci/agent.yml]}]}]\n',
    b'{"\\u0069nclude": [{"local": "ci/agent.yml"}]}',
    b'\xef\xbb\xbfinclude: [{local: ci/agent.yml}]\n',
    b'test: x\rinclude: [{local: ci/agent.yml}]\n',
    'test: x\u0085include: [{local: ci/agent.yml}]\n'.encode(),
    'test: x\u2028include: [{local: ci/agent.yml}]\n'.encode(),
    'test: x\u2029include: [{local: ci/agent.yml}]\n'.encode(),
    'test: "\ufffd"\ninclude: [{local: ci/agent.yml}]\n'.encode(),
    b'a:\n  b:\n    c: 1\n    c: 2\n',                   # (a duplicate key at depth)
    b'a: !custom x\n',                                   # (a tag)
])
def test_a_ci_file_the_broker_cannot_parse_refuses(text: bytes) -> None:
    with pytest.raises(WriteRefused) as refused:
        includes(text)
    assert refused.value.reason == CI_UNRESOLVED


@pytest.mark.parametrize('trigger', [
    b'deploy:\n  trigger:\n    include: ci/child.yml\n',
    b'deploy:\n  trigger:\n    include:\n      - local: ci/child.yml\n',
    b'deploy:\n  trigger:\n    include:\n      local: ci/child.yml\n',
], ids=['string', 'list', 'mapping'])
def test_a_child_pipelines_file_is_a_ci_definition_pinned_and_walked(trigger: bytes) -> None:
    found = pin(files={'.gitlab-ci.yml': PLAIN + trigger, 'ci/child.yml': BUILD})
    assert found.paths == ('.gitlab-ci.yml', 'ci/build.yml', 'ci/child.yml')


def test_a_child_pipeline_in_an_included_file_is_pinned_and_its_own_rules_hold() -> None:
    nested = b'deploy:\n  trigger:\n    include: ci/child.yml\n'
    assert pin(files={'ci/build.yml': nested, 'ci/child.yml': BUILD}).paths[-1] == 'ci/child.yml'
    child = b'include:\n  - local: "ci/*.yml"\n'
    assert 'a pattern or a variable' in refusal({'ci/build.yml': nested, 'ci/child.yml': child})


@pytest.mark.parametrize(('trigger', 'said'), [
    (b'deploy:\n  trigger:\n    include:\n      - project: example-org/other\n        file: a.yml\n', "a project's file"),
    (b'deploy:\n  trigger:\n    include:\n      - artifact: generated.yml\n        job: make\n', 'an entry with artifact'),
    (b'deploy:\n  trigger:\n    include: https://ci.example.com/a.yml\n', 'a remote file'),
    (b'deploy:\n  trigger:\n    include:\n      - component: gitlab.com/x/y@1\n', 'an entry with component'),
    (b'deploy:\n  trigger:\n    include: ci/$CHILD.yml\n', 'a pattern or a variable'),
    (b'deploy:\n  trigger:\n    include: "ci/*.yml"\n', 'a pattern or a variable'),
    (b'deploy:\n  trigger:\n    strategy: depend\n', 'a trigger the broker does not read'),
    (b'deploy:\n  trigger: [a]\n', 'a trigger the broker does not read'),
], ids=['project', 'artifact', 'remote', 'component', 'variable', 'glob', 'unknown', 'not a mapping'])
def test_a_child_pipeline_the_broker_cannot_pin_refuses_naming_it(trigger: bytes, said: str) -> None:
    assert said in refusal({'.gitlab-ci.yml': PLAIN + trigger})


@pytest.mark.parametrize('jobs', [
    # (a hidden job another extends: its child pipeline's file is walked and pinned wherever the job is defined)
    b'.child:\n  trigger:\n    include: ci/child.yml\ndeploy:\n  extends: .child\n',
    # (and the job that extends it may say how the child runs: GitLab merges it into the walked trigger)
    b'.child:\n  trigger:\n    include: ci/child.yml\ndeploy:\n  extends: .child\n  trigger:\n    strategy: depend\n',
    # (a job named ``trigger`` is a job like any other)
    b'trigger:\n  trigger:\n    include: ci/child.yml\n',
], ids=['hidden job', 'extends with strategy', 'a job named trigger'])
def test_every_job_s_child_pipeline_is_walked_whatever_its_name(jobs: bytes) -> None:
    assert pin(files={'.gitlab-ci.yml': PLAIN + jobs, 'ci/child.yml': BUILD}).paths[-1] == 'ci/child.yml'


@pytest.mark.parametrize(('jobs', 'said'), [
    (b'deploy:\n  trigger: !reference [.child, trigger]\n', 'a trigger the broker does not read'),
    (b'deploy:\n  trigger:\n    strategy: depend\n', 'a trigger the broker does not read'),
    (b'deploy:\n  extends: .child\n  trigger:\n    strategy: depend\n    include: "ci/*.yml"\n', 'a pattern'),
], ids=['reference tag', 'strategy without extends', 'extends with its own include'])
def test_a_trigger_the_walk_cannot_follow_refuses(jobs: bytes, said: str) -> None:
    assert said in refusal({'.gitlab-ci.yml': PLAIN + jobs})


@pytest.mark.parametrize('trigger', [b'deploy:\n  trigger: example-org/other\n',
                                     b'deploy:\n  trigger:\n    project: example-org/other\n    branch: main\n'])
def test_a_multi_project_trigger_puts_nothing_here_in_ci_and_is_allowed(trigger: bytes) -> None:
    assert pin(files={'.gitlab-ci.yml': PLAIN + trigger}).paths == ('.gitlab-ci.yml', 'ci/build.yml')


@pytest.mark.parametrize('text', [b'deploy: make\n', b'variables: [a]\n', b'deploy:\n  - script\n'])
def test_a_job_or_a_mapping_keyword_that_is_not_a_mapping_is_unreadable(text: bytes) -> None:
    with pytest.raises(WriteRefused) as refused:
        includes(text)
    assert refused.value.reason == CI_UNRESOLVED


def test_a_nested_local_glob_under_a_local_include_refuses() -> None:
    assert 'a pattern or a variable' in refusal({'ci/build.yml': b'include:\n  - local: "more/**/*.yml"\n'})


@pytest.mark.parametrize(('project', 'said'), [
    ({}, CI_UNRESOLVED),
    ({'ci_config_path': 7}, CI_UNRESOLVED),
    ({'ci_config_path': f'ci.yml@{PROJECT}'}, 'its CI file from elsewhere'),
    ({'ci_config_path': 'ci.yml@example-org/ci-templates:main'}, 'its CI file from elsewhere'),
    ({'ci_config_path': 'https://ci.example.com/ci.yml'}, 'its CI file from elsewhere'),
    ({'ci_config_path': '../outside.yml'}, 'outside the repository'),
], ids=['no key', 'not text', 'this project by @', 'another project', 'a URL', 'climbing out'])
def test_a_ci_file_the_broker_cannot_read_refuses(project: dict[str, Any], said: str) -> None:
    with pytest.raises(WriteRefused) as refused:
        pin(project)
    assert said in refused.value.reason


@pytest.mark.parametrize('linted', [
    {'valid': False, 'includes': []},
    {'valid': True},
    # (the round-3 case: GitLab reads an include the walk missed; its lint names it, so the push is refused)
    {'valid': True, 'includes': [{'type': 'local', 'location': 'ci/agent.yml'}]},
    {'valid': True, 'includes': [{'type': 'project', 'location': 'ci/a.yml'}]},
    {'valid': True, 'includes': [{'type': 'remote', 'location': 'https://ci.example.com/a.yml'}]},
    {'valid': True, 'includes': [{'type': 'component', 'location': 'gitlab.com/x/y@1'}]},
    {'valid': True, 'includes': [{'location': 'a.yml'}]},
], ids=['invalid', 'no includes', 'a local include the walk did not reach', 'project', 'remote', 'component',
        'no type'])
def test_the_lint_cross_check_refuses_what_it_does_not_confirm(linted: object) -> None:
    with pytest.raises(WriteRefused):
        pin(linted=linted)


def test_a_listed_file_missing_at_the_base_is_unresolved() -> None:
    with pytest.raises(WriteRefused, match='could not be resolved'):
        pinned({'ci_config_path': ''}, lambda: VALID, {'.gitlab-ci.yml': PLAIN}.get)


def test_the_walk_reads_no_deeper_and_no_more_files_than_its_bounds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gitlab_ci, 'MAX_DEPTH', 1)
    nested = b'include: ci/deep.yml\n'
    assert 'deeper, than the broker reads' in refusal({'ci/build.yml': nested, 'ci/deep.yml': BUILD})
    monkeypatch.setattr(gitlab_ci, 'MAX_DEPTH', 10)
    monkeypatch.setattr(gitlab_ci, 'MAX_FILES', 1)
    assert 'more local files' in refusal()


def test_paths_are_normalised_and_a_plain_or_empty_configuration_reads() -> None:
    assert (normalised('./a/b.yml'), normalised('/a.yml'), normalised('.//a.yml')) == ('a/b.yml', 'a.yml', 'a.yml')
    assert (ci_file({'ci_config_path': None}), ci_file({'ci_config_path': './ops/ci.yml'})) == (
        '.gitlab-ci.yml', 'ops/ci.yml')
    assert includes(b'test:\n  script: x\n') == []
    assert includes(b'include:\n  template: Jobs/SAST.gitlab-ci.yml\n') == []
