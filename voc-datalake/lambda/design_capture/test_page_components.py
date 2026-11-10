"""page_components.py: measured samples and state rules → contract components (pure)."""
import page_components as pc
import pytest


@pytest.mark.parametrize(('key', 'value', 'expected'), [
    ('font_size', '13.3333px', '13.33px'), ('padding', '4px 8px 4px 8px', '4px 8px'), ('padding', '2px 2px 2px 2px', '2px'),
    ('padding', '1px 2px 3px 4px', '1px 2px 3px 4px'), ('gap', '0px', None), ('height', 'auto', None),
    ('shadow', 'none', None), ('color', '', None), ('border_width', '0px', '0px'),
])
def test_values_are_normalised(key, value, expected):
    assert pc._normalise(key, value) == expected


@pytest.mark.parametrize(('selector', 'kind'), [
    ('.btn:hover', 'buttons'), ('button.primary:focus-visible', 'buttons'), ('a:hover', 'links'),
    ('nav a:hover', 'links'), ('.card:hover', 'cards'), ('[role="tab"]:focus', 'tabs'), ('input:focus', 'inputs'),
    ('.chip:hover', 'badges'), ('.hero:hover', None),
])
def test_rule_kinds(selector, kind):
    assert pc._rule_kind(selector) == kind


def test_a_rule_only_styles_samples_its_subject_matches():
    assert pc._rule_applies('.btn-primary:hover', 'buttons', {'btn', 'btn-primary'})
    assert not pc._rule_applies('.btn-primary:hover', 'buttons', {'btn'})
    assert pc._rule_applies('button:hover', 'buttons', set(), 'button')
    assert not pc._rule_applies('button:hover', 'buttons', {'copy'}, 'a')
    assert pc._rule_applies('[role="tab"]:focus', 'tabs', set(), 'div')
    assert not pc._rule_applies('.btn:hover::before, .btn:focus-visible::before', 'buttons', {'btn'}, 'a')
    assert not pc._rule_applies('.site-nav a:hover', 'buttons', {'btn'}, 'button')


def test_rules_are_capped_and_filtered():
    rows = [{'selector': 'a:hover', 'state': 'hover', 'styles': {'color': 'red', 'cursor': 'pointer'}}] * 40
    rows.append({'selector': 'a:active', 'state': 'active', 'styles': {'color': 'red'}})
    parsed = pc.parse_rules(rows)
    assert len(parsed) == 30
    assert parsed[0] == {'selector': 'a:hover', 'state': 'hover', 'styles': {'color': 'red'}}
    assert pc.parse_rules([{'selector': 'a:hover', 'state': 'hover', 'styles': {}}, 'x']) == []
