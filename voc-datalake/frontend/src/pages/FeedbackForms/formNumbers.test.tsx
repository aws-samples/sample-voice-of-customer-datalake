/**
 * @fileoverview The Feedback Forms card and its submissions dialog write their
 * figures in the app language: grouped counts ("26,622") and the average with
 * the locale's decimal mark (pl "4,5"); the submission time is a locale date.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useLocale } from '../../test/i18n-locale'
import feedbackFormsPl from '../../../public/locales/pl/feedbackForms.json'
import { createQueryWrapper } from './feedback-forms-fixtures'

const stats = { total_submissions: 26622, avg_rating: 4.5, rating_count: 20480 }

vi.mock('../../api/client', () => ({
  api: {
    getFeedbackFormStats: () => Promise.resolve({ stats }),
    getFeedbackFormSubmissions: () => Promise.resolve({
      stats,
      submissions: [{
        feedback_id: 'fb_1', original_text: 'Quick delivery', rating: 5, sentiment_label: 'positive',
        category: '', persona_name: '', created_at: '2026-10-18T09:05:00Z',
      }],
    }),
    getCategoriesConfig: () => Promise.resolve({ categories: [] }),
  },
}))

import FormCard from './FormCard'
import SubmissionsModal from './SubmissionsModal'
import { defaultFormConfig } from './formTemplates'

const form = {
  ...defaultFormConfig, form_id: 'form_1', name: 'Website', enabled: true,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}
const noop = () => {}

function renderCard() {
  return render(
    <FormCard form={form} onEdit={noop} onDelete={noop} onToggle={noop} apiEndpoint="https://api.example.com" statsRefreshing={false} />,
    { wrapper: createQueryWrapper() },
  )
}

function renderModal() {
  return render(<SubmissionsModal formId="form_1" formName="Website" onClose={noop} />, { wrapper: createQueryWrapper() })
}

describe('Feedback Forms numbers in English', () => {
  it('groups the submission count on the card', async () => {
    renderCard()
    expect(await screen.findByText('26,622')).toBeInTheDocument()
    expect(screen.getByText('4.5')).toBeInTheDocument()
  })

  it('groups the dialog figures and writes the submission time as a locale date', async () => {
    renderModal()
    expect(await screen.findByText('26,622')).toBeInTheDocument()
    expect(screen.getByText('20,480')).toBeInTheDocument()
    expect(screen.getByText(/Oct 18, 2026/)).toBeInTheDocument()
  })
})

describe('Feedback Forms numbers in Polish', () => {
  useLocale('pl', { feedbackForms: feedbackFormsPl })

  it('writes the card average with a decimal comma', async () => {
    renderCard()
    expect(await screen.findByText('4,5')).toBeInTheDocument()
    expect(screen.getByText('26 622')).toBeInTheDocument()
  })

  it('writes the dialog average with a decimal comma', async () => {
    renderModal()
    expect(await screen.findByText('4,5')).toBeInTheDocument()
  })
})
