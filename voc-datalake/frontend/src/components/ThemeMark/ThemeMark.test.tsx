import { describe, it, expect, afterEach } from 'vitest'
import { act, render } from '@testing-library/react'
import ThemeMark, { ThemeMarkIdle, ThemeMarkThinking } from './ThemeMark'
import { useThemeStore } from '../../theme/themeStore'
import { COLOR_THEME_IDS, WORKSPACE_THEME_CHOICE, DEFAULT_COLOR_THEME } from '../../theme/themeCatalog'
import type { ColorThemeId } from '../../theme/themeCatalog'
import type { ReactElement } from 'react'

function pick(theme: ColorThemeId): void {
  act(() => { useThemeStore.setState({ colorTheme: theme }) })
}

function svgOf(ui: ReactElement): SVGSVGElement {
  const svg = render(ui).container.querySelector('svg')
  if (svg === null) throw new Error('no svg rendered')
  return svg
}

afterEach(() => {
  act(() => { useThemeStore.setState({ colorTheme: WORKSPACE_THEME_CHOICE, workspaceTheme: DEFAULT_COLOR_THEME }) })
})

const POSES = [
  ['ThemeMark', (cls: string) => <ThemeMark className={cls} />],
  ['ThemeMarkIdle', (cls: string) => <ThemeMarkIdle className={cls} />],
  ['ThemeMarkThinking', (cls: string) => <ThemeMarkThinking className={cls} />],
] as const

describe.each(POSES)('%s', (_name, make) => {
  it.each(COLOR_THEME_IDS)('renders the %s mark, decorative, with the caller class', (theme) => {
    pick(theme)
    const svg = svgOf(make('h-5 w-5 text-aim'))
    expect([svg.dataset.mark, svg.getAttribute('aria-hidden'), svg.getAttribute('focusable')]).toStrictEqual([theme, 'true', 'false'])
    expect(svg.querySelector('title')).toBeNull()
    expect(svg).toHaveClass('h-5', 'w-5', 'text-aim')
  })
})

describe('theme selection', () => {
  it('shows the Kiro ghost by default (the workspace theme)', () => {
    const svg = svgOf(<ThemeMark />)
    expect(svg).toHaveAttribute('data-mark', 'kiro')
    expect(svg.getAttribute('viewBox')).toBe('210 80 805 1030')
  })

  it('follows the workspace theme when the person keeps "workspace"', () => {
    act(() => { useThemeStore.setState({ colorTheme: WORKSPACE_THEME_CHOICE, workspaceTheme: 'dracula' }) })
    expect(svgOf(<ThemeMark />)).toHaveAttribute('data-mark', 'dracula')
  })

  it('switches live when the theme changes', () => {
    const { container } = render(<ThemeMark />)
    expect(container.querySelector('svg')).toHaveAttribute('data-mark', 'kiro')
    pick('nord')
    expect(container.querySelector('svg')).toHaveAttribute('data-mark', 'nord')
  })

  it.each(['nord', 'dracula', 'highcontrast'] as const)('draws %s in currentColor only', (theme) => {
    pick(theme)
    const svg = svgOf(<ThemeMark />)
    const paints = [...svg.querySelectorAll('path, circle, g')]
      .flatMap((el) => [el.getAttribute('fill'), el.getAttribute('stroke')])
      .filter((v): v is string => v !== null)
    expect(new Set(paints)).toStrictEqual(new Set(['currentColor']))
  })

  it('outlines the Quick spark in its own gradient tokens, never the palette or hex literals', () => {
    pick('quick')
    const svg = svgOf(<ThemeMark />)
    const stops = [...svg.querySelectorAll('stop')].map((s) => s.style.getPropertyValue('stop-color'))
    expect(stops).toStrictEqual(['var(--mark-quick-from)', 'var(--mark-quick-via)', 'var(--mark-quick-to)'])
    expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  it('gives each Quick spark its own gradient id', () => {
    pick('quick')
    const { container } = render(<><ThemeMark /><ThemeMark /></>)
    const ids = [...container.querySelectorAll('linearGradient')].map((g) => g.id)
    expect(new Set(ids).size).toBe(2)
    expect(container.querySelector('[data-spark]')?.getAttribute('stroke')).toBe(`url(#${ids[0]})`)
  })

  it('draws the Quick spark in currentColor, without a gradient, on a filled surface', () => {
    pick('quick')
    const svg = svgOf(<ThemeMark onFill />)
    expect(svg.querySelector('linearGradient')).toBeNull()
    expect(svg.querySelector('[data-spark]')?.getAttribute('stroke')).toBe('currentColor')
  })
})

describe('thinking motion', () => {
  it.each(['kiro', 'nord', 'dracula', 'highcontrast'] as const)('%s floats, stopped under reduced motion', (theme) => {
    pick(theme)
    expect(svgOf(<ThemeMarkThinking />)).toHaveClass('animate-float', 'motion-reduce:animate-none')
  })

  it('quick spins its spark instead, stopped under reduced motion', () => {
    pick('quick')
    const svg = svgOf(<ThemeMarkThinking />)
    expect(svg.getAttribute('class') ?? '').not.toContain('animate')
    expect(svg.querySelector('[data-spark]')).toHaveClass('animate-mark-spin', 'motion-reduce:animate-none')
  })

  it.each(COLOR_THEME_IDS)('the static and idle %s marks stay still', (theme) => {
    pick(theme)
    const { container } = render(<><ThemeMark /><ThemeMarkIdle /></>)
    expect(container.innerHTML).not.toContain('animate')
  })
})
