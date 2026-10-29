"""Persona generation against a project deleted mid-run, and the save path's other cancellations.

5.35.01 live (e2e s3 step 02): the project was deleted while its personas were
being written. Every avatar was made, then the first persona's transaction came
back ``[ConditionalCheckFailed, None]`` (the project-writable check) and the job
raised a generic "Please try again" ServiceError to the DLQ. Against moto (real
transaction cancellation reasons) and the real ``delete_project``.
"""
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import projects_module_world
from persona_fakes import FakePersonaModel

import projects
from shared import jobs as shared_jobs
from shared import persona_save
from shared.avatar import AVATAR_OWNER_METADATA_KEY
from shared.exceptions import NotFoundError
from shared.jobs import JobContext, job_handler

BUCKET = 'test-raw-data-bucket'
PROJECT = 'proj-live'
NAMES = ['Ada Moreno', 'Grace Okafor', 'Mary Lindqvist']


@dataclass
class World:
    projects: Any
    jobs: Any
    s3: Any
    avatar_calls: int = 0

    def seed(self, persona_ids: tuple[str, ...] = ()) -> None:
        self.projects.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT})
        for persona_id in persona_ids:
            self.projects.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': f'PERSONA#{persona_id}', 'persona_id': persona_id})

    def persona_rows(self) -> list[dict]:
        return self.projects.query(
            KeyConditionExpression='pk = :pk AND begins_with(sk, :p)',
            ExpressionAttributeValues={':pk': f'PROJECT#{PROJECT}', ':p': 'PERSONA#'},
        )['Items']

    def avatar_keys(self) -> set[str]:
        return {o['Key'] for o in self.s3.list_objects_v2(Bucket=BUCKET).get('Contents', [])}


@pytest.fixture
def world() -> Iterator[World]:
    with mock_aws(), projects_module_world(BUCKET, also_shared_jobs=True) as (projects_table, jobs, s3):
        yield World(projects=projects_table, jobs=jobs, s3=s3)


def _corpus() -> projects._PersonaCorpus:
    return projects._PersonaCorpus(
        items=[{'feedback_id': 'fb-1', 'source_platform': 'webscraper'}], context='CTX', stats='STATS',
        context_budget=5000, fetch_limit=40, fetch_limit_reached=False, corpus_chars=10, char_cap_applied=False,
    )


def _avatar_maker(world: World, *, delete_project_on_call: int | None = None):
    """A stand-in avatar generator that stores a real owner-stamped object (and can delete the project)."""
    def make(project_id: str, persona_id: str, _persona: dict) -> dict:
        world.avatar_calls += 1
        key = f'avatars/{persona_id}/a.jpeg'
        world.s3.put_object(Bucket=BUCKET, Key=key, Body=b'x', Metadata={AVATAR_OWNER_METADATA_KEY: project_id})
        if world.avatar_calls == delete_project_on_call:
            projects.delete_project(project_id)
        return {'avatar_url': f's3://{BUCKET}/{key}', 'avatar_prompt': 'p'}
    return make


def _generate(world: World, filters: dict, **avatar_kwargs) -> dict:
    with patch.object(projects, '_load_persona_corpus', return_value=_corpus()), \
            patch.object(projects, 'converse_detailed', FakePersonaModel(NAMES)), \
            patch.object(projects, '_avatar_for', _avatar_maker(world, **avatar_kwargs)), \
            patch.object(projects, 'AVATAR_MAX_CONCURRENCY', 1):
        return projects.generate_personas(PROJECT, {'persona_count': 3, **filters})


class TestAProjectDeletedDuringGeneration:
    def test_deleted_after_the_avatars_is_a_404_that_logs_the_reasons_and_leaves_no_avatar(self, world):
        world.seed()
        with patch.object(persona_save, 'logger') as log, pytest.raises(persona_save.ProjectNotWritableError):
            _generate(world, {}, delete_project_on_call=3)

        reasons = [c.kwargs['extra']['cancellation_reasons'] for c in log.warning.call_args_list]
        assert reasons == [['ConditionalCheckFailed', None]]
        assert world.persona_rows() == []
        assert world.avatar_keys() == set(), 'the unsaved personas left avatar objects behind'

    def test_deleted_before_the_avatars_makes_no_avatar(self, world):
        world.seed()
        model = FakePersonaModel(NAMES)
        def delete_then_answer(**kwargs):
            if kwargs.get('step_name') == 'persona_plan':
                projects.delete_project(PROJECT)
            return model(**kwargs)
        with patch.object(projects, '_load_persona_corpus', return_value=_corpus()), \
                patch.object(projects, 'converse_detailed', delete_then_answer), \
                patch.object(projects, '_avatar_for', _avatar_maker(world)), \
                pytest.raises(persona_save.ProjectNotWritableError):
            projects.generate_personas(PROJECT, {'persona_count': 3})
        assert world.avatar_calls == 0

    def test_the_job_ends_as_a_terminal_not_found_without_raising_or_error_logs(self, world):
        world.seed()
        world.jobs.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'JOB#job-1', 'status': 'running'})

        @job_handler(error_message='Persona generation failed')
        def handle(_ctx: JobContext, _project_id: str, _job_id: str, filters: dict) -> dict:
            return _generate(world, filters, delete_project_on_call=1)

        with patch('shared.jobs.logger') as job_log:
            result = handle({'project_id': PROJECT, 'job_id': 'job-1', 'filters': {}})

        assert result['success'] is False
        assert 'deleted while its personas were being generated' in result['error']
        job_log.error.assert_not_called()
        job_log.exception.assert_not_called()
        assert issubclass(persona_save.ProjectNotWritableError, NotFoundError)


class TestTheSaveKeepsWhatItCan:
    def test_a_persona_already_stored_is_kept_and_the_others_are_saved(self, world):
        world.seed(('p-1',))
        items = [{'pk': f'PROJECT#{PROJECT}', 'sk': f'PERSONA#p-{i}', 'persona_id': f'p-{i}', 'name': f'N{i}'} for i in (1, 2, 3)]

        saved = persona_save.save_persona_items(world.projects, PROJECT, items)

        assert [s['persona_id'] for s in saved] == ['p-1', 'p-2', 'p-3']
        assert sorted(r['persona_id'] for r in world.persona_rows()) == ['p-1', 'p-2', 'p-3']

    def test_a_transient_conflict_is_retried_and_the_persona_saved(self, world):
        world.seed()
        conflict = ClientError({'Error': {'Code': 'TransactionCanceledException', 'Message': 'x'},
                                'CancellationReasons': [{'Code': 'TransactionConflict'}, {'Code': 'None'}]},
                               'TransactWriteItems')
        real = persona_save.put_project_item
        calls = MagicMock(side_effect=[conflict, None])
        def flaky(table, project_id, item):
            if calls() is None:
                real(table, project_id, item)
        item = {'pk': f'PROJECT#{PROJECT}', 'sk': 'PERSONA#p-1', 'persona_id': 'p-1'}
        sleep = MagicMock()
        with patch.object(persona_save, 'put_project_item', flaky):
            saved = persona_save.save_persona_items(world.projects, PROJECT, [item], sleep=sleep)
        assert saved == [item]
        assert [r['persona_id'] for r in world.persona_rows()] == ['p-1']
        sleep.assert_called_once()

    def test_appending_personas_counts_the_kept_ones_too(self, world):
        world.seed(('old-1', 'old-2'))

        result = _generate(world, {'keep_existing_personas': True, 'generate_avatars': False})

        meta = world.projects.get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'})['Item']
        assert len(result['personas']) == 3
        assert meta['persona_count'] == 5


@pytest.mark.usefixtures('world')
class TestAJobRowThatIsGone:
    def test_a_status_update_for_a_deleted_job_is_info_not_an_error(self):
        with patch.object(shared_jobs, 'logger') as log:
            shared_jobs.update_job_status(PROJECT, 'job-gone', 'running', 50, 'writing_personas')

        log.error.assert_not_called()
        (message,) = [c.args[0] for c in log.info.call_args_list]
        assert 'no longer exists' in message
