"""Local design assets: the download-only SVG object, the signed URLs GET returns, the SVG's own sheet, and no
remote image left in the stored guidelines (shared/design_assets.py, design_svg_style.py, extracted_design.py)."""
from unittest.mock import MagicMock

import boto3
import pytest
from moto import mock_aws

from shared import design_assets, design_svg
from shared.extracted_design import ICONS_PREFIX, LOGO_PREVIEW_PREFIX, clean_extracted_design, without_remote_images

REF = 'ref_0123456789ab'
PREVIEW, SVG_KEY = f'{LOGO_PREVIEW_PREFIX}{REF}.png', f'{LOGO_PREVIEW_PREFIX}{REF}.svg'
ICON, ICON_SVG = f'{ICONS_PREFIX}{REF}/a1.png', f'{ICONS_PREFIX}{REF}/a1.svg'


def _sign(key: str, as_svg: bool) -> str:
    return f'signed:{key}:{"svg" if as_svg else "raster"}'


def _view(design: dict, sign=_sign) -> dict:
    view = design_assets.with_asset_urls({'id': REF, 'extracted_design': design}, sign,
                                         preview_prefix=LOGO_PREVIEW_PREFIX, icons_prefix=ICONS_PREFIX)
    return view['extracted_design']


class TestPutSvg:
    def test_the_svg_is_stored_as_a_download_never_as_a_document(self):
        with mock_aws():
            s3 = boto3.client('s3', region_name='us-east-1')
            s3.create_bucket(Bucket='raw')
            assert design_assets.put_svg(s3, 'raw', SVG_KEY, '<svg/>') is True
            head = s3.head_object(Bucket='raw', Key=SVG_KEY)
        assert head['ContentType'] == 'image/svg+xml'
        assert head['ContentDisposition'] == 'attachment; filename="logo.svg"'

    @pytest.mark.parametrize(('bucket', 'key', 'svg'), [
        ('', SVG_KEY, '<svg/>'), ('raw', 'avatars/x.svg', '<svg/>'), ('raw', PREVIEW, '<svg/>'), ('raw', SVG_KEY, '')])
    def test_nothing_outside_the_design_prefix_or_without_markup_is_stored(self, bucket, key, svg):
        s3 = MagicMock()
        assert design_assets.put_svg(s3, bucket, key, svg) is False
        s3.put_object.assert_not_called()

    def test_the_signed_url_of_an_svg_pins_the_attachment_headers(self):
        assert design_assets.signed_params('raw', SVG_KEY, True) == {
            'Bucket': 'raw', 'Key': SVG_KEY, 'ResponseContentType': 'image/svg+xml',
            'ResponseContentDisposition': 'attachment; filename="logo.svg"'}
        assert design_assets.signed_params('raw', PREVIEW, False) == {'Bucket': 'raw', 'Key': PREVIEW}


class TestAssetUrls:
    def test_every_key_becomes_a_signed_url_and_no_key_leaves_the_api(self):
        shown = _view({'logo': {'source_url': 'https://a.example/l.svg', 'preview_key': PREVIEW, 'svg_preview_key': SVG_KEY},
                       'icons': [{'kind': 'icon', 'key': ICON, 'svg_key': ICON_SVG, 'source_url': 'https://a.example/i.svg'}]})
        assert shown['logo'] == {'source_url': 'https://a.example/l.svg', 'preview_url': f'signed:{PREVIEW}:raster',
                                 'svg_preview_url': f'signed:{SVG_KEY}:svg'}
        assert shown['icons'] == [{'kind': 'icon', 'source_url': 'https://a.example/i.svg',
                                   'url': f'signed:{ICON}:raster', 'svg_url': f'signed:{ICON_SVG}:svg'}]

    def test_a_key_outside_its_prefix_is_never_signed(self):
        shown = _view({'logo': {'source_url': 'https://a.example/l.png', 'preview_key': 'raw/x.png',
                                'svg_preview_key': f'{LOGO_PREVIEW_PREFIX}../x.svg'},
                       'icons': [{'key': 'avatars/a.png'}, {'key': f'{ICONS_PREFIX}{REF}/only.svg'}, 'bad']})
        assert shown['logo'] == {'source_url': 'https://a.example/l.png'}
        assert shown['icons'] == []

    def test_without_a_bucket_there_are_no_urls_and_no_icons(self):
        shown = _view({'logo': {'source_url': 'https://a.example/l.png', 'preview_key': PREVIEW},
                       'icons': [{'key': ICON}]}, sign=None)
        assert shown == {'logo': {'source_url': 'https://a.example/l.png'}, 'icons': []}

    def test_a_reference_without_a_design_is_unchanged(self):
        reference = {'id': REF, 'status': 'pending'}
        assert design_assets.with_asset_urls(reference, _sign, preview_prefix='p', icons_prefix='i') is reference


class TestTheSvgsOwnSheet:
    def test_a_class_rule_becomes_an_attribute_and_the_sheet_itself_is_dropped(self):
        out = design_svg.sanitize_svg(
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>/* c */ .a, .b {fill: #e4002b; '
            'stroke-width: 2 !important} path {opacity: .5} @media print {.a {fill: #000}}</style>'
            '<path class="a" d="M0 0h1"/><path class="b" fill="#111" style="fill:#222" d="M0 0h2"/></svg>')
        assert '<style' not in out
        for attribute in ('fill="#e4002b"', 'stroke-width="2"', 'opacity=".5"'):
            assert attribute in out
        assert 'fill:#222' in out   # the element's own style attribute wins over the sheet
        assert 'fill="#000"' not in out   # at-rules are ignored

    def test_a_sheet_value_still_passes_the_attribute_checks(self):
        out = design_svg.sanitize_svg(
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>.a{fill:url(https://x.example/a);'
            'onclick:alert(1);stroke:url(#g)}</style><path class="a" d="M0 0h1"/></svg>')
        assert 'x.example' not in out
        assert 'onclick' not in out
        assert 'stroke="url(#g)"' in out

    def test_combinators_and_pseudo_classes_are_not_applied(self):
        out = design_svg.sanitize_svg(
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>g .a{fill:red} .a:hover{fill:blue}'
            '</style><path class="a" d="M0 0h1"/></svg>')
        assert 'fill=' not in out


class TestNoRemoteImages:
    def test_remote_markdown_and_html_images_are_dropped_links_kept(self):
        text = ('Logo: ![Brand mark](https://cdn.example/logo.png) and <img src="https://cdn.example/x.png"> '
                'see [the guide](https://example.com/guide) ![local](#anchor)')
        assert without_remote_images(text) == ('Logo: Brand mark and  see [the guide](https://example.com/guide) '
                                                '![local](#anchor)')

    def test_the_stored_guidelines_carry_no_remote_image(self):
        design = clean_extracted_design({'guidelines_md': '## Look\n![hero](//cdn.example/hero.jpg)\nCalm.'}, 'repo_files')
        assert design is not None
        assert 'cdn.example' not in design['guidelines_md']
