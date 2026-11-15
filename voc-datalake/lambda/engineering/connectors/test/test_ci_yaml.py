"""The strict reader of the CI check (ci_yaml.py): PyYAML's composer, and a refusal for every reading GitLab and a
reader could see apart (escapes, line breaks, a BOM, anchors, merge keys, tags, duplicate keys, two documents)."""
from __future__ import annotations

import pytest

from engineering.connectors.ci_yaml import MAX_BYTES, MAX_DEPTH, Opaque, Unreadable, load
from engineering.connectors.transport import dig

CI = b"""\
stages: [build, test]
build:
  script:
    - make build   # a comment
    - 'echo ''quoted'''
test:
  script: |
    pytest -q
  needs:
  - build
  variables: {A: "1", B: two}
  after: !reference [.defaults, image]
"""


def test_a_ci_file_reads_as_its_structure_every_scalar_text() -> None:
    found = load(CI)
    assert (dig(found, 'stages'), dig(found, 'build', 'script')) == (['build', 'test'], ['make build', "echo 'quoted'"])
    assert (dig(found, 'test', 'needs'), dig(found, 'test', 'variables')) == (['build'], {'A': '1', 'B': 'two'})
    assert dig(found, 'test', 'after') == Opaque('!reference')
    assert (load(b''), load(b'{"include": "a.yml"}')) == (None, {'include': 'a.yml'})


@pytest.mark.parametrize('data', [
    b'\xef\xbb\xbfinclude: a.yml\n',                          # a byte-order mark
    b'a: 1\rinclude: a.yml\n',                                # a lone carriage return
    'a: 1\u0085include: a.yml\n'.encode(),                   # NEL
    'a: 1\u2028include: a.yml\n'.encode(),                   # LINE SEPARATOR
    'a: 1\u2029include: a.yml\n'.encode(),                   # PARAGRAPH SEPARATOR
    'a: "\ufffd"\n'.encode(),                                 # a replacement character
    b'a: "\xff"\n',                                           # not UTF-8
    b'"\\u0069nclude": [a.yml]\n',                            # a key written with an escape
    b'{"\\u0069nclude": [{"local": "ci/agent.yml"}]}',        # the JSON form of it
], ids=['bom', 'lone cr', 'nel', 'u2028', 'u2029', 'ufffd', 'not utf-8', 'escaped key', 'escaped JSON key'])
def test_text_a_reader_and_gitlab_could_read_apart_is_refused(data: bytes) -> None:
    with pytest.raises(Unreadable):
        load(data)


def test_a_value_written_with_an_escape_is_marked() -> None:
    found = load(b'include:\n  - local: "ci/\\x2a.yml"\n  - local: "ci/plain.yml"\n')
    entries = dig(found, 'include')
    assert isinstance(entries, list)
    first, second = entries
    assert (type(dig(first, 'local')).__name__, dig(first, 'local'), type(dig(second, 'local'))) == (
        'Escaped', 'ci/*.yml', str)


@pytest.mark.parametrize('data', [
    b'a: &x 1\nb: *x\n', b'a: *x\n', b'<<: {include: a.yml}\n', b'a:\n  b: 1\n  b: 2\n', b'{"a": {"b": 1, "b": 2}}',
    b'a: 1\n---\nb: 2\n', b'a: !!python/name:os.system x\n', b'a: !custom x\n', b'? [a]\n: 1\n', b'"\\t": 1\n',
    b'a: [1\n', b'a: "x\n', 'k\u00e9y: 1\n'.encode(), b'a:\n\tb: 1\n',
], ids=['anchor and alias', 'alias', 'merge key', 'duplicate at depth', 'duplicate in JSON', 'two documents',
        'python tag', 'custom tag', 'complex key', 'control-character key', 'unclosed flow', 'unclosed quote',
        'non-ASCII key', 'tab'])
def test_what_could_hide_or_change_an_include_is_unreadable(data: bytes) -> None:
    with pytest.raises(Unreadable):
        load(data)


def test_too_large_or_too_deep_is_unreadable() -> None:
    with pytest.raises(Unreadable, match='too large'):
        load(b'a: ' + b'x' * MAX_BYTES)
    with pytest.raises(Unreadable, match='too deep'):
        load(b'a: ' + b'[' * (MAX_DEPTH + 2) + b']' * (MAX_DEPTH + 2))
