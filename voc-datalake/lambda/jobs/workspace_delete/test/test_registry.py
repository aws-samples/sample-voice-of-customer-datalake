"""The hard delete's registry in lockstep with the code (jobs/workspace_delete/sweeps.py):

* ``SWEEPS`` and lib/utils/workspace-delete-grants.ts ``WORKSPACE_DELETE_GRANTS`` name the same sweeps, in order;
* ``FAMILIES`` names every key family of a workspace the code builds, with its sweep, or why it is kept (``KEPT``),
  expires (``TTL``), waits for a reserved entry (``RESERVED``) or is not reached yet (``GAP``, at most ``MAX_GAPS``):
  each of shared/ws_repo.py's builders (a public function taking a ``WorkspaceScope``), and, in one walk of the code
  outside the layer, each ``scope.key(<first part>, …)`` (or ``workspace.key``) by its first part (a literal, or a
  module constant) or by its function when the part is a variable; each workspace settings kind a settings builder
  names (``SETTINGS#{kind}``), a kind that is neither resolved nor passed on from the function's own parameter
  failing; and each function that calls shared/scoped_keys.py ``scoped_pk``, by its name. A new family fails here
  until it has an entry, and an entry no code builds any more fails too.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Final

from jobs.workspace_delete.sweeps import SWEEPS, WORK_PARTITION
from jobs.workspace_delete.test.families import FAMILIES, MAX_GAPS

# The production modules the raw-access guard scans (lambda/ and plugins/, tests and layers left out): the same set.
from shared.test.test_ws_raw_access import _modules

ROOT: Final = Path(__file__).resolve().parents[4]
LAYER: Final = ROOT / 'lambda/shared/ws_repo.py'
SCOPED_KEYS: Final = ROOT / 'lambda/shared/scoped_keys.py'
GRANTS: Final = ROOT / 'lib/utils/workspace-delete-grants.ts'
#: The calls that build or read a workspace's settings key (``WS#{ws}#SETTINGS#{kind}``, shared/workspace_settings.py)
#: from a kind, and the position of the kind: a literal or module-constant kind is a family ``SETTINGS#{kind}``; a
#: kind its function was given is its callers' (scanned too); a class built with one may pass ``self.<attr>`` on.
SETTINGS_BUILDERS: Final = {'settings_key': 1, 'get_config_item': 1, 'put_config_item': 1, '_put_config_row': 0,
                            '_ScopedReader': 1}
#: The names a workspace scope goes by where ``.key(…)`` builds a key of it.
SCOPE_NAMES: Final = frozenset({'scope', 'workspace'})
#: The reasons an entry may give instead of a sweep.
REASONS: Final = ('KEPT: ', 'TTL: ', 'RESERVED: ', 'GAP: ')
#: Public functions of the layer that take a scope but build no key.
NOT_KEYS: Final = {'control_query': 'a read', 'workspace_is_active': 'a read', 'ws_table': 'a view'}


def _constants(trees: list[ast.Module]) -> dict[str, set[str]]:
    """Every module-level ``NAME = '…'`` (or ``NAME: Final = '…'``) of the scanned code, by name."""
    constants: dict[str, set[str]] = {}
    for tree in trees:
        for node in tree.body:
            target, value = None, None
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                target, value = node.targets[0].id, node.value
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                target, value = node.target.id, node.value
            if target and isinstance(value, ast.Constant) and isinstance(value.value, str):
                constants.setdefault(target, set()).add(value.value)
    return constants


def _tuple_constants(trees: list[ast.Module]) -> dict[str, tuple[str, ...]]:
    """Every module-level tuple of string literals (``NAMES: Final = ('a', 'b')``), by name."""
    found: dict[str, tuple[str, ...]] = {}
    for tree in trees:
        for node in tree.body:
            target = node.targets[0] if isinstance(node, ast.Assign) and len(node.targets) == 1 else (
                node.target if isinstance(node, ast.AnnAssign) else None)
            value = node.value if isinstance(node, ast.Assign | ast.AnnAssign) else None
            if (isinstance(target, ast.Name) and isinstance(value, ast.Tuple) and value.elts
                    and all(isinstance(elt, ast.Constant) and isinstance(elt.value, str) for elt in value.elts)):
                found[target.id] = tuple(str(elt.value) for elt in value.elts if isinstance(elt, ast.Constant))
    return found


def _is_scope(node: ast.AST) -> bool:
    return (isinstance(node, ast.Name) and node.id in SCOPE_NAMES) or (isinstance(node, ast.Attribute)
                                                                       and node.attr in SCOPE_NAMES)


def _called(call: ast.Call) -> str:
    return call.func.attr if isinstance(call.func, ast.Attribute) else getattr(call.func, 'id', '')


def _functions(tree: ast.Module) -> list[tuple[ast.FunctionDef, str | None]]:
    """Every function of ``tree`` with the class it is a method of (None for a plain function)."""
    found: list[tuple[ast.FunctionDef, str | None]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            found += [(child, node.name) for child in node.body if isinstance(child, ast.FunctionDef)]
    methods = {id(function) for function, _owner in found}
    return found + [(node, None) for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
                    and id(node) not in methods]


class _Walk:
    """One walk of the code outside the layer: the families it builds, and the settings calls it cannot resolve."""

    def __init__(self) -> None:
        self.trees = {path: ast.parse(path.read_text(encoding='utf-8')) for path in _modules()}
        # The layer's constants resolve a part named by one (WATERMARK_DIRECTORY); its own calls are its builders'.
        self.constants = _constants(list(self.trees.values()))
        self.tuples = _tuple_constants(list(self.trees.values()))
        self.found: set[str] = set()
        self.unresolved: list[str] = []
        for path, tree in self.trees.items():
            if path == LAYER:
                continue
            for function, owner in _functions(tree):
                self._function(path, function, owner)

    def _resolved(self, node: ast.AST) -> str | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.Name) and len(self.constants.get(node.id, set())) == 1:
            return next(iter(self.constants[node.id]))
        return None

    def _function(self, path: Path, function: ast.FunctionDef, owner: str | None) -> None:
        nested = {id(inner) for child in function.body for inner in ast.walk(child) if isinstance(inner, ast.FunctionDef)}
        own_calls = [call for call in ast.walk(function) if isinstance(call, ast.Call)
                     and not any(call in ast.walk(inner) for inner in ast.walk(function) if id(inner) in nested)]
        parameters = {argument.arg for argument in (*function.args.args, *function.args.kwonlyargs)}
        # A comprehension's variable over a module tuple of kinds (``for kind in KINDS``) names each of them.
        looped = {generator.target.id: self.tuples[generator.iter.id] for generator in ast.walk(function)
                  if isinstance(generator, ast.comprehension) and isinstance(generator.target, ast.Name)
                  and isinstance(generator.iter, ast.Name) and generator.iter.id in self.tuples}
        for call in own_calls:
            name = _called(call)
            if (isinstance(call.func, ast.Attribute) and name == 'key' and _is_scope(call.func.value) and call.args
                    and path != SCOPED_KEYS):
                # A variable part: the family is its function's (the innermost one that builds it).
                self.found.add(self._resolved(call.args[0]) or function.name)
            elif name == 'scoped_pk' and path != SCOPED_KEYS:
                self.found.add(function.name)
            elif name in SETTINGS_BUILDERS and len(call.args) > SETTINGS_BUILDERS[name]:
                kind = call.args[SETTINGS_BUILDERS[name]]
                resolved = self._resolved(kind)
                if resolved is not None:
                    self.found.add(f'SETTINGS#{resolved}')
                elif isinstance(kind, ast.Name) and kind.id in looped:
                    self.found.update(f'SETTINGS#{each}' for each in looped[kind.id])
                elif not ((isinstance(kind, ast.Name) and kind.id in parameters)
                          or (isinstance(kind, ast.Attribute) and isinstance(kind.value, ast.Name)
                              and kind.value.id == 'self' and owner in SETTINGS_BUILDERS)):
                    self.unresolved.append(f'{path.relative_to(ROOT)}:{call.lineno} {name}({ast.unparse(kind)})')


_WALK: Final = _Walk()


def _built() -> set[str]:
    return _layer_builders() | _WALK.found


def _layer_builders() -> set[str]:
    tree = ast.parse(LAYER.read_text(encoding='utf-8'))
    return {node.name for node in tree.body if isinstance(node, ast.FunctionDef) and not node.name.startswith('_')
            and node.args.args and isinstance(node.args.args[0].annotation, ast.Name)
            and node.args.args[0].annotation.id == 'WorkspaceScope' and node.name not in NOT_KEYS}


def test_the_sweeps_and_the_cdk_grants_name_the_same_sweeps_in_order():
    source = GRANTS.read_text(encoding='utf-8')
    block = re.search(r'WORKSPACE_DELETE_GRANTS[^=]*=\s*\{(.*?)\n\};', source, re.DOTALL)
    assert block is not None
    named = re.findall(r'^\s*([a-z_]+):', block.group(1), re.MULTILINE)
    assert named == [sweep.name for sweep in SWEEPS]


def test_each_sweep_is_named_once():
    names = [sweep.name for sweep in SWEEPS]
    assert len(names) == len(set(names))
    assert WORK_PARTITION not in names


def test_every_key_family_the_code_builds_has_a_sweep_or_a_reason():
    assert sorted(_built() - set(FAMILIES)) == [], 'a key family without a sweep entry or a reason'


def test_every_settings_kind_is_resolved_or_passed_on():
    """A settings builder's kind is a literal, a module constant, or its function's own parameter (or a builder
    class's attribute): anything else names a kind this scan cannot see."""
    assert _WALK.unresolved == []


def test_no_family_entry_outlives_its_code():
    assert sorted(set(FAMILIES) - _built()) == [], 'an entry no code builds any more'


def test_each_entry_names_a_sweep_or_says_why_it_stays():
    sweeps = {sweep.name for sweep in SWEEPS} | {WORK_PARTITION}
    assert sorted(name for name, entry in FAMILIES.items()
                  if entry not in sweeps and not entry.startswith(REASONS)) == []


def test_the_gaps_only_shrink():
    assert len([entry for entry in FAMILIES.values() if entry.startswith('GAP: ')]) <= MAX_GAPS


def test_the_reserved_entries_are_held_for_voc_lead():
    source = (ROOT / 'lambda/jobs/workspace_delete/sweeps.py').read_text(encoding='utf-8')
    assert "owner_list_sweep('conversations'" in source
    assert 'WS#{ws}#CONVERSANTS' in source
    assert "Sweep('projects'" in source
    assert 'WS#{ws}#PROJECT_IDS' in source
    assert "Sweep('mcp_tokens'" in source
    assert 'WS#{ws}#MCPTOKENS' in source


#: What an entry's table needs of the grants, and what each hook needs (the inventory and the tombstones live in
#: voc-aggregates).
TABLE_GRANTS: Final = {'ssm': 'credentials', 'feedback': 'feedback', 'aggregates': 'aggregates',
                       'watermarks': 'watermarks', 'memory': 'memory', 'bucket': 'objects', 'workspaces': 'controlRows',
                       'radar': 'radar'}


def _cdk_grants() -> dict[str, list[str]]:
    source = GRANTS.read_text(encoding='utf-8')
    block = re.search(r'WORKSPACE_DELETE_GRANTS[^=]*=\s*\{(.*?)\n\};', source, re.DOTALL)
    assert block is not None
    return {name: re.findall(r"'([A-Za-z]+)'", grants)
            for name, grants in re.findall(r'^\s*([a-z_]+):\s*\[([^\]]*)\]', block.group(1), re.MULTILINE)}


def test_each_entry_declares_exactly_the_grants_the_cdk_gives_it():
    cdk = _cdk_grants()
    assert {sweep.name: list(sweep.grants) for sweep in SWEEPS} == cdk


def test_each_entry_holds_the_grants_its_table_and_its_hooks_need():
    for sweep in SWEEPS:
        needed = {TABLE_GRANTS[sweep.table], *(('tombstones',) if sweep.tombstone else ()),
                  *(('aggregates',) if sweep.note else ())}
        assert needed <= set(sweep.grants), sweep.name
        # No entry holds a grant its table and hooks do not explain, but the ones it reads or writes beside them.
        extra = set(sweep.grants) - needed
        assert extra <= {'metricTypeIndex', 'exportJobs', 'objects', 'aggregates'}, (
            sweep.name, extra)


def test_the_memory_enumeration_is_the_exports_too():
    """The export's counts and the delete read the same memory partitions (shared/memory_partitions.py)."""
    for module in ('lambda/jobs/workspace_export/memory.py', 'lambda/jobs/workspace_delete/sweeps.py'):
        source = (ROOT / module).read_text(encoding='utf-8')
        assert 'from shared.memory_partitions import' in source, module
        called = {node.func.id for node in ast.walk(ast.parse(source))
                  if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
        assert not called & {'memory_status_pk', 'memory_cursor_pk'}, module
