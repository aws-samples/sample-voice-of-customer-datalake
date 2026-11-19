"""The invitation trigger (auth/user_messages.py) reads the rows the settings API writes.

The trigger cannot import the writers (its bundle is self-contained), so it repeats their keys and field
names. This pins each copy to its writer: a renamed key or field fails here instead of silently turning the
invitation neutral.
"""
from unittest.mock import patch

from handler_events_fixtures import call_route

from auth import logo_signing, user_messages
from settings_handler import lambda_handler
from shared import company_context, company_logo


def test_reads_the_brand_row_and_field_the_brand_route_writes(api_gateway_event, lambda_context):
    with patch('settings_handler.aggregates_table') as table:
        response, _ = call_route(lambda_handler, api_gateway_event, lambda_context, method='PUT',
                                 path='/settings/brand', body={'brand_name': 'Acme'})
    assert response['statusCode'] == 200
    # The brand save is one UpdateItem of the brand row (the config version's bump is another write, elsewhere).
    writes = [c.kwargs for c in table.update_item.call_args_list
              if 'brand_name' in c.kwargs.get('ExpressionAttributeNames', {}).values()]
    assert len(writes) == 1
    write = writes[0]
    assert write['Key'] == user_messages.BRAND_KEY
    alias = next(alias for alias, name in write['ExpressionAttributeNames'].items() if name == 'brand_name')
    assert write['ExpressionAttributeValues'][alias.replace('#', ':', 1)] == 'Acme'


def test_reads_the_design_system_row_the_design_system_writes():
    assert user_messages.DESIGN_SYSTEM_KEY == {'pk': company_context.DESIGN_SYSTEM_PK, 'sk': company_context.CONFIG_SK}


def test_finds_the_accent_in_the_colour_tokens_the_design_system_writer_stores():
    # The route stores validate_design_system's output as the row (settings_handler.put_design_system_route).
    stored = company_context.validate_design_system(
        {'tokens': {'colors': [{'name': 'surface', 'value': '#fafafa'}, {'name': 'primary', 'value': '#be123c'}],
                    'typography': []}})
    assert user_messages.accent_color(stored) == '#be123c'


def test_reads_the_logo_attribute_and_key_shape_the_logo_upload_writes():
    assert user_messages.LOGO_KEY_ATTR == company_logo.LOGO_KEY_ATTR
    # The signer's copy of the uploaded-key rule agrees with company_logo's on every edge, accepted or refused.
    prefix = company_logo.LOGO_KEY_PREFIX
    for key in (prefix + '0123456789ab.png', prefix + '0123456789ab.jpg', prefix + '0123456789ab.webp',
                prefix + 'preview_0123456789ab.png', prefix + '0123456789AB.png', prefix + '0123456789a.png',
                prefix + '0123456789ab.svg', prefix + '0123456789ab.png.exe', 'x/' + prefix + '0123456789ab.png'):
        accepted_by_upload = company_logo.logo_keys({company_logo.LOGO_KEY_ATTR: key}) == [key]
        assert logo_signing.is_uploaded_logo_key(key) is accepted_by_upload, key
