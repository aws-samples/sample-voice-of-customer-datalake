"""Only the model picker may read BEDROCK_MODEL_ID (issue #273).

`shared.aws.BEDROCK_MODEL_ID` is the last-resort default at the bottom of
`shared.model_config`'s resolution chain. Any other production module that reads
it bypasses the per-surface picker: the avatar prompt writer did, and AccessDenied
in every deployment where that one model was not enabled, while the persona
provenance stamp recorded a model that had not run. Model ids reach Bedrock through
`shared/model_config.py` / `shared/converse.py` only.

Checked on the AST, so a docstring or comment naming the constant is fine; an
import, a bare name or an attribute access is not.
"""
import ast
from pathlib import Path

LAMBDA_ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOTS = (LAMBDA_ROOT, LAMBDA_ROOT.parent / 'plugins')

# The definition and the one reader.
ALLOWED = frozenset({
    LAMBDA_ROOT / 'shared' / 'aws.py',
    LAMBDA_ROOT / 'shared' / 'model_config.py',
})
CONSTANT = 'BEDROCK_MODEL_ID'


def _is_production(path: Path) -> bool:
    parts = set(path.parts)
    return not (
        {'test', 'tests', 'node_modules', '.venv', 'python'} & parts
        or path.name.startswith('test_')
        or path.name == 'conftest.py'
    )


def _references(tree: ast.AST) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id == CONSTANT:
            return True
        if isinstance(node, ast.Attribute) and node.attr == CONSTANT:
            return True
        if isinstance(node, ast.ImportFrom) and any(a.name == CONSTANT for a in node.names):
            return True
    return False


def _offenders() -> list[str]:
    return sorted(
        str(path.relative_to(LAMBDA_ROOT.parent))
        for root in SOURCE_ROOTS
        for path in root.rglob('*.py')
        if _is_production(path) and path not in ALLOWED
        and _references(ast.parse(path.read_text(encoding='utf-8')))
    )


def test_only_model_config_reads_bedrock_model_id():
    assert _offenders() == []


def test_the_scan_sees_production_code():
    """Guards the guard: a path bug that scanned nothing would pass vacuously."""
    from shared import model_config

    tree = ast.parse(Path(model_config.__file__).read_text(encoding='utf-8'))

    assert _references(tree)
    assert _is_production(LAMBDA_ROOT / 'api' / 'projects.py')
