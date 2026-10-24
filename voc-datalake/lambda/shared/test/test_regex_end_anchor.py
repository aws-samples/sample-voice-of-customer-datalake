"""No production regex ends a match with ``$`` outside MULTILINE mode: use ``\\Z``.

In Python, ``$`` without ``re.MULTILINE`` matches at the end of the string OR just before
a final newline, so ``re.match(r'^[a-z]+$', 'abc\\n')`` succeeds. A validator written that
way lets ``'abc\\n'`` through as a "safe" id: the raw-archive stem did, and an S3 key got a
newline in it. ``\\Z`` matches only at the very end (OpenSSF, "Correctly Using Regular
Expressions for Secure Input Validation"). In MULTILINE mode ``$`` means end of LINE and
is what a line-oriented pattern wants, so it stays allowed there.

Checked on the AST over every ``re.<function>(pattern, ...)`` call in production code with a
literal pattern (string, f-string text, ``+`` of literals). pydantic ``Field(pattern=...)``
is not checked: pydantic-core compiles it with Rust's regex, where ``$`` is end of input.
"""
import ast
import importlib
import re
from pathlib import Path

import pytest

LAMBDA_ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOTS = (LAMBDA_ROOT, LAMBDA_ROOT.parent / 'plugins')
_RE_FUNCTIONS = frozenset({'compile', 'match', 'fullmatch', 'search', 'sub', 'subn', 'split', 'findall', 'finditer'})
_MULTILINE_FLAGS = frozenset({'MULTILINE', 'M'})


def _is_production(path: Path) -> bool:
    parts = set(path.parts)
    return not (
        {'test', 'tests', 'node_modules', '.venv', 'python', 'cdk.out'} & parts
        or path.name.startswith('test_')
        or path.name == 'conftest.py'
    )


def _literal_text(node: ast.expr) -> str | None:
    """The literal text of a pattern argument (f-string placeholders dropped), or None."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return ''.join(part.value for part in node.values
                       if isinstance(part, ast.Constant) and isinstance(part.value, str))
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _literal_text(node.left), _literal_text(node.right)
        return None if left is None and right is None else (left or '') + (right or '')
    return None


def has_end_of_string_dollar(pattern: str) -> bool:
    """True when ``pattern`` holds an unescaped ``$`` outside a character class."""
    escaped = in_class = False
    for char in pattern:
        if escaped:
            escaped = False
        elif char == '\\':
            escaped = True
        elif in_class:
            in_class = char != ']'
        elif char == '[':
            in_class = True
        elif char == '$':
            return True
    return False


def _is_multiline(call: ast.Call, pattern: str) -> bool:
    if re.match(r'\(\?[aiLsux]*m', pattern):
        return True
    return any(isinstance(node, ast.Attribute) and node.attr in _MULTILINE_FLAGS
               for argument in [*call.args[1:], *(keyword.value for keyword in call.keywords)]
               for node in ast.walk(argument))


def offending_patterns(source: str) -> list[int]:
    """Line numbers of ``re.*`` calls in ``source`` whose literal pattern ends a match with ``$``."""
    lines = []
    for node in ast.walk(ast.parse(source)):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr in _RE_FUNCTIONS and isinstance(node.func.value, ast.Name)
                and node.func.value.id == 're' and node.args):
            continue
        pattern = _literal_text(node.args[0])
        if pattern is not None and has_end_of_string_dollar(pattern) and not _is_multiline(node, pattern):
            lines.append(node.lineno)
    return sorted(lines)


def _offenders() -> list[str]:
    return sorted(
        f'{path.relative_to(LAMBDA_ROOT.parent)}:{line}'
        for root in SOURCE_ROOTS
        for path in root.rglob('*.py')
        if _is_production(path)
        for line in offending_patterns(path.read_text(encoding='utf-8'))
    )


def test_no_production_regex_uses_dollar_as_its_end_anchor():
    assert _offenders() == []


def test_the_scan_covers_the_lambda_and_plugin_sources():
    scanned = {path.relative_to(LAMBDA_ROOT.parent).as_posix()
               for root in SOURCE_ROOTS for path in root.rglob('*.py') if _is_production(path)}
    assert {'lambda/shared/archive_keys.py', 'plugins/_shared/github_text.py'} <= scanned


@pytest.mark.parametrize(('source', 'lines'), [
    ("import re\nre.compile(r'^[a-z]+$')\n", [2]),
    ("import re\nre.match(r'(/|$)', 'x')\n", [2]),
    ("import re\nre.compile(rf'^{A}[0-9]{{2}}$')\n", [2]),
    ("import re\nre.compile(r'^a' + r'b$')\n", [2]),
    ("import re\nre.sub('-$', '', 'a-')\n", [2]),
    ("import re\nre.compile(PATTERN + '$')\n", [2]),
])
def test_a_dollar_end_anchor_is_reported(source: str, lines: list[int]):
    assert offending_patterns(source) == lines


@pytest.mark.parametrize('source', [
    "import re\nre.compile(r'^[a-z]+\\Z')\n",
    "import re\nre.compile(r'\\$\\d+')\n",
    "import re\nre.compile(r'[$]')\n",
    "import re\nre.compile(r'^x$', re.MULTILINE)\n",
    "import re\nre.compile(r'^x$', flags=re.M | re.I)\n",
    "import re\nre.compile(r'(?m)^x$')\n",
    "import re\nre.compile(PATTERN)\n",
    "x = '^a$'\n",
])
def test_an_exact_end_anchor_a_literal_dollar_or_multiline_mode_is_allowed(source: str):
    assert offending_patterns(source) == []


@pytest.mark.parametrize(('pattern', 'expected'), [
    ('a$', True), (r'a\$', False), ('[$]', False), (r'[\]$]', False), (r'[a]$', True), (r'\\$', True),
])
def test_the_dollar_detector_skips_escapes_and_character_classes(pattern: str, expected: bool):
    assert has_end_of_string_dollar(pattern) is expected


def test_the_reason_dollar_is_refused_holds_in_this_python():
    assert re.match(r'^[a-z]+$', 'abc\n') is not None
    assert re.match(r'^[a-z]+\Z', 'abc\n') is None


@pytest.mark.parametrize(('module', 'name', 'valid'), [
    ('shared.reprocess_jobs', 'JOB_ID_PATTERN', 'rp_0123456789ab'),
    ('shared.prototype_pins', '_FORM_ID_RE', 'pf_0123456789abcdef'),
    ('shared.company_context', '_DATE_RE', '2026-10-15'),
    ('shared.archive_keys', '_PLAIN_STEM_RE', 'abc'),
])
@pytest.mark.parametrize('ending', ['\n', '\r\n'])
def test_a_shared_validator_refuses_its_valid_value_with_a_trailing_newline(module: str, name: str, valid: str,
                                                                            ending: str):
    pattern = getattr(importlib.import_module(module), name)
    assert (pattern.match(valid) is not None, pattern.match(valid + ending)) == (True, None)
