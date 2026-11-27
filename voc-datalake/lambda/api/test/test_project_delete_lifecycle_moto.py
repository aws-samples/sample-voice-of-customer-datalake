"""Project delete removes every artifact the project owns, and nothing it does not.

Against moto (real S3 + DynamoDB semantics) because the hazards are wire-level:
prefix matching (`proj-1` vs `proj-10`), object metadata round-tripping, and
pagination keys. Ported from PR #407 by perrozzi.

The avatar case is the one that matters most. `avatars/{persona_id}.{ext}` is a
flat key space and persona ids are not globally unique (`persona_{YYYYMMDDHHMMSS}`
has no project component), so two projects can name ONE object. The delete
removes an avatar only when the object's stamped owner is the project being
deleted.
"""
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import patch

import pytest
from moto import mock_aws
from moto_helpers import projects_module_world

from shared.avatar import AVATAR_OWNER_METADATA_KEY

BUCKET = 'test-raw-data-bucket'
SHARED_PERSONA = 'persona_20260101120000'


@dataclass
class World:
    projects: Any
    jobs: Any
    s3: Any

    def put(self, key: str, owner: str | None = None) -> None:
        metadata = {AVATAR_OWNER_METADATA_KEY: owner} if owner else {}
        self.s3.put_object(Bucket=BUCKET, Key=key, Body=b'x', Metadata=metadata)

    def stored_keys(self) -> set[str]:
        listing = self.s3.list_objects_v2(Bucket=BUCKET)
        return {entry['Key'] for entry in listing.get('Contents', [])}

    def seed_project(self, project_id: str, persona_ids: tuple[str, ...] = ()) -> None:
        self.projects.put_item(Item={
            'pk': f'PROJECT#{project_id}', 'sk': 'META', 'project_id': project_id,
        })
        for persona_id in persona_ids:
            self.projects.put_item(Item={
                'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}',
            })


@pytest.fixture
def world() -> Iterator[World]:
    with mock_aws(), projects_module_world(BUCKET) as (projects, jobs, s3):
        yield World(projects=projects, jobs=jobs, s3=s3)


def _delete(project_id: str) -> dict:
    from projects import delete_project

    return delete_project(project_id)


class TestAvatarsAreDeletedOnlyByTheirOwner:
    def test_deleting_project_a_never_touches_project_bs_avatar(self, world):
        """Both projects have a persona with the SAME id; the one object is B's."""
        world.seed_project('proj-a', (SHARED_PERSONA,))
        world.seed_project('proj-b', (SHARED_PERSONA,))
        world.put(f'avatars/{SHARED_PERSONA}.jpeg', owner='proj-b')

        _delete('proj-a')

        assert f'avatars/{SHARED_PERSONA}.jpeg' in world.stored_keys()

    def test_the_projects_own_avatars_go_under_every_historical_extension(self, world):
        world.seed_project('proj-a', ('persona_1',))
        world.put('avatars/persona_1.jpeg', owner='proj-a')
        world.put('avatars/persona_1.png', owner='proj-a')

        _delete('proj-a')

        assert world.stored_keys() == set()

    def test_an_avatar_with_no_recorded_owner_is_left(self, world):
        """Written before the stamp existed: cannot tell whose it is, so kept."""
        world.seed_project('proj-a', ('persona_1',))
        world.put('avatars/persona_1.jpeg')

        _delete('proj-a')

        assert world.stored_keys() == {'avatars/persona_1.jpeg'}


class TestPrefixSweeps:
    def test_prototypes_go_and_a_neighbour_sharing_the_id_prefix_stays(self, world):
        world.seed_project('proj-1')
        world.put('prototypes/proj-1/doc.html')
        world.put('prototypes/proj-10/doc.html')

        _delete('proj-1')

        assert world.stored_keys() == {'prototypes/proj-10/doc.html'}

    def test_product_doc_uploads_and_extracted_text_go(self, world):
        world.seed_project('proj-1')
        world.put('projects/proj-1/product_docs/raw/d1.pdf')
        world.put('projects/proj-1/product_docs/extracted/d1.txt')
        world.put('projects/proj-10/product_docs/raw/d2.pdf')

        _delete('proj-1')

        assert world.stored_keys() == {'projects/proj-10/product_docs/raw/d2.pdf'}


class TestRowsAndTombstone:
    def test_job_rows_go_and_other_projects_jobs_stay(self, world):
        world.seed_project('proj-1')
        world.jobs.put_item(Item={'pk': 'PROJECT#proj-1', 'sk': 'JOB#j1'})
        world.jobs.put_item(Item={'pk': 'PROJECT#proj-2', 'sk': 'JOB#j2'})

        _delete('proj-1')

        assert [item['sk'] for item in world.jobs.scan()['Items']] == ['JOB#j2']

    def test_a_voice_session_s_row_goes_with_its_pointer_and_another_project_s_stays(self, world):
        world.seed_project('proj-1')
        for project, session in (('proj-1', 's-1'), ('proj-2', 's-2')):
            world.projects.put_item(Item={'pk': f'PROJECT#{project}', 'sk': f'VOICE#{session}'})
            world.projects.put_item(Item={'pk': f'VOICE#{session}', 'sk': 'SESSION', 'project_id': project})

        _delete('proj-1')

        assert sorted(item['pk'] for item in world.projects.scan()['Items'] if item['pk'].startswith('VOICE#')) == [
            'VOICE#s-2']

    def test_the_tombstone_is_finalized_after_the_sweeps(self, world):
        world.seed_project('proj-1', ('persona_1',))
        world.put('prototypes/proj-1/doc.html')

        result = _delete('proj-1')

        meta = world.projects.get_item(Key={'pk': 'PROJECT#proj-1', 'sk': 'META'})['Item']
        assert (result, meta['status']) == ({'success': True}, 'deleted')
        rows = world.projects.scan()['Items']
        assert sorted(item['pk'] for item in rows) == ['AUDIT#delete', 'PROJECT#proj-1']
        assert [item['sk'] for item in rows if item['pk'] == 'PROJECT#proj-1'] == ['META']
        audit = next(item for item in rows if item['pk'] == 'AUDIT#delete')
        assert (audit['kind'], audit['target'], audit['actor']) == (
            'project', {'project_id': 'proj-1'}, {'sub': 'system', 'kind': 'system'})
        assert 'ttl' not in audit

    def test_the_objects_go_before_the_rows(self, world):
        """7.48.00 (round 3): a delete stopped between the two leaves a product document's record without its
        objects (which an erasure lists as not checked), never its extracted text without a record."""
        import projects

        world.seed_project('proj-1', ('persona_1',))
        world.projects.put_item(Item={'pk': 'PROJECT#proj-1', 'sk': 'PRODUCT_DOC#d1'})
        world.put('projects/proj-1/product_docs/extracted/d1.txt')
        seen: list[bool] = []
        real = projects._sweep_project_objects

        def noted(project_id: str, persona_ids: list[str]) -> None:
            seen.append('Item' in world.projects.get_item(Key={'pk': 'PROJECT#proj-1', 'sk': 'PRODUCT_DOC#d1'}))
            assert persona_ids == ['persona_1']
            real(project_id, persona_ids)

        with patch.object(projects, '_sweep_project_objects', noted):
            _delete('proj-1')

        assert seen == [True]
        assert world.stored_keys() == set()

    def test_the_delete_takes_the_project_off_the_index_and_keeps_its_registry_row(self, world):
        """7.48.00 (3g-d): the tombstoned META leaves ``gsi1-by-type`` (the fence removes its index keys), so the
        erasure finds a deleted project through ``PROJECT_IDS``, which the delete never touches."""
        world.projects.put_item(Item={'pk': 'PROJECT#proj-1', 'sk': 'META', 'project_id': 'proj-1',
                                      'gsi1pk': 'TYPE#PROJECT', 'gsi1sk': 'x', 'owner_email': 'lead@example.com'})
        world.projects.put_item(Item={'pk': 'PROJECT_IDS', 'sk': 'proj-1', 'created_at': 'x'})

        _delete('proj-1')

        meta = world.projects.get_item(Key={'pk': 'PROJECT#proj-1', 'sk': 'META'})['Item']
        assert ('gsi1pk' in meta, meta['owner_email']) == (False, 'lead@example.com')
        assert 'Item' in world.projects.get_item(Key={'pk': 'PROJECT_IDS', 'sk': 'proj-1'})


@pytest.mark.parametrize(('sort_key', 'expected'), [
    pytest.param('PERSONA#persona_1', 'persona_1', id='persona row'),
    pytest.param('PERSONA#', None, id='empty id'),
    pytest.param('PERSONA#p1#NOTE#2', None, id='sub-row'),
    pytest.param('PRD#d1', None, id='other row'),
])
def test_persona_ids_come_only_from_exact_persona_rows(sort_key, expected):
    from projects import _persona_id_from_sort_key

    assert _persona_id_from_sort_key(sort_key) == expected


def test_the_sweep_prefixes_match_the_writers_key_layout():
    """Lockstep with the code that WRITES those objects, so a layout change in one
    place cannot leave the sweep listing a prefix nothing is under."""
    from product_doc_extractor import handler as extractor
    from projects import product_docs_project_prefix, prototype_project_prefix
    from shared.product_sources import product_doc_extracted_key, product_doc_raw_key, product_doc_source_key
    from shared.prototypes import prototype_draft_s3_key, prototype_s3_key

    assert prototype_s3_key('p1', 'd1', workspace=None).startswith(prototype_project_prefix('p1', workspace=None))
    # A prototype draft's object goes with its project too (docs/prototype-builder.md, part 2).
    assert prototype_draft_s3_key('p1', 'job_1', workspace=None).startswith(prototype_project_prefix('p1',
                                                                                                     workspace=None))
    assert extractor._extracted_key('p1', 'd1', None).startswith(product_docs_project_prefix('p1', workspace=None))
    # Every product source's objects (since 7.104.00: a PDF, DOCX or PPTX under source/ too) go with the project.
    for key in (product_doc_raw_key('p1', 'd1', 'md', workspace=None),
                product_doc_source_key('p1', 'd1', 'pdf', workspace=None),
                product_doc_extracted_key('p1', 'd1', workspace=None)):
        assert key.startswith(product_docs_project_prefix('p1', workspace=None))
