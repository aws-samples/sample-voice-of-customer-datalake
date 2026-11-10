import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RadioCard from './RadioCard'

function renderPair(checked: 'a' | 'b', onSelect = vi.fn()) {
  render(
    <fieldset>
      <legend>Pick one</legend>
      <RadioCard name="pair" value="a" checked={checked === 'a'} onSelect={onSelect} title="Option A" hint="First" />
      <RadioCard name="pair" value="b" checked={checked === 'b'} onSelect={onSelect} title="Option B" hint="Second" textTestId="b-text" />
    </fieldset>,
  )
  return onSelect
}

describe('RadioCard', () => {
  it('labels its radio with the title and hint', () => {
    renderPair('a')
    expect(screen.getByRole('radio', { name: /Option A\s*First/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Option B\s*Second/ })).not.toBeChecked()
  })

  it('reports its own value when chosen, by clicking anywhere on the card', async () => {
    const onSelect = renderPair('a')
    await userEvent.setup().click(screen.getByText('Second'))
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  it('shares one radio group through name and accents only the chosen card', () => {
    renderPair('b')
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('name'))).toStrictEqual(['pair', 'pair'])
    expect(screen.getByTestId('b-text').closest('label')).toHaveClass('border-accent')
    expect(screen.getByText('First').closest('label')).not.toHaveClass('border-accent')
  })
})
