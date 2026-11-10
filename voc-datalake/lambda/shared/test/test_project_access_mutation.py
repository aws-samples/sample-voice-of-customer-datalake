"""Mutation hardening for the agent / global-MCP additions to `shared/project_access.py`.

The module reached 0 survivors before the agents and global-MCP waves grew it.
Re-running mutmut on the grown module found thirteen survivors, all in the new
code, that `test_project_access.py` and `test_project_access_agent.py` cannot see:

* the WIRE NAMES of the three claims the agents runtime and the global MCP
  Lambda set (``voc:mcp_agent_run``, ``voc:agent_owner_sub``,
  ``voc:agent_editor_subs``). The earlier tests spell them through the module's
  own constants, so a renamed constant still passes them; here they are literals,
  because the producers in other Lambdas spell the same strings.
* ``delegated_agent_run_allowed`` itself: no test in this module's suite called
  it, so each of its three conjuncts could be inverted or the ``and`` turned into
  an ``or`` unnoticed.
* the ACCEPTED side of the two agent bounds: an agent id of exactly 64 characters
  is usable, and exactly 10 editors (the first ten, in claim order) survive the cap.
* the exact WORDING of the three agent refusals, which ``pytest.raises(match=)``
  only searched for as substrings.
"""
import re

import pytest

from shared import project_access as pa

OWNER = 'owner-sub'
NO_USABLE_AGENT_ID = 'agent principal has no usable agent id'
ONLY_AN_AGENT_NAMES_AN_OWNER = 'only an agent principal may name a project owner'
NO_OWNER_TO_HAND_TO = 'agent principal has no owner to hand the project to'
# The one shape delegated_agent_run_allowed clears, spelled with wire-name literals.
CLEARED_RUN_CLAIMS = {'sub': 'mcp:tok_1', 'voc:mcp_agent_run': 'true', 'voc:acting_subject': 'admin-sub'}


def _exact(message: str) -> str:
    return f'^{re.escape(message)}$'


class TestClaimNamesAreTheWireContract:
    def test_global_mcp_run_claim(self):
        assert pa.MCP_AGENT_RUN_CLAIM == 'voc:mcp_agent_run'

    def test_agent_owner_claim(self):
        assert pa.AGENT_OWNER_CLAIM == 'voc:agent_owner_sub'

    def test_agent_editors_claim(self):
        assert pa.AGENT_EDITORS_CLAIM == 'voc:agent_editor_subs'

    def test_editor_cap_is_ten(self):
        assert pa.MAX_AGENT_EDITORS == 10

    def test_the_owner_and_editor_claims_are_read_under_their_literal_names(self):
        caller = pa.caller_from_claims({
            'sub': 'agent:ag_1',
            'voc:acting_subject': OWNER,
            'voc:agent_owner_sub': 'po-sub',
            'voc:agent_editor_subs': 'e1,e2',
        }, [])

        assert caller.agent_owner_sub == 'po-sub'
        assert caller.agent_editor_subs == ('e1', 'e2')


class TestDelegatedAgentRunIsExactlyOneShape:
    def test_the_cleared_shape_is_allowed(self):
        assert pa.delegated_agent_run_allowed(CLEARED_RUN_CLAIMS) is True

    @pytest.mark.parametrize(('override', 'reason'), [
        ({'sub': 'admin-sub'}, 'a person is not a delegated subject'),
        ({'sub': 'agent:ag_1'}, 'an agent is not an mcp subject'),
        ({'voc:mcp_agent_run': 'True'}, 'the flag must be exactly lower-case true'),
        ({'voc:mcp_agent_run': 'XXtrueXX'}, 'the flag must be exactly true'),
        ({'voc:mcp_agent_run': ''}, 'a blank flag is not set'),
        ({'voc:acting_subject': ''}, 'the token must act for somebody'),
        ({'voc:acting_subject': 'mcp:other'}, 'the token cannot act for a credential'),
        ({'voc:acting_subject': 'agent:ag_1'}, 'the token cannot act for an agent'),
    ])
    def test_every_other_shape_is_refused(self, override, reason):
        assert pa.delegated_agent_run_allowed({**CLEARED_RUN_CLAIMS, **override}) is False, reason

    def test_a_missing_run_claim_is_refused_even_for_a_delegated_subject(self):
        claims = {'sub': 'mcp:tok_1', 'voc:acting_subject': 'admin-sub'}

        assert pa.delegated_agent_run_allowed(claims) is False

    def test_the_subject_key_is_sub(self):
        claims = {'XXsubXX': 'mcp:tok_1', 'voc:mcp_agent_run': 'true', 'voc:acting_subject': 'admin-sub'}

        assert pa.delegated_agent_run_allowed(claims) is False


class TestAgentBoundsAcceptTheirLimit:
    def test_a_64_character_agent_id_is_usable(self):
        agent_id = 'x' * 64

        caller = pa.caller_from_claims({'sub': f'agent:{agent_id}'}, [])

        assert caller.agent_id == agent_id

    def test_a_65_character_agent_id_is_not(self):
        with pytest.raises(ValueError, match=_exact(NO_USABLE_AGENT_ID)) as exc:
            pa.caller_from_claims({'sub': 'agent:' + 'x' * 65}, [])

        assert str(exc.value) == NO_USABLE_AGENT_ID

    def test_exactly_ten_editors_survive_in_claim_order(self):
        subs = ','.join(f's{i}' for i in range(11))

        caller = pa.caller_from_claims({'sub': 'agent:ag_1', 'voc:agent_editor_subs': subs}, [])

        assert caller.agent_editor_subs == tuple(f's{i}' for i in range(10))


class TestEveryAgentRefusalIsWordedExactly:
    @pytest.mark.parametrize('sub', ['agent:', 'agent:a,b'])
    def test_unusable_agent_id(self, sub):
        with pytest.raises(ValueError, match=_exact(NO_USABLE_AGENT_ID)) as exc:
            pa.caller_from_claims({'sub': sub}, [])

        assert str(exc.value) == NO_USABLE_AGENT_ID

    def test_only_an_agent_may_name_an_owner(self):
        with pytest.raises(ValueError, match=_exact(ONLY_AN_AGENT_NAMES_AN_OWNER)) as exc:
            pa.agent_project_owner_sub(pa.Caller(subject='u1'))

        assert str(exc.value) == ONLY_AN_AGENT_NAMES_AN_OWNER

    def test_an_ownerless_agent_has_nobody_to_hand_the_project_to(self):
        caller = pa.caller_from_claims({'sub': 'agent:ag_1'}, [])

        with pytest.raises(ValueError, match=_exact(NO_OWNER_TO_HAND_TO)) as exc:
            pa.agent_project_owner_sub(caller)

        assert str(exc.value) == NO_OWNER_TO_HAND_TO
