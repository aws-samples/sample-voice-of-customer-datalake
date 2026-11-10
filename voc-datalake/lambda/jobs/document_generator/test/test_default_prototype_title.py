"""default_prototype_title: an untitled build is "<source title> prototype", not "Prototype (v1)"."""
import pytest

from jobs.document_generator import handler as H

FALLBACK = 'Prototype: Acme App'


@pytest.mark.parametrize(('prd', 'prfaq', 'expected'), [
    pytest.param({'title': 'Checkout redesign (v2)'}, None, 'Checkout redesign prototype', id='prd-version-dropped'),
    pytest.param({'title': 'Checkout — PRD (v1)'}, {'title': 'Checkout — PR/FAQ'}, 'Checkout prototype', id='prd-label-dropped'),
    pytest.param({'base_title': 'Saved base', 'title': 'Saved base (v4)'}, None, 'Saved base prototype', id='base-title-first'),
    pytest.param(None, {'title': 'Loyalty — PR/FAQ (v2)'}, 'Loyalty prototype', id='prfaq-when-no-prd'),
    pytest.param({'title': '   '}, {'title': 'Loyalty'}, 'Loyalty prototype', id='blank-prd-title-skipped'),
    pytest.param({'document_id': 'p1'}, None, FALLBACK, id='no-title-anywhere'),
    pytest.param(None, None, FALLBACK, id='no-documents'),
])
def test_names_the_build_after_its_source(prd, prfaq, expected):
    assert H.default_prototype_title(prd, prfaq, FALLBACK) == expected


def test_a_long_source_title_is_capped_before_the_suffix():
    title = H.default_prototype_title({'title': 'x' * 500}, None, FALLBACK)
    assert title == 'x' * H.PROTOTYPE_TITLE_BASE_CAP + ' prototype'
