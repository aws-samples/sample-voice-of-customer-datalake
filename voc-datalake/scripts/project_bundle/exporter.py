"""Read every row and object one project owns on a deployment (the export half).

What a project owns on main (enumerated from `api/projects.py` `delete_project`,
`shared/document_versions.py`, `shared/document_comments.py`, `shared/prototype_pins.py`):

* projects table, `PROJECT#{id}`: META, personas, PR/FAQs, PRDs, prototypes, custom and
  research documents, decision records, product-doc rows: the whole partition;
* projects table, `DOCUMENT_VERSIONS#PROJECT#{id}`: the version counters and allocations;
* projects table, `DCOMMENTS#{id}#{series}`: comment threads (`C#…`), WITHOUT the `SHARE`
  row, which points at a review link;
* aggregates table: each prototype's pin form (`FEEDBACK_FORM` / `FORM#pf_…`, carrying the
  project id) and its pins (`PINS#{form_id}` / `PIN#…`);
* raw bucket: `prototypes/{id}/`, `projects/{id}/product_docs/`, and every `avatars/…` object
  a row names by `s3://<bucket>/…` URI.

NOT carried: review links (`DOCSHARE#…`, `DCRATE#…`) and MCP tokens (credentials), jobs
(the jobs table: transient progress rows with a TTL), feedback, participant links and
Prioritization rows (they reference the deployment's own people and data).
"""
from __future__ import annotations

from collections.abc import Iterable, Iterator
from typing import Any

from boto3.dynamodb.conditions import Attr, Key

from project_bundle.bundle import BundleWriter, ObjectRecord
from project_bundle.deployment import Deployment

PIN_FORMS_PK = 'FEEDBACK_FORM'
VERSIONS_PK_PREFIX = 'DOCUMENT_VERSIONS#PROJECT#'
COMMENTS_PK_PREFIX = 'DCOMMENTS#'
SHARE_INDEX_SK = 'SHARE'
TOMBSTONE_STATUSES = frozenset({'deleting', 'deleted'})
TOMBSTONE_ATTRIBUTE = 'deletion_started_at'
FIXTURE_ATTRIBUTE = 'verification_fixture_id'
# Credential-shaped rows are never exported, wherever they sit.
CREDENTIAL_ATTRIBUTES = frozenset({'token_hash', 'secret_hash'})
CREDENTIAL_SK_PREFIXES = ('TOKEN#', 'MCPTOKEN', 'APITOKEN')


class ExportError(Exception):
    """A requested project cannot be exported."""


def is_tombstone(meta: dict[str, Any]) -> bool:
    return TOMBSTONE_ATTRIBUTE in meta or meta.get('status') in TOMBSTONE_STATUSES


def is_credential(item: dict[str, Any]) -> bool:
    sk = str(item.get('sk', ''))
    return sk == SHARE_INDEX_SK or sk.startswith(CREDENTIAL_SK_PREFIXES) or bool(CREDENTIAL_ATTRIBUTES & item.keys())


def _paged(call: Any, **kwargs: Any) -> Iterator[dict[str, Any]]:
    while True:
        response = call(**kwargs)
        yield from response.get('Items', [])
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return
        kwargs['ExclusiveStartKey'] = last_key


def _partition(table: Any, pk: str) -> list[dict[str, Any]]:
    return list(_paged(table.query, KeyConditionExpression=Key('pk').eq(pk), ConsistentRead=True))


def live_project_ids(table: Any) -> list[str]:
    """Every project whose META is neither a tombstone nor a verification fixture (`--all`)."""
    metas = _paged(table.scan, FilterExpression=Attr('sk').eq('META') & Attr('pk').begins_with('PROJECT#'))
    return sorted(str(meta['pk']).removeprefix('PROJECT#') for meta in metas
                  if not is_tombstone(meta) and FIXTURE_ATTRIBUTE not in meta)


def comment_rows(table: Any, project_ids: Iterable[str]) -> dict[str, list[dict[str, Any]]]:
    """Comment-thread rows per project: ONE scan for every requested project.

    A series id is a digest of the document's title, so the partitions cannot be listed by
    key; the scan reads only the `DCOMMENTS#` rows.
    """
    wanted = {f'{COMMENTS_PK_PREFIX}{pid}#': pid for pid in project_ids}
    found: dict[str, list[dict[str, Any]]] = {pid: [] for pid in wanted.values()}
    for row in _paged(table.scan, FilterExpression=Attr('pk').begins_with(COMMENTS_PK_PREFIX)):
        pk = str(row['pk'])
        owner = next((pid for prefix, pid in wanted.items() if pk.startswith(prefix)), None)
        if owner is not None:
            found[owner].append(row)
    return found


def pin_rows(aggregates: Any, project_id: str) -> list[dict[str, Any]]:
    forms = [form for form in _partition(aggregates, PIN_FORMS_PK) if form.get('project_id') == project_id]
    rows = list(forms)
    for form in forms:
        rows.extend(_partition(aggregates, f"PINS#{form['form_id']}"))
    return rows


def _uris(value: Any, prefix: str) -> Iterator[str]:
    if isinstance(value, str):
        if value.startswith(prefix):
            yield value.removeprefix(prefix)
    elif isinstance(value, dict):
        for member in value.values():
            yield from _uris(member, prefix)
    elif isinstance(value, list | set | tuple):
        for member in value:
            yield from _uris(member, prefix)


def object_keys(s3: Any, bucket: str, project_id: str, rows: list[dict[str, Any]]) -> list[str]:
    """The project's prototype and product-doc objects, plus every avatar its rows name."""
    keys: list[str] = []
    paginator = s3.get_paginator('list_objects_v2')
    for prefix in (f'prototypes/{project_id}/', f'projects/{project_id}/product_docs/'):
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            keys.extend(entry['Key'] for entry in page.get('Contents', []))
    named = {key for row in rows for key in _uris(row, f's3://{bucket}/') if key.startswith('avatars/')}
    return keys + sorted(named - set(keys))


def _object_record(s3: Any, bucket: str, project_id: str, key: str) -> tuple[ObjectRecord, bytes] | None:
    from botocore.exceptions import ClientError

    try:
        response = s3.get_object(Bucket=bucket, Key=key)
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') in ('NoSuchKey', '404'):
            return None  # a row naming an avatar that was never written: nothing to carry
        raise
    record = ObjectRecord(project_id=project_id, key=key, content_type=response.get('ContentType'),
                          cache_control=response.get('CacheControl'), metadata=dict(response.get('Metadata') or {}))
    return record, response['Body'].read()


def _meta(table: Any, project_id: str) -> dict[str, Any]:
    meta = table.get_item(Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'}, ConsistentRead=True).get('Item')
    if not meta:
        raise ExportError(f'project {project_id} does not exist on the source deployment')
    if is_tombstone(meta):
        raise ExportError(f'project {project_id} is deleted (tombstone); nothing to export')
    return meta


def member_summary(meta: dict[str, Any]) -> list[dict[str, Any]]:
    stored = meta.get('members')
    members: dict[str, Any] = stored if isinstance(stored, dict) else {}
    return [{'sub': sub, 'email': (entry or {}).get('email'), 'role': (entry or {}).get('role')}
            for sub, entry in sorted(members.items())]


class Exporter:
    def __init__(self, session: Any, deployment: Deployment) -> None:
        dynamodb = session.resource('dynamodb')
        self.projects = dynamodb.Table(deployment.projects_table)
        self.aggregates = dynamodb.Table(deployment.aggregates_table)
        self.s3 = session.client('s3')
        self.deployment = deployment

    def run(self, project_ids: list[str], writer: BundleWriter) -> list[dict[str, Any]]:
        """Write every project to `writer`; return the manifest's project summaries."""
        metas = {pid: _meta(self.projects, pid) for pid in project_ids}  # refuse before writing anything
        comments = comment_rows(self.projects, project_ids)
        return [self._export_one(pid, metas[pid], comments[pid], writer) for pid in project_ids]

    def _export_one(self, project_id: str, meta: dict[str, Any], comments: list[dict[str, Any]],
                    writer: BundleWriter) -> dict[str, Any]:
        project_rows = (_partition(self.projects, f'PROJECT#{project_id}')
                        + _partition(self.projects, f'{VERSIONS_PK_PREFIX}{project_id}') + comments)
        kept = [row for row in project_rows if not is_credential(row)]
        aggregate_rows = pin_rows(self.aggregates, project_id)
        for row in kept:
            writer.add_row(project_id, 'projects', row)
        for row in aggregate_rows:
            writer.add_row(project_id, 'aggregates', row)
        objects = 0
        for key in object_keys(self.s3, self.deployment.bucket, project_id, kept):
            found = _object_record(self.s3, self.deployment.bucket, project_id, key)
            if found is not None:
                writer.add_object(*found)
                objects += 1
        return {
            'project_id': project_id, 'name': meta.get('name'), 'owner_sub': meta.get('owner_sub'),
            'owner_email': meta.get('owner_email'), 'members': member_summary(meta),
            'rows': len(kept) + len(aggregate_rows), 'objects': objects,
            'skipped_credentials': len(project_rows) - len(kept),
        }
