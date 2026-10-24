"""The optional knowledge keys on a derivation (memory ids, web searches, company context).

They are written only when non-empty, so a document built without company
knowledge stores the exact shape it stored before the keys existed.
"""
from shared.derivation import build_derivation

BASE = {
    'sources': [],
    'selected_document_count': 0,
    'feedback_count': 0,
    'persona_ids': [],
    'visual_document_ids': [],
    'product_context_included': False,
}


def test_absent_when_empty():
    assert build_derivation(memory_ids=[], web_search_count=0, company_context_included=False) == BASE


def test_present_when_used():
    assert build_derivation(memory_ids=['mem_1', '', None, 'mem_2'], web_search_count=3,
                            company_context_included=True) == {
        **BASE, 'memory_ids': ['mem_1', 'mem_2'], 'web_search_count': 3, 'company_context_included': True,
    }


def test_negative_search_count_degrades_to_absent():
    assert 'web_search_count' not in build_derivation(web_search_count=-2)
