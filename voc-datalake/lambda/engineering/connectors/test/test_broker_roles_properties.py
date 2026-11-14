"""Properties of the broker's role matrix (connectors/broker.py ``permitted``): an agent may read, and make the one write
its role needs, and nothing else. A role outside the agent roles may do nothing at all, and an operation the broker
does not have (marking a pull request ready, merging) is never permitted to anyone.
"""
from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from engineering.connectors.broker import OPEN_OR_UPDATE_DRAFT_PR, POST_COMMENT, PUSH_BUNDLE, READ, permitted
from engineering.connectors.identity import AGENT_ROLES
from shared.test.properties import PROPERTY

WRITE_OPS = (POST_COMMENT, PUSH_BUNDLE, OPEN_OR_UPDATE_DRAFT_PR)
KNOWN_OPS = (READ, *WRITE_OPS)
#: The matrix in words: the understander and the pull request reviewer comment, the
#: committer pushes, the pull request author opens or updates the draft; every other agent role only reads. Written
#: out here, not read from broker.py, so a changed entry there fails.
OWN_WRITE = {'understander': POST_COMMENT, 'pr-reviewer': POST_COMMENT, 'committer': PUSH_BUNDLE,
             'pr-author': OPEN_OR_UPDATE_DRAFT_PR}
# Words a person would use for a pull request's state or a merge: the broker has no operation for any of them.
NOT_OPERATIONS = st.sampled_from(['merge', 'mark_ready', 'ready_for_review', 'close_pull_request', 'delete_branch',
                                  'force_push', 'post_comment ', 'Push_Bundle'])
ANY_TEXT = st.text(max_size=24)


@PROPERTY
@given(role=st.sampled_from(sorted(AGENT_ROLES)), operation=st.sampled_from(KNOWN_OPS))
def test_an_agent_makes_its_own_write_and_only_that_one(role: str, operation: str) -> None:
    """Every agent role may read; it may make the one write its role is for, and no other write."""
    expected = operation == READ or OWN_WRITE.get(role) == operation
    assert permitted(role, operation) is expected


def test_the_writing_roles_are_agent_roles() -> None:
    """The matrix names no role the broker would not know (a renamed role would leave its write to no one)."""
    assert set(OWN_WRITE) <= AGENT_ROLES


@PROPERTY
@given(role=ANY_TEXT.filter(lambda r: r not in AGENT_ROLES), operation=st.sampled_from(KNOWN_OPS))
def test_a_caller_outside_the_agent_roles_may_do_nothing(role: str, operation: str) -> None:
    """A caller whose role is not an agent role (a person's session, an empty name, anything) may not even read."""
    assert permitted(role, operation) is False


@PROPERTY
@given(role=st.sampled_from(sorted(AGENT_ROLES)), operation=NOT_OPERATIONS | ANY_TEXT)
def test_an_operation_the_broker_does_not_have_is_permitted_to_no_one(role: str, operation: str) -> None:
    """Only the broker's own operation names are ever permitted; a merge, a ready-for-review mark or any other
    operation text is refused for every role, so the draft-only rule holds in every mode."""
    if operation in KNOWN_OPS:
        return
    assert permitted(role, operation) is False
