/**
 * @fileoverview The sentence for a refused participants request.
 *
 * The engagement API answers `{success: false, error}` (shared/api.py) with a short reason code
 * (`email_not_configured`, `daily_cap`, `external_not_allowed`, …) or a sentence, which `fetchApi`
 * carries as the `ApiError` message (`message ?? error`, api/client.ts). A known code gets its own sentence; otherwise the
 * status decides (409 duplicate, 429 throttled), else a generic one.
 *
 * @module pages/Participants/participantErrors
 */
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { serverReason } from '../../lib/errors'

type Translate = (key: string) => string

const REASON_PATTERN = /[a-z_]+/g

/** The reason codes a message names (a message may be the bare code or a sentence holding it). */
function reasonCodes(error: unknown): string[] {
  return (serverReason(error) ?? '').match(REASON_PATTERN) ?? []
}

function reasonSentence(codes: readonly string[], t: Translate): string | null {
  if (codes.includes('email_not_configured')) return t('participants:errors.emailNotConfigured')
  if (codes.includes('sender_daily_cap')) return t('participants:errors.senderDailyCap')
  if (codes.includes('daily_cap')) return t('participants:errors.dailyCap')
  if (codes.includes('no_recipients')) return t('participants:errors.noRecipients')
  if (codes.includes('too_many_recipients')) return t('participants:errors.tooManyRecipients')
  if (codes.includes('external_not_allowed')) return t('participants:errors.externalNotAllowed')
  if (codes.includes('invalid_email')) return t('participants:errors.invalidEmail')
  return null
}

function statusSentence(status: number | null, t: Translate): string {
  switch (status) {
    case 403: return t('participants:errors.forbidden')
    case 404: return t('participants:errors.notFound')
    case 409: return t('participants:errors.conflict')
    case 429: return t('participants:errors.throttled')
    default: return t('participants:errors.generic')
  }
}

export function participantErrorMessage(error: unknown, t: Translate): string {
  return reasonSentence(reasonCodes(error), t) ?? statusSentence(apiErrorStatus(error), t)
}
