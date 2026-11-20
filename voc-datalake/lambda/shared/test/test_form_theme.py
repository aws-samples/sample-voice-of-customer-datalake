"""A feedback form's theme (shared/form_theme.py): a closed object of hex colours, a pixel radius and three closed
choices (FE-2), read with its defaults, and judged by the contrast rules the editor and the widget share."""
import pytest

from shared.exceptions import ValidationError
from shared.form_theme import (
    VOC_DARK,
    VOC_LIGHT,
    contrast_ratio,
    default_theme,
    shown_palettes,
    text_contrast_problem,
    validate_theme,
    with_defaults,
)

FULL = {
    'primary_color': '#8e48ff', 'background_color': '#FFF', 'text_color': '#19161dcc', 'border_radius': '8px',
    'mode': 'auto', 'dark': {'primary_color': '#bd8fff', 'background_color': '#19161d', 'text_color': '#F2F1F4'},
    'font': 'rounded', 'text_size': 'large',
}


@pytest.mark.parametrize('theme', [
    FULL,
    {'primary_color': '#8e48ff', 'background_color': '#FFF', 'text_color': '#19161dcc', 'border_radius': '8px'},
    {},
    {'primary_color': None, 'mode': None, 'dark': None},
    {'dark': {}},
    {'font': 'inherit'},
    {'border_radius': '99px'},
], ids=['every-field', 'before-7-55-01', 'empty', 'nulls', 'empty-dark', 'page-font', 'largest-radius'])
def test_a_documented_theme_is_accepted_unchanged(theme):
    body = {'theme': dict(theme)}
    validate_theme(body)
    assert body == {'theme': theme}


def test_a_body_without_a_theme_is_not_checked():
    body = {'name': 'Form'}
    validate_theme(body)
    assert body == {'name': 'Form'}


@pytest.mark.parametrize(('theme', 'message'), [
    ('red', 'theme must be an object'),
    ({'primary_color': 'red;position:fixed;inset:0;background:url(https://evil.example/x)'}, 'theme.primary_color'),
    ({'background_color': 'rgb(0,0,0)'}, 'theme.background_color'),
    ({'text_color': 12}, 'theme.text_color'),
    ({'primary_color': '#8e48ff;'}, 'theme.primary_color'),
    ({'border_radius': '8px;position:fixed'}, 'theme.border_radius'),
    ({'border_radius': '100px'}, 'theme.border_radius'),
    ({'font_family': 'Comic Sans'}, 'unknown fields: font_family'),
    ({'font': 'Comic Sans'}, 'theme.font must be one of: system, inherit, serif, rounded, mono'),
    ({'font': ['system']}, 'theme.font must be one of'),
    ({'mode': 'sepia'}, 'theme.mode must be one of: light, dark, auto'),
    ({'text_size': 'huge'}, 'theme.text_size must be one of: default, large'),
    ({'dark': '#000000'}, 'theme.dark must be an object'),
    ({'dark': {'primary_color': '#000', 'border_radius': '4px'}}, 'theme.dark has unknown fields: border_radius'),
    ({'dark': {'text_color': '#f2f1f4cc'}}, 'theme.dark.text_color'),
    ({'dark': {'background_color': 'black;x:y'}}, 'theme.dark.background_color'),
], ids=['not-an-object', 'css-injection', 'rgb', 'number', 'trailing-semicolon', 'radius-injection', 'radius-100',
        'unknown-field', 'font-name', 'font-list', 'mode', 'text-size', 'dark-not-object', 'dark-unknown',
        'dark-alpha', 'dark-injection'])
def test_anything_that_could_reach_style_text_unchecked_is_refused(theme, message):
    with pytest.raises(ValidationError, match=message):
        validate_theme({'theme': theme})


class TestReadWithDefaults:
    def test_the_default_is_voc_light_shown_with_voc_dark_beside_it(self):
        assert default_theme() == {
            'primary_color': '#8e48ff', 'background_color': '#ffffff', 'text_color': '#19161d', 'border_radius': '8px',
            'mode': 'light', 'dark': {'primary_color': '#bd8fff', 'background_color': '#19161d', 'text_color': '#f2f1f4'},
            'font': 'system', 'text_size': 'default',
        }
        assert default_theme()['dark'] is not default_theme()['dark']

    def test_a_theme_stored_before_7_55_01_answers_its_new_fields_with_the_defaults(self):
        stored = {'primary_color': '#123456', 'background_color': '#fafafa', 'text_color': '#111', 'border_radius': '0px'}
        assert with_defaults(stored) == {**default_theme(), **stored}

    @pytest.mark.parametrize('stored', [None, 'red', [], {}], ids=['absent', 'string', 'list', 'empty'])
    def test_no_theme_reads_as_the_default(self, stored):
        assert with_defaults(stored) == default_theme()

    def test_an_unusable_value_reads_as_its_default_and_a_partial_dark_palette_is_filled(self):
        stored = {'primary_color': 'red', 'border_radius': '8em', 'mode': 'sepia', 'font': 7,
                  'dark': {'text_color': '#eeeeee', 'primary_color': 'url(x)'}}
        assert with_defaults(stored) == {**default_theme(), 'dark': {**VOC_DARK, 'text_color': '#eeeeee'}}

    def test_the_stored_theme_is_not_changed(self):
        stored = {'dark': {'text_color': '#eeeeee'}}
        with_defaults(stored)
        assert stored == {'dark': {'text_color': '#eeeeee'}}


class TestShownPalettes:
    def test_each_mode_shows_its_palettes(self):
        assert shown_palettes({}) == [('light', VOC_LIGHT)]
        assert shown_palettes({'mode': 'dark'}) == [('dark', VOC_DARK)]
        assert [name for name, _ in shown_palettes({'mode': 'auto'})] == ['light', 'dark']


class TestContrast:
    @pytest.mark.parametrize(('foreground', 'background', 'ratio'), [
        ('#19161d', '#ffffff', 17.89),
        ('#ffffff', '#8e48ff', 4.64),
        ('#f2f1f4', '#19161d', 15.90),
        ('#bd8fff', '#19161d', 7.27),
        ('#9ca3af', '#fff', 2.54),
        ('#f5c518', '#ffffff', 1.63),
        ('#000', '#000', 1.0),
    ])
    def test_the_wcag_ratio(self, foreground, background, ratio):
        assert contrast_ratio(foreground, background) == pytest.approx(ratio, abs=0.01)

    def test_an_old_translucent_colour_is_judged_as_the_widget_draws_it(self):
        """The shared vector (also in frontend theme/contrast.test.ts and feedbackWidget.theme.test.ts): the widget
        draws #19161d80 on #ffffff00 as #19161d on #ffffff, its alpha dropped, so that is the 17.89:1 judged here
        (composited, the text would be 3.42:1 and refused while the widget shows it at 17.89)."""
        assert contrast_ratio('#19161d80', '#ffffff00') == pytest.approx(17.89, abs=0.01)
        assert contrast_ratio('#ffffff80', '#ffffff') == pytest.approx(1.0, abs=0.01)

    def test_anything_that_is_not_hex_is_not_judged(self):
        assert contrast_ratio('red', '#ffffff') is None
        assert contrast_ratio('#000', 'white') is None

    def test_only_text_under_3_to_1_is_a_publish_problem(self):
        assert text_contrast_problem({'text_color': '#9ca3af', 'background_color': '#ffffff'}) == pytest.approx(2.54,
                                                                                                                  abs=0.01)
        assert text_contrast_problem({'text_color': '#767676', 'background_color': '#ffffff'}) is None  # 4.54
        assert text_contrast_problem({'text_color': '#949494', 'background_color': '#ffffff'}) is None  # 3.03
