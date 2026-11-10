"""shared/null_origin_cors.py: `Origin: null` is echoed only for an accepted request."""
import pytest

from shared import null_origin_cors


@pytest.fixture(autouse=True)
def _fresh():
    null_origin_cors.reset()
    yield
    null_origin_cors.reset()


def _event(origin: str | None, *, multi: bool = False) -> dict:
    if origin is None:
        return {'headers': {}}
    return {'multiValueHeaders': {'origin': [origin]}} if multi else {'headers': {'Origin': origin}}


RESOLVED = {
    'statusCode': 200,
    'headers': {'Content-Type': 'application/json'},
    'multiValueHeaders': {'Access-Control-Allow-Origin': ['*'], 'Access-Control-Allow-Credentials': ['true'],
                          'Vary': ['Accept-Encoding']},
    'body': '{}',
}


def test_an_accepted_null_origin_gets_null_vary_origin_and_no_credentials():
    null_origin_cors.accept()
    answered = null_origin_cors.apply(_event('null', multi=True), RESOLVED)

    assert answered['headers'] == {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'null',
                                   'Vary': 'Accept-Encoding, Origin'}
    assert answered['multiValueHeaders'] == {}
    assert answered['body'] == '{}'


@pytest.mark.parametrize('origin', [None, 'https://app.example', 'NULL', 'null ', ''])
def test_an_accepted_request_from_any_other_origin_is_unchanged(origin):
    null_origin_cors.accept()
    assert null_origin_cors.apply(_event(origin), RESOLVED) is RESOLVED


def test_a_request_that_was_not_accepted_is_unchanged_even_from_null():
    assert null_origin_cors.apply(_event('null'), RESOLVED) is RESOLVED


def test_reset_forgets_the_decision():
    null_origin_cors.accept()
    null_origin_cors.reset()
    assert null_origin_cors.apply(_event('null'), RESOLVED) is RESOLVED


def test_an_existing_vary_origin_is_not_repeated():
    null_origin_cors.accept()
    answered = null_origin_cors.apply(_event('null'), {'headers': {'vary': 'origin'}})
    assert answered['headers'] == {'Access-Control-Allow-Origin': 'null', 'Vary': 'origin'}
