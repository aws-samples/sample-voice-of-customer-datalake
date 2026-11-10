/**
 * @fileoverview Tests for SentimentBadge component.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import SentimentBadge from './SentimentBadge'

describe('SentimentBadge', () => {
  describe('sentiment colors', () => {
    it('renders positive sentiment with the ok tone', () => {
      render(<SentimentBadge sentiment="positive" />)

      const badge = screen.getByText('Positive')
      expect(badge).toBeInTheDocument()
      expect(badge).toHaveClass('bg-ok-subtle', 'text-ok')
    })

    it('renders negative sentiment with the danger tone', () => {
      render(<SentimentBadge sentiment="negative" />)

      const badge = screen.getByText('Negative')
      expect(badge).toHaveClass('bg-danger-subtle', 'text-danger')
    })

    it('renders neutral sentiment with the muted tone', () => {
      render(<SentimentBadge sentiment="neutral" />)

      const badge = screen.getByText('Neutral')
      expect(badge).toHaveClass('bg-bg-hover', 'text-muted')
    })

    it('renders mixed sentiment with the warn tone', () => {
      render(<SentimentBadge sentiment="mixed" />)

      const badge = screen.getByText('Mixed')
      expect(badge).toHaveClass('bg-warn-subtle', 'text-warn')
    })

    it('reads an unknown sentiment as neutral, in words and in tone', () => {
      render(<SentimentBadge sentiment="unknown" />)

      const badge = screen.getByText('Neutral')
      expect(badge).toHaveClass('bg-bg-hover', 'text-muted')
    })
  })

  describe('label', () => {
    it('shows the translated label, never the raw stored value (verify10: "negative" on the dashboard)', () => {
      render(<SentimentBadge sentiment="negative" />)

      expect(screen.queryByText('negative')).not.toBeInTheDocument()
    })

    it('shows a given label instead, keeping the tone of the sentiment', () => {
      render(<SentimentBadge sentiment="negative" label="Mostly negative" />)

      expect(screen.getByText('Mostly negative')).toHaveClass('text-danger')
    })
  })

  describe('score display', () => {
    it('displays the signed score when provided', () => {
      render(<SentimentBadge sentiment="positive" score={0.85} />)

      expect(screen.getByText('Positive')).toBeInTheDocument()
      expect(screen.getByText('(+0.85)')).toBeInTheDocument()
    })

    it('formats score to two decimal places, with a real minus sign', () => {
      render(<SentimentBadge sentiment="negative" score={-0.123456} />)

      expect(screen.getByText('(\u22120.12)')).toBeInTheDocument()
    })

    it('does not display score when not provided', () => {
      render(<SentimentBadge sentiment="positive" />)

      expect(screen.queryByText(/\(/)).not.toBeInTheDocument()
    })
  })

  describe('size variants', () => {
    it('applies small size by default', () => {
      render(<SentimentBadge sentiment="positive" />)

      const badge = screen.getByText('Positive')
      expect(badge).toHaveClass('px-2', 'py-0.5', 'text-xs')
    })

    it('applies medium size when specified', () => {
      render(<SentimentBadge sentiment="positive" size="md" />)

      const badge = screen.getByText('Positive')
      expect(badge).toHaveClass('px-3', 'py-1', 'text-sm')
    })
  })
})
