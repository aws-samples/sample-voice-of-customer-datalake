"""Workspace deletes really delete, are recorded, and leave a note on what cited them (docs/project-workspace.md).

Against moto with a VERSIONED bucket: a plain DeleteObject there only adds a delete
marker, so "every version goes" is only provable on real versioning semantics.
"""
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from boto3.dynamodb.conditions import Key
from moto import mock_aws
from moto_helpers import projects_module_world

from shared.avatar import AVATAR_OWNER_METADATA_KEY

BUCKET = 'test-raw-data-bucket'
P = 'proj-1'
ACTOR = {'sub': 'u-1', 'kind': 'user'}


@dataclass
class World:
    projects: Any
    s3: Any

    def put_versions(self, key: str, owner: str | None = None) -> None:
        metadata = {AVATAR_OWNER_METADATA_KEY: owner} if owner else {}
        for body in (b'1', b'2'):
            self.s3.put_object(Bucket=BUCKET, Key=key, Body=body, Metadata=metadata)

    def versions(self, prefix: str = '') -> list[str]:
        page = self.s3.list_object_versions(Bucket=BUCKET, Prefix=prefix)
        return sorted(e['Key'] for e in [*page.get('Versions', []), *page.get('DeleteMarkers', [])])

    def audit(self) -> list[dict]:
        return self.projects.query(KeyConditionExpression=Key('pk').eq('AUDIT#delete'))['Items']

    def row(self, sk: str) -> dict | None:
        return self.projects.get_item(Key={'pk': f'PROJECT#{P}', 'sk': sk}).get('Item')

    def seed(self, *, personas: int = 0, documents: int = 0) -> None:
        self.projects.put_item(Item={'pk': f'PROJECT#{P}', 'sk': 'META', 'project_id': P,
                                     'persona_count': personas, 'document_count': documents})


@pytest.fixture
def world() -> Iterator[World]:
    with mock_aws(), projects_module_world(BUCKET) as (projects, _jobs, s3):
        s3.put_bucket_versioning(Bucket=BUCKET, VersioningConfiguration={'Status': 'Enabled'})
        yield World(projects=projects, s3=s3)


def _doc(document_id: str, **fields: Any) -> dict:
    return {'pk': f'PROJECT#{P}', 'sk': f'DOC#{document_id}', 'document_id': document_id,
            'document_type': 'custom', 'title': 'T', 'content': 'c', **fields}


class TestPersonaDelete:
    def test_the_avatar_loses_every_version_the_delete_is_recorded_and_citing_documents_say_so(self, world):
        from projects import delete_persona

        world.seed(personas=1, documents=2)
        world.projects.put_item(Item={'pk': f'PROJECT#{P}', 'sk': 'PERSONA#x1', 'persona_id': 'x1', 'name': 'Budget Ben'})
        world.projects.put_item(Item=_doc('d1', derivation={'persona_ids': ['x1', 'x2']}))
        world.projects.put_item(Item=_doc('d2', derivation={'persona_ids': ['x2']}))
        world.put_versions('avatars/x1/abc.png', owner=P)

        assert delete_persona(P, 'x1', actor=ACTOR) == {'success': True}

        assert world.row('PERSONA#x1') is None
        assert world.versions('avatars/') == []
        [audit] = world.audit()
        assert (audit['kind'], audit['target'], audit['actor']) == (
            'persona', {'project_id': P, 'persona_id': 'x1'}, ACTOR)
        cited = world.row('DOC#d1')
        assert cited['derivation']['persona_ids'] == ['x1', 'x2']  # lineage kept
        [entry] = cited['deleted_sources']
        assert (entry['kind'], entry['id'], entry['name']) == ('persona', 'x1', 'Budget Ben')
        assert 'deleted_sources' not in world.row('DOC#d2')

    def test_a_company_persona_is_recorded_as_one(self, world):
        from projects import delete_persona
        from shared.company_personas import COMPANY_PERSONAS_CONTAINER as C

        world.projects.put_item(Item={'pk': f'PROJECT#{C}', 'sk': 'META', 'project_id': C, 'persona_count': 1})
        world.projects.put_item(Item={'pk': f'PROJECT#{C}', 'sk': 'PERSONA#c1', 'persona_id': 'c1'})
        delete_persona(C, 'c1', actor={'sub': 'a-1', 'kind': 'admin'})
        assert [a['kind'] for a in world.audit()] == ['company_persona']


class TestReplaceRegeneration:
    def test_each_replaced_persona_is_recorded_by_the_requester_and_cited_documents_say_so(self, world):
        import projects

        world.seed(personas=2, documents=1)
        world.projects.put_item(Item={'pk': f'PROJECT#{P}', 'sk': 'PERSONA#a', 'persona_id': 'a', 'name': 'A'})
        world.projects.put_item(Item={'pk': f'PROJECT#{P}', 'sk': 'PERSONA#b', 'persona_id': 'b', 'protected': True})
        world.projects.put_item(Item=_doc('d1', derivation={'persona_ids': ['a', 'b']}))

        projects._clear_existing_personas(P, actor=projects._requested_by({'requested_by': ACTOR}))

        assert [(a['kind'], a['target']['persona_id'], a['actor']) for a in world.audit()] == [
            ('persona_replaced', 'a', ACTOR)]
        assert [(e['id'], e['name']) for e in world.row('DOC#d1')['deleted_sources']] == [('a', 'A')]

    @pytest.mark.parametrize('filters', [{}, {'requested_by': 'u-1'}, {'requested_by': {'sub': 1, 'kind': 'user'}}])
    def test_an_older_or_malformed_job_has_no_requester(self, filters):
        import projects

        assert projects._requested_by(filters) is None


class TestDocumentDelete:
    def test_a_prototype_loses_every_html_version_and_its_citers_say_so(self, world):
        from projects import delete_document

        world.seed(documents=2)
        world.projects.put_item(Item={'pk': f'PROJECT#{P}', 'sk': 'PROTOTYPE#p1', 'document_id': 'p1',
                                      'document_type': 'prototype', 'title': 'Proto v1', 'version': 1})
        world.projects.put_item(Item=_doc('d2', derivation={'sources': [{'document_id': 'p1', 'role': 'reference'}]}))
        world.put_versions(f'prototypes/{P}/p1.html')
        world.put_versions(f'prototypes/{P}/p10.html')

        assert delete_document(P, 'p1', actor=ACTOR) == {'success': True}

        assert world.versions('prototypes/') == [f'prototypes/{P}/p10.html'] * 2
        assert [(a['kind'], a['target']) for a in world.audit()] == [
            ('document', {'project_id': P, 'document_id': 'p1'})]
        [entry] = world.row('DOC#d2')['deleted_sources']
        assert (entry['kind'], entry['id'], 'name' in entry) == ('document', 'p1', False)

    def test_an_unmanaged_document_records_its_revisions_too(self, world):
        from projects import delete_document

        world.seed(documents=1)
        world.projects.put_item(Item=_doc('d1'))
        delete_document(P, 'd1', actor=ACTOR)
        assert sorted(a['kind'] for a in world.audit()) == ['document', 'document_revisions']


class TestProjectDelete:
    def test_every_version_under_the_projects_prefixes_goes(self, world):
        from projects import delete_project

        world.seed()
        world.put_versions(f'prototypes/{P}/a.html')
        world.put_versions(f'projects/{P}/product_docs/x/raw.pdf')
        world.put_versions('prototypes/proj-10/keep.html')

        delete_project(P, actor=ACTOR)

        assert world.versions() == ['prototypes/proj-10/keep.html'] * 2
        assert [(a['kind'], a['actor']) for a in world.audit()] == [('project', ACTOR)]


class TestSupersededAvatar:
    def test_a_replaced_avatar_loses_every_version_and_the_new_one_stays(self, world):
        from shared.avatar import delete_superseded_avatars

        world.put_versions('avatars/x1/old.png', owner=P)
        world.put_versions('avatars/x1/new.png', owner=P)
        delete_superseded_avatars(world.s3, BUCKET, 'x1', keep='avatars/x1/new.png', project_id=P)
        assert world.versions('avatars/') == ['avatars/x1/new.png'] * 2
