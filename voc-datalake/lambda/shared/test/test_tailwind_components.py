"""shared/tailwind_components.py: component styles read from UI sources without a model.

The ``ui.tsx`` fixture is modelled on KiroCrew's ``website/src/components/ui.tsx`` (ternary-chain
``Btn``, a ``Record`` map for ``IconButton``, a ``variant === …`` chain for ``Badge``); the
``button.tsx`` one on the shadcn/ui ``cva`` button.
"""
import pytest

from shared.css_tokens import custom_properties
from shared.design_components import clean_components
from shared.tailwind_components import Theme, components_from_source, styles_from_classes

CSS = """
:root { --accent: #00d492; --accent-fg: #000; --accent-hover: #34d399; --accent-glow: rgba(4,117,84,.4);
        --border: #27272a; --border-strong: #3f3f46; --text: #e4e4e7; --muted: #7f7f88; --bg-hover: #262a35;
        --card: #181b22; --danger: #f87171; --ok-subtle: rgba(34,197,94,.12); --ok-text: #22c55e;
        --theme-font-sans: 'Space Grotesk'; }
@theme { --color-accent: var(--accent); --color-accent-fg: var(--accent-fg); --color-accent-hover: var(--accent-hover);
         --color-border: var(--border); --color-border-strong: var(--border-strong); --color-text: var(--text);
         --color-muted: var(--muted); --color-bg-hover: var(--bg-hover); --color-card: var(--card);
         --color-danger: var(--danger); --color-ok-subtle: var(--ok-subtle); --color-ok-text: var(--ok-text);
         --radius-md: 8px; --radius-lg: 12px;
         --font-body: var(--theme-font-sans, var(--script-fallbacks), -apple-system, sans-serif);
         --font-mono: var(--theme-font-mono, 'JetBrains Mono', monospace); }
"""
UI_TSX = """
import { twMerge } from 'tailwind-merge'

export function Card({ children, className = '', ...rest }) {
  const inset = [ownsX ? '' : 'px-2 md:px-5', ownsY ? '' : 'py-5'].filter(Boolean).join(' ')
  return <div className={twMerge(`card-glow border border-border bg-card rounded-lg ${inset} mb-4 shadow-sm`, className)} />
}

export const Btn = React.forwardRef(({ children, danger, primary, className, ...rest }, ref) => (
    <button
      className={twMerge(`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[13px] font-body md:px-4 ${
        primary
          ? 'bg-accent text-accent-fg border-accent hover:bg-accent-hover hover:shadow-[0_0_12px_var(--accent-glow)]'
          : danger
            ? 'border-border bg-transparent text-danger hover:border-danger'
            : 'border-border bg-transparent text-text hover:border-border-strong hover:bg-bg-hover'
      }`, className)}
    />
))

const ICON_BUTTON_VARIANTS: Record<'default' | 'accent', string> = {
  default: 'text-muted hover:text-text hover:bg-bg-hover',
  accent: 'text-muted hover:text-accent hover:bg-bg-hover',
}

export const IconButton = React.forwardRef(({ variant = 'default', className }, ref) => (
    <button className={twMerge('p-[4px] rounded bg-transparent border-none', ICON_BUTTON_VARIANTS[variant], className)} />
))

export function Badge({ variant, children, className }) {
  const cls =
    variant === 'ok' ? 'bg-ok-subtle text-ok-text'
    : variant === 'err' ? 'bg-danger text-accent-fg'
    : 'bg-bg-hover text-muted'
  return <span className={twMerge(`inline-flex gap-1 px-2 py-[2px] rounded-full text-[13px] font-medium font-mono uppercase ${cls}`, className)} />
}

export function useThing() { return 'bg-accent text-text' }
"""
BUTTON_TSX = """
import { cva } from "class-variance-authority"

const buttonVariants = cva(
  "inline-flex items-center gap-2 rounded-md text-sm font-medium h-9 px-4 py-2",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-fg hover:bg-accent-hover",
        outline: "border bg-transparent border-border text-text hover:bg-bg-hover",
        ghost: "hover:bg-bg-hover text-text",
      },
      size: { sm: "h-8 px-3", lg: "h-10 px-6" },
    },
    defaultVariants: { variant: "default" },
  }
)

export function Button({ className, variant, size, ...props }) {
  return <button className={cn(buttonVariants({ variant, size, className }))} {...props} />
}
"""


@pytest.fixture(scope='module')
def theme() -> Theme:
    return Theme(custom_properties(CSS))


def _by_name(components: list[dict]) -> dict[str, dict]:
    return {c['name']: c for c in components}


class TestKiroCrewLikeSource:
    def test_ternary_chain_becomes_variants_with_hover(self, theme):
        button = _by_name(components_from_source(UI_TSX, 'website/src/components/ui.tsx', theme))['Button']
        primary, danger, default = button['variants']
        assert [primary['name'], danger['name'], default['name']] == ['primary', 'danger', 'default']
        assert primary['styles'] == {
            'gap': '6px', 'radius': '8px', 'border_width': '1px', 'font_size': '13px',
            'font_family': "'Space Grotesk'", 'background': '#00d492', 'color': '#000',
            'border_color': '#00d492', 'padding': '4px 10px'}
        assert primary['hover'] == {'background': '#34d399', 'shadow': '0 0 12px rgba(4,117,84,.4)'}
        assert (danger['styles']['color'], danger['hover']) == ('#f87171', {'border_color': '#f87171'})
        assert default['hover'] == {'border_color': '#3f3f46', 'background': '#262a35'}

    def test_record_map_and_variant_equals_chain(self, theme):
        found = _by_name(components_from_source(UI_TSX, 'ui.tsx', theme))
        assert [v['name'] for v in found['Icon button']['variants']] == ['default', 'accent']
        assert found['Icon button']['variants'][1]['hover'] == {'color': '#00d492', 'background': '#262a35'}
        assert found['Icon button']['variants'][0]['styles']['padding'] == '4px'
        badge = found['Badge']['variants']
        assert [v['name'] for v in badge] == ['ok', 'err', 'default']
        assert badge[0]['styles']['radius'] == '9999px'
        assert badge[0]['styles']['text_transform'] == 'uppercase'

    def test_the_richest_literal_is_the_base_and_hooks_are_not_components(self, theme):
        found = _by_name(components_from_source(UI_TSX, 'ui.tsx', theme))
        assert found['Card']['variants'][0]['styles'] == {
            'border_width': '1px', 'border_color': '#27272a', 'background': '#181b22', 'radius': '12px',
            'shadow': '0 1px 3px rgb(0 0 0 / 10%), 0 1px 2px -1px rgb(0 0 0 / 10%)'}
        assert list(found) == ['Card', 'Button', 'Icon button', 'Badge']

    def test_everything_survives_the_contract_validator(self, theme):
        raw = components_from_source(UI_TSX, 'ui.tsx', theme)
        assert clean_components(raw) == raw


class TestCvaSource:
    def test_cva_variants_and_the_file_name(self, theme):
        [button] = components_from_source(BUTTON_TSX, 'src/components/ui/button.tsx', theme)
        assert button['name'] == 'Button'
        assert [v['name'] for v in button['variants']] == ['default', 'outline', 'ghost']
        assert button['variants'][0]['styles'] == {
            'gap': '8px', 'radius': '8px', 'font_size': '14px', 'font_weight': '500', 'height': '36px',
            'background': '#00d492', 'color': '#000', 'padding': '8px 16px'}
        assert button['variants'][1]['styles']['border_color'] == '#27272a'
        assert button['variants'][2]['hover'] == {'background': '#262a35'}

    def test_a_kebab_file_names_its_single_component(self, theme):
        source = 'export function X() { return <nav className="flex gap-4 bg-card px-4 h-12" /> }'
        assert components_from_source(source, 'components/ui/nav-bar.tsx', theme)[0]['name'] == 'Nav bar'


class TestMapping:
    @pytest.mark.parametrize(('classes', 'styles'), [
        ('px-4 py-2', {'padding': '8px 16px'}),
        ('p-3', {'padding': '12px'}),
        ('pt-1 px-2 pb-3', {'padding': '4px 8px 12px 8px'}),
        ('rounded', {'radius': '4px'}),
        ('rounded-[10px]', {'radius': '10px'}),
        ('tracking-tight font-semibold', {'letter_spacing': '-0.025em', 'font_weight': '600'}),
        ('text-white bg-transparent', {'color': 'white', 'background': 'transparent'}),
        ('border-2', {'border_width': '2px'}),
        ('normal-case', {'text_transform': 'none'}),
        ('min-h-9', {'height': '36px'}),
    ])
    def test_utilities(self, theme, classes, styles):
        assert styles_from_classes(classes, theme)[0] == styles

    @pytest.mark.parametrize('classes', [
        'md:px-4', 'dark:bg-accent', 'bg-accent/10', 'bg-blue-500', 'active:scale-95', 'border-t-2',
        'text-${tone}', 'disabled:opacity-30', 'focus-visible:ring-2',
    ])
    def test_unmapped_utilities_are_left_out(self, theme, classes):
        assert styles_from_classes(classes, theme) == ({}, {})

    def test_unknown_var_without_fallback_is_removed(self, theme):
        assert theme.resolve_vars('var(--nope), Inter') == 'Inter'
        assert theme.resolve_vars('var(--nope)') == ''
