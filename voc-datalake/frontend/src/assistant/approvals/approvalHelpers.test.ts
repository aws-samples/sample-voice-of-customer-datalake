import { describe, it, expect } from 'vitest'
import { ApiError } from '../../lib/errors'
import { checkArgs, isApprovable, isDestructive } from './approvalGate'
import { getWriteTool } from './registry'
import { safeErrorMessage } from './safeError'
import { expiryAt, formatRemaining, parseExpiry } from './useExpiry'
import type { GateInput } from './approvalGate'

describe('expiry helpers', () => {
  it('treats a missing or unparsable expiresAt as no expiry', () => {
    expect(parseExpiry(undefined)).toBeNull()
    expect(parseExpiry('not a date')).toBeNull()
    expect(expiryAt(null, Date.now())).toStrictEqual({ expired: false, remainingMs: null })
  })

  it('counts down and flips to expired at the deadline', () => {
    expect(expiryAt(10_000, 4_000)).toStrictEqual({ expired: false, remainingMs: 6_000 })
    expect(expiryAt(10_000, 10_000)).toStrictEqual({ expired: true, remainingMs: 0 })
    expect(expiryAt(10_000, 99_000)).toStrictEqual({ expired: true, remainingMs: 0 })
  })

  it('formats m:ss and h:mm:ss', () => {
    expect(formatRemaining(29 * 60_000 + 5_000)).toBe('29:05')
    expect(formatRemaining(400)).toBe('0:01')
    expect(formatRemaining(3_600_000 + 61_000)).toBe('1:01:01')
  })
})

describe('approval gate', () => {
  const definition = getWriteTool('delete_document')
  const check = checkArgs(definition, { project_id: 'p', document_id: 'd', reason: 'duplicate' })
  const base: GateInput = {
    definition,
    check,
    expiry: { expired: false, remainingMs: 1000 },
    adminBlocked: false,
    destructive: true,
    confirmed: true,
    disabled: false,
    phase: 'pending',
  }

  it('approves when every condition holds', () => {
    expect(isApprovable(base)).toBe(true)
  })

  it('approves a non-destructive tool without the confirmation', () => {
    expect(isApprovable({ ...base, destructive: false, confirmed: false })).toBe(true)
  })

  it.each<[string, Partial<GateInput>]>([
    ['unconfirmed destructive', { confirmed: false }],
    ['expired', { expiry: { expired: true, remainingMs: 0 } }],
    ['admin-blocked', { adminBlocked: true }],
    ['disabled', { disabled: true }],
    ['already executing', { phase: 'executing' }],
    ['unknown tool', { definition: undefined }],
    ['invalid args', { check: { ok: false, problems: [] } }],
  ])('refuses when %s', (_label, change) => {
    expect(isApprovable({ ...base, ...change })).toBe(false)
  })

  it('lists schema problems with their path', () => {
    const result = checkArgs(getWriteTool('create_project'), { name: '' })
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.problems[0]).toMatch(/^name: /)
  })

  it('takes the stricter of the server and client risk', () => {
    const write = getWriteTool('create_project')
    expect(isDestructive({ id: 'i', toolCallId: 't', metadata: { risk: 'destructive' } }, write)).toBe(true)
    expect(isDestructive({ id: 'i', toolCallId: 't', metadata: { risk: 'write' } }, definition)).toBe(true)
    expect(isDestructive({ id: 'i', toolCallId: 't' }, write)).toBe(false)
  })
})

describe('safeErrorMessage', () => {
  it('maps statuses without leaking the original text', () => {
    expect(safeErrorMessage(new Error('API Error: 403'))).toBe("You don't have permission to do this.")
    expect(safeErrorMessage(new Error('API Error: 404'))).toMatch(/not found/)
    expect(safeErrorMessage(new Error('API Error: 502'))).toBe('The request failed (HTTP 502).')
    expect(safeErrorMessage(new ApiError(403, 'secret body text'))).toBe("You don't have permission to do this.")
  })

  it('keeps the session-expired message and hides anything else', () => {
    expect(safeErrorMessage(new Error('Session expired. Please login again.'))).toBe('Session expired. Please login again.')
    expect(safeErrorMessage(new TypeError('Failed to fetch https://internal/secret'))).toBe('The action failed before the server answered.')
    expect(safeErrorMessage('boom')).toBe('The action failed before the server answered.')
  })
})
