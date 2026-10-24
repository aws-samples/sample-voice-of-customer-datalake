"""Regenerated avatars get a new key, so the CDN can never serve the old image (QA s3 F3).

The avatar used to live at `avatars/{persona_id}.{ext}` and a regeneration
overwrote it in place. The object is cached `immutable` for a year and the
`/avatars/*` CloudFront cache key ignores the query string (the signature does not
bust it), so production kept serving the previous bytes after a regeneration.

Each image is now content-addressed under the persona's prefix. These run against
moto S3 + DynamoDB (real listing, metadata and conditional-update semantics):

* two regenerations write two keys, the row and the response name the newest, and
  the response is a signed CDN URL rather than `s3://`;
* the image the row named before is removed once the new one is saved — including
  a legacy flat object written before owner stamps — while an object stamped by
  ANOTHER project (persona ids are not globally unique) is kept;
* the persona-delete and project-delete sweeps cover the new layout and the legacy
  flat keys alike.
"""
from collections.abc import Iterator
from contextlib import ExitStack
from dataclasses import dataclass
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table

from shared import avatar
from shared.avatar import AVATAR_OWNER_METADATA_KEY, avatar_object_key, get_avatar_cdn_url

BUCKET = 'test-raw-avatars'
PROJECT = 'proj-a'
PERSONA = 'persona_20260101120000'


@dataclass
class World:
    projects: Any
    jobs: Any
    s3: Any
    generated: int = 0

    def generate(self, persona: dict, project_id: str | None = None) -> dict:
        """generate_persona_avatar stand-in: a NEW image (new bytes) per call, stamped like the real one."""
        self.generated += 1
        key = avatar_object_key(persona['persona_id'], f'image-{self.generated}'.encode(), 'jpeg')
        self.put(key, owner=project_id)
        return {'avatar_url': f's3://{BUCKET}/{key}', 'avatar_prompt': f'prompt {self.generated}'}

    def put(self, key: str, owner: str | None = PROJECT) -> None:
        metadata = {AVATAR_OWNER_METADATA_KEY: owner} if owner else {}
        self.s3.put_object(Bucket=BUCKET, Key=key, Body=b'x', Metadata=metadata)

    def keys(self) -> set[str]:
        return {entry['Key'] for entry in self.s3.list_objects_v2(Bucket=BUCKET).get('Contents', [])}

    def persona(self, project_id: str = PROJECT) -> dict:
        return self.projects.get_item(Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{PERSONA}'})['Item']

    def seed(self, project_id: str = PROJECT, avatar_url: str | None = None) -> None:
        self.projects.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': 'META', 'project_id': project_id,
                                     'persona_count': 1})
        self.projects.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{PERSONA}',
                                     'persona_id': PERSONA, 'name': 'Ada', 'avatar_url': avatar_url})


@pytest.fixture
def world() -> Iterator[World]:
    """moto S3 + projects/jobs tables, wired into `projects` and the shared S3 accessor."""
    env = {'RAW_DATA_BUCKET': BUCKET, 'AVATARS_CDN_URL': 'https://cdn.example/avatars'}
    with mock_aws(), ExitStack() as stack:
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket=BUCKET)
        state = World(projects=pk_sk_table('avatar-projects'), jobs=pk_sk_table('avatar-jobs'), s3=client)
        for patcher in (
            patch('projects.projects_table', state.projects),
            patch('projects.get_jobs_table', return_value=state.jobs),
            patch('projects.get_s3_client', return_value=client),
            patch('shared.aws.get_s3_client', return_value=client),
            patch.dict('os.environ', env),
        ):
            stack.enter_context(patcher)
        yield state


def _regenerate(world: World, project_id: str = PROJECT) -> dict:
    import projects

    with patch.object(projects, 'generate_persona_avatar', side_effect=world.generate), \
            patch('shared.cloudfront_signing.sign_url', side_effect=lambda url: f'{url}?Signature=s'):
        return projects.regenerate_persona_avatar(project_id, PERSONA)


def _key(url: str) -> str:
    return url.removeprefix(f's3://{BUCKET}/')


class TestARegenerationIsANewObject:
    def test_two_regenerations_write_two_keys_and_the_row_names_the_newest(self, world):
        world.seed()

        first = _regenerate(world)
        first_url = world.persona()['avatar_url']
        second = _regenerate(world)
        second_url = world.persona()['avatar_url']

        assert first_url != second_url
        assert _key(second_url).startswith(f'avatars/{PERSONA}/')
        # The response is what the browser loads: signed, on the new path, never s3://.
        assert second['avatar_url'] == f"https://cdn.example/{_key(second_url)}?Signature=s"
        assert first['avatar_url'] != second['avatar_url']
        # The superseded image went once the row stopped naming it.
        assert world.keys() == {_key(second_url)}

    def test_a_legacy_flat_avatar_the_row_named_is_removed_even_without_a_stamp(self, world):
        legacy = f'avatars/{PERSONA}.jpeg'
        world.put(legacy, owner=None)
        world.seed(avatar_url=f's3://{BUCKET}/{legacy}')

        _regenerate(world)

        assert world.keys() == {_key(world.persona()['avatar_url'])}

    def test_another_projects_images_under_the_same_persona_id_are_kept(self, world):
        neighbour_nested = avatar_object_key(PERSONA, b'theirs', 'jpeg')
        neighbour_flat = f'avatars/{PERSONA}.png'
        world.put(neighbour_nested, owner='proj-b')
        world.put(neighbour_flat, owner='proj-b')
        world.seed()

        _regenerate(world)

        assert {neighbour_nested, neighbour_flat} <= world.keys()


class TestTheDeleteSweepsCoverBothLayouts:
    def test_deleting_a_persona_removes_its_nested_and_flat_images_and_keeps_a_neighbours(self, world):
        import projects

        mine_nested = avatar_object_key(PERSONA, b'mine', 'jpeg')
        theirs_nested = avatar_object_key(PERSONA, b'theirs', 'jpeg')
        world.put(mine_nested)
        world.put(f'avatars/{PERSONA}.png')
        world.put(theirs_nested, owner='proj-b')
        world.seed()

        assert projects.delete_persona(PROJECT, PERSONA) == {'success': True}

        assert world.keys() == {theirs_nested}

    def test_deleting_the_project_removes_every_image_it_owns(self, world):
        import projects

        world.put(avatar_object_key(PERSONA, b'one', 'jpeg'))
        world.put(avatar_object_key(PERSONA, b'two', 'jpeg'))
        world.put(f'avatars/{PERSONA}.jpeg')
        world.seed()

        projects.delete_project(PROJECT)

        assert world.keys() == set()


class TestTheCdnUrlKeepsThePath:
    def test_a_nested_key_signs_its_full_path_and_a_legacy_key_its_file_name(self):
        with patch('shared.cloudfront_signing.sign_url', side_effect=lambda url: url):
            nested = get_avatar_cdn_url('s3://b/avatars/p1/abc.jpeg', cdn_url='https://cdn/avatars')
            legacy = get_avatar_cdn_url('s3://b/avatars/p1.jpeg', cdn_url='https://cdn/avatars')
        assert (nested, legacy) == ('https://cdn/avatars/p1/abc.jpeg', 'https://cdn/avatars/p1.jpeg')

    def test_a_listing_failure_during_the_regeneration_sweep_is_logged_not_raised(self):
        class Broken:
            def get_paginator(self, _name: str) -> Any:
                raise RuntimeError('denied')

        with patch.object(avatar, 'logger') as logger:
            avatar.delete_superseded_avatars(Broken(), BUCKET, PERSONA, keep='k', project_id=PROJECT)
        assert 'Could not list superseded avatars' in logger.warning.call_args.args[0]
