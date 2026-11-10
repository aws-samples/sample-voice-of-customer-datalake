/**
 * @fileoverview A form's figures follow the app language: grouped counts, the
 * average with the locale's decimal mark, and an em dash (never 0) for "not
 * loaded" and "no ratings".
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useLocale } from '../../test/i18n-locale'
import FormStatsFigures from './FormStatsFigures'

const labels = { submissions: 'Submissions', avgRating: 'Avg rating', rated: 'Rated' }
const stats = { total_submissions: 26622, avg_rating: 4.5, rating_count: 20480 }

describe('FormStatsFigures', () => {
  it('groups the counts and gives the average one decimal (compact)', () => {
    render(<FormStatsFigures variant="compact" stats={stats} labels={labels} />)
    expect(screen.getByText('26,622')).toBeInTheDocument()
    expect(screen.getByText('4.5')).toBeInTheDocument()
    expect(screen.queryByText('Rated')).not.toBeInTheDocument()
  })

  it('adds the rated count in the panel', () => {
    render(<FormStatsFigures variant="panel" stats={stats} labels={labels} />)
    expect(screen.getByText('20,480')).toBeInTheDocument()
    expect(screen.getByText('Rated')).toBeInTheDocument()
  })

  it('shows dashes while loading and for a form without ratings, never 0', () => {
    const { rerender } = render(<FormStatsFigures variant="compact" stats={undefined} labels={labels} />)
    expect(screen.getAllByText('—')).toHaveLength(2)
    rerender(<FormStatsFigures variant="compact" stats={{ total_submissions: 3, avg_rating: null, rating_count: 0 }} labels={labels} />)
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(1)
    expect(screen.queryByText('0.0')).not.toBeInTheDocument()
  })
})

describe('FormStatsFigures in Polish', () => {
  useLocale('pl', {})

  it('writes the average with a decimal comma and groups the count with a space', () => {
    render(<FormStatsFigures variant="panel" stats={stats} labels={labels} />)
    expect(screen.getByText('4,5')).toBeInTheDocument()
    expect(screen.getByText('26 622')).toBeInTheDocument()
  })
})
