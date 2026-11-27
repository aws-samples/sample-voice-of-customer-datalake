"""Guard of the reprocess day walk's completeness (lambda/shared/reprocess_slices.py ``walk_days`` / ``read_day_page``).

A workspace's category reprocess reads voc-feedback's gsi1-by-date one day partition at a time instead of a Scan. It
finds every review only while two facts hold:

(a) a review's ``gsi1pk`` day is the day the processor processed it, stamped by the processor's first put alone
    (lambda/processor/handler.py ``build_feedback_item``, put by ``write_to_dynamodb`` on ``attribute_not_exists(pk)``);
    the IAM half, that only the processor's role may put an item there, is lib/customer-data-deletes.test.ts
    "voc-feedback: only the processor puts an item";
(b) nothing rewrites ``gsi1pk`` / ``gsi1sk`` (or ``date``) of a review afterwards.

So this scans every production module of lambda/ and plugins/ (never a test) for a write of ``gsi1pk`` or ``gsi1sk``:
a dict key (an item, an attribute map), a subscript store or delete, a keyword argument, a name added to a list by
a mutator, a string naming them outside a key condition, a filter, a projection or a condition (an UpdateExpression's
``SET`` / ``REMOVE`` or a fragment of one), and an ``ExpressionAttributeNames`` value beside an ``UpdateExpression``.
Reads are left out (``Key('gsi1pk')``, ``row['gsi1sk']``, ``row.get(...)``, a bare name passed to a query helper, a
key condition's text, docstrings). Many other tables name their own index ``gsi1`` too, so each write found must be
one this file lists:

* ``FEEDBACK_DAY_STAMP``: the processor's first put, the only write meant for voc-feedback;
* ``OTHER_TABLES``: a module that never reaches voc-feedback (it names neither the table nor its day keys,
  ``REACHES_FEEDBACK``), with the table its writes go to;
* ``FEEDBACK_MODULE_ENTRIES``: in a module that does reach voc-feedback, each other function or constant, by name, with
  what it is (another table's write, or a list of names that is read, never written).

A new write anywhere, or one moved into another function of a module that reaches voc-feedback, fails here, naming the
walk: keep gsi1pk the processing day and never rewrite it, or make the walk Scan. For ``date`` only the update form
can be told apart (``date`` is a DynamoDB reserved word, so an update can only name it through
``ExpressionAttributeNames``): none is allowed anywhere; a ``date`` key of an item is too common (API payloads, other
tables) to tell from a feedback item's, and a whole item is put only by the processor (the CDK half above).
"""
from __future__ import annotations

import ast
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import pytest

REPO: Final = Path(__file__).resolve().parents[3]
SCANNED: Final = ('lambda', 'plugins')
INDEX_NAMES: Final = frozenset({'gsi1pk', 'gsi1sk'})
TOKEN: Final = re.compile(r'\bgsi1(?:pk|sk)\b')
#: A module that names voc-feedback or the keys of its day partitions reaches it.
REACHES_FEEDBACK: Final = re.compile(
    r'feedback_table|FEEDBACK_TABLE|FEEDBACK_BY_DATE_INDEX|FEEDBACK_SK_PREFIX|date_partition|date_pk|DATE#')
#: Keyword arguments (or request-dict keys) whose text only reads: a string under them never writes.
READ_KWARGS: Final = frozenset({'KeyConditionExpression', 'FilterExpression', 'ProjectionExpression',
                                'ConditionExpression', 'ExclusiveStartKey', 'IndexName', 'sort_condition'})
#: Calls that change the container they are called on: a name passed to them is written into it.
MUTATORS: Final = frozenset({'pop', 'setdefault', 'update', 'append', 'extend', 'insert', 'add', '__setitem__', 'dict'})

#: The one write of a review's day keys: the processor's first put of the item.
FEEDBACK_DAY_STAMP: Final = ('lambda/processor/handler.py', 'build_feedback_item')

#: Modules that never reach voc-feedback, by the table their gsi1 writes go to (or what their names are).
OTHER_TABLES: Final = {
    'lambda/agents/store.py': 'voc-agents (a run active on RUNS_ACTIVE, removed when it ends)',
    'lambda/api/memory_handler.py': 'voc-memory (a restored memory relisted)',
    'lambda/api/verification_fixture_provider.py': 'voc-projects (a verification fixture project)',
    'lambda/jobs/persona_importer/handler.py': 'voc-projects (an imported persona listed)',
    'lambda/jobs/retention/registries.py': "voc-projects (INDEX_ATTRIBUTES: what the registries check reads of "
                                           "gsi1-by-type, 7.93.00; read)",
    'lambda/jobs/workspace_export/project_fields.py': 'names an export leaves out (read)',
    'lambda/shared/agent_run_resume.py': 'voc-agents (a resumed run back on RUNS_ACTIVE)',
    'lambda/shared/agents_store.py': 'voc-agents (agents, workflows, runs)',
    'lambda/shared/assist_jobs.py': 'voc-jobs (an assist job by status)',
    'lambda/shared/feature_boards_store.py': 'voc-feature-requests (boards)',
    'lambda/shared/feature_request_evidence.py': 'voc-feature-requests (its listing index read)',
    'lambda/shared/feature_requests_promote.py': 'voc-feature-requests (requests listed)',
    'lambda/shared/feature_requests_store.py': 'voc-feature-requests (requests)',
    'lambda/shared/jobs.py': 'voc-jobs (a job by status)',
    'lambda/shared/mcp_global_kit.py': 'names never forwarded to an MCP client (read)',
    'lambda/shared/memory_store.py': 'voc-memory (a memory by status)',
    'lambda/shared/participants_asks.py': 'voc-participants (asks)',
    'lambda/shared/participants_lists.py': 'voc-participants (lists)',
    'lambda/shared/participants_store.py': 'voc-participants (people)',
    'lambda/shared/persona_copy.py': 'voc-projects (a copied persona)',
    'lambda/shared/plans_store.py': 'voc-agents (plans, on gsi1-by-agents-listing)',
    'lambda/shared/project_keys.py': 'voc-projects (a project\'s documents listed)',
    'lambda/shared/prototype_versions.py': 'voc-projects (fields a prototype version does not carry)',
    'lambda/shared/radar_store.py': 'voc-radar (a feedback item\'s index keys dropped from its radar copy)',
}

#: In modules that reach voc-feedback: every other function or constant that names the day keys, and what it is.
FEEDBACK_MODULE_ENTRIES: Final = {
    ('lambda/api/projects.py', 'create_project.put_project'): 'voc-projects (a project listed by type)',
    ('lambda/api/projects.py', '_start_project_deletion.mark_existing'): 'voc-projects (a deleting project unlisted)',
    ('lambda/api/projects.py', '_build_persona_items'): 'voc-projects (a persona listed)',
    ('lambda/api/projects.py', '<module>'): 'voc-projects (fields a duplicated document does not carry)',
    ('lambda/jobs/workspace_export/entities.py', '<module>'): 'EXCLUDED: the index keys the export says it leaves out '
                                                              '(read)',
    ('lambda/shared/indexes.py', '<module>'): 'FEEDBACK_BY_DATE_POSITION: a review\'s key and gsi1 position, the '
                                              'reprocess walk\'s and the export\'s cursor (read)',
    ('lambda/shared/ws_repo.py', '<module>'): 'PARTITION_ATTRIBUTES: the workspace layer\'s partition check (read)',
}

WALK: Final = ('the reprocess day walk (lambda/shared/reprocess_slices.py walk_days / read_day_page) reads a review '
               'only under the day the processor first put it: ')


@dataclass(frozen=True)
class Write:
    path: str
    scope: str
    line: int
    what: str
    field: str = 'gsi1'

    def __str__(self) -> str:
        return f'{self.path}:{self.line} ({self.scope}): {self.what}'


def _call_name(call: ast.Call) -> str:
    func = call.func
    return func.attr if isinstance(func, ast.Attribute) else getattr(func, 'id', '')


def _sibling_keys(container: ast.AST) -> set[str]:
    """The keyword names of a call, or the string keys of a dict: what an ``ExpressionAttributeNames`` sits beside."""
    if isinstance(container, ast.Call):
        return {kw.arg for kw in container.keywords if kw.arg}
    if isinstance(container, ast.Dict):
        return {k.value for k in container.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)}
    return set()


class _Scanner:
    def __init__(self, path: str, source: str) -> None:
        self.path = path
        self.tree = ast.parse(source)
        self.parent: dict[ast.AST, ast.AST] = {
            child: node for node in ast.walk(self.tree) for child in ast.iter_child_nodes(node)}

    def _ancestors(self, node: ast.AST) -> Iterator[ast.AST]:
        while node in self.parent:
            node = self.parent[node]
            yield node

    def _scope(self, node: ast.AST) -> str:
        names = [a.name for a in self._ancestors(node)
                 if isinstance(a, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
        return '.'.join(reversed(names)) or '<module>'

    def _names_entry(self, child: ast.AST, holder: ast.AST) -> ast.AST | None:
        """The call or dict ``child`` is the ``ExpressionAttributeNames`` of, if it is one."""
        if isinstance(holder, ast.keyword) and holder.arg == 'ExpressionAttributeNames':
            return self.parent.get(holder)
        if isinstance(holder, ast.Dict):
            for key, value in zip(holder.keys, holder.values, strict=True):
                if value is child and isinstance(key, ast.Constant) and key.value == 'ExpressionAttributeNames':
                    return holder
        return None

    def _is_read(self, node: ast.Constant) -> bool:
        bare = node.value in INDEX_NAMES
        child: ast.AST = node
        for holder in self._ancestors(node):
            names_of = self._names_entry(child, holder)
            if names_of is not None:
                return 'UpdateExpression' not in _sibling_keys(names_of)
            if isinstance(holder, ast.keyword) and holder.arg in READ_KWARGS:
                return True
            if isinstance(holder, ast.Dict):
                for key, value in zip(holder.keys, holder.values, strict=True):
                    if value is child and isinstance(key, ast.Constant) and key.value in READ_KWARGS:
                        return True
            if isinstance(holder, ast.Call) and child in holder.args:
                name = _call_name(holder)
                if name in ('Key', 'Attr', 'get') or (bare and child is node and name not in MUTATORS):
                    return True
            call = self.parent.get(holder) if isinstance(holder, ast.keyword) else None
            if bare and child is node and isinstance(call, ast.Call) and _call_name(call) not in MUTATORS:
                return True
            if isinstance(holder, ast.Subscript) and child is holder.slice and isinstance(holder.ctx, ast.Load):
                return True
            if isinstance(holder, ast.Compare):
                return True
            child = holder
        return False

    def _is_docstring(self, node: ast.Constant) -> bool:
        return isinstance(self.parent.get(node), ast.Expr)

    def writes(self) -> Iterator[Write]:
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if TOKEN.search(node.value) and not self._is_docstring(node) and not self._is_read(node):
                    yield Write(self.path, self._scope(node), node.lineno, repr(node.value[:80]))
                elif node.value == 'date' and self._date_update(node):
                    yield Write(self.path, self._scope(node), node.lineno, "'date' named in an UpdateExpression", 'date')
            elif isinstance(node, ast.keyword) and node.arg in INDEX_NAMES:
                yield Write(self.path, self._scope(node), node.value.lineno, f'{node.arg}= keyword')

    def _date_update(self, node: ast.Constant) -> bool:
        holder = self.parent.get(node)
        if not isinstance(holder, ast.Dict) or node not in holder.values:
            return False
        container = self.parent.get(holder)
        names_of = None if container is None else self._names_entry(holder, container)
        return names_of is not None and 'UpdateExpression' in _sibling_keys(names_of)


def day_index_writes(path: str, source: str) -> list[Write]:
    """Every write of ``gsi1pk`` / ``gsi1sk`` (and an update naming ``date``) in one module's source."""
    return list(_Scanner(path, source).writes())


def _production_modules() -> Iterator[Path]:
    for base in SCANNED:
        for path in sorted((REPO / base).rglob('*.py')):
            parts = path.relative_to(REPO).parts
            if (any(part in ('test', 'tests', '__pycache__', 'node_modules', '.venv') for part in parts)
                    or path.name.startswith('test_') or path.name == 'conftest.py'):
                continue
            yield path


def _all_writes() -> dict[str, tuple[bool, list[Write]]]:
    found: dict[str, tuple[bool, list[Write]]] = {}
    for path in _production_modules():
        source = path.read_text(encoding='utf-8')
        if not TOKEN.search(source) and "'date'" not in source:
            continue
        rel = path.relative_to(REPO).as_posix()
        writes = day_index_writes(rel, source)
        if writes:
            found[rel] = (bool(REACHES_FEEDBACK.search(source)), writes)
    return found


WRITES: Final = _all_writes()


def _unexplained(path: str, reaches: bool, writes: list[Write]) -> list[Write]:
    return [w for w in writes if not _listed(path, reaches, w)]


def _listed(path: str, reaches: bool, write: Write) -> bool:
    if write.field == 'date':
        return False  # no update names a review's date, anywhere
    if path == FEEDBACK_DAY_STAMP[0]:
        return write.scope == FEEDBACK_DAY_STAMP[1]
    if reaches:
        return (path, write.scope) in FEEDBACK_MODULE_ENTRIES
    return path in OTHER_TABLES


class TestNothingRewritesAReviewsDay:
    def test_the_scan_reads_production_code(self):
        # Vacuity: the processor's own stamp is found, so the scan reaches the code it guards.
        assert REPO.joinpath(FEEDBACK_DAY_STAMP[0]).is_file()
        stamp = [w for w in WRITES[FEEDBACK_DAY_STAMP[0]][1] if w.scope == FEEDBACK_DAY_STAMP[1]]
        assert {w.what for w in stamp} == {"'gsi1pk'", "'gsi1sk'"}

    def test_every_write_of_the_day_keys_is_the_processors_first_put_or_another_tables(self):
        unexplained = [str(w) for path, (reaches, writes) in WRITES.items()
                       for w in _unexplained(path, reaches, writes)]
        assert unexplained == [], (
            WALK + 'a new write of gsi1pk / gsi1sk (or an update of date) can move a review out of it. Keep the day '
            'the processing day and never rewrite it (then list the write here with its table), or make the walk '
            'Scan:\n' + '\n'.join(unexplained))

    def test_a_module_that_reaches_feedback_is_listed_by_function_not_whole(self):
        # A module naming voc-feedback or its day keys may not be waved through whole by OTHER_TABLES.
        reaching = sorted(path for path, (reaches, _) in WRITES.items() if reaches)
        assert [path for path in reaching if path in OTHER_TABLES] == [], WALK + 'list these by function'
        assert REACHES_FEEDBACK.search(REPO.joinpath(FEEDBACK_DAY_STAMP[0]).read_text(encoding='utf-8'))

    def test_every_listed_entry_still_writes(self):
        # A stale entry would let a later write into that module or function pass unseen.
        here: set[str | tuple[str, str]] = set(WRITES) | {(path, w.scope) for path, (_, ws) in WRITES.items() for w in ws}
        stale = sorted(map(str, [p for p in OTHER_TABLES if p not in here]
                           + [e for e in FEEDBACK_MODULE_ENTRIES if e not in here]))
        assert stale == []

    def test_the_processors_put_of_a_review_is_its_first(self):
        # (a): the stamp reaches the table only by a put that cannot replace an existing review.
        tree = ast.parse(REPO.joinpath(FEEDBACK_DAY_STAMP[0]).read_text(encoding='utf-8'))
        puts = [node for node in ast.walk(tree)
                if isinstance(node, ast.Call) and _call_name(node) == 'put_item'
                and any(isinstance(n, ast.Name) and n.id == 'feedback_table' for n in ast.walk(node.func))]
        assert len(puts) == 1, WALK + 'the processor puts a review in one place'
        conditions = [kw.value for kw in puts[0].keywords if kw.arg == 'ConditionExpression']
        assert [ast.literal_eval(c) for c in conditions] == ['attribute_not_exists(pk)'], WALK + (
            'a put that may replace a stored review could refile it under another day')


class TestTheScanSeesEachForm:
    """The scanner itself, on planted sources: each write form is found, each read form is not."""

    @pytest.mark.parametrize('source', [
        "def f(t):\n    t.put_item(Item={'pk': 'p', 'gsi1pk': 'DATE#2026-11-10'})\n",
        "def f(item):\n    item['gsi1sk'] = 'x'\n",
        "def f(item):\n    del item['gsi1pk']\n",
        "def f(t):\n    t.update_item(Key={}, UpdateExpression='SET gsi1pk = :d')\n",
        "def f(t):\n    t.update_item(Key={}, UpdateExpression=f'SET a = :a REMOVE gsi1sk')\n",
        "def f(t):\n    t.update_item(Key={}, UpdateExpression='SET #g = :d', ExpressionAttributeNames={'#g': 'gsi1pk'})\n",
        "def f(t):\n    r = {'UpdateExpression': 'SET #g = :d', 'ExpressionAttributeNames': {'#g': 'gsi1sk'}}\n",
        "def f():\n    removes = ['gsi1pk']\n",
        "def f(removes):\n    removes.append('gsi1pk')\n",
        "def f():\n    return dict(gsi1pk='x')\n",
        "def f(t):\n    t.update_item(Key={}, UpdateExpression='SET #d = :d', ExpressionAttributeNames={'#d': 'date'})\n",
    ])
    def test_a_write_is_found(self, source):
        assert day_index_writes('planted.py', source) != []

    @pytest.mark.parametrize('source', [
        "def f(t):\n    '''Writes gsi1pk.'''\n    return t.query(KeyConditionExpression=Key('gsi1pk').eq('x'))\n",
        "def f(t):\n    return t.query(KeyConditionExpression='gsi1pk = :p', ExpressionAttributeNames={'#p': 'gsi1pk'})\n",
        "def f(row):\n    return row['gsi1sk'], row.get('gsi1pk'), 'gsi1pk' in row\n",
        "def f(s, t):\n    return query_partition(s, t, 'gsi1pk', 'x', attribute='gsi1sk')\n",
        "def f(t):\n    return t.query(ExclusiveStartKey={'gsi1pk': 'a', 'gsi1sk': 'b'})\n",
        "def f(t):\n    return t.query(ExpressionAttributeNames={'#d': 'date'}, FilterExpression='#d >= :d')\n",
    ])
    def test_a_read_is_not(self, source):
        assert day_index_writes('planted.py', source) == []

    def test_a_write_in_another_function_of_the_processor_is_unexplained(self):
        source = ("def build_feedback_item():\n    return {'gsi1pk': 'a', 'gsi1sk': 'b'}\n"
                  "def _refresh(t):\n    t.update_item(UpdateExpression='SET gsi1sk = :n')\n")
        writes = day_index_writes(FEEDBACK_DAY_STAMP[0], source)
        assert [w.scope for w in _unexplained(FEEDBACK_DAY_STAMP[0], True, writes)] == ['_refresh']

    def test_a_write_in_a_new_function_of_a_listed_feedback_module_is_unexplained(self):
        source = "def regroup(t):\n    t.update_item(UpdateExpression='SET gsi1pk = :d')\n"
        writes = day_index_writes('lambda/api/projects.py', source)
        assert [w.scope for w in _unexplained('lambda/api/projects.py', True, writes)] == ['regroup']

    def test_a_new_module_is_unexplained(self):
        source = "def f(item):\n    item['gsi1pk'] = 'DATE#2026-11-10'\n"
        writes = day_index_writes('lambda/jobs/new_job/handler.py', source)
        assert _unexplained('lambda/jobs/new_job/handler.py', False, writes) == writes
