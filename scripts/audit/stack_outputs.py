#!/usr/bin/env python3
# audit-detector: run by scripts/audit/run-all.sh
"""stack_outputs: CloudFormation outputs that scripts and docs read but no stack declares.

PATTERN (5.34: ``frontend/scripts/deploy.sh`` and ``voc-datalake/scripts/test-api.sh`` read ``ChatStreamUrl``
for years after the stream moved behind API Gateway). A script asks ``describe-stacks`` for an output by its
key; when no stack emits that key the query answers empty, the script falls back or writes an empty value, and
nothing fails. The CDK tests never see the script, and the script never sees the stack.

KIND. ``read-not-declared``: a key read in a ``*.sh`` / ``*.mjs`` / ``*.js`` / ``*.ts`` / ``*.py`` / ``*.yml``
/ ``*.md`` file that no ``new cdk.CfnOutput(<scope>, '<Key>'`` in ``voc-datalake/lib`` or ``bin`` declares.
Key = the output key.

HOW. A read is ``OutputKey==\"X\"`` / ``OutputKey=='X'`` / ``OutputKey==`X``` (jq, JMESPath), Python
``.get('OutputKey') == 'X'``, or a literal argument of a HELPER that compares ``OutputKey`` to one of its
parameters: a shell function comparing it to ``$N`` (``cfn_output "$STACK" ApiEndpoint``) or a Python function
comparing it to (or indexing an output map by) a named parameter (``_stack_output(cf, stack, 'FeedbackTableName')``).
A declared id written as a template literal (``InboundEmailDkimRecord${n}``) declares every key with that prefix;
a read through ``contains("X")`` matches any declared key containing X. A reverse "declared, never read" pass
would be noise (most outputs are for operators reading the console), so there is none.

FALSE POSITIVES: an output of a stack outside this repo (a bootstrap stack). Silence with
``{"key": "<Key>", "reason": ...}`` in ``scripts/audit/allowlists/stack_outputs.json``.

Run: ``voc-datalake/.venv/bin/python scripts/audit/stack_outputs.py [--json]`` (no synth needed).
"""
from __future__ import annotations

import ast
import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

from audit_common import Finding, guard, iter_files, parse_repo_cli, report, run_main

TOOL = 'stack_outputs'
READ_SUFFIXES = ('.sh', '.mjs', '.js', '.ts', '.py', '.yml', '.yaml', '.md')
_DECLARED = re.compile(r"CfnOutput\(\s*\w+\s*,\s*(?:'(\w+)'|\"(\w+)\"|`(\w*)\$\{)")
_DIRECT = re.compile(r"""OutputKey['"]?\)?\s*==\s*(?:"(\w+)"|'(\w+)'|`(\w+)`)""")
_CONTAINS = re.compile(r"""OutputKey\s*\|\s*contains\(\s*"(\w+)"\s*\)""")
_SHELL_HELPER = re.compile(r'^\s*(\w+)\s*\(\)\s*\{(.*?)^\s*\}', re.MULTILINE | re.DOTALL)
_SHELL_PARAM = re.compile(r"""OutputKey==['"]?\$(\d)""")


@dataclass(frozen=True)
class Read:
    key: str
    where: str
    contains: bool = False   # `contains("X")`: any declared key with X in it


def declared_outputs(repo: Path) -> tuple[set[str], set[str]]:
    """(exact keys, key prefixes) every ``CfnOutput`` in the CDK app declares."""
    exact: set[str] = set()
    prefixes: set[str] = set()
    for _, file in iter_files(repo, ['voc-datalake/lib', 'voc-datalake/bin'], ('.ts',), include_tests=False):
        for match in _DECLARED.finditer(file.read_text(encoding='utf-8')):
            if match.group(3) is not None:
                prefixes.add(match.group(3))
            else:
                exact.add(match.group(1) or match.group(2))
    return exact, prefixes


def _shell_helper_reads(text: str, rel: str) -> Iterator[Read]:
    for helper in _SHELL_HELPER.finditer(text):
        param = _SHELL_PARAM.search(helper.group(2))
        if not param:
            continue
        index = int(param.group(1))
        # a call in command position (`$(output ApiId)`, a line start, after `;` / `&&`), not `--output text`
        for call in re.finditer(rf'(?:\$\(|^|[;&|])[ \t]*{helper.group(1)}[ \t]+([^\n)]*)', text[helper.end():], re.MULTILINE):
            args = call.group(1).split()
            if len(args) >= index and re.fullmatch(r"['\"]?(\w+)['\"]?", args[index - 1]):
                yield Read(args[index - 1].strip('\'"'), rel)


def _compares_output_key_to(func: ast.FunctionDef) -> str | None:
    """The parameter a Python helper compares ``OutputKey`` to (or indexes an ``OutputKey`` map by)."""
    params = {a.arg for a in func.args.args}
    if 'OutputKey' not in ast.unparse(func):
        return None
    for node in ast.walk(func):
        names = [n.id for n in ast.walk(node) if isinstance(n, ast.Name) and n.id in params]
        if isinstance(node, ast.Compare | ast.Subscript) and names and 'OutputKey' in ast.unparse(node):
            return names[0]
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'get' \
                and node.args and isinstance(node.args[0], ast.Name) and node.args[0].id in params:
            return node.args[0].id
    return None


def _python_helper_reads(text: str, rel: str) -> Iterator[Read]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return
    helpers: dict[str, int] = {}
    for func in ast.walk(tree):
        if isinstance(func, ast.FunctionDef) and (param := _compares_output_key_to(func)):
            helpers[func.name] = [a.arg for a in func.args.args].index(param)
    for call in ast.walk(tree):
        if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id in helpers:
            index = helpers[call.func.id]
            if index < len(call.args) and isinstance(arg := call.args[index], ast.Constant) \
                    and isinstance(arg.value, str):
                yield Read(arg.value, f'{rel}:{call.lineno}')


def reads_in(repo: Path) -> tuple[list[Read], int]:
    found: list[Read] = []
    scanned = 0
    for rel, file in iter_files(repo, ['.'], READ_SUFFIXES, include_tests=False,
                                exclude=['scripts/audit/**', 'CHANGELOG.md', 'docs/history/**']):
        text = file.read_text(encoding='utf-8', errors='ignore')
        if 'OutputKey' not in text:
            continue
        scanned += 1
        for match in _DIRECT.finditer(text):
            line = text.count('\n', 0, match.start()) + 1
            found.append(Read(next(g for g in match.groups() if g), f'{rel}:{line}'))
        found.extend(Read(m.group(1), rel, contains=True) for m in _CONTAINS.finditer(text))
        if rel.endswith('.sh'):
            found.extend(_shell_helper_reads(text, rel))
        if rel.endswith('.py'):
            found.extend(_python_helper_reads(text, rel))
    return found, scanned


def is_declared(read: Read, exact: set[str], prefixes: set[str]) -> bool:
    if read.contains:
        return any(read.key in key for key in exact | prefixes)
    return read.key in exact or any(read.key.startswith(prefix) for prefix in prefixes)


def findings(reads: Iterable[Read], exact: set[str], prefixes: set[str]) -> list[Finding]:
    by_key: dict[str, list[str]] = {}
    for read in reads:
        if not is_declared(read, exact, prefixes):
            by_key.setdefault(read.key, []).append(read.where)
    return [Finding('read-not-declared', key, f'read in {", ".join(sorted(set(where)))}; no stack declares it')
            for key, where in sorted(by_key.items())]


def main(argv: list[str] | None = None) -> int:
    args = parse_repo_cli(__doc__, argv)
    exact, prefixes = declared_outputs(args.root)
    reads, scanned = reads_in(args.root)
    guard(len(exact) >= 40, f'only {len(exact)} declared outputs')
    guard(len(reads) >= 10, f'only {len(reads)} output reads')
    return report(TOOL, findings(reads, exact, prefixes), as_json=args.json, use_allowlist=not args.no_allowlist,
                  summary=f'{len(reads)} output reads in {scanned} files against {len(exact)} declared outputs')


if __name__ == '__main__':
    run_main(main)
