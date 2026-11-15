"""Review-site eval of the Web Reviews plugin: which reading method gets the reviews of which site, measured.

    AWS_PROFILE=<p> .venv/bin/python scripts/evals/web_reviews_sites.py --region us-west-2 [--prefix b]
        [--sites plugins/web_reviews/evals/sites.json] [--only g2,capterra] [--methods signed,unsigned,http,feed]
        [--browser-id <id>] [--no-model] [--model-id <id>] [--model-calls 1]
        [--web-search-models openai.gpt-5.6-luna,openai.gpt-5.6-terra] [--out <dir>] [--dry-run]

Run from voc-datalake/. Every site of the fixture (plugins/web_reviews/evals/sites.json) is read once per method,
page 1 only, and each read is classified the way the plugin sees a page (``classify``): off-host, blocked by a bot
wall (block_detection.py), a sign-in page, or reviews from its JSON-LD or from its text by the ``enrichment`` model
(extract.py), counted up to the site's ``max_reviews``. Methods (``METHODS``):

- ``signed``: the deployment's Web Bot Auth browser (``--browser-id``, else the ``BROWSER_IDENTIFIER`` of the
  Lambda ``[<prefix>-]voc-ingestor-web_reviews-<account>-<region>``; none: its rows are ``not_run``).
- ``unsigned``: the AWS-managed ``aws.browser.v1``, the baseline the fixture records.
- ``http``: one GET with this eval's own User-Agent (``VoC-Analytics-ReviewReader/<version>``), after robots.txt
  (RFC 9309) allows it.
- ``feed``: the site's ``structured`` entries (an RSS / Atom feed, a JSON API), fetched the same way and counted;
  an ``official_api`` or one that needs a secret is reported ``not_run`` with its docs.
- ``bedrock_web_search``: the ingestor's own reader (web_search_reader.py): an OpenAI GPT model on the
  ``bedrock-mantle`` Responses API opens the page from the Bedrock web search cache; one request per site per
  model (``--web-search-models``), one row each (``bedrock_web_search:<model>``).
- ``agentcore_web_search`` (not in the default ``--methods``): AgentCore Web Search (``InvokeWebSearch``, no
  model in the retrieval), ``"<subject> reviews"`` held to the site's domain; the model then reads the SNIPPETS
  only, and a review is kept only when its body is in one of them.

A web-search row's reviews are checked against the page text this run's browser or http rows read of the same
site (``verbatim``): every body found, some, none (``paraphrase_risk``), or no page text to check against.

What it never does: write anything into a deployment (no queue, watermark or secret; ``BROWSER_PROFILE_IDENTIFIER``
is removed before every session, so no browser profile is loaded or saved), or hide what it is (no stealth, no
browser-like User-Agent, no CAPTCHA solving, no proxy). Its AWS calls are reads (sts GetCallerIdentity, lambda
GetFunctionConfiguration, bedrock-agentcore-control GetBrowser) plus the browser sessions it starts and always stops
(one per site per browser method, 300 s at most), at most ``--model-calls`` Converse calls per page read, and the
web search requests above.

Output: ``--out`` (default ``web-reviews-eval/<UTC yyyymmddThhmmssZ>`` under the current directory) gets
``report.json`` and ``report.md``; report.md is printed too. ``--dry-run`` prints the plan without any AWS call or
network request. Exit 0 when the eval ran, 2 on a setup error (a bad fixture or argument, the ingestor Lambda not
found when ``signed`` needs it and no ``--browser-id`` is given).
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import string
import sys
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable, Generator, Iterable, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from typing import Any, Final, Literal
from urllib.parse import quote, urlsplit

# `lambda/` (shared.*), `plugins/` (_shared.*, which the browser module logs through) and the plugin's flat modules,
# laid out as the ingestor's bundle lays them out.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'lambda'))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'plugins'))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'plugins' / 'web_reviews' / 'ingestor'))

import requests
import urllib3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError
from bs4 import BeautifulSoup

from shared.converse import BedrockThrottlingError, converse
from shared.http_utils import MAX_PAGE_BYTES, RetryableHTTPError, UnsafeURLError, fetch_public_url
from shared.web_review_targets import TargetError, checked_url

ROOT: Final = Path(__file__).resolve().parents[2]
DEFAULT_SITES: Final = ROOT / 'plugins' / 'web_reviews' / 'evals' / 'sites.json'

# ── the plugin's flat modules, imported by name (pyright cannot resolve them from scripts/) ────────────────────────
BROWSER_MODULE: Final = 'agentcore_browser'
PAGE_MODULE: Final = 'page_reader'
BLOCK_MODULE: Final = 'block_detection'
EXTRACT_MODULE: Final = 'extract'
CDP_MODULE: Final = 'cdp_client'
WEB_SEARCH_MODULE: Final = 'web_search_reader'

#: The browsers: the unsigned baseline, and the env var naming the browser a session starts on (agentcore_browser).
UNSIGNED_BROWSER: Final = 'aws.browser.v1'
BROWSER_ENV: Final = 'BROWSER_IDENTIFIER'
PROFILE_ENV: Final = 'BROWSER_PROFILE_IDENTIFIER'
BROWSER_SESSION_SECONDS: Final = 300
INGESTOR_BASE_NAME: Final = 'voc-ingestor-web_reviews'
NO_SIGNED_BROWSER: Final = 'the deployment has no Web Bot Auth browser (opted out, or not deployed)'

#: Amazon Bedrock web search (web_search_reader.py), once per model.
BEDROCK_WEB_SEARCH: Final = 'bedrock_web_search'
DEFAULT_WEB_SEARCH_MODELS: Final = ('openai.gpt-5.6-luna', 'openai.gpt-5.6-terra')
_MODEL_ID_RE: Final = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}\Z')
#: AgentCore Web Search: the AWS-managed tool, its REST path (botocore's bedrock-agentcore model, InvokeWebSearch),
#: the SigV4 service, the regions that offer it (devguide, web-search-api.html → Regions).
AGENTCORE_WEB_SEARCH: Final = 'agentcore_web_search'
WEB_SEARCH_TOOL: Final = 'web-search.v1'
AGENTCORE_SIGNING_SERVICE: Final = 'bedrock-agentcore'
AGENTCORE_SEARCH_REGIONS: Final = frozenset({'us-east-1', 'us-east-2', 'us-west-2', 'ap-southeast-2', 'ap-northeast-1',
                                             'eu-west-1'})
AGENTCORE_SEARCH_RESULTS: Final = 10
AGENTCORE_SEARCH_TIMEOUT_SECONDS: Final = 60
MAX_QUERY_CHARS: Final = 200
#: Characters of a review body (whitespace collapsed, lower-cased) looked for in another method's page text.
VERBATIM_KEY_CHARS: Final = 80
#: Rows whose page text was the page itself (not a wall, a sign-in page or another host): what ``verbatim`` reads.
PAGE_TEXT_OUTCOMES: Final = frozenset({'readable', 'no_reviews', 'unextracted'})
#: Row keys held in memory between a site's rows and dropped before the report.
PAGE_TEXT_KEY: Final = '_page_text'
BODIES_KEY: Final = '_bodies'
#: Every row's method-specific fields (None where they do not apply).
ROW_EXTRAS: Final = ('excerpt_only', 'verbatim', 'model', 'opened_urls', 'cited_urls', 'dropped', 'sources')

#: How the http and feed methods identify themselves, and the robots.txt product token they obey.
ROBOTS_PRODUCT: Final = 'VoC-Analytics-ReviewReader'
DOCS_URL: Final = 'https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/docs/web-reviews.md'
HTTP_TIMEOUT_SECONDS: Final = 30
MAX_REDIRECTS: Final = 5
#: RFC 9309 asks a crawler to read at least 500 KiB of a robots.txt.
ROBOTS_MAX_BYTES: Final = 500 * 1024
#: Bytes read of a 429 / 5xx answer's body (left unread by the fetcher), for block detection.
ERROR_BODY_BYTES: Final = 64 * 1024
HTML_ACCEPT: Final = 'text/html,application/xhtml+xml'
FEED_ACCEPT: Final = {
    'rss': 'application/rss+xml, application/xml, text/xml',
    'atom': 'application/atom+xml, application/xml, text/xml',
    'json': 'application/json',
}

#: The model extraction (handler.py ``_model_completion``, under its own step name).
STEP_NAME: Final = 'web_reviews_eval'
SAMPLE_REVIEWS: Final = 2
SAMPLE_CHARS: Final = 200
#: What a row says when its outcome is not compared with the fixture's expectation.
NO_COMPARISON: Final = '—'
UNCOMPARED_OUTCOMES: Final = frozenset({'not_run', 'error'})

#: The fixture's vocabulary.
EXPECTATIONS: Final = ('readable', 'blocked', 'login', 'unknown')
FEED_KINDS: Final = ('rss', 'atom', 'json', 'official_api')
MAX_REVIEW_CAP: Final = 100
_TOP_KEYS: Final = frozenset({'description', 'defaults', 'sites'})
_DEFAULT_KEYS: Final = frozenset({'max_pages', 'max_reviews'})
_SITE_REQUIRED: Final = frozenset({'id', 'site', 'url', 'subject', 'expect', 'baseline', 'evidence'})
_SITE_OPTIONAL: Final = frozenset({'vendor', 'vendor_evidence', 'notes', 'structured', 'max_reviews'})
_ENTRY_REQUIRED: Final = frozenset({'kind', 'url'})
_ENTRY_OPTIONAL: Final = frozenset({'needs_secret', 'count_path', 'docs', 'notes'})
_SITE_ID_RE: Final = re.compile(r'^[a-z0-9][a-z0-9_-]{0,47}\Z')

#: Sign-in pages: by their URL's path, or by their title.
_SIGN_IN_PATH: Final = re.compile(r'/(?:login|signin|sign-in|sign_in|ap/signin|account/login)(?![a-z0-9])', re.IGNORECASE)
_SIGN_IN_TITLES: Final = ('sign in', 'log in', 'login')

_ATOM_ENTRY: Final = '{http://www.w3.org/2005/Atom}entry'
_ATOM_TITLE: Final = '{http://www.w3.org/2005/Atom}title'
_UNSAFE_XML: Final = re.compile(rb'<!\s*(DOCTYPE|ENTITY)', re.IGNORECASE)
_UNRESERVED: Final = frozenset(string.ascii_letters + string.digits + '-._~')
_PERCENT_RE: Final = re.compile(r'%([0-9A-Fa-f]{2})')
_RESERVED_KEPT: Final = ":/?#[]@!$&'()*+,;=%"
_MONTHS: Final = ('January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
                  'November', 'December')
_ELLIPSES: Final = ('...', '\u2026')


class SetupError(Exception):
    """The eval cannot start (a bad fixture or argument, no ingestor to read the signed browser from)."""


class FeedParseError(ValueError):
    """A structured entry's answer is not what its kind says."""


class AgentCoreSearchError(RuntimeError):
    """InvokeWebSearch refused the request or gave no readable answer; the message is client-safe."""


def plugin(name: str) -> ModuleType:
    """One of the plugin's flat modules (plugins/web_reviews/ingestor, on sys.path above)."""
    return importlib.import_module(name)


# ── the fixture ─────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Structured:
    """A site's structured source: a feed or an API the ``feed`` method reads instead of the page."""

    kind: str
    url: str
    needs_secret: bool
    count_path: str | None
    docs: str
    notes: str


@dataclass(frozen=True)
class Site:
    id: str
    site: str
    url: str
    subject: str
    vendor: str
    expect: str
    baseline: str
    max_reviews: int
    structured: tuple[Structured, ...]


def _text(value: object, where: str, *, empty: bool = False) -> str:
    if not isinstance(value, str) or (not empty and not value.strip()):
        raise SetupError(f'{where} must be a {"" if empty else "non-empty "}string')
    return value


def _https(value: object, where: str) -> str:
    url = _text(value, where)
    parts = urlsplit(url)
    if parts.scheme != 'https' or not parts.hostname:
        raise SetupError(f'{where} must be an https URL, not {url!r}')
    return url


def _choice(value: object, where: str, choices: Sequence[str]) -> str:
    if value not in choices:
        raise SetupError(f'{where} must be one of {", ".join(choices)}, not {value!r}')
    return str(value)


def _cap(value: object, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_REVIEW_CAP:
        raise SetupError(f'{where} must be a whole number from 1 to {MAX_REVIEW_CAP}')
    return value


def _keys(value: object, where: str, required: frozenset[str], optional: frozenset[str] = frozenset()) -> dict:
    if not isinstance(value, dict):
        raise SetupError(f'{where} must be an object')
    unknown = sorted(set(value) - required - optional)
    if unknown:
        raise SetupError(f'{where}: unknown key {unknown[0]!r}')
    missing = sorted(required - set(value))
    if missing:
        raise SetupError(f'{where}: missing key {missing[0]!r}')
    return value


def _structured(value: object, where: str) -> Structured:
    entry = _keys(value, where, _ENTRY_REQUIRED, _ENTRY_OPTIONAL)
    kind = _choice(entry['kind'], f'{where}.kind', FEED_KINDS)
    count_path = entry.get('count_path')
    if kind == 'json':
        count_path = _text(count_path, f'{where}.count_path (a json entry needs one)')
    elif count_path is not None:
        raise SetupError(f'{where}.count_path is for a json entry only')
    needs_secret = entry.get('needs_secret', False)
    if not isinstance(needs_secret, bool):
        raise SetupError(f'{where}.needs_secret must be true or false')
    return Structured(kind=kind, url=_https(entry['url'], f'{where}.url'), needs_secret=needs_secret,
                      count_path=count_path, docs=_text(entry.get('docs', ''), f'{where}.docs', empty=True),
                      notes=_text(entry.get('notes', ''), f'{where}.notes', empty=True))


def _site(value: object, where: str, default_cap: int) -> Site:
    raw = _keys(value, where, _SITE_REQUIRED, _SITE_OPTIONAL)
    site_id = raw['id']
    if not isinstance(site_id, str) or not _SITE_ID_RE.match(site_id):
        raise SetupError(f'{where}.id must be lower-case letters, digits, "_" or "-" (at most 48), not {site_id!r}')
    where = f'{where} ({site_id})'
    _text(raw['evidence'], f'{where}.evidence')
    _text(raw.get('vendor_evidence', ''), f'{where}.vendor_evidence', empty=True)
    _text(raw.get('notes', ''), f'{where}.notes', empty=True)
    entries = raw.get('structured', [])
    if not isinstance(entries, list):
        raise SetupError(f'{where}.structured must be a list')
    return Site(
        id=site_id, site=_text(raw['site'], f'{where}.site'), url=_https(raw['url'], f'{where}.url'),
        subject=_text(raw['subject'], f'{where}.subject'), vendor=_text(raw.get('vendor', 'unknown'), f'{where}.vendor'),
        expect=_choice(raw['expect'], f'{where}.expect', EXPECTATIONS),
        baseline=_choice(raw['baseline'], f'{where}.baseline', EXPECTATIONS),
        max_reviews=_cap(raw.get('max_reviews', default_cap), f'{where}.max_reviews'),
        structured=tuple(_structured(entry, f'{where}.structured[{i}]') for i, entry in enumerate(entries)),
    )


def load_fixture(path: Path) -> list[Site]:
    """The fixture's sites, validated strictly (any unknown key, bad value or duplicate id is a ``SetupError``)."""
    try:
        document = json.loads(path.read_text(encoding='utf-8'))
    except OSError as error:
        raise SetupError(f'{path}: cannot be read ({error.strerror or error})') from None
    except ValueError as error:
        raise SetupError(f'{path}: not valid JSON ({error})') from None
    top = _keys(document, path.name, _TOP_KEYS)
    _text(top['description'], f'{path.name}: description')
    defaults = _keys(top['defaults'], f'{path.name}: defaults', _DEFAULT_KEYS)
    if isinstance(defaults['max_pages'], bool) or defaults['max_pages'] != 1:
        raise SetupError(f'{path.name}: defaults.max_pages must be 1 (the eval reads page 1 only), '
                         f'not {defaults["max_pages"]!r}')
    default_cap = _cap(defaults['max_reviews'], f'{path.name}: defaults.max_reviews')
    raw_sites = top['sites']
    if not isinstance(raw_sites, list) or not raw_sites:
        raise SetupError(f'{path.name}: sites must be a non-empty list')
    sites = [_site(raw, f'{path.name}: sites[{i}]', default_cap) for i, raw in enumerate(raw_sites)]
    seen: set[str] = set()
    for site in sites:
        if site.id in seen:
            raise SetupError(f'{path.name}: duplicate site id {site.id!r}')
        seen.add(site.id)
    return sites


def selected_sites(sites: Sequence[Site], only: str) -> list[Site]:
    """The sites ``--only`` names (comma-separated ids), in the fixture's order; all of them without it."""
    wanted = [part.strip() for part in only.split(',') if part.strip()]
    unknown = sorted(set(wanted) - {site.id for site in sites})
    if unknown:
        raise SetupError(f'--only names no such site: {", ".join(unknown)}')
    return [site for site in sites if not wanted or site.id in wanted]


# ── one page, as every method sees it ───────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Page:
    url: str
    status: int
    title: str
    text: str
    html: str
    jsonld: tuple[str, ...]


@dataclass(frozen=True)
class Verdict:
    outcome: str
    extraction: str | None = None
    count: int = 0
    sample: tuple[dict[str, Any], ...] = ()
    detail: str = ''


class ModelBudget:
    """The model extraction's completion, at most ``limit`` calls: after that it answers '' (no review), so
    ``llm_reviews`` spends nothing on the page's later chunks."""

    def __init__(self, limit: int, complete: Callable[[str, str], str]):
        self.limit = limit
        self.used = 0
        self._complete = complete

    def __call__(self, prompt: str, system_prompt: str) -> str:
        if self.used >= self.limit:
            return ''
        self.used += 1
        return self._complete(prompt, system_prompt)


def model_completion(model_id: str | None) -> Callable[[str, str], str]:
    """The handler's Converse call (``enrichment`` surface, no temperature, no continuation), on ``model_id``
    when given."""
    extract = plugin(EXTRACT_MODULE)

    def complete(prompt: str, system_prompt: str) -> str:
        return converse(
            prompt=prompt, system_prompt=system_prompt, max_tokens=extract.LLM_MAX_TOKENS, temperature=None,
            surface=extract.LLM_SURFACE, step_name=STEP_NAME, max_continuations=0, model_id=model_id,
        )
    return complete


def _signs_in(url: str) -> bool:
    return _SIGN_IN_PATH.search(urlsplit(url).path) is not None


def _sample(review: Any) -> dict[str, Any]:
    """A review for the report: its text cut to ``SAMPLE_CHARS``, never its author."""
    return {'text': review.text[:SAMPLE_CHARS], 'rating': review.rating, 'date': review.date, 'title': review.title}


def _with_reviews(extraction: str, reviews: Sequence[Any], cap: int) -> Verdict:
    kept = list(reviews)[:cap]
    return Verdict('readable' if kept else 'no_reviews', extraction=extraction, count=len(kept),
                   sample=tuple(_sample(review) for review in kept[:SAMPLE_REVIEWS]))


def classify(target_url: str, page: Page, cap: int, budget: ModelBudget | None) -> Verdict:
    """What *page* (read for *target_url*) gives the plugin, checked in order:

    1. another host than the target's: ``login`` when its URL path is a sign-in page's, else ``off_host``;
    2. a bot wall (block_detection ``blocked_by``): ``blocked:<vendor>``;
    3. a sign-in page (by its URL path, or a title starting "Sign in" / "Log in" / "Login"): ``login``;
    4. reviews in its JSON-LD (extraction ``json-ld``); else, with ``budget`` None (``--no-model``), ``unextracted``
       (extraction ``text``); else the model over its text, within the budget (extraction ``model``).
       At least one review is ``readable``, none ``no_reviews``; at most *cap* are counted.
    """
    host = urlsplit(page.url).hostname
    if host != urlsplit(target_url).hostname:
        if _signs_in(page.url):
            return Verdict('login', detail=f'redirected to a sign-in page on {host}')
        return Verdict('off_host', detail=f'redirected to {host or page.url[:80]}')
    blocks = plugin(BLOCK_MODULE)
    vendor = blocks.blocked_by(blocks.PageSignals(status=page.status, title=page.title, text=page.text, html=page.html))
    if vendor:
        return Verdict(f'blocked:{vendor}')
    if _signs_in(page.url) or page.title.strip().lower().startswith(_SIGN_IN_TITLES):
        return Verdict('login', detail='a sign-in page')
    extract = plugin(EXTRACT_MODULE)
    reviews = extract.jsonld_reviews(page.jsonld)
    if reviews:
        return _with_reviews('json-ld', reviews, cap)
    if budget is None:
        return Verdict('unextracted', extraction='text', detail='no JSON-LD reviews; --no-model left the text unread')
    return _with_reviews('model', extract.llm_reviews(page.text, budget), cap)


def compare(expected: str, outcome: str) -> str:
    """``as expected`` / ``differs``; ``—`` for an unknown expectation or an outcome that measured nothing.
    Any ``blocked:<vendor>`` is ``blocked``."""
    if expected == 'unknown' or outcome in UNCOMPARED_OUTCOMES:
        return NO_COMPARISON
    measured = 'blocked' if outcome.startswith('blocked:') else outcome
    return 'as expected' if measured == expected else 'differs'


# ── robots.txt (RFC 9309) ───────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RobotsGroup:
    agents: tuple[str, ...]
    rules: tuple[tuple[bool, str], ...]  # (allow, path pattern)


def parse_robots(text: str) -> list[RobotsGroup]:
    """The groups of a robots.txt: consecutive user-agent lines, then their allow / disallow rules."""
    groups: list[RobotsGroup] = []
    agents: list[str] = []
    rules: list[tuple[bool, str]] = []
    in_rules = False
    for line in text.splitlines():
        key, _, value = line.split('#', 1)[0].partition(':')
        key, value = key.strip().lower(), value.strip()
        if key == 'user-agent':
            if in_rules:  # a user-agent line after rules starts the next group
                groups.append(RobotsGroup(tuple(agents), tuple(rules)))
                agents, rules, in_rules = [], [], False
            agents.append(value.lower())
        elif key in ('allow', 'disallow') and agents:
            in_rules = True
            if value:  # an empty rule matches nothing
                rules.append((key == 'allow', value))
    if agents:
        groups.append(RobotsGroup(tuple(agents), tuple(rules)))
    return groups


def _normalised(path: str) -> str:
    """*path* percent-encoded for comparison: non-ASCII encoded, an encoded unreserved character decoded."""
    def decoded(match: re.Match[str]) -> str:
        char = chr(int(match.group(1), 16))
        return char if char in _UNRESERVED else f'%{match.group(1).upper()}'
    return _PERCENT_RE.sub(decoded, quote(path, safe=_RESERVED_KEPT))


def _pattern(rule: str) -> re.Pattern[str]:
    """A rule's path pattern: ``*`` any characters, a final ``$`` the end of the path."""
    body = rule.removesuffix('$')
    regex = '.*'.join(re.escape(part) for part in body.split('*'))
    return re.compile(regex + (r'\Z' if body != rule else ''))


def robots_allows(groups: Sequence[RobotsGroup], token: str, url: str) -> bool:
    """Whether the group(s) for *token* (else ``*``; none: no rules) let *token* fetch *url*: the longest matching
    rule wins, an allow on a tie."""
    token = token.lower()
    matching = [group for group in groups if token in {agent.split('/')[0].strip() for agent in group.agents}]
    if not matching:
        matching = [group for group in groups if '*' in group.agents]
    parts = urlsplit(url)
    path = _normalised((parts.path or '/') + (f'?{parts.query}' if parts.query else ''))
    rules = [(allow, _normalised(raw)) for group in matching for allow, raw in group.rules]
    matches = [(len(rule), allow) for allow, rule in rules if _pattern(rule).match(path)]
    return not matches or max(matches)[1]


# ── HTTP: the http and feed methods ────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Fetched:
    url: str
    status: int
    content: bytes
    text: str


def user_agent(version: str) -> str:
    return f'{ROBOTS_PRODUCT}/{version} (+{DOCS_URL})'


def package_version() -> str:
    """voc-datalake's version (package.json), the User-Agent's."""
    try:
        version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8')).get('version')
    except (OSError, ValueError, AttributeError):
        version = None
    if not isinstance(version, str) or not version:
        raise SetupError('package.json has no version to name in the User-Agent')
    return version


def _error_answer(response: requests.Response, url: str) -> Fetched:
    """A 429 / 5xx answer (fetch_public_url raised it, its body unread): its status and the start of its body."""
    try:
        content = response.raw.read(ERROR_BODY_BYTES, decode_content=True) or b''
    except (OSError, ValueError, requests.RequestException, urllib3.exceptions.HTTPError, AttributeError):
        content = b''
    finally:
        response.close()
    content = content if isinstance(content, bytes) else b''
    return Fetched(url=response.url or url, status=response.status_code, content=content,
                   text=content.decode(response.encoding or 'utf-8', errors='replace'))


def fetch(url: str, accept: str, agent: str, max_bytes: int) -> Fetched:
    """One policy-checked GET (``checked_url``, then ``fetch_public_url``, SSRF-pinned) that says who it is."""
    checked = checked_url(url)
    headers = {'User-Agent': agent, 'Accept': accept}
    try:
        response = fetch_public_url(checked, headers=headers, timeout=HTTP_TIMEOUT_SECONDS,
                                    max_redirects=MAX_REDIRECTS, max_bytes=max_bytes)
    except RetryableHTTPError as error:
        if error.response is None:
            raise
        return _error_answer(error.response, checked)
    return Fetched(url=response.url or checked, status=response.status_code, content=response.content,
                   text=response.text)


def _robots_answer(origin: str, agent: str) -> str | list[RobotsGroup]:
    """The origin's robots.txt groups, or why it counts as disallowing everything (RFC 9309: a 4xx is no rules;
    a 5xx, a 429 or no answer is a complete disallow)."""
    try:
        answer = fetch(f'{origin}/robots.txt', 'text/plain', agent, ROBOTS_MAX_BYTES)
    except requests.RequestException as error:
        return f'robots.txt unreachable ({type(error).__name__}): treated as disallowing everything'
    if 200 <= answer.status < 300:
        return parse_robots(answer.text)
    if 400 <= answer.status < 500 and answer.status != 429:
        return []
    return f'robots.txt answered HTTP {answer.status}: treated as disallowing everything'


#: ``(url, body, headers, timeout) -> (status, response body)``, as web_search_reader's ``Post``.
Post = Callable[[str, bytes, dict[str, str], float], tuple[int, bytes]]


def aws_credentials() -> Any:
    import boto3

    found = boto3.Session().get_credentials()
    if found is None:
        raise NoCredentialsError
    return found.get_frozen_credentials()


def post_json(url: str, body: bytes, headers: dict[str, str], timeout: float) -> tuple[int, bytes]:
    """One POST to an AWS endpoint (never to a review site)."""
    response = requests.post(url, data=body, headers=headers, timeout=timeout)
    return response.status_code, response.content


@dataclass
class Run:
    """What every row of one eval shares."""

    agent: str
    signed_id: str | None
    complete: Callable[[str, str], str] | None
    model_calls: int
    region: str = ''
    web_search_models: tuple[str, ...] = DEFAULT_WEB_SEARCH_MODELS
    #: The web search requests' POST, ``(url, body, headers, timeout) -> (status, body)``; None: ``post_json``.
    post: Post | None = None
    robots: dict[str, str | list[RobotsGroup]] = field(default_factory=dict)
    signing_credentials: Any = None

    def budget(self) -> ModelBudget | None:
        return ModelBudget(self.model_calls, self.complete) if self.complete is not None else None

    def credentials(self) -> Any:
        """The ambient AWS credentials, frozen, read once per run (the web search requests are SigV4-signed)."""
        if self.signing_credentials is None:
            self.signing_credentials = aws_credentials()
        return self.signing_credentials

    def robots_refusal(self, url: str) -> str | None:
        """Why robots.txt keeps this eval off *url*, or None (each origin's robots.txt is read once per run)."""
        parts = urlsplit(checked_url(url))
        origin = f'{parts.scheme}://{parts.netloc}'
        if origin not in self.robots:
            self.robots[origin] = _robots_answer(origin, self.agent)
        answer = self.robots[origin]
        if isinstance(answer, str):
            return answer
        if robots_allows(answer, ROBOTS_PRODUCT, url):
            return None
        return f'robots.txt disallows {parts.path or "/"} for {ROBOTS_PRODUCT}'


def _capped_jsonld(blocks: Iterable[str]) -> tuple[str, ...]:
    """The JSON-LD blocks within page_reader's caps (blocks, characters per block, characters in all)."""
    reader = plugin(PAGE_MODULE)
    kept: list[str] = []
    total = 0
    for raw in blocks:
        if len(kept) >= reader.MAX_JSONLD_BLOCKS:
            break
        block = raw[:reader.MAX_JSONLD_CHARS]
        if not block.strip() or total + len(block) > reader.MAX_JSONLD_TOTAL_CHARS:
            continue
        kept.append(block)
        total += len(block)
    return tuple(kept)


def parse_html(url: str, status: int, html: str) -> Page:
    """A fetched page as the browser's snapshot has it: title, JSON-LD, visible text (collapsed like page_reader's
    fetch mode), the start of the HTML."""
    soup = BeautifulSoup(html, 'html.parser')
    title = ' '.join(soup.title.get_text().split()) if soup.title else ''
    jsonld = _capped_jsonld(script.get_text() for script in soup.select('script[type="application/ld+json" i]'))
    for element in soup.select('script, style, noscript, template, svg'):
        if not element.decomposed:
            element.decompose()
    text = (soup.body or soup).get_text()
    text = re.sub(r'\s*\n\s*', '\n', re.sub(r'[ \t\r\f\v]+', ' ', text))
    return Page(url=url, status=status, title=title, text=text[:plugin(PAGE_MODULE).MAX_TEXT_CHARS],
                html=html[:plugin(BLOCK_MODULE).HTML_SAMPLE_CHARS], jsonld=jsonld)


def _wall(fetched: Fetched) -> str | None:
    blocks = plugin(BLOCK_MODULE)
    return blocks.blocked_by(blocks.PageSignals(status=fetched.status, title='', text=fetched.text,
                                                html=fetched.text[:blocks.HTML_SAMPLE_CHARS]))


def _feed_entries(fetched: Fetched) -> list[ET.Element]:
    if b'\x00' in fetched.content:
        raise FeedParseError('not an ASCII-compatible document')
    if _UNSAFE_XML.search(fetched.content):
        raise FeedParseError('the feed declares a DOCTYPE or an ENTITY (not parsed)')
    try:
        root = ET.fromstring(fetched.content)  # noqa: S314 - DOCTYPE / ENTITY refused above
    except ET.ParseError:
        raise FeedParseError('the answer is not well-formed XML') from None
    return [*root.iter('item'), *root.iter(_ATOM_ENTRY)]


def _json_count(fetched: Fetched, count_path: str) -> int:
    try:
        value: Any = json.loads(fetched.text)
    except ValueError:
        raise FeedParseError('the answer is not JSON') from None
    for key in count_path.split('.'):
        if isinstance(value, list) and key.isdigit():
            value = value[int(key)] if int(key) < len(value) else None
        else:
            value = value.get(key) if isinstance(value, dict) else None
    if value is None:
        return 0
    if not isinstance(value, list):
        raise FeedParseError(f'count_path {count_path!r} does not name a list')
    return len(value)


def feed_verdict(entry: Structured, fetched: Fetched, cap: int) -> Verdict:
    """An RSS / Atom feed's items (``item``, Atom ``entry``) or a JSON answer's ``count_path`` list, counted."""
    if fetched.status >= 400:
        return Verdict(f'blocked:{_wall(fetched)}')
    sample: tuple[dict[str, Any], ...] = ()
    try:
        if entry.kind == 'json' and entry.count_path is not None:
            count, extraction = _json_count(fetched, entry.count_path), 'json'
        else:
            items = _feed_entries(fetched)
            count, extraction = len(items), 'feed'
            titles = (' '.join((item.findtext('title') or item.findtext(_ATOM_TITLE) or '').split()) for item in items)
            sample = tuple({'text': title[:SAMPLE_CHARS], 'rating': None, 'date': None, 'title': None}
                           for title in titles if title)[:SAMPLE_REVIEWS]
    except FeedParseError as error:
        vendor = _wall(fetched)
        return Verdict(f'blocked:{vendor}') if vendor else Verdict('error', detail=str(error))
    kept = min(count, cap)
    return Verdict('readable' if kept else 'no_reviews', extraction=extraction, count=kept, sample=sample)


# ── the rows ────────────────────────────────────────────────────────────────────────────────────────────────────


def row_errors() -> tuple[type[BaseException], ...]:
    """What one row may fail with; it is then an ``error`` row, the eval goes on."""
    return (plugin(BROWSER_MODULE).BrowserUnavailableError, plugin(PAGE_MODULE).PageLoadError,
            plugin(CDP_MODULE).CdpError, plugin(WEB_SEARCH_MODULE).WebSearchError, AgentCoreSearchError, TargetError,
            UnsafeURLError, requests.RequestException, ClientError, BotoCoreError, BedrockThrottlingError, OSError)


def _short(error: BaseException) -> str:
    message = ' '.join(str(error).split())[:160]
    return f'{type(error).__name__}: {message}' if message else type(error).__name__


@dataclass(frozen=True)
class Read:
    """Where a row's read ended: the final URL and its HTTP status (nothing when no page was read)."""

    final_url: str | None = None
    status: int | None = None


def result(site: Site, method: str, url: str, started: float, verdict: Verdict, *,
           budget: ModelBudget | None = None, read: Read | None = None,
           extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """One report row; *extra*: its method-specific fields (``ROW_EXTRAS``), and the in-memory ``PAGE_TEXT_KEY`` /
    ``BODIES_KEY`` that ``run_eval`` drops."""
    read = read or Read()
    return {
        'site_id': site.id, 'site': site.site, 'url': url, 'method': method, 'outcome': verdict.outcome,
        'reviews': verdict.count, 'pages_read': 0 if read.final_url is None else 1,
        'seconds': round(time.monotonic() - started, 1), 'extraction': verdict.extraction,
        'model_calls': budget.used if budget is not None else 0, 'http_status': read.status,
        'final_url': read.final_url, 'expect': site.expect, 'baseline': site.baseline,
        'vs_expect': compare(site.expect, verdict.outcome), 'vs_baseline': compare(site.baseline, verdict.outcome),
        'detail': verdict.detail, 'sample': list(verdict.sample),
        **dict.fromkeys(ROW_EXTRAS), **(extra or {}),
    }


def _page_text(page: Page, verdict: Verdict) -> dict[str, Any]:
    """The page's text for the site's web-search rows to be checked against, when it was the page itself."""
    return {PAGE_TEXT_KEY: page.text} if verdict.outcome in PAGE_TEXT_OUTCOMES else {}


def not_run(site: Site, method: str, detail: str, url: str | None = None) -> dict[str, Any]:
    return result(site, method, url or site.url, time.monotonic(), Verdict('not_run', detail=detail))


@contextmanager
def scoped_environment(values: Mapping[str, str | None]) -> Generator[None]:
    """``os.environ`` with *values* set (None: removed) for the block, restored after it."""
    saved = {name: os.environ.get(name) for name in values}
    try:
        for name, value in values.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        yield
    finally:
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def browser_page(url: str, browser_id: str) -> Page:
    """Page 1 of *url* in a fresh session on *browser_id*, with no profile loaded or saved; the session is stopped
    before the page is classified (the model call is not billed browser time)."""
    browser, reader = plugin(BROWSER_MODULE), plugin(PAGE_MODULE)
    environment = {BROWSER_ENV: browser_id, PROFILE_ENV: None}
    with scoped_environment(environment), browser.browser_session(BROWSER_SESSION_SECONDS) as cdp:
        tab = reader.BrowserTab(cdp)
        tab.open()
        snapshot = tab.load(url)
    return Page(url=snapshot.url, status=snapshot.status, title=snapshot.title, text=snapshot.text,
                html=snapshot.html, jsonld=tuple(snapshot.jsonld))


def browser_row(site: Site, run: Run, method: str, browser_id: str) -> dict[str, Any]:
    started, budget, read, extra = time.monotonic(), run.budget(), Read(), {}
    try:
        page = browser_page(checked_url(site.url), browser_id)
        read = Read(page.url, page.status)
        verdict = classify(site.url, page, site.max_reviews, budget)
        extra = _page_text(page, verdict)
    except row_errors() as error:
        verdict = Verdict('error', detail=_short(error))
    return result(site, method, site.url, started, verdict, budget=budget, read=read, extra=extra)


def signed_rows(site: Site, run: Run) -> list[dict[str, Any]]:
    if run.signed_id is None:
        return [not_run(site, 'signed', NO_SIGNED_BROWSER)]
    return [browser_row(site, run, 'signed', run.signed_id)]


def unsigned_rows(site: Site, run: Run) -> list[dict[str, Any]]:
    return [browser_row(site, run, 'unsigned', UNSIGNED_BROWSER)]


def http_rows(site: Site, run: Run) -> list[dict[str, Any]]:
    started, budget, read, extra = time.monotonic(), run.budget(), Read(), {}
    try:
        refusal = run.robots_refusal(site.url)
        if refusal is not None:
            verdict = Verdict('robots_disallowed', detail=refusal)
        else:
            fetched = fetch(site.url, HTML_ACCEPT, run.agent, MAX_PAGE_BYTES)
            read = Read(fetched.url, fetched.status)
            page = parse_html(fetched.url, fetched.status, fetched.text)
            verdict = classify(site.url, page, site.max_reviews, budget)
            extra = _page_text(page, verdict)
    except row_errors() as error:
        verdict = Verdict('error', detail=_short(error))
    return [result(site, 'http', site.url, started, verdict, budget=budget, read=read, extra=extra)]


def _not_fetched(entry: Structured) -> str:
    why = 'needs a secret' if entry.needs_secret else 'an official API'
    return '; '.join(part for part in (f'{entry.kind}: {why}, not read by this eval', entry.docs, entry.notes) if part)


def feed_row(site: Site, entry: Structured, run: Run) -> dict[str, Any]:
    if entry.kind == 'official_api' or entry.needs_secret:
        return not_run(site, 'feed', _not_fetched(entry), entry.url)
    started, read = time.monotonic(), Read()
    try:
        refusal = run.robots_refusal(entry.url)
        if refusal is not None:
            verdict = Verdict('robots_disallowed', detail=refusal)
        else:
            fetched = fetch(entry.url, FEED_ACCEPT[entry.kind], run.agent, MAX_PAGE_BYTES)
            read = Read(fetched.url, fetched.status)
            verdict = feed_verdict(entry, fetched, site.max_reviews)
    except row_errors() as error:
        verdict = Verdict('error', detail=_short(error))
    return result(site, 'feed', entry.url, started, verdict, read=read)


def feed_rows(site: Site, run: Run) -> list[dict[str, Any]]:
    return [feed_row(site, entry, run) for entry in site.structured]


# ── web search: Amazon Bedrock (e) and AgentCore (f) ─────────────────────────────────────────────────────────────


def _collapsed(text: str) -> str:
    return ' '.join(text.split())


def verbatim(bodies: Sequence[str], page_texts: Sequence[str]) -> str | None:
    """Whether a web-search row's review bodies are on the page this run read of the same site: each body's first
    ``VERBATIM_KEY_CHARS`` (whitespace collapsed, lower-cased) looked for in every page text. ``verbatim``: all of
    them; ``partial``: some; ``paraphrase_risk``: none; ``unverifiable``: no browser or http row read the page."""
    if not bodies:
        return None
    if not page_texts:
        return 'unverifiable'
    texts = [_collapsed(text).lower() for text in page_texts]
    found = sum(1 for body in bodies if any(_collapsed(body).lower()[:VERBATIM_KEY_CHARS] in text for text in texts))
    if found == len(bodies):
        return 'verbatim'
    return 'partial' if found else 'paraphrase_risk'


def web_search_row(site: Site, run: Run, model: str) -> dict[str, Any]:
    """The site's page as *model* reads it from the Bedrock web search cache (web_search_reader.py, one request)."""
    method, started = f'{BEDROCK_WEB_SEARCH}:{model}', time.monotonic()
    extra: dict[str, Any] = {'model': model}
    try:
        reader = plugin(WEB_SEARCH_MODULE)
        cap = min(site.max_reviews, reader.MAX_WEB_SEARCH_REVIEWS)
        read = reader.read_web_search_target(checked_url(site.url), model, cap, region=run.region,
                                             credentials=run.credentials(), post=run.post or post_json)
    except row_errors() as error:
        return result(site, method, site.url, started, Verdict('error', detail=_short(error)), extra=extra)
    extra.update(model=read.model, opened_urls=list(read.opened_urls), cited_urls=list(read.cited_urls),
                 dropped=read.dropped)
    if not read.fetched:
        verdict = Verdict('error', extraction='web_search', detail=f'fetch_failed: {read.reason or "no reason given"}')
    else:
        verdict = _with_reviews('web_search', read.reviews, cap)
        extra[BODIES_KEY] = [review.text for review in read.reviews[:cap]]
    return result(site, method, site.url, started, verdict, extra=extra)


def web_search_rows(site: Site, run: Run) -> list[dict[str, Any]]:
    return [web_search_row(site, run, model) for model in run.web_search_models]


def agentcore_search_url(region: str) -> str:
    """InvokeWebSearch's REST endpoint (botocore's bedrock-agentcore model: ``POST /web-search/{webSearchId}/invoke``)."""
    return f'https://bedrock-agentcore.{region}.amazonaws.com/web-search/{WEB_SEARCH_TOOL}/invoke'


def search_request(site: Site) -> dict[str, Any]:
    """``"<subject> reviews"``, ``AGENTCORE_SEARCH_RESULTS`` results at most, held to the site's domain."""
    domain = plugin(WEB_SEARCH_MODULE).site_domain(site.url)
    return {'searchQuery': f'{site.subject} reviews'[:MAX_QUERY_CHARS], 'maxResults': AGENTCORE_SEARCH_RESULTS,
            'filters': {'domainFilter': {'include': [domain]}}}


def invoke_web_search(site: Site, run: Run) -> list[dict[str, Any]]:
    """One SigV4-signed InvokeWebSearch (service ``bedrock-agentcore``): its results that carry text."""
    url = agentcore_search_url(run.region)
    data = json.dumps(search_request(site)).encode()
    request = AWSRequest(method='POST', url=url, data=data, headers={'Content-Type': 'application/json'})
    SigV4Auth(run.credentials(), AGENTCORE_SIGNING_SERVICE, run.region).add_auth(request)
    status, raw = (run.post or post_json)(url, data, dict(request.headers.items()), AGENTCORE_SEARCH_TIMEOUT_SECONDS)
    if status >= 400:
        raise AgentCoreSearchError(f'HTTP {status}: {_collapsed(raw.decode("utf-8", "replace"))[:160]}')
    try:
        answer = json.loads(raw)
    except ValueError:
        raise AgentCoreSearchError('an unreadable answer') from None
    results = answer.get('results') if isinstance(answer, dict) else None
    if not isinstance(results, list):
        raise AgentCoreSearchError('an answer without results')
    return [item for item in results if isinstance(item, dict) and isinstance(item.get('text'), str)]


def _shows_rating(snippet: str, rating: float) -> bool:
    """Whether *snippet* shows *rating* as a rating out of 5 ("4/5", "4.0 out of 5", "4 stars")."""
    values = '|'.join(re.escape(value) for value in {f'{rating:g}', f'{rating:.1f}'})
    pattern = rf'(?<![\d.])(?:{values})\s*(?:/\s*5\b|out of 5\b|-?stars?\b|\u2605)'
    return re.search(pattern, snippet, re.IGNORECASE) is not None


def _shows_date(snippet: str, iso: str) -> bool:
    """Whether *snippet* shows the date *iso* (as written, or as "October 1, 2026" / "Oct 1, 2026" / "1 October 2026")."""
    day = datetime.fromisoformat(iso)
    month = _MONTHS[day.month - 1]
    spellings = {iso, f'{month} {day.day}, {day.year}', f'{month[:3]} {day.day}, {day.year}',
                 f'{day.day} {month} {day.year}', f'{day.day} {month[:3]} {day.year}'}
    lowered = snippet.lower()
    return any(spelling.lower() in lowered for spelling in spellings)


def _from_snippet(review: Any, snippet: str) -> Any:
    """*review* with only what *snippet* shows: its rating and date when written there, never an author."""
    rating = review.rating if review.rating is not None and _shows_rating(snippet, review.rating) else None
    published = review.date if review.date is not None and _shows_date(snippet, review.date) else None
    return replace(review, rating=rating, date=published, author=None)


def snippet_verdict(results: Sequence[dict[str, Any]], cap: int,
                    budget: ModelBudget | None) -> tuple[Verdict, dict[str, Any]]:
    """The reviews the model finds in the search results' SNIPPETS, each kept only when its body (whitespace
    collapsed) is in one snippet; ``excerpt_only`` when that snippet is a cut passage (an ellipsis at its start or
    end), so the review may go on beyond what the search returned. Each kept review records its result's url, title
    and publication time."""
    extra: dict[str, Any] = {'sources': [], 'dropped': 0}
    if not results:
        return Verdict('no_reviews', extraction='snippets', detail='the search returned no result'), extra
    if budget is None:
        detail = f'{len(results)} results; --no-model left the snippets unread'
        return Verdict('unextracted', extraction='snippets', detail=detail), extra
    snippets = [_collapsed(item['text']) for item in results]
    kept: list[Any] = []
    for review in plugin(EXTRACT_MODULE).llm_reviews('\n\n---\n\n'.join(snippets), budget):
        body = _collapsed(review.text)
        index = next((i for i, snippet in enumerate(snippets) if body and body in snippet), None)
        if index is None:
            extra['dropped'] += 1
            continue
        if len(kept) >= cap:
            break
        snippet, source = snippets[index], results[index]
        kept.append(_from_snippet(review, snippet))
        extra['sources'].append({
            'url': source.get('url'), 'title': source.get('title'), 'published_date': source.get('publishedAt'),
            'excerpt_only': snippet.startswith(_ELLIPSES) or snippet.endswith(_ELLIPSES),
        })
    extra['excerpt_only'] = any(source['excerpt_only'] for source in extra['sources']) if kept else None
    extra[BODIES_KEY] = [review.text for review in kept]
    return _with_reviews('snippets', kept, cap), extra


def agentcore_search_rows(site: Site, run: Run) -> list[dict[str, Any]]:
    if run.region not in AGENTCORE_SEARCH_REGIONS:
        regions = ', '.join(sorted(AGENTCORE_SEARCH_REGIONS))
        return [not_run(site, AGENTCORE_WEB_SEARCH, f'AgentCore Web Search is not offered in {run.region} ({regions})')]
    started, budget = time.monotonic(), run.budget()
    try:
        verdict, extra = snippet_verdict(invoke_web_search(site, run), site.max_reviews, budget)
    except row_errors() as error:
        verdict, extra = Verdict('error', detail=_short(error)), {}
    return [result(site, AGENTCORE_WEB_SEARCH, site.url, started, verdict, budget=budget, extra=extra)]


# ── the method registry ─────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Cost:
    """What one site may cost a method at most: browser sessions, HTTP GETs (their URLs), Responses API requests,
    InvokeWebSearch requests, pages (or snippet sets) the model may read."""

    sessions: int = 0
    fetches: tuple[str, ...] = ()
    responses: int = 0
    searches: int = 0
    pages: int = 0
    note: str = ''


@dataclass(frozen=True)
class Method:
    name: str
    rows: Callable[[Site, Run], list[dict[str, Any]]]
    cost: Callable[[Site, Run], Cost]


def _feed_cost(site: Site, _run: Run) -> Cost:
    fetched = tuple(entry.url for entry in site.structured if entry.kind != 'official_api' and not entry.needs_secret)
    skipped = len(site.structured) - len(fetched)
    return Cost(fetches=fetched, note=f'{skipped} not run' if skipped else '')


def _agentcore_cost(_site: Site, run: Run) -> Cost:
    if run.region not in AGENTCORE_SEARCH_REGIONS:
        return Cost(note=f'not run ({run.region})')
    return Cost(searches=1, pages=1)


METHODS: Final = {method.name: method for method in (
    Method('signed', signed_rows, lambda _site, _run: Cost(sessions=1, pages=1)),
    Method('unsigned', unsigned_rows, lambda _site, _run: Cost(sessions=1, pages=1)),
    Method('http', http_rows, lambda site, _run: Cost(fetches=(site.url,), pages=1)),
    Method('feed', feed_rows, _feed_cost),
    Method(BEDROCK_WEB_SEARCH, web_search_rows, lambda _site, run: Cost(responses=len(run.web_search_models))),
    Method(AGENTCORE_WEB_SEARCH, agentcore_search_rows, _agentcore_cost),
)}
DEFAULT_METHODS: Final = ('signed', 'unsigned', 'http', 'feed', BEDROCK_WEB_SEARCH, AGENTCORE_WEB_SEARCH)


def parse_methods(value: str) -> list[Method]:
    """``--methods``: comma-separated names of ``METHODS``, each once, in the order given."""
    names = list(dict.fromkeys(part.strip() for part in value.split(',') if part.strip()))
    unknown = [name for name in names if name not in METHODS]
    if unknown or not names:
        raise SetupError(f'--methods: unknown method {", ".join(unknown) or "(none given)"}; '
                         f'choose from {", ".join(METHODS)}')
    return [METHODS[name] for name in names]


# ── the signed browser ──────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SignedBrowser:
    browser_id: str | None
    signing_enabled: bool | None


#: The AWS services the eval reads (every call on them is a read).
AwsService = Literal['sts', 'lambda', 'bedrock-agentcore-control']


def aws_client(service: AwsService, region: str) -> Any:
    import boto3

    return boto3.client(service, region_name=region)


def ingestor_function_name(prefix: str, account: str, region: str) -> str:
    """``[<prefix>-]voc-ingestor-web_reviews-<account>-<region>`` (lib/utils/naming.ts ``uniqueName``)."""
    return f'{f"{prefix}-" if prefix else ""}{INGESTOR_BASE_NAME}-{account}-{region}'


def signing_enabled(region: str, browser_id: str) -> bool | None:
    """GetBrowser's ``browserSigning.enabled``, best effort (None when it cannot be read)."""
    try:
        answer = aws_client('bedrock-agentcore-control', region).get_browser(browserId=browser_id)
    except (ClientError, BotoCoreError, AttributeError):
        return None
    enabled = (answer.get('browserSigning') or {}).get('enabled')
    return enabled if isinstance(enabled, bool) else None


def signed_browser(region: str, prefix: str, browser_id: str | None) -> SignedBrowser:
    """``browser_id``, else the deployed ingestor's ``BROWSER_IDENTIFIER`` (None: the deployment has none)."""
    if browser_id:
        return SignedBrowser(browser_id, signing_enabled(region, browser_id))
    name = '(unknown)'
    try:
        account = aws_client('sts', region).get_caller_identity()['Account']
        name = ingestor_function_name(prefix, account, region)
        config = aws_client('lambda', region).get_function_configuration(FunctionName=name)
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'ResourceNotFoundException':
            raise SetupError(f'the Lambda {name} is not in {region}: check --prefix and --region, or pass '
                             '--browser-id') from None
        raise SetupError(f'cannot read the Lambda {name}: {_short(error)}') from None
    except BotoCoreError as error:
        raise SetupError(f'cannot read the Lambda {name}: {_short(error)}') from None
    found = ((config.get('Environment') or {}).get('Variables') or {}).get(BROWSER_ENV)
    if not isinstance(found, str) or not found:
        return SignedBrowser(None, None)
    return SignedBrowser(found, signing_enabled(region, found))


# ── the report ──────────────────────────────────────────────────────────────────────────────────────────────────


def _cell(value: object) -> str:
    text = NO_COMPARISON if value is None or value == '' else str(value)
    return ' '.join(text.split()).replace('|', '\\|')


def _table(header: Sequence[str], rows: Iterable[Sequence[object]]) -> list[str]:
    return [f'| {" | ".join(header)} |', f'|{"---|" * len(header)}',
            *(f'| {" | ".join(_cell(value) for value in row)} |' for row in rows)]


def columns(rows: Sequence[dict[str, Any]], methods: Sequence[str]) -> list[str]:
    """The pivot's columns: each method's row names in order (``bedrock_web_search`` has one per model)."""
    names = list(dict.fromkeys(row['method'] for row in rows))
    found: list[str] = []
    for method in methods:
        own = [name for name in names if name == method or name.startswith(f'{method}:')]
        found += own or [method]
    return found


def _pivot_cell(row: Mapping[str, Any]) -> str:
    return f'{row["outcome"]} ({row["verbatim"]})' if row.get('verbatim') else row['outcome']


def _pivot(rows: Sequence[dict[str, Any]], names: Sequence[str]) -> list[list[str]]:
    """One line per site, one cell per column: its outcome(s) (a site with several feed entries has several), a
    web-search row's ``verbatim`` check after it."""
    sites = list(dict.fromkeys((row['site_id'], row['site']) for row in rows))
    return [[f'{name} ({site_id})', *(' / '.join(_pivot_cell(row) for row in rows
                                                 if row['site_id'] == site_id and row['method'] == column)
                                      for column in names)]
            for site_id, name in sites]


def report_markdown(report: Mapping[str, Any]) -> str:
    run, rows = report['run'], report['results']
    browser = run['browser']
    model = 'off (--no-model)' if run['no_model'] else f'at most {run["model_calls_per_page"]} call(s) per page'
    names = columns(rows, run['methods'])
    lines = [
        '# Web Reviews site eval', '',
        (f'- Started {run["started_at"]} in {run["region"]} (prefix {run["prefix"] or "none"}), '
         f'sites from {run["sites_file"]}'),
        f'- Methods: {", ".join(run["methods"])}',
        f'- Signed browser: {browser["signed_id"] or "none"} (signing enabled: {_cell(browser["signing_enabled"])})',
        f'- Model extraction: {model}', '',
        '## Results', '',
        *_table(('Site', 'Method', 'Outcome', 'Reviews', 'Extraction', 'Seconds', 'Expect', 'vs expect'),
                ((row['site'], row['method'], row['outcome'], row['reviews'], row['extraction'],
                  f'{row["seconds"]:.1f}', row['expect'], row['vs_expect']) for row in rows)),
        '', '## By site', '',
        *_table(('Site', *names), _pivot(rows, names)),
    ]
    details = [f'- {row["site"]} / {row["method"]}: {_cell(row["detail"])}' for row in rows if row['detail']]
    if details:
        lines += ['', '## Details', '', *details]
    return '\n'.join(lines) + '\n'


def write_report(out: Path, report: Mapping[str, Any]) -> str:
    out.mkdir(parents=True, exist_ok=True)
    (out / 'report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    markdown = report_markdown(report)
    (out / 'report.md').write_text(markdown, encoding='utf-8')
    return markdown


# ── the dry run ─────────────────────────────────────────────────────────────────────────────────────────────────


def _plan_cell(cost: Cost) -> str:
    parts = [f'{cost.sessions} session'] if cost.sessions else []
    if cost.fetches:
        parts.append(f'robots.txt + {len(cost.fetches)} GET')
    if cost.responses:
        parts.append(f'{cost.responses} Responses request{"s" if cost.responses > 1 else ""}')
    if cost.searches:
        parts.append(f'{cost.searches} InvokeWebSearch')
    if cost.note:
        parts.append(cost.note)
    return ', '.join(parts) or NO_COMPARISON


def dry_run_plan(sites: Sequence[Site], methods: Sequence[Method], args: argparse.Namespace, run: Run) -> str:
    """What a real run would do and spend at most; nothing is called."""
    costs = [method.cost(site, run) for site in sites for method in methods]
    fetches = [url for cost in costs for url in cost.fetches]
    origins = {f'{urlsplit(url).scheme}://{urlsplit(url).netloc}' for url in fetches}
    model_calls = 0 if args.no_model else sum(cost.pages for cost in costs) * args.model_calls
    if args.browser_id:
        source = f'--browser-id {args.browser_id}'
    else:
        name = ingestor_function_name(args.prefix, '<account>', args.region)
        source = f'{BROWSER_ENV} of the Lambda {name} (account from sts get_caller_identity)'
    model = (f'{args.model_calls} call(s) per page on {args.model_id or "the enrichment surface default"}'
             if not args.no_model else 'off (--no-model)')
    lines = [
        '# Web Reviews site eval: dry run (no AWS call, no network request)', '',
        f'- Sites: {len(sites)} from {args.sites}; methods: {", ".join(method.name for method in methods)}',
        f'- Region {args.region}, prefix {args.prefix or "none"}',
        f'- Signed browser: {source}' if any(method.name == 'signed' for method in methods) else '- No signed method',
        f'- User-Agent of http / feed: {run.agent}',
        f'- Model extraction: {model}',
        f'- Web search models ({BEDROCK_WEB_SEARCH}): {", ".join(run.web_search_models)}',
        '',
        *_table(('Site', 'Subject', 'Vendor', 'Expect', 'Baseline', *(method.name for method in methods)),
                ([f'{site.site} ({site.id})', site.subject, site.vendor, site.expect, site.baseline,
                  *(_plan_cell(method.cost(site, run)) for method in methods)] for site in sites)),
        '',
        (f'At most: {sum(cost.sessions for cost in costs)} browser sessions ({BROWSER_SESSION_SECONDS} s each), '
         f'{model_calls} model calls, {len(fetches) + len(origins)} HTTP GETs ({len(origins)} robots.txt; the shared '
         f'fetcher retries a 429 / 5xx up to 3 times), {sum(cost.responses for cost in costs)} Responses requests, '
         f'{sum(cost.searches for cost in costs)} InvokeWebSearch requests.'),
    ]
    return '\n'.join(lines)


# ── main ────────────────────────────────────────────────────────────────────────────────────────────────────────


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=(__doc__ or '').split('\n\n')[0])
    parser.add_argument('--region', required=True, help='the deployment region (sessions and model calls run there)')
    parser.add_argument('--prefix', default='', help='the deployment prefix, if any')
    parser.add_argument('--sites', default=str(DEFAULT_SITES), help='the fixture (default: %(default)s)')
    parser.add_argument('--only', default='', help='comma-separated site ids')
    parser.add_argument('--methods', default=','.join(DEFAULT_METHODS), help=f'comma-separated: {", ".join(METHODS)}')
    parser.add_argument('--browser-id', help="the signed browser's id (default: the deployed ingestor's)")
    parser.add_argument('--no-model', action='store_true', help='no model extraction (JSON-LD only)')
    parser.add_argument('--model-id', help='the model of the extraction (default: the enrichment surface default)')
    parser.add_argument('--model-calls', type=int, default=1, help='Converse calls per page at most (default: 1)')
    parser.add_argument('--web-search-models', default=','.join(DEFAULT_WEB_SEARCH_MODELS),
                        help=f'the models of {BEDROCK_WEB_SEARCH}, comma-separated (default: %(default)s)')
    parser.add_argument('--out', help='the report directory (default: web-reviews-eval/<UTC time>)')
    parser.add_argument('--dry-run', action='store_true', help='print the plan; no AWS call, no network request')
    return parser


def _progress(row: Mapping[str, Any]) -> None:
    print(f'{row["site_id"]} / {row["method"]}: {row["outcome"]} ({row["reviews"]} reviews, {row["seconds"]} s)',
          file=sys.stderr)


def run_eval(sites: Sequence[Site], methods: Sequence[Method], run: Run) -> list[dict[str, Any]]:
    """Every site through every method; after a site's rows, its web-search rows are checked against the page text
    its other rows read (``verbatim``), and that text is dropped."""
    rows: list[dict[str, Any]] = []
    for site in sites:
        site_rows: list[dict[str, Any]] = []
        for method in methods:
            for row in method.rows(site, run):
                _progress(row)
                site_rows.append(row)
        texts = [text for row in site_rows if (text := row.pop(PAGE_TEXT_KEY, None)) is not None]
        for row in site_rows:
            bodies = row.pop(BODIES_KEY, None)
            if bodies is not None:
                row['verbatim'] = verbatim(bodies, texts)
        rows += site_rows
    return rows


def web_search_models(value: str) -> tuple[str, ...]:
    models = tuple(dict.fromkeys(part.strip() for part in value.split(',') if part.strip()))
    bad = [model for model in models if not _MODEL_ID_RE.match(model)]
    if bad or not models:
        raise SetupError(f'--web-search-models: not a model id: {", ".join(bad) or "(none given)"}')
    return models


def _setup(args: argparse.Namespace) -> tuple[list[Site], list[Method], Run]:
    methods = parse_methods(args.methods)
    if args.model_calls < 1:
        raise SetupError('--model-calls must be at least 1 (use --no-model for none)')
    sites = selected_sites(load_fixture(Path(args.sites)), args.only)
    run = Run(agent=user_agent(package_version()), signed_id=None, complete=None, model_calls=args.model_calls,
              region=args.region, web_search_models=web_search_models(args.web_search_models))
    return sites, methods, run


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        sites, methods, run = _setup(args)
    except SetupError as error:
        print(f'error: {error}', file=sys.stderr)
        return 2
    if args.dry_run:
        print(dry_run_plan(sites, methods, args, run))
        return 0
    started = datetime.now(UTC)
    environment = {'AWS_REGION': args.region, 'AWS_DEFAULT_REGION': args.region, BROWSER_ENV: None, PROFILE_ENV: None}
    with scoped_environment(environment):
        try:
            browser = (signed_browser(args.region, args.prefix, args.browser_id)
                       if 'signed' in [method.name for method in methods] else SignedBrowser(None, None))
        except SetupError as error:
            print(f'error: {error}', file=sys.stderr)
            return 2
        run.signed_id = browser.browser_id
        run.complete = None if args.no_model else model_completion(args.model_id)
        rows = run_eval(sites, methods, run)
    report = {
        'run': {
            'started_at': started.isoformat(timespec='seconds'), 'region': args.region, 'prefix': args.prefix,
            'sites_file': args.sites, 'methods': [method.name for method in methods],
            'browser': {'signed_id': browser.browser_id, 'signing_enabled': browser.signing_enabled},
            'model_calls_per_page': args.model_calls, 'no_model': args.no_model, 'model_id': args.model_id,
            'web_search_models': list(run.web_search_models), 'user_agent': run.agent,
        },
        'results': rows,
    }
    out = Path(args.out) if args.out else Path.cwd() / 'web-reviews-eval' / started.strftime('%Y%m%dT%H%M%SZ')
    print(write_report(out, report))
    print(f'report: {out / "report.json"}, {out / "report.md"}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
