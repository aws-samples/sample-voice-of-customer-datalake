"""A project with product sources and a product context in a moto voc-projects, for the product extract's and the
proposals' tests (7.104.00, shared/product_extract.py, shared/product_proposals.py)."""
from __future__ import annotations

import io
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import patch

import moto
import pytest

from shared.product_sources import UNTRUSTED_DOC_BEGIN, UNTRUSTED_DOC_END, UNTRUSTED_DOC_NOTICE
from shared.test.moto_tables import create_pk_sk_table

PROJECT = 'p1'
TABLE = 'test-projects'
#: The fence every source is sent in (shared/product_sources.py, the PRD / PR-FAQ block's).
BEGIN, END, NOTICE = UNTRUSTED_DOC_BEGIN, UNTRUSTED_DOC_END, UNTRUSTED_DOC_NOTICE
FOLDER = f'projects/{PROJECT}/product_docs'


class FakeS3:
    """``get_object`` over a dict of key → bytes (a missing key raises KeyError: no test reads one)."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.reads: list[str] = []

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        if Bucket != 'raw-bucket':
            raise KeyError(Bucket)
        self.reads.append(Key)
        return {'Body': io.BytesIO(self.objects[Key])}


@dataclass
class World:
    """The moto table, the fake bucket and the rows put so far."""

    table: Any
    s3: FakeS3
    docs: list[dict[str, Any]] = field(default_factory=list)

    def source(self, doc_id: str, *, kind: str = 'file', text: str | None = 'Text', content_type: str = 'text/markdown',
               status: str = 'ready', created_at: str = '2026-11-01T00:00:00+00:00', image: bytes | None = None,
               **extra: Any) -> dict[str, Any]:
        row = {'pk': f'PROJECT#{PROJECT}', 'sk': f'PRODUCT_DOC#{doc_id}', 'doc_id': doc_id, 'status': status,
               'source_kind': kind, 'content_type': content_type, 'filename': f'{doc_id}.md',
               'created_at': created_at, **extra}
        if text is not None:
            row['s3_extracted_key'] = f'{FOLDER}/extracted/{doc_id}.txt'
            self.s3.objects[row['s3_extracted_key']] = text.encode('utf-8')
        if image is not None:
            row['s3_raw_key'] = f'{FOLDER}/raw/{doc_id}.png'
            self.s3.objects[row['s3_raw_key']] = image
        self.table.put_item(Item=row)
        self.docs.append(row)
        return row

    def context(self, **values: Any) -> None:
        self.table.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'PRODUCT_CONTEXT', **values})


@pytest.fixture
def world() -> Iterator[World]:
    with moto.mock_aws():
        table = create_pk_sk_table(TABLE)
        table.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT, 'name': 'Orbit'})
        with patch('shared.model_config._load_settings', return_value={}):
            yield World(table, FakeS3())
