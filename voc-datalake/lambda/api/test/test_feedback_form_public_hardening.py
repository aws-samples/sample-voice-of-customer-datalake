"""Hardening of the three public feedback-form routes.

- #379: GET /feedback-forms/<form_id>/iframe used to interpolate the raw path
  parameter into an inline <script> (reflected XSS). Ids are now validated on
  config, submit and iframe, the iframe 404s an unknown form, and every value
  in its script is serialised by `_js_value`. Design from upstream PR #396.
- #222: POST /submit bounds every caller-supplied field before the form read.
"""
import json
import re
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from handler_events_fixtures import call_route

from shared.test.source_profile_fixtures import no_source_profiles

_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)

# Closes the JS string literal the old template wrote around form_id.
_BREAKOUT = "a');alert(1);x=('"
# Same hole via an object-literal property; this one actually ran.
_OBJECT_BREAKOUT = "a',x:alert(1),y:'"

_MALFORMED_IDS = [
    _BREAKOUT,
    _OBJECT_BREAKOUT,
    '</script><script>alert(1)</script>',
    'caf\u00e9',
    'form\u2028a',
    'a' * 65,
    'deadbeef\n',
    ' deadbeef',
    'my form',
    '.',
    '..',
    '',
]

_VALID_IDS = ['deadbeef', '1a2b3c4d', 'pf_0123456789abcdef', 'form-123', 'acme.website', 'a' * 64]


def _iframe(lambda_handler, api_gateway_event, lambda_context, form_id: str, domain: str = 'api.example.com'):
    event = api_gateway_event(
        method='GET',
        path=f'/feedback-forms/{form_id}/iframe',
        path_params={'form_id': form_id},
    )
    event['requestContext']['domainName'] = domain
    return lambda_handler(event, lambda_context)


def _headers(response: dict) -> dict:
    """Response headers as name -> value, whichever shape Powertools emitted."""
    multi = response.get('multiValueHeaders') or {}
    return {**{k: v[0] for k, v in multi.items() if v}, **(response.get('headers') or {})}


def _init_options(html: str) -> dict:
    """The object literal passed to VoCFeedbackForm.init, parsed as JSON."""
    match = re.search(r'VoCFeedbackForm\.init\((\{.*?\})\);\n', html)
    assert match, 'VoCFeedbackForm.init({...}) call not found in the page'
    return json.loads(match.group(1))


class TestFormIdValidator:
    @pytest.mark.parametrize('raw', _MALFORMED_IDS)
    def test_malformed_ids_are_refused(self, feedback_form_handler, raw):
        assert feedback_form_handler._validated_form_id(raw) is None

    @pytest.mark.parametrize('raw', [None, 123, ['deadbeef']])
    def test_non_strings_are_refused(self, feedback_form_handler, raw):
        assert feedback_form_handler._validated_form_id(raw) is None

    @pytest.mark.parametrize('raw', _VALID_IDS)
    def test_real_ids_pass_unchanged(self, feedback_form_handler, raw):
        assert feedback_form_handler._validated_form_id(raw) == raw

    def test_every_minted_id_passes(self, feedback_form_handler):
        """Ids build_form_item and prototype_pins mint must always stay reachable."""
        from shared.prototype_pins import pin_form_id
        for _ in range(200):
            minted = feedback_form_handler.build_form_item({})['form_id']
            assert feedback_form_handler._validated_form_id(minted) == minted
        assert feedback_form_handler._validated_form_id(pin_form_id('doc_20260101')) is not None


class TestIframePage:
    @pytest.mark.parametrize('form_id', [_BREAKOUT, _OBJECT_BREAKOUT, 'caf\u00e9', 'a' * 65, 'my form'])
    def test_a_malformed_id_is_a_404_without_a_read(
        self, feedback_form_handler, api_gateway_event, lambda_context, form_id
    ):
        with patch('feedback_form_handler.aggregates_table') as table:
            response = _iframe(feedback_form_handler.lambda_handler, api_gateway_event, lambda_context, form_id)
        assert response['statusCode'] == 404
        assert 'alert' not in response['body']
        table.get_item.assert_not_called()

    def test_an_unknown_form_is_a_404(self, feedback_form_handler, api_gateway_event, lambda_context):
        with patch('feedback_form_handler.aggregates_table') as table:
            table.get_item.return_value = {}
            response = _iframe(feedback_form_handler.lambda_handler, api_gateway_event, lambda_context, 'deadbeef')
        assert response['statusCode'] == 404

    def test_happy_path_renders_the_widget_init(self, feedback_form_handler, api_gateway_event, lambda_context):
        with patch('feedback_form_handler.aggregates_table') as table:
            table.get_item.return_value = {'Item': {'form_id': 'deadbeef', 'enabled': False}}
            response = _iframe(feedback_form_handler.lambda_handler, api_gateway_event, lambda_context, 'deadbeef')
        assert response['statusCode'] == 200
        assert _headers(response)['Content-Type'] == 'text/html'
        assert _init_options(response['body']) == {
            'container': '#voc-feedback-form',
            'apiEndpoint': 'https://api.example.com/test',
            'formId': 'deadbeef',
            'configEndpoint': '/feedback-forms/deadbeef/config',
            'submitEndpoint': '/feedback-forms/deadbeef/submit',
        }
        table.get_item.assert_called_once_with(Key={'pk': 'FEEDBACK_FORM', 'sk': 'FORM#deadbeef'})

    def test_the_widget_renders_inside_a_main_landmark(
        self, feedback_form_handler, api_gateway_event, lambda_context
    ):
        """axe `landmark-one-main` + `region` on the public widget (E2E F6): the
        container the widget fills is the page's one <main>."""
        with patch('feedback_form_handler.aggregates_table') as table:
            table.get_item.return_value = {'Item': {'form_id': 'deadbeef', 'enabled': True}}
            response = _iframe(feedback_form_handler.lambda_handler, api_gateway_event, lambda_context, 'deadbeef')
        body = response['body']
        assert re.findall(r'<main\b[^>]*>', body) == ['<main id="voc-feedback-form">']
        assert '<div id="voc-feedback-form">' not in body

    def test_the_page_carries_a_content_security_policy(
        self, feedback_form_handler, api_gateway_event, lambda_context
    ):
        with patch('feedback_form_handler.aggregates_table') as table:
            table.get_item.return_value = {'Item': {'form_id': 'deadbeef'}}
            response = _iframe(feedback_form_handler.lambda_handler, api_gateway_event, lambda_context, 'deadbeef')
        headers = _headers(response)
        csp = headers['Content-Security-Policy']
        assert "default-src 'none'" in csp
        assert "connect-src 'self'" in csp
        assert 'frame-ancestors' not in csp, 'the page exists to be framed by customer sites'
        assert headers['X-Content-Type-Options'] == 'nosniff'

    def test_a_hostile_domain_name_cannot_break_out_of_the_script(
        self, feedback_form_handler, api_gateway_event, lambda_context
    ):
        hostile = "x'</script><script>alert(1)</script>"
        with patch('feedback_form_handler.aggregates_table') as table:
            table.get_item.return_value = {'Item': {'form_id': 'deadbeef'}}
            response = _iframe(
                feedback_form_handler.lambda_handler, api_gateway_event, lambda_context, 'deadbeef', domain=hostile
            )
        body = response['body']
        assert '</script><script>alert' not in body
        assert body.count('</script>') == 1
        assert _init_options(body)['apiEndpoint'] == f'https://{hostile}/test'


class TestJsValue:
    @pytest.mark.parametrize('value', [
        _BREAKOUT, _OBJECT_BREAKOUT, '</script><script>alert(1)</script>', 'a & b', 'line\u2028sep\u2029x', 'caf\u00e9',
    ])
    def test_round_trips_and_is_inert_to_the_html_parser(self, feedback_form_handler, value):
        serialised = feedback_form_handler._js_value(value)
        assert json.loads(serialised) == value
        for ch in '<>&\u2028\u2029':
            assert ch not in serialised
        # Only the serialiser's own two quotes; any inner quote is escaped.
        assert serialised.startswith('"')
        assert serialised.endswith('"')
        assert '"' not in serialised[1:-1].replace('\\"', '')


class TestPublicRoutesValidateTheId:
    @patch('feedback_form_handler.aggregates_table')
    def test_config_refuses_a_malformed_id_without_a_read(
        self, table, feedback_form_handler, api_gateway_event, lambda_context
    ):
        response, _ = call_route(
            feedback_form_handler.lambda_handler, api_gateway_event, lambda_context,
            method='GET', path=f'/feedback-forms/{_BREAKOUT}/config', path_params={'form_id': _BREAKOUT},
        )
        assert response['statusCode'] == 404
        table.get_item.assert_not_called()

    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_submit_refuses_a_malformed_id_without_a_read(
        self, table, sqs, feedback_form_handler, api_gateway_event, lambda_context
    ):
        response, _ = call_route(
            feedback_form_handler.lambda_handler, api_gateway_event, lambda_context,
            method='POST', path=f'/feedback-forms/{_BREAKOUT}/submit', path_params={'form_id': _BREAKOUT},
            body={'text': 'Great'},
        )
        assert response['statusCode'] == 404
        table.get_item.assert_not_called()
        sqs.send_message.assert_not_called()


def _submit(feedback_form_handler, api_gateway_event, lambda_context, body):
    return call_route(
        feedback_form_handler.lambda_handler, api_gateway_event, lambda_context,
        method='POST', path='/feedback-forms/deadbeef/submit', path_params={'form_id': 'deadbeef'}, body=body,
    )


_ENABLED_FORM = {'Item': {'form_id': 'deadbeef', 'enabled': True, 'collect_name': True, 'collect_email': True}}


class TestSubmissionLimits:
    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_the_widgets_own_payload_and_values_at_every_limit_are_accepted(
        self, table, sqs, feedback_form_handler, api_gateway_event, lambda_context
    ):
        table.get_item.return_value = _ENABLED_FORM
        # Exactly MAX_CUSTOM_FIELDS (20): a max-length value, a max-length key, scalars.
        custom_fields = {'plan': 'v' * 1000, 'k' * 64: None, 'opt_in': True}
        custom_fields |= {f'n{i}': i for i in range(17)}
        body = {
            'text': 'x' * 10_000,
            'rating': 4,
            'name': 'n' * 200,
            'email': 'e' * 254,
            'page_url': 'p' * 4096,
            'custom_fields': custom_fields,
        }
        response, payload = _submit(feedback_form_handler, api_gateway_event, lambda_context, body)
        assert response['statusCode'] == 200, payload
        record = json.loads(sqs.send_message.call_args.kwargs['MessageBody'])
        assert record['text'] == 'x' * 10_000
        assert record['metadata']['submitter_name'] == 'n' * 200

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.sqs', new=MagicMock())
    @patch('feedback_form_handler.aggregates_table')
    def test_the_widget_sends_null_name_and_email_and_that_is_accepted(
        self, table, feedback_form_handler, api_gateway_event, lambda_context
    ):
        table.get_item.return_value = _ENABLED_FORM
        response, _ = _submit(feedback_form_handler, api_gateway_event, lambda_context, {
            'text': 'Great', 'rating': None, 'name': None, 'email': None, 'page_url': 'https://shop.example/p?q=1',
        })
        assert response['statusCode'] == 200


class TestRatingAndNonFiniteNumbers:
    @pytest.mark.parametrize('rating', [
        0, 0.5, 11, -1, True, False, '5', [5], {'v': 5}, float('nan'), float('inf'), float('-inf'),
    ])
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_rating_outside_1_to_10_or_not_a_finite_number_is_a_400(
        self, table, sqs, feedback_form_handler, api_gateway_event, lambda_context, rating
    ):
        response, payload = _submit(feedback_form_handler, api_gateway_event, lambda_context,
                                    {'text': 'ok', 'rating': rating})
        assert response['statusCode'] == 400
        assert 'rating' in payload['error']
        table.get_item.assert_not_called()
        sqs.send_message.assert_not_called()

    @pytest.mark.parametrize('rating', [1, 5, 10, 4.5, None])
    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_every_rating_the_widget_can_send_is_accepted(
        self, table, sqs, feedback_form_handler, api_gateway_event, lambda_context, rating
    ):
        table.get_item.return_value = _ENABLED_FORM
        response, payload = _submit(feedback_form_handler, api_gateway_event, lambda_context,
                                    {'text': 'ok', 'rating': rating})
        assert response['statusCode'] == 200, payload
        assert json.loads(sqs.send_message.call_args.kwargs['MessageBody'])['rating'] == rating

    @pytest.mark.parametrize('value', [float('nan'), float('inf'), float('-inf')])
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_nan_or_infinity_in_custom_fields_is_a_400(
        self, table, sqs, feedback_form_handler, api_gateway_event, lambda_context, value
    ):
        response, payload = _submit(feedback_form_handler, api_gateway_event, lambda_context,
                                    {'text': 'ok', 'custom_fields': {'score': value}})
        assert response['statusCode'] == 400
        assert 'custom_fields.score' in payload['error']
        table.get_item.assert_not_called()
        sqs.send_message.assert_not_called()

    def test_the_submit_bound_matches_the_processor_schema(self, feedback_form_handler):
        from shared.ingest_schemas import MAX_RATING
        assert feedback_form_handler.MAX_SUBMISSION_RATING == MAX_RATING


class TestPublicConfigRatingMax:
    @staticmethod
    def _served_rating_max(feedback_form_handler, api_gateway_event, lambda_context, table, stored):
        table.get_item.return_value = {'Item': {'form_id': 'deadbeef', 'enabled': True, 'rating_max': stored}}
        response, payload = call_route(
            feedback_form_handler.lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/feedback-forms/deadbeef/config', path_params={'form_id': 'deadbeef'},
        )
        assert response['statusCode'] == 200, payload
        return payload['config']['rating_max']

    @pytest.mark.parametrize(('stored', 'served'), [
        ('abc', 5), ([3], 5), ({'x': 1}, 5), (True, 5), (None, 5), ('NaN', 5), ('Infinity', 5),
        (0, 1), (-3, 1), (99, 10), ('7', 7), (10, 10), (Decimal('8'), 8),   # DynamoDB returns Decimal
    ])
    @patch('feedback_form_handler.aggregates_table')
    def test_a_stored_rating_max_is_clamped_and_never_500s(
        self, table, feedback_form_handler, api_gateway_event, lambda_context, stored, served
    ):
        assert self._served_rating_max(
            feedback_form_handler, api_gateway_event, lambda_context, table, stored,
        ) == served
