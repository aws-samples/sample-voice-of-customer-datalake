"""A GitHub repository's SVG logo goes to the browser; an archived reference's logo preview is deleted (5.47.00).

Pins: with a browser available the SVG is read through the GitHub contents API (token headers, a private repo
works), sanitised, and handed off AFTER the ready outcome is written, with that outcome's ``fetched_at``; the
"upload a PNG" note is then left out of the guidelines. Without a browser, a refused SVG, or a hand-off that
cannot start, the note stays exactly as before. ``delete_previews`` deletes every preview key in one idempotent
call and reports a partial failure.
"""
from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import design_logo, design_logo_render
from shared import design_references as dr
from shared.company_context import MAX_GUIDELINES_CHARS
from shared.test.test_design_references_mutation import CONTENTS, TREE_HEAD, _Body, _tree, _world

REF_ID = 'ref_0123456789ab'
CSS_PATH = 'src/styles/tokens.css'
SVG_PATH = 'brand/logo.svg'
SVG = (b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 16"><script>alert(1)</script>'
       b'<rect width="64" height="16" fill="#7c3aed"/></svg>')
ITEM = {'id': REF_ID, 'kind': 'github', 'url': 'https://github.com/acme/ui'}
NOTE = 'logo is an SVG (`brand/logo.svg`)'


def _routes(svg: bytes | None = SVG) -> dict:
    routes = {TREE_HEAD: _tree(CSS_PATH, SVG_PATH), f'{CONTENTS}{CSS_PATH}': _Body(b':root{--color-accent:#7c3aed}')}
    if svg is not None:
        routes[f'{CONTENTS}{SVG_PATH}'] = _Body(svg)
    return routes


def _process(world, start):
    world.deps.start_logo_render = start
    world.deps.bucket = ''
    table = MagicMock()
    outcome = dr.process_reference(table, ITEM, world.deps)
    return outcome, table


class TestTheHandOff:
    def test_the_svg_is_read_sanitised_and_handed_off_after_the_outcome_is_written(self):
        world = _world(_routes(), secrets={'github_token': 'gh'}, summary='{"summary": "Purple"}')
        order: list[str] = []
        start = MagicMock(side_effect=lambda _event: order.append('start') or True)
        world.deps.start_logo_render = start
        world.deps.bucket = ''
        table = MagicMock()
        table.update_item.side_effect = lambda **_kw: order.append('write')
        outcome = dr.process_reference(table, ITEM, world.deps)

        assert order == ['write', 'start']
        event = start.call_args.args[0]
        assert event['action'] == design_logo_render.DESIGN_LOGO_RENDER_ACTION
        assert (event['ref_id'], event['path'], event['fetched_at']) == (REF_ID, SVG_PATH, outcome['fetched_at'])
        assert event['source_url'] == f'https://raw.githubusercontent.com/acme/ui/HEAD/{SVG_PATH}'
        assert 'script' not in event['svg']
        assert 'fill="#7c3aed"' in event['svg']
        assert NOTE not in outcome['extracted_design']['guidelines_md']
        assert outcome['extracted_design']['logo'] is None
        svg_call = next(c for c in world.http.call_args_list if c.args[0] == f'{CONTENTS}{SVG_PATH}')
        assert svg_call.kwargs['headers']['Authorization'] == 'Bearer gh'

    def test_the_event_parses_back_on_the_capture_side(self):
        world = _world(_routes(), summary='{"summary": "Purple"}')
        start = MagicMock(return_value=True)
        _process(world, start)
        request = design_logo_render.parse_render_event(start.call_args.args[0])
        assert request is not None
        assert request.logo.path == SVG_PATH

    def test_without_a_browser_the_svg_is_never_read_and_the_note_stays(self):
        world = _world(_routes(), summary='{"summary": "Purple"}')
        outcome, table = _process(world, None)
        assert f'{CONTENTS}{SVG_PATH}' not in world.urls()
        assert NOTE in outcome['extracted_design']['guidelines_md']
        assert table.update_item.call_count == 1

    @pytest.mark.parametrize('svg', [
        pytest.param(b'<!DOCTYPE svg [<!ENTITY a "x">]><svg/>', id='refused'),
        pytest.param(None, id='unreadable'),
    ])
    def test_a_refused_or_unreadable_svg_keeps_the_note_and_starts_nothing(self, svg):
        world = _world(_routes(svg), summary='{"summary": "Purple"}')
        start = MagicMock(return_value=True)
        outcome, _ = _process(world, start)
        start.assert_not_called()
        assert outcome['status'] == 'ready'
        assert NOTE in outcome['extracted_design']['guidelines_md']

    def test_a_hand_off_that_cannot_start_records_the_note_on_a_second_write(self):
        world = _world(_routes(), summary='{"summary": "Purple"}')
        outcome, table = _process(world, MagicMock(return_value=False))
        assert NOTE in outcome['extracted_design']['guidelines_md']
        assert table.update_item.call_count == 2
        written = table.update_item.call_args.kwargs['ExpressionAttributeValues'][':extracted_design']
        assert NOTE in written['guidelines_md']

    def test_a_failed_read_starts_nothing(self):
        world = _world({TREE_HEAD: _Body(status=500)})
        start = MagicMock(return_value=True)
        outcome, _ = _process(world, start)
        assert outcome['status'] == 'error'
        start.assert_not_called()


class TestTheNote:
    def test_the_note_is_appended_within_the_guidelines_limit(self):
        note = design_logo_render.render_failed_note(SVG_PATH)
        text = design_logo_render.with_note('x' * 30_000, note)
        assert len(text) <= MAX_GUIDELINES_CHARS
        assert text.endswith(note)

    def test_an_empty_guideline_is_just_the_note(self):
        note = design_logo_render.render_failed_note(SVG_PATH)
        assert design_logo_render.with_note(None, note) == note
        assert f'`{SVG_PATH}`' in note


class TestDeletePreviews:
    @pytest.fixture
    def s3(self):
        with mock_aws():
            client = boto3.client('s3', region_name='us-east-1')
            client.create_bucket(Bucket='raw')
            yield client

    def test_every_preview_key_of_the_reference_is_deleted_and_nothing_else(self, s3):
        keep = ['company-context/design/logo_preview_ref_aaaaaaaaaaaa.png', f'company-context/design/{REF_ID}.png',
                'company-context/design/logo_abcdefabcdef.png']
        for key in [*design_logo.preview_keys(REF_ID)[:2], *keep]:
            s3.put_object(Bucket='raw', Key=key, Body=b'x')
        assert design_logo.delete_previews(s3, 'raw', REF_ID) == 4
        assert sorted(o['Key'] for o in s3.list_objects_v2(Bucket='raw')['Contents']) == sorted(keep)

    def test_deleting_again_is_not_an_error(self, s3):
        assert design_logo.delete_previews(s3, 'raw', REF_ID) == 4
        assert design_logo.delete_previews(s3, 'raw', REF_ID) == 4

    @pytest.mark.parametrize(('bucket', 'ref_id'), [('', REF_ID), ('raw', '../x'), ('raw', 'ref_1')])
    def test_no_bucket_or_a_malformed_id_deletes_nothing(self, bucket, ref_id):
        s3 = MagicMock()
        assert design_logo.delete_previews(s3, bucket, ref_id) == 0
        s3.delete_objects.assert_not_called()

    @pytest.mark.parametrize('answer', [
        ClientError({'Error': {'Code': 'AccessDenied'}}, 'DeleteObjects'),
        {'Errors': [{'Key': 'k', 'Code': 'AccessDenied'}]},
    ])
    def test_a_failed_or_partial_delete_raises(self, answer):
        s3 = MagicMock()
        if isinstance(answer, Exception):
            s3.delete_objects.side_effect = answer
        else:
            s3.delete_objects.return_value = answer
        with pytest.raises(design_logo.LogoPreviewDeleteError):
            design_logo.delete_previews(s3, 'raw', REF_ID)
