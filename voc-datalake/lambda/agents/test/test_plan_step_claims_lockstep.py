"""The conductor's step claims and the plan-step Lambda's event schema must name the same keys.

``agents/plan_identity.py approver_claims`` builds the claims of every step event; ``stream/src/plan-step/event.ts``
``planStepEventSchema.claims`` is a plain ``z.object``, so a key it does not list is stripped without a word: a
renamed workspace key would drop the plan's workspace (docs/multi-workspace.md) and every test of either side would
stay green on its own.
"""
import re
from pathlib import Path
from unittest.mock import MagicMock, patch

from agents import plan_identity as pi

_EVENT_TS = Path(__file__).resolve().parents[2] / 'stream' / 'src' / 'plan-step' / 'event.ts'


def _schema_claim_keys() -> set[str]:
    source = _EVENT_TS.read_text(encoding='utf-8')
    block = re.search(r'claims: z\.object\(\{(.*?)\}\),', source, re.DOTALL)
    assert block is not None, 'planStepEventSchema has no claims object'
    return set(re.findall(r"^\s*'?([\w:]+)'?:", block.group(1), re.MULTILINE))


def _claims_with_every_key() -> dict[str, str]:
    cognito = MagicMock()
    cognito.admin_get_user.return_value = {'Enabled': True, 'UserAttributes': [{'Name': 'sub', 'Value': 'sub-7'}]}
    cognito.admin_list_groups_for_user.return_value = {'Groups': [{'GroupName': 'users'}]}
    meta = {'approver_sub': 'sub-7', 'approver_username': 'ada', 'plan_id': 'pl_abc',
            'workspace_id': 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'}
    with patch.object(pi, '_cognito', return_value=cognito), patch.dict('os.environ', {'USER_POOL_ID': 'pool'}):
        return pi.approver_claims(meta, needs_admin=False)


def test_every_key_the_conductor_sends_is_one_the_plan_step_schema_keeps():
    assert set(_claims_with_every_key()) <= _schema_claim_keys()


def test_the_workspace_key_is_the_one_both_sides_name():
    assert pi.WORKSPACE_CLAIM in _schema_claim_keys()
    assert pi.WORKSPACE_CLAIM in _claims_with_every_key()
