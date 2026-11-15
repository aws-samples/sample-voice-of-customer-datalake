"""A run's browser session survives a closed connection once, and a navigation a transient failure once (7.41.00).

* handler: one session serves every target; when its connection closes mid-run (``BrowserConnectionClosed``)
  ONE new session reads the target that was being read and those after it; a second close, or no time left,
  is reported as the session's failure and keeps what was read.
* page_reader: a navigation that fails on the network (``TRANSIENT_NAVIGATION_ERRORS``) or is not answered in
  time is tried once more after ``RETRY_PAUSE_SECONDS``; a closed connection is never turned into a page error.
* cdp_client: a websocket that closes on send or on receive is ``BrowserConnectionClosed`` (still a ``CdpError``).
"""
import json
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from cdp_client import BrowserConnectionClosed, CdpConnection, CdpError
from page_reader import RETRY_PAUSE_SECONDS, TRANSIENT_NAVIGATION_ERRORS, BrowserTab, PageLoadError, PageSnapshot
from test_web_reviews_handler import FakeTab, ingestor, page, target_config

FIRST, SECOND, THIRD = (f'https://www.trustpilot.com/review/site{n}.example' for n in (1, 2, 3))


def review_page(url: str, body: str) -> PageSnapshot:
    return page(url, jsonld=(json.dumps({'@type': 'Review', 'reviewBody': body, 'datePublished': '2026-10-01'}),))


class ClosingTab(FakeTab):
    """A tab whose connection closes on the first load of each URL in *closes_on* (once per listed URL)."""

    def __init__(self, pages: dict[str, PageSnapshot], closes_on: list[str]):
        super().__init__(pages)
        self.closes_on = list(closes_on)
        self.loaded: list[str] = []
        self.closed = False

    def load(self, url: str) -> PageSnapshot:
        self.loaded.append(url)
        if url in self.closes_on:
            self.closes_on.remove(url)
            self.closed = True
            raise BrowserConnectionClosed('Runtime.evaluate: the browser connection closed')
        return super().load(url)

    fetch = load


def three_targets() -> tuple[list[dict[str, str]], dict[str, PageSnapshot]]:
    configs = [target_config(id=f't{n}', app_name=f'Site {n}', url=url) for n, url in enumerate((FIRST, SECOND, THIRD), 1)]
    pages = {url: review_page(url, f'Review of site {n}.') for n, url in enumerate((FIRST, SECOND, THIRD), 1)}
    return configs, pages


def run_with(tab: ClosingTab, configs: list[dict[str, str]], **patches: Any) -> tuple[list[str], list[str], MagicMock]:
    """The run's review texts, its errors, and the browser_session mock (how many sessions it started)."""
    from web_reviews.ingestor import handler

    session = MagicMock()
    with ingestor(configs, tab.pages, session=session) as run, patch.object(handler, 'BrowserTab', return_value=tab), \
            patch.object(handler, 'browser_session', return_value=session) as start:
        for name, value in patches.items():
            setattr(run, name, value)
        texts = [item['text'] for item in run.fetch_new_items()]
    return texts, run.run_errors, start


class TestTheRunReconnectsOnce:
    def test_a_closed_connection_mid_run_is_replaced_and_the_target_read_again(self):
        configs, pages = three_targets()
        tab = ClosingTab(pages, closes_on=[SECOND])
        texts, errors, start = run_with(tab, configs)
        assert texts == ['Review of site 1.', 'Review of site 2.', 'Review of site 3.']
        assert errors == []
        assert start.call_count == 2
        assert tab.loaded == [FIRST, SECOND, SECOND, THIRD]

    def test_a_second_close_is_the_sessions_failure_and_keeps_what_was_read(self):
        configs, pages = three_targets()
        tab = ClosingTab(pages, closes_on=[SECOND, THIRD])
        texts, errors, start = run_with(tab, configs)
        assert texts == ['Review of site 1.', 'Review of site 2.']
        assert errors == ['The browser session failed: Runtime.evaluate: the browser connection closed']
        assert start.call_count == 2

    def test_no_new_session_without_the_time_for_a_page(self):
        configs, pages = three_targets()
        tab = ClosingTab(pages, closes_on=[SECOND])
        # Time for every page until the connection closes; none left after it.
        texts, errors, start = run_with(tab, configs, _has_time=lambda: not tab.closed)
        assert texts == ['Review of site 1.']
        assert errors == ['The browser session failed: Runtime.evaluate: the browser connection closed']
        assert start.call_count == 1


class ScriptedNavigation:
    """A DevTools peer whose ``Page.navigate`` answers come from *answers* in order (an exception is raised)."""

    def __init__(self, answers: list[object]):
        self.answers = list(answers)
        self.navigations = 0
        self.cdp = MagicMock()
        self.cdp.call.side_effect = self._answer

    def _answer(self, method: str, params: dict[str, Any] | None = None, **_options: object) -> dict[str, Any]:
        if method == 'Target.attachToTarget':
            return {'sessionId': 'tab-1'}
        if method == 'Page.navigate':
            self.navigations += 1
            answer = self.answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            assert isinstance(answer, dict)
            return answer
        if method == 'Runtime.evaluate':
            expression = (params or {})['expression']
            if expression.startswith('JSON.stringify([document.readyState'):
                return {'result': {'value': json.dumps(['complete', 600])}}
            if 'scrollBy' in expression:
                return {'result': {'value': json.dumps([True, 900])}}
            return {'result': {'value': json.dumps({'url': 'https://r.example/p', 'status': 200})}}
        return {}

    def tab(self) -> tuple[BrowserTab, list[float]]:
        sleeps: list[float] = []
        tab = BrowserTab(self.cdp, sleep=sleeps.append, clock=lambda: 0.0)
        tab.open()
        return tab, sleeps


class TestANavigationIsTriedOnceMore:
    @pytest.mark.parametrize('error', sorted(TRANSIENT_NAVIGATION_ERRORS))
    def test_after_a_transient_network_error(self, error: str):
        browser = ScriptedNavigation([{'errorText': error}, {'frameId': 'f'}])
        tab, sleeps = browser.tab()
        assert tab.load('https://r.example/p').status == 200
        assert browser.navigations == 2
        assert sleeps[0] == RETRY_PAUSE_SECONDS

    def test_after_a_navigation_the_browser_did_not_answer(self):
        browser = ScriptedNavigation([CdpError('Page.navigate timed out'), {'frameId': 'f'}])
        tab, _sleeps = browser.tab()
        assert tab.load('https://r.example/p').status == 200
        assert browser.navigations == 2

    def test_a_second_failure_is_the_pages_error(self):
        browser = ScriptedNavigation([{'errorText': 'net::ERR_CONNECTION_RESET'}] * 2)
        tab, _sleeps = browser.tab()
        with pytest.raises(PageLoadError, match=r'^the page did not load \(net::ERR_CONNECTION_RESET\)$'):
            tab.load('https://r.example/p')
        assert browser.navigations == 2

    def test_two_unanswered_navigations_are_the_pages_error(self):
        browser = ScriptedNavigation([CdpError('Page.navigate timed out')] * 2)
        tab, _sleeps = browser.tab()
        with pytest.raises(PageLoadError, match=r'^the page did not load$'):
            tab.load('https://r.example/p')

    def test_a_site_that_does_not_exist_is_not_tried_again(self):
        browser = ScriptedNavigation([{'errorText': 'net::ERR_NAME_NOT_RESOLVED'}])
        tab, sleeps = browser.tab()
        with pytest.raises(PageLoadError, match='ERR_NAME_NOT_RESOLVED'):
            tab.load('https://r.example/p')
        assert (browser.navigations, sleeps) == (1, [])

    def test_a_closed_connection_is_not_a_page_error(self):
        browser = ScriptedNavigation([BrowserConnectionClosed('Page.navigate: the browser connection closed')])
        tab, _sleeps = browser.tab()
        with pytest.raises(BrowserConnectionClosed):
            tab.load('https://r.example/p')
        assert browser.navigations == 1

    def test_a_connection_closed_while_reading_the_page_reaches_the_run(self):
        browser = ScriptedNavigation([{'frameId': 'f'}])
        tab, _sleeps = browser.tab()
        browser.cdp.call.side_effect = BrowserConnectionClosed('Runtime.evaluate: the browser connection closed')
        with pytest.raises(BrowserConnectionClosed):
            tab.fetch('https://r.example/p')


class ClosedSocket:
    def __init__(self, *, on_send: bool):
        self.on_send = on_send

    def send(self, _payload: str, /) -> None:
        if self.on_send:
            raise ConnectionError('WebSocketConnectionClosedException')

    def recv(self) -> str:
        raise ConnectionError('WebSocketConnectionClosedException')

    def settimeout(self, _timeout: float, /) -> None:
        return None

    def close(self) -> None:
        return None


class TestAClosedWebsocketIsNamed:
    @pytest.mark.parametrize('on_send', [True, False])
    def test_on_send_and_on_receive(self, on_send: bool):
        with pytest.raises(BrowserConnectionClosed, match=r'^Page\.enable: the browser connection closed$') as raised:
            CdpConnection(ClosedSocket(on_send=on_send)).call('Page.enable')
        assert isinstance(raised.value, CdpError)
