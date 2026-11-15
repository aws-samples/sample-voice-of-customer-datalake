"""Test support: a fictional monorepo (npm workspaces, a Python package, a Cargo crate) as the host would list it."""
from __future__ import annotations

from collections.abc import Collection, Generator
from contextlib import contextmanager
from typing import Any

import boto3

from engineering.board.test.table import engineering_table
from engineering.knowledge.notes import CitationRules
from engineering.workspace.store import WorkspaceStore

BUCKET = 'voc-eng-workspace'

WEB_URL = 'https://github.com/lumen-fixtures/harbor'
SHA_A, SHA_B, SHA_C = 'a' * 40, 'b1' * 20, 'c2' * 20

PATHS = (
    'package.json', 'Cargo.toml', 'README.md', '.github/CODEOWNERS', '.github/workflows/ci.yml',
    'packages/web/package.json', 'packages/web/src/app.ts', 'packages/web/src/routes/home.ts',
    'packages/web/test/app.test.ts',
    'packages/api/package.json', 'packages/api/src/server.ts',
    'services/billing/pyproject.toml', 'services/billing/billing/__init__.py', 'services/billing/billing/invoice.py',
    'services/billing/tests/test_invoice.py',
    'crates/ledger/Cargo.toml', 'crates/ledger/src/lib.rs',
    'node_modules/left-pad/package.json', 'node_modules/left-pad/index.js',
)

MANIFESTS = {
    'package.json': '{"name": "harbor", "private": true, "workspaces": ["packages/*"]}',
    'packages/web/package.json': '{"name": "@harbor/web"}',
    # A workspace member whose manifest names nothing: still a member.
    'packages/api/package.json': '{"private": true}',
    'services/billing/pyproject.toml': '[project]\nname = "harbor-billing"\n',
    'crates/ledger/Cargo.toml': '[package]\nname = "ledger"\nversion = "0.1.0"\n',
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
    '.github/CODEOWNERS': ('# owners\n* @harbor/core\n/packages/web/ @harbor/frontend someone@example.com\n'
                           'services/ @harbor/billing\n*.py @harbor/python\n'),
    'node_modules/left-pad/package.json': '{"name": "left-pad"}',
}

PACKAGES = frozenset({'.', 'packages/web', 'packages/api', 'services/billing', 'crates/ledger'})


def rules(*, paths: Collection[str] | None = PATHS, shas: Collection[str] | None = (SHA_A, SHA_B, SHA_C)
          ) -> CitationRules:
    return CitationRules('github', WEB_URL, frozenset(paths) if paths is not None else None,
                         frozenset(shas) if shas is not None else None)


@contextmanager
def pack_tables() -> Generator[tuple[Any, Any, WorkspaceStore]]:
    """The voc-engineering table and the workspace bucket on moto: a DynamoDB client, an S3 client, the store."""
    with engineering_table() as client:
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        yield client, s3, WorkspaceStore(s3, BUCKET)
