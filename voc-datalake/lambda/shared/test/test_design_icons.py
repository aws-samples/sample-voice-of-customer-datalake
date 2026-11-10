"""Copying a website reference's icons into the private bucket (shared/design_icons.py), moto S3.

Pins: the type is decided by the bytes (an HTML page or a script named .png is skipped), the 2 MB and 12-file
caps, deduplication by content, the URL policy refusal, an SVG icon sanitised and drawn (or skipped), the stored
entries carrying keys only (the remote URL is provenance), and the archive's listing of the icon folder.
"""
import json
import struct
from collections.abc import Mapping
from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import design_icons as di
from shared.design_logo import LogoPreviewDeleteError
from shared.http_utils import UnsafeURLError

REF_ID = 'ref_0123456789ab'
PNG = b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', 32, 32) + b'\x08\x06\x00\x00\x00'
ICO = b'\x00\x00\x01\x00\x01\x00' + b'\x10' * 20
GIF = b'GIF89a' + b'\x01' * 20
JPEG = b'\xff\xd8\xff' + b'2' * 20
WEBP = b'RIFF\x00\x00\x00\x00WEBPVP8 ' + b'3' * 10
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle r="8" fill="#7c3aed"/></svg>'
DRAWN = b'\x89PNG\r\n\x1a\n' + b'drawn'


def _fetch(bodies: Mapping[str, object]) -> MagicMock:
    """A fetch fake: ``bodies[url]`` is the body (bytes), an exception to raise, or (status, body)."""
    def fetch(url, **_kwargs):
        body = bodies.get(url, (404, b''))
        if isinstance(body, Exception):
            raise body
        status, content = body if isinstance(body, tuple) else (200, body)
        return MagicMock(status_code=status, content=content)
    return MagicMock(side_effect=fetch)


def _copy(fetch, draw=None) -> di.IconCopy:
    return di.IconCopy(draw_svg=draw or MagicMock(return_value=DRAWN), within_budget=lambda: True, fetch=fetch)


def _refs(*urls: str, kind: str = 'icon') -> list[di.IconRef]:
    return [di.IconRef(url, kind) for url in urls]


class TestSniff:
    @pytest.mark.parametrize(('data', 'expected'), [
        (PNG, 'image/png'), (JPEG, 'image/jpeg'), (WEBP, 'image/webp'), (GIF, 'image/gif'), (ICO, 'image/x-icon'),
        (SVG, 'image/svg+xml'), (b'\xef\xbb\xbf<?xml version="1.0"?>\n' + SVG, 'image/svg+xml'),
        (b'<!doctype html><html><svg></svg></html>', None), (b'alert(1)', None), (b'\x00\x00\x01\x00\x00\x00', None),
    ])
    def test_the_type_comes_from_the_bytes(self, data, expected):
        assert di.sniff_icon_type(data) == expected


class TestFetch:
    def test_a_script_served_as_png_and_an_error_page_are_skipped(self):
        fetch = _fetch({'https://a.example/x.png': b'alert(1)', 'https://a.example/y.png': (500, PNG),
                        'https://a.example/z.ico': ICO})
        icons = di.fetch_icons(_refs('https://a.example/x.png', 'https://a.example/y.png', 'https://a.example/z.ico'),
                               _copy(fetch))
        assert [(i.ref.url, i.content_type) for i in icons] == [('https://a.example/z.ico', 'image/x-icon')]

    def test_an_address_the_url_policy_refuses_is_skipped_and_the_rest_still_copied(self):
        fetch = _fetch({'https://169.254.169.254/x.png': UnsafeURLError('https://169.254.169.254/x.png', 'private'), 'https://a.example/a.png': PNG})
        icons = di.fetch_icons(_refs('https://169.254.169.254/x.png', 'https://a.example/a.png'), _copy(fetch))
        assert [i.ref.url for i in icons] == ['https://a.example/a.png']

    def test_only_https_is_ever_fetched(self):
        fetch = _fetch({})
        assert di.fetch_icons(_refs('http://a.example/a.png', 'file:///etc/passwd'), _copy(fetch)) == []
        fetch.assert_not_called()

    def test_every_fetch_is_capped_at_two_megabytes(self):
        fetch = _fetch({'https://a.example/big.png': PNG + b'0' * di.MAX_ICON_BYTES})
        assert di.fetch_icons(_refs('https://a.example/big.png'), _copy(fetch)) == []
        assert fetch.call_args.kwargs['max_bytes'] == di.MAX_ICON_BYTES + 1

    def test_identical_files_are_kept_once_and_the_file_cap_holds(self):
        bodies = {f'https://a.example/{n}.png': PNG + bytes([n]) for n in range(20)}
        bodies['https://a.example/same.png'] = PNG + bytes([0])
        refs = _refs('https://a.example/0.png', 'https://a.example/same.png', *list(bodies)[1:])
        icons = di.fetch_icons(refs, _copy(_fetch(bodies)))
        assert len(icons) == di.MAX_ICON_FILES
        assert 'https://a.example/same.png' not in [i.ref.url for i in icons]
        assert len({i.digest for i in icons}) == di.MAX_ICON_FILES

    def test_the_budget_stops_further_downloads(self):
        fetch = _fetch({'https://a.example/a.png': PNG, 'https://a.example/b.png': PNG + b'b'})
        ticks = iter([True, False])
        copy = di.IconCopy(draw_svg=MagicMock(), within_budget=lambda: next(ticks), fetch=fetch)
        assert len(di.fetch_icons(_refs('https://a.example/a.png', 'https://a.example/b.png'), copy)) == 1
        assert fetch.call_count == 1


class TestSvgIcons:
    def test_an_svg_icon_is_sanitised_and_drawn_and_both_are_kept(self):
        hostile = SVG.replace(b'</svg>', b'<script>steal()</script></svg>')
        draw = MagicMock(return_value=DRAWN)
        icon, = di.fetch_icons(_refs('https://a.example/i.svg'), _copy(_fetch({'https://a.example/i.svg': hostile}), draw))
        assert (icon.data, icon.content_type, icon.files) == (DRAWN, 'image/png', 2)
        assert icon.svg is not None
        assert 'script' not in icon.svg
        assert draw.call_args.args[0].startswith('data:image/svg+xml;base64,')

    @pytest.mark.parametrize('body', [b'<!DOCTYPE svg [<!ENTITY a "x">]><svg/>', SVG])
    def test_an_svg_icon_that_cannot_be_sanitised_or_drawn_is_skipped(self, body):
        draw = MagicMock(return_value=None)
        assert di.fetch_icons(_refs('https://a.example/i.svg'), _copy(_fetch({'https://a.example/i.svg': body}), draw)) == []

    def test_at_most_two_svg_icons_are_drawn(self):
        bodies = {f'https://a.example/{n}.svg': SVG.replace(b'r="8"', f'r="{n + 1}"'.encode()) for n in range(4)}
        draw = MagicMock(return_value=DRAWN)
        icons = di.fetch_icons(_refs(*bodies), _copy(_fetch(bodies), draw))
        assert draw.call_count == di.MAX_SVG_ICON_RENDERS
        assert len(icons) == di.MAX_SVG_ICON_RENDERS


class TestManifest:
    def test_the_manifest_icons_resolve_against_its_url(self):
        manifest = json.dumps({'icons': [{'src': '/icons/192.png', 'sizes': '192x192'}, {'src': 'a.png', 'sizes': 'x'},
                                         {'nope': 1}, 'bad']}).encode()
        refs = di.manifest_refs('https://a.example/app/site.webmanifest', _fetch({
            'https://a.example/app/site.webmanifest': manifest}))
        assert refs == [di.IconRef('https://a.example/icons/192.png', 'manifest', '192x192'),
                        di.IconRef('https://a.example/app/a.png', 'manifest', '')]

    @pytest.mark.parametrize('body', [b'not json', b'[]', (404, b'')])
    def test_an_unreadable_manifest_names_no_icons(self, body):
        assert di.manifest_refs('https://a.example/m.json', _fetch({'https://a.example/m.json': body})) == []


@pytest.fixture
def s3():
    with mock_aws():
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket='raw')
        yield client


class TestStore:
    def test_entries_name_local_keys_and_keep_the_remote_url_as_provenance_only(self, s3):
        icons = di.fetch_icons([di.IconRef('https://a.example/a.png', 'touch-icon', '180x180'),
                                di.IconRef('https://a.example/i.svg', 'mask-icon'),
                                di.IconRef('https://a.example/favicon.ico', 'favicon')],
                               _copy(_fetch({'https://a.example/a.png': PNG, 'https://a.example/i.svg': SVG,
                                             'https://a.example/favicon.ico': ICO})))
        entries = di.store_icons(icons, REF_ID, s3, 'raw')
        prefix = f'company-context/design/icons_{REF_ID}/'
        assert [(e['kind'], e['sizes'], e['content_type']) for e in entries] == [
            ('touch-icon', '180x180', 'image/png'), ('mask-icon', '', 'image/png'), ('favicon', '', 'image/x-icon')]
        assert all(e['key'].startswith(prefix) for e in entries)
        svg = s3.get_object(Bucket='raw', Key=entries[1]['svg_key'])
        assert (svg['ContentType'], svg['ContentDisposition']) == ('image/svg+xml', 'attachment; filename="logo.svg"')
        assert s3.get_object(Bucket='raw', Key=entries[2]['key'])['ContentType'] == 'image/x-icon'
        assert len(s3.list_objects_v2(Bucket='raw')['Contents']) == 4   # three icons + one SVG copy

    def test_an_undeclared_png_size_is_read_from_its_header(self, s3):
        icons = di.fetch_icons(_refs('https://a.example/a.png'), _copy(_fetch({'https://a.example/a.png': PNG})))
        entry, = di.store_icons(icons, REF_ID, s3, 'raw')
        assert entry['sizes'] == '32x32'

    @pytest.mark.parametrize(('bucket', 'ref_id'), [('', REF_ID), ('raw', '../x')])
    def test_nothing_is_stored_without_a_bucket_or_with_a_bad_id(self, s3, bucket, ref_id):
        icons = di.fetch_icons(_refs('https://a.example/a.png'), _copy(_fetch({'https://a.example/a.png': PNG})))
        assert di.store_icons(icons, ref_id, s3, bucket) == []

    def test_the_archive_lists_every_object_of_the_folder_and_only_it(self, s3):
        for key in (f'company-context/design/icons_{REF_ID}/a.png', f'company-context/design/icons_{REF_ID}/old.ico',
                    'company-context/design/icons_ref_aaaaaaaaaaaa/a.png', 'company-context/design/logo_x.png'):
            s3.put_object(Bucket='raw', Key=key, Body=b'x')
        assert sorted(di.stored_icon_keys(s3, 'raw', REF_ID)) == [
            f'company-context/design/icons_{REF_ID}/a.png', f'company-context/design/icons_{REF_ID}/old.ico']

    def test_a_refused_listing_fails_the_archive_step_so_it_can_be_repeated(self):
        s3 = MagicMock()
        s3.list_objects_v2.side_effect = ClientError({'Error': {'Code': 'AccessDenied'}}, 'ListObjectsV2')
        with pytest.raises(LogoPreviewDeleteError):
            di.stored_icon_keys(s3, 'raw', REF_ID)


@pytest.mark.parametrize(('raw', 'expected'), [
    ('16x16 32x32', '16x16 32x32'), ('ANY', 'any'), (' 180x180 ', '180x180'), ('big', ''), (None, ''),
    ('1x1 ' * 9, ''),
])
def test_sizes_are_kept_only_in_their_declared_grammar(raw, expected):
    assert di.clean_sizes(raw) == expected
