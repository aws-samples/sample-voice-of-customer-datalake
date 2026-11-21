/**
 * @fileoverview The Feedback Forms card writes its figures in the app language: a grouped response count
 * ("26,622", pl "26 622") and the average with the locale's decimal mark (pl "4,5").
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useLocale } from '../../test/i18n-locale'
import feedbackFormsPl from '../../../public/locales/pl/feedbackForms.json'
import { createQueryWrapper } from './feedback-forms-fixtures'
import { formatCount } from '../../utils/numberFormat'

// (the card's figure is the server's `headline`: here the first question's average rating)
const stats = {
  total_submissions: 26622, avg_rating: 4.5, rating_count: 20480,
  headline: { type: 'rating', value: 4.5, count: 20480, scale_max: 5 },
}

vi.mock('../../api/client', () => ({
  api: {
    getFeedbackFormStats: () => Promise.resolve({ stats }),
  },
}))

import FormCard from './FormCard'
import { normalizeFeedbackForms } from './formSchema'
import { defined } from '../../test/defined'

const form = defined(normalizeFeedbackForms([{
  form_id: 'form_1', name: 'Website', enabled: true, rating_enabled: true, rating_type: 'stars', rating_max: 5, language: 'en',
}])[0], 'form')
const noop = vi.fn()

function renderCard() {
  const Wrapper = createQueryWrapper()
  return render(
    <Wrapper>
      <MemoryRouter>
        <FormCard form={form} onDelete={noop} onToggle={noop} apiEndpoint="https://api.example.com" statsRefreshing={false} />
      </MemoryRouter>
    </Wrapper>,
  )
}

describe('Feedback Forms numbers in English', () => {
  it('groups the response count and writes the average with a decimal point', async () => {
    renderCard()
    expect(await screen.findByText('26,622 responses')).toBeInTheDocument()
    expect(screen.getByText(/4\.5/)).toBeInTheDocument()
  })
})

describe('Feedback Forms numbers in Polish', () => {
  useLocale('pl', { feedbackForms: feedbackFormsPl })

  it('groups the count the Polish way and writes the average with a decimal comma', async () => {
    renderCard()
    // (the matcher folds the locale's no-break space to a plain one)
    expect(await screen.findByText(new RegExp(formatCount(26622, 'pl').replace(/\s/gu, ' ')))).toBeInTheDocument()
    expect(screen.getByText(/4,5/)).toBeInTheDocument()
  })
})
