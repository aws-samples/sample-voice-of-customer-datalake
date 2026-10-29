"""The gates on `scrapers_handler`'s routes: every write and analyze is admin-only.

OWNER DECISION (2026-10-08), reversing the 2026-10-04 one that opened save and
analyze to every user: `POST /scrapers` (save — create AND update),
`POST /scrapers/analyze-url`, `DELETE /scrapers/<id>` and `POST /scrapers/<id>/run`
are admin-only; the reads (list, templates, status, runs) stay open. Save still
keeps its input bounds for an admin (`test_scrapers_save_bounds.py`), and an
admin's schedule fields are stored as sent (`TestAnAdminSaveStoresTheScheduleAsSent`).
Delegated callers — MCP tokens and agents — carry no group and are refused
(`TestDelegatedCallersAreNotAdmin`). The measurements quoted further down describe
the state BEFORE round 1 gated the writes; they are kept because they are why
the writes are gated.

SCOPE, first, because the module name and the URL prefix do not line up: this file
covers `scrapers_handler` ONLY. `/scrapers/*` is served by TWO Lambdas — five more
routes under the same prefix live in `manual_import_handler`
(`/scrapers/manual/parse`, `.../parse/<job_id>`, `.../confirm`, `.../csv-upload`,
`.../json-upload`). Before the owner decision of 2026-10-08 (#242 follow-up) none
of them called `require_admin`; measured then as a caller whose only
`cognito:groups` claim is `users`:

    POST /scrapers/manual/csv-upload → 200, one s3.put_object + one SQS batch
    POST /scrapers/manual/confirm    → 200, one s3.put_object
    POST /scrapers/manual/parse      → 200, one job row + one async invoke

So the nine-route inventory below is NOT an all-clear for the URL prefix, and the
`ast` pass cannot say so on its own: it parses one module, and no parse of one
module can notice a sibling serving the same prefix. `TestTheInventoryIsOneHandlers`
asserts the boundary explicitly so a reader inherits a known scope rather than a
false one.

Those five are now admin-only too, by that owner decision: importing content
(manual paste, CSV, JSON — and S3 import in `s3_import_handler`) is an
administrator's action. They are gated differently from the nine here — by ONE
resolver middleware in `manual_import_handler` (`shared.api.admins_only`) rather than a call
in each route body — which is why `TestTheInventoryIsOneHandlers` pins the
middleware, and `test_import_admin_gates.py` asserts the behaviour.

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
      403 AND that the secret was neither read nor written: a 403 with the write
      already done would satisfy a status-code-only check.

  TestAnAdminSaveStoresTheScheduleAsSent
    — re-introduces a schedule rewrite: an admin's `enabled` / `frequency_minutes`
      must land exactly as sent, on a create and on an edit.

  TestANonAdminCannotAnalyzeAUrl
    — drops `require_admin` from `analyze_url`, or moves it after the fetch:
      asserts no URL check, no fetch and no Bedrock call happened.

  TestDelegatedCallersAreNotAdmin
    — a claims builder that starts forwarding a group: the MCP and agent claims
      are built by the real builders and every admin route must refuse them.

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
    — gates a read. Without it, `require_admin` on all nine routes would satisfy
      every assertion above while blanking the Scrapers page for non-admins.

  TestEveryScraperWriteIsAdminGated::test_the_gate_runs_first
    — moves `require_admin` below a secret read, URL check or fetch.

  TestTheInventoryIsOneHandlers
    — lets a reader take the nine-route inventory for the whole `/scrapers/*`
      prefix. It is not: `manual_import_handler` serves five more, gated by a
      module middleware rather than per route. Pins that module's inventory and
      the middleware, so dropping `app.use(middlewares=[admins_only])` fails here.
"""
import ast
import importlib
import inspect
import json
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest
from assist_worker_fixtures import inline_assist_worker
from integrations_route_ast_fixtures import plain_calls_in, route_functions, route_paths


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

def _stored_configs(mock_put) -> list:
    """The `webscraper_configs` array the one `put_secret_json` call wrote."""
    (_client, _arn, secrets), _ = mock_put.call_args
    return json.loads(secrets['webscraper_configs'])


class TestANonAdminCannotWriteTheSharedSecret:
    """`POST /scrapers` and `DELETE /scrapers/<id>` write the shared secret: admin-only."""

    @patch('scrapers_handler.validate_url')
    @patch('scrapers_handler.put_secret_json')
    @patch('scrapers_handler.secretsmanager')
    def test_a_non_admin_save_is_refused_and_reads_and_writes_no_secret(
        self, mock_secrets, mock_put, mock_validate, api_gateway_event, lambda_context
    ):
        """Owner decision 2026-10-08. Removing the admin gate fails here."""
        from scrapers_handler import lambda_handler

        response = lambda_handler(_non_admin_event(
            api_gateway_event,
            method='POST',
            path='/scrapers',
            body={'scraper': {'id': 'mine', 'name': 'Mine', 'base_url': 'https://reviews.example'}},
        ), lambda_context)

        assert response['statusCode'] == 403, response['body']
        assert json.loads(response['body'])['error'] == 'Admin access required'
        assert mock_secrets.get_secret_value.call_args_list == [], 'the shared secret was read'
        assert mock_put.call_args_list == [], 'the shared secret was written'
        assert mock_validate.call_args_list == [], 'a URL was resolved for a refused caller'

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


@patch('scrapers_handler.validate_url', new=MagicMock(return_value=(True, '')))
@patch('scrapers_handler.put_secret_json')
@patch('scrapers_handler.secretsmanager')
class TestAnAdminSaveStoresTheScheduleAsSent:
    """Only admins save, so nothing rewrites `enabled` / `frequency_minutes` any more."""

    STORED: ClassVar[dict] = {'id': 's1', 'name': 'Old', 'base_url': 'https://a.example', 'enabled': False, 'frequency_minutes': 1440}
    PUSHED: ClassVar[dict] = {'id': 's1', 'name': 'New', 'base_url': 'https://b.example', 'enabled': True, 'frequency_minutes': 15}

    def _save(self, mock_secrets, stored, scraper, event):
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': json.dumps(stored)})
        }
        from scrapers_handler import lambda_handler
        return lambda_handler(event(method='POST', path='/scrapers', body={'scraper': scraper}), MagicMock())

    def test_an_admin_edit_stores_the_schedule_and_the_other_edits_as_sent(
        self, mock_secrets, mock_put, api_gateway_event
    ):
        response = self._save(mock_secrets, [self.STORED], self.PUSHED, api_gateway_event)
        assert response['statusCode'] == 200, response['body']
        [saved] = _stored_configs(mock_put)
        assert saved == self.PUSHED
        assert json.loads(response['body'])['scraper'] == saved

    def test_an_admin_create_stores_the_schedule_as_sent(
        self, mock_secrets, mock_put, api_gateway_event
    ):
        pushed = {**self.PUSHED, 'enabled': False, 'frequency_minutes': 0}
        self._save(mock_secrets, [], pushed, api_gateway_event)
        [saved] = _stored_configs(mock_put)
        assert (saved['enabled'], saved['frequency_minutes']) == (False, 0)

    def test_an_admin_create_without_schedule_fields_stores_none(
        self, mock_secrets, mock_put, api_gateway_event
    ):
        """No default is injected any more: absent stays absent (the ingestor's own default applies)."""
        self._save(mock_secrets, [], {'id': 's2', 'base_url': 'https://a.example'}, api_gateway_event)
        [saved] = _stored_configs(mock_put)
        assert 'enabled' not in saved
        assert 'frequency_minutes' not in saved


class TestANonAdminCannotAnalyzeAUrl:
    """`POST /scrapers/analyze-url` fetches a caller-chosen URL and calls Bedrock."""

    def _analyze(self, event, lambda_context):
        from scrapers_handler import lambda_handler
        return lambda_handler(event(method='POST', path='/scrapers/analyze-url', body={'url': 'https://a.example/'}),
                              lambda_context)

    @patch('shared.converse.converse')
    @patch('scrapers_handler._fetch_html')
    @patch('scrapers_handler.validate_url')
    def test_a_non_admin_analyze_is_refused_with_no_fetch_and_no_model_call(
        self, mock_validate, mock_fetch, mock_converse, api_gateway_event, lambda_context
    ):
        response = self._analyze(lambda **kw: _non_admin_event(api_gateway_event, **kw), lambda_context)

        assert response['statusCode'] == 403, response['body']
        assert mock_validate.call_args_list == [], 'the URL was resolved'
        assert mock_fetch.call_args_list == [], 'the URL was fetched'
        assert mock_converse.call_args_list == [], 'Bedrock was called'

    @patch('shared.converse.converse', return_value='{"container_selector": ".r"}')
    @patch('scrapers_handler._fetch_html', return_value='<html></html>')
    @patch('scrapers_handler.validate_url', new=MagicMock(return_value=(True, '')))
    def test_the_control_an_admin_analyze_fetches_and_asks_the_model(
        self, mock_fetch, mock_converse, api_gateway_event, lambda_context
    ):
        with inline_assist_worker(_handler_module(), lambda_context):
            response = self._analyze(api_gateway_event, lambda_context)

        assert response['statusCode'] == 202, response['body']
        assert len(mock_fetch.call_args_list) == 1
        assert len(mock_converse.call_args_list) == 1


def _mcp_claims() -> dict:
    from shared.mcp_delegate import synthetic_claims
    # Minted by an admin: the token still carries no group.
    return synthetic_claims({'token_id': 'tok-1', 'created_by': 'admin-sub'})


def _agent_claims() -> dict:
    from agents.principal import agent_claims
    return agent_claims({'agent_id': 'agent-1', 'owner_sub': 'admin-sub'}, owner_sub='admin-sub')


ADMIN_ROUTE_REQUESTS = [
    pytest.param('POST', '/scrapers', {'scraper': {'id': 'x', 'base_url': 'https://a.example'}}, None, id='save'),
    pytest.param('POST', '/scrapers/analyze-url', {'url': 'https://a.example/'}, None, id='analyze'),
    pytest.param('DELETE', '/scrapers/x', None, {'scraper_id': 'x'}, id='delete'),
    pytest.param('POST', '/scrapers/x/run', None, {'scraper_id': 'x'}, id='run'),
]


class TestDelegatedCallersAreNotAdmin:
    """MCP tokens and agents reach domain routes with claims the real builders make;
    those carry an empty `cognito:groups`, so every admin-only scraper route refuses
    them even when the token's minter or the agent's owner is an admin."""

    @pytest.mark.parametrize('claims_for', [_mcp_claims, _agent_claims], ids=['mcp', 'agent'])
    @pytest.mark.parametrize(('method', 'path', 'body', 'path_params'), ADMIN_ROUTE_REQUESTS)
    @patch('scrapers_handler.lambda_client')
    @patch('scrapers_handler._fetch_html')
    @patch('scrapers_handler.put_secret_json')
    @patch('scrapers_handler.secretsmanager')
    def test_the_route_refuses_a_delegated_caller(
        self, mock_secrets, mock_put, mock_fetch, mock_lambda,
        method, path, body, path_params, claims_for, api_gateway_event, lambda_context,
    ):
        claims = claims_for()
        assert claims['cognito:groups'] == ''
        from scrapers_handler import lambda_handler

        response = lambda_handler(api_gateway_event(
            method=method, path=path, body=body, path_params=path_params, claims=claims,
        ), lambda_context)

        assert response['statusCode'] == 403, response['body']
        assert mock_secrets.get_secret_value.call_args_list == []
        assert mock_put.call_args_list == []
        assert mock_fetch.call_args_list == []
        assert mock_lambda.invoke.call_args_list == []


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

    Non-vacuity for every case above: `require_admin` on all nine routes would
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

def _route_functions(module=None) -> dict[str, ast.FunctionDef]:
    """Every module-level function carrying an `@app.<method>("<path>")` decorator.

    Same parser as `test_integrations_security.py`'s (both live in
    `integrations_route_ast_fixtures`), deliberately: the two handlers are asserted
    about the same way.

    Takes a module so `TestTheInventoryIsOneHandlers` can point it at
    `manual_import_handler` — the sibling serving the other half of the
    `/scrapers/*` prefix — with the same parser rather than a second one that could
    disagree with this one about what a route is. Defaults to `scrapers_handler`,
    which every other caller means.
    """
    return route_functions(module or _handler_module())


# The admin-only routes (owner decision 2026-10-08): the ones that write a Secrets
# Manager value, invoke the webscraper, or fetch a URL and call Bedrock. Listed
# explicitly because "who may call this route?" is a judgement no parse can make.
SCRAPER_ADMIN_ROUTES = {
    'save_scraper',
    'analyze_url',
    'delete_scraper',
    'run_scraper',
}
SCRAPER_WRITE_ROUTES = SCRAPER_ADMIN_ROUTES

# `manual_import_handler`'s routes, all under `/scrapers/manual/`, and — as of this
# change — the complete set of `/scrapers/*` routes NOT covered by anything else in
# this file. Recorded as data rather than prose so that a change to either the
# inventory or its gate state fails an assertion instead of quietly making the
# scope paragraph in the module docstring wrong. Module level, beside
# SCRAPER_WRITE_ROUTES, because the two are the same kind of thing: a judgement no
# parse can make.
MANUAL_IMPORT_ROUTES = {
    'start_parse',
    'get_parse_status',
    'confirm_import',
    'csv_upload',
    'json_upload',
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
            'analyze_url',
            'get_scrapers_assist_job',
            # 5.47: a read (the app connectors with their Radar brand), open like GET /integrations/<source>/apps.
            'list_app_connectors',
        }, (
            'the route inventory changed; a NEW route must be added to '
            'SCRAPER_ADMIN_ROUTES if it mutates or spends, and will otherwise be '
            'asserted as a read that is deliberately open'
        )

    def test_every_named_write_route_is_a_route_the_parser_found(self):
        """The list above cannot name a function that no longer exists.

        Otherwise renaming a route would silently drop its guard assertion rather
        than failing.
        """
        assert set(_route_functions()) >= SCRAPER_WRITE_ROUTES


def _first_statement_call(node: ast.FunctionDef) -> str | None:
    """The plain function called by the first statement after the docstring, if any."""
    body = node.body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
        body = body[1:]
    first = body[0] if body else None
    if isinstance(first, ast.Expr) and isinstance(first.value, ast.Call) and isinstance(first.value.func, ast.Name):
        return first.value.func.id
    return None


class TestEveryScraperWriteIsAdminGated:
    """Save, analyze, delete and run call require_admin first; the reads do not."""

    @pytest.mark.parametrize('route', sorted(SCRAPER_ADMIN_ROUTES))
    def test_the_route_requires_admin(self, route):
        assert 'require_admin' in plain_calls_in(_route_functions()[route]), (
            f'{route} writes the shared secret, invokes the webscraper or calls '
            'Bedrock with no admin gate'
        )

    @pytest.mark.parametrize('route', sorted(SCRAPER_ADMIN_ROUTES))
    def test_the_gate_runs_first(self, route):
        """Before any secret read, URL check, fetch or model call."""
        assert _first_statement_call(_route_functions()[route]) == 'require_admin'

    def test_the_save_keeps_its_input_bounds_for_an_admin(self):
        """Admin-only does not mean unbounded: a refactor that drops them fails here."""
        calls = plain_calls_in(_route_functions()['save_scraper'])
        assert {'_validated_scraper', '_upserted_configs'} <= calls

    @pytest.mark.parametrize(
        'route',
        sorted(set(_route_functions()) - SCRAPER_WRITE_ROUTES),
    )
    def test_the_read_routes_are_deliberately_not_gated(self, route):
        """States the split as an assertion, so widening it is a choice."""
        assert 'require_admin' not in plain_calls_in(_route_functions()[route]), (
            f'{route} is a read; gating it would blank the Scrapers page for a '
            'non-admin. Move it to SCRAPER_ADMIN_ROUTES if that is intended.'
        )


class TestTheInventoryIsOneHandlers:
    """The nine routes above are `scrapers_handler`'s, not `/scrapers/*`'s.

    Every other assertion in this file is scoped to one module, and nothing in a
    one-module parse can reveal that a SECOND Lambda serves the same URL prefix. A
    reader arriving at `TestScraperRouteCoverageIsComplete` would reasonably read
    its nine-route equality as covering `/scrapers/*`; it does not. These cases
    make the real boundary an assertion rather than a paragraph.
    """

    @staticmethod
    def _manual_import_module():
        import manual_import_handler
        return manual_import_handler

    def test_a_second_handler_serves_the_same_url_prefix(self):
        """The scope claim itself, as data.

        If `manual_import_handler`'s inventory changes, the docstring at the top of
        this file is describing routes that no longer exist and has to be
        re-derived.
        """
        found = set(_route_functions(self._manual_import_module()))
        assert found == MANUAL_IMPORT_ROUTES

        paths = [
            path
            for node in _route_functions(self._manual_import_module()).values()
            for path in route_paths(node)
        ]
        assert all(path.startswith('/scrapers/') for path in paths), (
            'this class exists because those routes share the /scrapers/ prefix; '
            f'they no longer all do: {paths}'
        )

    def test_they_are_gated_by_the_module_middleware_not_per_route(self):
        """The state the docstring above describes, pinned (owner decision 2026-10-08).

        The gate is ONE `app.use(middlewares=[admins_only])` (shared.api) whose body calls
        `require_admin` unconditionally; no route repeats it. Dropping the
        middleware, or emptying it, fails here (and in `test_import_admin_gates.py`).
        """
        module = self._manual_import_module()
        tree = ast.parse(inspect.getsource(module))
        installed = [
            elt.id
            for stmt in tree.body
            if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call)
            and isinstance(stmt.value.func, ast.Attribute) and stmt.value.func.attr == 'use'
            for kw in stmt.value.keywords if kw.arg == 'middlewares' and isinstance(kw.value, ast.List)
            for elt in kw.value.elts if isinstance(elt, ast.Name)
        ]
        assert installed == ['admins_only']
        shared_api = ast.parse(inspect.getsource(importlib.import_module('shared.api')))
        middleware = next(n for n in shared_api.body if isinstance(n, ast.FunctionDef) and n.name == 'admins_only')
        assert 'require_admin' in plain_calls_in(middleware)
        per_route = {
            name
            for name, node in _route_functions(module).items()
            if 'require_admin' in plain_calls_in(node)
        }
        assert per_route == set()

    def test_the_control_the_parser_reaches_that_module_at_all(self):
        """Non-vacuity for the assertion above.

        `gated == set()` passes just as well over an EMPTY parse — a renamed `app`,
        a decorator style change, an import that silently fails. The inventory
        equality in the first case is the real guard; this states the minimum
        directly so the failure names the cause.
        """
        assert len(_route_functions(self._manual_import_module())) == len(MANUAL_IMPORT_ROUTES)
