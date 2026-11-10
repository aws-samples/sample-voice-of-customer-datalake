"""The `agent:` principal in shared.project_access (autonomous agents).

Mirrors the MCP delegation rules: acts as its owner, never admin, capped at
editor — plus the two agent-only powers (naming a project owner/editors at
create, and keeping edit on the projects it created).
"""
import pytest

from shared import project_access as pa

OWNER = 'owner-sub'
HANDOFF = 'po-sub'


def _agent(**claims):
    return pa.caller_from_claims({'sub': 'agent:ag_1', **claims}, ['admins'])


def test_agent_acts_as_its_owner_and_never_as_admin():
    caller = _agent(**{pa.ACTING_SUBJECT_CLAIM: OWNER})

    assert caller.subject == OWNER
    assert caller.is_admin is False
    assert caller.delegated is True
    assert caller.agent_id == 'ag_1'


@pytest.mark.parametrize('acting', ['mcp:tok', 'agent:ag_2', '', '  '])
def test_agent_cannot_act_as_a_synthetic_or_blank_subject(acting):
    assert _agent(**{pa.ACTING_SUBJECT_CLAIM: acting}).subject == ''


def test_owner_and_editor_claims_drop_synthetic_subjects_and_dedupe():
    caller = _agent(**{
        pa.ACTING_SUBJECT_CLAIM: OWNER,
        pa.AGENT_OWNER_CLAIM: 'agent:ag_9',
        pa.AGENT_EDITORS_CLAIM: 'a, b,mcp:x,,a,agent:y',
    })

    assert caller.agent_owner_sub == ''
    assert caller.agent_editor_subs == ('a', 'b')


def test_editor_claim_is_capped():
    subs = ','.join(f's{i}' for i in range(pa.MAX_AGENT_EDITORS + 5))
    caller = _agent(**{pa.AGENT_EDITORS_CLAIM: subs})

    assert len(caller.agent_editor_subs) == pa.MAX_AGENT_EDITORS


@pytest.mark.parametrize('sub', ['agent:', 'agent:' + 'x' * 65, 'agent:a,b'])
def test_unusable_agent_ids_fail_closed(sub):
    with pytest.raises(ValueError, match='agent principal has no usable agent id'):
        pa.caller_from_claims({'sub': sub}, [])


def test_agent_claims_are_ignored_for_people_and_mcp_tokens():
    claims = {pa.AGENT_OWNER_CLAIM: HANDOFF, pa.AGENT_EDITORS_CLAIM: 'x'}
    person = pa.caller_from_claims({'sub': 'u1', **claims}, [])
    token = pa.caller_from_claims({'sub': 'mcp:t', **claims}, [])

    assert (person.agent_id, person.agent_owner_sub, person.agent_editor_subs) == ('', '', ())
    assert (token.agent_id, token.agent_owner_sub, token.agent_editor_subs) == ('', '', ())


def _private(**extra):
    return {'owner_sub': HANDOFF, 'visibility': 'private', 'members': {}, **extra}


def test_agent_keeps_edit_on_a_private_project_it_created():
    caller = _agent(**{pa.ACTING_SUBJECT_CLAIM: OWNER})

    access = pa.resolve_access(_private(**{pa.CREATED_BY_AGENT_ATTRIBUTE: 'ag_1'}), caller)

    assert access.role == pa.ROLE_EDITOR
    assert access.can_edit
    assert not access.can_manage


def test_another_agent_gets_nothing_on_that_project():
    caller = pa.caller_from_claims({'sub': 'agent:ag_2', pa.ACTING_SUBJECT_CLAIM: OWNER}, [])

    assert pa.resolve_access(_private(**{pa.CREATED_BY_AGENT_ATTRIBUTE: 'ag_1'}), caller).role is None


def test_an_agent_whose_owner_owns_the_project_is_capped_at_editor():
    caller = _agent(**{pa.ACTING_SUBJECT_CLAIM: HANDOFF})

    assert pa.resolve_access(_private(), caller).role == pa.ROLE_EDITOR


def test_people_never_inherit_the_created_by_agent_grant():
    person = pa.caller_from_claims({'sub': 'stranger'}, [])

    assert pa.resolve_access(_private(**{pa.CREATED_BY_AGENT_ATTRIBUTE: 'ag_1'}), person).role is None


def test_agent_project_owner_prefers_the_handoff_target():
    assert pa.agent_project_owner_sub(_agent(**{
        pa.ACTING_SUBJECT_CLAIM: OWNER, pa.AGENT_OWNER_CLAIM: HANDOFF,
    })) == HANDOFF
    assert pa.agent_project_owner_sub(_agent(**{pa.ACTING_SUBJECT_CLAIM: OWNER})) == OWNER


def test_agent_project_owner_refuses_non_agents_and_ownerless_agents():
    with pytest.raises(ValueError, match='only an agent principal may name a project owner'):
        pa.agent_project_owner_sub(pa.Caller(subject='u1'))
    with pytest.raises(ValueError, match='agent principal has no owner to hand the project to'):
        pa.agent_project_owner_sub(_agent())


def test_owner_attributes_still_refuse_an_agent():
    with pytest.raises(ValueError, match='only a signed-in user can own a project'):
        pa.owner_attributes(_agent(**{pa.ACTING_SUBJECT_CLAIM: OWNER}))


@pytest.mark.parametrize(('sub', 'expected'), [
    ('mcp:x', True), ('agent:x', True), ('user-uuid', False), (None, False), ('', False),
])
def test_is_synthetic_subject(sub, expected):
    assert pa.is_synthetic_subject(sub) is expected
