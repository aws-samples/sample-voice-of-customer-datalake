"""Every API handler imports only what its deployed bundle contains.

`createApiLambdaCode` (lib/stacks/api-stack.ts) ships `api/<handler>.py`, `shared/`,
`projects.py`, `product_context.py`, `prompts/` and `static/` — NOT the other modules in
`lambda/api/`. Tests run with all of `lambda/api` on the path, so a handler importing a
sibling module passes every test and then fails its cold start with
`Runtime.ImportModuleError`. That is how `metrics_handler` importing `github_metrics`
took the whole dashboard down in production (2026-10-05). Shared code belongs in `shared/`.
"""
import ast
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
# Copied into every API bundle next to the handler (keep in step with createApiLambdaCode).
BUNDLED_SIBLINGS = frozenset({'projects', 'product_context'})


def _top_level_imports(path: Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
        if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.add(node.module.split('.')[0])
        elif isinstance(node, ast.Import):
            names.update(alias.name.split('.')[0] for alias in node.names)
    return names


def unbundled_sibling_imports(api_dir: Path) -> list[str]:
    """`<module>.py imports <sibling>` for every shipped module that imports an unshipped sibling."""
    siblings = {path.stem for path in api_dir.glob('*.py') if path.stem != '__init__'}
    shipped = sorted(BUNDLED_SIBLINGS & siblings | {path.stem for path in api_dir.glob('*_handler.py')})
    return sorted(
        f'{module}.py imports {name}'
        for module in shipped
        for name in _top_level_imports(api_dir / f'{module}.py')
        if name in siblings - BUNDLED_SIBLINGS - {module}
    )


def test_no_handler_imports_a_sibling_module_its_bundle_does_not_ship():
    assert unbundled_sibling_imports(API_DIR) == []


def test_the_scan_reports_a_handler_importing_an_unshipped_sibling(tmp_path):
    (tmp_path / 'metrics_handler.py').write_text('from helper import x\nimport projects\n', encoding='utf-8')
    (tmp_path / 'helper.py').write_text('x = 1\n', encoding='utf-8')
    (tmp_path / 'projects.py').write_text('', encoding='utf-8')

    assert unbundled_sibling_imports(tmp_path) == ['metrics_handler.py imports helper']
