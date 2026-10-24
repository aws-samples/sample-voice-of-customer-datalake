"""Plain builders shared by the API handler tests that drive a route end to end.

The `api_gateway_event` and `lambda_context` fixtures stay in conftest.py; these
helpers take them as arguments, so a test still requests them from pytest and the
event shape has a single definition.
"""
import json
import sys
from collections.abc import Callable
from typing import Any
from unittest.mock import MagicMock

from botocore.exceptions import ClientError


def aws_error(message: str, operation: str = 'Unknown', code: str = 'InternalFailure') -> ClientError:
    """A service-side AWS failure, the error a boto call actually raises.

    For stubbing an S3/SQS/DynamoDB call that fails: the handlers' fail-soft
    paths catch `ClientError`/`BotoCoreError`, not arbitrary exceptions.
    `str()` of the result contains `message`.
    """
    return ClientError({'Error': {'Code': code, 'Message': message}}, operation)


def call_route(
    lambda_handler: Callable[[dict, Any], dict],
    api_gateway_event: Callable[..., dict],
    lambda_context: Any,
    **event_kwargs: Any,
) -> tuple[dict, Any]:
    """Build an API Gateway event from `event_kwargs`, run the handler on it, decode the body.

    Returns `(response, body)`, where `body` is the JSON-decoded `response['body']`.
    """
    response = lambda_handler(api_gateway_event(**event_kwargs), lambda_context)
    return response, json.loads(response['body'])


def keyed_get_item(items: dict[tuple[str, str], dict]) -> Callable[..., dict]:
    """A `Table.get_item` side effect answering from `items`, keyed on the whole `(pk, sk)`.

    Keyed on both halves so a lookup that dropped `pk` (or `sk`) misses instead of
    finding a neighbour's row.
    """
    def get_item(Key=None, **_kwargs):
        pk_sk = ((Key or {}).get('pk', ''), (Key or {}).get('sk', ''))
        return {'Item': items[pk_sk]} if pk_sk in items else {}

    return get_item


def transacting_projects_table(items: list[dict] | None = None) -> MagicMock:
    """A projects-table double whose transactions land as plain `put_item` calls.

    `query` answers `items`; every `Put` in a `transact_write_items` batch is
    replayed as `table.put_item(Item=...)`, so a test asserts on what was written
    the same way whether the code wrote one row or a transaction of them.
    """
    table = MagicMock()
    table.name = 'test-projects'
    table.query.return_value = {'Items': items or []}

    def transact_write_items(*, TransactItems):
        for put in (action['Put'] for action in TransactItems if 'Put' in action):
            table.put_item(Item=put['Item'])
        return {}

    table.meta.client.transact_write_items.side_effect = transact_write_items
    return table


def table_behind(mock_resource: MagicMock) -> MagicMock:
    """Make `mock_resource.Table(...)` return one fresh mock table, and return that table."""
    table = MagicMock()
    mock_resource.Table.return_value = table
    return table


def project_meta_table(*project_ids: str) -> MagicMock:
    """A projects-table double whose only content is the META of ``project_ids``.

    Every route that starts a job now reads the project's META before it writes a
    JOB row (`projects_handler._require_project_exists`), so a route test that is
    about the job's CONFIG rather than about the project needs that read answered.
    Keyed on the whole `(pk, sk)` so a lookup that dropped `pk` misses, the same
    discipline `build_prototype_fixtures` applies to documents.
    """
    metas = {(f'PROJECT#{project_id}', 'META'): {'pk': f'PROJECT#{project_id}', 'sk': 'META'}
             for project_id in project_ids}
    table = MagicMock()
    table.get_item.side_effect = keyed_get_item(metas)
    return table


def recording_logger() -> MagicMock:
    """A logger whose `exception` records the in-flight exception, as Powertools does.

    Handlers no longer interpolate `{e}` into the message (#263), so asserting on
    call args alone would make a "was it logged" control vacuous: read
    `emitted_exceptions` instead.
    """
    mock_logger = MagicMock()
    emitted: list[str] = []
    mock_logger.exception.side_effect = lambda *a, **k: emitted.append(f'{a} {k} exc={sys.exc_info()[1]!r}')
    mock_logger.emitted_exceptions = emitted
    return mock_logger


def clear_validation_logs(
    handler: Callable[..., dict], mock_table: MagicMock, api_gateway_event, lambda_context,
    source: str = 'webscraper',
) -> tuple[dict, dict, MagicMock]:
    """`DELETE /logs/validation/<source>` against `mock_table`, whose `batch_writer()`
    context yields the returned batch double (assert its `delete_item` calls)."""
    batch = MagicMock()
    batch.__enter__ = MagicMock(return_value=batch)
    mock_table.batch_writer.return_value = batch
    response, body = call_route(handler, api_gateway_event, lambda_context,
                                method='DELETE', path=f'/logs/validation/{source}',
                                path_params={'source': source})
    return response, body, batch
