"""The gates on `scrapers_handler`'s routes: delete and run are admin-only, save is open.

OWNER DECISION (2026-10-04), which supersedes the "every write is admin-gated"
history recorded below: `POST /scrapers` (save — create AND update) is open to
every authenticated user; `DELETE /scrapers/<id>` and `POST /scrapers/<id>/run`
stay admin-only. The open save is bounded instead (`test_scrapers_save_bounds.py`),
and a non-admin still cannot set the schedule fields (`TestANonAdminSaveKeepsTheSchedule`
below). The measurements quoted further down describe the state BEFORE round 1
gated all three; they are kept because they are why delete and run stay gated.

SCOPE, first, because the module name and the URL prefix do not line up: this file
covers `scrapers_handler` ONLY. `/scrapers/*` is served by TWO Lambdas — five more
routes under the same prefix live in `manual_import_handler`
(`/scrapers/manual/parse`, `.../parse/<job_id>`, `.../confirm`, `.../csv-upload`,
`.../json-upload`), and none of them calls `require_admin`. Measured as a caller
whose only `cognito:groups` claim is `users`:

    POST /scrapers/manual/csv-upload → 200, one s3.put_object + one SQS batch
    POST /scrapers/manual/confirm    → 200, one s3.put_object
    POST /scrapers/manual/parse      → 200, one job row + one async invoke

So the eight-route inventory below is NOT an all-clear for the URL prefix, and the
`ast` pass cannot say so on its own: it parses one module, and no parse of one
module can notice a sibling serving the same prefix. `TestTheInventoryIsOneHandlers`
asserts the boundary explicitly so a reader inherits a known scope rather than a
false one.

Those five are left ungated deliberately, as a different question rather than the
same gap: they write feedback CONTENT into the ingestion pipeline (S3 plus the
enrichment queue that Bedrock drains) and reach neither the shared API-credentials
secret nor any plugin resource — which is the whole basis on which the three routes
here were gated. Every content-ingestion route in this tree is open to an
authenticated user on that basis (`POST /feedback-forms`,
`POST /s3-import/upload-url`, both verified 200 as `users`), so gating only the
manual-import three would create exactly the arbitrary boundary this change closed
for the secret — one that depends on which page a write arrived from. Whether
content ingestion as a whole should be admin-only is a product decision across
several handlers and their pages, not a rider on a secret-isolation fix.

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
    — drops `require_admin` from `delete_scraper`. Asserts the 403 AND that
      `put_secret_json` was never called: a 403 with the write already done would
      satisfy a status-code-only check. Also pins the opposite for save: re-adding
      `require_admin` to `save_scraper` fails `test_a_non_admin_save_is_accepted`.

  TestANonAdminSaveKeepsTheSchedule
    — drops `_apply_schedule_policy` (or makes it trust the caller): a non-admin
      could then switch a scraper on or make it fetch every 15 minutes.

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

  TestTheInventoryIsOneHandlers
    — lets a reader take the eight-route inventory for the whole `/scrapers/*`
      prefix. It is not: `manual_import_handler` serves five more, ungated. Pins
      that module's own inventory too, so if one of ITS routes later grows a
      `require_admin` — making the recorded scope stale — this fails and the
      docstring above has to be re-derived rather than left contradicting the code.
"""
import ast
import json
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest
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
    """`DELETE /scrapers/<id>` writes the shared secret and stays admin-only;
    `POST /scrapers` writes it too but is open (owner decision)."""

    @patch('scrapers_handler.validate_url', new=MagicMock(return_value=(True, '')))
    @patch('scrapers_handler.put_secret_json')
    @patch('scrapers_handler.secretsmanager')
    def test_a_non_admin_save_is_accepted(
        self, mock_secrets, mock_put, api_gateway_event, lambda_context
    ):
        """Owner decision: any user may create a scraper. Re-adding the admin gate fails here."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': '[]'})
        }
        from scrapers_handler import lambda_handler

        response = lambda_handler(_non_admin_event(
            api_gateway_event,
            method='POST',
            path='/scrapers',
            body={'scraper': {'id': 'mine', 'name': 'Mine', 'base_url': 'https://reviews.example'}},
        ), lambda_context)

        assert response['statusCode'] == 200, response['body']
        assert [c['id'] for c in _stored_configs(mock_put)] == ['mine']

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
class TestANonAdminSaveKeepsTheSchedule:
    """`enabled` / `frequency_minutes` decide when the scheduled ingestor fetches a
    scraper, so only an admin sets them — the same reason run stays admin-only."""

    STORED: ClassVar[dict] = {'id': 's1', 'name': 'Old', 'base_url': 'https://a.example', 'enabled': False, 'frequency_minutes': 1440}
    PUSHED: ClassVar[dict] = {'id': 's1', 'name': 'New', 'base_url': 'https://b.example', 'enabled': True, 'frequency_minutes': 15}

    def _save(self, mock_secrets, stored, scraper, event):
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': json.dumps(stored)})
        }
        from scrapers_handler import lambda_handler
        return lambda_handler(event(method='POST', path='/scrapers', body={'scraper': scraper}), MagicMock())

    def test_a_non_admin_edit_keeps_the_stored_schedule_and_the_other_edits(
        self, mock_secrets, mock_put, api_gateway_event
    ):
        response = self._save(
            mock_secrets, [self.STORED], self.PUSHED,
            lambda **kw: _non_admin_event(api_gateway_event, **kw),
        )
        assert response['statusCode'] == 200, response['body']
        [saved] = _stored_configs(mock_put)
        assert (saved['enabled'], saved['frequency_minutes']) == (False, 1440)
        assert (saved['name'], saved['base_url']) == ('New', 'https://b.example')
        assert json.loads(response['body'])['scraper'] == saved

    def test_a_non_admin_edit_of_a_legacy_config_leaves_the_schedule_absent(
        self, mock_secrets, mock_put, api_gateway_event
    ):
        """Absent stored fields stay absent, so the ingestor's own defaults keep applying."""
        legacy = {'id': 's1', 'base_url': 'https://a.example'}
        self._save(mock_secrets, [legacy], self.PUSHED, lambda **kw: _non_admin_event(api_gateway_event, **kw))
        [saved] = _stored_configs(mock_put)
        assert 'enabled' not in saved
        assert 'frequency_minutes' not in saved

    def test_a_non_admin_create_gets_the_default_schedule(
        self, mock_secrets, mock_put, api_gateway_event
    ):
        self._save(mock_secrets, [], self.PUSHED, lambda **kw: _non_admin_event(api_gateway_event, **kw))
        [saved] = _stored_configs(mock_put)
        assert (saved['enabled'], saved['frequency_minutes']) == (True, 1440)

    def test_the_control_an_admin_sets_the_schedule(
        self, mock_secrets, mock_put, api_gateway_event
    ):
        """Non-vacuity: ignoring the schedule for EVERY caller would pass the above."""
        self._save(mock_secrets, [self.STORED], self.PUSHED, api_gateway_event)
        [saved] = _stored_configs(mock_put)
        assert (saved['enabled'], saved['frequency_minutes']) == (True, 15)


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


# The routes that MUTATE — a Secrets Manager value or a webscraper invocation —
# split by the owner decision of 2026-10-04. Listed explicitly because "does this
# route write, and who may?" is a judgement no parse can make.
SCRAPER_ADMIN_ROUTES = {
    'delete_scraper',
    'run_scraper',
}
# Writes the shared secret but open to every authenticated user (owner decision);
# bounded by `_validated_scraper` / `_upserted_configs` / `_apply_schedule_policy`.
SCRAPER_OPEN_WRITE_ROUTES = {
    'save_scraper',
}
SCRAPER_WRITE_ROUTES = SCRAPER_ADMIN_ROUTES | SCRAPER_OPEN_WRITE_ROUTES

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
            'get_scraper_runs',
            'analyze_url',
        }, (
            'the route inventory changed; a NEW route must be added to '
            'SCRAPER_ADMIN_ROUTES or SCRAPER_OPEN_WRITE_ROUTES if it mutates, and '
            'will otherwise be asserted as a read that is deliberately open'
        )

    def test_every_named_write_route_is_a_route_the_parser_found(self):
        """The list above cannot name a function that no longer exists.

        Otherwise renaming a route would silently drop its guard assertion rather
        than failing.
        """
        assert set(_route_functions()) >= SCRAPER_WRITE_ROUTES


class TestEveryScraperWriteIsAdminGated:
    """Delete and run call require_admin; save and the reads deliberately do not."""

    @pytest.mark.parametrize('route', sorted(SCRAPER_ADMIN_ROUTES))
    def test_the_route_requires_admin(self, route):
        assert 'require_admin' in plain_calls_in(_route_functions()[route]), (
            f'{route} deletes from the shared secret or invokes the webscraper with '
            'no admin gate'
        )

    @pytest.mark.parametrize('route', sorted(SCRAPER_OPEN_WRITE_ROUTES))
    def test_the_open_write_is_bounded_not_gated(self, route):
        """Owner decision: save is open. What makes that safe is the bounds, so a
        refactor that drops them fails here rather than silently."""
        calls = plain_calls_in(_route_functions()[route])
        assert 'require_admin' not in calls, f'{route} is open by owner decision (2026-10-04)'
        assert {'_validated_scraper', '_upserted_configs'} <= calls

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
        assert 'require_admin' not in plain_calls_in(_route_functions()[route]), (
            f'{route} is a read; gating it would blank the Scrapers page for a '
            'non-admin. Move it to SCRAPER_WRITE_ROUTES if that is intended.'
        )


class TestTheInventoryIsOneHandlers:
    """The eight routes above are `scrapers_handler`'s, not `/scrapers/*`'s.

    Every other assertion in this file is scoped to one module, and nothing in a
    one-module parse can reveal that a SECOND Lambda serves the same URL prefix. A
    reader arriving at `TestScraperRouteCoverageIsComplete` would reasonably read
    its eight-route equality as covering `/scrapers/*`; it does not. These cases
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

    def test_none_of_them_is_admin_gated_and_that_is_recorded_not_assumed(self):
        """The state the docstring above describes, pinned.

        Deliberately asserts the ABSENCE. Gating those routes may well be right —
        they write feedback content into the pipeline — but it is a decision about
        content ingestion across several handlers and their pages, not a rider on a
        secret-isolation fix. This is what stops that decision being made silently:
        adding a gate to one of them fails here, and whoever adds it has to update
        the scope paragraph rather than leave this file asserting a stale claim.
        """
        gated = {
            name
            for name, node in _route_functions(self._manual_import_module()).items()
            if 'require_admin' in plain_calls_in(node)
        }
        assert gated == set(), (
            f'{sorted(gated)} is now admin-gated. That may be correct — but the '
            'scope paragraph in this module docstring says the manual-import '
            'routes are ungated, and it is now wrong. Revise it, and consider '
            'whether the remaining manual-import routes should follow.'
        )

    def test_the_control_the_parser_reaches_that_module_at_all(self):
        """Non-vacuity for the assertion above.

        `gated == set()` passes just as well over an EMPTY parse — a renamed `app`,
        a decorator style change, an import that silently fails. The inventory
        equality in the first case is the real guard; this states the minimum
        directly so the failure names the cause.
        """
        assert len(_route_functions(self._manual_import_module())) == len(MANUAL_IMPORT_ROUTES)
