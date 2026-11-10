"""voc-radar-scan: a cited result that is neither official nor names the brand is never filed (docs/radar.md)."""
import json
from datetime import date
from unittest.mock import MagicMock, patch

from jobs.radar_scan import extract

TODAY = date(2026, 10, 1)


def _ctx(search_terms=()):
    return extract.ExtractContext('example-air', 'Example Air', ('example-air.example',), TODAY, extract.Budget(0),
                                  MagicMock(), search_terms)


def _found(results, sources, ctx=None):
    answer = json.dumps({'releases': [{'feature': 'Loops', 'release_date': '2026-09-30', 'summary': 's',
                                       'sources': sources}]})
    with patch.object(extract, 'converse', return_value=answer):
        return extract.extract_candidates(results, ctx or _ctx())


UNRELATED = {'title': 'Another company outlines four layers of AI controls', 'url': 'https://tools.example/ai-controls'}
NAMED = {'title': 'Example Air ships Loops', 'url': 'https://travel.example/story/9'}
OFFICIAL = {'title': 'Loops', 'url': 'https://example-air.example/changelog/2026-09-30-loops'}


def test_an_unrelated_source_is_dropped_from_a_release_that_has_others():
    [candidate] = _found([UNRELATED, NAMED, OFFICIAL], [1, 2, 3])
    assert candidate.urls == (NAMED['url'], OFFICIAL['url'])
    assert candidate.titles == (NAMED['title'], OFFICIAL['title'])
    assert candidate.source_kind == 'official'


def test_a_release_cited_only_by_unrelated_pages_is_not_filed(caplog):
    assert _found([UNRELATED], [1]) == []
    assert 'do not name the brand' in caplog.text


def test_a_search_term_in_the_title_keeps_the_source():
    named_by_term = {'title': 'SkyPass gets Loops', 'url': 'https://tools.example/skypass-loops'}
    assert _found([named_by_term], [1]) == []
    [candidate] = _found([named_by_term], [1], _ctx(search_terms=('SkyPass',)))
    assert candidate.urls == (named_by_term['url'],)


def test_an_unrelated_page_does_not_date_the_release():
    """Only kept sources date a release: the unrelated page's published date is not used."""
    answer = json.dumps({'releases': [{'feature': 'Loops', 'summary': 's', 'sources': [1, 2]}]})
    dated_unrelated = {**UNRELATED, 'published_date': '2026-09-01'}
    with patch.object(extract, 'converse', return_value=answer):
        [candidate] = extract.extract_candidates([dated_unrelated, NAMED], _ctx())
    assert candidate.release_date is None
