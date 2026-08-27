"""
Tests for scrapers_handler.py - /scrapers/* endpoints.
Manages web scraper configurations and runs.

The URL-safety tests here cover this handler's USE of the shared outbound-URL
policy — which routes call it, and what the caller sees when it refuses. The
policy itself (address classification, resolution, redirect hops) is tested once,
in `lambda/shared/test/test_outbound_url_policy.py`; issue #244 asked for one
implementation, so this file must not grow a second set of address cases.

Resolution is patched at `shared.http_utils.socket.getaddrinfo` — the shared
module's import boundary — because that is where the handler's check now lives.
A test patching `scrapers_handler.socket` would pass against a handler that had
no check at all: this module no longer imports socket.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
from requests.structures import CaseInsensitiveDict

PUBLIC_ADDRINFO = [(2, 1, 6, '', ('93.184.216.34', 80))]
PRIVATE_ADDRINFO = [(2, 1, 6, '', ('10.1.2.3', 80))]


def _http_response(status: int, *, location: str | None = None, text: str = '') -> MagicMock:
    """A requests.Response double for `shared.http_utils.requests.request`."""
    response = MagicMock()
    response.status_code = status
    response.reason = 'reason'
    # CaseInsensitiveDict, not a plain dict: a real requests.Response is one,
    # and a real server may send `location:` lowercase — a plain-dict double
    # would pass against code reading from a case-SENSITIVE mapping.
    response.headers = CaseInsensitiveDict({'Location': location} if location else {})
    response.text = text
    return response


class TestSaveScraperRejectsInternalDestinations:
    """
    POST /scrapers applies the outbound-URL policy on WRITE (issue #244).

    That was the hole: the check ran only on the analyze/preview route, nothing
    forced a preview, and the scheduled ingestor then fetched whatever was
    saved. Removing the `validate_scraper_destinations(scraper)` call from
    `save_scraper` turns every assertion in this class from 400 into 200.

    `TestSaveScraper` below is the positive control — a public config still
    saves — so a validator that refused everything could not pass this file.
    """

    @staticmethod
    def _post(api_gateway_event, lambda_context, scraper):
        from scrapers_handler import lambda_handler

        return lambda_handler(
            api_gateway_event(method='POST', path='/scrapers', body={'scraper': scraper}),
            lambda_context,
        )

    @pytest.mark.parametrize('base_url', [
        'http://127.0.0.1/admin',                    # loopback
        'http://10.1.2.3/reviews',                   # private IPv4
        'http://169.254.169.254/latest/meta-data/',  # instance metadata
        'http://[::1]/admin',                        # loopback IPv6
        'http://[fd00::1]/reviews',                  # unique-local IPv6
        'ftp://example.com/reviews',                 # unsupported scheme
    ])
    @patch('scrapers_handler.secretsmanager')
    def test_refuses_a_config_whose_base_url_is_internal(
        self, mock_secrets, base_url, api_gateway_event, lambda_context
    ):
        response = self._post(
            api_gateway_event, lambda_context,
            {'id': 's1', 'name': 'Internal', 'base_url': base_url},
        )

        assert response['statusCode'] == 400, response['body']
        assert 'base_url' in json.loads(response['body'])['error']
        # Nothing persisted — refused before the secret was even read.
        mock_secrets.put_secret_value.assert_not_called()

    @patch('scrapers_handler.secretsmanager')
    def test_refuses_an_internal_url_in_the_extra_urls_list(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """`urls` reaches the ingestor exactly like `base_url` does."""
        response = self._post(
            api_gateway_event, lambda_context,
            {
                'id': 's1', 'name': 'Mixed', 'base_url': '',
                'urls': ['http://192.168.0.10/reviews'],
            },
        )

        assert response['statusCode'] == 400, response['body']
        assert 'urls' in json.loads(response['body'])['error']
        mock_secrets.put_secret_value.assert_not_called()

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('scrapers_handler.secretsmanager')
    def test_refuses_a_public_looking_host_that_resolves_internally(
        self, mock_secrets, mock_resolve, api_gateway_event, lambda_context
    ):
        """The gap a string denylist cannot close: the name looks fine, the answer does not."""
        mock_resolve.return_value = PRIVATE_ADDRINFO

        response = self._post(
            api_gateway_event, lambda_context,
            {'id': 's1', 'name': 'Sneaky', 'base_url': 'https://reviews.example.com/'},
        )

        assert response['statusCode'] == 400, response['body']
        assert 'internal/private' in json.loads(response['body'])['error']
        mock_secrets.put_secret_value.assert_not_called()

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('scrapers_handler.secretsmanager')
    def test_refuses_a_host_whose_answers_mix_public_and_private(
        self, mock_secrets, mock_resolve, api_gateway_event, lambda_context
    ):
        mock_resolve.return_value = PUBLIC_ADDRINFO + PRIVATE_ADDRINFO

        response = self._post(
            api_gateway_event, lambda_context,
            {'id': 's1', 'name': 'Mixed DNS', 'base_url': 'https://reviews.example.com/'},
        )

        assert response['statusCode'] == 400, response['body']
        mock_secrets.put_secret_value.assert_not_called()

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('scrapers_handler.secretsmanager')
    def test_refuses_a_host_that_will_not_resolve(
        self, mock_secrets, mock_resolve, api_gateway_event, lambda_context
    ):
        """Fails closed: an unresolvable host is a 400, not a saved config."""
        import socket

        mock_resolve.side_effect = socket.gaierror('nope')

        response = self._post(
            api_gateway_event, lambda_context,
            {'id': 's1', 'name': 'Unresolvable', 'base_url': 'https://nope.example/'},
        )

        assert response['statusCode'] == 400, response['body']
        assert 'resolve' in json.loads(response['body'])['error'].lower()
        mock_secrets.put_secret_value.assert_not_called()

    @patch('scrapers_handler.secretsmanager')
    def test_refuses_a_scraper_that_is_not_an_object(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """A list would sail past `.get()`-based validation as "no URLs to check"."""
        response = self._post(
            api_gateway_event, lambda_context, ['http://169.254.169.254/'],
        )

        assert response['statusCode'] == 400, response['body']
        mock_secrets.put_secret_value.assert_not_called()

    @pytest.mark.parametrize('base_url', [
        'http://' + 'a' * 64 + '.example.com/x',  # label longer than 63 bytes
        'http://a..b.com/x',                      # empty label
    ])
    @patch('scrapers_handler.secretsmanager')
    def test_answers_400_for_a_hostname_the_idna_codec_rejects(
        self, mock_secrets, base_url, api_gateway_event, lambda_context
    ):
        """
        `getaddrinfo` raises UnicodeEncodeError — not an OSError — for these,
        before resolving. It escaped the policy unwrapped, and because the check
        deliberately runs OUTSIDE `save_scraper`'s except-Exception wrapper,
        nothing caught it: the route answered with an unhandled invocation error
        rather than the actionable 400 it is built around. The resolver is not
        mocked here, because the codec is what raises.
        """
        response = self._post(
            api_gateway_event, lambda_context,
            {'id': 's1', 'name': 'Bad label', 'base_url': base_url},
        )

        assert response['statusCode'] == 400, response['body']
        assert 'base_url' in json.loads(response['body'])['error']
        mock_secrets.put_secret_value.assert_not_called()

    @pytest.mark.parametrize(('scraper', 'named'), [
        ({'urls': 'https://example.com/'}, 'urls'),   # a string where a list belongs
        ({'urls': [{'u': 'x'}]}, 'urls'),             # a dict inside the list
        ({'base_url': ['https://example.com/']}, 'base_url'),  # the mirror case
    ])
    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('scrapers_handler.secretsmanager')
    def test_names_the_field_when_it_holds_the_wrong_type(
        self, mock_secrets, mock_resolve, scraper, named, api_gateway_event, lambda_context
    ):
        """
        Mirrors `integrations_handler.update_credentials`' per-value type check.
        Both of these were already refused, but for the wrong reason: a bare
        string validated as one URL, and a dict reached the policy and came back
        as 'URL is required'.
        """
        response = self._post(
            api_gateway_event, lambda_context, {'id': 's1', 'name': 'Wrong type', **scraper},
        )

        assert response['statusCode'] == 400, response['body']
        assert named in json.loads(response['body'])['error']
        mock_resolve.assert_not_called()
        mock_secrets.put_secret_value.assert_not_called()

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('scrapers_handler.secretsmanager')
    def test_refuses_more_urls_than_one_invocation_can_resolve(
        self, mock_secrets, mock_resolve, api_gateway_event, lambda_context
    ):
        """
        Each URL costs a synchronous getaddrinfo, and this route answers through
        API Gateway's 29 s integration limit — so an unbounded list is a 504 with
        nothing saved rather than a 400 the caller can act on.
        """
        from shared.scraper_urls import MAX_SCRAPER_URLS

        mock_resolve.return_value = PUBLIC_ADDRINFO

        response = self._post(
            api_gateway_event, lambda_context,
            {
                'id': 's1', 'name': 'Too many',
                'urls': [f'https://example.com/{i}' for i in range(MAX_SCRAPER_URLS + 1)],
            },
        )

        assert response['statusCode'] == 400, response['body']
        assert 'urls' in json.loads(response['body'])['error']
        mock_secrets.put_secret_value.assert_not_called()

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('scrapers_handler.secretsmanager')
    def test_saves_a_config_at_the_url_limit(
        self, mock_secrets, mock_resolve, api_gateway_event, lambda_context
    ):
        """Positive control for the bound: exactly at the limit still saves."""
        from shared.scraper_urls import MAX_SCRAPER_URLS

        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': '[]'})
        }
        mock_resolve.return_value = PUBLIC_ADDRINFO

        response = self._post(
            api_gateway_event, lambda_context,
            {
                'id': 's1', 'name': 'At the limit',
                'urls': [f'https://example.com/{i}' for i in range(MAX_SCRAPER_URLS)],
            },
        )

        assert response['statusCode'] == 200, response['body']

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('scrapers_handler.secretsmanager')
    def test_saves_a_config_with_no_urls_configured_yet(
        self, mock_secrets, mock_resolve, api_gateway_event, lambda_context
    ):
        """
        Positive control for the empty case: the editor ships `base_url: ''` and
        `urls: []` for a fresh scraper, so refusing that would break the create
        flow while still passing every "refuses" test above.
        """
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': '[]'})
        }

        response = self._post(
            api_gateway_event, lambda_context,
            {'id': 's1', 'name': 'Draft', 'base_url': '', 'urls': []},
        )

        assert response['statusCode'] == 200, response['body']
        mock_resolve.assert_not_called()

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('scrapers_handler.secretsmanager')
    def test_saves_a_config_whose_urls_are_all_public(
        self, mock_secrets, mock_resolve, api_gateway_event, lambda_context
    ):
        """The main positive control: ordinary public http and https still save."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': '[]'})
        }
        mock_resolve.return_value = PUBLIC_ADDRINFO

        response = self._post(
            api_gateway_event, lambda_context,
            {
                'id': 's1', 'name': 'Public',
                'base_url': 'https://reviews.example.com/products',
                'urls': ['http://reviews.example.com/page/2'],
            },
        )

        assert response['statusCode'] == 200, response['body']
        assert json.loads(response['body'])['success'] is True
        saved = json.loads(
            json.loads(mock_secrets.put_secret_value.call_args.kwargs['SecretString'])
            ['webscraper_configs']
        )
        assert saved[0]['base_url'] == 'https://reviews.example.com/products'


class TestListScrapers:
    """Tests for GET /scrapers endpoint."""

    @patch('scrapers_handler.secretsmanager')
    def test_returns_scraper_configurations(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Returns list of scraper configurations from Secrets Manager."""
        # Arrange
        scrapers = [
            {'id': 'scraper-1', 'name': 'Test Scraper', 'url': 'https://example.com'},
            {'id': 'scraper-2', 'name': 'Another Scraper', 'url': 'https://test.com'}
        ]
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': json.dumps(scrapers)})
        }
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/scrapers')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert len(body['scrapers']) == 2
        assert body['scrapers'][0]['id'] == 'scraper-1'

    @patch('scrapers_handler.secretsmanager')
    def test_returns_empty_list_when_no_scrapers(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Returns empty array when no scrapers configured."""
        # Arrange
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({})
        }
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/scrapers')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['scrapers'] == []


class TestSaveScraper:
    """Tests for POST /scrapers endpoint."""

    @patch('scrapers_handler.secretsmanager')
    def test_saves_new_scraper_configuration(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Saves new scraper configuration to Secrets Manager."""
        # Arrange
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': '[]'})
        }
        mock_secrets.put_secret_value.return_value = {}
        
        new_scraper = {
            'id': 'new-scraper',
            'name': 'New Scraper',
            'url': 'https://newsite.com',
            'extraction_method': 'css'
        }
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/scrapers',
            body={'scraper': new_scraper}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['scraper']['id'] == 'new-scraper'

    @patch('scrapers_handler.secretsmanager')
    def test_updates_existing_scraper(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Updates existing scraper configuration."""
        # Arrange
        existing_scrapers = [{'id': 'existing', 'name': 'Old Name', 'url': 'https://old.com'}]
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': json.dumps(existing_scrapers)})
        }
        mock_secrets.put_secret_value.return_value = {}
        
        updated_scraper = {'id': 'existing', 'name': 'New Name', 'url': 'https://new.com'}
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/scrapers',
            body={'scraper': updated_scraper}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['scraper']['name'] == 'New Name'

    @patch('scrapers_handler.secretsmanager')
    def test_returns_error_when_no_scraper_provided(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Returns error when scraper config not provided."""
        # Arrange
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/scrapers', body={'scraper': None})
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert - now returns 400 with error key
        assert response['statusCode'] == 400
        assert 'error' in body


class TestSecretSizeGuardSurfacesAs400:
    """
    An over-limit secret must reach the caller as a 400, on BOTH write routes.

    put_secret_json refuses a serialized secret over the Secrets Manager limit by
    raising ValidationError. Each route wraps its work in `except Exception ->
    ServiceError`, so without an explicit re-raise that actionable 400 is
    flattened into an opaque 500.

    delete_scraper matters even though a delete only ever SHRINKS this key: the
    secret can already be over the limit from before the guard existed, and the
    caller hitting that is precisely the one deleting to get back under it.
    """

    @staticmethod
    def _oversized_secret() -> dict:
        from shared.aws import SECRET_STRING_MAX_BYTES

        return {
            'webscraper_configs': json.dumps([{'id': 'delete-this', 'name': 'D'}]),
            'other_feature_blob': 'y' * SECRET_STRING_MAX_BYTES,
        }

    @patch('scrapers_handler.secretsmanager')
    def test_save_returns_400_not_500(self, mock_secrets, api_gateway_event, lambda_context):
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps(self._oversized_secret())
        }
        from scrapers_handler import lambda_handler

        response = lambda_handler(
            api_gateway_event(
                method='POST', path='/scrapers',
                body={'scraper': {'id': 's1', 'name': 'New'}},
            ),
            lambda_context,
        )
        assert response['statusCode'] == 400, response['body']
        mock_secrets.put_secret_value.assert_not_called()

    @patch('scrapers_handler.secretsmanager')
    def test_delete_returns_400_not_500(self, mock_secrets, api_gateway_event, lambda_context):
        """Regression: removing `except ValidationError: raise` makes this a 500."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps(self._oversized_secret())
        }
        from scrapers_handler import lambda_handler

        response = lambda_handler(
            api_gateway_event(
                method='DELETE', path='/scrapers/delete-this',
                path_params={'scraper_id': 'delete-this'},
            ),
            lambda_context,
        )
        assert response['statusCode'] == 400, response['body']
        mock_secrets.put_secret_value.assert_not_called()


class TestDeleteScraper:
    """Tests for DELETE /scrapers/<scraper_id> endpoint."""

    @patch('scrapers_handler.secretsmanager')
    def test_deletes_scraper_successfully(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Deletes scraper configuration from Secrets Manager."""
        # Arrange
        existing_scrapers = [
            {'id': 'keep-this', 'name': 'Keep'},
            {'id': 'delete-this', 'name': 'Delete'}
        ]
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': json.dumps(existing_scrapers)})
        }
        mock_secrets.put_secret_value.return_value = {}
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE',
            path='/scrapers/delete-this',
            path_params={'scraper_id': 'delete-this'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        
        # Verify only one scraper remains
        assert mock_secrets.put_secret_value.called
        call_args = mock_secrets.put_secret_value.call_args
        saved_secrets = json.loads(call_args[1]['SecretString'])
        saved_scrapers = json.loads(saved_secrets['webscraper_configs'])
        assert len(saved_scrapers) == 1
        assert saved_scrapers[0]['id'] == 'keep-this'


class TestGetTemplates:
    """Tests for GET /scrapers/templates endpoint."""

    def test_returns_available_templates(
        self, api_gateway_event, lambda_context
    ):
        """Returns list of scraper templates."""
        # Arrange
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/scrapers/templates')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert 'templates' in body
        assert len(body['templates']) >= 2
        
        template_ids = [t['id'] for t in body['templates']]
        assert 'review_jsonld' in template_ids
        assert 'custom_css' in template_ids


class TestRunScraper:
    """Tests for POST /scrapers/<scraper_id>/run endpoint."""

    @patch('scrapers_handler.require_webscraper_function')
    @patch('scrapers_handler.lambda_client')
    @patch('scrapers_handler.get_aggregates_table')
    def test_triggers_scraper_run_successfully(
        self, mock_get_table, mock_lambda, mock_require_fn, api_gateway_event, lambda_context
    ):
        """Triggers async scraper Lambda invocation."""
        # Arrange
        mock_table = MagicMock()
        mock_table.put_item.return_value = {}
        mock_get_table.return_value = mock_table
        mock_lambda.invoke.return_value = {}
        mock_require_fn.return_value = 'test-webscraper-function'
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/scrapers/test-scraper/run',
            path_params={'scraper_id': 'test-scraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['status'] == 'running'
        assert 'execution_id' in body
        mock_lambda.invoke.assert_called_once()

    @patch('scrapers_handler.require_webscraper_function')
    @patch('scrapers_handler.lambda_client')
    @patch('scrapers_handler.get_aggregates_table')
    def test_stores_run_status_in_dynamodb(
        self, mock_get_table, mock_lambda, mock_require_fn, api_gateway_event, lambda_context
    ):
        """Stores scraper run status in DynamoDB."""
        # Arrange
        mock_table = MagicMock()
        mock_table.put_item.return_value = {}
        mock_get_table.return_value = mock_table
        mock_lambda.invoke.return_value = {}
        mock_require_fn.return_value = 'test-webscraper-function'
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/scrapers/my-scraper/run',
            path_params={'scraper_id': 'my-scraper'}
        )
        
        # Act
        lambda_handler(event, lambda_context)
        
        # Assert
        mock_table.put_item.assert_called_once()
        call_args = mock_table.put_item.call_args
        item = call_args.kwargs['Item']
        assert item['pk'] == 'SCRAPER_RUN#my-scraper'
        assert item['status'] == 'running'


class TestGetScraperStatus:
    """Tests for GET /scrapers/<scraper_id>/status endpoint."""

    @patch('scrapers_handler.get_aggregates_table')
    def test_returns_latest_run_status(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        """Returns latest scraper run status from DynamoDB."""
        # Arrange
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [{
                'pk': 'SCRAPER_RUN#test-scraper',
                'sk': 'run_test-scraper_20250101120000',
                'status': 'completed',
                'started_at': '2025-01-01T12:00:00Z',
                'completed_at': '2025-01-01T12:05:00Z',
                'pages_scraped': 5,
                'items_found': 25,
                'errors': []
            }]
        }
        mock_get_table.return_value = mock_table
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/scrapers/test-scraper/status',
            path_params={'scraper_id': 'test-scraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['status'] == 'completed'
        assert body['pages_scraped'] == 5
        assert body['items_found'] == 25

    @patch('scrapers_handler.get_aggregates_table')
    def test_returns_never_run_when_no_history(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        """Returns never_run status when no run history exists."""
        # Arrange
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}
        mock_get_table.return_value = mock_table
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/scrapers/new-scraper/status',
            path_params={'scraper_id': 'new-scraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['status'] == 'never_run'


class TestGetScraperRuns:
    """Tests for GET /scrapers/<scraper_id>/runs endpoint."""

    @patch('scrapers_handler.get_aggregates_table')
    def test_returns_run_history(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        """Returns scraper run history from DynamoDB."""
        # Arrange
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {'sk': 'run_1', 'status': 'completed', 'items_found': 10},
                {'sk': 'run_2', 'status': 'completed', 'items_found': 15},
            ]
        }
        mock_get_table.return_value = mock_table
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/scrapers/test-scraper/runs',
            path_params={'scraper_id': 'test-scraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert len(body['runs']) == 2


class TestAnalyzeUrl:
    """
    Tests for POST /scrapers/analyze-url endpoint.

    The fetch here used to be a bare `urllib.request.urlopen` on a
    string-validated URL — which is why the preview check was bypassable even
    when it ran (issue #244). It now goes through `fetch_checked_with_retry`, so
    HTTP is mocked at `shared.http_utils.requests.request` and resolution at
    `shared.http_utils.socket.getaddrinfo`.
    """

    @patch('shared.converse.converse')
    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_analyzes_url_and_returns_selectors(
        self, mock_resolve, mock_request, mock_converse,
        api_gateway_event, lambda_context
    ):
        """Analyzes URL and returns CSS selectors using Bedrock."""
        # Arrange
        mock_resolve.return_value = PUBLIC_ADDRINFO
        mock_request.return_value = _http_response(
            200, text='<html><div class="review">Test</div></html>'
        )

        # Mock the converse function to return JSON with selectors
        mock_converse.return_value = '{"container_selector": ".review", "text_selector": ".review-text", "confidence": "high"}'

        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/scrapers/analyze-url',
            body={'url': 'https://example.com/reviews'}
        )

        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert 'selectors' in body
        assert body['selectors']['container_selector'] == '.review'
        # Regression (live-caught on voc-deploy, PR #166): strict-JSON output
        # must fit ONE Bedrock call — adaptive-thinking models spend output
        # budget on thinking, and continuation is unreliable mid-JSON.
        assert mock_converse.call_args.kwargs['max_tokens'] >= 2048
        assert mock_converse.call_args.kwargs['surface'] == 'utility'

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_rejects_invalid_url(
        self, mock_resolve, api_gateway_event, lambda_context
    ):
        """Rejects invalid or dangerous URLs."""
        # Arrange - localhost should be blocked
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/scrapers/analyze-url',
            body={'url': 'http://localhost/admin'}
        )

        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        # Assert - now returns 400 with error key
        assert response['statusCode'] == 400
        assert 'error' in body
        assert 'localhost' in body['error'].lower()

    @patch('shared.converse.converse')
    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_refuses_a_redirect_from_the_previewed_page_into_an_internal_one(
        self, mock_resolve, mock_request, mock_converse,
        api_gateway_event, lambda_context
    ):
        """
        The preview's own bypass: a public URL that 302s to the metadata
        endpoint. Re-enabling automatic redirect following (or reverting the
        fetch to urlopen, which also follows) makes this a 200 whose HTML is
        internal — and, worse, hands that HTML to Bedrock.
        """
        def resolve(hostname, *_args, **_kwargs):
            return PUBLIC_ADDRINFO if hostname == 'example.com' else PRIVATE_ADDRINFO

        mock_resolve.side_effect = resolve
        mock_request.return_value = _http_response(
            302, location='http://metadata.internal/latest/meta-data/'
        )

        from scrapers_handler import lambda_handler
        response = lambda_handler(
            api_gateway_event(
                method='POST', path='/scrapers/analyze-url',
                body={'url': 'https://example.com/reviews'},
            ),
            lambda_context,
        )

        assert response['statusCode'] == 400, response['body']
        assert 'internal/private' in json.loads(response['body'])['error']
        # The internal hop was never sent, and nothing reached Bedrock.
        assert mock_request.call_count == 1
        mock_converse.assert_not_called()

    @patch('shared.converse.converse')
    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_handles_bedrock_failure_gracefully(
        self, mock_resolve, mock_request, mock_converse,
        api_gateway_event, lambda_context
    ):
        """Returns error when Bedrock analysis fails."""
        # Arrange
        mock_resolve.return_value = PUBLIC_ADDRINFO
        mock_request.return_value = _http_response(200, text='<html></html>')

        # Mock converse to raise an exception
        mock_converse.side_effect = Exception('Bedrock error')

        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/scrapers/analyze-url',
            body={'url': 'https://example.com'}
        )

        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        # Assert - now returns 500 with error key
        assert response['statusCode'] == 500
        assert 'error' in body

    @patch('shared.converse.converse')
    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_bounds_the_fetch_to_the_api_gateway_budget(
        self, mock_resolve, mock_request, mock_converse,
        api_gateway_event, lambda_context
    ):
        """
        This route answers through API Gateway's 29 s integration limit, and the
        checked fetch may follow up to MAX_REDIRECT_HOPS hops with retries. Left
        at the old bare `timeout=30`, a chain of slow-but-valid hops overran the
        limit and became a 504 with no message. Asserted as the CONTRACT — a total
        budget under the limit, and a per-hop timeout no larger — rather than as
        the two literals, so tuning them stays free.
        """
        from scrapers_handler import lambda_handler

        mock_resolve.return_value = PUBLIC_ADDRINFO
        mock_request.return_value = _http_response(200, text='<html></html>')
        mock_converse.return_value = '{"container_selector": ".review"}'

        lambda_handler(
            api_gateway_event(
                method='POST', path='/scrapers/analyze-url',
                body={'url': 'https://example.com/reviews'},
            ),
            lambda_context,
        )

        import scrapers_handler

        # API Gateway's REST integration limit. Named here rather than imported
        # because it is AWS's number, not ours.
        api_gateway_limit = 29
        assert 0 < scrapers_handler.PREVIEW_FETCH_TOTAL_TIMEOUT_SECONDS < api_gateway_limit
        assert (
            scrapers_handler.PREVIEW_FETCH_HOP_TIMEOUT_SECONDS
            <= scrapers_handler.PREVIEW_FETCH_TOTAL_TIMEOUT_SECONDS
        )
        # And the budget really reached the fetch: the first hop's timeout is
        # bounded by it, so a chain cannot outlive the invocation.
        assert 0 < mock_request.call_args.kwargs['timeout'] <= (
            scrapers_handler.PREVIEW_FETCH_HOP_TIMEOUT_SECONDS
        )


class TestOnePolicyForBothCallSites:
    """
    The API and the ingestor must share ONE implementation (issue #244).

    Copying the policy back into either module — the failure this repo has
    already lived once, where `scrapers_handler.validate_url` existed and the
    ingestor had no check at all — is what these two assertions catch.
    """

    def test_the_api_handler_uses_the_shared_policy_object(self):
        import scrapers_handler
        from shared import http_utils

        assert scrapers_handler.assert_outbound_url_allowed is (
            http_utils.assert_outbound_url_allowed
        )
        assert scrapers_handler.fetch_checked_with_retry is (
            http_utils.fetch_checked_with_retry
        )

    def test_the_handler_defines_no_url_policy_of_its_own(self):
        """
        Asserted as a property of the module's source, not of one spelling: any
        second address list or resolver call here means the two sides can drift.

        Scoped to names in CALL position — `socket.getaddrinfo(...)`, not a
        variable or attribute that merely happens to share the name — so an
        unrelated future use of the word cannot make this misfire.
        """
        import ast
        import inspect

        import scrapers_handler

        tree = ast.parse(inspect.getsource(scrapers_handler))
        called = set()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if isinstance(node.func, ast.Name):
                called.add(node.func.id)
            elif isinstance(node.func, ast.Attribute):
                called.add(node.func.attr)
        assert 'getaddrinfo' not in called, 'handler resolves hostnames itself again'
        assert 'ip_network' not in called, 'handler carries its own address denylist again'
        assert 'urlopen' not in called, 'handler fetches outside the checked client again'
