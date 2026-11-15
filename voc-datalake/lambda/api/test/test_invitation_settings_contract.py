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
    written = table.put_item.call_args.kwargs['Item']
    assert {'pk': written['pk'], 'sk': written['sk']} == user_messages.BRAND_KEY
    assert written['brand_name'] == 'Acme'


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
    uploaded = company_logo.LOGO_KEY_PREFIX + '0123456789ab.png'
    assert logo_signing.is_uploaded_logo_key(uploaded)
    assert not logo_signing.is_uploaded_logo_key(company_logo.LOGO_KEY_PREFIX + 'preview_0123456789ab.png')
