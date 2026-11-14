"""Property tests of the project export (scripts/project_bundle/exporter.py).

An export is the one place a project leaves its deployment, so a wrong answer either loses work on the way (a
document, a comment, a prototype page the target never gets) or leaks something (another project's rows, a credential,
an object of another project). These check the export over many projects, in words a person would use:

- An export carries every row the project owns (its partition, its version counters, its comment threads, its pin
  forms and pins) and not one row of another project, even one whose id begins with this one's.
- No credential leaves: a review link's SHARE row, a token row, a row holding a token or secret hash.
- The objects carried are the project's prototype pages and product docs (never a draft) and the avatars its rows
  name in this bucket, each with its metadata and bytes; an avatar that was never written is skipped.
- The manifest counts each document of the project once, in its section, every section listed.
- Only live projects are listed for `--all`, and a refused project stops the export before anything is written.

The deployment is a fake (dict-backed tables and bucket that page their answers and serve a stale view to a read that
is not consistent), so a property meets hundreds of projects in seconds; the moto round trip is
test_project_bundle_scripts.py's. The module is loaded as `project_bundle.exporter`, as that file loads it.
"""
from __future__ import annotations

import sys
from collections.abc import Iterator
from decimal import Decimal
from types import ModuleType
from typing import Any

import pytest
from botocore.exceptions import ClientError
from hypothesis import given
from hypothesis import strategies as st

from shared.test.property_settings import PROPERTY
from shared.test.repo_paths import load_module_from_path, repo_root

BUCKET = 'src-bucket'
OTHER_BUCKET = 'src-bucket-2'
# Real ids are fixed width; the short legacy ones make one id a prefix of another (proj_7, proj_70), which the
# `#` and `/` after each id in a key must keep apart.
PROJECT_IDS = ('proj_20260101000000_aaaa1111', 'proj_20260101000000_bbbb2222', 'proj_7', 'proj_70', 'proj_7a')
DOCUMENT_PREFIXES = ('PRD#', 'PRFAQ#', 'RESEARCH#', 'DOC#', 'PRODUCT_REPORT#', 'PROTOTYPE#')
DOCUMENT_TYPES = ('prd', 'prfaq', 'prototype', 'research', 'custom', 'product_report', 'decision', 'later_type', None)
SECTION_OF = {'prd': 'prd', 'prfaq': 'prfaq', 'prototype': 'prototypes'}
LEGACY_SECTION_OF = {'PRD#': 'prd', 'PRFAQ#': 'prfaq', 'PROTOTYPE#': 'prototypes'}
CREDENTIAL_PREFIXES = ('TOKEN#', 'MCPTOKEN', 'APITOKEN')
FAKE_CALL_CAP = 2000


def load_exporter() -> Iterator[ModuleType]:
    """`project_bundle.exporter`, imported the way scripts/project-export.py imports it (scripts/ on sys.path),
    and unloaded again when the generator is closed."""
    load_module_from_path('project_export', repo_root() / 'scripts' / 'project-export.py')
    try:
        yield sys.modules['project_bundle.exporter']
    finally:
        for name in [n for n in sys.modules if n.startswith(('project_bundle', 'project_export'))]:
            sys.modules.pop(name, None)


@pytest.fixture(scope='module')
def ex() -> Iterator[ModuleType]:
    """The exporter module for this module's tests (`load_exporter`)."""
    yield from load_exporter()


# ---- The fake deployment ----

def _holds(condition: Any, item: dict[str, Any]) -> bool:
    """A boto3 key or filter condition (=, begins_with, AND), evaluated on one item."""
    expression = condition.get_expression()
    operator, values = expression['operator'], expression['values']
    if operator == 'AND':
        return all(_holds(value, item) for value in values)
    attribute, operand = values
    if attribute.name not in item:
        return False
    if operator == '=':
        return item[attribute.name] == operand
    if operator == 'begins_with':
        return isinstance(item[attribute.name], str) and item[attribute.name].startswith(operand)
    raise AssertionError(f'the fake does not evaluate {operator}')


def _no_more_calls(owner: Any) -> None:
    owner.calls += 1
    if owner.calls > FAKE_CALL_CAP:
        raise AssertionError('the export kept calling the fake: a pager that never ends')


class FakeTable:
    """A table that answers `page` raw rows at a time (filtered after the page is read, as DynamoDB does, so a page
    can be empty and still say there is more) and leaves `Items` out of an empty answer. A key read that is not
    consistent does not see the `fresh` rows (written a moment before the export)."""

    def __init__(self, rows: list[dict[str, Any]], page: int, fresh: set[tuple[str, str]]) -> None:
        self.rows = sorted(rows, key=lambda row: (row['pk'], row['sk']))
        self.page = page
        self.fresh = fresh
        self.calls = 0

    def _visible(self, consistent: object) -> list[dict[str, Any]]:
        if consistent is True:
            return self.rows
        return [row for row in self.rows if (row['pk'], row['sk']) not in self.fresh]

    def _answer(self, rows: list[dict[str, Any]], condition: Any, start: dict[str, Any] | None) -> dict[str, Any]:
        _no_more_calls(self)
        keys = [(row['pk'], row['sk']) for row in rows]
        first = 0 if start is None else keys.index((start['pk'], start['sk'])) + 1
        chunk = rows[first:first + self.page]
        answer: dict[str, Any] = {}
        items = [dict(row) for row in chunk if _holds(condition, row)]
        if items:
            answer['Items'] = items
        if first + self.page < len(rows):
            answer['LastEvaluatedKey'] = {'pk': chunk[-1]['pk'], 'sk': chunk[-1]['sk']}
        return answer

    def query(self, *, KeyConditionExpression: Any, ConsistentRead: object = False,
              ExclusiveStartKey: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._answer(self._visible(ConsistentRead), KeyConditionExpression, ExclusiveStartKey)

    def scan(self, *, FilterExpression: Any,
             ExclusiveStartKey: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._answer(self.rows, FilterExpression, ExclusiveStartKey)

    def get_item(self, *, Key: dict[str, Any], ConsistentRead: object = False) -> dict[str, Any]:
        _no_more_calls(self)
        for row in self._visible(ConsistentRead):
            if row['pk'] == Key['pk'] and row['sk'] == Key['sk']:
                return {'Item': dict(row)}
        return {}


class FakeBody:
    def __init__(self, data: bytes) -> None:
        self.data = data

    def read(self) -> bytes:
        return self.data


class FakeS3:
    """One bucket's objects, listed `page` keys at a time in key order (no `Contents` on an empty page)."""

    def __init__(self, bucket: str, objects: dict[str, dict[str, Any]], page: int) -> None:
        self.bucket = bucket
        self.objects = objects
        self.page = page
        self.calls = 0

    def get_paginator(self, operation: str) -> FakeS3:
        assert operation == 'list_objects_v2'
        return self

    def paginate(self, *, Bucket: str, Prefix: str) -> Iterator[dict[str, Any]]:
        assert Bucket == self.bucket
        keys = sorted(key for key in self.objects if key.startswith(Prefix))
        for first in range(0, max(len(keys), 1), self.page):
            _no_more_calls(self)
            chunk = keys[first:first + self.page]
            yield {'Contents': [{'Key': key} for key in chunk]} if chunk else {}

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        _no_more_calls(self)
        assert Bucket == self.bucket
        stored = self.objects.get(Key)
        if stored is None:
            raise ClientError({'Error': {'Code': 'NoSuchKey', 'Message': 'missing'}}, 'GetObject')
        response = {key: value for key, value in stored.items() if key != 'body'}
        response['Body'] = FakeBody(stored['body'])
        return response


class FakeDynamo:
    def __init__(self, tables: dict[str, FakeTable]) -> None:
        self.tables = tables

    def Table(self, name: str) -> FakeTable:
        return self.tables[name]


class FakeSession:
    def __init__(self, tables: dict[str, FakeTable], s3: FakeS3) -> None:
        self.dynamodb = FakeDynamo(tables)
        self.s3 = s3

    def resource(self, name: str) -> FakeDynamo:
        assert name == 'dynamodb'
        return self.dynamodb

    def client(self, name: str) -> FakeS3:
        assert name == 's3'
        return self.s3


class FakeWriter:
    """What the exporter hands a bundle: the rows (project, table, row) and the objects (record, bytes)."""

    def __init__(self) -> None:
        self.rows: list[tuple[str, str, dict[str, Any]]] = []
        self.objects: list[tuple[Any, bytes]] = []

    def add_row(self, project_id: str, table: str, item: dict[str, Any]) -> None:
        self.rows.append((project_id, table, item))

    def add_object(self, record: Any, body: bytes) -> None:
        self.objects.append((record, body))


# ---- The deployments a property meets ----

def _avatar_key(draw: Any, pid: str) -> str:
    return f"avatars/persona_{pid[-4:]}_{draw(st.integers(0, 3))}/{draw(st.sampled_from(['a1', 'b2']))}.png"


def _meta(draw: Any, pid: str) -> dict[str, Any]:
    meta: dict[str, Any] = {'pk': f'PROJECT#{pid}', 'sk': 'META', 'project_id': pid, 'name': f'Project {pid[-4:]}',
                            'owner_sub': f'sub-{pid[-4:]}', 'owner_email': f'{pid[-4:]}@example.com',
                            'persona_count': Decimal(draw(st.integers(0, 9)))}
    if draw(st.booleans()):
        meta['members'] = {f'sub-m{n}': draw(st.one_of(st.none(), st.fixed_dictionaries(
            {'role': st.sampled_from(['viewer', 'editor']), 'email': st.just(f'm{n}@example.com')})))
            for n in draw(st.lists(st.integers(0, 5), max_size=3, unique=True))}
    return meta


def _documents(draw: Any, pk: str) -> list[dict[str, Any]]:
    documents = []
    for n in range(draw(st.integers(0, 5))):
        prefix = draw(st.sampled_from(DOCUMENT_PREFIXES))
        document = {'pk': pk, 'sk': f'{prefix}doc_{n}', 'document_id': f'doc_{n}', 'title': f'Doc {n}',
                    'version': Decimal(draw(st.integers(1, 3)))}
        document_type = draw(st.sampled_from(DOCUMENT_TYPES))
        if document_type is not None:
            document['document_type'] = document_type
        documents.append(document)
    return documents


def _personas(draw: Any, pid: str, avatars: list[str]) -> list[dict[str, Any]]:
    """Personas, some naming an avatar (at the top, nested, or in a list) in this bucket or another one."""
    personas = []
    for n in range(draw(st.integers(0, 3))):
        persona: dict[str, Any] = {'pk': f'PROJECT#{pid}', 'sk': f'PERSONA#p{n}', 'persona_id': f'p{n}',
                                   'avg_sentiment': Decimal('-0.5'), 'tags': ['frequent', 'mobile']}
        if draw(st.booleans()):
            key = _avatar_key(draw, pid)
            uri = f's3://{draw(st.sampled_from([BUCKET, BUCKET, OTHER_BUCKET]))}/{key}'
            persona.update(draw(st.sampled_from([{'avatar_url': uri}, {'profile': {'images': {'avatar': uri}}},
                                                 {'gallery': [Decimal('1'), uri]}])))
            avatars.append(key)
        personas.append(persona)
    return personas


def _threads(draw: Any, pid: str) -> list[dict[str, Any]]:
    rows = []
    for series in draw(st.lists(st.sampled_from(['s1', 's2']), max_size=2, unique=True)):
        thread = f'DCOMMENTS#{pid}#{series}'
        rows.append({'pk': thread, 'sk': 'C#dc_1', 'text': 'Too many steps',
                     'author': {'kind': 'persona', 'persona_id': 'p0'}})
        if draw(st.booleans()):
            rows.append({'pk': thread, 'sk': 'SHARE', 'share_id': f'shr_{series}'})
    return rows


def _credentials(draw: Any, pid: str, avatars: list[str]) -> list[dict[str, Any]]:
    """Token rows and rows holding a hash, some naming an avatar no kept row names."""
    rows = []
    for sk, extra in draw(st.lists(st.sampled_from([
            ('TOKEN#tok_1', {'token_hash': 'deadbeef'}), ('MCPTOKEN#m1', {}), ('APITOKEN#a1', {}),
            ('PERSONA#leaked', {'secret_hash': 'cafe'}), ('NOTE#n1', {'token_hash': 'beef'})]),
            max_size=3, unique_by=lambda pair: pair[0])):
        row = {'pk': f'PROJECT#{pid}', 'sk': sk, **extra}
        if draw(st.booleans()):
            key = _avatar_key(draw, pid)
            row['avatar_url'] = f's3://{BUCKET}/{key}'
            avatars.append(key)
        rows.append(row)
    return rows


def _pins(draw: Any, pid: str) -> list[dict[str, Any]]:
    rows = []
    for n in range(draw(st.integers(0, 2))):
        form_id = f'pf_{pid}_{n}'
        rows.append({'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}', 'form_id': form_id, 'project_id': pid})
        rows.extend({'pk': f'PINS#{form_id}', 'sk': f'PIN#pin_{pin}', 'comment': 'Button is hidden'}
                    for pin in range(draw(st.integers(0, 2))))
    return rows


def _objects(draw: Any, pid: str, avatars: list[str]) -> dict[str, dict[str, Any]]:
    """Prototype pages, drafts and product docs, and some of the named avatars (the rest were never written)."""
    objects: dict[str, dict[str, Any]] = {}
    for n in range(draw(st.integers(0, 3))):
        key = draw(st.sampled_from([f'prototypes/{pid}/prototype_{n}.html', f'prototypes/{pid}/prototype_{n}.html',
                                    f'prototypes/{pid}/drafts/job_{n}.html',
                                    f'projects/{pid}/product_docs/raw/brief_{n}.pdf']))
        objects[key] = _object(draw, key)
    for key in avatars:
        if draw(st.booleans()):
            objects[key] = _object(draw, key)
    return objects


@st.composite
def project_world(draw: Any, pid: str) -> dict[str, Any]:
    """One project's rows, pin rows and objects, the way the platform writes them: documents of every kind (some
    legacy rows with no type), personas whose avatars live in this bucket or another, version counters, comment
    threads with their SHARE row, credential rows, review links, pin forms with pins, prototype pages and drafts."""
    pk = f'PROJECT#{pid}'
    avatars: list[str] = []
    rows = [_meta(draw, pid), *_documents(draw, pk), *_personas(draw, pid, avatars)]
    if draw(st.booleans()):
        rows.append({'pk': pk, 'sk': 'PRODUCT_DOC#x1', 'document_type': 'prd', 'title': 'A product doc'})
    rows.extend({'pk': f'DOCUMENT_VERSIONS#PROJECT#{pid}', 'sk': f'ALLOCATION#PRD#a{n}', 'document_type': 'prd',
                 'document_pk': pk, 'document_sk': f'PRD#doc_{n}'} for n in range(draw(st.integers(0, 2))))
    rows.extend(_threads(draw, pid))
    rows.extend(_credentials(draw, pid, avatars))
    if draw(st.booleans()):
        rows.append({'pk': f'DOCSHARE#shr_{pid}', 'sk': 'META', 'project_id': pid})
    return {'rows': rows, 'aggregates': _pins(draw, pid), 'objects': _objects(draw, pid, avatars)}


def _object(draw: Any, key: str) -> dict[str, Any]:
    stored: dict[str, Any] = {'body': f'bytes of {key}'.encode()}
    if draw(st.booleans()):
        stored['ContentType'] = draw(st.sampled_from(['text/html', 'application/pdf', 'image/png']))
    if draw(st.booleans()):
        stored['CacheControl'] = 'no-cache'
    if draw(st.booleans()):
        stored['Metadata'] = {'project-id': key.split('/')[1]}
    return stored


@st.composite
def deployments(draw: Any) -> dict[str, Any]:
    """Two to four projects on one deployment, read a few rows and keys at a time, some rows written a moment
    before the export; `chosen` are the live projects the operator asks for, in the order asked."""
    pids = draw(st.lists(st.sampled_from(PROJECT_IDS), min_size=2, max_size=4, unique=True))
    worlds = {pid: draw(project_world(pid)) for pid in pids}
    rows = [row for world in worlds.values() for row in world['rows']]
    for pid in pids[1:]:
        state = draw(st.sampled_from(['live', 'live', 'deleting', 'deleted', 'fixture', 'container']))
        meta = worlds[pid]['rows'][0]
        if state in ('deleting', 'deleted'):
            meta['status'] = state
        elif state == 'fixture':
            meta['verification_fixture_id'] = 'fx_1'
        elif state == 'container':
            meta['kind'] = 'company_personas'
        if state != 'live' and draw(st.booleans()):
            meta.pop('status', None)
            meta['deletion_started_at'] = '2026-01-01T00:00:00Z'
    live = [pid for pid in pids if _is_live(worlds[pid]['rows'][0])]
    chosen = draw(st.permutations(live).flatmap(lambda order: st.integers(1, len(order)).map(lambda n: order[:n])))
    fresh = {(row['pk'], row['sk']) for row in rows if row['pk'].startswith(('PROJECT#', 'DOCUMENT_VERSIONS#'))
             and draw(st.integers(0, 3)) == 0}
    aggregates = [row for world in worlds.values() for row in world['aggregates']]
    page = draw(st.integers(1, 4))
    tables = {'src-p': FakeTable(rows, page, fresh), 'src-a': FakeTable(aggregates, page, set())}
    objects = {key: value for world in worlds.values() for key, value in world['objects'].items()}
    return {'worlds': worlds, 'rows': rows, 'aggregates': aggregates, 'objects': objects, 'live': live,
            'chosen': chosen, 'session': FakeSession(tables, FakeS3(BUCKET, objects, page))}


def _is_live(meta: dict[str, Any]) -> bool:
    return not ({'deletion_started_at', 'verification_fixture_id', 'kind'} & meta.keys()
                or meta.get('status') in ('deleting', 'deleted'))


def _credential(row: dict[str, Any]) -> bool:
    sk = row['sk']
    return sk == 'SHARE' or sk.startswith(CREDENTIAL_PREFIXES) or bool({'token_hash', 'secret_hash'} & row.keys())


def _owned(pid: str, row: dict[str, Any]) -> bool:
    return (row['pk'] in (f'PROJECT#{pid}', f'DOCUMENT_VERSIONS#PROJECT#{pid}')
            or row['pk'].startswith(f'DCOMMENTS#{pid}#'))


def _keys(rows: Any) -> list[tuple[str, str]]:
    return sorted((row['pk'], row['sk']) for row in rows)


def _export(ex: ModuleType, world: dict[str, Any]) -> tuple[FakeWriter, list[dict[str, Any]]]:
    deployment = sys.modules['project_bundle.deployment'].Deployment('src-p', 'src-a', BUCKET, 'pool-src', None)
    writer = FakeWriter()
    summaries = ex.Exporter(world['session'], deployment).run(list(world['chosen']), writer)
    return writer, summaries


def _expected_objects(world: dict[str, Any], pid: str) -> list[str]:
    own = [key for key in world['objects']
           if key.startswith((f'prototypes/{pid}/', f'projects/{pid}/product_docs/'))
           and not key.startswith(f'prototypes/{pid}/drafts/')]
    named = {uri.removeprefix(f's3://{BUCKET}/') for row in world['rows'] if _owned(pid, row) and not _credential(row)
             for uri in _strings(row) if uri.startswith(f's3://{BUCKET}/avatars/')}
    return sorted(own + [key for key in named if key in world['objects']])


def _strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for member in value.values():
            yield from _strings(member)
    elif isinstance(value, list):
        for member in value:
            yield from _strings(member)


class TestTheExportCarriesEveryRowOfTheProjectAndNoneOfAnother:
    """Invariant: for each project asked for, the bundle holds every row of its partition, its version counters and
    its comment threads, as stored, under its own id and the projects table, however the reads are paged and even
    when a row was written a moment before; and nothing of another project, even one whose id begins with this
    one's (proj_7 / proj_70)."""

    @PROPERTY
    @given(world=deployments())
    def test_the_projects_rows_are_exactly_the_ones_it_owns(self, ex: ModuleType, world: dict[str, Any]) -> None:
        writer, _ = _export(ex, world)
        for pid in world['chosen']:
            written = [row for owner, table, row in writer.rows if owner == pid and table == 'projects']
            expected = [row for row in world['rows'] if _owned(pid, row) and not _credential(row)]
            assert _keys(written) == _keys(expected)
            stored = {(row['pk'], row['sk']): row for row in world['rows']}
            assert all(row == stored[(row['pk'], row['sk'])] for row in written)
        assert {owner for owner, _, _ in writer.rows} <= set(world['chosen'])
        assert {table for _, table, _ in writer.rows} <= {'projects', 'aggregates'}

    @PROPERTY
    @given(world=deployments())
    def test_the_pin_forms_and_pins_are_the_projects_own(self, ex: ModuleType, world: dict[str, Any]) -> None:
        writer, _ = _export(ex, world)
        for pid in world['chosen']:
            forms = [row for row in world['aggregates'] if row['pk'] == 'FEEDBACK_FORM' and row['project_id'] == pid]
            pins = [row for row in world['aggregates'] for form in forms if row['pk'] == f"PINS#{form['form_id']}"]
            written = [row for owner, table, row in writer.rows if owner == pid and table == 'aggregates']
            assert _keys(written) == _keys(forms + pins)

    @PROPERTY
    @given(world=deployments())
    def test_each_summary_counts_what_was_written(self, ex: ModuleType, world: dict[str, Any]) -> None:
        writer, summaries = _export(ex, world)
        assert [summary['project_id'] for summary in summaries] == world['chosen']
        for summary in summaries:
            pid = summary['project_id']
            meta = world['worlds'][pid]['rows'][0]
            assert summary['rows'] == sum(1 for owner, _, _ in writer.rows if owner == pid)
            assert summary['objects'] == sum(1 for record, _ in writer.objects if record.project_id == pid)
            assert summary['skipped_credentials'] == sum(
                1 for row in world['rows'] if _owned(pid, row) and _credential(row))
            assert (summary['name'], summary['owner_sub'], summary['owner_email']) == (
                meta['name'], meta['owner_sub'], meta['owner_email'])


class TestNoCredentialEverLeaves:
    """Invariant: no row the bundle holds is a review link's SHARE row, a token row (TOKEN#, MCPTOKEN, APITOKEN) or a
    row carrying a token or secret hash, wherever it sits; and an avatar only such a row names stays behind."""

    @PROPERTY
    @given(world=deployments())
    def test_no_written_row_is_credential_shaped(self, ex: ModuleType, world: dict[str, Any]) -> None:
        writer, _ = _export(ex, world)
        assert not any(_credential(row) for _, table, row in writer.rows if table == 'projects')

    @PROPERTY
    @given(sk=st.one_of(st.sampled_from(['SHARE', 'TOKEN#t', 'MCPTOKEN', 'MCPTOKEN#x', 'APITOKEN#y', 'META',
                                         'PRD#d', 'C#dc_1', 'SHARED', 'TOKEN']), st.text(max_size=12)),
           attributes=st.sets(st.sampled_from(['token_hash', 'secret_hash', 'title', 'hash', 'secret'])),
           has_sk=st.booleans())
    def test_a_row_is_a_credential_by_its_key_or_a_hash_and_only_then(self, ex: ModuleType, sk: str,
                                                                      attributes: set[str], has_sk: bool) -> None:
        row: dict[str, Any] = dict.fromkeys(attributes, 'x')
        if has_sk:
            row['sk'] = sk
        expected = bool({'token_hash', 'secret_hash'} & attributes) or (
            has_sk and (sk == 'SHARE' or sk.startswith(CREDENTIAL_PREFIXES)))
        assert ex.is_credential(row) is expected


class TestTheObjectsAreTheProjectsOwn:
    """Invariant: the objects carried are the project's prototype pages and product docs, never a prototype draft,
    plus every avatar its kept rows name in this bucket that exists; each once, with its type, cache header,
    metadata and bytes; nothing under another project's prefix or another bucket."""

    @PROPERTY
    @given(world=deployments())
    def test_the_objects_are_exactly_the_projects(self, ex: ModuleType, world: dict[str, Any]) -> None:
        writer, _ = _export(ex, world)
        for pid in world['chosen']:
            records = [(record, body) for record, body in writer.objects if record.project_id == pid]
            assert sorted(record.key for record, _ in records) == _expected_objects(world, pid)
            for record, body in records:
                stored = world['objects'][record.key]
                assert body == stored['body']
                assert (record.content_type, record.cache_control, record.metadata) == (
                    stored.get('ContentType'), stored.get('CacheControl'), stored.get('Metadata', {}))


class TestTheManifestCountsEachDocumentOnce:
    """Invariant: the manifest lists every section in its one order, and the counts add up to the project's document
    rows (PRD#, PRFAQ#, RESEARCH#, DOC#, PRODUCT_REPORT#, PROTOTYPE# in its own partition), each in the section its
    type, or a legacy row's sort key, puts it in."""

    @PROPERTY
    @given(world=deployments())
    def test_the_counts_are_the_documents_by_section(self, ex: ModuleType, world: dict[str, Any]) -> None:
        _, summaries = _export(ex, world)
        for summary in summaries:
            pid = summary['project_id']
            expected: dict[str, int] = dict.fromkeys(('prd', 'prfaq', 'prototypes', 'documents'), 0)
            for row in world['rows']:
                if row['pk'] == f'PROJECT#{pid}' and row['sk'].startswith(DOCUMENT_PREFIXES) and not _credential(row):
                    if 'document_type' in row:
                        section = SECTION_OF.get(row['document_type'], 'documents')
                    else:
                        section = next((s for p, s in LEGACY_SECTION_OF.items() if row['sk'].startswith(p)),
                                       'documents')
                    expected[section] += 1
            assert list(summary['document_sections'].items()) == list(expected.items())


class TestOnlyLiveProjectsAreListed:
    """Invariant: `--all` lists each live project once, in id order, and never a deleted or deleting one, a
    verification fixture or the reserved company persona library; a row that is not a META never adds one."""

    @PROPERTY
    @given(world=deployments())
    def test_the_list_is_the_live_projects_sorted(self, ex: ModuleType, world: dict[str, Any]) -> None:
        assert ex.live_project_ids(world['session'].dynamodb.Table('src-p')) == sorted(world['live'])


class TestARefusedProjectStopsTheExportBeforeAnyWrite:
    """Invariant: asking for a project that does not exist, is deleted or deleting, or is a reserved container
    refuses the whole export with an error that names it, and nothing at all has been written, whatever was asked
    for before it."""

    @PROPERTY
    @given(world=deployments(), bad=st.sampled_from(['missing', 'deleted', 'deleting', 'tombstone', 'container']),
           at=st.integers(0, 4))
    def test_nothing_is_written_and_the_error_names_the_project(self, ex: ModuleType, world: dict[str, Any],
                                                                bad: str, at: int) -> None:
        pid = 'proj_20260101000000_ffff9999'
        meta: dict[str, Any] = {'pk': f'PROJECT#{pid}', 'sk': 'META', 'project_id': pid}
        if bad in ('deleted', 'deleting'):
            meta['status'] = bad
        elif bad == 'tombstone':
            meta['deletion_started_at'] = '2026-01-01T00:00:00Z'
        elif bad == 'container':
            meta['kind'] = 'company_personas'
        table = world['session'].dynamodb.Table('src-p')
        if bad != 'missing':
            table.rows.append(meta)
        world['chosen'].insert(min(at, len(world['chosen'])), pid)
        writer = FakeWriter()
        deployment = sys.modules['project_bundle.deployment'].Deployment('src-p', 'src-a', BUCKET, 'pool-src', None)
        with pytest.raises(ex.ExportError) as refused:
            ex.Exporter(world['session'], deployment).run(world['chosen'], writer)
        assert pid in str(refused.value)
        assert (writer.rows, writer.objects) == ([], [])


class TestMembersAreSummarisedInSubjectOrder:
    """Invariant: the summary lists each member once, by subject order, with the email and role stored (none for
    an entry that holds nothing), and no members at all when the map is missing or not a map."""

    @PROPERTY
    @given(members=st.one_of(
        st.dictionaries(st.sampled_from(['sub-a', 'sub-b', 'sub-c', 'sub-d']), st.one_of(
            st.none(), st.fixed_dictionaries({'role': st.sampled_from(['viewer', 'editor'])},
                                             optional={'email': st.just('person@example.com')}))),
        st.none(), st.just(['sub-a']), st.just('sub-a')))
    def test_the_members_in_order(self, ex: ModuleType, members: Any) -> None:
        meta = {} if members is None else {'members': members}
        expected = [{'sub': sub, 'email': (entry or {}).get('email'), 'role': (entry or {}).get('role')}
                    for sub, entry in sorted(members.items())] if isinstance(members, dict) else []
        assert ex.member_summary(meta) == expected
