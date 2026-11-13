"""Back to vN for a prototype (docs/prototype-builder.md, part 2): a NEW version from vN's HTML.

Against moto (real conditional puts and transactions), through ``projects.restore_document``,
the function the restore route calls:

* the restore is the next version of the series, ``edit_kind: restore`` with
  ``restored_from_id`` / ``restored_from_version``, ``edited_from_id`` the newest version and
  ``edited_by`` the caller; every earlier version and object is left as it was;
* the new version's HTML is vN's with the pin widget re-injected for the NEW document's own
  pin form, which exists; never the form of the version it came from;
* ``pin-submit-url`` metadata only for the new form and the configured API base;
* it is never reported unchanged (a prototype row's ``content`` is empty on both sides);
* a retry with the same ``edit_id`` is the same version, and a retry after an earlier attempt
  wrote the object but not the row finishes that version with the object already there.
"""
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table

from shared.document_versions import persist_versioned_document, versioned_document_id
from shared.exceptions import NotFoundError
from shared.prototype_pins import (
    PIN_SUBMIT_URL_METADATA_KEY,
    WIDGET_START,
    inject_pin_widget,
    pin_form_id,
    strip_pin_widget,
)
from shared.prototypes import prototype_s3_key

PROJECT = 'proj-1'
BUCKET = 'raw-data'
API_BASE = 'https://abcdefghij.execute-api.us-east-1.amazonaws.com/v1'
ACTOR = {'sub': 'user-1', 'kind': 'user'}


class World:
    def __init__(self, table: Any, pins: Any, s3: Any) -> None:
        self.table, self.pins, self.s3 = table, pins, s3

    def prototype(self, job_id: str, body: str, **fields: Any) -> dict:
        """One built version: its row and its object, the widget naming its own form."""
        doc_id = versioned_document_id(PROJECT, 'prototype', job_id)
        html = inject_pin_widget(f'<!DOCTYPE html><html><body>{body}</body></html>', pin_form_id(doc_id))
        self.s3.put_object(Bucket=BUCKET, Key=prototype_s3_key(PROJECT, doc_id), Body=html.encode())
        return persist_versioned_document(self.table, PROJECT, 'prototype', 'Checkout', job_id, {
            'content': '', 'prototype_format': 'html', 'created_at': f'2026-05-0{len(job_id)}T00:00:00+00:00',
            'job_id': job_id, 'source_prd_id': 'prd_1', 'revision_feedback': 'make it blue', **fields,
        })

    def html(self, doc_id: str) -> str:
        return self.s3.get_object(Bucket=BUCKET, Key=prototype_s3_key(PROJECT, doc_id))['Body'].read().decode()

    def metadata(self, doc_id: str) -> dict:
        return self.s3.head_object(Bucket=BUCKET, Key=prototype_s3_key(PROJECT, doc_id))['Metadata']

    def restore(self, document_id: str, version_id: str, body: dict | None = None) -> dict:
        from projects import restore_document

        return restore_document(PROJECT, document_id, version_id, body or {}, actor=ACTOR)

    def back_to_v1(self) -> str:
        """Builds v1 and v2, then restores v1 from v2: the restored version's id."""
        v1 = self.prototype('job_1', '<h1>One</h1>')
        v2 = self.prototype('job_22', '<h1>Two</h1>')
        return str(self.restore(v2['document_id'], v1['document_id'])['document']['document_id'])


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> Iterator[World]:
    monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)
    monkeypatch.setenv('PIN_SUBMIT_API_BASE', API_BASE)
    with mock_aws():
        table = pk_sk_table('restore-projects')
        table.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT, 'document_count': 0})
        pins = pk_sk_table('restore-aggregates')
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        with patch('projects.projects_table', table), patch('projects.get_s3_client', return_value=s3), \
                patch('projects.get_aggregates_table', return_value=pins):
            yield World(table, pins, s3)


class TestBackToAVersion:
    def test_it_is_the_next_version_recorded_as_a_restore_by_its_caller(self, world):
        v1 = world.prototype('job_1', '<h1>One</h1>')
        v2 = world.prototype('job_22', '<h1>Two</h1>', revised_from_id=v1['document_id'])

        restored = world.restore(v2['document_id'], v1['document_id'], {'edit_id': 'back-1'})['document']

        assert (restored['version'], restored['title']) == (3, 'Checkout (v3)')
        assert restored['edit_kind'] == 'restore'
        assert restored['restored_from_id'] == v1['document_id']
        assert restored['restored_from_version'] == 1
        assert restored['edited_from_id'] == v2['document_id']
        assert restored['edited_by'] == ACTOR
        # The sources carry; what described the version it came from does not.
        assert restored['source_prd_id'] == 'prd_1'
        assert {'job_id', 'revision_feedback', 'revised_from_id'}.isdisjoint(restored)
        assert restored['prototype_etag']

    def test_the_html_is_the_old_versions_with_the_widget_of_its_own_new_form(self, world):
        v1 = world.prototype('job_1', '<h1>One</h1>')
        v2 = world.prototype('job_22', '<h1>Two</h1>')

        restored = world.restore(v2['document_id'], v1['document_id'])['document']

        new_id = restored['document_id']
        html = world.html(new_id)
        assert '<h1>One</h1>' in html
        assert '<h1>Two</h1>' not in html
        assert html.count(WIDGET_START) == 1
        assert f"formId: '{pin_form_id(new_id)}'" in html
        assert pin_form_id(v1['document_id']) not in html
        assert strip_pin_widget(html) == strip_pin_widget(world.html(v1['document_id']))
        form = world.pins.get_item(Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{pin_form_id(new_id)}'})['Item']
        assert (form['document_id'], form['project_id'], form['form_type']) == (new_id, PROJECT, 'prototype_pin')

    def test_the_object_names_only_its_own_forms_submit_url(self, world):
        new_id = world.back_to_v1()

        expected = f'{API_BASE}/feedback-forms/{pin_form_id(new_id)}/submit'
        assert world.metadata(new_id) == {PIN_SUBMIT_URL_METADATA_KEY: expected}

    def test_without_an_api_base_the_object_carries_no_submit_url(self, world, monkeypatch):
        monkeypatch.delenv('PIN_SUBMIT_API_BASE')

        assert world.metadata(world.back_to_v1()) == {}

    def test_earlier_versions_and_their_objects_are_left_as_they_were(self, world):
        v1 = world.prototype('job_1', '<h1>One</h1>')
        v2 = world.prototype('job_22', '<h1>Two</h1>')
        before = {doc['document_id']: world.html(doc['document_id']) for doc in (v1, v2)}

        world.restore(v2['document_id'], v1['document_id'])

        assert {doc_id: world.html(doc_id) for doc_id in before} == before
        assert world.table.get_item(Key={'pk': v2['pk'], 'sk': v2['sk']})['Item']['version'] == 2

    def test_the_answer_carries_the_new_versions_signed_url_for_the_pane(self, world):
        v1 = world.prototype('job_1', '<h1>One</h1>')
        v2 = world.prototype('job_22', '<h1>Two</h1>')
        signed: list[tuple[str, str]] = []

        def sign(project_id: str, doc_id: str) -> str:
            signed.append((project_id, doc_id))
            return f'https://cdn.example/prototypes/{project_id}/{doc_id}.html?Signature=s'

        with patch('projects.prototype_signed_url', side_effect=sign):
            restored = world.restore(v2['document_id'], v1['document_id'])['document']

        new_id = restored['document_id']
        assert signed == [(PROJECT, new_id)]
        assert restored['prototype_url'] == f'https://cdn.example/prototypes/{PROJECT}/{new_id}.html?Signature=s'

    def test_restoring_the_newest_version_is_never_reported_unchanged(self, world):
        world.prototype('job_1', '<h1>One</h1>')
        v2 = world.prototype('job_22', '<h1>Two</h1>')

        answer = world.restore(v2['document_id'], v2['document_id'])

        assert 'unchanged' not in answer
        assert answer['document']['version'] == 3


class TestARetryIsTheSameVersion:
    def test_the_same_edit_id_replays_the_version_it_made(self, world):
        v1 = world.prototype('job_1', '<h1>One</h1>')
        v2 = world.prototype('job_22', '<h1>Two</h1>')

        first = world.restore(v2['document_id'], v1['document_id'], {'edit_id': 'back-1'})['document']
        again = world.restore(v2['document_id'], v1['document_id'], {'edit_id': 'back-1'})['document']
        other = world.restore(v2['document_id'], v1['document_id'], {'edit_id': 'back-2'})['document']

        assert again['document_id'] == first['document_id']
        assert (first['version'], other['version']) == (3, 4)

    def test_an_object_left_by_an_attempt_whose_row_failed_is_finished(self, world):
        v1 = world.prototype('job_1', '<h1>One</h1>')
        v2 = world.prototype('job_22', '<h1>Two</h1>')
        allocation = f"restore:{v1['document_id']}:back-1"
        new_id = versioned_document_id(PROJECT, 'prototype', allocation)
        earlier = world.s3.put_object(Bucket=BUCKET, Key=prototype_s3_key(PROJECT, new_id), Body=b'<html></html>')

        restored = world.restore(v2['document_id'], v1['document_id'], {'edit_id': 'back-1'})['document']

        assert restored['document_id'] == new_id
        assert restored['prototype_etag'] == earlier['ETag']


class TestTheOldestPrototypes:
    def _inline(self, world: World, job_id: str, content: str, **fields: Any) -> dict:
        """A version from before S3 storage: its HTML (or JSON spec) inline in ``content``, no object."""
        return persist_versioned_document(world.table, PROJECT, 'prototype', 'Checkout', job_id, {
            'content': content, 'created_at': '2026-01-01T00:00:00+00:00', **fields,
        })

    def test_inline_html_is_restored_to_its_own_object_with_its_own_widget(self, world):
        old = self._inline(world, 'job_1', '<!DOCTYPE html><html><body><h1>Inline</h1></body></html>',
                           prototype_format='html')
        v2 = world.prototype('job_22', '<h1>Two</h1>')

        restored = world.restore(v2['document_id'], old['document_id'])['document']

        html = world.html(restored['document_id'])
        assert '<h1>Inline</h1>' in html
        assert f"formId: '{pin_form_id(restored['document_id'])}'" in html
        assert (restored['content'], restored['prototype_format']) == ('', 'html')

    def test_unmarked_inline_html_is_restored_and_answered_with_its_signed_url(self, world):
        old = self._inline(world, 'job_1', '  <!DOCTYPE html><html><body><h1>Unmarked</h1></body></html>')
        v2 = world.prototype('job_22', '<h1>Two</h1>')

        with patch('projects.prototype_signed_url', return_value='https://cdn.example/signed'):
            restored = world.restore(v2['document_id'], old['document_id'])['document']

        assert '<h1>Unmarked</h1>' in world.html(restored['document_id'])
        # Now S3-backed (content ''), so the answer is signed rather than left to the inline path.
        assert restored['prototype_url'] == 'https://cdn.example/signed'

    @pytest.mark.parametrize('lead', ['\N{ZERO WIDTH NO-BREAK SPACE}', ' \N{ZERO WIDTH NO-BREAK SPACE}\n ',
                                      '\N{ZERO WIDTH NO-BREAK SPACE}' + ' ' * 300])
    def test_unmarked_inline_html_after_a_byte_order_mark_is_restored(self, world, lead):
        """The SPA's ``trimStart`` drops a BOM before it looks for ``<!doctype html``, so this does too."""
        old = self._inline(world, 'job_1', f'{lead}<!DOCTYPE html><html><body><h1>Bom</h1></body></html>')
        v2 = world.prototype('job_22', '<h1>Two</h1>')

        restored = world.restore(v2['document_id'], old['document_id'])['document']

        assert '<h1>Bom</h1>' in world.html(restored['document_id'])

    def test_a_bom_before_a_json_spec_is_still_refused(self, world):
        from shared.exceptions import ValidationError

        spec = self._inline(world, 'job_1', '\N{ZERO WIDTH NO-BREAK SPACE}{"title": "Checkout", "screens": []}')
        v2 = world.prototype('job_22', '<h1>Two</h1>')

        with pytest.raises(ValidationError, match='early screen spec'):
            world.restore(v2['document_id'], spec['document_id'])

    def test_a_json_screen_spec_is_refused_and_nothing_is_written(self, world):
        from shared.exceptions import ValidationError

        spec = self._inline(world, 'job_1', '{"title": "Checkout", "screens": []}')
        v2 = world.prototype('job_22', '<h1>Two</h1>')

        with pytest.raises(ValidationError, match='early screen spec'):
            world.restore(v2['document_id'], spec['document_id'])
        assert world.pins.scan()['Items'] == []

    def test_a_version_whose_object_is_gone_is_not_found_and_nothing_is_written(self, world):
        v1 = world.prototype('job_1', '<h1>One</h1>')
        v2 = world.prototype('job_22', '<h1>Two</h1>')
        world.s3.delete_object(Bucket=BUCKET, Key=prototype_s3_key(PROJECT, v1['document_id']))

        with pytest.raises(NotFoundError, match='no longer stored'):
            world.restore(v2['document_id'], v1['document_id'])
        assert world.pins.scan()['Items'] == []


class TestRefusals:
    def test_a_version_of_another_series_is_not_found(self, world):
        v1 = world.prototype('job_1', '<h1>One</h1>')

        with pytest.raises(NotFoundError, match='Version not found'):
            world.restore(v1['document_id'], 'prototype_not_in_this_series')

    def test_without_a_bucket_nothing_is_written(self, world, monkeypatch):
        from shared.exceptions import ConfigurationError

        monkeypatch.setenv('RAW_DATA_BUCKET', '')
        v1 = world.prototype('job_1', '<h1>One</h1>')

        with pytest.raises(ConfigurationError, match='Prototype storage not configured'):
            world.restore(v1['document_id'], v1['document_id'])
        assert world.pins.scan()['Items'] == []
