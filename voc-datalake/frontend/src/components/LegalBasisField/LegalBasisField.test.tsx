import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import LegalBasisField from './LegalBasisField'

describe('LegalBasisField', () => {
  it('shows the hint and no error for a valid basis', () => {
    render(<LegalBasisField value="GDPR art. 17 request #123" onChange={vi.fn()} />)
    expect(screen.getByRole('textbox', { name: 'Legal basis' })).toHaveAttribute('aria-invalid', 'false')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['Request from someone@example.com', 'call +44 20 7946 0958'])('refuses contact data in %j', (value) => {
    render(<LegalBasisField value={value} onChange={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: 'Legal basis' })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Remove the email address or phone number')
    expect(input).toHaveAccessibleDescription(/Remove the email address or phone number.*Why this data is deleted/u)
  })
})
