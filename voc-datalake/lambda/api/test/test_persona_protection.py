"""PUT /projects/<id>/personas/<persona_id> — the `protected` flag that keeps a
persona when personas are regenerated."""
import json
from unittest.mock import MagicMock, patch

import pytest


def _put(api_gateway_event, lambda_context, body):
    from projects_handler import lambda_handler

    table = MagicMock()
    event = api_gateway_event(
        method='PUT',
        path='/projects/proj-1/personas/p1',
        path_params={'project_id': 'proj-1', 'persona_id': 'p1'},
        body=body,
    )
    with patch('projects.projects_table', table):
        response = lambda_handler(event, lambda_context)
    return response, table


class TestProtectedFlag:
    @pytest.mark.parametrize('value', [True, False])
    def test_a_boolean_is_written_to_the_persona(self, api_gateway_event, lambda_context, value):
        response, table = _put(api_gateway_event, lambda_context, {'protected': value})

        assert response['statusCode'] == 200
        kwargs = table.update_item.call_args.kwargs
        assert '#protected = :protected' in kwargs['UpdateExpression']
        assert kwargs['ExpressionAttributeNames']['#protected'] == 'protected'
        assert kwargs['ExpressionAttributeValues'][':protected'] is value

    @pytest.mark.parametrize('bad', ['false', 'true', 0, 1, None, []])
    def test_a_non_boolean_is_refused_before_anything_is_written(
        self, api_gateway_event, lambda_context, bad,
    ):
        """`"false"` read as truthy would keep a persona the caller meant to release."""
        response, table = _put(api_gateway_event, lambda_context, {'protected': bad})

        assert response['statusCode'] == 400
        assert 'protected' in json.loads(response['body'])['error']
        table.update_item.assert_not_called()

    def test_an_edit_that_does_not_mention_protection_leaves_it_alone(
        self, api_gateway_event, lambda_context,
    ):
        """The edit modal saves the other sections; it must not unprotect."""
        response, table = _put(api_gateway_event, lambda_context, {'name': 'Renamed'})

        assert response['statusCode'] == 200
        assert 'protected' not in table.update_item.call_args.kwargs['UpdateExpression']
