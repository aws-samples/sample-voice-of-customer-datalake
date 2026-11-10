"""The standalone pin path in shared/prototype_pins.py: the submit URL a prototype
may post to, the widget option that carries it, and the S3 metadata the
prototype CSP function (lib/utils/prototype-csp.ts) turns into its one
connect-src."""
import pytest

from shared.prototype_pins import (
    PIN_SUBMIT_URL_METADATA_KEY,
    inject_pin_widget,
    pin_form_id,
    pin_submit_url,
    prototype_object_metadata,
)

API = 'https://abcde12345.execute-api.us-east-1.amazonaws.com/v1'
DOC = 'prototype_20260801_abc'
FORM = pin_form_id(DOC)
URL = f'{API}/feedback-forms/{FORM}/submit'
HTML = '<!doctype html><html><body><p>hi</p></body></html>'


class TestPinSubmitUrl:
    def test_is_the_full_submit_path_of_that_form_on_the_api(self):
        assert pin_submit_url(FORM, API) == URL
        assert pin_submit_url(FORM, f'{API}/') == URL

    @pytest.mark.parametrize('api_base', [
        None, '', 'http://abcde12345.execute-api.us-east-1.amazonaws.com/v1',
        'https://evil.example.com/v1', 'https://abcde12345.execute-api.us-east-1.amazonaws.com',
        f'{API}/extra/path', f'{API}?x=1', f'{API} https://evil.example.com',
    ])
    def test_refuses_anything_but_an_execute_api_stage_base(self, api_base):
        assert pin_submit_url(FORM, api_base) is None

    def test_refuses_a_non_pin_form_id(self):
        assert pin_submit_url('form_abc', API) is None


class TestWidgetOption:
    def test_without_a_url_the_init_call_is_unchanged(self):
        html = inject_pin_widget(HTML, FORM)
        assert f"window.VoCPinWidget.init({{formId: '{FORM}'}});" in html

    def test_with_its_own_url_the_widget_gets_it_json_encoded(self):
        html = inject_pin_widget(HTML, FORM, URL)
        assert f'window.VoCPinWidget.init({{formId: \'{FORM}\', submitUrl: "{URL}"}});' in html

    @pytest.mark.parametrize('submit_url', [
        f'{API}/feedback-forms/{pin_form_id("other")}/submit',
        f'{API}/feedback-forms/{FORM}/config',
        'https://evil.example.com/v1/feedback-forms/' + FORM + '/submit',
        URL + '"});alert(1);//',
    ])
    def test_refuses_any_other_url(self, submit_url):
        with pytest.raises(ValueError, match='not the submit URL'):
            inject_pin_widget(HTML, FORM, submit_url)


class TestObjectMetadata:
    def test_names_the_submit_url_when_the_widget_carries_it(self):
        html = inject_pin_widget(HTML, FORM, URL)
        assert prototype_object_metadata(DOC, html, API) == {PIN_SUBMIT_URL_METADATA_KEY: URL}

    def test_is_empty_without_an_api_base(self):
        assert prototype_object_metadata(DOC, inject_pin_widget(HTML, FORM, URL), None) == {}

    def test_is_empty_when_the_html_has_no_widget(self):
        assert prototype_object_metadata(DOC, HTML, API) == {}

    def test_is_empty_when_the_widget_cannot_post_standalone(self):
        assert prototype_object_metadata(DOC, inject_pin_widget(HTML, FORM), API) == {}

    def test_is_empty_when_the_widget_belongs_to_another_document(self):
        other = pin_form_id('prototype_other')
        html = inject_pin_widget(HTML, other, pin_submit_url(other, API))
        assert prototype_object_metadata(DOC, html, API) == {}
