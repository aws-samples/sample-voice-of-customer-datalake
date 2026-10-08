import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import i18n from 'i18next'
import {
  getSentimentScoreColorClass,
  NEUTRAL_CHART_STEP,
  categoryChartSteps,
  chartStepPrintHex,
  chartStepVar,
  matchesRatingFilter,
  ratingFilterLabel,
  ANY_RATING_FILTER,
} from './types'
import { at } from '@test/defined'

const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8')

/** `--chart-N` hexes declared inside one `[data-theme="…"]` block of index.css. */
function chartRampOf(theme: 'kiro-dark' | 'kiro-light'): Map<number, string> {
  const start = css.indexOf(`[data-theme="${theme}"]`)
  const block = css.slice(start, css.indexOf('}', start))
  const ramp = new Map<number, string>()
  for (const m of block.matchAll(/--chart-(\d):\s*(#[0-9a-f]{6})/g)) ramp.set(Number(m[1]), at(m, 2))
  return ramp
}

const KNOWN_CATEGORIES = [
  'flight_operations', 'in_flight_experience', 'customer_service', 'baggage_handling',
  'booking_and_check_in', 'pricing_and_fees', 'loyalty_program', 'airport_facilities',
  'delivery', 'customer_support', 'product_quality', 'pricing', 'website', 'app', 'billing',
  'returns', 'communication', 'other',
]

/** `var(--chart-N)` → N */
function stepOf(cssVar: string): number {
  const m = /^var\(--chart-([1-8])\)$/.exec(cssVar)
  expect(m, `${cssVar} is not a ramp step`).not.toBeNull()
  return Number(m?.[1])
}

describe('types utilities', () => {
  describe('getSentimentScoreColorClass', () => {
    it('returns green for positive scores above 20', () => {
      expect(getSentimentScoreColorClass(21)).toBe('text-sentiment-positive')
      expect(getSentimentScoreColorClass(50)).toBe('text-sentiment-positive')
      expect(getSentimentScoreColorClass(100)).toBe('text-sentiment-positive')
    })

    it('returns red for negative scores below -20', () => {
      expect(getSentimentScoreColorClass(-21)).toBe('text-sentiment-negative')
      expect(getSentimentScoreColorClass(-50)).toBe('text-sentiment-negative')
      expect(getSentimentScoreColorClass(-100)).toBe('text-sentiment-negative')
    })

    it('returns gray for neutral scores between -20 and 20', () => {
      expect(getSentimentScoreColorClass(0)).toBe('text-text')
      expect(getSentimentScoreColorClass(20)).toBe('text-text')
      expect(getSentimentScoreColorClass(-20)).toBe('text-text')
      expect(getSentimentScoreColorClass(10)).toBe('text-text')
    })
  })

  describe('category ramp colours', () => {
    /** The step `categoryChartSteps` gives `name` when it is the only category on the chart. */
    const soloStep = (name: string) => categoryChartSteps([name]).get(name)

    it('maps every known category to a fixed ramp step', () => {
      const pinned = ['delivery', 'customer_support', 'pricing', 'app', 'flight_operations']
      expect(Object.fromEntries(pinned.map((name) => [name, chartStepVar(soloStep(name) ?? 0)]))).toStrictEqual({
        delivery: 'var(--chart-1)',
        customer_support: 'var(--chart-2)',
        pricing: 'var(--chart-4)',
        app: 'var(--chart-7)',
        flight_operations: 'var(--chart-1)',
      })
      for (const name of KNOWN_CATEGORIES) stepOf(chartStepVar(soloStep(name) ?? 0))
    })

    it('keeps a known category on its step whatever else is on the chart', () => {
      const steps = categoryChartSteps(['zebrafin_cartridges', 'app', 'subscriptions', 'delivery'])
      expect(steps.get('app')).toBe(7)
      expect(steps.get('delivery')).toBe(1)
    })

    it('puts `other` on the neutral grey step (--chart-6 = --muted), and no known category', () => {
      expect(soloStep('other')).toBe(NEUTRAL_CHART_STEP)
      expect(NEUTRAL_CHART_STEP).toBe(6)
      for (const name of KNOWN_CATEGORIES.filter(n => n !== 'other')) {
        expect(soloStep(name), `${name} should be chromatic`).not.toBe(NEUTRAL_CHART_STEP)
      }
    })

    it('spreads each taxonomy over distinct steps', () => {
      const generic = ['delivery', 'customer_support', 'product_quality', 'pricing', 'website', 'app', 'billing']
      expect(new Set(categoryChartSteps(generic).values()).size).toBe(generic.length)
    })

    /**
     * Design audit D-14: every production category is a custom name, and the
     * fixed-name map sent all of them to the neutral grey, so all eight bars were
     * the same colour. Custom names now take the chromatic steps by rank.
     */
    describe('custom categories (D-14)', () => {
      const PRODUCTION_LIKE = [
        'subscription_billing', 'cartridge_quality', 'app_connectivity', 'shipping_delays',
        'customer_care', 'setup_experience', 'water_taste', 'refunds',
      ]

      it('gives the first seven custom categories, by rank, the seven chromatic steps in ramp order', () => {
        const steps = categoryChartSteps(PRODUCTION_LIKE)
        expect(PRODUCTION_LIKE.map((name) => steps.get(name))).toStrictEqual([1, 2, 3, 4, 5, 7, 8, NEUTRAL_CHART_STEP])
      })

      it('never gives two of the top seven the same colour, nor the grey', () => {
        const top = categoryChartSteps(PRODUCTION_LIKE.slice(0, 7))
        expect(new Set(top.values()).size).toBe(7)
        expect([...top.values()]).not.toContain(NEUTRAL_CHART_STEP)
      })

      it('is deterministic: the same ranked list always gets the same colours', () => {
        expect([...categoryChartSteps(PRODUCTION_LIKE)]).toStrictEqual([...categoryChartSteps([...PRODUCTION_LIKE])])
      })

      it('skips the steps that known categories on the same chart already hold', () => {
        const steps = categoryChartSteps(['delivery', 'water_taste', 'customer_support', 'refunds'])
        expect([steps.get('delivery'), steps.get('customer_support')]).toStrictEqual([1, 2])
        expect([steps.get('water_taste'), steps.get('refunds')]).toStrictEqual([3, 4])
      })

      it('keeps `other` grey even when it ranks first, without spending a chromatic step', () => {
        const steps = categoryChartSteps(['other', 'refunds'])
        expect([steps.get('other'), steps.get('refunds')]).toStrictEqual([NEUTRAL_CHART_STEP, 1])
      })

      it('counts a repeated name once', () => {
        const steps = categoryChartSteps(['refunds', 'refunds', 'water_taste'])
        expect([...steps]).toStrictEqual([['refunds', 1], ['water_taste', 2]])
      })
    })

    it('declares all eight ramp steps in both Kiro theme blocks', () => {
      for (const theme of ['kiro-dark', 'kiro-light'] as const) {
        expect([...chartRampOf(theme).keys()].sort((a, b) => a - b)).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8])
      }
    })

    it('keeps the print hex in lockstep with the Kiro Light ramp in index.css', () => {
      const light = chartRampOf('kiro-light')
      for (const step of [1, 2, 3, 4, 5, 6, 7, 8]) {
        expect(chartStepPrintHex(step)).toBe(light.get(step))
      }
      expect(chartStepPrintHex(99)).toBe(light.get(NEUTRAL_CHART_STEP))
    })

    it('defines neutral and sentiment tokens from KiroCrew tones, not literal hues', () => {
      const dark = css.slice(css.indexOf('[data-theme="kiro-dark"]'), css.indexOf('[data-theme="kiro-light"]'))
      const light = css.slice(css.indexOf('[data-theme="kiro-light"]'))
      const required = [
        /--chart-6:\s*(#938f9b|#5e5966)/,
        /--sentiment-positive:\s*var\(--ok\)/,
        /--sentiment-neutral:\s*var\(--muted\)/,
        /--sentiment-negative:\s*var\(--danger\)/,
        /--sentiment-mixed:\s*var\(--warn\)/,
      ]
      for (const block of [dark, light]) {
        // Every declaration present: the list of missing ones names any that is not.
        expect(required.filter((pattern) => !pattern.test(block)).map(String)).toStrictEqual([])
      }
    })
  })

  describe('matchesRatingFilter', () => {
    it('passes everything when the threshold is 0 (any rating)', () => {
      expect(matchesRatingFilter(5, ANY_RATING_FILTER)).toBe(true)
      expect(matchesRatingFilter(undefined, ANY_RATING_FILTER)).toBe(true)
      expect(matchesRatingFilter(0, { value: 0, direction: 'below' })).toBe(true)
    })

    it('keeps ratings at or above the threshold with & up', () => {
      expect(matchesRatingFilter(3, { value: 3, direction: 'up' })).toBe(true)
      expect(matchesRatingFilter(5, { value: 3, direction: 'up' })).toBe(true)
      expect(matchesRatingFilter(2, { value: 3, direction: 'up' })).toBe(false)
    })

    it('keeps ratings at or below the threshold with & below', () => {
      expect(matchesRatingFilter(3, { value: 3, direction: 'below' })).toBe(true)
      expect(matchesRatingFilter(1, { value: 3, direction: 'below' })).toBe(true)
      expect(matchesRatingFilter(4, { value: 3, direction: 'below' })).toBe(false)
    })

    it('excludes unrated items in both directions once a threshold is set', () => {
      expect(matchesRatingFilter(undefined, { value: 3, direction: 'up' })).toBe(false)
      expect(matchesRatingFilter(undefined, { value: 3, direction: 'below' })).toBe(false)
    })
  })

  describe('ratingFilterLabel', () => {
    it('formats the & up direction as N+', () => {
      expect(ratingFilterLabel({ value: 4, direction: 'up' }, i18n.t)).toBe('4+ stars')
    })

    it('formats the & below direction as ≤N', () => {
      expect(ratingFilterLabel({ value: 3, direction: 'below' }, i18n.t)).toBe('≤3 stars')
    })
  })
})
