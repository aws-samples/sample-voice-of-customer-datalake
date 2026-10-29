"""A GitHub design reference reads plain CSS component classes, the other themes and names an SVG logo.

5.35 live, against the voc-v2 repository (its real ``frontend/src/index.css`` is the fixture
``fixtures/voc_v2_index.css``): the read missed the light theme (``[data-theme="kiro-light"]``),
every ``@layer components`` class (``.input``, ``.badge-*``, ``.tab``/``.tab-active``, ``.select``,
``.switch``, the Button ``secondary`` / ``ghost`` / ``danger`` variants) and the logo (an SVG).
"""
from pathlib import Path

import pytest

from shared import design_references as dr
from shared import github_design
from shared.css_component_rules import components_from_css
from shared.css_rules import declarations, leaf_rules
from shared.css_theme_modes import modes_markdown, theme_modes
from shared.css_tokens import custom_properties
from shared.design_components import clean_components
from shared.tailwind_components import Theme
from shared.test.test_design_references_mutation import CONTENTS, TREE_HEAD, _Body, _tree, _world

VOC_V2_CSS = (Path(__file__).parent / 'fixtures' / 'voc_v2_index.css').read_text(encoding='utf-8')
CSS_PATH = 'voc-datalake/frontend/src/index.css'


def _components(css: str = VOC_V2_CSS) -> dict[str, dict[str, dict]]:
    """component name → variant name → variant (cleaned like the stored design)."""
    cleaned = clean_components(components_from_css(css, Theme(custom_properties(css))))
    return {c['name']: {v['name']: v for v in c['variants']} for c in cleaned}


class TestTheRuleScanner:
    def test_a_nested_rule_gets_its_own_selector_and_its_parents(self):
        rules = leaf_rules('@layer components { .a { color: red; .b { color: blue } } } @import "x"; .c { gap: 1px }')

        assert [(r.selector, r.parents) for r in rules] == [('.b', ('@layer components', '.a')), ('.c', ())]

    def test_a_semicolon_inside_a_data_uri_does_not_split_the_declaration(self):
        pairs = declarations('--m: url("data:image/png;base64,AAAA"); @apply px-2 py-1; color: red !important')

        assert pairs == [('--m', 'url("data:image/png;base64,AAAA")'), ('@apply', 'px-2 py-1'), ('color', 'red')]


class TestTheLightTheme:
    def test_the_voc_v2_light_theme_is_read_beside_the_dark_default(self):
        default_name, modes = theme_modes(VOC_V2_CSS)

        assert default_name == 'kiro-dark'
        assert [m['name'] for m in modes] == ['kiro-light']
        light = {c['name']: (c['value'], c['default']) for c in modes[0]['colors']}
        assert light['bg'] == ('#ffffff', '#19161d')
        assert light['text-strong'] == ('#19161d', '#f2f1f4')
        assert light['accent-text'] == ('#723acc', '#bd8fff')
        assert 'accent' not in light, 'a colour the light theme keeps is not repeated'

    @pytest.mark.parametrize(('css', 'mode'), [
        (':root{--bg:#000} :root[data-mode=light]{--bg:#fff}', 'light'),
        (':root{--bg:#000} html.light{--bg:#fff}', 'light'),
        (':root{--bg:#fff} .dark{--bg:#000}', 'dark'),
        (":root{--bg:#fff} [data-theme='midnight']{--bg:#000}", 'midnight'),
        (':root{--bg:#fff} @media (prefers-color-scheme: dark){:root{--bg:#000}}', 'dark'),
    ])
    def test_each_way_of_writing_a_theme_variant_is_read(self, css, mode):
        assert theme_modes(css)[1][0]['name'] == mode

    def test_a_responsive_media_block_is_not_a_theme(self):
        assert theme_modes(':root{--bg:#fff} @media (min-width: 40rem){:root{--bg:#000}}') == ('', [])

    def test_the_guidelines_section_lists_each_changed_token(self):
        default_name, modes = theme_modes(VOC_V2_CSS)
        text = modes_markdown(modes, default_name)

        assert text.startswith('## Theme variants (read from the CSS)\n\nThe colour tokens are the `kiro-dark` theme.')
        assert '| bg | #ffffff | #19161d |' in text
        assert modes_markdown([], 'x') == ''


class TestComponentClasses:
    def test_the_button_variants_written_as_plain_classes_are_read(self):
        button = _components()['Button']

        assert list(button) == ['default', 'primary', 'secondary', 'ghost', 'danger', 'danger-solid']
        assert button['ghost']['styles']['color'] == '#938f9b'
        assert button['ghost']['hover'] == {'background': '#28242e', 'color': '#dcdadf', 'border_color': 'transparent'}
        assert button['secondary']['styles']['background'] == '#211d25'
        assert button['danger']['styles']['color'] == '#ff5f73'
        assert button['primary']['styles']['padding'] == '8px 14px', 'the base .btn @apply padding is inherited'

    def test_input_badge_tab_select_and_switch_are_read(self):
        found = _components()

        assert found['Input']['default']['styles']['border_color'] == '#77727f'
        assert found['Input']['default']['focus']['outline'] == '1px solid #8e48ff'
        badge_ok = found['Badge']['ok']['styles']
        assert (badge_ok['background'], badge_ok['color']) == ('rgba(0, 133, 67, .15)', '#1bb36b')
        assert found['Tab']['active']['styles']['color'] == '#bd8fff'
        assert found['Select']['default']['styles']['radius'] == '8px'
        assert found['Switch']['on']['styles']['background'] == '#8e48ff'

    def test_sizes_and_parts_are_not_variants(self):
        found = _components()

        assert 'sm' not in found['Button']
        assert list(found['Switch']) == ['default', 'on']

    def test_a_rule_inside_a_media_query_is_ignored(self):
        assert _components('.btn{color:#111} @media (min-width:1px){.btn-ghost{color:#222}}') == {
            'Button': {'default': {'name': 'default', 'styles': {'color': '#111'}}}}


class TestTheSvgLogo:
    @pytest.mark.parametrize(('paths', 'expected'), [
        (['web/public/kiro-ghost.svg', 'web/public/favicon.ico'], 'web/public/kiro-ghost.svg'),
        (['assets/brand/logo-mark.svg', 'web/public/a.svg'], 'assets/brand/logo-mark.svg'),
        (['web/public/a.svg', 'web/public/b.svg'], None),
        (['node_modules/x/public/a.svg'], None),
    ])
    def test_the_svg_logo_is_named(self, paths, expected):
        assert github_design.svg_logo_path(paths) == expected


def test_a_voc_v2_like_repository_yields_its_components_light_theme_and_logo_note():
    world = _world({TREE_HEAD: _tree(CSS_PATH, 'voc-datalake/frontend/public/kiro-ghost.svg'),
                    f'{CONTENTS}{CSS_PATH}': _Body(VOC_V2_CSS.encode())}, summary='{"summary": "Kiro"}')

    design = dr.extract(world.deps, {'kind': 'github', 'url': 'https://github.com/acme/ui'}).design

    assert design is not None
    names = {c['name']: [v['name'] for v in c.get('variants', [])] for c in design['components']}
    assert names['Button'] == ['default', 'primary', 'secondary', 'ghost', 'danger', 'danger-solid']
    assert {'Input', 'Badge', 'Tab', 'Select', 'Switch'} <= set(names)
    assert '| bg | #ffffff | #19161d |' in design['guidelines_md']
    assert 'logo is an SVG (`voc-datalake/frontend/public/kiro-ghost.svg`)' in design['guidelines_md']
    assert design['logo'] is None
    assert all('kiro-ghost.svg' not in url for url in world.urls()), 'an SVG is never downloaded'
    assert '"theme_variants": [{"name": "kiro-light"' in world.summarise.call_args.args[0]


def test_a_hostile_selector_of_repeated_pseudo_parts_is_matched_in_linear_time():
    """CodeQL py/redos: `.a:` followed by many `(:` backtracked exponentially in the class-part pattern."""
    import time

    from shared.css_component_rules import _CLASS_PART_RE

    hostile = '.a:' + '(:' * 5000 + '!'
    started = time.perf_counter()
    assert _CLASS_PART_RE.match(hostile) is None
    assert time.perf_counter() - started < 0.5
    ghost = _CLASS_PART_RE.match('.btn-ghost:not(:disabled):hover')
    tab = _CLASS_PART_RE.match('.tab')
    assert ghost is not None
    assert ghost.group(2) == ':not(:disabled):hover'
    assert tab is not None
    assert tab.group(2) == ''
