"""Properties of a workspace's plugin credentials store (shared/workspace_credentials.py, decision 19).

A credential saved under another workspace's or plugin's name is a leak of a team's API keys; a value over the
parameter's 4096 bytes that is half written loses the keys it replaced; a status page that lists another workspace's
plugins tells a team what another one uses. The SSM client is a double that keeps parameters by name and lists a path
the way Parameter Store does (its direct children only, a page at a time).
"""
from __future__ import annotations

import json
from typing import Any

import pytest
from botocore.exceptions import ClientError
from hypothesis import given
from hypothesis import strategies as st

from shared.exceptions import ValidationError
from shared.test.ws_properties import PARAMETER_PREFIXES, PLUGIN_IDS, PROPERTY, exactly, two_workspace_ids
from shared.workspace_credentials import (
    MalformedCredentials,
    checked_credentials,
    read_credentials,
    read_workspace,
    save_credentials,
)
from shared.workspace_ids import credentials_parameter_name, credentials_path

LIMIT = 4096
KEY = 'alias/voc-workspaces'
#: Credential values as they come: ASCII keys and tokens, and text whose UTF-8 is longer than its characters.
VALUES = st.dictionaries(st.sampled_from(['api_key', 'webhook_secret', 'app_name', 'client_id', 'token']),
                         st.text(alphabet=st.sampled_from('abcXYZ019-_é漢'), max_size=40), max_size=4)


class Parameters:
    """The SSM double: SecureStrings by name; a path lists its direct children only, two to a page."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.puts: list[dict[str, Any]] = []

    def get_parameter(self, **request: Any) -> dict[str, Any]:
        if request['Name'] not in self.values:
            raise ClientError({'Error': {'Code': 'ParameterNotFound', 'Message': ''}}, 'GetParameter')
        return {'Parameter': {'Name': request['Name'], 'Value': self.values[request['Name']]}}

    def put_parameter(self, **request: Any) -> None:
        self.puts.append(request)
        self.values[request['Name']] = request['Value']

    def get_paginator(self, _operation: str) -> Parameters:
        return self

    def paginate(self, **request: Any) -> list[dict[str, Any]]:
        assert request['Recursive'] is False
        children = sorted(name for name in self.values
                          if name.startswith(f"{request['Path']}/") and '/' not in name[len(request['Path']) + 1:])
        found = [{'Name': name, 'Value': self.values[name]} for name in children]
        # An empty listing's page carries no Parameters field at all, as boto3 may hand it back.
        return [{'Parameters': found[start:start + 2]} for start in range(0, len(found), 2)] or [{}]


# What is saved is what is read back, under the one name of that workspace and plugin; a save that changes nothing
# writes nothing; every write is a SecureString under the deployment's key, standard tier, overwritten whole.
@PROPERTY
@given(PARAMETER_PREFIXES, two_workspace_ids(), PLUGIN_IDS, VALUES, VALUES)
def test_what_is_saved_is_read_back_from_its_own_name(prefix, pair, plugin, first, second):
    mine, theirs = pair
    ssm = Parameters()
    assert read_credentials(ssm, prefix, mine, plugin) == {}
    save_credentials(ssm, prefix, mine, plugin, stored={}, values=first, key_id=KEY)
    save_credentials(ssm, prefix, mine, plugin, stored=first, values=second, key_id=KEY)
    expected_puts = [values for stored, values in (({}, first), (first, second)) if values != stored]
    assert [json.loads(put['Value']) for put in ssm.puts] == expected_puts
    for put in ssm.puts:
        assert put == {'Name': credentials_parameter_name(prefix, mine, plugin), 'Value': put['Value'],
                       'Type': 'SecureString', 'KeyId': KEY, 'Overwrite': True, 'Tier': 'Standard'}
    assert read_credentials(ssm, prefix, mine, plugin) == (second if expected_puts else {})
    assert read_credentials(ssm, prefix, theirs, plugin) == {}


# A value is measured in UTF-8 bytes: up to 4096 is kept, one byte more is refused with the size and the limit, and
# nothing is written.
@PROPERTY
@given(PLUGIN_IDS, st.integers(min_value=0, max_value=6), st.booleans())
def test_the_limit_is_4096_bytes_of_utf8(plugin, over, wide):
    char, width = ('é', 2) if wide else ('x', 1)
    frame = len(json.dumps({'k': ''}))
    size = LIMIT - (LIMIT - frame) % width + over * width
    values = {'k': char * ((size - frame) // width)}
    encoded = len(json.dumps(values, ensure_ascii=False).encode())
    ssm = Parameters()
    if encoded <= LIMIT:
        assert json.loads(checked_credentials(plugin, values)) == values
        save_credentials(ssm, '/voc/ws', 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', plugin, stored={}, values=values, key_id=KEY)
        assert len(ssm.puts) == 1
        return
    message = (f'The {plugin} credentials of this workspace would take {encoded} bytes, over the 4096-byte limit of '
               'one stored value. Shorten or remove some values and retry.')
    with pytest.raises(ValidationError, match=exactly(message)):
        save_credentials(ssm, '/voc/ws', 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', plugin, stored={}, values=values, key_id=KEY)
    assert not ssm.puts


# A workspace's status lists its own plugins only (the direct children of its credentials path, across pages), each
# with its keys; another workspace's parameters, a deeper name and a name that is no plugin id are never in it, and a
# hand-edited parameter that is not a JSON object is left out without hiding the others.
@PROPERTY
@given(PARAMETER_PREFIXES, two_workspace_ids(), st.dictionaries(PLUGIN_IDS, VALUES, max_size=5),
       st.lists(PLUGIN_IDS, max_size=2), st.sampled_from(['not json', '[1, 2]', '"text"', '7']))
def test_a_workspace_lists_its_own_plugins_only(prefix, pair, saved, broken, malformed):
    mine, theirs = pair
    ssm = Parameters()
    assert read_workspace(ssm, prefix, mine) == {}
    for plugin, values in saved.items():
        ssm.values[credentials_parameter_name(prefix, mine, plugin)] = json.dumps(values)
        ssm.values[credentials_parameter_name(prefix, theirs, plugin)] = json.dumps({'other': 'team'})
    for plugin in broken:
        ssm.values[credentials_parameter_name(prefix, mine, plugin)] = malformed
    ssm.values[f'{credentials_path(prefix, mine)}/x/deeper'] = '{}'
    ssm.values[f'{credentials_path(prefix, mine)}/Not-A-Plugin'] = '{}'
    expected = {plugin: values for plugin, values in saved.items() if plugin not in broken}
    assert read_workspace(ssm, prefix, mine) == expected
    for plugin in broken:
        with pytest.raises(MalformedCredentials, match=exactly('a credentials parameter is not a JSON object')):
            read_credentials(ssm, prefix, mine, plugin)


# A read fails as boto3 failed for anything but "not found": an access refusal is never read as "nothing saved".
@PROPERTY
@given(PLUGIN_IDS, st.sampled_from(['AccessDeniedException', 'ThrottlingException', 'InternalServerError', None]))
def test_only_a_missing_parameter_reads_as_nothing_saved(plugin, code):
    # None: a fault whose answer carries no Error at all (a dropped connection's), still raised as it came.
    response: Any = {} if code is None else {'Error': {'Code': code, 'Message': ''}}

    class Refusing(Parameters):
        def get_parameter(self, **request: Any) -> dict[str, Any]:
            raise ClientError(response, request['Name'])

    with pytest.raises(ClientError) as raised:
        read_credentials(Refusing(), '/voc/ws', 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', plugin)
    assert raised.value.response == response
