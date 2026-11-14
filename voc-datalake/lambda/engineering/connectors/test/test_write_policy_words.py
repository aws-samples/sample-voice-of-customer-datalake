"""The connector's refusals word for word, and the edges of its branch and trailer rules (write_policy.py).

An agent reads a refusal's sentence in its run journal and acts on it, and a reviewer reads its code: both are part of
the contract, so each is pinned exactly here, beside the edges the property tests reach only by chance.
"""
from __future__ import annotations

import pytest

from engineering.connectors import write_policy
from engineering.connectors.write_policy import Refusal, WriteRefused

RUN = 'run-7f3a'
BOT = 'bot@agents.example'
OWN = f'voc-agent/{RUN}/'


@pytest.mark.parametrize(('branch', 'run_id', 'expected'), [
    ('main', RUN, Refusal('default_branch', 'An agent never pushes to the default branch.')),
    (f'{OWN}fix', 'not a run', Refusal('bad_run', 'The run is not one the connector knows.')),
    ('feature/x', RUN, Refusal('not_run_branch', f"An agent pushes only to its own run's branches ({OWN}...).")),
    (f'{OWN}a..b', RUN, Refusal('bad_branch_name', 'The branch name is not one the connector creates.')),
])
def test_each_branch_refusal_says_why_in_its_own_words(branch: str, run_id: str, expected: Refusal) -> None:
    assert write_policy.branch_refusal(branch, 'main', run_id) == expected


def test_two_dots_anywhere_in_the_branch_name_are_refused() -> None:
    """"a..b" passes the character set and every component rule: only the ".." rule refuses it."""
    for rest in ('a..b', 'fix/a..b', 'a/b..c/d'):
        refusal = write_policy.branch_refusal(f'{OWN}{rest}', 'main', RUN)
        assert refusal is not None
        assert refusal.code == 'bad_branch_name'


def test_only_leading_slashes_are_dropped_before_a_path_is_matched() -> None:
    assert [r.code for r in write_policy.path_refusals(['//.github/workflows/ci.yml'])] == ['ci_definition']
    assert write_policy.path_refusals(['X.github/workflows/ci.yml', 'XX/.github/workflows/ci.yml']) == []


def test_a_push_refused_twice_says_both_reasons_one_after_the_other() -> None:
    with pytest.raises(WriteRefused) as refused:
        write_policy.check_push('main', 'main', RUN, ['.github/workflows/ci.yml'])
    assert refused.value.reason == ('An agent never pushes to the default branch. '
                                    'An agent never changes the CI definitions (.github/workflows/ci.yml).')


def test_a_bundle_with_other_than_one_head_says_how_many_it_carries() -> None:
    with pytest.raises(WriteRefused) as refused:
        write_policy.check_heads(['refs/heads/a', 'refs/heads/b'])
    assert refused.value.reason == 'A pushed bundle carries exactly one head ref; this one carries 2.'


def test_a_commit_message_refused_twice_says_both_reasons() -> None:
    with pytest.raises(WriteRefused) as refused:
        write_policy.check_commit_message('Fix it\n\nCall +1 (555) 010-0199 or a.person@mail-host.net', [], [BOT])
    assert refused.value.reason == 'The text holds an email address. The text holds a phone number.'


@pytest.mark.parametrize(('trailer', 'codes'), [
    ('Co-authored-by: <bot@agents.example>', ['bad_trailer']),
    ('Co-authored-by: Agent <someone@mail-host.net>', ['not_the_bot']),
])
def test_an_authorship_trailer_refusal_has_its_own_code(trailer: str, codes: list[str]) -> None:
    assert [r.code for r in write_policy.authorship_refusals(trailer, [], [BOT])] == codes


TRAILER = f'Co-authored-by: Agent <{BOT}>'


@pytest.mark.parametrize(('message', 'expected'), [
    # The trailer block is found under trailing blank lines too.
    (f'Fix it\n\n{TRAILER}\n\n\n', ('Fix it', TRAILER)),
    # Every paragraph but the trailer block stays in the prose, the middle ones too.
    (f'Fix it\n\nThe body.\n\n{TRAILER}', ('Fix it\n\nThe body.', TRAILER)),
    # The other trailers of the block stay in the prose, one per line, as written.
    (f'Fix it\n\nRefs: fb_1\nReported-by: Ops\n{TRAILER}', ('Fix it\n\nRefs: fb_1\nReported-by: Ops', TRAILER)),
])
def test_the_authorship_trailers_are_split_from_the_prose(message: str, expected: tuple[str, str]) -> None:
    assert write_policy.split_trailers(message) == expected


@pytest.mark.parametrize('message', [
    TRAILER,                                                   # a single paragraph is the subject, never a block
    f'Fix it\n\n{TRAILER}\nand a line of prose after it',      # a last paragraph not all trailers is prose
])
def test_a_message_with_no_trailer_block_is_all_prose(message: str) -> None:
    assert write_policy.split_trailers(message) == (message, '')
