"""Public repositories and their upstream (7.57.00; docs/autonomous-engineering.md, "Any public repository").

The pure rules every side shares, with nothing read here: the token function reads GitHub (``app_tokens.py``), the
Agents API stores connections (``public_repos.py``, ``forks.py``) and the broker opens the upstream pull request
(``upstream_pr.py``). No ``cryptography`` here: the Agents API imports this module too.

* **A repository's facts** (``RepositoryFacts``, from GitHub's repository answer): its stars, its licence (SPDX), whether
  it is archived, private or a fork (and of what), when it was last pushed, its default branch and topics. Text that
  GitHub holds for a repository's owner (its description) is cut to one line of ``MAX_DESCRIPTION`` characters.
* **The picker's query** (``parse_query``): a GitHub URL or ``owner/name`` names one repository; anything else is a
  search of public repositories (``is:public``), ``MAX_QUERY`` characters at most.
* **Opting out of bot pull requests** (``opt_out``): a repository opts out with a topic or a label named
  ``no-bot-prs`` or ``no-ai-prs``, or with ``<!-- no-bot-prs -->`` / ``<!-- no-ai-prs -->`` in its CONTRIBUTING file
  (the markers are documented in docs/autonomous-engineering.md). An opted-out repository gets no fork workflow and no
  upstream pull request.
* **What CONTRIBUTING asks** (``contributing_asks``, a best-effort reading): a sign-off under the Developer Certificate
  of Origin (``Signed-off-by``, ``DCO``), which the agents' commits cannot give for a person; an issue before a pull
  request, which the run's issue answers.
* **The upstream pull request's body** (``upstream_body``): the upstream's pull request template with its comments
  taken out, the run's own description under its description section (else after the template), the issue it fixes,
  the CONTRIBUTING file it followed and the AI-assistance disclosure line (``DISCLOSURE``); at most ``MAX_BODY``.
* **The one-click link** (``compare_link``): GitHub's compare page of the fork's branch against the upstream's default
  branch, ``https://github.com/<upstream>/compare/<base>...<fork owner>:<fork name>:<branch>?expand=1&title=…&body=…``,
  its title and body prefilled, so the person opens the upstream pull request themselves with one click (Create): it
  needs no token, no App on the upstream and no permission beyond the person's own. At most ``MAX_COMPARE_URL``
  characters: past it, the link carries a short body (the issue, a pointer to the full text and the disclosure) and the
  full text is kept for "Copy the description".

The owner's model, plainly: the upstream is the organization's (e.g. ``aws-samples/X``); the fork and the pull requests
are the person's (``<their account>/X``, opened from it, by their click or, once they authorized it, by the app as
them).
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Final, Literal
from urllib.parse import quote, urlencode

from shared.github_rest import GITHUB_REPOSITORY, parse_repo

#: The markers a repository opts out of bot pull requests with (a topic, a label, or ``<!-- marker -->`` in its
#: CONTRIBUTING file).
OPT_OUT_MARKERS: Final = ('no-bot-prs', 'no-ai-prs')
#: Where GitHub reads a pull request template from, the first one found wins (GitHub reads them case-insensitively;
#: the contents API does not, so both spellings are tried).
TEMPLATE_PATHS: Final = ('.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md',
                         'pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md',
                         'docs/PULL_REQUEST_TEMPLATE.md')
#: Where GitHub reads a CONTRIBUTING file from, the first one found wins.
CONTRIBUTING_PATHS: Final = ('CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md')
#: The longest picker query, and how many search results are answered.
MAX_QUERY: Final = 200
SEARCH_RESULTS: Final = 10
#: The most of a repository's description kept (one line).
MAX_DESCRIPTION: Final = 300
#: The most of a template or a CONTRIBUTING file read (a larger one is read to this).
MAX_FILE_BYTES: Final = 64 * 1024
#: GitHub's longest pull request title and body.
MAX_TITLE: Final = 256
MAX_BODY: Final = 65_536
#: The line every upstream pull request body ends with ({login}: the fork's account, whose pull request it is, opened
#: by their click on the one-click link or by the app as them).
DISCLOSURE: Final = ('AI assistance: this pull request was prepared by AI agents (the Voice of the Customer data '
                     "lake's engineering agents) on @{login}'s fork, and opened from it by @{login}. Our own quality "
                     'gate and final review passed on this change before it was opened; only the maintainers decide '
                     'whether to merge it.')
#: The longest one-click link offered (browsers and GitHub take longer; this keeps it safe everywhere).
MAX_COMPARE_URL: Final = 7000
#: The link's body when the full one makes it too long: the full text is the run's "Copy the description".
SHORT_BODY: Final = ('The full description is on the run in VoC: use "Copy the description" there and paste it here '
                     'before you create the pull request.')
#: The headings a template's description section goes by, and its issue section's.
_DESCRIPTION_HEADING: Final = re.compile(r'\b(description|summary|what|changes?|motivation|overview|about)\b',
                                         re.IGNORECASE)
_ISSUE_HEADING: Final = re.compile(r'\b(issues?|related|fix(es)?|closes|tickets?|links?)\b', re.IGNORECASE)
_HEADING: Final = re.compile(r'^\s{0,3}#{1,6}\s+(?P<text>.+?)\s*#*\s*\Z')
_COMMENT: Final = re.compile(r'<!--.*?-->', re.DOTALL)
_DCO: Final = re.compile(r'signed-off-by|\bDCO\b|developer certificate of origin', re.IGNORECASE)
_ISSUE_FIRST: Final = re.compile(r'(open|file|create|raise)\s+an?\s+issue\s+(first|before)|'
                                 r'(every|each|all)\s+pull\s+requests?\s+(must|should)\s+(be\s+)?(linked|reference)',
                                 re.IGNORECASE)
SPDX: Final = re.compile(r'[A-Za-z0-9.+-]{1,64}')
_TOPIC: Final = re.compile(r'[a-z0-9][a-z0-9-]{0,49}')

QueryKind = Literal['repository', 'search']


class UpstreamRefused(ValueError):
    """A picker query or a repository the rules do not take: the message says what to change, never a token."""


@dataclass(frozen=True)
class RepositoryFacts:
    """A repository as GitHub answers it, the fields the picker, the connections and the upstream rules use."""

    repository: str
    description: str
    stars: int
    licence_spdx: str | None
    licence_name: str
    archived: bool
    private: bool
    fork: bool
    parent: str
    pushed_at: str
    default_branch: str
    html_url: str
    topics: tuple[str, ...] = ()

    def view(self, connected: str | None = None) -> dict[str, Any]:
        """As the Agents API answers it (``connected``: the connection that already has it)."""
        licence = None if not (self.licence_spdx or self.licence_name) else {
            'spdx': self.licence_spdx, 'name': self.licence_name}
        return {'repository': self.repository, 'description': self.description or None, 'stars': self.stars,
                'licence': licence, 'archived': self.archived, 'pushed_at': self.pushed_at or None,
                'default_branch': self.default_branch, 'html_url': self.html_url, 'fork': self.fork,
                'connected': connected}

    def answer(self) -> dict[str, Any]:
        """As the token function answers it (every field, plain JSON)."""
        return {'repository': self.repository, 'description': self.description, 'stars': self.stars,
                'licence_spdx': self.licence_spdx, 'licence_name': self.licence_name, 'archived': self.archived,
                'private': self.private, 'fork': self.fork, 'parent': self.parent, 'pushed_at': self.pushed_at,
                'default_branch': self.default_branch, 'html_url': self.html_url, 'topics': list(self.topics)}


def _text(value: object, limit: int = 1000) -> str:
    return ' '.join(value.split())[:limit] if isinstance(value, str) else ''


def _get(value: object, *keys: str) -> object:
    for key in keys:
        value = value.get(key) if isinstance(value, Mapping) else None
    return value


def facts_of(data: object) -> RepositoryFacts | None:
    """GitHub's repository answer (``GET /repos/{owner}/{name}``, a search item, an installation's listing), or None
    when it names no repository as ``owner/name``."""
    name = _get(data, 'full_name')
    if not isinstance(name, str) or not GITHUB_REPOSITORY.match(name):
        return None
    stars = _get(data, 'stargazers_count')
    spdx = _get(data, 'license', 'spdx_id')
    parent = _get(data, 'parent', 'full_name')
    topics = _get(data, 'topics')
    html_url = _get(data, 'html_url')
    return RepositoryFacts(
        repository=name, description=_text(_get(data, 'description'), MAX_DESCRIPTION),
        stars=stars if isinstance(stars, int) and not isinstance(stars, bool) and stars >= 0 else 0,
        licence_spdx=spdx if isinstance(spdx, str) and SPDX.fullmatch(spdx) else None,
        licence_name=_text(_get(data, 'license', 'name'), 120),
        archived=_get(data, 'archived') is True, private=_get(data, 'private') is not False,
        fork=_get(data, 'fork') is True,
        parent=parent if isinstance(parent, str) and GITHUB_REPOSITORY.match(parent) else '',
        pushed_at=_text(_get(data, 'pushed_at'), 40), default_branch=_text(_get(data, 'default_branch'), 255),
        html_url=html_url if isinstance(html_url, str) and html_url.startswith('https://github.com/') else
        f'https://github.com/{name}',
        topics=tuple(topic for topic in (topics if isinstance(topics, list) else [])
                     if isinstance(topic, str) and _TOPIC.fullmatch(topic))[:50])


def facts_from_answer(data: object) -> RepositoryFacts | None:
    """``RepositoryFacts.answer``'s JSON read back (the Agents API's side of the token function), or None off its
    shape."""
    if not isinstance(data, Mapping):
        return None
    name = data.get('repository')
    if not isinstance(name, str) or not GITHUB_REPOSITORY.match(name):
        return None
    stars, spdx, topics = data.get('stars'), data.get('licence_spdx'), data.get('topics')
    return RepositoryFacts(
        repository=name, description=_text(data.get('description'), MAX_DESCRIPTION),
        stars=stars if isinstance(stars, int) and not isinstance(stars, bool) else 0,
        licence_spdx=spdx if isinstance(spdx, str) and SPDX.fullmatch(spdx) else None,
        licence_name=_text(data.get('licence_name'), 120), archived=data.get('archived') is True,
        private=data.get('private') is not False, fork=data.get('fork') is True,
        parent=str(data.get('parent') or ''), pushed_at=_text(data.get('pushed_at'), 40),
        default_branch=_text(data.get('default_branch'), 255),
        html_url=str(data.get('html_url') or f'https://github.com/{name}'),
        topics=tuple(t for t in (topics if isinstance(topics, list) else []) if isinstance(t, str)))


def parse_query(text: object) -> tuple[QueryKind, str]:
    """The picker's query: ``('repository', 'owner/name')`` for a GitHub URL or ``owner/name``, else ``('search',
    <the words>)``, whitespace collapsed; ``UpstreamRefused`` for an empty or too long one."""
    words = ' '.join(text.split()) if isinstance(text, str) else ''
    if not 0 < len(words) <= MAX_QUERY:
        raise UpstreamRefused(f'q is a repository\'s name, owner/name or its GitHub address, at most {MAX_QUERY} '
                              'characters')
    named = parse_repo(words) if ' ' not in words else None
    if named is not None:
        return 'repository', named
    return 'search', words


def search_text(words: str) -> str:
    """The search's ``q``: the words, public repositories only (a token may see private ones it is installed on)."""
    kept = ' '.join(word for word in words.split() if word.lower() not in {'is:private', 'is:internal'})
    return f'{kept} is:public'.strip()


def opt_out(topics: Iterable[str], labels: Iterable[str], contributing: str) -> str | None:
    """The marker a repository opts out of bot pull requests with (a topic, a label, or the comment in its
    CONTRIBUTING file), or None."""
    found = {topic.lower() for topic in topics} | {label.lower() for label in labels}
    for marker in OPT_OUT_MARKERS:
        if marker in found or f'<!-- {marker} -->' in contributing.lower():
            return marker
    return None


@dataclass(frozen=True)
class ContributingAsks:
    """What a CONTRIBUTING file asks that the platform reads (best effort): a DCO sign-off, an issue first."""

    path: str = ''
    dco: bool = False
    issue_first: bool = False

    def view(self) -> dict[str, Any]:
        return {'path': self.path or None, 'dco': self.dco, 'issue_first': self.issue_first}


def contributing_asks(path: str, text: str) -> ContributingAsks:
    """What ``text`` (the CONTRIBUTING file at ``path``) asks of a contribution, comments included."""
    return ContributingAsks(path=path, dco=bool(_DCO.search(text)), issue_first=bool(_ISSUE_FIRST.search(text)))


def strip_comments(template: str) -> str:
    """A pull request template without its HTML comments (its instructions to the author), blank runs collapsed."""
    kept = _COMMENT.sub('', template.replace('\r\n', '\n'))
    return re.sub(r'\n{3,}', '\n\n', kept).strip()


def _insert_after_heading(lines: list[str], pattern: re.Pattern[str], text: str) -> bool:
    for index, line in enumerate(lines):
        heading = _HEADING.match(line)
        if heading and pattern.search(heading.group('text')):
            lines[index + 1:index + 1] = ['', text, '']
            return True
    return False


def fill_template(template: str, description: str, issue_line: str) -> str:
    """``template`` (its comments taken out) with ``description`` under its description section and ``issue_line``
    under its issue section; without such a section, the description goes after the template's first heading (or
    before a template with none) and the issue line at the end. Checkboxes are left as the template has them: a
    person ticks them."""
    lines = strip_comments(template).split('\n') if template.strip() else []
    if not lines:
        return '\n\n'.join(part for part in (description.strip(), issue_line) if part)
    if not _insert_after_heading(lines, _DESCRIPTION_HEADING, description.strip()):
        first = next((index for index, line in enumerate(lines) if _HEADING.match(line)), None)
        if first is None:
            lines[:0] = [description.strip(), '']
        else:
            lines[first + 1:first + 1] = ['', description.strip(), '']
    if issue_line and not _insert_after_heading(lines, _ISSUE_HEADING, issue_line):
        lines += ['', issue_line]
    return re.sub(r'\n{3,}', '\n\n', '\n'.join(lines)).strip()


def without_broker_line(body: str, line: str) -> str:
    """The fork pull request's body without the broker's own closing line (``MERGE_IS_HUMAN``, the fork's), which the
    upstream's body does not carry: its own disclosure says who merges."""
    kept = body.rstrip()
    if kept.endswith(line):
        kept = kept[:-len(line)].rstrip()
        kept = kept.removesuffix('---').rstrip()
    return kept


def upstream_body(*, template: str, description: str, issue: int | None, contributing: str, login: str) -> str:
    """The upstream pull request's body: the template filled (``fill_template``), the issue it fixes (``Fixes #N``, the
    upstream's own number), the CONTRIBUTING file followed and the disclosure; ``UpstreamRefused`` past ``MAX_BODY``."""
    issue_line = f'Fixes #{issue}' if issue is not None else ''
    if issue is not None and re.search(rf'(?<![\w/#])#{issue}(?!\d)', description):
        issue_line = ''
    parts = [fill_template(template, description, issue_line)]
    if contributing:
        parts.append(f'Prepared following this repository\'s `{contributing}`.')
    parts.append(DISCLOSURE.format(login=login))
    body = '\n\n'.join(part for part in parts if part).strip()
    if len(body) > MAX_BODY:
        raise UpstreamRefused(f'the upstream pull request\'s body would be longer than GitHub takes ({MAX_BODY} '
                              'characters): shorten the fork pull request\'s description')
    return body


def upstream_title(title: str) -> str:
    """The upstream pull request's title: the fork pull request's, one line, at most ``MAX_TITLE``."""
    return ' '.join(title.split())[:MAX_TITLE]


@dataclass(frozen=True)
class CompareLink:
    """The one-click link (``url``) and whether its body is the short one (``shortened``: the full text then goes to
    "Copy the description")."""

    url: str
    shortened: bool


def short_body(issue: int | None, login: str) -> str:
    """The link's body when the full one is too long: the issue it fixes, the pointer to the full text, the
    disclosure."""
    return '\n\n'.join(part for part in (f'Fixes #{issue}' if issue is not None else '', SHORT_BODY,
                                         DISCLOSURE.format(login=login)) if part)


def compare_link(*, upstream: str, base: str, fork: str, branch: str, title: str, body: str, issue: int | None,
                 login: str) -> CompareLink:
    """GitHub's compare page that opens the upstream pull request from ``fork``'s ``branch`` against ``upstream``'s
    ``base``, title and body prefilled (``expand=1`` shows the form), at most ``MAX_COMPARE_URL`` characters: past it,
    with ``short_body``. Every part is percent-encoded (a space is ``%20``, never ``+``); ``UpstreamRefused`` for a
    repository not ``owner/name``."""
    if not (GITHUB_REPOSITORY.match(upstream) and GITHUB_REPOSITORY.match(fork)):
        raise UpstreamRefused('the upstream and the fork are owner/name')
    owner, name = fork.split('/', 1)
    head = f'{quote(owner, safe="")}:{quote(name, safe="")}:{quote(branch, safe="/")}'
    page = f'https://github.com/{upstream}/compare/{quote(base, safe="/")}...{head}'

    def link(text: str) -> str:
        return f'{page}?{urlencode({"expand": 1, "title": title, "body": text}, quote_via=quote)}'

    full = link(body)
    if len(full) <= MAX_COMPARE_URL:
        return CompareLink(url=full, shortened=False)
    return CompareLink(url=link(short_body(issue, login)), shortened=True)


def licence_refusal(facts: RepositoryFacts, acknowledged: str) -> str | None:
    """Why ``facts``' licence stops a contribution acknowledged for ``acknowledged`` (None: it does not): none, or
    another than the one acknowledged."""
    current = facts.licence_spdx
    if current is None:
        return (f'{facts.repository} has no licence GitHub recognises: contributions to it are not opened from here '
                '(ask its maintainers to add one)')
    if current != acknowledged:
        return (f'{facts.repository}\'s licence is {current}, not the {acknowledged or "none"} acknowledged for this '
                'connection: acknowledge it again on the connection')
    return None


def contribution_refusal(facts: RepositoryFacts, marker: str | None, acknowledged: str) -> str | None:
    """Why ``facts`` takes no contribution from here (None: it does): archived, opted out (``marker``), private, or its
    licence (``licence_refusal``)."""
    if facts.archived:
        return f'{facts.repository} is archived: it takes no pull requests'
    if marker is not None:
        return f'{facts.repository} opts out of bot pull requests ({marker})'
    if facts.private:
        return f'{facts.repository} is not public: the fork workflow is for public repositories'
    return licence_refusal(facts, acknowledged)
