"""The design system follows the category-name rule the company context follows.

``scoped_design_system`` drops guideline paragraphs, token entries and references that name
a category the reader may not see; ``design_system_block`` applies it before the DATA block
is built, so a prototype started by a restricted user never carries another category's name.
"""
from unittest.mock import patch

from shared import company_context as cc
from shared.category_access import CategoryScope
from shared.scope_names import HIDE_ALL, hidden_names, scoped_design_system

CONFIG = [
    {'name': 'technical_support', 'description': 'Technical Support'},
    {'name': 'hardware_quality', 'description': 'Hardware Quality'},
]
#: The DATA block's tags + untrusted-data notice, on top of the capped body.
BLOCK_OVERHEAD = 500
HIDDEN = hidden_names(CategoryScope(all=False, categories=frozenset({'technical_support'})), CONFIG)

DESIGN = {
    'tokens': {
        'colors': [{'name': 'primary', 'value': '#8e48ff'}, {'name': 'hardware-quality-alert', 'value': '#ff0000'}],
        'typography': [{'role': 'body', 'family': 'Inter'}],
        'spacing': [{'name': 'md', 'value': '16px'}],
    },
    'guidelines': 'One primary action per screen.\n\nHardware Quality pages use the red banner.',
    'references': [
        {'id': 'ref_a', 'kind': 'figma', 'title': 'Checkout', 'status': 'ready', 'extracted_summary': 'Purple.'},
        {'id': 'ref_b', 'kind': 'figma', 'title': 'Hardware quality dashboard', 'status': 'ready',
         'extracted_summary': 'Dense tables.'},
    ],
}


def test_a_restricted_reader_loses_only_what_names_a_hidden_category():
    scoped = scoped_design_system(DESIGN, HIDDEN)
    assert scoped['guidelines'] == 'One primary action per screen.'
    assert scoped['tokens']['colors'] == [{'name': 'primary', 'value': '#8e48ff'}]
    assert [r['id'] for r in scoped['references']] == ['ref_a']
    assert scoped['tokens']['typography'] == DESIGN['tokens']['typography']


def test_unrestricted_reader_gets_an_unchanged_copy():
    scoped = scoped_design_system(DESIGN, None)
    assert scoped == DESIGN
    assert scoped is not DESIGN


def test_fail_closed_hides_every_text_entry():
    scoped = scoped_design_system(DESIGN, HIDE_ALL)
    assert scoped['guidelines'] == ''
    assert scoped['references'] == []
    assert scoped['tokens']['colors'] == []


def test_the_prompt_block_is_scoped_and_still_capped():
    design = {**DESIGN, 'guidelines': f'{DESIGN["guidelines"]}\n\n{"x" * (cc.DESIGN_BLOCK_CAP * 2)}'}
    with patch.object(cc, 'get_design_system', return_value=design):
        block = cc.design_system_block(object(), HIDDEN)
    assert block.startswith('<design_system>')
    assert 'hardware' not in block.casefold()
    assert 'One primary action per screen.' in block
    assert len(block) < cc.DESIGN_BLOCK_CAP + BLOCK_OVERHEAD


def test_the_prompt_block_without_a_scope_keeps_everything():
    with patch.object(cc, 'get_design_system', return_value=DESIGN):
        block = cc.design_system_block(object())
    assert 'Hardware Quality pages use the red banner.' in block
    assert 'Hardware quality dashboard (figma): Dense tables.' in block
