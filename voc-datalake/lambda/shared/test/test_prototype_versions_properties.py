"""Property tests of which prototype rows get Back to vN (shared/prototype_versions.py).

The Back to vN button is offered exactly where the server accepts the row's inline HTML. The rule, in words:
a row is HTML when it is marked as HTML, or when its text, after any run of leading whitespace and byte-order
marks (however long), starts like an HTML document in any letter case.
"""
from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from shared.prototype_versions import _is_inline_html
from shared.test.property_settings import PROPERTY

BOM = chr(0xFEFF)
NO_BREAK_SPACE = chr(0xA0)
BLANKS = st.text(alphabet=f' \t\n\r{BOM}{NO_BREAK_SPACE}', max_size=6)
LONG_BLANKS = st.text(alphabet=f' \t\n{BOM}', min_size=200, max_size=400)
DOCTYPE_OPENERS = st.sampled_from(['<!DOCTYPE html>', '<!doctype html>', '<html>', '<HTML lang="en">'])
OTHER_OPENERS = st.sampled_from(['{"screen": 1}', '<div>', 'Hello', '<htmlx>', '', '# Title', '<!-- html -->'])
OTHER_FORMATS = st.sampled_from([None, 'json', 'HTML', 'spec', ''])


def _row(fmt: str | None) -> dict:
    return {'prototype_format': fmt} if fmt is not None else {}


def _without_leading_blanks(text: str) -> str:
    """The text after its leading whitespace (str.isspace) and byte-order marks, in any mix."""
    index = 0
    while index < len(text) and (text[index].isspace() or text[index] == BOM):
        index += 1
    return text[index:]


class TestAnInlinePrototypeIsHtmlWhenMarkedOrWhenItStartsLikeOne:
    """Invariant: marking a row 'html' decides; otherwise leading whitespace, byte-order marks and letter
    case do not matter, and only how the text starts does."""

    @PROPERTY
    @given(content=st.text(max_size=300))
    def test_a_row_marked_html_is_html_whatever_it_holds(self, content: str) -> None:
        assert _is_inline_html({'prototype_format': 'html'}, content) is True

    @PROPERTY
    @given(blanks=BLANKS, opener=DOCTYPE_OPENERS, tail=st.text(max_size=100))
    def test_leading_space_and_case_do_not_change_an_html_start(self, blanks: str, opener: str, tail: str) -> None:
        assert _is_inline_html({}, blanks + opener + tail) is True

    @PROPERTY
    @given(blanks=LONG_BLANKS, opener=DOCTYPE_OPENERS)
    def test_a_long_run_of_leading_space_is_skipped_however_long(self, blanks: str, opener: str) -> None:
        assert _is_inline_html({}, blanks + opener) is True

    @PROPERTY
    @given(fmt=OTHER_FORMATS, blanks=BLANKS, opener=OTHER_OPENERS, tail=st.text(max_size=50))
    def test_a_row_not_marked_html_that_does_not_start_like_html_is_not_html(
            self, fmt: str | None, blanks: str, opener: str, tail: str) -> None:
        text = blanks + opener + tail
        head = _without_leading_blanks(text).lower()
        assert _is_inline_html(_row(fmt), text) is head.startswith(('<!doctype html', '<html'))

    @PROPERTY
    @given(fmt=OTHER_FORMATS, word=st.sampled_from(['x', 'Hi', '{}']), opener=DOCTYPE_OPENERS)
    def test_an_html_start_after_other_text_does_not_count(self, fmt: str | None, word: str, opener: str) -> None:
        assert _is_inline_html(_row(fmt), f'{word} {opener}') is False
