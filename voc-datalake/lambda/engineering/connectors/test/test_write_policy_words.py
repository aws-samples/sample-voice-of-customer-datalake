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


def test_a_push_of_two_ci_definitions_says_both_one_after_the_other() -> None:
    with pytest.raises(WriteRefused) as refused:
        write_policy.check_paths(['.github/workflows/b.yml', 'src/app.py', '.github/workflows/a.yml'])
    assert refused.value.reason == ('An agent never changes the CI definitions (.github/workflows/a.yml). '
                                    'An agent never changes the CI definitions (.github/workflows/b.yml).')


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


@pytest.mark.parametrize('text', [
    'Call +1 555 010 0199.', 'Call +1 (555) 010-0199!', 'Call 555-010-0199, today', 'Ring +44 20 7946 0958?',
    'Call +1 555 010 0199.\nThanks', '(+1 555 010 0199)',
    # Markdown emphasis, and a stop or an ellipsis with no space before the number.
    'Call _+1 555 010 0199_', 'Call __555-010-0199__ now', 'Number...555-010-0199', 'Call me.555-010-0199 ok',
    # A date just before the number never takes it into a match that is then dropped as a date.
    'Called 2026-11-14 555-010-0199', 'x_2026-11-14 555-010-0199', '2026-11-14 (555) 010-0199.',
    # A number grouped like a date, or ending in one, is still a number.
    '+44 20 7946-09-58', '+46 8 1234-56-78', 'Call +1 555 2026-11-14', '+1 2026-11-1234', '+44 12345-67-89',
    # A dot followed by a letter ends the number like a full stop.
    'Call +1 555 010 0199.Thanks',
    # A date glued to more digits, after a dot or an underscore, does not take the number with it.
    '.2026-11-1455 010 0199', '_2026-11-1455 010 0199',
    # A number glued to a date: blanking the date must leave a space, not join the two.
    'a2026-11-14+0199555555',
    # A number grouped like a date ending a sentence; one wrapped at a line break; one after a date range.
    'Call 08-1234-56-78.', 'Call +1 555 010\n0199.', '2026-11-10--2026-11-14 555-010-0199'])
def test_a_phone_number_ending_a_sentence_or_a_clause_is_refused(text: str) -> None:
    """A full stop, a question or exclamation mark, a comma, a bracket or markdown around a number does not hide it."""
    assert [r.code for r in write_policy.text_refusals(text, [], prose=True)] == ['personal_data']


@pytest.mark.parametrize('text', [
    # A grouped decimal: the digits run on past a dot, so they are an amount, not a number to call.
    'total 1 234 567 890.50 paid', 'Call +1 555 010 0199.5',
    # A run of digits after a digit and a dot is part of a version or a decimal.
    'release 2.555 010 0199 is out',
    # Digits touching a letter are part of a word: a reference, an id, a UUID.
    'ref A555-010-0199', 'id 555-010-0199x', 'uuid 3f2a1234-5678-9012-abcd-ef0123456789',
    # A date, alone or with its time, and identifiers stamped with one.
    'Released 2026-11-12 10:00:00', 'dump_20261114_123045',
    # Digits glued to a date are not a date, so they are not blanked out into a number of their own.
    '2026-11-1455 010 0199', '2026-11-14101011212026-11-14',
    # Separators of three characters split a run of digits into groups, not a number (as before).
    'Call +1 555 - 010 - 0199'])
def test_digits_that_run_on_past_a_dot_are_not_a_phone_number(text: str) -> None:
    assert write_policy.text_refusals(text, [], prose=True) == []


def test_a_review_sentence_of_exactly_the_shortest_matched_length_is_matched() -> None:
    """MIN_REVIEW_MATCH is inclusive: a sentence of exactly that many characters (normalised) is the customer's
    words; one character shorter is too common a phrase to match on."""
    exact, shorter = 'The refunds took 3 weeks.', 'The refund took 3 weeks.'
    assert len(exact.rstrip('.')) == write_policy.MIN_REVIEW_MATCH
    assert [r.code for r in write_policy.text_refusals(exact, [exact], prose=False)] == ['customer_text']
    assert write_policy.text_refusals(shorter, [shorter], prose=False) == []
