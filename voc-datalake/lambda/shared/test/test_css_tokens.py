"""shared/css_tokens.py: design tokens read from CSS custom properties, without a model."""
from pathlib import Path

from shared.css_tokens import custom_properties, tokens_from_css, tokens_from_properties

FIXTURE = (Path(__file__).parent / 'fixtures' / 'kirocrew_like_tokens.css').read_text(encoding='utf-8')


class TestCustomProperties:
    def test_first_declaration_wins_and_comments_are_ignored(self):
        props = custom_properties('/* --color-x: #000; */ :root{--a:#111} .dark{--a:#222}')
        assert props == {'a': '#111'}

    def test_var_references_resolve_and_important_is_dropped(self):
        props = custom_properties(':root{--b:var(--a);--a:#123 !important;--c:var(--missing, 4px);--d:var(--nope)}')
        assert props == {'a': '#123', 'b': '#123', 'c': '4px', 'd': 'var(--nope)'}

    def test_reference_cycles_end(self):
        assert custom_properties(':root{--a:var(--b);--b:var(--a)}')['a'].startswith('var(')


class TestKiroCrewLikeFixture:
    def test_colours_by_role_with_the_light_theme_first(self):
        colors = {c['name']: c['value'] for c in tokens_from_css(FIXTURE)['colors']}
        assert colors == {
            'primary': '#7c3aed', 'primary-foreground': '#ffffff', 'surface': 'oklch(0.98 0.01 290)',
            'text': 'rgb(17 17 27)', 'accent': '#7c3aed', 'border-muted': 'hsl(250 10% 85%)', 'danger': '#ef4444',
        }

    def test_typography_roles_skip_weights_and_sizes(self):
        assert tokens_from_css(FIXTURE)['typography'] == [
            {'role': 'body', 'family': '"Space Grotesk", system-ui, sans-serif'},
            {'role': 'mono', 'family': '"JetBrains Mono", ui-monospace, monospace'},
            {'role': 'display', 'family': '"Space Grotesk", system-ui, sans-serif'},
        ]

    def test_radius_and_spacing(self):
        tokens = tokens_from_css(FIXTURE)
        assert tokens['radius'] == [{'name': 'radius-sm', 'value': '4px'}, {'name': 'radius-card', 'value': '0.75rem'},
                                    {'name': 'radius-pill', 'value': '9999px'}]
        assert tokens['spacing'] == [{'name': 'space-2', 'value': '0.5rem'}, {'name': 'spacing-section', 'value': '48px'}]

    def test_values_the_editor_refuses_are_left_out(self):
        flat = str(tokens_from_css(FIXTURE))
        for refused in ('javascript', 'cubic-bezier', 'inherit', 'shadow'):
            assert refused not in flat


def test_bare_keywords_are_not_design_colours():
    assert tokens_from_properties({'color-x': 'transparent', 'y': 'red'})['colors'] == []
