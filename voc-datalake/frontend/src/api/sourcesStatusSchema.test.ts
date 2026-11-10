/**
 * @fileoverview Tests for the GET /sources/status and reset normalizers.
 * @module api/sourcesStatusSchema.test
 */
import { describe, it, expect } from 'vitest'
import { CLOSED_CIRCUIT, normalizeResetSource, normalizeSourcesStatus } from './sourcesStatusSchema'

const TRIPPED = {
  tripped: true, tripped_at: '2026-10-08T09:15:00+00:00', failure_count: 5, last_error: 'HTTPError: 503',
}

describe('normalizeSourcesStatus', () => {
  it('keeps a tripped circuit as the server sent it', () => {
    const status = normalizeSourcesStatus({ sources: { webscraper: { enabled: false, exists: true, circuit: TRIPPED } } })

    expect(status.sources.webscraper?.circuit).toStrictEqual(TRIPPED)
  })

  it('reads a record from a backend that predates the circuit as closed', () => {
    const status = normalizeSourcesStatus({ sources: { webscraper: { enabled: true, schedule: 'rate(1 hour)' } } })

    expect(status.sources.webscraper).toStrictEqual({ enabled: true, schedule: 'rate(1 hour)', circuit: CLOSED_CIRCUIT })
  })

  it('degrades each wrong-typed circuit field instead of dropping the record', () => {
    const status = normalizeSourcesStatus({
      sources: { webscraper: { enabled: 'yes', circuit: { tripped: true, tripped_at: 7, failure_count: '3', last_error: {} } } },
    })

    expect(status.sources.webscraper?.enabled).toBe(false)
    expect(status.sources.webscraper?.circuit).toStrictEqual({ tripped: true, tripped_at: null, failure_count: 3, last_error: null })
  })

  it('never reports a negative or fractional failure count', () => {
    const negative = normalizeSourcesStatus({ sources: { a: { circuit: { tripped: true, failure_count: -2 } } } })
    const fractional = normalizeSourcesStatus({ sources: { a: { circuit: { tripped: true, failure_count: 1.5 } } } })

    expect(negative.sources.a?.circuit.failure_count).toBe(0)
    expect(fractional.sources.a?.circuit.failure_count).toBe(0)
  })

  it('keeps the server error that says the circuit could not be read', () => {
    const status = normalizeSourcesStatus({
      sources: { a: { enabled: true, circuit: { ...CLOSED_CIRCUIT, error: 'Failed to retrieve circuit state' } } },
    })

    expect(status.sources.a?.circuit.error).toBe('Failed to retrieve circuit state')
  })

  it.each([null, 'nope', { sources: 'x' }])('reads %j as no sources', (raw) => {
    expect(normalizeSourcesStatus(raw)).toStrictEqual({ sources: {} })
  })

  it('reads a non-object entry as a disabled source with a closed circuit', () => {
    expect(normalizeSourcesStatus({ sources: { a: 'x' } }).sources.a).toStrictEqual({ enabled: false, circuit: CLOSED_CIRCUIT })
  })
})

describe('normalizeResetSource', () => {
  it('passes a successful reset through with its closed circuit', () => {
    const response = normalizeResetSource({ success: true, source: 'webscraper', enabled: false, circuit: CLOSED_CIRCUIT })

    expect(response).toStrictEqual({ success: true, source: 'webscraper', enabled: false, circuit: CLOSED_CIRCUIT })
  })

  it('reads a non-object answer as a failed reset', () => {
    expect(normalizeResetSource('oops').success).toBe(false)
  })
})
