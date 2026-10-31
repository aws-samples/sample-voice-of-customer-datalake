"""A feedback form's theme is a closed object of hex colours and a pixel radius (FE-2, shared/form_theme.py)."""
import pytest

from shared.exceptions import ValidationError
from shared.form_theme import validate_theme


@pytest.mark.parametrize('theme', [
    {'primary_color': '#8e48ff', 'background_color': '#FFF', 'text_color': '#19161dcc', 'border_radius': '8px'},
    {},
    {'primary_color': None},
], ids=['full', 'empty', 'null-colour'])
def test_a_hex_theme_is_accepted(theme):
    validate_theme({'theme': theme})


def test_a_body_without_a_theme_is_not_checked():
    validate_theme({'name': 'Form'})


@pytest.mark.parametrize(('theme', 'message'), [
    ('red', 'theme must be an object'),
    ({'primary_color': 'red;position:fixed;inset:0;background:url(https://evil.example/x)'}, 'theme.primary_color'),
    ({'background_color': 'rgb(0,0,0)'}, 'theme.background_color'),
    ({'text_color': 12}, 'theme.text_color'),
    ({'primary_color': '#8e48ff;'}, 'theme.primary_color'),
    ({'border_radius': '8px;position:fixed'}, 'theme.border_radius'),
    ({'font': 'Comic Sans'}, 'unknown fields: font'),
], ids=['not-an-object', 'css-injection', 'rgb', 'number', 'trailing-semicolon', 'radius-injection', 'unknown-field'])
def test_anything_that_could_reach_style_text_unchecked_is_refused(theme, message):
    with pytest.raises(ValidationError, match=message):
        validate_theme({'theme': theme})
