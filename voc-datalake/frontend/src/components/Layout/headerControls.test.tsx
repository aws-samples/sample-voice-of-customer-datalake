/**
 * @fileoverview Header control contract (owner request, wave 6). On /dashboard
 * the time-range group was 39 px tall centred at y=37, the theme toggle 30 px
 * with an 8 px radius and the avatar a 36 px circle centred at y=30: three
 * heights, two centre lines, two shapes. jsdom has no layout, so this pins the
 * classes that give every header control one height (`.header-control`, 2.25rem)
 * and the two round buttons one shape (`.header-icon-btn`). The live geometry was
 * measured with Playwright against the running app.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TestRouter } from '../../test/TestRouter'
import ThemeToggle from '../ThemeToggle/ThemeToggle'
import ProfileMenu from '../ProfileMenu/ProfileMenu'
import TimeRangeSelector from '../TimeRangeSelector/TimeRangeSelector'

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    timeRange: '7d', setTimeRange: vi.fn(), customDays: null, setCustomDays: vi.fn(), dateBasis: 'imported', setDateBasis: vi.fn(),
  }),
}))

// Accessible names of the header controls (en).
const BASIS_BUTTON = 'Filter dates by: Imported date'
const PHONE_TRIGGER = /^Time range:/
const THEME_BUTTON = /theme — switch to/
const AVATAR_BUTTON = 'Account menu for E2E admin'

const INDEX_CSS = readFileSync(resolve(__dirname, '../../index.css'), 'utf8')

/** The declarations of a header recipe in index.css, e.g. `header-control`. */
const headerRecipe = (name: string): string => new RegExp(`\\n {2}\\.${name} \\{([^}]*)\\}`).exec(INDEX_CSS)?.[1] ?? ''

function renderHeaderControls() {
  render(
    <TestRouter initialEntries={['/']}>
      <TimeRangeSelector />
      <ThemeToggle />
      <ProfileMenu user={{ username: 'e2e-admin', name: 'E2E admin' }} isAdmin={false} onSignOut={vi.fn()} />
    </TestRouter>,
  )
}

describe('header control recipes', () => {
  it('one control height in rem (2.25rem = 36 px), a minimum so a wrapped label is never cut', () => {
    expect(headerRecipe('header-control')).toMatch(/@apply min-h-9\b/)
  })

  it('round icon buttons are 2.25rem circles with a 1px border', () => {
    const iconBtn = headerRecipe('header-icon-btn')
    expect(iconBtn).toMatch(/\bh-9 w-9 min-h-9\b/)
    expect(iconBtn).toMatch(/\brounded-full border\b/)
  })
})

describe('the time range never runs past the header edge (wave 7: "Custo…" cut at 1440 px + 200 % text)', () => {
  it('a wrapped preset line keeps the control height: 2.25rem minus the track padding and border', () => {
    expect(headerRecipe('header-tab')).toMatch(/min-height: calc\(2rem - 2px\);/)
  })

  it('the selector wraps (basis picker over the presets) and is capped at its column', () => {
    renderHeaderControls()
    expect(screen.getByTestId('time-range-selector')).toHaveClass('flex-wrap', 'max-w-full', 'min-w-0')
  })

  it('the preset group wraps its presets inside the group instead of scrolling them out of view', () => {
    renderHeaderControls()
    const group = screen.getByRole('group', { name: 'Time range' })
    expect(group).toHaveClass('flex-wrap')
    const presets = Array.from(group.querySelectorAll('button'))
    expect(presets.filter((preset) => !preset.classList.contains('header-tab'))).toStrictEqual([])
  })
})

describe('header controls share the height and shape tokens', () => {
  it('the date-basis button and the time-range group are header controls', () => {
    renderHeaderControls()
    expect(screen.getByRole('button', { name: BASIS_BUTTON })).toHaveClass('header-control')
    // `items-stretch` + `py-0` tabs: the group is exactly the control height, not 39 px.
    expect(screen.getByRole('group', { name: 'Time range' })).toHaveClass('header-control', 'items-stretch')
    expect(screen.getByRole('button', { name: '7d' })).toHaveClass('py-0')
  })

  it('the phone time-range trigger is a header control, not a 44 px one', () => {
    renderHeaderControls()
    const trigger = screen.getByRole('button', { name: PHONE_TRIGGER })
    expect(trigger).toHaveClass('header-control')
    expect(trigger).not.toHaveClass('min-h-[44px]')
  })

  it('the theme toggle and the avatar are the same round icon button', () => {
    renderHeaderControls()
    const theme = screen.getByRole('button', { name: THEME_BUTTON })
    const avatar = screen.getByRole('button', { name: AVATAR_BUTTON })
    expect([theme, avatar].map((el) => el.classList.contains('header-icon-btn'))).toStrictEqual([true, true])
    // The old shapes: an 8 px `icon-btn` square and a ring (box-shadow) instead of a border.
    const classes = [...theme.classList, ...avatar.classList]
    expect(classes.filter((name) => name === 'icon-btn' || name.startsWith('ring-'))).toStrictEqual([])
  })
})

// Wave 7: the date-basis button had no border and the avatar an accent-tinted one, while the
// range group and theme toggle had the neutral `--border`. The border now lives in the recipes.
describe('every header control has the same neutral 1px border', () => {
  it('both recipes carry `border border-border`; hover darkens it, an open menu turns it accent', () => {
    expect(headerRecipe('header-control')).toMatch(/@apply min-h-9 border border-border;/)
    expect(headerRecipe('header-icon-btn')).toMatch(/\brounded-full border border-border\b/)
    expect(INDEX_CSS).toMatch(/button\.header-control:hover, \.header-icon-btn:hover \{ @apply border-border-strong; \}/)
    expect(INDEX_CSS).toMatch(/button\.header-control\[aria-expanded="true"\], \.header-icon-btn\[aria-expanded="true"\] \{ @apply border-accent; \}/)
  })

  it('no header control overrides the border colour at rest (the avatar keeps its accent initials only)', () => {
    renderHeaderControls()
    const controls = [BASIS_BUTTON, PHONE_TRIGGER, THEME_BUTTON, AVATAR_BUTTON].map((name) => screen.getByRole('button', { name }))
    const overrides = controls.flatMap((el) => [...el.classList].filter((name) => /^(hover:)?border-(?!border$)/.test(name)))
    expect(overrides).toStrictEqual([])
    expect(controls.map((el) => el.classList.contains('header-control') || el.classList.contains('header-icon-btn'))).toStrictEqual([true, true, true, true])
  })

  it('the date-basis button has a filled background like the other controls, not a bare label', () => {
    renderHeaderControls()
    expect(screen.getByRole('button', { name: BASIS_BUTTON })).toHaveClass('bg-bg-elevated')
  })
})
