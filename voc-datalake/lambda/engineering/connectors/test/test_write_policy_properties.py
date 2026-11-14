"""Properties of what the connector refuses before a host sees it (connectors/write_policy.py).

The policy is the last check on what an engineering agent writes: a push only to its own run's branch, never the
default branch, never a CI definition, never a review quoted back, never a person's address or phone number in prose,
and a commit whose author and committer are the bot. Each property states the rule in words; the generators build
realistic branch names, paths, sentences and contact details rather than random noise.
"""
from __future__ import annotations

import re

import pytest
from hypothesis import given
from hypothesis import strategies as st

from engineering.connectors import write_policy
from engineering.connectors.write_policy import (
    AGENT_BRANCH_PREFIX,
    MIN_REVIEW_MATCH,
    WriteRefused,
    branch_refusal,
    check_commit_identities,
    check_paths,
    check_text,
    path_refusals,
    text_refusals,
)
from shared.test.properties import PROPERTY

DEFAULT_BRANCH = 'main'
# A run id as the supervisor names one: a letter or digit, then letters, digits, "_" or "-".
RUN_IDS = st.from_regex(r'[A-Za-z0-9][A-Za-z0-9_-]{0,20}', fullmatch=True)
# The rest of a branch name, the way the connector makes one: "fix-tests", "agent/2026-11-13/retry_3".
BRANCH_RESTS = st.from_regex(r'[a-z0-9][a-z0-9-]{0,12}(?:/[a-z0-9][a-z0-9-]{0,12}){0,2}', fullmatch=True)
# A repository path, with a CI definition sometimes among them.
CI_PATHS = st.sampled_from(['.github/workflows/ci.yml', '.github/actions/setup/action.yml', '.gitlab-ci.yml',
                            '.gitlab/ci/build.yml', '/.github/workflows/release.yml'])
ORDINARY_PATHS = st.from_regex(r'[a-z][a-z0-9_]{0,8}(/[a-z][a-z0-9_]{0,8}){0,3}\.(py|ts|md|json)', fullmatch=True)
WORDS = st.sampled_from(['the', 'checkout', 'button', 'hides', 'on', 'small', 'screens', 'after', 'the', 'update',
                         'customers', 'report', 'slow', 'loading', 'when', 'filtering', 'orders', 'by', 'date'])
# A review sentence: enough words to be its own match, one that a person could quote.
REVIEW_SENTENCES = st.lists(WORDS, min_size=6, max_size=14).map(' '.join).filter(
    lambda s: len(s) >= MIN_REVIEW_MATCH)
LOCAL_PARTS = st.from_regex(r'[a-z][a-z0-9]{2,10}', fullmatch=True)
# Company-style domains, never the reserved ones (RFC 2606).
REAL_DOMAINS = st.from_regex(r'[a-z][a-z0-9]{2,10}\.(com|org|io|co\.uk)', fullmatch=True)
RESERVED_DOMAINS = st.sampled_from(['example.com', 'example.org', 'mail.example.net', 'test', 'app.test', 'localhost'])
PHONE_DIGITS = st.integers(min_value=10**8, max_value=10**15 - 1).map(str)


@PROPERTY
@given(run_id=RUN_IDS, rest=BRANCH_RESTS)
def test_a_run_pushes_only_to_a_branch_of_its_own_run(run_id: str, rest: str) -> None:
    """A run's push is accepted only on a branch under its own run's prefix; a branch of another run is refused."""
    own = f'{AGENT_BRANCH_PREFIX}{run_id}/{rest}'
    assert branch_refusal(own, DEFAULT_BRANCH, run_id) is None
    other = f'{AGENT_BRANCH_PREFIX}{run_id}x/{rest}'
    assert branch_refusal(other, DEFAULT_BRANCH, run_id) is not None
    assert branch_refusal(f'{AGENT_BRANCH_PREFIX}other-run/{rest}', DEFAULT_BRANCH, run_id) is not None


@PROPERTY
@given(run_id=RUN_IDS, default=st.sampled_from([DEFAULT_BRANCH, 'master', 'trunk', 'release-1']))
def test_no_run_ever_pushes_to_the_default_branch(run_id: str, default: str) -> None:
    """The default branch is refused whatever the run and whatever the repository calls it, even when a run's own
    prefix is spelled the same way."""
    assert branch_refusal(default, default, run_id) is not None
    assert branch_refusal(f'{AGENT_BRANCH_PREFIX}{run_id}/{default}', default, run_id) is None


@PROPERTY
@given(run_id=RUN_IDS, rest=BRANCH_RESTS, bad=st.sampled_from(['..', '@{', '//', 'x/', 'x.', '/.hidden',
                                                               '/b.lock', ' b', '~b', '^b', ':b']))
def test_a_branch_name_git_would_not_create_is_refused(run_id: str, rest: str, bad: str) -> None:
    """A branch name with a git-forbidden piece is refused even under the run's own prefix."""
    assert branch_refusal(f'{AGENT_BRANCH_PREFIX}{run_id}/{rest}{bad}', DEFAULT_BRANCH, run_id) is not None


@PROPERTY
@given(paths=st.lists(st.one_of(CI_PATHS, ORDINARY_PATHS), min_size=1, max_size=8))
def test_a_ci_definition_is_refused_and_nothing_else_is(paths: list[str]) -> None:
    """Exactly the paths under a CI definition are refused, one refusal each (a repeated path, once); a path only
    named like one (``src/.github/...``, ``.gitlab-ci.yml.bak``) is ordinary."""
    ci = {p for p in paths if p.lstrip('/').startswith(('.github/workflows/', '.github/actions/', '.gitlab/ci/'))
          or p.lstrip('/') == '.gitlab-ci.yml'}
    refusals = path_refusals(paths)
    assert len(refusals) == len(ci)
    assert all(r.code == 'ci_definition' for r in refusals)
    assert path_refusals(['src/.github/workflows/ci.yml', '.gitlab-ci.yml.bak', 'docs/CI.md']) == []


@PROPERTY
@given(path=CI_PATHS)
def test_a_push_is_refused_if_any_of_its_paths_is_refused(path: str) -> None:
    """A push's paths are allowed only when every one is: one CI definition among them is enough."""
    check_paths(['src/app.py'])
    with pytest.raises(WriteRefused) as refused:
        check_paths(['src/app.py', path])
    assert refused.value.reason == f'An agent never changes the CI definitions ({path}).'


@PROPERTY
@given(sentence=REVIEW_SENTENCES, upper=st.booleans(), decoration=st.sampled_from(['', '!', '.', '  ', ' "']))
def test_a_review_quoted_back_is_refused_whatever_its_case_and_punctuation(sentence: str, upper: bool,
                                                                          decoration: str) -> None:
    """A review sentence quoted verbatim is refused, case, spacing and punctuation aside; the quote is a customer's
    words, so a paraphrase is the only form the agents may write."""
    quoted = sentence.upper() if upper else sentence
    refusals = text_refusals(f'Fix for {quoted}{decoration}', [sentence], prose=False)
    assert [r.code for r in refusals] == ['customer_text']
    assert text_refusals('Fix the layout bug in the header', [sentence], prose=False) == []


@PROPERTY
@given(local=LOCAL_PARTS, domain=REAL_DOMAINS)
def test_a_person_address_in_prose_is_refused(local: str, domain: str) -> None:
    """An email address in prose (a comment, a pull request body, a commit message) is refused: a person's data."""
    text = f'Contact {local}@{domain} about this.'
    assert [r.code for r in text_refusals(text, [], prose=True)] == ['personal_data']
    assert text_refusals(text, [], prose=False) == []


@PROPERTY
@given(local=LOCAL_PARTS, domain=RESERVED_DOMAINS)
def test_a_reserved_example_address_is_not_a_persons(local: str, domain: str) -> None:
    """Addresses in the reserved example domains (RFC 2606) are never a person's, so they pass."""
    assert text_refusals(f'Use {local}@{domain} in the fixture.', [], prose=True) == []


@PROPERTY
@given(number=PHONE_DIGITS, after=st.sampled_from([' today', '.', '. Thanks', '!', '?', ',', ')', ';', '']))
def test_a_phone_number_in_prose_is_refused(number: str, after: str) -> None:
    """A phone number written with a leading plus sign in prose is personal data and is refused, whatever ends the
    sentence or the clause after it."""
    assert [r.code for r in text_refusals(f'Call +{number}{after}', [], prose=True)] == ['personal_data']


@PROPERTY
# A count of 9 to 15 digits has a phone number's length, so only the shape rule (no + and no separator) passes it.
@given(date=st.dates().map(lambda d: d.isoformat()),
       count=st.one_of(st.integers(min_value=0, max_value=999999), st.integers(min_value=10**8, max_value=10**15 - 1)))
def test_a_date_or_a_count_is_not_a_phone_number(date: str, count: int) -> None:
    """A date and a bare run of digits (a count, a timestamp) are not phone numbers; neither is a row of one-digit
    values, so the prose check does not block ordinary numbers."""
    assert text_refusals(f'Released {date} with {count} tickets', [], prose=True) == []
    assert text_refusals('0 0 0 0 0 0 0 0 0 1', [], prose=True) == []


@PROPERTY
@given(author=st.from_regex(r'[a-z]{3,8}@[a-z]{3,8}\.bot', fullmatch=True),
       committer=st.from_regex(r'[a-z]{3,8}@[a-z]{3,8}\.bot', fullmatch=True))
def test_a_commit_is_written_only_as_the_connections_bot(author: str, committer: str) -> None:
    """A commit's author and committer are the connection's bot address, and nothing else: a different address,
    on either field, is refused (it could carry a person's data to the host)."""
    bots = [author, committer]
    check_commit_identities(author, committer, bots)
    check_commit_identities(author.upper(), committer, bots)   # the address is compared without case
    person = 'person@corp.example.org'
    for author_, committer_ in [(person, committer), (author, person), (person, person)]:
        with pytest.raises(WriteRefused):
            check_commit_identities(author_, committer_, bots)


@PROPERTY
@given(text=st.text(alphabet=st.characters(blacklist_categories=('Cs',)), max_size=200))
def test_a_text_with_no_review_quoted_is_refused_for_nothing_but_personal_data(text: str) -> None:
    """With no review cited, a text is refused only for personal data (never for customer text), and code is not
    checked for personal data at all (the lines a diff adds)."""
    assert all(r.code == 'personal_data' for r in text_refusals(text, [], prose=True))
    assert text_refusals(text, [], prose=False) == []
    check_text(text, [], prose=False)


# The phone rule as it was before 7.01.02, written out here: the fix may only add refusals, never drop one.
_PHONE_BEFORE = re.compile(r'(?<![\w.])\+?\(?\d(?:[\s()-]{0,2}\d){8,14}(?![\w.])')
_DATE_START_BEFORE = re.compile(r'^\d{4}-\d{2}-\d{2}')


def _refused_before(text: str) -> bool:
    return any(re.search(r'^\+|[\s()-]', m.group()) and not _DATE_START_BEFORE.match(m.group())
               and not re.match(r'^\d(?:[\s()-]+\d)+\Z', m.group()) for m in _PHONE_BEFORE.finditer(text))


# Text joined from the pieces phone numbers, dates, decimals and identifiers are made of, so numbers the old rule
# refused, and the edges around them, are drawn often (single random characters almost never make one).
NUMBERISH = st.lists(st.sampled_from(['2026-11-14', '555-010-0199', '+1 555 010 0199', '(555) 010', '1234', '12', '0',
                                      '_', '.', ' ', '-', '(', ')', '+', 'a', '\n']), max_size=8).map(''.join)


def test_the_tight_reading_is_the_old_rule_exactly() -> None:
    """The superset rests on one reading being the old rule, character for character."""
    assert write_policy._PHONE_TIGHT.pattern == _PHONE_BEFORE.pattern


@PROPERTY
@given(text=NUMBERISH)
def test_every_phone_number_refused_before_is_still_refused(text: str) -> None:
    """The 7.01.02 fix only widens the phone rule: whatever the old rule refused as a phone number, the new one does."""
    if _refused_before(text):
        assert [r.code for r in text_refusals(text, [], prose=True)] == ['personal_data']
