"""A live website's buttons: every filled button by background, and only its own hover rules.

5.35.02 live on www.kiromail.dev (``fixtures/kiromail_page.json``: its ``:root`` properties and hover rules
from ``/assets/landing.css``, the three buttons the page measured, the model's stored Button): the purple
call-to-action (``#9046ff``, 16px, ``12px 24px``, radius 16px) had no Button variant — the page kept ONE
filled button — and the outlined button got a ``#000000`` hover no rule of its own sets.
"""
import json
from pathlib import Path

import page_components as pc
import page_styles as ps

from shared.component_overlay import overlay_components
from shared.css_tokens import custom_properties
from shared.tailwind_components import Theme

PAGE = json.loads((Path(__file__).parent / 'fixtures' / 'kiromail_page.json').read_text(encoding='utf-8'))


def _measured() -> dict[str, dict]:
    resolve = Theme(custom_properties(ps.css_text_of_vars(PAGE['root_vars']))).resolve_vars
    [button] = pc.measured_components(pc.parse_components(PAGE['components']), pc.parse_rules(PAGE['rules']), resolve)
    return button


def _by_name(component: dict) -> dict[str, dict]:
    return {v['name']: v for v in component['variants']}


def test_the_purple_call_to_action_and_the_white_nav_button_are_two_variants():
    variants = _by_name(_measured())

    assert list(variants) == ['inverse', 'primary', 'outline']
    primary = variants['primary']['styles']
    assert (primary['background'], primary['color']) == ('rgb(144, 70, 255)', 'rgb(255, 255, 255)')
    assert (primary['font_size'], primary['padding'], primary['radius']) == ('16px', '12px 24px', '16px')
    assert variants['inverse']['styles']['background'] == 'rgb(255, 255, 255)'


def test_a_hover_rule_styles_only_the_buttons_its_selector_names():
    variants = _by_name(_measured())

    assert variants['primary']['hover'] == {'color': '#000000'}  # .btn-primary:hover
    assert 'hover' not in variants['inverse']  # .btn-light has no hover rule of its own (only ::before)
    assert variants['outline']['hover'] == {'background': '#28242e', 'color': '#ffffff', 'border_color': '#5c5c5c'}


def test_the_measured_buttons_go_over_the_models_guess():
    design = overlay_components({'components': [PAGE['model_button']]}, [_measured()])

    assert design is not None
    [button] = design['components']
    variants = _by_name(button)
    assert list(variants) == ['inverse', 'primary', 'outline']
    assert variants['primary']['styles']['background'] == 'rgb(144, 70, 255)'
    # The model gave the white button and the outline a #000000 hover: hover comes from rules only.
    assert 'hover' not in variants['inverse']
    assert variants['outline']['hover']['color'] == '#ffffff'
    assert button['description'] == PAGE['model_button']['description']


def test_the_page_keeps_one_sample_per_filled_background_and_reads_the_rules_of_sampled_classes():
    js = ps.STYLES_JS

    assert "'filled ' + x.background" in js
    assert 'filled >= 2' in js
    assert 'namesSampled(sel)' in js
