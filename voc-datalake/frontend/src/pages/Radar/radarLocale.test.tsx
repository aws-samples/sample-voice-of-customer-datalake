/**
 * Radar in Polish (verify10): "W porównaniu z nami" read "4 opinii" / "2 opinii" / "23 opinii"
 * (the review counts were not i18next plurals, so every count took the genitive plural), and
 * the brand totals read "Zrównoważone (+0.08)" with an English decimal point.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { useLocale } from '@test/i18n-locale'
import { defined } from '@test/defined'
import { sortedStrings } from '@test/stringLists'
import radarPl from '../../../public/locales/pl/radar.json'
import dashboardPl from '../../../public/locales/pl/dashboard.json'
import BrandSentiment from './BrandSentiment'
import CompareTable from './CompareTable'
import { normalizeRadarPage } from '../../api/radarSchema'

const side = (volume: number) => ({ volume, positive_share: 0.5, negative_share: 0.2 })
const row = (category: string, theirs: number, ours: number) => ({ category, theirs: side(theirs), ours: side(ours), verdict: 'similar' })

/** Polish needs four forms: 1 opinia · 2–4, 22–24 opinie · 5–21, 25… opinii. */
const PAGE = normalizeRadarPage({
  compare: { ours_available: true, categories: [row('delivery', 4, 23), row('pricing', 2, 5), row('support', 1, 22)] },
  detail: {
    brand: { key: 'acme', label: 'Acme', domains: ['acme.example'] }, total: 3, avg_sentiment: 0.08,
    trend: [], love: [], hate: [],
  },
})
const COMPARE = PAGE.compare
const DETAIL = defined(PAGE.detail ?? undefined, 'radar detail fixture')

describe('Radar in Polish', () => {
  useLocale('pl', { radar: radarPl, dashboard: dashboardPl })

  it('counts the compared reviews with the Polish plural forms', () => {
    renderWithQueryClient(<MemoryRouter><CompareTable compare={COMPARE} onRead={vi.fn()} /></MemoryRouter>)
    const counts = ['4 opinie', '23 opinie', '2 opinie', '5 opinii', '1 opinia', '22 opinie']
    expect(counts.filter((text) => screen.queryByText(text) === null)).toStrictEqual([])
    expect(screen.queryByText('4 opinii')).not.toBeInTheDocument()
  })

  it('writes the brand totals with a plural count and the Polish decimal comma', () => {
    renderWithQueryClient(<MemoryRouter><BrandSentiment detail={DETAIL} onRead={vi.fn()} /></MemoryRouter>)
    expect(screen.getByText(/^3 opinie · .*\(\+0,08\)$/u)).toBeInTheDocument()
  })

  it('carries every Polish plural category for the review counts it uses', () => {
    const categories = new Intl.PluralRules('pl').resolvedOptions().pluralCategories
    const keys = Object.keys(radarPl.compare).filter((key) => key.startsWith('volume_')).map((key) => key.slice('volume_'.length))
    expect(sortedStrings(keys)).toStrictEqual(sortedStrings(categories))
    expect(Object.keys(radarPl.totals).filter((key) => key.startsWith('reviews_'))).toHaveLength(categories.length)
  })
})
