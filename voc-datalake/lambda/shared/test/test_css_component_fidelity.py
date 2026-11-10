"""The voc-v2 repository's components read with the values its own CSS gives them.

5.35.02 live (the real ``frontend/src/index.css`` is ``fixtures/voc_v2_index.css``), the stored design missed
the Badge ``info`` / ``aim`` tones, the Input / Select focus ring (only the outline was kept), the Switch
width and knob, and resolved ``shadow-sm`` / ``shadow-2xl`` to Tailwind's defaults or to the model's guess
instead of the file's own ``--shadow-*`` tokens.
"""
from pathlib import Path

import pytest

from shared.component_overlay import overlay_components
from shared.css_color_mix import evaluate_color_mix
from shared.css_component_rules import components_from_css
from shared.css_tokens import custom_properties
from shared.design_components import clean_components
from shared.tailwind_components import Theme, styles_from_classes

# The file's own --shadow-sm, and Tailwind's shadow-2xl (the file defines no --shadow-2xl).
FILE_SHADOW_SM = '0 1px 2px rgba(0, 0, 0, .3)'
TAILWIND_SHADOW_2XL = '0 25px 50px -12px rgb(0 0 0 / 25%)'

VOC_V2_CSS = (Path(__file__).parent / 'fixtures' / 'voc_v2_index.css').read_text(encoding='utf-8')


def _parsed(css: str = VOC_V2_CSS) -> list[dict]:
    return clean_components(components_from_css(css, Theme(custom_properties(css))))


def _variants(components: list[dict]) -> dict[str, dict[str, dict]]:
    return {c['name']: {v['name']: v for v in c['variants']} for c in components}


class TestTheVocV2Css:
    def test_every_badge_tone_is_a_variant_including_info_and_aim(self):
        badge = _variants(_parsed())['Badge']

        assert list(badge) == ['ok', 'danger', 'warn', 'muted', 'accent', 'info', 'aim']
        # --color-info-subtle is color-mix(in srgb, var(--info) 12%, transparent).
        assert badge['info']['styles']['background'] == 'rgba(122, 163, 230, 0.12)'
        assert badge['info']['styles']['color'] == '#7aa3e6'
        assert badge['aim']['styles']['background'] == 'rgba(193, 154, 255, .15)'

    def test_input_and_select_focus_carry_the_ring_border_and_glow(self):
        found = _variants(_parsed())

        assert found['Input']['default']['focus'] == {
            'outline': '1px solid #8e48ff', 'border_color': '#8e48ff',
            'shadow': '0 0 0 3px rgba(178, 127, 255, .16), 0 0 20px rgba(142, 72, 255, 0.08)'}
        assert found['Select']['default']['focus'] == {
            'outline': '1px solid #8e48ff', 'border_color': '#8e48ff', 'shadow': '0 0 0 3px rgba(178, 127, 255, .16)'}

    def test_the_switch_has_its_width_and_the_knob_is_described(self):
        [switch] = [c for c in _parsed() if c['name'] == 'Switch']

        assert {v['name']: v['styles']['width'] for v in switch['variants']} == {'default': '36px', 'on': '36px'}
        assert switch['description'].startswith('Knob: height=16px, width=16px, radius=9999px, background=white')

    def test_shadow_utilities_resolve_to_the_files_own_shadow_tokens(self):
        found = _variants(_parsed())

        assert found['Tab']['active']['styles']['shadow'] == FILE_SHADOW_SM  # --shadow-sm
        # The file defines no --shadow-2xl: Tailwind's 2xl, not the file's --shadow-lg.
        assert found['Dialog']['default']['styles']['shadow'] == TAILWIND_SHADOW_2XL


@pytest.mark.parametrize(('classes', 'props', 'expected'), [
    ('shadow-sm', {'shadow-sm': '0 1px 2px rgba(0, 0, 0, .3)'}, '0 1px 2px rgba(0, 0, 0, .3)'),
    ('shadow-2xl', {'shadow-2xl': '0 9px 9px #000'}, '0 9px 9px #000'),
    ('shadow', {'shadow': '0 2px 4px #111'}, '0 2px 4px #111'),
    ('shadow-sm', {'shadow-sm': 'var(--shadow-sm)'}, '0 1px 3px rgb(0 0 0 / 10%), 0 1px 2px -1px rgb(0 0 0 / 10%)'),
    ('shadow-xl', {}, '0 20px 25px -5px rgb(0 0 0 / 10%), 0 8px 10px -6px rgb(0 0 0 / 10%)'),
])
def test_a_shadow_utility_prefers_the_repositorys_token(classes, props, expected):
    assert styles_from_classes(classes, Theme(props))[0]['shadow'] == expected


@pytest.mark.parametrize(('value', 'expected'), [
    ('color-mix(in srgb, #7aa3e6 12%, transparent)', 'rgba(122, 163, 230, 0.12)'),
    ('color-mix(in oklch, transparent, #ffffff 40%)', 'rgba(255, 255, 255, 0.4)'),
    ('color-mix(in srgb, #000000 25%, #ffffff)', '#bfbfbf'),
    ('color-mix(in srgb, rgb(0 0 0 / 50%), transparent)', 'rgba(0, 0, 0, 0.25)'),
    ('0 0 4px color-mix(in srgb, #8e48ff 8%, transparent)', '0 0 4px rgba(142, 72, 255, 0.08)'),
    ('color-mix(in oklch, #000000, #ffffff)', 'color-mix(in oklch, #000000, #ffffff)'),
    ('color-mix(in srgb, currentColor 10%, transparent)', 'color-mix(in srgb, currentColor 10%, transparent)'),
    ('color-mix(' + '(' * 3_000, 'color-mix(' + '(' * 3_000),
])
def test_color_mix_is_computed_when_it_can_be(value, expected):
    assert evaluate_color_mix(value) == expected


def test_the_parsed_components_go_over_the_models_version():
    # The model's stored Badge / Tab of the live run: five tones, Tailwind's shadow on the active tab.
    model = [
        {'name': 'Badge', 'description': 'Status pill.', 'variants': [
            {'name': 'ok', 'styles': {'background': 'rgba(0, 133, 67, .15)', 'color': 'var:success'}}]},
        {'name': 'Tab', 'description': '', 'variants': [
            {'name': 'active', 'styles': {'color': 'var:accent-text',
                                          'shadow': '0 1px 3px rgb(0 0 0 / 10%), 0 1px 2px -1px rgb(0 0 0 / 10%)'}}]},
        {'name': 'Dialog', 'description': '', 'variants': [
            {'name': 'default', 'styles': {'shadow': '0 12px 28px rgba(0, 0, 0, .45)'}}]},
        {'name': 'Input', 'description': '', 'variants': [
            {'name': 'default', 'focus': {'outline': '1px solid #8e48ff'}}]},
    ]

    design = overlay_components({'components': model}, _parsed())

    assert design is not None
    found = _variants(design['components'])
    assert list(found['Badge']) == ['ok', 'danger', 'warn', 'muted', 'accent', 'info', 'aim']
    assert found['Badge']['ok']['styles']['color'] == '#1bb36b'
    assert found['Tab']['active']['styles']['shadow'] == FILE_SHADOW_SM
    # The model guessed the dialog's shadow from --shadow-lg; the file's class is shadow-2xl.
    assert found['Dialog']['default']['styles']['shadow'] == TAILWIND_SHADOW_2XL
    assert found['Input']['default']['focus']['border_color'] == '#8e48ff'
    assert found['Input']['default']['focus']['shadow'].startswith('0 0 0 3px rgba(178, 127, 255, .16)')
    assert next(c for c in design['components'] if c['name'] == 'Badge')['description'] == 'Status pill.'
    assert 'Switch' in found
