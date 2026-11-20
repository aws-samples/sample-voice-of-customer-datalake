/** The Administration section switch (main's, 7.59.00 again): WAI-ARIA tabs with arrow / Home / End keys and a roving tab stop. */
import { describe, expect, it } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Layers, Plug, Radar } from 'lucide-react'
import { SectionSwitch } from './SectionSwitch'

type Id = 'a' | 'b' | 'c'

const SECTIONS: readonly Id[] = ['a', 'b', 'c']
const ICONS = { a: Plug, b: Layers, c: Radar } as const
const LABELS: Readonly<Record<Id, string>> = { a: 'Alpha', b: 'Beta', c: 'Gamma' }

function Harness({ sections = SECTIONS }: Readonly<{ sections?: readonly Id[] }>) {
  const [active, setActive] = useState<Id>('a')
  return <SectionSwitch sections={sections} icons={ICONS} labelOf={(id) => LABELS[id]} active={active} onSelect={setActive}
    label="Sources" tabId={(id) => `tab-${id}`} />
}

/** Focuses Alpha, presses `keys`, and returns the selected, focused tab. */
async function press(keys: string) {
  const user = userEvent.setup()
  render(<Harness />)
  await user.click(screen.getByRole('tab', { name: 'Alpha' }))
  await user.keyboard(keys)
  return screen.getByRole('tab', { selected: true })
}

describe('SectionSwitch', () => {
  // Live finding: at 390 px the strip clipped "Radar" with no sign there was more.
  it('wraps onto a second row instead of clipping on a narrow screen', () => {
    render(<Harness />)

    expect(screen.getByRole('tablist', { name: 'Sources' })).toHaveClass('flex-wrap')
  })

  it('is a named tablist with one tab stop, on the selected tab, each tab controlling the section panel', () => {
    render(<Harness />)

    expect(screen.getByRole('tablist', { name: 'Sources' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab').map((tab) => tab.tabIndex)).toStrictEqual([0, -1, -1])
    expect(screen.getAllByRole('tab').map((tab) => [tab.id, tab.getAttribute('aria-controls')])).toStrictEqual([
      ['tab-a', 'admin-section-panel'], ['tab-b', 'admin-section-panel'], ['tab-c', 'admin-section-panel'],
    ])
  })

  it.each([
    ['{ArrowRight}', 'Beta'],
    ['{ArrowDown}{ArrowDown}', 'Gamma'],
    ['{ArrowLeft}', 'Gamma'],
    ['{ArrowRight}{ArrowRight}{ArrowRight}', 'Alpha'],
    ['{End}', 'Gamma'],
    ['{End}{Home}', 'Alpha'],
  ])('%s selects and focuses %s', async (keys, expected) => {
    const selected = await press(keys)

    expect(selected).toHaveTextContent(expected)
    expect(selected).toHaveFocus()
  })

  it('ignores other keys', async () => {
    const selected = await press('{Enter}x')

    expect(selected).toHaveTextContent('Alpha')
  })

  it('renders nothing for a single section', () => {
    render(<Harness sections={SECTIONS.slice(0, 1)} />)

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })
})
