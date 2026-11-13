"""The document generator's draft mode (docs/prototype-builder.md, part 2): ``doc_type: draft_prototype``.

Against moto (the projects and jobs tables, the raw bucket), with the model stubbed:

* the summary is the ``<change_summary>`` block as plain text, its lines and total capped; the
  HTML is extracted from the rest, with the pin widget stripped (the model may echo one);
* the object is at ``prototypes/{project}/drafts/{job}.html`` with NO metadata; no document row
  and no pin form are written;
* the detail (summary, base, instruction, ``llm_metadata``) is on the job row, and the job's result
  is exactly ``{draft_id}``;
* no HTML fails the job; a replay that finds its detail and object makes no second model call;
* the prompt carries the base's HTML without its widget and the instruction, and asks for the
  summary first; its version is pinned to its digest.
"""
import hashlib
from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws

from shared.converse import ConverseResult
from shared.document_versions import persist_versioned_document, versioned_document_id
from shared.prototype_drafts import (
    DRAFT_PROMPT_VERSION,
    MAX_SUMMARY_CHARS,
    MAX_SUMMARY_LINE_CHARS,
    MAX_SUMMARY_LINES,
    parse_change_summary,
)
from shared.prototype_pins import WIDGET_START, inject_pin_widget, pin_form_id
from shared.prototypes import prototype_draft_s3_key, prototype_s3_key

PROJECT = 'proj_1'
JOB = 'job_0123456789abcdef'
BUCKET = 'test-raw-data-bucket'
INSTRUCTION = 'Make the summary a sticky footer on phones'
HTML = '<!DOCTYPE html><html><body><footer class="sticky">Total</footer></body></html>'
ANSWER = f'<change_summary>\nCheckout: the summary is a sticky footer\n\nHome: unchanged\n</change_summary>\n{HTML}'

#: DRAFT_PROMPT_VERSION -> sha256 of the draft prompt (the output rules + the user template). Append only:
#: a prompt edit needs a new version and its digest here.
PINNED_PROMPTS = {'1.0.0': '2c67fc85d6d2f876697a891c871e5fae9bb8099e030953e7bfe98299956d96dc'}


def _table(dynamodb: Any, name: str) -> Any:
    return dynamodb.create_table(
        TableName=name, BillingMode='PAY_PER_REQUEST',
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                              {'AttributeName': 'sk', 'AttributeType': 'S'}])


class World:
    def __init__(self, projects: Any, jobs: Any, s3: Any, converse: MagicMock) -> None:
        self.projects, self.jobs, self.s3, self.converse = projects, jobs, s3, converse

    def base(self) -> dict:
        doc_id = versioned_document_id(PROJECT, 'prototype', 'job_build')
        page = inject_pin_widget('<!DOCTYPE html><html><body><aside>Summary</aside></body></html>', pin_form_id(doc_id))
        self.s3.put_object(Bucket=BUCKET, Key=prototype_s3_key(PROJECT, doc_id), Body=page.encode())
        return persist_versioned_document(self.projects, PROJECT, 'prototype', 'Checkout', 'job_build', {
            'content': '', 'prototype_format': 'html', 'created_at': '2026-05-01T00:00:00+00:00'})

    def job(self, base: dict, **config: Any) -> dict:
        doc_config = {'doc_type': 'draft_prototype', 'base_document_id': base['document_id'],
                      'base_version': int(base['version']), 'instruction': INSTRUCTION, **config}
        self.jobs.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': f'JOB#{JOB}', 'job_id': JOB,
                                 'project_id': PROJECT, 'job_type': 'draft_prototype', 'status': 'pending',
                                 'doc_config': doc_config})
        return doc_config

    def run(self, doc_config: dict) -> dict:
        from jobs.document_generator.handler import handle_job
        return handle_job({'project_id': PROJECT, 'job_id': JOB, 'doc_config': doc_config})

    def row(self) -> dict:
        return self.jobs.get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': f'JOB#{JOB}'})['Item']

    def draft_object(self) -> dict:
        return self.s3.get_object(Bucket=BUCKET, Key=prototype_draft_s3_key(PROJECT, JOB))

    def prompt(self) -> str:
        return self.converse.call_args.kwargs['prompt']


@pytest.fixture
def world() -> Iterator[World]:
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        projects = _table(dynamodb, 'test-projects-table')
        jobs = _table(dynamodb, 'test-jobs-table')
        projects.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT, 'name': 'Shop',
                                'document_count': 0})
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        converse = MagicMock(return_value=ConverseResult(text=ANSWER, model_id='model-that-answered'))
        with (
            patch('jobs.document_generator.handler.get_dynamodb_resource', return_value=dynamodb),
            # Read from the environment at import, which another module's tests may have set first.
            patch('jobs.document_generator.handler.PROJECTS_TABLE', 'test-projects-table'),
            patch('jobs.document_generator.handler.SCRATCH_BUCKET', BUCKET),
            patch('jobs.document_generator.handler.get_jobs_table', return_value=jobs),
            patch('jobs.document_generator.handler._s3', return_value=s3),
            patch('jobs.document_generator.handler._prototype_org_sections', return_value=('', '')),
            patch('shared.jobs.get_jobs_table', return_value=jobs),
            patch('shared.jobs.notify_project_job'),
            patch('shared.converse.converse_detailed', converse),
        ):
            yield World(projects, jobs, s3, converse)


class TestADraft:
    def test_the_result_is_only_the_draft_id_and_the_detail_is_on_the_job_row(self, world):
        base = world.base()

        answer = world.run(world.job(base))

        assert answer == {'success': True, 'draft_id': JOB}
        row = world.row()
        assert (row['status'], row['result']) == ('completed', {'draft_id': JOB})
        assert row['draft'] == {
            'summary': 'Checkout: the summary is a sticky footer\nHome: unchanged',
            'base_document_id': base['document_id'], 'base_version': 1, 'instruction': INSTRUCTION,
            'llm_metadata': {'model': 'model-that-answered', 'prompt_version': DRAFT_PROMPT_VERSION},
        }

    def test_the_html_is_written_at_the_jobs_draft_key_with_no_metadata_and_no_row(self, world):
        base = world.base()
        rows_before = world.projects.scan()['Items']

        world.run(world.job(base))

        obj = world.draft_object()
        assert obj['Body'].read().decode() == HTML
        assert obj['Metadata'] == {}
        assert obj['ContentType'].startswith('text/html')
        assert sorted(r['sk'] for r in world.projects.scan()['Items']) == sorted(r['sk'] for r in rows_before)

    def test_an_echoed_pin_widget_is_stripped_from_the_draft(self, world):
        base = world.base()
        echoed = inject_pin_widget(HTML, pin_form_id(base['document_id']))
        world.converse.return_value = ConverseResult(text=f'<change_summary>Home: x</change_summary>{echoed}',
                                                     model_id='m')

        world.run(world.job(base))

        body = world.draft_object()['Body'].read().decode()
        assert WIDGET_START not in body
        assert pin_form_id(base['document_id']) not in body

    def test_the_prompt_is_the_base_without_its_widget_and_the_instruction_summary_first(self, world):
        base = world.base()

        world.run(world.job(base))

        prompt = world.prompt()
        assert '<aside>Summary</aside>' in prompt
        assert WIDGET_START not in prompt
        assert INSTRUCTION in prompt
        assert prompt.index('<change_summary>') < prompt.index('EXISTING PROTOTYPE')
        kwargs = world.converse.call_args.kwargs
        assert (kwargs['surface'], kwargs['max_tokens']) == ('prototype', 32000)
        assert 'THIS REQUEST IS A DRAFT REVISION' in kwargs['system_prompt']

    def test_an_answer_without_html_fails_the_job_and_writes_nothing(self, world):
        base = world.base()
        world.converse.return_value = ConverseResult(text='<change_summary>Home: x</change_summary>Sorry.',
                                                     model_id='m')

        with pytest.raises(Exception, match='Document generation failed'):
            world.run(world.job(base))

        row = world.row()
        assert row['status'] == 'failed'
        assert 'Prototype model did not return an HTML document.' in row['error']
        assert 'draft' not in row
        assert world.s3.list_objects_v2(Bucket=BUCKET, Prefix=f'prototypes/{PROJECT}/drafts/').get('KeyCount') == 0

    def test_a_base_that_is_gone_ends_the_job_without_a_model_call(self, world):
        base = world.base()
        config = world.job(base)
        world.projects.delete_item(Key={'pk': base['pk'], 'sk': base['sk']})

        answer = world.run(config)

        assert answer['success'] is False
        world.converse.assert_not_called()

    def test_a_replay_that_finds_its_detail_and_object_makes_no_second_model_call(self, world):
        base = world.base()
        config = world.job(base)
        world.run(config)
        world.converse.reset_mock()
        world.jobs.update_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': f'JOB#{JOB}'},
                               UpdateExpression='SET #s = :p', ExpressionAttributeNames={'#s': 'status'},
                               ExpressionAttributeValues={':p': 'pending'})

        assert world.run(config) == {'success': True, 'draft_id': JOB}
        world.converse.assert_not_called()

    def test_a_retry_that_finds_the_detail_but_no_object_drafts_again_so_the_two_match(self, world):
        """An earlier attempt stored its detail and stopped before its object: drafted again, once, and the
        new detail replaces the old, so the summary describes the HTML that is stored."""
        base = world.base()
        config = world.job(base)
        world.jobs.update_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': f'JOB#{JOB}'},
                               UpdateExpression='SET #d = :d', ExpressionAttributeNames={'#d': 'draft'},
                               ExpressionAttributeValues={':d': {'summary': 'Old: an earlier attempt'}})

        assert world.run(config) == {'success': True, 'draft_id': JOB}

        assert world.converse.call_count == 1
        assert world.draft_object()['Body'].read().decode() == HTML
        assert world.row()['draft']['summary'] == 'Checkout: the summary is a sticky footer\nHome: unchanged'

    def test_a_job_discarded_while_it_ran_writes_no_object(self, world):
        base = world.base()
        config = world.job(base)

        def discard_then_answer(**_kwargs: Any) -> ConverseResult:
            world.jobs.delete_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': f'JOB#{JOB}'})
            return ConverseResult(text=ANSWER, model_id='m')

        world.converse.side_effect = discard_then_answer

        answer = world.run(config)

        assert answer['success'] is False
        assert world.s3.list_objects_v2(Bucket=BUCKET, Prefix=f'prototypes/{PROJECT}/drafts/').get('KeyCount') == 0


class TestTheChangeSummary:
    def test_tags_and_angle_brackets_are_dropped_and_blank_lines_go(self):
        summary, rest = parse_change_summary(
            'x<change_summary>\n <b>Home</b>: a <script>alert(1)</script>button\n\n Cart: 2 < 3 \n</change_summary>y')
        assert summary == 'Home: a alert(1)button\nCart: 2  3'
        assert rest == 'xy'

    def test_lines_and_the_total_are_capped(self):
        lines = '\n'.join(f'{n}: ' + 'x' * 400 for n in range(20))
        summary, _ = parse_change_summary(f'<change_summary>{lines}</change_summary>')
        kept = summary.split('\n')
        assert len(kept) <= MAX_SUMMARY_LINES
        assert all(len(line) <= MAX_SUMMARY_LINE_CHARS for line in kept)
        assert len(summary) <= MAX_SUMMARY_CHARS
        assert kept[0] == '0: ' + 'x' * (MAX_SUMMARY_LINE_CHARS - 3)

    def test_twelve_short_lines_are_kept_and_a_thirteenth_is_not(self):
        lines = '\n'.join(f'Screen {n}: changed' for n in range(13))
        summary, _ = parse_change_summary(f'<CHANGE_SUMMARY>{lines}</CHANGE_SUMMARY>')
        assert summary.split('\n') == [f'Screen {n}: changed' for n in range(12)]

    def test_no_block_is_an_empty_summary_and_the_whole_answer(self):
        assert parse_change_summary(HTML) == ('', HTML)


def test_the_draft_prompt_version_is_pinned_to_its_digest():
    from jobs.document_generator import handler

    digest = hashlib.sha256(
        (handler.PROTOTYPE_DRAFT_OUTPUT_RULES + handler.PROTOTYPE_DRAFT_USER_TEMPLATE).encode()).hexdigest()
    assert DRAFT_PROMPT_VERSION in PINNED_PROMPTS, f'pin {DRAFT_PROMPT_VERSION} with digest {digest}'
    assert PINNED_PROMPTS[DRAFT_PROMPT_VERSION] == digest, (
        f'The draft prompt changed under DRAFT_PROMPT_VERSION {DRAFT_PROMPT_VERSION}: bump it and pin {digest}')
