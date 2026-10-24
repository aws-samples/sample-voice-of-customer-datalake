"""Mutation hardening for `shared/null_origin_cors.py`.

`test_null_origin_cors.py` pins the accepted `Origin: null` answer and the
refusals, but every event it builds carries the Origin as its ONLY header, and
every request runs after `reset()`. A mutation run found what that cannot see:

* the Origin lookup must match the header NAME: a mutant that returned the first
  string-named header (`Content-Type`, `Accept`) as the Origin survived, in both
  the `headers` and the `multiValueHeaders` shape.
* a non-string Origin value is skipped (single) or answered as no Origin (multi).
* an existing comma-separated `Vary` is split into tokens, so an `Origin`
  already in the list is not appended a second time.
* a context that never called `reset()` (a fresh `contextvars.Context`) starts
  NOT accepted: the ContextVar's default is what keeps a first request closed.
"""
import contextvars

import pytest

from shared import null_origin_cors


@pytest.fixture(autouse=True)
def _fresh():
    null_origin_cors.reset()
    yield
    null_origin_cors.reset()


class TestTheOriginIsFoundByItsHeaderName:
    @pytest.mark.parametrize('event', [
        {'headers': {'Content-Type': 'application/json', 'oRiGiN': 'null'}},
        {'headers': {'Origin': 7, 'origin': 'null'}},
        {'headers': {1: 'x', 'Origin': 'null'}},
        {'multiValueHeaders': {'Accept': ['text/html'], 'ORIGIN': ['null', 'other']}},
        {'headers': None, 'multiValueHeaders': {1: ['x'], 'origin': ['null']}},
    ])
    def test_the_origin_header_is_returned_and_no_other(self, event):
        assert null_origin_cors.request_origin(event) == 'null'

    @pytest.mark.parametrize('event', [
        {},
        {'headers': {'Content-Type': 'application/json'}, 'multiValueHeaders': {'Accept': ['text/html']}},
        {'headers': {'Origin': 7}},
        {'multiValueHeaders': {'Origin': [7, 'null']}},
        {'multiValueHeaders': {'Origin': []}},
        {'multiValueHeaders': {'Origin': 'null'}},
    ])
    def test_no_usable_origin_is_none(self, event):
        assert null_origin_cors.request_origin(event) is None

    def test_a_single_header_wins_over_the_multi_value_shape(self):
        event = {'headers': {'Origin': 'https://a.example'}, 'multiValueHeaders': {'Origin': ['null']}}
        assert null_origin_cors.request_origin(event) == 'https://a.example'


class TestVaryIsMergedTokenByToken:
    @pytest.mark.parametrize(('response', 'vary'), [
        ({'headers': {'Vary': 'Accept-Encoding,Origin'}}, 'Accept-Encoding, Origin'),
        ({'headers': {'Vary': ' Accept , ,Cookie '}}, 'Accept, Cookie, Origin'),
        ({'multiValueHeaders': {'vary': ['Accept', 'ORIGIN, Cookie', 3], 'X': 'y'}}, 'Accept, ORIGIN, Cookie'),
        ({'headers': {'Vary': 5}}, 'Origin'),
        ({}, 'Origin'),
    ])
    def test_origin_is_added_once(self, response, vary):
        null_origin_cors.accept()
        answered = null_origin_cors.apply({'headers': {'Origin': 'null'}}, response)
        assert answered['headers']['Vary'] == vary
        assert answered['headers']['Access-Control-Allow-Origin'] == 'null'

    def test_replaced_names_are_dropped_case_insensitively_and_others_kept(self):
        null_origin_cors.accept()
        response = {'statusCode': 204, 'headers': {'access-control-allow-credentials': 'true', 'X-Id': '1', 2: 'n'},
                    'multiValueHeaders': {'VARY': ['Accept'], 'Set-Cookie': ['a=1'], 3: ['m']}}
        answered = null_origin_cors.apply({'headers': {'Origin': 'null'}}, response)
        assert answered == {
            'statusCode': 204,
            'headers': {'X-Id': '1', 2: 'n', 'Access-Control-Allow-Origin': 'null', 'Vary': 'Accept, Origin'},
            'multiValueHeaders': {'Set-Cookie': ['a=1'], 3: ['m']},
        }
        assert response['headers'] == {'access-control-allow-credentials': 'true', 'X-Id': '1', 2: 'n'}

    def test_no_multi_value_headers_are_added_when_the_response_had_none(self):
        null_origin_cors.accept()
        answered = null_origin_cors.apply({'headers': {'Origin': 'null'}}, {'headers': None})
        assert answered == {'headers': {'Access-Control-Allow-Origin': 'null', 'Vary': 'Origin'}}


def test_a_context_that_never_reset_starts_not_accepted():
    response = {'headers': {}}
    answered = contextvars.Context().run(null_origin_cors.apply, {'headers': {'Origin': 'null'}}, response)
    assert answered is response
