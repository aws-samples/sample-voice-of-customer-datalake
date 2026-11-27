"""The product sources' world on moto (7.104.00): the projects and aggregates tables, the raw bucket, one project, the
twin's invoke recorded and run in-line, the resolver answering a public address, and pages served by a fake fetch.
Neutral product names only."""
from __future__ import annotations

import io
from collections.abc import Callable, Generator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import requests
from moto import mock_aws
from requests.structures import CaseInsensitiveDict

from shared import product_source_links, product_source_routes, product_source_worker, product_sources
from shared.library_extract import Reading
from shared.product_sources import product_doc_extracted_key, source_row_key
from shared.test.moto_tables import create_pk_sk_table

BUCKET = 'test-raw-data-bucket'
PROJECT = 'proj_20261126120000_a1b2c3d4'
PUBLIC_IP = '93.184.216.34'
#: The claim a seeded source is read under (``SourcesWorld.claimed``).
CLAIM = 'tok-1'
PAGE_TEXT = ('Acme Notes keeps a team\'s meeting notes in one searchable place. It turns each call into a summary, '
             'lists the decisions taken and the open questions, and links every action to its owner. Teams use it '
             'to prepare the next meeting from the last one, to find what was agreed months ago, and to share a '
             'short digest with the people who were not there. It works in the browser and on a phone, and it reads '
             'calendar invitations to know who attended and what the meeting was about.')
PAGE = (f'<html><head><title>Acme Notes &amp; more</title><script>var x = 1;</script></head><body><p>{PAGE_TEXT}</p>'
        '</body></html>')


def html_page(text: str = PAGE) -> bytes:
    return text.encode('utf-8')


def response(url: str, body: bytes = b'', *, status: int = 200, content_type: str = 'text/html; charset=utf-8',
             headers: dict[str, str] | None = None) -> requests.Response:
    """A requests Response as ``fetch_public_url`` answers it (its body read already)."""
    answer = requests.Response()
    answer.status_code = status
    answer.url = url
    answer.headers = CaseInsensitiveDict({'Content-Type': content_type, **(headers or {})})
    answer.raw = io.BytesIO(body)
    return answer


@dataclass
class Pages:
    """A fake ``fetch_public_url``: each URL's answer (a Response or an exception), and the calls made."""

    answers: dict[str, requests.Response | Exception] = field(default_factory=dict)
    calls: list[dict[str, Any]] = field(default_factory=list)

    def serve(self, url: str, body: bytes = html_page(), **options: Any) -> None:
        self.answers[url] = response(options.pop('final_url', url), body, **options)

    def __call__(self, url: str, **kwargs: Any) -> requests.Response:
        self.calls.append({'url': url, **kwargs})
        answer = self.answers[url]
        if isinstance(answer, Exception):
            raise answer
        return answer


@dataclass
class SourcesWorld:
    projects: Any
    aggregates: Any
    s3: Any
    invoke: MagicMock
    pages: Pages
    describe: MagicMock

    def maybe_row(self, doc_id: str) -> dict | None:
        return self.projects.get_item(Key=source_row_key(PROJECT, doc_id, workspace=None)).get('Item')

    def row(self, doc_id: str) -> dict:
        row = self.maybe_row(doc_id)
        if row is None:
            raise AssertionError(f'no source row {doc_id}')
        return row

    def text(self, doc_id: str) -> str | None:
        try:
            body = self.s3.get_object(Bucket=BUCKET, Key=product_doc_extracted_key(PROJECT, doc_id, workspace=None))['Body']
        except self.s3.exceptions.NoSuchKey:
            return None
        return body.read().decode('utf-8')

    def seed(self, doc_id: str, **fields: Any) -> dict:
        """A source row of the project, ``fields`` over a pending upload's."""
        row = {**source_row_key(PROJECT, doc_id, workspace=None), 'doc_id': doc_id, 'filename': f'{doc_id}.pdf',
               'content_type': 'application/pdf', 'size_bytes': 10, 's3_raw_key': None, 's3_extracted_key': None,
               'status': 'pending', 'error': None, 'extracted_chars': 0, 'created_at': '2026-11-26T10:00:00+00:00',
               'source_kind': 'file', **fields}
        self.projects.put_item(Item=row)
        return row

    def upload(self, doc_id: str, ext: str, data: bytes, content_type: str) -> None:
        self.s3.put_object(Bucket=BUCKET, Key=f'projects/{PROJECT}/product_docs/source/{doc_id}.{ext}', Body=data,
                           ContentType=content_type)

    def claimed(self, doc_id: str, token: str = CLAIM, **fields: Any) -> dict:
        """A source the twin was handed under ``token`` (``fields`` over it)."""
        return self.seed(doc_id, **{'status': 'extracting', 'extract_token': token,
                                    'claimed_at': '2026-11-26T10:00:00+00:00', **fields})

    def run_worker(self) -> list[dict[str, str]]:
        """Run the twin for every invoke made so far (and forget them)."""
        events = [call.args[1] for call in self.invoke.call_args_list]
        self.invoke.reset_mock()
        return [product_source_worker.run(event) for event in events]

    def sources(self) -> list[dict]:
        return product_sources.list_sources(self.projects, PROJECT, workspace=None)


def _public_answers(*_args: Any, **_kwargs: Any) -> list:
    return [(2, 1, 6, '', (PUBLIC_IP, 0))]


@contextmanager
def sources_world(*, describe: Callable[..., Reading] | None = None) -> Generator[SourcesWorld]:
    """The world, inside ``mock_aws``: every AWS call the sources make lands on moto."""
    with mock_aws(), ExitStack() as stack:
        projects = create_pk_sk_table('test-projects')
        aggregates = create_pk_sk_table('test-aggregates')
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        projects.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT, 'name': 'Acme Notes',
                                'status': 'active', 'visibility': 'public', 'owner_sub': 'sub-owner'})
        invoke = MagicMock(name='invoke_lambda_async')
        pages = Pages()
        reader = MagicMock(name='describe', side_effect=describe or (lambda *_a: Reading('Scanned text.')))
        stack.enter_context(patch.object(product_sources, 'get_projects_table', return_value=projects))
        stack.enter_context(patch.object(product_sources, 'get_s3_client', return_value=s3))
        stack.enter_context(patch.object(product_source_worker, 'get_s3_client', return_value=s3))
        stack.enter_context(patch.object(product_source_worker, 'describe', reader))
        stack.enter_context(patch.object(product_source_links, 'fetch_public_url', pages))
        stack.enter_context(patch('shared.url_policy.socket.getaddrinfo', side_effect=_public_answers))
        stack.enter_context(patch.dict('os.environ', {'RAW_DATA_BUCKET': BUCKET,
                                                      'ASSIST_WORKER_FUNCTION': 'voc-projects-assist'}))
        stack.enter_context(patch.object(product_source_routes, 'get_aggregates_table', return_value=aggregates))
        stack.enter_context(patch.object(product_source_routes, 'invoke_lambda_async', invoke))
        yield SourcesWorld(projects, aggregates, s3, invoke, pages, reader)
