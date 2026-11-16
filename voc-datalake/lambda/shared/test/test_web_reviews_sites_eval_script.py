"""Tests for `scripts/evals/web_reviews_sites.py`, the Web Reviews review-site eval.

Lives under `lambda/` so the default `testpaths` (lambda, plugins) runs it; the script is loaded by path because
`scripts/` is not a package. Nothing here reaches AWS or the network: the fetcher, the browser session and tab, the
AWS clients and the model are replaced, and so is `checked_url`'s DNS lookup (its https check is kept).
"""
import copy
import io
import json
import os
import socket
import sys
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

import boto3
import pytest
import requests
from botocore.credentials import ReadOnlyCredentials
from botocore.exceptions import ClientError
from urllib3.response import HTTPResponse

from shared.test.repo_paths import load_module_from_path, repo_root

_SCRIPT = repo_root() / 'scripts' / 'evals' / 'web_reviews_sites.py'
_SEED = repo_root() / 'plugins' / 'web_reviews' / 'evals' / 'sites.json'
#: The plugin's flat modules the script imports by name; dropped again after this module if it imported them.
_FLAT_MODULES = ('agentcore_browser', 'page_reader', 'block_detection', 'extract', 'cdp_client', 'web_search_reader',
                 'snippet_reader')
_AGENT = 'VoC-Analytics-ReviewReader/9.9.9 (+https://example.test/docs)'
_LONG_TEXT = 'A review page with plenty of visible text and nothing that looks like a wall.\n' * 80

_REVIEWS_LD = json.dumps({'@context': 'https://schema.org', '@type': 'Product', 'name': 'Amazon Connect', 'review': [
    {'@type': 'Review', 'reviewBody': 'Setup took an afternoon. ' * 20, 'reviewRating': {'ratingValue': 5},
     'datePublished': '2026-10-01', 'name': 'Quick', 'author': {'name': 'Ann Example'}},
    {'@type': 'Review', 'reviewBody': 'Support was slow.', 'reviewRating': {'ratingValue': 2},
     'datePublished': '2026-10-02'},
    {'@type': 'Review', 'reviewBody': 'Fine for our call centre.', 'datePublished': '2026-10-03'},
]})


@pytest.fixture(scope='module')
def evals():
    path, modules = list(sys.path), set(sys.modules)
    module = load_module_from_path('web_reviews_sites_eval', _SCRIPT)
    try:
        yield module
    finally:
        sys.modules.pop(module.__name__, None)
        for name in set(_FLAT_MODULES) - modules:
            sys.modules.pop(name, None)
        sys.path[:] = path


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """No test here opens a socket or resolves a name: a seam a test forgot to replace fails it instead."""
    def refuse(*_args, **_kwargs):
        raise AssertionError('a test of the eval reached for the network')
    for name in ('getaddrinfo', 'create_connection'):
        monkeypatch.setattr(socket, name, refuse)
    monkeypatch.setattr(socket.socket, 'connect', refuse)


class FakeWeb:
    """``fetch_public_url``: answers by URL (a 429 / 5xx raised the way the real one raises it), every call recorded."""

    def __init__(self, errors):
        self.routes: dict[str, tuple[int, str, str | None]] = {}
        self.calls: list[tuple[str, dict]] = []
        self._errors = errors

    def answer(self, url: str, status: int = 200, body: str = '', final_url: str | None = None) -> None:
        self.routes[url] = (status, body, final_url)

    def urls(self) -> list[str]:
        return [url for url, _headers in self.calls]

    def __call__(self, url, headers=None, timeout=30, max_redirects=5, max_bytes=None):
        assert timeout > 0
        assert max_redirects == 5
        assert max_bytes is not None
        self.calls.append((url, dict(headers or {})))
        if url not in self.routes:
            raise requests.ConnectionError(f'no route to {url}')
        status, body, final_url = self.routes[url]
        response = requests.Response()
        response.status_code = status
        response.url = final_url or url
        response.encoding = 'utf-8'
        if status == 429 or status >= 500:
            response.raw = HTTPResponse(body=io.BytesIO(body.encode()), preload_content=False)
            raise self._errors(f'{status} Server Error', response=response)
        response._content = body.encode()
        return response


@pytest.fixture
def web(evals, monkeypatch):
    def checked(url):
        if not url.startswith('https://'):
            raise evals.TargetError('Only https URLs are allowed')
        return url
    monkeypatch.setattr(evals, 'checked_url', checked)
    fake = FakeWeb(evals.RetryableHTTPError)
    monkeypatch.setattr(evals, 'fetch_public_url', fake)
    return fake


@pytest.fixture
def browser(evals, monkeypatch):
    """The browser session and tab replaced; records the environment each session started in."""
    state = SimpleNamespace(sessions=[], loaded=[], open=False, snapshot=None, start_error=None, load_error=None)

    @contextmanager
    def session(timeout_seconds):
        if state.start_error is not None:
            raise state.start_error
        state.sessions.append({'timeout': timeout_seconds, 'browser': os.environ.get('BROWSER_IDENTIFIER'),
                               'profile': os.environ.get('BROWSER_PROFILE_IDENTIFIER')})
        state.open = True
        try:
            yield 'cdp'
        finally:
            state.open = False

    class Tab:
        def __init__(self, cdp):
            assert cdp == 'cdp'
            self.opened = False

        def open(self):
            self.opened = True

        def load(self, url):
            assert self.opened, 'the tab is opened before a page is loaded'
            state.loaded.append(url)
            if state.load_error is not None:
                raise state.load_error
            return state.snapshot

    monkeypatch.setattr(evals.plugin('agentcore_browser'), 'browser_session', session)
    monkeypatch.setattr(evals.plugin('page_reader'), 'BrowserTab', Tab)
    return state


def _site(evals, **overrides):
    values = {'id': 'g2', 'site': 'G2', 'url': 'https://www.g2.com/products/x/reviews', 'subject': 'X',
              'expect': 'readable', 'max_reviews': 20, 'structured': ()}
    return evals.Site(**{**values, **overrides})


def _entry(evals, **overrides):
    values = {'kind': 'rss', 'url': 'https://feeds.example.com/reviews.rss', 'needs_secret': False,
              'count_path': None, 'docs': '', 'notes': ''}
    return evals.Structured(**{**values, **overrides})


def _run(evals, **overrides):
    return evals.Run(**{'agent': _AGENT, 'signed_id': None, 'complete': None, 'model_calls': 1, **overrides})


def _page(evals, **overrides):
    values = {'url': 'https://www.g2.com/products/x/reviews', 'status': 200, 'title': 'X reviews',
              'text': _LONG_TEXT, 'html': '<html><body>reviews</body></html>', 'jsonld': ()}
    return evals.Page(**{**values, **overrides})


def _html(title='X reviews', jsonld=(), body=_LONG_TEXT):
    scripts = ''.join(f'<script type="application/ld+json">{block}</script>' for block in jsonld)
    return f'<html><head><title>{title}</title>{scripts}</head><body><p>{body}</p></body></html>'


def _fixture_document():
    """A small valid fixture: two sites, the second with a json entry."""
    return {
        'description': 'test sites', 'defaults': {'max_pages': 1, 'max_reviews': 20},
        'sites': [
            {'id': 'g2', 'site': 'G2', 'url': 'https://www.g2.com/products/amazon-connect/reviews',
             'subject': 'Amazon Connect', 'expect': 'unknown', 'notes': 'a software review site', 'structured': []},
            {'id': 'hackernews', 'site': 'Hacker News', 'url': 'https://news.ycombinator.com/item?id=13976567',
             'subject': 'Amazon Connect launch thread', 'expect': 'unknown', 'structured': [
                 {'kind': 'json', 'url': 'https://hacker-news.firebaseio.com/v0/item/13976567.json',
                  'count_path': 'kids', 'needs_secret': False, 'docs': 'https://github.com/HackerNews/API'}]},
        ],
    }


def _write(tmp_path, document, name='sites.json'):
    path = tmp_path / name
    path.write_text(json.dumps(document), encoding='utf-8')
    return path


def _main(evals, *args):
    return evals.main(['--region', 'us-west-2', *args])


@pytest.fixture
def reports(evals, tmp_path, monkeypatch):
    """The git-ignored reports directory of the eval, made a temporary one: ``--out`` must name a directory in it."""
    root = tmp_path / 'web-reviews-eval'
    monkeypatch.setattr(evals, 'REPORTS_ROOT', root)
    return root


# ── the fixture ─────────────────────────────────────────────────────────────────────────────────────────────────


class TestTheFixture:
    def test_the_fixture_loads_its_27_sites_inputs_only(self, evals):
        sites = {site.id: site for site in evals.load_fixture(_SEED)}
        assert len(sites) == 27
        assert sites['g2'].max_reviews == 20
        assert {site_id: site.expect for site_id, site in sites.items() if site.expect != 'unknown'} == {
            'glassdoor': 'login', 'amazon_reviews': 'login', 'yelp': 'official_api_only', 'reddit': 'official_api_only'}
        assert {site_id for site_id, site in sites.items() if site.official_api_only} == {'yelp', 'reddit'}
        assert 'Yelp Fusion API' in sites['yelp'].notes
        assert 'Reddit Data API' in sites['reddit'].notes
        (thread,) = sites['hackernews'].structured
        assert (thread.kind, thread.count_path, thread.url) == (
            'json', 'kids', 'https://hacker-news.firebaseio.com/v0/item/13976567.json')
        assert {entry.kind for site_id in ('trustpilot', 'yelp', 'reddit') for entry in sites[site_id].structured} == {
            'official_api'}
        assert sites['softwareadvice'].url == 'https://www.softwareadvice.com/call-center/amazon-connect-profile/reviews/'

    def test_the_fixture_holds_no_observation_of_a_run(self):
        """Inputs only: no vendor, baseline or evidence of where or how something was seen (a run's results stay in
        the git-ignored web-reviews-eval/)."""
        document = json.loads(_SEED.read_text(encoding='utf-8'))
        keys = {key for site in document['sites'] for key in site}
        assert keys <= {'id', 'site', 'url', 'subject', 'expect', 'notes', 'structured', 'max_reviews',
                        'official_api_only'}
        text = _SEED.read_text(encoding='utf-8').lower()
        assert not any(word in text for word in ('laptop', 'zurich', 'measured', 'live run', 'baseline', 'evidence'))

    def test_a_site_may_lower_the_review_cap_and_optional_keys_default(self, evals, tmp_path):
        document = _fixture_document()
        document['sites'][0]['max_reviews'] = 5
        sites = evals.load_fixture(_write(tmp_path, document))
        assert sites[0].max_reviews == 5
        assert (sites[1].notes, sites[1].max_reviews, sites[1].official_api_only) == ('', 20, False)

    @pytest.mark.parametrize(('change', 'message'), [
        (lambda d: d.update(extra=1), "unknown key 'extra'"),
        (lambda d: d['defaults'].update(max_pages=2), 'defaults.max_pages must be 1'),
        (lambda d: d['defaults'].update(max_pages=True), 'defaults.max_pages must be 1'),
        (lambda d: d['defaults'].update(max_reviews=0), 'defaults.max_reviews must be a whole number'),
        (lambda d: d['defaults'].update(max_reviews=1000), 'defaults.max_reviews must be a whole number'),
        (lambda d: d.update(sites=[]), 'sites must be a non-empty list'),
        (lambda d: d['sites'][0].update(colour='red'), "unknown key 'colour'"),
        (lambda d: d['sites'][0].pop('subject'), "missing key 'subject'"),
        (lambda d: d['sites'][0].update(baseline='blocked'), "unknown key 'baseline'"),
        (lambda d: d['sites'][0].update(vendor='DataDome'), "unknown key 'vendor'"),
        (lambda d: d['sites'][0].update(official_api_only=True), 'official_api_only: true goes with expect'),
        (lambda d: d['sites'][0].update(expect='official_api_only'), 'official_api_only: true goes with expect'),
        (lambda d: d['sites'][0].update(official_api_only='yes'), 'official_api_only must be true or false'),
        (lambda d: d['sites'][0].update(id='G 2'), '.id must be lower-case'),
        (lambda d: d['sites'][0].update(url='http://www.g2.com/products/x'), 'must be an https URL'),
        (lambda d: d['sites'][1].update(id='g2'), "duplicate site id 'g2'"),
        (lambda d: d['sites'][0].update(expect='maybe'),
         'expect must be one of readable, blocked, login, official_api_only, unknown'),
        (lambda d: d['sites'][0].update(max_reviews=500), 'max_reviews must be a whole number from 1 to 100'),
        (lambda d: d['sites'][0].update(notes=3), 'notes must be a string'),
        (lambda d: d['sites'][1]['structured'][0].update(kind='xml'), 'kind must be one of rss, atom, json'),
        (lambda d: d['sites'][1]['structured'][0].pop('count_path'), 'count_path (a json entry needs one)'),
        (lambda d: d['sites'][1]['structured'][0].update(kind='rss'), 'count_path is for a json entry only'),
        (lambda d: d['sites'][1]['structured'][0].update(url='ftp://x.example/feed'), 'must be an https URL'),
        (lambda d: d['sites'][1]['structured'][0].update(needs_secret='no'), 'needs_secret must be true or false'),
        (lambda d: d['sites'][1]['structured'][0].update(token='x'), "unknown key 'token'"),
    ])
    def test_each_bad_fixture_is_refused_with_a_clear_message(self, evals, tmp_path, change, message):
        document = copy.deepcopy(_fixture_document())
        change(document)
        with pytest.raises(evals.SetupError) as raised:
            evals.load_fixture(_write(tmp_path, document))
        assert message in str(raised.value)

    def test_a_file_that_is_not_json_is_refused(self, evals, tmp_path):
        path = tmp_path / 'sites.json'
        path.write_text('{"sites": [', encoding='utf-8')
        with pytest.raises(evals.SetupError, match='not valid JSON'):
            evals.load_fixture(path)

    def test_a_bad_fixture_exits_2_before_anything_runs(self, evals, tmp_path, capsys):
        document = _fixture_document()
        document['defaults']['max_pages'] = 3
        assert _main(evals, '--sites', str(_write(tmp_path, document)), '--dry-run') == 2
        assert 'max_pages must be 1' in capsys.readouterr().err

    def test_only_keeps_the_named_sites_in_fixture_order_and_refuses_an_unknown_one(self, evals):
        sites = evals.load_fixture(_SEED)
        assert [site.id for site in evals.selected_sites(sites, 'capterra, g2')] == ['g2', 'capterra']
        assert len(evals.selected_sites(sites, '')) == 27
        with pytest.raises(evals.SetupError, match='no such site: nope'):
            evals.selected_sites(sites, 'g2,nope')


# ── classification ──────────────────────────────────────────────────────────────────────────────────────────────


class TestClassification:
    def test_another_host_is_off_host(self, evals):
        verdict = evals.classify('https://www.g2.com/x', _page(evals, url='https://www.example.org/x'), 20, None)
        assert (verdict.outcome, verdict.detail) == ('off_host', 'redirected to www.example.org')

    def test_another_host_that_is_a_sign_in_page_is_login(self, evals):
        page = _page(evals, url='https://accounts.example.org/ap/signin?return=/x', jsonld=(_REVIEWS_LD,))
        assert evals.classify('https://www.g2.com/x', page, 20, None).outcome == 'login'

    @pytest.mark.parametrize('path', ['/login', '/users/sign_in', '/sign-in/', '/account/login.html', '/SignIn'])
    def test_a_sign_in_path_on_the_same_host_is_login(self, evals, path):
        page = _page(evals, url=f'https://www.g2.com{path}', jsonld=(_REVIEWS_LD,))
        assert evals.classify('https://www.g2.com/x', page, 20, None).outcome == 'login'

    def test_a_path_that_only_starts_like_login_is_not_one(self, evals):
        page = _page(evals, url='https://www.g2.com/logintervals/reviews', jsonld=(_REVIEWS_LD,))
        assert evals.classify('https://www.g2.com/x', page, 20, None).outcome == 'readable'

    @pytest.mark.parametrize('title', ['Sign in to G2', 'Log in | Capterra', 'Login', '  sign in  '])
    def test_a_sign_in_title_is_login(self, evals, title):
        assert evals.classify('https://www.g2.com/x', _page(evals, title=title), 20, None).outcome == 'login'

    @pytest.mark.parametrize(('status', 'title', 'text', 'html', 'vendor'), [
        (403, '', 'g2.com', '<script src="https://ct.captcha-delivery.com/c.js"></script>', 'DataDome'),
        (200, 'Access to this page has been denied', 'Press & Hold to confirm you are a human', '', 'HUMAN (PerimeterX)'),
        (403, 'Just a moment...', 'Checking your browser', '', 'Cloudflare'),
        (202, '', '', '<script>window.gokuProps = {}</script>', 'AWS WAF'),
        (200, 'Blocked', "You've been blocked by network security.", '', 'Reddit network security'),
        (200, 'Check', 'Please verify you are human', '', 'a CAPTCHA'),
        (403, 'Forbidden', 'Forbidden', '', 'HTTP 403'),
        (200, 'Oops', 'Access Denied. Reference #18', '', 'access denied'),
    ])
    def test_every_wall_is_blocked_by_its_vendor(self, evals, status, title, text, html, vendor):
        page = _page(evals, status=status, title=title, text=text, html=html)
        assert evals.classify('https://www.g2.com/x', page, 20, None).outcome == f'blocked:{vendor}'

    def test_a_wall_is_blocked_before_its_sign_in_title_counts(self, evals):
        page = _page(evals, title='Sign in', status=403, text='Just a moment...')
        assert evals.classify('https://www.g2.com/x', page, 20, None).outcome == 'blocked:Cloudflare'

    def test_off_host_is_decided_before_a_wall(self, evals):
        page = _page(evals, url='https://www.example.org/x', status=403, text='Just a moment...')
        assert evals.classify('https://www.g2.com/x', page, 20, None).outcome == 'off_host'

    def test_json_ld_reviews_are_readable_and_sampled_without_their_author(self, evals):
        verdict = evals.classify('https://www.g2.com/x', _page(evals, jsonld=(_REVIEWS_LD,)), 20, None)
        assert (verdict.outcome, verdict.extraction, verdict.count) == ('readable', 'json-ld', 3)
        assert len(verdict.sample) == 2
        assert len(verdict.sample[0]['text']) == 200
        assert verdict.sample[0] == {**verdict.sample[0], 'rating': 5.0, 'date': '2026-10-01', 'title': 'Quick'}
        assert all('author' not in sample for sample in verdict.sample)

    def test_reviews_are_counted_up_to_the_sites_cap(self, evals):
        assert evals.classify('https://www.g2.com/x', _page(evals, jsonld=(_REVIEWS_LD,)), 2, None).count == 2

    def test_without_the_model_a_page_without_json_ld_is_unextracted(self, evals):
        verdict = evals.classify('https://www.g2.com/x', _page(evals), 20, None)
        assert (verdict.outcome, verdict.extraction, verdict.count) == ('unextracted', 'text', 0)

    def test_the_model_reads_the_text_when_there_is_no_json_ld(self, evals):
        answer = '{"rating": 4, "date": "2026-09-30", "title": null, "text": "Calls route well."}\n'
        budget = evals.ModelBudget(1, lambda _prompt, _system: answer)
        verdict = evals.classify('https://www.g2.com/x', _page(evals), 20, budget)
        assert (verdict.outcome, verdict.extraction, verdict.count, budget.used) == ('readable', 'model', 1, 1)

    def test_a_model_that_finds_nothing_is_no_reviews(self, evals):
        budget = evals.ModelBudget(1, lambda _prompt, _system: '')
        verdict = evals.classify('https://www.g2.com/x', _page(evals), 20, budget)
        assert (verdict.outcome, verdict.extraction) == ('no_reviews', 'model')

    @pytest.mark.parametrize('limit', [1, 2])
    def test_the_model_budget_stops_after_its_calls_on_a_long_page(self, evals, limit):
        prompts = []

        def complete(prompt, _system):
            prompts.append(prompt)
            return ''
        long_text = 'One line of a very long page, read in several chunks.\n' * 2500  # ~140,000 characters: 4 chunks
        budget = evals.ModelBudget(limit, complete)
        evals.classify('https://www.g2.com/x', _page(evals, text=long_text), 20, budget)
        assert (len(prompts), budget.used) == (limit, limit)

    @pytest.mark.parametrize(('expected', 'outcome', 'compared'), [
        ('blocked', 'blocked:DataDome', 'as expected'),
        ('blocked', 'blocked:HTTP 403', 'as expected'),
        ('readable', 'readable', 'as expected'),
        ('readable', 'blocked:Cloudflare', 'differs'),
        ('login', 'off_host', 'differs'),
        ('readable', 'robots_disallowed', 'differs'),
        ('unknown', 'readable', '—'),
        ('readable', 'not_run', '—'),
        ('readable', 'error', '—'),
    ])
    def test_an_outcome_is_compared_with_the_expectation(self, evals, expected, outcome, compared):
        assert evals.compare(expected, outcome) == compared


# ── robots.txt ──────────────────────────────────────────────────────────────────────────────────────────────────


class TestRobotsTxt:
    def _allows(self, evals, robots, url):
        return evals.robots_allows(evals.parse_robots(robots), 'VoC-Analytics-ReviewReader', url)

    def test_the_longest_matching_rule_wins_and_an_allow_wins_a_tie(self, evals):
        robots = 'User-agent: *\nDisallow: /products/\nAllow: /products/*/reviews\nDisallow: /p/x\nAllow: /p/x\n'
        assert self._allows(evals, robots, 'https://h.example/products/connect/reviews')
        assert not self._allows(evals, robots, 'https://h.example/products/connect')
        assert self._allows(evals, robots, 'https://h.example/p/x')

    def test_wildcards_and_the_end_anchor(self, evals):
        robots = 'User-agent: *\nDisallow: /*?sort=\nDisallow: /*.json$\n'
        assert not self._allows(evals, robots, 'https://h.example/reviews?sort=new')
        assert not self._allows(evals, robots, 'https://h.example/item.json')
        assert self._allows(evals, robots, 'https://h.example/item.json?x=1')

    def test_our_own_group_replaces_the_catch_all_one(self, evals):
        robots = ('User-agent: *\nDisallow: /\n\n# us\nUser-agent: voc-analytics-reviewreader\nAllow: /reviews\n'
                  'Disallow: /private\n')
        assert self._allows(evals, robots, 'https://h.example/anything')
        assert not self._allows(evals, robots, 'https://h.example/private/x')

    def test_an_empty_group_of_ours_is_no_rules_not_the_catch_all(self, evals):
        robots = 'User-agent: VoC-Analytics-ReviewReader\nDisallow:\n\nUser-agent: *\nDisallow: /\n'
        assert self._allows(evals, robots, 'https://h.example/reviews')

    def test_consecutive_user_agent_lines_share_their_rules(self, evals):
        robots = 'User-agent: GPTBot\nUser-agent: VoC-Analytics-ReviewReader\nDisallow: /\n'
        assert not self._allows(evals, robots, 'https://h.example/reviews')

    def test_no_group_for_us_and_no_catch_all_is_no_rules(self, evals):
        assert self._allows(evals, 'User-agent: GPTBot\nDisallow: /\n', 'https://h.example/reviews')
        assert self._allows(evals, '', 'https://h.example/reviews')

    def test_percent_encoding_is_compared_normalised(self, evals):
        robots = 'User-agent: *\nDisallow: /caf%C3%A9\nDisallow: /%7Euser\n'
        assert not self._allows(evals, robots, 'https://h.example/café/reviews')
        assert not self._allows(evals, robots, 'https://h.example/~user')


# ── the http method ─────────────────────────────────────────────────────────────────────────────────────────────


class TestTheHttpMethod:
    URL = 'https://www.g2.com/products/x/reviews'
    ROBOTS = 'https://www.g2.com/robots.txt'

    def _row(self, evals, run=None, **site):
        (row,) = evals.http_rows(_site(evals, **site), run or _run(evals))
        return row

    def test_robots_disallowing_the_page_stops_before_it_is_fetched(self, evals, web):
        web.answer(self.ROBOTS, body='User-agent: *\nDisallow: /products/\n')
        row = self._row(evals)
        assert (row['outcome'], row['pages_read'], row['http_status']) == ('robots_disallowed', 0, None)
        assert row['detail'] == 'robots.txt disallows /products/x/reviews for VoC-Analytics-ReviewReader'
        assert web.urls() == [self.ROBOTS]

    def test_a_robots_404_is_no_rules_and_the_json_ld_page_is_read(self, evals, web):
        web.answer(self.ROBOTS, status=404)
        web.answer(self.URL, body=_html(jsonld=(_REVIEWS_LD,)))
        row = self._row(evals)
        assert (row['outcome'], row['extraction'], row['reviews'], row['pages_read']) == ('readable', 'json-ld', 3, 1)
        assert (row['http_status'], row['final_url']) == (200, self.URL)
        assert web.urls() == [self.ROBOTS, self.URL]

    def test_every_request_says_who_it_is(self, evals, web):
        web.answer(self.ROBOTS, status=404)
        web.answer(self.URL, body=_html(jsonld=(_REVIEWS_LD,)))
        self._row(evals)
        assert [headers['User-Agent'] for _url, headers in web.calls] == [_AGENT, _AGENT]

    def test_the_user_agent_names_the_eval_its_version_and_its_docs(self, evals):
        version = json.loads((repo_root() / 'package.json').read_text(encoding='utf-8'))['version']
        assert evals.package_version() == version
        assert evals.user_agent(version) == (
            f'VoC-Analytics-ReviewReader/{version} '
            '(+https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/docs/web-reviews.md)')

    @pytest.mark.parametrize('status', [500, 503, 429])
    def test_a_robots_server_error_is_a_complete_disallow(self, evals, web, status):
        web.answer(self.ROBOTS, status=status)
        row = self._row(evals)
        assert row['outcome'] == 'robots_disallowed'
        assert f'robots.txt answered HTTP {status}' in row['detail']
        assert web.urls() == [self.ROBOTS]

    @pytest.mark.usefixtures('web')
    def test_an_unreachable_robots_is_a_complete_disallow(self, evals):
        row = self._row(evals)  # no route: the fetcher raises ConnectionError
        assert row['outcome'] == 'robots_disallowed'
        assert row['detail'].startswith('robots.txt unreachable (ConnectionError)')

    def test_robots_is_read_once_per_origin(self, evals, web):
        web.answer(self.ROBOTS, status=404)
        web.answer(self.URL, body=_html(jsonld=(_REVIEWS_LD,)))
        run = _run(evals)
        self._row(evals, run)
        self._row(evals, run)
        assert web.urls().count(self.ROBOTS) == 1

    def test_a_wall_answered_with_403_is_blocked(self, evals, web):
        web.answer(self.ROBOTS, status=404)
        web.answer(self.URL, status=403, body=_html(title='Just a moment...', body='Checking your browser'))
        row = self._row(evals)
        assert (row['outcome'], row['http_status'], row['vs_expect']) == ('blocked:Cloudflare', 403, 'differs')
        assert 'vs_baseline' not in row

    def test_a_wall_answered_with_503_is_read_from_the_error_and_named(self, evals, web):
        web.answer(self.ROBOTS, status=404)
        web.answer(self.URL, status=503, body='<html><script src="https://ct.captcha-delivery.com/c.js"></script>')
        row = self._row(evals)
        assert (row['outcome'], row['http_status']) == ('blocked:DataDome', 503)

    def test_a_redirect_to_a_sign_in_page_is_login(self, evals, web):
        web.answer(self.ROBOTS, status=404)
        web.answer(self.URL, body=_html(title='Welcome'), final_url='https://www.g2.com/login?return=/x')
        row = self._row(evals)
        assert (row['outcome'], row['final_url']) == ('login', 'https://www.g2.com/login?return=/x')

    def test_a_policy_refusal_is_an_error_row(self, evals, web):
        web.answer(self.ROBOTS, status=404)
        row = self._row(evals, url='http://www.g2.com/products/x/reviews')
        assert (row['outcome'], row['detail']) == ('error', 'TargetError: Only https URLs are allowed')

    def test_the_model_reads_a_page_without_json_ld_with_the_handlers_call(self, evals, web, monkeypatch):
        calls = []

        def converse(**kwargs):
            calls.append(kwargs)
            return '{"rating": 3, "date": null, "title": null, "text": "Decent tooling."}\n'
        monkeypatch.setattr(evals, 'converse', converse)
        web.answer(self.ROBOTS, status=404)
        web.answer(self.URL, body=_html())
        row = self._row(evals, _run(evals, complete=evals.model_completion('model-x')))
        assert (row['outcome'], row['extraction'], row['reviews'], row['model_calls']) == ('readable', 'model', 1, 1)
        extract = evals.plugin('extract')
        assert {key: value for key, value in calls[0].items() if key not in ('prompt', 'system_prompt')} == {
            'max_tokens': extract.LLM_MAX_TOKENS, 'temperature': None, 'surface': extract.LLM_SURFACE,
            'step_name': 'web_reviews_eval', 'max_continuations': 0, 'model_id': 'model-x'}

    def test_a_page_is_parsed_as_the_browser_snapshot_has_it(self, evals):
        html = ('<html><head><title>  G2\n  Reviews </title><style>p{color:red}</style>'
                '<script type="Application/LD+JSON">{"a": 1}</script><script>var hidden = 1;</script></head>'
                '<body><p>First   review</p>\n\n   <noscript>enable js</noscript><svg><text>logo</text></svg>'
                '<template>tpl</template><p>Second</p></body></html>')
        page = evals.parse_html('https://h.example/x', 200, html)
        assert (page.url, page.status, page.title, page.jsonld) == ('https://h.example/x', 200, 'G2 Reviews', ('{"a": 1}',))
        assert page.text == 'First review\nSecond'
        assert page.html == html


# ── the feed method ─────────────────────────────────────────────────────────────────────────────────────────────


class TestTheFeedMethod:
    RSS = ('<?xml version="1.0"?><rss version="2.0"><channel><title>Reviews</title>'
           '<item><title>Great  product</title></item><item><title>Slow support</title></item>'
           '<item><description>no title</description></item></channel></rss>')
    ATOM = ('<feed xmlns="http://www.w3.org/2005/Atom"><title>R</title><entry><title>One</title></entry>'
            '<entry><title>Two</title></entry></feed>')

    def _row(self, evals, entry):
        robots = f'https://{entry.url.split("/")[2]}/robots.txt'
        return robots, evals.feed_row(_site(evals, structured=(entry,)), entry, _run(evals))

    def test_rss_items_are_counted(self, evals, web):
        entry = _entry(evals)
        web.answer('https://feeds.example.com/robots.txt', status=404)
        web.answer(entry.url, body=self.RSS)
        _robots, row = self._row(evals, entry)
        assert (row['outcome'], row['extraction'], row['reviews'], row['url']) == ('readable', 'feed', 3, entry.url)
        assert [sample['text'] for sample in row['sample']] == ['Great product', 'Slow support']
        assert web.calls[1][1]['User-Agent'] == _AGENT

    def test_atom_entries_are_counted(self, evals, web):
        entry = _entry(evals, kind='atom', url='https://feeds.example.com/reviews.atom')
        web.answer('https://feeds.example.com/robots.txt', status=404)
        web.answer(entry.url, body=self.ATOM)
        assert self._row(evals, entry)[1]['reviews'] == 2

    def test_a_json_answer_counts_its_count_path_list(self, evals, web):
        entry = _entry(evals, kind='json', url='https://api.example.com/v0/item/1.json', count_path='kids')
        web.answer('https://api.example.com/robots.txt', status=404)
        web.answer(entry.url, body=json.dumps({'id': 1, 'kids': [2, 3]}))
        _robots, row = self._row(evals, entry)
        assert (row['outcome'], row['extraction'], row['reviews']) == ('readable', 'json', 2)

    @pytest.mark.parametrize(('answer', 'count'), [
        ([{'kind': 'Listing'}, {'data': {'children': [{'id': 1}, {'id': 2}, {'id': 3}]}}], 3),
        ([{'kind': 'Listing'}], 0),
    ])
    def test_a_count_path_may_index_a_list(self, evals, web, answer, count):
        entry = _entry(evals, kind='json', url='https://api.example.com/r/x/.json', count_path='1.data.children')
        web.answer('https://api.example.com/robots.txt', status=404)
        web.answer(entry.url, body=json.dumps(answer))
        assert self._row(evals, entry)[1]['reviews'] == count

    def test_a_json_answer_without_the_list_has_no_reviews(self, evals, web):
        entry = _entry(evals, kind='json', url='https://api.example.com/v0/item/1.json', count_path='kids')
        web.answer('https://api.example.com/robots.txt', status=404)
        web.answer(entry.url, body=json.dumps({'id': 1}))
        assert self._row(evals, entry)[1]['outcome'] == 'no_reviews'

    @pytest.mark.parametrize('overrides', [
        {'kind': 'official_api', 'docs': 'https://developer.example.com', 'notes': 'OAuth app'},
        {'kind': 'rss', 'needs_secret': True, 'docs': 'https://developer.example.com', 'notes': 'OAuth app'},
    ])
    def test_an_official_api_or_a_secret_is_not_run_with_its_docs(self, evals, web, overrides):
        _robots, row = self._row(evals, _entry(evals, **overrides))
        assert row['outcome'] == 'not_run'
        assert row['detail'].endswith('https://developer.example.com; OAuth app')
        assert web.calls == []

    def test_a_feed_declaring_a_doctype_is_not_parsed(self, evals, web):
        entry = _entry(evals)
        web.answer('https://feeds.example.com/robots.txt', status=404)
        web.answer(entry.url, body='<!DOCTYPE x [<!ENTITY a "b">]><rss><channel><item/></channel></rss>')
        _robots, row = self._row(evals, entry)
        assert (row['outcome'], row['detail']) == ('error', 'the feed declares a DOCTYPE or an ENTITY (not parsed)')

    def test_robots_applies_to_feeds_too(self, evals, web):
        entry = _entry(evals)
        web.answer('https://feeds.example.com/robots.txt', body='User-agent: *\nDisallow: /\n')
        _robots, row = self._row(evals, entry)
        assert row['outcome'] == 'robots_disallowed'
        assert web.urls() == ['https://feeds.example.com/robots.txt']

    def test_a_site_without_structured_entries_has_no_feed_row(self, evals, web):
        assert evals.feed_rows(_site(evals), _run(evals)) == []
        assert web.calls == []


# ── the browser methods ─────────────────────────────────────────────────────────────────────────────────────────


class TestTheBrowserMethods:
    def _snapshot(self, evals, **overrides):
        values = {'url': 'https://www.g2.com/products/x/reviews', 'status': 200, 'title': 'X reviews',
                  'text': _LONG_TEXT, 'html': '<html></html>', 'jsonld': (_REVIEWS_LD,), 'next_url': None}
        return evals.plugin('page_reader').PageSnapshot(**{**values, **overrides})

    def test_unsigned_starts_a_fresh_managed_session_without_a_profile(self, evals, web, browser, monkeypatch):
        monkeypatch.setenv('BROWSER_PROFILE_IDENTIFIER', 'profile-of-the-deployment')
        monkeypatch.setenv('BROWSER_IDENTIFIER', 'set-by-someone-else')
        browser.snapshot = self._snapshot(evals)
        (row,) = evals.unsigned_rows(_site(evals), _run(evals))
        assert browser.sessions == [{'timeout': 300, 'browser': 'aws.browser.v1', 'profile': None}]
        assert browser.loaded == ['https://www.g2.com/products/x/reviews']
        assert (row['method'], row['outcome'], row['extraction'], row['reviews']) == ('unsigned', 'readable', 'json-ld', 3)
        assert (row['pages_read'], row['http_status'], row['final_url']) == (1, 200, 'https://www.g2.com/products/x/reviews')
        assert os.environ['BROWSER_PROFILE_IDENTIFIER'] == 'profile-of-the-deployment'
        assert web.calls == []

    @pytest.mark.usefixtures('web')
    def test_signed_starts_its_session_on_the_deployments_browser(self, evals, browser):
        browser.snapshot = self._snapshot(evals, status=403, text='', html='<script src="//captcha-delivery.com/c.js">')
        (row,) = evals.signed_rows(_site(evals), _run(evals, signed_id='br-signed-1'))
        assert browser.sessions[0]['browser'] == 'br-signed-1'
        assert (row['method'], row['outcome'], row['vs_expect']) == ('signed', 'blocked:DataDome', 'differs')

    @pytest.mark.usefixtures('web')
    def test_signed_without_a_browser_is_not_run(self, evals, browser):
        (row,) = evals.signed_rows(_site(evals), _run(evals))
        assert (row['outcome'], row['detail'], row['vs_expect']) == (
            'not_run', 'the deployment has no Web Bot Auth browser (opted out, or not deployed)', '—')
        assert browser.sessions == []

    @pytest.mark.usefixtures('web')
    def test_the_page_is_classified_after_the_session_stopped(self, evals, browser):
        browser.snapshot = self._snapshot(evals, jsonld=())
        open_during_model = []

        def complete(_prompt, _system):
            open_during_model.append(browser.open)
            return ''
        evals.unsigned_rows(_site(evals), _run(evals, complete=complete))
        assert open_during_model == [False]

    @pytest.mark.usefixtures('web')
    def test_a_browser_that_cannot_start_is_an_error_row(self, evals, browser):
        browser.start_error = evals.plugin('agentcore_browser').BrowserUnavailableError(
            'AgentCore Browser is unavailable in us-west-2')
        (row,) = evals.unsigned_rows(_site(evals), _run(evals))
        assert (row['outcome'], row['pages_read']) == ('error', 0)
        assert row['detail'] == 'BrowserUnavailableError: AgentCore Browser is unavailable in us-west-2'

    @pytest.mark.usefixtures('web')
    def test_a_page_that_does_not_load_is_an_error_row(self, evals, browser):
        browser.load_error = evals.plugin('page_reader').PageLoadError('the page did not load')
        (row,) = evals.unsigned_rows(_site(evals), _run(evals))
        assert (row['outcome'], row['detail']) == ('error', 'PageLoadError: the page did not load')


# ── the signed browser of the deployment ────────────────────────────────────────────────────────────────────────


def _aws(evals, monkeypatch, *, variables=None, missing=False, signing=True):
    sts, functions, control = MagicMock(), MagicMock(), MagicMock()
    sts.get_caller_identity.return_value = {'Account': '123456789012'}
    if missing:
        functions.get_function_configuration.side_effect = ClientError(
            {'Error': {'Code': 'ResourceNotFoundException', 'Message': 'Function not found'}}, 'GetFunctionConfiguration')
    else:
        functions.get_function_configuration.return_value = {'Environment': {'Variables': variables or {}}}
    control.get_browser.return_value = {'browserSigning': {'enabled': signing}}
    clients = {'sts': sts, 'lambda': functions, 'bedrock-agentcore-control': control}
    calls = []

    def client(service, region):
        calls.append((service, region))
        return clients[service]
    monkeypatch.setattr(evals, 'aws_client', client)
    return clients, calls


class TestTheSignedBrowser:
    def test_its_id_is_the_deployed_ingestors_browser_identifier(self, evals, monkeypatch):
        clients, _calls = _aws(evals, monkeypatch, variables={'BROWSER_IDENTIFIER': 'br-1', 'X': 'y'})
        assert evals.signed_browser('us-west-2', 'b', None) == evals.SignedBrowser('br-1', True)
        clients['lambda'].get_function_configuration.assert_called_once_with(
            FunctionName='b-voc-ingestor-web_reviews-123456789012-us-west-2')
        clients['bedrock-agentcore-control'].get_browser.assert_called_once_with(browserId='br-1')

    def test_an_unprefixed_deployment_has_the_bare_name(self, evals):
        assert evals.ingestor_function_name('', '1', 'eu-west-1') == 'voc-ingestor-web_reviews-1-eu-west-1'

    def test_no_browser_identifier_means_no_signed_browser(self, evals, monkeypatch):
        _aws(evals, monkeypatch)
        assert evals.signed_browser('us-west-2', '', None) == evals.SignedBrowser(None, None)

    def test_browser_id_skips_the_lookup_and_signing_is_best_effort(self, evals, monkeypatch):
        clients, calls = _aws(evals, monkeypatch)
        clients['bedrock-agentcore-control'].get_browser.side_effect = ClientError(
            {'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'GetBrowser')
        assert evals.signed_browser('us-west-2', 'b', 'br-given') == evals.SignedBrowser('br-given', None)
        assert calls == [('bedrock-agentcore-control', 'us-west-2')]

    def test_a_deployment_without_one_reports_every_signed_row_not_run(self, evals, monkeypatch, browser, tmp_path,
                                                                     capsys, reports):
        _aws(evals, monkeypatch)
        sites = _write(tmp_path, _fixture_document())
        out = reports / 'r'
        assert _main(evals, '--sites', str(sites), '--methods', 'signed', '--no-model', '--out', str(out)) == 0
        report = json.loads((out / 'report.json').read_text(encoding='utf-8'))
        assert {row['outcome'] for row in report['results']} == {'not_run'}
        assert len(report['results']) == 2
        assert report['run']['browser'] == {'signed_id': None, 'signing_enabled': None}
        assert browser.sessions == []
        capsys.readouterr()

    @pytest.mark.usefixtures('browser')
    def test_no_ingestor_function_is_a_setup_error(self, evals, monkeypatch, tmp_path, capsys, reports):
        _aws(evals, monkeypatch, missing=True)
        sites = _write(tmp_path, _fixture_document())
        out = reports / 'r'
        assert _main(evals, '--sites', str(sites), '--methods', 'signed', '--prefix', 'b', '--out', str(out)) == 2
        assert 'b-voc-ingestor-web_reviews-123456789012-us-west-2 is not in us-west-2' in capsys.readouterr().err
        assert not (out / 'report.json').exists()


# ── web search: Amazon Bedrock (e) and AgentCore (f) ────────────────────────────────────────────────────────────

_CREDENTIALS = ReadOnlyCredentials('AKIDEXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'session-token')
_MANTLE = 'https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses'
_SEARCH = 'https://bedrock-agentcore.us-west-2.amazonaws.com/web-search/web-search.v1/invoke'


class FakePost:
    """The web search requests' POST: answers by URL, every request recorded with its decoded body."""

    def __init__(self):
        self.answers: dict[str, list[tuple[int, object]]] = {}
        self.requests: list[tuple[str, dict, dict]] = []

    def answer(self, url, payload, status=200):
        self.answers.setdefault(url, []).append((status, payload))

    def __call__(self, url, body, headers, timeout):
        assert timeout > 0
        self.requests.append((url, json.loads(body), headers))
        status, payload = self.answers[url].pop(0) if len(self.answers[url]) > 1 else self.answers[url][0]
        return status, payload if isinstance(payload, bytes) else json.dumps(payload).encode()


def _responses_answer(reviews, fetched=True, reason=None, page='https://www.g2.com/products/x/reviews'):
    text = json.dumps({'fetched': fetched, 'reason': reason, 'reviews': reviews})
    return {'output': [
        {'type': 'web_search_call', 'action': {'type': 'open_page', 'url': page}},
        {'type': 'message', 'content': [{'type': 'output_text', 'text': text,
                                         'annotations': [{'type': 'url_citation', 'url': page}]}]},
    ]}


def _web_review(body, kind='review', rating=None, scale=None):
    return {'review_kind': kind, 'author': 'Ann', 'rating': rating, 'rating_scale': scale, 'date': '2026-10-01',
            'title': None, 'body': body}


@pytest.fixture
def post(evals, monkeypatch):
    monkeypatch.setattr(evals, 'aws_credentials', lambda: _CREDENTIALS)
    monkeypatch.setattr(evals, 'checked_url', lambda url: url)
    return FakePost()


class TestTheBedrockWebSearchMethod:
    def test_one_row_per_model_from_the_ingestors_reader(self, evals, post):
        post.answer(_MANTLE, _responses_answer([_web_review('Routing works well.', rating=8, scale=10),
                                                _web_review('Users find it reliable overall.', kind='summary')]))
        run = _run(evals, region='us-west-2', post=post, web_search_models=('openai.m-1', 'openai.m-2'))
        rows = evals.web_search_rows(_site(evals), run)
        assert [row['method'] for row in rows] == ['bedrock_web_search:openai.m-1', 'bedrock_web_search:openai.m-2']
        row = rows[0]
        assert (row['outcome'], row['extraction'], row['reviews'], row['model'], row['dropped']) == (
            'readable', 'web_search', 1, 'openai.m-1', 1)
        assert row['opened_urls'] == row['cited_urls'] == ['https://www.g2.com/products/x/reviews']
        assert row['sample'][0] == {'text': 'Routing works well.', 'rating': 4.0, 'date': '2026-10-01', 'title': None}
        assert row['_bodies'] == ['Routing works well.']
        url, body, headers = post.requests[0]
        assert (url, body['model'], body['tools'][0]['filters']) == (_MANTLE, 'openai.m-1', {'allowed_domains': ['g2.com']})
        assert '/us-west-2/bedrock-mantle/aws4_request' in headers['Authorization']

    def test_a_page_the_model_could_not_open_is_an_error_with_its_reason(self, evals, post):
        post.answer(_MANTLE, _responses_answer([], fetched=False, reason='the page is not in the cache'))
        (row, _other) = evals.web_search_rows(_site(evals), _run(evals, region='us-west-2', post=post))
        assert (row['outcome'], row['detail']) == ('error', 'fetch_failed: the page is not in the cache')

    def test_a_page_without_reviews_is_no_reviews(self, evals, post):
        post.answer(_MANTLE, _responses_answer([]))
        (row, _other) = evals.web_search_rows(_site(evals), _run(evals, region='us-west-2', post=post))
        assert (row['outcome'], row['extraction'], row['verbatim']) == ('no_reviews', 'web_search', None)

    def test_a_refused_request_is_an_error_row(self, evals, post):
        post.answer(_MANTLE, b'{"message": "not authorized"}', status=403)
        (row, _other) = evals.web_search_rows(_site(evals), _run(evals, region='us-west-2', post=post))
        assert (row['outcome'], row['model']) == ('error', 'openai.gpt-5.6-luna')
        assert row['detail'].startswith('WebSearchError: HTTP 403')

    def test_the_default_models_are_luna_and_terra(self, evals):
        assert evals.DEFAULT_WEB_SEARCH_MODELS == ('openai.gpt-5.6-luna', 'openai.gpt-5.6-terra')
        assert evals.web_search_models(' a.b , a.b,c-d ') == ('a.b', 'c-d')

    @pytest.mark.parametrize('value', ['', 'has space', ','])
    def test_a_bad_model_list_exits_2(self, evals, capsys, value):
        assert _main(evals, '--web-search-models', value, '--dry-run') == 2
        assert '--web-search-models' in capsys.readouterr().err


def _search_results():
    return {'results': [
        {'title': 'Amazon Connect reviews', 'url': 'https://www.g2.com/products/amazon-connect/reviews',
         'text': 'Routing works well and setup was quick. Rated 4/5 by a team lead on October 1, 2026.',
         'publishedAt': '2026-10-02T08:00:00Z'},
        {'title': 'Page 2', 'url': 'https://www.g2.com/products/amazon-connect/reviews?page=2',
         'text': 'Support answered   within minutes...'},
        {'title': 'No text'},
    ]}


def _model_lines(*reviews):
    answer = '\n'.join(json.dumps(review) for review in reviews) + '\n'
    calls = []

    def complete(prompt, _system):
        calls.append(prompt)
        return answer
    return complete, calls


_G2_PAGE = 'https://www.g2.com/products/amazon-connect/reviews'


class TestTheAgentCoreWebSearchMethod:
    def _row(self, evals, post, complete=None, region='us-west-2'):
        run = _run(evals, region=region, post=post, complete=complete)
        (row,) = evals.agentcore_search_rows(_site(evals, url='https://www.g2.com/products/amazon-connect/reviews',
                                                   subject='Amazon Connect'), run)
        return row

    def test_the_request_is_a_signed_invoke_web_search_held_to_the_sites_domain(self, evals, post):
        post.answer(_SEARCH, {'results': []})
        row = self._row(evals, post)
        url, body, headers = post.requests[0]
        assert url == _SEARCH
        assert body == {'searchQuery': 'Amazon Connect reviews', 'maxResults': 10,
                        'filters': {'domainFilter': {'include': ['g2.com']}}}
        assert '/us-west-2/bedrock-agentcore/aws4_request' in headers['Authorization']
        assert headers['X-Amz-Security-Token'] == 'session-token'
        assert (row['outcome'], row['detail']) == ('no_reviews', 'the search returned no result')

    def test_a_review_is_kept_only_when_its_body_is_in_one_snippet(self, evals, post):
        post.answer(_SEARCH, _search_results())
        complete, calls = _model_lines(
            {'rating': 4, 'date': '2026-10-01', 'title': None, 'text': 'Routing works well and setup was quick.'},
            {'rating': 5, 'date': '2026-09-01', 'title': None, 'text': 'Support answered within minutes'},
            {'rating': None, 'date': None, 'title': None, 'text': 'A paraphrase that is in no snippet.'},
        )
        row = self._row(evals, post, complete)
        assert (row['outcome'], row['extraction'], row['reviews'], row['dropped'], row['model_calls']) == (
            'readable', 'snippets', 2, 1, 1)
        assert '<page_text>' in calls[0]
        assert 'Routing works well' in calls[0]
        assert [(sample['rating'], sample['date']) for sample in row['sample']] == [(4.0, '2026-10-01'), (None, None)]
        assert row['sources'] == [
            {'url': 'https://www.g2.com/products/amazon-connect/reviews', 'title': 'Amazon Connect reviews',
             'published_date': '2026-10-02T08:00:00Z', 'excerpt_only': False},
            {'url': 'https://www.g2.com/products/amazon-connect/reviews?page=2', 'title': 'Page 2',
             'published_date': None, 'excerpt_only': True},
        ]
        assert row['excerpt_only'] is True
        assert row['_bodies'] == ['Routing works well and setup was quick.', 'Support answered within minutes']

    def test_a_review_that_is_its_whole_snippet_is_not_an_excerpt(self, evals, post):
        post.answer(_SEARCH, {'results': [{'text': 'Exactly one review, all of it.', 'url': _G2_PAGE}]})
        complete, _calls = _model_lines({'rating': None, 'date': None, 'title': None,
                                         'text': 'Exactly one review, all of it.'})
        row = self._row(evals, post, complete)
        assert (row['sources'][0]['excerpt_only'], row['excerpt_only']) == (False, False)

    def test_without_the_model_the_snippets_are_unextracted(self, evals, post):
        post.answer(_SEARCH, _search_results())
        row = self._row(evals, post)
        assert (row['outcome'], row['extraction'], row['detail']) == (
            'unextracted', 'snippets', '2 results on the page; --no-model left the snippets unread')

    def test_results_on_other_pages_of_the_site_are_not_read(self, evals, post):
        post.answer(_SEARCH, {'results': [{'text': 'Routing works well.', 'url': 'https://www.g2.com/compare/x-vs-y'}]})
        complete, calls = _model_lines({'text': 'Routing works well.'})
        row = self._row(evals, post, complete)
        assert (row['outcome'], row['detail'], calls) == ('no_reviews', '1 results, none on the page itself', [])

    def test_a_refusal_is_an_error_row(self, evals, post):
        post.answer(_SEARCH, b'{"message": "User is not authorized to perform: bedrock-agentcore:InvokeWebSearch"}',
                    status=403)
        row = self._row(evals, post)
        assert row['outcome'] == 'error'
        assert row['detail'].startswith('SnippetSearchError: HTTP 403: {"message": "User is not authorized')

    def test_a_region_without_the_api_is_not_run(self, evals, post):
        row = self._row(evals, post, region='eu-central-1')
        assert row['outcome'] == 'not_run'
        assert row['detail'].startswith('AgentCore Web Search is not offered in eu-central-1')
        assert post.requests == []


class TestVerbatim:
    @pytest.mark.parametrize(('bodies', 'texts', 'expected'), [
        (['Routing  works WELL.', 'Support was slow.'], ['x routing works well. y support was slow. z'], 'verbatim'),
        (['Routing works well.', 'Never written.'], ['routing works well.'], 'partial'),
        (['Never written.'], ['routing works well.'], 'paraphrase_risk'),
        (['Routing works well.'], [], 'unverifiable'),
        ([], ['anything'], None),
    ])
    def test_bodies_are_looked_for_in_the_page_text(self, evals, bodies, texts, expected):
        assert evals.verbatim(bodies, texts) == expected

    def test_only_the_first_80_characters_of_a_body_are_compared(self, evals):
        body = 'a' * 80 + ' then words the page never shows'
        assert evals.verbatim([body], ['a' * 80]) == 'verbatim'

    @pytest.mark.usefixtures('web')
    def test_a_run_checks_web_search_rows_against_the_sites_page_and_drops_the_page_text(self, evals, browser,
                                                                                       post):
        browser.snapshot = evals.plugin('page_reader').PageSnapshot(
            url='https://www.g2.com/products/x/reviews', status=200, title='X reviews',
            text=_LONG_TEXT + 'Routing works well.\n', html='<html></html>', jsonld=(_REVIEWS_LD,), next_url=None)
        post.answer(_MANTLE, _responses_answer([_web_review('Routing works well.')]))
        site = _site(evals)
        run = _run(evals, region='us-west-2', post=post, web_search_models=('openai.m-1',))
        methods = evals.parse_methods('bedrock_web_search,unsigned')
        rows = evals.run_eval([site], methods, run)
        assert [(row['method'], row['verbatim']) for row in rows] == [
            ('bedrock_web_search:openai.m-1', 'verbatim'), ('unsigned', None)]
        assert all('_page_text' not in row and '_bodies' not in row for row in rows)

    def test_a_wall_is_not_page_text_to_check_against(self, evals, browser, post):
        browser.snapshot = evals.plugin('page_reader').PageSnapshot(
            url='https://www.g2.com/products/x/reviews', status=403, title='Just a moment...', text='Routing works well.',
            html='', jsonld=(), next_url=None)
        post.answer(_MANTLE, _responses_answer([_web_review('Routing works well.')]))
        run = _run(evals, region='us-west-2', post=post, web_search_models=('openai.m-1',))
        rows = evals.run_eval([_site(evals)], evals.parse_methods('unsigned,bedrock_web_search'), run)
        assert rows[1]['verbatim'] == 'unverifiable'


# ── the report, the methods and the dry run ─────────────────────────────────────────────────────────────────────


_ROW_KEYS = {'site_id', 'site', 'url', 'method', 'outcome', 'reviews', 'pages_read', 'seconds', 'extraction',
             'model_calls', 'http_status', 'final_url', 'expect', 'vs_expect', 'detail',
             'sample', 'excerpt_only', 'verbatim', 'model', 'opened_urls', 'cited_urls', 'dropped', 'sources', 'picked',
             'chain'}


class TestTheReport:
    def _fixture(self, tmp_path):
        return _write(tmp_path, _fixture_document())  # g2, hackernews

    def _web(self, web):
        web.answer('https://www.g2.com/robots.txt', status=404)
        web.answer('https://www.g2.com/products/amazon-connect/reviews', status=403,
                   body='<html><script src="https://ct.captcha-delivery.com/c.js"></script></html>')
        web.answer('https://news.ycombinator.com/robots.txt', body='User-agent: *\nDisallow: /item\n')
        web.answer('https://hacker-news.firebaseio.com/robots.txt', status=404)
        web.answer('https://hacker-news.firebaseio.com/v0/item/13976567.json', body=json.dumps({'kids': [1, 2, 3]}))

    def test_report_json_and_report_md_are_written_and_md_printed(self, evals, web, post, tmp_path, capsys,
                                                                  monkeypatch, reports):
        self._web(web)
        post.answer(_MANTLE, _responses_answer([_web_review('Routing works well.')]))
        monkeypatch.setattr(evals, 'post_json', post)
        out = reports / 'out'
        code = _main(evals, '--sites', str(self._fixture(tmp_path)), '--methods', 'http,feed,bedrock_web_search',
                     '--web-search-models', 'openai.m-1', '--no-model', '--out', str(out))
        assert code == 0
        report = json.loads((out / 'report.json').read_text(encoding='utf-8'))
        assert set(report) == {'run', 'results'}
        assert set(report['run']) == {'started_at', 'region', 'prefix', 'sites_file', 'methods', 'browser',
                                      'model_calls_per_page', 'no_model', 'model_id', 'web_search_models',
                                      'user_agent'}
        assert (report['run']['methods'], report['run']['web_search_models']) == (
            ['http', 'feed', 'bedrock_web_search'], ['openai.m-1'])
        assert report['run']['user_agent'].startswith('VoC-Analytics-ReviewReader/')
        assert all(set(row) == _ROW_KEYS for row in report['results'])
        outcomes = [(row['site_id'], row['method'], row['outcome'], row['verbatim']) for row in report['results']]
        assert outcomes == [
            ('g2', 'http', 'blocked:DataDome', None), ('g2', 'bedrock_web_search:openai.m-1', 'readable', 'unverifiable'),
            ('hackernews', 'http', 'robots_disallowed', None), ('hackernews', 'feed', 'readable', None),
            ('hackernews', 'bedrock_web_search:openai.m-1', 'readable', 'unverifiable')]
        markdown = (out / 'report.md').read_text(encoding='utf-8')
        assert '| Site | Method | Outcome | Reviews | Extraction | Seconds | Expect | vs expect |' in markdown
        assert '| Site | Vendor (this run) | http | feed | bedrock_web_search:openai.m-1 |' in markdown
        assert '| G2 (g2) | DataDome | blocked:DataDome | — | readable (unverifiable) |' in markdown
        assert '| Hacker News (hackernews) | — | robots_disallowed | readable | readable (unverifiable) |' in markdown
        assert 'baseline' not in markdown
        assert markdown in capsys.readouterr().out

    def test_the_default_out_is_a_utc_stamped_directory_in_the_reports_directory(self, evals, web, tmp_path, capsys,
                                                                                 reports):
        self._web(web)
        sites = self._fixture(tmp_path)
        assert _main(evals, '--sites', str(sites), '--methods', 'feed', '--no-model') == 0
        (stamp,) = reports.iterdir()
        assert len(stamp.name) == len('20261115T120000Z')
        assert stamp.name.endswith('Z')
        assert {path.name for path in stamp.iterdir()} == {'report.json', 'report.md'}
        capsys.readouterr()

    @pytest.mark.parametrize('out', ['elsewhere', 'web-reviews-eval', '../web-reviews-eval/x/../../y'])
    def test_out_must_be_inside_the_reports_directory(self, evals, tmp_path, capsys, reports, out):
        assert _main(evals, '--sites', str(self._fixture(tmp_path)), '--dry-run', '--out', str(tmp_path / out)) == 2
        assert '--out must be a directory inside' in capsys.readouterr().err
        assert not reports.exists()

    def test_the_reports_directory_is_git_ignored(self, evals):
        ignored = (repo_root().parent / '.gitignore').read_text(encoding='utf-8').splitlines()
        assert f'{evals.REPORTS_DIR}/' in ignored
        assert repo_root() / evals.REPORTS_DIR == evals.REPORTS_ROOT

    def test_the_run_restores_the_environment_it_changed(self, evals, web, tmp_path, monkeypatch, capsys, reports):
        self._web(web)
        monkeypatch.setenv('BROWSER_PROFILE_IDENTIFIER', 'p-1')
        monkeypatch.delenv('AWS_REGION', raising=False)
        _main(evals, '--sites', str(self._fixture(tmp_path)), '--methods', 'feed', '--no-model',
              '--out', str(reports / 'o'))
        assert os.environ['BROWSER_PROFILE_IDENTIFIER'] == 'p-1'
        assert 'AWS_REGION' not in os.environ
        capsys.readouterr()

    def test_the_pivot_has_a_column_per_web_search_model_in_method_order(self, evals):
        rows = [{'method': name} for name in ('feed', 'bedrock_web_search:b', 'http', 'bedrock_web_search:a')]
        assert evals.columns(rows, ['http', 'bedrock_web_search', 'feed', 'signed']) == [
            'http', 'bedrock_web_search:b', 'bedrock_web_search:a', 'feed', 'signed']


class TestTheMethods:
    def test_methods_are_parsed_in_order_once_each(self, evals):
        assert [m.name for m in evals.parse_methods('http, feed,http')] == ['http', 'feed']
        assert list(evals.METHODS) == ['signed', 'unsigned', 'http', 'feed', 'bedrock_web_search',
                                       'agentcore_web_search', 'auto']
        assert [m.name for m in evals.parse_methods('auto,http')] == ['http', 'auto']  # auto reuses what ran before
        assert tuple(evals.METHODS) == evals.DEFAULT_METHODS  # every method by default

    @pytest.mark.parametrize('methods', ['http,scrape', ',', 'Signed'])
    def test_an_unknown_method_exits_2(self, evals, capsys, methods):
        assert _main(evals, '--methods', methods, '--dry-run') == 2
        assert '--methods: unknown method' in capsys.readouterr().err

    def test_a_model_call_budget_below_one_exits_2(self, evals, capsys):
        assert _main(evals, '--model-calls', '0', '--dry-run') == 2
        assert '--model-calls must be at least 1' in capsys.readouterr().err


class TestTheDryRun:
    @pytest.fixture
    def nothing_reachable(self, evals, monkeypatch):
        def refuse(*_args, **_kwargs):
            raise AssertionError('the dry run reached for AWS or the network')
        for target, name in ((boto3, 'client'), (boto3, 'Session'), (boto3.session.Session, 'client'),
                             (socket, 'getaddrinfo'), (requests, 'post'), (evals, 'aws_client'),
                             (evals, 'aws_credentials'), (evals, 'fetch_public_url'), (evals, 'post_json'),
                             (evals, 'converse')):
            monkeypatch.setattr(target, name, refuse)
        monkeypatch.setattr(evals.plugin('agentcore_browser'), 'browser_session', refuse)
        monkeypatch.setattr(evals.plugin('web_search_reader'), 'read_web_search_target', refuse)

    @pytest.mark.usefixtures('nothing_reachable')
    def test_it_prints_the_plan_without_any_aws_or_network_call(self, evals, capsys, tmp_path,
                                                                monkeypatch):
        sites = _write(tmp_path, _fixture_document())
        monkeypatch.chdir(tmp_path)
        assert _main(evals, '--sites', str(sites), '--prefix', 'b', '--dry-run',
                     '--methods', 'signed,unsigned,http,feed,bedrock_web_search,agentcore_web_search') == 0
        plan = capsys.readouterr().out
        assert 'BROWSER_IDENTIFIER of the Lambda b-voc-ingestor-web_reviews-<account>-us-west-2' in plan
        assert ('| G2 (g2) | Amazon Connect | unknown | 1 session | 1 session | robots.txt + 1 GET '
                '| — | 2 Responses requests | 1 InvokeWebSearch |') in plan
        assert ('At most: 4 browser sessions (300 s each), 8 model calls, 6 HTTP GETs (3 robots.txt; the shared '
                'fetcher retries a 429 / 5xx up to 3 times), 4 Responses requests, 2 InvokeWebSearch requests.') in plan
        assert {path.name for path in tmp_path.iterdir()} == {'sites.json'}

    @pytest.mark.usefixtures('nothing_reachable')
    def test_it_names_a_given_browser_and_spends_no_model_call_without_the_model(self, evals,
                                                                                capsys):
        assert _main(evals, '--dry-run', '--no-model', '--browser-id', 'br-9', '--only', 'g2',
                     '--methods', 'signed,feed,bedrock_web_search', '--web-search-models', 'openai.m-1') == 0
        plan = capsys.readouterr().out
        assert '- Signed browser: --browser-id br-9' in plan
        assert ('At most: 1 browser sessions (300 s each), 0 model calls, 0 HTTP GETs (0 robots.txt; the shared '
                'fetcher retries a 429 / 5xx up to 3 times), 1 Responses requests, 0 InvokeWebSearch requests.') in plan

    @pytest.mark.usefixtures('nothing_reachable')
    def test_the_whole_fixture_plans_with_the_default_methods(self, evals, capsys):
        assert _main(evals, '--dry-run') == 0
        plan = capsys.readouterr().out
        assert 'Sites: 27 from' in plan
        # Yelp and Reddit are for their official APIs only: nothing is planned for them.
        assert 'At most: 50 browser sessions' in plan
        assert '50 Responses requests' in plan
        assert '| Yelp (yelp) | Pike Place Market Seattle | official_api_only | official_api_only |' in plan

    @pytest.mark.usefixtures('nothing_reachable')
    def test_agentcore_in_a_region_without_it_is_planned_as_not_run(self, evals, capsys):
        assert _main(evals, '--region', 'eu-central-1', '--dry-run', '--only', 'g2',
                     '--methods', 'agentcore_web_search') == 0
        assert '| not run (eu-central-1) |' in capsys.readouterr().out


def test_a_snippet_cut_at_its_start_is_an_excerpt_too(evals, post):
    """``excerpt_only``: the search returned a cut passage (an ellipsis at either end)."""
    post.answer(_SEARCH, {'results': [{'text': '... and the IVR builder is easy.', 'url': _G2_PAGE}]})
    complete, _calls = _model_lines({'rating': None, 'date': None, 'title': None, 'text': 'and the IVR builder is easy.'})
    row = TestTheAgentCoreWebSearchMethod()._row(evals, post, complete)
    assert (row['sources'][0]['excerpt_only'], row['excerpt_only']) == (True, True)


# ── auto and the official-API-only sites ────────────────────────────────────────────────────────────────────────


def _made(evals, method, outcome, reviews=0, final_url=None, **extra):
    """A row a method already made of the site this run (``Run.site_rows``)."""
    row = evals.result(_site(evals), method, 'https://www.g2.com/products/x/reviews', 0.0,
                       evals.Verdict(outcome, extraction='x', count=reviews), read=evals.Read(final_url, 200))
    return {**row, **extra}


class TestAuto:
    def _auto(self, evals, *rows, **run):
        state = _run(evals, region='us-west-2', web_search_models=('openai.m-1',), **run)
        state.site_rows = list(rows)
        (row,) = evals.auto_rows(_site(evals), state)
        return row, state

    def test_a_readable_signed_browser_is_picked_and_nothing_else_runs(self, evals):
        row, _ = self._auto(evals, _made(evals, 'signed', 'readable', 10, _bodies=['b']))
        assert (row['method'], row['outcome'], row['picked'], row['reviews']) == ('auto', 'readable', 'signed', 10)
        assert row['chain'] == [{'method': 'signed', 'outcome': 'readable', 'reviews': 10}]
        assert row['_bodies'] == ['b']

    def test_a_block_hands_the_site_to_bedrock_web_search_its_first_model(self, evals):
        row, _ = self._auto(evals, _made(evals, 'signed', 'blocked:Cloudflare'),
                            _made(evals, 'bedrock_web_search:openai.m-1', 'readable', 11),
                            _made(evals, 'bedrock_web_search:openai.m-2', 'readable', 3))
        assert (row['picked'], row['reviews']) == ('bedrock_web_search', 11)
        assert [step['method'] for step in row['chain']] == ['signed', 'bedrock_web_search']

    @pytest.mark.parametrize('first', ['error', 'no_reviews', 'login', 'not_run'])
    def test_what_else_hands_the_site_on(self, evals, first):
        row, _ = self._auto(evals, _made(evals, 'signed', first),
                            _made(evals, 'bedrock_web_search:openai.m-1', 'error'),
                            _made(evals, 'agentcore_web_search', 'readable', 5))
        assert (row['picked'], [s['outcome'] for s in row['chain']]) == ('agentcore_web_search',
                                                                          [first, 'error', 'readable'])

    def test_a_redirect_to_chromes_error_page_is_a_block_and_to_another_site_ends_the_read(self, evals):
        error, _ = self._auto(evals, _made(evals, 'signed', 'off_host', final_url='chrome-error://chromewebdata/'),
                              _made(evals, 'bedrock_web_search:openai.m-1', 'readable', 2))
        moved, _ = self._auto(evals, _made(evals, 'signed', 'off_host', final_url='https://other.example/'))
        assert error['picked'] == 'bedrock_web_search'
        assert (moved['picked'], moved['outcome'], len(moved['chain'])) == (None, 'off_host', 1)

    def test_nothing_reads_it(self, evals):
        row, _ = self._auto(evals, _made(evals, 'signed', 'blocked:DataDome'),
                            _made(evals, 'bedrock_web_search:openai.m-1', 'error'),
                            _made(evals, 'agentcore_web_search', 'no_reviews'))
        assert (row['picked'], row['outcome'], row['reviews']) == (None, 'no_reviews', 0)

    def test_a_step_that_did_not_run_is_run_now(self, evals, post):
        post.answer(_MANTLE, _responses_answer([_web_review('Routing works well.')]))
        row, state = self._auto(evals, _made(evals, 'signed', 'blocked:Cloudflare'), post=post)
        assert (row['picked'], row['reviews']) == ('bedrock_web_search', 1)
        assert [r['method'] for r in state.site_rows] == ['signed', 'bedrock_web_search:openai.m-1']

    def test_it_runs_last_and_its_own_steps_stay_in_the_report(self, evals, browser, post):
        browser.snapshot = evals.plugin('page_reader').PageSnapshot(
            url='https://www.g2.com/products/x/reviews', status=403, title='Just a moment...', text='', html='',
            jsonld=(), next_url=None)
        post.answer(_MANTLE, _responses_answer([_web_review('Routing works well.')]))
        run = _run(evals, region='us-west-2', post=post, web_search_models=('openai.m-1',), signed_id='br-1')
        rows = evals.run_eval([_site(evals)], evals.parse_methods('auto,unsigned'), run)
        assert [(r['method'], r['outcome']) for r in rows] == [
            ('unsigned', 'blocked:Cloudflare'), ('signed', 'blocked:Cloudflare'),
            ('bedrock_web_search:openai.m-1', 'readable'), ('auto', 'readable')]
        assert rows[-1]['verbatim'] == 'unverifiable'

    def test_the_pivot_names_the_picked_step(self, evals):
        assert evals._pivot_cell({'outcome': 'readable', 'picked': 'bedrock_web_search', 'verbatim': None}) == (
            'readable via bedrock_web_search')


class TestOfficialApiOnly:
    def test_no_method_reads_the_site_each_row_says_why(self, evals):
        site = _site(evals, expect='official_api_only', official_api_only=True, notes='Official API only: Yelp Fusion.',
                     structured=(_entry(evals, kind='official_api', url='https://docs.developer.yelp.com/',
                                        needs_secret=True),))
        rows = evals.run_eval([site], evals.parse_methods('signed,http,feed,bedrock_web_search,auto'),
                              _run(evals, region='us-west-2'))
        assert [(r['method'], r['outcome'], r['vs_expect']) for r in rows] == [
            (method, 'official_api_only', 'as expected')
            for method in ('signed', 'http', 'feed', 'bedrock_web_search', 'auto')]
        assert rows[0]['detail'] == 'Official API only: Yelp Fusion.; https://docs.developer.yelp.com/'

    def test_the_vendor_column_is_what_this_run_met(self, evals):
        rows = [{'outcome': 'blocked:Cloudflare'}, {'outcome': 'readable'}, {'outcome': 'blocked:Cloudflare'},
                {'outcome': 'blocked:HTTP 403'}]
        assert evals.vendors(rows) == 'Cloudflare, HTTP 403'
        assert evals.vendors([{'outcome': 'readable'}]) == '—'
