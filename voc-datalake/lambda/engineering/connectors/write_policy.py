"""What a connector refuses before a repository host would (docs/autonomous-engineering.md).

Every write an engineering agent makes goes through the connector's broker, and the broker checks it here first:

* a push only to a branch of the agent's own run (``voc-agent/{run_id}/...``), never to the default branch;
* no change to the CI definition paths it knows (best effort: the CI attestation is the real boundary);
* no customer text: a write the agents made that holds, verbatim, a sentence of a review the run cited (comments,
  pull request bodies, commit messages and the lines a diff adds), or, in prose (comments, pull request bodies,
  commit messages but for their authorship trailers), a value shaped like personal data (an email address, a
  phone number).

Pure functions, no I/O: the broker calls them and raises on a refusal.
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass
from typing import Final

# The agents' branch prefix (``voc-agent/``) is runtime/outputs.py's, shared with the harness, whose committer's and PR
# author's tools check a branch against it.
from engineering.runtime.outputs import AGENT_BRANCH_PREFIX

#: A run id: an ASCII letter or digit, then up to 63 more of letters, digits, ``_`` and ``-``.
#: A branch name's rest (after ``voc-agent/{run_id}/``): an ASCII letter or digit, then up to 149 more of letters,
#: digits, ``.``, ``_``, ``/`` and ``-`` (``branch_refusal`` also refuses ``..``, ``//`` and a trailing ``/``, ``.``
#: or ``.lock``).
_RUN_ID: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}')
_BRANCH_REST: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,149}')
#: CI definitions an agent never changes (the GitHub App holds no ``workflows`` permission either).
_CI_PATHS: Final = re.compile(r'^(?:\.github/workflows/|\.github/actions/|\.gitlab-ci\.yml\Z|\.gitlab/ci/)')
_EMAIL: Final = re.compile(r'[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})')
#: Reserved for examples and tests (RFC 2606), so never a person's address.
_RESERVED_DOMAIN: Final = re.compile(r'(?:^|\.)(?:example(?:\.(?:com|net|org))?|test|invalid|localhost)\Z', re.IGNORECASE)
#: A phone number: an optional +, then 9 to 15 digits with spaces, brackets or dashes between them
#: ("+1 (555) 010-0199"). A dot is not a separator, so an IP address or a decimal is never one.
_PHONE: Final = re.compile(r'(?<![\w.])\+?\(?\d(?:[\s()-]{0,2}\d){8,14}(?![\w.])')
#: A bare run of digits (a timestamp, an order id) is not a phone number: one needs a leading + or a separator.
_PHONE_SHAPE: Final = re.compile(r'^\+|[\s()-]')
#: Nor is a date ("2026-11-12 10:00") or a row of one-digit values ("0 0 0 0 0 0 0 0 0").
_ISO_DATE: Final = re.compile(r'^\d{4}-\d{2}-\d{2}')
_SINGLE_DIGITS: Final = re.compile(r'^\d(?:[\s()-]+\d)+\Z')
#: Punctuation is dropped before matching, so a quote without its full stop or inside quotation marks still matches.
_NOT_WORD: Final = re.compile(r'[^\w\s]')
#: A review splits into sentences at a full stop, ! or ? and at every line break (a review written in lines with no
#: full stops is matched line by line).
_SENTENCE_END: Final = re.compile(r'(?<=[.!?])\s+|\n+')
#: A git trailer line ("Co-authored-by: A. Person <a@mail-host.net>", "Refs: fb_0123abcd").
_TRAILER: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9-]*: \S')
#: The trailers that name a commit's authors: the only ones not read as the agents' prose.
_AUTHORSHIP_TRAILER: Final = re.compile(r'(?:co-authored-by|signed-off-by): \S', re.IGNORECASE)
#: The one form an authorship trailer may take: ``Co-authored-by: Name <address>`` (or ``Signed-off-by:``).
_AUTHORSHIP_FORM: Final = re.compile(
    r'(?:co-authored-by|signed-off-by): (?P<name>[^<>\n]*[^<>\s]) <(?P<address>[^<>\s]+)>', re.IGNORECASE)
#: A review sentence shorter than this is too common a phrase to match on ("Great app").
MIN_REVIEW_MATCH: Final = 24


class BrokerError(Exception):
    """What the broker answers a caller with instead of a result; ``reason`` (the one argument) is a plain sentence
    for the run journal."""

    @property
    def reason(self) -> str:
        return str(self.args[0])


class WriteRefused(BrokerError):
    """The broker refused a write."""


@dataclass(frozen=True)
class Refusal:
    """One reason a write is refused."""

    code: str
    message: str


def branch_refusal(branch: str, default_branch: str, run_id: str) -> Refusal | None:
    """Why a push to ``branch`` is refused, or ``None`` when it is a branch of the run ``run_id`` (from the caller's
    role session name, never from the request)."""
    if branch == default_branch:
        return Refusal('default_branch', 'An agent never pushes to the default branch.')
    if not _RUN_ID.fullmatch(run_id):
        return Refusal('bad_run', 'The run is not one the connector knows.')
    own = f'{AGENT_BRANCH_PREFIX}{run_id}/'
    if not branch.startswith(own):
        return Refusal('not_run_branch', f'An agent pushes only to its own run\'s branches ({own}...).')
    rest = branch[len(own):]
    # git check-ref-format's rules on top of the character set: no "..", "//" or "@{", no component that starts
    # with "." or ends with ".lock", no trailing "/" or ".".
    components = rest.split('/')
    if (not _BRANCH_REST.fullmatch(rest) or '..' in rest or '@{' in rest or rest.endswith(('/', '.'))
            or any(not c or c.startswith('.') or c.endswith('.lock') for c in components)):
        return Refusal('bad_branch_name', 'The branch name is not one the connector creates.')
    return None


def path_refusals(paths: Iterable[str]) -> list[Refusal]:
    """A refusal for each changed path an agent may not touch (the CI definitions it knows)."""
    return [Refusal('ci_definition', f'An agent never changes the CI definitions ({path}).')
            for path in sorted(set(paths)) if _CI_PATHS.match(path.lstrip('/'))]


def _normalise(text: str) -> str:
    """Words only: case, punctuation, whitespace, compatibility forms (NFKC: full-width letters, ligatures) and
    invisible format characters (Unicode Cf: zero-width spaces and joiners, bidi marks) aside, padded so a match is
    on whole words."""
    visible = ''.join(c for c in unicodedata.normalize('NFKC', text) if unicodedata.category(c) != 'Cf')
    return f" {' '.join(_NOT_WORD.sub(' ', visible.casefold()).split())} "


def _sentences(review: str) -> list[str]:
    """The review's sentences long enough to be its own words, normalised."""
    return [s for s in (_normalise(part) for part in _SENTENCE_END.split(review)) if len(s.strip()) >= MIN_REVIEW_MATCH]


def _has_email(text: str) -> bool:
    return any(not _RESERVED_DOMAIN.search(m.group(1)) for m in _EMAIL.finditer(text))


def _is_phone(candidate: str) -> bool:
    return (_PHONE_SHAPE.search(candidate) is not None and not _ISO_DATE.match(candidate)
            and not _SINGLE_DIGITS.match(candidate))


def _has_phone(text: str) -> bool:
    return any(_is_phone(m.group()) for m in _PHONE.finditer(text))


def text_refusals(text: str, review_texts: Iterable[str], *, prose: bool) -> list[Refusal]:
    """Refusals for customer text in ``text``: a sentence of a review the run cited (verbatim; case, spacing and
    punctuation aside, on whole words), and, when ``text`` is ``prose`` (not code), a value shaped like personal data.
    A paraphrase passes; a person reviews every pull request.
    """
    found: list[Refusal] = []
    if prose and _has_email(text):
        found.append(Refusal('personal_data', 'The text holds an email address.'))
    if prose and _has_phone(text):
        found.append(Refusal('personal_data', 'The text holds a phone number.'))
    haystack = _normalise(text)
    if any(sentence in haystack for review in review_texts for sentence in _sentences(review)):
        found.append(Refusal('customer_text', 'The text quotes a customer review; cite its feedback id instead.'))
    return found


def check_push(branch: str, default_branch: str, run_id: str, changed_paths: Iterable[str]) -> None:
    """Raise ``WriteRefused`` unless a push of ``changed_paths`` to ``branch`` by run ``run_id`` is allowed."""
    refusals = [r for r in [branch_refusal(branch, default_branch, run_id)] if r is not None]
    refusals += path_refusals(changed_paths)
    if refusals:
        raise WriteRefused(' '.join(r.message for r in refusals))


def check_text(text: str, review_texts: Iterable[str], *, prose: bool) -> None:
    """Raise ``WriteRefused`` when ``text`` carries customer text (``prose``: a comment, a pull request body or a
    commit message but for its authorship trailers; otherwise the lines a diff adds)."""
    refusals = text_refusals(text, review_texts, prose=prose)
    if refusals:
        raise WriteRefused(' '.join(r.message for r in refusals))


def split_trailers(message: str) -> tuple[str, str]:
    """A commit message's prose and its authorship trailers: the ``Co-authored-by:`` and ``Signed-off-by:`` lines
    (any case) of its trailer block, the last paragraph when every line is ``Token: value``. Every other trailer
    (``Reported-by:``, ``Refs:``) stays in the prose; the authorship is ``''`` when there is none."""
    paragraphs = message.rstrip().split('\n\n')
    last = paragraphs[-1].splitlines()
    if len(paragraphs) < 2 or not last or not all(_TRAILER.match(line) for line in last):
        return message, ''
    authorship = [line for line in last if _AUTHORSHIP_TRAILER.match(line)]
    others = [line for line in last if not _AUTHORSHIP_TRAILER.match(line)]
    return '\n\n'.join(paragraphs[:-1] + (['\n'.join(others)] if others else [])), '\n'.join(authorship)


def _is_bot(address: str, bot_addresses: Collection[str]) -> bool:
    return address.casefold() in {bot.casefold() for bot in bot_addresses}


def authorship_refusals(trailer: str, review_texts: Sequence[str], bot_addresses: Collection[str]) -> list[Refusal]:
    """Refusals for one authorship trailer: it is exactly ``Co-authored-by: Name <address>`` (or ``Signed-off-by:``),
    its name is prose like any other (no phone number, no other address, no review sentence), and its address is
    one of the connection's ``bot_addresses`` (compared without case). The agents set a commit's author and
    committer themselves, so neither is a source of allowed addresses."""
    form = _AUTHORSHIP_FORM.fullmatch(trailer)
    if form is None:
        return [Refusal('bad_trailer', 'An authorship trailer is "Co-authored-by: Name <address>" or '
                                       '"Signed-off-by: Name <address>", and nothing else.')]
    found = text_refusals(form.group('name'), review_texts, prose=True)
    if not _is_bot(form.group('address'), bot_addresses):
        found.append(Refusal('not_the_bot', "An authorship trailer names only the connection's bot address."))
    return found


def check_commit_message(message: str, review_texts: Sequence[str], bot_addresses: Collection[str]) -> None:
    """Raise ``WriteRefused`` when a commit message carries customer text: a review sentence anywhere, personal
    data anywhere but the address of an authorship trailer that names one of the connection's ``bot_addresses``."""
    prose, authorship = split_trailers(message)
    refusals = text_refusals(prose, review_texts, prose=True)
    for trailer in authorship.splitlines():
        refusals += authorship_refusals(trailer, review_texts, bot_addresses)
    if refusals:
        raise WriteRefused(' '.join(r.message for r in refusals))


def check_commit_identities(author: str, committer: str, bot_addresses: Collection[str]) -> None:
    """Raise ``WriteRefused`` unless a commit's author and committer are both one of the connection's bot addresses:
    the agents write those fields, so any other address could carry a person's data to the host."""
    if not (_is_bot(author, bot_addresses) and _is_bot(committer, bot_addresses)):
        raise WriteRefused("A commit's author and committer are the connection's bot address, nothing else.")


def check_heads(heads: Sequence[str]) -> None:
    """Raise ``WriteRefused`` unless a bundle carries exactly one head ref (the one commit the push puts on the
    branch)."""
    if len(heads) != 1:
        raise WriteRefused(f'A pushed bundle carries exactly one head ref; this one carries {len(heads)}.')
