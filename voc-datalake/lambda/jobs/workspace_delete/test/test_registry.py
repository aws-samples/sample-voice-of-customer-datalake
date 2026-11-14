"""The hard delete's registry in lockstep with the code (jobs/workspace_delete/sweeps.py):

* ``SWEEPS`` and lib/utils/workspace-delete-grants.ts ``WORKSPACE_DELETE_GRANTS`` name the same sweeps, in order;
* ``FAMILIES`` names every key family of a workspace the code builds, with its sweep or why it is kept (``KEPT``) or
  expires (``TTL``): each of shared/ws_repo.py's builders (a public function taking a ``WorkspaceScope``), and each
  ``scope.key(<first part>, …)`` outside the layer, by its first part (a literal, or a module constant), or by its
  function when the part is a variable. A new family fails here until it has an entry, and an entry no code builds any
  more fails too.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Final

from jobs.workspace_delete.sweeps import SWEEPS, WORK_PARTITION
from jobs.workspace_delete.test.families import FAMILIES

# The production modules the raw-access guard scans (lambda/ and plugins/, tests and layers left out): the same set.
from shared.test.test_ws_raw_access import _modules

ROOT: Final = Path(__file__).resolve().parents[4]
LAYER: Final = ROOT / 'lambda/shared/ws_repo.py'
GRANTS: Final = ROOT / 'lib/utils/workspace-delete-grants.ts'
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


def _is_scope(node: ast.AST) -> bool:
    return (isinstance(node, ast.Name) and node.id == 'scope') or (isinstance(node, ast.Attribute)
                                                                   and node.attr == 'scope')


def _families_built_outside_the_layer() -> set[str]:
    trees = {path: ast.parse(path.read_text(encoding='utf-8')) for path in _modules()}
    # The layer's constants resolve a part named by one (WATERMARK_DIRECTORY); its own calls are its builders'.
    constants = _constants(list(trees.values()))
    found: set[str] = set()
    for path, tree in trees.items():
        if path == LAYER:
            continue
        for function in [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)]:
            nested = {id(inner) for child in function.body for inner in ast.walk(child)
                      if isinstance(inner, ast.FunctionDef)}
            for call in ast.walk(function):
                if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr == 'key'
                        and _is_scope(call.func.value) and call.args):
                    continue
                first = call.args[0]
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    found.add(first.value)
                elif isinstance(first, ast.Name) and len(constants.get(first.id, set())) == 1:
                    found.add(next(iter(constants[first.id])))
                elif not any(call in ast.walk(inner) for inner in ast.walk(function)
                             if id(inner) in nested):
                    # A variable part: the family is its function's (the innermost one that builds it).
                    found.add(function.name)
    return found


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
    built = _layer_builders() | _families_built_outside_the_layer()
    assert sorted(built - set(FAMILIES)) == [], 'a key family without a sweep entry or a KEPT / TTL reason'


def test_no_family_entry_outlives_its_code():
    built = _layer_builders() | _families_built_outside_the_layer()
    assert sorted(set(FAMILIES) - built) == [], 'an entry no code builds any more'


def test_each_entry_names_a_sweep_or_says_why_it_stays():
    sweeps = {sweep.name for sweep in SWEEPS} | {WORK_PARTITION}
    assert sorted(name for name, entry in FAMILIES.items()
                  if entry not in sweeps and not entry.startswith(('KEPT: ', 'TTL: '))) == []


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
                       'watermarks': 'watermarks', 'memory': 'memory', 'bucket': 'objects', 'workspaces': 'controlRows'}


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
        assert extra <= {'metricTypeIndex', 'deploymentSettings', 'exportJobs', 'objects', 'aggregates'}, (
            sweep.name, extra)


def test_the_memory_enumeration_is_the_exports_too():
    """The export's counts and the delete read the same memory partitions (shared/memory_partitions.py)."""
    for module in ('lambda/jobs/workspace_export/memory.py', 'lambda/jobs/workspace_delete/sweeps.py'):
        source = (ROOT / module).read_text(encoding='utf-8')
        assert 'from shared.memory_partitions import' in source, module
        called = {node.func.id for node in ast.walk(ast.parse(source))
                  if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
        assert not called & {'memory_status_pk', 'memory_cursor_pk'}, module
