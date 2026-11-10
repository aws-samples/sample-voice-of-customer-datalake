"""Plan, then write, a bundle's projects into a target deployment (the import half).

Every project is PLANNED before anything is written, and one refusal stops the whole import:

* the project id already exists on the target (any META, a tombstone too), unless `--new-ids`;
* the owner's email matches no single user in the target pool, and `--owner-email` does not
  either (or was not given).

A member whose email is not in the target pool is dropped from `members` and reported. The
agent that created a project (`created_by_agent`) is deployment-local and dropped. Objects go
first, then the aggregates rows, the project's other rows, and META last with a condition
(`attribute_not_exists`), so a half-written import never lists as a project and a race with
another writer is refused rather than overwritten.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from project_bundle.bundle import ObjectRecord, ProjectBundle, object_path
from project_bundle.deployment import Deployment
from project_bundle.remap import Rewriter, fix_legacy_assignment, new_id_map
from project_bundle.users import TargetUser, UserDirectory

PIN_SUBMIT_URL_METADATA_KEY = 'pin-submit-url'
DROPPED_META_ATTRIBUTES = ('created_by_agent',)


@dataclass
class ImportOptions:
    owner_email: str | None = None
    new_ids: bool = False


@dataclass
class PlannedObject:
    source: ObjectRecord
    key: str
    metadata: dict[str, str]
    rewrite_body: bool


@dataclass
class ProjectPlan:
    source_id: str
    project_id: str
    name: str
    owner: TargetUser | None = None
    rows: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    objects: list[PlannedObject] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    refusals: list[str] = field(default_factory=list)
    rewrite: Rewriter = field(default_factory=lambda: Rewriter({}))

    def lines(self) -> list[str]:
        kinds = Counter(f'{table} {str(item.get("sk", "")).split("#", 1)[0]}' for table, item in self.rows)
        owner = f'  owner: {self.owner.email} ({self.owner.sub})' if self.owner else '  owner: UNRESOLVED'
        return [
            f'{self.source_id} -> {self.project_id}  "{self.name}"', owner,
            *(f'  rows {kind}: {count}' for kind, count in sorted(kinds.items())),
            f'  S3 objects: {len(self.objects)}',
            *(f'  note: {note}' for note in self.notes),
            *(f'  REFUSED: {refusal}' for refusal in self.refusals),
        ]


def _missing(email: object) -> str:
    return str(email) if email else '(no email)'


def _resolve_owner(plan: ProjectPlan, summary: dict[str, Any], users: UserDirectory,
                   options: ImportOptions) -> None:
    owner = users.find(summary.get('owner_email'))
    if owner is None and options.owner_email:
        owner = users.find(options.owner_email)
        if owner is None:
            plan.refusals.append(f'--owner-email {options.owner_email} matches no single user in the target pool')
            return
        plan.notes.append(f'owner {_missing(summary.get("owner_email"))} not in the target pool; using --owner-email')
    if owner is None:
        plan.refusals.append(f'owner {_missing(summary.get("owner_email"))} is not in the target user pool; '
                             'pass --owner-email')
    plan.owner = owner


def _resolve_members(plan: ProjectPlan, summary: dict[str, Any], users: UserDirectory) -> dict[str, TargetUser]:
    """Source sub -> target user, for every member whose email the target pool knows."""
    found = {}
    for member in summary.get('members') or []:
        user = users.find(member.get('email'))
        if user is None:
            plan.notes.append(f'member {member.get("email") or member.get("sub")} is not in the target pool; dropped')
        else:
            found[str(member['sub'])] = user
    return found


def _target_meta(meta: dict[str, Any], owner: TargetUser, members: dict[str, TargetUser]) -> dict[str, Any]:
    """META (already rewritten) with the target owner and only the members that resolved.

    The rewrite turned resolved members' keys into their target subs; an unresolved member
    still carries its source sub and is dropped here, as is the owner listed as a member.
    """
    target = {key: value for key, value in meta.items() if key not in DROPPED_META_ATTRIBUTES}
    target.update(owner_sub=owner.sub, owner_username=owner.username, owner_email=owner.email)
    found = meta.get('members')
    stored: dict[str, Any] = found if isinstance(found, dict) else {}
    target['members'] = {
        user.sub: {**stored[user.sub], 'username': user.username, 'email': user.email}
        for user in members.values() if user.sub != owner.sub and isinstance(stored.get(user.sub), dict)
    }
    return target


def _plan_object(record: ObjectRecord, rewrite: Rewriter, api: tuple[str | None, str | None]) -> PlannedObject:
    """The target key and metadata; the pin submit URL points at the TARGET API, or is dropped."""
    source_api, target_api = api
    metadata = {key: rewrite.text(value) for key, value in record.metadata.items()}
    url = metadata.get(PIN_SUBMIT_URL_METADATA_KEY)
    if url is not None:
        if source_api and target_api and url.startswith(f'{source_api}/'):
            metadata[PIN_SUBMIT_URL_METADATA_KEY] = target_api + url.removeprefix(source_api)
        else:
            del metadata[PIN_SUBMIT_URL_METADATA_KEY]  # no connect-src to an API this deployment does not run
    return PlannedObject(source=record, key=rewrite.text(record.key), metadata=metadata,
                         rewrite_body=record.key.startswith('prototypes/') and record.key.endswith('.html'))


class Importer:
    def __init__(self, session: Any, deployment: Deployment, bundle_root: Path,
                 source: dict[str, Any]) -> None:
        dynamodb = session.resource('dynamodb')
        self.tables = {'projects': dynamodb.Table(deployment.projects_table),
                       'aggregates': dynamodb.Table(deployment.aggregates_table)}
        self.s3 = session.client('s3')
        self.users = UserDirectory(session.client('cognito-idp'), deployment.user_pool_id)
        self.deployment = deployment
        self.root = bundle_root
        self.source = source

    def _exists(self, project_id: str) -> bool:
        key = {'pk': f'PROJECT#{project_id}', 'sk': 'META'}
        return 'Item' in self.tables['projects'].get_item(Key=key, ConsistentRead=True)

    def plan(self, project: ProjectBundle, options: ImportOptions) -> ProjectPlan:
        summary, source_id = project.summary, project.project_id
        all_rows = [item for _, item in project.rows]
        id_map = new_id_map(all_rows, source_id) if options.new_ids else {}
        plan = ProjectPlan(source_id=source_id, project_id=id_map.get(source_id, source_id),
                           name=str(summary.get('name') or ''))
        if self._exists(plan.project_id):
            plan.refusals.append(f'project {plan.project_id} already exists on the target; pass --new-ids')
        _resolve_owner(plan, summary, self.users, options)
        members = _resolve_members(plan, summary, self.users)
        if plan.owner is None:
            return plan
        subs = {str(summary.get('owner_sub') or ''): plan.owner.sub} | {old: u.sub for old, u in members.items()}
        rewrite = Rewriter({str(self.source.get('bucket') or ''): self.deployment.bucket} | subs | id_map)
        meta_key = {'pk': f'PROJECT#{plan.project_id}', 'sk': 'META'}
        for table, item in project.rows:
            row = fix_legacy_assignment(rewrite.value(item))
            if table == 'projects' and {'pk': row.get('pk'), 'sk': row.get('sk')} == meta_key:
                row = _target_meta(row, plan.owner, members)
            plan.rows.append((table, row))
        api = (self.source.get('api_base'), self.deployment.api_base)
        plan.objects = [_plan_object(record, rewrite, api) for record in project.objects]
        plan.rewrite = rewrite
        return plan

    def _body(self, planned: PlannedObject, rewrite: Rewriter) -> bytes:
        body = object_path(self.root, planned.source.key).read_bytes()
        if not planned.rewrite_body:
            return body
        text = rewrite.text(body.decode('utf-8'))
        source_api, target_api = self.source.get('api_base'), self.deployment.api_base
        if source_api and target_api:
            text = text.replace(f'{source_api}/', f'{target_api}/')
        return text.encode('utf-8')

    def write(self, plan: ProjectPlan) -> None:
        for planned in plan.objects:
            extra = {key: value for key, value in (('ContentType', planned.source.content_type),
                                                    ('CacheControl', planned.source.cache_control)) if value}
            self.s3.put_object(Bucket=self.deployment.bucket, Key=planned.key, Body=self._body(planned, plan.rewrite),
                               Metadata=planned.metadata, **extra)
        meta_key = (f'PROJECT#{plan.project_id}', 'META')
        for table in ('aggregates', 'projects'):  # aggregates first; META held back for the conditional put
            with self.tables[table].batch_writer() as batch:
                for row_table, item in plan.rows:
                    if row_table == table and (item.get('pk'), item.get('sk')) != meta_key:
                        batch.put_item(Item=item)
        meta = next(item for table, item in plan.rows if table == 'projects' and (item['pk'], item['sk']) == meta_key)
        self.tables['projects'].put_item(Item=meta, ConditionExpression='attribute_not_exists(pk)')
