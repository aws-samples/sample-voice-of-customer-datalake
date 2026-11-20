/**
 * @fileoverview The scraper editor's pieces on their own: each CSS selector field writes its key (an optional one
 * cleared reads as none), the advanced toggle says which way it goes, an analysis says its tone, confidence and
 * warnings, and the footer shows the save error and keeps Save off for a non-admin.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AnalyzeResultDisplay, CssSelectorToggle, CssSelectors, EditorFooter } from './ScraperEditorParts'
import type { ScraperConfig } from '../../api/types'

const CONFIG: ScraperConfig = {
  id: 's1', name: 'Shop reviews', enabled: true, base_url: 'https://shop.example.com', urls: [], frequency_minutes: 60,
  container_selector: '.review', text_selector: '.text', title_selector: '.title', rating_selector: '.stars',
  date_selector: 'time', author_selector: '.author',
  pagination: { enabled: false, param: 'page', max_pages: 1, start: 1 },
}

describe('the CSS selector fields', () => {
  it('write each selector, and an optional one cleared reads as none', () => {
    const setConfig = vi.fn<(config: ScraperConfig) => void>()
    render(<CssSelectors config={CONFIG} setConfig={setConfig} analyzeSuccess />)
    fireEvent.change(screen.getByLabelText('Review Container *'), { target: { value: '.card' } })
    fireEvent.change(screen.getByLabelText('Text Content *'), { target: { value: '.body' } })
    for (const label of ['Title', 'Rating', 'Date', 'Author']) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: '' } })
    }
    fireEvent.change(screen.getByLabelText('Rating'), { target: { value: '.score' } })
    expect(setConfig.mock.calls.map(([config]) => [config.container_selector,
      config.text_selector, config.title_selector, config.rating_selector, config.date_selector, config.author_selector]))
      .toStrictEqual([
        ['.card', '.text', '.title', '.stars', 'time', '.author'],
        ['.review', '.body', '.title', '.stars', 'time', '.author'],
        ['.review', '.text', undefined, '.stars', 'time', '.author'],
        ['.review', '.text', '.title', undefined, 'time', '.author'],
        ['.review', '.text', '.title', '.stars', undefined, '.author'],
        ['.review', '.text', '.title', '.stars', 'time', undefined],
        ['.review', '.text', '.title', '.score', 'time', '.author'],
      ])
    expect(screen.getByText('These selectors were auto-detected. Adjust if needed.')).toBeInTheDocument()
  })

  it('say they are the defaults when nothing was detected', () => {
    render(<CssSelectors config={{ ...CONFIG, title_selector: undefined }} setConfig={vi.fn()} />)
    expect(screen.getByText('These selectors were set to defaults. Adjust if needed.')).toBeInTheDocument()
  })
})

describe('the advanced toggle', () => {
  it('opens and closes the selectors, saying which', async () => {
    const setShowAdvanced = vi.fn()
    const { rerender } = render(<CssSelectorToggle showAdvanced={false} setShowAdvanced={setShowAdvanced} />)
    await userEvent.click(screen.getByRole('button', { name: /Advanced: which part of the page is a review/ }))
    rerender(<CssSelectorToggle showAdvanced setShowAdvanced={setShowAdvanced} />)
    await userEvent.click(screen.getByRole('button', { name: /Hide advanced settings/ }))
    expect(setShowAdvanced.mock.calls).toStrictEqual([[true], [false]])
  })
})

describe('an analysis', () => {
  it('says its tone, its confidence and its warnings', () => {
    const { rerender } = render(<AnalyzeResultDisplay result={{ success: true, message: 'Found 12 reviews', confidence: 'high',
      warnings: ['No dates found'] }} />)
    expect([screen.getByRole('status').dataset.tone, screen.getByText('Confidence: high').textContent,
      screen.getByText('No dates found').textContent]).toStrictEqual(['ok', 'Confidence: high', 'No dates found'])
    rerender(<AnalyzeResultDisplay result={{ success: false, empty: true, message: 'No review on the page' }} />)
    expect(screen.getByRole('status').dataset.tone).toBe('warn')
    rerender(<AnalyzeResultDisplay result={{ success: false, message: 'The page did not load' }} />)
    expect(screen.getByRole('status').dataset.tone).toBe('danger')
  })
})

describe('the footer', () => {
  it('shows the save error, cancels, and keeps Save off for a non-admin', async () => {
    const onCancel = vi.fn()
    render(<EditorFooter saveError="Not saved" isSaving={false} isAdmin={false} onSave={vi.fn()} onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect([screen.getByRole('alert').textContent, screen.getByRole('button', { name: /Save Scraper/ }).hasAttribute('disabled'),
      onCancel.mock.calls.length]).toStrictEqual(['Not saved', true, 1])
  })
})
