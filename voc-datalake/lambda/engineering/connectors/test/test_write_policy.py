"""The connector's write refusals (docs/autonomous-engineering.md, "Repository connectors")."""
from __future__ import annotations

import pytest

from engineering.connectors import write_policy
from engineering.connectors.write_policy import WriteRefused

REVIEW = 'The refund took three weeks and nobody answered my emails about it.'
RUN = 'run-7f3a'


@pytest.mark.parametrize(('branch', 'code'), [
    ('main', 'default_branch'),
    ('feature/x', 'not_run_branch'),
    ('voc-agent/fix', 'not_run_branch'),
    ('voc-agent/run-0000/fix', 'not_run_branch'),
    ('voc-agent/run-7f3a/', 'bad_branch_name'),
    ('voc-agent/run-7f3a/../main', 'bad_branch_name'),
    ('voc-agent/run-7f3a/-x', 'bad_branch_name'),
    ('voc-agent/run-7f3a/fix.lock', 'bad_branch_name'),
    ('voc-agent/run-7f3a/fix/', 'bad_branch_name'),
    ('voc-agent/run-7f3a/a//b', 'bad_branch_name'),
    ('voc-agent/run-7f3a/fix\n', 'bad_branch_name'),
    # What git check-ref-format refuses: a component starting with ".", one ending with ".lock", "@{", a trailing ".".
    ('voc-agent/run-7f3a/.hidden', 'bad_branch_name'),
    ('voc-agent/run-7f3a/fix/.x', 'bad_branch_name'),
    ('voc-agent/run-7f3a/fix.lock/x', 'bad_branch_name'),
    ('voc-agent/run-7f3a/fix@{1}', 'bad_branch_name'),
    ('voc-agent/run-7f3a/fix.', 'bad_branch_name'),
    ('voc-agent/run-7f3a/fix/x.', 'bad_branch_name'),
])
def test_refuses_every_branch_but_the_runs_own(branch: str, code: str) -> None:
    refusal = write_policy.branch_refusal(branch, 'main', RUN)
    assert refusal is not None
    assert refusal.code == code


def test_refuses_the_default_branch_even_under_the_prefix() -> None:
    branch = f'voc-agent/{RUN}/main'
    refusal = write_policy.branch_refusal(branch, branch, RUN)
    assert refusal is not None
    assert refusal.code == 'default_branch'


@pytest.mark.parametrize('run_id', ['', '../x', 'a/b', '-x'])
def test_refuses_a_run_id_it_does_not_know(run_id: str) -> None:
    refusal = write_policy.branch_refusal(f'voc-agent/{run_id}/fix', 'main', run_id)
    assert refusal is not None
    assert refusal.code == 'bad_run'


@pytest.mark.parametrize('rest', ['fix-refund-total-42', 'fix/v1.2', 'fix.locked', 'a.b/c_d'])
def test_allows_a_branch_of_the_run(rest: str) -> None:
    assert write_policy.branch_refusal(f'voc-agent/{RUN}/{rest}', 'main', RUN) is None


@pytest.mark.parametrize('path', ['.github/workflows/ci.yml', '/.github/workflows/x.yaml', '.github/actions/a/action.yml',
                                  '.gitlab-ci.yml', '.gitlab/ci/test.yml'])
def test_refuses_ci_definitions(path: str) -> None:
    assert [r.code for r in write_policy.path_refusals([path, 'src/app.py'])] == ['ci_definition']


def test_allows_ordinary_paths() -> None:
    assert write_policy.path_refusals(['src/app.py', 'docs/ci.md', '.github/CODEOWNERS']) == []


def test_check_push_names_every_reason() -> None:
    with pytest.raises(WriteRefused) as caught:
        write_policy.check_push('main', 'main', RUN, ['.github/workflows/ci.yml'])
    assert 'default branch' in caught.value.reason
    assert '.github/workflows/ci.yml' in caught.value.reason


def test_check_push_passes_an_allowed_push() -> None:
    write_policy.check_push(f'voc-agent/{RUN}/fix-1', 'main', RUN, ['src/app.py'])
    assert write_policy.path_refusals(['src/app.py']) == []


def test_refuses_a_quoted_review_whatever_its_case_and_spacing() -> None:
    text = f'Fixture:\n  "{REVIEW.upper().replace(" ", "   ")}"'
    assert [r.code for r in write_policy.text_refusals(text, [REVIEW], prose=False)] == ['customer_text']


def test_refuses_one_quoted_sentence_of_a_longer_review() -> None:
    review = f'{REVIEW} Support was friendly once I reached them. Five stars for the app itself.'
    text = 'Evidence: "support was friendly once I reached them."'
    assert [r.code for r in write_policy.text_refusals(text, [review], prose=True)] == ['customer_text']


@pytest.mark.parametrize('text', [
    'Customer said: the refund took three weeks and nobody answered my emails about it',
    '"The refund took three weeks and nobody answered my emails about it," she wrote',
])
def test_refuses_a_quote_without_its_punctuation(text: str) -> None:
    assert [r.code for r in write_policy.text_refusals(text, [REVIEW], prose=True)] == ['customer_text']


@pytest.mark.parametrize('hidden', [
    REVIEW.replace('refund', f're{chr(0x200B)}fund'),               # a zero-width space inside a word
    REVIEW.replace('three', f'three{chr(0x2060)}').replace('nobody', f'nobody{chr(0x200D)}'),  # joiners
    REVIEW.replace('The', f'{chr(0xFF34)}he'),                      # a full-width T (NFKC: T)
])
def test_an_invisible_or_compatibility_character_does_not_hide_a_quote(hidden: str) -> None:
    assert hidden != REVIEW
    assert [r.code for r in write_policy.text_refusals(f'Quote: "{hidden}"', [REVIEW], prose=True)] == [
        'customer_text']


def test_matches_whole_words_only() -> None:
    review = 'The courier left the parcel at the wrong door.'
    assert write_policy.text_refusals('Sorted: the courier left the parcel at the wrong doorway', [review],
                                      prose=True) == []


def test_a_short_review_is_not_matched() -> None:
    assert write_policy.text_refusals('Great app, thanks', ['Great app'], prose=True) == []


@pytest.mark.parametrize('text', ['Contact casey@mail-host.net for details', 'Call +1 555 010 0199 today',
                                  'Phone +1 (555) 010-0199', 'Reach us on 555-010-0199'])
def test_refuses_personal_data_in_prose(text: str) -> None:
    assert [r.code for r in write_policy.text_refusals(text, [], prose=True)] == ['personal_data']


@pytest.mark.parametrize('text', ['Released at 1731400000 (epoch)', 'Order 123456789012 retried',
                                  'Built 2026-11-12 10:00 from 6.04.09', 'Host 192.168.100.200, ratio 0.8333333333',
                                  'row = [0 0 0 0 0 0 0 0 0]', 'Mail user@example.com or qa@team.test'])
def test_what_is_not_personal_data(text: str) -> None:
    assert write_policy.text_refusals(text, [], prose=True) == []


def test_code_is_not_checked_for_personal_data() -> None:
    line = 'remote = "git@code-host.net:team/app.git"  # tel: +1 555 010 0199'
    assert write_policy.text_refusals(line, [], prose=False) == []
    assert [r.code for r in write_policy.text_refusals(line, [], prose=True)] == ['personal_data', 'personal_data']


def test_allows_text_that_cites_ids() -> None:
    text = 'Fixes the refund total (feedback fb_0123abcd, fb_4567ef01).'
    assert write_policy.text_refusals(text, [REVIEW], prose=True) == []


def test_check_text_names_every_reason() -> None:
    with pytest.raises(WriteRefused) as caught:
        write_policy.check_text(f'Ask casey@mail-host.net: "{REVIEW}"', [REVIEW], prose=True)
    assert caught.value.reason == ('The text holds an email address. '
                                   'The text quotes a customer review; cite its feedback id instead.')


def test_check_text_passes_clean_text() -> None:
    write_policy.check_text('Fix the rounding of refund totals.', [REVIEW], prose=True)
    assert write_policy.text_refusals('Fix the rounding of refund totals.', [REVIEW], prose=True) == []


@pytest.mark.parametrize(('message', 'prose', 'authorship'), [
    ('Fix the total\n\nCo-authored-by: Casey <casey@mail-host.net>\nRefs: fb_01',
     'Fix the total\n\nRefs: fb_01', 'Co-authored-by: Casey <casey@mail-host.net>'),
    ('Fix the total\n\nsigned-off-by: C <c@mail-host.net>\nCo-Authored-By: D <d@mail-host.net>',
     'Fix the total', 'signed-off-by: C <c@mail-host.net>\nCo-Authored-By: D <d@mail-host.net>'),
    ('Fix the total\n\nReported-by: casey@mail-host.net', 'Fix the total\n\nReported-by: casey@mail-host.net', ''),
    ('Fix the total\n\nWhy: rounding came first.\nAnd more prose.', None, ''),
    ('Refs: fb_01', None, ''),
])
def test_split_trailers_sets_apart_only_the_authorship_trailers(message: str, prose: str | None,
                                                                 authorship: str) -> None:
    assert write_policy.split_trailers(message) == (message if prose is None else prose, authorship)


#: The connection's bot addresses: the only ones a commit (author, committer, trailers) may carry.
BOT = 'voc-agents[bot]@users.noreply.code-host.net'
BOTS = (BOT,)
BAD_TRAILER = ('An authorship trailer is "Co-authored-by: Name <address>" or "Signed-off-by: Name <address>", '
               'and nothing else.')
NOT_THE_BOT = "An authorship trailer names only the connection's bot address."
NOT_BOT_COMMIT = "A commit's author and committer are the connection's bot address, nothing else."


@pytest.mark.parametrize('trailer', [f'Signed-off-by: VoC agents <{BOT}>', f'Co-authored-by: VoC agents <{BOT}>',
                                     f'SIGNED-OFF-BY: VoC agents <{BOT.upper()}>'])
def test_an_authorship_trailer_may_name_the_bot(trailer: str) -> None:
    write_policy.check_commit_message(f'Fix the total\n\n{trailer}', [REVIEW], BOTS)
    assert write_policy.authorship_refusals(trailer, [REVIEW], BOTS) == []


@pytest.mark.parametrize(('message', 'expected'), [
    ('Fix the total for casey@mail-host.net\n\nRefs: fb_01', 'The text holds an email address.'),
    (f'Fix the total\n\nQuote: {REVIEW}', 'The text quotes a customer review; cite its feedback id instead.'),
    ('Fix the total\n\nReported-by: casey@mail-host.net', 'The text holds an email address.'),
    ('Fix the total\n\nCall: +1 555 010 0199', 'The text holds a phone number.'),
    (f'Fix the total\n\nSigned-off-by: VoC agents <{BOT}>\nReported-by: casey@mail-host.net',
     'The text holds an email address.'),
    # A phone number, another address or a review sentence in the trailer's name part.
    (f'Fix the total\n\nSigned-off-by: Casey +1 555 010 0199 <{BOT}>', 'The text holds a phone number.'),
    (f'Fix the total\n\nSigned-off-by: Casey alt@mail-host.net <{BOT}>', 'The text holds an email address.'),
    (f'Fix the total\n\nCo-authored-by: {REVIEW} <{BOT}>',
     'The text quotes a customer review; cite its feedback id instead.'),
    # Any address but the bot's: a person's (even the one the agent put in the author field), a look-alike.
    ('Fix the total\n\nSigned-off-by: Casey <casey@mail-host.net>', NOT_THE_BOT),
    (f'Fix the total\n\nCo-authored-by: VoC agents <{BOT}.evil>', NOT_THE_BOT),
    # Anything but "Name <address>".
    (f'Fix the total\n\nCo-authored-by: {REVIEW}', BAD_TRAILER),
    (f'Fix the total\n\nSigned-off-by: {BOT}', BAD_TRAILER),
    (f'Fix the total\n\nSigned-off-by: VoC agents <{BOT}> +1 555 010 0199', BAD_TRAILER),
    (f'Fix the total\n\nSigned-off-by: VoC agents <{BOT}> <{BOT}>', BAD_TRAILER),
])
def test_a_commit_message_with_customer_text_is_refused(message: str, expected: str) -> None:
    with pytest.raises(WriteRefused) as caught:
        write_policy.check_commit_message(message, [REVIEW], BOTS)
    assert caught.value.reason == expected


def test_a_commit_by_the_bot_passes() -> None:
    write_policy.check_commit_identities(BOT, BOT.upper(), BOTS)
    with pytest.raises(WriteRefused):
        write_policy.check_commit_identities(BOT, BOT, ())   # a connection with no bot address pushes nothing


@pytest.mark.parametrize(('author', 'committer'), [
    ('casey@mail-host.net', BOT), (BOT, 'casey@mail-host.net'), (f'{BOT}.evil', BOT), ('', BOT)])
def test_a_commit_authored_or_committed_by_anyone_but_the_bot_is_refused(author: str, committer: str) -> None:
    with pytest.raises(WriteRefused) as caught:
        write_policy.check_commit_identities(author, committer, BOTS)
    assert caught.value.reason == NOT_BOT_COMMIT


@pytest.mark.parametrize('heads', [(), ('refs/heads/a', 'refs/heads/b')])
def test_check_heads_refuses_none_or_several(heads: tuple[str, ...]) -> None:
    write_policy.check_heads(('refs/heads/a',))
    with pytest.raises(WriteRefused):
        write_policy.check_heads(heads)


def test_one_line_of_a_review_written_without_full_stops_is_matched() -> None:
    review = 'Love the app overall\nBut the refund screen freezes every single time\nPlease fix'
    text = 'Customer wrote: but the refund screen freezes every single time'
    assert [r.code for r in write_policy.text_refusals(text, [review], prose=True)] == ['customer_text']
    assert write_policy.text_refusals('the refund screen freezes', [review], prose=True) == []
