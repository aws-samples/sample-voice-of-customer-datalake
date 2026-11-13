"""A prototype version's outline: its screens, headings and visible text (docs/prototype-builder.md, part 2).

The assistant cannot read a prototype's HTML, and should not: it is model-written code. The
outline is what a person reading the prototype sees, extracted on the server from the version's
HTML (``version_html``: its object, or the HTML the oldest prototypes kept inline), so the model
can say "the checkout screen's summary" without ever being handed markup:

* **Screens.** A prototype is one file whose screens are toggled by script. An element is a
  screen when it carries ``data-screen``, ``data-route`` or ``data-page`` (the value is its
  route), or is a ``<section>`` with an ``id``, or has an ``id`` and a class ``screen``,
  ``page`` or ``view`` (the id is its route). Text outside every screen (the header, the tab
  bar) is the screen with route ``""``, listed first. A screen inside a screen is its own.
* **Text.** The text of each block element (paragraphs, list items, buttons, cells, …) is one
  line, whitespace collapsed; headings (``h1``-``h6``) are listed apart. The ``<title>`` of the
  document's head is the outline's ``title``. Nothing from ``script``, ``style``, ``noscript``,
  ``template``, ``svg`` or the rest of ``head`` (a ``<body>`` closes a head left open), nothing
  hidden from people (``hidden``, ``aria-hidden="true"``, an inline ``display: none``; a screen
  itself is kept, as an inactive screen is hidden until shown), and nothing of the pin widget
  (stripped first): the outline never holds a pin or a line of code. A line repeated in one screen
  is listed once.
* **Caps.** At most ``MAX_INPUT_CHARS`` of HTML are read, elements nest at most ``MAX_DEPTH``
  deep (a deeper start tag is ignored: its text joins the element it is in), and the answer has
  at most ``MAX_SCREENS`` screens, ``MAX_LINES`` lines (headings and text together) of
  ``MAX_LINE_CHARS`` characters, and ``MAX_OUTLINE_CHARS`` characters in all, title and routes
  counted; ``truncated`` says whether anything was left out. Every check looks at the innermost
  open element only (each carries what it inherits), so model HTML that never closes its tags
  costs linear time.
* **Data, not instructions.** Every line, route and the title have their DATA-block tags defanged
  (``neutralise_tags``): the stream Lambda hands the outline to the model inside a
  ``<prototype_outline>`` block, and an MCP client gets the same lines.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any, Final

from shared.prompt_safety import neutralise_tags
from shared.prototype_pins import strip_pin_widget
from shared.text_clip import WHITESPACE_RE

MAX_INPUT_CHARS: Final = 512 * 1024
MAX_DEPTH: Final = 256
MAX_SCREENS: Final = 40
MAX_LINES: Final = 200
MAX_LINE_CHARS: Final = 300
MAX_OUTLINE_CHARS: Final = 12_000
MAX_TITLE_CHARS: Final = 200

_SKIPPED: Final = frozenset({'script', 'style', 'noscript', 'template', 'svg', 'head', 'title'})
_HEADINGS: Final = frozenset({'h1', 'h2', 'h3', 'h4', 'h5', 'h6'})
# A block's text is one line; inline elements (span, a, b, label, …) join the line they are in.
_BLOCKS: Final = frozenset({
    'address', 'article', 'aside', 'blockquote', 'body', 'br', 'button', 'caption', 'dd', 'details', 'dialog', 'div',
    'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'option',
    'p', 'pre', 'section', 'select', 'summary', 'table', 'td', 'th', 'tr', 'ul', *_HEADINGS,
})
_VOID: Final = frozenset({'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'})
_ROUTE_ATTRS: Final = ('data-screen', 'data-route', 'data-page')
_SCREEN_CLASSES: Final = frozenset({'screen', 'page', 'view'})
_DISPLAY_NONE: Final = re.compile(r'display\s*:\s*none', re.IGNORECASE)


def _screen_route(tag: str, attrs: dict[str, str]) -> str | None:
    """The route an element names when it is a screen, else None."""
    for name in _ROUTE_ATTRS:
        value = attrs.get(name, '').strip()
        if value:
            return value
    element_id = attrs.get('id', '').strip()
    if not element_id:
        return None
    if tag == 'section' or _SCREEN_CLASSES & set(attrs.get('class', '').split()):
        return element_id
    return None


def _hidden(attrs: dict[str, str]) -> bool:
    """Whether people never see the element: ``hidden``, ``aria-hidden="true"`` or an inline ``display: none``."""
    return ('hidden' in attrs or attrs.get('aria-hidden', '').strip().lower() == 'true'
            or bool(_DISPLAY_NONE.search(attrs.get('style', ''))))


@dataclass
class _Screen:
    route: str
    headings: list[str] = field(default_factory=list)
    text: list[str] = field(default_factory=list)
    seen: set[str] = field(default_factory=set)


@dataclass(frozen=True)
class _Open:
    """One open element and the state it gives what is inside it (its parent's, plus its own)."""

    tag: str
    screen: _Screen
    owns_screen: bool = False
    skipped: bool = False
    heading: bool = False
    in_head: bool = False


class _OutlineParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.screens: list[_Screen] = [_Screen('')]
        self.title: list[str] = []
        self._root = _Open('', self.screens[0])
        self._open: list[_Open] = []
        self._line: list[str] = []
        self._in_title = False

    def _top(self) -> _Open:
        return self._open[-1] if self._open else self._root

    def _flush(self) -> None:
        line = WHITESPACE_RE.sub(' ', ''.join(self._line)).strip()
        self._line = []
        top = self._top()
        if not line or top.skipped or line in top.screen.seen:
            return
        top.screen.seen.add(line)
        (top.screen.headings if top.heading else top.screen.text).append(line)

    def _close_head(self) -> None:
        """A ``<body>`` ends a head nothing closed: drop the open head and what is inside it."""
        for index, element in enumerate(self._open):
            if element.tag == 'head':
                del self._open[index:]
                self._line = []
                self._in_title = False
                return

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == 'body':
            self._close_head()
        if tag in _BLOCKS:
            self._flush()
        if tag in _VOID or len(self._open) >= MAX_DEPTH:
            return
        parent = self._top()
        values = {name: value or '' for name, value in attrs}
        route = None if parent.skipped else _screen_route(tag, values)
        screen = _Screen(route) if route is not None else None
        if screen is not None:
            self.screens.append(screen)
        # A screen is kept though hidden: an inactive screen is hidden until the prototype shows it.
        hidden = screen is None and _hidden(values)
        if tag == 'title':
            # Only the head's title names the document (an <svg><title> in the body is an icon's label).
            self._in_title = parent.in_head
        self._open.append(_Open(
            tag, screen or parent.screen, owns_screen=screen is not None,
            skipped=parent.skipped or tag in _SKIPPED or hidden,
            heading=parent.heading or tag in _HEADINGS,
            in_head=parent.in_head or tag == 'head',
        ))

    def handle_endtag(self, tag: str) -> None:
        if tag in _BLOCKS:
            self._flush()
        # Close up to the matching element; an end tag nothing opened is ignored (model HTML is not always
        # balanced). The search is bounded by MAX_DEPTH.
        for index in range(len(self._open) - 1, -1, -1):
            if self._open[index].tag == tag:
                # A screen that ends keeps its own last line, even when it is an inline element.
                if any(element.owns_screen for element in self._open[index:]):
                    self._flush()
                if tag == 'title':
                    self._in_title = False
                del self._open[index:]
                return

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title.append(data)
        elif not self._top().skipped:
            self._line.append(data)

    def close(self) -> None:
        super().close()
        self._flush()


def _line(text: str) -> str:
    """One outline line: whitespace collapsed, data-block tags defanged, within MAX_LINE_CHARS (an ellipsis marks a cut)."""
    safe = neutralise_tags(WHITESPACE_RE.sub(' ', text).strip())
    return safe if len(safe) <= MAX_LINE_CHARS else f'{safe[:MAX_LINE_CHARS - 1].rstrip()}…'


def outline_of(html: str) -> dict[str, Any]:
    """``{title, screens: [{route, headings, text}], truncated}`` of a prototype's HTML, within the caps."""
    source = strip_pin_widget(html or '')
    truncated = len(source) > MAX_INPUT_CHARS
    parser = _OutlineParser()
    parser.feed(source[:MAX_INPUT_CHARS])
    parser.close()
    found = [screen for screen in parser.screens if screen.route or screen.headings or screen.text]
    truncated = truncated or len(found) > MAX_SCREENS
    title = neutralise_tags(WHITESPACE_RE.sub(' ', ''.join(parser.title)).strip()[:MAX_TITLE_CHARS])
    screens: list[dict[str, Any]] = []
    lines = 0
    chars = len(title)
    full = False  # a cap reached: nothing later is added, so the outline is a prefix of the prototype's text
    for screen in found[:MAX_SCREENS]:
        route = _line(screen.route)
        full = full or chars + len(route) > MAX_OUTLINE_CHARS
        if full:
            truncated = True
            break
        chars += len(route)
        kept: dict[str, list[str]] = {'headings': [], 'text': []}
        for key, entries in (('headings', screen.headings), ('text', screen.text)):
            for raw in entries:
                line = _line(raw)
                full = full or lines >= MAX_LINES or chars + len(line) > MAX_OUTLINE_CHARS
                if full:
                    truncated = True
                    break
                kept[key].append(line)
                lines += 1
                chars += len(line)
        screens.append({'route': route, **kept})
    return {'title': title, 'screens': screens, 'truncated': truncated}
