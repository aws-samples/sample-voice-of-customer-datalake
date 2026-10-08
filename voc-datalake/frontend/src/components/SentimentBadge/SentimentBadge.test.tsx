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
      
      const badge = screen.getByText('positive')
      expect(badge).toBeInTheDocument()
      expect(badge).toHaveClass('bg-ok-subtle', 'text-ok')
    })

    it('renders negative sentiment with the danger tone', () => {
      render(<SentimentBadge sentiment="negative" />)
      
      const badge = screen.getByText('negative')
      expect(badge).toHaveClass('bg-danger-subtle', 'text-danger')
    })

    it('renders neutral sentiment with the muted tone', () => {
      render(<SentimentBadge sentiment="neutral" />)
      
      const badge = screen.getByText('neutral')
      expect(badge).toHaveClass('bg-bg-hover', 'text-muted')
    })

    it('renders mixed sentiment with the warn tone', () => {
      render(<SentimentBadge sentiment="mixed" />)
      
      const badge = screen.getByText('mixed')
      expect(badge).toHaveClass('bg-warn-subtle', 'text-warn')
    })

    it('falls back to neutral styling for unknown sentiment', () => {
      render(<SentimentBadge sentiment="unknown" />)
      
      const badge = screen.getByText('unknown')
      expect(badge).toHaveClass('bg-bg-hover', 'text-muted')
    })
  })

  describe('score display', () => {
    it('displays score when provided', () => {
      render(<SentimentBadge sentiment="positive" score={0.85} />)
      
      expect(screen.getByText('positive')).toBeInTheDocument()
      expect(screen.getByText('(0.85)')).toBeInTheDocument()
    })

    it('formats score to two decimal places', () => {
      render(<SentimentBadge sentiment="negative" score={0.123456} />)
      
      expect(screen.getByText('(0.12)')).toBeInTheDocument()
    })

    it('does not display score when not provided', () => {
      render(<SentimentBadge sentiment="positive" />)
      
      expect(screen.queryByText(/\(/)).not.toBeInTheDocument()
    })
  })

  describe('size variants', () => {
    it('applies small size by default', () => {
      render(<SentimentBadge sentiment="positive" />)
      
      const badge = screen.getByText('positive')
      expect(badge).toHaveClass('px-2', 'py-0.5', 'text-xs')
    })

    it('applies medium size when specified', () => {
      render(<SentimentBadge sentiment="positive" size="md" />)
      
      const badge = screen.getByText('positive')
      expect(badge).toHaveClass('px-3', 'py-1', 'text-sm')
    })
  })
})
