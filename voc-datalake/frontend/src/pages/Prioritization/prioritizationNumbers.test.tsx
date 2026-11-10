/**
 * @fileoverview The Prioritization row writes its figures in the app language:
 * the linked form's grouped count and average, and the team score, spread and
 * per-axis means with the locale's decimal mark (pl "4,5").
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { renderWithQueryClient } from '../../test/query-client'
import { useLocale } from '../../test/i18n-locale'
import prioritizationPl from '../../../public/locales/pl/prioritization.json'

vi.mock('../../api/client', () => ({
  api: {
    getFeedbackFormStats: () => Promise.resolve({ stats: { total_submissions: 26622, avg_rating: 4.5, rating_count: 20000 } }),
  },
}))

import LinkedFormEvidence from './LinkedFormEvidence'
import { DisagreementBadge, TeamScorePanel, TeamScoreSummary } from './RowTeamScore'
import { DEFAULT_AXES } from '../../api/prioritizationAxes'
import type { TeamView } from './teamScore'

const forms = [{ form_id: 'form_1', name: 'Concept test', project_id: 'p1', document_id: 'doc_1' }]
const team: TeamView = {
  kind: 'scored',
  team: { displayComposite: 4.5, displayAxes: { impact: 3.5 }, reviewerCount: 1200, spread: 1.5 },
}

describe('Prioritization numbers in English', () => {
  it('groups the linked form submission count', async () => {
    renderWithQueryClient(<LinkedFormEvidence forms={forms} apiEndpoint="https://api.example.com" />)
    expect(await screen.findByText('26,622')).toBeInTheDocument()
    expect(screen.getByText('4.5')).toBeInTheDocument()
  })

  it('groups the reviewer count in the team summary', () => {
    render(<TeamScorePanel team={team} />)
    expect(screen.getByText(/Team average 4\.5 of 5 · Reviewer ballots: 1,200/)).toBeInTheDocument()
  })
})

describe('Prioritization numbers in Polish', () => {
  useLocale('pl', { prioritization: prioritizationPl })

  it('writes the linked form average with a decimal comma', async () => {
    renderWithQueryClient(<LinkedFormEvidence forms={forms} apiEndpoint="https://api.example.com" />)
    expect(await screen.findByText('4,5')).toBeInTheDocument()
  })

  it('writes the team score and spread with a decimal comma', () => {
    render(<><TeamScorePanel team={team} /><DisagreementBadge team={team} /></>)
    expect(screen.getByText(/4,5/)).toBeInTheDocument()
    expect(screen.getByText('Rozrzut 1,5')).toBeInTheDocument()
    expect(screen.getByText(/różnią się w tej ocenie o 1,5/)).toBeInTheDocument()
  })

  it('writes the per-metric team means with a decimal comma', () => {
    render(<TeamScoreSummary team={team} axes={DEFAULT_AXES} />)
    expect(screen.getByText('3,5')).toBeInTheDocument()
  })
})
