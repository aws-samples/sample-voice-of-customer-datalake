/**
 * @fileoverview IconBadge: tone class, a hidden 12 / 10 px icon, the label, a spinner and pass-through attributes.
 * @module components/IconBadge
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { IconBadge } from './IconBadge'

function badgeOf(label: string): HTMLElement {
  const badge = screen.getByText(label).closest('span')
  if (badge === null) throw new TypeError(`no badge around "${label}"`)
  return badge
}

describe('IconBadge', () => {
  it('draws a toned badge with the label', () => {
    render(<IconBadge toneClass="badge-ok" icon={CheckCircle2}>Completed</IconBadge>)
    const badge = badgeOf('Completed')
    expect(badge).toHaveClass('badge', 'badge-ok', 'inline-flex', 'items-center', 'gap-1')
    expect(badge).toHaveTextContent(/^Completed$/)
  })

  it('puts a hidden, still 12 px icon first', () => {
    render(<IconBadge toneClass="badge-ok" icon={CheckCircle2}>Completed</IconBadge>)
    const badge = badgeOf('Completed')
    const icon = badge.querySelector('svg')
    expect(badge.firstChild).toBe(icon)
    expect(icon).toHaveAttribute('aria-hidden', 'true')
    expect(icon).toHaveAttribute('width', '12')
    expect(icon).not.toHaveClass('animate-spin')
  })

  it('takes the 10 px size for the small inline flags', () => {
    render(<IconBadge toneClass="badge-danger" icon={CheckCircle2} iconSize={10}>Flagged</IconBadge>)
    expect(badgeOf('Flagged').querySelector('svg')).toHaveAttribute('width', '10')
  })

  it('spins the icon when asked', () => {
    render(<IconBadge toneClass="badge-muted" icon={Loader2} spin>Testing</IconBadge>)
    expect(badgeOf('Testing').querySelector('svg')).toHaveClass('animate-spin')
  })

  it('shows the label alone without an icon', () => {
    render(<IconBadge toneClass="badge-muted" spin>Ready</IconBadge>)
    expect(badgeOf('Ready').querySelector('svg')).toBeNull()
  })

  it('adds layout classes and passes span attributes through', () => {
    render(
      <IconBadge toneClass="badge-info" icon={CheckCircle2} className="flex-shrink-0" title="Why" role="status" data-testid="b">
        Public
      </IconBadge>,
    )
    const badge = screen.getByTestId('b')
    expect(badge).toHaveClass('badge', 'badge-info', 'flex-shrink-0')
    expect(badge).toHaveAttribute('title', 'Why')
    expect(screen.getByRole('status')).toBe(badge)
  })
})
