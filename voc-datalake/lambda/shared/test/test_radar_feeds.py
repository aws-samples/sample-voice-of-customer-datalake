"""A Radar brand's RSS / Atom feeds: safe parsing, the window, the SSRF-guarded fetch (docs/radar.md → "Feeds")."""
import logging
from datetime import date
from unittest.mock import MagicMock

import pytest
import requests

from shared.http_utils import UnsafeURLError
from shared.radar_feeds import (
    FEED_TIMEOUT_SECONDS,
    MAX_FEED_BYTES,
    MAX_FEED_REDIRECTS,
    FeedError,
    feed_results,
    parse_feed,
)

SINCE, TODAY = date(2026, 10, 1), date(2026, 10, 27)

RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Acme news</title>
  <item><title>Nowa wersja 5.0</title><link>https://acme.example/news/5</link>
    <description>&lt;p&gt;Acme wprowadza &lt;b&gt;tryb ciemny&lt;/b&gt;&lt;/p&gt;</description>
    <pubDate>Mon, 20 Oct 2026 08:00:00 +0200</pubDate></item>
  <item><title>Old</title><link>https://acme.example/news/old</link><pubDate>Mon, 01 Sep 2026 08:00:00 GMT</pubDate></item>
  <item><title>Plain http</title><link>http://acme.example/news/http</link><pubDate>Tue, 21 Oct 2026 08:00:00 GMT</pubDate></item>
  <item><title>Undated</title><link>https://acme.example/news/undated</link></item>
  <item><title>Promo</title><link>https://acme.example/news/promo</link><pubDate>Thu, 23 Oct 2026 08:00:00 GMT</pubDate></item>
</channel></rss>"""

ATOM = b"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Acme</title>
  <entry><title>Partnership with Example Air</title>
    <link rel="self" href="https://acme.example/self"/><link rel="alternate" href="https://acme.example/blog/partner"/>
    <summary>Acme and Example Air integrate.</summary><updated>2026-10-15T10:00:00Z</updated></entry>
  <entry><title>Launch</title><link href="https://acme.example/blog/launch"/>
    <content type="html">&lt;p&gt;Launched&lt;/p&gt;</content><published>2026-10-02</published></entry>
</feed>"""


class TestParse:
    def test_rss_items_in_the_window_with_an_https_link_newest_first_tags_stripped(self):
        assert parse_feed(RSS, SINCE, TODAY) == [
            {'title': 'Promo', 'url': 'https://acme.example/news/promo', 'text': 'Promo', 'published_date': '2026-10-23'},
            {'title': 'Nowa wersja 5.0', 'url': 'https://acme.example/news/5', 'text': 'Acme wprowadza tryb ciemny',
             'published_date': '2026-10-20'},
        ]

    def test_atom_entries_take_the_alternate_link_and_published_or_updated(self):
        found = parse_feed(ATOM, SINCE, TODAY)
        assert [(r['url'], r['published_date'], r['text']) for r in found] == [
            ('https://acme.example/blog/partner', '2026-10-15', 'Acme and Example Air integrate.'),
            ('https://acme.example/blog/launch', '2026-10-02', 'Launched'),
        ]

    @pytest.mark.parametrize('body', [
        b'<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "aaaa">]><rss><channel/></rss>',
        b'<?xml version="1.0"?><!doctype rss><rss/>',
        b'<rss><!ENTITY x SYSTEM "file:///etc/passwd"></rss>',
        '<?xml version="1.0" encoding="UTF-16"?><rss/>'.encode('utf-16'),
    ])
    def test_a_doctype_an_entity_or_a_non_ascii_compatible_document_is_refused_before_parsing(self, body):
        with pytest.raises(FeedError):
            parse_feed(body, SINCE, TODAY)

    @pytest.mark.parametrize('body', [b'<rss><channel>', b'<html><body>news</body></html>', b'not xml'])
    def test_malformed_or_non_feed_documents_are_refused(self, body):
        with pytest.raises(FeedError):
            parse_feed(body, SINCE, TODAY)

    def test_at_most_thirty_items(self):
        items = ''.join(f'<item><title>{n}</title><link>https://acme.example/{n}</link>'
                        f'<pubDate>Mon, 20 Oct 2026 08:00:00 GMT</pubDate></item>' for n in range(40))
        assert len(parse_feed(f'<rss><channel>{items}</channel></rss>'.encode(), SINCE, TODAY)) == 30


class TestFetch:
    def test_the_feed_is_fetched_through_the_guard_with_its_caps(self):
        fetch = MagicMock(return_value=MagicMock(status_code=200, content=ATOM))
        assert len(feed_results('https://acme.example/feed', SINCE, TODAY, fetch)) == 2
        fetch.assert_called_once_with('https://acme.example/feed', timeout=FEED_TIMEOUT_SECONDS,
                                      max_redirects=MAX_FEED_REDIRECTS, max_bytes=MAX_FEED_BYTES)

    @pytest.mark.parametrize('failure', [
        MagicMock(side_effect=UnsafeURLError('https://acme.example/feed', 'private address')),
        MagicMock(side_effect=requests.Timeout()),
        MagicMock(return_value=MagicMock(status_code=404, content=b'')),
        MagicMock(return_value=MagicMock(status_code=200, content=b'<html/>')),
    ])
    def test_a_failing_feed_is_a_warning_with_the_host_only_and_no_results(self, failure, caplog):
        with caplog.at_level(logging.WARNING):
            assert feed_results('https://acme.example/secret/feed?token=t', SINCE, TODAY, failure) == []
        assert 'Radar: a feed' in caplog.text
        assert 'secret' not in caplog.text
        assert 'token' not in caplog.text

    def test_a_non_https_feed_is_never_fetched(self):
        fetch = MagicMock()
        assert feed_results('http://acme.example/feed', SINCE, TODAY, fetch) == []
        fetch.assert_not_called()
