"""voc-design-capture with a fake CDP connection: no AWS, no websocket, no model.

Pins the SSRF re-check after navigation, the ONE evaluate + ONE screenshot, block detection, the
fenced vision call and the outcome written on the reference row (moto).
"""
import base64
import importlib.util
import json
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

import boto3
import capture_handler
import capture_worker as cw
import page_styles as ps
import pytest
from moto import mock_aws

from shared.company_context import DESIGN_SYSTEM_PK, get_reference
from shared.test.moto_tables import create_pk_sk_table

REF_ID = 'ref_0123456789ab'
JPEG = b'\xff\xd8\xff' + b'1' * 64
BLOCKS_PATH = Path(__file__).resolve().parents[2] / 'plugins' / 'web_reviews' / 'ingestor' / 'block_detection.py'


def _block_detection():
    spec = importlib.util.spec_from_file_location('design_capture_block_detection', BLOCKS_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BLOCKS = _block_detection()


def _styles(**overrides) -> str:
    page = {
        'url': 'https://kirocrew.dev/', 'title': 'KiroCrew', 'status': 200, 'text': 'Crew of agents. ' * 300,
        'html': '<html></html>',
        'vars': {'--color-primary': '#7c3aed', '--font-sans': '"Space Grotesk", sans-serif', '--radius-md': '8px'},
        'elements': [{'tag': 'h1', 'font': '"Space Grotesk"', 'size': '48px'}],
        'colors': [{'value': 'rgb(124, 58, 237)', 'count': 40}], 'lengths': [], 'fonts': [],
        'logos': [{'url': 'https://kirocrew.dev/logo.svg', 'kind': 'header'},
                  {'url': 'https://kirocrew.dev/apple-touch-icon.png', 'kind': 'touch-icon'}],
        **overrides,
    }
    return json.dumps(page)


class FakeCdp:
    """Answers the commands a capture sends; records them."""

    def __init__(self, styles: str, final_url: str = 'https://kirocrew.dev/', navigate: dict | None = None):
        self.calls: list[tuple[str, dict]] = []
        self.routed: list[tuple[str | None, float]] = []
        self.styles, self.final_url, self.navigate = styles, final_url, navigate or {}

    def call(self, method: str, params: dict | None = None, *, session_id: str | None = None,
             timeout: float = 30.0) -> dict:
        self.calls.append((method, dict(params or {})))
        self.routed.append((session_id, timeout))
        if method == 'Target.createTarget':
            return {'targetId': 't1'}
        if method == 'Target.attachToTarget':
            return {'sessionId': 's1'}
        if method == 'Page.navigate':
            return self.navigate
        if method == 'Page.captureScreenshot':
            return {'data': base64.b64encode(JPEG).decode()}
        if method == 'Runtime.evaluate':
            return {'result': {'value': self._evaluate(str((params or {}).get('expression')))}}
        return {}

    def _evaluate(self, expression: str) -> str:
        if expression == cw.PROGRESS_JS:
            return json.dumps(['complete', 5000])
        if expression == 'location.href':
            return self.final_url
        return self.styles

    def methods(self) -> list[str]:
        return [m for m, _ in self.calls]


def _kit(cdp: FakeCdp, sessions: list[int]) -> cw.BrowserKit:
    @contextmanager
    def open_session(seconds):
        sessions.append(seconds)
        yield cdp
    return cw.BrowserKit(open_session=open_session, blocked_by=BLOCKS.blocked_by, page_signals=BLOCKS.PageSignals,
                         browser_errors=(RuntimeError,))


ANSWER = json.dumps({
    'summary': 'Dark purple developer site.', 'colors': [{'name': 'accent', 'value': '#a78bfa'}],
    'typography': [], 'components': [{'name': 'Button', 'description': 'Purple pill'}], 'guidelines_md': '## Voice\nTerse.',
})


@pytest.fixture
def table():
    with mock_aws():
        table = create_pk_sk_table('test-aggregates')
        table.put_item(Item={'pk': DESIGN_SYSTEM_PK, 'sk': f'REF#{REF_ID}', 'id': REF_ID, 'kind': 'website',
                             'title': 'KiroCrew', 'url': 'https://kirocrew.dev', 'status': 'pending', 'created_at': '1'})
        yield table


def _run(table, cdp: FakeCdp, answer: str = ANSWER, public: bool = True):
    sessions: list[int] = []
    vision = MagicMock(return_value=answer)
    deps = cw.CaptureDeps(table=table, kit=_kit(cdp, sessions), summarise_image=vision, sleep=lambda _s: None,
                          clock=iter(range(1000)).__next__, now=lambda: '2026-10-21T00:00:00+00:00')
    with patch.object(cw, 'validate_url', return_value=(True, '') if public else (False, 'private address')), \
            patch.object(ps, 'validate_url', return_value=(True, '')):
        result = cw.run_capture({'action': 'design_capture', 'ref_id': REF_ID}, deps)
    stored = get_reference(table, REF_ID)
    assert stored is not None
    return result, stored, vision, sessions


class TestCapture:
    def test_one_evaluate_one_screenshot_one_vision_call(self, table):
        cdp = FakeCdp(_styles())
        result, stored, vision, sessions = _run(table, cdp)
        assert result == {'status': 'ready'}
        assert sessions == [120]
        style_evaluates = [p for m, p in cdp.calls if m == 'Runtime.evaluate' and 'getComputedStyle' in p['expression']]
        assert len(style_evaluates) == 1
        assert cdp.methods().count('Page.captureScreenshot') == 1
        assert {session for session, _ in cdp.routed[2:]} == {'s1'}   # every page command goes to the tab
        image, image_format, facts = vision.call_args.args
        assert (image, image_format) == (JPEG, 'jpeg')
        assert '"--color-primary": "#7c3aed"' in facts
        design = stored['extracted_design']
        assert design['source'] == 'computed_styles'
        assert design['colors'] == [{'name': 'accent', 'value': '#a78bfa'}]   # the model's group wins
        assert design['radius'] == [{'name': 'radius-md', 'value': '8px'}]   # backed by the page's own vars
        assert design['logo'] == {'source_url': 'https://kirocrew.dev/apple-touch-icon.png', 'content_type': 'image/png'}
        assert stored['extracted_summary'] == 'Dark purple developer site.'

    def test_final_url_on_a_private_address_is_refused_before_reading(self, table):
        cdp = FakeCdp(_styles(), final_url='http://169.254.169.254/latest/meta-data')
        with patch.object(cw, 'validate_url', side_effect=[(True, ''), (False, 'private')]):
            deps = cw.CaptureDeps(table=table, kit=_kit(cdp, []), summarise_image=MagicMock(), sleep=lambda _s: None,
                                  clock=iter(range(1000)).__next__)
            cw.run_capture({'ref_id': REF_ID}, deps)
        stored = get_reference(table, REF_ID)
        assert stored is not None
        assert stored['status'] == 'error'
        assert stored['error'].startswith('The page ended on an address that is not allowed')
        assert 'Page.captureScreenshot' not in cdp.methods()

    @pytest.mark.parametrize('final_url', ['file:///etc/passwd', 'chrome://settings', 'data:text/html,x'])
    def test_final_url_with_another_scheme_is_refused(self, table, final_url):
        _, stored, vision, _ = _run(table, FakeCdp(_styles(), final_url=final_url))
        assert stored['status'] == 'error'
        vision.assert_not_called()

    def test_configured_url_refused_by_the_guard_opens_no_browser(self, table):
        _, stored, _, sessions = _run(table, FakeCdp(_styles()), public=False)
        assert sessions == []
        assert stored['error'] == 'This address is not allowed (private address)'

    def test_bot_wall_is_a_clear_error(self, table):
        wall = _styles(title='Just a moment...', text='Checking your browser', status=403)
        _, stored, vision, _ = _run(table, FakeCdp(wall))
        assert stored['status'] == 'error'
        assert stored['error'].startswith('The site blocked the secure browser (Cloudflare)')
        vision.assert_not_called()

    def test_navigation_error(self, table):
        _, stored, _, _ = _run(table, FakeCdp(_styles(), navigate={'errorText': 'net::ERR_NAME_NOT_RESOLVED'}))
        assert stored['error'] == 'The page did not load (net::ERR_NAME_NOT_RESOLVED)'

    def test_prose_answer_still_gives_a_design_from_the_page(self, table):
        _, stored, _, _ = _run(table, FakeCdp(_styles()), answer='Plain prose summary.')
        assert stored['extracted_summary'] == 'Plain prose summary.'
        assert stored['extracted_design']['colors'] == [{'name': 'primary', 'value': '#7c3aed'}]

    def test_browser_failure_and_unexpected_failure_are_recorded(self, table):
        cdp = FakeCdp(_styles())
        cdp.call = MagicMock(side_effect=RuntimeError('ws closed'))
        _, stored, _, _ = _run(table, cdp)
        assert stored['error'] == 'The secure browser could not read the page; try again later'
        cdp.call = MagicMock(side_effect=KeyError('x'))
        _, stored, _, _ = _run(table, cdp)
        assert stored['error'] == 'The page could not be processed; try Fetch again later'

    @pytest.mark.parametrize('attrs', [{'status': 'archived'}, {'kind': 'github'}])
    def test_not_a_live_website_is_skipped(self, table, attrs):
        table.update_item(Key={'pk': DESIGN_SYSTEM_PK, 'sk': f'REF#{REF_ID}'},
                          UpdateExpression='SET #a = :v', ExpressionAttributeNames={'#a': next(iter(attrs))},
                          ExpressionAttributeValues={':v': next(iter(attrs.values()))})
        result, _, _, sessions = _run(table, FakeCdp(_styles()))
        assert result == {'status': 'skipped'}
        assert sessions == []


class TestPageStyles:
    def test_answer_is_re_capped(self):
        styles = ps.parse_page_styles(_styles(text='x' * 9_000, vars={f'--v{i}': '1px' for i in range(500)}), 'f')
        assert styles is not None
        assert len(styles.text) == 4_000
        assert len(styles.root_vars) == 400

    @pytest.mark.parametrize('raw', [None, 'nope', '[]', '{"error": "TypeError"}'])
    def test_unreadable_answer(self, raw):
        assert ps.parse_page_styles(raw, 'f') is None

    def test_svg_and_http_logos_are_refused(self):
        with patch.object(ps, 'validate_url', return_value=(True, '')):
            assert ps.logo_candidate([{'url': 'https://a.example/logo.svg', 'kind': 'header'},
                                      {'url': 'http://a.example/logo.png', 'kind': 'header'}]) is None
            assert ps.logo_candidate([{'url': 'https://a.example/og.webp', 'kind': 'og-image'}]) == {
                'source_url': 'https://a.example/og.webp', 'content_type': 'image/webp'}

    def test_expression_hands_the_python_limits_to_the_page(self):
        assert ps.styles_expression().endswith(f'({json.dumps(ps.PAGE_LIMITS)})')

    def test_vars_become_one_root_block_without_injection(self):
        assert ps.css_text_of_vars({'--a': '#111', '--b': 'x;}body{', 'c': '1px'}) == ':root{--a:#111}'


def test_handler_ignores_api_gateway_and_other_actions():
    with patch.object(capture_handler, 'run_capture') as run:
        for event in ({'action': 'other'}, {'action': 'design_capture', 'httpMethod': 'POST'}):
            assert capture_handler.lambda_handler(event, MagicMock()) == {'status': 'ignored'}
        run.assert_not_called()


# ── Component samples (wave 13) ──

SAMPLES = {
    'buttons': [
        {'background': 'rgb(124, 58, 237)', 'color': 'rgb(255, 255, 255)', 'border_width': '0px', 'radius': '8px',
         'padding': '8px 16px 8px 16px', 'font_size': '14px', 'font_weight': '600', 'shadow': 'none',
         'html': '<button class="btn" onclick="steal()">Buy<img src=x onerror=alert(1)></button>', 'variant': 'filled'},
        {'background': 'rgba(0, 0, 0, 0)', 'color': 'rgb(124, 58, 237)', 'border_color': 'rgb(124, 58, 237)',
         'border_width': '1px', 'html': '<button class="btn btn-outline">More</button>', 'variant': 'outlined'},
    ],
    'inputs': [{'background': 'rgb(255, 255, 255)', 'radius': '6px', 'html': '<input type="email" placeholder="you@x">'}],
    'iframes': [{'background': 'red'}],
}
RULES = [{'selector': '.btn-outline:hover', 'state': 'hover', 'styles': {'background': 'rgb(237, 233, 254)'}},
         {'selector': 'button:focus-visible', 'state': 'focus-visible', 'styles': {'outline': '2px solid #a78bfa'}}]


class TestComponents:
    def test_the_one_evaluate_collects_component_samples_and_state_rules(self):
        js = ps.STYLES_JS
        for needle in ('[role=tab]', "[class*=card i], article, section", ':(hover|focus-visible|focus)',
                       'try { rules = Array.from(sheet.cssRules', 'buttonVariant', 'L.snippet', 'removeAttribute'):
            assert needle in js
        assert ps.PAGE_LIMITS['samples'] == 3
        assert ps.PAGE_LIMITS['snippet'] == 600

    def test_without_model_components_the_measured_ones_are_stored(self, table):
        answer = json.dumps({'summary': 'Purple.', 'colors': [{'name': 'accent', 'value': '#a78bfa'}]})
        _, stored, vision, _ = _run(table, FakeCdp(_styles(components=SAMPLES, rules=RULES)), answer=answer)
        assert '"measured_component_styles"' in vision.call_args.args[2]
        assert 'onclick' not in vision.call_args.args[2]
        button, field = stored['extracted_design']['components']
        assert [v['name'] for v in button['variants']] == ['primary', 'outline']
        assert button['variants'][0]['styles'] == {
            'background': 'rgb(124, 58, 237)', 'color': 'rgb(255, 255, 255)', 'border_width': '0px', 'radius': '8px',
            'padding': '8px 16px', 'font_size': '14px', 'font_weight': '600'}
        assert 'hover' not in button['variants'][0]
        assert button['variants'][1]['hover'] == {'background': 'rgb(237, 233, 254)'}
        assert button['variants'][0]['focus'] == {'outline': '2px solid #a78bfa'}
        assert button['example_html'] == '<button class="btn">Buy<img></button>'
        assert field['name'] == 'Input'

    def test_the_models_components_win_and_borrow_the_measured_snippet(self, table):
        _, stored, _, _ = _run(table, FakeCdp(_styles(components=SAMPLES, rules=RULES)))
        [button] = stored['extracted_design']['components']
        assert button['description'] == 'Purple pill'
        assert button['example_html'] == '<button class="btn">Buy<img></button>'

    def test_unknown_kinds_are_dropped_and_samples_capped(self):
        styles = ps.parse_page_styles(_styles(components={**SAMPLES, 'buttons': [SAMPLES['buttons'][0]] * 5,
                                                          'cards': [{'html': 'x' * 900}]}), 'f')
        assert styles is not None
        assert set(styles.components) == {'buttons', 'inputs', 'cards'}
        assert len(styles.components['buttons']) == 3
        assert len(styles.components['cards'][0]['html']) == 600


class TestPreviewAndFetchedAt:
    def test_the_logo_preview_is_stored_and_fetched_at_is_the_end_of_the_read(self, table):
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='raw')
        png = b'\x89PNG\r\n\x1a\n' + b'0' * 16
        response = MagicMock(status_code=200, content=png)
        times = iter(['2026-10-22T10:00:00+00:00', '2026-10-22T10:01:30+00:00'])
        logo_fetch = MagicMock(return_value=response)
        deps = cw.CaptureDeps(table=table, kit=_kit(FakeCdp(_styles()), []), summarise_image=MagicMock(return_value=ANSWER),
                              sleep=lambda _s: None, clock=iter(range(1000)).__next__, now=lambda: next(times),
                              s3=s3, bucket='raw', logo_fetch=logo_fetch)
        with patch.object(cw, 'validate_url', return_value=(True, '')), patch.object(ps, 'validate_url', return_value=(True, '')):
            cw.run_capture({'action': 'design_capture', 'ref_id': REF_ID}, deps)
        stored = get_reference(table, REF_ID)
        assert stored is not None
        key = f'company-context/design/logo_preview_{REF_ID}.png'
        assert stored['extracted_design']['logo']['preview_key'] == key
        assert s3.get_object(Bucket='raw', Key=key)['Body'].read() == png
        assert stored['fetched_at'] == '2026-10-22T10:00:00+00:00'
        logo_fetch.assert_called_once()

    def test_an_error_is_stamped_when_the_read_ends(self, table):
        _, stored, _, _ = _run(table, FakeCdp(_styles(), navigate={'errorText': 'net::ERR_NAME_NOT_RESOLVED'}))
        assert stored['status'] == 'error'
        assert stored['fetched_at'] == '2026-10-21T00:00:00+00:00'


def test_handler_passes_the_bucket_for_the_preview():
    with patch.object(capture_handler, 'run_capture', return_value={'status': 'ready'}) as run, \
            patch.object(capture_handler, 'get_dynamodb_resource'), patch.object(capture_handler, 'browser_kit'), \
            patch.object(capture_handler, 'get_s3_client', return_value='s3'), \
            patch.dict('os.environ', {'AGGREGATES_TABLE': 't', 'RAW_DATA_BUCKET': 'raw'}):
        capture_handler.lambda_handler({'action': 'design_capture', 'ref_id': REF_ID}, MagicMock())
    deps = run.call_args.args[1]
    assert (deps.s3, deps.bucket) == ('s3', 'raw')
