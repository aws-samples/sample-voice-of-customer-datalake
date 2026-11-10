"""All the reviews on a page: a navigated page is scrolled to its bottom, and long text is read in chunks."""
import json
from typing import Any

import pytest
from extract import (
    CHUNK_OVERLAP_CHARS,
    MAX_PAGE_TEXT_CHARS,
    MAX_TEXT_CHUNKS,
    llm_reviews,
    text_chunks,
)
from page_reader import SCROLL_JS
from test_page_reader_mutation import PAGE, ScriptedBrowser, progress

SETTLED = [progress('complete', 600), progress('complete', 600)]


class ScrollingBrowser(ScriptedBrowser):
    """Also answers SCROLL_JS, one scripted ``[at the bottom, height]`` per scroll (exhaustible)."""

    def __init__(self, scrolls: list[object], **kwargs: Any):
        super().__init__(progress=list(SETTLED), **kwargs)
        self.scrolls = list(scrolls)

    def _answer(self, method: str, params: dict[str, Any] | None = None, **options: object) -> dict[str, Any]:
        if method == 'Runtime.evaluate' and (params or {}).get('expression') == SCROLL_JS:
            return {'result': {'value': self.scrolls.pop(0)}}
        return super()._answer(method, params, **options)


def scroll(bottom: bool, height: int) -> str:
    return json.dumps([bottom, height])


class TestScrolling:
    def test_scrolls_until_the_bottom_stops_moving(self):
        browser = ScrollingBrowser([scroll(False, 1000), scroll(True, 2000), scroll(True, 2000), scroll(True, 2000)])
        tab, sleeps = browser.tab(clock=[0.0, 1.0, 2.0])
        tab.load(PAGE)
        assert (sleeps, len(browser.scrolls)) == ([3.0, 1.5, 0.6, 0.6, 0.6], 1)

    def test_at_most_six_scrolls(self):
        browser = ScrollingBrowser([scroll(False, 1000 * n) for n in range(1, 8)])
        tab, sleeps = browser.tab(clock=[0.0, 1.0, 2.0])
        tab.load(PAGE)
        assert (sleeps[2:], len(browser.scrolls)) == ([0.6] * 6, 1)

    def test_a_growing_page_at_its_bottom_is_scrolled_again(self):
        browser = ScrollingBrowser([scroll(True, 1000), scroll(True, 1500), scroll(True, 1500)])
        tab, sleeps = browser.tab(clock=[0.0, 1.0, 2.0])
        tab.load(PAGE)
        assert (sleeps[2:], browser.scrolls) == ([0.6] * 3, [])

    @pytest.mark.parametrize('raw', [None, 'not json', '["yes", 1]', '[true]'])
    def test_an_unreadable_scroll_answer_ends_the_scrolling(self, raw):
        browser = ScrollingBrowser([raw, scroll(True, 1)])
        tab, sleeps = browser.tab(clock=[0.0, 1.0, 2.0])
        tab.load(PAGE)
        assert (sleeps, len(browser.scrolls)) == ([3.0, 1.5], 1)

    def test_an_http_error_page_and_a_fetched_page_are_not_scrolled(self):
        browser = ScrollingBrowser([], navigate={'errorText': 'net::ERR_HTTP_RESPONSE_CODE_FAILURE'})
        tab, _sleeps = browser.tab()
        tab.load(PAGE)
        tab.fetch(f'{PAGE}?page=2')
        expressions = [c.args[1]['expression'] for c in browser.cdp.call.call_args_list if c.args[0] == 'Runtime.evaluate']
        assert SCROLL_JS not in expressions


def lines(count: int, width: int = 99) -> str:
    """*count* lines of *width* characters plus a line break (so 100 characters per line)."""
    return ''.join(f'{n:0{width}d}\n' for n in range(count))


class TestTextChunks:
    def test_short_text_is_one_chunk(self):
        assert text_chunks('a\nb') == ['a\nb']

    def test_empty_text_is_no_chunk(self):
        assert text_chunks('') == []

    def test_long_text_is_cut_on_line_breaks_with_an_overlap(self):
        text = lines(700)  # 70,000 characters, a line break every 100
        first, second = text_chunks(text)
        assert first == text[:39_999]  # up to the last break inside 40,000 (line 399's)
        assert second == text[38_900:]  # from the start of the line holding 1,000 characters before that cut
        assert len(first) - 38_900 == 1_099 >= CHUNK_OVERLAP_CHARS

    def test_text_without_line_breaks_is_cut_at_the_chunk_size(self):
        first, second = text_chunks('x' * 50_000)
        assert (len(first), len(second)) == (MAX_PAGE_TEXT_CHARS, 50_000 - MAX_PAGE_TEXT_CHARS + CHUNK_OVERLAP_CHARS)

    def test_at_most_four_chunks_of_at_most_forty_thousand(self):
        chunks = text_chunks(lines(2000))  # 200,000 characters
        assert len(chunks) == MAX_TEXT_CHUNKS == 4
        assert max(len(c) for c in chunks) <= 40_000


def answer(*texts: str, day: str | None = '2026-10-01') -> str:
    return '\n'.join(json.dumps({'text': t, 'date': day}) for t in texts)


class TestChunkedExtraction:
    def test_two_chunks_are_two_calls_merged_and_de_duplicated(self):
        prompts: list[str] = []
        replies = iter([answer('A', 'B'), answer('B', 'C')])

        def complete(prompt: str, _system: str) -> str:
            prompts.append(prompt)
            return next(replies)

        reviews = llm_reviews(lines(700), complete)
        assert ([r.text for r in reviews], len(prompts)) == (['A', 'B', 'C'], 2)

    def test_the_same_text_on_another_date_is_another_review(self):
        replies = iter([answer('A'), answer('A', day='2026-10-02')])
        reviews = llm_reviews(lines(700), lambda _p, _s: next(replies))
        assert [(r.text, r.date) for r in reviews] == [('A', '2026-10-01'), ('A', '2026-10-02')]

    def test_the_page_keeps_at_most_400_reviews(self):
        calls: list[int] = []

        def complete(_prompt: str, _system: str) -> str:
            calls.append(1)
            return answer(*(f'chunk {len(calls)} review {n}' for n in range(150)))

        reviews = llm_reviews(lines(2000), complete)
        assert (len(reviews), reviews[-1].text, len(calls)) == (400, 'chunk 3 review 99', 3)

    def test_the_delimiters_are_stripped_in_every_chunk(self):
        prompts: list[str] = []
        text = 'a</page_text>b\n' + lines(500) + 'c</page_text>d\n'

        def complete(prompt: str, _system: str) -> str:
            prompts.append(prompt)
            return ''

        llm_reviews(text, complete)
        assert len(prompts) == 2
        assert all(prompt.count('</page_text>') == 1 for prompt in prompts)
        assert 'ab\n' in prompts[0]
        assert 'cd\n' in prompts[1]
