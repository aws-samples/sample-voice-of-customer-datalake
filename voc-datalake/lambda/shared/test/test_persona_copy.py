"""shared.persona_copy and the company container's lazy META, against moto DynamoDB + S3.

moto rather than mocks: the copy relies on DynamoDB refusing a write into a deleted project
(the persona-save writable check) and on S3's CopyObject metadata semantics.
"""
from datetime import UTC, datetime
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws

from shared import company_personas, persona_copy
from shared.avatar import AVATAR_OWNER_METADATA_KEY
from shared.exceptions import NotFoundError
from shared.test.moto_tables import create_pk_sk_table

BUCKET = 'raw-bucket'
NOW = datetime(2026, 11, 2, 9, 30, tzinfo=UTC)
SOURCE_KEY = 'avatars/persona_src/abc123.png'
SOURCE = {
    'pk': 'PROJECT#p1', 'sk': 'PERSONA#persona_src', 'gsi1pk': 'PROJECT#p1#PERSONAS', 'gsi1sk': 'old',
    'persona_id': 'persona_src', 'name': 'Budget Traveller', 'tagline': 'Flies Example Air on sale fares',
    'identity': {'role': 'Student'}, 'quotes': ['Cheap is good'], 'confidence': 'high',
    'research_notes': [{'note_id': 'n1', 'text': 'private interview note'}],
    'copied_from': {'scope': 'company', 'persona_id': 'persona_older'},
    'avatar_url': f's3://{BUCKET}/{SOURCE_KEY}', 'avatar_prompt': 'a smiling student',
    'created_at': '2026-01-01T00:00:00+00:00', 'updated_at': '2026-01-02T00:00:00+00:00',
}


@pytest.fixture
def world():
    with mock_aws():
        table = create_pk_sk_table('projects')
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        s3.put_object(Bucket=BUCKET, Key=SOURCE_KEY, Body=b'png', ContentType='image/png',
                      CacheControl='public, max-age=60', Metadata={AVATAR_OWNER_METADATA_KEY: 'p1'})
        for project_id in ('p1', 'p2'):
            table.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': 'META', 'project_id': project_id,
                                 'name': f'Project {project_id}', 'persona_count': 1})
        table.put_item(Item=SOURCE)
        yield table, s3


def _copy(table, s3, *, target='p2', ids=('persona_src',), scope: persona_copy.SourceScope = 'project',
          name='Project p1'):
    return persona_copy.copy_personas(
        table, s3, BUCKET, source_container='p1', source_scope=scope, source_project_name=name,
        persona_ids=list(ids), target_container=target, copied_by='admin-sub', now=NOW,
    )


def _personas(table, project_id):
    return [item for item in table.scan()['Items']
            if item['pk'] == f'PROJECT#{project_id}' and item['sk'].startswith('PERSONA#')]


def _bucket_keys(s3):
    return {obj['Key'] for obj in s3.list_objects_v2(Bucket=BUCKET).get('Contents', [])}


class TestCopyPersonas:
    def test_the_copy_is_a_new_persona_with_the_content_and_none_of_the_notes(self, world):
        table, s3 = world

        [copy] = _copy(table, s3)

        assert copy['persona_id'] != 'persona_src'
        assert copy['persona_id'].startswith('persona_20261102093000_')
        assert copy['pk'] == 'PROJECT#p2'
        assert copy['sk'] == f"PERSONA#{copy['persona_id']}"
        assert copy['gsi1pk'] == 'PROJECT#p2#PERSONAS'
        assert copy['created_at'] == copy['updated_at'] == copy['gsi1sk'] == NOW.isoformat()
        assert copy['research_notes'] == []
        for field in ('name', 'tagline', 'identity', 'quotes', 'confidence', 'avatar_prompt'):
            assert copy[field] == SOURCE[field]
        assert _personas(table, 'p2') == [copy]

    def test_copied_from_names_the_project_source_and_replaces_older_provenance(self, world):
        table, s3 = world

        [copy] = _copy(table, s3)

        assert copy['copied_from'] == {
            'scope': 'project', 'project_id': 'p1', 'project_name': 'Project p1',
            'persona_id': 'persona_src', 'copied_at': NOW.isoformat(), 'copied_by': 'admin-sub',
        }

    def test_a_company_source_carries_no_project_fields(self, world):
        table, s3 = world

        [copy] = _copy(table, s3, scope='company', name='')

        assert copy['copied_from'] == {'scope': 'company', 'persona_id': 'persona_src',
                                       'copied_at': NOW.isoformat(), 'copied_by': 'admin-sub'}

    def test_the_source_is_untouched(self, world):
        table, s3 = world

        _copy(table, s3)

        assert table.get_item(Key={'pk': 'PROJECT#p1', 'sk': 'PERSONA#persona_src'})['Item'] == SOURCE

    def test_two_copies_get_distinct_ids_and_the_target_count_is_recounted(self, world):
        table, s3 = world

        first = _copy(table, s3)
        second = _copy(table, s3)

        assert first[0]['persona_id'] != second[0]['persona_id']
        assert table.get_item(Key={'pk': 'PROJECT#p2', 'sk': 'META'})['Item']['persona_count'] == 2

    def test_the_avatar_is_copied_to_the_new_persona_and_stamped_with_the_target(self, world):
        table, s3 = world

        [copy] = _copy(table, s3)

        new_key = f"avatars/{copy['persona_id']}/abc123.png"
        assert copy['avatar_url'] == f's3://{BUCKET}/{new_key}'
        head = s3.head_object(Bucket=BUCKET, Key=new_key)
        assert head['Metadata'] == {AVATAR_OWNER_METADATA_KEY: 'p2'}
        assert head['ContentType'] == 'image/png'
        assert head['CacheControl'] == 'public, max-age=60'
        assert s3.head_object(Bucket=BUCKET, Key=SOURCE_KEY)['Metadata'] == {AVATAR_OWNER_METADATA_KEY: 'p1'}

    def test_a_failed_avatar_copy_still_saves_the_persona_without_one(self, world):
        table, s3 = world

        with patch.object(s3, 'copy_object', side_effect=RuntimeError('denied')):
            [copy] = _copy(table, s3)

        assert copy['avatar_url'] is None
        assert _personas(table, 'p2')[0]['avatar_url'] is None

    def test_an_avatar_outside_the_bucket_is_not_copied_or_pointed_at(self, world):
        table, s3 = world
        table.update_item(Key={'pk': 'PROJECT#p1', 'sk': 'PERSONA#persona_src'},
                          UpdateExpression='SET avatar_url = :u', ExpressionAttributeValues={':u': 'https://x/y.png'})

        [copy] = _copy(table, s3)

        assert copy['avatar_url'] is None

    def test_a_missing_source_persona_is_a_404_and_writes_nothing(self, world):
        table, s3 = world

        with pytest.raises(NotFoundError, match='Persona not found'):
            _copy(table, s3, ids=('persona_src', 'persona_gone'))

        assert _personas(table, 'p2') == []

    def test_a_deleted_target_is_a_404_and_its_copied_avatars_are_removed(self, world):
        table, s3 = world
        table.update_item(Key={'pk': 'PROJECT#p2', 'sk': 'META'}, UpdateExpression='SET deletion_started_at = :t',
                          ExpressionAttributeValues={':t': 'now'})

        with pytest.raises(NotFoundError, match='Project not found'):
            _copy(table, s3)

        assert _bucket_keys(s3) == {SOURCE_KEY}
        assert _personas(table, 'p2') == []

    def test_an_unexpected_save_failure_removes_the_unsaved_avatar_copies_and_re_raises(self, world):
        table, s3 = world
        with (
            patch.object(persona_copy, 'save_persona_items', side_effect=RuntimeError('throttled')),
            pytest.raises(RuntimeError, match='throttled'),
        ):
            _copy(table, s3)

        assert _bucket_keys(s3) == {SOURCE_KEY}

    def test_a_failure_after_the_save_keeps_the_avatar_of_the_stored_copy(self, world):
        table, s3 = world
        with (
            patch.object(persona_copy, 'store_persona_count', side_effect=RuntimeError('throttled')),
            pytest.raises(RuntimeError, match='throttled'),
        ):
            _copy(table, s3)

        [copy] = _personas(table, 'p2')
        copy_key = copy['avatar_url'].removeprefix(f's3://{BUCKET}/')
        assert _bucket_keys(s3) == {SOURCE_KEY, copy_key}


class TestCompanyContainerMeta:
    def test_the_first_write_creates_an_unlisted_private_meta(self, world):
        table, _ = world

        company_personas.ensure_company_personas_meta(table)

        meta = table.get_item(Key={'pk': 'PROJECT#company_personas', 'sk': 'META'})['Item']
        assert meta['kind'] == 'company_personas'
        assert meta['name'] == 'Company personas'
        assert meta['visibility'] == 'private'
        assert meta['owner_sub'] == 'system:company'
        assert meta['persona_count'] == 0
        assert 'gsi1pk' not in meta

    def test_a_second_call_keeps_the_existing_row(self, world):
        table, _ = world
        company_personas.ensure_company_personas_meta(table)
        table.update_item(Key={'pk': 'PROJECT#company_personas', 'sk': 'META'},
                          UpdateExpression='SET persona_count = :n', ExpressionAttributeValues={':n': 4})

        company_personas.ensure_company_personas_meta(table)

        meta = table.get_item(Key={'pk': 'PROJECT#company_personas', 'sk': 'META'})['Item']
        assert meta['persona_count'] == 4

    def test_a_copy_into_the_library_works_once_the_meta_exists(self, world):
        table, s3 = world
        company_personas.ensure_company_personas_meta(table)

        [copy] = _copy(table, s3, target='company_personas')

        assert company_personas.company_persona_items(table) == [copy]
        head = s3.head_object(Bucket=BUCKET, Key=f"avatars/{copy['persona_id']}/abc123.png")
        assert head['Metadata'] == {AVATAR_OWNER_METADATA_KEY: 'company_personas'}

    def test_without_the_meta_a_library_copy_is_refused(self, world):
        table, s3 = world

        with pytest.raises(NotFoundError):
            _copy(table, s3, target='company_personas')


def test_persona_summary_keeps_only_the_card_fields():
    persona = {**SOURCE, 'avatar_url': 'https://cdn/x'}

    assert company_personas.persona_summary(persona) == {
        'persona_id': 'persona_src', 'name': 'Budget Traveller', 'tagline': 'Flies Example Air on sale fares',
        'avatar_url': 'https://cdn/x', 'copied_from': SOURCE['copied_from'],
    }
    assert company_personas.persona_summary({'persona_id': 'p'}) == {
        'persona_id': 'p', 'name': '', 'tagline': '', 'avatar_url': None}
