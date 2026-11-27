"""Guard of the project stores' scope (docs/multi-workspace.md, "3h, the switch": ``workspace`` is a required keyword).

A project store that drops its caller's workspace reads or writes the deployment's rows while the request is in a
workspace, and nothing at run time tells the two apart: ``workspace=None`` IS the deployment. So since 7.99.00 (3h-S1)
the gate and the stores of ``GUARDED`` take ``workspace`` with no default, and every call spells its scope out:
``workspace=scope`` inside a workspace, ``workspace=None`` for the deployment. Four rules:

* **No default.** Every function (and method) of a ``GUARDED`` module that has a ``workspace`` parameter takes it
  keyword-only with no default; by position only in a private (``_``-named) helper or ``require_deployment``, the
  refusal itself, which no call can leave out.
* **Every call names its scope.** Every call of a keyword one from production code (every module under ``lambda/``
  and ``plugins/``, tests, conftests and the bundled layers left out, and the operator scripts under ``scripts/``)
  passes ``workspace=`` by name. A ``**kwargs`` spread does not count (what it holds cannot be read here), nor does
  handing the function on as a value (``partial(project_pk)``, a callback; a type annotation is not one), nor a
  relative or ``*`` import of a guarded module: each fails.
* **A held scope is passed on.** Inside a function (or a lambda within one) that binds ``workspace``, ``scope`` or
  ``ws`` (a parameter or a local), a guarded call may not pass a literal ``workspace=None`` unless one of its lines
  says why: ``# deployment: <reason>``.
* **The ratchet.** ``LITERAL_NONE`` pins, per module, the guarded calls that name the deployment by a literal None;
  each later 3h slice lowers it.
* **The membership** (since 7.101.00, 3h-S2). The access policy's calls (``MEMBERSHIP_CALLS``) also pass
  ``membership=`` by name (``None`` beside ``workspace=None``; the ratchet does not count it), and a
  ``WorkspaceMembership`` is built only in shared/project_access.py and shared/workspace.py ``membership_of``
  (``MEMBERSHIP_BUILDERS``), so a route hands the gate only the membership it resolved.

The Cognito triggers (``lambda/auth/board_triggers.py``) and the retention worker (``lambda/jobs/retention/``) read
projects outside the API; ``NON_API_READERS`` names them so the scan is proved to reach them.

How a call is resolved: by the imports of its module (``from shared.project_keys import project_pk [as k]``,
``from shared import project_keys [as k]``, ``import shared.document_versions [as v]``, an API module by its bare name
from beside it, ``import projects``), wherever in the module the import is; a guarded module's own calls of its own
functions by their bare names; and a name one guarded module imports from another, called through it
(``document_comments.comments_pk``). A class whose ``__init__`` takes ``workspace`` is called like a function. The
bundle scripts reach the stores through lazy imports (``remap.py`` ``project_keys()``, ``_shared_helpers()``), so there
an attribute call whose receiver no import resolves is matched by the function's name alone (``BY_NAME``), except the
``(module, name)`` pairs of ``BY_NAME_EXCLUDED`` (``assist_jobs.get`` is not every ``dict.get``); any other guarded
name a builtin container's method also has fails a test, so the exclusions never grow unseen.

Since 7.102.00 (3h-S1b) ``GUARDED`` holds every project-adjacent store, not only the gate and the project stores: the
jobs and their notices, the personas' stores, the voice sessions, the human documents, the decisions, the deleted
sources' marks, the participants' project gate, the ballots' and the plan waits' wrappers and the product docs'
extractor; since 7.104.00 the Product tab's stores too (its sources, its context and proposals, its extract and the
sources' reading).

Not seen (docs/multi-workspace.md, 3h's guard line): a method called on an instance (``store.method(…)``: the
method's own signature is still held to the first rule); ``import shared`` followed by attribute access
(``shared.project_keys.project_pk``); a guarded name re-exported by a module outside ``GUARDED``; a store reached
through ``getattr`` or ``importlib``; and a name rebound to a guarded function by assignment.
"""
from __future__ import annotations

import ast
import functools
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import pytest

REPO: Final = Path(__file__).resolve().parents[3]
LAMBDA: Final = REPO / 'lambda'
#: The Lambdas, the plugins and the operator scripts (the project bundle's, the registries' backfill, …).
SCANNED: Final = ('lambda', 'plugins', 'scripts')
BUNDLE_SCRIPTS: Final = 'scripts/project_bundle'
#: The project stores and the gate, by module (dotted from lambda/): every function of each that takes ``workspace``.
GUARDED: Final = (
    # The keys, the writes, the partition reads, the gate and the access resolver.
    'shared.project_keys', 'shared.project_writes', 'shared.project_tables', 'shared.project_gate',
    'shared.project_access',
    # The document stores.
    'shared.document_versions', 'shared.document_history', 'shared.document_series', 'shared.document_comments',
    'shared.document_share', 'shared.document_review', 'shared.document_revision',
    # The objects and the pins.
    'shared.prototypes', 'shared.avatar', 'shared.prototype_pins', 'shared.prototype_versions',
    'shared.prototype_feedback', 'shared.prototype_drafts', 'shared.prototype_incorporation',
    # The API's own: a project's create and its object prefixes.
    'api.projects',
    # Since 7.102.00 (3h-S1b): the other project-adjacent stores. The jobs and their notices.
    'shared.jobs', 'shared.job_notices', 'shared.assist_jobs',
    # The personas: the company's, the save, the copy (and its routes), the replace, the overlap and the grounding.
    'shared.company_personas', 'shared.persona_save', 'shared.persona_copy', 'shared.persona_copy_routes',
    'shared.persona_replace', 'shared.persona_overlap', 'shared.persona_grounding',
    # The voice sessions, the human documents, the decisions and the deleted sources' marks.
    'shared.voice_sessions', 'shared.human_documents', 'shared.decision_records', 'shared.deleted_sources',
    # The participants' project gate wrappers, the ballots' and the plan waits'.
    'shared.engagement_identity', 'api.ballots_handler', 'agents.plan_waits',
    # The product docs' extractor (its scope a workspace id: a stdlib-only Lambda, its keys a copy held in lockstep).
    'product_doc_extractor.handler',
    # Since 7.104.00: the Product tab's stores, a project's product documents among them (their keys moved from
    # api/product_context.py, which takes no workspace of its own and calls them with the deployment's): the sources,
    # the product context and its proposals, the extract and the sources' reading on the twin.
    'shared.product_sources', 'shared.product_proposals', 'shared.product_extract', 'shared.product_source_worker',
)
#: The modules that read projects outside the API (docs/multi-workspace.md, 3h): each must be in the scan.
NON_API_READERS: Final = ('lambda/auth/board_triggers.py', 'lambda/jobs/retention')
#: Where an unresolved attribute call is matched by the function's name alone (the lazy imports above).
BY_NAME: Final = (BUNDLE_SCRIPTS,)
#: The guarded ``(module, name)`` pairs the name-only match leaves out, each one by name (since 7.102.00): by its name
#: alone a ``dict.get`` would read as ``assist_jobs.get``, and the bundle's lazy helpers never reach the assists. Any
#: other guarded name a builtin container's method also has fails ``test_no_other_guarded_name_is_a_builtin_methods``.
BY_NAME_EXCLUDED: Final = frozenset({('shared.assist_jobs', 'get')})
#: The method names of the builtin containers a script's values are (the clash the exclusions above answer).
BUILTIN_METHODS: Final = frozenset(name for kind in (dict, list, set, str, bytes, tuple) for name in dir(kind))
# The ratchet: per module, the guarded calls that name the deployment by a literal ``workspace=None``. Must match
# exactly and may only go down: each later 3h slice that resolves a route's or a job's scope lowers its module's count
# (or removes the entry) in the same change, and a raise is refused in review. Separate from test_ws_raw_access.py's
# `project accessor(workspace=None)` kind, which counts its own accessor list; this one counts every GUARDED call.
#
# 7.102.00 (3h-S1b) raised it once, from 191 in 27 modules to 265 in 35, as the other project-adjacent stores joined
# GUARDED: 78 production calls took the default before and now spell `workspace=None` out, every one the deployment's
# (no route or job resolves a workspace for them yet), net +74 because projects_handler.py's four `version_html` calls
# pass `store.workspace` instead. Per module, the "+n (3h-S1b)" notes below say which calls.
#
# 7.104.00 raised it once more, from 230 in 35 modules (after 3h-S3a lowered it) to 252 in 38, as the Product tab's
# stores (written beside 3h-S1 and S1b, rebased onto them) joined GUARDED: their routes, the product interviewer and
# its transcript name the deployment in 24 calls, `api/product_context.py` in 2 fewer (its rows moved to those
# stores), every one the deployment's (their routes wait in api/projects_handler.py ``NOT_YET``, 3h-S3b and 3h-S3c,
# refused in a workspace before any read). The "(7.104.00)" notes below say which calls.
LITERAL_NONE: Final[dict[str, int]] = {
    'lambda/agents/artifacts.py': 1,
    # +10 (3h-S1b): the ballots' row, project and session checks (`_existing_row`, `_project_gone`, the
    # `_require_*_project_level` gates), whose rows are the deployment's (`BALLOT_ROWS_STORE` refuses a workspace).
    'lambda/api/ballots_handler.py': 10,
    # A credential's pin, the deployment's until 3h-S9 (marked on the line).
    'lambda/api/mcp_tokens_handler.py': 1,
    # +1 (3h-S1b): a deleted product doc's citing documents (`mark_citing_documents`).
    # -2 (7.104.00): the Product tab's rows are read and written by their own stores (shared/product_sources.py,
    # shared/product_proposals.py), so the context's read and write, the source rows' listing and the upload's
    # record name the deployment once each; the delete also names it to `forget_source`.
    'lambda/api/product_context.py': 15,
    # 3 more since 7.101.00 (3h-S2): the sharing summary and the email redaction take the project's scope, so the list
    # (`list_projects`: its summary and its redaction), `get_project` and `get_project_members` name the deployment,
    # while `_with_sharing_fields` and the create pass theirs on. Lifted with the projects routes' slice.
    # +9 (3h-S1b): the persona job's save, count, clear, protection, kept-personas read and writable check, the human
    # document's create and the two deleted-source marks.
    # -34 (3h-S3a): the project core routes take the request's scope (shared/project_request_scope.py): the list, the
    # get and its details, the chat context, the update, the sharing routes (visibility, members, owner), the
    # documents' create, edit, versions, restore and duplicate, and the personas' edit, note and protection. What stays
    # is the deployment's by its route's slice (the deletes, the jobs and assists, the prototypes, the avatars), and
    # the four assists' internal `get_project` reads (+4: they took the default; their routes are refused in a
    # workspace).
    'lambda/api/projects.py': 41,
    # +6 -4 (3h-S1b): the job row (`create_job` in `_started_job`), the project assist (`assist_jobs.start`) and the
    # four decision routes name the deployment; the four `version_html` calls pass their PrototypeStore's
    # `store.workspace` (the S1 follow-up).
    # -5 +4 (3h-S3a): the gate (`_gate_meta`, `_project_access_for`), the create and the board's viewable filter
    # (`_gate_meta_batch_chunk`, `_viewable_project_ids`) pass the request's scope; the company library's four persona
    # ops, handed on as values before, now call `update_persona`, `add_persona_note`, `require_persona` and
    # `with_signed_avatars` naming the deployment (the library is refused in a workspace by the middleware).
    'lambda/api/projects_handler.py': 33,
    # +3 each (3h-S1b): the caller's own assists outside any project (`start_owned`, `owner_pk`, `get`).
    'lambda/api/scrapers_handler.py': 3,
    'lambda/api/settings_handler.py': 3,
    'lambda/api/verification_fixture_provider.py': 7,
    # +5 (3h-S1b): the chain's job progress and outcome (`JobContext`, `update_job_status`): its steps are the
    # deployment's (the error step alone passes the run's scope).
    'lambda/jobs/document_generator/handler.py': 25,
    'lambda/jobs/document_merger/handler.py': 6,
    'lambda/jobs/persona_importer/handler.py': 2,
    'lambda/jobs/retention/registries.py': 2,
    # +1 (3h-S1b): the deployment's upload (`projects/…`), handed to `_extract_document`; a workspace's upload passes
    # the workspace id its key and claim named.
    'lambda/product_doc_extractor/handler.py': 1,
    # +15 (3h-S1b): each step's job status and the completed notice; a step is refused in a workspace before it runs
    # (`require_deployment(event_scope(event), PROJECT_JOB_WORK_STORE)`), the error step passes the run's scope.
    'lambda/research/research_step_handler.py': 18,
    # +2 (3h-S1b): the company library's META and read.
    'lambda/shared/company_personas_routes.py': 2,
    # +1 (3h-S1b): the promote's project gate (beside the board viewer's `BoardScope`, `board_scope`).
    'lambda/shared/feature_requests_routes.py': 1,
    # A credential's pin, the deployment's until 3h-S9 (marked on the line).
    'lambda/shared/mcp_oauth_consent_routes.py': 1,
    # +8 (3h-S1b): the participants' and asks' project gate (`require_project_access`, `can_view_project`).
    'lambda/shared/participants_ask_routes.py': 8,
    # +6 (3h-S1b): the promote route, the source project's META, its persona count, the library read and the two
    # copies (the copy's company-or-project kind is `source_kind`).
    'lambda/shared/persona_copy_routes.py': 7,
    'lambda/shared/persona_grounding.py': 2,
    # 7.104.00: the Product tab's extract and proposal routes, the deployment's until the projects routes' slice
    # resolves their scope (every store they call refuses a workspace, PRODUCT_SOURCES_STORE): the owner's META for an
    # autonomous writer (`read_gate_meta`), the precheck's ready sources and lock, the start's lock and its job, the
    # latest proposal's three reads, the accept and the dismiss.
    'lambda/shared/product_proposal_routes.py': 11,
    # 7.104.00: the Product tab's source routes, the same: a source's reads, claims and settles, the link's listing,
    # row key and put, and the typed answers' save.
    'lambda/shared/product_source_routes.py': 10,
    # +3 (3h-S1b): the evidence pack, its freshness and its refresh.
    'lambda/shared/persona_grounding_routes.py': 3,
    'lambda/shared/project_validation.py': 2,
    # +1 (3h-S1b): the validation assists' start.
    'lambda/shared/project_validation_routes.py': 8,
    'lambda/shared/project_writes.py': 1,
    'lambda/shared/prototype_drafts.py': 1,
    'lambda/shared/prototype_feedback.py': 2,
    'lambda/shared/prototype_pins.py': 6,
    'lambda/shared/validation_documents.py': 2,
    # +3 (3h-S1b): the offer, the mint (beside the caller's `category_scope`) and the transcript job.
    'lambda/shared/voice_session_routes.py': 4,
    # +1 (3h-S1b): the session's evidence pack (`mint` refused a workspace first; its `category_scope` is categories).
    'lambda/shared/voice_sessions.py': 5,
    # 7.104.00: the product interviewer's read of the product context (`context_state`), the deployment's as every
    # voice session is (`mint` refused a workspace first).
    'lambda/shared/voice_subjects.py': 1,
    # +2 (7.104.00): a product interview's transcript saved as a source (`save_interview_source`, and again past the
    # cap), the deployment's as the persona interview's document is.
    'lambda/shared/voice_transcripts.py': 4,
    # The bundle scripts and the backfill are the deployment's by design (they refuse a workspace).
    'scripts/project_bundle/exporter.py': 1,
    'scripts/project_bundle/remap.py': 1,
    'scripts/projects/backfill_review_registries.py': 1,
}


@dataclass(frozen=True)
class Guarded:
    module: str
    name: str


def _module_path(dotted: str) -> Path:
    return LAMBDA.joinpath(*dotted.split('.')).with_suffix('.py')


def _is_test(rel: Path) -> bool:
    parts, name = rel.parts, rel.name
    return ('test' in parts or 'tests' in parts or 'layers' in parts or 'node_modules' in parts
            or '__pycache__' in parts or name.startswith('test_') or name.endswith('_test.py') or name == 'conftest.py')


def production_files() -> list[Path]:
    found = []
    for top in SCANNED:
        found.extend(path for path in sorted((REPO / top).rglob('*.py')) if not _is_test(path.relative_to(REPO)))
    return found


KEYWORD: Final = 'keyword'
POSITIONAL: Final = 'positional'
#: The one public function that takes its scope by position: the refusal itself, whose first argument is the scope.
POSITIONAL_PUBLIC: Final = frozenset({'require_deployment'})
PUBLIC_POSITIONAL: Final = 'by position (a public store takes it keyword-only)'


def _workspace_parameter(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str | None:
    """None when ``node`` takes no ``workspace``; else ``KEYWORD`` (keyword-only, no default), ``POSITIONAL`` (by
    position, no default, in a private helper, ``_``-named, or ``require_deployment``: no call can leave it out) or
    what is wrong (a default, or a public function's by position)."""
    args = node.args
    keywords = [arg.arg for arg in args.kwonlyargs]
    if 'workspace' in keywords:
        default = args.kw_defaults[keywords.index('workspace')]
        return KEYWORD if default is None else f'a default ({ast.unparse(default)})'
    positional = [arg.arg for arg in (*args.posonlyargs, *args.args)]
    if 'workspace' not in positional:
        return None
    first_default = len(positional) - len(args.defaults)
    index = positional.index('workspace')
    if index >= first_default:
        return f'a default ({ast.unparse(args.defaults[index - first_default])})'
    return POSITIONAL if node.name.startswith('_') or node.name in POSITIONAL_PUBLIC else PUBLIC_POSITIONAL


def _scoped_functions(tree: ast.Module) -> Iterator[tuple[str, ast.FunctionDef | ast.AsyncFunctionDef]]:
    """Every function and method of a module, by its qualified name."""
    for node in tree.body:
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            yield node.name, node
        elif isinstance(node, ast.ClassDef):
            for member in node.body:
                if isinstance(member, ast.FunctionDef | ast.AsyncFunctionDef):
                    yield f'{node.name}.{member.name}', member


def guarded_names(dotted: str) -> dict[str, str]:
    """The callable names of ``dotted`` that take ``workspace`` → what is wrong with it ('' when nothing is)."""
    found = {}
    for qualified, node in _scoped_functions(ast.parse(_module_path(dotted).read_text(encoding='utf-8'))):
        state = _workspace_parameter(node)
        if state is None:
            continue
        cls, _, member = qualified.rpartition('.')
        if not cls:
            found[qualified] = state
        elif member == '__init__':
            found[cls] = state
        else:
            found[qualified] = state
    return found


@functools.cache
def _guarded_table() -> dict[str, frozenset[str]]:
    """The names a call is checked for: a function or class of each module whose ``workspace`` is a keyword (one
    taken by position cannot be left out, and a default fails the first rule whatever its kind)."""
    own = {dotted: frozenset(name for name, state in guarded_names(dotted).items()
                             if '.' not in name and state != POSITIONAL) for dotted in GUARDED}
    return {dotted: names | _reexports(dotted, own) for dotted, names in own.items()}


def _reexports(dotted: str, own: dict[str, frozenset[str]]) -> frozenset[str]:
    """The guarded names ``dotted`` imports from another guarded module, so a call through it is one of theirs
    (``document_comments.comments_pk``, ``projects.version_partition_key``)."""
    path = _module_path(dotted)
    found = set()
    for node in ast.parse(path.read_text(encoding='utf-8')).body:
        if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            base = _resolve_module(node.module, path)
            found.update(alias.asname or alias.name for alias in node.names
                         if base is not None and alias.name in own[base])
    return frozenset(found)


def _resolve_module(dotted: str, importer: Path) -> str | None:
    """The guarded module an import names from ``importer`` (an API module by its bare name from beside it)."""
    beside = importer.parent.joinpath(*dotted.split('.')).with_suffix('.py')
    if beside.is_file() and beside.is_relative_to(LAMBDA):
        dotted = '.'.join(beside.relative_to(LAMBDA).with_suffix('').parts)
    return dotted if dotted in GUARDED else None


@dataclass
class Bindings:
    functions: dict[str, Guarded]
    modules: dict[str, str]
    #: Imports of a guarded module the resolver cannot follow (relative, or ``*``): ``(line, module)``.
    unresolvable: list[tuple[int, str]]


def _relative_module(node: ast.ImportFrom, path: Path) -> str | None:
    """The dotted module (from lambda/) a relative import names, None outside lambda/."""
    if not path.is_relative_to(LAMBDA):
        return None
    package = path.parent.relative_to(LAMBDA).parts
    base = package[:len(package) - (node.level - 1)] if node.level > 1 else package
    return '.'.join((*base, *(node.module.split('.') if node.module else ())))


def _bindings(tree: ast.Module, path: Path, table: dict[str, frozenset[str]]) -> Bindings:
    functions: dict[str, Guarded] = {}
    modules: dict[str, str] = {}
    unresolvable: list[tuple[int, str]] = []
    own = '.'.join(path.relative_to(LAMBDA).with_suffix('').parts) if path.is_relative_to(LAMBDA) else None
    if own in table:
        functions.update({name: Guarded(own, name) for name in table[own]})
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                module = _resolve_module(alias.name, path)
                if module is not None:
                    modules[alias.asname or alias.name] = module
        elif isinstance(node, ast.ImportFrom) and node.level > 0:
            relative = _relative_module(node, path)
            names = {relative, *(f'{relative}.{alias.name}' for alias in node.names)} if relative else set()
            unresolvable.extend((node.lineno, name) for name in sorted(names & set(GUARDED)))
        elif isinstance(node, ast.ImportFrom) and node.module:
            base = _resolve_module(node.module, path)
            for alias in node.names:
                local = alias.asname or alias.name
                if base is not None and alias.name == '*':
                    unresolvable.append((node.lineno, base))
                elif base is not None and alias.name in table[base]:
                    functions[local] = Guarded(base, alias.name)
                elif (submodule := _resolve_module(f'{node.module}.{alias.name}', path)) is not None:
                    modules[local] = submodule
    return Bindings(functions, modules, unresolvable)


def _dotted(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        inner = _dotted(node.value)
        return None if inner is None else f'{inner}.{node.attr}'
    return None


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    target: str
    problem: str

    def __str__(self) -> str:
        return f'{self.path}:{self.line}: {self.target} {self.problem}'


def _target(node: ast.AST, bindings: Bindings, table: dict[str, frozenset[str]], by_name: frozenset[str],
            name_match: bool) -> Guarded | None:
    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
        return bindings.functions.get(node.id)
    if isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load):
        receiver = _dotted(node.value)
        module = bindings.modules.get(receiver) if receiver else None
        if module is not None:
            return Guarded(module, node.attr) if node.attr in table[module] else None
        if name_match and node.attr in by_name:
            return Guarded('?', node.attr)
    return None


def _annotations(node: ast.AST) -> Iterator[ast.expr]:
    """The type annotations ``node`` holds (a class named there is a type, not a call handed on)."""
    if isinstance(node, ast.arg | ast.AnnAssign) and node.annotation is not None:
        yield node.annotation
    if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.returns is not None:
        yield node.returns


#: Names that hold a scope: a guarded call inside a function binding one must pass it on, not a literal None.
SCOPE_NAMES: Final = frozenset({'workspace', 'scope', 'ws'})
#: The marker that lets a literal None stand where a scope is held: ``# deployment: <why>`` on one of the call's lines.
DEPLOYMENT_MARKER: Final = re.compile(r'#\s*deployment:\s*\S')
LITERAL_NONE_HELD: Final = ('passes a literal workspace=None where a scope is held: pass it on, or say why on the '
                            'line (`# deployment: <reason>`)')


@dataclass
class Scanned:
    findings: list[Finding]
    #: The guarded calls the module makes, and how many of them name the deployment by a literal ``workspace=None``.
    calls: int
    literal_none: int


def _held_scopes(tree: ast.Module) -> dict[int, frozenset[str]]:
    """For every node inside a function (or lambda), the scope names that function or one around it binds (its
    parameters and the names it assigns)."""
    held: dict[int, frozenset[str]] = {}

    def visit(node: ast.AST, outer: frozenset[str]) -> None:
        names = outer
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda):
            args = node.args
            bound = {arg.arg for arg in (*args.posonlyargs, *args.args, *args.kwonlyargs)}
            if not isinstance(node, ast.Lambda):
                bound |= {inner.id for inner in ast.walk(node) if isinstance(inner, ast.Name)
                          and isinstance(inner.ctx, ast.Store)}
            names = outer | (bound & SCOPE_NAMES)
        held[id(node)] = names
        for child in ast.iter_child_nodes(node):
            visit(child, names)

    visit(tree, frozenset())
    return held


#: The access policy's calls (3h-S2): each decides on the caller's membership of the project's workspace, so it takes
#: ``membership`` as it takes ``workspace``, a required keyword spelled out at every call (``membership=None`` beside
#: ``workspace=None`` for the deployment). The ratchet counts the ``workspace=None`` only: a ``membership=None``
#: always stands beside one (``project_access.require_membership`` refuses any other pairing at run time), so counting
#: it too would count each deployment call twice.
MEMBERSHIP_CALLS: Final = frozenset({
    'shared.project_access.resolve_access', 'shared.project_access.sharing_summary',
    'shared.project_gate.require_project_level', 'shared.project_gate.require_viewable_pin'})
MEMBERSHIP_MISSING: Final = 'is called without membership= (None for the deployment, membership_of(context) in one)'


def by_name_names(table: dict[str, frozenset[str]]) -> frozenset[str]:
    """The names an unresolved attribute call is matched by in ``BY_NAME``: every guarded name but the excluded pairs'
    (a name another guarded module also has stays)."""
    return frozenset(name for module, names in table.items() for name in names
                     if (module, name) not in BY_NAME_EXCLUDED)


def _is_literal_none(node: ast.Call) -> bool:
    return any(keyword.arg == 'workspace' and isinstance(keyword.value, ast.Constant) and keyword.value.value is None
               for keyword in node.keywords)


def scan(path: Path, table: dict[str, frozenset[str]], source: str | None = None) -> Scanned:
    """The calls of ``path`` (or of ``source``, read as if it were ``path``) that leave a guarded function's
    ``workspace`` out or drop a scope they hold, how many guarded calls it makes and how many name the deployment by
    a literal None."""
    text = path.read_text(encoding='utf-8') if source is None else source
    lines = text.splitlines()
    tree = ast.parse(text)
    bindings = _bindings(tree, path, table)
    rel = path.relative_to(REPO).as_posix()
    name_match = rel.startswith(BY_NAME)
    by_name = by_name_names(table)
    held = _held_scopes(tree)
    findings = [Finding(rel, line, module, 'is imported relatively or with *: import it by name')
                for line, module in bindings.unresolvable]
    calls = literal_none = 0
    called: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        target = _target(node.func, bindings, table, by_name, name_match)
        if target is None:
            continue
        called.add(id(node.func))
        calls += 1
        name = f'{target.module}.{target.name}'
        if _is_literal_none(node):
            literal_none += 1
            marked = any(DEPLOYMENT_MARKER.search(line) for line in lines[node.lineno - 1:node.end_lineno])
            if held.get(id(node)) and not marked:
                findings.append(Finding(rel, node.lineno, name, LITERAL_NONE_HELD))
        if not any(keyword.arg == 'workspace' for keyword in node.keywords):
            spread = any(keyword.arg is None for keyword in node.keywords)
            findings.append(Finding(rel, node.lineno, name,
                                    'gets its workspace through **kwargs: spell workspace= out' if spread
                                    else 'is called without workspace='))
        if name in MEMBERSHIP_CALLS and not any(keyword.arg == 'membership' for keyword in node.keywords):
            findings.append(Finding(rel, node.lineno, name, MEMBERSHIP_MISSING))
    skipped = called | {id(inner) for node in ast.walk(tree) for annotation in _annotations(node)
                        for inner in ast.walk(annotation)}
    for node in ast.walk(tree):
        if id(node) in skipped or not isinstance(node, ast.Name | ast.Attribute):
            continue
        target = _target(node, bindings, table, by_name, name_match=False)
        if target is not None:
            findings.append(Finding(rel, node.lineno, f'{target.module}.{target.name}',
                                    'is handed on as a value: call it, passing workspace='))
    return Scanned(findings, calls, literal_none)


def test_every_guarded_module_exists_and_takes_a_workspace():
    missing = [dotted for dotted in GUARDED if not _module_path(dotted).is_file() or not guarded_names(dotted)]
    assert not missing, f'GUARDED names a module that is gone or takes no workspace: {missing}'


@pytest.mark.parametrize('dotted', GUARDED)
def test_workspace_is_a_required_keyword(dotted):
    """No default: a store that is not told its scope fails at the call, never falls back to the deployment."""
    wrong = {name: state for name, state in guarded_names(dotted).items() if state not in (KEYWORD, POSITIONAL)}
    assert not wrong, f'{dotted}: `workspace` must have no default (`*, workspace: …`): {wrong}'


def test_every_call_passes_its_workspace():
    table = _guarded_table()
    findings = [str(finding) for path in production_files() for finding in scan(path, table).findings]
    assert not findings, ('a project store is called without its scope: pass `workspace=` (None for the '
                          f'deployment, the resolved scope in a workspace): {len(findings)} calls\n'
                          + '\n'.join(findings))


def _literal_nones() -> dict[str, int]:
    table = _guarded_table()
    counts = {path.relative_to(REPO).as_posix(): scan(path, table).literal_none for path in production_files()}
    return {module: count for module, count in counts.items() if count}


def test_the_literal_nones_match_the_ratchet():
    """Each module names the deployment by a literal ``workspace=None`` exactly as often as ``LITERAL_NONE`` says: a
    new one fails until its count is raised in the same change (refused in review), one removed fails until the count
    is lowered, so every change to the list shows in the diff."""
    found = _literal_nones()
    differ = {module: {'allowed': LITERAL_NONE.get(module, 0), 'found': found.get(module, 0)}
              for module in sorted(set(found) | set(LITERAL_NONE)) if found.get(module) != LITERAL_NONE.get(module)}
    assert not differ, f'literal workspace=None calls differ from LITERAL_NONE (lower an entry when a call moves): {differ}'


def test_every_ratchet_entry_counts_something():
    assert all(count > 0 for count in LITERAL_NONE.values())


@pytest.mark.parametrize('reader', NON_API_READERS)
def test_the_non_api_readers_are_scanned(reader):
    scanned = {path.relative_to(REPO).as_posix() for path in production_files()}
    files = sorted(path for path in scanned if path == reader or path.startswith(f'{reader}/'))
    assert files, f'{reader} is not in the scan'
    sources = [(REPO / path).read_text(encoding='utf-8') for path in files]
    assert any('get_projects_table' in source or 'PROJECTS_TABLE' in source for source in sources), (
        f'{reader} no longer reads projects: take it out of NON_API_READERS')


def test_retention_is_resolved():
    """The retention worker's store calls are seen (an import style the resolver misses would pass them silently)."""
    table = _guarded_table()
    calls = sum(scan(path, table).calls for path in production_files()
                if path.relative_to(REPO).as_posix().startswith('lambda/jobs/retention/'))
    assert calls > 0


#: Where a probe is read as if it sat: the scan resolves an import from its module's own folder.
PROBE: Final = LAMBDA / 'shared' / '_workspace_guard_probe.py'
MISSING: Final = 'is called without workspace='


def _probe(source: str, path: Path = PROBE) -> list[str]:
    return [f'{finding.line}: {finding.target} {finding.problem}'
            for finding in scan(path, _guarded_table(), source).findings]


@pytest.mark.parametrize(('source', 'expected'), [
    ('from shared.project_keys import project_pk\nproject_pk("p")\n', [f'2: shared.project_keys.project_pk {MISSING}']),
    ('from shared.project_keys import project_pk as pk\npk("p")\n', [f'2: shared.project_keys.project_pk {MISSING}']),
    ('from shared import project_keys\nproject_keys.project_pk("p")\n',
     [f'2: shared.project_keys.project_pk {MISSING}']),
    ('import shared.document_versions\nshared.document_versions.series_head_version(1, "p")\n',
     [f'2: shared.document_versions.series_head_version {MISSING}']),
    ('import shared.document_versions as v\nv.series_head_version(1, "p")\n',
     [f'2: shared.document_versions.series_head_version {MISSING}']),
    ('def f():\n    from shared.project_gate import read_gate_meta\n    read_gate_meta(1, "p")\n',
     [f'3: shared.project_gate.read_gate_meta {MISSING}']),
    ('from shared.prototype_versions import PrototypeStore\nPrototypeStore(table=1)\n',
     [f'2: shared.prototype_versions.PrototypeStore {MISSING}']),
    ('from shared.project_keys import project_pk\nproject_pk("p", **options)\n',
     ['2: shared.project_keys.project_pk gets its workspace through **kwargs: spell workspace= out']),
    ('from functools import partial\nfrom shared.project_keys import project_pk\npartial(project_pk, "p")\n',
     ['3: shared.project_keys.project_pk is handed on as a value: call it, passing workspace=']),
    ('from shared.project_keys import project_pk\nproject_pk("p", workspace=None)\n', []),
    ('from shared.project_keys import project_pk\nproject_pk("p", workspace=scope)\n', []),
    ('from shared.project_keys import PROJECT_PREFIX\nlen(PROJECT_PREFIX)\n', []),
    ('from shared.ids import timestamped_id\ntimestamped_id("p")\n', []),
    (('from shared.prototype_versions import PrototypeStore\ndef f(s: PrototypeStore) -> PrototypeStore:\n'
      '    t: PrototypeStore = s\n    return t\n'), []),
])
def test_the_resolver_sees_every_import_style(source, expected):
    assert _probe(source) == expected


def test_a_name_reexported_by_a_guarded_module_is_seen_through_it():
    source = 'from shared import document_comments as dc\ndc.comments_pk("p", "s")\n'
    assert _probe(source) == [f'2: shared.document_comments.comments_pk {MISSING}']


def test_an_api_module_resolves_by_its_bare_name_beside_it():
    source = 'import projects\nprojects.create_project({}, caller)\n'
    assert _probe(source, LAMBDA / 'api' / '_probe.py') == [f'2: api.projects.create_project {MISSING}']
    assert _probe(source) == []


def test_a_bundle_script_is_matched_by_name():
    """remap.py's lazy helpers (``helpers.keys``) resolve to no import, so there the name alone decides."""
    source = 'helpers.keys.version_partition_key("p")\nhelpers.keys.version_partition_key("p", workspace=None)\n'
    assert _probe(source, REPO / BUNDLE_SCRIPTS / '_probe.py') == [f'1: ?.version_partition_key {MISSING}']
    assert _probe(source) == []


def test_an_excluded_pair_is_not_matched_by_name():
    """``assist_jobs.get`` is guarded, but a bundle script's ``row.get(…)`` is a dict's: by name alone it is left out,
    while the same call through an import is still seen."""
    assert 'get' in _guarded_table()['shared.assist_jobs']
    assert _probe('row.get("pk")\n', REPO / BUNDLE_SCRIPTS / '_probe.py') == []
    assert _probe('from shared import assist_jobs\nassist_jobs.get("pk", "job")\n') == [
        f'2: shared.assist_jobs.get {MISSING}']


def test_every_excluded_pair_is_a_guarded_name():
    """An exclusion whose store no longer has the name (renamed, unguarded) is stale: drop it."""
    table = _guarded_table()
    assert all(name in table.get(module, ()) for module, name in BY_NAME_EXCLUDED)


def test_no_other_guarded_name_is_a_builtin_methods():
    """The exclusions cannot grow unseen: a guarded name a builtin container's method also has (a store's ``keys``,
    ``update``, ``pop``…) fails here, to be renamed or excluded by its pair in review. Today only ``get``, excluded."""
    table = _guarded_table()
    clashes = {(module, name) for module, names in table.items() for name in names if name in BUILTIN_METHODS}
    assert clashes == {('shared.assist_jobs', 'get')} == BY_NAME_EXCLUDED
    assert not by_name_names(table) & BUILTIN_METHODS


def test_a_default_or_a_positional_workspace_is_named():
    tree = ast.parse('def a(*, workspace=None): ...\ndef _b(t, workspace, k=1): ...\ndef c(*, workspace): ...\n'
                     'def d(x): ...\ndef e(t, workspace=None): ...\ndef f(t, workspace): ...\n'
                     'def require_deployment(workspace, store): ...\n')
    states = [_workspace_parameter(node) for node in tree.body if isinstance(node, ast.FunctionDef)]
    assert states == ['a default (None)', POSITIONAL, KEYWORD, None, 'a default (None)', PUBLIC_POSITIONAL,
                      POSITIONAL]


@pytest.mark.parametrize(('source', 'expected'), [
    ('from shared.project_keys import project_pk\ndef f(workspace):\n    return project_pk("p", workspace=None)\n',
     [f'3: shared.project_keys.project_pk {LITERAL_NONE_HELD}']),
    ('from shared.project_keys import project_pk\ndef f(x):\n    scope = x\n    return project_pk("p", workspace=None)\n',
     [f'4: shared.project_keys.project_pk {LITERAL_NONE_HELD}']),
    ('from shared.project_keys import project_pk\ndef f(ws):\n    return lambda: project_pk("p", workspace=None)\n',
     [f'3: shared.project_keys.project_pk {LITERAL_NONE_HELD}']),
    (('from shared.project_keys import project_pk\ndef f(workspace):\n'
      '    return project_pk("p", workspace=None)  # deployment: the claim row is deployment-wide\n'), []),
    ('from shared.project_keys import project_pk\ndef f(workspace):\n    return project_pk("p", workspace=workspace)\n',
     []),
    ('from shared.project_keys import project_pk\ndef f(x):\n    return project_pk("p", workspace=None)\n', []),
])
def test_a_literal_none_where_a_scope_is_held_needs_a_reason(source, expected):
    assert _probe(source) == expected


@pytest.mark.parametrize('source', [
    'from .project_keys import project_pk\n',
    'from . import project_keys\n',
    'from shared.project_keys import *\n',
])
def test_a_relative_or_star_import_of_a_guarded_module_fails(source):
    assert _probe(source) == ['1: shared.project_keys is imported relatively or with *: import it by name']


def test_the_ratchet_counts_aliases_and_every_literal_none():
    source = ('from shared.avatar import generate_persona_avatar as _gen\nfrom shared import project_keys\n'
              '_gen({}, "b", "p", workspace=None)\nproject_keys.project_pk("p", workspace=None)\n'
              'project_keys.project_pk("p", workspace=held)\n')
    found = scan(PROBE, _guarded_table(), source)
    assert (found.calls, found.literal_none, found.findings) == (3, 2, [])


@pytest.mark.parametrize(('source', 'expected'), [
    ('from shared.project_access import resolve_access\nresolve_access(m, c, workspace=None)\n',
     [f'2: shared.project_access.resolve_access {MEMBERSHIP_MISSING}']),
    ('from shared import project_gate\nproject_gate.require_project_level(r, c, "view", workspace=s)\n',
     [f'2: shared.project_gate.require_project_level {MEMBERSHIP_MISSING}']),
    ('from shared.project_gate import require_viewable_pin\nrequire_viewable_pin(t, p, c)\n',
     [f'2: shared.project_gate.require_viewable_pin {MISSING}',
      f'2: shared.project_gate.require_viewable_pin {MEMBERSHIP_MISSING}']),
    ('from shared import project_access\nproject_access.sharing_summary(m, c, workspace=None, membership=None)\n', []),
    ('from shared.project_gate import read_gate_meta\nread_gate_meta(t, p, workspace=None)\n', []),
])
def test_the_policys_calls_spell_their_membership(source, expected):
    assert _probe(source) == expected


def test_a_membership_none_is_not_counted_by_the_ratchet():
    source = 'from shared import project_access\nproject_access.resolve_access(m, c, workspace=None, membership=None)\n'
    found = scan(PROBE, _guarded_table(), source)
    assert (found.calls, found.literal_none, found.findings) == (1, 1, [])


# ── The one builder of a route's membership ─────────────────────────────────

#: Where a ``WorkspaceMembership`` may be built: the policy's own module and shared/workspace.py ``membership_of``,
#: the one builder a route uses (from the membership it resolved), so no route hands the gate a role it made up.
MEMBERSHIP_BUILDERS: Final = frozenset({'lambda/shared/project_access.py', 'lambda/shared/workspace.py'})
MEMBERSHIP_CLASS: Final = 'WorkspaceMembership'


def membership_builds(source: str) -> list[int]:
    """The lines of ``source`` that build a ``WorkspaceMembership`` (by its name or an attribute of that name), or
    import it under another name (which the first rule could not see). Not seen: ``dataclasses.replace`` of one,
    ``getattr``, a name rebound by assignment."""
    lines = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Call):
            func = node.func
            if (isinstance(func, ast.Name) and func.id == MEMBERSHIP_CLASS) or (
                    isinstance(func, ast.Attribute) and func.attr == MEMBERSHIP_CLASS):
                lines.append(node.lineno)
        elif isinstance(node, ast.ImportFrom) and any(
                alias.name == MEMBERSHIP_CLASS and alias.asname not in (None, MEMBERSHIP_CLASS) for alias in node.names):
            lines.append(node.lineno)
    return sorted(lines)


def test_only_membership_of_builds_a_routes_membership():
    found = [f'{rel}:{line}' for path in production_files()
             if (rel := path.relative_to(REPO).as_posix()) not in MEMBERSHIP_BUILDERS
             for line in membership_builds(path.read_text(encoding='utf-8'))]
    assert not found, ('a WorkspaceMembership is built outside shared/workspace.py membership_of: build it from the '
                       f'resolved context with membership_of(context): {found}')


def test_the_builders_exist_and_build_one():
    assert all((REPO / rel).is_file() for rel in MEMBERSHIP_BUILDERS)
    assert membership_builds((REPO / 'lambda/shared/workspace.py').read_text(encoding='utf-8'))


@pytest.mark.parametrize(('source', 'expected'), [
    ('from shared.project_access import WorkspaceMembership\nWorkspaceMembership(scope=s, subject="x", role="admin")\n',
     [2]),
    ('from shared import project_access\nproject_access.WorkspaceMembership(s, "x", "admin")\n', [2]),
    ('from shared.project_access import WorkspaceMembership as M\nM(s, "x", "admin")\n', [1]),
    ('from shared.project_access import WorkspaceMembership\ndef f(m: WorkspaceMembership) -> None: ...\n', []),
    ('from shared.workspace import membership_of\nmembership_of(context)\n', []),
])
def test_a_membership_built_by_hand_is_seen(source, expected):
    assert membership_builds(source) == expected
