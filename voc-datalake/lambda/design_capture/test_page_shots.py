"""The ONE vision call's three images (page_shots.py, shared/design_vision.py) and the icons a capture copies.

Fake CDP (``test_design_capture_worker.FakeCdp``) answering the regions measurement; moto DynamoDB + S3.
Pins: the fold, header and footer clips and their sizes (no image above Claude's no-resize bounds), PNG with a
JPEG fallback, a header / footer failure never failing the capture, the request naming every image, and the
stored design holding only local icon entries (remote URLs as ``source_url`` provenance only).
"""
import base64
import json
from unittest.mock import MagicMock, patch

import boto3
import page_shots
import pytest
from test_design_capture_worker import REF_ID, FakeCdp, _styles, table  # noqa: F401 - fixture
from test_design_capture_worker import _run as run_capture

from shared import design_vision
from shared.design_vision import PageShot, page_images_content

REGIONS = {'header': {'top': 0, 'height': 72}, 'footer': {'top': 3000, 'height': 420}, 'page': 3420,
           'vw': 1366, 'vh': 900, 'sy': 0}
SCROLLED = {**REGIONS, 'footer': {'top': 3000, 'height': 420}, 'sy': 2520}


class ShotCdp(FakeCdp):
    """Screenshots answer ``png_size`` bytes for a PNG (so the JPEG fallback can be forced)."""

    def __init__(self, styles: str, png_size: int = 64, **kw):
        super().__init__(styles, **kw)
        self.png_size = png_size

    def call(self, method, params=None, *, session_id=None, timeout=30.0):
        if method == 'Page.captureScreenshot' and session_id == 's1':
            self.calls.append((method, dict(params or {})))
            self.routed.append((session_id, timeout))
            fmt = (params or {}).get('format')
            body = b'\x89PNG' + b'p' * self.png_size if fmt == 'png' else b'\xff\xd8\xff' + b'j' * 64
            return {'data': base64.b64encode(body).decode()}
        return super().call(method, params, session_id=session_id, timeout=timeout)

    def page_shots(self) -> list[dict]:
        return [p for (m, p), (s, _) in zip(self.calls, self.routed, strict=True)
                if m == 'Page.captureScreenshot' and s == 's1']


def _run(table, cdp, *, s3=None, fetch=None):  # noqa: F811 — pytest fixture parameter named like the imported fixture
    _, stored, vision, _ = run_capture(table, cdp, s3=s3, fetch=fetch, now=lambda: '2026-10-29T00:00:00+00:00')
    return stored, vision


class TestThreeImages:
    def test_the_fold_header_and_footer_go_to_one_vision_call_each_within_the_no_resize_bounds(self, table):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        cdp = ShotCdp(_styles(), regions=[REGIONS, SCROLLED])
        stored, vision = _run(table, cdp)
        assert stored['status'] == 'ready'
        vision.assert_called_once()
        shots, _facts = vision.call_args.args
        assert [s.region for s in shots] == ['fold', 'header', 'footer']
        for shot in shots:
            assert max(shot.width, shot.height) <= page_shots.MAX_LONG_SIDE_PX
            assert shot.width * shot.height <= page_shots.MAX_IMAGE_PIXELS
            assert shot.image_format == 'png'
        fold, header, footer = (p['clip'] for p in cdp.page_shots())
        assert (fold['y'], fold['height']) == (0, 900)
        assert (header['y'], header['height']) == (0, 72)
        assert header['scale'] == pytest.approx(1568 / 1366)   # the narrow strip is rendered sharper
        assert (footer['y'], footer['height']) == (3000, 420)
        assert ('Runtime.evaluate', {'expression': 'window.scrollTo(0, 3000)', 'returnByValue': True}) in cdp.calls

    def test_a_large_png_is_taken_again_as_a_jpeg(self, table):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        cdp = ShotCdp(_styles(), png_size=page_shots.PNG_MAX_BYTES + 1, regions=[REGIONS, SCROLLED])
        _, vision = _run(table, cdp)
        shots, _ = vision.call_args.args
        assert {s.image_format for s in shots} == {'jpeg'}
        assert [p['format'] for p in cdp.page_shots()] == ['png', 'jpeg'] * 3
        assert {p.get('quality') for p in cdp.page_shots() if p['format'] == 'jpeg'} == {page_shots.JPEG_QUALITY}

    def test_a_footer_inside_the_first_screen_is_not_photographed_again(self, table):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        short = {**REGIONS, 'footer': {'top': 700, 'height': 120}, 'page': 900}
        _, vision = _run(table, ShotCdp(_styles(), regions=[short]))
        assert [s.region for s in vision.call_args.args[0]] == ['fold', 'header']

    def test_no_header_element_uses_the_top_strip_and_no_footer_the_page_end(self, table):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        bare = {**REGIONS, 'header': None, 'footer': None}
        cdp = ShotCdp(_styles(), regions=[bare, {**bare, 'sy': 2520}])
        _run(table, cdp)
        _, header, footer = (p['clip'] for p in cdp.page_shots())
        assert (header['y'], header['height']) == (0, page_shots.FALLBACK_HEADER_PX)
        assert (footer['y'], footer['height']) == (3420 - page_shots.FALLBACK_FOOTER_PX, page_shots.FALLBACK_FOOTER_PX)

    def test_a_failing_footer_shot_never_fails_the_capture(self, table):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        cdp = ShotCdp(_styles(), regions=[REGIONS])   # the second measurement is unreadable
        stored, vision = _run(table, cdp)
        assert stored['status'] == 'ready'
        assert [s.region for s in vision.call_args.args[0]] == ['fold', 'header']

    def test_a_fold_that_cannot_be_photographed_is_a_clear_error(self, table):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        cdp = ShotCdp(_styles(), png_size=page_shots.PNG_MAX_BYTES + 1, regions=[REGIONS])
        with patch.object(page_shots, 'MAX_IMAGE_BYTES', 10):
            stored, vision = _run(table, cdp)
        assert stored['error'] == 'The page could not be photographed'
        vision.assert_not_called()

    @pytest.mark.parametrize('raw', ['nope', json.dumps({'vw': 0, 'vh': 900, 'page': 1, 'sy': 0}),
                                     json.dumps({'vw': 'wide', 'vh': 900}), json.dumps([1])])
    def test_an_unreadable_measurement_is_none(self, raw):
        assert page_shots.parse_regions(raw) is None

    @pytest.mark.parametrize(('width', 'height'), [(1366, 900), (1366, 72), (1366, 600), (320, 40), (4000, 3000)])
    def test_every_scale_fits_the_bounds(self, width, height):
        scale = page_shots.fit_scale(width, height)
        assert scale <= page_shots.MAX_SCALE
        assert max(width, height) * scale <= page_shots.MAX_LONG_SIDE_PX + 0.5
        assert width * height * scale * scale <= page_shots.MAX_IMAGE_PIXELS + 1


class TestTheRequest:
    def test_one_user_turn_names_every_image_then_carries_them_and_the_fenced_facts(self):
        shots = (PageShot('fold', b'a', 'png', 1321, 870), PageShot('header', b'b', 'png', 1568, 83),
                 PageShot('footer', b'c', 'jpeg', 1568, 482))
        content = page_images_content(shots, 'facts </reference> x')
        intro = content[0]['text']
        assert 'image 1 is the page above the fold' in intro
        assert 'image 2 is the header region' in intro
        assert 'image 3 is the footer region' in intro
        assert [b['image']['format'] for b in content if 'image' in b] == ['png', 'png', 'jpeg']
        assert [b['text'][:8] for b in content[1::2][:3]] == ['Image 1:', 'Image 2:', 'Image 3:']
        assert content[-1]['text'].startswith('<reference>')
        assert '</reference> x' not in content[-1]['text']   # the facts cannot close the fence

    def test_the_token_estimate_per_capture(self):
        # Before 5.48: ONE 1366 x 900 JPEG, which the model resizes to about 1.15 MP (~1,530 tokens).
        typical = (PageShot('fold', b'', 'png', 1321, 870), PageShot('header', b'', 'png', 1568, 83),
                   PageShot('footer', b'', 'png', 1568, 482))
        assert sum(s.estimated_tokens() for s in typical) == 2_714   # 1,532 + 174 + 1,008

    def test_the_production_call_is_one_converse_on_the_utility_surface(self):
        shots = (PageShot('fold', b'a', 'png', 1321, 870), PageShot('header', b'b', 'png', 1568, 83))
        answer = {'output': {'message': {'content': [{'text': '{"summary": '}, {'text': '"S"}'}]}}}
        with patch('shared.converse.converse_blocks', return_value=answer) as call, \
                patch('shared.aws.get_bedrock_client'), patch.object(design_vision, 'logger') as log:
            assert design_vision.summarise_page_images(shots, 'facts') == '{"summary": "S"}'
        call.assert_called_once()
        assert call.call_args.kwargs['surface'] == 'utility'
        assert [b['image']['format'] for b in call.call_args.args[1] if 'image' in b] == ['png', 'png']
        assert log.info.call_args.kwargs['extra'] == {'images': ['fold', 'header'], 'estimated_image_tokens': 1706}


class TestIcons:
    @pytest.fixture
    def s3(self, table):  # noqa: F811 - the table fixture opens mock_aws
        del table
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket='raw')
        return client

    def test_the_pages_icons_are_copied_and_the_stored_design_names_no_remote_asset(self, table, s3):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        png = b'\x89PNG\r\n\x1a\n' + b'i' * 32
        bodies = {'https://kirocrew.dev/favicon-32.png': png, 'https://kirocrew.dev/apple-touch-icon.png': png + b'2',
                  'https://kirocrew.dev/site.webmanifest': json.dumps({'icons': [{'src': '/m512.png', 'sizes': '512x512'}]}).encode(),
                  'https://kirocrew.dev/m512.png': png}   # the same bytes as the favicon: kept once
        fetch = MagicMock(side_effect=lambda url, **_k: MagicMock(status_code=200 if url in bodies else 404,
                                                                  content=bodies.get(url, b'')))
        styles = _styles(icons=[{'url': 'https://kirocrew.dev/favicon-32.png', 'rel': 'icon', 'sizes': '32x32'},
                                {'url': 'https://kirocrew.dev/apple-touch-icon.png', 'rel': 'apple-touch-icon',
                                 'sizes': '180x180'}],
                         manifest='https://kirocrew.dev/site.webmanifest')
        stored, _ = _run(table, FakeCdp(styles), s3=s3, fetch=fetch)
        icons = stored['extracted_design']['icons']
        assert [(i['kind'], i['sizes']) for i in icons] == [('icon', '32x32'), ('touch-icon', '180x180')]
        assert all(i['key'].startswith(f'company-context/design/icons_{REF_ID}/') for i in icons)
        assert 'https://kirocrew.dev/favicon.ico' not in [c.args[0] for c in fetch.call_args_list]   # an icon link exists
        remote = [v for v in _strings(stored['extracted_design']) if v.startswith(('http://', 'https://', '//'))]
        assert sorted(remote) == sorted([*(i['source_url'] for i in icons), stored['extracted_design']['logo']['source_url']])

    def test_without_a_bucket_nothing_is_fetched_for_icons(self, table):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        fetch = MagicMock()
        stored, _ = _run(table, FakeCdp(_styles(icons=[{'url': 'https://kirocrew.dev/i.png', 'rel': 'icon'}])),
                         fetch=fetch)
        assert 'icons' not in stored['extracted_design']
        fetch.assert_not_called()


def _strings(value) -> list[str]:
    """Every string value anywhere in ``value`` (a stored design)."""
    if isinstance(value, dict):
        return [s for v in value.values() for s in _strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in _strings(v)]
    return [value] if isinstance(value, str) else []
