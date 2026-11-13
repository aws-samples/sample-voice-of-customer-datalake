"""Prototype drafts (docs/prototype-builder.md, part 2): start, read, apply, discard, through the real handler.

Against moto (real conditional puts, transactions and the access gate), through
``projects_handler.lambda_handler``:

* the start validates ``{instruction}`` (``pin_ids`` refused by name), drafts on the series HEAD
  whatever version is named, refuses a base whose HTML cannot be read, and records a
  ``draft_prototype`` job: no document row, no object, no pin form;
* the draft GET is EDIT, answers the detail and the signed URL of the job's OWN draft key, and is
  a 404 for another project's or series' job, an unfinished or non-draft job, a deleted job and a
  present row whose ``ttl`` is past;
* Apply is the next version (``edit_kind: revise``, ``revised_from_id``, ``revision_feedback``,
  ``edited_by``, ``llm_metadata``, no ``edited_from_id``) with its own pin form and widget, 201 then
  200 with the same version, 409 once the series moved (writing nothing), and finishes a version
  whose object an earlier attempt wrote;
* Discard (the draft DELETE, which deletes only a draft job of this series in any state, and the
  job DELETE the SPA uses) makes the GET and Apply 404; a viewer gets 403 on the four routes,
  and reads the job's status with ``draft_id`` and none of the detail.
"""
import json
import time
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table, project_route_call

from shared.document_versions import persist_versioned_document, versioned_document_id
from shared.indexes import PROJECTS_BY_TYPE_INDEX
from shared.prototype_pins import WIDGET_START, inject_pin_widget, pin_form_id
from shared.prototypes import prototype_draft_s3_key, prototype_s3_key

PROJECT = 'p1'
OTHER = 'p2'
BUCKET = 'raw-data'
API_BASE = 'https://abcdefghij.execute-api.us-east-1.amazonaws.com/v1'
EDITOR = {'sub': 'editor-sub', 'cognito:username': 'eddie', 'email': 'eddie@example.com'}
VIEWER = {'sub': 'viewer-sub', 'cognito:username': 'vera', 'email': 'vera@example.com'}
DRAFT_ID = 'job_0123456789abcdef'
INSTRUCTION = 'Make the summary a sticky footer on phones'
SUMMARY = 'Checkout: the summary is a sticky footer'
CANNOT_EDIT = {'success': False, 'error': 'You do not have permission to edit this project'}
NOT_FOUND = {'success': False, 'error': 'Draft not found'}


class World:
    def __init__(self, projects: Any, jobs: Any, pins: Any, s3: Any, call: Any, invoked: list[dict]) -> None:
        self.projects, self.jobs, self.pins, self.s3, self.call = projects, jobs, pins, s3, call
        self.invoked = invoked

    def prototype(self, job_id: str, body: str, *, title: str = 'Checkout', project: str = PROJECT,
                  **fields: Any) -> dict:
        """One built version: its row and its object, the widget naming its own form."""
        doc_id = versioned_document_id(project, 'prototype', job_id)
        html = inject_pin_widget(f'<!DOCTYPE html><html><body>{body}</body></html>', pin_form_id(doc_id))
        self.s3.put_object(Bucket=BUCKET, Key=prototype_s3_key(project, doc_id), Body=html.encode())
        return persist_versioned_document(self.projects, project, 'prototype', title, job_id, {
            'content': '', 'prototype_format': 'html', 'created_at': f'2026-05-0{len(job_id) % 9 + 1}T00:00:00+00:00',
            'job_id': job_id, 'source_prd_id': 'prd_1', **fields,
        })

    def draft(self, base: dict, *, project: str = PROJECT, draft_id: str = DRAFT_ID, html: str | None = None,
              **row: Any) -> dict:
        """A finished draft job of ``base`` and its object, as the document generator leaves them."""
        item = {
            'pk': f'PROJECT#{project}', 'sk': f'JOB#{draft_id}', 'job_id': draft_id, 'project_id': project,
            'job_type': 'draft_prototype', 'status': 'completed', 'ttl': int(time.time()) + 3600,
            'completed_at': '2026-05-09T00:00:00+00:00', 'result': {'draft_id': draft_id},
            'doc_config': {'doc_type': 'draft_prototype', 'base_document_id': base['document_id'],
                           'base_version': base['version'], 'instruction': INSTRUCTION},
            'draft': {'summary': SUMMARY, 'base_document_id': base['document_id'], 'base_version': base['version'],
                      'instruction': INSTRUCTION, 'llm_metadata': {'model': 'test-model', 'prompt_version': '1.0.0'}},
            **row,
        }
        self.jobs.put_item(Item=item)
        page = html if html is not None else '<!DOCTYPE html><html><body><footer>Sticky</footer></body></html>'
        self.s3.put_object(Bucket=BUCKET, Key=prototype_draft_s3_key(project, draft_id), Body=page.encode())
        return item

    def html(self, doc_id: str) -> str:
        return self.s3.get_object(Bucket=BUCKET, Key=prototype_s3_key(PROJECT, doc_id))['Body'].read().decode()

    def prototype_rows(self) -> list[dict]:
        # The project's own partition: the version allocations (DOCUMENT_VERSIONS#…) share the sort key prefix.
        rows = [row for row in self.projects.scan()['Items']
                if row['pk'] == f'PROJECT#{PROJECT}' and str(row['sk']).startswith('PROTOTYPE#')]
        return sorted(rows, key=lambda row: str(row['sk']))

    def pin_forms(self) -> list[str]:
        return sorted(str(row['sk']) for row in self.pins.scan()['Items'])

    def object_keys(self) -> list[str]:
        return sorted(o['Key'] for o in self.s3.list_objects_v2(Bucket=BUCKET).get('Contents', []))

    def draft_path(self, document_id: str, draft_id: str = DRAFT_ID) -> str:
        return f'/projects/{PROJECT}/prototypes/{document_id}/drafts/{draft_id}'

    def assert_no_draft(self, document_id: str, versions: int = 2) -> None:
        """The draft GET and Apply both answer 404, and no version was written."""
        assert self.call(EDITOR, 'GET', self.draft_path(document_id)) == (404, NOT_FOUND)
        assert self.call(EDITOR, 'POST', f'{self.draft_path(document_id)}/apply') == (404, NOT_FOUND)
        assert len(self.prototype_rows()) == versions


@pytest.fixture
def world(api_gateway_event, lambda_context, monkeypatch: pytest.MonkeyPatch) -> Iterator[World]:
    import projects
    import projects_handler
    from shared import jobs

    monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)
    monkeypatch.setenv('PIN_SUBMIT_API_BASE', API_BASE)
    with mock_aws():
        projects_table = pk_sk_table('drafts-projects', gsi1_index=PROJECTS_BY_TYPE_INDEX)
        jobs_table = pk_sk_table('drafts-jobs')
        pins = pk_sk_table('drafts-aggregates')
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        for project in (PROJECT, OTHER):
            projects_table.put_item(Item={
                'pk': f'PROJECT#{project}', 'sk': 'META', 'project_id': project, 'name': 'One',
                'gsi1pk': 'TYPE#PROJECT', 'gsi1sk': f'2026-01-01#{project}', 'status': 'active',
                'visibility': 'private', 'owner_sub': 'owner-sub', 'document_count': 0,
                'members': {EDITOR['sub']: {'role': 'editor'}, VIEWER['sub']: {'role': 'viewer'}},
            })
        invoked: list[dict] = []

        def call(claims: dict, method: str, path: str, body: dict | None = None) -> tuple[int, Any]:
            return project_route_call(api_gateway_event, lambda_context, claims, method, path, body)

        def sign_draft(project_id: str, draft_id: str) -> str:
            return f'https://cdn.example/prototypes/{project_id}/drafts/{draft_id}.html?Signature=s'

        def sign(project_id: str, doc_id: str) -> str:
            return f'https://cdn.example/prototypes/{project_id}/{doc_id}.html?Signature=s'

        with (
            patch.object(projects_handler, 'get_projects_table', return_value=projects_table),
            patch.object(projects_handler, 'get_aggregates_table', return_value=pins),
            patch.object(projects_handler, 'get_jobs_table', return_value=jobs_table),
            patch.object(jobs, 'get_jobs_table', return_value=jobs_table),
            patch.object(projects, 'projects_table', projects_table),
            patch.object(projects, 'get_s3_client', return_value=s3),
            patch.object(projects, 'get_aggregates_table', return_value=pins),
            patch.object(projects, 'prototype_signed_url', side_effect=sign),
            patch.object(projects_handler, 'prototype_draft_signed_url', side_effect=sign_draft),
            patch.object(projects_handler, 'invoke_lambda_async',
                         side_effect=lambda _fn, payload: invoked.append(payload)),
        ):
            yield World(projects_table, jobs_table, pins, s3, call, invoked)


def _two_versions(world: World) -> tuple[dict, dict]:
    v1 = world.prototype('job_1', '<h1>One</h1>')
    v2 = world.prototype('job_22', '<h1>Two</h1>', revised_from_id=v1['document_id'])
    return v1, v2


class TestStartingADraft:
    def test_it_is_a_draft_job_on_the_series_head_whatever_version_is_named(self, world):
        v1, v2 = _two_versions(world)
        rows, keys, forms = world.prototype_rows(), world.object_keys(), world.pin_forms()

        status, body = world.call(EDITOR, 'POST', f'/projects/{PROJECT}/prototypes/{v1["document_id"]}/drafts',
                                  {'instruction': f'  {INSTRUCTION}  ', 'response_language': 'en', 'extra': 1})

        assert status == 200, body
        assert body == {'success': True, 'job_id': body['job_id'], 'status': 'pending',
                        'message': 'Prototype draft started.'}
        [job] = world.jobs.scan()['Items']
        assert (job['job_type'], job['status'], job['initiated_by']) == ('draft_prototype', 'pending', EDITOR['sub'])
        config = job['doc_config']
        assert {key: config[key] for key in ('doc_type', 'base_document_id', 'base_version', 'instruction',
                                             'response_language')} == {
            'doc_type': 'draft_prototype', 'base_document_id': v2['document_id'], 'base_version': 2,
            'instruction': INSTRUCTION, 'response_language': 'en'}
        assert 'extra' not in config
        assert [payload['doc_config']['base_document_id'] for payload in world.invoked] == [v2['document_id']]
        # Nothing but the job: no version, no object, no pin form.
        assert (world.prototype_rows(), world.object_keys(), world.pin_forms()) == (rows, keys, forms)

    @pytest.mark.parametrize(('body', 'error'), [
        ({'instruction': INSTRUCTION, 'pin_ids': ['pin_1']}, 'Incorporating feedback into a draft is not available yet'),
        ({'pin_ids': ['pin_1']}, 'Incorporating feedback into a draft is not available yet'),
        ({}, 'instruction is required'),
        ({'instruction': '   '}, 'instruction is required'),
        ({'instruction': ['x']}, 'instruction is required'),
        ({'instruction': 'x' * 2001}, 'instruction must be at most 2000 characters'),
    ])
    def test_a_bad_body_is_a_400_and_no_job(self, world, body, error):
        _, v2 = _two_versions(world)

        status, answer = world.call(EDITOR, 'POST', f'/projects/{PROJECT}/prototypes/{v2["document_id"]}/drafts',
                                    body)

        assert (status, answer) == (400, {'success': False, 'error': error})
        assert world.jobs.scan()['Items'] == []
        assert world.invoked == []

    def test_an_instruction_of_2000_characters_is_accepted(self, world):
        _, v2 = _two_versions(world)
        status, _ = world.call(EDITOR, 'POST', f'/projects/{PROJECT}/prototypes/{v2["document_id"]}/drafts',
                               {'instruction': 'x' * 2000})
        assert status == 200

    def test_a_document_that_is_no_prototype_of_this_project_is_a_404(self, world):
        other = world.prototype('job_1', '<h1>Elsewhere</h1>', project=OTHER)
        world.projects.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'PRD#prd_1', 'document_id': 'prd_1'})

        for document_id in (other['document_id'], 'prd_1'):
            status, answer = world.call(EDITOR, 'POST', f'/projects/{PROJECT}/prototypes/{document_id}/drafts',
                                        {'instruction': INSTRUCTION})
            assert (status, answer) == (404, {'success': False, 'error': 'Prototype not found'})
        assert world.jobs.scan()['Items'] == []

    def test_an_early_json_spec_head_is_a_400_and_a_lost_object_a_404(self, world):
        spec = persist_versioned_document(world.projects, PROJECT, 'prototype', 'Spec', 'job_9', {
            'content': '{"screens": []}', 'created_at': '2026-01-01T00:00:00+00:00'})
        status, answer = world.call(EDITOR, 'POST', f'/projects/{PROJECT}/prototypes/{spec["document_id"]}/drafts',
                                    {'instruction': INSTRUCTION})
        assert status == 400
        assert 'early screen spec' in answer['error']

        _, v2 = _two_versions(world)
        world.s3.delete_object(Bucket=BUCKET, Key=prototype_s3_key(PROJECT, v2['document_id']))
        status, answer = world.call(EDITOR, 'POST', f'/projects/{PROJECT}/prototypes/{v2["document_id"]}/drafts',
                                    {'instruction': INSTRUCTION})
        assert status == 404
        assert 'no longer stored' in answer['error']
        assert world.jobs.scan()['Items'] == []


class TestAViewer:
    def test_is_refused_the_four_draft_routes(self, world):
        _, v2 = _two_versions(world)
        world.draft(v2)
        doc = v2['document_id']

        assert world.call(VIEWER, 'POST', f'/projects/{PROJECT}/prototypes/{doc}/drafts',
                          {'instruction': INSTRUCTION}) == (403, CANNOT_EDIT)
        assert world.call(VIEWER, 'GET', world.draft_path(doc)) == (403, CANNOT_EDIT)
        assert world.call(VIEWER, 'POST', f'{world.draft_path(doc)}/apply') == (403, CANNOT_EDIT)
        assert world.call(VIEWER, 'DELETE', world.draft_path(doc)) == (403, CANNOT_EDIT)
        assert (len(world.prototype_rows()), len(world.jobs.scan()['Items'])) == (2, 1)

    def test_reads_the_draft_jobs_status_with_its_draft_id_and_none_of_its_detail(self, world):
        _, v2 = _two_versions(world)
        world.draft(v2)

        status, body = world.call(VIEWER, 'GET', f'/projects/{PROJECT}/jobs/{DRAFT_ID}')

        assert status == 200
        assert (body['status'], body['result']) == ('completed', {'draft_id': DRAFT_ID})
        assert 'draft' not in body
        assert SUMMARY not in json.dumps(body)
        listed = world.call(VIEWER, 'GET', f'/projects/{PROJECT}/jobs')[1]['jobs']
        assert [job['result'] for job in listed] == [{'draft_id': DRAFT_ID}]
        assert SUMMARY not in json.dumps(listed)


class TestReadingADraft:
    def test_answers_the_detail_and_the_signed_url_of_its_own_key(self, world):
        v1, v2 = _two_versions(world)
        world.draft(v2)

        # Any version of the series reaches the draft.
        for doc in (v1['document_id'], v2['document_id']):
            status, body = world.call(EDITOR, 'GET', world.draft_path(doc))
            assert (status, body) == (200, {
                'draft_id': DRAFT_ID, 'base_document_id': v2['document_id'], 'base_version': 2,
                'instruction': INSTRUCTION, 'summary': SUMMARY,
                'preview_url': f'https://cdn.example/prototypes/{PROJECT}/drafts/{DRAFT_ID}.html?Signature=s',
                'completed_at': '2026-05-09T00:00:00+00:00'})

    def test_preview_url_is_null_when_signing_is_unavailable(self, world):
        import projects_handler

        _, v2 = _two_versions(world)
        world.draft(v2)
        with patch.object(projects_handler, 'prototype_draft_signed_url', return_value=None):
            status, body = world.call(EDITOR, 'GET', world.draft_path(v2['document_id']))
        assert (status, body['preview_url']) == (200, None)

    @pytest.mark.parametrize('row', [
        {'status': 'running'}, {'status': 'failed'}, {'job_type': 'build_prototype'},
        {'ttl': int(time.time()) - 1}, {'draft': 'not a map'},
    ])
    def test_an_unfinished_non_draft_expired_or_detail_less_job_is_a_404(self, world, row):
        _, v2 = _two_versions(world)
        world.draft(v2, **row)

        world.assert_no_draft(v2['document_id'])

    def test_another_projects_job_and_another_series_draft_are_404(self, world):
        _, v2 = _two_versions(world)
        other_series = world.prototype('job_333', '<h1>Other</h1>', title='Onboarding')
        world.draft(v2, project=OTHER)
        world.draft(other_series, draft_id='job_00000000000000aa')

        # The draft of another project's job id is not read under this project.
        assert world.call(EDITOR, 'GET', world.draft_path(v2['document_id'])) == (404, NOT_FOUND)
        # A draft of the Onboarding series is not one of Checkout's.
        assert world.call(EDITOR, 'GET', world.draft_path(v2['document_id'], 'job_00000000000000aa')) == (
            404, NOT_FOUND)
        assert world.call(EDITOR, 'POST', f'{world.draft_path(v2["document_id"], "job_00000000000000aa")}/apply') \
            == (404, NOT_FOUND)

    @pytest.mark.parametrize('draft_id', ['job_1', 'JOB_0123456789ABCDEF', 'other'])
    def test_an_id_that_names_no_job_is_a_404(self, world, draft_id):
        _, v2 = _two_versions(world)
        assert world.call(EDITOR, 'GET', world.draft_path(v2['document_id'], draft_id)) == (404, NOT_FOUND)

    def test_a_draft_is_in_no_project_read(self, world):
        import projects
        from shared.project_access import Caller

        _, v2 = _two_versions(world)
        world.draft(v2)

        read = projects.get_project(PROJECT, Caller(subject=EDITOR['sub']))

        assert sorted(d['document_id'] for d in read['documents']) == sorted(
            r['document_id'] for r in world.prototype_rows())
        assert DRAFT_ID not in json.dumps(read, default=str)
        assert SUMMARY not in json.dumps(read, default=str)


class TestApplyingADraft:
    def test_it_is_the_next_version_recorded_as_a_revise_by_the_applier(self, world):
        _, v2 = _two_versions(world)
        world.draft(v2)

        status, body = world.call(EDITOR, 'POST', f'{world.draft_path(v2["document_id"])}/apply')

        assert status == 201, body
        document = body['document']
        new_id = versioned_document_id(PROJECT, 'prototype', f'apply:{DRAFT_ID}')
        assert (body['success'], document['document_id'], document['version'], document['title']) == (
            True, new_id, 3, 'Checkout (v3)')
        assert document['edit_kind'] == 'revise'
        assert document['revised_from_id'] == v2['document_id']
        assert document['revision_feedback'] == INSTRUCTION
        assert document['edited_by'] == {'sub': EDITOR['sub'], 'kind': 'user'}
        assert document['llm_metadata'] == {'model': 'test-model', 'prompt_version': '1.0.0'}
        assert 'edited_from_id' not in document
        assert document['prototype_url'] == f'https://cdn.example/prototypes/{PROJECT}/{new_id}.html?Signature=s'
        assert document['source_prd_id'] == 'prd_1'

    def test_the_version_carries_the_drafts_html_with_its_own_pin_form(self, world):
        _, v2 = _two_versions(world)
        world.draft(v2, html=inject_pin_widget('<!DOCTYPE html><html><body><footer>Sticky</footer></body></html>',
                                               pin_form_id(v2['document_id'])))

        new_id = world.call(EDITOR, 'POST', f'{world.draft_path(v2["document_id"])}/apply')[1]['document']['document_id']

        html = world.html(new_id)
        assert '<footer>Sticky</footer>' in html
        assert html.count(WIDGET_START) == 1
        assert f"formId: '{pin_form_id(new_id)}'" in html
        assert pin_form_id(v2['document_id']) not in html
        form = world.pins.get_item(Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{pin_form_id(new_id)}'})['Item']
        assert form['document_id'] == new_id

    def test_a_second_apply_answers_200_with_the_same_version(self, world):
        _, v2 = _two_versions(world)
        world.draft(v2)
        path = f'{world.draft_path(v2["document_id"])}/apply'

        first = world.call(EDITOR, 'POST', path)
        again = world.call(EDITOR, 'POST', path)

        assert (first[0], again[0]) == (201, 200)
        assert again[1]['document']['document_id'] == first[1]['document']['document_id']
        assert again[1]['document']['version'] == 3
        assert len(world.prototype_rows()) == 3

    def test_an_apply_that_another_one_beat_is_answered_200_with_that_version_not_409(self, world):
        """Two Applies at the same moment: this one looked before the other landed, so its write finds the
        series moved; the version that moved it is this draft's own, so the answer is that replay."""
        from shared import prototype_drafts, prototype_versions

        _, v2 = _two_versions(world)
        world.draft(v2)
        path = f'{world.draft_path(v2["document_id"])}/apply'
        first = world.call(EDITOR, 'POST', path)
        real = prototype_drafts.get_versioned_document_by_allocation
        looks: list[tuple] = []

        def looked_before_the_other_landed(*args: Any) -> dict | None:
            looks.append(args)
            return None if len(looks) == 1 else real(*args)

        with patch.object(prototype_drafts, 'get_versioned_document_by_allocation',
                          side_effect=looked_before_the_other_landed), \
                patch.object(prototype_versions, 'get_versioned_document_by_allocation', return_value=None):
            again = world.call(EDITOR, 'POST', path)

        assert (first[0], again[0]) == (201, 200)
        assert again[1]['document']['document_id'] == first[1]['document']['document_id']
        assert len(looks) == 2
        assert len(world.prototype_rows()) == 3

    def test_a_series_that_moved_past_the_base_is_409_and_nothing_is_written(self, world):
        _, v2 = _two_versions(world)
        world.draft(v2)
        world.prototype('job_4444', '<h1>Three</h1>')
        keys, forms = world.object_keys(), world.pin_forms()

        status, body = world.call(EDITOR, 'POST', f'{world.draft_path(v2["document_id"])}/apply')

        assert status == 409
        assert body['error'] == 'The document was changed by someone else; reload it and try again'
        assert (len(world.prototype_rows()), world.object_keys(), world.pin_forms()) == (3, keys, forms)

    def test_an_object_left_by_an_attempt_whose_row_failed_is_finished(self, world):
        _, v2 = _two_versions(world)
        world.draft(v2)
        new_id = versioned_document_id(PROJECT, 'prototype', f'apply:{DRAFT_ID}')
        earlier = world.s3.put_object(Bucket=BUCKET, Key=prototype_s3_key(PROJECT, new_id), Body=b'<html></html>')

        status, body = world.call(EDITOR, 'POST', f'{world.draft_path(v2["document_id"])}/apply')

        assert status == 201
        assert (body['document']['document_id'], body['document']['prototype_etag']) == (new_id, earlier['ETag'])

    def test_a_draft_whose_object_is_gone_is_a_404(self, world):
        _, v2 = _two_versions(world)
        world.draft(v2)
        world.s3.delete_object(Bucket=BUCKET, Key=prototype_draft_s3_key(PROJECT, DRAFT_ID))

        status, body = world.call(EDITOR, 'POST', f'{world.draft_path(v2["document_id"])}/apply')

        assert status == 404
        assert 'no longer stored' in body['error']
        assert len(world.prototype_rows()) == 2


class TestDiscardingADraft:
    def test_the_job_delete_makes_the_draft_404_everywhere_and_keeps_the_versions(self, world):
        _, v2 = _two_versions(world)
        world.draft(v2)

        assert world.call(EDITOR, 'DELETE', f'/projects/{PROJECT}/jobs/{DRAFT_ID}') == (200, {'success': True})

        world.assert_no_draft(v2['document_id'])

    @pytest.mark.parametrize('status', ['completed', 'running', 'failed'])
    def test_the_draft_delete_discards_a_draft_of_this_series_in_any_state(self, world, status):
        v1, v2 = _two_versions(world)
        world.draft(v2, status=status)

        # Any version of the series names the draft, as for the GET.
        assert world.call(EDITOR, 'DELETE', world.draft_path(v1['document_id'])) == (200, {'success': True})

        assert world.jobs.scan()['Items'] == []
        world.assert_no_draft(v2['document_id'])

    def test_the_draft_delete_refuses_a_job_that_is_no_draft_and_another_series_draft(self, world):
        _, v2 = _two_versions(world)
        other_series = world.prototype('job_333', '<h1>Other</h1>', title='Onboarding')
        world.jobs.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'JOB#job_00000000000000bb',
                                  'job_id': 'job_00000000000000bb', 'job_type': 'build_prototype',
                                  'status': 'completed', 'doc_config': {'base_document_id': v2['document_id']}})
        world.draft(other_series, draft_id='job_00000000000000aa')

        for draft_id in ('job_00000000000000bb', 'job_00000000000000aa', 'job_00000000000000cc'):
            assert world.call(EDITOR, 'DELETE', world.draft_path(v2['document_id'], draft_id)) == (404, NOT_FOUND)
        assert sorted(row['job_id'] for row in world.jobs.scan()['Items']) == [
            'job_00000000000000aa', 'job_00000000000000bb']

    def test_the_draft_delete_of_a_document_that_is_no_prototype_is_a_404(self, world):
        _, v2 = _two_versions(world)
        world.draft(v2)

        status, body = world.call(EDITOR, 'DELETE', world.draft_path('prd_1'))

        assert (status, body) == (404, {'success': False, 'error': 'Prototype not found'})
        assert len(world.jobs.scan()['Items']) == 1
