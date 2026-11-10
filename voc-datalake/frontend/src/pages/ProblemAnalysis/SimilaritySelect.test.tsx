/**
 * The Problem Analysis "Similarity" select has a real accessible name (its visible
 * label), not just a `title` — a production audit reported it unlabelled — and says
 * what its levels do.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { SimilaritySelect } from './SimilaritySelect'

const label = () => i18n.t('problemAnalysis:filters.similarity')

describe('SimilaritySelect', () => {
  it('is named by its visible label', () => {
    render(<SimilaritySelect value="med" onChange={vi.fn()} />)

    const select = screen.getByRole('combobox', { name: label() })
    expect(document.getElementById(select.getAttribute('aria-labelledby') ?? '')).toHaveTextContent(label())
  })

  it('reports the chosen level', async () => {
    const onChange = vi.fn()
    render(<SimilaritySelect value="med" onChange={onChange} />)

    await userEvent.setup().selectOptions(
      screen.getByRole('combobox', { name: label() }),
      i18n.t('problemAnalysis:filters.similarityHigh'),
    )

    expect(onChange).toHaveBeenCalledWith('high')
  })

  it('explains Low / Medium / High / Off in a tooltip and as the description', () => {
    render(<SimilaritySelect value="med" onChange={vi.fn()} />)
    const hint = i18n.t('problemAnalysis:filters.similarityLevelsHint')

    expect(screen.getByTestId('similarity-hint')).toHaveAttribute('title', hint)
    expect(screen.getByRole('combobox', { name: label() })).toHaveAccessibleDescription(hint)
  })
})
