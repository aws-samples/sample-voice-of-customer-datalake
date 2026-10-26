"""Wave 13 follow-ups of the design references: the logo candidate PREVIEW (downloaded at read time through
the SSRF-guarded fetch, stored privately, served signed), ``fetched_at`` stamped when the read finishes,
and a GitHub read that parses the UI component sources."""
import io
import json
from unittest.mock import MagicMock, patch

import boto3
import pytest
import requests
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import design_logo
from shared import design_references as dr
from shared.http_utils import UnsafeURLError

REF_ID = 'ref_0123456789ab'
PNG = b'\x89PNG\r\n\x1a\n' + b'0' * 32
WEBP = b'RIFF\x00\x00\x00\x00WEBPVP8 ' + b'0' * 16
DESIGN = {'colors': [], 'logo': {'source_url': 'https://kiro.dev/logo.png', 'content_type': 'image/png'}}


def _response(status: int, body: bytes) -> requests.Response:
    response = requests.Response()
    response.status_code = status
    response.raw = io.BytesIO(body)
    return response


@pytest.fixture
def bucket():
    with mock_aws():
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket='raw')
        yield client


class TestStorePreview:
    def test_downloads_through_the_guard_and_stores_it_under_the_preview_prefix(self, bucket):
        fetch = MagicMock(return_value=_response(200, WEBP))
        design = design_logo.store_preview(DESIGN, REF_ID, bucket, 'raw', fetch)
        assert design is not None
        key = f'company-context/design/logo_preview_{REF_ID}.webp'
        assert design['logo'] == {**DESIGN['logo'], 'preview_key': key}
        fetch.assert_called_once_with('https://kiro.dev/logo.png', timeout=10, max_redirects=3, max_bytes=2_000_001)
        stored = bucket.get_object(Bucket='raw', Key=key)
        assert (stored['ContentType'], stored['Body'].read()) == ('image/webp', WEBP)

    @pytest.mark.parametrize('failure', [
        UnsafeURLError('https://kiro.dev/logo.png', 'private address'),
        requests.exceptions.ConnectionError('down'),
        _response(200, b'<svg onload="alert(1)"/>'),
        _response(200, b'<html>error</html>'),
        _response(200, PNG + b'0' * 2_000_000),
        _response(403, b''),
    ])
    def test_unsafe_unreachable_wrong_type_or_too_large_leaves_no_preview(self, bucket, failure):
        fetch = MagicMock(side_effect=failure) if isinstance(failure, Exception) else MagicMock(return_value=failure)
        stale = {**DESIGN, 'logo': {**DESIGN['logo'], 'preview_key': 'company-context/design/logo_preview_old.png'}}
        design = design_logo.store_preview(stale, REF_ID, bucket, 'raw', fetch)
        assert design == DESIGN
        assert bucket.list_objects_v2(Bucket='raw').get('KeyCount') == 0

    def test_an_s3_failure_leaves_no_preview(self):
        s3 = MagicMock()
        s3.put_object.side_effect = ClientError({'Error': {'Code': 'AccessDenied'}}, 'PutObject')
        assert design_logo.store_preview(DESIGN, REF_ID, s3, 'raw', MagicMock(return_value=_response(200, PNG))) == DESIGN

    @pytest.mark.parametrize(('design', 'ref_id', 'bucket_name'), [
        ({'colors': []}, REF_ID, 'raw'), (None, REF_ID, 'raw'), (DESIGN, REF_ID, ''), (DESIGN, '../x', 'raw'),
    ])
    def test_nothing_to_fetch_makes_no_request(self, design, ref_id, bucket_name):
        fetch = MagicMock()
        design_logo.store_preview(design, ref_id, MagicMock(), bucket_name, fetch)
        fetch.assert_not_called()


class TestFetchedAt:
    def test_it_is_the_time_the_read_finished(self, monkeypatch):
        times = iter(['2026-10-22T10:00:00+00:00', '2026-10-22T10:00:42+00:00'])
        clock = MagicMock()
        clock.now.return_value.isoformat.side_effect = lambda: next(times)
        monkeypatch.setattr(dr, 'datetime', clock)
        table = MagicMock()

        def slow_summary(_digest: str) -> str:
            next(times)  # the read itself takes time: the stamp must come after it
            return 'A summary'

        deps = dr.ProcessDeps(s3=MagicMock(), bucket='', secrets={'figma_token': 't'}, summarise=slow_summary,
                              summarise_image=MagicMock(), http_get=MagicMock(return_value=_figma()))
        outcome = dr.process_reference(table, {'id': REF_ID, 'kind': 'figma',
                                               'url': 'https://www.figma.com/file/abcdefghij12/x'}, deps)
        assert outcome['fetched_at'] == '2026-10-22T10:00:42+00:00'

    def test_an_error_is_stamped_too(self):
        deps = dr.ProcessDeps(s3=MagicMock(), bucket='', secrets={}, summarise=MagicMock(),
                              summarise_image=MagicMock())
        outcome = dr.process_reference(MagicMock(), {'id': REF_ID, 'kind': 'figma', 'url': 'https://www.figma.com/file/abcdefghij12/x'}, deps)
        assert outcome['status'] == 'error'
        assert outcome['fetched_at'].startswith('20')


def _figma() -> requests.Response:
    return _response(200, json.dumps({'name': 'F', 'document': {'children': []}}).encode())


GITHUB_ROUTES = {
    'https://api.github.com/repos/acme/ui/git/trees/HEAD?recursive=1': json.dumps({'tree': [
        {'type': 'blob', 'path': p} for p in (
            'src/styles/tokens.css', 'src/components/ui/button.tsx', 'src/components/ui/card.tsx',
            'src/components/ui/avatar.tsx', 'public/logo.png')]}).encode(),
    'https://api.github.com/repos/acme/ui/contents/src/styles/tokens.css':
        b':root{--color-accent:#7c3aed;--color-accent-fg:#ffffff;--radius-md:6px}',
    'https://api.github.com/repos/acme/ui/contents/src/components/ui/button.tsx': (
        b'export function Button() { return <button className="bg-accent text-accent-fg rounded-md px-4 py-2" /> }'),
}


class TestGithubComponents:
    def _deps(self, summary: str = '{"summary": "Purple."}', logo_fetch: MagicMock | None = None) -> dr.ProcessDeps:
        def route(url: str, **_kwargs: object) -> requests.Response:
            body = GITHUB_ROUTES.get(url)
            return _response(200 if body is not None else 404, body or b'')
        return dr.ProcessDeps(s3=MagicMock(), bucket='raw', secrets={}, summarise=MagicMock(return_value=summary),
                              summarise_image=MagicMock(), http_get=MagicMock(side_effect=route), logo_fetch=logo_fetch)

    def test_parsed_styles_back_the_model_and_a_failed_source_is_skipped(self):
        summarise = MagicMock(return_value='{"summary": "Purple."}')
        deps = self._deps(logo_fetch=MagicMock(return_value=_response(200, PNG)))
        deps.summarise = summarise
        summary, design = dr.extract_reference(deps, {'kind': 'github', 'url': 'https://github.com/acme/ui'})
        assert summary == 'Purple.'
        assert design is not None
        button = design['components'][0]
        assert button == {'name': 'Button', 'description': '', 'variants': [{'name': 'default', 'styles': {
            'background': '#7c3aed', 'color': '#ffffff', 'radius': '6px', 'padding': '8px 16px'}}]}
        assert [c['name'] for c in design['components']] == ['Button', 'Avatar', 'Card']
        prompt = summarise.call_args.args[0]
        assert '(UI component source)' in prompt
        assert '"background": "#7c3aed"' in prompt

    def test_the_models_components_win_when_it_gives_some(self):
        answer = json.dumps({'summary': 'S', 'components': [{'name': 'Card', 'variants': [
            {'name': 'default', 'styles': {'radius': '12px'}}]}]})
        _, design = dr.extract_reference(self._deps(answer), {'kind': 'github', 'url': 'https://github.com/acme/ui'})
        assert design is not None
        assert [c['name'] for c in design['components']] == ['Card']

    def test_process_stores_the_logo_preview(self):
        logo_fetch = MagicMock(return_value=_response(200, PNG))
        deps = self._deps(logo_fetch=logo_fetch)
        with patch.object(dr, 'record_outcome'):
            outcome = dr.process_reference(MagicMock(), {'id': REF_ID, 'kind': 'github',
                                                         'url': 'https://github.com/acme/ui'}, deps)
        assert outcome['extracted_design']['logo']['preview_key'] == f'company-context/design/logo_preview_{REF_ID}.png'
        logo_fetch.assert_called_once()
        assert logo_fetch.call_args.args[0] == 'https://raw.githubusercontent.com/acme/ui/HEAD/public/logo.png'
