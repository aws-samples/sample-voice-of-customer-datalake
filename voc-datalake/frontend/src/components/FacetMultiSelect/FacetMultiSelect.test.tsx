import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FacetMultiSelect from './FacetMultiSelect'

function renderSelect(selected: string[] = [], onToggle = vi.fn(), onClear = vi.fn()) {
  render(
    <div>
      <FacetMultiSelect label="Source" allLabel="All sources" options={['web', 'app']} selected={selected}
        onToggle={onToggle} onClear={onClear} display={(value) => value.toUpperCase()} />
      <button type="button">outside</button>
    </div>,
  )
  return { onToggle, onClear }
}

describe('FacetMultiSelect', () => {
  it('names the facet and says "all" with nothing checked', () => {
    renderSelect()
    expect(screen.getByRole('button', { name: 'Source: All sources' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('says the one value, or how many are checked', () => {
    renderSelect(['web'])
    expect(screen.getByRole('button', { name: 'Source: WEB' })).toBeInTheDocument()
  })

  it('opens a labelled checkbox group and toggles the raw value', async () => {
    const user = userEvent.setup()
    const { onToggle } = renderSelect(['app'])
    await user.click(screen.getByRole('button', { name: 'Source: APP' }))

    expect(screen.getByRole('group', { name: 'Source' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'APP' })).toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: 'WEB' }))
    expect(onToggle).toHaveBeenCalledWith('web')
  })

  it('clears from the panel when something is checked', async () => {
    const user = userEvent.setup()
    const { onClear } = renderSelect(['web', 'app'])
    await user.click(screen.getByRole('button', { name: 'Source: 2 selected' }))
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onClear).toHaveBeenCalledWith()
  })

  it('closes on Escape with focus back on the button, and on a click outside', async () => {
    const user = userEvent.setup()
    renderSelect()
    const button = screen.getByRole('button', { name: 'Source: All sources' })
    await user.click(button)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(button).toHaveFocus()

    await user.click(button)
    await user.click(screen.getByRole('button', { name: 'outside' }))
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })
})
