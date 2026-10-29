#!/usr/bin/env python3
# audit-detector: run by scripts/audit/run-all.sh
"""py_sfn_errors: Step Functions ``ErrorEquals`` names no Lambda of the task can report.

PATTERN (hunt-python class 6, fixed in 5.34): the research and document workflows retried on
``BedrockThrottlingException``; the Lambda raised ``BedrockThrottlingError``. A Python alias
(``BedrockThrottlingException = BedrockThrottlingError``) does not change ``__name__``, and Lambda reports
``errorType = type(error).__name__``, so the retry never fired and a throttled step failed at once.

HOW: every ``AWS::StepFunctions::StateMachine`` of the synthesized templates (py_assembly) is decoded:
an ``Fn::Join`` definition has its intrinsic pieces replaced by placeholders, a plain definition has its
``${Name}`` ``DefinitionSubstitutions`` resolved. Each Task state (Map / Parallel branches included) is
joined to the Lambda its ``FunctionName`` or ``Resource`` points at. Every ``Retry`` / ``Catch`` name that is
not a service prefix (``States.*``, ``Lambda.*``, ``Sandbox.*``) must equal the name of an exception class a
Python Lambda can report: a class DEFINED in its bundle (any module it ships) or a builtin exception.
A module-level alias (``Old = New``) does not count, and the finding names the class it aliases.

WHY THE REFERENCE TOOLS MISS IT: the CDK tests assert the retry EXISTS; nothing joins the ASL to the code.

FALSE POSITIVES: a name only a third-party library raises (botocore's ``ClientError`` is not defined in the
bundle) and a non-Python task (not judged, counted in the summary). Silence with
``{"key": "<stack>/<state machine>::<error name>", "reason": ...}`` in ``allowlists/py_sfn_errors.json``.

Run: ``voc-datalake/.venv/bin/python scripts/audit/py_sfn_errors.py [--json] [--refresh]``.
"""
from __future__ import annotations

import argparse
import ast
import builtins
import json
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

from audit_common import AuditError, Finding, detector_main, guard, run_main
from py_assembly import Assembly, emulate_bundle, load_assembly, python_modules, refs

TOOL = 'py_sfn_errors'
SERVICE_PREFIXES = ('States.', 'Lambda.', 'Sandbox.')
BUILTIN_ERRORS = frozenset(name for name, value in vars(builtins).items()
                           if isinstance(value, type) and issubclass(value, BaseException))
_PLACEHOLDER = '@@ref{}@@'
_PLACEHOLDER_RE = re.compile(r'@@ref\d+@@')
_SUBSTITUTION_RE = re.compile(r'\$\{(\w+)\}')


@dataclass
class Machine:
    rid: str                                   # "<stack>/<logicalId>"
    definition: dict
    placeholders: dict[str, object] = field(default_factory=dict)   # placeholder / ${Name} -> intrinsic


@dataclass
class BundleErrors:
    classes: set[str] = field(default_factory=set)
    aliases: dict[str, str] = field(default_factory=dict)   # alias name -> the class it binds


def _decode(rid: str, props: dict) -> Machine:
    raw = props.get('DefinitionString')
    placeholders: dict[str, object] = {}
    if isinstance(raw, dict) and isinstance(raw.get('Fn::Join'), list):
        parts = []
        for piece in raw['Fn::Join'][1]:
            if isinstance(piece, str):
                parts.append(piece)
            else:
                token = _PLACEHOLDER.format(len(placeholders))
                placeholders[token] = piece
                parts.append(token)
        text = str(raw['Fn::Join'][0]).join(parts)
    elif isinstance(raw, str):
        text = raw
        placeholders.update({f'${{{k}}}': v for k, v in (props.get('DefinitionSubstitutions') or {}).items()})
    else:
        raise AuditError(f'{rid}: definition is neither a string nor an Fn::Join')
    try:
        return Machine(rid, json.loads(text), placeholders)
    except ValueError as error:
        raise AuditError(f'{rid}: definition is not JSON once its intrinsics are replaced ({error})') from error


def machines(assembly: Assembly) -> Iterator[Machine]:
    for stack, template in sorted(assembly.templates.items()):
        for logical, resource in sorted(template.get('Resources', {}).items()):
            if resource.get('Type') == 'AWS::StepFunctions::StateMachine':
                yield _decode(f'{stack}/{logical}', resource.get('Properties', {}))


def states(definition: dict) -> Iterator[tuple[str, dict]]:
    """Every state, nested Map / Parallel states included."""
    for name, state in (definition.get('States') or {}).items():
        yield name, state
        for nested in [state.get('Iterator'), state.get('ItemProcessor'), *(state.get('Branches') or [])]:
            if isinstance(nested, dict):
                yield from states(nested)


def _targets(machine: Machine, state: dict, assembly: Assembly) -> set[str]:
    """Function ids a Task state invokes (``FunctionName`` parameter or a direct ``Resource`` ARN)."""
    text = json.dumps([state.get('Resource'), (state.get('Parameters') or {}).get('FunctionName')])
    tokens = {m.group(0) for m in _PLACEHOLDER_RE.finditer(text)}
    tokens |= {f'${{{name}}}' for name in _SUBSTITUTION_RE.findall(text)}
    stack = machine.rid.split('/', 1)[0]
    exports = assembly.exports()
    found = {rid for token in tokens for rid in refs(machine.placeholders.get(token), stack, exports)}
    return {rid for rid in found if rid in assembly.functions}


def _custom_names(state: dict) -> set[str]:
    names = {name for rule in [*(state.get('Retry') or []), *(state.get('Catch') or [])]
             for name in rule.get('ErrorEquals', [])}
    return {name for name in names if not name.startswith(SERVICE_PREFIXES)}


def _module_errors(src: Path) -> BundleErrors:
    tree = ast.parse(src.read_text(encoding='utf-8'))
    found = BundleErrors({node.name for node in ast.walk(tree) if isinstance(node, ast.ClassDef)})
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Name):
            for target in stmt.targets:
                if isinstance(target, ast.Name):
                    found.aliases[target.id] = stmt.value.id
    return found


class Judge:
    """Judges a state's custom names against the bundles it invokes (bundles and modules parsed once)."""

    def __init__(self, cdk_dir: Path, assembly: Assembly) -> None:
        self.cdk_dir, self.assembly = cdk_dir, assembly
        self.modules: dict[Path, BundleErrors] = {}
        self.bundles: dict[str, BundleErrors] = {}
        self.machines = self.judged = self.not_python = 0

    def errors_of(self, fid: str) -> BundleErrors:
        """Exception classes defined anywhere in ``fid``'s bundle, and module-level aliases of them."""
        if fid not in self.bundles:
            out = BundleErrors()
            for src in python_modules(emulate_bundle(self.cdk_dir, self.assembly.functions[fid])).values():
                if src not in self.modules:
                    self.modules[src] = _module_errors(src)
                module = self.modules[src]
                out.classes |= module.classes
                out.aliases.update(module.aliases)
            self.bundles[fid] = out
        return self.bundles[fid]

    def state(self, machine: Machine, state_name: str, state: dict) -> Iterator[Finding]:
        names = _custom_names(state)
        for fid in sorted(_targets(machine, state, self.assembly) if names else ()):
            fn = self.assembly.functions[fid]
            if not fn.is_python or fn.asset_source is None:
                self.not_python += 1
                continue
            errors = self.errors_of(fid)
            self.judged += len(names)
            for name in sorted(names - errors.classes - BUILTIN_ERRORS):
                alias = errors.aliases.get(name)
                hint = f'an alias of {alias}; Lambda reports {alias}' if alias else 'no such exception class'
                yield Finding('unknown-error-name', f'{machine.rid}::{name}', f'state {state_name} -> {fn.handler}: {hint}')


def findings(cdk_dir: Path, assembly: Assembly) -> tuple[list[Finding], Judge]:
    judge = Judge(cdk_dir, assembly)
    out: dict[str, Finding] = {}
    for machine in machines(assembly):
        judge.machines += 1
        for state_name, state in states(machine.definition):
            for finding in judge.state(machine, state_name, state):
                out.setdefault(finding.key, finding)
    return sorted(out.values(), key=lambda f: f.key), judge


def scan(args: argparse.Namespace) -> tuple[list[Finding], str]:
    assembly = load_assembly(args.cdk_dir, refresh=args.refresh)
    found, tally = findings(args.cdk_dir, assembly)
    guard(tally.machines >= 1 and tally.judged >= 1, f'{tally.machines} state machine(s), {tally.judged} names judged')
    return found, (f'{tally.machines} state machines, {tally.judged} custom error names judged, '
                   f'{tally.not_python} non-Python task(s) skipped')


main = detector_main(TOOL, __doc__, scan)


if __name__ == '__main__':
    run_main(main)
