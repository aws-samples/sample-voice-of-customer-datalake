"""Web Reviews store plain text: no markdown escapes, no bold markers (5.34.00 live finding).

The cases are the ones the SPA and the assistant pin too (``schemas/review-text-cleanup-cases.json``).
"""
import json
from pathlib import Path

import pytest
from extract import ExtractedReview
from review_text import plain_review_text
from web_items import WebTarget, queue_item, review_id

CASES = json.loads((Path(__file__).resolve().parents[3] / 'schemas' / 'review-text-cleanup-cases.json').read_text())['cases']


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['input'][:30] or 'empty')
def test_review_text_reads_as_plain_text(case):
    assert plain_review_text(case['input']) == case['output']


def test_a_queued_review_is_stored_without_escapes_but_keeps_the_id_of_its_extracted_text():
    review = ExtractedReview(text='Stressful situation\\.On **time** next day', rating=4.0, date='2026-10-01',
                             title='**Fine**', author=None)
    target = WebTarget(id='t1', name='Example Air', url='https://reviews.example.com/x', max_pages=1,
                       max_reviews=0, frequency_minutes=0, enabled=True)
    item = queue_item(target, review, page=1, page_url=target.url, brand_name='')
    assert item['text'] == 'Stressful situation. On time next day'
    assert item['title'] == 'Fine'
    # The id still hashes the extracted text, so a review stored before this change is not stored again.
    assert item['id'] == review_id(target.host, review)
