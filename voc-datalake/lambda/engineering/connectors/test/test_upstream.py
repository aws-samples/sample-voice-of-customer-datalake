"""The public repositories' and upstreams' pure rules (upstream.py, 7.57.00): the picker's query, a repository's facts,
the opt-out markers, what CONTRIBUTING asks, the template filled, the upstream pull request's body and its one-click
link (GitHub's compare page, every part encoded, at most MAX_COMPARE_URL long)."""
from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import pytest

from engineering.connectors.upstream import (
    DISCLOSURE,
    MAX_BODY,
    MAX_COMPARE_URL,
    MAX_QUERY,
    SHORT_BODY,
    UpstreamRefused,
    compare_link,
    contributing_asks,
    contribution_refusal,
    facts_from_answer,
    facts_of,
    fill_template,
    licence_refusal,
    opt_out,
    parse_query,
    search_text,
    strip_comments,
    upstream_body,
    upstream_title,
    without_broker_line,
)

REPO = {'full_name': 'upstream-org/tool', 'description': 'A  tool\nfor things', 'stargazers_count': 1200,
        'license': {'spdx_id': 'MIT', 'name': 'MIT License'}, 'archived': False, 'private': False, 'fork': False,
        'pushed_at': '2026-11-01T10:00:00Z', 'default_branch': 'main', 'html_url': 'https://github.com/upstream-org/tool',
        'topics': ['cli', 'NOT A TOPIC', 'no-bot-prs']}


@pytest.mark.parametrize(('text', 'found'), [
    ('upstream-org/tool', ('repository', 'upstream-org/tool')),
    ('https://github.com/upstream-org/tool/issues/4', ('repository', 'upstream-org/tool')),
    ('github.com/upstream-org/tool.git', ('repository', 'upstream-org/tool')),
    ('  refund   service ', ('search', 'refund service')),
    ('tool', ('search', 'tool')),
])
def test_the_pickers_query_names_one_repository_or_searches(text: str, found: tuple[str, str]) -> None:
    assert parse_query(text) == found


@pytest.mark.parametrize('text', ['', '   ', None, 'x' * (MAX_QUERY + 1), 42])
def test_an_empty_or_too_long_query_is_refused(text: object) -> None:
    with pytest.raises(UpstreamRefused):
        parse_query(text)


def test_the_search_is_of_public_repositories_only() -> None:
    assert search_text('refund is:private service') == 'refund service is:public'


def test_a_repositorys_facts_are_read_from_githubs_answer_and_back() -> None:
    facts = facts_of(REPO)
    assert facts is not None
    assert (facts.repository, facts.stars, facts.licence_spdx, facts.description) == (
        'upstream-org/tool', 1200, 'MIT', 'A tool for things')
    assert facts.topics == ('cli', 'no-bot-prs')   # (a topic GitHub would never spell is dropped)
    assert facts_from_answer(facts.answer()) == facts
    assert facts.view('tool') == {
        'repository': 'upstream-org/tool', 'description': 'A tool for things', 'stars': 1200,
        'licence': {'spdx': 'MIT', 'name': 'MIT License'}, 'archived': False, 'pushed_at': '2026-11-01T10:00:00Z',
        'default_branch': 'main', 'html_url': 'https://github.com/upstream-org/tool', 'fork': False,
        'connected': 'tool'}


def test_an_answer_off_its_shape_is_no_repository_and_an_unsaid_private_is_private() -> None:
    assert facts_of({'full_name': 'not a repo'}) is None
    assert facts_from_answer('nothing') is None
    facts = facts_of({'full_name': 'o/r'})
    assert facts is not None
    assert facts.private is True


@pytest.mark.parametrize(('topics', 'labels', 'contributing', 'found'), [
    ((), (), '', None), (('no-bot-prs',), (), '', 'no-bot-prs'), ((), ('No-AI-PRs',), '', 'no-ai-prs'),
    ((), (), 'Thanks!\n<!-- no-bot-prs -->\n', 'no-bot-prs'), ((), (), 'We review bot PRs gladly.', None),
])
def test_a_repository_opts_out_by_topic_label_or_marker(topics: tuple[str, ...], labels: tuple[str, ...],
                                                        contributing: str, found: str | None) -> None:
    assert opt_out(topics, labels, contributing) == found


def test_contributing_asks_are_read_best_effort() -> None:
    asks = contributing_asks('CONTRIBUTING.md', 'Every commit needs a Signed-off-by line (DCO).\nOpen an issue first.')
    assert (asks.dco, asks.issue_first) == (True, True)
    assert contributing_asks('CONTRIBUTING.md', 'Be kind.').view() == {'path': 'CONTRIBUTING.md', 'dco': False,
                                                                        'issue_first': False}


def test_the_template_is_filled_under_its_sections_with_its_comments_out() -> None:
    template = ('## Summary\n<!-- Describe the change -->\n\n## Related issues\n\n## Checklist\n- [ ] Tests added\n')
    filled = fill_template(template, 'Rounds the total.', 'Fixes #42')
    assert filled == ('## Summary\n\nRounds the total.\n\n## Related issues\n\nFixes #42\n\n## Checklist\n'
                      '- [ ] Tests added')
    assert strip_comments('a<!-- b -->c') == 'ac'


def test_a_template_without_those_sections_or_none_still_carries_the_description_and_issue() -> None:
    assert fill_template('### Notes\n- [ ] done', 'Body.', 'Fixes #1') == '### Notes\n\nBody.\n\n- [ ] done\n\nFixes #1'
    assert fill_template('Please describe.', 'Body.', '') == 'Body.\n\nPlease describe.'
    assert fill_template('', 'Body.', 'Fixes #1') == 'Body.\n\nFixes #1'


def test_the_upstream_body_links_the_issue_names_contributing_and_discloses_the_ai() -> None:
    body = upstream_body(template='', description='Rounds the total.', issue=42, contributing='CONTRIBUTING.md',
                         login='casey-dev')
    assert body == ('Rounds the total.\n\nFixes #42\n\nPrepared following this repository\'s `CONTRIBUTING.md`.\n\n'
                    + DISCLOSURE.format(login='casey-dev'))
    again = upstream_body(template='', description='Closes #42 for good.', issue=42, contributing='', login='c')
    assert again.count('#42') == 1   # (a body that names the issue already gets no second line)


def test_a_body_past_githubs_limit_is_refused_never_cut() -> None:
    with pytest.raises(UpstreamRefused):
        upstream_body(template='', description='x' * MAX_BODY, issue=None, contributing='', login='c')


def test_the_brokers_line_on_the_fork_stays_on_the_fork() -> None:
    line = 'Only a person merges it.'
    assert without_broker_line(f'Body.\n\n---\n{line}', line) == 'Body.'
    assert without_broker_line('Body.', line) == 'Body.'
    assert upstream_title('  Fix\nthe   total ') == 'Fix the total'


def test_the_licence_and_the_upstreams_state_refuse_a_contribution() -> None:
    facts = facts_of({**REPO, 'topics': []})
    assert facts is not None
    assert contribution_refusal(facts, None, 'MIT') is None
    archived = facts_of({**REPO, 'archived': True})
    assert archived is not None
    assert 'is archived' in str(contribution_refusal(archived, None, 'MIT'))
    assert 'opts out' in str(contribution_refusal(facts, 'no-ai-prs', 'MIT'))
    assert 'acknowledge it again' in str(licence_refusal(facts, 'Apache-2.0'))
    unlicensed = facts_of({**REPO, 'license': None})
    assert unlicensed is not None
    assert 'no licence' in str(licence_refusal(unlicensed, 'MIT'))


# --- the one-click link ----------------------------------------------------------------------------------------------

LINK = {'upstream': 'upstream-org/tool', 'base': 'main', 'fork': 'casey-dev/tool',
        'branch': 'voc-agent/01JC8Z3K4M5N6P7Q8R9S0T1V2W/fix-the-total', 'issue': 42, 'login': 'casey-dev'}


def test_the_link_is_githubs_compare_page_of_the_forks_branch_prefilled() -> None:
    body = 'Rounds the total.\n\nFixes #42\n\n' + DISCLOSURE.format(login='casey-dev')
    link = compare_link(title='Fix the total & more', body=body, **LINK)
    page, _, query = link.url.partition('?')
    assert page == ('https://github.com/upstream-org/tool/compare/main...casey-dev:tool:'
                    'voc-agent/01JC8Z3K4M5N6P7Q8R9S0T1V2W/fix-the-total')
    assert '+' not in query   # (a space is %20: GitHub reads a literal plus as a plus)
    assert '%20' in query
    assert parse_qs(urlsplit(link.url).query) == {'expand': ['1'], 'title': ['Fix the total & more'], 'body': [body]}
    assert link.shortened is False


def test_a_branch_or_text_that_needs_escaping_never_breaks_out_of_its_part() -> None:
    link = compare_link(title='a?b#c', body='x&title=injected', **{**LINK, 'branch': 'voc-agent/x#y?z'})
    assert '#' not in link.url
    query = parse_qs(urlsplit(link.url).query)
    assert query['title'] == ['a?b#c']
    assert query['body'] == ['x&title=injected']
    assert urlsplit(link.url).path.endswith('casey-dev:tool:voc-agent/x%23y%3Fz')


def test_a_body_too_long_for_the_link_gets_the_short_one_with_the_issue_and_the_disclosure() -> None:
    link = compare_link(title='Fix', body='word ' * 3000, **LINK)
    assert link.shortened is True
    assert len(link.url) <= MAX_COMPARE_URL
    [body] = parse_qs(urlsplit(link.url).query)['body']
    assert body == f'Fixes #42\n\n{SHORT_BODY}\n\n{DISCLOSURE.format(login="casey-dev")}'


def test_a_body_that_just_fits_is_kept_whole() -> None:
    link = compare_link(title='Fix', body='', **LINK)
    room = MAX_COMPARE_URL - len(link.url)
    fitting = compare_link(title='Fix', body='a' * room, **LINK)
    assert (len(fitting.url), fitting.shortened) == (MAX_COMPARE_URL, False)
    assert compare_link(title='Fix', body='a' * (room + 1), **LINK).shortened is True


@pytest.mark.parametrize('change', [{'upstream': 'not a repository'}, {'fork': 'nobody'}])
def test_a_link_is_only_between_two_repositories(change: dict[str, str]) -> None:
    with pytest.raises(UpstreamRefused):
        compare_link(title='Fix', body='Body', **{**LINK, **change})
