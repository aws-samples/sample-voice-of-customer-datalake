"""PUT /projects/{id}/personas/{pid}/protection reaches its own handler (ported from #429 by @aws-bryan).

The behaviour is tested in test_persona_protection_moto.py; here, the route is not swallowed by
``PUT /projects/{id}/personas/{pid}`` (the ordinary persona edit, which cannot change protection).
"""
import json
from unittest.mock import patch


def _put(api_gateway_event, lambda_context, body):
    from projects_handler import lambda_handler
    event = api_gateway_event(method='PUT', path='/projects/p1/personas/persona_1/protection',
                              path_params={'project_id': 'p1', 'persona_id': 'persona_1'}, body=body)
    with patch('projects.persona_replace.set_protection') as stored, \
            patch('projects_handler.update_persona') as edit:
        response = lambda_handler(event, lambda_context)
    return response, stored, edit


def test_the_protection_route_stores_the_flag(api_gateway_event, lambda_context):
    response, stored, edit = _put(api_gateway_event, lambda_context, {'protected': True})
    assert response['statusCode'] == 200, response['body']
    assert json.loads(response['body']) == {'success': True, 'persona_id': 'persona_1', 'protected': True}
    _table, project_id, persona_id, protected, _now = stored.call_args.args
    assert (project_id, persona_id, protected) == ('p1', 'persona_1', True)
    edit.assert_not_called()


def test_a_non_boolean_is_400(api_gateway_event, lambda_context):
    response, stored, _edit = _put(api_gateway_event, lambda_context, {'protected': 'true'})
    assert response['statusCode'] == 400
    stored.assert_not_called()
