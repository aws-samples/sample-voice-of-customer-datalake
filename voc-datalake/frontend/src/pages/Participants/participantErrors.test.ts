/**
 * @fileoverview The sentence for a refused participants request, from the body the engagement
 * API really sends: shared/api.py answers every refusal `{success: false, error: <reason>}` (no
 * `message`), and `apiErrorFor` (the transport every fetch goes through) turns it into the ApiError.
 */
import { describe, expect, it } from 'vitest'
import { apiErrorFor } from '../../api/client'
import { participantErrorMessage } from './participantErrors'

const t = (key: string) => key

/** A Response exactly as API Gateway hands it over from the engagement Lambda. */
const backendRefusal = (status: number, error: string) =>
  new Response(JSON.stringify({ success: false, error }), { status, headers: { 'Content-Type': 'application/json' } })

describe('participantErrorMessage, from a backend-shaped error body', () => {
  it.each([
    [409, 'email_not_configured', 'participants:errors.emailNotConfigured'],
    [429, 'daily_cap', 'participants:errors.dailyCap'],
    [429, 'sender_daily_cap', 'participants:errors.senderDailyCap'],
    [400, 'no_recipients', 'participants:errors.noRecipients'],
    [400, 'too_many_recipients', 'participants:errors.tooManyRecipients'],
    [400, 'external_not_allowed', 'participants:errors.externalNotAllowed'],
    [400, 'invalid_email', 'participants:errors.invalidEmail'],
  ])('%i {error: %s} reads as %s', async (status, error, key) => {
    expect(participantErrorMessage(await apiErrorFor(backendRefusal(status, error)), t)).toBe(key)
  })

  it.each([
    [409, 'A person with this email already exists', 'participants:errors.conflict'],
    [404, 'List not found', 'participants:errors.notFound'],
    [403, 'Only an administrator can do this', 'participants:errors.forbidden'],
    [400, 'subject is required', 'participants:errors.generic'],
  ])('a sentence (%i %s) falls back to the status: %s', async (status, error, key) => {
    expect(participantErrorMessage(await apiErrorFor(backendRefusal(status, error)), t)).toBe(key)
  })
})
