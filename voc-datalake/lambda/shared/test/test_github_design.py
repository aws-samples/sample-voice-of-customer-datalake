"""shared/github_design.py: the tree ranking picks the design files over the README."""
import pytest

from shared import github_design as gd

KIROCREW_TREE = [
    'README.md', 'CHANGELOG.md', 'src/kiro_crew/static/kirocrew-logo.png', 'site/public/kirocrew-logo.svg',
    'site/public/kirocrew-logo.png', 'website/src/styles/design-tokens.css', 'website/src/tailwind-theme.css',
    'website/src/styles/theme-palettes.css', 'website/src/styles/font-faces.css', 'website/src/index.css',
    'website/src/components/ui/button.tsx', 'website/src/components/ui/dropdown-menu.tsx',
    'website/src/components/ui/button.test.tsx', 'website/src/components/ui/index.ts',
    'website/src/components/ui/tabs/index.tsx', 'docs/system-specs/modules/themes.md',
    'src/auth/access-token.ts', 'website/node_modules/pkg/tokens.css', 'website/dist/app.min.css',
    'website/src/App.tsx', 'website/electron/token-acquire.js', 'website/src/model_tokens.json',
    'semgrep/contextvar-token-reset.yaml', 'website/electron/runtime/gateway/token-sources.js',
]


class TestRankDesignFiles:
    def test_kirocrew_design_files_in_priority_order_without_readme(self):
        assert gd.rank_design_files(KIROCREW_TREE) == [
            'website/src/styles/design-tokens.css', 'website/src/tailwind-theme.css',
            'website/src/styles/theme-palettes.css', 'website/src/styles/font-faces.css', 'website/src/index.css',
            'docs/system-specs/modules/themes.md',
        ]

    def test_readme_only_when_nothing_else_shallowest_first(self):
        assert gd.rank_design_files(['pkg/README.md', 'README.md', 'src/a.py']) == ['README.md']
        assert gd.rank_design_files(['src/a.py']) == []

    def test_limit_and_base_path(self):
        files = [f'styles/{i:02d}.css' for i in range(15)]
        assert len(gd.rank_design_files(files)) == 12
        assert gd.rank_design_files(['a/theme.css', 'ab/theme.css'], 'a') == ['a/theme.css']

    @pytest.mark.parametrize(('path', 'expected'), [
        ('tokens.json', 0), ('brand-token.dark.yml', 0), ('tailwind.config.ts', 3), ('.kiro/steering/design.md', 5),
        ('tokens.base.json', 0), ('design_tokens.ts', 0), ('design.tokens.json', 0),
        ('tokenizer.js', None), ('access-token.ts', None), ('src/main.ts', None), ('styles/x.scss', 6),
        ('token-acquire.js', None), ('model_tokens.json', None), ('contextvar-token-reset.yaml', None),
        ('token.js', None), ('mytokens.json', None), ('tokens.md', None), ('token-sources.js', None),
        ('.kiro/specs/app-builder-kit/design.md', None), ('design.md', 5), ('docs/design-system.md', 5),
        ('packages/ui/design-system.md', 5),
    ])
    def test_rank(self, path, expected):
        assert gd._rank(path) == expected


def test_component_names_are_readable_unique_and_skip_tests():
    assert gd.component_names(KIROCREW_TREE) == ['Button', 'Dropdown menu', 'Tabs']


def test_logo_prefers_a_public_png_never_svg():
    assert gd.logo_path(KIROCREW_TREE) == 'site/public/kirocrew-logo.png'
    assert gd.logo_path(['a/logo.svg']) is None
    assert gd.logo_content_type('x/logo.JPG') == 'image/jpeg'


def test_component_files_follow_the_priority_list_within_the_limit():
    tree = ['website/src/components/ui/tabs.tsx', 'website/src/components/ui/dialog.tsx',
            'website/src/components/ui.tsx', 'website/src/components/ui/popover.tsx',
            'website/src/components/ui/button.test.tsx', 'node_modules/x/components/ui/button.tsx',
            'apps/a/components/ui/button/index.tsx', 'website/src/components/ui/select.tsx']
    assert gd.component_files(tree) == [
        'website/src/components/ui.tsx', 'apps/a/components/ui/button/index.tsx', 'website/src/components/ui/tabs.tsx',
        'website/src/components/ui/dialog.tsx', 'website/src/components/ui/select.tsx']
    assert gd.component_files(tree, limit=2) == ['website/src/components/ui.tsx', 'apps/a/components/ui/button/index.tsx']
    assert gd.component_files(tree, 'apps/a') == ['apps/a/components/ui/button/index.tsx']
