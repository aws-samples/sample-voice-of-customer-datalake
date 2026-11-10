/** The Administration section switch: WAI-ARIA tabs with arrow / Home / End keys and a roving tab stop. */
import { describe, expect, it } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Layers, Plug, Radar } from 'lucide-react'
import { SectionSwitch } from './SectionSwitch'
import type { SectionItem } from './SectionSwitch'

type Id = 'a' | 'b' | 'c'

const SECTIONS: readonly SectionItem<Id>[] = [
  { id: 'a', label: 'Alpha', icon: Plug },
  { id: 'b', label: 'Beta', icon: Layers },
  { id: 'c', label: 'Gamma', icon: Radar },
]

function Harness({ sections = SECTIONS }: Readonly<{ sections?: readonly SectionItem<Id>[] }>) {
  const [active, setActive] = useState<Id>('a')
  return <SectionSwitch sections={sections} active={active} onSelect={setActive} label="Sources" />
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

  it('is a named tablist with one tab stop, on the selected tab', () => {
    render(<Harness />)

    expect(screen.getByRole('tablist', { name: 'Sources' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab').map((tab) => tab.tabIndex)).toStrictEqual([0, -1, -1])
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
