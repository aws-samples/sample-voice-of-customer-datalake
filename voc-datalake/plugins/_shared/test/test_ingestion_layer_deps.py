"""Every third-party package a plugin Lambda imports is in the ingestion-deps layer.

Plugin Lambdas get their code from ``plugins/<id>/``, ``plugins/_shared`` and ``lambda/shared``,
and their dependencies ONLY from ``lambda/layers/ingestion-deps``. 3.06 made
``_shared.base_ingestor`` import ``shared.ingest_schemas`` (through the source policy), which
needs pydantic, a package only the processing layer carried: every ingestor then failed at
import (``Runtime.ImportModuleError: No module named 'pydantic'``) while the unit tests, which
run in the dev venv, stayed green.

The check walks the import graph on the AST from each plugin handler, following the modules
that ship in the bundle, and collects every other top-level import (including lazy imports
inside functions). Each must be the standard library, the Lambda runtime's boto3/botocore, or
a distribution named in the layer's ``requirements.txt``.
"""
import ast
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]  # voc-datalake/
PLUGINS = ROOT / 'plugins'
REQUIREMENTS = ROOT / 'lambda' / 'layers' / 'ingestion-deps' / 'requirements.txt'
#: The Python Lambda runtime ships these.
RUNTIME_PROVIDED = frozenset({'boto3', 'botocore', 's3transfer', 'jmespath', 'dateutil', 'urllib3', 'six'})
#: Import name of a distribution when it differs from the normalised distribution name.
IMPORT_NAMES = {
    'beautifulsoup4': {'bs4'},
    'aws-lambda-powertools': {'aws_lambda_powertools'},
    'websocket-client': {'websocket'},
    'app-store-web-scraper': {'app_store_web_scraper'},
    'google-play-scraper': {'google_play_scraper'},
    'pydantic': {'pydantic', 'pydantic_core'},
}
#: Extra import names a requirement's extras bring (`aws-lambda-powertools[tracer]` installs the X-Ray SDK).
EXTRA_IMPORT_NAMES = {('aws-lambda-powertools', 'tracer'): {'aws_xray_sdk'}}
#: Marks a relative import, resolved to a file path rather than a module name.
RELATIVE = 'path:'


def layer_import_names(text: str) -> set[str]:
    """Top-level import names the requirements in *text* provide."""
    names: set[str] = set()
    for raw in text.splitlines():
        line = raw.split('#', 1)[0].strip()
        if not line:
            continue
        dist = re.split(r'[\s<>=!~;\[]', line, maxsplit=1)[0].lower()
        names |= IMPORT_NAMES.get(dist, {dist.replace('-', '_')})
        extras = re.search(r'\[([^\]]*)\]', line)
        for extra in (extras.group(1).split(',') if extras else []):
            names |= EXTRA_IMPORT_NAMES.get((dist, extra.strip().lower()), set())
    return names


def _bundle_roots(plugin_dir: Path) -> list[Path]:
    """Where the bundle's modules live, in sys.path order (the ingestor dir, then the copies)."""
    return [plugin_dir / 'ingestor', plugin_dir / 'webhook', plugin_dir, PLUGINS, ROOT / 'lambda']


def _resolve(name: str, roots: list[Path]) -> Path | None:
    parts = name.split('.')
    for root in roots:
        base = root.joinpath(*parts)
        for candidate in (base.with_suffix('.py'), base / '__init__.py'):
            if candidate.is_file():
                return candidate
    return None


def _imported_names(tree: ast.AST, path: Path) -> set[str]:
    """Absolute module names *tree* (the module at *path*) imports; relative imports resolved."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                package = path.parents[node.level - 1]
                names.add(f'{RELATIVE}{package / node.module}' if node.module else f'{RELATIVE}{package}')
                names |= {f'{RELATIVE}{package / (node.module or "") / alias.name}' for alias in node.names}
            elif node.module:
                names.add(node.module)
                names |= {f'{node.module}.{alias.name}' for alias in node.names}
    return names


def _resolve_any(name: str, roots: list[Path]) -> Path | None:
    if not name.startswith(RELATIVE):
        return _resolve(name, roots)
    base = Path(name.removeprefix(RELATIVE))
    for candidate in (base.with_suffix('.py'), base / '__init__.py'):
        if candidate.is_file():
            return candidate
    return None


def external_imports(entry: Path, roots: list[Path]) -> dict[str, str]:
    """Top-level names imported from outside the bundle -> the bundle file that imports each."""
    found: dict[str, str] = {}
    pending, seen = [entry], set[Path]()
    while pending:
        path = pending.pop()
        if path in seen:
            continue
        seen.add(path)
        for name in sorted(_imported_names(ast.parse(path.read_text(encoding='utf-8')), path)):
            module = _resolve_any(name, roots)
            if module is not None:
                pending.append(module)
                continue
            if name.startswith(RELATIVE):
                continue  # a name imported from a bundle package (a function, a class), not a module
            top = name.split('.', 1)[0]
            if _resolve(top, roots) is None:
                found.setdefault(top, str(path.relative_to(ROOT)))
    return found


def _entry_points() -> list[Path]:
    return sorted(
        path for pattern in ('*/ingestor/handler.py', '*/webhook/handler.py')
        for path in PLUGINS.glob(pattern) if not path.parts[-3].startswith('_')
    )


def _allowed() -> set[str]:
    return layer_import_names(REQUIREMENTS.read_text(encoding='utf-8')) | RUNTIME_PROVIDED | set(sys.stdlib_module_names)


@pytest.mark.parametrize('entry', _entry_points(), ids=lambda path: str(path.relative_to(PLUGINS)))
def test_every_third_party_import_of_a_plugin_lambda_is_in_the_ingestion_layer(entry: Path):
    missing = {name: where for name, where in external_imports(entry, _bundle_roots(entry.parents[1])).items()
               if name not in _allowed()}
    assert missing == {}


def test_the_scan_finds_the_plugin_handlers_and_follows_the_shared_code():
    web_reviews = PLUGINS / 'web_reviews' / 'ingestor' / 'handler.py'
    assert web_reviews in _entry_points()
    assert 'pydantic' in external_imports(web_reviews, _bundle_roots(web_reviews.parents[1]))


def test_a_package_missing_from_the_layer_is_reported():
    assert 'pydantic' not in layer_import_names('requests>=2.31.0\nwebsocket-client==1.9.2\n')
    assert layer_import_names('beautifulsoup4>=4\naws-lambda-powertools[tracer]>=2\npydantic==2.14.1  # x\n') == {
        'bs4', 'aws_lambda_powertools', 'aws_xray_sdk', 'pydantic', 'pydantic_core'}
