"""Every settings row of the deployment, with its scope: per workspace or for the whole deployment
(docs/multi-workspace.md, "Per-workspace configuration", whose table says why each kind has its scope; decisions 6,
7, 10 and 13).

Today every settings row has one deployment-wide key, ``SETTINGS#<kind>`` (in voc-aggregates, and Radar's in
voc-radar), or ``SETTINGS`` in voc-participants. Phase 3 moves each kind of ``WORKSPACE_KINDS`` under its workspace,
``WS#{ws}#SETTINGS#<kind>``; a kind of ``DEPLOYMENT_KINDS`` keeps its key. Which map a kind is in is its scope, and
each names, per kind, every production file that spells the deployment-wide key today: a Python string constant that
starts the key (docstrings and prose that only mention it do not count), a quoted string in the TypeScript or in a
JavaScript Lambda that starts with it (comments do not count). The maps must match the code exactly, and the docs table must match the maps. So:

* a new settings row fails here until it is given a kind and a scope (any ``SETTINGS#…`` spelling that is not exactly
  one known kind, a capital, a digit, a hyphen, a sub-key or a wildcard included, is a kind of its own);
* a new place that spells a workspace kind's deployment-wide key fails (the key must come from the module that owns
  the kind, which phase 3 moves);
* when phase 3 moves a kind, the files it moved stop spelling the old key and their entries must go: the list of
  files still to move only shrinks;
* a key built from a bare prefix (``'SETTINGS#' + kind``, ``f'SETTINGS#{kind}'``) fails: every kind is spelled whole.

A key inside a workspace (``WS#{ws}#SETTINGS#<kind>``, built by the module that owns the kind) is out of this map: it
is what phase 3 moves a kind to, and the cross-workspace suite (lambda/api/test/test_cross_workspace_routes.py) is its
guard.
"""
from __future__ import annotations

import ast
import os
import re
from collections.abc import Iterator
from functools import cache
from pathlib import Path

import pytest

from shared.test.test_dunder_all_exports import ROOT, is_production, production_files

DOCS = ROOT.parent / 'docs' / 'multi-workspace.md'
#: The one module that builds the keys inside a workspace, `WS#{ws}#SETTINGS#{kind}`, from a kind it is given (so its
#: `f'SETTINGS#{kind}'` is not a deployment-wide key): out of this map by design (the module docstring).
WORKSPACE_KEY_BUILDER = 'lambda/shared/workspace_settings.py'
TYPESCRIPT_TREES = ('lib', 'lambda/stream/src', 'bin')
#: A settings key as a whole string: ``SETTINGS`` (the participants' partition) or ``SETTINGS#<anything>``.
_PYTHON_KEY = re.compile(r'SETTINGS(?:#(.*))?', re.DOTALL)
_TS_KEY = re.compile(r"""['"`]SETTINGS(?:#([^'"`$]*))?['"`]""")
#: A TypeScript string (kept) or comment (dropped), in one pass, so ``'prototypes/*'`` or ``'a //b'`` inside a string
#: starts no comment.
_TS_STRING_OR_COMMENT = re.compile(
    r"""('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|/\*.*?\*/|//[^\n]*""", re.DOTALL)
_KIND = re.compile(r'[a-z_]+')
#: The voc-participants table's settings partition: its pk is ``SETTINGS``, the kind is the sort key.
PARTICIPANTS = 'participants'


#: Moved under ``WS#{ws}#`` in phase 3 (decision 6: everything per workspace).
WORKSPACE_KINDS: dict[str, frozenset[str]] = {
    # Moved under its workspace; the deployment's row (a request with no workspace, the engagement API) is spelled
    # once, in engagement_config.py.
    'brand': frozenset({'lambda/shared/engagement_config.py'}),
    'company_context': frozenset({'lambda/shared/company_context.py', 'lambda/shared/memory_store.py'}),
    'design_system': frozenset({'lambda/shared/company_context.py', 'lib/stacks/design-capture.ts'}),
    'categories': frozenset({'lambda/shared/categories_key.py', 'lambda/shared/category_gate.py'}),
    'dimensions': frozenset({'lambda/shared/dimension_config.py'}),
    'sources': frozenset({'lambda/shared/source_profiles.py'}),
    # Moved under its workspace (shared/workspace_settings.py); the settings API keeps the deployment's row for a
    # request that names no workspace (shared/request_workspace.py: the deployment as before), until every
    # deployment runs inside one.
    'resolved_problems': frozenset({'lambda/api/settings_handler.py'}),
    'email_intake': frozenset({'lambda/shared/email_intake_settings.py'}),
    'fallback_owner': frozenset({'lambda/agents/nodes/select_or_create_project.py', 'lambda/shared/user_flags.py'}),
    'radar': frozenset({'lambda/shared/data_version.py', 'lambda/shared/radar_brands.py',
                        'lambda/shared/radar_settings.py', 'lib/utils/cache-version-grants.ts'}),
    # The workspace's pick; the default pinned at deploy (model_pin.py, `model_default` below) and the allowlist stay
    # deployment-wide.
    'model': frozenset({'lambda/product_doc_extractor/handler.py',
                        'lambda/shared/model_config.py', 'lambda/stream/src/bedrock/model-override.ts',
                        'lib/stacks/design-capture.ts'}),
    PARTICIPANTS: frozenset({'lambda/shared/participants_settings.py'}),
}

#: Kept deployment-wide.
DEPLOYMENT_KINDS: dict[str, frozenset[str]] = {
    'appearance': frozenset({'lambda/shared/appearance.py'}),
    # The default pinned at deploy, below every pick (decision 6: the picks per workspace, the default and the
    # allowlist the deployment's): split from `model` so the picks can move.
    'model_default': frozenset({'lambda/custom_resources/model_pin.py', 'lambda/product_doc_extractor/handler.py',
                                'lambda/shared/model_config.py', 'lambda/stream/src/bedrock/model-override.ts',
                                'lib/utils/model-allowlist.ts'}),
    'model_quotas': frozenset({'lambda/shared/model_quota_store.py'}),
    'image_model_quota': frozenset({'lambda/shared/image_model_quota.py'}),
    'alerts': frozenset({'lambda/shared/ops_alerts.py'}),
}

SETTINGS_KINDS: dict[str, frozenset[str]] = {**WORKSPACE_KINDS, **DEPLOYMENT_KINDS}


def _kind_of(rest: str | None) -> str:
    """The kind a key's text after ``SETTINGS#`` names: itself when it is a plain kind, ``''`` when empty (a bare
    prefix), else the text itself (``ai-model``, ``brand#v2``, ``%s``…), which no map names, so the test fails."""
    if rest is None:
        return PARTICIPANTS
    return rest if rest == '' or _KIND.fullmatch(rest) else f'?{rest}'


def python_keys(source: str) -> Iterator[str]:
    """The kind of every string constant of ``source`` that starts a settings key: a whole constant (its kind), or
    an f-string that starts with ``SETTINGS`` (``''``: built from a prefix). A part of an f-string after its first,
    like ``#SETTINGS#`` in ``f'WS#{ws}#SETTINGS#{k}'``, starts nothing."""
    tree = ast.parse(source)
    skipped: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            skipped |= {id(part) for part in node.values}
            first = node.values[0] if node.values else None
            if isinstance(first, ast.Constant) and isinstance(first.value, str) and first.value.startswith('SETTINGS'):
                yield ''
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skipped \
                and (found := _PYTHON_KEY.fullmatch(node.value)):
            yield _kind_of(found.group(1))


def typescript_keys(source: str) -> Iterator[str]:
    """The kind of every quoted string of ``source`` that is or starts a settings key (``''`` for a bare prefix,
    quoted or in a template). Comments do not count."""
    source = _TS_STRING_OR_COMMENT.sub(lambda found: found.group(1) or '', source)
    for found in _TS_KEY.finditer(source):
        yield _kind_of(found.group(1))
    for _ in re.finditer(r'''`SETTINGS(?:#[^'"`$]*)?\$\{''', source):
        yield ''


#: Directories with no production TypeScript or JavaScript (dependencies, vendored layers, tests).
_NOT_SCRIPT_SOURCE = frozenset({'node_modules', 'layers', 'test', 'tests'})


def _script_files() -> Iterator[Path]:
    """The production TypeScript of the CDK app and the stream Lambda, and the JavaScript Lambdas (a custom resource
    is one), never descending into dependencies."""
    trees = [(tree, ('.ts',)) for tree in TYPESCRIPT_TREES] + [('lambda', ('.js', '.mjs'))]
    for tree, suffixes in trees:
        for current, subdirs, names in os.walk(ROOT / tree):
            subdirs[:] = [d for d in subdirs if d not in _NOT_SCRIPT_SOURCE]
            for name in names:
                if name.endswith(suffixes) and not re.search(r'\.test\.[cm]?[jt]s$', name):
                    yield Path(current, name)


@cache
def spelled() -> dict[str, frozenset[str]]:
    """kind -> the production files that spell its key."""
    scripts = [path for path in (ROOT / 'scripts').rglob('*.py') if is_production(path.relative_to(ROOT))]
    sources = [(path, python_keys) for path in [*production_files(), *scripts]
               if str(path.relative_to(ROOT)) != WORKSPACE_KEY_BUILDER]
    sources += [(path, typescript_keys) for path in _script_files()]
    files: dict[str, set[str]] = {}
    for path, keys in sources:
        for kind in keys(path.read_text(encoding='utf-8')):
            files.setdefault(kind, set()).add(str(path.relative_to(ROOT)))
    return {kind: frozenset(names) for kind, names in files.items()}


def test_every_settings_key_in_the_code_has_a_kind_and_a_scope():
    unknown = {kind: sorted(files) for kind, files in spelled().items() if kind not in SETTINGS_KINDS}
    assert unknown == {}, (
        'Settings keys with no kind: give each one an entry in WORKSPACE_KINDS or DEPLOYMENT_KINDS and a row in '
        "docs/multi-workspace.md \"Per-workspace configuration\". ('' is a key built from a bare prefix: spell the "
        "kind whole; '?…' is a key that is not one plain kind.)")


@pytest.mark.parametrize('kind', sorted(SETTINGS_KINDS))
def test_each_kind_names_exactly_the_files_that_spell_its_key(kind):
    assert spelled().get(kind, frozenset()) == SETTINGS_KINDS[kind], (
        f'{kind}: a new file spelling the key must take it from the module that owns the kind; a file that stopped '
        '(the kind moved under its workspace) leaves the list')


def test_no_kind_has_two_scopes():
    assert set(WORKSPACE_KINDS) & set(DEPLOYMENT_KINDS) == set()


def test_the_scopes_follow_the_decisions():
    """Decision 7 (one logo and colour scheme), decision 13 (Radar per workspace), decision 6 (the model picker per
    workspace; brand, categories, dimensions and sources per workspace)."""
    assert 'appearance' in DEPLOYMENT_KINDS
    assert {'radar', 'model', 'brand', 'categories', 'dimensions', 'sources'} <= set(WORKSPACE_KINDS)


def docs_scopes(text: str) -> dict[str, str]:
    """kind -> scope, read from the docs table that follows "Every settings row and its scope"."""
    table = text.split('Every settings row and its scope', 1)[1].split('\n\n', 2)[1]
    scopes: dict[str, str] = {}
    for row in table.splitlines()[2:]:
        cells = [cell.strip() for cell in row.strip('|').split('|')]
        for kind in re.findall(r'`([a-z_]+)`', cells[0]):
            assert kind not in scopes, f'{kind}: two rows in the docs table'
            scopes[kind] = cells[1].split(',')[0]
    return scopes


def test_the_docs_table_matches_the_maps():
    expected = {**dict.fromkeys(WORKSPACE_KINDS, 'workspace'), **dict.fromkeys(DEPLOYMENT_KINDS, 'deployment')}
    assert docs_scopes(DOCS.read_text(encoding='utf-8')) == expected


@pytest.mark.parametrize(('source', 'kinds'), [
    ("KEY = {'pk': 'SETTINGS#brand', 'sk': 'config'}\n", ['brand']),
    ("KEY = {'pk': 'SETTINGS', 'sk': 'engagement'}\n", [PARTICIPANTS]),
    ("PK = 'SETTINGS#' + kind\n", ['']),
    ("PK = f'SETTINGS#{kind}'\n", ['']),
    ("PK = 'SETTINGS#%s' % kind\n", ['?%s']),
    ("PK = 'SETTINGS#{}'.format(kind)\n", ['?{}']),
    ("PK = 'SETTINGS#ai-model'\n", ['?ai-model']),
    ("PK = 'SETTINGS#Brand'\n", ['?Brand']),
    ("PK = 'SETTINGS#brand#v2'\n", ['?brand#v2']),
    ("PK = 'SETTINGS#model2'\n", ['?model2']),
    ("PK = f'WS#{ws}#SETTINGS#{kind}'\n", []),
    ('"""Stored at SETTINGS#brand."""\n', []),
    ("log('no categories (SETTINGS#categories)')\n", []),
    ("def f():\n    '''Reads SETTINGS#radar.'''\n    return 'SETTINGS#radar'\n", ['radar']),
], ids=['a-key', 'the-participants-partition', 'a-prefix', 'an-f-string-prefix', 'percent-format', 'str-format',
        'a-hyphen', 'a-capital', 'a-sub-key', 'a-digit', 'inside-a-workspace', 'a-docstring', 'prose',
        'a-function-docstring'])
def test_the_python_reader_sees_keys_and_only_keys(source, kinds):
    assert list(python_keys(source)) == kinds


@pytest.mark.parametrize(('source', 'kinds'), [
    ("const PK = 'SETTINGS#model';\n", ['model']),
    ('conditions: { leadingKeys: ["SETTINGS#radar"] }\n', ['radar']),
    ('conditions: { leadingKeys: ["SETTINGS#radar*"] }\n', ['?radar*']),
    ("const pk = 'SETTINGS#' + kind;\n", ['']),
    ('const pk = `SETTINGS#${kind}`;\n', ['']),
    ("const pk = 'SETTINGS#ai-model';\n", ['?ai-model']),
    ("const pk = 'SETTINGS';\n", [PARTICIPANTS]),
    ('// the SETTINGS#model row\n', []),
    ("/** `voc-radar`: `SETTINGS#radar / version`. */\nconst url = 'https://example.com'; // 'SETTINGS#x'\n", []),
    ("grant(role, 'prototypes/*');\nconst pk = 'SETTINGS#brand';\n/** doc */\n", ['brand']),
    ("const u = 'a //b'; const pk = 'SETTINGS#brand';\n", ['brand']),
    ("const g = '/*'; const pk = 'SETTINGS#brand'; const h = '*/';\n", ['brand']),
    ('const pk = `SETTINGS#brand_${x}`;\n', ['']),
    ('const pk = `SETTINGS${sep}brand`;\n', ['']),
], ids=['single-quoted', 'double-quoted', 'a-wildcard', 'a-prefix', 'a-template', 'a-hyphen', 'bare', 'a-comment',
        'a-doc-comment-and-a-trailing-comment', 'a-glob-in-a-string', 'a-double-slash-in-a-string',
        'comment-markers-in-strings', 'a-template-with-a-sub-key', 'a-template-separator'])
def test_the_typescript_reader_sees_keys_and_only_keys(source, kinds):
    assert list(typescript_keys(source)) == kinds


def test_a_kind_listed_twice_in_the_docs_table_is_caught():
    row = '| `appearance` | deployment |'
    text = DOCS.read_text(encoding='utf-8').replace(row, f'| `appearance` | workspace | twice |\n{row}')
    with pytest.raises(AssertionError, match='appearance: two rows'):
        docs_scopes(text)
