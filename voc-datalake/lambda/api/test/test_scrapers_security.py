"""Every mutating /scrapers route is admin-gated.

`scrapers_handler` writes the SAME shared API-credentials secret that
`integrations_handler` does — `POST /scrapers` and `DELETE /scrapers/<id>` both
`put_secret_json` it, rewriting `webscraper_configs`, a key the webscraper
ingestor consumes — and `POST /scrapers/<id>/run` invokes that ingestor. None of
its eight routes called `require_admin`. Measured before the fix, as a caller
whose only `cognito:groups` claim is `users`:

    POST   /scrapers          → 200, one put_secret_json
    DELETE /scrapers/x        → 200, one put_secret_json
    POST   /scrapers/x/run    → 200, one lambda:Invoke + one SCRAPER_RUN# row

That state predated the `<source>`-route gating in `integrations_handler`, but
gating only that half left the boundary depending on which HANDLER a write
arrived through rather than on what it changed — the same asymmetry the
`<source>` work closed inside one file, now sitting between two files that write
one secret.

REVERT MAP — each assertion below names the mutation it catches:

  TestANonAdminCannotWriteTheSharedSecret
    — drops `require_admin` from `save_scraper` or `delete_scraper`. Asserts the
      403 AND that `put_secret_json` was never called: a 403 with the write
      already done would satisfy a status-code-only check.

  TestANonAdminCannotTriggerAScraperRun
    — drops `require_admin` from `run_scraper`. Asserts no `lambda:Invoke` and no
      `SCRAPER_RUN#` row, because the invoke is the billed effect and the row is
      what the UI then polls.

  TestEveryScraperWriteIsAdminGated
    — the half that covers a route added LATER. A behavioural case can only speak
      about a route somebody remembered to write it for, and forgetting is the
      whole failure here, so this parses the `@app.<method>` decorators and
      asserts over every route found. Its inventory case is what stops the parse
      silently finding nothing and passing vacuously.

  TestTheReadRoutesStayOpen
    — gates a read. Without it, `require_admin` on all eight routes would satisfy
      every assertion above while blanking the Scrapers page for non-admins.
"""
import ast
import inspect
import json
from unittest.mock import MagicMock, patch

import pytest


def _handler_module():
    import scrapers_handler
    return scrapers_handler


def _non_admin_event(api_gateway_event, **kwargs):
    """An API Gateway event whose only Cognito group is `users`."""
    event = api_gateway_event(**kwargs)
    event['requestContext']['authorizer']['claims']['cognito:groups'] = 'users'
    return event


# ---------------------------------------------------------------------------
# Behavioural half
# ---------------------------------------------------------------------------

class TestANonAdminCannotWriteTheSharedSecret:
    """`POST /scrapers` and `DELETE /scrapers/<id>` write the shared secret."""

    @patch('scrapers_handler.put_secret_json')
    @patch('scrapers_handler.secretsmanager')
    def test_a_non_admin_save_is_refused_and_writes_nothing(
        self, mock_secrets, mock_put, api_gateway_event, lambda_context
    ):
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': '[]'})
        }
        from scrapers_handler import lambda_handler

        response = lambda_handler(_non_admin_event(
            api_gateway_event,
            method='POST',
            path='/scrapers',
            body={'scraper': {'id': 'injected', 'name': 'Injected', 'base_url': 'https://attacker.example'}},
        ), lambda_context)

        assert response['statusCode'] == 403
        # The status code alone would pass if the write happened first.
        assert mock_put.call_args_list == []

    @patch('scrapers_handler.put_secret_json')
    @patch('scrapers_handler.secretsmanager')
    def test_a_non_admin_delete_is_refused_and_writes_nothing(
        self, mock_secrets, mock_put, api_gateway_event, lambda_context
    ):
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': '[{"id": "keep-me"}]'})
        }
        from scrapers_handler import lambda_handler

        response = lambda_handler(_non_admin_event(
            api_gateway_event,
            method='DELETE',
            path='/scrapers/keep-me',
            path_params={'scraper_id': 'keep-me'},
        ), lambda_context)

        assert response['statusCode'] == 403
        assert mock_put.call_args_list == []

    @patch('scrapers_handler.put_secret_json')
    @patch('scrapers_handler.secretsmanager')
    def test_the_control_an_admin_save_still_writes(
        self, mock_secrets, mock_put, api_gateway_event, lambda_context
    ):
        """Non-vacuity: without this, refusing EVERY caller would pass the above."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': '[]'})
        }
        from scrapers_handler import lambda_handler

        response = lambda_handler(api_gateway_event(
            method='POST',
            path='/scrapers',
            body={'scraper': {'id': 'legit', 'name': 'Legit', 'base_url': 'https://example.com'}},
        ), lambda_context)

        assert response['statusCode'] == 200
        assert len(mock_put.call_args_list) == 1


class TestANonAdminCannotTriggerAScraperRun:
    """`POST /scrapers/<id>/run` invokes the webscraper — a billed fetch."""

    @patch('scrapers_handler.require_webscraper_function')
    @patch('scrapers_handler.lambda_client')
    @patch('scrapers_handler.get_aggregates_table')
    def test_a_non_admin_run_is_refused_and_invokes_nothing(
        self, mock_get_table, mock_lambda, mock_require_fn, api_gateway_event, lambda_context
    ):
        table = MagicMock()
        mock_get_table.return_value = table
        mock_require_fn.return_value = 'test-webscraper-function'
        from scrapers_handler import lambda_handler

        response = lambda_handler(_non_admin_event(
            api_gateway_event,
            method='POST',
            path='/scrapers/some-scraper/run',
            path_params={'scraper_id': 'some-scraper'},
        ), lambda_context)

        assert response['statusCode'] == 403
        assert mock_lambda.invoke.call_args_list == [], 'a billed third-party fetch was issued'
        assert table.put_item.call_args_list == [], 'a SCRAPER_RUN# row was written'

    @patch('scrapers_handler.require_webscraper_function')
    @patch('scrapers_handler.lambda_client')
    @patch('scrapers_handler.get_aggregates_table')
    def test_the_control_an_admin_run_still_invokes(
        self, mock_get_table, mock_lambda, mock_require_fn, api_gateway_event, lambda_context
    ):
        table = MagicMock()
        mock_get_table.return_value = table
        mock_require_fn.return_value = 'test-webscraper-function'
        from scrapers_handler import lambda_handler

        response = lambda_handler(api_gateway_event(
            method='POST',
            path='/scrapers/some-scraper/run',
            path_params={'scraper_id': 'some-scraper'},
        ), lambda_context)

        assert response['statusCode'] == 200
        assert len(mock_lambda.invoke.call_args_list) == 1


class TestTheReadRoutesStayOpen:
    """The reads are deliberately ungated, and that is asserted, not assumed.

    Non-vacuity for every case above: `require_admin` on all eight routes would
    satisfy all of them. It would also empty the Scrapers page for a non-admin,
    which is why the split is read/write rather than route-by-route.
    """

    @patch('scrapers_handler.secretsmanager')
    def test_a_non_admin_can_list_scrapers(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': '[{"id": "one"}]'})
        }
        from scrapers_handler import lambda_handler

        response = lambda_handler(_non_admin_event(
            api_gateway_event, method='GET', path='/scrapers',
        ), lambda_context)

        assert response['statusCode'] == 200
        assert json.loads(response['body'])['scrapers'] == [{'id': 'one'}]

    @patch('scrapers_handler.get_aggregates_table')
    def test_a_non_admin_can_read_a_run_status(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        table = MagicMock()
        table.query.return_value = {'Items': []}
        mock_get_table.return_value = table
        from scrapers_handler import lambda_handler

        response = lambda_handler(_non_admin_event(
            api_gateway_event,
            method='GET',
            path='/scrapers/one/status',
            path_params={'scraper_id': 'one'},
        ), lambda_context)

        assert response['statusCode'] == 200


# ---------------------------------------------------------------------------
# `ast` half — covers a route added later
# ---------------------------------------------------------------------------

def _route_path_of(decorator: ast.expr) -> str | None:
    """The literal path of an `@app.get("/x")`-style decorator, else None.

    Matches on the `app` receiver and a string first argument, so
    `@tracer.capture_method` (no arguments) is ignored without needing a list of
    method names to exclude. Same shape as `test_integrations_security.py`'s
    parser, deliberately: the two handlers are asserted about the same way.
    """
    if not isinstance(decorator, ast.Call):
        return None
    func = decorator.func
    if not isinstance(func, ast.Attribute):
        return None
    if not isinstance(func.value, ast.Name) or func.value.id != 'app':
        return None
    if not decorator.args or not isinstance(decorator.args[0], ast.Constant):
        return None
    path = decorator.args[0].value
    return path if isinstance(path, str) else None


def _route_functions() -> dict[str, ast.FunctionDef]:
    """Every module-level function carrying an `@app.<method>("<path>")` decorator.

    Parsed rather than read off the resolver, because the resolver records a
    route's path and handler but not the guards inside the handler's body, which
    is the thing under test.
    """
    tree = ast.parse(inspect.getsource(_handler_module()))
    return {
        node.name: node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and any(_route_path_of(d) for d in node.decorator_list)
    }


def _calls_in(node: ast.FunctionDef) -> set[str]:
    """Names of the plain-function calls anywhere in *node*'s body."""
    return {
        call.func.id
        for call in ast.walk(node)
        if isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
    }


# The routes that MUTATE — a Secrets Manager value or a webscraper invocation.
# Listed explicitly because "does this route write?" is a judgement no parse can
# make, and because the read/write split is the whole argument for gating three
# of the eight rather than all of them.
SCRAPER_WRITE_ROUTES = {
    'save_scraper',
    'delete_scraper',
    'run_scraper',
}


class TestScraperRouteCoverageIsComplete:
    """Non-vacuity for the class below.

    Its assertion is "for each route found", so a parse that finds NOTHING — a
    rename of `app`, a move to a router object, a decorator style change — would
    pass over an empty set. These cases make that loud, and pin the inventory the
    list above is asserted against.
    """

    def test_the_parser_finds_every_scraper_route(self):
        assert set(_route_functions()) == {
            'list_scrapers',
            'save_scraper',
            'delete_scraper',
            'get_templates',
            'run_scraper',
            'get_scraper_status',
            'get_scraper_runs',
            'analyze_url',
        }, (
            'the route inventory changed; a NEW route must be added to '
            'SCRAPER_WRITE_ROUTES if it mutates, and will otherwise be asserted '
            'as a read that is deliberately open'
        )

    def test_every_named_write_route_is_a_route_the_parser_found(self):
        """The list above cannot name a function that no longer exists.

        Otherwise renaming a route would silently drop its guard assertion rather
        than failing.
        """
        assert SCRAPER_WRITE_ROUTES <= set(_route_functions())


class TestEveryScraperWriteIsAdminGated:
    """Each mutating route calls require_admin; each read deliberately does not."""

    @pytest.mark.parametrize('route', sorted(SCRAPER_WRITE_ROUTES))
    def test_the_route_requires_admin(self, route):
        assert 'require_admin' in _calls_in(_route_functions()[route]), (
            f'{route} mutates the shared secret or invokes the webscraper with no '
            'admin gate'
        )

    @pytest.mark.parametrize(
        'route',
        sorted(set(_route_functions()) - SCRAPER_WRITE_ROUTES),
    )
    def test_the_read_routes_are_deliberately_not_gated(self, route):
        """States the split as an assertion, so widening it is a choice.

        `analyze_url` is here rather than in the write set on purpose: it fetches
        a URL the caller supplies and asks Bedrock about it, but persists nothing
        — and `validate_url` already bounds the fetch (SSRF). If a future change
        makes it store something, this fails and forces the classification.
        """
        assert 'require_admin' not in _calls_in(_route_functions()[route]), (
            f'{route} is a read; gating it would blank the Scrapers page for a '
            'non-admin. Move it to SCRAPER_WRITE_ROUTES if that is intended.'
        )
