"""What the mutation run of page_reader.py found that the browser-layer tests could not see.

Those tests drive a tab whose sleeps are no-ops and whose clock is real, so the settle
loop's bounds (the 3 s first wait, the 1.5 s poll, the 25 s ceiling, the 500-character
"settled" floor, two equal reads in a row) were never observed. They never looked at the
exact DevTools commands either (the tab's target, ``flatten``, ``awaitPromise`` /
``returnByValue``, the 30 s and 60 s timeouts, the snapshot call's arguments), never read a
refusal's exact message, never sat on a cap's boundary (160,000 text characters, 50 JSON-LD
blocks, 400,000 per block, 1,000,000 in total), and checked the next-page words only for two
of fifteen. Every expectation below is a literal.
"""
import dataclasses
import json
from typing import Any
from unittest.mock import MagicMock, call

import pytest
from cdp_client import CdpError
from page_reader import (
    NEXT_WORDS,
    PROGRESS_JS,
    SNAPSHOT_JS,
    BrowserTab,
    PageLoadError,
    PageSnapshot,
    _snapshot_from,
    page_parameter_successor,
)
from test_web_reviews_browser import run_node

PAGE = 'https://reviews.example.com/r'
SECOND = 'https://reviews.example.com/r?page=2'


class ScriptedBrowser:
    """A DevTools peer that answers each command from a script and records every call.

    ``progress`` holds the raw values PROGRESS_JS returns, one per poll (exhaustible, so a
    loop that polls once too often fails); ``snapshot`` is what SNAPSHOT_JS returns.
    """

    def __init__(self, *, progress: list[object] | None = None, snapshot: object = None,
                 navigate: dict[str, Any] | None = None, location: object = PAGE,
                 attach: dict[str, Any] | None = None):
        self.progress = list(progress or [])
        self.snapshot = json.dumps({'url': PAGE}) if snapshot is None else snapshot
        self.navigate = navigate or {'frameId': 'f-1'}
        self.location = location
        self.attach = {'sessionId': 'tab-7'} if attach is None else attach
        self.failing: set[str] = set()
        self.cdp = MagicMock()
        self.cdp.call.side_effect = self._answer

    def _answer(self, method: str, params: dict[str, Any] | None = None, **_options: object) -> dict[str, Any]:
        if method in self.failing:
            raise CdpError(f'{method} timed out')
        answers: dict[str, Any] = {
            'Target.createTarget': {'targetId': 't-7'}, 'Target.attachToTarget': self.attach,
            'Page.navigate': self.navigate,
        }
        if method != 'Runtime.evaluate':
            return answers.get(method, {})
        expression = (params or {})['expression']
        if expression == PROGRESS_JS:
            return {'result': {'value': self.progress.pop(0)}}
        if expression == 'location.href':
            return {'result': {'value': self.location}}
        return {'result': {'value': self.snapshot}}

    def tab(self, clock: list[float] | None = None) -> tuple[BrowserTab, list[float]]:
        """An opened tab and the list its sleeps are recorded in."""
        sleeps: list[float] = []
        ticks = iter(clock or [0.0, 1.0])
        tab = BrowserTab(self.cdp, sleep=sleeps.append, clock=lambda: next(ticks))
        tab.open()
        self.cdp.call.reset_mock()
        return tab, sleeps


def progress(state: str, length: int) -> str:
    return json.dumps([state, length])


def refusal(action: Any) -> str:
    with pytest.raises(PageLoadError) as caught:
        action()
    return str(caught.value)


class TestTheTabSpeaksExactDevTools:
    def test_open_creates_a_blank_target_attaches_flat_and_enables_the_page(self):
        browser = ScriptedBrowser()
        BrowserTab(browser.cdp).open()
        assert browser.cdp.call.call_args_list == [
            call('Target.createTarget', {'url': 'about:blank'}),
            call('Target.attachToTarget', {'targetId': 't-7', 'flatten': True}),
            call('Page.enable', None, session_id='tab-7', timeout=30.0),
        ]

    def test_an_unopened_tab_opens_itself_before_its_first_command(self):
        browser = ScriptedBrowser(navigate={'errorText': 'net::ERR_HTTP_RESPONSE_CODE_FAILURE'})
        BrowserTab(browser.cdp, sleep=lambda _s: None).load(PAGE)
        assert [entry.args[0] for entry in browser.cdp.call.call_args_list[:4]] == [
            'Target.createTarget', 'Target.attachToTarget', 'Page.enable', 'Page.navigate']

    def test_a_tab_without_a_session_id_is_refused(self):
        browser = ScriptedBrowser(attach={'sessionId': 7})
        assert refusal(BrowserTab(browser.cdp).open) == 'the browser tab could not be opened'

    def test_navigate_and_evaluate_carry_their_session_and_timeouts(self):
        browser = ScriptedBrowser(progress=[progress('complete', 600), progress('complete', 600)])
        tab, _sleeps = browser.tab(clock=[0.0, 1.0, 2.0])
        tab.load(PAGE)
        assert browser.cdp.call.call_args_list[:2] == [
            call('Page.navigate', {'url': PAGE}, session_id='tab-7', timeout=30.0),
            call('Runtime.evaluate', {'expression': PROGRESS_JS, 'awaitPromise': True, 'returnByValue': True},
                 session_id='tab-7', timeout=60.0),
        ]

    def test_the_snapshot_is_called_with_its_mode_target_words_and_limits(self):
        browser = ScriptedBrowser(snapshot=json.dumps({'url': SECOND}))
        tab, _sleeps = browser.tab()
        tab.fetch(SECOND)
        expression = browser.cdp.call.call_args_list[-1].args[1]['expression']
        assert expression == (
            f'({SNAPSHOT_JS})("fetch", "{SECOND}", {json.dumps(list(NEXT_WORDS))}, '
            '{"jsonldChars": 400000, "jsonldBlocks": 50, "jsonldTotalChars": 1000000, '
            '"htmlChars": 20000, "textChars": 160000})')


class TestEveryRefusalNamesItsCause:
    def test_a_navigation_the_browser_does_not_answer(self):
        browser = ScriptedBrowser()
        browser.failing.add('Page.navigate')
        tab, _sleeps = browser.tab()
        assert refusal(lambda: tab.load(PAGE)) == 'the page did not load'

    def test_a_navigation_error_is_named_in_at_most_sixty_characters(self):
        browser = ScriptedBrowser(navigate={'errorText': 'net::ERR_' + 'X' * 70})
        tab, _sleeps = browser.tab()
        assert refusal(lambda: tab.load(PAGE)) == 'the page did not load (net::ERR_' + 'X' * 51 + ')'

    def test_an_evaluation_the_browser_does_not_answer(self):
        browser = ScriptedBrowser()
        browser.failing.add('Runtime.evaluate')
        tab, _sleeps = browser.tab()
        assert refusal(lambda: tab.load(PAGE)) == 'the page did not answer'

    @pytest.mark.parametrize('raw', [None, 'garbage', '[]', '{"error": "TypeError"}'])
    def test_an_unreadable_snapshot(self, raw):
        assert refusal(lambda: _snapshot_from(raw, PAGE)) == 'the page could not be read'


class TestTheSettleLoop:
    def test_two_equal_reads_of_a_complete_page_end_the_wait(self):
        browser = ScriptedBrowser(progress=[progress('complete', 600), progress('complete', 600)])
        tab, sleeps = browser.tab(clock=[100.0, 101.0, 102.5])
        tab.load(PAGE)
        assert (sleeps, browser.progress) == ([3.0, 1.5], [])

    def test_exactly_five_hundred_characters_is_settled(self):
        browser = ScriptedBrowser(progress=[progress('complete', 500), progress('complete', 500)])
        tab, sleeps = browser.tab(clock=[0.0, 1.0, 2.0])
        tab.load(PAGE)
        assert (sleeps, browser.progress) == ([3.0, 1.5], [])

    def test_a_page_still_loading_is_polled_until_the_ceiling(self):
        browser = ScriptedBrowser(progress=[progress('interactive', 600), progress('interactive', 600)])
        tab, sleeps = browser.tab(clock=[0.0, 1.0, 2.0, 25.0])
        tab.load(PAGE)
        assert (sleeps, browser.progress) == ([3.0, 1.5, 1.5], [])

    def test_the_ceiling_is_twenty_five_seconds_after_the_start(self):
        browser = ScriptedBrowser(progress=[progress('loading', 0)])
        tab, sleeps = browser.tab(clock=[100.0, 124.9, 125.0])
        tab.load(PAGE)
        assert (sleeps, browser.progress) == ([3.0, 1.5], [])

    def test_an_http_error_page_waits_three_seconds_and_is_not_polled(self):
        browser = ScriptedBrowser(navigate={'errorText': 'net::ERR_HTTP_RESPONSE_CODE_FAILURE'})
        tab, sleeps = browser.tab()
        assert tab.load(PAGE).url == PAGE
        assert sleeps == [3.0]


class TestProgressIsReadOrNothing:
    @pytest.mark.parametrize('raw', [7, 'not json', '["complete", "600"]', '[5, 600]', '[1, 2, 3]'])
    def test_an_unreadable_answer_is_an_empty_state_and_no_text(self, raw):
        tab, _sleeps = ScriptedBrowser(progress=[raw]).tab()
        assert tab._progress() == ('', 0)

    def test_a_readable_answer_is_returned_as_is(self):
        tab, _sleeps = ScriptedBrowser(progress=[progress('complete', 600)]).tab()
        assert tab._progress() == ('complete', 600)


class TestTheSnapshotFields:
    def test_every_field_is_taken_from_the_page(self):
        raw = json.dumps({'url': SECOND, 'status': 404, 'title': 'Gone', 'text': 'Not here', 'html': '<p>',
                          'ld': ['{"a": 1}'], 'next': 'https://reviews.example.com/r?page=3'})
        assert _snapshot_from(raw, PAGE) == PageSnapshot(
            url=SECOND, status=404, title='Gone', text='Not here', html='<p>', jsonld=('{"a": 1}',),
            next_url='https://reviews.example.com/r?page=3')

    def test_missing_fields_fall_back_to_the_requested_url_and_empties(self):
        assert _snapshot_from('{}', PAGE) == PageSnapshot(
            url=PAGE, status=0, title='', text='', html='', jsonld=(), next_url=None)

    @pytest.mark.parametrize(('status', 'nxt'), [('200', ''), (None, 7)])
    def test_a_status_that_is_not_a_number_and_an_empty_or_odd_next_are_dropped(self, status, nxt):
        snapshot = _snapshot_from(json.dumps({'status': status, 'next': nxt}), PAGE)
        assert (snapshot.status, snapshot.next_url) == (0, None)

    def test_a_snapshot_is_immutable(self):
        snapshot = _snapshot_from('{}', PAGE)
        with pytest.raises(dataclasses.FrozenInstanceError):
            snapshot.__setattr__('status', 500)


class TestTheCapsSitOnTheirBoundaries:
    def test_text_is_cut_at_a_hundred_and_sixty_thousand_and_html_at_twenty_thousand(self):
        snapshot = _snapshot_from(json.dumps({'text': 't' * 160001, 'html': 'h' * 20001}), PAGE)
        assert (len(snapshot.text), len(snapshot.html)) == (160000, 20000)

    def test_fifty_json_ld_blocks_are_kept(self):
        snapshot = _snapshot_from(json.dumps({'ld': [f'{{"n": {n}}}' for n in range(51)]}), PAGE)
        assert (len(snapshot.jsonld), snapshot.jsonld[-1]) == (50, '{"n": 49}')

    def test_a_block_is_cut_at_four_hundred_thousand(self):
        snapshot = _snapshot_from(json.dumps({'ld': ['b' * 400001]}), PAGE)
        assert [len(block) for block in snapshot.jsonld] == [400000]

    def test_exactly_one_million_in_total_is_kept_and_one_more_is_not(self):
        snapshot = _snapshot_from(json.dumps({'ld': ['a' * 400000, 'b' * 400000, 'c' * 200000, 'd']}), PAGE)
        assert [len(block) for block in snapshot.jsonld] == [400000, 400000, 200000]

    def test_a_block_past_the_total_is_skipped_and_a_later_one_that_fits_is_kept(self):
        snapshot = _snapshot_from(json.dumps({'ld': ['a' * 400000, 'b' * 400000, 'c' * 300000, '{"n": 1}']}), PAGE)
        assert [len(block) for block in snapshot.jsonld] == [400000, 400000, 8]

    def test_json_ld_that_is_not_a_list_is_none(self):
        assert _snapshot_from(json.dumps({'ld': '{"a": 1}'}), PAGE).jsonld == ()


class TestThePageParameter:
    def test_pg_is_a_page_parameter(self):
        assert page_parameter_successor('https://a.example/r?pg=4') == 'https://a.example/r?pg=5'

    def test_blank_parameters_are_kept(self):
        assert page_parameter_successor('https://a.example/r?q=&page=1') == 'https://a.example/r?q=&page=2'


#: Runs SNAPSHOT_JS in node once per link label, on a fake page whose only link carries that label.
NEXT_WORD_HARNESS = """
const labels = JSON.parse(process.argv[1]);
globalThis.location = { href: 'https://reviews.example.com/r' };
const snapshot = (__SNAPSHOT_JS__);
(async () => {
  const found = [];
  for (const [attribute, label] of labels) {
    const link = { textContent: attribute === 'text' ? label : '',
                   getAttribute: (name) => (name === 'href' ? '/r?page=2' : name === attribute ? label : null) };
    globalThis.document = { title: '', body: { innerText: '' }, documentElement: { outerHTML: '' },
                            querySelector: () => null,
                            querySelectorAll: (selector) => (selector === 'a[href]' ? [link] : []) };
    found.push(JSON.parse(await snapshot('navigate', null, __WORDS__, {})).next);
  }
  process.stdout.write(JSON.stringify(found));
})();
"""

LABELS = [
    ('text', ' Next '), ('text', 'NEXT PAGE'), ('text', 'Siguiente'), ('text', 'Página Siguiente'),
    ('text', 'Próxima'), ('text', 'Suivant'), ('text', 'Page Suivante'), ('text', 'Weiter'),
    ('text', 'Nächste'), ('text', 'Nächste Seite'), ('text', 'Successiva'), ('text', 'Avanti'),
    ('text', 'Volgende'), ('text', '\u203a'), ('aria-label', '\u00bb'), ('text', 'Previous'),
]


def test_every_next_word_is_recognised_in_any_case_and_nothing_else():
    script = NEXT_WORD_HARNESS.replace('__SNAPSHOT_JS__', SNAPSHOT_JS).replace('__WORDS__', json.dumps(list(NEXT_WORDS)))
    assert json.loads(run_node(script, json.dumps(LABELS))) == [SECOND] * 15 + [None]
