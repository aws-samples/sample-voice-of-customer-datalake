"""The raw-access guard (docs/multi-workspace.md, "Request flow", step 4): data-path access goes through
shared/ws_repo.py.

Every production module under ``lambda/`` and ``plugins/`` (tests, conftests and the bundled layers left out) is
parsed, and each raw access is counted by its kind:

* a call that reaches a table or the bucket without the workspace layer: ``.Table(…)``, ``.put_object(…)``,
  ``.copy_object(…)``, ``.upload_file(…)``, ``.upload_fileobj(…)``, ``.generate_presigned_url(…)``,
  ``.generate_presigned_post(…)``, ``.delete_object(…)``, ``.delete_objects(…)``, or a data-path table getter of
  shared/tables.py (``get_feedback_table()``, ``get_aggregates_table()``, ``cached_table(…)``, also under an
  ``import … as`` alias), or the ingestors' deployment-wide table (``DeploymentTable(…)``, and
  ``ingest_table(None, …)`` with the literal None; a call passing a scope variable that may be None at run time
  is not counted);
* a string that STARTS a data-path partition or object key without the workspace (``'SOURCE#…'``,
  ``f'METRIC#{name}'``, ``'raw/'`` …: ``UNSCOPED_KEY_PREFIXES``): such a key can only name the deployment-wide
  partition, never one workspace's.

``ALLOWED`` names, per module, the phase that moves it (2: the data path, 3: everything else; docs/multi-workspace.md
"Phases") and how many of EACH kind it still holds. A module's counts must match exactly: a new raw access fails
(also one that replaces another kind in the same module) unless its entry is raised in the same change, which
review refuses, and one removed without lowering its count fails too: every change to the list shows in the diff. Only the layer itself (``LAYER``) is exempt.

Two more rules hold everywhere: a ``WorkspaceScope`` is built only inside the layer (``scope_of``,
``scope_from_message``, ``scope_from_key``; aliases included), and no request-facing module (``lambda/api/``, the
public webhooks, but for the asynchronous workers in ``ASYNC_API_WORKERS``) calls ``scope_from_message`` or
``scope_from_key``: a request's workspace comes from its resolved membership (``scope_of``), never from a field, a
path or a cursor it sent. (``dataclasses.replace`` of a scope is not detected: it still validates the id.)

Known limits, each closed by the slice that moves the code: keys joined without a literal prefix
(``'#'.join(('SOURCE', s))``), low-level clients (``boto3.client('dynamodb')``), S3 reads, and the TypeScript stream
Lambda (phase 3) are not counted. A failure lists every module whose counts differ.
"""
from __future__ import annotations

import ast
from collections import Counter
from pathlib import Path
from typing import Final

ROOT: Final = Path(__file__).resolve().parents[3]
SCANNED: Final = ('lambda', 'plugins')
#: The one sanctioned home of raw data-path access.
LAYER: Final = frozenset({'lambda/shared/ws_repo.py'})
RAW_CALLS: Final = frozenset({'Table', 'put_object', 'copy_object', 'upload_file', 'upload_fileobj',
                              'generate_presigned_url', 'generate_presigned_post', 'delete_object',
                              'delete_objects'})
#: The data path's table getters (shared/tables.py): a table they return is reached without the layer.
RAW_GETTERS: Final = frozenset({'get_feedback_table', 'get_aggregates_table', 'cached_table'})
#: The ingestors' deployment-wide table (shared/ingest_tables.py): built directly, or asked for with no scope.
DEPLOYMENT_TABLE: Final = 'DeploymentTable'
UNSCOPED_INGEST_TABLE: Final = 'ingest_table(None)'
#: Partition and object prefixes of the data path that, at the start of a string, name no workspace.
UNSCOPED_KEY_PREFIXES: Final = ('SOURCE#', 'METRIC#', 'DATE#', 'CATEGORY#', 'URGENCY#', 'CHANNEL#', 'SOURCE_RUN#',
                                'raw/', 'silver/')
#: Modules that answer requests a client sent (the API, the public webhooks): their workspace is never read from
#: what the client sent.
REQUEST_FACING: Final = ('lambda/api/', 'plugins/_shared/base_webhook.py')
REQUEST_FACING_DIR_PART: Final = '/webhook/'
#: Request-facing modules that are asynchronous workers, not request handlers: their workspace comes from
#: the payload their own handler wrote from a resolved scope.
ASYNC_API_WORKERS: Final = frozenset({'lambda/api/manual_import_processor.py'})

# module: (phase that moves it, {kind: count}). Must match exactly; raising an entry is refused in review (docstring).
ALLOWED: Final[dict[str, tuple[int, dict[str, int]]]] = {
    'lambda/agents/context_blocks.py': (3, {'Table': 1}),
    'lambda/agents/heartbeat/handler.py': (3, {'DATE#': 1, 'Table': 2}),
    'lambda/agents/nodes/aggregate_reviews.py': (3, {'get_aggregates_table': 1}),
    'lambda/agents/nodes/select_or_create_project.py': (3, {'get_aggregates_table': 2}),
    'lambda/agents/plan_waits.py': (3, {'SOURCE_RUN#': 1, 'get_aggregates_table': 1}),
    'lambda/agents/store.py': (3, {'Table': 1}),
    'lambda/aggregator/handler.py': (2, {'METRIC#': 2, 'Table': 2}),
    'lambda/api/agents_handler.py': (3, {'get_aggregates_table': 1}),
    'lambda/api/ballots_handler.py': (2, {'get_aggregates_table': 1}),
    'lambda/api/chat_handler.py': (3, {'Table': 1}),
    'lambda/api/data_explorer_handler.py': (
        2, {'SOURCE#': 1, 'Table': 1, 'generate_presigned_url': 1, 'get_aggregates_table': 2, 'put_object': 1}),
    'lambda/api/feedback_edit_handler.py': (2, {'get_aggregates_table': 1, 'get_feedback_table': 1}),
    'lambda/api/feedback_form_handler.py': (2, {'SOURCE#': 2, 'Table': 2}),
    'lambda/api/integrations_handler.py': (2, {'SOURCE_RUN#': 2, 'get_aggregates_table': 2}),
    'lambda/api/logs_handler.py': (3, {'get_aggregates_table': 1}),
    'lambda/api/manual_import_handler.py': (2, {'Table': 2, 'raw/': 3}),
    'lambda/api/manual_import_processor.py': (2, {'Table': 1}),
    'lambda/api/memory_handler.py': (3, {'Table': 1, 'get_aggregates_table': 9, 'put_object': 1}),
    'lambda/api/metrics_handler.py': (2, {'CATEGORY#': 2, 'DATE#': 3, 'METRIC#': 1, 'Table': 2, 'URGENCY#': 1}),
    'lambda/api/product_context.py': (3, {'generate_presigned_url': 1}),
    'lambda/api/projects.py': (3, {'copy_object': 1, 'get_feedback_table': 1}),
    'lambda/api/projects_handler.py': (3, {'get_aggregates_table': 12}),
    'lambda/api/radar_handler.py': (3, {'cached_table': 1, 'get_aggregates_table': 1}),
    'lambda/api/s3_import_handler.py': (
        2, {'delete_object': 1, 'generate_presigned_url': 1, 'get_aggregates_table': 2, 'put_object': 1}),
    'lambda/api/scrapers_handler.py': (2, {'get_aggregates_table': 3}),
    'lambda/api/settings_handler.py': (3, {'Table': 1, 'generate_presigned_url': 3, 'put_object': 1}),
    'lambda/api/users_handler.py': (3, {'Table': 2}),
    'lambda/api/verification_fixture_provider.py': (3, {'get_aggregates_table': 1}),
    'lambda/api/workspaces_handler.py': (3, {'cached_table': 1}),
    'lambda/auth/board_triggers.py': (3, {'Table': 2}),
    'lambda/briefing/handler.py': (3, {'Table': 1}),
    'lambda/briefing/signals.py': (3, {'DATE#': 2, 'METRIC#': 1, 'URGENCY#': 1}),
    'lambda/custom_resources/model_pin.py': (3, {'Table': 1}),
    'lambda/design_capture/capture_handler.py': (3, {'Table': 1}),
    'lambda/email_intake/handler.py': (2, {'Table': 2, 'delete_object': 1}),
    'lambda/email_intake/intake.py': (2, {'copy_object': 1}),
    'lambda/jobs/category_reprocess/handler.py': (3, {'CATEGORY#': 2, 'Table': 2, 'URGENCY#': 1, 'raw/': 1}),
    'lambda/jobs/document_generator/handler.py': (3, {'Table': 6, 'delete_objects': 1, 'put_object': 2}),
    'lambda/jobs/document_merger/handler.py': (3, {'Table': 2}),
    'lambda/jobs/persona_importer/handler.py': (3, {'Table': 1}),
    'lambda/jobs/radar_scan/handler.py': (3, {'Table': 2}),
    'lambda/jobs/retention/boards.py': (3, {'raw/': 1}),
    'lambda/jobs/retention/handler.py': (3, {'Table': 3}),
    'lambda/memory/extractor/handler.py': (3, {'Table': 1, 'get_aggregates_table': 3}),
    'lambda/memory/scanner/handler.py': (3, {'Table': 1}),
    'lambda/processor/handler.py': (2, {'CATEGORY#': 1, 'DATE#': 1, 'SOURCE#': 3, 'Table': 3, 'URGENCY#': 1}),
    'lambda/product_doc_extractor/handler.py': (3, {'Table': 1, 'put_object': 1}),
    'lambda/research/research_step_handler.py': (3, {'delete_object': 1, 'get_feedback_table': 1, 'put_object': 2}),
    'lambda/shared/agents_store.py': (3, {'Table': 1}),
    'lambda/shared/avatar.py': (3, {'put_object': 1}),
    'lambda/shared/cloudfront_signing.py': (3, {'generate_presigned_url': 1}),
    'lambda/shared/design_assets.py': (3, {'put_object': 1}),
    'lambda/shared/design_icons.py': (3, {'put_object': 1}),
    'lambda/shared/design_logo.py': (3, {'put_object': 2}),
    'lambda/shared/earliest_date.py': (2, {'METRIC#': 1}),
    'lambda/shared/engagement_config.py': (3, {'cached_table': 1, 'get_aggregates_table': 1}),
    'lambda/shared/feature_requests_enrich.py': (3, {'get_aggregates_table': 1}),
    'lambda/shared/feedback.py': (2, {'CATEGORY#': 1, 'DATE#': 1, 'METRIC#': 1}),
    'lambda/shared/feedback_category.py': (2, {'CATEGORY#': 1}),
    'lambda/shared/feedback_form_participants.py': (2, {'Table': 1}),
    'lambda/shared/feedback_keys.py': (2, {'SOURCE#': 1}),
    'lambda/shared/image_model_quota.py': (3, {'get_aggregates_table': 1}),
    'lambda/shared/job_knowledge.py': (3, {'get_aggregates_table': 1}),
    'lambda/shared/memory_store.py': (3, {'Table': 1}),
    'lambda/shared/metric_keys.py': (2, {'METRIC#': 14}),
    'lambda/shared/model_config.py': (3, {'Table': 1}),
    'lambda/shared/model_quota_store.py': (3, {'get_aggregates_table': 1}),
    'lambda/shared/participants_ask_routes.py': (3, {'get_aggregates_table': 1}),
    'lambda/shared/persona_copy.py': (3, {'copy_object': 1}),
    'lambda/shared/plugin_circuit.py': (2, {'get_aggregates_table': 2}),
    'lambda/shared/prompt_labels_store.py': (3, {'Table': 1}),
    'lambda/shared/radar_views.py': (3, {'METRIC#': 1}),
    'lambda/shared/raw_object_summary.py': (2, {'raw/': 1}),
    'lambda/shared/raw_versions.py': (2, {'put_object': 1, 'raw/': 1}),
    'lambda/shared/release_watch.py': (3, {'DATE#': 1}),
    'lambda/shared/retention.py': (3, {'delete_objects': 2, 'raw/': 2}),
    'lambda/shared/s3_import_runs.py': (2, {'SOURCE_RUN#': 1}),
    'lambda/shared/s3_versions.py': (3, {'delete_objects': 1}),
    'lambda/shared/silver_provenance.py': (2, {'SOURCE#': 2, 'put_object': 1, 'silver/': 1}),
    'lambda/shared/source_profiles.py': (2, {'Table': 1}),
    'lambda/shared/source_updates.py': (2, {'CATEGORY#': 1, 'URGENCY#': 1}),
    'lambda/shared/tables.py': (2, {'Table': 2}),
    'lambda/shared/user_flags.py': (3, {'Table': 1}),
    # The deployment-wide run's SOURCE_RUN# row (an event that names no workspace: kept until phase 2's last slice).
    # and voc-workspaces opened deployment-wide for the tick's fan-out (the control plane's PLUGIN# list).
    'plugins/_shared/base_ingestor.py': (2, {'SOURCE_RUN#': 1, 'ingest_table(None)': 1}),
    # The one place an ingestor run opens a table by name, for both paths: the three call sites base_ingestor,
    # circuit_breaker and the webscraper held, consolidated (the deployment-wide tables and voc-workspaces).
    'lambda/shared/ingest_tables.py': (2, {'DeploymentTable': 1, 'Table': 1}),
}


def _modules() -> list[Path]:
    found = []
    for top in SCANNED:
        for path in sorted((ROOT / top).rglob('*.py')):
            parts = path.relative_to(ROOT).parts
            name = path.name
            if ('test' in parts or 'tests' in parts or 'layers' in parts or 'node_modules' in parts
                    or name.startswith('test_') or name.endswith('_test.py') or name == 'conftest.py'):
                continue
            found.append(path)
    return found


def _unscoped_prefix(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        text = node.value
    elif isinstance(node, ast.JoinedStr) and node.values and isinstance(node.values[0], ast.Constant):
        text = str(node.values[0].value)
    else:
        return None
    return next((prefix for prefix in UNSCOPED_KEY_PREFIXES if text.startswith(prefix)), None)


def _getter_names(tree: ast.AST) -> dict[str, str]:
    """Local name → getter, for each getter imported under its own name or an alias."""
    names = {getter: getter for getter in RAW_GETTERS}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name in RAW_GETTERS and alias.asname:
                    names[alias.asname] = alias.name
    return names


def _called(node: ast.Call) -> str | None:
    func = node.func
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return None


def _kinds(tree: ast.AST) -> Counter[str]:
    """Each raw access of one parsed module, counted by kind (a call name, or an unscoped key prefix)."""
    kinds: Counter[str] = Counter()
    getters = _getter_names(tree)
    inside_fstring = {id(value) for node in ast.walk(tree) if isinstance(node, ast.JoinedStr) for value in node.values}
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = _called(node)
            if name is None:
                continue
            if isinstance(node.func, ast.Attribute) and name in RAW_CALLS | RAW_GETTERS:
                kinds[name] += 1
            elif isinstance(node.func, ast.Name) and name in getters:
                kinds[getters[name]] += 1
            elif name == DEPLOYMENT_TABLE:
                kinds[DEPLOYMENT_TABLE] += 1
            elif (name == 'ingest_table' and node.args and isinstance(node.args[0], ast.Constant)
                  and node.args[0].value is None):
                kinds[UNSCOPED_INGEST_TABLE] += 1
        elif id(node) not in inside_fstring and (prefix := _unscoped_prefix(node)) is not None:
            kinds[prefix] += 1
    return kinds


def _parse(path: Path) -> ast.AST:
    return ast.parse(path.read_text(encoding='utf-8'))


def _rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def _all_kinds() -> dict[str, dict[str, int]]:
    found = {}
    for path in _modules():
        if _rel(path) in LAYER:
            continue
        kinds = _kinds(_parse(path))
        if kinds:
            found[_rel(path)] = dict(sorted(kinds.items()))
    return found


def _local_names(tree: ast.AST, name: str) -> set[str]:
    """``name`` and every ``import … as`` alias of it in one module."""
    return {name} | {alias.asname for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
                     for alias in node.names if alias.name == name and alias.asname}


def _calls_of(name: str) -> list[str]:
    """Every production module outside the layer that calls ``name`` (by name, alias or as an attribute)."""
    found = []
    for path in _modules():
        if _rel(path) in LAYER:
            continue
        tree = _parse(path)
        names = _local_names(tree, name)
        if any(isinstance(node, ast.Call) and _called(node) in names for node in ast.walk(tree)):
            found.append(_rel(path))
    return sorted(found)


def _request_facing(module: str) -> bool:
    return (module.startswith(REQUEST_FACING) or REQUEST_FACING_DIR_PART in module) and module not in ASYNC_API_WORKERS


def test_counts_match_the_allowlist():
    """Each module holds exactly the raw access its ``ALLOWED`` entry names, kind by kind (none without one)."""
    actual = _all_kinds()
    expected = {module: kinds for module, (_phase, kinds) in ALLOWED.items()}
    differ = {module: {'allowed': expected.get(module, {}), 'found': actual.get(module, {})}
              for module in sorted(set(actual) | set(expected)) if actual.get(module, {}) != expected.get(module, {})}
    assert not differ, ('raw data-path access differs from ALLOWED: build new access through shared/ws_repo.py, '
                        f'and lower an entry when a module moves: {differ}')


def test_every_entry_names_the_phase_that_moves_it():
    assert all(phase in (2, 3) and kinds and all(count > 0 for count in kinds.values())
               for phase, kinds in ALLOWED.values())


def test_a_scope_is_built_only_in_the_layer():
    assert _calls_of('WorkspaceScope') == []


def test_no_request_facing_module_takes_its_scope_from_what_was_sent():
    """A request's workspace is its resolved membership (``scope_of``), never a field, a path or a cursor."""
    assert [module for name in ('scope_from_message', 'scope_from_key') for module in _calls_of(name)
            if _request_facing(module)] == []


def test_the_rules_see_aliases(tmp_path):
    sample = tmp_path / 'sample.py'
    sample.write_text('from shared.ws_repo import WorkspaceScope as S\nscope = S(x)\n', encoding='utf-8')
    tree = _parse(sample)
    assert any(isinstance(node, ast.Call) and _called(node) in _local_names(tree, 'WorkspaceScope')
               for node in ast.walk(tree))
    assert _request_facing('plugins/github_issues/webhook/handler.py')
    assert _request_facing('lambda/api/metrics_handler.py')
    assert not _request_facing('lambda/api/manual_import_processor.py')
    assert not _request_facing('lambda/processor/handler.py')


def test_the_async_api_workers_exist():
    assert all((ROOT / module).is_file() for module in ASYNC_API_WORKERS)


def test_the_scan_sees_each_kind_of_raw_access(tmp_path):
    """The detector itself: each kind is counted, and the scoped forms are not (so the guard can fail)."""
    sample = tmp_path / 'sample.py'
    sample.write_text(
        "from shared.tables import get_feedback_table as feedback\n"
        "t = resource.Table('x')\n"
        "s3.put_object(Bucket='b', Key='k')\n"
        "s3.copy_object(Bucket='b', Key='k', CopySource={})\n"
        "a = 'SOURCE#web'\n"
        "b = f'METRIC#{name}'\n"
        "c = f'raw/{source}/'\n"
        "d = f'WS#{ws}#SOURCE#{source}'\n"
        "e = 'FEEDBACK#x'\n"
        "f = f'{prefix}SOURCE#'\n"
        "g = repo.get_item({'pk': key})\n"
        "h = feedback()\n"
        "i = tables.get_aggregates_table()\n"
        "j = f'silver/{source}/'\n"
        "s3.upload_file('f', 'b', 'k')\n"
        "s3.upload_fileobj(f, 'b', 'k')\n"
        "k = cached_table(resource, 'voc-radar')\n"
        "s3.generate_presigned_url('put_object', Params={})\n"
        "s3.delete_object(Bucket='b', Key='k')\n"
        "l = DeploymentTable(table)\n"
        "m = ingest_tables.DeploymentTable(table)\n"
        "n = ingest_table(None, resource, 'voc-workspaces')\n"
        "o = ingest_table(scope, resource, 'voc-aggregates')\n",
        encoding='utf-8')
    assert _kinds(_parse(sample)) == Counter({
        'Table': 1, 'put_object': 1, 'copy_object': 1, 'get_feedback_table': 1, 'get_aggregates_table': 1,
        'SOURCE#': 1, 'METRIC#': 1, 'raw/': 1, 'silver/': 1, 'upload_file': 1, 'upload_fileobj': 1,
        'cached_table': 1, 'generate_presigned_url': 1, 'delete_object': 1, 'DeploymentTable': 2,
        'ingest_table(None)': 1})


def test_the_layer_modules_exist():
    assert all((ROOT / module).is_file() for module in LAYER)
