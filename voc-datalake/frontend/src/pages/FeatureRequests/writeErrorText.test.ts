/**
 * @fileoverview writeErrorText against the body the engagement API really sends
 * (`{success: false, error: <sentence>}`, shared/api.py), through the real `apiErrorFor`.
 */
import { describe, expect, it } from 'vitest'
import { apiErrorFor } from '../../api/client'
import { writeErrorText } from './writeErrorText'

const t = (key: string) => `t:${key}`
const backendRefusal = (status: number, error: string) =>
  new Response(JSON.stringify({ success: false, error }), { status, headers: { 'Content-Type': 'application/json' } })

describe('writeErrorText', () => {
  it.each([
    [403, 'Only an administrator can do this', 't:featureRequests:errors.forbidden'],
    [403, 'You can only change your own entry', 't:featureRequests:errors.forbidden'],
    [404, 'Feature request not found', 't:featureRequests:errors.notFound'],
    [409, 'The totals changed meanwhile; try again', 't:featureRequests:errors.conflict'],
  ])('%i {error: %s} is shown translated', async (status, error, expected) => {
    expect(writeErrorText(await apiErrorFor(backendRefusal(status, error)), t)).toBe(expected)
  })

  it.each([
    [429, 'rate_limited', 't:featureRequests:errors.rateLimited'],
    [429, 'Too Many Requests', 't:featureRequests:errors.throttled'],
    [409, 'board_not_empty', 't:featureRequests:errors.boardNotEmpty'],
    [409, 'slug_taken', 't:featureRequests:errors.slugTaken'],
    [409, 'status_in_use', 't:featureRequests:errors.statusInUse'],
    [409, 'already_supported', 't:featureRequests:errors.alreadySupported'],
  ])('%i {error: %s} names the board limit or conflict in words', async (status, error, expected) => {
    expect(writeErrorText(await apiErrorFor(backendRefusal(status, error)), t)).toBe(expected)
  })

  it('a 400 shows the server reason (it names the field)', async () => {
    expect(writeErrorText(await apiErrorFor(backendRefusal(400, 'title is required')), t)).toBe('title is required')
  })

  it('a status without a reason or a translation is the generic sentence', async () => {
    expect(writeErrorText(await apiErrorFor(new Response('', { status: 502 })), t)).toBe('t:featureRequests:errors.generic')
  })
})
