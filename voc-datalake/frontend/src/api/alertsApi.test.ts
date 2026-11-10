/**
 * @fileoverview The alerting boundary: drift reads as "not configured / off /
 * nobody", never as "on", and each call hits its own route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchApi = vi.hoisted(() => vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>())
vi.mock('./client', () => ({ fetchApi }))

import { DEFAULT_ALERTS_STATUS, alertsApi, normalizeAlertsStatus } from './alertsApi'

describe('normalizeAlertsStatus', () => {
  it('keeps a well-formed answer', () => {
    const raw = {
      configured: true, enabled: true, updated_at: '2026-10-17T10:00:00+00:00', updated_by: 'admin@example.com',
      alarms: [{ name: 'voc-alerts-1-us-east-1-processing-dlq', state: 'OK' }],
      expected_alarm_count: 9, billed_metric_count: 11,
      subscribers: [{ email: 'ops@example.com', status: 'confirmed' }, { email: 'on-call@example.com', status: 'pending' }],
      max_subscribers: 10,
    }
    expect(normalizeAlertsStatus(raw)).toStrictEqual(raw)
  })

  it.each([[null], ['x'], [[]], [{}]])('reads %j as not configured and off', (raw) => {
    expect(normalizeAlertsStatus(raw)).toStrictEqual(DEFAULT_ALERTS_STATUS)
    expect(DEFAULT_ALERTS_STATUS).toMatchObject({ configured: false, enabled: false, alarms: [], subscribers: [], max_subscribers: 10 })
  })

  it('drops a malformed recipient and reads an unknown status as pending', () => {
    const status = normalizeAlertsStatus({
      configured: true, enabled: 'yes',
      subscribers: [{ email: '' }, 42, { email: 'ops@example.com', status: 'weird' }],
    })
    expect(status.enabled).toBe(false)
    expect(status.subscribers).toStrictEqual([{ email: 'ops@example.com', status: 'pending' }])
  })
})

describe('alertsApi', () => {
  beforeEach(() => {
    fetchApi.mockReset()
    fetchApi.mockResolvedValue({})
  })

  it('turns alerting on with PUT /logs/alerts', async () => {
    await alertsApi.setEnabled(true)
    expect(fetchApi).toHaveBeenCalledWith('/logs/alerts', { method: 'PUT', body: JSON.stringify({ enabled: true }) })
  })

  it('adds and removes a recipient by its own routes', async () => {
    await alertsApi.addRecipient('ops@example.com')
    await alertsApi.removeRecipient('ops@example.com')
    expect(fetchApi.mock.calls).toStrictEqual([
      ['/logs/alerts/recipients', { method: 'POST', body: JSON.stringify({ email: 'ops@example.com' }) }],
      ['/logs/alerts/recipients/remove', { method: 'POST', body: JSON.stringify({ email: 'ops@example.com' }) }],
    ])
  })
})
