"""The pure text analysis behind github_issues: version, signature, repro, component, PRs, markdown."""
import pytest

from _shared.github_text import (
    detect_component,
    error_signature,
    has_repro,
    linked_pull_requests,
    parse_software_version,
    strip_markdown,
)

FORM_BODY = """### Describe the bug

The chat panel freezes.

### Kiro version

0.4.2 (stable channel)

### Operating system

macOS 14.2.1

### Steps to reproduce

1. Open a project
2. Ask anything
"""


@pytest.mark.parametrize(
    ("body", "labels", "expected"),
    [
        # Issue-form section — the most confident source.
        (FORM_BODY, [], ("0.4.2", "form")),
        ("### Version\n\nv1.10.0\n", [], ("1.10.0", "form")),
        ("### App version\n\n2.0.0-beta.3\n", [], ("2.0.0-beta.3", "form")),
        # The form wins over a label and over the body.
        ("### Version\n\n1.2.3\n\nKiro 9.9.9", ["v5.0.0"], ("1.2.3", "form")),
        # An unanswered version field is not an answer; fall through.
        ("### Version\n\n_No response_\n", ["version:1.2"], ("1.2", "label")),
        # A version heading that names the environment is not the product's.
        ("### OS version\n\nmacOS 14.1\n", [], None),
        ("### Node version\n\n18.17.0\n", [], None),
        # A non-version answer under a version heading is not confident.
        ("### Version\n\nlatest\n", [], None),
        # Labels.
        ("", ["bug", "v1.2.3"], ("1.2.3", "label")),
        ("", ["version:1.2"], ("1.2", "label")),
        ("", ["version: 0.9.1"], ("0.9.1", "label")),
        ("", ["Version/3.1"], ("3.1", "label")),
        ("", ["bug", "needs-triage"], None),
        ("", ["v1"], None),
        # Labels win over the body.
        ("version: 1.0.0", ["v2.0.0"], ("2.0.0", "label")),
        # Body: `version: x.y.z`.
        ("I am on version: 2.0.1 today", [], ("2.0.1", "body")),
        ("version=3.4", [], ("3.4", "body")),
        ("Version: v1.0.0-rc.1", [], ("1.0.0-rc.1", "body")),
        # ... unless the word before "version" names the environment.
        ("Node version: 18.1.0", [], None),
        ("Python version: 3.12.1", [], None),
        # Body: `<product> x.y.z` for the configured / repo-derived product names.
        ("Running Kiro 0.4.2 on macOS 14.2.1", [], ("0.4.2", "body")),
        ("kiro v0.5.0 crashes", [], ("0.5.0", "body")),
        ("Kiro version 0.6.1", [], ("0.6.1", "body")),
        # Body: a bare v-prefixed three-part version.
        ("upgraded to v0.4.2 today", [], ("0.4.2", "body")),
        ("node v18.17.0 here", [], None),
        # Things that are not versions.
        ("ip 10.0.0.1 refused", [], None),
        ("I tried 2 times in 1.5 hours", [], None),
        ("macOS 14.2.1 only", [], None),
        ("", [], None),
        (None, [], None),
    ],
)
def test_parse_software_version(body, labels, expected):
    assert parse_software_version(body, labels, product_names=["Kiro"]) == expected


def test_a_product_name_is_only_used_when_configured():
    assert parse_software_version("Kiro 0.4.2", [], product_names=[]) is None
    assert parse_software_version("Acme 1.2.3", [], product_names=["Acme"]) == ("1.2.3", "body")


def test_a_product_name_is_matched_as_a_word():
    assert parse_software_version("SuperKiro 0.4.2", [], product_names=["Kiro"]) is None


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        (
            "```\nTraceback (most recent call last):\n  File \"/srv/app/x.py\", line 12, in run\n"
            "ValueError: invalid literal for int() with base 10: 'abc'\n```",
            "valueerror: invalid literal for int() with base <n>: <str>",
        ),
        (
            "Uncaught TypeError: Cannot read properties of undefined (reading 'id') at 12:3",
            "typeerror: cannot read properties of undefined (reading <str>) at <n>:<n>",
        ),
        ("error[E0382]: borrow of moved value: `x`", "error[e0382]: borrow of moved value: <str>"),
        ("panic: runtime error: index out of range [5] with length 3",
         "panic: runtime error: index out of range [<n>] with length <n>"),
        ("java.lang.IllegalStateException: Expected BEGIN_OBJECT at /tmp/a/b.json",
         "java.lang.illegalstateexception: expected begin_object at <path>"),
        ("Error: ENOENT: no such file or directory, open 'C:\\Users\\me\\a.txt'",
         "error: enoent: no such file or directory, open <str>"),
        ("Request 0xdeadbeef failed: Error: timeout after 3000ms", "error: timeout after <n>ms"),
        ("It throws an error sometimes, no idea why", None),
        ("Everything works", None),
        ("", None),
        (None, None),
    ],
)
def test_error_signature(body, expected):
    assert error_signature(body) == expected


def test_error_signatures_of_one_crash_with_different_values_are_equal():
    a = error_signature("TypeError: Cannot read properties of undefined (reading 'name') at line 40")
    b = error_signature("TypeError: Cannot read properties of undefined (reading 'id') at line 7")
    assert a == b


def test_code_blocks_are_searched_before_prose():
    body = "Error: something in prose\n\n```\nKeyError: 'session'\n```"
    assert error_signature(body) == "keyerror: <str>"


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        (FORM_BODY, True),
        ("### Steps to reproduce\n\n_No response_\n", False),
        ("### Reproduction\n\nRun `kiro --chat`", True),
        ("Steps to reproduce: click the button twice", True),
        ("Minimal repro: https://github.com/me/repro", True),
        ("It just broke.", False),
        (None, False),
    ],
)
def test_has_repro(body, expected):
    assert has_repro(body) is expected


@pytest.mark.parametrize(
    ("labels", "body", "expected"),
    [
        (["bug", "area: Editor"], "", "editor"),
        (["component/chat-panel"], "", "chat-panel"),
        (["area:auth"], "### Component\n\nBilling\n", "auth"),
        ([], "### Component\n\nChat panel\nmore text", "chat panel"),
        ([], "### Which part of the app?\n\nSettings", "settings"),
        ([], "### Component\n\n_No response_\n", None),
        (["bug"], "nothing", None),
    ],
)
def test_detect_component(labels, body, expected):
    assert detect_component(labels, body) == expected


def test_linked_pull_requests_counts_pr_links_not_bare_references():
    text = (
        "Fixed by https://github.com/o/r/pull/12 and PR #7; see also #9 and "
        "https://github.com/other/repo/pull/99 and pull request #7 again"
    )
    assert linked_pull_requests(text, "o/r") == [7, 12]
    assert linked_pull_requests(None, "o/r") == []


def test_strip_markdown_keeps_the_words_and_drops_the_markup():
    markdown = (
        "## Title\n<!-- template comment -->\nSome **bold**, _em_ and [a link](http://x) "
        "`code` snake_case_name\n![shot](a.png)\n| a | b |\n|---|---|\n| 1 | 2 |\n> quoted\n_No response_\n"
    )
    assert strip_markdown(markdown, 500) == (
        "Title\n\nSome bold, em and a link code snake_case_name\n\na b\n\n1 2\nquoted"
    )

