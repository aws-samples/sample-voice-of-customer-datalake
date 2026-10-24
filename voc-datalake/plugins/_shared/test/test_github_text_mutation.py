"""Mutation hardening for `_shared/github_text.py`.

`github_issues/test/test_github_text.py` pins the headline cases (form beats
label beats body, a crash normalises to one signature, a component label wins),
but a mutation run found what it could not see:

* the ENVIRONMENT word list: only a handful of words (node, python, macos) were
  exercised, so dropping ``"rust"`` or ``".net"`` from it — which would put a
  toolchain version on a product's release trend — passed. Every word is pinned
  here, through the form-heading check that reads all of them.
* every markdown rule one by one (multi-line comments, autolinks, inline HTML,
  ``*em*``, task lists, collapsed blank lines, CRLF) and the exact output of a
  kept code-block head, including the 5-line boundary and the ``…`` marker.
* the exact caps and boundaries: the 24-character look-back for an environment
  word, the 160-character signature, the 1,000-character line skip, the
  60-character component, the 50 linked PRs and ``strip_markdown``'s cap at
  ``len == cap``, ``cap - 1`` and ``cap`` 0/1.
* each signature mask (url, uuid, ``0x`` hex, long hex, whitespace).
"""
import pytest

from _shared.github_text import (
    detect_component,
    error_signature,
    linked_pull_requests,
    parse_software_version,
    strip_markdown,
)


class TestEveryEnvironmentWordDisqualifiesAVersionHeading:
    @pytest.mark.parametrize('word', [
        '.net', 'android', 'browser', 'cargo', 'chrome', 'chromium', 'code', 'debian',
        'docker', 'dotnet', 'edge', 'electron', 'fedora', 'firefox', 'git', 'go', 'ios',
        'java', 'jdk', 'kernel', 'linux', 'macos', 'node', 'node.js', 'nodejs', 'npm',
        'os', 'osx', 'php', 'pip', 'pnpm', 'python', 'ruby', 'rust', 'safari', 'system',
        'ubuntu', 'vscode', 'win', 'windows', 'yarn',
    ])
    def test_a_heading_naming_the_environment_is_not_the_product_version(self, word):
        assert parse_software_version(f'### {word} version\n\n1.2.3\n') is None

    def test_operating_in_the_heading_disqualifies_it(self):
        assert parse_software_version('### Operating version\n\n1.2.3\n') is None

    def test_a_heading_without_version_is_not_read(self):
        assert parse_software_version('### Release\n\n1.2.3\n') is None


class TestBodyVersionQualifiers:
    def test_the_look_back_for_an_environment_word_is_24_characters(self):
        assert parse_software_version('node' + ' ' * 20 + 'version: 1.2.3') is None
        assert parse_software_version('node' + ' ' * 21 + 'version: 1.2.3') == ('1.2.3', 'body')

    def test_an_empty_product_name_is_skipped_not_the_end_of_the_list(self):
        assert parse_software_version('Acme 1.2.3', [], ['', 'Acme']) == ('1.2.3', 'body')


class TestEveryMarkdownRule:
    @pytest.mark.parametrize(('markdown', 'expected'), [
        (None, ''),
        ('a <!--\nhidden\n--> b', 'a b'),
        ('see <https://x.io/a>', 'see https://x.io/a'),
        ('a <kbd>Ctrl</kbd> b', 'a Ctrl b'),
        ('an *em* word', 'an em word'),
        ('- [x] done\n- [ ] todo', '- done\n- todo'),
        ('a\n\n\n\nb', 'a\n\nb'),
        ('a\r\n\r\n\r\nb', 'a\n\nb'),
    ])
    def test_rule(self, markdown, expected):
        assert strip_markdown(markdown, 100) == expected

    def test_a_five_line_code_block_is_kept_whole(self):
        markdown = '```\nl0\nl1\nl2\nl3\nl4\n```\nafter'
        assert strip_markdown(markdown, 100) == 'l0\nl1\nl2\nl3\nl4\n\nafter'

    def test_a_six_line_code_block_keeps_five_and_an_ellipsis(self):
        markdown = '```\nl0\nl1\nl2\nl3\nl4\nl5\n```\nafter'
        assert strip_markdown(markdown, 100) == 'l0\nl1\nl2\nl3\nl4\n…\n\nafter'


class TestStripMarkdownCap:
    @pytest.mark.parametrize(('markdown', 'cap', 'expected'), [
        ('abcde', 5, 'abcde'),
        ('abcdef', 5, 'abcd…'),
        ('abc', 1, '…'),
        ('abc', 0, '…'),
    ])
    def test_cap(self, markdown, cap, expected):
        assert strip_markdown(markdown, cap) == expected


class TestEverySignatureMask:
    @pytest.mark.parametrize(('body', 'expected'), [
        ('Error: failed https://x.io/a/1', 'error: failed <url>'),
        ('Error: job 123e4567-e89b-12d3-a456-426614174000 lost', 'error: job <id> lost'),
        ('Error: at 0xDEADBEEF', 'error: at <hex>'),
        ('Error: commit deadbeefcafe1234', 'error: commit <hex>'),
        ('Error: a   b\tc', 'error: a b c'),
        ('TypeError: boom\r\nmore', 'typeerror: boom'),
        ('first\n\nError: boom', 'error: boom'),
    ])
    def test_mask(self, body, expected):
        assert error_signature(body) == expected

    def test_a_signature_is_capped_at_160_characters(self):
        assert error_signature('Error: ' + 'z' * 300) == 'error: ' + 'z' * 153

    def test_a_line_of_1000_characters_is_read_and_1001_is_skipped(self):
        assert error_signature('Error: ' + 'z' * 993) == 'error: ' + 'z' * 153
        assert error_signature('Error: ' + 'z' * 994) is None


class TestComponent:
    @pytest.mark.parametrize(('labels', 'body', 'expected'), [
        (['area: ' + 'a' * 80], '', 'a' * 60),
        (['area: chat\t\tpanel'], '', 'chat panel'),
        (['area: Xbox'], '', 'xbox'),
        (['area: `editor`.'], '', 'editor'),
        ([], '### Describe the bug\n\nIt crashes\n', None),
    ])
    def test_component(self, labels, body, expected):
        assert detect_component(labels, body) == expected


def test_at_most_50_linked_pull_requests_lowest_first():
    text = ' '.join(f'PR #{n}' for n in range(60, 0, -1))
    assert linked_pull_requests(text, 'o/r') == list(range(1, 51))
